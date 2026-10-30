/* ---------------------------------------------------------------------------
 * WHICH PRICE LIST APPLIES TO THIS SHOP TODAY — and why.
 *
 * A list says who it is for through scope rows: a state, a district, a city,
 * an area, a beat, a customer type, a salesman, a named customer, or everybody.
 * A shop matches several — it is in Maharashtra, in Thane, on a beat, and its
 * salesman may have a list of his own — and the rule is NARROWEST WINS: a
 * named customer over a salesman over a beat over an area over a city over a
 * district over a state over a customer type over everybody. Inside one kind
 * the freight term decides — "Odisha Paid" and "Odisha To Pay" are one region
 * and two answers to who pays the transport — then priority, then the newest
 * effective date.
 *
 * Pure. It takes the shop's geography, the scope rows and the lists as data
 * and returns the list AND THE CHAIN OF REASONS, because a price a telecaller
 * cannot explain is a price the customer argues with. The handset compiles the
 * same file, so a salesman standing in the shop and the office get one answer.
 *
 * KEYS, NOT NAMES. A scope's value for the four geography kinds is a place key
 * — the same fold `places.key` uses, letters and digits lower-cased — and the
 * customer arrives with every key it can be known by: the resolved place's key
 * where the place master has one, and the folded raw text beside it. A book
 * whose places have not been resolved yet still matches on what the sheet
 * typed, and a resolved one matches on both.
 * ------------------------------------------------------------------------- */

import type { PriceFreightTerm, PriceScopeKind } from "@/db/schema";
import { addDays } from "@/lib/business-date";
import { pickSlab, type SlabRate } from "@/lib/engines/price-math";

/** Narrowest first. The order IS the rule. */
export const SCOPE_SPECIFICITY: readonly PriceScopeKind[] = [
  "customer",
  "salesman",
  "beat",
  "area",
  "city",
  "district",
  "state",
  "customer_type",
  "everybody",
];

export type ScopeRow = {
  id: string;
  priceListId: string;
  scopeKind: PriceScopeKind;
  scopeValue: string;
  parentKey: string;
  freightTermMatch: "any" | "to_pay" | "paid";
  priority: number;
  validFrom: string | null;
  validTo: string | null;
  /** As shown to a person, where somebody typed one; the note falls back to the key. */
  scopeLabel?: string | null;
  /**
   * A row that LEAVES OUT the shops it names: its list does not price them,
   * whatever else on the list names them. Absent is false — every row written
   * before exclusions existed.
   */
  excluded?: boolean;
};

export type ListMeta = {
  id: string;
  name: string;
  status: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  freightTerm: PriceFreightTerm;
  version: number;
  /** The list's own validity in days; null takes the configured default. */
  validityDays?: number | null;
  /** The book (lineage) the version belongs to; absent reads as the list itself. */
  bookId?: string | null;
  /** `standard` or `agreed` (one shop's own prices). Absent reads as standard. */
  kind?: string | null;
};

/**
 * How the resolver treats a list whose VALIDITY has passed — its effective
 * date plus its validity days (or the configured default). Its effective_to is
 * a different fact: a list ended by its successor or withdrawn is out of force
 * whatever this says.
 *
 * Absent means the shipped behaviour: a list past its validity goes on
 * pricing. That is `pricing.expiredListsKeepPricing`'s default too, so the
 * screens and the resolver read one answer from one setting.
 */
export type ResolveOptions = {
  expiredListsKeepPricing: boolean;
  defaultValidityDays: number;
};

export type ValidityState = "current" | "past_validity_pricing" | "expired";

