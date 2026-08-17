import "server-only";
import { asc, sql } from "drizzle-orm";
import { db } from "@/db";
import { employeeReporting, employees } from "@/db/schema";

/* ---------------------------------------------------------------------------
 * The org chart.
 *
 * One query for the people, one for the links, and the tree assembled in
 * memory. Seventy-one employees is not a recursive-CTE problem — it is two
 * small reads and a loop — and doing it here rather than in SQL means the
 * cycle safety is written in a language that can say what it is doing.
 *
 * NOTHING HERE TRUSTS THE DATA TO BE A TREE. `setManager` refuses to create a
 * loop, but a row written before that guard existed, or by hand, would make a
 * naive walk run for ever and take the page down. Every descent is depth-capped
 * and visit-marked, so the worst a bad row can do is fail to draw a branch.
 * ------------------------------------------------------------------------- */

export type OrgPerson = {
  id: string;
  employeeCode: string;
  name: string;
  position: string | null;
  department: string | null;
  officeName: string | null;
  status: string;
  /** The sheet's own `report_to` — a POSITION, never a person. Shown as a hint. */
  sheetReportsTo: string | null;
  managerId: string | null;
  reports: OrgPerson[];
};

export type OrgChart = {
  /** People with nobody above them. Usually several, and that is not an error. */
  roots: OrgPerson[];
  /** Everybody, flat, for the pickers and the counts. */
  all: OrgPerson[];
  totals: {
    people: number;
    withManager: number;
    unassigned: number;
    /** Deepest chain, so a chart that has gone strange is visible as a number. */
    depth: number;
    /** Rows that could not be drawn because they sit in a loop. Normally zero. */
    unreachable: number;
  };
};

const MAX_DEPTH = 50;

/**
 * @param includeLeavers Employees who have left are hidden by default — the
 *   chart is meant to answer "who reports to whom today", and 45 of the 71
 *   records are former staff. Their links are kept, not deleted, so turning
 *   this on shows the org as it was recorded.
 */
export async function orgChart(includeLeavers = false): Promise<OrgChart> {
  const [people, links] = await Promise.all([
    db
      .select({
        id: employees.id,
        employeeCode: employees.employeeCode,
        name: employees.name,
        position: employees.position,
        department: employees.department,
        officeName: employees.officeName,
        status: employees.status,
        sheetReportsTo: employees.reportsTo,
      })
      .from(employees)
      .where(
        includeLeavers
          ? sql`true`
          : sql`${employees.status} <> 'inactive' and ${employees.sheetStatus} = 'present'`,
      )
      .orderBy(asc(employees.name)),
    db
      .select({
        employeeId: employeeReporting.employeeId,
        managerId: employeeReporting.managerId,
      })
      .from(employeeReporting),
  ]);

  const managerOf = new Map(links.map((l) => [l.employeeId, l.managerId]));
  const byId = new Map<string, OrgPerson>();
  for (const p of people) {
    byId.set(p.id, { ...p, managerId: managerOf.get(p.id) ?? null, reports: [] });
  }

  // Attach each person to their manager. A manager who is filtered out — a
  // leaver, while leavers are hidden — leaves their reports at the top rather
  // than vanishing with them: the alternative is people silently missing from
  // the chart, which is the one thing an org chart must not do.
  const roots: OrgPerson[] = [];
  for (const person of byId.values()) {
    const manager = person.managerId ? byId.get(person.managerId) : undefined;
    if (manager && manager.id !== person.id) manager.reports.push(person);
    else roots.push(person);
  }

  for (const p of byId.values()) {
    p.reports.sort((a, b) => a.name.localeCompare(b.name));
  }
  roots.sort((a, b) => b.reports.length - a.reports.length || a.name.localeCompare(b.name));

  // Depth, and whether anybody is stranded in a loop. Walking from the roots
  // with a seen-set reaches every node exactly once; anyone left over is in a
  // cycle and is reported as a number rather than silently dropped.
  const seen = new Set<string>();
  let depth = 0;
  const walk = (node: OrgPerson, level: number) => {
    if (seen.has(node.id) || level > MAX_DEPTH) return;
    seen.add(node.id);
    depth = Math.max(depth, level);
    for (const child of node.reports) walk(child, level + 1);
  };
  for (const r of roots) walk(r, 1);

  const all = [...byId.values()];
  return {
    roots,
    all,
    totals: {
      people: all.length,
      withManager: all.filter((p) => p.managerId).length,
      unassigned: all.filter((p) => !p.managerId).length,
      depth,
      unreachable: all.length - seen.size,
    },
  };
}
