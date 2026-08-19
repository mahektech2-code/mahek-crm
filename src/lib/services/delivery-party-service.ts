import "server-only";
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { customers, orders, sheetTakenOrderRows } from "@/db/schema";
import { partyNameKey } from "@/lib/sheet-parse";

/* ---------------------------------------------------------------------------
 * Where the goods actually went.
 *
 * The Taken Order tab has carried `Delivery Party Name` beside `Billing Party
 * Name` since the day it was read, and nothing has ever looked at it. This is
 * what looks at it: for every order projected from the sheet, if the delivery
 * party differs from the billing party and names a record we already hold, the
 * order records where it went.
 *
 * IT CREATES NOTHING. Not a customer, not a lead, not a third party. A name
 * that matches no record is counted and reported, never inserted — the lead
 * book is full of records some earlier import created from a spreadsheet
 * column, and this is the subsystem that exists because of it.
 * ------------------------------------------------------------------------- */

/** Folded the way the projection folds a party name, so both agree. */
const fold = (name: string) => partyNameKey(name);

export type DeliveryLinkResult = {
  /** Orders whose delivery party now names a record. */
  linked: number;
  /** Links removed because the sheet no longer says the goods went elsewhere. */
  cleared: number;
  /** Delivery names with no record at all. Reported, never created. */
  unresolved: number;
  /** Names folding onto more than one record — held rather than guessed at. */
  ambiguous: number;
};

/**
 * Rebuild every order's delivery party from the sheet.
 *
 * A recompute, not an import: it derives `orders.deliveryCustomerId` from data
 * already stored and can be re-run at any time, which is what makes it safe to
 * put in the nightly. Running it twice changes nothing the second time.
 */
export async function linkDeliveryParties(): Promise<DeliveryLinkResult> {
  /*
   * Every folded name we hold, to the record it names.
   *
   * By NAME rather than by `externalCode`, and that is the whole difficulty:
   * the projection resolves a BILLING party by code because it wrote those
   * codes itself, but only the 561 customers have one. The delivery parties
   * include leads that arrived from somewhere else entirely, and 99 of them
   * match — by code, all 99 would be invisible.
   */
  const records = await db
    .select({ id: customers.id, name: customers.name, status: customers.status })
    .from(customers);

  const byName = new Map<string, string>();
  const duplicated = new Set<string>();
  for (const r of records) {
    // A deactivated record is not a delivery address anybody should be handed,
    // but it is still the right answer about where an old order went.
    const key = fold(r.name);
    if (byName.has(key)) duplicated.add(key);
    else byName.set(key, r.id);
  }

  /*
   * The sheet's own answer, per order.
   *
   * `orders.externalRef` is `SHEET-<order number>` and the taken-order row
   * carries that number, which is the only join between the tab that knows the
   * delivery party and the tab the orders were built from. One row per order:
   * a multi-line order repeats its parties on every line, and `distinct` is
   * cheaper than deciding which line to believe.
   */
  const rows = await db
    .selectDistinct({
      orderId: orders.id,
      billingCustomerId: orders.customerId,
      current: orders.deliveryCustomerId,
      deliveryPartyName: sheetTakenOrderRows.deliveryPartyName,
      billingPartyName: sheetTakenOrderRows.billingPartyName,
    })
    .from(orders)
    .innerJoin(
      sheetTakenOrderRows,
      eq(orders.externalRef, sql`'SHEET-' || ${sheetTakenOrderRows.orderNumber}`),
    )
    .where(
      and(
        isNotNull(sheetTakenOrderRows.orderNumber),
        isNotNull(sheetTakenOrderRows.deliveryPartyName),
      ),
    );

  let linked = 0;
  let cleared = 0;
  let unresolved = 0;
  let ambiguous = 0;

  for (const row of rows) {
    const delivery = row.deliveryPartyName!;
    const sameAsBilling =
      row.billingPartyName !== null && fold(delivery) === fold(row.billingPartyName);

    // Delivered to the party that was billed: the column stays null, which is
    // what null MEANS. Writing the billing customer into it would make every
    // order look like a third-party delivery.
    if (sameAsBilling) {
      if (row.current !== null) {
        await db
          .update(orders)
          .set({ deliveryCustomerId: null })
          .where(eq(orders.id, row.orderId));
        cleared++;
      }
      continue;
    }

    const key = fold(delivery);
    if (duplicated.has(key)) {
      // Two records fold onto one name. Choosing between them silently is how
      // history gets attached to the wrong shop, so it is held, exactly as the
      // catalogue holds a name carried by two legacy product ids.
      ambiguous++;
      continue;
    }

    const id = byName.get(key);
    if (!id) {
      unresolved++;
      continue;
    }
    if (id === row.billingCustomerId || id === row.current) continue;

    await db
      .update(orders)
      .set({ deliveryCustomerId: id })
      .where(eq(orders.id, row.orderId));
    linked++;
  }

  return { linked, cleared, unresolved, ambiguous };
}

export type UnresolvedDeliveryParty = {
  name: string;
  orders: number;
  lastSeen: string | null;
};

/**
 * Delivery names naming nothing we hold.
 *
 * A list rather than an insert. Somebody reads it and decides whether each is a
 * shop worth a record — which is the one decision this whole subsystem exists
 * to keep in human hands.
 */
export async function unresolvedDeliveryParties(): Promise<UnresolvedDeliveryParty[]> {
  const rows = await db
    .select({
      name: sheetTakenOrderRows.deliveryPartyName,
      orders: sql<number>`count(distinct ${sheetTakenOrderRows.orderNumber})::int`,
      lastSeen: sql<string | null>`max(${sheetTakenOrderRows.orderDate})::text`,
    })
    .from(sheetTakenOrderRows)
    .where(
      and(
        isNotNull(sheetTakenOrderRows.deliveryPartyName),
        ne(sheetTakenOrderRows.deliveryPartyName, sheetTakenOrderRows.billingPartyName),
        sql`not exists (
          select 1 from customers c
           where upper(regexp_replace(btrim(c.name), '\s+', ' ', 'g'))
               = upper(regexp_replace(btrim(${sheetTakenOrderRows.deliveryPartyName}), '\s+', ' ', 'g'))
        )`,
      ),
    )
    .groupBy(sheetTakenOrderRows.deliveryPartyName)
    .orderBy(sql`count(distinct ${sheetTakenOrderRows.orderNumber}) desc`);

  return rows.map((r) => ({ name: r.name!, orders: r.orders, lastSeen: r.lastSeen }));
}
