/* ---------------------------------------------------------------------------
 * THE TIMELINE'S VOCABULARY — pure.
 *
 * Two kinds of fact live on the Timeline and they are never worded alike:
 *   - what a PERSON said or did (opened a chat, marked it sent, downloaded it) — `action`, always
 *     phrased as theirs ("Marked sent by Priya") and never as a delivery;
 *   - what KAPSO reported about a message it was handed (sent, delivered, read, failed) — read from the
 *     message itself, shown with "(Kapso)" so it cannot be mistaken for a person's claim.
 * ------------------------------------------------------------------------- */

export const ACTIVITY_KINDS = ["poster", "brochure", "price_list", "video", "image", "product_info", "message"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export const KIND_LABEL: Record<ActivityKind, string> = {
  poster: "Poster",
  brochure: "Brochure",
  price_list: "Price list",
  video: "Video",
  image: "Image",
  product_info: "Product information",
  message: "Message",
};

export const MODES = ["individual", "bulk", "inbox", "forward_manual"] as const;
export type ActivityMode = (typeof MODES)[number];
export const MODE_LABEL: Record<ActivityMode, string> = { individual: "Individually", bulk: "In bulk", inbox: "From the Inbox", forward_manual: "Forward, by hand" };

export const CHANNELS = ["kapso", "whatsapp_chat", "download", "device", "studio"] as const;
export type ActivityChannel = (typeof CHANNELS)[number];

export const ACTIONS = ["kapso_handed", "not_sent", "chat_opened", "marked_sent", "marked_skipped", "marked_undone", "downloaded", "shared_device", "batch_generated", "zip_downloaded", "zip_downloaded_batch"] as const;
export type ActivityAction = (typeof ACTIONS)[number];

/** What a person or the system did, in words that claim no more than that. */
export const ACTION_LABEL: Record<ActivityAction, string> = {
  kapso_handed: "Handed to Kapso",
  not_sent: "Not sent",
  chat_opened: "Chat opened (by hand)",
  marked_sent: "Marked as sent by the sender",
  marked_skipped: "Skipped by the sender",
  marked_undone: "Mark undone by the sender",
  downloaded: "Downloaded",
  shared_device: "Shared from the phone",
  /* A bulk run, and a ZIP of it, are things somebody MADE and SAVED. None of them is a send, and none says or implies one. */
  batch_generated: "Generated as a bulk run (nothing sent)",
  zip_downloaded: "Downloaded in a ZIP (not sent)",
  zip_downloaded_batch: "ZIP of the whole run downloaded (not sent)",
};

/** Actions whose row is about a whole run, not one recipient: drawn without a "To". */
export const BATCH_ACTIONS: readonly ActivityAction[] = ["batch_generated", "zip_downloaded_batch"];

/** The Kapso message states, as Kapso reported them. "pending" is OUR reservation before Kapso answered. */
export type ProviderState = "pending" | "sent" | "delivered" | "read" | "failed";
export const PROVIDER_LABEL: Record<ProviderState, string> = { pending: "Sending…", sent: "Sent (Kapso)", delivered: "Delivered (Kapso)", read: "Read (Kapso)", failed: "Failed (Kapso)" };

export type Tone = "neutral" | "success" | "danger" | "brand";

/**
 * The one status a row shows. A Kapso send shows what Kapso reported; everything else shows the person's own act,
 * and `not_sent` shows as not sent. A user-marked act is NEVER given a delivery word.
 */
export function statusOf(a: { action: ActivityAction; channel: ActivityChannel; provider: ProviderState | null }): { label: string; tone: Tone; confirmedByProvider: boolean } {
  if (a.channel === "kapso" && a.action === "kapso_handed") {
    if (a.provider) return { label: PROVIDER_LABEL[a.provider], tone: a.provider === "failed" ? "danger" : a.provider === "pending" ? "neutral" : "success", confirmedByProvider: a.provider !== "pending" };
    return { label: ACTION_LABEL.kapso_handed, tone: "neutral", confirmedByProvider: false };
  }
  return { label: ACTION_LABEL[a.action], tone: a.action === "not_sent" ? "danger" : "neutral", confirmedByProvider: false };
}

/** A filter the Timeline accepts, cleaned: anything unknown is dropped rather than guessed. */
export type TimelineFilter = { q?: string; sender?: string; kind?: ActivityKind; from?: string; to?: string; page?: number };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
export function cleanFilter(raw: Record<string, string | undefined>): TimelineFilter {
  const kind = (ACTIVITY_KINDS as readonly string[]).includes(raw.kind ?? "") ? (raw.kind as ActivityKind) : undefined;
  const day = (v: string | undefined) => (v && ISO_DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : undefined);
  const page = Number.parseInt(raw.page ?? "1", 10);
  return {
    ...(raw.q?.trim() ? { q: raw.q.trim().slice(0, 80) } : {}),
    ...(raw.sender?.trim() ? { sender: raw.sender.trim().slice(0, 80) } : {}),
    ...(kind ? { kind } : {}),
    ...(day(raw.from) ? { from: day(raw.from)! } : {}),
    ...(day(raw.to) ? { to: day(raw.to)! } : {}),
    page: Number.isFinite(page) && page > 0 && page < 10_000 ? page : 1,
  };
}

export const TIMELINE_PAGE = 30;
