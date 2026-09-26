import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { bills, customers, orders, paymentReceipts } from "@/db/schema";
import { getConfig } from "../config/store";
import { today } from "../recompute";
import { effectiveDueDate } from "../engines/escalation";
import { billCreditDaysSql } from "../bill-terms";
import { PURCHASE_STATUSES } from "../order-status";
import type { CustomerFacts } from "../wati-templates";

/* ---------------------------------------------------------------------------
 * The facts one customer's WhatsApp templates are built from — read fresh,
 * every time, at the moment of rendering or sending.
 *
 * Fresh on purpose. A message prepared at 9am and sent at 11am must not quote
 * the bills as they stood at 9am if a payment was confirmed at 10; so a send
 * re-reads these rather than trusting whatever was stored when it was queued.
 *
 * Every figure here comes from the same source the CRM's own screens use:
 * `effectiveDueDate` (with the bill's own credit terms) for overdue, stated
 * bills only, `PURCHASE_STATUSES` for what counts as an order. A customer
 * could be told a different number from the one a telecaller sees otherwise.
 * ------------------------------------------------------------------------- */

export async function factsFor(customerId: string): Promise<CustomerFacts | null> {
  const [c] = await db.select().from(customers).where(eq(customers.id, customerId));
  if (!c) return null;
  const [config, day] = await Promise.all([getConfig(), today()]);

  const billRows = await db
    .select({ bill: bills, creditDays: billCreditDaysSql })
    .from(bills)
    .where(
      and(
        eq(bills.customerId, customerId),
        sql`${bills.amount} > ${bills.paidAmount}`,
        // Never a bill nobody has stated a position for — the one place an
        // unverified balance would otherwise leave the building.
        eq(bills.paymentPosition, "stated"),
      ),
    );

  const [claim] = await db
    .select({ id: paymentReceipts.id })
    .from(paymentReceipts)
    .where(
      and(
        eq(paymentReceipts.customerId, customerId),
        inArray(paymentReceipts.status, ["reported", "held"]),
      ),
    )
    .limit(1);

  const [last] = await db
    .select({
      id: orders.id,
      day: sql<string>`((${orders.orderedAt}) at time zone 'Asia/Kolkata')::date::text`,
      total: orders.totalAmount,
      lines: orders.lineItems,
    })
    .from(orders)
    .where(and(eq(orders.customerId, customerId), inArray(orders.status, [...PURCHASE_STATUSES])))
    .orderBy(desc(orders.orderedAt))
    .limit(1);

  let products: string[] = [];
  if (last) {
    products = (last.lines ?? []).map((l) => l.product).filter((p): p is string => Boolean(p?.trim()));
    if (!products.length) {
      // A CRM order carries its products on the call that took it, keyed on
      // the catalogue rather than as text.
      const crm = await db.execute<{ name: string }>(sql`
        select p.name from interaction_product_lines l
          join calls k on k.id = l.interaction_id
          join products p on p.id = l.product_id
         where k.order_id = ${last.id}
         order by l.id
      `);
      products = crm.map((r) => r.name);
    }
  }

  const [pending] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.customerId, customerId), eq(orders.status, "pending_approval")))
    .limit(1);

  return {
    today: day,
    customer: {
      name: c.name,
      kind: c.kind === "lead" ? "lead" : "customer",
      thirdParty: c.thirdParty,
      deactivated: c.status === "deactivated",
      doNotContact: c.doNotContact,
    },
    openBills: billRows.map(({ bill: b, creditDays }) => ({
      billNo: b.billNo,
      billDate: b.billDate,
      dueDate: effectiveDueDate(
        {
          id: b.id,
          billNo: b.billNo,
          billDate: b.billDate,
          dueDate: b.dueDate,
          creditDays,
          amount: b.amount,
          paid: b.paidAmount,
          disputed: b.disputed,
        },
        config,
      ),
      balancePaise: Number(b.amount) - Number(b.paidAmount),
      disputed: b.disputed,
    })),
    paymentClaimPending: Boolean(claim),
    lastOrder: last
      ? { date: last.day, valuePaise: Number(last.total), products }
      : null,
    orderPendingApproval: Boolean(pending),
    openInOrderSystem: c.activeInOrderSystem,
    cycle: { days: c.cycleDays, measured: !c.cycleIsDefault },
  };
}
