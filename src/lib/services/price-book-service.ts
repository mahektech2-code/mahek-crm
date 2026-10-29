import "server-only";
import { cache } from "react";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getConfig } from "@/lib/config/store";
import { addDays } from "@/lib/business-date";
import { today } from "@/lib/recompute";
import { userIdsInScope } from "@/lib/access-control";
import { resolvePriceList, type Resolution } from "@/lib/engines/price-resolution";
import {
  countChanges,
  diffRates,
  ratesHash,
  revenueEffect,
  stageOf,
  type ChangeFlag,
  type ChangeRate,
  type NeighbourRate,
  type OverrideOnBook,
} from "@/lib/engines/price-change";
import { overrideState } from "@/lib/engines/price-overrides";
import {
  activeScopesAndLists,
  bookClause,
  GEO_SELECT,
  LIST_SELECT,
  resolveOptionsFrom,
  toGeo,
  toSummary,
  type GeoRow,
  type ListRow,
} from "@/lib/services/price-list-service";
import type { PriceChangeNotify, PriceChangeSource, PriceFreightTerm } from "@/db/schema";
import type { PriceListSummary } from "@/lib/price-list-views";
import type {
  BookDetail,
  BookEvent,
  BookRevision,
  BookRow,
  BookState,
  ChangeAiReview,
  ChangeSummaryRow,
  ChangeView,
  OverrideView,
} from "@/lib/price-book-views";
import { PROVIDER_LABEL } from "@/lib/price-ai/providers";

/* ---------------------------------------------------------------------------
 * PRICE BOOKS, READ — the books, a book, a change, and the facts a change is
 * checked against.
 *
 * A BOOK is a lineage of `price_lists` (`book_id`), so nothing here stores a
 * second copy of a list: the book's revisions are its published versions, its
 * draft is a change's draft, and who it covers is the scopes the versions
 * carry (each version inherits them on publish). What the book screens add is
 * the WORKFLOW (`price_changes`) and the reading of all of it as one thing.
 * ------------------------------------------------------------------------- */

type ChangeRow = {
  id: string;
  bookId: string;
  baseListId: string | null;
  draftListId: string;
  status: string;
  title: string | null;
  reason: string | null;
  source: PriceChangeSource;
  makerId: string;
  makerName: string;
  goLive: string | null;
  submittedAt: string | null;
  approverId: string | null;
  approverName: string | null;
  approvedAt: string | null;
  needsSecond: boolean;
  secondApproverId: string | null;
  secondApproverName: string | null;
  approverNote: string | null;
  sendBackReason: string | null;
  notify: PriceChangeNotify;
  checks: unknown;
  checkedAt: string | null;
  checkedHash: string | null;
  acks: Record<string, { note: string; byId: string; at: string }>;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
};

const ISO_TS = (col: string) => sql.raw(`to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`);

const CHANGE_SELECT = sql`
  select pc.id, pc.book_id as "bookId", pc.base_list_id as "baseListId", pc.draft_list_id as "draftListId",
         pc.status, pc.title, pc.reason, pc.source,
         pc.maker_id as "makerId", coalesce(mu.name, 'Unknown') as "makerName",
         pc.go_live::text as "goLive",
         ${ISO_TS("pc.submitted_at")} as "submittedAt",
         pc.approver_id as "approverId", au.name as "approverName",
         ${ISO_TS("pc.approved_at")} as "approvedAt",
         pc.needs_second as "needsSecond",
         pc.second_approver_id as "secondApproverId", su.name as "secondApproverName",
         pc.approver_note as "approverNote", pc.send_back_reason as "sendBackReason",
         pc.notify, pc.checks, ${ISO_TS("pc.checked_at")} as "checkedAt", pc.checked_hash as "checkedHash",
         pc.acks, pc.cancel_reason as "cancelReason",
         ${ISO_TS("pc.created_at")} as "createdAt", ${ISO_TS("pc.updated_at")} as "updatedAt"
    from price_changes pc
    left join users mu on mu.id = pc.maker_id
    left join users au on au.id = pc.approver_id
    left join users su on su.id = pc.second_approver_id
`;

/* ------------------------------------------------------- shops, resolved */

export type ShopResolution = { customerId: string; name: string; salesAmId: string | null; resolution: Resolution | null };

