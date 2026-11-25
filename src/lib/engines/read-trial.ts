/* ---------------------------------------------------------------------------
 * READING TRIALS — is Sarvam better than OpenAI at reading our photographs?
 *
 * Sarvam is built for India, and the hope is that it reads a Marathi shop
 * board or a Gujarati fuel bill better than OpenAI does. That is a hypothesis,
 * so before any feature changes who reads first, both read the same photos
 * and this file says how they compared. Pure: no I/O, no clock.
 *
 * TWO KINDS OF EVIDENCE, because the two features have different truths.
 *
 *   An EXPENSE BILL has a right answer on file: the salesman typed the amount,
 *   bill number and date beside the photo. Each reader is scored against that
 *   — `right`, `wrong`, `missed` — which is accuracy, not just agreement. The
 *   typed amount is what he CLAIMED, which can legitimately be less than the
 *   bill, so a "wrong" amount is sometimes the claim and not the reader; both
 *   readers carry that noise equally, so the comparison between them holds.
 *
 *   A LEAD SCAN keeps nothing — no photo, no reading — so there is no truth on
 *   file. What can be said is whether the two AGREED field by field, and one
 *   objective check: whether each GSTIN passes its checksum.
 *
 * Only VERDICTS are stored, never a value read: a card is a person's name and
 * number, and the comparison needs neither.
 * ------------------------------------------------------------------------- */

import type { LeadScanResult } from "@/lib/engines/lead-scan";

export type ReadProvider = "openai" | "sarvam";
export type TrialFeature = "lead_scan" | "expense_bill";

/* ------------------------------------------------------------------ lead scan */

export type Agreement = "same" | "differs" | "only_openai" | "only_sarvam" | "neither";

/** The fields a salesman would otherwise type, compared one by one. */
export const LEAD_SCAN_FIELDS = ["businessName", "contactPerson", "mobile", "city", "address", "gstin"] as const;

/** Case, spacing and punctuation are not disagreements: "SHRI GANESH PAINTS." is "Shri Ganesh Paints". */
export function sameText(a: string, b: string): boolean {
  const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return norm(a) === norm(b);
}

export function agreement(openai: string | null, sarvam: string | null): Agreement {
  const a = openai?.trim() ? openai : null;
  const b = sarvam?.trim() ? sarvam : null;
  if (a && b) return sameText(a, b) ? "same" : "differs";
  if (a) return "only_openai";
  if (b) return "only_sarvam";
  return "neither";
}

/**
 * Field → verdict for one scan both providers read. The GSTIN's checksum is
 * recorded for each side as well, since it is the one field whose correctness
 * can be known without a person: `valid`, `corrected`, `invalid` or `none`.
 */
export function compareLeadScans(openai: LeadScanResult, sarvam: LeadScanResult): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of LEAD_SCAN_FIELDS) out[f] = agreement(openai[f], sarvam[f]);
  out.gstinCheck_openai = openai.gstinCheck ?? "none";
  out.gstinCheck_sarvam = sarvam.gstinCheck ?? "none";
  return out;
}

/* --------------------------------------------------------------- expense bill */

export type Score = "right" | "wrong" | "missed" | "untyped";

export type TypedBill = { amountPaise: number; billNumber: string | null; billDate: string | null };
export type ReadBill = { amountPaise: number | null; billNumber: string | null; billDate: string | null };

/** "INV/0042" and "inv 42" are not the same bill number; "INV-0042" and "INV/0042" are. */
export function sameBillNumber(a: string, b: string): boolean {
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return norm(a) !== "" && norm(a) === norm(b);
}

/** A rupee either way is the bill's own round off, not a misreading. */
export const AMOUNT_TOLERANCE_PAISE = 100;

export function scoreBill(typed: TypedBill, read: ReadBill): Record<string, Score> {
  const amount: Score =
    read.amountPaise == null
      ? "missed"
      : Math.abs(read.amountPaise - typed.amountPaise) <= AMOUNT_TOLERANCE_PAISE
        ? "right"
        : "wrong";
  const billNumber: Score = !typed.billNumber?.trim()
    ? "untyped"
    : !read.billNumber?.trim()
      ? "missed"
      : sameBillNumber(typed.billNumber, read.billNumber)
        ? "right"
        : "wrong";
  const billDate: Score = !typed.billDate
    ? "untyped"
    : !read.billDate
      ? "missed"
      : read.billDate === typed.billDate
        ? "right"
        : "wrong";
  return { amount, billNumber, billDate };
}

