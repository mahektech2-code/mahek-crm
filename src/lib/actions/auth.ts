"use server";

import { redirect } from "next/navigation";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { appAccess, otpCodes, passwordResets, sessions, users } from "@/db/schema";
import {
  createSession,
  destroySession,
  getCurrentUser,
  hashPassword,
  requireManager,
} from "@/lib/auth";
import { listUserApps, recordSignIn, recordSignOut } from "@/lib/access";
import { getApp, type AppId } from "@/lib/apps";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { auditLog } from "@/db/schema";
import {
  err as fail,
  ok as ok2,
  okVoid as ok,
  type Result as ActionResult,
} from "@/lib/result";
import { mailConfigured, sendMail } from "@/lib/mailer";
import {
  appOrigin,
  findLiveReset,
  hashResetToken,
  newResetToken,
  RESET_TTL_MINUTES,
} from "@/lib/password-reset";
import { getConfig } from "@/lib/config/store";
import { hashOtpCode, maskPhone, newOtpCode, normalisePhone } from "@/lib/otp";
import { sendOtpCode, type OtpChannel } from "@/lib/otp-provider";

const newId = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

async function audit(
  user: { id: string } | null,
  action: string,
  entityType: string,
  entityId?: string | null,
  detail?: string | null,
) {
  await db.insert(auditLog).values({
    id: newId("aud"),
    actorId: user?.id ?? null,
    action,
    entityType,
    entityId: entityId ?? null,
    afterState: detail ? ({ detail } as never) : null,
  });
}

/* ---------------------------------------------------------------------------
 * One sign-in for all of MahekOne, and no password on the web any more — a
 * work number and a code sent to it is the whole credential. Where it lands
 * you depends on what you can open: one app goes straight in, several go to
 * the launcher.
 *
 * `users.password_hash` still exists and is untouched: MBOS, the field
 * salesman handset app, pairs with it over its own API and that contract
 * cannot change from here — see AGENTS.md. This file only changes how a
 * BROWSER signs in.
 * ------------------------------------------------------------------------- */

export type OtpStep = { phone: string; masked: string; channel: OtpChannel };

const phoneRequest = z.object({
  phone: z.string().trim().min(1, "Enter your work number."),
  channel: z.enum(["sms", "whatsapp"]),
});

/**
 * Same response whether or not the number has an account, for the same
 * reason `requestPasswordReset` never says: this form must not become a way
 * to find out who else works here.
 */
const SENT_MESSAGE = "If that number has an account, a code is on its way.";

export async function requestOtp(
  _prev: ActionResult<OtpStep> | null,
  formData: FormData,
): Promise<ActionResult<OtpStep>> {
  const parsed = phoneRequest.safeParse({
    phone: formData.get("phone"),
    channel: formData.get("channel"),
  });
  if (!parsed.success) return fail(parsed.error.issues[0].message);

  const phone = normalisePhone(parsed.data.phone);
  if (!phone) return fail("Enter a valid 10-digit work number.");
  const { channel } = parsed.data;
  const step: OtpStep = { phone, masked: maskPhone(phone), channel };

  const [user] = await db.select().from(users).where(eq(users.phone, phone)).limit(1);
  if (!user || !user.active) return ok2(step, SENT_MESSAGE);

  const config = await getConfig();
  const windowStart = new Date(
    Date.now() - config["auth.otp.requestWindowMinutes"] * 60_000,
  );
  const recent = await db
    .select({ createdAt: otpCodes.createdAt })
    .from(otpCodes)
    .where(and(eq(otpCodes.userId, user.id), gt(otpCodes.createdAt, windowStart)))
    .orderBy(desc(otpCodes.createdAt));

  if (recent.length >= config["auth.otp.maxRequestsPerWindow"]) {
    return fail(
      `Too many codes requested for this number. Try again in ${config["auth.otp.requestWindowMinutes"]} minutes.`,
    );
  }
  const secondsSinceLast = recent[0]
    ? (Date.now() - recent[0].createdAt.getTime()) / 1000
    : Infinity;
  if (secondsSinceLast < config["auth.otp.resendCooldownSeconds"]) {
    const wait = Math.ceil(config["auth.otp.resendCooldownSeconds"] - secondsSinceLast);
    return fail(`Wait ${wait}s before requesting another code.`);
  }

  const code = newOtpCode(config["auth.otp.codeLength"]);
  await db.insert(otpCodes).values({
    id: newId("otp"),
    userId: user.id,
    codeHash: hashOtpCode(code),
    channel,
    expiresAt: new Date(Date.now() + config["auth.otp.ttlMinutes"] * 60_000),
  });

  const outcome = await sendOtpCode(phone, channel, code);
  return ok2(
    step,
    SENT_MESSAGE,
    outcome.delivered
      ? undefined
      : [
          outcome.reason === "not_configured"
            ? "No SMS/WhatsApp provider is configured, so the code was written to the server log instead of sent."
            : `The code could not be sent: ${outcome.reason === "not_ready" || outcome.reason === "failed" ? outcome.detail : "unknown error"}`,
        ],
  );
}

