import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { addDays, APP_TIMEZONE } from "@/lib/business-date";
import { varianceRowsForRange, type VarianceRangeRow } from "@/lib/services/price-list-service";
import { buildWatch, type WatchApprovalFacts, type WatchLine, type WatchReport } from "@/lib/engines/price-watch";

/* ---------------------------------------------------------------------------
 * WATCH THE MONEY — the reads behind the Watch screen.
 *
 * Every line is judged by `varianceRowsForRange`, the month variance report's
 * own body, so a line reads the same on both screens: against the revision of
 * the shop's book that was live on the line's own date, narrowed to the
 * reader's book exactly as variance is. This file adds the record of what
 * could explain a lower price (overrides and special-price requests) and
 * hands both to the pure engine.
 * ------------------------------------------------------------------------- */

export const WATCH_LINE_LIMIT = 20_000;

export type WatchResult = WatchReport & {
  /** Both inclusive, as the screen says them. */
  from: string;
  to: string;
  /** True when the window held more lines than were read. */
  truncated: boolean;
};

function toLine(r: VarianceRangeRow): WatchLine {
  return {
    lineId: r.lineId,
    orderDate: r.orderDate,
    orderNumber: r.orderNumber,
    customerId: r.customerId,
    customerName: r.customerName,
    productId: r.productId,
    productName: r.productName,
    cans: r.cans == null ? null : Number(r.cans),
    billedExPaise: r.billedExPaise,
    listExPaise: r.listExPaise,
    listInclPaise: r.listInclPaise,
    listGstBp: r.listGstBp,
    listId: r.listId,
    listName: r.listName,
    deltaPaise: r.deltaPaise,
    deltaBp: r.deltaBp,
    sheetDiscountBp: r.sheetDiscountBp == null ? null : Number(r.sheetDiscountBp),
    source: r.source,
    takenByName: r.takenByName,
    takenById: r.takenById,
    rateSetById: r.rateSetById,
    rateSetByName: r.rateSetByName,
    discountAuthorisedById: r.discountAuthorisedById,
    discountAuthorisedByName: r.discountAuthorisedByName,
  };
}

/** Overrides and special-price requests for the shops these lines name. */
async function approvalFacts(customerIds: string[]): Promise<WatchApprovalFacts> {
  if (!customerIds.length) return { overrides: [], requests: [] };
  const ids = sql.join(customerIds.map((id) => sql`${id}`), sql`, `);
  const [overrides, requests] = await Promise.all([
    db.execute<{ customerId: string; productId: string; validFrom: string; validTo: string | null }>(sql`
      select customer_id as "customerId", product_id as "productId",
             valid_from::text as "validFrom", valid_to::text as "validTo"
        from price_overrides
       where cancelled_at is null and customer_id in (${ids})
    `),
    db.execute<{ customerId: string; productId: string; status: string; day: string }>(sql`
      select customer_id as "customerId", product_id as "productId", status,
             (created_at at time zone ${APP_TIMEZONE})::date::text as day
        from price_requests
       where status in ('pending', 'approved') and customer_id in (${ids})
    `),
  ]);
  return { overrides: [...overrides], requests: [...requests] };
}

/**
 * The Watch report over `from`..`to`, BOTH INCLUSIVE. Narrowed to the
 * reader's book (`varianceRowsForRange` asks `userIdsInScope`).
 */
export async function watchReport(input: { from: string; to: string }): Promise<WatchResult> {
  const rows = await varianceRowsForRange(input.from, addDays(input.to, 1), { limit: WATCH_LINE_LIMIT });
  const lines = rows.map(toLine);
  const customers = [...new Set(lines.filter((l) => l.deltaPaise != null && l.deltaPaise < 0).map((l) => l.customerId).filter((c): c is string => !!c))];
  const report = buildWatch(lines, await approvalFacts(customers));
  return { ...report, from: input.from, to: input.to, truncated: rows.length >= WATCH_LINE_LIMIT };
}

/** One line, read as the reader may see it, on its own date. Null when it is not theirs to see. */
export async function watchLineFor(lineId: string, orderDate: string): Promise<WatchLine | null> {
  const rows = await varianceRowsForRange(orderDate, addDays(orderDate, 1), { limit: WATCH_LINE_LIMIT });
  const found = rows.find((r) => r.lineId === lineId);
  return found ? toLine(found) : null;
}

/** Who answers for a shop: its sales account manager, else its owner, and the back office. */
export async function shopPeople(customerId: string): Promise<{ name: string; userIds: string[] } | null> {
  const [row] = await db.execute<{ name: string; sales: string | null; back: string | null }>(sql`
    select c.name, coalesce(c.sales_am_id, c.owner_id) as sales, c.back_office_am_id as back
      from customers c where c.id = ${customerId}
  `);
  if (!row) return null;
  return { name: row.name, userIds: [row.sales, row.back].filter((u): u is string => !!u) };
}

/** Everybody active who holds the Founder Dashboard. */
export async function founderHolders(): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    select distinct u.id from users u join app_access a on a.user_id = u.id
     where a.app = 'founder' and u.active
  `);
  return rows.map((r) => r.id);
}

/** Only users that exist and are active — a name on a sheet is not an account. */
export async function activeUserIds(ids: string[]): Promise<string[]> {
  const clean = [...new Set(ids.filter(Boolean))];
  if (!clean.length) return [];
  const list = sql.join(clean.map((id) => sql`${id}`), sql`, `);
  const rows = await db.execute<{ id: string }>(sql`select id from users where active and id in (${list})`);
  return rows.map((r) => r.id);
}
