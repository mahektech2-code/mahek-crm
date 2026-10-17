"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "@/db";
import {
  appAccess,
  auditLog,
  passwordResets,
  sessions,
  users,
} from "@/db/schema";
import { requirePlatformAdminUser } from "@/lib/access-control";
import { err as fail, ok, type Result } from "@/lib/result";
import { mailConfigured, sendMail } from "@/lib/mailer";
import {
  appOrigin,
  hashResetToken,
  newResetToken,
  RESET_TTL_MINUTES,
} from "@/lib/password-reset";
import { ADMIN } from "@/lib/admin-routes";
import { ConsoleNotConfirmedError } from "@/lib/console-confirm";

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

/**
 * A PLATFORM ADMINISTRATOR, and nobody else — the same bar `setAccess` sets.
 *
 * It was `isManager`, the widest level held anywhere, so a manager of any app
 * could disable every administrator, end their sessions, or (through the
 * identity action this file used to export) move an administrator's sign-in
 * address and mail themselves its reset link. Removed with it: `setUserRole`,
 * `setUserApps`, `createUser` and `updateUserIdentity`, which no screen called
 * and which were a second door onto the account level and the app grants —
 * one that knew nothing about modules, levels or the last administrator.
 */
async function manager() {
  try {
    return await requirePlatformAdminUser();
  } catch (e) {
    if (e instanceof ConsoleNotConfirmedError) throw e;
    throw new Error("Only a platform administrator can change accounts.");
  }
}

/** Whether anybody other than this person is an active platform administrator. */
async function anotherPlatformAdmin(userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: users.id })
    .from(appAccess)
    .innerJoin(users, eq(users.id, appAccess.userId))
    .where(
      and(
        eq(appAccess.app, "admin"),
        eq(appAccess.role, "admin"),
        eq(users.active, true),
        ne(users.id, userId),
      ),
    )
    .limit(1);
  return rows.length > 0;
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
    revalidatePath(ADMIN.home, "layout");
    revalidatePath("/apps");
  } catch {
    /* outside a request, which is fine */
  }
}



/**
 * Deactivation is a status, never a deletion — the same rule customers follow.
 * A leaver's calls, orders and audit trail outlive their login.
 *
 * Their APPS outlive it too. Disabling is about whether the person can sign in,
 * not about what they would find if they did — somebody disabled for a month's
 * leave comes back to the book they left, and a leaver's grants are still the
 * record of what they could reach. Taking the apps away is a separate decision,
 * made on the Access screen, and conflating the two would silently destroy it.
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
  if (!active && !(await anotherPlatformAdmin(userId))) {
    const [admin] = await db
      .select({ id: appAccess.id })
      .from(appAccess)
      .where(and(eq(appAccess.userId, userId), eq(appAccess.app, "admin"), eq(appAccess.role, "admin")))
      .limit(1);
    if (admin) {
      return fail(`${before.name} is the only platform administrator, so their sign-in cannot be turned off.`);
    }
  }

  const ended = await db.transaction(async (tx) => {
    await tx.update(users).set({ active, updatedAt: new Date() }).where(eq(users.id, userId));
    if (active) return 0;
    /*
     * Sessions go with the account.
     *
     * `getCurrentUser` already refuses an inactive account, so a live tab stops
     * working on its next request either way — this is not what makes disabling
     * safe. It is that a session row is good for thirty days, and a leaver's
     * sitting in the table for a month is a thing somebody has to reason about
     * later. Disabling should leave nothing to reason about.
     */
    const gone = await tx
      .delete(sessions)
      .where(eq(sessions.userId, userId))
      .returning({ id: sessions.id });
    return gone.length;
  });

  await audit(actor.id, active ? "reactivate-user" : "deactivate-user", userId, before.name);
  refresh();
  return ok(
    null,
    active
      ? `${before.name} can sign in again, and opens what they opened before.`
      : `${before.name} can no longer sign in.` +
        (ended ? ` ${ended} open session${ended === 1 ? "" : "s"} ended.` : "") +
        " Their apps are kept, so enabling them again restores what they had.",
  );
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
  /* AN ACCOUNT NEED NOT HAVE AN EMAIL. A work number and a password is a whole
     credential, and a field salesman issued a handset and a number has no
     company mailbox to send anything to. There is nowhere for this link to go,
     so the refusal names the thing that does work rather than reporting a
     failure the person reading it cannot act on. */
  if (!user.email) {
    return fail(
      `${user.name} has no work email on their account, so there is nowhere to send a link. Generate a password to read out to them instead.`,
      "rule_violation",
    );
  }
  const to = user.email;

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
    to,
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

  await audit(actor.id, "send-password-reset", user.id, `Link sent to ${to}`);
  refresh();

  // Said plainly rather than claimed: without a key the mail goes to the
  // server log, and the person waiting for it will wait forever.
  return ok(
    null,
    mailConfigured()
      ? `Reset link sent to ${to}. It expires in ${RESET_TTL_MINUTES} minutes.`
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

