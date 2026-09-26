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
import { err as fail, ok as okData, okVoid as ok, type Result } from "@/lib/result";
import { otpAvailability, sendOtp, verifyOtp } from "@/lib/services/otp-service";

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
    current: z.string(),
    code: z.string(),
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
  .refine((v) => !v.current || v.password !== v.current, {
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
    current: formData.get("current") ?? "",
    code: formData.get("code") ?? "",
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

  // WHERE WhatsApp codes are set up, a code to the person's own phone is what
  // proves it is them — Mahek's rule for changing a password. Where they are
  // not, the current password does, exactly as before.
  if ((await otpAvailability()).available) {
    const verified = await verifyOtp(user.id, "password_change", parsed.data.code);
    if (!verified.ok) {
      return fail(verified.error, "validation", [{ field: "code", message: verified.error }]);
    }
  } else {
    if (!parsed.data.current) {
      return fail("Enter your current password.", "validation", [
        { field: "current", message: "Enter your current password." },
      ]);
    }
    if (!(await verifyPassword(parsed.data.current, row.passwordHash))) {
      return fail("That is not your current password.", "validation", [
        { field: "current", message: "That is not your current password." },
      ]);
    }
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

/** Sends the signed-in person a code on WhatsApp to change their password with. */
export async function sendPasswordChangeCode(): Promise<Result<{ sentTo: string }>> {
  const user = await requireUser();
  const sent = await sendOtp(user.id, "password_change");
  if (!sent.ok) return fail(sent.error);
  return okData({ sentTo: sent.sentTo }, `Code sent to ${sent.sentTo} on WhatsApp`);
}

/** Whether the change-password dialog should ask for a code instead of the current password. */
export async function passwordChangeUsesCode(): Promise<boolean> {
  return (await otpAvailability()).available;
}
