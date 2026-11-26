/* ---------------------------------------------------------------------------
 * THE PLACES "WHERE THEY WORK" OFFERS — the master of states and districts
 * merged with what the book knows — PURE, no I/O.
 *
 * AVAILABILITY AND COUNTS ARE TWO THINGS. Every state, union territory and
 * district in the master is offered whether or not a shop is in it, because
 * somebody has to be allocated Sikkim before the first Sikkim shop exists. The
 * shop count beside it comes from the book and is `0` where nothing is placed —
 * said, never hidden.
 *
 * A DISTRICT LINKS TO THE BOOK ONLY ON AN EXACT FOLDED NAME under the same
 * state. Nothing is guessed: "Khorda" in the book and "Khordha" in the master
 * are two entries, and so are "Mumbai" and "Mumbai City". A book district that
 * matches no master district is kept as its own entry, marked `bookOnly`, so
 * that no allocation already made, and no shop already placed, loses its name.
 * ------------------------------------------------------------------------- */

import { canonicalState, stateKey } from "@/lib/india-states";
import { INDIA_GEOGRAPHY } from "@/lib/geography/india-districts";
import { townsOf } from "@/lib/geography/india-towns";
import { placeKey } from "@/lib/place-parse";
import { splitTownParent } from "@/lib/territory-path";
import type { DistrictNode, PlaceTree, StateNode } from "@/lib/services/sales-service";

const bySize = (a: DistrictNode, b: DistrictNode) =>
  b.shops - a.shops || a.district.localeCompare(b.district);

export function mergeMasterWithBook(book: PlaceTree): PlaceTree {
  const bookStates = new Map(book.states.map((s) => [stateKey(canonicalState(s.state)), s]));
  const used = new Set<string>();
  const states: StateNode[] = [];

  for (const master of INDIA_GEOGRAPHY) {
    const key = stateKey(canonicalState(master.name));
    used.add(key);
    const inBook = bookStates.get(key);
    const bookDistricts = new Map((inBook?.districts ?? []).map((d) => [placeKey(d.district), d]));
    const matched = new Set<string>();

    const official: DistrictNode[] = master.districts.map((m) => {
      const k = placeKey(m.name);
      const found = bookDistricts.get(k);
      if (found) matched.add(k);
      /* The book's towns first, then every other town of the district from the
         shared list, at zero. Matched on the folded name, so a town is never
         offered twice (a pick is stored by name); the book's spelling wins. */
      const booked = found?.towns ?? [];
      const have = new Set(booked.map((t) => placeKey(t.town)));
      const unbooked: { town: string; shops: number }[] = [];
      for (const [town] of townsOf(master.name, m.name)) {
        const townKey = placeKey(town);
        if (have.has(townKey)) continue;
        have.add(townKey);
        unbooked.push({ town, shops: 0 });
      }
      return {
        district: m.name,
        towns: [...booked, ...unbooked],
        shops: found?.shops ?? 0,
        ...(m.provisional ? { provisional: true } : {}),
      };
    });

    /* What the book has that the master does not name — kept apart, never merged. */
    const bookOnly: DistrictNode[] = (inBook?.districts ?? [])
      .filter((d) => !matched.has(placeKey(d.district)))
      .map((d) => ({ ...d, bookOnly: true }));

    states.push({
      state: master.name,
      districts: [...official.sort(bySize), ...bookOnly.sort(bySize)],
      shops: inBook?.shops ?? 0,
      undistricted: inBook?.undistricted ?? 0,
    });
  }

  /* A state the book spells in a way the master does not know is kept as typed. */
  for (const [key, node] of bookStates) {
    if (used.has(key)) continue;
    states.push({ ...node, districts: node.districts.map((d) => ({ ...d, bookOnly: true })) });
  }

  return {
    states: states.sort((a, b) => a.state.localeCompare(b.state)),
    statelessShops: book.statelessShops,
  };
}

/* ---------------------------------------------------------------------------
 * WHAT A NARROWED TERRITORY LEAVES OUTSIDE.
 *
 * A district or a town picked under a state narrows that state. A shop the tree
 * placed only as far as the state — or not at all — is reached by a whole-state
 * pick and by nothing finer, so narrowing quietly drops it. The dialog names the
 * number and asks for an explicit yes; the SERVER recomputes the number and
 * refuses a missing or stale one. Nothing here moves a shop or guesses a
 * district for it.
 * ------------------------------------------------------------------------- */

type Leaf = { kind: string; value: string; parent?: string };