/**
 * Every shop the reader may see, resolved as of `day` — the same narrowing the
 * coverage report uses. Cached per request: the books list, a book's page and
 * a change's effect all ask it.
 */
export const shopResolutions = cache(async function shopResolutions(day: string): Promise<ShopResolution[]> {
  const [config, ids, { scopes, lists }] = await Promise.all([getConfig(), userIdsInScope(), activeScopesAndLists()]);
  const rows = await db.execute<GeoRow & { name: string }>(sql`
    select g.*, named.name
      from (${GEO_SELECT} where c.kind = 'customer' and c.status <> 'deactivated' and ${bookClause(ids)}) g
      join customers named on named.id = g."customerId"
  `);
  const opts = resolveOptionsFrom(config);
  return [...rows].map((row) => ({
    customerId: row.customerId,
    name: row.name,
    salesAmId: row.salesAmId,
    resolution: resolvePriceList(toGeo(row), scopes, lists, day, opts),
  }));
});

/** Shops whose resolution picks one of these lists, by list. */
function shopsByList(shops: readonly ShopResolution[]): Map<string, ShopResolution[]> {
  const out = new Map<string, ShopResolution[]>();
  for (const s of shops) {
    const id = s.resolution?.listId;
    if (!id) continue;
    out.set(id, [...(out.get(id) ?? []), s]);
  }
  return out;
}

/* ------------------------------------------------------------- the books */

type Version = PriceListSummary & { kind: string };

const allVersions = cache(async function allVersions(day: string): Promise<Version[]> {
  const config = await getConfig();
  const rows = await db.execute<ListRow & { kind: string }>(sql`
    select x.*, (select l2.kind from price_lists l2 where l2.id = x.id) as kind
      from (${LIST_SELECT}) x
     order by x."bookId" asc, x.version asc, x.id asc
  `);
  const opts = resolveOptionsFrom(config);
  return [...rows].map((r) => ({ ...toSummary(r, day, opts), kind: r.kind }));
});

const openChanges = cache(async function openChanges(): Promise<ChangeRow[]> {
  return [...(await db.execute<ChangeRow>(sql`${CHANGE_SELECT} where pc.status in ('draft', 'submitted', 'sent_back')`))];
});

function inForce(v: Version, day: string): boolean {
  return v.status === "published" && v.effectiveFrom <= day && (v.effectiveTo == null || v.effectiveTo >= day);
}

function bookRowFrom(
  bookId: string,
  versions: Version[],
  day: string,
  expiringDays: number,
  change: ChangeRow | null,
  shopsByListId: Map<string, ShopResolution[]>,
): BookRow {
  const published = versions.filter((v) => v.status === "published");
  const live = [...published].reverse().find((v) => inForce(v, day)) ?? null;
  const scheduled = [...published].reverse().find((v) => v.effectiveFrom > day) ?? null;
  const notWithdrawn = versions.filter((v) => v.status !== "withdrawn" && v.status !== "draft");
  const head = scheduled ?? live ?? notWithdrawn[notWithdrawn.length - 1] ?? versions[versions.length - 1] ?? null;
  const shown = live ?? scheduled ?? head ?? versions[versions.length - 1];

  let state: BookState;
  const everPublished = versions.some((v) => v.status !== "draft");
  if (!everPublished) state = "draft";
  else if (!live && !scheduled) state = "retired";
  else if (change) state = "change_waiting";
  else if (scheduled) state = "scheduled";
  else if (live && live.validityState !== "current") state = "expired";
  else if (live?.expiresOn && daysBetween(day, live.expiresOn) <= expiringDays) state = "expiring";
  else state = "live";

  const stage = change ? stageOf({ status: change.status, checkedHash: change.checkedHash, goLive: change.goLive }, change.checkedHash ?? "", day) : null;
  return {
    id: bookId,
    name: shown.name,
    kind: (shown.kind === "agreed" ? "agreed" : "standard") as "standard" | "agreed",
    freightTerm: shown.freightTerm,
    scopeSummary: shown.scopeSummary,
    scopeCount: shown.scopeCount,
    live: live
      ? {
          listId: live.id,
          version: live.version,
          effectiveFrom: live.effectiveFrom,
          effectiveTo: live.effectiveTo,
          expiresOn: live.expiresOn,
          validityState: live.validityState,
          rateCount: live.rateCount,
        }
      : null,
    scheduled: scheduled
      ? { listId: scheduled.id, version: scheduled.version, effectiveFrom: scheduled.effectiveFrom, effectiveTo: scheduled.effectiveTo }
      : null,
    openChange: change && stage
      ? { id: change.id, stage, title: change.title, makerName: change.makerName, goLive: change.goLive }
      : null,
    head: head ? { listId: head.id, version: head.version, status: head.status } : null,
    revisions: published.length + versions.filter((v) => v.status === "superseded" || v.status === "withdrawn").length,
    shops: live ? (shopsByListId.get(live.id)?.length ?? 0) : 0,
    state,
    updatedAt: versions.reduce((m, v) => (v.updatedAt > m ? v.updatedAt : m), ""),
  };
}

