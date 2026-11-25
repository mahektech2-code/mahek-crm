import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { appModuleAccess } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { resolveOrgVerifier, type ChainAccount } from "@/lib/engines/org-verifier-chain";
import { loadOrgData } from "@/lib/services/lead-verifier";

/* ---------------------------------------------------------------------------
 * WHO WOULD APPROVE A DESIGN, from the CRM Org Chart — and nothing else.
 *
 * This is the routing half of a future approval workflow, built so that turning
 * the workflow on later is a switch and not a redesign. It is deliberately
 * INERT today:
 *
 *   - `studio.approvalByOrgChart` is off, and nothing reads it to decide
 *     whether a design may be published. Publishing is exactly what it was.
 *   - Nothing in the Studio calls `designApproverFor`. It sends no
 *     notification, writes no request row and holds nothing back.
 *   - It names nobody. The approver is whoever the Org Chart puts nearest
 *     above the uploader and who holds the `studio.approve` module — the same
 *     walk, skips and refusals the lead verification uses (`resolveOrgVerifier`),
 *     with a different answer to "may this account decide".
 *
 * The uploader is never their own approver: they are excluded from the walk.
 * ------------------------------------------------------------------------- */

export const APPROVAL_MODULE = "studio.approve";

export type DesignApprover =
  /** The workflow is off. Nothing was resolved and nobody should be asked. */
  | { enabled: false }
  | { enabled: true; ok: true; approverId: string; approverName: string; depth: number }
  | { enabled: true; ok: false; reason: string; message: string };

/** Whether Org Chart approval is switched on. Off until somebody turns it on. */
export async function approvalByOrgChartEnabled(): Promise<boolean> {
  return Boolean((await getConfig())["studio.approvalByOrgChart"]);
}

/**
 * The nearest person above `uploaderId` on the Org Chart who may approve
 * designs. Pure routing: it reads the chart and the grants and writes nothing.
 * Returns `{ enabled: false }` while the workflow is off.
 *
 * `opts.ignoreSwitch` lets a test or a preview ask the question while the
 * switch is off; no production caller passes it.
 */
export async function designApproverFor(uploaderId: string, opts: { ignoreSwitch?: boolean } = {}): Promise<DesignApprover> {
  if (!opts.ignoreSwitch && !(await approvalByOrgChartEnabled())) return { enabled: false };

  const data = await loadOrgData();
  const subjectEmployee = data.employeeOfUser.get(uploaderId) ?? null;

  /* Collect only the employees on the uploader's reporting line (cycle-safe) so
     only they are asked whether they hold the module. */
  const line = new Set<string>();
  let cur = subjectEmployee;
  for (let i = 0; cur && i < 30; i++) {
    const next = data.managerOf.get(cur);
    if (!next || line.has(next)) break;
    line.add(next);
    cur = next;
  }

  const byEmployee = new Map<string, ChainAccount[]>();
  const candidates = data.accounts.filter((a) => a.employeeId && line.has(a.employeeId) && a.active);
  /* "Approve designs" must be GIVEN to the person — an explicit module row on the Studio. Holding the whole app, being its manager or its
     admin, or being nearer the top of the chart is not enough: the walk skips them and goes on up. */
  const explicit = candidates.length
    ? new Set(
        (
          await db
            .select({ userId: appModuleAccess.userId })
            .from(appModuleAccess)
            .where(and(eq(appModuleAccess.app, "studio"), eq(appModuleAccess.module, APPROVAL_MODULE), inArray(appModuleAccess.userId, candidates.map((c) => c.id))))
        ).map((r) => r.userId),
      )
    : new Set<string>();
  for (const a of data.accounts) {
    if (!a.employeeId || !line.has(a.employeeId)) continue;
    const list = byEmployee.get(a.employeeId) ?? [];
    list.push({ userId: a.id, active: a.active, canVerify: a.active && explicit.has(a.id) });
    byEmployee.set(a.employeeId, list);
  }

  const r = resolveOrgVerifier({
    subjectEmployeeId: subjectEmployee,
    managerOf: data.managerOf,
    employees: data.employees,
    accountsByEmployee: byEmployee,
    excludeUserIds: new Set([uploaderId]),
  });
  if (r.ok) return { enabled: true, ok: true, approverId: r.verifierUserId, approverName: data.nameOfUser.get(r.verifierUserId) ?? "", depth: r.depth };
  return { enabled: true, ok: false, reason: r.code, message: r.message };
}