/**
 * THE NARROWING LEAVES OF EACH STATE, keyed by the state's canonical name.
 *
 * A district or a town narrows the state it sits in, and so does a typed city
 * (picked before districts existed) and a beat under it. A state-only leaf is
 * the whole state and is not a narrowing. A typed city that never named its
 * state, or a beat whose city is not among the leaves, has no state to say, so
 * it is left out rather than guessed into one.
 */
export function leavesByState(leaves: ReadonlyArray<Leaf>): Map<string, Leaf[]> {
  const fold = (s: string) => s.trim().toLowerCase();
  const out = new Map<string, Leaf[]>();
  const add = (state: string, leaf: Leaf) => {
    const name = canonicalState(state);
    if (!name) return;
    out.set(name, [...(out.get(name) ?? []), leaf]);
  };
  for (const t of leaves) {
    if (t.kind === "district" || t.kind === "city") add(t.parent ?? "", t);
    else if (t.kind === "town") add(splitTownParent(t.parent).state, t);
    else if (t.kind === "beat") {
      const city = leaves.find((c) => c.kind === "city" && fold(c.value) === fold(t.parent ?? ""));
      if (city) add(city.parent ?? "", t);
    }
  }
  return out;
}

/** The states (as canonical names) that have something narrower than the whole state picked under them. */
export function narrowedStates(leaves: ReadonlyArray<Leaf>): string[] {
  return [...leavesByState(leaves).keys()];
}

export type OutsideCount = { state: string; shops: number };

/**
 * Why a save may not go ahead on this acknowledgement — or null if it may.
 *
 * It is needed only when the areas actually change AND something would be left
 * outside. The figures are compared STATE BY STATE, not as a total: two states
 * whose counts moved in opposite directions would pass a total, and a person
 * who confirmed 31 in one state has not confirmed 31 in another. A state that is
 * missing from the acknowledgement counts as zero confirmed, and a state it
 * names that now has nothing outside counts as stale. Missing and stale are
 * different sentences, because "tick the box" and "look again, the number moved"
 * are different things to do.
 */
export function acknowledgementProblem(input: {
  changed: boolean;
  outside: ReadonlyArray<OutsideCount>;
  acknowledged: ReadonlyArray<OutsideCount> | undefined;
}): string | null {
  const total = input.outside.reduce((t, o) => t + (o.shops > 0 ? o.shops : 0), 0);
  if (!input.changed || total <= 0) return null;
  if (input.acknowledged === undefined) {
    return total === 1
      ? "1 shop is not placed in any district and would be left outside this area. Confirm that before saving."
      : `${total.toLocaleString("en-IN")} shops are not placed in any district and would be left outside this area. Confirm that before saving.`;
  }

  const by = (rows: ReadonlyArray<OutsideCount>) => {
    const m = new Map<string, { state: string; shops: number }>();
    for (const r of rows) {
      const k = stateKey(canonicalState(r.state));
      const had = m.get(k);
      m.set(k, { state: had?.state ?? canonicalState(r.state), shops: (had?.shops ?? 0) + r.shops });
    }
    return m;
  };
  const now = by(input.outside);
  const said = by(input.acknowledged);
  for (const k of new Set([...now.keys(), ...said.keys()])) {
    const n = now.get(k)?.shops ?? 0;
    const c = said.get(k)?.shops ?? 0;
    if (n !== c) {
      const state = now.get(k)?.state ?? said.get(k)!.state;
      return `The shops left outside ${state} changed since the dialog counted them — ${n.toLocaleString("en-IN")} now, ${c.toLocaleString("en-IN")} confirmed. Look again before saving.`;
    }
  }
  return null;
}

/**
 * The districts of one state the dropdown offers: the master's and the book's,
 * and any district ALREADY ALLOCATED that neither names — listed as an earlier
 * pick so it stays ticked and is never dropped on Save.
 */
export function offeredDistricts(
  state: StateNode,
  picked: ReadonlyArray<{ kind: string; value: string; parent: string }>,
): Array<{ district: string; shops: number; bookOnly?: boolean; provisional?: boolean; earlierPick?: boolean }> {
  const fold = (s: string) => s.trim().toLowerCase();
  const earlier = picked
    .filter(
      (p) =>
        p.kind === "district" &&
        fold(p.parent) === fold(state.state) &&
        !state.districts.some((d) => fold(d.district) === fold(p.value)),
    )
    .map((p) => ({ district: p.value, shops: 0, earlierPick: true as const }));
  return [...state.districts, ...earlier];
}
