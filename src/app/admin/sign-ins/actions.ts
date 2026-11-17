"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { ne } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, sessions } from "@/db/schema";
import { requirePlatformAdminUser } from "@/lib/access-control";
import { currentSessionId } from "@/lib/auth";
import { ADMIN } from "@/lib/admin-routes";
import { ConsoleNotConfirmedError } from "@/lib/console-confirm";
import { err as fail, ok, type Result } from "@/lib/result";

/*
 * What the Security screen does rather than reads: a platform administrator's,
 * audited under the code every "end sessions" already uses.
 */

async function admin() {
  try {
    return await requirePlatformAdminUser();
  } catch (e) {
    if (e instanceof ConsoleNotConfirmedError) throw e;
    throw new Error("Only a platform administrator can do that.");
  }
}

/** Sign everybody out — every session but the one pressing the button. */
export async function endEverySession(
  confirm: string,
): Promise<Result<{ ended: number }>> {
  let actor;
  try {
    actor = await admin();
  } catch (e) {
    return fail(
      e instanceof Error ? e.message : "Not allowed.",
      "not_permitted",
    );
  }
  if (confirm.trim().toUpperCase() !== "END")
    return fail("Type END to sign everybody out.");
  const mine = await currentSessionId();
  const gone = await (
    mine
      ? db.delete(sessions).where(ne(sessions.id, mine))
      : db.delete(sessions)
  ).returning({ id: sessions.id });
  await db.insert(auditLog).values({
    id: `aud_${randomUUID().slice(0, 12)}`,
    actorId: actor.id,
    action: "end-sessions",
    entityType: "platform",
    entityId: "all",
    afterState: { detail: `${gone.length} ended, every account` } as never,
  });
  revalidatePath(ADMIN.home, "layout");
  return ok(
    { ended: gone.length },
    `${gone.length} session${gone.length === 1 ? "" : "s"} ended. Everybody else signs in again.`,
  );
}