function daysBetween(fromIso: string, toIso: string): number {
  const [a, b] = [fromIso, toIso].map((d) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))));
  return Math.round((b - a) / 86_400_000);
}

/** Every book, one row each, with what it is doing today. */
export async function listBooks(): Promise<BookRow[]> {
  const [config, day] = await Promise.all([getConfig(), today()]);
  const [versions, changes, shops] = await Promise.all([allVersions(day), openChanges(), shopResolutions(day)]);
  const byBook = new Map<string, Version[]>();
  for (const v of versions) {
    /* A draft that is a change's draft belongs to the change, not to the book's
       list of versions — counted once, in the change. */
    byBook.set(v.bookId, [...(byBook.get(v.bookId) ?? []), v]);
  }
  const changeDrafts = new Set(changes.map((c) => c.draftListId));
  const changeByBook = new Map(changes.map((c) => [c.bookId, c]));
  const byList = shopsByList(shops);
  const out: BookRow[] = [];
  for (const [bookId, vs] of byBook) {
    const own = vs.filter((v) => !changeDrafts.has(v.id));
    if (!own.length) continue;
    out.push(bookRowFrom(bookId, own, day, config["pricing.today.expiringDays"], changeByBook.get(bookId) ?? null, byList));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export async function bookRow(bookId: string): Promise<BookRow | null> {
  return (await listBooks()).find((b) => b.id === bookId) ?? null;
}

/** A list's book, for links from the list screens. */
export async function bookIdOfList(listId: string): Promise<string | null> {
  const [row] = await db.execute<{ bookId: string | null }>(sql`select book_id as "bookId" from price_lists where id = ${listId}`);
  return row?.bookId ?? null;
}

export async function bookDetail(bookId: string): Promise<BookDetail | null> {
  const day = await today();
  const book = await bookRow(bookId);
  if (!book) return null;
  const versions = (await allVersions(day)).filter((v) => v.bookId === bookId);
  const [people, changes, events] = await Promise.all([
    db.execute<{ id: string; createdByName: string | null; publishedByName: string | null }>(sql`
      select l.id, cu.name as "createdByName", pu.name as "publishedByName"
        from price_lists l
        left join users cu on cu.id = l.created_by_id
        left join users pu on pu.id = l.published_by_id
       where l.book_id = ${bookId}
    `),
    db.execute<ChangeRow>(sql`${CHANGE_SELECT} where pc.book_id = ${bookId} order by pc.created_at desc`),
    bookEvents(sql`e.book_id = ${bookId}`),
  ]);
  const who = new Map([...people].map((p) => [p.id, p]));
  const changeByDraft = new Map([...changes].map((c) => [c.draftListId, c]));
  const openDrafts = new Set([...changes].filter((c) => ["draft", "submitted", "sent_back"].includes(c.status)).map((c) => c.draftListId));

  const revisions: BookRevision[] = versions
    .filter((v) => !openDrafts.has(v.id))
    .map((v) => {
      const c = changeByDraft.get(v.id) ?? null;
      const role: BookRevision["role"] =
        v.status === "withdrawn"
          ? "withdrawn"
          : v.status === "draft"
            ? "draft"
            : v.id === book.live?.listId
              ? "live"
              : v.id === book.scheduled?.listId
                ? "scheduled"
                : "history";
      return {
        listId: v.id,
        version: v.version,
        name: v.name,
        status: v.status,
        effectiveFrom: v.effectiveFrom,
        effectiveTo: v.effectiveTo,
        rateCount: v.rateCount,
        documentId: v.documentId,
        createdByName: who.get(v.id)?.createdByName ?? null,
        publishedAt: v.publishedAt,
        publishedByName: who.get(v.id)?.publishedByName ?? null,
        change: c
          ? { id: c.id, makerName: c.makerName, approverName: c.approverName, secondApproverName: c.secondApproverName, reason: c.reason }
          : null,
        role,
      };
    })
    .reverse();

  return {
    book,
    revisions,
    events,
    changes: [...changes].map((c) => toChangeSummary(c, book.name, day)),
    shownListId: book.live?.listId ?? book.scheduled?.listId ?? book.head?.listId ?? null,
  };
}

function toChangeSummary(c: ChangeRow, bookName: string, day: string): ChangeSummaryRow {
  const summary = (c.checks as { counts?: { changed?: number } } | null) ?? null;
  return {
    id: c.id,
    bookId: c.bookId,
    bookName,
    title: c.title,
    stage: stageOf({ status: c.status, checkedHash: c.checkedHash, goLive: c.goLive }, c.checkedHash ?? "", day),
    makerName: c.makerName,
    goLive: c.goLive,
    changed: summary?.counts?.changed ?? 0,
    updatedAt: c.updatedAt,
  };
}

/** Every change in a status, across books — for Today and the books list. */
export async function changesIn(statuses: string[]): Promise<ChangeSummaryRow[]> {
  if (!statuses.length) return [];
  const day = await today();
  const rows = await db.execute<ChangeRow & { bookName: string }>(sql`
    select x.*, (select l.name from price_lists l where l.id = x."draftListId") as "bookName"
      from (${CHANGE_SELECT} where pc.status in (${sql.join(statuses.map((s) => sql`${s}`), sql`, `)})) x
     order by x."updatedAt" desc
  `);
  return [...rows].map((c) => toChangeSummary(c, c.bookName, day));
}

async function bookEvents(where: ReturnType<typeof sql>): Promise<BookEvent[]> {
  const rows = await db.execute<BookEvent>(sql`
    select e.id, e.change_id as "changeId", e.kind, u.name as "actorName", e.note,
           ${ISO_TS("e.created_at")} as at
      from price_change_events e
      left join users u on u.id = e.actor_id
     where ${where}
     order by e.created_at desc, e.id desc
     limit 200
  `);
  return [...rows];
}

/* -------------------------------------------------------------- a change */

/** A list's rows as a change reads them. Bigints coerced. */
export async function changeRatesOf(listId: string): Promise<ChangeRate[]> {
  const rows = await db.execute<{
    productId: string;
    productName: string;
    brandName: string | null;
    millilitresPerCan: number | null;
    minCans: number | null;
    rateExGstPaise: string | number;
    rateInclGstPaise: string | number;
    offered: boolean;
  }>(sql`
    select r.product_id as "productId", p.name as "productName", b.name as "brandName",
           p.millilitres_per_can as "millilitresPerCan", r.min_cans as "minCans",
           r.rate_ex_gst_paise as "rateExGstPaise", r.rate_incl_gst_paise as "rateInclGstPaise", r.offered
      from price_list_rates r
      join products p on p.id = r.product_id
      left join product_brands b on b.id = p.brand_id
     where r.price_list_id = ${listId}
     order by b.name asc nulls last, p.millilitres_per_can asc nulls last, p.name asc, r.min_cans asc nulls first
  `);
  return [...rows].map((r) => ({
    productId: r.productId,
    productName: r.productName,
    family: r.brandName ?? (r.productName.includes(" - ") ? r.productName.slice(0, r.productName.indexOf(" - ")) : r.productName),
    millilitresPerCan: r.millilitresPerCan == null ? null : Number(r.millilitresPerCan),
    minCans: r.minCans == null ? null : Number(r.minCans),
    rateExGstPaise: Number(r.rateExGstPaise),
    rateInclGstPaise: Number(r.rateInclGstPaise),
    offered: r.offered,
  }));
}

/**
 * Cans a month each product sold to these shops over the last `months` whole
 * months — the sheet's lines and the ERP's own, as the variance report reads
 * them, so the effect of a change is measured on the same volume.
 */
export async function volumeFor(customerIds: readonly string[], months: number, day: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!customerIds.length) return out;
  const to = `${day.slice(0, 7)}-01`;
  let from = to;
  for (let i = 0; i < months; i++) from = `${addDays(from, -1).slice(0, 7)}-01`;
  for (let i = 0; i < customerIds.length; i += 5000) {
    const ids = sql.join(customerIds.slice(i, i + 5000).map((id) => sql`${id}`), sql`, `);
    const rows = await db.execute<{ productId: string; cans: string | number }>(sql`
      select x."productId", sum(x.cans) as cans from (
        select o.matched_product_id as "productId", coalesce(o.cans, 0) as cans
          from sheet_order_rows o
         where o.status = 'present' and o.matched_product_id is not null
           and o.order_date >= ${from}::date and o.order_date < ${to}::date
           and o.matched_customer_id in (${ids})
        union all
        select e.sku_id, coalesce(e.qty_cans, 0)
          from erp_orders e
         where e.source = 'erp' and e.status <> 'Cancel' and e.sku_id is not null
           and e.order_date >= ${from}::date and e.order_date < ${to}::date
           and e.billing_customer_id in (${ids})
      ) x group by x."productId"
    `);
    for (const r of rows) out.set(r.productId, (out.get(r.productId) ?? 0) + Number(r.cans) / months);
  }
  return out;
}

/**
 * What these shops were actually BILLED for these products over the last
 * `months`, ex-GST per can: how many lines, the lowest and the median. A rise
 * on a product the shops are already billed below is a rise that may not stick.
 */
export async function billedFor(
  customerIds: readonly string[],
  productIds: readonly string[],
  months: number,
  day: string,
): Promise<Map<string, { lines: number; minEx: number; medianEx: number }>> {
  const out = new Map<string, { lines: number; minEx: number; medianEx: number }>();
  if (!customerIds.length || !productIds.length) return out;
  const from = addDays(day, -Math.round(months * 30.5));
  const products = sql.join([...new Set(productIds)].map((id) => sql`${id}`), sql`, `);
  const all = new Map<string, number[]>();
  for (let i = 0; i < customerIds.length; i += 5000) {
    const ids = sql.join(customerIds.slice(i, i + 5000).map((id) => sql`${id}`), sql`, `);
    const rows = await db.execute<{ productId: string; ex: string | number }>(sql`
      select o.matched_product_id as "productId", o.rate_paise as ex
        from sheet_order_rows o
       where o.status = 'present' and o.rate_paise is not null and o.order_date >= ${from}::date
         and o.matched_customer_id in (${ids}) and o.matched_product_id in (${products})
      union all
      select e.sku_id, e.rate_paise
        from erp_orders e
       where e.source = 'erp' and e.status <> 'Cancel' and e.rate_paise is not null and e.order_date >= ${from}::date
         and e.billing_customer_id in (${ids}) and e.sku_id in (${products})
    `);
    for (const r of rows) all.set(r.productId, [...(all.get(r.productId) ?? []), Number(r.ex)]);
  }
  for (const [productId, values] of all) {
    const v = values.filter((x) => x > 0).sort((a, b) => a - b);
    if (!v.length) continue;
    const m = Math.floor(v.length / 2);
    out.set(productId, { lines: v.length, minEx: v[0], medianEx: v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2) });
  }
  return out;
}

