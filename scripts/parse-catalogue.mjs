/* ---------------------------------------------------------------------------
 * Turns the product-master document into src/db/catalogue-seed.ts.
 *
 * Run by hand when a new revision of the document arrives:
 *
 *   node scripts/parse-catalogue.mjs ~/Downloads/mahek_unique_products.md
 *
 * The document is the source, the generated module is what ships, and the
 * importer is what writes rows — three steps, because a hand-edited copy of a
 * document nobody can regenerate is how catalogues rot. Nothing here touches a
 * database; it prints what it inferred and refuses to write on a contradiction.
 * ------------------------------------------------------------------------- */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC =
  process.argv[2] ??
  resolve(process.env.HOME ?? "", "Downloads/mahek_unique_products.md");
const OUT = resolve(HERE, "../src/db/catalogue-seed.ts");

const text = readFileSync(SRC, "utf8");

/* ------------------------------------------------------------ the tables */

function section(title) {
  const i = text.indexOf(title);
  if (i < 0) throw new Error(`section not found: ${title}`);
  const rest = text.slice(i);
  const end = rest.indexOf("\n---");
  return rest
    .slice(0, end < 0 ? undefined : end)
    .split("\n")
    .filter((l) => l.trim().startsWith("|"))
    .map((l) =>
      l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()),
    )
    .filter((c) => !/^-+$/.test(c[0]) && c[0] !== "#");
}

/* ------------------------------------------------------- normalisation */

/** Point 5: spacing, bracket spacing and Can/box → Can/Box. */
function canonical(name) {
  return name
    .replace(/\s+/g, " ")
    .replace(/\s*\(\s*/g, " (")
    .replace(/\s*\)/g, ")")
    .replace(/can\/box/gi, "Can/Box")
    .trim();
}

/** The matching key behind the canonical name: letters and digits only. */
const key = (name) => canonical(name).toLowerCase().replace(/[^a-z0-9]/g, "");

const tokens = (s) =>
  new Set(
    canonical(s)
      .toLowerCase()
      .replace(/[^a-z0-9. ]/g, " ")
      .split(/\s+/)
      .filter(Boolean),
  );

/** "0.8 L" → 800, "200 L" → 200000. Millilitres, because 0.5 L is a real size. */
const millilitres = (size) => Math.round(Number(size.replace(/[^0-9.]/g, "")) * 1000);

/* ------------------------------------------------------------ level 1–3 */

const formulations = section("## 1. Base formulations").map((c) => ({
  name: c[1],
  declaredBrands: Number(c[2]),
  declaredSkus: Number(c[3]),
}));

const brands = section("## 2. Brand lines").map((c) => ({
  name: c[1],
  formulation: c[2],
  declaredSkus: Number(c[4]),
}));

const goods = section("## 3. Finished goods").map((c) => ({
  name: canonical(c[1]),
  formulation: c[2],
  millilitres: millilitres(c[3]),
}));

/* -------------------------------------------------------------- level 4 */

/** The LAST bracketed group is the packing. Earlier ones are grade — (SD), (No. 4). */
function splitPacking(name) {
  const m = name.match(/^(.*)\s*\(([^()]*)\)\s*$/);
  if (!m) return { good: canonical(name), packing: null };
  return { good: canonical(m[1]), packing: canonical(m[2]) };
}

/**
 * A few rows name no packing at all — "Melody N C Thinner - 200 Liter".
 * Defaulting those to Loose would be wrong in the expensive direction: they
 * are drums, they carry a drum cost, and calling one loose makes that cost
 * read as a box cost. So the packing comes off the row's own numbers instead.
 */
function derivePacking(cansPerBox, hasContainerCost) {
  if (cansPerBox > 1) return `${cansPerBox} Can/Box`;
  return hasContainerCost ? "Drum" : "Loose";
}

const skus = section("## 4. Sellable SKUs").map((c) => {
  const rawName = c[1].replace(/\s*⚠\s*$/, "").trim();
  const { good, packing } = splitPacking(rawName);
  const cansPerBox = Number(c[4]);
  // Point 6: the empty box or drum, not a selling price.
  const packingCostPaise =
    c[5] === "—" ? null : Math.round(Number(c[5].replace(/[^0-9.]/g, "")) * 100);
  return {
    rawName,
    name: canonical(rawName),
    goodName: good,
    packing: packing ?? derivePacking(cansPerBox, packingCostPaise != null),
    // One can and nothing containing it. A drum IS a container and carries a
    // cost, so a drum is not loose — that is what keeps the two costs apart.
    loose: cansPerBox === 1 && packingCostPaise == null,
    formulation: c[2],
    millilitresPerCan: millilitres(c[3]),
    cansPerBox,
    packingCostPaise,
    // Point 12: per box where there is a box, per can where there is not.
    weightGrams: c[6] === "—" ? null : Math.round(Number(c[6].replace(/[^0-9.]/g, "")) * 1000),
    weightBasis: cansPerBox > 1 ? "box" : "can",
    externalIds: c[7].split(",").map((s) => Number(s.trim())),
    // Point 4: flagged, never auto-resolved.
    duplicated: c[1].includes("⚠"),
  };
});

