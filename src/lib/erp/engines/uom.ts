/* ---------------------------------------------------------------------------
 * UNITS OF MEASURE — what a quantity may be typed in.
 *
 * Every ERP quantity is STORED in one base unit per kind of measure, because
 * the stock ledgers, the density conversion and every rule after them add
 * those figures up: weight in kg, volume in litres, a count in pieces (cans,
 * boxes, drums — whatever the field counts). That never changes.
 *
 * What changes is how a person may TYPE it. The units master (`erp_uoms`,
 * ERP → Masters → Reference lists → Units) lists every unit somebody may enter
 * a quantity in, each saying what it measures and how many base units one of
 * it is: Gram is 0.001 kg, a Drum (200 L) is 200 litres, a Dozen is 12. A
 * quantity box offers the units of its own kind, and the figure it hands the
 * form is already in the base unit — so nothing that reads the form, the
 * calculators, the min/max checks or the server's handlers, has to know a
 * unit was chosen at all.
 *
 * Weight and volume are never converted into each other here: that needs the
 * item's density, which is the register's job, not a box's.
 *
 * PURE and client-safe: the quantity box and the server read the same rules.
 * ------------------------------------------------------------------------- */

export const MEASURES = ["weight", "volume", "count"] as const;
export type Measure = (typeof MEASURES)[number];

export const MEASURE_LABEL: Record<Measure, string> = {
  weight: "Weight",
  volume: "Volume",
  count: "Count",
};

/** The base unit each kind of measure is stored in, by its master name. */
export const BASE_UNIT: Record<Measure, string> = { weight: "Kg", volume: "Litre", count: "Pcs" };

/** How the base unit reads after a number, for the "= 400 L" line. */
export const BASE_SHORT: Record<Measure, string> = { weight: "kg", volume: "L", count: "pcs" };

/** One unit of the master, as the browser is handed it. */
export type Uom = {
  id: string;
  name: string;
  measure: Measure;
  /** How many base units one of this is. Always > 0; exactly 1 for a base unit. */
  perBase: number;
  /** A base unit: it cannot be renamed, re-sized or retired. */
  builtIn: boolean;
  active: boolean;
};

/**
 * THE WORDS A BASE UNIT IS ALREADY SPELLED IN. The ERP grew with "Kg",
 * "Litre", "Ltr", "L", "Unit", "Pcs", "cans", "boxes" all in use — a raw
 * material's unit, a count's unit, a label's bracket. Each of them IS the
 * base of its measure, so a quantity box reading any of them knows what it
 * holds without the schema being rewritten.
 */
const BASE_ALIASES: Record<string, Measure> = {
  kg: "weight",
  kgs: "weight",
  kilogram: "weight",
  kilograms: "weight",
  l: "volume",
  ltr: "volume",
  ltrs: "volume",
  litre: "volume",
  litres: "volume",
  liter: "volume",
  liters: "volume",
  pcs: "count",
  pc: "count",
  nos: "count",
  unit: "count",
  units: "count",
  piece: "count",
  pieces: "count",
  cans: "count",
  boxes: "count",
  drums: "count",
};

/** The measure a base word names ("Kg", "Ltr", "cans"…), or null where it names none. */
export function measureOfBase(word: string | null | undefined): Measure | null {
  if (!word) return null;
  return BASE_ALIASES[word.trim().toLowerCase()] ?? null;
}

const key = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** A unit of the master by name, ignoring case and spacing. */
export function findUom(units: readonly Uom[], name: string | null | undefined): Uom | null {
  if (!name) return null;
  const k = key(name);
  return units.find((u) => key(u.name) === k) ?? null;
}

/**
 * The units a quantity of this measure may be typed in, the base first and
 * then by size. Retired units are left out unless the box already holds one.
 */
export function unitsFor(units: readonly Uom[], measure: Measure, keep?: string): Uom[] {
  return units
    .filter((u) => u.measure === measure && (u.active || (keep && key(u.name) === key(keep))))
    .sort((a, b) => Number(b.builtIn) - Number(a.builtIn) || a.perBase - b.perBase || a.name.localeCompare(b.name));
}

/** Round off floating-point dust: 0.1 × 3 is 0.3, not 0.30000000000000004. */
export function tidy(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** A typed amount in `perBase`-sized units, as the base figure. */
export function toBase(amount: number, perBase: number): number {
  return tidy(amount * perBase);
}

/** A base figure, as an amount of `perBase`-sized units. */
export function fromBase(base: number, perBase: number): number {
  return tidy(base / perBase);
}

/**
 * The string a quantity box hands the form: the typed text converted into the
 * base unit, or the text itself where nothing is to be converted. Blank stays
 * blank; a half-typed number ("1.") is handed on as typed when the unit is the
 * base, so the box never loses the point.
 */
export function baseText(typed: string, perBase: number): string {
  const t = typed.trim();
  if (!t) return "";
  if (perBase === 1) return typed;
  const n = Number(t);
  if (!Number.isFinite(n)) return typed;
  return String(toBase(n, perBase));
}

/* ------------------------------------------------------ the master's rules */

export type UomDraft = { name: string; measure: string; perBase: string | number };

/**
 * What is wrong with a new or edited unit, field by field — read by the
 * inline "Add a unit" box and by the server alike. `others` is every other
 * unit of the master, so a duplicate name is caught before the database
 * refuses it.
 */
export function uomProblems(d: UomDraft, others: readonly Pick<Uom, "name">[]): Partial<Record<"name" | "measure" | "perBase", string>> {
  const out: Partial<Record<"name" | "measure" | "perBase", string>> = {};
  const name = d.name.trim().replace(/\s+/g, " ");
  if (!name) out.name = "Name the unit";
  else if (name.length > 40) out.name = "Keep it under 40 characters";
  else if (others.some((o) => key(o.name) === key(name))) out.name = "There is already a unit of that name";
  else if (measureOfBase(name)) {
    /* "Kg", "Ltr", "cans" already mean the base unit everywhere; a second
       unit spelled the same way would read as the base and not be. */
    out.name = "That word already means the base unit";
  }
  if (!(MEASURES as readonly string[]).includes(d.measure)) out.measure = "Choose what it measures";
  const n = typeof d.perBase === "number" ? d.perBase : Number(String(d.perBase).trim());
  if (!String(d.perBase).trim() || !Number.isFinite(n) || n <= 0) out.perBase = "Must be more than 0";
  else if (n > 1e7) out.perBase = "That is too large";
  return out;
}

/** The cleaned name a unit is stored under. */
export function cleanUomName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/** "1 Drum (200 L) = 200 L" — what a unit is, in one line. */
export function uomSentence(u: Pick<Uom, "name" | "measure" | "perBase" | "builtIn">): string {
  if (u.builtIn) return `Base unit for ${MEASURE_LABEL[u.measure].toLowerCase()} — every figure is kept in it`;
  return `1 ${u.name} = ${tidy(u.perBase)} ${BASE_SHORT[u.measure]}`;
}
