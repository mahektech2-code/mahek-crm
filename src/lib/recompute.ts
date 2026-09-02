import "server-only";
import { randomUUID } from "node:crypto";
import { orderCountsSql } from "./order-status";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  bills,
  calls,
  customers,
  followUpStates,
  inactiveWatchItems,
  monthlyTargets,
  orders,
  paymentReceipts,
  payments,
  salesTargetCategories,
  salesTargets,
  sheetPartyRows,
  sheetTakenOrderRows,
  users,
  waMessages,
} from "@/db/schema";
import { getConfig } from "./config/store";
import { managerNameByEmployeeName } from "./services/org-service";
import type { Config } from "./config/registry";
import { buyingCycle } from "./engines/buying-cycle";
import {
  escalationStage,
  effectiveDueDate,
  isSlowPayer,
  type EscalationBill,
} from "./engines/escalation";
import { billCreditDaysSql } from "./bill-terms";
import { partyNameKey } from "./sheet-parse";
import { evaluateInactivity } from "./engines/inactivity";
import { resolveTarget } from "./engines/targets";
import {
  APP_TIMEZONE,
  businessDate,
  calendarDate,
  monthKey,
  addMonths,
  type BusinessDate,
} from "./business-date";
import { CANCELLED_STATUS } from "./taken-order-parse";

/* ---------------------------------------------------------------------------
 * Recompute paths for every cached derived value.
 *
 * Nothing here is a source of truth. If the queue is wrong, or a cycle looks
 * absurd, the fix is to re-run one of these — never to edit a stored row.
 * Every function is idempotent and safe to re-run.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

export async function today(): Promise<BusinessDate> {
  const config = await getConfig();
  return businessDate(new Date(), {
    timezone: config["workingDay.timezone"],
    dayBoundaryHour: config["workingDay.dayBoundaryHour"],
    workingDays: config["workingDay.workingDays"],
  });
}

/* -------------------------------------------------------------- E1 cycles */

/** Recomputed nightly for everyone, and immediately when an order arrives. */
export async function recomputeBuyingCycle(customerId: string): Promise<void> {
  const config = await getConfig();

  const rows = await db
    .select({ orderedAt: orders.orderedAt, totalAmount: orders.totalAmount })
    .from(orders)
    .where(and(eq(orders.customerId, customerId), orderCountsSql("orders")))
    .orderBy(asc(orders.orderedAt));

  await writeCycle(customerId, rows, config, await lastPlaced(customerId));
}


/**
 * When they last PLACED an order, approved or not — billed OR delivered.
 *
 * Separate from the cycle on purpose. The cycle is a fact about purchases and
 * must ignore anything accounts have not accepted; this is the signal that
 * stops the calling queue chasing somebody who ordered this morning, and it
 * would be wrong to make a telecaller ring them because approval is slow. A
 * declined order drops out of both.
 *
 * The TAKEN ORDER tab counts too, and it has to. That tab is where an order
 * lands first — typed as the customer gives it, hours or days before it is
 * dispatched, billed, or written to Order Details and projected into `orders`.
 * Two things were supposed to cover a customer between ordering and being
 * chased again: `activeInOrderSystem` holds them while any line is still open,
 * and this date keeps them quiet afterwards. The hold released on dispatch and
 * handed over to a date that knew nothing about the order, so the customer
 * went back on the list days after their material shipped — asked to order the
 * thing they had just received. GMP Technical Solutions ordered on 7 August
 * and the Call Log had them "overdue by 6 days".
 *
 * Cancelled lines are excluded. A cancelled row is the one status that
 * releases the hold on its own, precisely because the customer behind it has
 * not ordered anything — counting it here would mute exactly the person who
 * should be rung.
 *
 * Written once and rendered for both the per-customer path and the nightly
 * one, because the comment on the bulk query already says what happens when
 * they drift: a queue that changes its mind overnight. It takes the outer
 * table's alias as a string, since the two callers spell it differently and a
 * bare `id` inside a correlated subquery silently binds to the INNER table —
 * the mistake §11 has a test for.
 *
 * DELIVERY COUNTS AS CONTACT, and only as contact. A shop receiving goods on
 * its distributor's bill has been served, so chasing it to order is a call
 * that annoys somebody who is already stocked — that is what this stops. What
 * it deliberately does NOT do is make the delivery a sale: the buying cycle,
 * the average order value, EOD figures, targets, outstanding and the product
 * history are all read from `orders.customer_id` elsewhere and stay with
 * whoever was invoiced. The shop's own cycle is still built from what the shop
 * itself bought, which on a purely third-party account is nothing — so it
 * reads as a prospect, which is what it is to us.
 */
const placedDateSql = (alias: string) => sql`
  greatest(
    (select max((o.ordered_at at time zone ${APP_TIMEZONE}))::date::text
       from orders o
      where (o.customer_id = ${sql.raw(alias)}.id
             or o.delivery_customer_id = ${sql.raw(alias)}.id)
        and o.status in ('captured', 'pending_approval', 'confirmed', 'dispatched')),
    (select max(t.order_date)::text
       from sheet_taken_order_rows t
      where t.matched_customer_id = ${sql.raw(alias)}.id
        and t.status = 'present'
        and lower(coalesce(t.office_status, '')) <> ${CANCELLED_STATUS})
  )`;

