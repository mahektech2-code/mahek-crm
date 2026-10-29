import { z } from "zod";
import { PLACE_KINDS, placeKey, type PlaceKind } from "@/lib/place-parse";
import { lookup, pickOf, resolvePick, type PlaceOption, type PlacePick, type ResolvedRung } from "@/lib/erp/transporter-godowns";

/* ---------------------------------------------------------------------------
 * WHERE A CUSTOMER IS, picked on the reviewed place tree — PURE and
 * client-safe, so the add and edit forms check what the save checks.
 *
 * State → District → City → Area, each list narrowed by the rung above, the
 * same picker a transporter's godown uses (`lib/erp/transporter-godowns.ts`).
 * State, district and city are required; the AREA may be left out — plenty of
 * shops sit in a town nobody has divided into areas. A district, city or area
 * that is not listed can be typed under the rung above and is added to the
 * tree on save, matched first by name so nothing is added twice. A state is
 * never typed.
 * ------------------------------------------------------------------------- */

/** Rungs a customer may leave unpicked. */
export const CUSTOMER_OPTIONAL_RUNGS: readonly PlaceKind[] = ["area"];

const rungSchema = z
  .object({ id: z.string().trim().max(60).nullable().optional(), name: z.string().trim().max(80).nullable().optional() })
  .optional();

export const placePickSchema = z.object({
  state: rungSchema,
  district: rungSchema,
  city: rungSchema,
  area: rungSchema,
});

/** A customer's stored place as the four rungs, from the deepest id it carries. */
export function customerPick(
  ids: { stateId: string | null; districtId: string | null; cityId: string | null; areaId: string | null; region?: string | null },
  tree: PlaceOption[],
): PlacePick {
  const deepest = ids.areaId ?? ids.cityId ?? ids.districtId ?? ids.stateId;
  if (deepest) return pickOf(deepest, lookup(tree));
  // Not on the tree yet: open on the state the record's typed text names, if it names one.
  const key = ids.region ? placeKey(ids.region) : "";
  const state = key ? tree.find((n) => n.kind === "state" && placeKey(n.name) === key) : undefined;
  return state ? { state: { id: state.id } } : {};
}

/** The rungs as they will be stored, or the first rung that is wrong and why. */
export function resolveCustomerPick(
  pick: PlacePick,
  tree: PlaceOption[],
): { ok: true; rungs: ResolvedRung[] } | { ok: false; kind: PlaceKind; message: string } {
  return resolvePick(pick, lookup(tree), tree, CUSTOMER_OPTIONAL_RUNGS);
}

/** The name picked or typed at one rung. */
export function rungNameOf(pick: PlacePick, kind: PlaceKind, tree: PlaceOption[]): string {
  const r = pick[kind];
  if (!r) return "";
  if (r.id) return tree.find((n) => n.id === r.id)?.name ?? "";
  return (r.name ?? "").trim();
}

/** Whether two picks name the same place. */
export function samePick(a: PlacePick, b: PlacePick): boolean {
  return PLACE_KINDS.every((k) => (a[k]?.id ?? null) === (b[k]?.id ?? null) && (a[k]?.id ? true : (a[k]?.name ?? "").trim() === (b[k]?.name ?? "").trim()));
}
