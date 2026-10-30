/* ---------------------------------------------------------------------------
 * ONE PRICE LIST PER SHOP — which books a shop is on, and which edit would
 * put it on a second.
 *
 * Mahek's rule: a shop is ALLOCATED to one price list, never two. A shop no
 * list names is priced from Standard, the default, and Standard does not
 * count — it is the floor under everybody, not an allocation. Two other
 * things do not count either, because neither is a second list:
 *
 *   - a shop's AGREED prices (`kind = 'agreed'`, the scope at or above
 *     `AGREED_SCOPE_PRIORITY`) — one-product special prices that layer on top
 *     of the shop's list;
 *   - an "everybody" row, wherever it is — that is what makes a list Standard.
 *
 * A BOOK IS ONE LIST. A book's revisions (this month's, the one scheduled for
 * the 15th, a draft change) are versions of the same allocation, so they are
 * counted by `bookId`, never by version.
 *
 * DATES ARE ALLOCATION, NOT A DAY'S PRICING. A rule that has ENDED no longer
 * allocates anybody, so it is skipped; a rule or a list that starts LATER
 * already does, because a shop scheduled onto a second book next week is on
 * two books from the moment somebody wrote it down. A left-out row counts
 * whatever its dates say: "moved to Maharashtra Dealers from 15 Nov" writes a
 * leave-out on the old book dated the 15th, and until then the old book still
 * prices the shop — but as an allocation it has already gone.
 *
 * THE RULE BITES ON THE EDIT, never on what is already stored. Books that
 * overlapped before the rule existed go on pricing exactly as they did
 * (narrowest wins) and are listed for somebody to settle; what is refused is
 * an edit that puts a shop on a SECOND book it was not already on with this
 * one — `introducedClashes`. That is what lets the rule ship without stopping
 * the desk on the day it lands.
 *
 * Pure, like every engine here: the geography, the rows and the lists come in
 * as data.
 * ------------------------------------------------------------------------- */

import {
  AGREED_SCOPE_PRIORITY,
  freightAgrees,
  scopeReaches,
  type CustomerGeo,
  type ListMeta,
  type ScopeRow,
} from "@/lib/engines/price-resolution";

/** One book a shop is on, by the version that names it. */
export type BookOnShop = { bookId: string; listId: string; listName: string };

/** The book a list version belongs to — itself where no book is recorded. */
export function bookOf(list: Pick<ListMeta, "id" | "bookId">): string {
  return list.bookId || list.id;
}

/** Whether a list is something a shop can be allocated to. A shop's own agreed prices are not. */
export function allocatingList(list: Pick<ListMeta, "kind">): boolean {
  return (list.kind ?? "standard") !== "agreed";
}

/** Whether a row allocates the shops it names: not left-out, not "everybody", not an agreed-prices row. */
export function allocatingScope(scope: Pick<ScopeRow, "excluded" | "scopeKind" | "priority">): boolean {
  return !scope.excluded && scope.scopeKind !== "everybody" && scope.priority < AGREED_SCOPE_PRIORITY;
}

/** A list version that allocates on or after `day`: published, or superseded on a later day. Drafts never. */
export function stillAllocates(list: Pick<ListMeta, "status" | "effectiveTo">, day: string): boolean {
  if (list.status !== "published" && list.status !== "superseded") return false;
  return list.effectiveTo == null || list.effectiveTo >= day;
}

function ruleLive(scope: Pick<ScopeRow, "validTo">, day: string): boolean {
  return scope.validTo == null || scope.validTo >= day;
}

/**
 * EVERY BOOK THIS SHOP IS ALLOCATED TO, as of `day` and onwards. Two or more
 * is a shop on two lists. The version named is the one in force on the day
 * where there is one, otherwise the soonest scheduled.
 */
