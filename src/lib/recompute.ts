import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  bills,
  calls,
  customers,
  followUpStates,
  inactiveWatchItems,
  monthlyTargets,
  orders,
  payments,
  waMessages,
} from "@/db/schema";
import { getConfig } from "./config/store";
import type { Config } from "./config/registry";
import { buyingCycle } from "./engines/buying-cycle";
import { escalationStage, isSlowPayer, type EscalationBill } from "./engines/escalation";
import { evaluateInactivity } from "./engines/inactivity";
import { resolveTarget } from "./engines/targets";
import { businessDate, monthKey, addMonths, type BusinessDate } from "./business-date";

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
    .where(and(eq(orders.customerId, customerId), sql`${orders.status} <> 'cancelled'`))
    .orderBy(asc(orders.orderedAt));

  await writeCycle(customerId, rows, config);
}

/** Shared by the single-customer and whole-book paths so they cannot drift. */
async function writeCycle(
  customerId: string,
  rows: Array<{ orderedAt: Date; totalAmount: number }>,
  config: Config,
): Promise<void> {
  const dates = rows.map((r) => r.orderedAt.toISOString().slice(0, 10));
  const cycle = buyingCycle(dates, config);
  const avg = rows.length
    ? Math.round(rows.reduce((sum, r) => sum + r.totalAmount, 0) / rows.length)
    : 0;

  await db
    .update(customers)
    .set({
      cycleDays: cycle.days,
      cycleIsDefault: cycle.isDefault,
      lastOrderDate: dates.at(-1) ?? null,
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
    .where(sql`${orders.status} <> 'cancelled'`)
    .orderBy(asc(orders.orderedAt));

  const byCustomer = new Map<string, Array<{ orderedAt: Date; totalAmount: number }>>();
  for (const o of all) {
    const list = byCustomer.get(o.customerId);
    if (list) list.push(o);
    else byCustomer.set(o.customerId, [o]);
  }

  // Customers with no orders still need their cycle written — that is how a
  // brand-new customer gets the configured default.
  const ids = await db.select({ id: customers.id }).from(customers);
  for (const { id } of ids) await writeCycle(id, byCustomer.get(id) ?? [], config);
  return ids.length;
}

/* --------------------------------------------------- outstanding and bills */

/** Outstanding is derived from bills, never typed in. */
export async function recomputeOutstanding(customerId: string): Promise<void> {
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${bills.amount} - ${bills.paidAmount}), 0)::bigint`,
    })
    .from(bills)
    .where(eq(bills.customerId, customerId));

  await db
    .update(customers)
    .set({ outstanding: Number(row?.total ?? 0), updatedAt: new Date() })
    .where(eq(customers.id, customerId));
}

export async function recomputeAllOutstanding(): Promise<number> {
  const result = await db.execute(sql`
    update customers c set outstanding = coalesce((
      select sum(b.amount - b.paid_amount) from bills b where b.customer_id = c.id
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
  const rows = await db.select().from(bills).where(eq(bills.customerId, customerId));
  return rows.map((b) => ({
    id: b.id,
    billNo: b.billNo,
    billDate: b.billDate,
    dueDate: b.dueDate,
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
          attemptedAt: existing.lastFollowUpAt.toISOString().slice(0, 10),
        }
      : null,
    day,
    config,
    (existing?.stage as 1 | 2 | 3 | undefined) ?? null,
  );

  // Nothing overdue: the customer leaves the worklist entirely.
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
  const rows = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.status, "active"));
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
      paidAt: payments.paidAt,
    })
    .from(payments)
    .innerJoin(bills, eq(bills.id, payments.billId));

  const byCustomer = new Map<string, Array<{ dueDate: string; paidOn: string }>>();
  for (const r of rows) {
    const due =
      r.dueDate ??
      new Date(
        new Date(r.billDate).getTime() +
          config["bills.defaultCreditDays"] * 86_400_000,
      )
        .toISOString()
        .slice(0, 10);
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
    } else if (existing) {
      // An incoming order clears the flag automatically, with no manual action.
      await db.delete(inactiveWatchItems).where(eq(inactiveWatchItems.customerId, c.id));
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
    .select({ at: sql<string | null>`max(${calls.startedAt})::date` })
    .from(calls)
    .where(eq(calls.customerId, customerId));

  const [lastWa] = await db
    .select({ at: sql<string | null>`max(${waMessages.confirmedSentAt})::date` })
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

/** On the first of the month, seed a default target for anyone without one. */
export async function seedMonthlyTargets(forMonth?: string): Promise<number> {
  const config = await getConfig();
  const day = await today();
  const period = forMonth ?? monthKey(day);
  const [year, month] = period.split("-").map(Number);

  const active = await db
    .select()
    .from(customers)
    .where(eq(customers.status, "active"));

  const existing = await db
    .select({ customerId: monthlyTargets.customerId })
    .from(monthlyTargets)
    .where(and(eq(monthlyTargets.year, year), eq(monthlyTargets.month, month)));
  const have = new Set(existing.map((e) => e.customerId));

  let created = 0;
  for (const c of active) {
    if (have.has(c.id)) continue;

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
            sql`${orders.status} <> 'cancelled'`,
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

/* ----------------------------------------------------------- full rebuild */

/** Everything, in dependency order. Used after a migration or a config change. */
export async function recomputeEverything(): Promise<Record<string, number>> {
  const cycles = await recomputeAllBuyingCycles();
  await recomputeBillStatuses();
  const outstanding = await recomputeAllOutstanding();
  const slowPayers = await recomputeSlowPayers();
  const followUps = await recomputeAllFollowUpStates();
  const inactive = await recomputeInactivity();
  const targets = await seedMonthlyTargets();

  const all = await db.select({ id: customers.id }).from(customers);
  for (const c of all) await recomputeLastContact(c.id);

  return { cycles, outstanding, slowPayers, followUps, inactive, targets };
}

export { isNotNull };
