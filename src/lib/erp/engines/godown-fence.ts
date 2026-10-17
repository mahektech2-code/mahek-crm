import { metresBetween } from "@/lib/geo";

/* ---------------------------------------------------------------------------
 * WHICH GODOWN IS THIS PERSON STANDING IN — the working location read off a
 * fix rather than off a menu.
 *
 * Pure, like every engine: the godowns, the fix and the radius come in as
 * arguments. Only a godown with a pin can be found this way, and only the
 * godowns the person is assigned to are offered, so a fix can never put
 * somebody to work somewhere the menu would not have let them pick.
 *
 * A fix whose accuracy circle is wider than the fence cannot say which side of
 * it somebody is on, so it answers `imprecise` rather than guessing — a
 * storekeeper switched to the wrong godown pre-fills every form with it, which
 * is worse than not being switched at all. Where two fences overlap the
 * nearer pin wins.
 * ------------------------------------------------------------------------- */

export type FenceGodown = { id: string; name: string; lat: number | null; lng: number | null };
export type Fix = { lat: number; lng: number; accuracyM: number | null };

export type FenceVerdict =
  | { kind: "inside"; godown: { id: string; name: string }; metres: number }
  | { kind: "outside"; nearest: { id: string; name: string; metres: number } | null }
  | { kind: "imprecise"; accuracyM: number }
  | { kind: "unpinned" };

export function godownAt(godowns: FenceGodown[], fix: Fix, radiusM: number): FenceVerdict {
  const pinned = godowns.filter(
    (g): g is FenceGodown & { lat: number; lng: number } =>
      g.lat != null && g.lng != null && Number.isFinite(g.lat) && Number.isFinite(g.lng),
  );
  if (!pinned.length) return { kind: "unpinned" };
  if (fix.accuracyM != null && fix.accuracyM > radiusM) return { kind: "imprecise", accuracyM: Math.round(fix.accuracyM) };

  let best: { id: string; name: string; metres: number } | null = null;
  for (const g of pinned) {
    const metres = metresBetween(fix.lat, fix.lng, g.lat, g.lng);
    if (!best || metres < best.metres) best = { id: g.id, name: g.name, metres };
  }
  if (best && best.metres <= radiusM) {
    return { kind: "inside", godown: { id: best.id, name: best.name }, metres: Math.round(best.metres) };
  }
  return { kind: "outside", nearest: best && { ...best, metres: Math.round(best.metres) } };
}
