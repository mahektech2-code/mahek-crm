import { similarity } from "./match";

/* ---------------------------------------------------------------------------
 * READING AN LR PHOTO INTO THE UPLOAD FORM — the rules half. The model reads
 * the receipt; everything after the read is here, pure, so it is tested
 * without a model:
 *
 * - WHICH TRANSPORTER it is decided against the directory, never taken as
 *   printed: "SHREE MARUTI COURIER SERVICES PVT LTD" is the "Shree Maruti" the
 *   desk already knows, and a name nobody has met is kept as printed.
 * - THE NUMBER is checked against that transporter's own STYLE: what it calls
 *   the number ("GR Number", "G.C Number" — `consignmentLabel`) and the SHAPE
 *   of the numbers already uploaded for it. A receipt carries a phone, a GSTIN,
 *   an invoice number and a pin code beside the consignment number, and the
 *   shape is what tells them apart. A number that does not look like this
 *   transporter's is still offered — a transporter changes its book — but
 *   marked to check.
 * - A DATE that is not a date, is in the future, or is older than any LR
 *   being uploaded today is dropped rather than filled in.
 *
 * Nothing here writes. The form fills only what the person has not typed, and
 * "Upload" is still the only save.
 * ------------------------------------------------------------------------- */

/** One transporter as the model and the rules see it. */
export type LrStyle = { name: string; label: string | null; examples: string[] };

/** What the model returned. */
export type LrRawReading = {
  lrNo: string | null;
  /** The words the number was printed under ("G.R. No.", "Consignment Note No"). */
  lrLabelSeen: string | null;
  transporter: string | null;
  lrDate: string | null;
  destination: string | null;
  packages: number | null;
  freightTerm: string | null;
  freightRupees: number | null;
  confidence: "high" | "check";
};

/** What the form is offered. */
export type LrSuggestion = {
  lrNo: string | null;
  lrDate: string | null;
  transporter: string | null;
  destination: string | null;
  packages: number | null;
  freightTerm: "Paid" | "To pay" | "TBB" | null;
  freightRupees: number | null;
  /** The number is worth a second look: unsure, or not shaped like this transporter's. */
  checkNumber: boolean;
  /** Sentences for the person, about what was read and what to check. */
  notes: string[];
};

/** How old an LR date may be before it is read as a misreading. */
export const LR_MAX_AGE_DAYS = 120;

/**
 * The shape of a consignment number: digits become 9, letters A, everything
 * else is kept — "MUM/104882" is "AAA/999999". Leading and trailing spaces go.
 */
export function lrShape(lrNo: string): string {
  return lrNo
    .trim()
    .toUpperCase()
    .replace(/[0-9]/g, "9")
    .replace(/[A-Z]/g, "A")
    .replace(/\s+/g, " ");
}

/** The shapes a transporter's numbers have come in, commonest first. */
export function lrShapes(examples: string[]): string[] {
  const n = new Map<string, number>();
  for (const e of examples) {
    if (!e?.trim()) continue;
    const s = lrShape(e);
    n.set(s, (n.get(s) ?? 0) + 1);
  }
  return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
}

/**
 * Whether a number fits a transporter's style. Exact shape, or the same
 * pattern one digit longer or shorter — a running serial passes from 999999
 * to 1000000 and is still the same book.
 */
export function fitsStyle(lrNo: string, examples: string[]): boolean | null {
  const shapes = lrShapes(examples);
  if (!shapes.length) return null;
  const s = lrShape(lrNo);
  const loose = (x: string) => x.replace(/9+/g, "9");
  return shapes.some((x) => x === s || (loose(x) === loose(s) && Math.abs(x.length - s.length) <= 1));
}

/** The style in words, for the model: "printed as GR Number; earlier ones look like 1048821, 1048822". */
export function styleLine(t: LrStyle): string {
  const bits: string[] = [];
  if (t.label) bits.push(`calls it "${t.label}"`);
  const ex = t.examples.filter((e) => e?.trim()).slice(0, 3);
  if (ex.length) bits.push(`earlier numbers: ${ex.join(", ")}`);
  return `- ${t.name}${bits.length ? ` — ${bits.join("; ")}` : ""}`;
}

/** The directory transporter a printed name means, or null where none is close. */
export function matchTransporter(printed: string | null | undefined, directory: LrStyle[]): LrStyle | null {
  const p = (printed ?? "").trim();
  if (!p) return null;
  const exact = directory.find((t) => t.name.trim().toLowerCase() === p.toLowerCase());
  if (exact) return exact;
  let best: { t: LrStyle; score: number } | null = null;
  for (const t of directory) {
    /* Either way round: the directory's short name inside the receipt's long one, or the reverse. */
    const score = Math.max(similarity(t.name, p), similarity(p, t.name));
    if (score >= 0.6 && (!best || score > best.score)) best = { t, score };
  }
  return best?.t ?? null;
}

