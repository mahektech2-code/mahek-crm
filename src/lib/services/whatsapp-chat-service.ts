import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, customers, waMessages, waReplies } from "@/db/schema";
import {
  ASSIGNED_TO_SQL,
  assertCustomerInScope,
  resolveScope,
  scopedToUsers,
  scopedUserIds,
} from "../access-control";
import { requireUser } from "../auth";
import { asDate } from "../business-date";
import { err, ok, type Result } from "../result";
import { sendWatiText } from "../wati";
import { replyText, waNumber } from "../whatsapp-delivery";
import { sessionWindowEnds, type TrackedMessage } from "../whatsapp-status";
import { announceWa } from "../wa-live";
import { deliveryContext, recomputeLastWhatsapp } from "./whatsapp-service";

/* ---------------------------------------------------------------------------
 * WHATSAPP CONVERSATIONS — one thread per customer, both directions, in order.
 *
 * Everything here was already stored: our messages in `wa_messages`, theirs in
 * `wa_replies`. This is the reading of them as a chat, plus the one write a
 * chat needs, and it is scoped exactly as the rest of the CRM: a telecaller
 * sees the threads of the customers and leads in their own book, a manager
 * their team's, and a number on nobody's book only somebody who sees the whole
 * book. A thread is keyed by the customer's id, or `n:<last ten digits>` for a
 * number that matches no customer.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const iso = (v: unknown) => (v === null || v === undefined ? null : asDate(v)?.toISOString() ?? null);
/** Last ten digits of a stored number, in SQL — the one spelling of it here. */
const last10 = (col: ReturnType<typeof sql.raw>) =>
  sql`right(regexp_replace(coalesce(${col}, ''), '[^0-9]', '', 'g'), 10)`;

export type ChatShow = "open" | "all" | "unknown";
export const CHAT_ALL_DAYS = 30;
const LIST_LIMIT = 200;
const THREAD_LIMIT = 200;

export type Conversation = {
  key: string;
  customerId: string | null;
  name: string;
  kind: "lead" | "customer" | null;
  thirdParty: boolean;
  number: string | null;
  lastAt: string;
  lastText: string;
  lastFromThem: boolean;
  /** Their messages nobody has answered or marked handled. */
  unanswered: number;
  assignedToName: string | null;
};

/**
 * The conversation list: every thread in which the customer has written to
 * us at least once — a list of everybody we ever messaged would be the whole
 * book — newest activity first, as a chat app orders it.
 */
