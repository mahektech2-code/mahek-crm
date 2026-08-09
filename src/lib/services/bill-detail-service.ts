import "server-only";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  bills,
  customers,
  orders,
  payments,
  paymentReceipts,
  sheetOrderRows,
} from "@/db/schema";
import { ASSIGNED_TO_SQL, resolveScope, scopedUserIds } from "../access-control";
import { billCreditDaysSql } from "../bill-terms";
import { calendarDate } from "../business-date";
import { boxesFor, litresFor } from "../catalogue";
import { getConfig } from "../config/store";
import { effectiveDueDate } from "../engines/escalation";
import { orderLines } from "./order-approval-service";

/* ---------------------------------------------------------------------------
 * What is behind one line of the sales bill ledger.
 *
 * The bills table answers "how much and when"; it cannot answer "what did they
 * actually buy", which is the question anybody reading an order history asks
 * next. A bill IS an order here, so the answer already exists — spread across
 * three places depending on where the order came from — and this is the one
 * function that assembles it.
 *
 * Loaded a row at a time, when a row is opened. Ten thousand bills' worth of
 * line items is not something to send to a browser that will show one.
 * ------------------------------------------------------------------------- */

/** Where the items came from. Shown, because it says how much detail to expect. */
export type LineSource = "sheet" | "order" | "call" | "none";

export type BillDetailLine = {
  description: string;
  /** The formulation, or the pack size — whatever names the thing further. */
  subtitle: string | null;
  /** The sheet's "Type": Can or Drums. Null where nothing recorded one. */
  packType: string | null;
  cans: number | null;
  /** Derived, never stored: from the sheet's dispatched litres or the SKU. */
  litres: number | null;
  boxes: number | null;
  /** Paise, per can. */
  ratePaise: number | null;
  /** Paise, before GST and discount. */
  amountPaise: number | null;
  /** Basis points: 5% is 500. The sheet's Discount is a percentage. */
  discountBp: number | null;
  /** Paise, what the line was actually billed at. */
  finalAmountPaise: number | null;
  /** Line-level in the sheet — one order's lines can carry different numbers. */
  tallyBillNo: string | null;
};

export type BillDetail = {
  id: string;
  billNo: string;
  billDate: string;
  dueDate: string;
  amount: number;
  paid: number;
  balance: number;
  status: "unpaid" | "partially_paid" | "paid";
  disputed: boolean;
  customerId: string;
  customerName: string;
  /** Null where the bill was typed in rather than raised against an order. */
  order: {
    /** The number the customer quotes, from the sheet. */
    number: string | null;
    orderedAt: string | null;
    dispatchDate: string | null;
    status: string;
    source: string;
    totalAmount: number;
    creditDays: number | null;
    /** Order-level in the sheet, so it sits on the header and not the lines. */
    gstBp: number | null;
    paymentType: string | null;
    paymentStatus: string | null;
    paymentReceivedDate: string | null;
    transportName: string | null;
    area: string | null;
    salesMan: string | null;
    segmentCounterType: string | null;
    orderFulfillDays: number | null;
  } | null;
  lines: BillDetailLine[];
  lineSource: LineSource;
  totals: {
    cans: number | null;
    litres: number | null;
    amountPaise: number | null;
    finalAmountPaise: number | null;
  };
  /** Every receipt line against this bill, reported ones included. */
  receipts: Array<{
    id: string;
    paidAt: string;
    amount: number;
    mode: string;
    reference: string | null;
    status: "reported" | "confirmed" | "rejected";
  }>;
};