/* -------------------------------------------------- SKU → finished good */

const goodByKey = new Map(goods.map((g) => [key(g.name), g]));

/**
 * Where the SKU name does not name a finished good outright, the document has
 * collapsed a container or brand-prefix variant ("… Tin Can …", "Mahek Epoxy"
 * against "Epoxy"). Such a SKU is placed among the goods of its OWN
 * formulation and size — neither is ever guessed — and the closest name wins.
 */
function bestGood(sku) {
  const want = tokens(sku.goodName);
  let best = null;
  let bestScore = -Infinity;
  for (const g of goods) {
    if (g.formulation !== sku.formulation) continue;
    if (g.millilitres !== sku.millilitresPerCan) continue;
    const have = tokens(g.name);
    let shared = 0;
    for (const t of have) if (want.has(t)) shared++;
    const score = shared - 0.1 * (have.size - shared);
    if (score > bestScore) {
      bestScore = score;
      best = g;
    }
  }
  return best;
}

let exact = 0;
let inferred = 0;
const orphanSkus = [];
for (const s of skus) {
  const direct = goodByKey.get(key(s.goodName));
  const good = direct ?? bestGood(s);
  if (direct) exact++;
  else if (good) inferred++;
  else orphanSkus.push(s.rawName);
  s.finishedGood = good?.name ?? null;
}

/* ----------------------------------------------- finished good → brand */

const orphanGoods = [];
for (const g of goods) {
  const want = tokens(g.name);
  let best = null;
  let bestScore = -Infinity;
  for (const b of brands) {
    if (b.formulation !== g.formulation) continue;
    const have = tokens(b.name);
    let shared = 0;
    for (const t of have) if (want.has(t)) shared++;
    // A brand token the good does not carry is strong evidence against, so
    // "Mahek N C Thinner" never claims a Melody good.
    const score = shared - 2 * (have.size - shared);
    if (score > bestScore) {
      bestScore = score;
      best = b;
    }
  }
  if (best) g.brand = best.name;
  else orphanGoods.push(g.name);
}

for (const s of skus) {
  s.brand = goods.find((g) => g.name === s.finishedGood)?.brand ?? null;
}

/* ------------------------------------------------------------ contradictions */

const fatal = [];
if (orphanSkus.length) fatal.push(`SKUs with no finished good: ${orphanSkus.join(", ")}`);
if (orphanGoods.length) fatal.push(`finished goods with no brand: ${orphanGoods.join(", ")}`);

const dupNames = new Map();
for (const s of skus) dupNames.set(s.name, (dupNames.get(s.name) ?? 0) + 1);
const collisions = [...dupNames].filter(([, n]) => n > 1).map(([n]) => n);
// Point 3: the canonical name is the join key, so it has to be unique.
if (collisions.length) fatal.push(`canonical name collisions: ${collisions.join(", ")}`);

if (fatal.length) {
  console.error("Refusing to write:\n  " + fatal.join("\n  "));
  process.exit(1);
}

/* The document's own counts, checked rather than trusted. */
const perBrand = new Map();
const perFormulation = new Map();
for (const s of skus) {
  perBrand.set(s.brand, (perBrand.get(s.brand) ?? 0) + 1);
  perFormulation.set(s.formulation, (perFormulation.get(s.formulation) ?? 0) + 1);
}
const discrepancies = [
  ...brands
    .filter((b) => (perBrand.get(b.name) ?? 0) !== b.declaredSkus)
    .map((b) => `brand "${b.name}": document says ${b.declaredSkus} SKUs, the rows give ${perBrand.get(b.name) ?? 0}`),
  ...formulations
    .filter((f) => (perFormulation.get(f.name) ?? 0) !== f.declaredSkus)
    .map((f) => `formulation "${f.name}": document says ${f.declaredSkus} SKUs, the rows give ${perFormulation.get(f.name) ?? 0}`),
];

/* ----------------------------------------------------------------- emit */

const q = (v) =>
  v === null ? "null" : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v);

