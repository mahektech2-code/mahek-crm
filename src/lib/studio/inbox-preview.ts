import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { WINDOW_CLOSED_MESSAGE, previewOf, windowState, type MessageStatus } from "./domain/inbox";
import { previewAllowed } from "./domain/inbox-preview-gate";
import type { ConversationRow, MessageView } from "./inbox-service";

/* ---------------------------------------------------------------------------
 * LOCAL PREVIEW — SAMPLE DATA. Developer machines only.
 *
 * Lets the whole Inbox be inspected before the company number is connected.
 * It lives in MEMORY, in this process only: nothing here is written to a
 * database, nothing is read from Kapso and no WhatsApp message is ever sent.
 * Restarting the server forgets it. `previewEnabled` is the gate in
 * domain/inbox-preview-gate.ts: off in production, off without
 * STUDIO_INBOX_PREVIEW=1, off for any database that is not local.
 *
 * Every name and number below is invented; the numbers are in a range nobody
 * owns. None of it is, or stands in for, the company's WhatsApp.
 * ------------------------------------------------------------------------- */

export const previewEnabled = (): boolean => previewAllowed({ NODE_ENV: process.env.NODE_ENV, STUDIO_INBOX_PREVIEW: process.env.STUDIO_INBOX_PREVIEW, DATABASE_URL: process.env.DATABASE_URL });

type PMsg = Omit<MessageView, "at" | "status"> & { at: Date; status: MessageStatus | null; /** Sent from this preview: its status moves with the clock. */ liveSince: number | null; clientKey: string | null };
type PConv = Omit<ConversationRow, "windowOpen" | "windowClosesAt" | "lastMessageText" | "lastMessageAt"> & { messages: PMsg[] };

type Store = { convs: PConv[] };
const g = globalThis as unknown as { __studioInboxPreview?: Store };

const H = 3_600_000;
const M = 60_000;

let seq = 0;
const mid = () => `preview-${++seq}`;

function msg(direction: "inbound" | "outbound", ago: number, body: string | null, over: Partial<PMsg> = {}): PMsg {
  return {
    id: mid(),
    direction,
    type: "text",
    body,
    caption: null,
    hasMedia: false,
    mediaType: null,
    status: direction === "outbound" ? "read" : null,
    errorText: null,
    origin: "cloud_api",
    at: new Date(Date.now() - ago),
    sentByName: direction === "outbound" ? "Priya Sharma" : null,
    posterId: null,
    liveSince: null,
    clientKey: null,
    ...over,
  };
}

