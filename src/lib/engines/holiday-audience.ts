/* ---------------------------------------------------------------------------
 * WHO A HOLIDAY IS FOR — PURE, and the one statement of it.
 *
 * A holiday used to be a date, a name and a free-text "where". The server's
 * attendance verdict read every row as a day off for everybody, the handset
 * read only the rows with an empty "where", and a state holiday in Odisha was
 * either everybody's or nobody's depending on which screen was asking.
 *
 * Now a holiday has a LEVEL — company, state, district, city, area, or named
 * people — and the places it names are picked from the reviewed place tree
 * (`places`), never typed. Who it reaches is worked out here, from the
 * territories each salesman is allocated, and then narrowed or widened person
 * by person: an INCLUDE gives the day to somebody the place does not reach (a
 * festival of one community, a man whose family is in Odisha), an EXCLUDE
 * takes it away from somebody it would otherwise reach.
 *
 * Exclude wins over include and over the place, because it is always the more
 * specific decision: somebody looked at THIS person on THIS day and said no.
 *
 * Pure, because the answer decides whether a day reads as absent on the
 * record pay is read against, and a rule that only runs with a database is a
 * rule nobody tests. `holiday-service.ts` wires it to data and writes what it
 * answers into `mbos_holiday_members`, which every SQL reader joins.
 * ------------------------------------------------------------------------- */

import { canonicalState, stateKey, stateVariants } from "@/lib/india-states";
import { placeKey } from "@/lib/place-parse";

export const HOLIDAY_LEVELS = ["company", "state", "district", "city", "area", "people"] as const;
export type HolidayLevel = (typeof HOLIDAY_LEVELS)[number];

export const HOLIDAY_LEVEL_LABEL: Record<HolidayLevel, string> = {
  company: "Company-wide",
  state: "State",
  district: "District",
  city: "City",
  area: "Area",
  people: "Named people",
};

/** What kind of day it is. A label, not a rule: nothing here reads it. */
export const HOLIDAY_CATEGORIES = ["National", "Festival", "Regional", "Weekly off", "Special"] as const;
export type HolidayCategory = (typeof HOLIDAY_CATEGORIES)[number];

export function isHolidayLevel(v: unknown): v is HolidayLevel {
  return typeof v === "string" && (HOLIDAY_LEVELS as readonly string[]).includes(v);
}

/** The place kind a level picks from — null for the two that pick none. */
export function placeKindFor(level: HolidayLevel): "state" | "district" | "city" | "area" | null {
  return level === "company" || level === "people" ? null : level;
}

export type PlaceNode = { id: string; kind: string; name: string; parentId: string | null };

export type TerritoryRow = { kind: string; value: string; parent: string };

export type HolidayPerson = { id: string; territories: TerritoryRow[] };

export type HolidayRule = {
  level: HolidayLevel;
  placeIds: string[];
  /** People given the day whatever the place says. */
  include: string[];
  /** People the day is taken away from whatever the place says. */
  exclude: string[];
};

export type Membership = {
  /** Why: "Company-wide", "Odisha", "Named", … — one per reason that applies. */
  reasons: string[];
  /** True where the place reaches him and nobody named him. */
  byPlace: boolean;
};

const sameState = (a: string, b: string) =>
  !!a.trim() && !!b.trim() && stateVariants(canonicalState(b)).includes(stateKey(a));
const sameName = (a: string, b: string) => placeKey(a) !== "" && placeKey(a) === placeKey(b);

