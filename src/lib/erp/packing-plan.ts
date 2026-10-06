/* ---------------------------------------------------------------------------
 * PACKING FROM MAHEK PLUS: the "My Products" tab's Can Use, empty boxes, box
 * type and box rate, onto the ERP's per-SKU packing.
 *
 * The tab names its can by the Raw Materials tab's own name for it — "Packing
 * Material 1 liter Mahek Yellow" — and the ERP had none of those raw materials,
 * so a Can Use could not be recorded at all. The plan therefore has two
 * halves: the packing raw materials (Can, Drum, Box) that are missing, and
 * then each SKU's packing pointing at them.
 *
 * PURE, like the engines: it takes the two tabs and what the database already
 * holds, and says what to write and what it could not place. The service does
 * the reading and the writing, and the dry run shows exactly this.
 *
 * Three rules it keeps:
 *
 * A SKU is matched on its legacy PRODUCT ID, never its name. The tab's ID is
 * the same number the catalogue import kept in `external_ids`, and an ID names
 * one row where a name is spelled four ways.
 *
 * A packing somebody already set in the ERP is LEFT ALONE. "Edit packing" is a
 * decision; a re-run must not put the old system's answer back over it. Only a
 * SKU with no packing row at all is written — which also makes it re-runnable.
 *
 * A Can Use that names no Can or Drum is REPORTED, never guessed. The row is
 * still written with the boxes, so one unknown can does not cost the rest.
 * ------------------------------------------------------------------------- */

export const PACKING_MATERIAL_TYPES = ["Can", "Drum", "Box"] as const;
/** What a SKU's Can Use may name — the packing form refuses anything else. */
const CAN_TYPES = new Set(["Can", "Drum"]);

export type SheetRow = { rowNumber: number; cells: Record<string, string> };

export type PlanInput = {
  /** The "My Products" tab. */
  products: SheetRow[];
  /** The "Raw Materials" tab. */
  materials: SheetRow[];
  existingMaterials: { id: string; name: string; materialType: string }[];
  skus: { id: string; name: string; externalCode: string | null; externalIds: number[] | null }[];
  /** SKUs that already carry a packing row. */
  packedProductIds: Set<string>;
  boxTypes: readonly string[];
};

export type NewMaterial = {
  name: string;
  code: string | null;
  unit: "Kg" | "Litre" | "Unit";
  materialType: string;
  pricePaise: number | null;
  remark: string | null;
};

export type NewPacking = {
  productId: string;
  sku: string;
  productIdOnSheet: string;
  /** The material's name, resolved to an id by the service once it exists. */
  canUse: string | null;
  emptyBoxesRequired: number;
  boxType: string | null;
  boxRatePaise: number | null;
};

export type PackingPlan = {
  materials: NewMaterial[];
  /** Packing materials on the tab that the ERP already has. */
  materialsExisting: number;
  /** Chemicals and stationery — a different master, not part of packing. */
  materialsNotPacking: number;
  packing: NewPacking[];
  /** SKUs whose packing was already set in the ERP. */
  kept: { sku: string; productIdOnSheet: string }[];
  /** A Product ID no catalogue SKU carries. */
  noSku: { productIdOnSheet: string; name: string; row: number }[];
  /** A Can Use naming nothing of type Can or Drum. The packing is written without it. */
  unknownCan: { sku: string; canUse: string; row: number }[];
  /**
   * A second Product ID for a SKU the catalogue settled onto one name, whose
   * packing disagrees with the first row's. The first row is what was written.
   */
  conflicting: { sku: string; productIdOnSheet: string; keptFrom: string; row: number }[];
  /** A Box Type the ERP does not offer. The packing is written without it. */
  unknownBoxType: { sku: string; boxType: string; row: number }[];
};

const key = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
const cell = (r: SheetRow, h: string) => (r.cells[h] ?? "").trim();
const numberOf = (s: string) => {
  const n = Number(s.replace(/,/g, ""));
  return s === "" || !Number.isFinite(n) ? null : n;
};

/** The tab says Pcs where the ERP says Unit; anything unrecognised is a count. */
export function erpUnit(u: string): NewMaterial["unit"] {
  const k = key(u);
  if (k === "kg") return "Kg";
  if (k === "litre" || k === "liter" || k === "ltr") return "Litre";
  return "Unit";
}

