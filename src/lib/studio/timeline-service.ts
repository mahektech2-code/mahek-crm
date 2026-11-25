import "server-only";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { studioActivities, users, type StudioPoster } from "@/db/schema";
import { scopedToUsers } from "@/lib/access-control";
import { APP_TIMEZONE } from "@/lib/business-date";
import { cleanFilter, statusOf, TIMELINE_PAGE, type ActivityAction, type ActivityChannel, type ActivityKind, type ActivityMode, type ProviderState, type TimelineFilter } from "./domain/timeline";

/* ---------------------------------------------------------------------------
 * THE STUDIO TIMELINE — writes and reads.
 *
 * WRITES are one row per recipient per act, appended and never changed, and they can never fail the act they record:
 * a row that cannot be written is logged and the send, the mark or the download carries on.
 *
 * READS are scoped HERE, in SQL, and are the only way a row leaves the server:
 *   - a row about a lead or customer that still exists is visible to whoever the CRM lets see that record
 *     (`scopedToUsers`, the same rule every list uses);
 *   - a row whose record is gone (or never had one — an unmatched number) is visible to its sender and to whoever's
 *     reach takes in the sender; the whole-book reader sees every row.
 * Nothing about a recipient is read from the CRM for display: the name on the row is the snapshot taken at the time.
 * ------------------------------------------------------------------------- */

export type ActivityInput = {
  kind: ActivityKind;
  contentName: string;
  contentRefType?: "poster" | "forward" | "message" | "batch" | null;
  contentRefId?: string | null;
  caption?: string | null;
  senderId: string;
  customerId: string | null;
  recipientName: string;
  mode: ActivityMode;
  channel: ActivityChannel;
  action: ActivityAction;
  reason?: string | null;
  waMessageId?: string | null;
  batchRef?: string | null;
  occurredAt?: Date;
};

