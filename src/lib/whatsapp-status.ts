/* ---------------------------------------------------------------------------
 * What a WhatsApp message's status MEANS, in one place — pure, client-safe.
 *
 * Two kinds of evidence, and the words must never blur them:
 *   API sends carry WhatsApp's own receipts: sent ✓, delivered ✓✓, read ✓✓
 *     (blue). Read only arrives if the customer has read receipts on; a
 *     message that stays at "delivered" may well have been read.
 *   Manual sends carry a PERSON's word: "confirmed sent" means somebody pressed
 *     the button after pasting. WhatsApp never tells us whether a pasted
 *     message arrived or was read, so the screen says so rather than showing
 *     ticks it cannot back.
 * ------------------------------------------------------------------------- */

export type TrackedMessage = {
  status: string;
  mode: string;
  preparedAt: string;
  sentAt: string | null;
  confirmedSentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failureReason: string | null;
  /** A reply from the customer after this message went. */
  repliedAt?: string | null;
};

export type StatusView = {
  label: string;
  ticks: "" | "✓" | "✓✓";
  tone: "success" | "brand" | "warn" | "danger" | "muted";
  /** When the message reached this state. */
  at: string | null;
  /** A sentence for the hover: what this state does and does not prove. */
  explain: string;
};

export function statusView(m: TrackedMessage): StatusView {
  const api = m.mode === "automatic";
  switch (m.status) {
    case "read":
      return { label: "Read", ticks: "✓✓", tone: "brand", at: m.readAt ?? m.deliveredAt ?? m.sentAt, explain: "WhatsApp reported the customer opened it." };
    case "delivered":
      return { label: "Delivered", ticks: "✓✓", tone: "success", at: m.deliveredAt ?? m.sentAt, explain: "On the customer's phone. Not opened yet — or they have read receipts turned off, in which case it will never show as read." };
    case "sent":
      return { label: "Sent", ticks: "✓", tone: "success", at: m.sentAt, explain: "Accepted by WhatsApp. The delivered tick comes when it reaches the phone." };
    case "sent_manually":
      return { label: "Confirmed sent", ticks: "", tone: "success", at: m.confirmedSentAt, explain: "A person pasted it into WhatsApp and confirmed. WhatsApp gives no delivery or read receipt for a pasted message." };
    case "queued":
      return { label: "Sending", ticks: "", tone: "muted", at: m.preparedAt, explain: "Handed to WhatsApp a moment ago." };
    case "copied":
      return { label: "Copied, not confirmed", ticks: "", tone: "warn", at: m.preparedAt, explain: "Copied to paste but nobody confirmed it went — it may or may not have been sent." };
    case "failed":
      return { label: "Failed", ticks: "", tone: "danger", at: m.sentAt ?? m.preparedAt, explain: m.failureReason ?? (api ? "WhatsApp did not deliver it." : "It did not go.") };
    case "cancelled":
      return { label: "Not sent", ticks: "", tone: "muted", at: m.preparedAt, explain: m.failureReason ?? "Discarded before it went." };
    default:
      return { label: "Prepared", ticks: "", tone: "muted", at: m.preparedAt, explain: "Written, not sent." };
  }
}

/** Whether this counts as having reached the customer, for the funnel. */
export const REACHED = new Set(["sent", "sent_manually", "delivered", "read"]);
