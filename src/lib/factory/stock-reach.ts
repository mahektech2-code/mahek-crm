/* ---------------------------------------------------------------------------
 * WHICH STOCK A FLOOR DEPARTMENT MAY CHECK.
 *
 *   Mixing & Blending   raw chemicals and semi-finished (SFG) liquid
 *   Filling             empty cans and drums, filled cans (FG) and packed boxes
 *   Packing             empty boxes and packing stationery
 *   Dispatch            filled cans and packed boxes — what goes on the lorry
 *   Quality             raw chemicals and SFG — what it tests
 *   The whole floor     everything, and so does an administrator
 *
 * Somebody in several departments may check what any of them may. A
 * supervisor of some departments reaches what those departments reach. A raw
 * material is placed by its item-master type (`erp_raw_materials.
 * material_type`); a type no department names is reached by the whole floor
 * only.
 *
 * The server filters the Stock check list AND the office's counts with this,
 * and refuses a check of anything else, because a server action is a URL.
 * PURE, so it is tested without a database.
 * ------------------------------------------------------------------------- */

export type ReachStage = "rm" | "sfg" | "fg" | "pack";

type Dept = "head" | "mixing" | "filling" | "packing" | "dispatch" | "qc";

type Grant = { rmTypes: readonly string[]; stages: readonly Exclude<ReachStage, "rm">[] };

export const STOCK_REACH: Record<Exclude<Dept, "head">, Grant> = {
  mixing: { rmTypes: ["Chemical"], stages: ["sfg"] },
  filling: { rmTypes: ["Can", "Drum"], stages: ["fg", "pack"] },
  packing: { rmTypes: ["Box", "Stationary"], stages: [] },
  dispatch: { rmTypes: [], stages: ["fg", "pack"] },
  qc: { rmTypes: ["Chemical"], stages: ["sfg"] },
};

/** `all` reaches everything; otherwise the raw-material types and the other stages. */
export type StockReach = { all: true } | { all: false; rmTypes: Set<string>; stages: Set<ReachStage> };

/**
 * What one person reaches. `whole` is an administrator or a supervisor of the
 * whole floor; `depts` the departments they work (or, for a supervisor, run).
 */
export function stockReach(whole: boolean, depts: readonly string[]): StockReach {
  if (whole || depts.includes("head")) return { all: true };
  const rmTypes = new Set<string>();
  const stages = new Set<ReachStage>();
  for (const d of depts) {
    const g = STOCK_REACH[d as Exclude<Dept, "head">];
    if (!g) continue;
    for (const t of g.rmTypes) rmTypes.add(t.toLowerCase());
    for (const s of g.stages) stages.add(s);
  }
  if (rmTypes.size) stages.add("rm");
  return { all: false, rmTypes, stages };
}

/** May this person check this item? `materialType` is read for raw materials only. */
export function reaches(r: StockReach, stage: ReachStage, materialType?: string | null): boolean {
  if (r.all) return true;
  if (!r.stages.has(stage)) return false;
  if (stage !== "rm") return true;
  return r.rmTypes.has(String(materialType ?? "").trim().toLowerCase());
}

/** The stages this person's Stock check offers, in the screen's order. */
export function reachStages(r: StockReach): ReachStage[] {
  const all: ReachStage[] = ["rm", "sfg", "fg", "pack"];
  return r.all ? all : all.filter((s) => r.stages.has(s));
}
