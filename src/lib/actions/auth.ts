"use server";

import { redirect } from "next/navigation";
import { and, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { appAccess, passwordResets, sessions, users } from "@/db/schema";
import {
  createSession,
  destroySession,
  getCurrentUser,
  hashPassword,
  requireManager,
  verifyPassword,
} from "@/lib/auth";
import { listUserApps, recordSignIn, recordSignOut } from "@/lib/access";
import { getApp, APP_IDS, type AppId } from "@/lib/apps";
import { randomUUID } from "node:crypto";
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
import { initialsOf } from "@/lib/format";

/* ---------------------------------------------------------------------------
 * One sign-in for all of MahekOne. Where it lands you depends on what you can
 * open: one app goes straight in, several go to the launcher.
 * ------------------------------------------------------------------------- */

const credentials = z.object({
  identifier: z
    .string()
    .trim()
    .min(1, "Enter your work number or email address."),
  password: z.string().min(1, "Enter your password."),
  remember: z.boolean().default(true),
});

/** Telecallers know their phone number; office staff know their email. */
function normalise(identifier: string) {
  const digits = identifier.replace(/\D/g, "");
  return {
    email: identifier.toLowerCase(),
    phone: digits.length >= 10 ? digits.slice(-10) : null,
  };
}

export async function signIn(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = credentials.safeParse({
    identifier: formData.get("identifier"),
    password: formData.get("password"),
    remember: formData.get("remember") === "on",
  });
  if (!parsed.success) {
    return fail(parsed.error.issues[0].message);
  }

  const { email, phone } = normalise(parsed.data.identifier);

  const [user] = await db
    .select()
    .from(users)
    .where(phone ? or(eq(users.email, email), eq(users.phone, phone)) : eq(users.email, email))
    .limit(1);

  // Same message either way — never reveal which half was wrong.
  const wrong =
    "That did not match an account. Check the spelling, or ask your manager to reset it.";
  if (!user || !user.active) return fail(wrong);
  if (!(await verifyPassword(parsed.data.password, user.passwordHash))) {
    return fail(wrong);
  }

  await createSession(user.id, parsed.data.remember);
  await recordSignIn(user.id, newId("att"));
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

const newUser = z.object({
  name: z.string().trim().min(2, "Enter the person's full name."),
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  phone: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v.replace(/\D/g, "").slice(-10) : undefined)),
  password: z.string().min(8, "Passwords must be at least 8 characters."),
  role: z.enum(["telecaller", "manager"]),
  apps: z.array(z.enum(APP_IDS)).min(1, "Give them at least one app."),
});

/** Managers create accounts — there is no self-signup on an internal tool. */
export async function createTeamMember(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let manager;
  try {
    manager = await requireManager();
  } catch {
    return fail("Only a manager can add team members.");
  }

  const parsed = newUser.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    phone: formData.get("phone"),
    password: formData.get("password"),
    role: formData.get("role"),
    apps: formData.getAll("apps"),
  });
  if (!parsed.success) return fail(parsed.error.issues[0].message);

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, parsed.data.email))
    .limit(1);
  if (existing.length) return fail("Somebody already uses that email address.");

  const id = newId("usr");
  await db.transaction(async (tx) => {
    await tx.insert(users).values({
      id,
      name: parsed.data.name,
      email: parsed.data.email,
      phone: parsed.data.phone || null,
      passwordHash: await hashPassword(parsed.data.password),
      role: parsed.data.role,
      initials: initialsOf(parsed.data.name),
    });
    await tx.insert(appAccess).values(
      parsed.data.apps.map((app) => ({
        id: newId("acc"),
        userId: id,
        app,
        grantedById: manager.id,
      })),
    );
  });

  await audit(manager, "create", "user", id, parsed.data.name);
  return ok(`${parsed.data.name} can now sign in.`);
}

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
