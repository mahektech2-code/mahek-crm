import "server-only";
import { awaitingAccountsSql } from "@/lib/order-status";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, customers, orders, users } from "@/db/schema";
import { requireCapability } from "../access-control";
import { calendarDate } from "../business-date";
import { convertIfNowQualified } from "./lead-conversion-service";
import { money } from "../format";
import { notifyUser } from "../notify";
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
 * because both change which orders count as purchases, and both tell whoever
 * took the order what was decided — a queue that receives work and answers
 * into silence is only half a workflow.
 * ------------------------------------------------------------------------- */

export type PendingOrder = {
  orderId: string;
  customerId: string;
  customerName: string;
  customerCity: string;
  contactPerson: string | null;
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
           -- A CRM order's lines hang off the call; a field order's are on the
           -- order itself. Counting only the first drew every MBOS order as
           -- "0 lines" in the queue.
           coalesce(nullif((select count(*)::int
              from interaction_product_lines l
              join calls ca on ca.id = l.interaction_id
             where ca.order_id = o.id), 0),
             case when jsonb_typeof(o.line_items) = 'array' then jsonb_array_length(o.line_items) else 0 end) as line_count,
           (select count(*)::int from bills b
             where b.customer_id = c.id
               and b.amount > b.paid_amount
               and b.due_date < current_date) as overdue_bills,
           extract(epoch from (now() - o.ordered_at)) / 3600 as waiting_hours
      from orders o
      join customers c on c.id = o.customer_id
      left join users u on u.id = o.user_id
     where ${awaitingAccountsSql("o")}
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
    union all
    -- A field order carries its lines on the order — product ids from the
    -- handset — and has no call behind it. Only read where the call has none,
    -- so an order is never drawn twice.
    select coalesce(p.name, li->>'product'), p.pack_size, f.name, (li->>'quantity')::int,
           p.millilitres_per_can, coalesce(p.cans_per_box, 1)
      from orders o
      cross join lateral jsonb_array_elements(case when jsonb_typeof(o.line_items) = 'array' then o.line_items else '[]'::jsonb end) li
      left join products p on p.id = li->>'productId'
      left join product_formulations f on f.id = p.formulation_id
     where o.id = ${orderId}
       and not exists (select 1 from interaction_product_lines l2
                         join calls c2 on c2.id = l2.interaction_id where c2.order_id = o.id)
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

/**
 * Telling the person who took the order what accounts decided.
 *
 * A DECISION NOBODY RECEIVES IS NOT A DECISION — `lib/actions/sales.ts` says
 * exactly that about MBOS approvals, and this was the one decision path that
 * never said it. The reason went onto the customer timeline and stopped
 * there, so the telecaller who had promised a customer their order found out
 * it was refused by opening that customer's record, which nobody does
 * unprompted. In practice the customer found out first, and rang to ask.
 *
 * WHO is `orders.userId` — whoever took it, never whoever owns the account
 * today. The person who has to ring back is the person who made the promise,
 * and a reassignment since does not move that. It is null on anything the
 * sheet imported, and those tell nobody: there is no author to tell.
 *
 * Accounts deciding an order they took themselves would be told what they had
 * just done, so that is skipped — the same rule as a reassignment that
 * changes nothing notifying nobody.
 *
 * A FIELD ORDER'S TAP OPENS `/orders` on the handset, and nothing else does.
 * `/rejections` would be wrong — it reads the local outbox, records refused
 * BEFORE they were stored, and an order declined here synced days ago. The
 * Orders screen is right now that the decision reaches it (`myOrders` on the
 * pull): the order is drawn there with its new status and the reason. An
 * order with no handset behind it keeps the honest default, `/notifications`.
 *
 * IT NEVER FAILS THE DECISION. The order is decided and audited before this
 * runs; the courtesy is on top of a completed write, exactly as the next-step
 * sentence is on a completed call.
 */
async function tellTheAuthor(
  order: typeof orders.$inferSelect,
  decidedBy: { id: string; name: string },
  reason: string | null,
): Promise<void> {
  const authorId = order.userId;
  if (!authorId || authorId === decidedBy.id) return;

  const [customer] = await db
    .select({ name: customers.name })
    .from(customers)
    .where(eq(customers.id, order.customerId));
  const who = customer?.name ?? "a customer";
  const value = money(Number(order.totalAmount));
  const href = `/crm/customers/${order.customerId}`;
  const mbosHref = order.source === "mbos" ? "/orders" : null;

  await notifyUser(
    reason === null
      ? {
          userId: authorId,
          title: `Your order for ${who} was approved`,
          body: `${decidedBy.name} approved it — ${value}.`,
          href,
          mbosHref,
        }
      : {
          userId: authorId,
          title: `Your order for ${who} was declined`,
          /* The ring-back sentence goes BEFORE the reason so the reason can
             end the body however it was typed. Trailing a free-text field
             with another sentence reads as one run-on the moment somebody
             leaves the full stop off. */
          body: `${decidedBy.name} declined it — ${value}. You will need to ring the customer back. Reason given: ${reason}`,
          kind: "warn",
          href,
          mbosHref,
        },
  ).catch(() => {
    /* A bell that could not be written must not undo an order decision that
       already stands in the ledger. */
  });
}

/** A TO still waiting for its two checks has no order number: Accounts decide it only after. */
async function stillATo(orderId: string): Promise<string | null> {
  const rows = (await db.execute(sql`select to_no as "toNo" from erp_order_intakes where origin_order_id = ${orderId} and status <> 'verified'`)) as unknown as { toNo: number }[];
  return rows[0] ? `It is still TO-${rows[0].toNo}: decide it in the TO list at the top of Order approvals.` : null;
}

export async function approveOrder(orderId: string): Promise<Result> {
  const ctx = await requireCapability("order.approve");

  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) return err("That order no longer exists.", "not_found");
  const asTo = await stillATo(orderId);
  if (asTo) return err(asTo, "rule_violation");
  if (order.status !== "pending_approval") {
    // Two people opened the same queue. Say which way it went rather than
    // silently overwriting somebody else's decision.
    return err(
      `That order was already ${order.status === "declined" ? "declined" : "decided"}.`,
      "conflict",
    );
  }

  const decided = await db.transaction(async (tx) => {
    /* Only from pending: two people deciding the same order at once must not
       both write, and the second must not overwrite the first's answer. */
    const moved = await tx
      .update(orders)
      .set({
        status: "confirmed",
        approvedById: ctx.user.id,
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(orders.id, orderId), eq(orders.status, "pending_approval")))
      .returning({ id: orders.id });
    if (!moved.length) return false;

    await tx.insert(auditLog).values({
      id: id("aud"),
      actorId: ctx.user.id,
      // Which hat allowed it — see `audit_log.actor_role`.
      actorRole: ctx.authorisedBy,
        actorApp: ctx.authorisedIn,
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
    return true;
  });
  if (!decided) return err("Somebody else decided that order a moment ago.", "conflict");

  // It is a purchase now, so the cycle, the average and the history all change.
  await recomputeBuyingCycle(order.customerId);
  /* An ERP order waits on this decision too: its lines learn the answer. */
  await (await import("../erp/book")).afterBookDecision(orderId);

  /*
   * And it may be the order that makes them a customer.
   *
   * A lead becomes one on its SECOND order, and what counts as an order is an
   * APPROVED one — so the save path can ask "has this account ordered before"
   * and be told no, purely because the first order was still sitting with
   * accounts. Nothing looked again when it was approved, and the shop stayed a
   * lead until a third order, on a book where the calling queue and the owner's
   * funnel both read `kind`.
   *
   * Outside the transaction above deliberately: this is a consequence of the
   * approval rather than part of it, and a failure here must not roll back a
   * decision accounts have already taken. The order is approved either way, and
   * the nightly pass would catch the promotion on the next order regardless.
   */
  try {
    await convertIfNowQualified(
      db,
      order.customerId,
      calendarDate(order.orderedAt ?? new Date()),
      ctx.user.id,
      "order_approved",
      order.id,
    );
  } catch {
    /* Reported nowhere on purpose: accounts approved an order and that is what
       the screen must say. A promotion that did not happen is visible on the
       next order and on the customer record, and telling a clerk about it here
       would be reporting somebody else's job as their failure. */
  }

  await tellTheAuthor(order, ctx.user, null);
  return okVoid("Order approved");
}

export async function declineOrder(
  orderId: string,
  reason: string,
): Promise<Result> {
  const ctx = await requireCapability("order.approve");
  const asTo = await stillATo(orderId);
  if (asTo) return err(asTo, "rule_violation");

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

  const decided = await db.transaction(async (tx) => {
    /* Only from pending: two people deciding the same order at once must not
       both write, and the second must not overwrite the first's answer. */
    const moved = await tx
      .update(orders)
      .set({
        status: "declined",
        approvedById: ctx.user.id,
        approvedAt: new Date(),
        declineReason: reason.trim(),
        updatedAt: new Date(),
      })
      .where(and(eq(orders.id, orderId), eq(orders.status, "pending_approval")))
      .returning({ id: orders.id });
    if (!moved.length) return false;

    await tx.insert(auditLog).values({
      id: id("aud"),
      actorId: ctx.user.id,
      // Which hat allowed it — see `audit_log.actor_role`.
      actorRole: ctx.authorisedBy,
        actorApp: ctx.authorisedIn,
      action: "order.decline",
      entityType: "order",
      entityId: orderId,
      afterState: {
        customerId: order.customerId,
        reason: reason.trim(),
        amount: Number(order.totalAmount),
      } as never,
    });
    return true;
  });
  if (!decided) return err("Somebody else decided that order a moment ago.", "conflict");

  // The declined order stops counting as placed, so the customer returns to
  // the calling list on their own cycle rather than staying quiet on the
  // strength of an order that was refused.
  await recomputeBuyingCycle(order.customerId);
  /* An ERP order waits on this decision too: its lines learn the answer. */
  await (await import("../erp/book")).afterBookDecision(orderId);
  await tellTheAuthor(order, ctx.user, reason.trim());
  return okVoid("Order declined");
}

/** For the launcher tile and the header badge. */
export async function pendingOrderCount(): Promise<number> {
  const rows = await db.execute<{ n: number }>(
    /* What the screen draws: the TOs waiting for Accounts and any other order
       waiting for them — `awaitingAccountsSql` leaves out the book rows that
       are still TOs, so no order is counted twice. */
    sql`select ((select count(*) from orders o where ${awaitingAccountsSql("o")}) + (select count(*) from erp_order_intakes where status = 'open'))::int as n`,
  );
  return Number(rows[0]?.n ?? 0);
}

/* =========================================================== ACCOUNTS HOLD
 * An order made through the Order Hub can be held by Accounts instead of
 * approved or declined: it leaves the queue for "Orders on hold", and
 * releasing it puts it back in the queue to be decided again. The hold itself
 * is the ERP's (`erp_order_holds`, department accounts), so To Hold lists it
 * beside every other desk's.
 * ------------------------------------------------------------------------ */

function erpOrderNo(order: { source: string; externalRef: string | null }): number | null {
  if (order.source !== "erp" || !order.externalRef?.startsWith("ERP-")) return null;
  const n = Number(order.externalRef.slice(4));
  return Number.isInteger(n) ? n : null;
}

export async function holdOrderForAccounts(orderId: string, reasonCode: string, note: string, opts: { customerText?: string | null; lookAgainOn?: string | null } = {}): Promise<Result> {
  const ctx = await requireCapability("order.approve");
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) return err("That order no longer exists.", "not_found");
  if (order.status !== "pending_approval") return err("That order was already decided.", "conflict");
  const no = erpOrderNo(order);
  if (no == null) {
    /* An order with no products never reached the Order Hub, so there is
       nothing for a hold to sit on — say that, and what to do, rather than
       naming the hub to somebody who has never seen it. */
    const empty = !order.lineItems?.length;
    if (empty) {
      const [taker] = order.userId ? await db.select({ name: users.name }).from(users).where(eq(users.id, order.userId)) : [];
      return err(
        `This order has no products, so it never reached the Order Hub and cannot be held. Decline it and ask ${taker?.name ?? "whoever took it"} to log it again with the products.`,
        "rule_violation",
      );
    }
    return err("Only an order made through the Order Hub is held here. Approve or decline this one.", "rule_violation");
  }
  if (!note.trim()) return err("Write the remark — what you are waiting for.", "validation", [{ field: "reason", message: "A remark is required." }]);
  const { holdOrder, ACCOUNTS_HOLD_REASONS } = await import("../erp/screens/order-hub");
  if (!ACCOUNTS_HOLD_REASONS.some((r) => r.code === reasonCode)) return err("Pick the reason.", "validation");
  const lookAgain = opts.lookAgainOn && /^\d{4}-\d{2}-\d{2}$/.test(opts.lookAgainOn) ? opts.lookAgainOn : null;
  const res = await holdOrder(ctx.user.id, no, "accounts", reasonCode, note.trim(), opts.customerText?.trim() || null, undefined, { nextUpdateOn: lookAgain });
  if (!res.ok) return res;
  await db.insert(auditLog).values({ id: id("aud"), actorId: ctx.user.id, actorRole: ctx.authorisedBy, actorApp: ctx.authorisedIn, action: "order.hold", entityType: "order", entityId: orderId, afterState: { reason: reasonCode, note } as never });
  if (order.userId)
    await notifyUser({ userId: order.userId, title: `Order ${no} is on hold with Accounts`, body: note.trim(), kind: "warn", general: true }).catch(() => undefined);
  /* The sales manager on the account is told too: it is their customer's order waiting. */
  const [c] = await db.select({ sm: customers.salesManagerId }).from(customers).where(eq(customers.id, order.customerId));
  if (c?.sm && c.sm !== order.userId)
    await notifyUser({ userId: c.sm, title: `Order ${no} is on hold with Accounts`, body: note.trim(), kind: "warn", general: true }).catch(() => undefined);
  return okVoid(`Order ${no} is on hold`);
}

export async function releaseOrderForAccounts(orderId: string, note: string): Promise<Result> {
  const ctx = await requireCapability("order.approve");
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) return err("That order no longer exists.", "not_found");
  const no = erpOrderNo(order);
  if (no == null) return err("That order is not held here.", "rule_violation");
  if (!note.trim()) return err("Say what changed.", "validation", [{ field: "reason", message: "Say what changed." }]);
  const { releaseOrderHold } = await import("../erp/screens/order-hub");
  const res = await releaseOrderHold(ctx.user.id, no, "accounts", note.trim());
  if (!res.ok) return res;
  await db.insert(auditLog).values({ id: id("aud"), actorId: ctx.user.id, actorRole: ctx.authorisedBy, actorApp: ctx.authorisedIn, action: "order.release", entityType: "order", entityId: orderId, afterState: { note } as never });
  return okVoid(`Order ${no} is back in the queue`);
}

