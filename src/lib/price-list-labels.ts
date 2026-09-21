/* ---------------------------------------------------------------------------
 * THE PRICE LIST VOCABULARY — every stored code and the words it is shown as.
 *
 * Pure and client-safe, like `account-types` and `seat-labels` beside it: the
 * modals that write these run in a browser and the services that read them
 * are `server-only`, so the words live where both can import them. A stored
 * code is never a label — `for_godown` on a screen is a bug.
 * ------------------------------------------------------------------------- */

import type {
  PriceDeliveryBasis,
  PriceDiscountKind,
  PriceDocumentStatus,
  PriceFreightTerm,
  PriceListStatus,
  PriceMatchStatus,
  PriceScopeKind,
} from "@/db/schema";

export const LIST_STATUS_LABEL: Record<PriceListStatus, string> = {
  draft: "Draft",
  published: "Published",
  superseded: "Superseded",
  withdrawn: "Withdrawn",
};

export const LIST_STATUS_TONE: Record<PriceListStatus, "neutral" | "success" | "muted" | "danger"> = {
  draft: "neutral",
  published: "success",
  superseded: "muted",
  withdrawn: "danger",
};

export const FREIGHT_TERM_LABEL: Record<PriceFreightTerm, string> = {
  to_pay: "To Pay",
  paid: "Paid",
  not_stated: "Not stated",
};

/** The sentence under the pill, because "To Pay" alone is jargon to a new telecaller. */
export const FREIGHT_TERM_HINT: Record<PriceFreightTerm, string> = {
  to_pay: "The shop pays the transport on delivery. Prices are ex-freight.",
  paid: "Transport is paid by us and built into the price, up to the transporter's godown.",
  not_stated: "The list did not say who pays the transport.",
};

export const DELIVERY_BASIS_LABEL: Record<PriceDeliveryBasis, string> = {
  for_mumbai: "FOR Mumbai",
  for_godown: "FOR transporter godown",
  door_delivery: "Door delivery",
  ex_factory: "Ex factory",
};

export const SCOPE_KIND_LABEL: Record<PriceScopeKind, string> = {
  everybody: "Everybody",
  state: "State",
  district: "District",
  city: "City",
  area: "Area",
  beat: "Beat",
  customer_type: "Customer type",
  salesman: "Salesman",
  customer: "Customer",
};

/** Narrowest first, for a picker that should offer the usual answer near the top. */
export const SCOPE_KIND_ORDER: readonly PriceScopeKind[] = [
  "state",
  "city",
  "district",
  "area",
  "beat",
  "customer",
  "salesman",
  "customer_type",
  "everybody",
];

export const SCOPE_KIND_HINT: Record<PriceScopeKind, string> = {
  everybody: "The fallback for any shop nothing narrower names. Keep one.",
  state: "Every shop in the state, unless a narrower scope names it.",
  district: "Every shop in the district.",
  city: "Every shop in the city. Pick it under its state, so two cities with one name stay apart.",
  area: "Every shop in the area, under its city.",
  beat: "Every shop on the beat, as the beat master spells it.",
  customer_type: "Every dealer, or every distributor, wherever they are.",
  salesman: "Every shop in one salesman's book.",
  customer: "One shop by name. This beats every other scope.",
};

export const DOCUMENT_STATUS_LABEL: Record<PriceDocumentStatus, string> = {
  queued: "Waiting",
  extracting: "Reading the file",
  classifying: "Working out the layout",
  normalising: "Reading the prices",
  matching: "Matching products",
  validating: "Checking the figures",
  parsed: "Ready to review",
  needs_review: "Needs a person",
  published: "Published",
  rejected: "Rejected",
  failed: "Could not be read",
};

/** The parsing stages in order, for the animation and the progress line. */
export const PARSE_STAGES = [
  "extracting",
  "classifying",
  "normalising",
  "matching",
  "validating",
] as const satisfies readonly PriceDocumentStatus[];
export type ParseStage = (typeof PARSE_STAGES)[number];