/**
 * THE ONE ANSWER TO "IS THIS LIST PAST ITS VALIDITY, AND DOES IT STILL PRICE".
 *
 * Read by the resolver (which lists may win) and by every screen that draws a
 * list's state, so a screen cannot say "expired" over a list the order form is
 * still pricing from — which it did, because the screens counted validity days
 * and the resolver did not.
 *
 *   - `expiresOn` is the earlier of the validity end and effective_to;
 *   - `current`: neither has passed;
 *   - `past_validity_pricing`: the validity has passed, the setting keeps it
 *     pricing, and nothing has ended it;
 *   - `expired`: effective_to has passed, or the validity has and the setting
 *     stops past-validity lists pricing.
 */
export function listValidity(
  list: Pick<ListMeta, "effectiveFrom" | "effectiveTo"> & { validityDays?: number | null },
  day: string,
  opts: ResolveOptions,
): { validUntil: string | null; expiresOn: string | null; pastValidity: boolean; state: ValidityState } {
  const days = list.validityDays ?? opts.defaultValidityDays;
  /* Kept to the reading the screens have always printed: valid until the
     effective date plus its days, and past it the day after. */
  const validUntil = days > 0 ? addDays(list.effectiveFrom, days) : null;
  const expiresOn = list.effectiveTo && (!validUntil || list.effectiveTo < validUntil) ? list.effectiveTo : validUntil;
  const pastValidity = validUntil != null && validUntil < day;
  const ended = list.effectiveTo != null && list.effectiveTo < day;
  const state: ValidityState =
    ended || (pastValidity && !opts.expiredListsKeepPricing) ? "expired" : pastValidity ? "past_validity_pricing" : "current";
  return { validUntil, expiresOn, pastValidity, state };
}

/** Everything a shop can be matched on. Each kind is a LIST of keys because a shop has several spellings. */
export type CustomerGeo = {
  customerId: string;
  /** The sales seat (sales_am_id) — the one person a salesman list may name. Never the owner, who on an imported book is whoever ran the import. */
  salesmanIds: string[];
  beatKeys: string[];
  areaKeys: string[];
  cityKeys: string[];
  districtKeys: string[];
  stateKeys: string[];
  customerType: string | null;
  /** Null where the sheet never said; then a list of either term is accepted. */
  freightTerm: "to_pay" | "paid" | null;
};

export type ResolutionStep = {
  kind: PriceScopeKind;
  /** Scope rows of this kind that named this shop. */
  matched: Array<{ scopeId: string; listId: string; listName: string }>;
  /** Why the winner won, or why this kind produced nothing. */
  note: string;
  chosen: string | null;
};

/** One list that names this shop, in the order the resolver would reach it. */
export type ResolutionCandidate = {
  listId: string;
  listName: string;
  kind: PriceScopeKind;
  scopeId: string;
};

export type Resolution = {
  listId: string;
  listName: string;
  scope: ScopeRow;
  chain: ResolutionStep[];
  /**
   * EVERY list that names this shop on the day, narrowest first and in the
   * order ties are broken — the winner is `candidates[0]`. A product the
   * winner has no row for is priced from the next list here that has one
   * (`rateFromCandidates`), which is what makes a one-rate "agreed prices"
   * list an addition to a shop's prices rather than a replacement for them.
   */
  candidates: ResolutionCandidate[];
};

