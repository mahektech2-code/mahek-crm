import "server-only";
import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { authOtps, passwordResets, sessions, users } from "@/db/schema";
import { hashPassword } from "../password";
import { getConfig } from "../config/store";
import { isApproved, listWatiTemplates, sendWatiTemplate, watiConfig } from "../wati";
import { waNumber } from "../whatsapp-delivery";

/* ---------------------------------------------------------------------------
 * One-time codes on WhatsApp — for signing in (web and MBOS handset), for
 * changing a password, and for resetting a forgotten one.
 *
 * THE CODE GOES TO THE WORK NUMBER ON THE ACCOUNT, never to a number typed at
 * the screen. Somebody can only ever receive a code for an account whose
 * number is their own phone, which is the whole of what makes this a second
 * factor rather than a way round the first.
 *
 * IT IS OFFERED ONLY WHEN IT CAN WORK: a Wati key, and an APPROVED
 * authentication template named in `auth.otp.whatsappTemplateName`. Until
 * then every screen shows password sign-in exactly as before and says
 * nothing about codes — an option that fails when pressed is worse than one
 * never offered. It does not depend on the founder's WhatsApp switch: that
 * switch is about messages to CUSTOMERS; this is a staff member's own code.
 *
 * Limits are configuration (`auth.otp.*`): digits, lifetime, wrong guesses per
 * code, the resend cooldown, and how many codes an account may be sent in a
 * window — the last is what stops a number being used to run up a bill.
 * ------------------------------------------------------------------------- */

export type OtpPurpose = "login" | "password_change" | "password_reset";

const hashOf = (id: string, code: string) => createHash("sha256").update(`${id}:${code}`).digest("hex");

/** "+91 98•••••001" — enough to recognise your own number, not enough to learn one. */
export function maskNumber(wa: string): string {
  const d = wa.replace(/\D/g, "");
  return `+${d.slice(0, 2)} ${d.slice(2, 4)}•••••${d.slice(-3)}`;
}

export type OtpAvailability = { available: true; template: string; param: string } | { available: false; why: string };

let availabilityCache: { at: number; value: OtpAvailability } | null = null;

/** Whether codes can be sent at all. Cached for a minute — every login screen asks. */
export async function otpAvailability(): Promise<OtpAvailability> {
  if (availabilityCache && Date.now() - availabilityCache.at < 60_000) return availabilityCache.value;
  // NEVER THROWS. The login page asks this, and the container's health check
  // IS the login page — a settings read that fails (a database still being
  // migrated, a Wati outage) must cost the WhatsApp option, never the sign-in
  // screen. The password form stands on its own.
  const value = await (async (): Promise<OtpAvailability> => {
    const config = await getConfig();
    const name = String(config["auth.otp.whatsappTemplateName"] ?? "").trim();
    if (!name) return { available: false, why: "No WhatsApp code template is named in the settings." };
    if (!(await watiConfig())) return { available: false, why: "No Wati key is configured." };
    const listed = await listWatiTemplates();
    if (!listed.ok) return { available: false, why: `Wati could not be reached: ${listed.error}` };
    const t = listed.templates.find((x) => x.name === name);
    if (!t) return { available: false, why: `Wati has no template called "${name}".` };
    if (!isApproved(t)) return { available: false, why: `"${name}" is ${t.status.toLowerCase()} in Wati.` };
    // An authentication template carries exactly one variable, the code.
    // Whatever Wati calls it ("1", "otp", …) is what the send must name.
    return { available: true, template: name, param: t.params[0] ?? "1" };
  })().catch((e): OtpAvailability => ({
    available: false,
    why: `Could not check: ${e instanceof Error ? e.message : "unknown error"}`,
  }));
  availabilityCache = { at: Date.now(), value };
  return value;
}

/** For tests and after a settings change. */
export function forgetOtpAvailability() {
  availabilityCache = null;
}

/** An account by work number or email — the same lookup the password sign-in uses. */
export async function findAccount(identifier: string) {
  const id = identifier.trim();
  const digits = id.replace(/\D/g, "");
  const last10 = digits.length >= 10 ? digits.slice(-10) : null;
  const [user] = await db
    .select()
    .from(users)
    .where(
      last10
        ? sql`lower(${users.email}) = lower(${id}) or right(regexp_replace(coalesce(${users.phone}, ''), '[^0-9]', '', 'g'), 10) = ${last10}`
        : sql`lower(${users.email}) = lower(${id})`,
    )
    .limit(1);
  return user ?? null;
}

export type SendResult =
  | { ok: true; sentTo: string; expiresInMinutes: number }
  | { ok: false; error: string; retryInSeconds?: number };

/**
 * Sends a fresh code for one purpose to the account's own work number.
 * Every refusal says what to do instead, because the person is standing at a
 * login screen with nobody to ask.
 */