async function build(): Promise<Store> {
  /* The sample posters in the chats are the generic preview pictures, never a poster from the database. */
  const poster = "pvp-1";
  const conv = (id: string, title: string, nameSource: PConv["nameSource"], phone: string, unread: number, messages: PMsg[], over: Partial<PConv> = {}): PConv => ({
    id,
    phone,
    title,
    nameSource,
    customerId: nameSource === "crm" ? `preview-customer-${id}` : null,
    contactName: nameSource === "whatsapp" ? title : null,
    lastInboundAt: messages.filter((m) => m.direction === "inbound").map((m) => m.at).sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
    unread,
    blocked: null,
    messages,
    ...over,
  });
  const convs: PConv[] = [
    conv("pv-1", "Sharma Paints & Hardware", "crm", "919000000101", 2, [
      msg("outbound", 26 * H, "Namaste Sharma ji, Diwali ke liye aapka poster taiyaar hai.", { sentByName: "Priya Sharma" }),
      msg("outbound", 26 * H - M, null, { type: "image", hasMedia: true, mediaType: "image/jpeg", caption: "Happy Diwali from Mahek Marketing! 🪔 Wishing you and your family a bright and prosperous season.", posterId: poster, status: "read" }),
      msg("inbound", 3 * H, "Poster bahut accha hai, thank you!"),
      msg("inbound", 2 * H + 10 * M, "Kya hum isko shop ke bahar laga sakte hain? Print size kya hogi?"),
      msg("inbound", 12 * M, "Aur ek 20 litre PU thinner ka rate bhi bhej dijiye."),
    ]),
    conv("pv-2", "Gupta Colour House", "crm", "919000000102", 0, [
      msg("outbound", 5 * H, null, { type: "image", hasMedia: true, mediaType: "image/jpeg", caption: "Season's greetings from Mahek Marketing.", posterId: poster, status: "delivered" }),
      msg("outbound", 5 * H - 2 * M, "Gupta ji, poster dekh lijiye, aapka naam aur number daal diya hai.", { status: "delivered" }),
      msg("inbound", 4 * H + 30 * M, "Received. Thanks 🙏"),
    ]),
    conv("pv-3", "Rajesh Bhai", "whatsapp", "919000000103", 1, [
      msg("inbound", 40 * M, "Hello, mujhe aapki thinner ki dealership ke baare mein jaanna hai."),
      msg("inbound", 38 * M, null, { type: "image", hasMedia: true, mediaType: "image/jpeg", caption: "Meri shop ki photo" }),
      msg("inbound", 37 * M, "Pune mein shop hai, 10 saal se paint ka business."),
    ]),
    conv("pv-4", "+91 90000 00104", "number", "919000000104", 0, [
      msg("inbound", 8 * H, "Price list please"),
      msg("outbound", 7 * H + 40 * M, "Namaste! Price list abhi bhej rahe hain. Aapka shehar?", { status: "sent" }),
    ]),
    conv("pv-5", "Mehta Traders", "crm", "919000000105", 0, [
      msg("inbound", 30 * H, "Order ka status batayein, bill number MMI/26-27/1119."),
      msg("outbound", 29 * H + 50 * M, "Mehta ji, dispatch ho chuka hai, LR number kal tak mil jayega.", { status: "read" }),
      msg("outbound", 2 * H, "Reminder: aapka payment due hai.", {
        status: "failed",
        errorText: "More than 24 hours have passed since the recipient last replied. Use an approved template.",
      }),
    ]),
    conv(
      "pv-6",
      "Patel & Sons",
      "crm",
      "919000000106",
      0,
      [msg("inbound", 3 * H, "Please stop sending promotional messages."), msg("outbound", 2 * H + 55 * M, "Sorry for the trouble — we will not message you again.", { status: "read" })],
      { blocked: "do_not_contact" },
    ),
    conv(
      "pv-9",
      "Verma Colours",
      "crm",
      "919000000109",
      0,
      [msg("inbound", 4 * H, "Please do not send festival posters on WhatsApp, call me instead."), msg("outbound", 3 * H + 50 * M, "Noted Verma ji — we will call you from now on.", { status: "read" })],
      { blocked: "whatsapp_dnd" },
    ),
    conv("pv-7", "Kumar Hardware", "crm", "919000000107", 0, [
      msg("inbound", 6 * H, "Bhai kal sample bhej do 5 litre ka"),
      msg("outbound", 5 * H + 45 * M, "Haan Kumar ji, kal subah tak pahunch jayega.", { origin: "business_app", sentByName: null, status: "read" }),
      msg("inbound", 5 * H + 40 * M, "Theek hai 👍"),
    ]),
    conv("pv-8", "Singh Paints", "crm", "919000000108", 0, [
      msg("inbound", 50 * H, "Namaste, aapke paas wood lacquer ka stock hai?"),
      msg("outbound", 49 * H, "Haan Singh ji, M2750 Wood Lacquer available hai. Kitna chahiye?", { status: "read" }),
      msg("inbound", 48 * H, "20 litre."),
      msg("outbound", 47 * H, "Ho jayega. Rate ₹ bheja ja raha hai.", { status: "read" }),
      msg("inbound", 22 * H, "Rate theek hai, order confirm."),
      msg("outbound", 21 * H, "Thank you Singh ji! Order accounts ko bhej diya hai.", { status: "read" }),
      msg("inbound", 1 * H + 5 * M, "Dispatch kab tak hoga?"),
    ]),
  ];
  return { convs };
}

let building: Promise<Store> | null = null;
async function store(): Promise<Store> {
  if (g.__studioInboxPreview) return g.__studioInboxPreview;
  building ??= build().then((s) => (g.__studioInboxPreview = s));
  return building;
}

