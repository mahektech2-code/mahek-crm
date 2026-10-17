import "server-only";
import { readSecret } from "./secrets";

/* ---------------------------------------------------------------------------
 * MiniMoth — one-time codes to an Indian mobile, WhatsApp first and SMS when
 * WhatsApp does not deliver, under MiniMoth's own DLT registration.
 *
 * It is the transport for `otp-service.ts` and nothing else. Unlike the Wati
 * path, MiniMoth MAKES the code and CHECKS it: MahekOne never sees the digits,
 * so the `auth_otps` row records that a code was sent and through which
 * MiniMoth id, and verification asks MiniMoth.
 *
 * Plain `fetch` rather than `@minimoth/sdk-node`: the SDK's value is session
 * handling (JWTs, refresh, a token store), and MahekOne keeps its own
 * DB-backed sessions. Verify returns MiniMoth session tokens on success; they
 * are dropped, because nothing here signs anybody in with them.
 *
 * A TEST KEY (`mm_test_…`) SENDS NOTHING AND ACCEPTS 000000 FOR EVERY NUMBER.
 * That is what makes it right for a laptop and dangerous anywhere else — on a
 * deployment anybody who knows a colleague's work number could sign in as
 * them. `isTestKey` exists so the readiness check can refuse one in
 * production rather than trusting whoever pasted it to know that.
 * ------------------------------------------------------------------------- */

const BASE_URL = "https://api.minimoth.dev";
const TIMEOUT_MS = 10_000;

export const isTestKey = (key: string) => key.startsWith("mm_test_");

export async function minimothKey(): Promise<string | null> {
  const key = (await readSecret("minimoth.apiKey"))?.trim();
  return key ? key : null;
}

type Fail = { ok: false; code: string; error: string; status: number };

async function post<T>(key: string, path: string, body: unknown): Promise<{ ok: true; data: T } | Fail> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "X-Api-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (e) {
    return { ok: false, code: "NETWORK_ERROR", error: e instanceof Error ? e.message : "network error", status: 0 };
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    return {
      ok: false,
      code: typeof json.code === "string" ? json.code : "UNKNOWN_ERROR",
      error: typeof json.error === "string" ? json.error : `HTTP ${res.status}`,
      status: res.status,
    };
  }
  return { ok: true, data: json as T };
}

/** Indian numbers as MiniMoth takes them: country code, no plus. */
function phoneFor(wa: string): string {
  const digits = wa.replace(/\D/g, "");
  return digits.length === 10 ? `91${digits}` : digits;
}

/** `raw` is MiniMoth's answer as it came back — kept for the OTP history. It never holds the code. */
export type MiniMothSend = { ok: true; otpId: string; expiresAt: Date; raw: Record<string, unknown> } | Fail;

export async function sendMiniMothOtp(key: string, phone: string): Promise<MiniMothSend> {
  const r = await post<{ otp_id?: string; expires_at?: string; [k: string]: unknown }>(key, "/v1/otp/send", { phone: phoneFor(phone) });
  if (!r.ok) return r;
  if (!r.data.otp_id) return { ok: false, code: "BAD_RESPONSE", error: "MiniMoth answered without an otp_id.", status: 200 };
  const expiresAt = r.data.expires_at ? new Date(r.data.expires_at) : new Date(Date.now() + 10 * 60_000);
  return { ok: true, otpId: r.data.otp_id, expiresAt, raw: r.data as Record<string, unknown> };
}

/**
 * `valid: false` carries MiniMoth's own code: INVALID_OTP (wrong digits),
 * OTP_NOT_FOUND (expired, used, or never sent), VERIFY_RATE_LIMITED. Anything
 * else — a network failure, a revoked key — is `unavailable`, which is not the
 * person's mistake and must not be counted against their attempts.
 */
export type MiniMothVerify =
  | { ok: true; valid: true }
  | { ok: true; valid: false; code: string }
  | { ok: false; error: string };

const WRONG_CODE = new Set(["INVALID_OTP", "OTP_NOT_FOUND", "INVALID_PHONE", "VERIFY_RATE_LIMITED"]);

export async function verifyMiniMothOtp(key: string, phone: string, code: string): Promise<MiniMothVerify> {
  const r = await post<{ access_token?: string }>(key, "/v1/otp/verify", { phone: phoneFor(phone), code });
  if (r.ok) return { ok: true, valid: true };
  if (WRONG_CODE.has(r.code)) return { ok: true, valid: false, code: r.code };
  return { ok: false, error: `${r.code}: ${r.error}` };
}
