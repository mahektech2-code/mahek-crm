import { sql, type SQL } from "drizzle-orm";

/**
 * THE SHOP'S NAME, in SQL, for a row of `customers` aliased `alias`.
 *
 * A lead raised on the MBOS handset keeps the PERSON the salesman spoke to in
 * `name` ("Who you spoke to") and the SHOP in `company_name` ("Shop name") —
 * so a screen that printed `c.name` for every customer showed a person where
 * the shop should be (FB-15, the Sales Dashboard's live page). The shop comes
 * first; `name` is the fallback, which is every customer from the sheets and
 * every lead that never said its shop.
 */
export function shopNameSql(alias = "c"): SQL {
  const a = sql.raw(alias);
  return sql`coalesce(nullif(trim(${a}.company_name), ''), ${a}.name)`;
}