export async function sendOtp(userId: string, purpose: OtpPurpose): Promise<SendResult> {
  const avail = await otpAvailability();
  if (!avail.available) return { ok: false, error: "Sign-in codes on WhatsApp are not set up yet. Use your password." };

  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user || !user.active) return { ok: false, error: "That account is not open. Ask your manager." };
  const to = waNumber(user.phone);
  if (!to) {
    return { ok: false, error: "There is no mobile number on this account to send a code to. Use your password, or ask your manager to add your number." };
  }

  const config = await getConfig();
  const cooldown = Number(config["auth.otp.resendCooldownSeconds"]);
  const windowMin = Number(config["auth.otp.requestWindowMinutes"]);
  const cap = Number(config["auth.otp.maxRequestsPerWindow"]);
  const ttl = Number(config["auth.otp.ttlMinutes"]);
  const digits = Number(config["auth.otp.codeLength"]);

  const [last] = await db
    .select({ createdAt: authOtps.createdAt })
    .from(authOtps)
    .where(and(eq(authOtps.userId, userId), eq(authOtps.purpose, purpose)))
    .orderBy(desc(authOtps.createdAt))
    .limit(1);
  if (last) {
    const wait = Math.ceil(cooldown - (Date.now() - last.createdAt.getTime()) / 1000);
    if (wait > 0) return { ok: false, error: `A code was just sent. You can ask for another in ${wait} seconds.`, retryInSeconds: wait };
  }
  const [recent] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(authOtps)
    .where(and(eq(authOtps.userId, userId), gt(authOtps.createdAt, new Date(Date.now() - windowMin * 60_000))));
  if (Number(recent?.n ?? 0) >= cap) {
    return { ok: false, error: `Too many codes asked for in the last ${windowMin} minutes. Use your password, or try again later.` };
  }

  const id = `otp_${randomUUID().slice(0, 12)}`;
  const code = String(randomInt(0, 10 ** digits)).padStart(digits, "0");
  await db.insert(authOtps).values({
    id,
    userId,
    purpose,
    destination: to,
    codeHash: hashOf(id, code),
    expiresAt: new Date(Date.now() + ttl * 60_000),
  });

  const sent = await sendWatiTemplate({
    templateName: avail.template,
    phone: to,
    params: [{ name: avail.param, value: code }],
    localMessageId: id,
    broadcastName: "mahekone_sign_in_code",
  });
  if (!sent.ok) {
    await db.update(authOtps).set({ failureReason: sent.error }).where(eq(authOtps.id, id));
    return { ok: false, error: "The code could not be sent on WhatsApp just now. Use your password, or try again in a minute." };
  }
  await db.update(authOtps).set({ sentAt: new Date() }).where(eq(authOtps.id, id));
  return { ok: true, sentTo: maskNumber(to), expiresInMinutes: ttl };
}

export type VerifyResult = { ok: true } | { ok: false; error: string };

/**
 * Checks a code against the newest live one for this account and purpose.
 * One use; a wrong guess counts against it; an expired or used-up code says
 * so and asks for a new one rather than a retry that cannot succeed.
 */
export async function verifyOtp(userId: string, purpose: OtpPurpose, code: string): Promise<VerifyResult> {
  const typed = code.replace(/\D/g, "");
  if (!typed) return { ok: false, error: "Enter the code from WhatsApp." };
  const config = await getConfig();
  const maxAttempts = Number(config["auth.otp.maxVerifyAttempts"]);

  const [row] = await db
    .select()
    .from(authOtps)
    .where(and(eq(authOtps.userId, userId), eq(authOtps.purpose, purpose), isNull(authOtps.consumedAt)))
    .orderBy(desc(authOtps.createdAt))
    .limit(1);
  if (!row || !row.sentAt) return { ok: false, error: "No code is waiting for this account. Ask for one first." };
  if (row.expiresAt.getTime() < Date.now()) return { ok: false, error: "That code has expired. Ask for a new one." };
  if (row.attempts >= maxAttempts) return { ok: false, error: "Too many wrong tries for that code. Ask for a new one." };

  const a = Buffer.from(hashOf(row.id, typed));
  const b = Buffer.from(row.codeHash);
  const match = a.length === b.length && timingSafeEqual(a, b);
  if (!match) {
    await db.update(authOtps).set({ attempts: sql`${authOtps.attempts} + 1` }).where(eq(authOtps.id, row.id));
    const left = maxAttempts - row.attempts - 1;
    return { ok: false, error: left > 0 ? `That code is not right. ${left} ${left === 1 ? "try" : "tries"} left.` : "That code is not right, and it has now stopped working. Ask for a new one." };
  }
  // Consumed atomically: two submissions of one right code sign in once.
  const used = await db
    .update(authOtps)
    .set({ consumedAt: new Date() })
    .where(and(eq(authOtps.id, row.id), isNull(authOtps.consumedAt)))
    .returning({ id: authOtps.id });
  if (!used.length) return { ok: false, error: "That code has already been used. Ask for a new one." };
  return { ok: true };
}

/**
 * A forgotten password, set again with a `password_reset` code. Same
 * consequences as the emailed link: every session on the account ends, and
 * any reset link still waiting stops working.
 */
export async function resetPasswordWithOtp(
  userId: string,
  code: string,
  newPassword: string,
): Promise<VerifyResult> {
  const verified = await verifyOtp(userId, "password_reset", code);
  if (!verified.ok) return verified;
  const passwordHash = await hashPassword(newPassword);
  await db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, userId));
    await tx
      .update(passwordResets)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordResets.userId, userId), isNull(passwordResets.usedAt)));
    await tx.delete(sessions).where(eq(sessions.userId, userId));
  });
  return { ok: true };
}
