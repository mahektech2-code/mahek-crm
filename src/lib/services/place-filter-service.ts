import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import type { PlaceKind } from "@/lib/place-parse";
import {
  PLACE_FILTER_KINDS,
  type PlaceFilterOptions,
  type PlaceFilterValues,
} from "@/lib/place-filters";

/* ---------------------------------------------------------------------------
 * The four place filters as SQL, and the options each dropdown offers.
 *
 * ONE clause for every list that narrows by place — the customer table in the
 * CRM and in Accounts, and the lead table in the CRM and on the Sales
 * Dashboard — so two screens cannot disagree about which shops Thane has.
 * See `lib/place-filters.ts` for the shape and `place-tree-service.ts` for
 * where the four columns come from.
 * ------------------------------------------------------------------------- */

const COLUMN: Record<PlaceKind, string> = {
  state: "resolved_state_id",
  district: "resolved_district_id",
  city: "resolved_city_id",
  area: "resolved_area_id",
};

function ids(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * The picks, AND-ed across rungs and OR-ed within one.
 *
 * `alias` is the name the customers table has in the statement this is
 * spliced into — `customers` on the customer list, `c` on the lead list. It
 * is spelled out rather than taken from Drizzle's column objects, because a
 * bare column inside a correlated subquery binds to the inner table.
 */
export function placeFilterSql(
  values: PlaceFilterValues,
  alias = "customers",
  kinds: readonly PlaceKind[] = PLACE_FILTER_KINDS,
): SQL | undefined {
  const clauses: SQL[] = [];
  for (const kind of kinds) {
    const picked = ids(values[kind]);
    if (!picked.length) continue;
    const col = sql.raw(`${alias}.${COLUMN[kind]}`);
    clauses.push(
      picked.length === 1
        ? sql`${col} = ${picked[0]}`
        : sql`${col} in (${sql.join(
            picked.map((v) => sql`${v}`),
            sql`, `,
          )})`,
    );
  }
  if (!clauses.length) return undefined;
  return sql`(${sql.join(clauses, sql` and `)})`;
}

/**
 * What each of the four dropdowns offers, counted over the list being shown.
 *
 * `from` and `where` describe that list — its scope and its own fixed
 * narrowing (not a lead, not archived) — and never the OTHER filters, so the
 * options do not vanish one by one as somebody narrows the list. A rung's
 * options ARE narrowed by the place picks above it, which is the cascade:
 * pick Maharashtra and the district list is Maharashtra's districts.
 *
 * Labelled with the parent ("Bhiwandi — Thane") because two places share a
 * name constantly, and the count is how many shops in THIS list sit there,
 * so a telecaller sees their own book and not the company's.
 */
export async function placeFilterOptions(opts: {
  from: SQL;
  alias: string;
  where: SQL | undefined;
  picks: PlaceFilterValues;
}): Promise<PlaceFilterOptions> {
  const out = { state: [], district: [], city: [], area: [] } as PlaceFilterOptions;

  await Promise.all(
    PLACE_FILTER_KINDS.map(async (kind, i) => {
      const above = placeFilterSql(opts.picks, opts.alias, PLACE_FILTER_KINDS.slice(0, i));
      const conditions = [opts.where, above].filter((c): c is SQL => Boolean(c));
      const where = conditions.length ? sql`where ${sql.join(conditions, sql` and `)}` : sql``;
      const col = sql.raw(`${opts.alias}.${COLUMN[kind]}`);

      const rows = (await db.execute<{
        id: string;
        name: string;
        parent: string | null;
        shops: number;
      }>(sql`
        select p.id, p.name, par.name as parent, count(*)::int as shops
          from ${opts.from}
          join places p on p.id = ${col}
          left join places par on par.id = p.parent_id
          ${where}
         group by p.id, p.name, par.name
         order by count(*) desc, p.name asc
      `)) as unknown as Array<{ id: string; name: string; parent: string | null; shops: number }>;

      out[kind] = rows.map((r) => ({
        value: r.id,
        label:
          kind === "state" || !r.parent || r.parent === r.name
            ? `${r.name} (${Number(r.shops)})`
            : `${r.name} — ${r.parent} (${Number(r.shops)})`,
      }));
    }),
  );

  return out;
}

/**
 * One rung of a shop's place as a NAME, for a SELECT list — the reviewed
 * tree's name, falling back to what the sheet typed where the tree has none.
 *
 * Every read that shows a shop's city or area goes through this, so a list,
 * a record and a map popup cannot name one shop's town two ways.
 */
export function placeNameSql(alias: string, kind: PlaceKind, typedColumn?: string): SQL {
  const tree = sql.raw(
    `(select p.name from places p where p.id = ${alias}.${COLUMN[kind]})`,
  );
  return typedColumn
    ? sql`coalesce(${tree}, nullif(trim(${sql.raw(`${alias}.${typedColumn}`)}), ''))`
    : tree;
}

/**
 * The resolved place of each shop, as names, for a list or a record — keyed
 * by customer id. One round trip for a page of rows.
 */
export async function placeNamesFor(
  customerIds: string[],
): Promise<Map<string, { state: string | null; district: string | null; city: string | null; area: string | null }>> {
  const out = new Map<
    string,
    { state: string | null; district: string | null; city: string | null; area: string | null }
  >();
  if (!customerIds.length) return out;
  const rows = (await db.execute<{
    id: string;
    state: string | null;
    district: string | null;
    city: string | null;
    area: string | null;
  }>(sql`
    select c.id,
           st.name as state, di.name as district, ci.name as city, ar.name as area
      from customers c
      left join places st on st.id = c.resolved_state_id
      left join places di on di.id = c.resolved_district_id
      left join places ci on ci.id = c.resolved_city_id
      left join places ar on ar.id = c.resolved_area_id
     where c.id in (${sql.join(
       customerIds.map((v) => sql`${v}`),
       sql`, `,
     )})
  `)) as unknown as Array<{
    id: string;
    state: string | null;
    district: string | null;
    city: string | null;
    area: string | null;
  }>;
  for (const r of rows) out.set(r.id, { state: r.state, district: r.district, city: r.city, area: r.area });
  return out;
}
