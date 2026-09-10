import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

/**
 * Kept out of lib/auth.ts so the seed script can hash passwords without
 * pulling in `server-only` and the request-scoped cookie APIs.
 */
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [scheme, saltHex, keyHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !keyHex) return false;

  const key = await scryptAsync(password, Buffer.from(saltHex, "hex"), 64);
  const expected = Buffer.from(keyHex, "hex");
  if (expected.length !== key.length) return false;
  return timingSafeEqual(key, expected);
}

/* ------------------------------------------------- a password read out loud */

/**
 * The alphabet of a password somebody has to READ OUT OVER A TELEPHONE.
 *
 * `I O S Z` and `0 1 2 5` are gone, which is what the whole constant is for.
 * A credential minted in the Admin Console is not typed by the person it
 * belongs to — it is read down a phone line by whoever granted the access, to
 * a telecaller who then types it, and every one of those characters is a pair
 * that gets transcribed wrong. Dropping both halves of each pair costs four
 * bits and buys the difference between a password that works first time and a
 * support call.
 *
 * Upper case throughout for the same reason: "capital bee, small bee" is a
 * sentence nobody should have to say, and a shift key is one more thing to get
 * wrong on a handset.
 */
const READABLE = "ABCDEFGHJKLMNPQRTUVWXY346789";

/** Ten characters of it, so roughly 48 bits — split for reading, not for show. */
const LENGTH = 10;
const GROUP = 5;

/**
 * A fresh password for somebody the office is setting up.
 *
 * THE DASH IS PART OF IT. Grouping is what makes ten characters sayable, and
 * a group that is only a display flourish is a transcription trap — the screen
 * shows `ABCDE-FGHJK`, somebody types the dash, and a password without one
 * refuses them. So it is in the string, it is in the hash, and the screen says
 * in words that it counts.
 *
 * Drawn from `randomBytes` with the tail of the byte range REJECTED rather
 * than folded in: 256 does not divide by 28, so a plain modulo would make the
 * first four letters of the alphabet slightly likelier than the rest. It costs
 * a handful of extra bytes and removes a bias somebody would otherwise have to
 * reason about.
 */
export function newPassword(): string {
  const limit = 256 - (256 % READABLE.length);
  let out = "";
  while (out.length < LENGTH + 1) {
    for (const byte of randomBytes(LENGTH * 2)) {
      if (byte >= limit) continue;
      out += READABLE[byte % READABLE.length];
      if (out.length === GROUP) out += "-";
      if (out.length === LENGTH + 1) break;
    }
  }
  return out;
}