/** The same products in every OTHER standard book in force today, for the typo check. */
export async function neighbourRates(bookId: string, day: string): Promise<NeighbourRate[]> {
  const rows = await db.execute<{ bookName: string; productId: string; rateExGstPaise: string | number }>(sql`
    select l.name as "bookName", r.product_id as "productId", r.rate_ex_gst_paise as "rateExGstPaise"
      from price_list_rates r
      join price_lists l on l.id = r.price_list_id
     where l.status = 'published' and l.kind = 'standard'
       and coalesce(l.book_id, l.id) <> ${bookId}
       and l.effective_from <= ${day}::date and (l.effective_to is null or l.effective_to >= ${day}::date)
       and r.min_cans is null and r.offered
  `);
  return [...rows].map((r) => ({ bookName: r.bookName, productId: r.productId, rateExGstPaise: Number(r.rateExGstPaise) }));
}

/** Live overrides of the shops this list prices. */
export async function overridesForShops(customerIds: readonly string[], day: string): Promise<OverrideOnBook[]> {
  if (!customerIds.length) return [];
  const out: OverrideOnBook[] = [];
  for (let i = 0; i < customerIds.length; i += 5000) {
    const ids = sql.join(customerIds.slice(i, i + 5000).map((id) => sql`${id}`), sql`, `);
    const rows = await db.execute<{ customerName: string; productId: string; rateExGstPaise: string | number }>(sql`
      select c.name as "customerName", o.product_id as "productId", o.rate_ex_gst_paise as "rateExGstPaise"
        from price_overrides o join customers c on c.id = o.customer_id
       where o.cancelled_at is null and o.valid_from <= ${day}::date and (o.valid_to is null or o.valid_to >= ${day}::date)
         and o.customer_id in (${ids})
    `);
    for (const r of rows) out.push({ customerName: r.customerName, productId: r.productId, rateExGstPaise: Number(r.rateExGstPaise) });
  }
  return out;
}

