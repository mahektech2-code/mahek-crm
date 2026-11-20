import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { hrmsRefLists } from "@/db/schema";
import { has } from "@/lib/hrms/access";
import { readImpactPart } from "@/lib/erp/ui";
import type { ImpactItem } from "../types";
import type { ImpactSource } from "../registry";
import { hrmsMayAct } from "./hrms-common";

/* ---------------------------------------------------------------------------
 * REMOVING A VALUE FROM AN HRMS PICK LIST takes it off the forms and nothing
 * else: every record saved with it keeps it, as text. The modal says which
 * records those are, because "Old records keep the value" is the half people
 * doubt — and a pick list somebody tidies is usually one people still use.
 *
 * WHERE EACH LIST IS COPIED, as text: a list missing here is one no HRMS
 * record stores by name, and the modal says so rather than claiming none do.
 * ------------------------------------------------------------------------- */

const STORED: Record<string, { what: string; q: ReturnType<typeof sql> }[]> = {
  "Position types": [{ what: "employees of that position type", q: sql`select department as v from employees` }],
  Positions: [
    { what: "employees in that position", q: sql`select position as v from employees` },
    { what: "employees who report to that position", q: sql`select reports_to as v from employees` },
  ],
  "Bank names": [{ what: "employees banking with it", q: sql`select bank_name as v from employees` }],
  Areas: [{ what: "employees allocated that area", q: sql`select area_allocated as v from employees` }],
  "Holiday categories": [{ what: "holidays of that category", q: sql`select category as v from hrms_holidays` }],
  "Holiday names": [{ what: "holidays by that name", q: sql`select name as v from hrms_holidays` }],
  "Expense categories": [{ what: "expenses in that category", q: sql`select category as v from hrms_expenses` }],
  "Expense particulars": [{ what: "expenses with that particular", q: sql`select particular as v from hrms_expenses` }],
  "Expense locations": [{ what: "expenses at that location", q: sql`select location as v from hrms_expenses` }],
  "Asset names": [{ what: "asset stock lots by that name", q: sql`select name as v from hrms_asset_stock` }],
};

/** How many records of each kind carry a value, or null where the list is copied nowhere HRMS knows of. */
export async function pickListUses(list: string, value: string): Promise<{ what: string; n: number }[] | null> {
  const uses = STORED[list];
  if (!uses) return null;
  const out: { what: string; n: number }[] = [];
  for (const u of uses) {
    const [row] = (await db.execute(sql`select count(*)::int as n from (${u.q}) s(v) where lower(trim(s.v)) = lower(trim(${value}))`)) as unknown as { n: number }[];
    out.push({ what: u.what, n: Number(row?.n ?? 0) });
  }
  return out;
}

export const pickListValueImpact: ImpactSource = {
  authorize: async () => {
    await hrmsMayAct(["refLists"], (ctx) => (has(ctx, "admin") ? null : "Editing pick lists needs the HRMS administration power"));
  },

  async report(id) {
    const part = readImpactPart(id);
    if (!part) return null;
    const [list, value] = part;
    const [r] = await db.select().from(hrmsRefLists).where(eq(hrmsRefLists.list, list));
    if (!r || !value) return null;
    const on = r.values.includes(value);
    const uses = await pickListUses(list, value);
    const items: ImpactItem[] = [
      {
        app: "HRMS",
        label: `value comes off the ${list} pick list on every form`,
        effect: "changed",
        count: on ? 1 : 0,
        note: "Add a value puts it back.",
      },
      ...(uses ?? []).map(
        (u): ImpactItem => ({
          app: "HRMS",
          label: `${u.what}`,
          effect: "kept",
          count: u.n,
          note: `They keep “${value}” exactly as saved; editing one shows it until somebody picks another.`,
        }),
      ),
    ];
    if (!uses) items.push({ app: "HRMS", label: "records that already picked it", effect: "kept", count: 0, note: "No HRMS record stores this list by name; whatever carries it keeps it." });
    return {
      title: `“${value}” in ${list}`,
      verb: "Remove",
      confirmWord: value.length <= 40 ? value : "REMOVE",
      items: items.filter((i) => i.count > 0 || (i.effect === "kept" && !uses)),
      blockers: on ? [] : [`“${value}” is no longer in ${list}.`],
    };
  },
};
