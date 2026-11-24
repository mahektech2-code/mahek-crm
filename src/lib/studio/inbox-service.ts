import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, studioWaConversations, studioWaEvents, studioWaMessages } from "@/db/schema";
import { scopedToUsers } from "@/lib/access-control";
import { getConfig } from "@/lib/config/store";
import { whatsappServiceState } from "@/lib/services/whatsapp-switch-service";
import { readSecret } from "@/lib/secrets";
import {
  CAPTION_MAX,
  IMAGE_MAX_BYTES,
  WINDOW_CLOSED_MESSAGE,
  checkCaption,
  checkText,
  isMessageEvent,
  mergeStatus,
  normalizeConversation,
  normalizeMessage,
  parseWebhook,
  phoneKey,
  previewOf,
  sendableNumber,
  windowState,
  type MessageStatus,
  type NormalConversation,
  type NormalMessage,
} from "./domain/inbox";
import * as kapso from "./kapso";
import { previewConversation, previewEnabled, previewList, previewMarkRead, previewSend, previewThread } from "./inbox-preview";
import { fail, ok, type Result } from "./result";

/* ---------------------------------------------------------------------------
 * THE STUDIO'S WHATSAPP INBOX — reads, webhook intake, refresh and sending.
 *
 * Three rules hold the whole thing together:
 *   - NOTHING IS SHOWN THAT KAPSO DID NOT SAY. There is no seed, no sample and
 *     no fallback conversation. Where Kapso is not reachable, not holding the
 *     company number, or holding only a sandbox, the screen says exactly that.
 *   - ONE MESSAGE IS ONE ROW. The unique key is the WhatsApp message id, a
 *     webhook delivery is remembered by its idempotency key, and a message the
 *     Studio is sending is reserved under the browser's own key first — so a
 *     double click, a retried webhook and the refresh that reads the same
 *     message back all land on one row.
 *   - A STATUS ONLY MOVES FORWARD, and is only what Kapso reported.
 * ------------------------------------------------------------------------- */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/* --------------------------------------------------------------- connection */

export type Connection =
  /** LOCAL PREVIEW — sample data, developer machines only (see inbox-preview.ts). Never produced by `connection()`. */
  | { state: "preview" }
  | { state: "no_key" }
  | { state: "rejected" | "unreachable"; error: string }
  | { state: "not_connected"; reason: "number_missing" | "sandbox_only"; expected: string; seen: { display: string | null; sandbox: boolean }[] }
  | { state: "connected"; phoneNumberId: string; display: string | null; coexistence: boolean | null; status: string | null; webhookSecretHeld: boolean };

const CACHE_MS = 30_000;
let cached: { at: number; value: Connection } | null = null;
export const resetConnectionCache = () => {
  cached = null;
};

const isSandbox = (n: kapso.KapsoNumber) => /sandbox/i.test(n.name ?? "");

/**
 * Is the company number really in the Kapso project, as a live number? Judged
 * from Kapso's own list of numbers, never assumed: a sandbox number is never
 * shown as the company's WhatsApp, and a number that is not there says so.
 */
