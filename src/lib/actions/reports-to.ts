"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, users } from "@/db/schema";
import { requirePlatformAdminUser } from "@/lib/access-control";
import { err as fail, ok, type Result } from "@/lib/result";
import { ADMIN } from "@/lib/admin-routes";
import { reportsToRefusal } from "@/lib/reports-to";

/* ---------------------------------------------------------------------------
 * Setting who somebody reports to (`users.reports_to_id`).
 *
 * The line drives a CRM manager's team, a sales manager's managed salesmen
 * and who the handset tells about somebody's day — see `lib/reports-to.ts` —
 * and until this file nothing outside the seed wrote it. It is the ACCOUNT's
 * line: the HRMS org chart (`employee_reporting`) is a separate answer kept by
 * HR, and this does not touch it.
 *
 * A PLATFORM ADMINISTRATOR only, for the reason `setAccess` is: moving
 * somebody under yourself widens your team scope to their whole book, which
 * is a grant of access in everything but name. A server action is a URL, so
 * the check is here and not only in front of the screen.
 * ------------------------------------------------------------------------- */

const newId = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

export async function setReportsTo(userId: string, managerId: string | null): Promise<Result<null>> {
  let actor;
  try {
    actor = await requirePlatformAdminUser();
  } catch (e) {
    /* The console's own sentence where the password needs proving again;
       otherwise the plain refusal. Either reaches the toast as words. */
    if (e instanceof Error && e.name === "ConsoleNotConfirmedError") return fail(e.message);
    return fail("Only a platform administrator can change who somebody reports to.");
  }

  /* Everybody, small enough to read whole (it is the account list), so the
     loop is walked in memory by the same function the page uses. */
  const people = await db
    .select({ id: users.id, name: users.name, active: users.active, reportsToId: users.reportsToId })
    .from(users);
  const me = people.find((p) => p.id === userId);
  if (!me) return fail("That account no longer exists.");
  const next = managerId || null;
  if ((me.reportsToId ?? null) === next) return ok(null, "No change.");

  const refusal = reportsToRefusal(userId, next, people);
  if (refusal) return fail(refusal);

  const nameOf = (id: string | null) => (id ? (people.find((p) => p.id === id)?.name ?? null) : null);
  const before = { reportsToId: me.reportsToId ?? null, reportsToName: nameOf(me.reportsToId) };
  const after = { reportsToId: next, reportsToName: nameOf(next) };

  await db.transaction(async (tx) => {
    await tx.update(users).set({ reportsToId: next, updatedAt: new Date() }).where(eq(users.id, userId));
    await tx.insert(auditLog).values({
      id: newId("aud"),
      actorId: actor.id,
      action: "access.reports_to",
      entityType: "user",
      entityId: userId,
      /* The only hat that reaches this file — see above. */
      actorRole: "admin",
      actorApp: "admin",
      beforeState: before as never,
      afterState: {
        ...after,
        detail: next
          ? `${me.name} now reports to ${after.reportsToName}${before.reportsToName ? ` (was ${before.reportsToName})` : ""}.`
          : `${me.name} now reports to nobody${before.reportsToName ? ` (was ${before.reportsToName})` : ""}.`,
      } as never,
    });
  });

  try {
    /* Both people's pages: the person's "Reports to", and the old and new
       managers' "Manages N people". The layout form covers every tab. */
    for (const id of new Set([userId, me.reportsToId, next].filter((x): x is string => !!x))) {
      revalidatePath(ADMIN.person(id), "layout");
    }
    revalidatePath(ADMIN.access);
  } catch {
    /* outside a request, which is fine */
  }

  return ok(null, next ? `${me.name} now reports to ${after.reportsToName}.` : `${me.name} now reports to nobody.`);
}