async function lastPlaced(customerId: string): Promise<string | null> {
  const rows = await db.execute<{ d: string | null }>(sql`
    select ${placedDateSql("customers")} as d
    from customers
    where customers.id = ${customerId}
  `);
  return rows[0]?.d ?? null;
}

/** Shared by the single-customer and whole-book paths so they cannot drift. */
async function writeCycle(
  customerId: string,
  rows: Array<{ orderedAt: Date; totalAmount: number }>,
  config: Config,
  placedOn: string | null,
): Promise<void> {
  // In Asia/Kolkata, never UTC. These dates become the INTERVALS the cycle is
  // the median of, so an order placed at 2am read as the previous day shortens
  // one gap and lengthens its neighbour — and the cycle decides when the whole
  // book is called. The SQL beside this already names the zone; this did not.
  const dates = rows.map((r) => calendarDate(r.orderedAt));
  const cycle = buyingCycle(dates, config);
  const avg = rows.length
    ? Math.round(rows.reduce((sum, r) => sum + r.totalAmount, 0) / rows.length)
    : 0;

  await db
    .update(customers)
    .set({
      cycleDays: cycle.days,
      cycleIsDefault: cycle.isDefault,
      cycleConfidence: cycle.confidence,
      // The latest order PLACED, which may be newer than the latest approved.
      lastOrderDate: placedOn ?? dates.at(-1) ?? null,
      avgOrderValue: avg,
      updatedAt: new Date(),
    })
    .where(eq(customers.id, customerId));
}

/**
 * The nightly path. One pass over the order book rather than two queries per
 * customer — at a few thousand customers the difference is minutes.
 */
export async function recomputeAllBuyingCycles(): Promise<number> {
  const config = await getConfig();

  const all = await db
    .select({
      customerId: orders.customerId,
      orderedAt: orders.orderedAt,
      totalAmount: orders.totalAmount,
    })
    .from(orders)
    .where(orderCountsSql("orders"))
    .orderBy(asc(orders.orderedAt));

  const byCustomer = new Map<string, Array<{ orderedAt: Date; totalAmount: number }>>();
  for (const o of all) {
    const list = byCustomer.get(o.customerId);
    if (list) list.push(o);
    else byCustomer.set(o.customerId, [o]);
  }

  // Customers with no orders still need their cycle written — that is how a
  // brand-new customer gets the configured default.
  //
  // One pass for the placed dates too, rather than a query per customer, and
  // the same union `lastPlaced` takes: an order the Taken Order tab has and
  // `orders` has not yet is still an order the customer placed. Kept in step
  // with `lastPlaced` deliberately — the nightly pass and the per-customer one
  // disagreeing about when somebody last ordered is a queue that changes its
  // mind overnight.
  const placed = await db.execute<{ customer_id: string; d: string | null }>(sql`
    select c.id as customer_id, ${placedDateSql("c")} as d
      from customers c
  `);
  const placedBy = new Map(placed.map((r) => [r.customer_id, r.d]));

  const ids = await db.select({ id: customers.id }).from(customers);
  for (const { id } of ids) {
    await writeCycle(id, byCustomer.get(id) ?? [], config, placedBy.get(id) ?? null);
  }
  return ids.length;
}

/* --------------------------------------------------- outstanding and bills */

/**
 * What a bill has been paid is the sum of the allocation lines belonging to
 * CONFIRMED receipts, and nothing else.
 *
 * That single condition is what makes outstanding, aging, the slow-payer flag
 * and the collections worklist statements about money the business has seen
 * rather than money it has been told about. A reported payment writes its
 * lines immediately — so the allocation is not re-derived later from a
 * half-remembered conversation — but they weigh nothing until accounts confirm
 * the receipt, and they weigh nothing again the moment one is rejected.
 *
 * Rebuilt rather than incremented, so confirming, rejecting and re-confirming
 * all land on the same answer however many times they happen.
 */
export async function recomputeBillPaid(customerId: string): Promise<void> {
  await db.execute(sql`
    update bills b set paid_amount = coalesce((
      select sum(p.amount)
        from payments p
        join payment_receipts r on r.id = p.receipt_id
       where p.bill_id = b.id and r.status = 'confirmed'
    ), 0), updated_at = now()
     where b.customer_id = ${customerId}
  `);
}

export async function recomputeAllBillPaid(): Promise<number> {
  await db.execute(sql`
    update bills b set paid_amount = coalesce((
      select sum(p.amount)
        from payments p
        join payment_receipts r on r.id = p.receipt_id
       where p.bill_id = b.id and r.status = 'confirmed'
    ), 0), updated_at = now()
  `);
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(bills);
  return row?.n ?? 0;
}