export async function connection(opts: { force?: boolean } = {}): Promise<Connection> {
  if (!opts.force && cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const value = await readConnection();
  cached = { at: Date.now(), value };
  return value;
}

async function readConnection(): Promise<Connection> {
  if (!(await kapso.kapsoKeyHeld())) return { state: "no_key" };
  const expected = String((await getConfig())["studio.whatsapp.number"] ?? "").replace(/\D/g, "");
  const listed = await kapso.listNumbers();
  if (!listed.ok) return { state: listed.status === 401 || listed.status === 403 ? "rejected" : "unreachable", error: listed.error };
  const key = phoneKey(expected);
  const ours = key ? listed.data.find((n) => !isSandbox(n) && phoneKey(n.digits) === key) : undefined;
  if (!ours) {
    const sandboxOnly = listed.data.length > 0 && listed.data.every(isSandbox);
    return { state: "not_connected", reason: sandboxOnly || listed.data.length === 0 ? "sandbox_only" : "number_missing", expected, seen: listed.data.map((n) => ({ display: n.displayPhone, sandbox: isSandbox(n) })) };
  }
  return {
    state: "connected",
    phoneNumberId: ours.phoneNumberId,
    display: ours.displayPhone,
    coexistence: ours.isCoexistence,
    status: ours.status,
    webhookSecretHeld: Boolean(await readSecret("kapso.webhookSecret")),
  };
}

const connectedId = (c: Connection) => (c.state === "connected" ? c.phoneNumberId : null);

const notReady = (c: Connection) =>
  fail(
    "unavailable",
    c.state === "no_key"
      ? "The Kapso key is not set, so the inbox cannot reach WhatsApp."
      : c.state === "not_connected"
        ? "The company WhatsApp number is not connected to Kapso as a live number yet."
        : c.state === "rejected" || c.state === "unreachable"
          ? c.error
          : "The inbox is not ready.",
  );

/* ----------------------------------------------------------------- upserts */

async function upsertConversation(tx: Tx, c: NormalConversation, phoneNumberId: string) {
  await tx
    .insert(studioWaConversations)
    .values({ id: c.id, phoneNumberId, phone: c.phone, phoneKey: phoneKey(c.phone), contactName: c.contactName, lastMessageText: c.lastMessageText, lastMessageAt: c.lastMessageAt, lastInboundAt: c.lastInboundAt })
    .onConflictDoUpdate({
      target: studioWaConversations.id,
      set: {
        phone: sql`coalesce(excluded.phone, studio_wa_conversations.phone)`,
        phoneKey: sql`coalesce(excluded.phone_key, studio_wa_conversations.phone_key)`,
        contactName: sql`coalesce(excluded.contact_name, studio_wa_conversations.contact_name)`,
        lastInboundAt: sql`greatest(excluded.last_inbound_at, studio_wa_conversations.last_inbound_at)`,
        lastMessageText: sql`case when excluded.last_message_at is not null and (studio_wa_conversations.last_message_at is null or excluded.last_message_at >= studio_wa_conversations.last_message_at) then excluded.last_message_text else studio_wa_conversations.last_message_text end`,
        lastMessageAt: sql`greatest(excluded.last_message_at, studio_wa_conversations.last_message_at)`,
        updatedAt: sql`now()`,
      },
    });
}

type Extras = { sentById?: string | null; posterId?: string | null };

/** One message, by its WhatsApp id: inserted once, and merged — never duplicated — every time it is reported again. */
async function applyMessage(tx: Tx, conversationId: string, m: NormalMessage, opts: { countUnread: boolean } & Extras): Promise<{ inserted: boolean }> {
  const [ex] = await tx.select().from(studioWaMessages).where(eq(studioWaMessages.wamid, m.wamid)).limit(1).for("update");
  let inserted = false;
  if (ex) {
    await tx
      .update(studioWaMessages)
      .set({
        status: ex.direction === "outbound" ? mergeStatus((ex.status as MessageStatus | null) ?? null, m.status) : ex.status,
        body: ex.body ?? m.body,
        caption: ex.caption ?? m.caption,
        mediaUrl: m.mediaUrl ?? ex.mediaUrl,
        errorCode: m.errorCode ?? ex.errorCode,
        errorText: m.errorText ?? ex.errorText,
        origin: ex.origin ?? m.origin,
        sentById: ex.sentById ?? opts.sentById ?? null,
        posterId: ex.posterId ?? opts.posterId ?? null,
        updatedAt: sql`now()`,
      })
      .where(eq(studioWaMessages.id, ex.id));
  } else {
    await tx.insert(studioWaMessages).values({
      id: randomUUID(),
      conversationId,
      wamid: m.wamid,
      direction: m.direction,
      type: m.type,
      body: m.body,
      caption: m.caption,
      hasMedia: m.hasMedia,
      mediaType: m.mediaType,
      mediaUrl: m.mediaUrl,
      status: m.direction === "outbound" ? (m.status ?? "sent") : null,
      errorCode: m.errorCode,
      errorText: m.errorText,
      origin: m.origin,
      sentById: opts.sentById ?? null,
      posterId: opts.posterId ?? null,
      at: m.at,
    });
    inserted = true;
  }
  const inbound = m.direction === "inbound";
  await tx
    .update(studioWaConversations)
    .set({
      lastMessageText: sql`case when ${studioWaConversations.lastMessageAt} is null or ${m.at.toISOString()}::timestamptz >= ${studioWaConversations.lastMessageAt} then ${previewOf(m)} else ${studioWaConversations.lastMessageText} end`,
      lastMessageAt: sql`greatest(${studioWaConversations.lastMessageAt}, ${m.at.toISOString()}::timestamptz)`,
      lastInboundAt: inbound ? sql`greatest(${studioWaConversations.lastInboundAt}, ${m.at.toISOString()}::timestamptz)` : studioWaConversations.lastInboundAt,
      unread: inserted && inbound && opts.countUnread ? sql`${studioWaConversations.unread} + 1` : studioWaConversations.unread,
      updatedAt: sql`now()`,
    })
    .where(eq(studioWaConversations.id, conversationId));
  return { inserted };
}

/* ----------------------------------------------------------------- webhooks */

export type WebhookOutcome = { result: "stored" | "duplicate" | "ignored" | "unavailable"; reason?: string };

/**
 * One webhook delivery. Recognised by Kapso's idempotency key (stable across
 * its retries), so a retry changes nothing; and only a message for the company
 * number is kept — a webhook for any other number in the project is ignored.
 */
export async function applyWebhook(input: { event: string | null; key: string | null; body: unknown }): Promise<WebhookOutcome> {
  if (!isMessageEvent(input.event)) return { result: "ignored", reason: "not a message event" };
  const parsed = parseWebhook(input.event, input.body);
  if (!parsed.message || !parsed.conversation) return { result: "ignored", reason: "no message" };
  const conn = await connection();
  const own = connectedId(conn);
  if (!own) return { result: "unavailable", reason: "the company number is not confirmed in Kapso, so the message cannot be filed yet" };
  if (parsed.phoneNumberId !== own) return { result: "ignored", reason: "another number" };
  const key = input.key?.trim() || `${input.event}:${parsed.message.wamid}:${parsed.message.status ?? ""}`;
  return db.transaction(async (tx) => {
    const fresh = await tx.insert(studioWaEvents).values({ key, event: input.event as string }).onConflictDoNothing().returning({ key: studioWaEvents.key });
    if (!fresh.length) return { result: "duplicate" } as WebhookOutcome;
    await upsertConversation(tx, parsed.conversation as NormalConversation, own);
    await applyMessage(tx, (parsed.conversation as NormalConversation).id, parsed.message as NormalMessage, { countUnread: true });
    return { result: "stored" } as WebhookOutcome;
  });
}

/* ------------------------------------------------------------------ refresh */

/**
 * THE MANUAL REFRESH'S MINIMUM INTERVAL. One press costs up to 23 calls to Kapso (three pages of conversations and
 * twenty threads), and anybody holding the Inbox can press it, so repeated presses must not repeat the calls. Two layers,
 * neither of which needs a table:
 *   - this process: the slot is taken in ONE synchronous check-and-set, so presses that arrive together cannot both pass,
 *     and a refresh that FAILED still holds it (a broken Kapso is not hammered);
 *   - every process and restart: the newest `studio.inbox.synced` audit row, which a completed refresh already writes.
 */
export const REFRESH_MIN_SECONDS = 30;
const refreshState = globalThis as unknown as { __studioInboxRefreshAt?: number };

/** Seconds the caller must wait before Kapso may be asked again; 0 means go ahead, and the slot is now taken. */
export async function claimRefresh(): Promise<number> {
  const now = Date.now();
  const before = refreshState.__studioInboxRefreshAt;
  const wait = before === undefined ? 0 : Math.ceil((before + REFRESH_MIN_SECONDS * 1000 - now) / 1000);
  if (wait > 0) return wait;
  refreshState.__studioInboxRefreshAt = now;
  const [last] = await db.select({ at: auditLog.at }).from(auditLog).where(eq(auditLog.action, "studio.inbox.synced")).orderBy(desc(auditLog.at)).limit(1);
  const other = last ? Math.ceil((new Date(last.at).getTime() + REFRESH_MIN_SECONDS * 1000 - Date.now()) / 1000) : 0;
  if (other > 0) {
    /* Another process refreshed a moment ago: give the slot back and wait out the rest of its interval. */
    refreshState.__studioInboxRefreshAt = before;
    return other;
  }
  return 0;
}

/** Test seam only: forgets this process's slot. Does nothing outside NODE_ENV=test. */
export function resetRefreshThrottle() {
  if (process.env.NODE_ENV === "test") delete refreshState.__studioInboxRefreshAt;
}

const SYNC_PAGES = 3;
const SYNC_THREADS = 20;

/**
 * Reads the recent conversations and the messages of the ones that moved from
 * Kapso itself. It is the catch-up under the webhook — Kapso retries a
 * delivery for about fifty seconds and then gives up — and the only way the
 * inbox fills before a webhook is set. A message already stored is merged, not
 * duplicated; messages written on the phone (`origin: business_app`) come in
 * the same way.
 */
export async function syncFromKapso(): Promise<Result<{ conversations: number; threads: number; messages: number }>> {
  if (previewEnabled()) return fail("unavailable", "This is the local preview with sample data — there is nothing to refresh from Kapso.");
  const conn = await connection({ force: true });
  const own = connectedId(conn);
  if (!own) return notReady(conn);
  const convs: NormalConversation[] = [];
  let after: string | undefined;
  for (let i = 0; i < SYNC_PAGES; i++) {
    const page = await kapso.listConversations(own, { limit: 50, after });
    if (!page.ok) return fail("unavailable", page.error);
    for (const raw of page.data.data ?? []) {
      const c = normalizeConversation(raw, own);
      if (c) convs.push(c);
    }
    after = page.data.paging?.next ? (page.data.paging.cursors?.after ?? undefined) : undefined;
    if (!after) break;
  }
  await db.transaction(async (tx) => {
    for (const c of convs) await upsertConversation(tx, c, own);
  });
  let threads = 0;
  let messages = 0;
  for (const c of convs) {
    if (threads >= SYNC_THREADS) break;
    const [known] = await db
      .select({ latest: sql<Date | null>`(select max(at) from studio_wa_messages where conversation_id = ${c.id})`, inbound: sql<Date | null>`(select max(at) from studio_wa_messages where conversation_id = ${c.id} and direction = 'inbound')` })
      .from(studioWaConversations)
      .where(eq(studioWaConversations.id, c.id));
    const latest = known?.latest ? new Date(known.latest) : null;
    if (latest && c.lastMessageAt && c.lastMessageAt.getTime() <= latest.getTime()) continue;
    const page = await kapso.listMessages(own, c.id, { limit: 100 });
    if (!page.ok) return fail("unavailable", page.error);
    threads++;
    const lastInbound = known?.inbound ? new Date(known.inbound) : null;
    const list = (page.data.data ?? []).map(normalizeMessage).filter((m): m is NormalMessage => Boolean(m)).reverse();
    await db.transaction(async (tx) => {
      for (const m of list) {
        /* Unread is counted only for messages newer than the last one already seen, and never on a first fill. */
        const countUnread = lastInbound !== null && m.at.getTime() > lastInbound.getTime();
        const r = await applyMessage(tx, c.id, m, { countUnread });
        if (r.inserted) messages++;
      }
    });
  }
  return ok({ conversations: convs.length, threads, messages });
}

/* -------------------------------------------------------------------- reads */

export type ConversationRow = {
  id: string;
  phone: string | null;
  /** What the list shows: the CRM name where the number matches a customer, else WhatsApp's contact name, else the number. */
  title: string;
  nameSource: "crm" | "whatsapp" | "number";
  customerId: string | null;
  contactName: string | null;
  lastMessageText: string | null;
  lastMessageAt: Date | null;
  lastInboundAt: Date | null;
  unread: number;
  windowOpen: boolean;
  windowClosesAt: Date | null;
  /** Why this customer may not be messaged from the Studio, where they may not. */
  blocked: "do_not_contact" | "whatsapp_dnd" | null;
};

type RawConversation = {
  id: string;
  phone: string | null;
  contact_name: string | null;
  last_message_text: string | null;
  last_message_at: Date | null;
  last_inbound_at: Date | null;
  unread: number;
  customer_id: string | null;
  customer_name: string | null;
  dnc: boolean | null;
  wdnd: boolean | null;
};

const MATCH = (col: ReturnType<typeof sql>) => sql`right(regexp_replace(coalesce(${col}, ''), '\\D', '', 'g'), 10) = conv.phone_key`;

function toRow(r: RawConversation, now: Date): ConversationRow {
  const w = windowState(r.last_inbound_at ? new Date(r.last_inbound_at) : null, now);
  return {
    id: r.id,
    phone: r.phone,
    title: r.customer_name ?? r.contact_name ?? (r.phone ? `+${r.phone}` : "Unknown number"),
    nameSource: r.customer_name ? "crm" : r.contact_name ? "whatsapp" : "number",
    customerId: r.customer_id,
    contactName: r.contact_name,
    lastMessageText: r.last_message_text,
    lastMessageAt: r.last_message_at ? new Date(r.last_message_at) : null,
    lastInboundAt: r.last_inbound_at ? new Date(r.last_inbound_at) : null,
    unread: Number(r.unread ?? 0),
    windowOpen: w.open,
    windowClosesAt: w.closesAt,
    blocked: r.dnc ? "do_not_contact" : r.wdnd ? "whatsapp_dnd" : null,
  };
}

/**
 * Every conversation on the company number, newest first, with the CRM name
 * where the number is a customer's. The match is made here, at read time, on
 * the last ten digits of any phone the customer record holds — so a corrected
 * CRM phone corrects the name at once, and nothing about it is stored. Only
 * the name and two do-not-message flags leave the CRM: everybody holding the
 * inbox sees every conversation, and nothing else about the customer.
 */
async function selectConversations(extra: ReturnType<typeof sql>, limit: number, scopeIds: string[] | null): Promise<ConversationRow[]> {
  const rows = (await db.execute(sql`
    select conv.id, conv.phone, conv.contact_name, conv.last_message_text, conv.last_message_at, conv.last_inbound_at, conv.unread,
           m.customer_id, m.customer_name, d.dnc, d.wdnd
      from studio_wa_conversations conv
      left join lateral (
        select customers.id as customer_id, customers.name as customer_name
          from customers
         where conv.phone_key is not null
           and ${scopedToUsers(scopeIds) ?? sql`true`}
           and (${MATCH(sql`customers.phone`)} or ${MATCH(sql`customers.whatsapp_phone`)} or ${MATCH(sql`customers.alt_phone`)} or ${MATCH(sql`customers.payment_whatsapp_phone`)}
                or exists (select 1 from customer_contacts cc where cc.customer_id = customers.id and ${MATCH(sql`cc.phone`)}))
         order by (customers.kind = 'customer') desc, customers.id
         limit 1
      ) m on true
      left join lateral (
        /* A number is not messaged if ANY record that holds it says so - whether or not the viewer may see that record. */
        select bool_or(customers.do_not_contact) as dnc, bool_or(customers.whatsapp_dnd) as wdnd
          from customers
         where conv.phone_key is not null
           and (${MATCH(sql`customers.phone`)} or ${MATCH(sql`customers.whatsapp_phone`)} or ${MATCH(sql`customers.alt_phone`)} or ${MATCH(sql`customers.payment_whatsapp_phone`)}
                or exists (select 1 from customer_contacts cc where cc.customer_id = customers.id and ${MATCH(sql`cc.phone`)}))
      ) d on true
     where ${extra}${scopeIds === null ? sql`` : sql` and m.customer_id is not null`}
     order by conv.last_message_at desc nulls last
     limit ${limit}`)) as unknown as RawConversation[];
  const now = new Date();
  return rows.map((r) => toRow(r, now));
}

export async function listConversationRows(opts: { q?: string; /** The viewer's reach (`scope.userIds`): null is the whole book. Required — there is no unscoped read. */ scopeIds: string[] | null }): Promise<{ connection: Connection; rows: ConversationRow[] }> {
  if (previewEnabled()) return { connection: { state: "preview" }, rows: await previewList(opts.q ?? "") };
  const conn = await connection();
  const own = connectedId(conn);
  /* Stored messages stay readable even where Kapso cannot be reached right now, but only for the company number once known. */
  const numberId = own ?? (await storedNumberId());
  if (!numberId) return { connection: conn, rows: [] };
  const q = (opts.q ?? "").trim().slice(0, 80);
  const digits = q.replace(/\D/g, "");
  /* A phone clause only where the search has digits in it — "shree" must not match every number. */
  const byPhone = digits.length >= 3 ? sql` or conv.phone ilike ${"%" + digits + "%"}` : sql``;
  const filter = q
    ? sql`conv.phone_number_id = ${numberId} and (conv.contact_name ilike ${"%" + q + "%"}${byPhone} or m.customer_name ilike ${"%" + q + "%"})`
    : sql`conv.phone_number_id = ${numberId}`;
  return { connection: conn, rows: await selectConversations(filter, 100, opts.scopeIds) };
}

async function storedNumberId(): Promise<string | null> {
  const [r] = await db.select({ id: studioWaConversations.phoneNumberId }).from(studioWaConversations).orderBy(sql`${studioWaConversations.updatedAt} desc`).limit(1);
  return r?.id ?? null;
}

export type MessageView = {
  id: string;
  direction: "inbound" | "outbound";
  type: string;
  body: string | null;
  caption: string | null;
  hasMedia: boolean;
  mediaType: string | null;
  status: MessageStatus | null;
  errorText: string | null;
  origin: string | null;
  at: Date;
  sentByName: string | null;
  posterId: string | null;
};

export async function getConversation(id: string, scopeIds: string[] | null): Promise<ConversationRow | null> {
  if (previewEnabled()) return previewConversation(id);
  const [row] = await selectConversations(sql`conv.id = ${id}`, 1, scopeIds);
  return row ?? null;
}

/** The conversation on the company number with this phone, if the viewer may see it - which is to say, if it is a lead's or customer's they may see. */
export async function conversationForNumber(phone: string | null | undefined, scopeIds: string[] | null): Promise<ConversationRow | null> {
  const key = String(phone ?? "").replace(/\D/g, "").slice(-10);
  if (key.length < 10) return null;
  const [row] = await selectConversations(sql`conv.phone_key = ${key}`, 1, scopeIds);
  return row ?? null;
}

export async function threadMessages(conversationId: string, scopeIds: string[] | null, limit = 300): Promise<MessageView[]> {
  if (previewEnabled()) return previewThread(conversationId);
  /* A thread is read only through a conversation the viewer may see; one they may not answers like one that does not exist. */
  if (!(await getConversation(conversationId, scopeIds))) return [];
  const rows = (await db.execute(sql`
    select * from (
      select m.id, m.direction, m.type, m.body, m.caption, m.has_media, m.media_type, m.status, m.error_text, m.origin, m.at, m.poster_id, u.name as sent_by_name
        from studio_wa_messages m left join users u on u.id = m.sent_by_id
       where m.conversation_id = ${conversationId}
       order by m.at desc, m.id desc limit ${limit}) t
     order by at asc, id asc`)) as unknown as {
    id: string; direction: "inbound" | "outbound"; type: string; body: string | null; caption: string | null; has_media: boolean; media_type: string | null;
    status: MessageStatus | null; error_text: string | null; origin: string | null; at: Date; poster_id: string | null; sent_by_name: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    direction: r.direction,
    type: r.type,
    body: r.body,
    caption: r.caption,
    hasMedia: r.has_media,
    mediaType: r.media_type,
    status: r.status,
    errorText: r.error_text,
    origin: r.origin,
    at: new Date(r.at),
    sentByName: r.sent_by_name,
    posterId: r.poster_id,
  }));
}

