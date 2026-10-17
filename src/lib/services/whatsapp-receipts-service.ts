import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { asDate } from "../business-date";
import { watiHistoryPage } from "../wati";
import { advancedStatus } from "../whatsapp-delivery";
import { matchReceipts, watiWaId } from "../wati-receipts";
import { announceWa } from "../wa-live";

/* ---------------------------------------------------------------------------
 * Bring delivered and read up to date from Wati's history — see
 * `lib/wati-receipts.ts` for why this exists beside the webhook.
 *
 * Only messages still short of READ, sent through the API in the last few
 * days, are looked at, grouped by number so each number costs one call. A
 * timestamp is written as the moment we LEARNED of the tick: Wati's history
 * says that a message was delivered, not when, and inventing a time would be
 * worse than saying when we found out.
 * ------------------------------------------------------------------------- */

type Pending = {
  id: string;
  customer_id: string;
  resolved_destination: string;
  provider_ref: string | null;
  sent_at: unknown;
  body: string;
  status: string;
};

/** A chat opened over and over must not mean a Wati call every time. */
const RECENTLY_CHECKED_MS = 20_000;
const lastChecked = new Map<string, number>();

export async function refreshReceipts(opts: {
  customerId?: string;
  days?: number;
  /** Most numbers to ask Wati about in one pass. */
  maxNumbers?: number;
}): Promise<{ numbers: number; updated: number; errors: number }> {
  const days = opts.days ?? 7;
  const rows = await db.execute<Pending>(sql`
    select m.id, m.customer_id, m.resolved_destination, m.provider_ref,
           coalesce(m.sent_at, m.prepared_at) as sent_at, m.body, m.status::text as status
      from wa_messages m
     where m.status::text in ('queued', 'sent', 'delivered')
       and m.dest_kind = 'personal'
       and coalesce(m.sent_at, m.prepared_at) > now() - make_interval(days => ${days}::int)
       ${opts.customerId ? sql`and m.customer_id = ${opts.customerId}` : sql``}
     order by coalesce(m.sent_at, m.prepared_at) desc
  `);

  const byNumber = new Map<string, Pending[]>();
  for (const r of rows) {
    const waId = watiWaId(r.resolved_destination ?? "");
    if (!waId) continue;
    byNumber.set(waId, [...(byNumber.get(waId) ?? []), r]);
  }

  const numbers = [...byNumber.keys()].slice(0, opts.maxNumbers ?? 300);
  let updated = 0;
  let errors = 0;
  const touched = new Set<string>();

  // A few at a time: an hourly pass over a week of sends is a few hundred
  // numbers, and one at a time would spend minutes waiting on the network.
  const queue = [...numbers];
  const worker = async () => {
    for (let waId = queue.shift(); waId; waId = queue.shift()) {
      const page = await watiHistoryPage(waId, 1, 100);
      if (!page.ok) {
        errors++;
        continue;
      }
      const ours = byNumber.get(waId)!;
      const matched = matchReceipts(
        ours.map((m) => ({ id: m.id, providerRef: m.provider_ref, sentAt: asDate(m.sent_at) ?? new Date(0), body: m.body })),
        page.items,
      );
      for (const { messageId, status } of matched) {
        const row = ours.find((m) => m.id === messageId)!;
        const next = advancedStatus(row.status, status);
        if (!next) continue;
        const now = new Date().toISOString();
        await db.execute(sql`
          update wa_messages
             set status = ${next}::message_status,
                 sent_at = coalesce(sent_at, ${now}::timestamptz),
                 delivered_at = case when ${next} in ('delivered', 'read') then coalesce(delivered_at, ${now}::timestamptz) else delivered_at end,
                 read_at = case when ${next} = 'read' then coalesce(read_at, ${now}::timestamptz) else read_at end,
                 updated_at = ${now}::timestamptz
           where id = ${messageId} and status::text = ${row.status}
        `);
        updated++;
        touched.add(row.customer_id);
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));

  // Only when something moved — the open chat reloads on this, and a reload
  // asks again, so announcing "nothing changed" would never stop.
  for (const customerId of touched) await announceWa({ customerId, number: null });
  return { numbers: numbers.length, updated, errors };
}

/** For the chat that was just opened: its customer's ticks, at most every 20 seconds. */
export async function refreshReceiptsForThread(key: string): Promise<void> {
  if (!key || key.startsWith("n:")) return;
  const last = lastChecked.get(key) ?? 0;
  if (Date.now() - last < RECENTLY_CHECKED_MS) return;
  lastChecked.set(key, Date.now());
  if (lastChecked.size > 5_000) lastChecked.clear();
  try {
    await refreshReceipts({ customerId: key, days: 30, maxNumbers: 3 });
  } catch (e) {
    console.error("[wati receipts] refresh for a chat failed", e instanceof Error ? e.message : e);
  }
}
