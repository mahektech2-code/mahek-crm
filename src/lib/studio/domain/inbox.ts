/* ---------------------------------------------------------------------------
 * THE STUDIO'S WHATSAPP INBOX — the rules, pure.
 *
 * What Kapso says is stored as it arrives and shown as it arrives. Nothing
 * here guesses a delivery: a status only ever moves forward, a message is one
 * row however many times it is reported, and a reply is refused — in words —
 * when WhatsApp would refuse it.
 * ------------------------------------------------------------------------- */

export const MESSAGE_STATUSES = ["pending", "sent", "delivered", "read", "failed"] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const STATUS_LABEL: Record<MessageStatus, string> = {
  pending: "Sending",
  sent: "Sent",
  delivered: "Delivered",
  read: "Read",
  failed: "Failed",
};

/** What Kapso calls a status, folded onto ours. `received` is an inbound message and carries no delivery state. */
export function statusOf(raw: unknown): MessageStatus | null {
  const s = typeof raw === "string" ? raw.toLowerCase() : "";
  return (MESSAGE_STATUSES as readonly string[]).includes(s) ? (s as MessageStatus) : null;
}

const RANK: Record<MessageStatus, number> = { pending: 0, sent: 1, delivered: 2, read: 3, failed: 1 };

/**
 * A status never moves backwards — a late "delivered" must not demote "read" —
 * and a failure only replaces a message that has not been delivered: WhatsApp
 * does not un-deliver a message, so a failure arriving after delivery is
 * noise, not news.
 */
export function mergeStatus(current: MessageStatus | null, next: MessageStatus | null): MessageStatus {
  if (!next) return current ?? "pending";
  if (!current) return next;
  if (next === "failed") return RANK[current] >= 2 ? current : "failed";
  if (current === "failed") return RANK[next] >= 2 ? next : "failed";
  return RANK[next] > RANK[current] ? next : current;
}

/* ------------------------------------------------------------------ phones */

/** Digits only: "+91 98200-11111" → "919820011111". */
export const digitsOnly = (raw: string | null | undefined): string => (raw ?? "").replace(/\D/g, "");

/**
 * The key two spellings of one Indian mobile share: its last ten digits. A
 * customer's phone is typed "9820011111", "09820011111" or "+91 98200 11111",
 * and Kapso reports "919820011111" — all one person. Anything shorter than ten
 * digits has no key, so it can never match somebody by accident.
 */
export function phoneKey(raw: string | null | undefined): string | null {
  const d = digitsOnly(raw);
  return d.length >= 10 ? d.slice(-10) : null;
}

/** The number a message is sent to: country code included, digits only. A bare ten-digit Indian number gets 91. */
export function sendableNumber(raw: string | null | undefined): string | null {
  const d = digitsOnly(raw);
  if (d.length === 10) return `91${d}`;
  if (d.length >= 11 && d.length <= 15) return d;
  return null;
}

/* ------------------------------------------------------------------ window */

export const WINDOW_HOURS = 24;

/** WhatsApp lets a free-form reply through for 24 hours after the customer's last message; your own messages do not reopen it. */
export function windowState(lastInboundAt: Date | null, now: Date): { open: boolean; closesAt: Date | null } {
  if (!lastInboundAt) return { open: false, closesAt: null };
  const closesAt = new Date(lastInboundAt.getTime() + WINDOW_HOURS * 3_600_000);
  return { open: now.getTime() < closesAt.getTime(), closesAt };
}

export const WINDOW_CLOSED_MESSAGE =
  "WhatsApp only lets you send a free-form message or poster within 24 hours of the customer's last message. This conversation is outside that window, so it needs an approved template.";

/* --------------------------------------------------------------- limits */

export const TEXT_MAX = 4096;
export const CAPTION_MAX = 1024;
/** Meta's own ceiling for an image upload. */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export function checkText(body: string): string | null {
  const t = body.trim();
  if (!t) return "Write a message first.";
  if (t.length > TEXT_MAX) return `A message can be at most ${TEXT_MAX} characters.`;
  return null;
}
export function checkCaption(caption: string): string | null {
  return caption.length > CAPTION_MAX ? `A caption can be at most ${CAPTION_MAX} characters; this one is ${caption.length}.` : null;
}

/* ---------------------------------------------------------------- webhooks */

export type NormalMessage = {
  /** The WhatsApp message id (wamid). One row per id, whatever reports it. */
  wamid: string;
  direction: "inbound" | "outbound";
  type: string;
  body: string | null;
  caption: string | null;
  hasMedia: boolean;
  mediaType: string | null;
  mediaUrl: string | null;
  status: MessageStatus | null;
  /** cloud_api | business_app | history_sync — where the message was written. */
  origin: string | null;
  at: Date;
  errorCode: string | null;
  errorText: string | null;
};

export type NormalConversation = {
  id: string;
  phone: string | null;
  contactName: string | null;
  phoneNumberId: string | null;
  lastInboundAt: Date | null;
  lastMessageText: string | null;
  lastMessageAt: Date | null;
};

export type NormalEvent = { phoneNumberId: string | null; conversation: NormalConversation | null; message: NormalMessage | null };

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const date = (v: unknown): Date | null => {
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v);
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    const d = Number.isFinite(n) && /^\d+$/.test(v.trim()) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
};

/* Kapso describes a picture or file in words of its own - "Image attached (name) [Size | Type] URL: …", or the caption followed
   by "[Image attached]". That is a note for software, with a long download link in it, not anything either person wrote. */