export async function markRead(conversationId: string, scopeIds: string[] | null) {
  if (previewEnabled()) return previewMarkRead(conversationId);
  if (!(await getConversation(conversationId, scopeIds))) return;
  await db.update(studioWaConversations).set({ unread: 0 }).where(and(eq(studioWaConversations.id, conversationId), sql`${studioWaConversations.unread} > 0`));
}

/* ------------------------------------------------------------------ sending */

type Draft = { kind: "text"; body: string } | { kind: "poster"; caption: string; posterId: string | null; image: Uint8Array; mime: string; filename: string };

/**
 * What may be sent to this conversation right now — checked before anything is
 * reserved or sent: Kapso must hold the company number, WhatsApp's 24-hour
 * window must be open, and the customer (if the number is one) must not be
 * marked do-not-contact or WhatsApp-DND. A refusal is in words and sends nothing.
 */
/**
 * THE CRM'S CONTACT SAFEGUARDS, applied to every Inbox send. They are the same two rules the CRM's WhatsApp
 * enforces (`whatsapp-service.sendAutomaticAs`), read from the same setting, not a looser copy:
 *   - a number that belongs to somebody who WORKS at Mahek is never messaged as if it were a customer's;
 *   - `whatsapp.contactsPerWeekLimit` messages to one customer in a rolling week (zero is no limit). The count is the
 *     CRM's own (`wa_messages`: sent, delivered, read) PLUS what the Studio has already sent that customer's number
 *     through the company WhatsApp, so the limit holds across both channels.
 */