export async function listConversations(opts: { show: ChatShow; q?: string }): Promise<{
  rows: Conversation[];
  openCount: number;
  seesUnknown: boolean;
  capped: boolean;
}> {
  const ctx = await resolveScope();
  const ids = scopedUserIds(ctx.scope);
  const seesUnknown = ids === null;
  // `customers` is joined unaliased on purpose: the scope clause spells its
  // columns `customers.owner_id`, and an alias would leave them pointing at
  // nothing.
  // A thread with a customer is drawn only while that customer is not in the
  // lead trash — the scope clause says so for everybody, and the whole-book
  // reader is held to it explicitly.
  const scope = seesUnknown
    ? sql`(th.customer_id is null or customers.deleted_at is null)`
    : sql`th.customer_id is not null and (${scopedToUsers(ids) ?? sql`true`})`;
  const q = opts.q?.trim().replace(/[%_]/g, "").slice(0, 100) ?? "";
  const like = `%${q}%`;
  const search = q
    ? sql`and (customers.name ilike ${like} or th.num like ${like} or th.sender ilike ${like}
               or exists (select 1 from wa_replies s where s.message ilike ${like}
                           and coalesce(s.customer_id, 'n:' || ${last10(sql.raw("s.wa_id"))}) = th.k))`
    : sql``;
  const which =
    opts.show === "open"
      ? sql`th.unanswered > 0`
      : opts.show === "unknown"
        ? sql`th.customer_id is null`
        : sql`th.last_at > now() - make_interval(days => ${CHAT_ALL_DAYS}::int)`;

  const threadsSql = sql`
    with ev as (
      select coalesce(r.customer_id, 'n:' || ${last10(sql.raw("r.wa_id"))}) as k,
             r.customer_id, ${last10(sql.raw("r.wa_id"))} as num,
             r.received_at as at, true as from_them, r.message as text,
             (not r.actioned) as open, r.sender_name as sender
        from wa_replies r
      union all
      select m.customer_id, m.customer_id, null, coalesce(m.sent_at, m.confirmed_sent_at, m.prepared_at),
             false, m.body, false, null
        from wa_messages m
       where m.status not in ('prepared', 'cancelled')
         and m.customer_id in (select x.customer_id from wa_replies x where x.customer_id is not null)
      union all
      select 'n:' || ${last10(sql.raw("r.wa_id"))}, null, ${last10(sql.raw("r.wa_id"))}, r.answered_at,
             false, r.answer_body, false, null
        from wa_replies r
       where r.customer_id is null and r.answer_status = 'sent'
    ),
    th as (
      select k, max(customer_id) as customer_id, max(num) as num, max(at) as last_at,
             count(*) filter (where open)::int as unanswered, max(sender) as sender
        from ev group by k
    ),
    latest as (select distinct on (k) k, from_them, text from ev order by k, at desc)
  `;

  const [rows, open] = await Promise.all([
    db.execute<{
      k: string;
      customer_id: string | null;
      num: string | null;
      last_at: unknown;
      unanswered: number;
      sender: string | null;
      from_them: boolean;
      text: string;
      name: string | null;
      kind: "lead" | "customer" | null;
      third_party: boolean | null;
      phone: string | null;
      assigned_to_name: string | null;
    }>(sql`
      ${threadsSql}
      select th.k, th.customer_id, th.num, th.last_at, th.unanswered, th.sender,
             latest.from_them, latest.text,
             customers.name, customers.kind, customers.third_party, customers.phone,
             (select u.name from users u where u.id = ${ASSIGNED_TO_SQL}) as assigned_to_name
        from th
        join latest on latest.k = th.k
        left join customers on customers.id = th.customer_id
       where (${scope}) and ${which} ${search}
       order by th.last_at desc, th.k
       limit ${LIST_LIMIT}
    `),
    db.execute<{ n: number }>(sql`
      ${threadsSql}
      select count(*)::int as n from th left join customers on customers.id = th.customer_id
       where (${scope}) and th.unanswered > 0
    `),
  ]);

  return {
    rows: rows.map((r) => ({
      key: r.k,
      customerId: r.customer_id,
      name: r.name ?? r.sender ?? (r.num ? `+91 ${r.num}` : "Unknown"),
      kind: r.kind,
      thirdParty: Boolean(r.third_party),
      number: r.customer_id ? r.phone : r.num,
      lastAt: iso(r.last_at)!,
      lastText: r.from_them ? replyText(r.text ?? "", null) : (r.text ?? ""),
      lastFromThem: Boolean(r.from_them),
      unanswered: Number(r.unanswered),
      assignedToName: r.assigned_to_name,
    })),
    openCount: Number(open[0]?.n ?? 0),
    seesUnknown,
    capped: rows.length >= LIST_LIMIT,
  };
}

export type ChatEvent = {
  id: string;
  fromThem: boolean;
  at: string;
  text: string;
  /** Template name for our messages; "Reply" for a typed answer. */
  templateName: string | null;
  /** Their WhatsApp name, or who of ours sent it, or "Automatic rule". */
  by: string | null;
  viaRule: boolean;
  /** Our messages' receipts, drawn by the shared DeliveryStatus badge. */
  receipts: TrackedMessage | null;
  /** Their message: answered or marked handled. */
  handled: boolean;
  /**
   * A file they sent — a photograph, a PDF — read through MahekOne at `url`,
   * behind the same gate as this conversation. Null for words.
   */
  media: { type: string; url: string; pdf: boolean } | null;
};