export type HeldOrder = { orderId: string; orderNo: number; customerName: string; amount: number; reason: string; note: string | null; heldBy: string | null; heldAt: Date };

/** The orders Accounts hold, oldest first. */
export async function heldOrders(): Promise<HeldOrder[]> {
  const rows = (await db.execute(sql`
    select o.id as "orderId", h.order_no as "orderNo", c.name as "customerName", o.total_amount as amount, h.reason, h.internal_note as note, u.name as "heldBy", h.raised_at as "heldAt"
      from erp_order_holds h
      join orders o on o.external_ref = 'ERP-' || h.order_no and o.source = 'erp'
      join customers c on c.id = o.customer_id
      left join users u on u.id = h.raised_by_id
     where h.department = 'accounts' and h.resolved_at is null
     order by h.raised_at
  `)) as unknown as HeldOrder[];
  return rows.map((r) => ({ ...r, orderNo: Number(r.orderNo), amount: Number(r.amount), heldAt: new Date(r.heldAt) }));
}

/* ------------------------------------------------------------ the board */

/**
 * ORDER APPROVALS AS THE MOCKUP DRAWS THEM: each order waiting for Accounts
 * with its order number and TO, who took it, the party's instructions, this
 * order's value, what the party owes, how much of its credit limit this order
 * would use, what is overdue and for how long, how long it has waited, and
 * whether it is past the accounts deadline. Read from the same queue
 * (`awaitingAccountsSql`) the rest of Accounts counts.
 */
