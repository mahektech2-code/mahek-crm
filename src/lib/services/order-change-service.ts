import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, orderChangeRequests, orders, type OrderLine } from "@/db/schema";
import { requireCapability } from "../access-control";
import { money } from "../format";
import { notifyUser } from "../notify";
import { err, okVoid, type Result } from "../result";

/* ---------------------------------------------------------------------------
 * CHANGES TO APPROVED ORDERS — the Accounts desk's half.
 *
 * A salesman edits his own order until accounts decide it (`handleOrderEdit`).
 * After that it is the office's commitment, and a change arrives here as a
 * request: what the order should become, what it was when he asked, and why.
 * Accepting rewrites the order's lines and value; declining needs a reason,
 * because the salesman has to ring the shop and say something. Both are
 * `order.approve` — the same people who approved the order decide whether it
 * may change, for the same reason: the person chasing a target must not sign
 * off the figure that hits it.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

export type OrderChangeRow = {
  id: string;
  orderId: string;
  orderNo: string | null;
  orderStatus: string;
  customerId: string;
  customerName: string;
  customerCity: string | null;
  requestedByName: string;
  note: string;
  lineItems: OrderLine[];
  previousLineItems: OrderLine[] | null;
  totalAmountPaise: number;
  previousTotalPaise: number | null;
  status: "pending" | "accepted" | "declined";
  decisionNote: string | null;
  decidedByName: string | null;
  createdAt: string;
  decidedAt: string | null;
};

export async function pendingOrderChangeCount(): Promise<number> {
  const [row] = await db.execute<{ n: string }>(
    sql`select count(*)::text as n from order_change_requests where status = 'pending'`,
  );
  return Number(row?.n ?? 0);
}

/** Everything waiting, oldest first, then the most recent decisions. */
export async function listOrderChanges(recent = 30): Promise<OrderChangeRow[]> {
  const rows = await db.execute<OrderChangeRow>(sql`
    select r.id, r.order_id as "orderId", o.order_no as "orderNo", o.status::text as "orderStatus",
           r.customer_id as "customerId", c.name as "customerName", c.city as "customerCity",
           u.name as "requestedByName", r.note,
           r.line_items as "lineItems", r.previous_line_items as "previousLineItems",
           r.total_amount_paise::bigint as "totalAmountPaise",
           r.previous_total_paise::bigint as "previousTotalPaise",
           r.status::text as status, r.decision_note as "decisionNote", d.name as "decidedByName",
           r.created_at::text as "createdAt", r.decided_at::text as "decidedAt"
      from order_change_requests r
      join orders o on o.id = r.order_id
      join customers c on c.id = r.customer_id
      join users u on u.id = r.requested_by_id
      left join users d on d.id = r.decided_by_id
     where r.status = 'pending'
        or r.id in (select id from order_change_requests where status <> 'pending'
                     order by decided_at desc nulls last limit ${recent})
     order by (r.status = 'pending') desc,
              case when r.status = 'pending' then r.created_at end asc,
              r.decided_at desc nulls last, r.id
  `);
  return rows.map((r) => ({
    ...r,
    totalAmountPaise: Number(r.totalAmountPaise),
    previousTotalPaise: r.previousTotalPaise == null ? null : Number(r.previousTotalPaise),
  }));
}

/**
 * Accept or decline one. Accepting is refused if the order has moved past
 * `confirmed` since the request was made — a dispatched order cannot be
 * rewritten by a click, and doing so silently would put a figure on the ledger
 * the lorry never carried.
 */
export async function decideOrderChange(
  requestId: string,
  decision: "accept" | "decline",
  note: string | null,
): Promise<Result> {
  const ctx = await requireCapability("order.approve");
  const reason = note?.trim() || null;
  if (decision === "decline" && !reason) {
    return err("Say why it is declined — the salesman has to tell the shop something.", "validation");
  }

  const [request] = await db.select().from(orderChangeRequests).where(eq(orderChangeRequests.id, requestId));
  if (!request) return err("That request no longer exists.", "not_found");
  if (request.status !== "pending") return err(`That request was already ${request.status}.`, "conflict");

  const [order] = await db.select().from(orders).where(eq(orders.id, request.orderId));
  if (!order) return err("The order behind that request no longer exists.", "not_found");
  if (decision === "accept" && order.status !== "confirmed") {
    return err(
      `Order ${order.orderNo ?? ""} is ${order.status.replace("_", " ")} now, so it can no longer be changed. Decline the request and say so.`,
      "conflict",
    );
  }

  let raced = false;
  let moved = false;
  await db.transaction(async (tx) => {
    const decided = await tx
      .update(orderChangeRequests)
      .set({
        status: decision === "accept" ? "accepted" : "declined",
        decidedById: ctx.user.id,
        decidedAt: new Date(),
        decisionNote: reason,
        updatedAt: new Date(),
      })
      .where(and(eq(orderChangeRequests.id, requestId), eq(orderChangeRequests.status, "pending")))
      .returning({ id: orderChangeRequests.id });
    if (!decided.length) {
      raced = true;
      return;
    }

    if (decision === "accept") {
      const changed = await tx
        .update(orders)
        .set({
          lineItems: request.lineItems,
          totalAmount: request.totalAmountPaise,
          updatedAt: new Date(),
          updatedById: ctx.user.id,
        })
        .where(and(eq(orders.id, order.id), eq(orders.status, "confirmed")))
        .returning({ id: orders.id });
      if (!changed.length) {
        moved = true;
        tx.rollback();
      }
    }

    await tx.insert(auditLog).values({
      id: id("aud"),
      actorId: ctx.user.id,
      actorRole: ctx.authorisedBy,
      actorApp: ctx.authorisedIn,
      action: decision === "accept" ? "order.change.accept" : "order.change.decline",
      entityType: "order",
      entityId: order.id,
      beforeState: { lines: request.previousLineItems, amount: request.previousTotalPaise } as never,
      afterState: {
        requestId,
        lines: request.lineItems,
        amount: request.totalAmountPaise,
        reason,
      } as never,
    });
  }).catch((e) => {
    if (!moved) throw e;
  });
  if (raced) return err("Somebody else decided that request a moment ago.", "conflict");
  if (moved) return err(`Order ${order.orderNo ?? ""} moved on while this was being decided, so it was not changed.`, "conflict");

  await notifyUser({
    userId: request.requestedById,
    kind: decision === "accept" ? "info" : "warn",
    title:
      decision === "accept"
        ? `Change accepted on ${order.orderNo ?? "your order"}`
        : `Change declined on ${order.orderNo ?? "your order"}`,
    body:
      decision === "accept"
        ? `The order now stands at ${money(request.totalAmountPaise)}.${reason ? " " + reason : ""}`
        : `Reason: ${reason}. The order stays as it was approved.`,
    href: null,
    /* The orders screen on the handset is where the request and its answer
       are drawn against the order itself. */
    mbosHref: "/orders",
  }).catch(() => {});

  return okVoid(decision === "accept" ? "Change accepted — the order is updated" : "Change declined");
}