export type Thread = {
  key: string;
  customerId: string | null;
  name: string;
  kind: "lead" | "customer" | null;
  thirdParty: boolean;
  number: string | null;
  assignedToName: string | null;
  events: ChatEvent[];
  /** When free text stops being possible, or null when they never wrote. */
  windowEndsAt: string | null;
  /** Why nothing can be typed right now — the switch, the key, DND — or null. */
  blockedWhy: string | null;
  unanswered: number;
};

type Resolved =
  | { kind: "customer"; customer: typeof customers.$inferSelect }
  | { kind: "unknown"; number: string };

/**
 * Who a thread key names, and whether the caller may open it — the one gate
 * every read and write below goes through. A customer out of scope THROWS,
 * as every customer check here does; a number on nobody's book is refused to
 * anybody who does not see the whole book.
 */
async function resolveThread(key: string): Promise<Resolved | Result<never>> {
  if (key.startsWith("n:")) {
    const number = key.slice(2);
    if (!/^\d{10}$/.test(number)) return err("That conversation does not exist.", "not_found");
    if (scopedUserIds((await resolveScope()).scope) !== null) {
      return err("A number on nobody's book is answered by somebody who sees the whole book.", "not_permitted");
    }
    return { kind: "unknown", number };
  }
  const [customer] = await db.select().from(customers).where(eq(customers.id, key));
  if (!customer) return err("That conversation does not exist.", "not_found");
  await assertCustomerInScope(customer);
  return { kind: "customer", customer };
}

const isRefusal = (r: Resolved | Result<never>): r is Result<never> => "ok" in r;

/** Their messages in one thread, as a clause on `wa_replies r`. */
function theirs(t: Resolved) {
  return t.kind === "customer"
    ? sql`r.customer_id = ${t.customer.id}`
    : sql`r.customer_id is null and ${last10(sql.raw("r.wa_id"))} = ${t.number}`;
}

