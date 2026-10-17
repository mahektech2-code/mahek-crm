/* ---------------------------------------------------------------------------
 * THE REVIEWED LOCATION TREE, read as rows — PURE, no I/O.
 *
 * `data/places/customer-places.csv` is the team's reviewed answer to "where is
 * this shop": state › district › city › area for every account on the book on
 * 26 Sep 2026, built from the pin, the address and the sheet text, then
 * corrected by hand on the Tree sheet (`location-tree-reviewed.csv` beside it
 * is that sheet as it came back). `place-tree-service.ts` writes it into
 * `places` and the four `resolved_*_id` columns; this file is the part of that
 * which can be tested without a database.
 *
 * It also answers the question for a shop the review never saw — every
 * account created since — from the sheet's own text, matched against the tree
 * the review built. That is deliberately a MATCH and never a new node: a
 * typed city that names nothing in the tree leaves the shop at its state
 * rather than inventing a place one telecaller spelled once, which is how the
 * 1,165 city strings the tree replaced came to exist.
 * ------------------------------------------------------------------------- */

import { canonicalState, isKnownState } from "@/lib/india-states";
import { PLACE_KINDS, placeKey, type PlaceKind } from "@/lib/place-parse";

export type PlaceChainStep = { kind: PlaceKind; name: string };

/**
 * One reviewed row as a chain, coarsest first — or null where it has a hole.
 *
 * A TREE CANNOT HAVE A HOLE IN IT, the rule `placeChain` already keeps for a
 * geocoder's answer: a city with no district above it has nothing to hang
 * from, and hanging it from the state instead would make every count above it
 * a count of two different things. The data file has none; a row that grows
 * one later is refused rather than half-written.
 */
export function chainFromRow(row: {
  state?: string;
  district?: string;
  city?: string;
  area?: string;
}): PlaceChainStep[] | null {
  const chain: PlaceChainStep[] = [];
  let ended = false;
  for (const kind of PLACE_KINDS) {
    const name = (row[kind] ?? "").trim().replace(/\s+/g, " ");
    if (!name) {
      ended = true;
      continue;
    }
    if (ended) return null;
    chain.push({ kind, name });
  }
  return chain;
}

/** A node of the tree as the matcher sees it. */
export type PlaceNode = {
  id: string;
  kind: PlaceKind;
  name: string;
  key: string;
  parentId: string | null;
  /** Shops at or under it — `places.shops`. Breaks a tie only where no state was given. */
  shops?: number;
};

/** What the sheet says about a shop, for matching. */
export type TypedPlace = {
  region: string | null;
  city: string | null;
  address: string | null;
};

export type PlaceIds = Partial<Record<PlaceKind, string>>;

/**
 * The tree, indexed for the one question the matcher asks: which node of this
 * kind, under this state, carries this key.
 */
export type PlaceIndex = {
  byId: Map<string, PlaceNode>;
  stateByKey: Map<string, PlaceNode>;
  /** `${stateId}|${kind}|${key}` → every node that matches, since two districts can share a town name. */
  underState: Map<string, PlaceNode[]>;
  /** `${kind}|${key}` across the whole country, for a shop that names no state. */
  everywhere: Map<string, PlaceNode[]>;
};

export function indexPlaces(nodes: PlaceNode[]): PlaceIndex {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const stateByKey = new Map<string, PlaceNode>();
  const underState = new Map<string, PlaceNode[]>();
  const everywhere = new Map<string, PlaceNode[]>();

  const stateOf = (n: PlaceNode): PlaceNode | null => {
    let cur: PlaceNode | undefined = n;
    while (cur && cur.parentId) cur = byId.get(cur.parentId);
    return cur && cur.kind === "state" ? cur : null;
  };

  for (const n of nodes) {
    if (n.kind === "state") {
      stateByKey.set(n.key, n);
      continue;
    }
    const anywhere = `${n.kind}|${n.key}`;
    everywhere.set(anywhere, [...(everywhere.get(anywhere) ?? []), n]);
    const st = stateOf(n);
    if (!st) continue;
    const k = `${st.id}|${n.kind}|${n.key}`;
    const list = underState.get(k) ?? [];
    list.push(n);
    underState.set(k, list);
  }
  return { byId, stateByKey, underState, everywhere };
}

/** Every id from the state down to this node. */
function idsUpFrom(index: PlaceIndex, node: PlaceNode): PlaceIds {
  const ids: PlaceIds = {};
  let cur: PlaceNode | undefined = node;
  while (cur) {
    ids[cur.kind] = cur.id;
    cur = cur.parentId ? index.byId.get(cur.parentId) : undefined;
  }
  return ids;
}

