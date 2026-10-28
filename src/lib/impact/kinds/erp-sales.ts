import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { bills, erpBatchCodes, erpOrderDetails, orders } from "@/db/schema";
import { bookBillRef, bookOrderRef, erpOrdersLive } from "@/lib/erp/book";
import { scannedOnAllocation } from "@/lib/erp/dispatch";
import { orderLines, type OrderLine } from "@/lib/erp/screens/sales";
import { nf } from "@/lib/erp/ui";
import { money } from "@/lib/format";
import type { ImpactItem } from "../types";
import type { ImpactSource } from "../registry";
import { erpMayDelete, many, present, qty } from "./erp-common";
import { ORDER_SCREENS } from "./erp-order-line";

/* ---------------------------------------------------------------------------
 * AN ORDER IN THE ERP IS ALSO AN ORDER IN THE BOOK. Once the ERP takes the
 * orders (`erp.orders.live`) every write that changes a line's status, its
 * billing or its dispatch is copied into MahekOne's `orders` and `bills` — what
 * Accounts approve, the CRM's Call Log and buying cycle read, and every target
 * counts. Cancelling a line, undoing a bill or un-dispatching it is therefore
 * never only the godown's business; the report says what the book does next.
 *
 * The refusals are the acts' own: a dispatch-verified line moves no more, a
 * billed one is unbilled first, an allocated one has its batch codes released
 * first. A selection is refused only where none of it can move — the act
 * changes the rest and names what it left — so a partial refusal is listed as
 * kept rather than blocking the button.
 * ------------------------------------------------------------------------- */

const ids = (id: string) => [...new Set(id.split(",").map((s) => s.trim()).filter(Boolean))];
const unitOf = (l: OrderLine) => (l.boxed ? "boxes" : "cans");

/** The lines of these orders, every one — an order is billed and synced whole. */
async function wholeOrdersOf(lineIds: string[]): Promise<Map<number, OrderLine[]>> {
  const picked = await orderLines({ ids: lineIds });
  const nos = [...new Set(picked.filter((l) => lineIds.includes(l.o.id)).map((l) => l.o.orderNo))];
  const out = new Map<number, OrderLine[]>();
  if (!nos.length) return out;
  for (const l of await orderLines({ orderNos: nos })) out.set(l.o.orderNo, [...(out.get(l.o.orderNo) ?? []), l]);
  return out;
}

/** The book's copy of an order and its bill, where the ERP takes the orders. */
async function bookOf(orderNo: number) {
  const [[o], [b]] = await Promise.all([
    db.select({ status: orders.status, total: orders.totalAmount }).from(orders).where(eq(orders.externalRef, bookOrderRef(orderNo))),
    db.select({ no: bills.billNo, paid: bills.paidAmount, amount: bills.amount }).from(bills).where(eq(bills.externalRef, bookBillRef(orderNo))),
  ]);
  return { order: o ?? null, bill: b ?? null };
}

/* ============================================================ cancel lines */

