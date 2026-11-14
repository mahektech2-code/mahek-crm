/**
 * What a field-customer pin's raw "Industry" cell actually means.
 *
 * The source app's dropdown conflates two different questions under one
 * column: a real trade category ("Hardware & Paints") and a lead-pipeline or
 * payment-behaviour rating ("Interested Customer", "Class A (Fast Payment
 * High Sales)"). `field_customer_pins.industry_label` keeps the cell
 * verbatim — a stored value is not a label — and this is the split, read only
 * at render time by the map/legend.
 *
 * Pure and client-safe: the map is a client component, and this decides
 * nothing about the database.
 */
export type PinIndustryKind = "trade" | "pipeline" | "unknown";

export type PinIndustryInfo = {
  kind: PinIndustryKind;
  /** "positive" nudges a prospect pin toward a warmer colour, "negative" cooler. */
  tone: "neutral" | "positive" | "negative";
};

const PIN_INDUSTRY_LABEL: Record<string, PinIndustryInfo> = {
  "Hardware & Paints": { kind: "trade", tone: "neutral" },
  "Decorative Paints": { kind: "trade", tone: "neutral" },
  "Auto Car Colour": { kind: "trade", tone: "neutral" },
  "Industry Counter": { kind: "trade", tone: "neutral" },
  "Furniture Counter": { kind: "trade", tone: "neutral" },

  "Interested Customer": { kind: "pipeline", tone: "positive" },
  "Will Buy Later": { kind: "pipeline", tone: "positive" },
  "Not Interested To Buy": { kind: "pipeline", tone: "negative" },
  "Unknown": { kind: "pipeline", tone: "neutral" },

  "Class A (Fast Payment High Sales)": { kind: "pipeline", tone: "positive" },
  "Class B (Fast Payment Low Sales)": { kind: "pipeline", tone: "positive" },
  "Class B (Fast Payment  Low Sales)": { kind: "pipeline", tone: "positive" },
  "Class C (Slow Payment High Sales)": { kind: "pipeline", tone: "negative" },
  "Class D (Slow Payment Low Sales)": { kind: "pipeline", tone: "negative" },
};

/**
 * The classification, or `unknown` where the source has gained a value this
 * map has not — never guessed, and the raw cell is still shown alongside it.
 */
export function pinIndustryInfo(raw: string | null): PinIndustryInfo {
  if (!raw) return { kind: "unknown", tone: "neutral" };
  return PIN_INDUSTRY_LABEL[raw] ?? { kind: "unknown", tone: "neutral" };
}
