import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { listedTransporter } from "./engines/lr-read";

/* ---------------------------------------------------------------------------
 * A TRANSPORTER'S NAME IS A JOIN KEY, so renaming one is not a one-row edit.
 *
 * Bills, LRs, orders, trips, payments, returns and a party's default all carry
 * the transporter as TEXT, and the master is matched to them by name, ignoring
 * case — that match is what gives a bill its call button, its tracking link
 * and the master its "With them now" count. Renaming only the master row left
 * every one of those carrying the old spelling and matched to nothing, so the
 * Edit button worked and broke the links it existed to feed.
 *
 * So a rename rewrites the old spelling everywhere, in the same transaction as
 * the master row, and a merge is the same rewrite towards a name that already
 * has a row. `NAME_USES` is the one list of where the name lives: the impact
 * report counts from it and the rewrite writes from it, so what a person is
 * shown and what is changed cannot be two lists.
 *
 * The sheet's staging rows (`sheet_taken_order_rows.transporter_name`) are
 * deliberately NOT on it: staging holds what the sheet said, and rewriting it
 * would make the next hash compare see a change nobody made in the sheet.
 * ------------------------------------------------------------------------- */

type NameUse = { table: string; column: string; label: string; one: string; extra?: string };

export const NAME_USES: NameUse[] = [
  { table: "erp_transports", column: "transporter", label: "bills", one: "bill" },
  { table: "erp_lrs", column: "transporter", label: "LRs", one: "LR" },
  { table: "erp_orders", column: "transporter", label: "order lines", one: "order line" },
  { table: "erp_trips", column: "transporter", label: "trips", one: "trip" },
  { table: "erp_transport_payments", column: "paid_to", label: "transport payments (paid to)", one: "transport payment (paid to)" },
  { table: "erp_customer_profiles", column: "transporter", label: "parties using it as their transporter", one: "party using it as their transporter" },
  { table: "erp_return_outwards", column: "transporter", label: "return outwards", one: "return outward" },
  { table: "erp_customer_returns", column: "transporter", label: "customer returns", one: "customer return" },
];

const matches = (u: NameUse, name: string): SQL => sql`lower(btrim(${sql.raw(u.column)})) = ${name.trim().toLowerCase()}`;

/** How many rows of each kind carry this name, ignoring case and surrounding spaces. */
export async function nameUses(name: string): Promise<{ use: NameUse; count: number }[]> {
  if (!name.trim()) return NAME_USES.map((use) => ({ use, count: 0 }));
  const counts = await Promise.all(
    NAME_USES.map(async (use) => {
      const [r] = (await db.execute(sql`select count(*)::int as n from ${sql.raw(use.table)} where ${matches(use, name)}`)) as unknown as { n: number }[];
      return { use, count: Number(r?.n ?? 0) };
    }),
  );
  return counts;
}

/**
 * LR numbers that would clash once `from` reads as `to`. `erp_lrs_number_key`
 * is unique on the transporter and the number over live LRs, so two companies
 * that each issued an LR 1042 cannot be folded into one name — the update
 * would throw half-way. Said as a blocker instead, with the numbers.
 */
export async function lrClashes(from: string, to: string): Promise<string[]> {
  if (from.trim().toLowerCase() === to.trim().toLowerCase()) return [];
  const rows = (await db.execute(sql`
    select distinct upper(a.lr_no) as "lrNo"
      from erp_lrs a join erp_lrs b on upper(a.lr_no) = upper(b.lr_no)
     where a.status <> 'void' and b.status <> 'void'
       and lower(btrim(a.transporter)) = ${from.trim().toLowerCase()}
       and lower(btrim(b.transporter)) = ${to.trim().toLowerCase()}
     order by 1 limit 6
  `)) as unknown as { lrNo: string }[];
  return rows.map((r) => r.lrNo);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Rewrite every carried spelling of `from` to exactly `to`. Returns rows changed per kind. */
export async function rewriteName(tx: Tx, from: string, to: string): Promise<Record<string, number>> {
  const changed: Record<string, number> = {};
  for (const use of NAME_USES) {
    const rows = (await tx.execute(
      sql`update ${sql.raw(use.table)} set ${sql.raw(use.column)} = ${to} where ${matches(use, from)} and ${sql.raw(use.column)} is distinct from ${to} returning 1`,
    )) as unknown as unknown[];
    if (rows.length) changed[use.table] = rows.length;
  }
  return changed;
}

/**
 * A transporter typed into a form, as the list spells it — and REFUSED when it
 * is not on the list. Every carried name still has a row behind it, which is
 * what lets a later rename or merge reach it; but the row is added by a person
 * on the Transporters screen, never by whatever was typed into an order line or
 * read off a receipt. Adding them on the way past is how one company became
 * "Great India", "THE GREAT INDIA" and "Great India Roadways Pvt Ltd".
 */
export async function listedTransporterName(
  ex: Tx | typeof db,
  raw: string | null | undefined,
  /** What the record already carries: saved again unchanged, an older spelling is left alone rather than refused. */
  kept?: string | null,
): Promise<{ ok: true; name: string | null } | { ok: false; error: string }> {
  const typed = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!typed) return { ok: true, name: null };
  if (kept && kept.trim().replace(/\s+/g, " ").toLowerCase() === typed.toLowerCase()) return { ok: true, name: kept };
  const names = ((await ex.execute(sql`select name from erp_transporters`)) as unknown as { name: string }[]).map((r) => r.name);
  const { name, near } = listedTransporter(typed, names);
  if (name) return { ok: true, name };
  return { ok: false, error: `"${typed}" is not on the transporter list.${near ? ` Did you mean ${near}?` : ""} Pick one from the list, or add it under Transporters first.` };
}

/** The names a transporter box offers: the active list, as it spells them. */
export async function transporterChoices(): Promise<string[]> {
  return ((await db.execute(sql`select name from erp_transporters where active order by lower(name)`)) as unknown as { name: string }[]).map((r) => r.name);
}