export async function changeRow(changeId: string): Promise<ChangeRow | null> {
  const [row] = await db.execute<ChangeRow>(sql`${CHANGE_SELECT} where pc.id = ${changeId}`);
  return row ?? null;
}

export type ChangeFacts = {
  change: ChangeRow;
  base: ChangeRate[];
  draft: ChangeRate[];
  baseList: { id: string; version: number; name: string; effectiveFrom: string; effectiveTo: string | null; status: string; kind: string } | null;
  draftList: { id: string; version: number; name: string; status: string; effectiveFrom: string; gstBp: number; freightTerm: PriceFreightTerm; derived: boolean; kind: string };
  shopIds: string[];
  day: string;
};

/** Everything a change is judged on, read once. The actions and the screen both start here. */
export async function changeFacts(changeId: string): Promise<ChangeFacts | null> {
  const change = await changeRow(changeId);
  if (!change) return null;
  const day = await today();
  const [lists] = await Promise.all([
    db.execute<{ id: string; version: number; name: string; status: string; effectiveFrom: string; effectiveTo: string | null; gstBp: number; freightTerm: PriceFreightTerm; derived: boolean; kind: string }>(sql`
      select l.id, l.version, l.name, l.status, l.effective_from::text as "effectiveFrom", l.effective_to::text as "effectiveTo",
             l.gst_bp as "gstBp", l.freight_term as "freightTerm", (l.parent_list_id is not null and l.derivation is not null) as derived, l.kind
        from price_lists l where l.id in (${change.draftListId}, ${change.baseListId ?? change.draftListId})
    `),
  ]);
  const draftList = [...lists].find((l) => l.id === change.draftListId);
  if (!draftList) return null;
  const baseList = change.baseListId ? ([...lists].find((l) => l.id === change.baseListId) ?? null) : null;
  const [base, draft, shops] = await Promise.all([
    baseList ? changeRatesOf(baseList.id) : Promise.resolve([]),
    changeRatesOf(draftList.id),
    shopResolutions(day),
  ]);
  const shopIds = baseList ? shops.filter((s) => s.resolution?.listId === baseList.id).map((s) => s.customerId) : [];
  return { change, base, draft, baseList, draftList, shopIds, day };
}