const MEDIA_NOTE = /^(Image|Video|Audio|Document|Sticker) attached\b/;
const MEDIA_TAG = /\s*\[(?:Image|Video|Audio|Document|Sticker) attached\][\s\S]*$/;

/** What the two people wrote on a message with a file. Applied as it arrives AND as it is read, so rows already stored are shown clean. */
export function mediaWords(hasMedia: boolean, body: string | null, caption: string | null): { body: string | null; caption: string | null } {
  if (!hasMedia || !body) return { body, caption };
  if (MEDIA_NOTE.test(body)) return { body: null, caption };
  if (MEDIA_TAG.test(body)) return { body: null, caption: caption ?? str(body.replace(MEDIA_TAG, "").trim()) };
  return { body, caption };
}

/** The same for the one line in the conversation list, where only the text is stored. */
export function listText(text: string | null): string | null {
  if (!text) return text;
  const note = MEDIA_NOTE.exec(text);
  if (note) return note[1] === "Image" ? "📷 Photo" : note[1] === "Video" ? "🎞 Video" : note[1] === "Audio" ? "🎤 Voice message" : note[1] === "Document" ? "📄 Document" : "Attachment";
  return text.replace(MEDIA_TAG, "").trim() || "Attachment";
}

/** A Kapso message (the shape `GET /whatsapp/messages` and every webhook share) → ours. Null where it names no id. */
export function normalizeMessage(raw: unknown): NormalMessage | null {
  const m = obj(raw);
  if (!m) return null;
  const wamid = str(m.id);
  if (!wamid) return null;
  const k = obj(m.kapso) ?? {};
  const type = str(m.type) ?? "text";
  const direction = k.direction === "outbound" ? "outbound" : "inbound";
  const payload = obj(m[type]);
  const text = obj(m.text);
  const media = obj(k.media_data);
  const statuses = Array.isArray(k.statuses) ? k.statuses : [];
  const lastError = [...statuses].reverse().map((s) => obj(s)).find((s) => s && Array.isArray(s.errors) && s.errors.length);
  const err = lastError ? obj((lastError.errors as unknown[])[0]) : null;
  const body = type === "text" ? str(text?.body) : str(k.content) ?? str(payload?.caption);
  const hasMedia = Boolean(k.has_media) || (type !== "text" && ["image", "video", "audio", "document", "sticker"].includes(type));
  const words = mediaWords(hasMedia, body, str(payload?.caption));
  return {
    wamid,
    direction,
    type,
    body: words.body,
    caption: words.caption,
    hasMedia,
    mediaType: str(media?.content_type) ?? (hasMedia ? type : null),
    mediaUrl: str(k.media_url) ?? str(media?.url),
    status: direction === "outbound" ? statusOf(k.status) : null,
    origin: str(k.origin),
    at: date(m.timestamp) ?? new Date(),
    errorCode: err && err.code != null ? String(err.code) : null,
    errorText: err ? str(err.message) ?? str(err.title) : null,
  };
}

export function normalizeConversation(raw: unknown, fallbackPhoneNumberId: string | null = null): NormalConversation | null {
  const c = obj(raw);
  if (!c) return null;
  const id = str(c.id);
  if (!id) return null;
  const k = obj(c.kapso) ?? {};
  return {
    id,
    phone: str(c.phone_number),
    contactName: str(k.contact_name),
    phoneNumberId: str(c.phone_number_id) ?? fallbackPhoneNumberId,
    lastInboundAt: date(k.last_inbound_at),
    lastMessageText: str(k.last_message_text),
    lastMessageAt: date(k.last_message_timestamp),
  };
}

export const MESSAGE_EVENTS = [
  "whatsapp.message.received",
  "whatsapp.message.sent",
  "whatsapp.message.delivered",
  "whatsapp.message.read",
  "whatsapp.message.failed",
] as const;
export type MessageEvent = (typeof MESSAGE_EVENTS)[number];
export const isMessageEvent = (e: string | null): e is MessageEvent => !!e && (MESSAGE_EVENTS as readonly string[]).includes(e);

/** The status an event name itself asserts, for a payload whose own `kapso.status` is missing. */
const EVENT_STATUS: Partial<Record<MessageEvent, MessageStatus>> = {
  "whatsapp.message.sent": "sent",
  "whatsapp.message.delivered": "delivered",
  "whatsapp.message.read": "read",
  "whatsapp.message.failed": "failed",
};

/**
 * A v2 webhook body. The event NAME is in the `X-Webhook-Event` header and not
 * in the body, so it is handed in. A body that carries no message (or no
 * conversation) is not an error — it just contributes nothing.
 */
export function parseWebhook(event: MessageEvent, body: unknown): NormalEvent {
  const b = obj(body) ?? {};
  const phoneNumberId = str(b.phone_number_id);
  const conversation = normalizeConversation(b.conversation, phoneNumberId);
  const message = normalizeMessage(b.message);
  if (message) {
    const asserted = EVENT_STATUS[event] ?? null;
    if (message.direction === "outbound") message.status = mergeStatus(message.status, asserted);
  }
  return { phoneNumberId, conversation, message };
}

/** The last words of a conversation, as the list shows them. */
export function previewOf(m: Pick<NormalMessage, "type" | "body" | "caption" | "hasMedia">): string {
  if (m.body) return m.body.slice(0, 140);
  if (m.caption) return m.caption.slice(0, 140);
  if (m.hasMedia) return m.type === "image" ? "📷 Photo" : m.type === "document" ? "📄 Document" : m.type === "audio" ? "🎤 Voice message" : m.type === "video" ? "🎞 Video" : "Attachment";
  return m.type === "reaction" ? "Reaction" : "Message";
}
