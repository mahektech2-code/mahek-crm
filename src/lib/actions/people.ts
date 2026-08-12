"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import {
  appAccess,
  appModuleAccess,
  auditLog,
  passwordResets,
  sessions,
  users,
} from "@/db/schema";
import { requireUser, isManager, hashPassword } from "@/lib/auth";
import { APP_IDS, type AppId } from "@/lib/apps";
import { initialsOf } from "@/lib/format";
import { err as fail, fieldErr, ok, type Result } from "@/lib/result";
import { mailConfigured, sendMail } from "@/lib/mailer";
import {
  appOrigin,
  hashResetToken,
  newResetToken,
  RESET_TTL_MINUTES,
} from "@/lib/password-reset";

/* ---------------------------------------------------------------------------
 * Writes for the People section.
 *
 * These are what the console's checkboxes used to only pretend to do. Every
 * one is checked server-side rather than by hiding a control: a screen that
 * disables a button has told the browser something, and the browser is not
 * where authority lives.
 *
 * Every change lands in the audit log with the manager who made it, because
 * "who can open payroll" is exactly the question somebody asks six months
 * later.
 * ------------------------------------------------------------------------- */

const newId = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

async function manager() {
  const user = await requireUser();
  if (!isManager(user)) throw new Error("Only a manager can change accounts.");
  return user;
}

async function audit(
  actorId: string,
  action: string,
  userId: string,
  detail: string,
) {
  await db.insert(auditLog).values({
    id: newId("aud"),
    actorId,
    action,
    entityType: "user",
    entityId: userId,
    afterState: { detail } as never,
  });
}

function refresh() {
  try {
    revalidatePath("/admin");
    revalidatePath("/apps");
  } catch {
    /* outside a request, which is fine */
  }
}

/** The complete set of apps an account may open. */
export async function setUserApps(
  userId: string,
  apps: string[],
): Promise<Result<{ apps: string[] }>> {
  let actor;
  try {
    actor = await manager();
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Not allowed.");
  }

  const wanted = [...new Set(apps)].filter((a): a is AppId => APP_IDS.includes(a as AppId));
  const unknown = [...new Set(apps)].filter((a) => !APP_IDS.includes(a as AppId));
  if (unknown.length) return fail(`Not an app: ${unknown.join(", ")}`);

  const current = await db
    .select({ app: appAccess.app })
    .from(appAccess)
    .where(eq(appAccess.userId, userId));
  const had = current.map((c) => c.app as AppId);

  const add = wanted.filter((a) => !had.includes(a));
  const remove = had.filter((a) => !wanted.includes(a));
  if (!add.length && !remove.length) return ok({ apps: wanted }, "No change.");

  await db.transaction(async (tx) => {
    if (remove.length) {
      await tx
        .delete(appAccess)
        .where(and(eq(appAccess.userId, userId), inArray(appAccess.app, remove)));
      // The module rows go with the app. Left behind, they would silently
      // narrow it the day somebody granted it back — a grant that opened four
      // screens of fourteen with nothing on any screen saying why.
      await tx
        .delete(appModuleAccess)
        .where(
          and(eq(appModuleAccess.userId, userId), inArray(appModuleAccess.app, remove)),
        );
    }
    if (add.length) {
      await tx.insert(appAccess).values(
        add.map((app) => ({ id: newId("acc"), userId, app, grantedById: actor.id })),
      );
    }
  });

  await audit(
    actor.id,
    "set-app-access",
    userId,
    `${had.sort().join(",") || "none"} → ${wanted.sort().join(",") || "none"}`,
  );
  refresh();

  const granted = add.length ? `granted ${add.join(", ")}` : "";
  const revoked = remove.length ? `revoked ${remove.join(", ")}` : "";
  return ok({ apps: wanted }, [granted, revoked].filter(Boolean).join("; "));
}

export async function setUserRole(
  userId: string,
  role: "telecaller" | "manager" | "accounts" | "admin",
): Promise<Result<null>> {
  let actor;
  try {
    actor = await manager();
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Not allowed.");
  }

  const [before] = await db
    .select({ role: users.role, name: users.name })
    .from(users)
    .where(eq(users.id, userId));
  if (!before) return fail("That account no longer exists.");
  if (before.role === role) return ok(null, "No change.");

  await db.update(users).set({ role, updatedAt: new Date() }).where(eq(users.id, userId));
  await audit(actor.id, "set-role", userId, `${before.role} → ${role}`);
  refresh();
  return ok(null, `${before.name} is now ${role}.`);
}

