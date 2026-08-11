import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/* ---------------------------------------------------------------------------
 * MBOS access and refresh tokens.
 *
 * The rest of MahekOne signs in with a cookie and a `sessions` row, and that
 * is right for a browser. A handset is not a browser: it holds its credential
 * in SecureStore across app restarts, sends it on a background sync the user
 * is not watching, and has to be able to tell "my token expired" from "there
 * is no signal" without asking anybody.
 *
 * So it is a signed token rather than a session id — but a SMALL one, written
 * here rather than pulled in. `jose` is not a dependency of this app and a JWT
 * library for two claim shapes and one algorithm is a dependency that earns
 * nothing: HMAC-SHA256 over base64url JSON is what a JWT is, and node:crypto
 * already ships it.
 *
 * Two things it deliberately does NOT do:
 *
 *  - It does not accept an `alg` from the token. The header is written by us
 *    and checked against a constant, because "alg: none" is the oldest hole in
 *    this shape of credential and it exists precisely because verifiers read
 *    the algorithm out of the thing they are verifying.
 *  - It does not carry a role, a scope or a capability. Those are read from
 *    the database on every request. A token that carried them would keep
 *    working for its whole life after somebody was moved off the field app.
 * ------------------------------------------------------------------------- */

export type MbosTokenType = "access" | "refresh";

export type MbosClaims = {
  /** The `users` row. */
  sub: string;
  /** The install this token was issued to — a token is bound to a handset. */
  did: string;
  typ: MbosTokenType;
  /** Seconds since epoch, both. */
  iat: number;
  exp: number;
  /** Unique per issue, so a rotation can be told from a replay. */
  jti: string;
};

const ALG = "HS256";

/**
 * There is no default and there is no fallback. A signing key the deployment
 * did not choose is a signing key an attacker can guess, and a field app that
 * silently accepts tokens signed with a well-known string is worse than one
 * that will not start.
 */
export class MissingSigningKeyError extends Error {
  constructor() {
    super(
      "MBOS_JWT_SECRET (or JWT_SECRET) is not set, so the field app cannot issue or verify tokens.",
    );
    this.name = "MissingSigningKeyError";
  }
}

function secret(): string {
  const value = process.env.MBOS_JWT_SECRET ?? process.env.JWT_SECRET;
  if (!value || value.length < 16) throw new MissingSigningKeyError();
  return value;
}

export function signingKeyPresent(): boolean {
  try {
    secret();
    return true;
  } catch {
    return false;
  }
}

const b64url = (input: Buffer | string) =>
  Buffer.from(input).toString("base64url");

function sign(data: string): string {
  return createHmac("sha256", secret()).update(data).digest("base64url");
}

export function issueToken(input: {
  userId: string;
  deviceId: string;
  type: MbosTokenType;
  /** How long it lives, in seconds. */
  ttlSeconds: number;
  now?: number;
}): { token: string; expiresAt: number; jti: string } {
  const iat = Math.floor((input.now ?? Date.now()) / 1000);
  const exp = iat + input.ttlSeconds;
  const jti = randomUUID();

  const claims: MbosClaims = {
    sub: input.userId,
    did: input.deviceId,
    typ: input.type,
    iat,
    exp,
    jti,
  };

  const head = b64url(JSON.stringify({ alg: ALG, typ: "JWT" }));
  const body = b64url(JSON.stringify(claims));
  const token = `${head}.${body}.${sign(`${head}.${body}`)}`;
  return { token, expiresAt: exp * 1000, jti };
}

export type VerifyResult =
  | { ok: true; claims: MbosClaims }
  | { ok: false; reason: "malformed" | "signature" | "expired" | "wrong_type" };

export function verifyToken(
  token: string | null | undefined,
  expected: MbosTokenType,
  now = Date.now(),
): VerifyResult {
  if (!token) return { ok: false, reason: "malformed" };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [head, body, mac] = parts;

  let expectedMac: string;
  try {
    expectedMac = sign(`${head}.${body}`);
  } catch {
    // No key configured. Refusing everything is the safe direction, and the
    // route says so rather than letting a handset guess.
    return { ok: false, reason: "signature" };
  }

  const a = Buffer.from(mac);
  const b = Buffer.from(expectedMac);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "signature" };
  }

  let claims: MbosClaims;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    const header = JSON.parse(Buffer.from(head, "base64url").toString("utf8"));
    // The header is ours; it is checked, never obeyed.
    if (header?.alg !== ALG) return { ok: false, reason: "signature" };
    if (
      typeof parsed?.sub !== "string" ||
      typeof parsed?.did !== "string" ||
      typeof parsed?.exp !== "number"
    ) {
      return { ok: false, reason: "malformed" };
    }
    claims = parsed as MbosClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (claims.typ !== expected) return { ok: false, reason: "wrong_type" };
  if (claims.exp * 1000 <= now) return { ok: false, reason: "expired" };

  return { ok: true, claims };
}

/** The bearer credential, or null. Header parsing in one place. */
export function bearerFrom(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !value) return null;
  return value.trim();
}
