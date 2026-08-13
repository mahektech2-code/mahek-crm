import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";

/* ---------------------------------------------------------------------------
 * How long the oldest thing in each queue has been waiting.
 *
 * Two integers, read on every navigation because the sidebar badges them. The
 * counts themselves come from each queue's own service — this answers only the
 * second question, which is whether the number should be alarming.
 * ------------------------------------------------------------------------- */

export type QueueUrgency = {
  oldestOrderHours: number;
  oldestReceiptHours: number;
};

export async function queueUrgency(): Promise<QueueUrgency> {
  const [row] = await db.execute<{ orders: number; receipts: number }>(sql`
    select
      (select coalesce(max(extract(epoch from (now() - ordered_at)) / 3600), 0)::int
         from orders where status = 'pending_approval') as orders,
      (select coalesce(max(extract(epoch from (now() - created_at)) / 3600), 0)::int
         from payment_receipts where status in ('reported','held')) as receipts
  `);
  return {
    oldestOrderHours: Number(row?.orders ?? 0),
    oldestReceiptHours: Number(row?.receipts ?? 0),
  };
}
