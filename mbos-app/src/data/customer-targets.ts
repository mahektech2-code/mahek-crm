import { all } from '../db';
import { isoDate } from '../lib/format';
import type { CustomerTargetRow } from '../engines/customer-targets';

/**
 * His customers' targets for one month, as this phone holds them.
 *
 * The office sends target, achieved and what accounts have not decided yet —
 * see `customerTargetsFor` in MahekOne. Two things are added here and only
 * here, because only the phone knows them:
 *
 * - the shop's NAME and LAST ORDER, off the customer row already on the
 *   phone, rather than sent a second time on this channel;
 * - what he took on THIS PHONE and has not sent yet. The office cannot count
 *   an order it has not received, and a shop he sold to an hour ago in a lane
 *   with no signal reading "nothing yet" is the screen being wrong about the
 *   one thing he knows for certain. Once it is sent it leaves this figure and
 *   arrives in the office's pending one on the next pull.
 *
 * Neither is ever added to `achievedPaise`: achievement is accepted orders,
 * and the screen says so.
 */
export async function listCustomerTargets(period: string): Promise<CustomerTargetRow[]> {
  const rows = await all<{
    customerId: string;
    name: string | null;
    city: string | null;
    customerName: string | null;
    customerCity: string | null;
    onPhone: number;
    lastOrderDate: string | null;
    targetPaise: number;
    achievedPaise: number;
    pendingPaise: number;
    isDefault: number;
    carriedForward: number;
    billTarget: number | null;
    billsAchieved: number | null;
  }>(
    `SELECT t.customerId, c.name, c.city, t.customerName, t.customerCity,
            (c.id IS NOT NULL) AS onPhone, c.lastOrderDate,
            t.targetPaise, t.achievedPaise, t.pendingPaise, t.isDefault, t.carriedForward,
            t.billTarget, t.billsAchieved
       FROM customer_targets t
       LEFT JOIN customers c ON c.id = t.customerId
      WHERE t.period = ?`,
    [period],
  );

  const unsent = await unsentByCustomer(period);

  return rows.map((r) => ({
    customerId: r.customerId,
    /* A shop credited to him outside the area he is allocated has a target
       and no customer row here. The office sends its name with the target,
       so it is shown by that name and marked as outside his area rather than
       as something the phone lost. "A shop" is only for a row pulled before
       the office started sending the name. */
    name: r.name ?? r.customerName ?? 'A shop',
    city: r.city ?? r.customerCity,
    onPhone: Boolean(r.onPhone),
    targetPaise: r.targetPaise ?? 0,
    achievedPaise: r.achievedPaise ?? 0,
    pendingPaise: r.pendingPaise ?? 0,
    unsentPaise: unsent.get(r.customerId) ?? 0,
    isDefault: Boolean(r.isDefault),
    carriedForward: Boolean(r.carriedForward),
    lastOrderDate: r.lastOrderDate,
    billTarget: r.billTarget && r.billTarget > 0 ? r.billTarget : null,
    billsAchieved: r.billsAchieved ?? 0,
  }));
}

/** When the office last worked these out, or null where it has sent none. */
export async function customerTargetsComputedAt(period: string): Promise<string | null> {
  const rows = await all<{ computedAt: string | null }>(
    'SELECT MAX(computedAt) AS computedAt FROM customer_targets WHERE period = ?',
    [period],
  );
  return rows[0]?.computedAt ?? null;
}

/**
 * Orders on this phone the office has not heard of, for the month, per shop.
 * A REFUSED one is not counted: it is not on its way anywhere.
 *
 * The month is read off `orderedAt` in the phone's own day, which is the day
 * the salesman means. An order whose value is not known yet adds nothing
 * rather than a guess.
 */
async function unsentByCustomer(period: string): Promise<Map<string, number>> {
  const rows = await all<{ customerId: string; orderedAt: number; netTotalPaise: number | null }>(
    `SELECT customerId, orderedAt, netTotalPaise
       FROM orders
      WHERE syncState IN ('local', 'queued')
        AND status <> 'cancelled'
        AND valueUnavailable = 0`,
  );
  const out = new Map<string, number>();
  for (const r of rows) {
    if (!r.netTotalPaise) continue;
    if (isoDate(new Date(r.orderedAt)).slice(0, 7) !== period) continue;
    out.set(r.customerId, (out.get(r.customerId) ?? 0) + r.netTotalPaise);
  }
  return out;
}
