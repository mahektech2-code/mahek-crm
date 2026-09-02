import { one } from '../db';
import { isoDate } from '../lib/format';

/**
 * His own numbers, read straight off what is already on the phone.
 *
 * Everything here is OWNED data — visits, orders, payments the salesman
 * himself wrote — so this needs no new pull channel and no signal to answer.
 * It is deliberately not the same question `performance` answers: that is
 * the office's SCORE, computed server-side against a published target; this
 * is a plain count of what actually happened, the same way the Call Log's
 * own EOD screen is a count rather than a judgement.
 */

export type MonthReport = {
  from: string;
  to: string;
  visits: number;
  ordersTaken: number;
  ordersRejected: number;
  litres: number;
  valuePaise: number | null;
  /** How many of this month's orders had NO computed value at all. */
  ordersUnvalued: number;
  collectedPaise: number;
  collectedCount: number;
};

async function monthWindow(monthsAgo: number): Promise<{ from: string; to: string }> {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 1);
  const nextFirst = new Date(now.getFullYear(), now.getMonth() - monthsAgo + 1, 1);
  return { from: isoDate(first), to: isoDate(nextFirst) };
}

/** `monthsAgo = 0` is the current month, `1` is last month, and so on. */
export async function monthReport(userId: string, monthsAgo = 0): Promise<MonthReport> {
  const { from, to } = await monthWindow(monthsAgo);
  const fromMs = Date.parse(from + 'T00:00:00');
  const toMs = Date.parse(to + 'T00:00:00');

  const visits = await one<{ n: number }>(
    'SELECT COUNT(*) AS n FROM visits WHERE userId = ? AND checkInAt >= ? AND checkInAt < ?',
    [userId, fromMs, toMs],
  );

  const orders = await one<{
    taken: number; rejected: number; litres: number; value: number; unvalued: number;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE status <> 'rejected' AND status <> 'cancelled') AS taken,
       COUNT(*) FILTER (WHERE status = 'rejected') AS rejected,
       COALESCE(SUM(netTotalPaise) FILTER (WHERE valueUnavailable = 0 AND status <> 'rejected' AND status <> 'cancelled'), 0) AS value,
       COUNT(*) FILTER (WHERE valueUnavailable = 1 AND status <> 'rejected' AND status <> 'cancelled') AS unvalued
       FROM orders WHERE userId = ? AND orderedAt >= ? AND orderedAt < ?`,
    [userId, fromMs, toMs],
  );

  /* Litres come from the lines, not the order — a line is what actually
     carries a pack size. */
  const litreRow = await one<{ litres: number }>(
    `SELECT COALESCE(SUM(ol.litres), 0) AS litres
       FROM order_lines ol JOIN orders o ON o.id = ol.orderId
      WHERE o.userId = ? AND o.orderedAt >= ? AND o.orderedAt < ?
        AND o.status <> 'rejected' AND o.status <> 'cancelled'`,
    [userId, fromMs, toMs],
  );

  const collected = await one<{ n: number; total: number }>(
    'SELECT COUNT(*) AS n, COALESCE(SUM(amountPaise), 0) AS total FROM payments WHERE userId = ? AND collectedAt >= ? AND collectedAt < ?',
    [userId, fromMs, toMs],
  );

  const taken = orders?.taken ?? 0;
  const unvalued = orders?.unvalued ?? 0;

  return {
    from,
    to,
    visits: visits?.n ?? 0,
    ordersTaken: taken,
    ordersRejected: orders?.rejected ?? 0,
    litres: Math.round((litreRow?.litres ?? 0) * 10) / 10,
    // Null the moment even one order this month has no value — a partial sum
    // presented as the month's value would be a confident wrong number.
    valuePaise: taken > 0 && unvalued > 0 ? null : (orders?.value ?? 0),
    ordersUnvalued: unvalued,
    collectedPaise: collected?.total ?? 0,
    collectedCount: collected?.n ?? 0,
  };
}
