import { waNumber } from "@/lib/whatsapp-delivery";

/* ---------------------------------------------------------------------------
 * SHARING A PURCHASE ORDER — the rules, pure, so the dialog that offers them
 * and the action that sends them answer from one place.
 *
 * A PO goes by one of three ways: WhatsApp (through Wati where Wati can take
 * it, otherwise opened on the person's own WhatsApp with the message written),
 * email (sent from MahekOne with the PDF attached, otherwise opened in their
 * mail app), or a copied link. It goes to whoever is ticked — the vendor and
 * the receiving godown are offered from their own records — and to anybody
 * typed in as a mobile number or an email. Every message carries the link to
 * the PO's PDF, which opens with no sign-in.
 * ------------------------------------------------------------------------- */

export const SHARE_CHANNELS = ["whatsapp", "email", "link"] as const;
export type ShareChannel = (typeof SHARE_CHANNELS)[number];

export const CHANNEL_LABEL: Record<ShareChannel, string> = { whatsapp: "WhatsApp", email: "Email", link: "Copy link" };

/** Somebody the PO can be sent to, as the dialog lists them. */
export type ShareRecipient = {
  key: string;
  name: string;
  /** "Vendor", "Godown". */
  tag?: string;
  /** A WhatsApp-able number, country code and digits; null where there is none. */
  whatsapp: string | null;
  email: string | null;
  /** Ticked when the dialog opens. */
  checked: boolean;
};

/** One message to go: who, and where. */
export type ShareTarget = { recipient: string; address: string };

/** The longest message a person may write; WhatsApp's own ceiling is far above it. */
export const MAX_SHARE_MESSAGE = 2000;
/** How many people one share may reach — a PO is not a broadcast. */
export const MAX_SHARE_TARGETS = 10;

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

export function isEmail(s: string): boolean {
  return EMAIL.test(s.trim());
}

/** "+91 98200 11004" → "Mobile ••• 1004"; an email as it is. For the dialog's second line. */
export function addressLine(channel: ShareChannel, r: Pick<ShareRecipient, "whatsapp" | "email">): string | null {
  if (channel === "whatsapp") return r.whatsapp ? `WhatsApp +${r.whatsapp.slice(0, 2)} ${r.whatsapp.slice(2, 7)} ${r.whatsapp.slice(7)}` : null;
  if (channel === "email") return r.email;
  return null;
}

/** The vendor and the receiving godown, from their own records. The vendor is ticked; the godown is offered. */
export function poRecipients(po: {
  vendor: string;
  vendorPhone: string | null;
  vendorEmail: string | null;
  godown: string;
  godownPhone: string | null;
  godownEmail: string | null;
}): ShareRecipient[] {
  return [
    { key: "vendor", name: po.vendor, tag: "Vendor", whatsapp: waNumber(po.vendorPhone), email: po.vendorEmail?.trim() || null, checked: true },
    { key: "godown", name: `Godown — ${po.godown}`, tag: "Godown", whatsapp: waNumber(po.godownPhone), email: po.godownEmail?.trim() || null, checked: false },
  ];
}

/** "MEK 4 Litre and IPA 2 Litre"; past three items, the first two and how many more. */
export function itemsLine(lines: { item: string; quantity: number; unit: string }[]): string {
  const one = (l: { item: string; quantity: number; unit: string }) => `${l.item} (${l.quantity.toLocaleString("en-IN")} ${l.unit})`;
  if (!lines.length) return "the items listed";
  if (lines.length === 1) return one(lines[0]);
  if (lines.length <= 3) return `${lines.slice(0, -1).map(one).join(", ")} and ${one(lines[lines.length - 1])}`;
  return `${lines.slice(0, 2).map(one).join(", ")} and ${lines.length - 2} more items`;
}

