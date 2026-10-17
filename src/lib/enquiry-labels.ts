/* ---------------------------------------------------------------------------
 * The enquiry vocabulary — stages, priorities and activity kinds — pure and
 * client-safe. Three screens (the list, the dashboard, the detail page) all
 * say the same thing about a stage; written out three times they would drift,
 * the same reasoning `next-step-labels.ts` and `complaint-labels.ts` already
 * follow for their own screens.
 * ------------------------------------------------------------------------- */

import type { Tone } from "@/components/ui/primitives";
import { ENQUIRY_SOURCE_FORM_TYPES, ENQUIRY_SOURCE_CATEGORIES } from "./enquiry-ingest-validation";

export const ENQUIRY_STAGES = [
  "new",
  "contacted",
  "follow_up",
  "qualified",
  "converted",
  "closed",
] as const;
export type EnquiryStage = (typeof ENQUIRY_STAGES)[number];

export const STAGE_LABEL: Record<EnquiryStage, string> = {
  new: "New",
  contacted: "Contacted",
  follow_up: "Follow-up",
  qualified: "Qualified",
  converted: "Converted",
  closed: "Closed",
};

export const STAGE_TONE: Record<EnquiryStage, Tone> = {
  new: "brand",
  contacted: "neutral",
  follow_up: "warn",
  qualified: "brand",
  converted: "success",
  closed: "muted",
};

export function isTerminalStage(stage: EnquiryStage): boolean {
  return stage === "converted" || stage === "closed";
}

export const ENQUIRY_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type EnquiryPriority = (typeof ENQUIRY_PRIORITIES)[number];

export const PRIORITY_LABEL: Record<EnquiryPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

export const PRIORITY_TONE: Record<EnquiryPriority, Tone> = {
  low: "muted",
  normal: "neutral",
  high: "warn",
  urgent: "danger",
};

/**
 * The stored value, not the display text — `createEnquiryFromWebsite` writes
 * `source: "website"`, lowercase, and a filter built on the label instead
 * (`"Website"`) matches no row at all. The rest of these are not written by
 * any code path yet — the enquiries table's own migration comment names
 * Instagram, WhatsApp and IndiaMART as sources "tomorrow" — so they are
 * provisioned here, lowercase to match the one real convention that exists,
 * for whenever an ingestion path for them is built.
 */
export const ENQUIRY_SOURCES = [
  "website",
  "instagram",
  "facebook",
  "whatsapp",
  "indiamart",
  "google",
  "manual",
  "other",
] as const;
export type EnquirySource = (typeof ENQUIRY_SOURCES)[number];

export const SOURCE_LABEL: Record<EnquirySource, string> = {
  website: "Website",
  instagram: "Instagram",
  facebook: "Facebook",
  whatsapp: "WhatsApp",
  indiamart: "IndiaMART",
  google: "Google",
  manual: "Manual",
  other: "Other",
};

/**
 * The display label for a `source` value, wherever one is rendered as text
 * rather than as the filter's own `<option>` (which already pairs
 * `value={s}` with `label={SOURCE_LABEL[s]}` correctly). `source` is stored
 * as free text — "this list grows without a migration" — so a value outside
 * `SOURCE_LABEL` is a real possibility, not a bug, and falls back to itself
 * rather than rendering blank.
 */
export function sourceLabel(value: string): string {
  return (SOURCE_LABEL as Record<string, string>)[value] ?? value;
}

/**
 * `source_form` (aka the website's own `formType`) is a second enum stored on
 * `enquiries` — CONTACT, QUOTE, SAMPLE and the rest, see
 * `enquiry-ingest-validation.ts`'s own list, imported rather than retyped so
 * the two cannot drift apart. Shown raw today, exactly like `source` was.
 */
export const SOURCE_FORM_LABEL: Record<(typeof ENQUIRY_SOURCE_FORM_TYPES)[number], string> = {
  CONTACT: "Contact",
  QUICK_ENQUIRY: "Quick Enquiry",
  PRODUCT_ENQUIRY: "Product Enquiry",
  DISTRIBUTOR: "Distributor",
  TECHNICAL_ENQUIRY: "Technical Enquiry",
  QUOTE: "Quote",
  SAMPLE: "Sample",
  CAREER: "Career",
};

/**
 * Same fallback discipline as `sourceLabel` — `sourceForm` is nullable, and a
 * value outside the known list (the website adding a ninth form before this
 * list is updated) shows itself rather than nothing.
 */