export function booksOnShop(
  geo: CustomerGeo,
  scopes: readonly ScopeRow[],
  lists: readonly ListMeta[],
  day: string,
): BookOnShop[] {
  const listsById = new Map(lists.map((l) => [l.id, l]));
  const leftOut = new Set<string>();
  for (const s of scopes) {
    if (s.excluded && scopeReaches(s, geo)) leftOut.add(s.priceListId);
  }
  const byBook = new Map<string, ListMeta>();
  for (const s of scopes) {
    if (!allocatingScope(s) || !ruleLive(s, day)) continue;
    const list = listsById.get(s.priceListId);
    if (!list || !allocatingList(list) || !stillAllocates(list, day)) continue;
    if (leftOut.has(list.id)) continue;
    if (!scopeReaches(s, geo) || !freightAgrees(s, list, geo)) continue;
    const key = bookOf(list);
    const held = byBook.get(key);
    if (!held || better(list, held, day)) byBook.set(key, list);
  }
  return [...byBook.entries()]
    .map(([bookId, l]) => ({ bookId, listId: l.id, listName: l.name }))
    .sort((a, b) => a.listName.localeCompare(b.listName) || a.bookId.localeCompare(b.bookId));
}

/** In force today beats scheduled; between two scheduled, the sooner. */
function better(a: ListMeta, b: ListMeta, day: string): boolean {
  const aNow = a.effectiveFrom <= day;
  const bNow = b.effectiveFrom <= day;
  if (aNow !== bNow) return aNow;
  return aNow ? a.effectiveFrom > b.effectiveFrom : a.effectiveFrom < b.effectiveFrom;
}

/** One shop and the books it is on, for the screens that list them. */
export type ShopOnBooks = { customerId: string; books: BookOnShop[] };

/** Every shop on more than one book — what is listed for somebody to settle. */
export function doubleListed(
  geos: readonly CustomerGeo[],
  scopes: readonly ScopeRow[],
  lists: readonly ListMeta[],
  day: string,
): ShopOnBooks[] {
  const out: ShopOnBooks[] = [];
  for (const geo of geos) {
    const books = booksOnShop(geo, scopes, lists, day);
    if (books.length > 1) out.push({ customerId: geo.customerId, books });
  }
  return out;
}

/** A shop an edit would put on a second book, and the books it is already on. */
export type IntroducedClash = { customerId: string; others: BookOnShop[] };

/**
 * WHAT AN EDIT TO ONE BOOK WOULD BREAK: the shops the book reaches after the
 * edit that are also on another book, where they were not already on both
 * before it. `before` and `after` are the whole picture either side of the
 * edit — a scope added, a draft published, a shop moved.
 */
export function introducedClashes(
  geos: readonly CustomerGeo[],
  before: { scopes: readonly ScopeRow[]; lists: readonly ListMeta[] },
  after: { scopes: readonly ScopeRow[]; lists: readonly ListMeta[] },
  bookId: string,
  day: string,
): IntroducedClash[] {
  const out: IntroducedClash[] = [];
  for (const geo of geos) {
    const now = booksOnShop(geo, after.scopes, after.lists, day);
    if (now.length < 2 || !now.some((b) => b.bookId === bookId)) continue;
    const was = booksOnShop(geo, before.scopes, before.lists, day);
    const wasHere = was.some((b) => b.bookId === bookId);
    const others = now.filter((b) => b.bookId !== bookId && !(wasHere && was.some((w) => w.bookId === b.bookId)));
    if (others.length) out.push({ customerId: geo.customerId, others });
  }
  return out;
}

/**
 * HOW MANY SHOPS A LIST'S RULES REACH, AND HOW MANY IT LEAVES OUT — the strip
 * above "Who this list applies to". Freight and dates aside: this is the
 * rules' own reach, the number somebody checks a rule against.
 */
export function listReach(
  geos: readonly CustomerGeo[],
  rows: readonly ScopeRow[],
): { reached: number; leftOut: number; priced: number; everybody: boolean } {
  const including = rows.filter((r) => !r.excluded);
  const excluding = rows.filter((r) => r.excluded);
  const everybody = including.some((r) => r.scopeKind === "everybody");
  let reached = 0;
  let leftOut = 0;
  for (const geo of geos) {
    if (!including.some((r) => scopeReaches(r, geo))) continue;
    reached++;
    if (excluding.some((r) => scopeReaches(r, geo))) leftOut++;
  }
  return { reached, leftOut, priced: reached - leftOut, everybody };
}

/** Which kinds may be left out. Everybody and a customer type never are. */
export const EXCLUDABLE_KINDS = ["customer", "salesman", "beat", "area", "city", "district"] as const;
export type ExcludableKind = (typeof EXCLUDABLE_KINDS)[number];

export function isExcludable(kind: string): kind is ExcludableKind {
  return (EXCLUDABLE_KINDS as readonly string[]).includes(kind);
}