/** What is left of a name once case, punctuation and the company-form words are set aside. */
const FORM_WORDS = new Set(["the", "m", "s", "ms", "pvt", "private", "ltd", "limited", "llp", "co", "company"]);
export function transporterKey(name: string | null | undefined): string {
  return (name ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !FORM_WORDS.has(w))
    .join("");
}

/**
 * The listed transporter a TYPED name is — only where it is the same name,
 * spelled with other capitals, spacing, punctuation or "Pvt Ltd". A name that
 * is merely close is not taken for one: `near` is a suggestion to say back,
 * never an answer, because "Shree Roadways" is not "Shree Maruti".
 */
export function listedTransporter(typed: string, names: string[]): { name: string | null; near: string | null } {
  const t = typed.trim().replace(/\s+/g, " ");
  const exact = names.find((n) => n.trim().toLowerCase() === t.toLowerCase());
  if (exact) return { name: exact, near: null };
  const k = transporterKey(t);
  const same = k ? names.filter((n) => transporterKey(n) === k) : [];
  if (same.length === 1) return { name: same[0], near: null };
  const near = matchTransporter(t, names.map((name) => ({ name, label: null, examples: [] })));
  return { name: null, near: near?.name ?? null };
}

/** Strips what is not the number: a label read along with it, spaces, a leading "No." */
export function cleanLrNo(raw: string | null | undefined): string | null {
  let s = (raw ?? "").trim().toUpperCase();
  if (!s) return null;
  s = s.replace(/^(L\.?\s*R\.?|G\.?\s*R\.?|G\.?\s*C\.?|C\.?\s*N\.?|DOCKET|CONSIGNMENT(\s+NOTE)?|BILTY|AWB)\s*(NO\.?|NUMBER|#)?\s*[:.\-]?\s*/, "");
  s = s.replace(/^(NO\.?|NUMBER|#)\s*[:.\-]?\s*/, "");
  s = s.replace(/\s+/g, "");
  if (!/[0-9]/.test(s)) return null;
  if (s.length < 3 || s.length > 30) return null;
  return s;
}

/** "Paid", "To pay" or "TBB" from however the receipt prints it. */
export function freightTermOf(raw: string | null | undefined): LrSuggestion["freightTerm"] {
  const s = (raw ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (!s) return null;
  if (s === "topay" || s === "tp" || s.startsWith("topay")) return "To pay";
  if (s === "tbb" || s.startsWith("tobebilled") || s === "billed") return "TBB";
  if (s === "paid" || s === "pd" || s.startsWith("paid")) return "Paid";
  return null;
}

function validDay(d: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d ?? "");
  if (!m) return null;
  const [y, mo, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  /* A date-only value, so UTC is the honest reading: 2026-02-30 rolls over and is refused. */
  const t = new Date(Date.UTC(y, mo - 1, day));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === day ? d! : null;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** The model's reading, checked against the directory and the day. */
export function cleanLrReading(r: LrRawReading, directory: LrStyle[], today: string): LrSuggestion {
  const notes: string[] = [];
  const known = matchTransporter(r.transporter, directory);
  /* Only a name already on the list is offered: a receipt's letterhead is not a reason to add a transporter. */
  const transporter = known?.name ?? null;
  if (r.transporter?.trim() && !known) notes.push(`The receipt says "${r.transporter.trim()}", which is not on the transporter list — pick one, or add it under Transporters first.`);

  const lrNo = cleanLrNo(r.lrNo);
  let checkNumber = r.confidence !== "high";
  if (lrNo && known) {
    const fits = fitsStyle(lrNo, known.examples);
    if (fits === false) {
      checkNumber = true;
      notes.push(`${lrNo} does not look like ${known.name}'s earlier numbers (${known.examples.slice(0, 2).join(", ")}) — check it.`);
    }
  }
  if (!lrNo) notes.push(r.lrNo ? `"${r.lrNo}" does not look like an LR number — type it from the photo.` : "No LR number could be read — type it from the photo.");
  else if (checkNumber && !notes.some((n) => n.startsWith(lrNo))) notes.push(`Check ${lrNo} against the photo.`);

  let lrDate = validDay(r.lrDate);
  if (lrDate && (lrDate > today || daysBetween(lrDate, today) > LR_MAX_AGE_DAYS)) {
    notes.push(`The date read (${lrDate}) cannot be this LR's — it was left as today.`);
    lrDate = null;
  }

  const packages = r.packages != null && Number.isFinite(r.packages) && r.packages > 0 && r.packages <= 10_000 ? Math.trunc(r.packages) : null;
  const freightRupees = r.freightRupees != null && Number.isFinite(r.freightRupees) && r.freightRupees > 0 && r.freightRupees < 10_000_000 ? Math.round(r.freightRupees * 100) / 100 : null;
  const destination = r.destination?.trim() || null;

  return { lrNo, lrDate, transporter, destination, packages, freightTerm: freightTermOf(r.freightTerm), freightRupees, checkNumber: Boolean(lrNo) && checkNumber, notes };
}
