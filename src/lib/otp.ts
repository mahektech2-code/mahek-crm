import "server-only";
import { createHash, randomInt } from "node:crypto";

/* ---------------------------------------------------------------------------
 * A sign-in code: minted here, hashed before storage, and read back in one
 * place — the same split `password-reset.ts` keeps between a reset token and
 * its hash, so the page that sends a code and the action that checks one
 * cannot disagree about what a right answer looks like.
 * ------------------------------------------------------------------------- */

/** A code of the given length, zero-padded — "007331", not "7331". */
export function newOtpCode(length: number): string {
  const max = 10 ** length;
  return String(randomInt(0, max)).padStart(length, "0");
}

/** What goes in the database. The code itself only ever exists in the message. */
export function hashOtpCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/**
 * Telecallers know their phone, not a ten-digit string with a country code in
 * front of it — this is the one place a typed number becomes the last ten
 * digits everything else compares against.
 */
export function normalisePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/** For showing a number back without showing the whole thing: 98••••1006. */
export function maskPhone(phone: string): string {
  if (phone.length < 4) return phone;
  return `${phone.slice(0, 2)}${"•".repeat(phone.length - 4)}${phone.slice(-2)}`;
}
