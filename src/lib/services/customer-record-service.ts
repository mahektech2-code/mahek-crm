import "server-only";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  bills,
  complaints,
  customers,
  orders,
  paymentReceipts,
  reminders,
} from "@/db/schema";
import { orderCountsSql } from "@/lib/order-status";

/* ---------------------------------------------------------------------------
 * Everything the customer record should have been showing.
 *
 * The record page held a timeline, five figures and a four-line Account box,
 * while the call drawer's Information tab — opened over the top of it — knew
 * the product history, the buying cycle and the recent calls. The screen a
 * telecaller opens to prepare for a call held less than the drawer they open
 * during one.
 *
 * Every list here is capped. A customer with 400 bills is a scrolling panel,
 * not a page that never ends, and the cap is stated on the screen rather than
 * left for somebody to discover by counting.
 * ------------------------------------------------------------------------- */

const LIMIT = 200;

export type RecordBill = {
  id: string;
  billNo: string;
  billDate: string;
  dueDate: string | null;
  amount: number;
  paid: number;
  balance: number;
  status: string;
  /** `unstated` is neither paid nor owed — shown, never added up. */
  stated: boolean;
  daysOverdue: number | null;
};

export type RecordReceipt = {
  id: string;
  receivedAt: string;
  instrumentDate: string | null;
  amount: number;
  mode: string;
  reference: string | null;
  status: string;
  source: string;
};

export type RecordOrder = {
  id: string;
  orderNo: string | null;
  orderedAt: string;
  amount: number;
  status: string;
  lines: number;
  /** Where the goods went, when that was not the billing party. */
  deliveredTo: string | null;
  counts: boolean;
};

export type RecordComplaint = {
  id: string;
  category: string;
  description: string;
  status: string;
  createdAt: string;
};

export type RecordReminder = {
  id: string;
  dueDate: string;
  note: string | null;
  status: string;
  ownerName: string | null;
};

/*
 * `deliversTo` and `billedThrough` were here, derived from
 * `orders.delivery_customer_id`, and each was drawn as its own panel beside
 * the recorded arrangement. Two lists answering one question is what put four
 * rows beside eighty-six under two titles — they are one list per direction
 * now, in `lib/services/distributor-service.ts`, which reads the arrangement
 * and the order history together so a row can say which it is.
 */

export type CustomerRecordDetail = {
  bills: RecordBill[];
  receipts: RecordReceipt[];
  orders: RecordOrder[];
  complaints: RecordComplaint[];
  reminders: RecordReminder[];
  counts: {
    bills: number;
    receipts: number;
    orders: number;
    complaints: number;
    reminders: number;
  };
};

export async function customerRecordDetail(
  customerId: string,
  today: string,
): Promise<CustomerRecordDetail> {
  const [
    billRows,
    receiptRows,
    orderRows,
    complaintRows,
    reminderRows,
    counts,
  ] = await Promise.all([
    db
      .select({
        id: bills.id,
        billNo: bills.billNo,
        billDate: bills.billDate,
        dueDate: bills.dueDate,
        amount: bills.amount,
        paid: bills.paidAmount,
        status: bills.status,
        position: bills.paymentPosition,
      })
      .from(bills)
      .where(eq(bills.customerId, customerId))
      .orderBy(desc(bills.billDate), desc(bills.billNo))
      .limit(LIMIT),

    db
      .select({
        id: paymentReceipts.id,
        receivedAt: paymentReceipts.receivedAt,
        instrumentDate: paymentReceipts.instrumentDate,
        amount: paymentReceipts.amount,
        mode: paymentReceipts.mode,
        reference: paymentReceipts.reference,
        status: paymentReceipts.status,
        source: paymentReceipts.source,
      })
      .from(paymentReceipts)
      .where(eq(paymentReceipts.customerId, customerId))
      .orderBy(desc(paymentReceipts.receivedAt))
      .limit(LIMIT),

    db
      .select({
        id: orders.id,
        orderNo: orders.orderNo,
        orderedAt: sql<string>`to_char(${orders.orderedAt} at time zone 'Asia/Kolkata', 'YYYY-MM-DD')`,
        amount: orders.totalAmount,
        status: orders.status,
        lines: sql<number>`coalesce(jsonb_array_length(${orders.lineItems}), 0)::int`,
        deliveredTo: sql<string | null>`(
          select c.name from customers c where c.id = orders.delivery_customer_id
        )`,
        counts: sql<boolean>`${orderCountsSql("orders")}`,
      })
      .from(orders)
      .where(eq(orders.customerId, customerId))
      .orderBy(desc(orders.orderedAt))
      .limit(LIMIT),

    db
      .select({
        id: complaints.id,
        category: complaints.category,
        description: complaints.description,
        status: complaints.status,
        createdAt: sql<string>`to_char(${complaints.createdAt} at time zone 'Asia/Kolkata', 'YYYY-MM-DD')`,
      })
      .from(complaints)
      .where(eq(complaints.customerId, customerId))
      .orderBy(desc(complaints.createdAt))
      .limit(LIMIT),

    db
      .select({
        id: reminders.id,
        dueDate: reminders.dueDate,
        note: reminders.note,
        status: reminders.status,
        ownerName: sql<string | null>`(
          select name from users u where u.id = reminders.assigned_user_id
        )`,
      })
      .from(reminders)
      .where(eq(reminders.customerId, customerId))
      .orderBy(desc(reminders.dueDate))
      .limit(LIMIT),

        // The real totals, so a capped list can say what it is a slice of.
    db
      .select({
        bills: sql<number>`(select count(*)::int from bills where bills.customer_id = ${customerId})`,
        receipts: sql<number>`(select count(*)::int from payment_receipts r where r.customer_id = ${customerId})`,
        orders: sql<number>`(select count(*)::int from orders o where o.customer_id = ${customerId})`,
        complaints: sql<number>`(select count(*)::int from complaints c where c.customer_id = ${customerId})`,
        reminders: sql<number>`(select count(*)::int from reminders rm where rm.customer_id = ${customerId})`,
      })
      .from(customers)
      .where(eq(customers.id, customerId))
      .then((r) => r[0]),
  ]);

  return {
    bills: billRows.map((b) => {
      const stated = b.position !== "unstated";
      const balance = Math.max(0, b.amount - b.paid);
      return {
        id: b.id,
        billNo: b.billNo,
        billDate: b.billDate,
        dueDate: b.dueDate,
        amount: b.amount,
        paid: b.paid,
        balance,
        status: b.status,
        stated,
        // Only a stated bill can be overdue. An unstated one is not a debt, so
        // counting days against it would invent an age for something nobody
        // has said is owed.
        daysOverdue:
          stated && balance > 0 && b.dueDate && b.dueDate < today
            ? Math.round(
                (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${b.dueDate}T00:00:00Z`)) /
                  86_400_000,
              )
            : null,
      };
    }),
    receipts: receiptRows,
    orders: orderRows,
    complaints: complaintRows,
    reminders: reminderRows,
    counts: counts ?? {
      bills: 0,
      receipts: 0,
      orders: 0,
      complaints: 0,
      reminders: 0,
    },
  };
}