const otpVerification = z.object({
  phone: z.string().trim().min(1),
  code: z.string().trim().min(1, "Enter the code you were sent."),
  remember: z.boolean().default(true),
});

const WRONG_CODE = "That code was not right, or it has expired. Request a new one.";

export async function verifyOtp(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = otpVerification.safeParse({
    phone: formData.get("phone"),
    code: formData.get("code"),
    remember: formData.get("remember") === "on",
  });
  if (!parsed.success) return fail(parsed.error.issues[0].message);

  const phone = normalisePhone(parsed.data.phone);
  if (!phone) return fail(WRONG_CODE);

  const [user] = await db.select().from(users).where(eq(users.phone, phone)).limit(1);
  if (!user || !user.active) return fail(WRONG_CODE);

  const config = await getConfig();
  const [row] = await db
    .select()
    .from(otpCodes)
    .where(
      and(
        eq(otpCodes.userId, user.id),
        isNull(otpCodes.consumedAt),
        gt(otpCodes.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(otpCodes.createdAt))
    .limit(1);

  if (!row || row.attempts >= config["auth.otp.maxVerifyAttempts"]) {
    return fail(WRONG_CODE);
  }

  const submitted = Buffer.from(hashOtpCode(parsed.data.code.replace(/\D/g, "")), "hex");
  const stored = Buffer.from(row.codeHash, "hex");
  const matches =
    submitted.length === stored.length && timingSafeEqual(submitted, stored);

  if (!matches) {
    await db
      .update(otpCodes)
      .set({ attempts: row.attempts + 1 })
      .where(eq(otpCodes.id, row.id));
    return fail(WRONG_CODE);
  }

  await db.update(otpCodes).set({ consumedAt: new Date() }).where(eq(otpCodes.id, row.id));

  await createSession(user.id, parsed.data.remember);
  await recordSignIn(user.id, newId("att"));
  // Nothing wrote this column, so every screen that asked when somebody last
  // signed in answered "never" — including the console's list of accounts
  // nobody has ever used, which therefore accused the whole company.
  await db
    .update(users)
    .set({ lastLoginAt: new Date() })
    .where(eq(users.id, user.id));
  await audit(user, "sign-in", "user", user.id);

  const apps = await listUserApps(user.id);
  if (!apps.length) {
    // Signed in, but nobody has given them an app yet. Say so rather than
    // dropping them on an empty screen.
    redirect("/apps");
  }
  // One app is not a choice — go straight there.
  if (apps.length === 1) {
    redirect(getApp(apps[0])?.href ?? "/apps");
  }
  redirect("/apps");
}

export async function signOut() {
  const user = await getCurrentUser();
  if (user) {
    await recordSignOut(user.id);
    await audit(user, "sign-out", "user", user.id);
  }
  await destroySession();
  redirect("/login");
}

/* ------------------------------------------------------- password resets */

const resetRequest = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Enter the work email your account was created with.")
    .email("That does not look like an email address."),
});