/** The message the dialog opens with; the person may rewrite it. The link is added when it goes. */
export function defaultPoMessage(po: { vendor: string; name: string; items: string; total: string | null; deliverTo: string; deliveryBy: string; company: string }): string {
  return [
    `Dear ${po.vendor}, please find our purchase order ${po.name} for ${po.items}${po.total ? `, total ${po.total}` : ""}, delivery to our ${po.deliverTo} godown by ${po.deliveryBy}. Kindly confirm.`,
    `— ${po.company}`,
  ].join("\n");
}

/** The message as it is sent: what was written, then the PO's link. */
export function withLink(message: string, link: string | null): string {
  return link ? `${message.trim()}\n\nPurchase order (PDF): ${link}` : message.trim();
}

/** A wa.me link with the message written, for a WhatsApp opened on the person's own phone. */
export function waMeLink(number: string, message: string): string {
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}

export function mailtoLink(email: string, subject: string, message: string): string {
  return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`;
}

export type ShareRequest = { channel: ShareChannel; message: string; targets: ShareTarget[] };

/**
 * What the dialog sent, read and checked against who may be sent to. `to` is
 * the ticked recipient keys and `extra` whatever was typed — numbers and
 * emails, one per line or comma-separated. A typed entry the channel cannot
 * use is refused by name rather than dropped, so nobody believes a message
 * went to a number it never reached.
 */
export function readShare(
  values: { channel?: string; to?: string; extra?: string; message?: string },
  recipients: ShareRecipient[],
): { ok: true; value: ShareRequest } | { ok: false; field: string; error: string } {
  const channel = (values.channel ?? "") as ShareChannel;
  if (!SHARE_CHANNELS.includes(channel)) return { ok: false, field: "channel", error: "Choose WhatsApp, email or a link" };
  const message = (values.message ?? "").trim();
  if (channel !== "link" && !message) return { ok: false, field: "message", error: "Write the message" };
  if (message.length > MAX_SHARE_MESSAGE) return { ok: false, field: "message", error: `Keep the message under ${MAX_SHARE_MESSAGE} characters` };
  if (channel === "link") return { ok: true, value: { channel, message, targets: [] } };

  let keys: string[] = [];
  try {
    const parsed = JSON.parse(values.to || "[]");
    if (Array.isArray(parsed)) keys = parsed.filter((k): k is string => typeof k === "string");
  } catch {
    return { ok: false, field: "to", error: "Choose who it goes to" };
  }
  const targets: ShareTarget[] = [];
  const seen = new Set<string>();
  const add = (recipient: string, address: string) => {
    const k = address.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    targets.push({ recipient, address });
  };
  for (const key of keys) {
    const r = recipients.find((x) => x.key === key);
    if (!r) continue;
    const address = channel === "whatsapp" ? r.whatsapp : r.email;
    if (!address) return { ok: false, field: "to", error: `${r.name} has no ${channel === "whatsapp" ? "WhatsApp number" : "email"} on record — untick them or type one below` };
    add(r.name, address);
  }
  for (const raw of (values.extra ?? "").split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean)) {
    if (channel === "whatsapp") {
      const n = waNumber(raw);
      if (!n) return { ok: false, field: "extra", error: `${raw} is not a mobile number WhatsApp can reach` };
      add(raw, n);
    } else {
      if (!isEmail(raw)) return { ok: false, field: "extra", error: `${raw} is not an email address` };
      add(raw.toLowerCase(), raw.toLowerCase());
    }
  }
  if (!targets.length) return { ok: false, field: "to", error: "Tick somebody, or type a number or email" };
  if (targets.length > MAX_SHARE_TARGETS) return { ok: false, field: "to", error: `Send to at most ${MAX_SHARE_TARGETS} people at once` };
  return { ok: true, value: { channel, message, targets } };
}

/** A PO is shared once it is approved, and until it is closed: the statuses a vendor can act on. */
export const SHAREABLE_PO = ["Approved", "Sent", "Partly received", "Received"] as const;

/** "WhatsApp · 18 Oct" for the list's Last shared column. */
export function lastSharedLine(via: string | null, on: string | null): string | null {
  if (!via) return null;
  return on ? `${via} · ${on}` : via;
}
