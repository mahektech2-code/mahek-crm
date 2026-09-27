/* ---------------------------------------------------------------------------
 * Matching what a model read to the ERP's own records, DETERMINISTIC: a bill
 * line to a raw material, a message's product mention to an SKU. The model
 * only reads; which record it means is decided here, by rules somebody can
 * check, and a close call is shown as a choice rather than decided silently.
 * ------------------------------------------------------------------------- */

const ALIASES: Record<string, string> = {
  ltr: "liter",
  litre: "liter",
  lit: "liter",
  l: "liter",
  kgs: "kg",
  nc: "nc",
  peti: "box",
  pety: "box",
  carton: "box",
  ctn: "box",
  dabba: "can",
  tin: "can",
};

/** Lower-case word tokens, with common shop shorthand folded to one spelling. */
export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/(\d)([a-z])/g, "$1 $2")
    .split(/[^a-z0-9.]+/)
    .filter(Boolean)
    .map((t) => ALIASES[t] ?? t);
}

/** How much of `mention` is found in `name`, 0–1, with numbers (sizes) weighted double. */
export function similarity(mention: string, name: string): number {
  const m = tokens(mention);
  if (!m.length) return 0;
  const n = new Set(tokens(name));
  let hit = 0;
  let total = 0;
  for (const t of m) {
    const w = /^\d/.test(t) ? 2 : 1;
    total += w;
    if (n.has(t)) hit += w;
    else if (t.length >= 4 && [...n].some((x) => x.startsWith(t) || t.startsWith(x))) hit += w * 0.7;
  }
  return total ? hit / total : 0;
}

export type Candidate<T> = { item: T; score: number };

/**
 * The best candidates for a mention. `sure` is set only when the best clears
 * `minScore` AND beats the next by `margin`; otherwise the caller shows the
 * choices. `boost` lifts records this party has bought before.
 */
export function bestMatches<T>(mention: string, items: T[], name: (t: T) => string, opts: { minScore?: number; margin?: number; boost?: (t: T) => number; limit?: number } = {}): { sure: T | null; choices: Candidate<T>[] } {
  const minScore = opts.minScore ?? 0.6;
  const margin = opts.margin ?? 0.15;
  const scored = items
    .map((item) => ({ item, score: similarity(mention, name(item)) + (opts.boost?.(item) ?? 0) }))
    .filter((c) => c.score > 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 5);
  const [a, b] = scored;
  const sure = a && a.score >= minScore && (!b || a.score - b.score >= margin) ? a.item : null;
  return { sure, choices: scored };
}

/** A GSTIN compared the way it is printed: case, spaces and dashes ignored. */
export const sameGstin = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.replace(/[\s-]/g, "").toUpperCase() === b.replace(/[\s-]/g, "").toUpperCase();

/** Cans for a quantity said in boxes, cans, drums or litres, for one SKU. */
export function toCans(qty: number, unit: string, cansPerBox: number, litresPerCan: number): { cans: number | null; note: string | null } {
  const u = (tokens(unit)[0] ?? "can").replace(/s$/, "");
  if (u === "box") return { cans: qty * cansPerBox, note: cansPerBox > 1 ? `${qty} box × ${cansPerBox}` : null };
  if (u === "liter" || u === "litre") {
    if (litresPerCan <= 0) return { cans: null, note: "No can size to convert litres" };
    const c = qty / litresPerCan;
    return Number.isInteger(c) ? { cans: c, note: `${qty} L ÷ ${litresPerCan} L` } : { cans: null, note: `${qty} L is not a whole number of ${litresPerCan} L cans` };
  }
  return { cans: qty, note: null };
}
