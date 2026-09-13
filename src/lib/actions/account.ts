"use server";

import { randomUUID } from "node:crypto";
import { and, eq, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLog, passwordResets, sessions, users } from "@/db/schema";
import {
  currentSessionId,
  hashPassword,
  requireUser,
  verifyPassword,
} from "@/lib/auth";
import { err as fail, okVoid as ok, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * What a person may do to their OWN account, from the account menu in every
 * header and sidebar.
 *
 * ITS OWN FILE, and not `actions/auth.ts` beside it, for a reason worth
 * writing down: that module imports `redirect` from `next/navigation` at the
 * top level, which drags in the client React runtime — so nothing in it can be
 * loaded by the integration tests, and nothing in it is tested. A password
 * change has four rules that all fail silently when they are wrong, and the
 * one thing it must not be is untestable.
 * ------------------------------------------------------------------------- */

const passwordChange = z
  .object({
    current: z.string().min(1, "Enter your current password."),
    password: z.string().min(8, "Passwords must be at least 8 characters."),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    message: "The two passwords do not match.",
    path: ["confirm"],
  })
  /*
   * A NEW PASSWORD THAT IS THE OLD ONE IS NOT A CHANGE, and saying "Saved" to
   * it is the worst answer available: somebody changing their password because
   * they think it has been seen would walk away believing they had.
   */
  .refine((v) => v.password !== v.current, {
    message: "That is the password you already have. Choose a different one.",
    path: ["password"],
  });

/**
 * Changing your own password.
 *
 * IT ASKS FOR THE CURRENT ONE, which `resetPassword` cannot and does not: a
 * reset link IS the proof, spent once and expiring, while this form is
 * reachable from any signed-in tab — including one left open on a shared
 * machine on the sales floor. Without the old password, walking past an
 * unlocked screen would be enough to take an account over.
 *
 * EVERY OTHER SESSION ENDS AND THIS ONE STAYS. `resetPassword` ends the lot
 * and is right to: a reset is a password that may have leaked being contained,
 * so the sessions opened with the old one have to go or the change bought
 * nothing. This is that reasoning applied to somebody who is standing here —
 * the laptop they left signed in at home is exactly what they are ending, and
 * signing them out of the tab they are looking at teaches them that changing a
 * password is a thing that costs you your afternoon.
 *
 * Any live reset link dies with it. Somebody who asked for one, remembered
 * their password and changed it by hand has left a working link in an inbox,
 * and the whole point of that link is that holding it is enough.
 */
export async function changePassword(
  _prev: Result | null,
  formData: FormData,
): Promise<Result> {
  const user = await requireUser();

  const parsed = passwordChange.safeParse({
    current: formData.get("current"),
    password: formData.get("password"),
    confirm: formData.get("confirm"),
  });
  if (!parsed.success) {
    // Under the field it names. These dialogs used to pin whatever the server
    // said to the first box on the form, which points at the one field that
    // was correct.
    const issue = parsed.error.issues[0];
    return fail(issue.message, "validation", [
      { field: String(issue.path[0] ?? "password"), message: issue.message },
    ]);
  }

  /*
   * Read the hash back rather than trusting the session's copy: `requireUser`
   * is cached for the request, so an account whose password changed a moment
   * ago in another tab would be checked against the one this request loaded.
   */
  const [row] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  if (!row) return fail("That account no longer exists.", "not_found");

  if (!(await verifyPassword(parsed.data.current, row.passwordHash))) {
    return fail("That is not your current password.", "validation", [
      { field: "current", message: "That is not your current password." },
    ]);
  }

  const passwordHash = await hashPassword(parsed.data.password);
  const keep = await currentSessionId();

  // One transaction: the password, the links it makes pointless, and the
  // sessions opened with the old one. A half-applied change is an account
  // whose password moved and whose other devices did not.
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, user.id));
    await tx
      .update(passwordResets)
      .set({ usedAt: new Date() })
      .where(
        and(eq(passwordResets.userId, user.id), isNull(passwordResets.usedAt)),
      );
    await tx
      .delete(sessions)
      .where(
        keep
          ? and(eq(sessions.userId, user.id), ne(sessions.id, keep))
          : eq(sessions.userId, user.id),
      );
  });

  await db.insert(auditLog).values({
    id: `aud_${randomUUID().slice(0, 12)}`,
    actorId: user.id,
    action: "change-password",
    entityType: "user",
    entityId: user.id,
  });

  /*
   * The sentence names what ELSE happened, because that is the half nobody
   * expects: a password saved is obvious, a phone at home signed out is not,
   * and finding that out by being locked out of it tomorrow reads as a fault.
   */
  return ok(
    "Password changed. Every other device signed in to this account has been signed out.",
  );
}
