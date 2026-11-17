import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { loadStaffResolver } from "./person-identity-service";

/* ---------------------------------------------------------------------------
 * PERSON IDS FROM THE NAMES ALREADY STORED (migration 0353).
 *
 * Each of these rows names a person as text — who was given an advance, who
 * spent the money, the salesman a complaint was raised for, who controls a
 * sign-in account, whose card it is. 0353 gave each an account-id column; this
 * fills it from the text, through the person directory and nothing else:
 * today's name, any spelling the person carried, the name the sheets use, and
 * for somebody who has left their own switched-off account.
 *
 * It NEVER guesses. A name nobody answers to, or two people answer to, stays
 * unfilled and is counted, so a person can decide. It only fills an EMPTY id —
 * a row somebody already pointed at a person is theirs. Idempotent; the dry
 * run writes nothing.
 * ------------------------------------------------------------------------- */

type Target = { label: string; table: string; text: string; id: string; where?: string };

/** Constants only: the identifiers are spelled here, never taken from input. */
const TARGETS: Target[] = [
  { label: "Advances · given to", table: "erp_advances", text: "employee_name", id: "user_id" },
  { label: "Old petty cash · credit to", table: "erp_credits", text: "employee_name", id: "user_id" },
  { label: "Old petty cash · expense by", table: "erp_expenses", text: "expense_by", id: "expense_by_id" },
  { label: "Complaints · salesman", table: "complaints", text: "salesman_name", id: "salesman_id" },
  { label: "Old ERP requests · salesman", table: "erp_requests", text: "salesman_name", id: "salesman_id" },
  { label: "Locker sign-in accounts · controlled by", table: "locker_identities", text: "controlled_by_name", id: "controlled_by_id", where: "not controlled" },
  { label: "Locker cards · holder", table: "locker_payment_methods", text: "holder", id: "holder_user_id" },
];

export type BackfillCount = {
  label: string;
  column: string;
  filled: number;
  unmatched: number;
  ambiguous: number;
  /** The names left unfilled, with how many rows carry each — for a person to decide. */
  left: Array<{ name: string; rows: number; why: "nobody" | "several people" | "no single account" }>;
};

export async function backfillPersonIds(opts: { dryRun?: boolean } = {}): Promise<BackfillCount[]> {
  const resolve = await loadStaffResolver();
  const out: BackfillCount[] = [];
  for (const t of TARGETS) {
    const T = sql.raw(`"${t.table}"`);
    const TEXT = sql.raw(`"${t.text}"`);
    const ID = sql.raw(`"${t.id}"`);
    const extra = t.where ? sql.raw(`and (${t.where})`) : sql``;
    const count: BackfillCount = { label: t.label, column: `${t.table}.${t.id}`, filled: 0, unmatched: 0, ambiguous: 0, left: [] };

    /* An advance already knows its employee by id; the one account linked to
       that employee is the person, with no name read at all. Those rows are
       not asked again by name. */
    let viaLink: string[] = [];
    if (t.table === "erp_advances") {
      const byLink = (await db.execute(sql`
        select a.id, min(u.id) as "userId"
          from erp_advances a join users u on u.employee_id = a.employee_id
         where a.user_id is null
         group by a.id
        having count(*) = 1
      `)) as unknown as { id: string; userId: string }[];
      if (!opts.dryRun) {
        for (const r of byLink) await db.execute(sql`update erp_advances set user_id = ${r.userId} where id = ${r.id} and user_id is null`);
      }
      count.filled += byLink.length;
      viaLink = byLink.map((r) => r.id);
    }
    const notLinked = viaLink.length ? sql`and id not in (${sql.join(viaLink.map((d) => sql`${d}`), sql`, `)})` : sql``;

    const names = (await db.execute(sql`
      select ${TEXT} as name, count(*)::int as n from ${T}
       where ${ID} is null and btrim(coalesce(${TEXT}, '')) <> '' ${extra} ${notLinked}
       group by ${TEXT}
    `)) as unknown as { name: string; n: number }[];
    await tally(names, count, resolve, opts.dryRun ? null : async (name, userId) => {
      await db.execute(sql`update ${T} set ${ID} = ${userId} where ${ID} is null and ${TEXT} = ${name} ${extra}`);
    });
    out.push(count);
  }
  return out;
}

async function tally(
  names: { name: string; n: number }[],
  count: BackfillCount,
  resolve: Awaited<ReturnType<typeof loadStaffResolver>>,
  write: ((name: string, userId: string) => Promise<void>) | null,
) {
  for (const { name, n } of names) {
    const rows = Number(n);
    const m = resolve(name);
    if (m.userId) {
      if (write) await write(name, m.userId);
      count.filled += rows;
    } else if (m.why === "many") {
      count.ambiguous += rows;
      count.left.push({ name, rows, why: "several people" });
    } else {
      count.unmatched += rows;
      count.left.push({ name, rows, why: m.why === "none" ? "nobody" : "no single account" });
    }
  }
  count.left.sort((a, b) => b.rows - a.rows);
}

/** The job's report, one line per column and the names left for a person. */
export function backfillReport(counts: BackfillCount[], dryRun: boolean): string {
  const lines = [dryRun ? "DRY RUN — nothing written." : "Written."];
  for (const c of counts) {
    lines.push(`${c.label} (${c.column}): ${c.filled} ${dryRun ? "would be filled" : "filled"}, ${c.unmatched} unmatched, ${c.ambiguous} ambiguous`);
    for (const l of c.left.slice(0, 15)) lines.push(`    ${String(l.rows).padStart(5)}  “${l.name}” — ${l.why}`);
    if (c.left.length > 15) lines.push(`    … and ${c.left.length - 15} more names`);
  }
  return lines.join("\n");
}
