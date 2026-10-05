import "server-only";
import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { authOtps, employees, passwordResets, sessions, users } from "@/db/schema";
import { hashPassword } from "../password";
import { getConfig } from "../config/store";
import { isApproved, listWatiTemplates, sendWatiTemplate, watiConfig } from "../wati";
import { waNumber } from "../whatsapp-delivery";
import { isTestKey, minimothKey, sendMiniMothOtp, verifyMiniMothOtp } from "../minimoth";

/* ---------------------------------------------------------------------------
 * One-time codes on WhatsApp — for signing in (web and MBOS handset), for
 * changing a password, and for resetting a forgotten one.
 *
 * THE CODE GOES TO THE PERSONAL MOBILE IN HRMS, for every purpose — signing
 * in, changing a password, resetting one — and never to a number typed at the
 * screen. It used to go to the work number on the account; Mahek asked for the
 * employee's own phone instead, as HR keeps it, so one number is somebody's
 * way in on the web and on the MBOS handset alike. It is read through
 * `users.employee_id` and nothing looser: the email/company-mobile guess the
 * pay screens fall back on is wrong on this book (two Pritesh rows share one
 * company mobile), and a guess here would send a sign-in code to the wrong
 * person. An account with no link, or a linked employee with no personal
 * mobile, gets no code and is told why — the password still works.
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
 *
 * TWO WAYS TO SEND, and MiniMoth is asked first. A MiniMoth key
 * (`minimoth.apiKey`, set under Admin Console → Integrations) is all it needs:
 * no template to get approved, WhatsApp first with an SMS fallback, under
 * MiniMoth's DLT registration rather than ours. MiniMoth makes and checks the
 * code itself, so its rows store `minimoth:<otp id>` where a Wati row stores a
 * hash — the digits never reach MahekOne. Every limit above still applies to
 * both: the cooldown, the window cap and wrong guesses are counted here,
 * whoever sent the code. `auth.otp.codeLength` and `ttlMinutes` do not apply
 * to MiniMoth's codes, which are six digits and live ten minutes.
 * ------------------------------------------------------------------------- */

export type OtpPurpose = "login" | "password_change" | "password_reset";

const hashOf = (id: string, code: string) => createHash("sha256").update(`${id}:${code}`).digest("hex");

/** "+91 98•••••001" — enough to recognise your own number, not enough to learn one. */
export function maskNumber(wa: string): string {
  const d = wa.replace(/\D/g, "");
  return `+${d.slice(0, 2)} ${d.slice(2, 4)}•••••${d.slice(-3)}`;
}

export type OtpAvailability =
  | { available: true; provider: "minimoth"; key: string }
  | { available: true; provider: "wati"; template: string; param: string }
  | { available: false; why: string };

const MINIMOTH_PREFIX = "minimoth:";

let availabilityCache: { at: number; value: OtpAvailability } | null = null;

