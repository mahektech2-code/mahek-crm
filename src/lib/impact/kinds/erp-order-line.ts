import "server-only";
import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { bills, customers, erpGodowns, erpOrders, orders, products } from "@/db/schema";
import { bookBillRef, bookOrderRef, erpOrdersLive } from "@/lib/erp/book";
import { money } from "@/lib/format";
import type { ImpactItem } from "../types";
import type { ImpactSource } from "../registry";
import { erpMayDelete, many, present } from "./erp-common";

/* ---------------------------------------------------------------------------
 * AN ORDER LINE IS IN TWO ORDER BOOKS. The ERP's line is where the godown
 * works it; once the ERP takes the orders (`erp.orders.live`) the same order
 * number is ONE row in MahekOne's `orders` — what Accounts approves, the CRM's
 * Call Log stops chasing on, and every target and buying cycle reads. Deleting
 * a line rewrites that order, and deleting the last one cancels it.
 *
 * What may never be deleted is a line something physical is attached to: a
 * bill, batch codes holding stock, a box scanned against it, a return, or a
 * dispatch override somebody asked for. Every one of those holds the line by a
 * foreign key, so the delete used to fail in the database with a message
 * nobody could act on; the report names it instead, as a blocker.
 * ------------------------------------------------------------------------- */

/** Every order screen the line's Delete is offered on. */
export const ORDER_SCREENS = ["orders", "verifyOrders", "pendingOrders", "readyOrders", "toBill", "invoiceCheck", "labels"];

export const orderLineImpact: ImpactSource = {
  authorize: async () => {
    await erpMayDelete(ORDER_SCREENS);
  },

  async report(id) {
    const [x] = await db
      .select({ o: erpOrders, sku: products.name, party: customers.name, godown: erpGodowns.name })
      .from(erpOrders)
      .innerJoin(products, eq(products.id, erpOrders.skuId))
      .innerJoin(customers, eq(customers.id, erpOrders.billingCustomerId))
      .innerJoin(erpGodowns, eq(erpGodowns.id, erpOrders.godownId))
      .where(eq(erpOrders.id, id));
    if (!x) return null;
    const o = x.o;
    const [[held], others, live] = await Promise.all([
      db.execute<{ billed: number; codes: number; units: number; overrides: number; returns: number; followups: number }>(sql`
        select (select count(*)::int from erp_order_details where order_id = ${id}) as billed,
               (select count(*)::int from erp_batch_codes where order_id = ${id}) as codes,
               (select count(*)::int from erp_units where order_id = ${id}) as units,
               (select count(*)::int from erp_dispatch_overrides where order_id = ${id}) as overrides,
               (select count(*)::int from erp_customer_returns where order_id = ${id}) as returns,
               (select count(*)::int from erp_followups where order_id = ${id}) as followups`),
      db
        .select({ id: erpOrders.id, sku: products.name, cans: erpOrders.qtyCans, status: erpOrders.status })
        .from(erpOrders)
        .innerJoin(products, eq(products.id, erpOrders.skuId))
        .where(and(eq(erpOrders.orderNo, o.orderNo), ne(erpOrders.id, id))),
      erpOrdersLive(),
    ]);
    const n = (k: keyof typeof held) => Number(held?.[k] ?? 0);

    const blockers: string[] = [];
    if (n("billed")) blockers.push("It is billed: a billed line is not deleted. Undo its billing first.");
    if (n("codes")) blockers.push(`Its ${n("codes")} batch ${many(n("codes"), "code")} hold stock. Release them first.`);
    if (n("units")) blockers.push(`${n("units")} ${many(n("units"), "box", "boxes")} or labelled ${many(n("units"), "can")} ${n("units") === 1 ? "was" : "were"} scanned against it at dispatch. Take them off the order first.`);
    if (n("overrides")) blockers.push("A dispatch override was asked for on this line; it is the record of who asked and who decided, and keeps the line.");
    if (n("returns")) blockers.push("Goods on it have come back as a customer return, which is recorded against this line.");

    const stillOpen = others.filter((l) => l.status !== "Cancel");
    const items: ImpactItem[] = [
      {
        app: "ERP",
        label: `other ${many(others.length, "line")} of order ${o.orderNo}`,
        effect: "kept",
        count: others.length,
        examples: others.slice(0, 5).map((l) => `${l.sku} · ${l.cans} cans`),
      },
      {
        app: "ERP",
        label: "retired follow-up remark on the line",
        effect: "deleted",
        count: n("followups"),
        note: "A remark from Mahek Plus's order follow-up, which nothing reads any more. It held the line in place; it goes with it.",
      },
    ];
    if (stillOpen.length && o.orderCheck !== "Pending" && o.status !== "Cancel") {
      items.push({
        app: "ERP",
        label: `order ${o.orderNo} goes back to the back office to verify`,
        effect: "changed",
        count: 1,
        note: `A line removed is a change to the order, so its check returns to Pending (it is ${o.orderCheck} now).`,
      });
    }

    if (live) {
      const [[book], [bill]] = await Promise.all([
        db.select({ id: orders.id, status: orders.status, total: orders.totalAmount }).from(orders).where(eq(orders.externalRef, bookOrderRef(o.orderNo))),
        db.select({ id: bills.id, paid: bills.paidAmount, no: bills.billNo }).from(bills).where(eq(bills.externalRef, bookBillRef(o.orderNo))),
      ]);
      if (book && !others.length) {
        items.push({
          app: "Accounts",
          label: `order ${bookOrderRef(o.orderNo)} in the order book marked cancelled`,
          effect: "changed",
          count: 1,
          note: `It was its last line. The order stays, cancelled, because it was on somebody's list; the CRM, Accounts and ${x.party}'s buying cycle stop counting it.`,
        });
        if (bill && !Number(bill.paid)) {
          items.push({ app: "Accounts", label: `unpaid bill ${bill.no}`, effect: "deleted", count: 1 });
        }
      } else if (book) {
        items.push({
          app: "Accounts",
          label: `order ${bookOrderRef(o.orderNo)} in the order book rewritten without this line`,
          effect: "changed",
          count: 1,
          note: `Its lines and value (${money(Number(book.total))} now) are rebuilt from the lines left — what Accounts approves and the CRM's targets read.`,
        });
      }
    }

    if (!stillOpen.length) {
      const [{ n: jobs }] = await db.execute<{ n: number }>(
        sql`select count(*)::int as n from factory_tasks where proc = 'dispatch' and status = 'ready' and order_no = ${String(o.orderNo)}`,
      );
      items.push({
        app: "Factory",
        label: `loading ${many(Number(jobs), "job")} for order ${o.orderNo}`,
        effect: "kept",
        count: Number(jobs),
        note: "It stays on the floor's list with nothing left to load — cancel it there.",
      });
    }

    return {
      title: `${x.sku} · ${o.qtyCans} cans on order ${o.orderNo} for ${x.party}`,
      verb: "Delete",
      confirmWord: String(o.orderNo),
      items: present(items),
      blockers,
    };
  },
};