/**
 * Nobody can be told whether an address has an account here — that would turn
 * this form into a staff directory — so the answer is the same either way and
 * the work happens only when there is somebody to send it to.
 */
export async function requestPasswordReset(
  _prev: ActionResult<string> | null,
  formData: FormData,
): Promise<ActionResult<string>> {
  const parsed = resetRequest.safeParse({ email: formData.get("email") });
  if (!parsed.success) return fail(parsed.error.issues[0].message);
  const { email } = parsed.data;

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (user && user.active) {
    const token = newResetToken();
    const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60_000);

    await db.transaction(async (tx) => {
      // Sending a new link kills the old one, which is what the screen says.
      await tx
        .update(passwordResets)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(passwordResets.userId, user.id),
            isNull(passwordResets.usedAt),
          ),
        );
      await tx.insert(passwordResets).values({
        id: newId("rst"),
        userId: user.id,
        tokenHash: hashResetToken(token),
        expiresAt,
      });
    });

    const link = `${await appOrigin()}/login/reset?token=${token}`;
    await sendMail({
      to: user.email,
      subject: "Set a new MahekOne password",
      text: [
        `Hello ${user.name.split(" ")[0]},`,
        "",
        "Somebody asked to reset the password on your MahekOne account.",
        `Open this link to set a new one - it works once and expires in ${RESET_TTL_MINUTES} minutes:`,
        "",
        link,
        "",
        "If that was not you, ignore this email. Your password has not changed.",
      ].join("\n"),
    });

    await audit(user, "request-password-reset", "user", user.id);
  }

  // Said regardless of whether an account was found, so the notice cannot be
  // read as an answer to "does this address have an account?".
  return ok2(
    email,
    "If that account exists, a reset link is on its way.",
    mailConfigured()
      ? undefined
      : [
          "No mail provider is configured, so the link was written to the server log instead of sent. Set RESEND_API_KEY and MAIL_FROM to send it for real.",
        ],
  );
}

const resetSubmission = z
  .object({
    token: z.string().trim().min(1),
    password: z.string().min(8, "Passwords must be at least 8 characters."),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    message: "The two passwords do not match.",
    path: ["confirm"],
  });

/**
 * Consuming the link is one transaction: the new password, the link marked
 * spent and every session that account had. A password changed because it may
 * have leaked has to end the sessions opened with the old one, or the change
 * bought nothing.
 */
export async function resetPassword(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = resetSubmission.safeParse({
    token: formData.get("token"),
    password: formData.get("password"),
    confirm: formData.get("confirm"),
  });
  if (!parsed.success) return fail(parsed.error.issues[0].message);

  const row = await findLiveReset(parsed.data.token);
  if (!row) {
    return fail(
      "That link has expired or has already been used. Ask for a new one.",
    );
  }

  const passwordHash = await hashPassword(parsed.data.password);
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, row.userId));
    await tx
      .update(passwordResets)
      .set({ usedAt: new Date() })
      .where(eq(passwordResets.id, row.id));
    await tx.delete(sessions).where(eq(sessions.userId, row.userId));
  });

  await audit({ id: row.userId }, "reset-password", "user", row.userId);
  redirect("/login?reset=1");
}

/* ------------------------------------------------------------- accounts */

export async function setAppAccess(
  userId: string,
  apps: AppId[],
): Promise<ActionResult> {
  let manager;
  try {
    manager = await requireManager();
  } catch {
    return fail("Only a manager can change app access.");
  }

  await db.transaction(async (tx) => {
    await tx.delete(appAccess).where(eq(appAccess.userId, userId));
    if (apps.length) {
      await tx.insert(appAccess).values(
        apps.map((app) => ({
          id: newId("acc"),
          userId,
          app,
          grantedById: manager.id,
        })),
      );
    }
  });

  await audit(manager, "set-app-access", "user", userId, apps.join(", "));
  return ok("App access updated");
}
