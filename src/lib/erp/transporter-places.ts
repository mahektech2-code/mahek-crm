import { PLACE_KINDS, type PlaceKind } from "@/lib/place-parse";

/* ---------------------------------------------------------------------------
 * Where a transporter keeps godowns, as picks on the reviewed place tree.
 *
 * PURE and client-safe: the form draws the four cascading lists from these
 * and the save prunes with the same function, so what was picked and what is
 * stored cannot disagree. Down a branch is a narrowing — Maharashtra with
 * Bhiwandi under it means Bhiwandi — so only the narrowest pick in a branch is
 * stored, the rule a territory already follows.
 * ------------------------------------------------------------------------- */

export type PlaceOption = { id: string; kind: PlaceKind; name: string; parentId: string | null };

export type PlaceLookup = Map<string, PlaceOption>;

export function lookup(nodes: PlaceOption[]): PlaceLookup {
  return new Map(nodes.map((n) => [n.id, n]));
}

/** The node's ancestors, nearest first. */
export function ancestorsOf(id: string, byId: PlaceLookup): string[] {
  const out: string[] = [];
  let at = byId.get(id)?.parentId ?? null;
  while (at && !out.includes(at)) {
    out.push(at);
    at = byId.get(at)?.parentId ?? null;
  }
  return out;
}

/** Every pick, with the path above each one — what the four lists show as ticked. */
export function withAncestors(ids: string[], byId: PlaceLookup): string[] {
  const out = new Set<string>();
  for (const id of ids) {
    if (!byId.has(id)) continue;
    out.add(id);
    for (const a of ancestorsOf(id, byId)) out.add(a);
  }
  return [...out];
}

/** The narrowest pick in each branch: a pick with another pick beneath it is the path, not the godown. */
export function leaves(ids: string[], byId: PlaceLookup): string[] {
  const picked = new Set(ids.filter((id) => byId.has(id)));
  const covered = new Set<string>();
  for (const id of picked) for (const a of ancestorsOf(id, byId)) covered.add(a);
  return [...picked].filter((id) => !covered.has(id));
}

/** The nearest rung above `kind` that has a pick, with those picks. */
function nearestPickedAbove(kind: PlaceKind, picks: string[], byId: PlaceLookup): Set<string> | null {
  for (let i = PLACE_KINDS.indexOf(kind) - 1; i >= 0; i--) {
    const at = picks.filter((id) => byId.get(id)?.kind === PLACE_KINDS[i]);
    if (at.length) return new Set(at);
  }
  return null;
}

/**
 * What one rung offers: the places of that kind under the picks on the nearest
 * rung above that has any, or every place of that kind where nothing above is
 * picked. Labelled with the parent, because two districts often share a town name.
 */
export function optionsFor(kind: PlaceKind, picks: string[], nodes: PlaceOption[], byId: PlaceLookup): { value: string; label: string }[] {
  const above = nearestPickedAbove(kind, picks, byId);
  return nodes
    .filter((n) => n.kind === kind && (!above || ancestorsOf(n.id, byId).some((a) => above.has(a))))
    .map((n) => {
      const parent = n.parentId ? byId.get(n.parentId)?.name : null;
      return { value: n.id, label: parent ? `${n.name} — ${parent}` : n.name };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * A rung's picks replaced. Picks below that no longer sit under that rung's
 * picks go, because they would be offered nowhere; where the rung is emptied
 * the picks below stay, since each still names a real place.
 */
export function repick(kind: PlaceKind, next: string[], picks: string[], byId: PlaceLookup): string[] {
  const at = PLACE_KINDS.indexOf(kind);
  const keepOther = picks.filter((id) => {
    const k = byId.get(id)?.kind;
    if (!k || k === kind) return false;
    if (PLACE_KINDS.indexOf(k) < at || !next.length) return true;
    return ancestorsOf(id, byId).some((a) => next.includes(a));
  });
  return [...keepOther, ...next];
}

/** "Bhiwandi, Thane, Maharashtra" — the place and the path above it. */
export function placePath(id: string, byId: PlaceLookup): string {
  const n = byId.get(id);
  if (!n) return "";
  return [n.name, ...ancestorsOf(id, byId).map((a) => byId.get(a)?.name ?? "")].filter(Boolean).join(", ");
}