export const orderCancelImpact: ImpactSource = {
  authorize: async () => {
    await erpMayDelete(ORDER_SCREENS);
  },

  /** One line, or a selection's ids joined by commas. */
  async report(id) {
    const want = ids(id);
    const asked = (await orderLines({ ids: want })).filter((l) => want.includes(l.o.id));
    if (!asked.length) return null;
    const open = asked.filter((l) => l.o.status !== "Cancel");
    const go: OrderLine[] = [];
    const refused: string[] = [];
    for (const l of open) {
      const why = l.dispatched ? "dispatch-verified" : l.inDetails ? "billed — undo billing first" : l.allocations ? "has batch codes — release them first" : "";
      if (why) refused.push(`order ${l.o.orderNo} · ${l.sku.name} is ${why}`);
      else go.push(l);
    }
    const blockers: string[] = [];
    if (!open.length) blockers.push("Those lines are already Cancel.");
    else if (!go.length) blockers.push(`Not changed: ${refused.join("; ")}.`);

    const items: ImpactItem[] = [
      {
        app: "ERP",
        label: `order ${many(go.length, "line")} cancelled`,
        effect: "changed",
        count: go.length,
        examples: go.slice(0, 5).map((l) => `order ${l.o.orderNo} · ${l.sku.name} · ${nf(l.o.qtyCans)} cans`),
        note: go.some((l) => l.o.status === "Ready") ? "A Ready line stops holding shelf stock for itself; the godown no longer allocates to it." : undefined,
      },
      {
        app: "ERP",
        label: `selected ${many(refused.length, "line")} left as ${refused.length === 1 ? "it is" : "they are"}`,
        effect: "kept",
        count: go.length ? refused.length : 0,
        examples: refused.slice(0, 5),
      },
    ];

    /* What each order looks like after: still alive with fewer lines, or gone. */
    const whole = await wholeOrdersOf(go.map((l) => l.o.id));
    const goIds = new Set(go.map((l) => l.o.id));
    const ended: number[] = [];
    const shrunk: number[] = [];
    for (const [no, all] of whole) (all.some((l) => l.o.status !== "Cancel" && !goIds.has(l.o.id)) ? shrunk : ended).push(no);
    if (go.length && (await erpOrdersLive())) {
      items.push({
        app: "Accounts",
        label: `${many(ended.length, "order")} in the order book marked cancelled`,
        effect: "changed",
        count: ended.length,
        examples: ended.slice(0, 5).map((n) => bookOrderRef(n)),
        note: "Every live line of each is cancelled. The order stays, cancelled; Accounts, the CRM's Call Log and the customer's buying cycle stop counting it.",
      });
      items.push({
        app: "Accounts",
        label: `${many(shrunk.length, "order")} in the order book rewritten without the cancelled lines`,
        effect: "changed",
        count: shrunk.length,
        examples: shrunk.slice(0, 5).map((n) => bookOrderRef(n)),
        note: "Their lines and value are rebuilt from the lines left — what Accounts approve and targets read.",
      });
    }
    if (ended.length) {
      const [{ n }] = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from factory_tasks where proc = 'dispatch' and status = 'ready' and order_no in ${ended.map(String)}`);
      items.push({
        app: "Factory",
        label: `loading ${many(Number(n), "job")} for the cancelled ${many(ended.length, "order")}`,
        effect: "kept",
        count: Number(n),
        note: "They stay on the floor's list with nothing left to load — cancel them there.",
      });
    }

    const one = asked.length === 1 ? asked[0] : null;
    return {
      title: one ? `${one.sku.name} · ${nf(one.o.qtyCans)} cans on order ${one.o.orderNo} for ${one.billing.name}` : `${asked.length} order lines`,
      verb: "Cancel",
      confirmWord: one ? String(one.o.orderNo) : "CANCEL",
      items: present(items),
      blockers,
    };
  },
};

/* ============================================================ undo billing */

export const orderUnbillImpact: ImpactSource = {
  authorize: async () => {
    await erpMayDelete(ORDER_SCREENS);
  },

  /** One line (its whole order goes back), or a selection's ids joined by commas. */
  async report(id) {
    const whole = await wholeOrdersOf(ids(id));
    if (!whole.size) return null;
    const back: OrderLine[] = [];
    const refused: string[] = [];
    for (const [no, order] of whole) {
      const billed = order.filter((l) => l.inDetails);
      if (!billed.length) continue;
      if (billed.some((l) => l.dispatched)) refused.push(`order ${no} has been dispatch-verified`);
      else back.push(...billed);
    }
    const blockers = back.length ? [] : [refused.length ? `Not undone: ${refused.join("; ")}.` : "Only a billed order that has not been dispatch-verified goes back."];
    const nos = [...new Set(back.map((l) => l.o.orderNo))];
    const checked = back.filter((l) => l.invoiceCheck === "Approved" || l.invoiceCheck === "Rejected");
    const invoices = [...new Set(back.map((l) => l.o.tallyBillNo).filter((x): x is string => !!x))];

    return {
      title: nos.length === 1 ? `Order ${nos[0]} · ${back[0].billing.name}` : `${nos.length} orders`,
      verb: "Undo billing",
      confirmWord: nos.length === 1 ? String(nos[0]) : "UNDO",
      items: present([
        {
          app: "ERP",
          label: `billed ${many(back.length, "line")} taken off order details`,
          effect: "deleted",
          count: back.length,
          examples: back.slice(0, 5).map((l) => `order ${l.o.orderNo} · ${l.sku.name}`),
          note: "Their billing rows — GST, the bill's figures — go; the order lines go back to To bill.",
        },
        {
          app: "ERP",
          label: `invoice ${many(checked.length, "check")} cleared`,
          effect: "changed",
          count: checked.length,
          note: "The checker's Approved or Rejected is undone; the invoice is checked again once it is billed again.",
        },
        {
          app: "ERP",
          label: `invoice ${many(invoices.length, "number")} stays on the lines`,
          effect: "kept",
          count: invoices.length,
          examples: invoices.slice(0, 5),
          note: "Billing again offers it; Change invoice replaces it.",
        },
      ]),
      blockers,
    };
  },
};

/* ======================================================= release a lot allocation */

export const batchReleaseImpact: ImpactSource = {
  authorize: async () => {
    await erpMayDelete(["batchCodes"]);
  },

  async report(id) {
    const [b] = await db.select().from(erpBatchCodes).where(eq(erpBatchCodes.id, id));
    if (!b) return null;
    const [[d], [line], scanned] = await Promise.all([
      db.select({ v: erpOrderDetails.verification }).from(erpOrderDetails).where(eq(erpOrderDetails.orderId, b.orderId)),
      orderLines({ ids: [b.orderId] }).then((ls) => ls.filter((l) => l.o.id === b.orderId)),
      scannedOnAllocation(b.orderId, b.lotCode),
    ]);
    const blockers: string[] = [];
    if (d?.v === "Verified") blockers.push("The order has been dispatch-verified.");
    else if (d) blockers.push("The line is billed. Undo its billing first.");
    else if (scanned) blockers.push(`${scanned} box${scanned === 1 ? " is" : "es are"} scanned against this lot; take ${scanned === 1 ? "it" : "them"} off at the Dispatch desk first.`);
    const unit = b.lotFrom === "pack" ? "boxes" : "cans";

    return {
      title: `${nf(b.quantity)} ${unit} of ${b.lotCode}${line ? ` → order ${line.o.orderNo} · ${line.sku.name}` : ""}`,
      verb: "Release",
      confirmWord: b.lotCode,
      items: present([
        {
          app: "ERP",
          label: `${unit} go back into ${b.lotFrom === "pack" ? "packing" : "FG"} lot ${b.lotCode}, free for any order`,
          effect: "changed",
          count: qty(b.quantity),
        },
        {
          app: "ERP",
          label: line ? `order ${line.o.orderNo} · ${line.sku.name} needs this much allocating again before it can be billed` : "order line needs allocating again",
          effect: "changed",
          count: line ? 1 : 0,
          note: line ? `Allocated now: ${nf(line.allocated)} ${unitOf(line)}; after: ${nf(qty(line.allocated - b.quantity))}.` : undefined,
        },
      ]),
      blockers,
    };
  },
};

/* ===================================================== un-dispatch a line */

export const dispatchUnverifyImpact: ImpactSource = {
  authorize: async () => {
    await erpMayDelete(["orderDetails"], (ctx) => (ctx.administrator ? null : "Only an administrator marks a line not verified."));
  },

  async report(id) {
    const [x] = await db.execute<{ verification: string | null; orderNo: number; sku: string; party: string }>(sql`
      select d.verification, o.order_no as "orderNo", p.name as sku, c.name as party
        from erp_order_details d
        join erp_orders o on o.id = d.order_id
        join products p on p.id = o.sku_id
        join customers c on c.id = o.billing_customer_id
       where d.order_id = ${id}`);
    if (!x) return null;
    const orderNo = Number(x.orderNo);
    const wasVerified = x.verification === "Verified";
    const items: ImpactItem[] = [
      {
        app: "ERP",
        label: `line of order ${orderNo} goes back from ${wasVerified ? "dispatched" : (x.verification ?? "pending").toLowerCase()} to not verified`,
        effect: "changed",
        count: 1,
        note: "Its boxes, transport record and stock are not touched — only the dispatch check on the line.",
      },
    ];

    if (wasVerified && (await erpOrdersLive())) {
      const [book, [others]] = await Promise.all([
        bookOf(orderNo),
        db.execute<{ n: number }>(sql`
          select count(*)::int as n from erp_orders o join erp_order_details d on d.order_id = o.id
           where o.order_no = ${orderNo} and o.status <> 'Cancel' and o.id <> ${id} and d.verification = 'Verified'`),
      ]);
      const stillSent = Number(others?.n ?? 0);
      if (book.order && ["dispatched", "in_transit", "delivered"].includes(book.order.status)) {
        items.push({
          app: "Accounts",
          label: `order ${bookOrderRef(orderNo)} in the order book goes back from ${book.order.status.replace("_", " ")} to confirmed`,
          effect: "changed",
          count: 1,
          note: `${x.party}'s outstanding, buying cycle and follow-up are recomputed.`,
        });
      }
      if (book.bill) {
        const paid = Number(book.bill.paid) > 0;
        items.push(
          stillSent
            ? { app: "Accounts", label: `bill ${book.bill.no} rewritten from the dispatched lines left`, effect: "changed", count: 1, note: `It is ${money(Number(book.bill.amount))} now and drops by this line's value.` }
            : paid
              ? { app: "Accounts", label: `bill ${book.bill.no} has money against it and is kept`, effect: "kept", count: 1 }
              : { app: "Accounts", label: `unpaid bill ${book.bill.no}`, effect: "deleted", count: 1, note: "No line of the order is dispatched any more, so the bill that dispatch raised goes." },
        );
      }
    }

    return {
      title: `${x.sku} · order ${orderNo} for ${x.party}`,
      verb: "Mark not verified",
      confirmWord: String(orderNo),
      items: present(items),
      blockers: [],
    };
  },
};