/** Rupees as a reader returned them — 1,250.50 or "₹ 1250.5" — to paise; null when it is not a figure. */
export function readRupeesToPaise(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[₹,\s]|rs\.?|inr/gi, "")) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > 10_000_000) return null;
  return Math.round(n * 100);
}

/** A date a reader returned, as YYYY-MM-DD, or null. Day-first, as Indian bills are printed. */
export function readDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  let y: number, m: number, d: number;
  let mt = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (mt) [y, m, d] = [Number(mt[1]), Number(mt[2]), Number(mt[3])];
  else {
    mt = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/);
    if (!mt) return null;
    [d, m, y] = [Number(mt[1]), Number(mt[2]), Number(mt[3])];
    if (y < 100) y += 2000;
  }
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/* -------------------------------------------------------------------- summary */

export type TrialRow = { feature: string; provider: string; ok: boolean; ms: number | null; fields: Record<string, string> };

export type ProviderSummary = {
  provider: string;
  reads: number;
  failed: number;
  /** Middle reading time of the ones that succeeded. */
  medianMs: number | null;
  /** Field → verdict → how many. */
  fields: Record<string, Record<string, number>>;
};

export function summariseTrials(rows: TrialRow[], feature: TrialFeature): ProviderSummary[] {
  const by = new Map<string, TrialRow[]>();
  for (const r of rows) if (r.feature === feature) by.set(r.provider, [...(by.get(r.provider) ?? []), r]);
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, rs]) => {
      const times = rs.filter((r) => r.ok && r.ms != null).map((r) => r.ms!).sort((a, b) => a - b);
      const fields: Record<string, Record<string, number>> = {};
      for (const r of rs)
        for (const [f, v] of Object.entries(r.fields ?? {})) {
          fields[f] ??= {};
          fields[f][v] = (fields[f][v] ?? 0) + 1;
        }
      return {
        provider,
        reads: rs.length,
        failed: rs.filter((r) => !r.ok).length,
        medianMs: times.length ? times[Math.floor((times.length - 1) / 2)] : null,
        fields,
      };
    });
}

/* ------------------------------------------------------------- Sarvam schema */

type Json = { [k: string]: unknown };

/**
 * A JSON Schema (as `z.toJSONSchema` writes it) in the subset Sarvam's Extract
 * accepts: `type`, `description`, `enum`, `properties`, `items`, root an
 * object, nesting at most four deep. A nullable field becomes its plain type —
 * Sarvam answers null for a field it cannot find anyway — and everything else
 * (`required`, `additionalProperties`, `$schema`) is dropped.
 */
export function toSarvamSchema(schema: Json, depth = 0): Json {
  if (depth > 4) throw new Error("Sarvam accepts a schema at most four levels deep.");
  let node = schema;
  const variants = (node.anyOf ?? node.oneOf) as Json[] | undefined;
  if (Array.isArray(variants)) {
    const real = variants.filter((v) => v.type !== "null");
    if (real.length !== 1) throw new Error("Sarvam cannot take a field that may be one of several types.");
    node = { ...real[0], description: node.description ?? real[0].description };
  }
  let type = node.type;
  if (Array.isArray(type)) type = type.find((t) => t !== "null");
  if (typeof type !== "string") throw new Error("Every field Sarvam is asked for needs a type.");
  const out: Json = { type };
  if (typeof node.description === "string") out.description = node.description;
  if (Array.isArray(node.enum)) out.enum = node.enum.filter((v) => v !== null);
  if (type === "object") {
    const props = (node.properties ?? {}) as Record<string, Json>;
    out.properties = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, toSarvamSchema(v, depth + 1)]));
  }
  if (type === "array" && node.items) out.items = toSarvamSchema(node.items as Json, depth + 1);
  return out;
}

/** A value Sarvam returned, as a string the reading can hold — or null. */
export function asText(v: unknown): string | null {
  if (typeof v === "string") return v.trim() ? v.trim() : null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}