async function contactSafeguards(conv: ConversationRow): Promise<string | null> {
  const key = String(conv.phone ?? "").replace(/\D/g, "").slice(-10);
  if (key.length === 10) {
    const [staff] = (await db.execute(sql`
      select u.name from users u
       where right(regexp_replace(coalesce(u.phone, ''), '[^0-9]', '', 'g'), 10) = ${key}
       limit 1`)) as unknown as { name: string }[];
    if (staff) return `That number is ${staff.name}'s, who works at Mahek - not a customer's, so nothing can be sent to it from the Studio.`;
  }
  const limit = Number((await getConfig())["whatsapp.contactsPerWeekLimit"] ?? 0);
  if (limit > 0 && key.length === 10) {
    const [row] = (await db.execute(sql`
      select (
        (select count(*) from wa_messages w
          where ${conv.customerId ? sql`w.customer_id = ${conv.customerId}` : sql`false`}
            and w.status in ('sent_manually','sent','delivered','read')
            and coalesce(w.confirmed_sent_at, w.sent_at) > now() - interval '7 days')
        +
        (select count(*) from studio_wa_messages sm join studio_wa_conversations sc on sc.id = sm.conversation_id
          where sc.phone_key = ${key} and sm.direction = 'outbound'
            and sm.status in ('sent','delivered','read')
            and sm.at > now() - interval '7 days')
      )::int as n`)) as unknown as { n: number }[];
    const n = Number(row?.n ?? 0);
    if (n >= limit) return `${conv.title} has already had ${n} WhatsApp message${n === 1 ? "" : "s"} this week - the limit is ${limit}.`;
  }
  return null;
}