/** What each stage is doing, in a sentence the animation prints underneath. */
export const PARSE_STAGE_SENTENCE: Record<ParseStage, string> = {
  extracting: "Reading every line of text off the page.",
  classifying: "Finding the header, the pack-size columns and the terms.",
  normalising: "Turning Rs.1,168 into paise and 50/bx into cans per box.",
  matching: "Matching each row and column to a SKU in the catalogue.",
  validating: "Checking GST, the derivation and that no cell is empty by accident.",
};

export const DOCUMENT_STATUS_TONE: Record<PriceDocumentStatus, "neutral" | "brand" | "success" | "warn" | "danger" | "muted"> = {
  queued: "muted",
  extracting: "brand",
  classifying: "brand",
  normalising: "brand",
  matching: "brand",
  validating: "brand",
  parsed: "success",
  needs_review: "warn",
  published: "success",
  rejected: "muted",
  failed: "danger",
};

export const MATCH_STATUS_LABEL: Record<PriceMatchStatus, string> = {
  matched: "Matched",
  alias: "Matched by alias",
  suggested: "Suggested",
  held: "Held",
  skipped: "Skipped",
  manual: "Chosen by hand",
};

export const MATCH_STATUS_TONE: Record<PriceMatchStatus, "success" | "brand" | "warn" | "danger" | "muted" | "neutral"> = {
  matched: "success",
  alias: "success",
  suggested: "warn",
  held: "danger",
  skipped: "muted",
  manual: "brand",
};

export const DISCOUNT_KIND_LABEL: Record<PriceDiscountKind, string> = {
  advance_payment: "Advance payment",
  quantity: "Quantity",
  prompt_payment: "Prompt payment",
  other: "Other",
};

export const REQUEST_STATUS_LABEL: Record<"pending" | "approved" | "refused" | "withdrawn", string> = {
  pending: "Waiting",
  approved: "Approved",
  refused: "Refused",
  withdrawn: "Withdrawn",
};

export const TAX_BASIS_LABEL: Record<"inclusive" | "exclusive", string> = {
  inclusive: "GST inclusive",
  exclusive: "GST extra",
};

/** "3% off for advance payment", "2% off from 1,000 litres". */
export function discountTermSentence(term: {
  kind: PriceDiscountKind;
  percentBp: number;
  thresholdLitres: number | null;
  thresholdPaise: number | null;
}): string {
  const pct = term.percentBp / 100;
  const pctText = `${Number.isInteger(pct) ? pct : pct.toFixed(2)}% off`;
  switch (term.kind) {
    case "advance_payment":
      return `${pctText} for advance payment`;
    case "prompt_payment":
      return `${pctText} for prompt payment`;
    case "quantity":
      if (term.thresholdLitres) return `${pctText} from ${term.thresholdLitres.toLocaleString("en-IN")} litres`;
      if (term.thresholdPaise) return `${pctText} on orders of ₹${Math.round(term.thresholdPaise / 100).toLocaleString("en-IN")} and above`;
      return `${pctText} by quantity`;
    case "other":
      return pctText;
  }
}

/** The one-line summary a list is introduced by: "PL0105 · effective 1 Aug 2026 · GST inclusive · To Pay". */
export function listSummary(list: {
  refNo: string | null;
  taxBasis: string;
  freightTerm: PriceFreightTerm;
  deliveryBasis: PriceDeliveryBasis | string | null;
}): string {
  const parts = [
    list.refNo ? `Ref ${list.refNo}` : null,
    TAX_BASIS_LABEL[(list.taxBasis as "inclusive" | "exclusive") ?? "inclusive"] ?? null,
    list.deliveryBasis ? (DELIVERY_BASIS_LABEL[list.deliveryBasis as PriceDeliveryBasis] ?? list.deliveryBasis) : null,
    list.freightTerm !== "not_stated" ? FREIGHT_TERM_LABEL[list.freightTerm] : null,
  ].filter((p): p is string => !!p);
  return parts.join(" · ");
}
