import * as React from "react";

/**
 * THE OWNER PICKER'S OPTIONS, drawn once for every "Change owner" list.
 *
 * Four screens hand a lead to somebody — the bulk button, the list's row menu,
 * the lead record and the Calling desk — and each drew its own `<option>`s from
 * a list of Calling-desk holders alone, so a person who had not been granted the
 * desk was missing and the list looked short. They all draw from here now:
 * Unassigned first, then everybody, in the order they were given.
 *
 * A person without the Calling desk is listed and DISABLED, with the reason in
 * the label. The server still refuses a lead given to somebody with no desk to
 * see it on, so offering them as a live choice would be offering a refusal.
 */

/** The value the picker holds for "Unassigned". An empty string means "not chosen yet". */
export const UNASSIGNED = "__unassigned__";

export type OwnerPerson = {
  id: string;
  name: string;
  canOwn?: boolean;
  /**
   * Where a lead given to them shows up. Nothing is said for the usual case
   * (`desk`); the two that are not on a Calling desk say so in the label, so a
   * choice is never silent about where the lead lands. Optional because the
   * Calling desk's own assign list predates it.
   */
  place?: "desk" | "crm" | "handset";
};

function labelFor(p: OwnerPerson): string {
  if (p.canOwn === false) return `${p.name} (no Calling desk)`;
  if (p.place === "crm") return `${p.name} (All Leads, no desk)`;
  if (p.place === "handset") return `${p.name} (Salesman App)`;
  return p.name;
}

/** What the action takes: `null` is Unassigned. */
export function ownerIdFor(value: string): string | null {
  return value === UNASSIGNED ? null : value;
}

/** The first person who can actually be chosen, for a picker that starts somewhere. */
export function firstChoosable(people: OwnerPerson[]): string {
  return people.find((p) => p.canOwn !== false)?.id ?? UNASSIGNED;
}

export function OwnerOptions({ people }: { people: OwnerPerson[] }) {
  return (
    <>
      <option value={UNASSIGNED}>Unassigned</option>
      {people.map((p) => (
        <option key={p.id} value={p.id} disabled={p.canOwn === false}>
          {labelFor(p)}
        </option>
      ))}
    </>
  );
}