async function gate(conversationId: string, scopeIds: string[] | null): Promise<Result<{ own: string; to: string; conv: ConversationRow }>> {
  const conn = await connection();
  const own = connectedId(conn);
  if (!own) return notReady(conn);
  const conv = await getConversation(conversationId, scopeIds);
  if (!conv) return fail("not_found", "That conversation was not found.");
  /* THE FOUNDER'S SWITCH, read on every send like the CRM's: off means nothing goes, from the Inbox or from a bulk send. */
  if (!(await whatsappServiceState()).active) return fail("rule_violation", "The founder has WhatsApp sending switched off, so nothing was sent.");
  if (conv.blocked === "do_not_contact") return fail("rule_violation", "This customer is marked do not contact, so nothing can be sent to them from the Studio.");
  if (conv.blocked === "whatsapp_dnd") return fail("rule_violation", "This customer has asked not to be messaged on WhatsApp, so nothing can be sent to them from the Studio.");
  const to = sendableNumber(conv.phone);
  if (!to) return fail("rule_violation", "This conversation has no phone number to send to.");
  const refused = await contactSafeguards(conv);
  if (refused) return fail("rule_violation", refused);
  if (!conv.windowOpen) return fail("rule_violation", WINDOW_CLOSED_MESSAGE);
  return ok({ own, to, conv });
}