/** A tree read once: ancestors by id, and every name under a node. */
export function indexTree(nodes: PlaceNode[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, PlaceNode[]>();
  for (const n of nodes) {
    if (!n.parentId) continue;
    const list = children.get(n.parentId) ?? [];
    list.push(n);
    children.set(n.parentId, list);
  }
  function ancestor(id: string, kind: string): PlaceNode | null {
    let at = byId.get(id) ?? null;
    while (at && at.kind !== kind) at = at.parentId ? (byId.get(at.parentId) ?? null) : null;
    return at;
  }
  function below(id: string, kind: string): PlaceNode[] {
    const out: PlaceNode[] = [];
    const walk = (n: string) => {
      for (const c of children.get(n) ?? []) {
        if (c.kind === kind) out.push(c);
        walk(c.id);
      }
    };
    walk(id);
    return out;
  }
  /* Which states a city NAME sits in, across the whole tree — how a city row
     with no stated parent, or a beat's parent city, is placed in a state. */
  const cityStates = new Map<string, Set<string>>();
  for (const n of nodes) {
    if (n.kind !== "city" && n.kind !== "district") continue;
    const st = ancestor(n.id, "state");
    if (!st) continue;
    const key = placeKey(n.name);
    const set = cityStates.get(key) ?? new Set<string>();
    set.add(canonicalState(st.name));
    cityStates.set(key, set);
  }
  return { byId, ancestor, below, cityStates };
}

export type TreeIndex = ReturnType<typeof indexTree>;

/** "Cuttack (Odisha)" — how a picked place reads on a screen and on the phone. */
export function placeLabel(tree: TreeIndex, id: string): string {
  const n = tree.byId.get(id);
  if (!n) return "a place no longer on the tree";
  if (n.kind === "state") return n.name;
  const up = n.kind === "area" ? tree.ancestor(id, "city") : tree.ancestor(id, "state");
  return up ? `${n.name} (${up.name})` : n.name;
}

/** Does one allocated territory reach one picked place? */
export function territoryReaches(t: TerritoryRow, place: PlaceNode, tree: TreeIndex): boolean {
  const state = place.kind === "state" ? place : tree.ancestor(place.id, "state");
  const stateName = state?.name ?? "";
  const statesOfCity = (name: string) => tree.cityStates.get(placeKey(name)) ?? new Set<string>();
  /* A city is in this state where its row says so, or — where the row states
     no parent — where the tree knows that city name only inside it. */
  const cityInState = (city: string, parent: string) =>
    parent.trim() ? sameState(parent, stateName) : stateName !== "" && statesOfCity(city).has(canonicalState(stateName));

  if (place.kind === "state") {
    if (t.kind === "state" || t.kind === "region") return sameState(t.value, place.name);
    if (t.kind === "city") return cityInState(t.value, t.parent);
    if (t.kind === "beat") return !!t.parent.trim() && statesOfCity(t.parent).has(canonicalState(place.name));
    return false;
  }

  if (place.kind === "district") {
    const cities = [place.name, ...tree.below(place.id, "city").map((c) => c.name)];
    const inDistrict = (city: string) => cities.some((c) => sameName(c, city));
    if (t.kind === "city") return inDistrict(t.value) && (!t.parent.trim() || !stateName || sameState(t.parent, stateName));
    if (t.kind === "beat") return !!t.parent.trim() && inDistrict(t.parent);
    return false;
  }

  if (place.kind === "city") {
    if (t.kind === "city") return sameName(t.value, place.name) && (!t.parent.trim() || !stateName || sameState(t.parent, stateName));
    if (t.kind === "beat") return sameName(t.parent, place.name);
    return false;
  }

  if (place.kind === "area") {
    const city = tree.ancestor(place.id, "city");
    if (t.kind === "beat") return sameName(t.value, place.name) && (!t.parent.trim() || !city || sameName(t.parent, city.name));
    return false;
  }
  return false;
}

/**
 * Everybody a holiday reaches, and why. A person absent from the answer does
 * not get the day; a person in it does, for the reasons listed.
 */
export function resolveHoliday(rule: HolidayRule, people: HolidayPerson[], tree: TreeIndex): Map<string, Membership> {
  const out = new Map<string, Membership>();
  const excluded = new Set(rule.exclude);
  const places = rule.placeIds.map((id) => tree.byId.get(id)).filter((p): p is PlaceNode => !!p);

  for (const person of people) {
    if (excluded.has(person.id)) continue;
    const reasons: string[] = [];
    if (rule.level === "company") reasons.push("Company-wide");
    else if (rule.level !== "people")
      for (const place of places)
        if (person.territories.some((t) => territoryReaches(t, place, tree))) reasons.push(placeLabel(tree, place.id));
    const byPlace = reasons.length > 0;
    if (rule.include.includes(person.id)) reasons.push("Named");
    if (reasons.length) out.set(person.id, { reasons, byPlace });
  }
  /* Somebody named who is not on the field team any more is still named: the
     decision was about him and stands, even if no screen draws him today. */
  for (const id of rule.include)
    if (!excluded.has(id) && !out.has(id)) out.set(id, { reasons: ["Named"], byPlace: false });
  return out;
}

/** The short "where" a holiday carries on the phone and in a list. */
export function audienceLabel(rule: Pick<HolidayRule, "level" | "placeIds" | "include">, tree: TreeIndex): string | null {
  if (rule.level === "company") return null;
  if (rule.level === "people") {
    const n = rule.include.length;
    return n === 1 ? "1 named person" : `${n} named people`;
  }
  const names = rule.placeIds.map((id) => tree.byId.get(id)?.name).filter((n): n is string => !!n);
  if (!names.length) return `${HOLIDAY_LEVEL_LABEL[rule.level]} — none picked`;
  return names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} +${names.length - 3}`;
}