/** A message sent from the preview moves sent → delivered → read with the clock, so the ticks can be seen changing. */
function statusNow(m: PMsg): MessageStatus | null {
  if (m.direction !== "outbound" || m.liveSince === null) return m.status;
  const age = Date.now() - m.liveSince;
  return age < 3000 ? "sent" : age < 8000 ? "delivered" : "read";
}

const last = (c: PConv) => c.messages.reduce((a, b) => (b.at.getTime() >= a.at.getTime() ? b : a));

function row(c: PConv): ConversationRow {
  const l = last(c);
  const w = windowState(c.lastInboundAt, new Date());
  return {
    id: c.id,
    phone: c.phone,
    title: c.title,
    nameSource: c.nameSource,
    customerId: c.customerId,
    contactName: c.contactName,
    lastMessageText: previewOf({ type: l.type, body: l.body, caption: l.caption, hasMedia: l.hasMedia }),
    lastMessageAt: l.at,
    lastInboundAt: c.lastInboundAt,
    unread: c.unread,
    windowOpen: w.open,
    windowClosesAt: w.closesAt,
    blocked: c.blocked,
  };
}

export async function previewList(q: string): Promise<ConversationRow[]> {
  const s = await store();
  const needle = q.trim().toLowerCase();
  const rows = s.convs.map(row).filter((r) => !needle || r.title.toLowerCase().includes(needle) || (r.phone ?? "").includes(needle.replace(/\D/g, "") || "\u0000"));
  return rows.sort((a, b) => (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0));
}

export async function previewConversation(id: string): Promise<ConversationRow | null> {
  const c = (await store()).convs.find((x) => x.id === id);
  return c ? row(c) : null;
}

export async function previewThread(id: string): Promise<MessageView[]> {
  const c = (await store()).convs.find((x) => x.id === id);
  if (!c) return [];
  return [...c.messages]
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map((m) => ({ id: m.id, direction: m.direction, type: m.type, body: m.body, caption: m.caption, hasMedia: m.hasMedia, mediaType: m.mediaType, status: statusNow(m), errorText: m.errorText, origin: m.origin, at: m.at, sentByName: m.sentByName, posterId: m.posterId }));
}

export async function previewMarkRead(id: string) {
  const c = (await store()).convs.find((x) => x.id === id);
  if (c) c.unread = 0;
}

/** A send from the preview: the same checks the real send makes, then a line added to the sample chat. Nothing leaves this process. */
export async function previewSend(
  userId: string,
  conversationId: string,
  clientKey: string,
  draft: { kind: "text"; body: string } | { kind: "poster"; caption: string; posterId: string | null },
): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
  const c = (await store()).convs.find((x) => x.id === conversationId);
  if (!c) return { ok: false, error: "That conversation was not found." };
  if (c.blocked === "do_not_contact") return { ok: false, error: "This customer is marked do not contact, so nothing can be sent to them from the Studio." };
  if (c.blocked === "whatsapp_dnd") return { ok: false, error: "This customer has asked not to be messaged on WhatsApp, so nothing can be sent to them from the Studio." };
  if (!windowState(c.lastInboundAt, new Date()).open) return { ok: false, error: WINDOW_CLOSED_MESSAGE };
  const dup = c.messages.find((m) => m.clientKey === clientKey);
  if (dup) return { ok: true, messageId: dup.id };
  const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
  const m: PMsg = {
    id: mid(),
    direction: "outbound",
    type: draft.kind === "poster" ? "image" : "text",
    body: draft.kind === "text" ? draft.body : null,
    caption: draft.kind === "poster" ? draft.caption || null : null,
    hasMedia: draft.kind === "poster",
    mediaType: draft.kind === "poster" ? "image/jpeg" : null,
    status: "sent",
    errorText: null,
    origin: "cloud_api",
    at: new Date(),
    sentByName: u?.name ?? null,
    posterId: draft.kind === "poster" ? draft.posterId : null,
    liveSince: Date.now(),
    clientKey,
  };
  c.messages.push(m);
  return { ok: true, messageId: m.id };
}