async function dispatch(userId: string, conversationId: string, clientKey: string, draft: Draft, scopeIds: string[] | null): Promise<Result<{ messageId: string; wamid: string }>> {
  /* LOCAL PREVIEW: the same checks, then a line in the in-memory sample chat. Nothing is sent and nothing is stored. */
  if (previewEnabled()) {
    const r = await previewSend(userId, conversationId, clientKey, draft.kind === "text" ? { kind: "text", body: draft.body } : { kind: "poster", caption: draft.caption, posterId: draft.posterId });
    return r.ok ? ok({ messageId: r.messageId, wamid: `preview:${r.messageId}` }) : fail("rule_violation", r.error);
  }
  const g = await gate(conversationId, scopeIds);
  if (!g.ok) return g;
  const { own, to } = g.data;
  const rowId = randomUUID();
  /* Reserve the send under the browser's own key: a second press of Send finds this row and sends nothing. */
  const reserved = await db
    .insert(studioWaMessages)
    .values({
      id: rowId,
      conversationId,
      wamid: `pending:${clientKey}`,
      direction: "outbound",
      type: draft.kind === "poster" ? "image" : "text",
      body: draft.kind === "text" ? draft.body : null,
      caption: draft.kind === "poster" ? draft.caption || null : null,
      hasMedia: draft.kind === "poster",
      mediaType: draft.kind === "poster" ? draft.mime : null,
      status: "pending",
      origin: "cloud_api",
      sentById: userId,
      posterId: draft.kind === "poster" ? draft.posterId : null,
      clientKey,
      at: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: studioWaMessages.id });
  if (!reserved.length) {
    const [existing] = await db.select({ id: studioWaMessages.id, wamid: studioWaMessages.wamid }).from(studioWaMessages).where(eq(studioWaMessages.clientKey, clientKey)).limit(1);
    return existing ? ok({ messageId: existing.id, wamid: existing.wamid }) : fail("unavailable", "That message could not be reserved. Try again.");
  }

  let sent: kapso.KapsoResult<{ wamid: string }>;
  if (draft.kind === "text") {
    sent = await kapso.sendText(own, to, draft.body);
  } else {
    const up = await kapso.uploadImage(own, draft.image, draft.filename, draft.mime);
    sent = up.ok ? await kapso.sendImage(own, to, up.data.id, draft.caption) : up;
  }
  if (!sent.ok) {
    /* A refusal means nothing went. A timeout or lost connection does not say — so it is marked, never retried. */
    const unsure = sent.code === "unreachable" || sent.code === "no_id";
    await db
      .update(studioWaMessages)
      .set({ status: "failed", errorText: unsure ? `${sent.error} It is not known whether this message went — check the conversation before sending it again.` : sent.error, errorCode: sent.code, updatedAt: sql`now()` })
      .where(eq(studioWaMessages.id, rowId));
    return fail("unavailable", sent.error);
  }
  const wamid = sent.data.wamid;
  await db.transaction(async (tx) => {
    /* A webhook can reach us before this line: then the real row exists already and this reservation folds into it. */
    const [other] = await tx.select().from(studioWaMessages).where(eq(studioWaMessages.wamid, wamid)).limit(1).for("update");
    if (other && other.id !== rowId) {
      await tx.delete(studioWaMessages).where(eq(studioWaMessages.id, rowId));
      await tx
        .update(studioWaMessages)
        .set({ sentById: other.sentById ?? userId, posterId: other.posterId ?? (draft.kind === "poster" ? draft.posterId : null), clientKey, body: other.body ?? (draft.kind === "text" ? draft.body : null), caption: other.caption ?? (draft.kind === "poster" ? draft.caption || null : null), updatedAt: sql`now()` })
        .where(eq(studioWaMessages.id, other.id));
    } else {
      await tx.update(studioWaMessages).set({ wamid, status: "sent", updatedAt: sql`now()` }).where(eq(studioWaMessages.id, rowId));
    }
    const preview = draft.kind === "text" ? draft.body : draft.caption || "📷 Photo";
    await tx
      .update(studioWaConversations)
      .set({ lastMessageText: preview.slice(0, 140), lastMessageAt: sql`greatest(${studioWaConversations.lastMessageAt}, now())`, updatedAt: sql`now()` })
      .where(eq(studioWaConversations.id, conversationId));
  });
  return ok({ messageId: rowId, wamid });
}

