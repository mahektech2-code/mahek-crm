/* ---------------------------------------------------------------------------
 * "DESCRIBE THE CHANGE" — a sentence becomes a RULE, and code computes prices.
 *
 * A person types "everything up 5%, Nano held, round to the rupee". A model
 * (or, for the plain cases, `parseSimpleInstruction` below with no model at
 * all) turns that into an `InstructionRule`. Every price is then computed HERE
 * from the live revision's rows, so a model can misunderstand a sentence — and
 * the preview shows exactly what it understood — but it can never invent a
 * number. Nothing is written until the person presses Apply on the preview.
 *
 * Pure and client-safe: the preview runs the same function the action does.
 * ------------------------------------------------------------------------- */

import { exFromIncl, inclFromEx } from "@/lib/engines/price-math";
import type { ChangeRate } from "@/lib/engines/price-change";
import { cellKey } from "@/lib/engines/price-change";

const BP = 10_000;

export type InstructionOp = "percent" | "per_litre" | "per_can" | "set";
export type InstructionRounding = "none" | "rupee" | "five" | "ten";

/** Which cells a rule or an exception reaches. Empty lists mean "no narrowing" on that axis. */
export type InstructionTarget = {
  /** Brand lines / families, matched case-insensitively against `ChangeRate.family`. */
  families: string[];
  productIds: string[];
  /** Pack size bounds in litres, inclusive. Null is unbounded. */
  minLitres: number | null;
  maxLitres: number | null;
};

export type InstructionException = InstructionTarget & {
  action: "hold" | "percent" | "set";
  valueBp: number | null;
  valuePaise: number | null;
};

export type InstructionRule = {
  op: InstructionOp;
  /** For `percent`: basis points, signed (500 is +5%). */
  valueBp: number | null;
  /** For `per_litre`, `per_can` (signed) and `set`: paise. */
  valuePaise: number | null;
  /** Whether the figures are meant on the GST-inclusive price (what the PDF prints) or before GST. */
  basis: "incl" | "ex";
  target: InstructionTarget;
  rounding: InstructionRounding;
  exceptions: InstructionException[];
};

export const EMPTY_TARGET: InstructionTarget = { families: [], productIds: [], minLitres: null, maxLitres: null };

export type ProposedPrice = {
  key: string;
  productId: string;
  productName: string;
  family: string;
  minCans: number | null;
  beforeExPaise: number;
  beforeInclPaise: number;
  afterExPaise: number;
  afterInclPaise: number;
  /** In words: what moved it, or that an exception held it. */
  why: string;
};

function reaches(t: InstructionTarget, r: ChangeRate): boolean {
  if (t.families.length) {
    const fam = r.family.toLowerCase();
    if (!t.families.some((f) => fam === f.toLowerCase() || fam.includes(f.toLowerCase()))) return false;
  }
  if (t.productIds.length && !t.productIds.includes(r.productId)) return false;
  const litres = r.millilitresPerCan == null ? null : r.millilitresPerCan / 1000;
  if (t.minLitres != null && (litres == null || litres < t.minLitres)) return false;
  if (t.maxLitres != null && (litres == null || litres > t.maxLitres)) return false;
  return true;
}

function round(paise: number, rounding: InstructionRounding): number {
  const step = rounding === "rupee" ? 100 : rounding === "five" ? 500 : rounding === "ten" ? 1000 : 1;
  return Math.round(paise / step) * step;
}

/** One cell moved by one operation, on the basis the rule speaks in. */
function moved(start: number, op: InstructionOp, valueBp: number | null, valuePaise: number | null, millilitres: number | null): number | null {
  switch (op) {
    case "percent":
      return valueBp == null ? null : Math.round(start * (1 + valueBp / BP));
    case "per_litre":
      return valuePaise == null || millilitres == null ? null : Math.round(start + (valuePaise * millilitres) / 1000);
    case "per_can":
      return valuePaise == null ? null : start + valuePaise;
    case "set":
      return valuePaise;
  }
}

/**
 * The prices a rule produces, for the cells it reaches and moves. Cells it
 * does not reach, and cells it would leave where they are, are not returned.
 * The figure is computed on the rule's basis and rounded there (the PDF prints
 * the inclusive rupee), then stored ex-GST.
 */