/** Whether codes can be sent at all. Cached for a minute — every login screen asks. */
export async function otpAvailability(): Promise<OtpAvailability> {
  if (availabilityCache && Date.now() - availabilityCache.at < 60_000) return availabilityCache.value;
  // NEVER THROWS. The login page asks this, and the container's health check
  // IS the login page — a settings read that fails (a database still being
  // migrated, a Wati outage) must cost the WhatsApp option, never the sign-in
  // screen. The password form stands on its own.
  const value = await (async (): Promise<OtpAvailability> => {
    const mm = await minimothKey();
    /* A TEST KEY IS REFUSED IN PRODUCTION: it sends nothing and accepts
       000000 for every number, so on a real deployment it would let anybody
       who knows a colleague's work number sign in as them. */
    if (mm && !(isTestKey(mm) && process.env.NODE_ENV === "production")) {
      return { available: true, provider: "minimoth", key: mm };
    }
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
    return { available: true, provider: "wati", template: name, param: t.params[0] ?? "1" };
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

const last10Of = (col: unknown) => sql`right(regexp_replace(coalesce(${col}, ''), '[^0-9]', '', 'g'), 10)`;

/**
 * An account by email, work number or HRMS personal mobile — the one lookup
 * every sign-in uses: password and code, web and handset.
 *
 * The personal mobile is asked LAST and only through the explicit employee
 * link, and it must name exactly one account. A number that is one person's
 * work number and another's personal mobile goes on meaning the work number,
 * so nobody's existing sign-in moves; one that names two accounts names
 * nobody, rather than signing somebody in as whichever came first.
 */
export async function findAccount(identifier: string) {
  const id = identifier.trim();
  const digits = id.replace(/\D/g, "");
  const last10 = digits.length >= 10 ? digits.slice(-10) : null;
  const [user] = await db
    .select()
    .from(users)
    .where(
      last10
        ? sql`lower(${users.email}) = lower(${id}) or ${last10Of(users.phone)} = ${last10}`
        : sql`lower(${users.email}) = lower(${id})`,
    )
    .limit(1);
  if (user || !last10) return user ?? null;
  const viaHr = await db
    .select({ user: users })
    .from(users)
    .innerJoin(employees, eq(employees.id, users.employeeId))
    .where(sql`${last10Of(employees.personalMobile)} = ${last10}`)
    .limit(2);
  return viaHr.length === 1 ? viaHr[0].user : null;
}

/**
 * Where this account's codes go: the personal mobile of the HRMS employee it
 * is linked to. A refusal, in words, where there is none — the person is at a
 * login screen with nobody to ask.
 */
export async function otpDestination(
  userId: string,
): Promise<{ ok: true; to: string } | { ok: false; error: string }> {
  const [row] = await db
    .select({ employeeId: users.employeeId, personalMobile: employees.personalMobile })
    .from(users)
    .leftJoin(employees, eq(employees.id, users.employeeId))
    .where(eq(users.id, userId));
  if (!row?.employeeId) {
    return {
      ok: false,
      error: "OTPs go to your personal mobile in HRMS, and your account is not linked to an HRMS record yet. Use your password, or ask an administrator to link it.",
    };
  }
  const to = waNumber(row.personalMobile);
  if (!to) {
    return {
      ok: false,
      error: "OTPs go to your personal mobile in HRMS, and there is none on your HRMS record. Use your password, or ask HR to add it.",
    };
  }
  return { ok: true, to };
}

export type SendResult =
  | { ok: true; sentTo: string; expiresInMinutes: number }
  | { ok: false; error: string; retryInSeconds?: number };

/**
 * Sends a fresh code for one purpose to the personal mobile in HRMS.
 * Every refusal says what to do instead, because the person is standing at a
 * login screen with nobody to ask.
 */
export async function sendOtp(userId: string, purpose: OtpPurpose): Promise<SendResult> {
  const avail = await otpAvailability();
  if (!avail.available) return { ok: false, error: "OTP sign-in is not set up yet. Use your password." };

  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user || !user.active) return { ok: false, error: "That account is not open. Ask your manager." };
  const dest = await otpDestination(user.id);
  if (!dest.ok) return { ok: false, error: dest.error };
  const to = dest.to;

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
    if (wait > 0) return { ok: false, error: `An OTP was just sent. You can ask for another in ${wait} seconds.`, retryInSeconds: wait };
  }
  const [recent] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(authOtps)
    .where(and(eq(authOtps.userId, userId), gt(authOtps.createdAt, new Date(Date.now() - windowMin * 60_000))));
  if (Number(recent?.n ?? 0) >= cap) {
    return { ok: false, error: `Too many OTPs asked for in the last ${windowMin} minutes. Use your password, or try again later.` };
  }

  const id = `otp_${randomUUID().slice(0, 12)}`;

  if (avail.provider === "minimoth") {
    const sent = await sendMiniMothOtp(avail.key, to);
    if (!sent.ok) {
      /* Recorded so the failure is visible, and so it still counts towards
         the window cap — a number that keeps failing must not be retried
         without limit. `sent_at` stays null, so the row can never verify. */
      await db.insert(authOtps).values({
        id,
        userId,
        purpose,
        destination: to,
        codeHash: MINIMOTH_PREFIX,
        expiresAt: new Date(),
        failureReason: `${sent.code}: ${sent.error}`,
      });
      return { ok: false, error: "The OTP could not be sent just now. Use your password, or try again in a minute." };
    }
    await db.insert(authOtps).values({
      id,
      userId,
      purpose,
      destination: to,
      codeHash: `${MINIMOTH_PREFIX}${sent.otpId}`,
      expiresAt: sent.expiresAt,
      sentAt: new Date(),
    });
    const minutes = Math.max(1, Math.round((sent.expiresAt.getTime() - Date.now()) / 60_000));
    return { ok: true, sentTo: maskNumber(to), expiresInMinutes: minutes };
  }

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
    return { ok: false, error: "The OTP could not be sent just now. Use your password, or try again in a minute." };
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
  if (!typed) return { ok: false, error: "Enter the OTP." };
  const config = await getConfig();
  const maxAttempts = Number(config["auth.otp.maxVerifyAttempts"]);

  const [row] = await db
    .select()
    .from(authOtps)
    .where(and(eq(authOtps.userId, userId), eq(authOtps.purpose, purpose), isNull(authOtps.consumedAt)))
    .orderBy(desc(authOtps.createdAt))
    .limit(1);
  if (!row || !row.sentAt) return { ok: false, error: "No OTP is waiting for this account. Ask for one first." };
  if (row.expiresAt.getTime() < Date.now()) return { ok: false, error: "That OTP has expired. Ask for a new one." };
  if (row.attempts >= maxAttempts) return { ok: false, error: "Too many wrong tries for that OTP. Ask for a new one." };

  let match: boolean;
  if (row.codeHash.startsWith(MINIMOTH_PREFIX)) {
    /* MiniMoth holds the code, so MiniMoth is asked. A failure to REACH it is
       not a wrong guess and is not counted as one. */
    const key = await minimothKey();
    if (!key) return { ok: false, error: "OTP sign-in is not set up any more. Use your password." };
    const checked = await verifyMiniMothOtp(key, row.destination, typed);
    if (!checked.ok) return { ok: false, error: "The OTP could not be checked just now. Try again in a minute, or use your password." };
    match = checked.valid;
  } else {
    const a = Buffer.from(hashOf(row.id, typed));
    const b = Buffer.from(row.codeHash);
    match = a.length === b.length && timingSafeEqual(a, b);
  }
  if (!match) {
    await db.update(authOtps).set({ attempts: sql`${authOtps.attempts} + 1` }).where(eq(authOtps.id, row.id));
    const left = maxAttempts - row.attempts - 1;
    return { ok: false, error: left > 0 ? `That OTP is not right. ${left} ${left === 1 ? "try" : "tries"} left.` : "That OTP is not right, and it has now stopped working. Ask for a new one." };
  }
  // Consumed atomically: two submissions of one right code sign in once.
  const used = await db
    .update(authOtps)
    .set({ consumedAt: new Date() })
    .where(and(eq(authOtps.id, row.id), isNull(authOtps.consumedAt)))
    .returning({ id: authOtps.id });
  if (!used.length) return { ok: false, error: "That OTP has already been used. Ask for a new one." };
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