export async function sendTextMessage(userId: string, input: { conversationId: string; body: string; clientKey: string; scopeIds: string[] | null }) {
  const bad = checkText(input.body);
  if (bad) return fail("invalid_request", bad);
  return dispatch(userId, input.conversationId, input.clientKey, { kind: "text", body: input.body.trim() }, input.scopeIds);
}

export async function sendPosterMessage(userId: string, input: { conversationId: string; caption: string; clientKey: string; posterId: string | null; image: Uint8Array; mime: string; filename: string; scopeIds: string[] | null }) {
  const bad = checkCaption(input.caption);
  if (bad) return fail("invalid_request", bad);
  if (input.image.byteLength > IMAGE_MAX_BYTES) return fail("rule_violation", "That poster is larger than the 5 MB WhatsApp allows for a picture.");
  return dispatch(userId, input.conversationId, input.clientKey, { kind: "poster", caption: input.caption, posterId: input.posterId, image: input.image, mime: input.mime, filename: input.filename }, input.scopeIds);
}

/** LOCAL PREVIEW only: a generic preview picture sent into the in-memory sample chat. Refused outright when the preview gate is closed. */
export async function sendPreviewPosterMessage(userId: string, input: { conversationId: string; caption: string; clientKey: string; assetId: string }) {
  if (!previewEnabled()) return fail("unavailable", "The local preview is not switched on.");
  const bad = checkCaption(input.caption);
  if (bad) return fail("invalid_request", bad);
  return dispatch(userId, input.conversationId, input.clientKey, { kind: "poster", caption: input.caption, posterId: input.assetId, image: new Uint8Array(0), mime: "image/png", filename: "preview.png" }, null);
}

export { CAPTION_MAX };
