/* ---------------------------------------------------------------------------
 * THE PURE HALF OF THE LEAD TOMBSTONES (see `lead-tombstone.ts`).
 *
 * The handset applies a pull's upserts BEFORE its tombstones, so a pull that
 * both sends a lead and carries a `leads` tombstone for it would archive the
 * very row it just delivered — which is what a lead lost and reopened, or
 * taken away and given back, between two of somebody's syncs looks like. A
 * pull therefore never tombstones a lead it is also sending.
 * ------------------------------------------------------------------------- */

export function withoutResentLeads<G extends { entity: string; ids: string[] }>(
  groups: G[],
  sentLeadIds: Iterable<string>,
): G[] {
  const sent = new Set(sentLeadIds);
  if (!sent.size) return groups;
  return groups
    .map((g) => (g.entity === "leads" ? { ...g, ids: g.ids.filter((id) => !sent.has(id)) } : g))
    .filter((g) => g.entity !== "leads" || g.ids.length > 0);
}

/** Whether a set of seats moved, nulls compared as nobody. */
export function seatsMoved(
  before: readonly (string | null | undefined)[],
  after: readonly (string | null | undefined)[],
): boolean {
  if (before.length !== after.length) return true;
  return before.some((b, i) => (b ?? null) !== (after[i] ?? null));
}