export function sourceFormLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return (SOURCE_FORM_LABEL as Record<string, string>)[value] ?? value;
}

/**
 * `category` — the website's own coarse classification of the submission
 * (GENERAL, SALES, DISTRIBUTOR, CAREER, LOGISTICS), a sibling of `sourceForm`
 * rather than part of it — see `enquiries.category`'s own schema comment.
 * Validated at the ingestion boundary against `ENQUIRY_SOURCE_CATEGORIES`,
 * imported rather than retyped so the two cannot drift apart, but stored as
 * free text like `sourceForm` — a ninth category the website adds needs no
 * migration here, so the label falls back to the value itself.
 */
export const CATEGORY_LABEL: Record<(typeof ENQUIRY_SOURCE_CATEGORIES)[number], string> = {
  GENERAL: "General",
  SALES: "Sales",
  DISTRIBUTOR: "Distributor",
  CAREER: "Career",
  LOGISTICS: "Logistics",
};

/** Same fallback discipline as `sourceFormLabel` — nullable, and an unrecognised value shows itself rather than nothing. */
export function categoryLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return (CATEGORY_LABEL as Record<string, string>)[value] ?? value;
}

/**
 * The six reminder types this enquiry form offers — the same
 * `reminder_type` column and the same six values the rest of the CRM's
 * reminders already use (`src/db/schema.ts`'s `reminderTypeEnum`). One map,
 * read by both the create form's own `<option>` list and by the read side
 * that lists reminders already scheduled — they used to say two different
 * things about the same value, because only the form had labels.
 */
export const ENQUIRY_REMINDER_TYPES = [
  "call_back",
  "payment_promise",
  "order_confirmation",
  "send_information",
  "check_stock",
  "other",
] as const;
export type EnquiryReminderType = (typeof ENQUIRY_REMINDER_TYPES)[number];

export const REMINDER_TYPE_LABEL: Record<EnquiryReminderType, string> = {
  call_back: "Call back",
  payment_promise: "Payment promise",
  order_confirmation: "Order confirmation",
  send_information: "Send information",
  check_stock: "Check stock",
  other: "Other",
};

/** Same fallback discipline as `sourceLabel` — a value outside the known six shows itself rather than nothing. */
export function reminderTypeLabel(value: string): string {
  return (REMINDER_TYPE_LABEL as Record<string, string>)[value] ?? value;
}

/**
 * `reminders.status` — the same three values every reminder in the CRM
 * carries (`src/db/schema.ts`'s `reminderStatusEnum`). Senior finding #13: the
 * enquiry detail screen's follow-up list was rendering this raw (`pending`,
 * `completed`, `dismissed`) straight into a badge.
 */
export const ENQUIRY_REMINDER_STATUSES = ["pending", "completed", "dismissed"] as const;
export type EnquiryReminderStatus = (typeof ENQUIRY_REMINDER_STATUSES)[number];

export const REMINDER_STATUS_LABEL: Record<EnquiryReminderStatus, string> = {
  pending: "Pending",
  completed: "Completed",
  dismissed: "Dismissed",
};

/** Same fallback discipline as `sourceLabel` — a value outside the known three shows itself rather than nothing. */
export function reminderStatusLabel(value: string): string {
  return (REMINDER_STATUS_LABEL as Record<string, string>)[value] ?? value;
}

/**
 * `orders.status` (`src/db/schema.ts`'s `orderStatusEnum`) — an enquiry's
 * linked orders reached the detail screen unlabelled the same way reminder
 * status did (Senior finding #13), showing `pending_approval` rather than
 * "Pending Approval". No shared, exported label for this enum exists
 * elsewhere in the codebase to reuse — `queue-service.ts` has a private,
 * full-sentence version for a different screen's own wording, and
 * `sales/orders/page.tsx` only replaces underscores with spaces — so this is
 * its own map here, kept to the enquiries vocabulary this file already holds.
 */
export const ENQUIRY_ORDER_STATUSES = [
  "captured",
  "pending_approval",
  "declined",
  "confirmed",
  "dispatched",
  "in_transit",
  "delivered",
  "cancelled",
] as const;
export type EnquiryOrderStatus = (typeof ENQUIRY_ORDER_STATUSES)[number];

