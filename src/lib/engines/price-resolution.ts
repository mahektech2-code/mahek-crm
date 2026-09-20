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
};

export type ListMeta = {
  id: string;
  name: string;
  status: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  freightTerm: PriceFreightTerm;
  version: number;
};

/** Everything a shop can be matched on. Each kind is a LIST of keys because a shop has several spellings. */
export type CustomerGeo = {
  customerId: string;
  /** The seat that sells to it, and the owner behind it — either may hold a list. */
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

export type Resolution = {
  listId: string;
  listName: string;
  scope: ScopeRow;
  chain: ResolutionStep[];
};

/** The fold a place key is compared on — one definition, shared with the place master. */
export function placeKey(raw: string | null | undefined): string {
  return (raw ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function inForce(list: ListMeta, today: string): boolean {
  if (list.status !== "published") return false;
  if (list.effectiveFrom > today) return false;
  if (list.effectiveTo && list.effectiveTo < today) return false;
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

/** An empty parent is "this place wherever it is" — every row written before parents existed. */
function parentAgrees(parentKey: string, candidates: string[]): boolean {
  return parentKey === "" || candidates.includes(parentKey);
}

function freightAgrees(scope: ScopeRow, list: ListMeta, geo: CustomerGeo): boolean {
  const wanted = scope.freightTermMatch === "any" ? list.freightTerm : scope.freightTermMatch;
  if (wanted === "not_stated" || wanted === ("any" as string)) return true;
  if (geo.freightTerm == null) return true;
  return wanted === geo.freightTerm;
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
): Resolution | null {
  const listsById = new Map(lists.map((l) => [l.id, l]));
  const chain: ResolutionStep[] = [];
  let winner: { scope: ScopeRow; list: ListMeta } | null = null;

  for (const kind of SCOPE_SPECIFICITY) {
    const candidates = scopes
      .filter((s) => s.scopeKind === kind && scopeInForce(s, today) && scopeNames(s, geo))
      .map((s) => ({ scope: s, list: listsById.get(s.priceListId) }))
      .filter((c): c is { scope: ScopeRow; list: ListMeta } => !!c.list && inForce(c.list, today))
      .filter((c) => freightAgrees(c.scope, c.list, geo));

    const matched = candidates.map((c) => ({ scopeId: c.scope.id, listId: c.list.id, listName: c.list.name }));

    if (!candidates.length) {
      chain.push({ kind, matched, note: noMatchNote(kind, geo), chosen: null });
      if (winner) break;
      continue;
    }

    candidates.sort((a, b) => {
      const f = freightRank(b.scope, b.list, geo) - freightRank(a.scope, a.list, geo);
      if (f) return f;
      const p = b.scope.priority - a.scope.priority;
      if (p) return p;
      return b.list.effectiveFrom.localeCompare(a.list.effectiveFrom);
    });
    const best = candidates[0];
    winner = best;
    chain.push({
      kind,
      matched,
      note: winNote(kind, best, candidates.length, geo),
      chosen: best.list.id,
    });
    break;
  }

  if (!winner) return null;
  return { listId: winner.list.id, listName: winner.list.name, scope: winner.scope, chain };
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