/** The fold a place key is compared on — one definition, shared with the place master. */
export function placeKey(raw: string | null | undefined): string {
  return (raw ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * In force on the day. A SUPERSEDED list is in force inside its own dates —
 * which is what lets last month's order be read against last month's list —
 * but only where it carries an end: one with no effective_to says nothing
 * about when it stopped, and must never win today. Drafts and withdrawn lists
 * never price.
 */
function inForce(list: ListMeta, today: string, opts?: ResolveOptions): boolean {
  if (list.status !== "published" && !(list.status === "superseded" && list.effectiveTo)) return false;
  if (list.effectiveFrom > today) return false;
  if (list.effectiveTo && list.effectiveTo < today) return false;
  if (opts && !opts.expiredListsKeepPricing && listValidity(list, today, opts).pastValidity) return false;
  return true;
}

function scopeInForce(scope: ScopeRow, today: string): boolean {
  if (scope.validFrom && scope.validFrom > today) return false;
  if (scope.validTo && scope.validTo < today) return false;
  return true;
}

function scopeNames(scope: ScopeRow, geo: CustomerGeo): boolean {
  const value = scope.scopeValue;
  switch (scope.scopeKind) {
    case "everybody":
      return true;
    case "customer":
      return value === geo.customerId;
    case "salesman":
      return geo.salesmanIds.includes(value);
    case "customer_type":
      return geo.customerType != null && value === geo.customerType;
    case "beat":
      return geo.beatKeys.includes(value);
    case "area":
      return geo.areaKeys.includes(value) && parentAgrees(scope.parentKey, geo.cityKeys);
    case "city":
      return geo.cityKeys.includes(value) && parentAgrees(scope.parentKey, [...geo.districtKeys, ...geo.stateKeys]);
    case "district":
      return geo.districtKeys.includes(value) && parentAgrees(scope.parentKey, geo.stateKeys);
    case "state":
      return geo.stateKeys.includes(value);
  }
}

/**
 * The lists that LEAVE THIS SHOP OUT on the day: a list with an excluded row
 * in force that names the shop does not price it, however else it names it.
 * Read before any kind is walked, so a city list that leaves one shop out
 * hands that shop to whatever list is next — a wider one, or Standard.
 */
export function leftOutLists(geo: CustomerGeo, scopes: readonly ScopeRow[], today: string): Set<string> {
  const out = new Set<string>();
  for (const s of scopes) {
    if (s.excluded && scopeInForce(s, today) && scopeNames(s, geo)) out.add(s.priceListId);
  }
  return out;
}

/** Whether one row names this shop, dates and the left-out flag aside — what a rule's count is read from. */
export function scopeReaches(scope: ScopeRow, geo: CustomerGeo): boolean {
  return scopeNames(scope, geo);
}

/** An empty parent is "this place wherever it is" — every row written before parents existed. */
function parentAgrees(parentKey: string, candidates: string[]): boolean {
  return parentKey === "" || candidates.includes(parentKey);
}

export function freightAgrees(scope: ScopeRow, list: ListMeta, geo: CustomerGeo): boolean {
  const wanted = scope.freightTermMatch === "any" ? list.freightTerm : scope.freightTermMatch;
  if (wanted === "not_stated" || wanted === ("any" as string)) return true;
  if (geo.freightTerm == null) return true;
  return wanted === geo.freightTerm;
}

/**
 * The priority a shop's AGREED-PRICES scope carries. A scope at or above it
 * outranks every other scope of its kind, freight term included: the agreed
 * list is the shop's own and sits on top of the list it is assigned.
 */
export const AGREED_SCOPE_PRIORITY = 1000;

function layerRank(scope: ScopeRow): number {
  return scope.priority >= AGREED_SCOPE_PRIORITY ? 1 : 0;
}

/** How well a scope's freight term fits the shop: exact beats unstated. */
function freightRank(scope: ScopeRow, list: ListMeta, geo: CustomerGeo): number {
  const wanted = scope.freightTermMatch === "any" ? list.freightTerm : scope.freightTermMatch;
  if (geo.freightTerm == null) return 0;
  return wanted === geo.freightTerm ? 2 : 0;
}

/**
 * The answer, and the reasons.
 *
 * Walks the kinds narrowest first and stops at the first kind with a match.
 * Every kind walked is in the chain — the ones that matched nothing say so —
 * so the screen can print "no customer list, no salesman list, matched on the
 * city Thane under Maharashtra, To Pay".
 */
export function resolvePriceList(
  geo: CustomerGeo,
  scopes: readonly ScopeRow[],
  lists: readonly ListMeta[],
  today: string,
  opts?: ResolveOptions,
): Resolution | null {
  const listsById = new Map(lists.map((l) => [l.id, l]));
  const left = leftOutLists(geo, scopes, today);
  const chain: ResolutionStep[] = [];
  const candidates: ResolutionCandidate[] = [];
  const seen = new Set<string>();
  let winner: { scope: ScopeRow; list: ListMeta } | null = null;

  for (const kind of SCOPE_SPECIFICITY) {
    const found = scopes
      .filter((s) => !s.excluded && !left.has(s.priceListId))
      .filter((s) => s.scopeKind === kind && scopeInForce(s, today) && scopeNames(s, geo))
      .map((s) => ({ scope: s, list: listsById.get(s.priceListId) }))
      .filter((c): c is { scope: ScopeRow; list: ListMeta } => !!c.list && inForce(c.list, today, opts))
      .filter((c) => freightAgrees(c.scope, c.list, geo));

    found.sort((a, b) => {
      // A shop's own agreed prices LAYER over whatever it is otherwise on, so
      // that scope wins inside its kind before the freight term is asked.
      const l = layerRank(b.scope) - layerRank(a.scope);
      if (l) return l;
      const f = freightRank(b.scope, b.list, geo) - freightRank(a.scope, a.list, geo);
      if (f) return f;
      const p = b.scope.priority - a.scope.priority;
      if (p) return p;
      const e = b.list.effectiveFrom.localeCompare(a.list.effectiveFrom);
      if (e) return e;
      /* A full tie must not be decided by the order the database happened to
         return the rows in, or one shop prices differently on two reads. The
         id is arbitrary, but it is the SAME every time. */
      return a.list.id.localeCompare(b.list.id) || a.scope.id.localeCompare(b.scope.id);
    });
    for (const c of found) {
      if (seen.has(c.list.id)) continue;
      seen.add(c.list.id);
      candidates.push({ listId: c.list.id, listName: c.list.name, kind, scopeId: c.scope.id });
    }

    /* The chain of reasons stops at the winning kind, as it always has; the
       candidates go on, because fall-through needs the whole order. */
    if (winner) continue;
    const matched = found.map((c) => ({ scopeId: c.scope.id, listId: c.list.id, listName: c.list.name }));
    if (!found.length) {
      chain.push({ kind, matched, note: noMatchNote(kind, geo), chosen: null });
      continue;
    }
    const best = found[0];
    winner = best;
    chain.push({
      kind,
      matched,
      note: winNote(kind, best, found.length, geo),
      chosen: best.list.id,
    });
  }

  if (!winner) return null;
  return { listId: winner.list.id, listName: winner.list.name, scope: winner.scope, chain, candidates };
}

/* ------------------------------------------------- a rate off the chain */

/** A row of a list for one product, as the fall-through reads it. */
export type ChainRate = SlabRate;

export type ChainedRate<T extends ChainRate> = {
  /** The list the price came from — the winner, or one it fell through to. */
  listId: string;
  listName: string;
  /** The row that applies: the base rate, or the slab for the quantity. Null where none does. */
  row: T | null;
  /** Every row that list has for the product, slabs included. */
  rows: T[];
  /** False where the list prints a dash: listed and not for sale. It does NOT fall through. */
  offered: boolean;
  /** True where the rate came from a list below the winner. */
  fellThrough: boolean;
};

/**
 * The base row of a product on one list: the flat row, or where a list only
 * prints slabs, the lowest slab — the figure the grid already shows for it.
 */
export function baseRow<T extends ChainRate>(rows: readonly T[]): T | null {
  const flat = rows.find((r) => r.minCans == null && r.maxCans == null);
  if (flat) return flat;
  return [...rows].sort((a, b) => (a.minCans ?? 0) - (b.minCans ?? 0))[0] ?? null;
}

/**
 * The rate for a quantity off ONE list's rows for a product: the slab the
 * quantity falls in where a quantity is known, the base row where none is.
 * Shared by the save and by the order form in the browser, so a quantity
 * typed after the rates were fetched gives the figure the save will write.
 */
export function rateAtQuantity<T extends ChainRate>(rows: readonly T[], cans?: number | null): T | null {
  const offered = rows.filter((r) => r.offered);
  if (!offered.length) return null;
  return cans != null && cans > 0 ? pickSlab(offered, cans) : baseRow(offered);
}

/**
 * WHAT THIS SHOP PAYS FOR ONE PRODUCT, off the candidate chain.
 *
 * The first list in the chain that has ANY row for the product decides it.
 * A dash on that list ("not for sale here") is an answer and does not fall
 * through: a list that says "not to you" must not be overruled by a wider list
 * that says otherwise. A quantity no slab covers is likewise that list's
 * answer — it prices the product, just not in that quantity.
 *
 * Null where no list in the chain prices the product at all.
 */
export function rateFromCandidates<T extends ChainRate>(
  candidates: readonly Pick<ResolutionCandidate, "listId" | "listName">[],
  rowsOf: (listId: string) => readonly T[],
  cans?: number | null,
): ChainedRate<T> | null {
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const rows = [...rowsOf(c.listId)];
    if (!rows.length) continue;
    return {
      listId: c.listId,
      listName: c.listName,
      row: rateAtQuantity(rows, cans),
      rows,
      offered: rows.some((r) => r.offered),
      fellThrough: i > 0,
    };
  }
  return null;
}

/**
 * A list and the lists it replaced are ONE list for "has their list changed":
 * the root of the supersedes chain names the lineage, so a routine new version
 * of the shop's own list is not a change to warn a customer about.
 */
export function lineageRoot(listId: string, supersedesOf: (id: string) => string | null | undefined): string {
  let id = listId;
  const seen = new Set<string>([id]);
  for (;;) {
    const parent = supersedesOf(id);
    if (!parent || seen.has(parent)) return id;
    seen.add(parent);
    id = parent;
  }
}

function noMatchNote(kind: PriceScopeKind, geo: CustomerGeo): string {
  switch (kind) {
    case "customer":
      return "No list is set for this customer by name.";
    case "salesman":
      return geo.salesmanIds.length ? "No list is set for their salesman." : "No salesman on the account to match a list on.";
    case "beat":
      return geo.beatKeys.length ? "No list is set for their beat." : "No beat on the account.";
    case "area":
      return geo.areaKeys.length ? "No list is set for their area." : "No area on the account.";
    case "city":
      return geo.cityKeys.length ? "No list is set for their city." : "No city on the account.";
    case "district":
      return geo.districtKeys.length ? "No list is set for their district." : "No district resolved for the account.";
    case "state":
      return geo.stateKeys.length ? "No list is set for their state." : "No state on the account.";
    case "customer_type":
      return geo.customerType ? "No list is set for their customer type." : "No customer type on the account.";
    case "everybody":
      return "No list applies to everybody.";
  }
}

function winNote(
  kind: PriceScopeKind,
  best: { scope: ScopeRow; list: ListMeta },
  count: number,
  geo: CustomerGeo,
): string {
  const where = best.scope.scopeLabel ?? best.scope.scopeValue;
  const freight =
    geo.freightTerm && (best.scope.freightTermMatch !== "any" || best.list.freightTerm !== "not_stated")
      ? `, ${geo.freightTerm === "paid" ? "freight paid" : "freight to pay"}`
      : "";
  const tie = count > 1 ? ` (${count} lists matched here; priority and the freight term decided)` : "";
  switch (kind) {
    case "everybody":
      return `Matched the list for everybody${freight}${tie}.`;
    case "customer":
      return `Matched a list set for this customer by name${tie}.`;
    case "salesman":
      return `Matched their salesman's list${freight}${tie}.`;
    default:
      return `Matched on ${kind.replace("_", " ")} ${where}${freight}${tie}.`;
  }
}