type StoredChecks = { flags?: ChangeFlag[]; reviews?: ChangeAiReview[]; secondOpinion?: { provider: string; text: string; at: string } | null };

export async function changeDetail(changeId: string): Promise<ChangeView | null> {
  const facts = await changeFacts(changeId);
  if (!facts) return null;
  const { change, base, draft, baseList, draftList, shopIds, day } = facts;
  const config = await getConfig();
  const months = config["pricing.changes.effectVolumeMonths"];
  const [volume, events, ackPeople, books] = await Promise.all([
    volumeFor(shopIds, months, day),
    bookEvents(sql`e.change_id = ${changeId}`),
    db.execute<{ id: string; name: string }>(sql`
      select u.id, u.name from users u
       where u.id in (${sql.join([...new Set(Object.values(change.acks ?? {}).map((a) => a.byId)), "__none"].map((id) => sql`${id}`), sql`, `)})
    `),
    listBooks(),
  ]);
  const diffs = diffRates(base, draft);
  const currentHash = ratesHash(draft);
  const stored = (change.checks ?? {}) as StoredChecks;
  const names = new Map([...ackPeople].map((p) => [p.id, p.name]));
  const effect = revenueEffect(diffs, volume);
  return {
    id: change.id,
    bookId: change.bookId,
    bookName: baseList?.name ?? draftList.name,
    kind: (draftList.kind === "agreed" ? "agreed" : "standard") as "standard" | "agreed",
    status: change.status,
    stage: stageOf({ status: change.status, checkedHash: change.checkedHash, goLive: change.goLive }, currentHash, day),
    source: change.source,
    title: change.title,
    reason: change.reason,
    goLive: change.goLive,
    notify: change.notify ?? {},
    maker: { id: change.makerId, name: change.makerName },
    approver: change.approverId ? { id: change.approverId, name: change.approverName ?? "Unknown" } : null,
    secondApprover: change.secondApproverId ? { id: change.secondApproverId, name: change.secondApproverName ?? "Unknown" } : null,
    needsSecond: change.needsSecond,
    approverNote: change.approverNote,
    sendBackReason: change.sendBackReason,
    cancelReason: change.cancelReason,
    submittedAt: change.submittedAt,
    approvedAt: change.approvedAt,
    createdAt: change.createdAt,
    updatedAt: change.updatedAt,
    baseList: baseList
      ? { id: baseList.id, version: baseList.version, name: baseList.name, effectiveFrom: baseList.effectiveFrom, effectiveTo: baseList.effectiveTo, status: baseList.status }
      : null,
    draftList: { id: draftList.id, version: draftList.version, name: draftList.name, status: draftList.status, effectiveFrom: draftList.effectiveFrom },
    gstBp: draftList.gstBp,
    freightTerm: draftList.freightTerm,
    derived: draftList.derived,
    base,
    draft,
    diffs,
    counts: countChanges(diffs),
    effect: { ...effect, months },
    flags: stored.flags ?? [],
    acks: Object.fromEntries(
      Object.entries(change.acks ?? {}).map(([k, a]) => [k, { note: a.note, byName: names.get(a.byId) ?? null, at: a.at }]),
    ),
    checkedAt: change.checkedAt,
    checkStale: !!change.checkedHash && change.checkedHash !== currentHash,
    currentHash,
    reviews: stored.reviews ?? [],
    secondOpinion: stored.secondOpinion ?? null,
    events,
    shops: shopIds.length,
    families: [...new Set(draft.map((r) => r.family))].sort(),
    otherBooks: books
      .filter((b) => b.id !== change.bookId && b.kind === "standard" && b.live)
      .map((b) => ({ id: b.id, name: b.name, listId: b.live!.listId })),
  };
}

