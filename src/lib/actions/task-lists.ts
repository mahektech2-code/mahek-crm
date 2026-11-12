"use server";

import { requireUser } from "@/lib/auth";
import { today } from "@/lib/recompute";
import { err, ok, type Result } from "@/lib/result";
import { BULK_CAP, readTaskQuery, TASK_GROUPS, TASK_TABS } from "@/lib/tasks/list-query";
import { matchingTaskIds, resolveScope, type TaskScopeSpec } from "@/lib/tasks/list-service";

/**
 * "Select every match": the ids of every task a list's reading matches, in the
 * list's own order, up to the most one bulk action takes. The scope is
 * resolved for whoever is asking — a screen names a scope, it never names
 * whose tasks it may read.
 */
export async function taskIdsMatching(spec: TaskScopeSpec, params: Record<string, string>): Promise<Result<{ ids: string[]; total: number; capped: boolean }>> {
  const user = await requireUser();
  const scope = await resolveScope(user, spec);
  if (!scope) return err("You can't see those tasks.", "not_permitted");
  const q = readTaskQuery(params, { tab: "open", group: "none", tabs: TASK_TABS, groups: TASK_GROUPS });
  const { ids, total } = await matchingTaskIds(scope, q, await today(), BULK_CAP);
  return ok({ ids, total, capped: total > ids.length });
}