/** `SHEET-2451` and `SHEETPAY-2451` both name order 2451. */
function orderNumberFrom(ref: string | null): string | null {
  if (!ref) return null;
  const match = ref.match(/^SHEET(?:PAY)?-(.+)$/);
  return match ? match[1] : null;
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/**
 * One bill, everything known about it.
 *
 * Scoped the way every other read is: a bill the caller may not see and a bill
 * that does not exist answer identically, or this becomes a way to page
 * through somebody else's book one id at a time.
 */
export async function getBillDetail(billId: string): Promise<BillDetail | null> {
  const { scope } = await resolveScope();
  const ids = scopedUserIds(scope);
  const config = await getConfig();

  const [row] = await db
    .select({
      bill: bills,
      customerName: customers.name,
      creditDays: billCreditDaysSql,
      order: orders,
    })
    .from(bills)
    .innerJoin(customers, eq(customers.id, bills.customerId))
    .leftJoin(orders, eq(orders.id, bills.orderId))
    .where(
      and(
        eq(bills.id, billId),
        ids ? inArray(ASSIGNED_TO_SQL, ids) : undefined,
      ),
    );

  if (!row) return null;

  const { bill: b, order } = row;
  const dueDate = effectiveDueDate(
    {
      id: b.id,
      billNo: b.billNo,
      billDate: b.billDate,
      dueDate: b.dueDate,
      creditDays: row.creditDays === null ? null : Number(row.creditDays),
      amount: b.amount,
      paid: b.paidAmount,
      disputed: b.disputed,
    },
    config,
  );

  const orderNumber =
    orderNumberFrom(order?.externalRef ?? null) ?? orderNumberFrom(b.externalRef);

  // The staged sheet rows are the fullest record of an imported order — GST,
  // transport, salesman and the litres actually dispatched never make it onto
  // `orders`, which keeps only what the CRM's own rules read. Nothing is
  // copied onto the order to make this easier: the sheet is the source, and a
  // second copy would be a second thing to keep true.
  const staged = orderNumber
    ? await db
        .select()
        .from(sheetOrderRows)
        .where(
          and(
            eq(sheetOrderRows.orderNumber, orderNumber),
            eq(sheetOrderRows.status, "present"),
          ),
        )
        .orderBy(asc(sheetOrderRows.rowNumber))
    : [];

  const head = staged[0];

  let lines: BillDetailLine[] = [];
  let lineSource: LineSource = "none";

  if (staged.length) {
    lineSource = "sheet";
    lines = staged.map((l) => ({
      description: l.description ?? "(not named)",
      subtitle: null,
      packType: l.packType,
      cans: l.cans,
      litres: l.volumeMl === null ? null : Number(l.volumeMl) / 1000,
      boxes: null,
      ratePaise: num(l.ratePaise),
      amountPaise: num(l.amountPaise),
      discountBp: l.discountBp,
      finalAmountPaise: num(l.finalAmountPaise),
      tallyBillNo: l.tallyBillNo,
    }));
  } else if (order?.lineItems?.length) {
    // An imported order whose staged rows have since been withdrawn from the
    // sheet. The order kept what it was projected with, and that is still an
    // honest answer to "what was on it" — just a shorter one.
    lineSource = "order";
    lines = order.lineItems.map((l) => ({
      description: l.product,
      subtitle: null,
      packType: null,
      cans: l.quantity,
      litres: null,
      boxes: null,
      ratePaise: l.unitPrice,
      amountPaise: null,
      discountBp: null,
      finalAmountPaise: l.amount,
      tallyBillNo: null,
    }));
  } else if (order) {
    // An order taken on a call. Its products are catalogue SKUs on the
    // interaction, so litres and boxes are derived from the SKU's own packing
    // rather than read off a cell.
    const called = await orderLines(order.id);
    if (called.length) {
      lineSource = "call";
      lines = called.map((l) => {
        const packing = {
          millilitresPerCan: l.millilitresPerCan,
          cansPerBox: l.cansPerBox,
        };
        const { boxes } = boxesFor(l.quantity, packing);
        return {
          description: l.productName,
          subtitle: l.subtitle ?? l.packSize,
          packType: null,
          cans: l.quantity,
          litres: litresFor(l.quantity, packing),
          boxes: boxes || null,
          // The catalogue carries no prices, so a call's line has no value of
          // its own. A zero here would read as free.
          ratePaise: null,
          amountPaise: null,
          discountBp: null,
          finalAmountPaise: null,
          tallyBillNo: null,
        };
      });
    }
  }

  const sum = (pick: (l: BillDetailLine) => number | null) => {
    const values = lines.map(pick).filter((v): v is number => v !== null);
    return values.length ? values.reduce((a, v) => a + v, 0) : null;
  };

  const receipts = await db
    .select({
      id: payments.id,
      paidAt: payments.paidAt,
      amount: payments.amount,
      mode: payments.mode,
      reference: payments.reference,
      status: paymentReceipts.status,
    })
    .from(payments)
    .innerJoin(paymentReceipts, eq(paymentReceipts.id, payments.receiptId))
    .where(eq(payments.billId, billId))
    .orderBy(desc(payments.paidAt));

  return {
    id: b.id,
    billNo: b.billNo,
    billDate: b.billDate,
    dueDate,
    amount: b.amount,
    paid: b.paidAmount,
    balance: b.amount - b.paidAmount,
    status: b.status,
    disputed: b.disputed,
    customerId: b.customerId,
    customerName: row.customerName,
    order: order
      ? {
          number: orderNumber,
          orderedAt: calendarDate(order.orderedAt),
          dispatchDate: order.expectedDispatch ?? head?.dispatchDate ?? null,
          status: order.status,
          source: order.source,
          totalAmount: order.totalAmount,
          creditDays: order.creditDays,
          gstBp: head?.gstBp ?? null,
          paymentType: head?.paymentType ?? null,
          paymentStatus: head?.paymentStatus ?? null,
          paymentReceivedDate: head?.paymentReceivedDate ?? null,
          transportName: head?.transportName ?? null,
          area: head?.area ?? null,
          salesMan: head?.salesMan ?? null,
          segmentCounterType: head?.segmentCounterType ?? null,
          orderFulfillDays: head?.orderFulfillDays ?? null,
        }
      : null,
    lines,
    lineSource,
    totals: {
      cans: sum((l) => l.cans),
      litres: sum((l) => l.litres),
      amountPaise: sum((l) => l.amountPaise),
      finalAmountPaise: sum((l) => l.finalAmountPaise),
    },
    receipts,
  };
}