export async function recordActivity(input: ActivityInput): Promise<void> {
  try {
    const [sender] = await db.select({ name: users.name }).from(users).where(eq(users.id, input.senderId)).limit(1);
    await db.insert(studioActivities).values({
      id: `act_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      occurredAt: input.occurredAt ?? new Date(),
      kind: input.kind,
      contentName: input.contentName.slice(0, 200) || "Untitled",
      contentRefType: input.contentRefType ?? null,
      contentRefId: input.contentRefId ?? null,
      caption: input.caption ? input.caption.slice(0, 1024) : null,
      senderId: input.senderId,
      senderName: sender?.name ?? "Unknown",
      customerId: input.customerId,
      recipientName: input.recipientName.slice(0, 200) || "Unknown",
      mode: input.mode,
      channel: input.channel,
      action: input.action,
      reason: input.reason ? input.reason.slice(0, 500) : null,
      waMessageId: input.waMessageId ?? null,
      batchRef: input.batchRef ?? null,
    });
  } catch (e) {
    console.error("[studio] timeline row not written:", e instanceof Error ? e.message : e);
  }
}

export type TimelineRow = {
  id: string;
  at: Date;
  kind: ActivityKind;
  contentName: string;
  caption: string | null;
  senderName: string;
  recipientName: string;
  customerId: string | null;
  mode: ActivityMode;
  channel: ActivityChannel;
  action: ActivityAction;
  reason: string | null;
  batchRef: string | null;
  provider: ProviderState | null;
  providerError: string | null;
  status: { label: string; tone: string; confirmedByProvider: boolean };
};

/** `scopeIds` is the viewer's `scope.userIds`: null is the whole book. There is no unscoped read. */
export async function timelineRows(scopeIds: string[] | null, raw: TimelineFilter | Record<string, string | undefined> = {}): Promise<{ rows: TimelineRow[]; total: number; page: number; pageCount: number; filter: TimelineFilter }> {
  const f = "page" in raw && typeof (raw as TimelineFilter).page === "number" ? (raw as TimelineFilter) : cleanFilter(raw as Record<string, string | undefined>);
  const visible =
    scopeIds === null
      ? sql`true`
      : sql`(
          (a.customer_id is not null and exists (select 1 from customers where customers.id = a.customer_id and ${scopedToUsers(scopeIds)}))
          or (not exists (select 1 from customers where customers.id = a.customer_id) and ${scopeIds.length ? sql`a.sender_id in (${sql.join(scopeIds.map((i) => sql`${i}`), sql`, `)})` : sql`false`})
        )`;
  const parts = [visible];
  if (f.q) parts.push(sql`(a.recipient_name ilike ${"%" + f.q + "%"} or a.content_name ilike ${"%" + f.q + "%"} or a.caption ilike ${"%" + f.q + "%"})`);
  if (f.sender) parts.push(sql`a.sender_name ilike ${"%" + f.sender + "%"}`);
  if (f.kind) parts.push(sql`a.kind = ${f.kind}`);
  /* A day is the Indian day, named explicitly: a bare cast would read it in the session's zone. */
  if (f.from) parts.push(sql`a.occurred_at >= (${f.from}::timestamp at time zone ${APP_TIMEZONE})`);
  if (f.to) parts.push(sql`a.occurred_at < ((${f.to}::date + 1)::timestamp at time zone ${APP_TIMEZONE})`);
  const where = sql.join(parts, sql` and `);
  const [{ n }] = (await db.execute(sql`select count(*)::int as n from studio_activities a where ${where}`)) as unknown as { n: number }[];
  const total = Number(n);
  const pageCount = Math.max(1, Math.ceil(total / TIMELINE_PAGE));
  const page = Math.min(f.page ?? 1, pageCount);
  const rows = (await db.execute(sql`
    select a.id, a.occurred_at, a.kind, a.content_name, a.caption, a.sender_name, a.recipient_name, a.customer_id, a.mode, a.channel, a.action, a.reason, a.batch_ref,
           m.status as provider, m.error_text as provider_error
      from studio_activities a
      left join studio_wa_messages m on m.id = a.wa_message_id
     where ${where}
     order by a.occurred_at desc, a.id desc
     limit ${TIMELINE_PAGE} offset ${(page - 1) * TIMELINE_PAGE}`)) as unknown as {
    id: string; occurred_at: Date; kind: ActivityKind; content_name: string; caption: string | null; sender_name: string; recipient_name: string; customer_id: string | null;
    mode: ActivityMode; channel: ActivityChannel; action: ActivityAction; reason: string | null; batch_ref: string | null; provider: ProviderState | null; provider_error: string | null;
  }[];
  return {
    rows: rows.map((r) => ({
      id: r.id,
      at: new Date(r.occurred_at),
      kind: r.kind,
      contentName: r.content_name,
      caption: r.caption,
      senderName: r.sender_name,
      recipientName: r.recipient_name,
      customerId: r.customer_id,
      mode: r.mode,
      channel: r.channel,
      action: r.action,
      reason: r.reason,
      batchRef: r.batch_ref,
      provider: r.provider,
      providerError: r.provider_error,
      status: statusOf({ action: r.action, channel: r.channel, provider: r.provider }),
    })),
    total,
    page,
    pageCount,
    filter: f,
  };
}

/* ------------------------------------------------------------ the bulk poster run */

/**
 * One entry for the RUN: who generated it, when, which design and how many posters. It names no recipient and invents
 * none - the recipients are the posters' own rows, which appear when a poster is downloaded, shared or sent.
 */
export async function recordBatchGenerated(input: { senderId: string; batchId: string; templateName: string; made: number; skipped: number }): Promise<void> {
  await recordActivity({
    kind: "poster",
    contentName: `${input.templateName} - bulk run`,
    contentRefType: "batch",
    contentRefId: input.batchId,
    senderId: input.senderId,
    customerId: null,
    recipientName: `Bulk run - ${input.made} poster${input.made === 1 ? "" : "s"}`,
    mode: "bulk",
    channel: "studio",
    action: "batch_generated",
    reason: input.skipped ? `${input.skipped} could not be made and were skipped.` : null,
    batchRef: input.batchId,
  });
}

/**
 * A ZIP of a bulk run was downloaded. What the ZIP CONTAINED decides the shape:
 *   - every poster that carries a recipient gets its own row (the poster-recipient pair), as a download - never a send;
 *   - posters that carry no recipient cannot be mapped, so they are one row for the whole run instead - and if NONE
 *     can be mapped that single row is all there is.
 * `included` is what actually went into the ZIP (a poster that could not be drawn is not in it, and has no row).
 */
export async function recordBatchZipDownload(senderId: string, batch: { id: string; templateName: string }, included: Pick<StudioPoster, "id" | "customerId" | "recipient" | "templateName">[]): Promise<void> {
  const mapped = included.filter((p) => p.customerId !== null || (p.recipient?.company ?? "").trim() !== "");
  const unmapped = included.length - mapped.length;
  for (const p of mapped) {
    await recordActivity({
      kind: "poster",
      contentName: `${p.templateName} - ${p.recipient?.company?.trim() || "recipient"}`,
      contentRefType: "poster",
      contentRefId: p.id,
      senderId,
      customerId: p.customerId,
      recipientName: p.recipient?.company?.trim() || "Unknown recipient",
      mode: "bulk",
      channel: "download",
      action: "zip_downloaded",
      batchRef: batch.id,
    });
  }
  if (!mapped.length || unmapped) {
    await recordActivity({
      kind: "poster",
      contentName: `${batch.templateName} - bulk run`,
      contentRefType: "batch",
      contentRefId: batch.id,
      senderId,
      customerId: null,
      recipientName: `Whole bulk run - ${included.length} poster${included.length === 1 ? "" : "s"}`,
      mode: "bulk",
      channel: "download",
      action: "zip_downloaded_batch",
      reason: !mapped.length ? "The posters in this ZIP carry no recipient, so this is one entry for the whole run." : `${unmapped} poster${unmapped === 1 ? "" : "s"} in this ZIP carry no recipient.`,
      batchRef: batch.id,
    });
  }
}
