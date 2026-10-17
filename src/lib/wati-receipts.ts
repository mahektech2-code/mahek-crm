/* ---------------------------------------------------------------------------
 * READING THE TICKS BACK FROM WATI, for when the webhook does not bring them.
 *
 * Delivered and read are meant to arrive as webhook events. On production
 * none ever did: 241 messages in a fortnight, not one marked delivered or
 * read, while Wati's own history showed READ against the same messages — so
 * every message on every screen sat at one grey tick. Whatever the webhook is
 * subscribed to, the history is the record Wati itself keeps, so it is asked
 * directly: when a chat is opened, and hourly for the last week.
 *
 * Matching one of our rows to one of Wati's items:
 *  - a typed reply carries Wati's own message id as `provider_ref` — exact;
 *  - a template carries no id of Wati's (the send answers with a broadcast
 *    id), so it is the outgoing item sent within a few minutes of ours whose
 *    words begin the same way. Words are required, not just time: two
 *    reminders a minute apart to one number must not trade ticks.
 *
 * PURE, so the matching can be tested without Wati or a database. Status only
 * ever moves forward; that is `advancedStatus`, applied by the caller.
 * ------------------------------------------------------------------------- */

export type ReceiptStatus = "sent" | "delivered" | "read";

export type OurSentMessage = {
  id: string;
  providerRef: string | null;
  sentAt: Date;
  body: string;
};

export type WatiOutgoingItem = {
  id?: string | null;
  eventType?: string | null;
  owner?: boolean | null;
  statusString?: string | null;
  created?: string | null;
  text?: string | null;
  finalText?: string | null;
};

/** How far apart our send and Wati's record of it may be. */
export const MATCH_WINDOW_MS = 5 * 60_000;
/** How much of the words have to agree. */
const PREFIX = 24;

export function receiptStatusOf(statusString: string | null | undefined): ReceiptStatus | null {
  switch ((statusString ?? "").toUpperCase()) {
    case "READ":
      return "read";
    case "DELIVERED":
      return "delivered";
    case "SENT":
      return "sent";
    default:
      // FAILED comes through the webhook WITH its reason; read here it would
      // be a failure nobody could explain. Anything else is not a tick.
      return null;
  }
}

/** One of ours, as opposed to the customer's. */
function isOutgoing(item: WatiOutgoingItem): boolean {
  const type = (item.eventType ?? "").toLowerCase();
  if (type === "broadcastmessage" || type === "templatemessage") return true;
  return type === "message" && item.owner === true;
}

/** Words compared without WhatsApp's bold, italic and strike marks, or spacing. */
export function wordsKey(text: string | null | undefined): string {
  return (text ?? "")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, PREFIX);
}

export function matchReceipts(
  ours: OurSentMessage[],
  items: WatiOutgoingItem[],
): Array<{ messageId: string; status: ReceiptStatus }> {
  const out: Array<{ messageId: string; status: ReceiptStatus }> = [];
  const candidates = items.filter(isOutgoing).filter((i) => receiptStatusOf(i.statusString));
  const used = new Set<WatiOutgoingItem>();

  // Exact first, so an id match can never be taken by a time-and-words guess.
  const rest: OurSentMessage[] = [];
  for (const m of ours) {
    const hit = m.providerRef ? candidates.find((i) => i.id === m.providerRef && !used.has(i)) : undefined;
    if (hit) {
      used.add(hit);
      out.push({ messageId: m.id, status: receiptStatusOf(hit.statusString)! });
    } else {
      rest.push(m);
    }
  }

  for (const m of [...rest].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())) {
    const key = wordsKey(m.body);
    if (!key) continue;
    let best: WatiOutgoingItem | null = null;
    let bestGap = Infinity;
    for (const i of candidates) {
      if (used.has(i) || !i.created) continue;
      const gap = Math.abs(Date.parse(i.created) - m.sentAt.getTime());
      if (!(gap <= MATCH_WINDOW_MS) || gap >= bestGap) continue;
      if (wordsKey(i.finalText || i.text) !== key) continue;
      best = i;
      bestGap = gap;
    }
    if (best) {
      used.add(best);
      out.push({ messageId: m.id, status: receiptStatusOf(best.statusString)! });
    }
  }
  return out;
}

/** The number as Wati's history is keyed: country code and ten digits. */
export function watiWaId(destination: string): string | null {
  const ten = destination.replace(/\D/g, "").slice(-10);
  return /^[6-9]\d{9}$/.test(ten) ? `91${ten}` : null;
}