export const ORDER_STATUS_LABEL: Record<EnquiryOrderStatus, string> = {
  captured: "Captured",
  pending_approval: "Pending Approval",
  declined: "Declined",
  confirmed: "Confirmed",
  dispatched: "Dispatched",
  in_transit: "In Transit",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

/** Same fallback discipline as `sourceLabel` — a value outside the known eight shows itself rather than nothing. */
export function orderStatusLabel(value: string): string {
  return (ORDER_STATUS_LABEL as Record<string, string>)[value] ?? value;
}

/**
 * Where a page of the Enquiries list stopped, so the next one can carry on —
 * `listEnquiries`'s own `TimelineCursor`, the same keyset shape
 * `customerTimeline` already uses for the exact same reason: `receivedAt`
 * alone cannot break a tie between two enquiries the website posted in the
 * same millisecond, and `id` can.
 */
export type EnquiryCursor = { receivedAt: string; id: string };

/**
 * The cursor STACK, one entry per page boundary already crossed, as a single
 * URL-safe string — `~` between the two fields of one cursor, `,` between
 * cursors. Going "Previous" needs no reverse query: the boundary before the
 * current page was already read on the way forward, so popping the stack is
 * enough to ask for it again.
 */
export function encodeEnquiryCursors(cursors: EnquiryCursor[]): string {
  return cursors.map((c) => `${c.receivedAt}~${c.id}`).join(",");
}

/**
 * The inverse. A hand-edited or stale URL decodes to no cursors — the same
 * "back to page one" a bad `stage`/`priority` value on this screen already
 * falls back to — rather than asking the database to compare against
 * something that was never a real cursor.
 */
export function decodeEnquiryCursors(raw: string | undefined | null): EnquiryCursor[] {
  if (!raw) return [];
  const out: EnquiryCursor[] = [];
  for (const part of raw.split(",")) {
    const i = part.lastIndexOf("~");
    if (i <= 0) return [];
    const receivedAt = part.slice(0, i);
    const cursorId = part.slice(i + 1);
    if (!receivedAt || !cursorId || Number.isNaN(Date.parse(receivedAt))) return [];
    out.push({ receivedAt, id: cursorId });
  }
  return out;
}

/** Labels for the fixed set of activity kinds this phase writes. The column itself stays free text, same as `timeline_events.eventType` — a new kind later needs no migration. */
export const ACTIVITY_LABEL: Record<string, string> = {
  received: "Enquiry received",
  viewed: "Enquiry viewed",
  assigned: "Assigned",
  reassigned: "Reassigned",
  unassigned: "Unassigned",
  stage_changed: "Stage changed",
  priority_changed: "Priority changed",
  customer_linked: "Customer linked",
  note: "Note added",
  order_linked: "Order linked",
  order_unlinked: "Order unlinked",
  reminder_created: "Follow-up scheduled",
  lead_created: "Lead created",
};

/* ---------------------------------------------------------------------------
 * WHICH ENQUIRIES A TELECALLER MAY TURN INTO A LEAD.
 *
 * Four of the website's eight forms are somebody asking to buy or to sell for
 * us: a quote, a product enquiry, a quick enquiry and a distributor enquiry.
 * The rest are not a sales lead — a career application is a person applying
 * for a job and must never reach the calling desk, and Contact, Technical and
 * Sample are handled where they already are.
 *
 * The values are the website's own `formType` spellings, typed against the
 * ingest list rather than retyped, so a rename there is a compile error here
 * and not a button that quietly stops appearing. Website is the only source
 * that exists; every other channel is future scope, so `source` is part of the
 * rule and not an afterthought.
 * ------------------------------------------------------------------------- */
export const LEAD_CONVERTIBLE_FORMS = [
  "QUOTE",
  "PRODUCT_ENQUIRY",
  "QUICK_ENQUIRY",
  "DISTRIBUTOR",
] as const satisfies readonly (typeof ENQUIRY_SOURCE_FORM_TYPES)[number][];

export type LeadConvertibility = { ok: true } | { ok: false; reason: string };

export function leadConvertibility(e: {
  source: string;
  sourceForm: string | null;
  category: string | null;
}): LeadConvertibility {
  if (e.source !== "website") {
    return { ok: false, reason: "Only website enquiries can be turned into a lead so far." };
  }
  if (e.category === "CAREER" || e.sourceForm === "CAREER") {
    return { ok: false, reason: "A career application is not a sales lead." };
  }
  if (!e.sourceForm || !(LEAD_CONVERTIBLE_FORMS as readonly string[]).includes(e.sourceForm)) {
    return {
      ok: false,
      reason: `${sourceFormLabel(e.sourceForm) ?? "This"} enquiry is not one that becomes a lead — only a quote, product, quick or distributor enquiry does.`,
    };
  }
  return { ok: true };
}
