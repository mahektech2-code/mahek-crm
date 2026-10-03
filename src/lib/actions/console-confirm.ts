"use server";

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, users } from "@/db/schema";
import { requireUser, verifyPassword } from "@/lib/auth";
import { markConsoleConfirmed } from "@/lib/console-confirm";
import { err as fail, type Result } from "@/lib/result";
import {
  accountKey,
  clearSignInFailures,
  clientAddress,
  recordSignInFailure,
  signInRefusal,
} from "@/lib/services/sign-in-throttle";

/**
 * Only somewhere inside the console. The address comes from the query string,
 * and a confirmation that could be told to land anywhere is a redirect any
 * link can aim at a page that is not ours.
 */
function safeNext(raw: FormDataEntryValue | null): string {
  const next = String(raw ?? "");
  return /^\/admin(\/[\w\-/.%]*)?$/.test(next) ? next : "/admin";
}

/**
 * Proves the password for the session already signed in, so the Admin Console
 * opens. It shares the sign-in's count of wrong passwords: a stolen session
 * cookie must not turn this box into somewhere to guess at leisure.
 */
export async function confirmConsolePassword(_prev: Result | null, formData: FormData): Promise<Result> {
  const user = await requireUser();
  const password = String(formData.get("password") ?? "");
  if (!password) return fail("Enter your password.");

  const account = accountKey(user.id, "");
  const address = await clientAddress();
  const refused = await signInRefusal(account, address);
  if (refused) return fail(refused);

  const [row] = await db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, user.id)).limit(1);
  if (!row || !(await verifyPassword(password, row.hash))) {
    await recordSignInFailure(account, address);
    return fail("That is not your password.");
  }
  await clearSignInFailures(account);
  await markConsoleConfirmed();
  await db.insert(auditLog).values({
    id: `aud_${randomUUID().slice(0, 12)}`,
    actorId: user.id,
    action: "sign-in-console",
    entityType: "user",
    entityId: user.id,
  });

  const { redirect } = await import("next/navigation");
  redirect(safeNext(formData.get("next")));
  throw new Error("unreachable"); // redirect() never returns
}