/* ------------------------------------------------------------- overrides */

/**
 * Overrides, as the screens read them: each with what the shop's book would
 * charge without it, and last month's cans against its condition.
 */
export async function listOverrides(filter?: { customerId?: string; state?: "open" | "all" }): Promise<OverrideView[]> {
  const day = await today();
  const ids = await userIdsInScope();
  const rows = await db.execute<{
    id: string;
    customerId: string;
    customerName: string;
    productId: string;
    productName: string;
    rateExGstPaise: string | number;
    rateInclGstPaise: string | number;
    validFrom: string;
    validTo: string | null;
    minCansPerMonth: number | null;
    cancelledAt: string | null;
    requestId: string | null;
    note: string | null;
    createdByName: string | null;
    createdAt: string;
  }>(sql`
    select o.id, o.customer_id as "customerId", c.name as "customerName", o.product_id as "productId", p.name as "productName",
           o.rate_ex_gst_paise as "rateExGstPaise", o.rate_incl_gst_paise as "rateInclGstPaise",
           o.valid_from::text as "validFrom", o.valid_to::text as "validTo", o.min_cans_per_month as "minCansPerMonth",
           ${ISO_TS("o.cancelled_at")} as "cancelledAt", o.request_id as "requestId", o.note,
           u.name as "createdByName", ${ISO_TS("o.created_at")} as "createdAt"
      from price_overrides o
      join customers c on c.id = o.customer_id
      join products p on p.id = o.product_id
      left join users u on u.id = o.created_by_id
     where ${bookClause(ids)}
       ${filter?.customerId ? sql`and o.customer_id = ${filter.customerId}` : sql``}
       ${filter?.state === "all" ? sql`` : sql`and o.cancelled_at is null and (o.valid_to is null or o.valid_to >= ${addDays(day, -30)}::date)`}
     order by c.name asc, p.name asc, o.valid_from desc
     limit 1000
  `);
  const list = [...rows];
  // Last whole month's cans per shop and product, for the condition.
  const monthStart = `${day.slice(0, 7)}-01`;
  const lastStart = `${addDays(monthStart, -1).slice(0, 7)}-01`;
  const shopIds = [...new Set(list.map((r) => r.customerId))];
  const cans = new Map<string, number>();
  if (shopIds.length) {
    const idsSql = sql.join(shopIds.map((id) => sql`${id}`), sql`, `);
    const vol = await db.execute<{ customerId: string; productId: string; cans: string | number }>(sql`
      select x."customerId", x."productId", sum(x.cans) as cans from (
        select o.matched_customer_id as "customerId", o.matched_product_id as "productId", coalesce(o.cans, 0) as cans
          from sheet_order_rows o
         where o.status = 'present' and o.order_date >= ${lastStart}::date and o.order_date < ${monthStart}::date
           and o.matched_customer_id in (${idsSql})
        union all
        select e.billing_customer_id, e.sku_id, coalesce(e.qty_cans, 0)
          from erp_orders e
         where e.source = 'erp' and e.status <> 'Cancel'
           and e.order_date >= ${lastStart}::date and e.order_date < ${monthStart}::date
           and e.billing_customer_id in (${idsSql})
      ) x group by x."customerId", x."productId"
    `);
    for (const v of vol) cans.set(`${v.customerId}|${v.productId}`, Number(v.cans));
  }
  // What each shop's book charges without its overrides: the first list in its
  // chain that is NOT its agreed-prices list.
  const shops = await shopResolutions(day);
  const shopById = new Map(shops.map((s) => [s.customerId, s]));
  const agreedIds = new Set(
    [...(await db.execute<{ id: string }>(sql`select id from price_lists where kind = 'agreed'`))].map((r) => r.id),
  );
  const needLists = new Set<string>();
  for (const r of list) for (const c of shopById.get(r.customerId)?.resolution?.candidates ?? []) if (!agreedIds.has(c.listId)) needLists.add(c.listId);
  const bookRates = new Map<string, number>();
  if (needLists.size) {
    const rr = await db.execute<{ listId: string; productId: string; ex: string | number }>(sql`
      select r.price_list_id as "listId", r.product_id as "productId", r.rate_ex_gst_paise as ex
        from price_list_rates r where r.min_cans is null and r.offered and r.price_list_id in (${sql.join([...needLists].map((id) => sql`${id}`), sql`, `)})
    `);
    for (const x of rr) bookRates.set(`${x.listId}|${x.productId}`, Number(x.ex));
  }
  return list.map((r) => {
    let bookEx: number | null = null;
    let bookName: string | null = null;
    for (const c of shopById.get(r.customerId)?.resolution?.candidates ?? []) {
      if (agreedIds.has(c.listId)) continue;
      const v = bookRates.get(`${c.listId}|${r.productId}`);
      if (v != null) {
        bookEx = v;
        bookName = c.listName;
        break;
      }
    }
    return {
      id: r.id,
      customerId: r.customerId,
      customerName: r.customerName,
      productId: r.productId,
      productName: r.productName,
      rateExGstPaise: Number(r.rateExGstPaise),
      rateInclGstPaise: Number(r.rateInclGstPaise),
      bookExGstPaise: bookEx,
      bookName,
      validFrom: r.validFrom,
      validTo: r.validTo,
      minCansPerMonth: r.minCansPerMonth,
      lastMonthCans: cans.has(`${r.customerId}|${r.productId}`) ? cans.get(`${r.customerId}|${r.productId}`)! : r.minCansPerMonth ? 0 : null,
      state: overrideState({ validFrom: r.validFrom, validTo: r.validTo, cancelledAt: r.cancelledAt }, day),
      requestId: r.requestId,
      note: r.note,
      createdByName: r.createdByName,
      createdAt: r.createdAt,
    };
  });
}

export { PROVIDER_LABEL };