/**
 * Outstanding is derived from bills, never typed in.
 *
 * A bill nobody has stated a payment position for contributes NOTHING, in
 * either direction. It is not debt — no person has said the money is owed, and
 * the sheet it came from records what was billed and never what was received —
 * and it is not settled either. Counting it as debt is how the whole order
 * book, nine crore of it, lands on the collections worklist on the strength of
 * an import; counting it as paid is what the sheet used to do, and is what
 * this change exists to stop. So it waits, and outstanding describes only the
 * bills somebody has actually spoken for.
 */
export async function recomputeOutstanding(customerId: string): Promise<void> {
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${bills.amount} - ${bills.paidAmount}), 0)::bigint`,
    })
    .from(bills)
    .where(
      and(eq(bills.customerId, customerId), eq(bills.paymentPosition, "stated")),
    );

  await db
    .update(customers)
    .set({ outstanding: Number(row?.total ?? 0), updatedAt: new Date() })
    .where(eq(customers.id, customerId));
}

export async function recomputeAllOutstanding(): Promise<number> {
  const result = await db.execute(sql`
    update customers c set outstanding = coalesce((
      select sum(b.amount - b.paid_amount) from bills b
       where b.customer_id = c.id and b.payment_position = 'stated'
    ), 0), updated_at = now()
  `);
  return Array.isArray(result) ? result.length : 0;
}

/** Bill status follows the amounts, so it can never disagree with them. */
export async function recomputeBillStatuses(): Promise<number> {
  await db.execute(sql`
    update bills set status = case
      when paid_amount >= amount then 'paid'::bill_status
      when paid_amount > 0 then 'partially_paid'::bill_status
      else 'unpaid'::bill_status
    end, updated_at = now()
  `);
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(bills);
  return row?.n ?? 0;
}

/* ------------------------------------------------------- E3 follow-up state */

async function escalationBillsFor(customerId: string): Promise<EscalationBill[]> {
  const rows = await db
    .select({ bill: bills, creditDays: billCreditDaysSql })
    .from(bills)
    // Only bills somebody has spoken for. A telecaller must never be sent to
    // chase money on the strength of a spreadsheet row nobody has confirmed is
    // owed — the customer is on the phone being asked for a payment that may
    // already have been made, and the call cannot be taken back.
    .where(
      and(eq(bills.customerId, customerId), eq(bills.paymentPosition, "stated")),
    );
  return rows.map(({ bill: b, creditDays }) => ({
    id: b.id,
    billNo: b.billNo,
    billDate: b.billDate,
    dueDate: b.dueDate,
    creditDays: creditDays === null ? null : Number(creditDays),
    amount: b.amount,
    paid: b.paidAmount,
    disputed: b.disputed,
  }));
}

export async function recomputeFollowUpState(customerId: string): Promise<void> {
  const config = await getConfig();
  const day = await today();

  const [existing] = await db
    .select()
    .from(followUpStates)
    .where(eq(followUpStates.customerId, customerId));

  const state = escalationStage(
    await escalationBillsFor(customerId),
    existing?.lastChannel && existing.lastFollowUpAt
      ? {
          channel: existing.lastChannel,
          /* Compared against `day` inside the engine, so it must be the same
           * kind: an attempt made at 1am belongs to the previous shift. */
          attemptedAt: businessDate(existing.lastFollowUpAt, {
            timezone: config["workingDay.timezone"],
            dayBoundaryHour: config["workingDay.dayBoundaryHour"],
            workingDays: config["workingDay.workingDays"],
          }),
        }
      : null,
    day,
    config,
    (existing?.stage as 1 | 2 | 3 | undefined) ?? null,
    (existing?.manualStageFloor as 1 | 2 | 3 | null | undefined) ?? null,
  );

  // Nothing overdue: the customer leaves the worklist entirely, and the hand-
  // raised floor goes with the row — it described a debt that no longer exists.
  if (!state) {
    if (existing) {
      await db.delete(followUpStates).where(eq(followUpStates.customerId, customerId));
    }
    return;
  }

  const stageChanged = !existing || existing.stage !== state.stage;

  await db
    .insert(followUpStates)
    .values({
      customerId,
      stage: state.stage,
      stageEnteredAt: new Date(),
      oldestOverdueBillDate: state.anchorDueDate,
      daysOverdue: state.daysOverdue,
      totalOverdue: state.totalOverdue,
      overdueBillCount: state.overdueCount,
      lastChannel: existing?.lastChannel ?? null,
      lastFollowUpAt: existing?.lastFollowUpAt ?? null,
      nextChannel: state.nextChannel,
      held: state.held,
      heldReason: state.heldReason,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: followUpStates.customerId,
      set: {
        stage: state.stage,
        // Only reset the clock when the stage actually moved.
        ...(stageChanged ? { stageEnteredAt: new Date() } : {}),
        oldestOverdueBillDate: state.anchorDueDate,
        daysOverdue: state.daysOverdue,
        totalOverdue: state.totalOverdue,
        overdueBillCount: state.overdueCount,
        nextChannel: state.nextChannel,
        held: state.held,
        heldReason: state.heldReason,
        updatedAt: new Date(),
      },
    });
}

export async function recomputeAllFollowUpStates(): Promise<number> {
  // EVERY customer, whatever their status. This pass is the only thing that
  // REMOVES a follow-up row once the debt behind it is gone, so a filter here
  // does not skip work — it freezes it. Filtering to `active` left eight
  // customers on the collections list at stage 3, claiming crores overdue
  // while owing nothing, with no recompute able to reach them again.
  //
  // Nothing is created for a customer who owes nothing, so visiting them all
  // costs a read and writes only deletions.
  const rows = await db.select({ id: customers.id }).from(customers);
  for (const r of rows) await recomputeFollowUpState(r.id);
  return rows.length;
}

/* ------------------------------------------------------------- slow payer */

export async function recomputeSlowPayers(): Promise<number> {
  const config = await getConfig();
  const day = await today();

  const rows = await db
    .select({
      customerId: bills.customerId,
      dueDate: bills.dueDate,
      billDate: bills.billDate,
      creditDays: billCreditDaysSql,
      paidAt: payments.paidAt,
    })
    .from(payments)
    .innerJoin(bills, eq(bills.id, payments.billId))
    // Confirmed money only. A customer does not earn — or escape — the
    // slow-payer flag on a payment nobody has found in the bank yet.
    .innerJoin(paymentReceipts, eq(paymentReceipts.id, payments.receiptId))
    // And only against a bill somebody has stated a position for. The flag is
    // read as "be careful with this one", so every payment behind it has to
    // have a due date that means something.
    .where(
      and(
        eq(paymentReceipts.status, "confirmed"),
        eq(bills.paymentPosition, "stated"),
      ),
    );

  const byCustomer = new Map<string, Array<{ dueDate: string; paidOn: string }>>();
  for (const r of rows) {
    // The same fallback chain the worklist uses, or a customer could be a slow
    // payer on one screen and not on another.
    const due = effectiveDueDate(
      {
        id: "",
        billNo: "",
        billDate: r.billDate,
        dueDate: r.dueDate,
        creditDays: r.creditDays === null ? null : Number(r.creditDays),
        amount: 0,
        paid: 0,
        disputed: false,
      },
      config,
    );
    (byCustomer.get(r.customerId) ?? byCustomer.set(r.customerId, []).get(r.customerId)!)
      .push({ dueDate: due, paidOn: r.paidAt });
  }

  const all = await db.select({ id: customers.id }).from(customers);
  for (const c of all) {
    const { slowPayer } = isSlowPayer(byCustomer.get(c.id) ?? [], day, config);
    await db
      .update(customers)
      .set({ slowPayer, updatedAt: new Date() })
      .where(eq(customers.id, c.id));
  }
  return all.length;
}

/* ------------------------------------------------- the order-system hold */

export type OrderSystemHolds = {
  /** How many customers are held back from order-chasing calls, in total. */
  held: number;
  /** Of those, how many this pass is the first to hold. */
  newlyHeld: number;
  /** Customers whose last open line closed, put back on their own cycle. */
  released: number;
  /**
   * Parties with an open order that no customer here answers to — so nobody
   * was held for them. Counted separately from parties with no open order,
   * which are unmatched too and cost nothing.
   */
  unmatched: number;
};

/**
 * `customers.activeInOrderSystem`, rebuilt from the Taken Order tab.
 *
 * The flag means what it has always meant — there is live activity in the
 * external order system — and the queue has suppressed on it since it existed.
 * What it has never had until now is anything setting it honestly. The
 * projection deliberately refused to (it would have flagged every customer it
 * touched, which is what `0021` had to undo), so the switch has been wired to
 * nothing.
 *
 * This is the source. A customer is held while ANY line of theirs on that tab
 * is still open — Status not `Ready`, or Entry status not `Done` — and
 * released the moment the last one closes.
 *
 * FULL RECONCILE, and that is not a detail. A pass that only ever sets the
 * flag is how a book goes quiet permanently: nothing would ever clear a hold,
 * and a customer whose order shipped in August would still be off the queue in
 * March. Every customer is written on every pass, so the flag can only ever
 * say what the sheet currently says.
 *
 * This function OWNS the column. Anything else that writes it will be undone
 * on the next sync, which is the correct behaviour for a derived value and the
 * reason it should not be written anywhere else.
 */
export async function recomputeOrderSystemHolds(): Promise<OrderSystemHolds> {
  // Never synced, or synced and the table is empty. Either way the sheet has
  // told us nothing, and "nothing" must not be read as "every order in the
  // company is dispatched" — which is what releasing the whole book on an
  // empty table would mean. `recomputeEverything()` reaches this function on
  // databases that have never seen the tab, so the guard belongs here rather
  // than only in the sync.
  const [{ rows }] = await db
    .select({ rows: sql<number>`count(*)::int` })
    .from(sheetTakenOrderRows)
    .where(eq(sheetTakenOrderRows.status, "present"));
  if (!rows) return { held: 0, newlyHeld: 0, released: 0, unmatched: 0 };

  // Every party the tab names, and whether any of their lines is still open.
  // Resolving all of them rather than only the open ones is what makes the
  // landing table traceable: a row whose customer was never worked out is a
  // row nobody can answer a question with, and the parties with no open order
  // are most of the table.
  const parties = await db
    .select({
      billingPartyName: sheetTakenOrderRows.billingPartyName,
      anyOpen: sql<boolean>`bool_or(${sheetTakenOrderRows.open})`,
    })
    .from(sheetTakenOrderRows)
    .where(
      and(
        eq(sheetTakenOrderRows.status, "present"),
        isNotNull(sheetTakenOrderRows.billingPartyName),
      ),
    )
    .groupBy(sheetTakenOrderRows.billingPartyName);

  const all = await db
    .select({
      id: customers.id,
      name: customers.name,
      externalCode: customers.externalCode,
      active: customers.activeInOrderSystem,
    })
    .from(customers);

  // Two ways to the same customer. The projection stamps `SHEET:NAME` on the
  // rows it creates, which is the exact and preferred match; a customer added
  // in the CRM by hand has no external code at all and can only be found by
  // their name. Both are folded the same way, because a stray double space in
  // a spreadsheet is not a different company.
  const byCode = new Map<string, string>();
  const byName = new Map<string, string[]>();
  for (const c of all) {
    if (c.externalCode) byCode.set(c.externalCode, c.id);
    const key = takenPartyKey(c.name);
    byName.set(key, [...(byName.get(key) ?? []), c.id]);
  }

  const hold = new Set<string>();
  const matchedNames = new Map<string, string>();
  const unresolved: string[] = [];
  let unmatchedOpen = 0;

  for (const party of parties) {
    const name = party.billingPartyName!;
    const key = takenPartyKey(name);
    const viaCode = byCode.get(`SHEET:${key}`);
    const candidates = viaCode ? [viaCode] : byName.get(key) ?? [];

    // One candidate resolves. None cannot. Two is left for a person rather
    // than guessed at: picking one would mute a customer who has not ordered,
    // and the cost of the other direction is a call that turns out early.
    if (candidates.length === 1) {
      matchedNames.set(name, candidates[0]);
      if (party.anyOpen) hold.add(candidates[0]);
    } else {
      unresolved.push(name);
      if (party.anyOpen) unmatchedOpen++;
    }
  }

  const ids = [...hold];
  const wasActive = new Set(all.filter((c) => c.active).map((c) => c.id));

  // Only the differences are written. Every customer is CONSIDERED on every
  // pass — that is what makes this a reconcile — but a book where nothing
  // changed costs no writes at all.
  const toHold = ids.filter((id) => !wasActive.has(id));
  if (toHold.length) {
    await db
      .update(customers)
      .set({ activeInOrderSystem: true, updatedAt: new Date() })
      .where(inArray(customers.id, toHold));
  }

  const toRelease = [...wasActive].filter((id) => !hold.has(id));
  if (toRelease.length) {
    await db
      .update(customers)
      .set({ activeInOrderSystem: false, updatedAt: new Date() })
      .where(inArray(customers.id, toRelease));
  }

  await linkTakenOrderRows(matchedNames, unresolved);

  return {
    held: ids.length,
    newlyHeld: toHold.length,
    released: toRelease.length,
    unmatched: unmatchedOpen,
  };
}

/** The same folding the projection's `partyKey` applies, minus its prefix. */
const takenPartyKey = (name: string) => name.trim().replace(/\s+/g, " ").toUpperCase();

/**
 * Write the resolution back onto the staged rows.
 *
 * Not needed to hold anybody — the hold is computed from names above — but a
 * landing table whose rows cannot be traced to a customer is one nobody can
 * answer a question with. It also puts the unmatched parties somewhere a
 * person can list them, rather than only in a count at the end of a sync.
 */
async function linkTakenOrderRows(
  matched: Map<string, string>,
  unresolved: string[],
): Promise<void> {
  const namesByCustomer = new Map<string, string[]>();
  for (const [name, customerId] of matched) {
    namesByCustomer.set(customerId, [...(namesByCustomer.get(customerId) ?? []), name]);
  }

  for (const [customerId, names] of namesByCustomer) {
    await db
      .update(sheetTakenOrderRows)
      .set({ matchedCustomerId: customerId, customerMatchStatus: "matched" })
      .where(inArray(sheetTakenOrderRows.billingPartyName, names));
  }

  if (unresolved.length) {
    await db
      .update(sheetTakenOrderRows)
      .set({ matchedCustomerId: null, customerMatchStatus: "unmatched" })
      .where(inArray(sheetTakenOrderRows.billingPartyName, unresolved));
  }
}

/* --------------------------------------------------------- E4 inactivity */

export async function recomputeInactivity(): Promise<number> {
  const config = await getConfig();
  const day = await today();

  const rows = await db.select().from(customers);
  let flagged = 0;

  for (const c of rows) {
    const result = evaluateInactivity(
      {
        status: c.status,
        lastOrderDate: c.lastOrderDate,
        cycleDays: c.cycleDays,
        cycleIsDefault: c.cycleIsDefault,
        avgOrderValue: c.avgOrderValue,
      },
      day,
      config,
    );

    const [existing] = await db
      .select()
      .from(inactiveWatchItems)
      .where(eq(inactiveWatchItems.customerId, c.id));

    if (result.inactive) {
      flagged++;
      if (existing) {
        await db
          .update(inactiveWatchItems)
          .set({
            cyclesElapsed: String(result.cyclesElapsed),
            daysSinceLastOrder: result.daysSinceLastOrder ?? 0,
            valueAtRisk: result.valueAtRisk,
          })
          .where(eq(inactiveWatchItems.customerId, c.id));
      } else {
        await db.insert(inactiveWatchItems).values({
          customerId: c.id,
          cyclesElapsed: String(result.cyclesElapsed),
          daysSinceLastOrder: result.daysSinceLastOrder ?? 0,
          valueAtRisk: result.valueAtRisk,
        });
      }
      // The status is the flag, not a second opinion on it: crossing twice the
      // cycle marks the customer inactive without anybody typing it.
      if (c.status === "active") {
        await db
          .update(customers)
          .set({ status: "inactive", updatedAt: new Date() })
          .where(eq(customers.id, c.id));
      }
    } else {
      if (existing) {
        // An incoming order clears the flag automatically, with no manual action.
        await db
          .delete(inactiveWatchItems)
          .where(eq(inactiveWatchItems.customerId, c.id));
      }
      // …and puts the customer back to active. Only "inactive" is reversed:
      // deactivation was a decision somebody made, and an order does not undo
      // it. A telecaller who wants them back asks for that separately.
      if (c.status === "inactive") {
        await db
          .update(customers)
          .set({ status: "active", updatedAt: new Date() })
          .where(eq(customers.id, c.id));
      }
    }
  }

  return flagged;
}

/* ------------------------------------------------------- last contact date */

/**
 * Last contact is any call, or a WhatsApp message that reached a terminal sent
 * state. A copied-but-unconfirmed message is deliberately excluded.
 */
export async function recomputeLastContact(customerId: string): Promise<void> {
  const [lastCall] = await db
    .select({ at: sql<string | null>`max(${calls.startedAt} at time zone 'Asia/Kolkata')::date` })
    .from(calls)
    .where(eq(calls.customerId, customerId));

  const [lastWa] = await db
    .select({ at: sql<string | null>`max(${waMessages.confirmedSentAt} at time zone 'Asia/Kolkata')::date` })
    .from(waMessages)
    .where(
      and(
        eq(waMessages.customerId, customerId),
        inArray(waMessages.status, ["sent_manually", "sent", "delivered", "read"]),
      ),
    );

  const dates = [lastCall?.at, lastWa?.at].filter(Boolean) as string[];
  const latest = dates.sort().at(-1) ?? null;

  await db
    .update(customers)
    .set({ lastContactDate: latest, updatedAt: new Date() })
    .where(eq(customers.id, customerId));
}

/* ------------------------------------------------------- E5 target seeding */

/**
 * On the first of the month, a customer's target starts as last month's —
 * IF a manager actually set one. A default is this month's guess at what
 * somebody will buy, computed fresh below from trailing sales; carrying a
 * guess forward as though it were a decision is how a customer ends up with
 * a target nobody actually asked for. Only a target set BY HAND carries, the
 * same rule `copyForwardSalesTargets` applies to a person's own target —
 * and only where nothing has been asked for `period` yet, so a target
 * already typed or already carried this month is left alone.
 */
export async function seedMonthlyTargets(forMonth?: string): Promise<number> {
  const config = await getConfig();
  const day = await today();
  const period = forMonth ?? monthKey(day);
  const [year, month] = period.split("-").map(Number);
  const [prevYear, prevMonth] = addMonths(period, -1).split("-").map(Number);

  const active = await db
    .select()
    .from(customers)
    .where(eq(customers.status, "active"));

  const existing = await db
    .select({ customerId: monthlyTargets.customerId })
    .from(monthlyTargets)
    .where(and(eq(monthlyTargets.year, year), eq(monthlyTargets.month, month)));
  const have = new Set(existing.map((e) => e.customerId));

  const priorManual = await db
    .select({ customerId: monthlyTargets.customerId, targetAmount: monthlyTargets.targetAmount })
    .from(monthlyTargets)
    .where(
      and(
        eq(monthlyTargets.year, prevYear),
        eq(monthlyTargets.month, prevMonth),
        eq(monthlyTargets.isDefault, false),
      ),
    );
  const carryFrom = new Map(priorManual.map((r) => [r.customerId, r.targetAmount]));

  let created = 0;
  for (const c of active) {
    if (have.has(c.id)) continue;

    const carried = carryFrom.get(c.id);
    if (carried !== undefined) {
      await db.insert(monthlyTargets).values({
        id: id("tgt"),
        customerId: c.id,
        year,
        month,
        targetAmount: carried,
        isDefault: false,
        carriedForward: true,
      });
      created++;
      continue;
    }

    const trailing: number[] = [];
    for (let i = 1; i <= config["targets.trailingMonths"]; i++) {
      const key = addMonths(period, -i);
      const [y, m] = key.split("-").map(Number);
      const [row] = await db
        .select({ total: sql<number>`coalesce(sum(${orders.totalAmount}),0)::bigint` })
        .from(orders)
        .where(
          and(
            eq(orders.customerId, c.id),
            sql`extract(year from ${orders.orderedAt}) = ${y}`,
            sql`extract(month from ${orders.orderedAt}) = ${m}`,
            orderCountsSql("orders"),
          ),
        );
      trailing.push(Number(row?.total ?? 0));
    }

    const resolved = resolveTarget(
      {
        manualAmount: null,
        trailingAchievement: trailing,
        customerSince: c.customerSince,
        month: `${period}-01`,
      },
      config,
    );

    await db.insert(monthlyTargets).values({
      id: id("tgt"),
      customerId: c.id,
      year,
      month,
      targetAmount: resolved.amount,
      isDefault: true,
    });
    created++;
  }

  return created;
}

/**
 * On the first of the month, a person's target starts as last month's.
 *
 * §21 of the brief leaves the DECISION with a manager; it does not ask them to
 * retype the same five figures for nine people every month. Where somebody's
 * target for the new period does not exist at all yet — a draft in progress
 * or a real figure already saved for `period` is left exactly alone, because
 * "not changed manually" means precisely that — the row is copied from their
 * PUBLISHED target for the month before, bands included, and published again
 * immediately: nothing about the commitment has moved, so there is nothing to
 * hold back from them. A target that was only ever a draft is not copied,
 * because a draft was never told to anybody and there is no commitment to
 * continue. `carriedForward` marks the copy so the screen can say "still last
 * month's number" rather than presenting it as something chosen this month —
 * and the moment a manager saves a real change, `saveSalesTarget` clears it.
 *
 * Harmless to call on any day: it only ever creates a row where `period` has
 * none, so a hand-triggered re-run at noon touches nothing already there.
 */
export async function copyForwardSalesTargets(forMonth?: string): Promise<number> {
  const day = await today();
  const period = forMonth ?? monthKey(day);
  const previous = addMonths(period, -1);

  const already = await db
    .select({ userId: salesTargets.userId })
    .from(salesTargets)
    .where(eq(salesTargets.period, period));
  const have = new Set(already.map((r) => r.userId));

  const priorTargets = await db
    .select()
    .from(salesTargets)
    .where(and(eq(salesTargets.period, previous), eq(salesTargets.status, "published")));

  let created = 0;
  for (const prior of priorTargets) {
    if (have.has(prior.userId)) continue;

    const targetId = id("stg");
    await db.insert(salesTargets).values({
      id: targetId,
      userId: prior.userId,
      period,
      revenueTargetPaise: prior.revenueTargetPaise,
      volumeTargetMl: prior.volumeTargetMl,
      newCustomerTarget: prior.newCustomerTarget,
      collectionTargetBp: prior.collectionTargetBp,
      activityTarget: prior.activityTarget,
      notes: prior.notes,
      status: "published",
      publishedAt: new Date(),
      carriedForward: true,
    });

    const bands = await db
      .select()
      .from(salesTargetCategories)
      .where(eq(salesTargetCategories.targetId, prior.id));
    for (const band of bands) {
      await db.insert(salesTargetCategories).values({
        id: id("stc"),
        targetId,
        categoryId: band.categoryId,
        minimumBp: band.minimumBp,
        targetBp: band.targetBp,
        stretchBp: band.stretchBp,
      });
    }
    created++;
  }

  return created;
}

/* ------------------------------------------------------------ salespeople */

/**
 * Who sells to each customer, mirrored from the customer master.
 *
 * The Sales Party tab's `Sales Person` is the answer to "who is the account
 * manager for sales", and it is a NAME rather than an account: Heena Pritesh
 * Doshi, Rahul, and entries that are not people at all — "Western Line Sale",
 * "Company Own", "JAIPUR". `salesAmId` can only hold a `users` row, so every
 * screen fell through to the owner and showed a telecaller as the salesperson
 * for all 557 customers.
 *
 * This reads what is already stored rather than the sheet, so it is the
 * command to run when the READING changed and not the row — the same reason
 * `taken-order-reparse` exists. It rewrites every customer on every pass,
 * including back to null: a salesperson removed from the master must not go
 * on being displayed by a cache nobody clears.
 */
export async function recomputeSalesPeople(): Promise<number> {
  const parties = await db
    .select({
      partyName: sheetPartyRows.partyName,
      salesPersonName: sheetPartyRows.salesPersonName,
    })
    .from(sheetPartyRows)
    .where(eq(sheetPartyRows.status, "present"));

  // Nothing synced yet is not the same as nobody having a salesperson. A pass
  // over an empty tab would blank the column for the whole book.
  if (!parties.length) return 0;

  const byKey = new Map(
    parties.map((p) => [partyNameKey(p.partyName), p.salesPersonName]),
  );

  const rows = await db
    .select({
      id: customers.id,
      name: customers.name,
      salesPersonName: customers.salesPersonName,
      amDecidedAt: customers.amDecidedAt,
    })
    .from(customers);

  let changed = 0;
  for (const c of rows) {
    /*
     * An account somebody has reassigned in the app is off limits, name
     * included.
     *
     * This is the quiet half of the guard and the half that would have been
     * missed. Holding `sales_am_id` while letting this rewrite
     * `sales_person_name` produces the worst outcome available: the account
     * moves to the new manager for scope, the queue, collections and every
     * scoped list — and the screens go on displaying the OLD name, because
     * they read the sheet's name first and the linked account only where it
     * is silent. Nobody reports that as a bug. They report that the
     * reassignment did not work, and they are half right in a way that takes
     * a day to unpick.
     */
    if (c.amDecidedAt) continue;
    const next = byKey.get(partyNameKey(c.name)) ?? null;
    if (next === c.salesPersonName) continue;
    await db
      .update(customers)
      .set({ salesPersonName: next })
      .where(eq(customers.id, c.id));
    changed++;
  }
  return changed;
}

/**
 * The third seat, kept in step with the org chart — every customer whose
 * sales manager NOBODY HAS DECIDED, which is `recomputeSalesPeople`'s own
 * rule read for a different column: this rewrites every undecided customer
 * on every pass, including back to null, because a salesperson removed from
 * the org chart must not go on being displayed by a cache nobody clears.
 *
 * A LEAD is resolved through its OWNER, a customer through its salesperson —
 * `salesPersonName` first, the linked account second, the same fallback
 * `SALES_AM_NAME_SQL` already uses. Both are matched to the org chart by
 * NAME, through `managerNameByEmployeeName()`, because nothing links a
 * `users` account back to the employee record it may have come from.
 *
 * `sales_manager_decided_at` is what makes this safe to run nightly: a
 * customer a person has ever set this on is skipped entirely, so their own
 * pick survives every future org-chart change the same way a reassignment
 * survives the sheet sync.
 */
export async function recomputeSalesManagers(): Promise<number> {
  const managerNameOf = await managerNameByEmployeeName();

  // Nothing on the org chart yet is not the same as nobody having a sales
  // manager. A pass with an empty map would blank every undecided customer's
  // seat rather than leave it as it was.
  if (!managerNameOf.size) return 0;

  const [rows, activeUsers] = await Promise.all([
    db
      .select({
        id: customers.id,
        kind: customers.kind,
        salesPersonName: customers.salesPersonName,
        salesAmId: customers.salesAmId,
        ownerId: customers.ownerId,
        salesManagerId: customers.salesManagerId,
        salesManagerPersonName: customers.salesManagerPersonName,
      })
      .from(customers)
      .where(isNull(customers.salesManagerDecidedAt)),
    db.select({ id: users.id, name: users.name }).from(users).where(eq(users.active, true)),
  ]);

  if (!rows.length) return 0;

  const userNameById = new Map(activeUsers.map((u) => [u.id, u.name]));
  const userIdByName = new Map(activeUsers.map((u) => [u.name.trim().toLowerCase(), u.id]));

  let changed = 0;
  for (const c of rows) {
    const assignedName =
      c.kind === "lead"
        ? (c.ownerId ? (userNameById.get(c.ownerId) ?? null) : null)
        : (c.salesPersonName ?? (c.salesAmId ? (userNameById.get(c.salesAmId) ?? null) : null));

    const managerName = assignedName
      ? (managerNameOf.get(assignedName.trim().toLowerCase()) ?? null)
      : null;

    const nextId = managerName ? (userIdByName.get(managerName.trim().toLowerCase()) ?? null) : null;
    const nextName = managerName && !nextId ? managerName : null;

    if (nextId === c.salesManagerId && nextName === c.salesManagerPersonName) continue;

    await db
      .update(customers)
      .set({ salesManagerId: nextId, salesManagerPersonName: nextName })
      .where(eq(customers.id, c.id));
    changed++;
  }
  return changed;
}

/* ----------------------------------------------------------- full rebuild */

/** Everything, in dependency order. Used after a migration or a config change. */
export async function recomputeEverything(): Promise<Record<string, number>> {
  const cycles = await recomputeAllBuyingCycles();
  // Paid amounts before statuses, and statuses before outstanding: each reads
  // what the one before it wrote.
  await recomputeAllBillPaid();
  await recomputeBillStatuses();
  const outstanding = await recomputeAllOutstanding();
  const slowPayers = await recomputeSlowPayers();
  const followUps = await recomputeAllFollowUpStates();
  const inactive = await recomputeInactivity();
  const targets = await seedMonthlyTargets();
  // From what the Taken Order tab last said. A no-op until that tab has been
  // synced at least once — see the guard at the top of it.
  const { held } = await recomputeOrderSystemHolds();
  // From what the Sales Party tab last said, for the same reason.
  const salesPeople = await recomputeSalesPeople();

  const all = await db.select({ id: customers.id }).from(customers);
  for (const c of all) await recomputeLastContact(c.id);

  return {
    cycles,
    outstanding,
    slowPayers,
    followUps,
    inactive,
    targets,
    held,
    salesPeople,
  };
}

export { isNotNull };
