"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { requirePlatformAdminUser } from "@/lib/access-control";
import { applyChange, type AccessTemplateShape } from "@/lib/access-bulk";
import { setAccess } from "@/lib/actions/access";
import { ADMIN } from "@/lib/admin-routes";
import { APP_IDS, type AppId } from "@/lib/apps";
import { err, fieldErr, ok, type Result } from "@/lib/result";
import { listAccess } from "@/lib/services/access-service";
import type { BulkOutcome } from "@/lib/actions/access-bulk";

/* ---------------------------------------------------------------------------
 * "GIVE AN APP" ON THE SELECTION BAR. One app at one level, the whole app,
 * for several people — the same additive template change the Powers & screens
 * page applies, so it obeys every rule a single save does: each person goes
 * through `setAccess` with the whole picture `applyChange` worked out, and a
 * person who already holds the app at that level or wider is skipped with the
 * reason. It never narrows or takes anything away; taking an app away is
 * confirmed one person at a time on their own access dialog.
 * ------------------------------------------------------------------------- */

export async function giveAppTo(input: { app: string; role: "associate" | "manager" | "admin"; userIds: string[] }): Promise<Result<BulkOutcome>> {
  let me;
  try {
    me = await requirePlatformAdminUser();
  } catch {
    return err("Only a platform administrator can change access.", "not_permitted");
  }
  if (!(APP_IDS as readonly string[]).includes(input.app)) return fieldErr("app", "Pick an app.");
  const ids = [...new Set(input.userIds)];
  if (!ids.length) return fieldErr("people", "Pick at least one person.");
  if (ids.length > 200) return fieldErr("people", "Up to 200 people at a time.");

  const shape: AccessTemplateShape = {
    apps: [{ app: input.app as AppId, role: input.role, modules: null }],
    erpPowers: [],
    hrmsPowers: [],
    taskPowers: [],
  };
  const rows = new Map((await listAccess()).map((r) => [r.userId, r]));
  const out: BulkOutcome = { moved: [], skipped: [] };
  for (const id of ids) {
    const row = rows.get(id);
    if (!row) {
      out.skipped.push({ userId: id, name: id, why: "no longer has an account" });
      continue;
    }
    if (!row.active) {
      out.skipped.push({ userId: id, name: row.name, why: "is disabled" });
      continue;
    }
    const applied = applyChange(row, { kind: "template", shape });
    if (!applied.changed) {
      out.skipped.push({ userId: id, name: row.name, why: applied.why });
      continue;
    }
    const res = await setAccess({ ...applied.save });
    if (res.ok) out.moved.push({ userId: id, name: row.name, words: applied.words });
    else out.skipped.push({ userId: id, name: row.name, why: res.error });
  }
  await db.insert(auditLog).values({
    id: `aud_${randomUUID().slice(0, 12)}`,
    actorId: me.id,
    action: "access.bulk",
    entityType: "access",
    entityId: `give ${input.app} (${input.role})`,
    actorRole: "admin",
    actorApp: "admin",
    afterState: { moved: out.moved.length, skipped: out.skipped.length, people: out.moved.map((m) => `${m.name}: ${m.words}`) } as never,
  });
  try {
    revalidatePath(ADMIN.home, "layout");
    revalidatePath("/apps");
  } catch {
    /* outside a request */
  }
  return ok(out);
}
