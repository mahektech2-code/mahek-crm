"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { auditLog, taskAutomations } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { err, ok, type Result } from "@/lib/result";
import { AUTOMATION_BY_ID } from "@/lib/tasks/automations";
import { syncAutomation, syncAutomations } from "@/lib/tasks/automation-service";
import { canManageAutomations } from "@/lib/tasks/setup-access";
import { APP_TASKS_PATH } from "@/lib/tasks/rules";

/* ---------------------------------------------------------------------------
 * Switching an automatic task on or off, and running them now. Both decide
 * work for other people across apps, so both are the Tasks administrator's
 * (or a platform administrator's) — asked here, not only by hiding a switch.
 * ------------------------------------------------------------------------- */

function refresh() {
  try {
    revalidatePath("/tasks", "layout");
    for (const path of Object.values(APP_TASKS_PATH)) revalidatePath(path);
  } catch {
    /* no request context */
  }
}

export async function setAutomation(ruleId: string, enabled: boolean): Promise<Result<{ raised: number; closed: number }>> {
  const user = await requireUser();
  if (!(await canManageAutomations(user))) return err("Only a Tasks administrator switches automatic tasks on or off.", "not_permitted");
  const rule = AUTOMATION_BY_ID.get(ruleId);
  if (!rule) return err("That automatic task does not exist.", "not_found");
  await db
    .insert(taskAutomations)
    .values({ rule: rule.id, enabled, updatedById: user.id, updatedAt: new Date() })
    .onConflictDoUpdate({ target: taskAutomations.rule, set: { enabled, updatedById: user.id, updatedAt: new Date() } });
  await db.insert(auditLog).values({
    id: `aud_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    actorId: user.id,
    action: enabled ? "task.automation.on" : "task.automation.off",
    entityType: "task_automation",
    entityId: rule.id,
    afterState: { when: rule.when } as never,
  });
  const r = await syncAutomation(rule, enabled);
  refresh();
  return ok(
    { raised: r.raised, closed: r.closed },
    enabled ? `Switched on — ${r.raised} task${r.raised === 1 ? "" : "s"} raised now.` : `Switched off — ${r.closed} open task${r.closed === 1 ? "" : "s"} closed.`,
  );
}

export async function runAutomationsNow(): Promise<Result<{ raised: number; closed: number }>> {
  const user = await requireUser();
  if (!(await canManageAutomations(user))) return err("Only a Tasks administrator runs automatic tasks by hand.", "not_permitted");
  const r = await syncAutomations();
  const raised = r.reduce((a, x) => a + x.raised, 0);
  const closed = r.reduce((a, x) => a + x.closed, 0);
  const failed = r.filter((x) => x.error);
  refresh();
  if (failed.length) return err(`${failed.length} rule${failed.length === 1 ? "" : "s"} could not run: ${failed.map((f) => f.rule).join(", ")}.`);
  return ok({ raised, closed }, `Up to date — ${raised} raised, ${closed} closed.`);
}
