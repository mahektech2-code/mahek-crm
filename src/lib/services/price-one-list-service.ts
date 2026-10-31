import "server-only";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import {
  resolvePriceList,
  scopeReaches,
  type CustomerGeo,
  type ListMeta,
  type ResolveOptions,
  type ScopeRow,
} from "@/lib/engines/price-resolution";
import {
  bookOf,
  booksOnShop,
  doubleListed,
  introducedClashes,
  type BookOnShop,
} from "@/lib/engines/price-one-list";
import { GEO_SELECT, toGeo, type GeoRow } from "@/lib/services/price-list-service";
import type { Tx } from "@/lib/services/price-write";

/* ---------------------------------------------------------------------------
 * ONE PRICE LIST PER SHOP, wired to the data — the pure rule is
 * `engines/price-one-list.ts`.
 *
 * Everything takes an EXECUTOR (`db` or a transaction) because the check that
 * refuses an edit must read the edit it is judging: a scope inserted inside a
 * transaction is invisible to the pool until the transaction commits, so a
 * check read through `db` would always answer "no clash".
 * ------------------------------------------------------------------------- */

type Exec = Tx | typeof db;

const gen = (prefix: string) => `${prefix}_${randomUUID().slice(0, 12)}`;

/** The whole picture the rule is read over: every version that allocates or may, and every row on one. */
export type World = { scopes: ScopeRow[]; lists: ListMeta[] };

export async function loadWorld(q: Exec): Promise<World> {
  const [scopeRows, listRows] = await Promise.all([
    q.execute<ScopeRow>(sql`
      select sc.id, sc.price_list_id as "priceListId", sc.scope_kind as "scopeKind",
             sc.scope_value as "scopeValue", sc.scope_label as "scopeLabel",
             sc.parent_key as "parentKey", sc.freight_term_match as "freightTermMatch",
             sc.priority, sc.valid_from::text as "validFrom", sc.valid_to::text as "validTo",
             sc.excluded
        from price_list_scopes sc
        join price_lists l on l.id = sc.price_list_id
       where l.status in ('draft', 'published', 'superseded')
       order by sc.price_list_id asc, sc.id asc
    `),
    q.execute<ListMeta>(sql`
      select l.id, l.name, l.status, l.effective_from::text as "effectiveFrom",
             l.effective_to::text as "effectiveTo", l.freight_term as "freightTerm", l.version,
             l.validity_days as "validityDays", l.book_id as "bookId", l.kind
        from price_lists l
       where l.status in ('draft', 'published', 'superseded')
       order by l.id asc
    `),
  ]);
  return { scopes: [...scopeRows], lists: [...listRows] };
}

/** Every account a list can price: customers and leads not deactivated. Names beside, for the screens. */
export async function loadShops(q: Exec): Promise<{ geos: CustomerGeo[]; names: Map<string, { name: string; city: string | null }> }> {
  const rows = await q.execute<GeoRow & { name: string }>(sql`
    select g.*, named.name
      from (${GEO_SELECT} where c.status <> 'deactivated') g
      join customers named on named.id = g."customerId"
  `);
  const names = new Map<string, { name: string; city: string | null }>();
  const geos: CustomerGeo[] = [];
  for (const r of rows) {
    geos.push(toGeo(r));
    names.set(r.customerId, { name: r.name, city: r.city });
  }
  return { geos, names };
}

/** A shop an edit would put on a second list, named for a screen. */
export type ClashView = {
  customerId: string;
  name: string;
  city: string | null;
  /** The books it is already on — what "keep it where it is" keeps it on. */
  others: BookOnShop[];
};