export function applyInstruction(rows: readonly ChangeRate[], rule: InstructionRule, gstBp: number): ProposedPrice[] {
  const out: ProposedPrice[] = [];
  for (const r of rows) {
    if (!r.offered || r.rateExGstPaise <= 0) continue;
    if (!reaches(rule.target, r)) continue;
    const exception = rule.exceptions.find((e) => reaches(e, r));
    if (exception?.action === "hold") continue;

    const start = rule.basis === "incl" ? r.rateInclGstPaise : r.rateExGstPaise;
    let next: number | null;
    let why: string;
    if (exception?.action === "percent") {
      next = moved(start, "percent", exception.valueBp, null, r.millilitresPerCan);
      why = `exception: ${(exception.valueBp ?? 0) / 100}%`;
    } else if (exception?.action === "set") {
      next = exception.valuePaise;
      why = "exception: set";
    } else {
      next = moved(start, rule.op, rule.valueBp, rule.valuePaise, r.millilitresPerCan);
      why = describeOp(rule);
    }
    if (next == null || next <= 0) continue;
    next = round(next, rule.rounding);

    const afterEx = rule.basis === "incl" ? exFromIncl(next, gstBp) : next;
    const afterIncl = rule.basis === "incl" ? next : inclFromEx(next, gstBp);
    if (afterEx === r.rateExGstPaise) continue;
    out.push({
      key: cellKey(r.productId, r.minCans),
      productId: r.productId,
      productName: r.productName,
      family: r.family,
      minCans: r.minCans,
      beforeExPaise: r.rateExGstPaise,
      beforeInclPaise: r.rateInclGstPaise,
      afterExPaise: afterEx,
      afterInclPaise: afterIncl,
      why,
    });
  }
  return out;
}

/** The rule said back in words, for the preview. */
export function describeRule(rule: InstructionRule): string {
  const parts = [describeOp(rule)];
  parts.push(rule.basis === "incl" ? "on the price with GST" : "on the price before GST");
  const t = targetWords(rule.target);
  parts.push(t ? `for ${t}` : "for every product");
  if (rule.rounding !== "none") parts.push(`rounded to the nearest ${rule.rounding === "rupee" ? "rupee" : rule.rounding === "five" ? "₹5" : "₹10"}`);
  const ex = rule.exceptions.map((e) => {
    const who = targetWords(e) || "everything";
    if (e.action === "hold") return `${who} held`;
    if (e.action === "set") return `${who} set to ₹${((e.valuePaise ?? 0) / 100).toLocaleString("en-IN")}`;
    return `${who} ${signed((e.valueBp ?? 0) / 100)}%`;
  });
  if (ex.length) parts.push(`except ${ex.join("; ")}`);
  return parts.join(", ");
}

