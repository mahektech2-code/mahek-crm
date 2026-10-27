/* ---------------------------------------------------------------------------
 * HOW A TERRITORY ROW NAMES ITS PLACE — PURE, no imports, client-safe.
 *
 * Apart from `territory-rules.ts` because the "Where they work" dialog is a
 * client component and that file pulls in drizzle to build its SQL. The
 * dialog writes these strings and the rules read them back, so they have to
 * come from one place: a town written as "Thane, Maharashtra" by the screen
 * and split on something else by the server is a town that matches nothing.
 * ------------------------------------------------------------------------- */

/**
 * A town row's parent: its district, then that district's state.
 *
 * A town hangs from a district, but the district's own name cannot say which
 * one — there is an Aurangabad district in Maharashtra and another in Bihar,
 * each with an Aurangabad town in it — so the state rides along.
 */
export function townParent(district: string, state: string): string {
  return `${district.trim()}, ${state.trim()}`;
}

/** The two halves of a town row's parent. Neither name carries a comma. */
export function splitTownParent(parent: string | null | undefined): { district: string; state: string } {
  const raw = (parent ?? "").trim();
  const at = raw.lastIndexOf(",");
  return at < 0
    ? { district: raw, state: "" }
    : { district: raw.slice(0, at).trim(), state: raw.slice(at + 1).trim() };
}

/**
 * The narrowest name of an allocation, as a chip or a list says it. A district
 * says so, because Thane district and the town of Thane are both allocations
 * and "Thane" alone would not tell anybody which one he was given.
 */
export function territoryName(t: { kind: string; value: string }): string {
  return t.kind === "district" ? `${t.value} district` : t.value;
}