/**
 * Deactivation is a status, never a deletion — the same rule customers follow.
 * A leaver's calls, orders and audit trail outlive their login.
 */
export async function setUserActive(
  userId: string,
  active: boolean,
): Promise<Result<null>> {
  let actor;
  try {
    actor = await manager();
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Not allowed.");
  }

  const [before] = await db
    .select({ active: users.active, name: users.name })
    .from(users)
    .where(eq(users.id, userId));
  if (!before) return fail("That account no longer exists.");
  if (before.active === active) return ok(null, "No change.");

  if (!active && userId === actor.id) {
    return fail("You cannot deactivate your own account.");
  }

  await db.update(users).set({ active, updatedAt: new Date() }).where(eq(users.id, userId));
  await audit(actor.id, active ? "reactivate-user" : "deactivate-user", userId, before.name);
  refresh();
  return ok(null, `${before.name} ${active ? "reactivated" : "deactivated"}.`);
}

/** Name, work number and sign-in address. Never the password. */
export async function updateUserIdentity(
  userId: string,
  input: { name?: string; email?: string; phone?: string | null },
): Promise<Result<null>> {
  let actor;
  try {
    actor = await manager();
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Not allowed.");
  }

  const [before] = await db
    .select({ name: users.name, email: users.email, phone: users.phone })
    .from(users)
    .where(eq(users.id, userId));
  if (!before) return fail("That account no longer exists.");

  const patch: Partial<typeof users.$inferInsert> = {};
  const changed: string[] = [];

  if (input.name && input.name.trim() && input.name !== before.name) {
    patch.name = input.name.trim();
    // The avatar follows the name, or it keeps the previous person's letters.
    const parts = patch.name.split(/\s+/).filter(Boolean);
    patch.initials = (
      (parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : (parts[0]?.[1] ?? ""))
    ).toUpperCase();
    changed.push(`name ${before.name} → ${patch.name}`);
  }

  if (input.email && input.email.trim() && input.email !== before.email) {
    const email = input.email.trim().toLowerCase();
    const taken = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (taken.length && taken[0].id !== userId) {
      return fail(`${email} already belongs to another account.`);
    }
    patch.email = email;
    // This is a sign-in, not a label. Worth saying so where somebody will read
    // it rather than discovering it at the login screen.
    changed.push(`email ${before.email} → ${email} (this is their sign-in)`);
  }

  if (input.phone !== undefined) {
    const phone = input.phone ? input.phone.replace(/\D/g, "").slice(-10) : null;
    if (phone && !/^[6-9]\d{9}$/.test(phone)) {
      return fail("That is not a 10-digit Indian mobile number.");
    }
    if (phone !== before.phone) {
      patch.phone = phone;
      changed.push(`work number ${before.phone ?? "none"} → ${phone ?? "none"}`);
    }
  }

  if (!changed.length) return ok(null, "No change.");

  patch.updatedAt = new Date();
  await db.update(users).set(patch).where(eq(users.id, userId));
  await audit(actor.id, "update-user", userId, changed.join("; "));
  refresh();
  return ok(null, changed.join("; "));
}

/**
 * Send somebody a reset link from the console.
 *
 * The same machinery as `/login/forgot`, reached the other way round: a person
 * who cannot get in rings a manager rather than a form. Everything the public
 * path guarantees still holds — only the hash is stored, the link works once,
 * it expires in thirty minutes, and asking for a new one kills the old one.
 *
 * This was a menu item that recorded a line in an in-memory list and toasted
 * "reset link sent". Nothing was sent. Somebody would have been told to check
 * their email for a message that did not exist.
 */