export type ApprovalBoardRow = PendingOrder & {
  orderNo: number | null;
  toNo: number | null;
  instructions: string | null;
  creditLimit: number | null;
  overdueAmount: number;
  overdueDays: number;
  pastDeadline: boolean;
  /** Only an Order Hub order can be held here; the rest are approved or declined. */
  holdable: boolean;
  salesManager: string | null;
};

export async function approvalBoard(): Promise<ApprovalBoardRow[]> {
  const base = await pendingOrders();
  if (!base.length) return [];
  const ids = base.map((b) => b.orderId);
  const list = sql.join(ids.map((x) => sql`${x}`), sql`, `);
  const extra = (await db.execute(sql`
    select o.id as "orderId", o.source, o.external_ref as "externalRef",
           (select i.to_no from erp_order_intakes i where i.origin_order_id = o.id or (o.external_ref like 'ERP-%' and i.order_no::text = substring(o.external_ref from 5)) limit 1) as "toNo",
           (select tu.name from erp_order_intakes i join users tu on tu.id = i.taken_by_id where i.origin_order_id = o.id or (o.external_ref like 'ERP-%' and i.order_no::text = substring(o.external_ref from 5)) limit 1) as taker,
           nullif(trim(coalesce(p.standing_instructions, '')), '') as instructions,
           exists (select 1 from payment_receipts r where r.customer_id = c.id and r.status in ('reported', 'held')) as "paymentReported",
           c.credit_limit_paise as "creditLimit",
           coalesce((select sum(b.amount - b.paid_amount) from bills b where b.customer_id = c.id and b.payment_position = 'stated' and b.amount > b.paid_amount and b.due_date < current_date), 0) as "overdueAmount",
           coalesce((select max(current_date - b.due_date) from bills b where b.customer_id = c.id and b.payment_position = 'stated' and b.amount > b.paid_amount and b.due_date < current_date), 0) as "overdueDays",
           exists (select 1 from accounts_sla_breaches s where s.kind = 'order' and s.record_id = o.id and s.resolved_at is null) as "pastDeadline",
           coalesce(sm.name, c.sales_manager_person_name) as "salesManager"
      from orders o
      join customers c on c.id = o.customer_id
      left join erp_customer_profiles p on p.customer_id = c.id
      left join users sm on sm.id = c.sales_manager_id
     where o.id in (${list})`)) as unknown as {
    orderId: string;
    source: string;
    externalRef: string | null;
    toNo: number | null;
    taker: string | null;
    instructions: string | null;
    paymentReported: boolean;
    creditLimit: number | null;
    overdueAmount: number;
    overdueDays: number;
    pastDeadline: boolean;
    salesManager: string | null;
  }[];
  const by = new Map(extra.map((e) => [e.orderId, e]));
  return base.map((b) => {
    const e = by.get(b.orderId);
    const orderNo = e ? erpOrderNo({ source: e.source, externalRef: e.externalRef }) : null;
    return {
      ...b,
      takenByName: e?.taker ?? b.takenByName,
      orderNo,
      toNo: e?.toNo == null ? null : Number(e.toNo),
      instructions: e?.instructions ?? (e?.paymentReported ? "Payment reported, unconfirmed" : null),
      creditLimit: e?.creditLimit == null ? null : Number(e.creditLimit),
      overdueAmount: Number(e?.overdueAmount ?? 0),
      overdueDays: Number(e?.overdueDays ?? 0),
      pastDeadline: !!e?.pastDeadline,
      holdable: orderNo != null,
      salesManager: e?.salesManager ?? null,
    };
  });
}
