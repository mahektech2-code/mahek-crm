/* ---------------------------------------------------------------------------
 * FOLLOW-UP INSIDE THE CALL FORM — the vocabulary, pure and client-safe.
 *
 * A follow-up is "send this lead something": a product image, the brochure or
 * the price list. The three codes are the SAME ones `COMMUNICATION_ACTIONS`
 * uses for the Reach-out buttons (`product_image`, `brochure`, `price_list`) and
 * they resolve to the same library categories, so the call form and the
 * Communication tab can never disagree about which file is "the brochure".
 *
 * WHAT CLICKING ONE DOES: opens the lead's WhatsApp conversation and records that
 * it was opened. The person composes and sends in the WhatsApp screen with
 * whatever that screen supports; this feature sends nothing itself.
 *
 * WHAT A FOLLOW-UP IS NOT: a call. It never writes a `calls` row, so it is never
 * counted as Call 1/2/3, never satisfies a qualification answer and never moves a
 * stage.
 *
 * THE STATES, and only the first two are ours:
 *   requested        — recorded without opening WhatsApp;
 *   whatsapp_opened  — the WhatsApp conversation was opened for it;
 *   (confirmed sent) — only the WhatsApp screen can say that, from the
 *                      integration's own confirmation. This file has no such
 *                      state on purpose: clicking is never "sent".
 * ------------------------------------------------------------------------- */

export const FOLLOWUP_MATERIALS = [
  { code: "product_image", label: "Send a Product Image", short: "Product image", category: "marketing" },
  { code: "brochure", label: "Send the Brochure", short: "Brochure", category: "catalogue" },
  { code: "price_list", label: "Send the Price List", short: "Price list", category: "price_list" },
] as const;

export type FollowUpCode = (typeof FOLLOWUP_MATERIALS)[number]["code"];

export const FOLLOWUP_CODES: readonly FollowUpCode[] = FOLLOWUP_MATERIALS.map((m) => m.code);

export function isFollowUpCode(v: unknown): v is FollowUpCode {
  return typeof v === "string" && (FOLLOWUP_CODES as readonly string[]).includes(v);
}

export const followUpMaterial = (code: FollowUpCode) => FOLLOWUP_MATERIALS.find((m) => m.code === code)!;

/** What the page knows about the published file behind one material, if any (a hint for the person, never required). */
export type FollowUpDoc = {
  id: string;
  title: string;
  /** Where somebody opens it from (the attachment route); null where the document has no file. */
  fileHref: string | null;
};

export type FollowUpDocs = Partial<Record<FollowUpCode, FollowUpDoc>>;

export type FollowUpStatus = "requested" | "whatsapp_opened";

/** Where the lead's WhatsApp conversation opens. The existing screen; the same lead. */
export const whatsappHref = (customerId: string) => `/crm/whatsapp?customer=${encodeURIComponent(customerId)}`;

/** The sentence on the lead's timeline. Never says "sent". */
export function followUpSentence(
  code: FollowUpCode,
  title: string | null,
  status: FollowUpStatus,
  callNumber?: number | null,
): string {
  const m = followUpMaterial(code);
  const where = callNumber ? ` on Call ${callNumber}` : "";
  const what = title ? `${m.short} “${title}”` : m.short;
  return status === "whatsapp_opened"
    ? `Follow-up initiated${where}: ${what} — WhatsApp opened, send not confirmed`
    : `Follow-up${where}: ${what} requested — not yet sent`;
}

/** The future Promotional Studio hand-off. No URL is invented: until one exists it is simply not available. */
export const PROMO_STUDIO = { available: false, label: "Promotional Materials", note: "Coming soon" } as const;