export async function sendPasswordResetFor(userId: string): Promise<Result<null>> {
  let actor;
  try {
    actor = await manager();
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Not allowed.", "not_permitted");
  }

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return fail("That account no longer exists.", "not_found");
  if (!user.active) return fail("That account is deactivated, so it cannot be signed in to.");

  const token = newResetToken();
  const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60_000);

  await db.transaction(async (tx) => {
    await tx
      .update(passwordResets)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordResets.userId, user.id), isNull(passwordResets.usedAt)));
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
      `${actor.name} asked MahekOne to reset the password on your account.`,
      `Open this link to set a new one - it works once and expires in ${RESET_TTL_MINUTES} minutes:`,
      "",
      link,
      "",
      "If you were not expecting this, tell them. Your password has not changed.",
    ].join("\n"),
  });

  await audit(actor.id, "send-password-reset", user.id, `Link sent to ${user.email}`);
  refresh();

  // Said plainly rather than claimed: without a key the mail goes to the
  // server log, and the person waiting for it will wait forever.
  return ok(
    null,
    mailConfigured()
      ? `Reset link sent to ${user.email}. It expires in ${RESET_TTL_MINUTES} minutes.`
      : "No mail is configured on this deployment, so the link was written to the server log instead of sent.",
  );
}

/**
 * End every session an account has.
 *
 * Sessions are rows, so this takes effect on their next request rather than
 * whenever a token happens to expire.
 */
export async function endSessionsFor(userId: string): Promise<Result<{ ended: number }>> {
  let actor;
  try {
    actor = await manager();
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Not allowed.", "not_permitted");
  }

  const [user] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return fail("That account no longer exists.", "not_found");

  const gone = await db
    .delete(sessions)
    .where(eq(sessions.userId, userId))
    .returning({ id: sessions.id });

  await audit(actor.id, "end-sessions", userId, `${gone.length} ended`);
  refresh();

  return ok(
    { ended: gone.length },
    gone.length
      ? `${gone.length} session${gone.length === 1 ? "" : "s"} ended for ${user.name}.`
      : `${user.name} had no session open.`,
  );
}

/**
 * Create an account.
 *
 * The console's most prominent button, and until now the only thing it did was
 * toast "saved". Accounts are admin-created here — there is no sign-up — so a
 * password is set at creation and the person is told to change it; a reset
 * link from the row menu is the other way in.
 *
 * Apps are granted in the same breath, because an account that can open
 * nothing is somebody who cannot start work and will ring somebody about it.
 */
export async function createUser(input: {
  name: string;
  email: string;
  phone?: string | null;
  role: "telecaller" | "manager" | "accounts" | "admin";
  password: string;
  apps: string[];
}): Promise<Result<{ id: string }>> {
  let actor;
  try {
    actor = await manager();
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Not allowed.", "not_permitted");
  }

  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  const phone = input.phone?.trim() || null;

  if (name.length < 2) return fieldErr("name", "A name is needed.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return fieldErr("email", "That does not look like an email address.");
  }
  if (phone && !/^[6-9]\d{9}$/.test(phone)) {
    return fieldErr("phone", "A work number is ten digits, starting 6 to 9.");
  }
  if (input.password.length < 8) {
    return fieldErr("password", "Eight characters at least.");
  }

  // Both of these are how somebody signs in, so both have to be unique or the
  // sign-in form has two answers to one question.
  const clashes = await db
    .select({ email: users.email, phone: users.phone })
    .from(users)
    .where(phone ? or(eq(users.email, email), eq(users.phone, phone)) : eq(users.email, email));
  if (clashes.some((c) => c.email === email)) {
    return fieldErr("email", "An account already uses that email.");
  }
  if (phone && clashes.some((c) => c.phone === phone)) {
    return fieldErr("phone", "An account already uses that work number.");
  }

  const wanted = [...new Set(input.apps)].filter((a): a is AppId =>
    APP_IDS.includes(a as AppId),
  );

  const id = newId("usr");
  await db.transaction(async (tx) => {
    await tx.insert(users).values({
      id,
      name,
      email,
      phone,
      role: input.role,
      initials: initialsOf(name),
      passwordHash: await hashPassword(input.password),
      active: true,
    });
    if (wanted.length) {
      await tx.insert(appAccess).values(
        wanted.map((app) => ({ id: newId("acc"), userId: id, app, grantedById: actor.id })),
      );
    }
  });

  await audit(
    actor.id,
    "create-user",
    id,
    `${name} · ${input.role} · ${wanted.join(", ") || "no apps"}`,
  );
  refresh();

  return ok(
    { id },
    wanted.length
      ? `${name} can sign in with ${email}, and opens ${wanted.length} app${wanted.length === 1 ? "" : "s"}.`
      : `${name} can sign in with ${email}, but has no app yet — grant one or they land on an empty launcher.`,
  );
}
