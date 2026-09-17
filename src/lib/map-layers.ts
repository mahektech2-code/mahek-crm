/**
 * WHICH TRAIL LAYERS A REDRAW HAS TO TAKE DOWN — as arithmetic, in one place.
 *
 * PURE AND CLIENT-SAFE, like `handset-health` and `customer-health` beside it,
 * and for a reason worth stating: everything else in `street-map.tsx` needs a
 * WebGL context and a live MapLibre instance to run at all, so a rule written
 * inside it is a rule no test can reach. This is the one part of a redraw that
 * is a decision rather than a call into a library, and it is exactly the part
 * that is wrong when a salesman's line is left on the map after his last fix
 * has gone — so it is lifted out where it can be asserted.
 *
 * A trail is THREE layers over one source, and every one of them has to go
 * together. MapLibre refuses to remove a source that still has a layer reading
 * it, so a partial teardown does not fail loudly — it throws half way through
 * a redraw and takes the rest of the day's drawing with it.
 */

/** The three layers one salesman's trail is drawn with, casing first. */
export function trailLayerIds(salesmanId: string): string[] {
  return [`trail-casing-${salesmanId}`, `trail-${salesmanId}`, `trail-gap-${salesmanId}`];
}

/** The source those three read. */
export function trailSourceId(salesmanId: string): string {
  return `trail-${salesmanId}`;
}

/**
 * Who was drawn last time and is not on the map any more.
 *
 * ORDER IS PRESERVED from what was drawn, rather than taken from a Set, so a
 * teardown is the same sequence twice — a redraw that removes layers in a
 * different order each time is a bug nobody can reproduce.
 *
 * It is deliberately not "everyone drawn who is not wanted AND whose source
 * still exists": whether the source exists is a question for the map, asked at
 * the moment of removal, and mixing it in here would need this function to
 * hold a MapLibre instance and stop being testable — which is the whole point
 * of it being here.
 */
export function departedTrailIds(drawn: readonly string[], wanted: readonly string[]): string[] {
  const keep = new Set(wanted);
  return drawn.filter((id) => !keep.has(id));
}