function named(rows: Array<{ customerId: string; others: BookOnShop[] }>, names: Map<string, { name: string; city: string | null }>): ClashView[] {
  return rows
    .map((r) => ({ customerId: r.customerId, name: names.get(r.customerId)?.name ?? r.customerId, city: names.get(r.customerId)?.city ?? null, others: r.others }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* ------------------------------------------------------------ a preview */

/** One row of a list as a screen holds it before it is saved. */
export type DraftRow = {
  scopeKind: ScopeRow["scopeKind"];
  scopeValue: string;
  scopeLabel?: string | null;
  parentKey: string;
  freightTermMatch: ScopeRow["freightTermMatch"];
  priority?: number;
  validFrom?: string | null;
  validTo?: string | null;
  excluded?: boolean;
};

/**
 * WHAT THESE RULES WOULD DO if this list carried them and were published:
 * how many shops they reach and leave out, and the shops already on another
 * book. `listId` is the list being edited (null for one not saved yet);
 * `supersedesId` names the version it replaces, so a new version is read as
 * the same book rather than a second one. `moves` are shops already answered
 * "move here" — taken off their book in the picture before it is read.
 */
export async function previewClashes(input: {
  listId: string | null;
  supersedesId?: string | null;
  freightTerm?: ListMeta["freightTerm"];
  rows: DraftRow[];
  moves?: Array<{ customerId: string; fromBookId: string }>;
  day: string;
}): Promise<{ clashes: ClashView[]; reached: number; leftOut: number; priced: number }> {
  const [world, shops] = await Promise.all([loadWorld(db), loadShops(db)]);
  const existing = input.listId ? world.lists.find((l) => l.id === input.listId) ?? null : null;
  const predecessor = input.supersedesId ? world.lists.find((l) => l.id === input.supersedesId) ?? null : null;
  const id = existing?.id ?? "__candidate";
  const bookId = predecessor ? bookOf(predecessor) : existing ? bookOf(existing) : id;
  const candidate: ListMeta = {
    id,
    name: existing?.name ?? "This list",
    status: "published",
    effectiveFrom: input.day,
    effectiveTo: null,
    freightTerm: input.freightTerm ?? existing?.freightTerm ?? "not_stated",
    version: existing?.version ?? 1,
    bookId,
    kind: existing?.kind ?? "standard",
  };
  const rows: ScopeRow[] = input.rows.map((r, i) => ({
    id: `__row${i}`,
    priceListId: id,
    scopeKind: r.scopeKind,
    scopeValue: r.scopeValue,
    scopeLabel: r.scopeLabel ?? null,
    parentKey: r.parentKey,
    freightTermMatch: r.freightTermMatch,
    priority: r.priority ?? 0,
    validFrom: r.validFrom ?? null,
    validTo: r.validTo ?? null,
    excluded: !!r.excluded,
  }));
  const before: World = {
    scopes: world.scopes.filter((s) => s.priceListId !== id),
    lists: world.lists.filter((l) => l.id !== id).map((l) => (bookOf(l) === bookId ? { ...l, bookId } : l)),
  };
  const moved = movesAsRows(input.moves ?? [], before.lists, input.day);
  const after: World = {
    scopes: [...before.scopes, ...rows, ...moved],
    lists: [...before.lists, candidate],
  };
  const clashes = introducedClashes(shops.geos, before, after, bookId, input.day);

  let reached = 0;
  let leftOut = 0;
  const including = rows.filter((r) => !r.excluded);
  const excluding = rows.filter((r) => r.excluded);
  for (const geo of shops.geos) {
    if (!including.some((r) => scopeReaches(r, geo))) continue;
    reached++;
    if (excluding.some((r) => scopeReaches(r, geo))) leftOut++;
  }
  return { clashes: named(clashes, shops.names), reached, leftOut, priced: reached - leftOut };
}

/** "Move here" as rows: the shop left out of every live, scheduled or draft version of the book it is on. */
function movesAsRows(moves: Array<{ customerId: string; fromBookId: string }>, lists: readonly ListMeta[], day: string): ScopeRow[] {
  const out: ScopeRow[] = [];
  for (const m of moves) {
    for (const l of lists) {
      if (bookOf(l) !== m.fromBookId) continue;
      if (l.effectiveTo && l.effectiveTo < day) continue;
      out.push({
        id: `__move_${m.customerId}_${l.id}`,
        priceListId: l.id,
        scopeKind: "customer",
        scopeValue: m.customerId,
        parentKey: "",
        freightTermMatch: "any",
        priority: 0,
        validFrom: null,
        validTo: null,
        excluded: true,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------- the check */

/**
 * WHY AN EDIT MAY NOT STAND, or null: the edit put a shop on a second list.
 * `before` is the picture read at the start of the caller's transaction,
 * before it wrote anything; the picture after is read here, on the same
 * transaction. The caller throws its own `Refused` with the sentence, which
 * rolls the whole edit back.
 */
export async function newClashRefusal(tx: Tx, before: World, bookId: string, day: string): Promise<string | null> {
  const [after, shops] = await Promise.all([loadWorld(tx), loadShops(tx)]);
  const clashes = introducedClashes(shops.geos, before, after, bookId, day);
  if (!clashes.length) return null;
  return clashSentence(named(clashes, shops.names));
}

/** The refusal in words: who, and on which list already. */
export function clashSentence(views: readonly ClashView[]): string {
  const first = views.slice(0, 3).map((v) => `${v.name} (on ${v.others.map((o) => o.listName).join(", ")})`);
  const more = views.length > 3 ? ` and ${views.length - 3} more` : "";
  const are = views.length === 1 ? "is" : "are";
  return `${first.join(", ")}${more} ${are} already on another price list. A shop can be on one list: leave ${views.length === 1 ? "it" : "them"} out here, or move ${views.length === 1 ? "it" : "them"} here.`;
}

/* ------------------------------------------------------- moving a shop */

/**
 * TAKES ONE SHOP OFF A BOOK: a left-out row on every version of the book that
 * still allocates (in force, scheduled) and on its open drafts, so the next
 * revision cannot bring the shop back. A row naming the shop by name is
 * removed — leaving it beside a leave-out would read as two answers. Dated
 * `validFrom` where the shop moves on a later day, so the old book goes on
 * pricing it until the new one starts.
 */
export async function leaveShopOutOfBook(
  tx: Tx,
  input: { bookId: string; customerId: string; label: string; validFrom?: string | null; userId: string; day: string },
): Promise<number> {
  const versions = await tx.execute<{ id: string }>(sql`
    select l.id from price_lists l
     where coalesce(l.book_id, l.id) = ${input.bookId}
       and l.kind <> 'agreed'
       and (l.status = 'draft' or (l.status in ('published', 'superseded') and (l.effective_to is null or l.effective_to >= ${input.day}::date)))
  `);
  let written = 0;
  for (const v of versions) {
    await tx.execute(sql`
      delete from price_list_scopes
       where price_list_id = ${v.id} and scope_kind = 'customer' and scope_value = ${input.customerId}
         and not excluded and priority < 1000
    `);
    const [held] = await tx.execute<{ id: string }>(sql`
      select id from price_list_scopes
       where price_list_id = ${v.id} and excluded and scope_kind = 'customer' and scope_value = ${input.customerId}
       limit 1
    `);
    if (held) continue;
    await tx.execute(sql`
      insert into price_list_scopes (id, price_list_id, scope_kind, scope_value, scope_label, parent_key,
                                     freight_term_match, priority, valid_from, valid_to, excluded, created_by_id)
      values (${gen("pls")}, ${v.id}, 'customer', ${input.customerId}, ${input.label}, '', 'any', 0,
              ${input.validFrom ?? null}, null, true, ${input.userId})
    `);
    written++;
  }
  return written;
}

/** Undoes a leave-out of one shop on a book — what putting it back on that book means. */
export async function takeShopBackOnBook(tx: Tx, input: { bookId: string; customerId: string }): Promise<void> {
  await tx.execute(sql`
    delete from price_list_scopes sc
     using price_lists l
     where l.id = sc.price_list_id
       and coalesce(l.book_id, l.id) = ${input.bookId}
       and sc.excluded and sc.scope_kind = 'customer' and sc.scope_value = ${input.customerId}
  `);
}

/* ---------------------------------------------- shops on two lists today */

export type DoubleListedView = {
  customerId: string;
  name: string;
  city: string | null;
  books: BookOnShop[];
  /** The book that prices the shop today under narrowest-wins — the suggested answer. */
  pricedFromBookId: string | null;
  pricedFromName: string | null;
};

/**
 * EVERY SHOP ON MORE THAN ONE LIST, with the one that prices it today. Shops
 * that overlapped before the rule existed go on pricing exactly as they did;
 * this is the list somebody works down to settle them.
 */
export async function doubleListedShops(day: string, opts?: ResolveOptions): Promise<DoubleListedView[]> {
  const [world, shops] = await Promise.all([loadWorld(db), loadShops(db)]);
  const rows = doubleListed(shops.geos, world.scopes, world.lists, day);
  const geoOf = new Map(shops.geos.map((g) => [g.customerId, g]));
  const listsById = new Map(world.lists.map((l) => [l.id, l]));
  const pricing = { scopes: world.scopes, lists: world.lists.filter((l) => l.status !== "draft") };
  return rows
    .map((r) => {
      const res = resolvePriceList(geoOf.get(r.customerId)!, pricing.scopes, pricing.lists, day, opts);
      const winner = res ? listsById.get(res.listId) : null;
      const winnerBook = winner ? bookOf(winner) : null;
      const onIt = winnerBook ? r.books.find((b) => b.bookId === winnerBook) ?? null : null;
      return {
        customerId: r.customerId,
        name: shops.names.get(r.customerId)?.name ?? r.customerId,
        city: shops.names.get(r.customerId)?.city ?? null,
        books: r.books,
        pricedFromBookId: onIt?.bookId ?? null,
        pricedFromName: onIt?.listName ?? null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The books one shop is on today, for the shop's own page. */
export async function booksOfShop(customerId: string, day: string): Promise<BookOnShop[]> {
  const [world, rows] = await Promise.all([
    loadWorld(db),
    db.execute<GeoRow>(sql`${GEO_SELECT} where c.id = ${customerId}`),
  ]);
  if (!rows[0]) return [];
  return booksOnShop(toGeo(rows[0]), world.scopes, world.lists, day);
}
