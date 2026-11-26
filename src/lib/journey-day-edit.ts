/**
 * What the office's picker is about to do to one day — PURE.
 *
 * The edit is held as what was ADDED and what was REMOVED, never as the whole
 * list. A picker that holds the whole list and opens empty deletes every shop
 * nobody happened to tick again, which is the fault this replaced.
 */

export type DayStop = { customerId: string; status: string };

export type DayEdit = {
  /** Ticked now: what is on the day and staying, plus what is being added. */
  selected: Set<string>;
  /** Already visited or skipped. Part of the day, and not editable. */
  locked: Set<string>;
  /** Saved on the day and still waiting to be walked. */
  saved: Set<string>;
  added: string[];
  removed: string[];
  /** How many stops the day will have once saved. */
  total: number;
};

export function dayEdit(
  stops: ReadonlyArray<DayStop>,
  added: ReadonlyArray<string>,
  removed: ReadonlyArray<string>,
): DayEdit {
  const locked = new Set(stops.filter((s) => s.status !== "planned").map((s) => s.customerId));
  const saved = new Set(
    stops.filter((s) => s.status === "planned" && !locked.has(s.customerId)).map((s) => s.customerId),
  );
  /* Filtered against what is saved NOW, so a draft that has since landed (or a
     shop somebody else took off) is not counted a second time. */
  const adding = [...new Set(added)].filter((id) => !saved.has(id) && !locked.has(id));
  const removing = [...new Set(removed)].filter((id) => saved.has(id));
  const selected = new Set([...locked, ...saved, ...adding]);
  for (const id of removing) selected.delete(id);
  return { selected, locked, saved, added: adding, removed: removing, total: selected.size };
}

export function saveStopsLabel(edit: Pick<DayEdit, "total" | "added" | "removed">): string {
  return `Save ${edit.total} ${edit.total === 1 ? "stop" : "stops"} (${edit.added.length} added, ${edit.removed.length} removed)`;
}

/**
 * Whether the office arranged a day: it has stops, and the salesman created none
 * of them. His pick replaces the planned stops with rows in his own name, so a
 * day he arranged reads as his however it started. A stop with no creator on
 * record is not claimed for the office.
 */
export function arrangedByOffice(
  stops: ReadonlyArray<{ createdById: string | null }>,
  salesmanId: string,
): boolean {
  return stops.length > 0 && stops.every((s) => s.createdById !== null && s.createdById !== salesmanId);
}

/**
 * A `planned` day is edited from the office only where the office arranged it
 * and it has not gone by. Every other state is as it was.
 */
export function officeMayEdit(
  day: { dayState: string; planDate: string; officeArranged: boolean } | null,
  today: string,
): boolean {
  if (!day || day.dayState !== "planned") return true;
  return day.officeArranged && day.planDate >= today;
}
