import "server-only";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, orders } from "@/db/schema";
import { requireCapability } from "../access-control";
import { recomputeBuyingCycle } from "../recompute";
import { err, okVoid, type Result } from "../result";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/* ---------------------------------------------------------------------------
 * Order approval.
 *
 * An order taken on a call is a customer saying yes. It is not yet the
 * business saying yes — accounts check who they are and what they already owe
 * before it is accepted. Until then it sits at `pending_approval`, counting
 * towards nothing except the fact that the customer should not be chased for
 * another order.
 *
 * Approving is the only thing this file does, and it is the only place that
 * moves an order out of pending. Both paths recompute the buying cycle,
 * because both change which orders count as purchases.
 * ------------------------------------------------------------------------- */

export type PendingOrder = {
  orderId: string;
  customerId: string;
  customerName: string;
  customerCity: string;
  contactPerson: string;
  phone: string;
  /** What accounts are actually checking: can this customer take more credit. */
  outstanding: number;
  overdueBills: number;
  slowPayer: boolean;
  creditDays: number | null;
  orderedAt: Date;
  takenByName: string | null;
  totalAmount: number;
  lineCount: number;
  waitingHours: number;
};

export type PendingOrderLine = {
  productName: string;
  packSize: string | null;
  /** The formulation. Two SKU names here differ by one word; this is what separates them. */
  subtitle: string | null;
  /** Cans — always. Litres and boxes are derived from the packing below. */
  quantity: number;
  millilitresPerCan: number | null;
  cansPerBox: number;
};

/** The approval queue, oldest first — a customer waiting longest is worked first. */
export async function pendingOrders(): Promise<PendingOrder[]> {
  const rows = await db.execute<{
    order_id: string;
    customer_id: string;
    customer_name: string;
    city: string;
    contact_person: string;
    phone: string;
    outstanding: number;
    overdue_bills: number;
    slow_payer: boolean;
    credit_days: number | null;
    ordered_at: Date;
    taken_by: string | null;
    total_amount: number;
    line_count: number;
    waiting_hours: number;
  }>(sql`
    select o.id as order_id, o.customer_id, c.name as customer_name, c.city,
           c.contact_person, c.phone, c.outstanding, c.slow_payer,
           c.credit_days, o.ordered_at, u.name as taken_by,
           o.total_amount,
           (select count(*)::int
              from interaction_product_lines l
              join calls ca on ca.id = l.interaction_id
             where ca.order_id = o.id) as line_count,
           (select count(*)::int from bills b
             where b.customer_id = c.id
               and b.amount > b.paid_amount
               and b.due_date < current_date) as overdue_bills,
           extract(epoch from (now() - o.ordered_at)) / 3600 as waiting_hours
      from orders o
      join customers c on c.id = o.customer_id
      left join users u on u.id = o.user_id
     where o.status = 'pending_approval'
     order by o.ordered_at asc
  `);

  return rows.map((r) => ({
    orderId: r.order_id,
    customerId: r.customer_id,
    customerName: r.customer_name,
    customerCity: r.city,
    contactPerson: r.contact_person,
    phone: r.phone,
    outstanding: Number(r.outstanding),
    overdueBills: Number(r.overdue_bills),
    slowPayer: r.slow_payer,
    creditDays: r.credit_days === null ? null : Number(r.credit_days),
    orderedAt: new Date(r.ordered_at),
    takenByName: r.taken_by,
    totalAmount: Number(r.total_amount),
    lineCount: Number(r.line_count),
    waitingHours: Math.floor(Number(r.waiting_hours)),
  }));
}

/**
 * The lines on one order. Loaded when a row is opened rather than with the
 * list: an order may carry hundreds of items and the queue only needs a count.
 */
export async function orderLines(orderId: string): Promise<PendingOrderLine[]> {
  const rows = await db.execute<{
    name: string;
    pack_size: string | null;
    formulation: string | null;
    quantity: number;
    millilitres_per_can: number | null;
    cans_per_box: number;
  }>(sql`
    select p.name, p.pack_size, f.name as formulation, l.quantity,
           p.millilitres_per_can, p.cans_per_box
      from interaction_product_lines l
      join calls ca on ca.id = l.interaction_id
      join products p on p.id = l.product_id
      left join product_formulations f on f.id = p.formulation_id
     where ca.order_id = ${orderId}
     order by p.display_order, p.name
  `);
  return rows.map((r) => ({
    productName: r.name,
    packSize: r.pack_size,
    subtitle: r.formulation,
    quantity: Number(r.quantity),
    millilitresPerCan: r.millilitres_per_can,
    cansPerBox: Number(r.cans_per_box) || 1,
  }));
}

export async function approveOrder(orderId: string): Promise<Result> {
  const ctx = await requireCapability("order.approve");

  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) return err("That order no longer exists.", "not_found");
  if (order.status !== "pending_approval") {
    // Two people opened the same queue. Say which way it went rather than
    // silently overwriting somebody else's decision.
    return err(
      `That order was already ${order.status === "declined" ? "declined" : "decided"}.`,
      "conflict",
    );
  }

  await db.transaction(async (tx) => {
    await tx
      .update(orders)
      .set({
        status: "confirmed",
        approvedById: ctx.user.id,
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(orders.id, orderId));

    await tx.insert(auditLog).values({
      id: id("aud"),
      actorId: ctx.user.id,
      // Which hat allowed it — see `audit_log.actor_role`.
      actorRole: ctx.authorisedBy,
      action: "order.approve",
      entityType: "order",
      entityId: orderId,
      // The value is recorded on the row so the audit log can say what was
      // approved without joining back to an order that may since have moved.
      afterState: {
        customerId: order.customerId,
        amount: Number(order.totalAmount),
      } as never,
    });
  });

  // It is a purchase now, so the cycle, the average and the history all change.
  await recomputeBuyingCycle(order.customerId);
  return okVoid("Order approved");
}

export async function declineOrder(
  orderId: string,
  reason: string,
): Promise<Result> {
  const ctx = await requireCapability("order.approve");

  // A refusal the telecaller cannot read is a row nobody can act on — they
  // have to ring the customer back and say something.
  if (!reason.trim()) {
    return err("Say why it is being declined.", "validation", [
      { field: "reason", message: "A reason is required." },
    ]);
  }

  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) return err("That order no longer exists.", "not_found");
  if (order.status !== "pending_approval") {
    return err(
      `That order was already ${order.status === "declined" ? "declined" : "decided"}.`,
      "conflict",
    );
  }

  await db.transaction(async (tx) => {
    await tx
      .update(orders)
      .set({
        status: "declined",
        approvedById: ctx.user.id,
        approvedAt: new Date(),
        declineReason: reason.trim(),
        updatedAt: new Date(),
      })
      .where(eq(orders.id, orderId));

    await tx.insert(auditLog).values({
      id: id("aud"),
      actorId: ctx.user.id,
      // Which hat allowed it — see `audit_log.actor_role`.
      actorRole: ctx.authorisedBy,
      action: "order.decline",
      entityType: "order",
      entityId: orderId,
      afterState: {
        customerId: order.customerId,
        reason: reason.trim(),
        amount: Number(order.totalAmount),
      } as never,
    });
  });

  // The declined order stops counting as placed, so the customer returns to
  // the calling list on their own cycle rather than staying quiet on the
  // strength of an order that was refused.
  await recomputeBuyingCycle(order.customerId);
  return okVoid("Order declined");
}

/** For the launcher tile and the header badge. */
export async function pendingOrderCount(): Promise<number> {
  const rows = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from orders o where o.status = 'pending_approval'`,
  );
  return Number(rows[0]?.n ?? 0);
}
