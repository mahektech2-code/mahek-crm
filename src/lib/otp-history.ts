/* ---------------------------------------------------------------------------
 * THE OTP HISTORY, IN WORDS — pure and client-safe.
 *
 * An `auth_otps` row does not store a status: whether a code was used,
 * expired, locked or is still waiting is read off its timestamps and its
 * attempt count. `otpStatus` is the ONE reading of that, and `OTP_STATUS_SQL`
 * in the service is the same rule as a CASE so a filter can run in the
 * database — `otp-history.test.ts` holds the two together.
 * ------------------------------------------------------------------------- */

export const OTP_STATUSES = [
  "verified",
  "waiting",
  "expired",
  "locked",
  "send_failed",
  "refused",
] as const;
export type OtpStatus = (typeof OTP_STATUSES)[number];

export type Tone = "neutral" | "brand" | "success" | "warn" | "danger" | "muted";

export const OTP_STATUS_LABELS: Record<OtpStatus, { label: string; tone: Tone; meaning: string }> = {
  verified: { label: "Used", tone: "success", meaning: "The right code was entered and it did its job." },
  waiting: { label: "Waiting", tone: "brand", meaning: "Sent, still live, not entered yet." },
  expired: { label: "Expired unused", tone: "muted", meaning: "Sent, and never entered before it ran out." },
  locked: { label: "Too many wrong tries", tone: "danger", meaning: "Wrong codes used up its tries; it stopped working." },
  send_failed: { label: "Not delivered", tone: "danger", meaning: "The provider refused or could not be reached." },
  refused: { label: "Refused", tone: "warn", meaning: "Turned down before anything was sent." },
};

export type OtpRowFacts = {
  refusedReason: string | null;
  sentAt: Date | string | null;
  consumedAt: Date | string | null;
  expiresAt: Date | string;
  attempts: number;
};

const ms = (d: Date | string) => (typeof d === "string" ? Date.parse(d) : d.getTime());

/** What became of one request. `now` is passed in — no engine reads the clock. */
export function otpStatus(row: OtpRowFacts, maxAttempts: number, now: number): OtpStatus {
  if (row.refusedReason) return "refused";
  if (!row.sentAt) return "send_failed";
  if (row.consumedAt) return "verified";
  if (row.attempts >= maxAttempts) return "locked";
  if (ms(row.expiresAt) < now) return "expired";
  return "waiting";
}

export const OTP_PURPOSE_LABELS: Record<string, string> = {
  login: "Sign in",
  password_reset: "Reset password",
  password_change: "Change password",
};

export const OTP_SURFACE_LABELS: Record<string, string> = {
  web: "Web sign-in page",
  handset: "MBOS handset",
  settings: "Account settings",
};

export const OTP_PROVIDER_LABELS: Record<string, string> = {
  minimoth: "MiniMoth",
  wati: "Wati",
};

export const OTP_REFUSAL_LABELS: Record<string, string> = {
  cooldown: "Asked again inside the resend cooldown",
  window_cap: "Over the limit of codes for the window",
  no_hrms_mobile: "No HRMS link or personal mobile",
  account_closed: "Account closed",
};

export const OTP_ATTEMPT_LABELS: Record<string, string> = {
  ok: "Right code",
  wrong: "Wrong code",
  expired: "Entered after it expired",
  too_many: "Entered after it was locked",
  unavailable: "Provider could not be reached",
  OTP_NOT_FOUND: "MiniMoth had no live code",
  VERIFY_RATE_LIMITED: "MiniMoth rate-limited the check",
  INVALID_PHONE: "MiniMoth rejected the number",
};

/** A stored code back to words. An unknown code is shown as itself, never hidden. */
export function labelOf(map: Record<string, string>, code: string | null | undefined, empty = "Not recorded"): string {
  if (!code) return empty;
  return map[code] ?? code;
}

/** "+91 98200 11001" — this screen is for administrators, so the whole number. */
export function numberForReading(dest: string | null | undefined): string {
  const d = (dest ?? "").replace(/\D/g, "");
  if (!d) return "—";
  if (d.length === 12 && d.startsWith("91")) return `+91 ${d.slice(2, 7)} ${d.slice(7)}`;
  if (d.length === 10) return `${d.slice(0, 5)} ${d.slice(5)}`;
  return `+${d}`;
}

/**
 * How MiniMoth delivered it, where its answer says — WhatsApp first and SMS
 * when WhatsApp did not take. Null where the answer names no channel.
 */
export function deliveryChannel(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const r = response as Record<string, unknown>;
  for (const k of ["channel", "delivered_via", "via", "sent_via"]) {
    if (typeof r[k] === "string" && r[k]) return String(r[k]);
  }
  return null;
}

/** A user agent cut down to something a person recognises. */
export function deviceOf(ua: string | null | undefined): string {
  if (!ua) return "Not recorded";
  if (/okhttp|expo|mbos/i.test(ua)) return "MBOS handset";
  const os = /android/i.test(ua) ? "Android" : /iphone|ipad/i.test(ua) ? "iOS" : /windows/i.test(ua) ? "Windows" : /mac os/i.test(ua) ? "Mac" : /linux/i.test(ua) ? "Linux" : "";
  const browser = /edg\//i.test(ua) ? "Edge" : /chrome\//i.test(ua) ? "Chrome" : /firefox\//i.test(ua) ? "Firefox" : /safari\//i.test(ua) ? "Safari" : "";
  return [browser, os].filter(Boolean).join(" on ") || ua.slice(0, 60);
}