const file = `/* ---------------------------------------------------------------------------
 * GENERATED by scripts/parse-catalogue.mjs from the product-master document.
 * Do not edit by hand — regenerate, then re-run the import, which is
 * idempotent and will report exactly what changed.
 *
 * Four levels. Formulation and brand are internal grouping; a finished good is
 * what people call a product; a SKU is what gets ordered, and it is the only
 * level an order line may attach to.
 * ------------------------------------------------------------------------- */

export type SeedFormulation = { name: string };

export type SeedBrand = { name: string; formulation: string };

export type SeedFinishedGood = {
  name: string;
  brand: string;
  formulation: string;
  /** Millilitres, because 0.5 L and 0.8 L are both real sizes here. */
  millilitres: number;
};

export type SeedSku = {
  /** As the document spells it, for reconciling against legacy records. */
  rawName: string;
  /** Spacing and casing fixed. The join key to legacy order lines. */
  name: string;
  finishedGood: string;
  brand: string;
  formulation: string;
  millilitresPerCan: number;
  cansPerBox: number;
  /** "6 Can/Box", "Loose", "Drum" — as printed on the SKU name. */
  packing: string;
  loose: boolean;
  /** The empty box or drum. NOT a selling price. Null where there is no box. */
  packingCostPaise: number | null;
  /** Per box where cansPerBox > 1, per can otherwise. Transport, not pricing. */
  weightGrams: number | null;
  weightBasis: "box" | "can";
  /** Product IDs in the legacy system. Reference only — never a primary key. */
  externalIds: number[];
  /** More than one legacy ID shares this name. A human picks the canonical one. */
  duplicated: boolean;
};

/** A legacy row deliberately not imported, and why. */
export type SeedExclusion = { externalId: number; name: string; reason: string };

/** A legacy row that cannot be sold until somebody names it. */
export type SeedException = {
  externalId: number;
  formulation: string;
  millilitresPerCan: number;
  reason: string;
};

export const FORMULATIONS: SeedFormulation[] = [
${formulations.map((f) => `  { name: ${q(f.name)} },`).join("\n")}
];

export const BRANDS: SeedBrand[] = [
${brands.map((b) => `  { name: ${q(b.name)}, formulation: ${q(b.formulation)} },`).join("\n")}
];

export const FINISHED_GOODS: SeedFinishedGood[] = [
${goods
  .map(
    (g) =>
      `  { name: ${q(g.name)}, brand: ${q(g.brand)}, formulation: ${q(g.formulation)}, millilitres: ${g.millilitres} },`,
  )
  .join("\n")}
];

export const SKUS: SeedSku[] = [
${skus
  .map(
    (s) =>
      `  {\n` +
      `    rawName: ${q(s.rawName)},\n` +
      `    name: ${q(s.name)},\n` +
      `    finishedGood: ${q(s.finishedGood)},\n` +
      `    brand: ${q(s.brand)},\n` +
      `    formulation: ${q(s.formulation)},\n` +
      `    millilitresPerCan: ${s.millilitresPerCan},\n` +
      `    cansPerBox: ${s.cansPerBox},\n` +
      `    packing: ${q(s.packing)},\n` +
      `    loose: ${s.loose},\n` +
      `    packingCostPaise: ${q(s.packingCostPaise)},\n` +
      `    weightGrams: ${q(s.weightGrams)},\n` +
      `    weightBasis: ${q(s.weightBasis)},\n` +
      `    externalIds: [${s.externalIds.join(", ")}],\n` +
      `    duplicated: ${s.duplicated},\n` +
      `  },`,
  )
  .join("\n")}
];

/** Point 8: packaging material, not something anybody can order. */
export const EXCLUSIONS: SeedExclusion[] = [
  { externalId: 152, name: "Empty Drum", reason: "Packaging material, not a sellable product" },
];

/** Point 9: packing configuration but no sellable name. Held, not imported. */
export const EXCEPTIONS: SeedException[] = [
  { externalId: 76, formulation: "Epoxy Thinner (FD)", millilitresPerCan: 1000, reason: "No sellable name in the source" },
  { externalId: 77, formulation: "Epoxy Thinner (FD)", millilitresPerCan: 5000, reason: "No sellable name in the source" },
];

/**
 * Where the document contradicts itself. Reported by the importer rather than
 * silently reconciled — a count that does not add up is a question for whoever
 * maintains the document, not something an import should decide.
 */
export const SOURCE_DISCREPANCIES: string[] = [
${discrepancies.map((d) => `  ${q(d)},`).join("\n")}
];
`;

writeFileSync(OUT, file);

console.log(`Wrote ${OUT}`);
console.log(
  `  ${formulations.length} formulations · ${brands.length} brands · ` +
    `${goods.length} finished goods · ${skus.length} SKUs`,
);
console.log(`  finished good matched by name ${exact}, inferred ${inferred}`);
console.log(`  ${skus.filter((s) => s.duplicated).length} names need a canonical ID chosen`);
for (const d of discrepancies) console.log(`  discrepancy: ${d}`);
