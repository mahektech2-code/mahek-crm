/* ---------------------------------------------------------------------------
 * THE SHEET'S "REPORT TO" TITLE, TURNED INTO A PERSON — ONCE.
 *
 * Pure. Employees and the existing org chart go in; links to write and the
 * people a person has to place come out.
 *
 * HRMS used to answer "who is this person's manager" for anybody missing from
 * the org chart by matching their Report To text against everybody's job
 * title, every time it was asked. Rename the title "Area Head" and a team lost
 * its approver; give two people the same title and both became approvers.
 *
 * So the title is read ONCE, here, and only where it names exactly one active
 * person: that becomes a real `employee_reporting` row, by id, and from then on
 * nothing about titles matters. A title nobody holds, or two people hold, is
 * NOT guessed — it is handed back for HR to place on the org chart.
 *
 * It only ever FILLS. Somebody already on the chart is never moved, so a
 * manager HR chose is never overwritten by what the sheet says.
 * ------------------------------------------------------------------------- */

import { personKey } from "./person-directory";

export type TitleEmployee = {
  id: string;
  name: string;
  position: string | null;
  /** The sheet's Report To — a job title, not a person. */
  reportsTo: string | null;
  active: boolean;
};

export type ChartLink = { employeeId: string; managerId: string };

export type TitlePlan = {
  place: ChartLink[];
  /** Two or more active people hold the title: HR picks. */
  ambiguous: Array<{ employeeId: string; title: string; candidateIds: string[] }>;
  /** Nobody active holds the title. */
  unknown: Array<{ employeeId: string; title: string }>;
};

/** Would `employeeId → managerId` close a circle, given the links so far? */
function wouldLoop(managerOf: Map<string, string>, employeeId: string, managerId: string): boolean {
  let cur: string | undefined = managerId;
  for (let i = 0; cur && i < 200; i++) {
    if (cur === employeeId) return true;
    cur = managerOf.get(cur);
  }
  return Boolean(cur);
}

export function planChartFromTitles(employees: readonly TitleEmployee[], links: readonly ChartLink[]): TitlePlan {
  const managerOf = new Map(links.map((l) => [l.employeeId, l.managerId]));
  const holders = new Map<string, string[]>();
  for (const e of employees) {
    if (!e.active) continue;
    const k = personKey(e.position);
    if (!k) continue;
    holders.set(k, [...(holders.get(k) ?? []), e.id]);
  }

  const plan: TitlePlan = { place: [], ambiguous: [], unknown: [] };
  for (const e of [...employees].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!e.active || managerOf.has(e.id)) continue;
    const title = (e.reportsTo ?? "").trim();
    if (!title) continue;
    const candidates = (holders.get(personKey(title)) ?? []).filter((id) => id !== e.id);
    if (candidates.length === 0) {
      plan.unknown.push({ employeeId: e.id, title });
      continue;
    }
    if (candidates.length > 1) {
      plan.ambiguous.push({ employeeId: e.id, title, candidateIds: candidates });
      continue;
    }
    const managerId = candidates[0]!;
    if (wouldLoop(managerOf, e.id, managerId)) {
      plan.ambiguous.push({ employeeId: e.id, title, candidateIds: candidates });
      continue;
    }
    managerOf.set(e.id, managerId);
    plan.place.push({ employeeId: e.id, managerId });
  }
  return plan;
}