/** The one node of `kind` under this state with this key — or null if none or several. */
function only(index: PlaceIndex, stateId: string, kind: PlaceKind, raw: string): PlaceNode | null {
  const key = placeKey(raw);
  if (!key) return null;
  const hits = index.underState.get(`${stateId}|${kind}|${key}`) ?? [];
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Where the sheet's own words put a shop, in the reviewed tree.
 *
 * The state comes from `region`, folded through `canonicalState` so "Gujrat"
 * and "MH" land where they mean. Below it the typed city is tried as a CITY,
 * then as an AREA — the sheet routinely types a Mumbai suburb as the city,
 * and the tree has it as an area under Mumbai — and then each comma-separated
 * part of the address, last first, because a Google-format address ends
 * "…, Area, City, State PIN, India".
 *
 * AMBIGUITY STOPS THE DESCENT. Two Sadars in one state is the ordinary case,
 * and picking one would put a guess in a column every filter reads as a fact;
 * the shop stays at its state, which is true.
 */
export function matchTypedPlace(index: PlaceIndex, typed: TypedPlace): PlaceIds {
  const state = stateFor(index, typed);
  if (!state) return matchAnywhere(index, typed);

  const tryText = (raw: string | null | undefined): PlaceNode | null => {
    if (!raw) return null;
    return only(index, state.id, "city", raw) ?? only(index, state.id, "area", raw);
  };

  let hit = tryText(typed.city);

  if (!hit && typed.address) {
    const parts = addressParts(typed.address);
    for (const part of parts) {
      const city = only(index, state.id, "city", part);
      if (city) {
        hit = city;
        break;
      }
    }
    /* With the city found, the part just before it in the address is usually
       its area — taken only if the tree already has that area under THIS
       city, never matched across the state. */
    if (hit && hit.kind === "city") {
      const cityId = hit.id;
      for (const part of parts) {
        const area = only(index, state.id, "area", part);
        if (area && area.parentId === cityId) {
          hit = area;
          break;
        }
      }
    }
  }

  return hit ? idsUpFrom(index, hit) : { state: state.id };
}

/** Address parts, last first, with the pincode taken off — "Maharashtra 416119" reads as "Maharashtra". */
function addressParts(address: string | null): string[] {
  if (!address) return [];
  return address
    .split(",")
    .map((p) => p.replace(/\b\d{6}\b/g, "").trim())
    .filter(Boolean)
    .reverse();
}

/**
 * The state, from the sheet's region first and the address second. A lead
 * raised on a handset carries no region at all, and its address — when it has
 * one — names the state in the part before the pincode.
 */
function stateFor(index: PlaceIndex, typed: TypedPlace): PlaceNode | null {
  const fromRegion = index.stateByKey.get(placeKey(canonicalState(typed.region)));
  if (fromRegion) return fromRegion;
  for (const part of addressParts(typed.address)) {
    if (!isKnownState(part)) continue;
    const hit = index.stateByKey.get(placeKey(canonicalState(part)));
    if (hit) return hit;
  }
  return null;
}

/**
 * No state anywhere: the typed city is placed only if ONE city in the whole
 * tree carries that name — or one dwarfs every namesake — or failing that one
 * area. "Nagpur" is one place; "Sadar" is a dozen, and a dozen is no answer.
 */
function matchAnywhere(index: PlaceIndex, typed: TypedPlace): PlaceIds {
  const key = placeKey(typed.city);
  if (!key) return {};
  for (const kind of ["city", "area"] as const) {
    const hits = [...(index.everywhere.get(`${kind}|${key}`) ?? [])].sort(
      (a, b) => (b.shops ?? 0) - (a.shops ?? 0),
    );
    if (hits.length === 1) return idsUpFrom(index, hits[0]);
    /* One overwhelming namesake is an answer: "Nagpur" is the city of 223
       shops, not the village of one in East Nimar. Anything closer is not. */
    if (hits.length > 1) {
      const [top, next] = hits;
      return (top.shops ?? 0) >= 10 * Math.max(next.shops ?? 0, 1) ? idsUpFrom(index, top) : {};
    }
  }
  return {};
}

/**
 * How a resolved shop reads on a screen — narrowest first, the way an Indian
 * address is written: "Kandivali West, Mumbai, Maharashtra".
 *
 * The district is left out where it repeats the city, which it does for most
 * towns ("Thane, Thane, Maharashtra" reads as a typo).
 */
export function placeLine(p: {
  state?: string | null;
  district?: string | null;
  city?: string | null;
  area?: string | null;
}): string {
  const parts = [p.area, p.city];
  if (p.district && placeKey(p.district) !== placeKey(p.city)) parts.push(p.district);
  parts.push(p.state);
  const seen = new Set<string>();
  return parts
    .filter((x): x is string => Boolean(x && x.trim()))
    .filter((x) => {
      const k = placeKey(x);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .join(", ");
}