export async function getThread(key: string): Promise<Result<Thread>> {
  const t = await resolveThread(key);
  if (isRefusal(t)) return t;

  type Row = {
    id: string;
    from_them: boolean;
    at: unknown;
    text: string;
    template_name: string | null;
    by: string | null;
    via_rule: boolean;
    status: string | null;
    mode: string | null;
    prepared_at: unknown;
    sent_at: unknown;
    confirmed_sent_at: unknown;
    delivered_at: unknown;
    read_at: unknown;
    failure_reason: string | null;
    handled: boolean;
    media_type: string | null;
    media_path: string | null;
  };
  const inbound = sql`
    select r.id, true as from_them, r.received_at as at, r.message as text, null as template_name,
           r.sender_name as by, false as via_rule, null as status, null as mode, null as prepared_at,
           null as sent_at, null as confirmed_sent_at, null as delivered_at, null as read_at,
           null as failure_reason, r.actioned as handled,
           case when r.media_path is not null then r.media_type end as media_type, r.media_path
      from wa_replies r where ${theirs(t)}
  `;
  const outbound =
    t.kind === "customer"
      ? sql`
    select m.id, false, coalesce(m.sent_at, m.confirmed_sent_at, m.prepared_at), m.body, m.template_name,
           case when m.trigger_id is not null then 'Automatic rule' else u.name end, m.trigger_id is not null,
           m.status::text, m.mode::text, m.prepared_at, m.sent_at, m.confirmed_sent_at, m.delivered_at,
           m.read_at, m.failure_reason, true, null, null
      from wa_messages m left join users u on u.id = m.user_id
     where m.customer_id = ${t.customer.id} and m.status not in ('prepared', 'cancelled')`
      : sql`
    select r.id || ':answer', false, r.answered_at, r.answer_body, 'Reply', u.name, false,
           case when r.answer_status = 'sent' then 'sent' else 'failed' end, 'automatic', r.answered_at,
           r.answered_at, r.answered_at, null, null, r.answer_failure, true, null, null
      from wa_replies r left join users u on u.id = r.answered_by_id
     where ${theirs(t)} and r.answer_body is not null and r.answer_status in ('sent', 'failed')`;

  const [rows, lastIn] = await Promise.all([
    db.execute<Row>(sql`
      select * from (${inbound} union all ${outbound}) e
       order by e.at desc, e.id desc limit ${THREAD_LIMIT}
    `),
    db.execute<{ at: unknown; unanswered: number }>(sql`
      select max(r.received_at) as at, count(*) filter (where not r.actioned)::int as unanswered
        from wa_replies r where ${theirs(t)}
    `),
  ]);

  const events: ChatEvent[] = rows
    .map((r) => ({
      id: r.id,
      fromThem: Boolean(r.from_them),
      at: iso(r.at)!,
      text: r.from_them ? replyText(r.text ?? "", r.media_type) : (r.text ?? ""),
      templateName: r.template_name,
      by: r.by,
      viaRule: Boolean(r.via_rule),
      receipts: r.from_them
        ? null
        : {
            status: r.status ?? "sent",
            mode: r.mode ?? "automatic",
            preparedAt: iso(r.prepared_at) ?? iso(r.at)!,
            sentAt: iso(r.sent_at),
            confirmedSentAt: iso(r.confirmed_sent_at),
            deliveredAt: iso(r.delivered_at),
            readAt: iso(r.read_at),
            failureReason: r.failure_reason,
          },
      handled: Boolean(r.handled),
      media: r.media_type
        ? {
            type: r.media_type,
            url: `/api/whatsapp/media/${encodeURIComponent(r.id)}`,
            pdf: /\.pdf$/i.test(r.media_path ?? ""),
          }
        : null,
    }))
    .reverse();

  const [assigned] =
    t.kind === "customer"
      ? await db.execute<{ name: string | null }>(sql`
          select (select u.name from users u where u.id = ${ASSIGNED_TO_SQL}) as name
            from customers where customers.id = ${t.customer.id}`)
      : [{ name: null }];

  const lastInboundAt = iso(lastIn[0]?.at ?? null);
  const ends = sessionWindowEnds(lastInboundAt);
  const delivery = await deliveryContext();
  const blockedWhy = !delivery.serviceOn
    ? "WhatsApp sending is switched off in the Founder Command Centre, so nothing can go from the business number."
    : !delivery.hasToken
      ? "No Wati key is configured, so nothing can go from the business number."
      : t.kind === "customer" && t.customer.whatsappDnd
        ? `${t.customer.name} is on WhatsApp DND${t.customer.whatsappDndReason ? ` — ${t.customer.whatsappDndReason}` : ""}.`
        : null;

  const firstTheirs = [...events].reverse().find((e) => e.fromThem);
  return ok({
    key,
    customerId: t.kind === "customer" ? t.customer.id : null,
    name:
      t.kind === "customer" ? t.customer.name : (firstTheirs?.by ?? `+91 ${t.number}`),
    kind: t.kind === "customer" ? t.customer.kind : null,
    thirdParty: t.kind === "customer" ? t.customer.thirdParty : false,
    number: t.kind === "customer" ? (t.customer.whatsappPhone ?? t.customer.phone) : t.number,
    assignedToName: assigned?.name ?? null,
    events,
    windowEndsAt: ends ? ends.toISOString() : null,
    blockedWhy,
    unanswered: Number(lastIn[0]?.unanswered ?? 0),
  });
}

/**
 * The file one of their messages carries, for somebody allowed to see it.
 *
 * Asked through `resolveThread`, the gate every read here goes through: a
 * customer out of scope throws, and a number on nobody's book is refused to
 * anybody who does not see the whole book. So a payment slip is exactly as
 * visible as the conversation it arrived in, and a guessed id opens nothing.
 */
export async function getReplyMedia(replyId: string): Promise<Result<{ type: string; path: string }>> {
  const [reply] = await db
    .select({
      customerId: waReplies.customerId,
      waId: waReplies.waId,
      mediaType: waReplies.mediaType,
      mediaPath: waReplies.mediaPath,
    })
    .from(waReplies)
    .where(eq(waReplies.id, replyId));
  if (!reply?.mediaType || !reply.mediaPath) return err("No such file.", "not_found");
  const key = reply.customerId ?? `n:${(reply.waId ?? "").replace(/\D/g, "").slice(-10)}`;
  const t = await resolveThread(key);
  if (isRefusal(t)) return t;
  return ok({ type: reply.mediaType, path: reply.mediaPath });
}