function signed(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function describeOp(rule: InstructionRule): string {
  switch (rule.op) {
    case "percent":
      return `${signed((rule.valueBp ?? 0) / 100)}%`;
    case "per_litre":
      return `${signed((rule.valuePaise ?? 0) / 100)} ₹ a litre`;
    case "per_can":
      return `${signed((rule.valuePaise ?? 0) / 100)} ₹ a can`;
    case "set":
      return `set to ₹${((rule.valuePaise ?? 0) / 100).toLocaleString("en-IN")}`;
  }
}

function targetWords(t: InstructionTarget): string {
  const bits: string[] = [];
  if (t.families.length) bits.push(t.families.join(", "));
  if (t.productIds.length) bits.push(`${t.productIds.length} named product${t.productIds.length === 1 ? "" : "s"}`);
  if (t.minLitres != null && t.maxLitres != null) bits.push(`${t.minLitres}–${t.maxLitres} L packs`);
  else if (t.minLitres != null) bits.push(`packs of ${t.minLitres} L and more`);
  else if (t.maxLitres != null) bits.push(`packs up to ${t.maxLitres} L`);
  return bits.join(" · ");
}

/**
 * The questions a rule raises before anybody should apply it — asked rather
 * than guessed. An exception that would move a price DOWN when the rule moves
 * prices up (or the other way) is the classic: "hold Nano at ₹290" where Nano
 * is ₹305 is a 5% cut, not a hold.
 */
export function ruleQuestions(rows: readonly ChangeRate[], rule: InstructionRule, gstBp: number): string[] {
  const qs: string[] = [];
  const direction = rule.op === "percent" ? Math.sign(rule.valueBp ?? 0) : rule.op === "set" ? 0 : Math.sign(rule.valuePaise ?? 0);
  for (const e of rule.exceptions) {
    if (e.action !== "set" || e.valuePaise == null) continue;
    for (const r of rows) {
      if (!reaches(e, r) || !reaches(rule.target, r) || (r.minCans ?? 0) !== 0) continue;
      const now = rule.basis === "incl" ? r.rateInclGstPaise : r.rateExGstPaise;
      const moveDir = Math.sign(e.valuePaise - now);
      if (direction !== 0 && moveDir !== 0 && moveDir !== direction) {
        const pct = Math.round(((e.valuePaise - now) * 1000) / now) / 10;
        qs.push(
          `${r.productName} is ₹${(now / 100).toLocaleString("en-IN")} today, so ₹${(e.valuePaise / 100).toLocaleString("en-IN")} is a ${Math.abs(pct)}% ${pct < 0 ? "cut" : "rise"}, not a hold. Is that what you meant?`,
        );
        break;
      }
    }
  }
  if (!applyInstruction(rows, rule, gstBp).length) qs.push("This instruction does not change any price on the book. Check the product names.");
  return qs;
}

/* ------------------------------------------------- the plain cases, no model */

const NUM = String.raw`(\d+(?:\.\d+)?)`;

/**
 * Reads the plain shapes of an instruction without a model — "+5%", "up 3
 * percent", "₹2 a litre", "add 10 per can", "5% except Nano" — against the
 * families this book carries. Null where the sentence is anything else; the
 * screen then asks a model, or says it could not read it.
 */
export function parseSimpleInstruction(text: string, families: readonly string[]): InstructionRule | null {
  const t = text.toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const down = /\b(down|cut|reduce|decrease|lower|minus|less)\b|(^|\s)-\s*\d/.test(t);
  const sign = down ? -1 : 1;

  const [main, ...exceptParts] = t.split(/\bexcept\b|\bbut not\b|\bexcluding\b/);
  let op: InstructionOp | null = null;
  let valueBp: number | null = null;
  let valuePaise: number | null = null;

  const pctM = main.match(new RegExp(`[+-]?\\s*${NUM}\\s*(%|percent|per cent)`));
  const litreM = main.match(new RegExp(`(?:₹|rs\\.?|inr)?\\s*[+-]?\\s*${NUM}\\s*(?:₹|rs\\.?|rupees?)?\\s*(?:a|per|/)\\s*(?:litre|liter|ltr|l)\\b`));
  const canM = main.match(new RegExp(`(?:₹|rs\\.?|inr)?\\s*[+-]?\\s*${NUM}\\s*(?:₹|rs\\.?|rupees?)?\\s*(?:a|per|/)\\s*(?:can|tin|drum|pack)\\b`));
  if (pctM) {
    op = "percent";
    valueBp = Math.round(Number(pctM[1]) * 100) * sign;
  } else if (litreM) {
    op = "per_litre";
    valuePaise = Math.round(Number(litreM[1]) * 100) * sign;
  } else if (canM) {
    op = "per_can";
    valuePaise = Math.round(Number(canM[1]) * 100) * sign;
  }
  if (!op) return null;

  const basis: "incl" | "ex" = /\b(ex[- ]?gst|before gst|excluding gst|without gst)\b/.test(t) ? "ex" : "incl";
  const rounding: InstructionRounding = /nearest (₹|rs\.? ?)?10\b|round(ed)? to (₹|rs\.? ?)?10\b/.test(t)
    ? "ten"
    : /nearest (₹|rs\.? ?)?5\b|round(ed)? to (₹|rs\.? ?)?5\b/.test(t)
      ? "five"
      : /\bround/.test(t)
        ? "rupee"
        : "none";

  const named = (part: string) => families.filter((f) => part.includes(f.toLowerCase()));
  const target: InstructionTarget = { ...EMPTY_TARGET, families: named(main.replace(/\bround.*$/, "")) };
  const exceptions: InstructionException[] = exceptParts
    .flatMap((p) => named(p))
    .map((f) => ({ ...EMPTY_TARGET, families: [f], action: "hold" as const, valueBp: null, valuePaise: null }));

  return { op, valueBp, valuePaise, basis, target, rounding, exceptions };
}