export function planPackingImport(input: PlanInput): PackingPlan {
  /* ---- the packing raw materials ---- */
  const known = new Map(input.existingMaterials.map((m) => [key(m.name), m]));
  const materials: NewMaterial[] = [];
  let materialsExisting = 0;
  let materialsNotPacking = 0;
  for (const r of input.materials) {
    const name = cell(r, "Raw Item");
    const type = cell(r, "Material type");
    if (!name) continue;
    if (!(PACKING_MATERIAL_TYPES as readonly string[]).includes(type)) {
      materialsNotPacking++;
      continue;
    }
    if (known.has(key(name))) {
      materialsExisting++;
      continue;
    }
    const price = numberOf(cell(r, "Price"));
    const m: NewMaterial = {
      name: name.replace(/\s+/g, " "),
      code: cell(r, "Item Code") || null,
      unit: erpUnit(cell(r, "Item Unit")),
      materialType: type,
      pricePaise: price == null || price <= 0 ? null : Math.round(price * 100),
      remark: cell(r, "Remark") || null,
    };
    materials.push(m);
    known.set(key(name), { id: "", name: m.name, materialType: type });
  }

  /* ---- each SKU's packing ---- */
  const byLegacyId = new Map<string, PlanInput["skus"][number]>();
  for (const s of input.skus) {
    for (const id of s.externalIds ?? []) byLegacyId.set(String(id), s);
    if (s.externalCode) byLegacyId.set(s.externalCode.trim(), s);
  }
  const plan: PackingPlan = {
    materials,
    materialsExisting,
    materialsNotPacking,
    packing: [],
    kept: [],
    noSku: [],
    unknownCan: [],
    unknownBoxType: [],
    conflicting: [],
  };
  const seen = new Map<string, SheetRow>();
  const packingOf = (r: SheetRow) =>
    [cell(r, "Can Use"), cell(r, "Box Type"), cell(r, "No. Of Empty Box Required") || "0"].map(key).join("|");
  /* Where the catalogue has CHOSEN which legacy ID a SKU is (`externalCode`),
     that ID's row speaks for it; otherwise the first row on the tab does. */
  const canonical = (r: SheetRow) => {
    const pid = cell(r, "Product ID");
    return byLegacyId.get(pid)?.externalCode?.trim() === pid ? 0 : 1;
  };
  const ordered = input.products.map((r, i) => ({ r, i })).sort((a, b) => canonical(a.r) - canonical(b.r) || a.i - b.i).map((x) => x.r);
  for (const r of ordered) {
    const pid = cell(r, "Product ID");
    if (!pid) continue;
    const sku = byLegacyId.get(pid);
    if (!sku) {
      plan.noSku.push({ productIdOnSheet: pid, name: cell(r, "Description Of Goods") || cell(r, "FG Product Name"), row: r.rowNumber });
      continue;
    }
    /* Two legacy IDs settled onto one SKU: one row speaks for it, and another
       that says something different is reported rather than lost. */
    const first = seen.get(sku.id);
    if (first) {
      if (packingOf(first) !== packingOf(r))
        plan.conflicting.push({ sku: sku.name, productIdOnSheet: pid, keptFrom: cell(first, "Product ID"), row: r.rowNumber });
      continue;
    }
    seen.set(sku.id, r);
    if (input.packedProductIds.has(sku.id)) {
      plan.kept.push({ sku: sku.name, productIdOnSheet: pid });
      continue;
    }

    const canName = cell(r, "Can Use");
    let canUse: string | null = null;
    if (canName) {
      const m = known.get(key(canName));
      if (m && CAN_TYPES.has(m.materialType)) canUse = m.name;
      else plan.unknownCan.push({ sku: sku.name, canUse: canName, row: r.rowNumber });
    }

    const boxName = cell(r, "Box Type");
    let boxType: string | null = null;
    if (boxName) {
      boxType = input.boxTypes.find((b) => key(b) === key(boxName)) ?? null;
      if (!boxType) plan.unknownBoxType.push({ sku: sku.name, boxType: boxName, row: r.rowNumber });
    }

    const boxes = numberOf(cell(r, "No. Of Empty Box Required"));
    const rate = numberOf(cell(r, "Rate"));
    plan.packing.push({
      productId: sku.id,
      sku: sku.name,
      productIdOnSheet: pid,
      canUse,
      emptyBoxesRequired: boxes == null || boxes < 0 ? 0 : Math.round(boxes),
      boxType,
      /* The tab writes 0 on a loose SKU, which has no box to cost. */
      boxRatePaise: rate == null || rate <= 0 ? null : Math.round(rate * 100),
    });
  }
  return plan;
}