/**
 * SEND A MESSAGE INTO A THREAD, from the business number.
 *
 * A WhatsApp session message, so only inside the 24 hours after the customer
 * last wrote — checked against their newest message before Wati is called,
 * and sent to the number that message came from, because that is the one the
 * conversation is open on. Gated like every API send (founder's switch, key)
 * and refused on WhatsApp DND.
 *
 * For a customer it is a row in the message log, claimed by its idempotency
 * key BEFORE Wati is called, so a double click sends one message: it shows in
 * the Log, on the record and on the payment page, its ticks land on it, and the
 * customer counts as messaged. Their unanswered messages are marked handled by
 * whoever answered.
 *
 * A number on nobody's book has no log row to write, so its answer is kept on
 * their newest message — one answer per message they send. Putting the number
 * on a customer or lead is what opens a free conversation with it.
 */
export async function sendChatMessage(input: {
  key: string;
  text: string;
  idempotencyKey: string;
}): Promise<Result> {
  const user = await requireUser();
  const body = input.text.trim();
  if (!body) return err("Write the message first.", "validation");
  if (body.length > 4000) return err("Keep the message under 4,000 characters.", "validation");
  if (!/^[\w-]{8,80}$/.test(input.idempotencyKey)) return err("Refresh the page and try again.", "validation");

  const t = await resolveThread(input.key);
  if (isRefusal(t)) return t;

  const delivery = await deliveryContext();
  if (!delivery.serviceOn) return err("WhatsApp sending is switched off in the Founder Command Centre.", "rule_violation");
  if (!delivery.hasToken) return err("No Wati key is configured, so nothing can be sent from the business number.", "rule_violation");
  if (t.kind === "customer" && t.customer.whatsappDnd) {
    return err(`${t.customer.name} is on WhatsApp DND${t.customer.whatsappDndReason ? ` — ${t.customer.whatsappDndReason}` : ""}.`, "rule_violation");
  }

  const [latest] = await db.execute<{
    id: string;
    wa_id: string | null;
    received_at: unknown;
    answer_status: string | null;
    answer_body: string | null;
  }>(sql`
    select r.id, r.wa_id, r.received_at, r.answer_status, r.answer_body
      from wa_replies r where ${theirs(t)}
     order by r.received_at desc, r.id desc limit 1
  `);
  const ends = sessionWindowEnds(iso(latest?.received_at ?? null));
  if (!latest || !ends || ends.getTime() <= Date.now()) {
    return err(
      latest
        ? "WhatsApp only allows free text within 24 hours of the customer's last message, and that window has closed. Send an approved template from Send a message instead."
        : "They have not written to us, so WhatsApp only allows an approved template. Send one from Send a message.",
      "rule_violation",
    );
  }
  const phone = waNumber(latest.wa_id);
  if (!phone) return err("Their number is not an Indian mobile MahekOne can answer.", "validation");
  const announce = () =>
    announceWa({ customerId: t.kind === "customer" ? t.customer.id : null, number: phone.slice(-10) });

  if (t.kind === "unknown") {
    if (latest.answer_status === "sent") {
      return err(
        "A number on nobody's book gets one reply per message it sends. Put the number on a customer or lead to keep the conversation going.",
        "conflict",
      );
    }
    const claimed = await db
      .update(waReplies)
      .set({ answerStatus: "sending", answerBody: body, answeredById: user.id, answeredAt: new Date(), answerFailure: null })
      .where(and(eq(waReplies.id, latest.id), sql`(${waReplies.answerStatus} is null or ${waReplies.answerStatus} = 'failed')`))
      .returning({ id: waReplies.id });
    if (!claimed.length) return err("This reply is already being sent.", "conflict");
    const sent = await sendWatiText({ phone, text: body });
    const now = new Date();
    if (!sent.ok) {
      const reason = sent.uncertain ? `${sent.error} It may or may not have gone — check in Wati before sending again.` : sent.error;
      await db.update(waReplies).set({ answerStatus: "failed", answerFailure: reason, answeredAt: now }).where(eq(waReplies.id, latest.id));
      await announce();
      return err(`Not sent: ${reason}`, "rule_violation");
    }
    await db
      .update(waReplies)
      .set({ answerStatus: "sent", answeredAt: now, actioned: true, actionedAt: now, actionedById: user.id })
      .where(eq(waReplies.id, latest.id));
    await db.insert(auditLog).values({
      id: id("aud"), actorId: user.id, action: "whatsapp.chat_sent", entityType: "wa_reply", entityId: latest.id,
      afterState: { number: phone, providerRef: sent.providerRef } as never,
    });
    await announce();
    return ok(undefined, "Sent from the business number");
  }

  const customer = t.customer;
  const messageId = id("wam");
  const claimed = await db
    .insert(waMessages)
    .values({
      id: messageId,
      customerId: customer.id,
      templateName: "Reply",
      userId: user.id,
      mode: "automatic",
      destKind: "personal",
      resolvedDestination: phone,
      body,
      status: "queued",
      inReplyToId: latest.id,
      idempotencyKey: input.idempotencyKey,
      createdById: user.id,
    })
    .onConflictDoNothing()
    .returning({ id: waMessages.id });
  if (!claimed.length) return err("That message has already been sent.", "conflict");
  await announce();

  const sent = await sendWatiText({ phone, text: body });
  const now = new Date();
  if (!sent.ok) {
    const reason = sent.uncertain ? `${sent.error} It may or may not have gone — check in Wati before sending again.` : sent.error;
    await db
      .update(waMessages)
      .set({ status: "failed", failureReason: reason, updatedAt: now })
      .where(eq(waMessages.id, messageId));
    await announce();
    return err(`Not sent: ${reason}`, "rule_violation");
  }

  await db.transaction(async (tx) => {
    await tx
      .update(waMessages)
      .set({ status: "sent", sentAt: now, confirmedSentAt: now, providerRef: sent.providerRef, updatedAt: now })
      .where(eq(waMessages.id, messageId));
    // Answering is handling: every message of theirs still waiting is done.
    await tx
      .update(waReplies)
      .set({ actioned: true, actionedAt: now, actionedById: user.id })
      .where(and(eq(waReplies.customerId, customer.id), eq(waReplies.actioned, false)));
    // And their newest message carries the answer, so lists that read the
    // reply row (the Replies count, the payment strip) see it answered.
    await tx
      .update(waReplies)
      .set({ answerBody: body, answerStatus: "sent", answeredAt: now, answeredById: user.id })
      .where(and(eq(waReplies.id, latest.id), isNull(waReplies.answerBody)));
    await tx.insert(auditLog).values({
      id: id("aud"), actorId: user.id, action: "whatsapp.chat_sent", entityType: "wa_message", entityId: messageId,
      afterState: { customerId: customer.id, providerRef: sent.providerRef } as never,
    });
  });
  await recomputeLastWhatsapp(customer.id);
  await announce();
  return ok(undefined, `Sent to ${customer.name} from the business number`);
}

/** Mark every waiting message in a thread handled — or, with `false`, put them back. */
export async function markThreadHandled(key: string, handled = true): Promise<Result> {
  const user = await requireUser();
  const t = await resolveThread(key);
  if (isRefusal(t)) return t;
  const now = new Date();
  if (handled) {
    await db.execute(sql`
      update wa_replies r set actioned = true, actioned_at = ${now.toISOString()}::timestamptz, actioned_by_id = ${user.id}
       where ${theirs(t)} and r.actioned = false
    `);
  } else {
    // Back to waiting: their newest message, which is the one somebody owes an answer to.
    await db.execute(sql`
      update wa_replies set actioned = false, actioned_at = null, actioned_by_id = null
       where id = (select r.id from wa_replies r where ${theirs(t)} order by r.received_at desc limit 1)
    `);
  }
  await announceWa({
    customerId: t.kind === "customer" ? t.customer.id : null,
    number: t.kind === "unknown" ? t.number : null,
  });
  return ok(undefined, handled ? "Marked handled" : "Back in Needs reply");
}
