import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { priceListRates, priceListScopes, priceLists, priceOverrides, priceRequests } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { addDays } from "@/lib/business-date";
import { notifyUsers } from "@/lib/notify";
import { today } from "@/lib/recompute";
import { AGREED_SCOPE_PRIORITY, type Resolution } from "@/lib/engines/price-resolution";
import { inclFromEx } from "@/lib/engines/price-math";
import { dueForReminder, plannedAgreedRates, type AgreedRate, type OverrideLike } from "@/lib/engines/price-overrides";
import {
  chainedRate,
  customerPricing,
  resolveForCustomer,
  rowsForLists,
  type PricedRow,
} from "@/lib/services/price-list-service";
import { billedFor, listOverrides, shopResolutions, volumeFor } from "@/lib/services/price-book-service";
import { aiReadiness, askBoth, askEither, PROVIDER_LABEL } from "@/lib/price-ai/providers";
import type { RateRow } from "@/lib/price-list-views";
import type {
  RequestAdvice,
  RequestContext,
  ShopPriceRow,
  ShopPriceSource,
  ShopPricesView,
  ShopProductFacts,
} from "@/components/pricing/overrides/types";
import { priceDeskPeople } from "@/lib/services/price-desk-people";
import { audit, draftVersionIn, publishDraftIn, type DeskCtx, type Tx } from "@/lib/services/price-write";

/* ---------------------------------------------------------------------------
 * OVERRIDES, APPLIED — the shop's agreed-prices list kept in step with its
 * dated special prices.
 *
 * An override does not price anything by itself. The shop's AGREED list does
 * (`kind = 'agreed'`, one customer scope at AGREED_SCOPE_PRIORITY), because it
 * already layers over the shop's book product by product in every reader — the
 * CRM, the ERP order form, the handset, the variance report — and none of them
 * has to learn overrides exist. `plannedAgreedRates` says what that list should
 * hold on a day; this file makes it so.
 *
 * A CHANGE IS A NEW REVISION, never an edit. When the plan differs from what
 * the agreed list holds, a new version is published effective that day through
 * the same `draftVersionIn` / `publishDraftIn` every other publish uses, so an
 * order priced last month is still explained by last month's revision. A
 * second run on the same day finds nothing to do and writes nothing.
 *
 * A PRODUCT NOBODY GAVE AN OVERRIDE IS LEFT AS TYPED. Only products that have
 * override rows are decided by them: the live one's price, or off the list when
 * none is live, so the product falls back to the book.
 * ------------------------------------------------------------------------- */

const ISO = (col: string) => sql.raw(`to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
const gen = (prefix: string) => `${prefix}_${randomUUID().slice(0, 12)}`;

/** Who a scheduled job writes as: nobody. `audit_log.actor_id` and every `*_by_id` take null. */
export const SYSTEM_CTX = {
  user: { id: null as unknown as string, name: "MahekOne" },
  authorisedBy: null as unknown as string,
  authorisedIn: null,
} as unknown as DeskCtx;

export type AgreedListRow = { id: string; bookId: string; gstBp: number; effectiveFrom: string; name: string };

/**
 * The shop's OWN agreed-prices list — kind `agreed`, a customer scope naming
 * this shop and nothing else, still in force or yet to start. The same rule
 * `decidePriceRequest` has always used, so old and new agree on which list it
 * is: a shared list ASSIGNED to the shop also has a customer scope naming it,
 * and writing a special price into that would reprice every shop on it.
 */
export async function findAgreedList(tx: Tx | typeof db, customerId: string, day: string, lock = false): Promise<AgreedListRow | null> {
  const [row] = await tx.execute<AgreedListRow>(sql`
    select l.id, coalesce(l.book_id, l.id) as "bookId", l.gst_bp as "gstBp",
           l.effective_from::text as "effectiveFrom", l.name
      from price_lists l
     where l.kind = 'agreed'
       and l.status = 'published'
       and (l.effective_to is null or l.effective_to >= ${day}::date)
       and exists (select 1 from price_list_scopes s
                    where s.price_list_id = l.id
                      and s.scope_kind = 'customer' and s.scope_value = ${customerId})
       and not exists (select 1 from price_list_scopes s
                        where s.price_list_id = l.id
                          and not (s.scope_kind = 'customer' and s.scope_value = ${customerId}))
     order by l.effective_from desc, l.id desc
     limit 1
     ${lock ? sql`for update of l` : sql``}
  `);
  return row ? { ...row, gstBp: Number(row.gstBp) } : null;
}

async function agreedRatesOf(tx: Tx | typeof db, listId: string): Promise<AgreedRate[]> {
  const rows = await tx.execute<{ productId: string; ex: string | number; incl: string | number; minCans: number | null; offered: boolean }>(sql`
    select r.product_id as "productId", r.rate_ex_gst_paise as ex, r.rate_incl_gst_paise as incl,
           r.min_cans as "minCans", r.offered
      from price_list_rates r where r.price_list_id = ${listId}
  `);
  return [...rows].map((r) => ({
    productId: r.productId,
    rateExGstPaise: Number(r.ex),
    rateInclGstPaise: Number(r.incl),
    minCans: r.minCans == null ? null : Number(r.minCans),
    offered: r.offered,
  }));
}

async function overridesOf(tx: Tx | typeof db, customerId: string): Promise<Array<OverrideLike & { requestId: string | null }>> {
  const rows = await tx.execute<{
    id: string;
    productId: string;
    ex: string | number;
    incl: string | number;
    validFrom: string;
    validTo: string | null;
    cancelledAt: string | null;
    createdAt: string;
    requestId: string | null;
  }>(sql`
    select o.id, o.product_id as "productId", o.rate_ex_gst_paise as ex, o.rate_incl_gst_paise as incl,
           o.valid_from::text as "validFrom", o.valid_to::text as "validTo",
           ${ISO("o.cancelled_at")} as "cancelledAt", ${ISO("o.created_at")} as "createdAt", o.request_id as "requestId"
      from price_overrides o where o.customer_id = ${customerId}
  `);
  return [...rows].map((r) => ({
    id: r.id,
    productId: r.productId,
    rateExGstPaise: Number(r.ex),
    rateInclGstPaise: Number(r.incl),
    validFrom: r.validFrom,
    validTo: r.validTo,
    cancelledAt: r.cancelledAt,
    createdAt: r.createdAt,
    requestId: r.requestId,
  }));
}

/**
 * A NEW agreed-prices list for a shop that has none, with these rows, published
 * effective `day`. Named, noted and scoped exactly as `decidePriceRequest` made
 * them before overrides existed, so a list made either way reads the same.
 */
export async function ensureAgreedList(
  tx: Tx,
  ctx: DeskCtx,
  customerId: string,
  day: string,
  rows: readonly AgreedRate[],
): Promise<AgreedListRow> {
  const existing = await findAgreedList(tx, customerId, day, true);
  if (existing) return existing;
  const config = await getConfig();
  const [customer] = await tx.execute<{ name: string }>(sql`select name from customers where id = ${customerId}`);
  const resolution = await resolveForCustomer(customerId, day);
  const [parentList] = resolution
    ? await tx.select().from(priceLists).where(eq(priceLists.id, resolution.listId))
    : [];
  const gstBp = parentList?.gstBp ?? config["pricing.gstBp"];
  const listId = gen("pl");
  await tx.insert(priceLists).values({
    id: listId,
    name: `${customer?.name ?? "Customer"} — agreed prices`,
    version: 1,
    kind: "agreed",
    effectiveFrom: day,
    taxBasis: parentList?.taxBasis ?? "inclusive",
    gstBp,
    deliveryBasis: parentList?.deliveryBasis ?? null,
    freightTerm: "not_stated",
    parentListId: parentList?.id ?? null,
    status: "draft",
    notes: `Agreed prices for this shop. Everything not listed here falls through to ${parentList?.name ?? "their ordinary list"}.`,
    createdById: ctx.user.id,
    updatedById: ctx.user.id,
  });
  if (rows.length) {
    await tx.insert(priceListRates).values(
      rows.map((r) => ({
        id: gen("plr"),
        priceListId: listId,
        productId: r.productId,
        rateExGstPaise: r.rateExGstPaise,
        rateInclGstPaise: r.rateInclGstPaise,
        minCans: r.minCans,
        offered: r.offered,
        matchStatus: "manual" as const,
        updatedById: ctx.user.id,
      })),
    );
  }
  /* It LAYERS over whatever list the shop is assigned rather than competing
     with it: the agreed priority outranks every other customer scope. */
  await tx.insert(priceListScopes).values({
    id: gen("pls"),
    priceListId: listId,
    scopeKind: "customer",
    scopeValue: customerId,
    scopeLabel: customer?.name ?? null,
    freightTermMatch: "any",
    priority: AGREED_SCOPE_PRIORITY,
    createdById: ctx.user.id,
  });
  await publishDraftIn(tx, ctx, listId, { effectiveFrom: day }, config, day);
  return { id: listId, bookId: listId, gstBp, effectiveFrom: day, name: `${customer?.name ?? "Customer"} — agreed prices` };
}

export type SyncResult = {
  /** True where a revision was published (or the list ended). */
  changed: boolean;
  /** The agreed list's BOOK id — its first version, the same id however often it is revised. */
  bookId: string | null;
  /** The revision now in force, where there is one. */
  listId: string | null;
  /** Why nothing could be written, where something should have been. */
  skipped: string | null;
};

/**
 * Bring one shop's agreed list in line with its overrides on `day`, inside the
 * caller's transaction. Serialised per shop on the same advisory lock the old
 * approve path takes, so two writers cannot each find no list and make one.
 */
export async function syncShopOverridesIn(tx: Tx, ctx: DeskCtx, customerId: string, day: string): Promise<SyncResult> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"agreed-prices:" + customerId}))`);
  const overrides = await overridesOf(tx, customerId);
  const agreed = await findAgreedList(tx, customerId, day, true);
  if (agreed && agreed.effectiveFrom > day) {
    return { changed: false, bookId: agreed.bookId, listId: null, skipped: `A later revision of ${agreed.name} is already scheduled from ${agreed.effectiveFrom}.` };
  }
  const current = agreed ? await agreedRatesOf(tx, agreed.id) : [];
  const plan = plannedAgreedRates(current, overrides, day);

  let result: SyncResult = { changed: false, bookId: agreed?.bookId ?? null, listId: agreed?.id ?? null, skipped: null };
  if (plan.differs) {
    const config = await getConfig();
    const governed = [...new Set(overrides.map((o) => o.productId))];
    if (!agreed) {
      const made = await ensureAgreedList(tx, ctx, customerId, day, plan.rows);
      result = { changed: true, bookId: made.bookId, listId: made.id, skipped: null };
    } else if (!plan.rows.length) {
      /* Nothing left on it: the list is DATED OUT to the day before, and the
         shop is priced from its book again. Not withdrawn — a withdrawn list
         never prices, so the orders taken while it was in force could no
         longer be read against it — and not revised to empty, because a list
         with no prices is not a list. Still published, inside its own dates,
         it explains every order it priced; the resolver stops reading it on
         the day it ends. */
      await tx.execute(sql`
        update price_lists
           set effective_to = ${addDays(day, -1)}::date,
               updated_at = now(), updated_by_id = ${ctx.user.id}
         where id = ${agreed.id} and status = 'published'
      `);
      await audit(tx, ctx, {
        action: "pricelist.override.ended",
        entityType: "price_list",
        entityId: agreed.id,
        before: { effectiveTo: null },
        after: { reason: "every special price on it has ended", effectiveTo: addDays(day, -1) },
      });
      result = { changed: true, bookId: agreed.bookId, listId: null, skipped: null };
    } else {
      const draft = await draftVersionIn(tx, ctx, agreed.id, { effectiveFrom: day });
      if (draft.existing) {
        return {
          changed: false,
          bookId: agreed.bookId,
          listId: agreed.id,
          skipped: `${agreed.name} has a draft somebody is editing, so the special prices wait until it is published or deleted.`,
        };
      }
      await tx.delete(priceListRates).where(and(eq(priceListRates.priceListId, draft.id), inArray(priceListRates.productId, governed)));
      const fromOverrides = plan.rows.filter((r) => governed.includes(r.productId));
      if (fromOverrides.length) {
        await tx.insert(priceListRates).values(
          fromOverrides.map((r) => ({
            id: gen("plr"),
            priceListId: draft.id,
            productId: r.productId,
            rateExGstPaise: r.rateExGstPaise,
            rateInclGstPaise: r.rateInclGstPaise,
            minCans: r.minCans,
            offered: r.offered,
            matchStatus: "manual" as const,
            updatedById: ctx.user.id,
          })),
        );
      }
      await publishDraftIn(tx, ctx, draft.id, { supersedesId: agreed.id, effectiveFrom: day }, config, day);
      result = { changed: true, bookId: agreed.bookId, listId: draft.id, skipped: null };
    }
    await audit(tx, ctx, {
      action: "pricelist.override.sync",
      entityType: "customer",
      entityId: customerId,
      after: { day, added: plan.added, removed: plan.removed, repriced: plan.repriced, listId: result.listId },
    });
  }

  if (result.bookId) {
    await tx
      .update(priceOverrides)
      .set({ agreedListId: result.bookId, updatedAt: new Date() })
      .where(and(eq(priceOverrides.customerId, customerId), isNull(priceOverrides.agreedListId), sql`${priceOverrides.validFrom} <= ${day}::date`));
    const requestIds = overrides.map((o) => o.requestId).filter((x): x is string => !!x);
    if (requestIds.length) {
      await tx
        .update(priceRequests)
        .set({ resultingListId: result.bookId, updatedAt: new Date() })
        .where(and(inArray(priceRequests.id, requestIds), isNull(priceRequests.resultingListId), eq(priceRequests.status, "approved")));
    }
  }
  return result;
}

/** The same, in a transaction of its own — what an action calls after its own commit. */
export async function syncShopOverrides(customerId: string, day: string, ctx: DeskCtx | null): Promise<SyncResult> {
  return db.transaction((tx) => syncShopOverridesIn(tx, ctx ?? SYSTEM_CTX, customerId, day));
}

/**
 * Every shop whose overrides may have moved: anything not long ended, anything
 * cancelled lately, anything never applied. Idempotent per shop, so a shop with
 * nothing to do costs a few reads. One shop failing never stops the rest.
 */
export async function syncAllOverrides(day: string): Promise<{ shops: number; changed: number; skipped: string[]; failed: string[] }> {
  const rows = await db.execute<{ customerId: string }>(sql`
    select distinct o.customer_id as "customerId" from price_overrides o
     where o.agreed_list_id is null
        or (o.cancelled_at is null and (o.valid_to is null or o.valid_to >= ${addDays(day, -31)}::date))
        or o.cancelled_at >= now() - interval '31 days'
  `);
  let changed = 0;
  const skipped: string[] = [];
  const failed: string[] = [];
  for (const r of rows) {
    try {
      const s = await syncShopOverrides(r.customerId, day, null);
      if (s.changed) changed++;
      if (s.skipped) skipped.push(s.skipped);
    } catch (e) {
      failed.push(`${r.customerId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { shops: rows.length, changed, skipped, failed };
}

/**
 * Overrides ending within `pricing.overrides.reminderDays`, told once: to the
 * Price Desk and to whoever asked for the special price. `reminded_at` is the
 * once; extending an override clears it, so the new end is reminded too.
 */
export async function remindEndingOverrides(day: string): Promise<number> {
  const config = await getConfig();
  const within = config["pricing.overrides.reminderDays"];
  const rows = await db.execute<
    OverrideLike & { remindedAt: string | null; customerId: string; customerName: string; productName: string; requestedById: string | null }
  >(sql`
    select o.id, o.product_id as "productId", o.rate_ex_gst_paise::bigint as "rateExGstPaise",
           o.rate_incl_gst_paise::bigint as "rateInclGstPaise", o.valid_from::text as "validFrom",
           o.valid_to::text as "validTo", ${ISO("o.cancelled_at")} as "cancelledAt", ${ISO("o.created_at")} as "createdAt",
           ${ISO("o.reminded_at")} as "remindedAt", o.customer_id as "customerId", c.name as "customerName",
           p.name as "productName", q.requested_by_id as "requestedById"
      from price_overrides o
      join customers c on c.id = o.customer_id
      join products p on p.id = o.product_id
      left join price_requests q on q.id = o.request_id
     where o.cancelled_at is null and o.reminded_at is null and o.valid_to is not null
       and o.valid_to >= ${day}::date
  `);
  const due = dueForReminder([...rows], day, within);
  if (!due.length) return 0;
  const desk = await priceDeskPeople();
  for (const o of due) {
    const body = `The special price for ${o.customerName} on ${o.productName} ends on ${o.validTo}. Extend it, or let the shop go back to its book price.`;
    const entries = desk.map((d) => ({ userId: d.id, title: "A special price is ending", body, kind: "warn" as const, href: `${d.basePath}/overrides` }));
    if (o.requestedById && !desk.some((d) => d.id === o.requestedById)) {
      entries.push({ userId: o.requestedById, title: "A special price you asked for is ending", body, kind: "warn" as const, href: `/crm/customers/${o.customerId}` });
    }
    await notifyUsers(entries);
    await db.update(priceOverrides).set({ remindedAt: new Date() }).where(eq(priceOverrides.id, o.id));
  }
  return due.length;
}

/* =========================================================================
 * THE FACTS A SPECIAL PRICE IS WEIGHED ON, and what a shop pays.
 *
 * Read the same way when somebody asks and when somebody decides, so the two
 * look at one set of numbers. Every figure is computed here; a model is given
 * these facts to advise on and nothing it says is used as a number.
 * ========================================================================= */

async function agreedListIds(ids: readonly string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await db.execute<{ id: string }>(sql`
    select id from price_lists where kind = 'agreed' and id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
  `);
  return new Set([...rows].map((r) => r.id));
}

type Priced = PricedRow & { listName: string };

/** A shop's rate per product, once from its whole chain and once from its book alone (agreed lists left out). */
async function chainRates(resolution: Resolution | null, productIds: readonly string[]): Promise<Map<string, { pay: Priced; book: Priced | null }>> {
  const out = new Map<string, { pay: Priced; book: Priced | null }>();
  if (!resolution || !productIds.length) return out;
  const ids = resolution.candidates.map((c) => c.listId);
  const agreed = await agreedListIds(ids);
  const rows = await rowsForLists(ids, productIds);
  const bookOnly: Resolution = { ...resolution, candidates: resolution.candidates.filter((c) => !agreed.has(c.listId)) };
  for (const productId of productIds) {
    const pay = chainedRate(resolution, rows, productId);
    if (!pay?.row) continue;
    const book = chainedRate(bookOnly, rows, productId);
    out.set(productId, {
      pay: { ...pay.row, listName: pay.listName },
      book: book?.row ? { ...book.row, listName: book.listName } : null,
    });
  }
  return out;
}

/** The first day after `day` on which any list in the shop's chain has a scheduled revision. */
async function nextScheduledDate(resolution: Resolution | null, day: string): Promise<string | null> {
  if (!resolution?.candidates.length) return null;
  const ids = sql.join(resolution.candidates.map((c) => sql`${c.listId}`), sql`, `);
  const [row] = await db.execute<{ d: string | null }>(sql`
    select min(n.effective_from)::text as d
      from price_lists n
     where n.status = 'published' and n.effective_from > ${day}::date
       and coalesce(n.book_id, n.id) in (select coalesce(l.book_id, l.id) from price_lists l where l.id in (${ids}))
  `);
  return row?.d ?? null;
}

export async function shopProductFacts(customerId: string, productId: string, day: string): Promise<ShopProductFacts | null> {
  const [shop] = await db.execute<{
    name: string;
    city: string;
    cityId: string | null;
    outstanding: string | number;
    slowPayer: boolean;
    creditBlocked: boolean;
    creditLimit: string | number | null;
    overdue: string | number | null;
    daysOverdue: number | null;
    productName: string | null;
  }>(sql`
    select c.name, c.city, c.resolved_city_id as "cityId", c.outstanding, c.slow_payer as "slowPayer",
           c.credit_blocked as "creditBlocked", c.credit_limit_paise as "creditLimit",
           f.total_overdue as overdue, f.days_overdue as "daysOverdue",
           (select p.name from products p where p.id = ${productId}) as "productName"
      from customers c left join follow_up_states f on f.customer_id = c.id
     where c.id = ${customerId}
  `);
  if (!shop || !shop.productName) return null;
  const config = await getConfig();
  const resolution = await resolveForCustomer(customerId, day);
  const rates = await chainRates(resolution, [productId]);
  const here = rates.get(productId) ?? null;

  const scheduledDay = await nextScheduledDate(resolution, day);
  let scheduled: ShopProductFacts["scheduled"] = null;
  if (scheduledDay) {
    const later = await chainRates(await resolveForCustomer(customerId, scheduledDay), [productId]);
    const b = later.get(productId)?.book;
    if (b && (!here?.book || b.rateExGstPaise !== here.book.rateExGstPaise)) {
      scheduled = { date: scheduledDay, ex: b.rateExGstPaise, incl: b.rateInclGstPaise, listName: b.listName };
    }
  }

  const [volume, billed, neighbours, live] = await Promise.all([
    volumeFor([customerId], 6, day),
    billedFor([customerId], [productId], 6, day),
    nearbyRates(customerId, shop.city, shop.cityId, productId, day),
    db.execute<{ ex: string | number; incl: string | number; validTo: string | null }>(sql`
      select o.rate_ex_gst_paise as ex, o.rate_incl_gst_paise as incl, o.valid_to::text as "validTo"
        from price_overrides o
       where o.customer_id = ${customerId} and o.product_id = ${productId} and o.cancelled_at is null
         and o.valid_from <= ${day}::date and (o.valid_to is null or o.valid_to >= ${day}::date)
       order by o.valid_from desc, o.created_at desc limit 1
    `),
  ]);
  const avg = volume.get(productId);
  const b = billed.get(productId) ?? null;
  const sorted = [...neighbours].sort((x, y) => x - y);
  const n = sorted.length;
  const median = n ? (n % 2 ? sorted[(n - 1) / 2] : Math.round((sorted[n / 2 - 1] + sorted[n / 2]) / 2)) : null;
  return {
    customerId,
    customerName: shop.name,
    city: shop.city,
    productId,
    productName: shop.productName,
    gstBp: here?.pay.gstBp ?? config["pricing.gstBp"],
    payToday: here ? { ex: here.pay.rateExGstPaise, incl: here.pay.rateInclGstPaise, listName: here.pay.listName } : null,
    book: here?.book ? { ex: here.book.rateExGstPaise, incl: here.book.rateInclGstPaise, listName: here.book.listName } : null,
    scheduled,
    avgCansPerMonth: avg ? Math.round(avg * 10) / 10 : null,
    billed: b,
    payment: {
      outstandingPaise: Number(shop.outstanding ?? 0),
      overduePaise: Number(shop.overdue ?? 0),
      daysOverdue: Number(shop.daysOverdue ?? 0),
      slowPayer: !!shop.slowPayer,
      creditBlocked: !!shop.creditBlocked,
      creditLimitPaise: shop.creditLimit == null ? null : Number(shop.creditLimit),
    },
    nearby: { shops: n, minEx: sorted[0] ?? null, medianEx: median, maxEx: n ? sorted[n - 1] : null, ratesEx: sorted.slice(0, 300) },
    liveOverride: live[0]
      ? { rateExGstPaise: Number(live[0].ex), rateInclGstPaise: Number(live[0].incl), validTo: live[0].validTo }
      : null,
  };
}

/** What other shops in the same city pay for the product today, ex-GST, as their own chains resolve it. */
async function nearbyRates(customerId: string, city: string, cityId: string | null, productId: string, day: string): Promise<number[]> {
  const near = await db.execute<{ id: string }>(sql`
    select c.id from customers c
     where c.id <> ${customerId} and c.kind = 'customer' and c.status <> 'deactivated'
       and (lower(btrim(c.city)) = lower(btrim(${city}))
            ${cityId ? sql`or c.resolved_city_id = ${cityId}` : sql``})
     limit 300
  `);
  const ids = new Set([...near].map((r) => r.id));
  if (!ids.size) return [];
  const shops = (await shopResolutions(day)).filter((s) => ids.has(s.customerId) && s.resolution);
  const listIds = [...new Set(shops.flatMap((s) => s.resolution!.candidates.map((c) => c.listId)))];
  const rows = await rowsForLists(listIds, [productId]);
  const out: number[] = [];
  for (const s of shops) {
    const r = chainedRate(s.resolution, rows, productId);
    if (r?.row && r.offered) out.push(r.row.rateExGstPaise);
  }
  return out;
}

/* ------------------------------------------------- a request's context */

const adviceSchema = z.object({
  verdict: z.enum(["approve", "counter", "refuse"]),
  priceInclGstPaise: z.number().int().nullable().describe("For approve or counter: the price per can INCLUDING GST, in paise. Null for refuse."),
  months: z.number().int().nullable().describe("How many months the special price should hold before it is looked at again, or null."),
  minCansPerMonth: z.number().int().nullable().describe("A minimum monthly volume to hold it to, or null."),
  reasons: z.array(z.string()).describe("Up to five short reasons, each naming a fact you were given."),
  risk: z.string().nullable().describe("The one thing that could make this a bad decision, or null."),
});

const rupees = (p: number | null | undefined) => (p == null ? "—" : `₹${(p / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`);

function factsLines(f: ShopProductFacts): string[] {
  return [
    `Shop: ${f.customerName}, ${f.city}. Product: ${f.productName}.`,
    `Pays today: ${f.payToday ? `${rupees(f.payToday.incl)} incl GST (${rupees(f.payToday.ex)} ex) from ${f.payToday.listName}` : "no list prices it"}.`,
    `Book price without any special price: ${f.book ? `${rupees(f.book.incl)} incl GST from ${f.book.listName}` : "none"}.`,
    f.scheduled ? `The book is scheduled to change to ${rupees(f.scheduled.incl)} incl GST on ${f.scheduled.date}.` : "No book revision is scheduled.",
    `Average volume, last six whole months: ${f.avgCansPerMonth == null ? "nothing bought" : `${f.avgCansPerMonth} cans a month`}.`,
    f.billed
      ? `Billed over six months: ${f.billed.lines} lines, lowest ${rupees(f.billed.minEx)} ex, median ${rupees(f.billed.medianEx)} ex.`
      : "No billed lines in six months.",
    `Payment: outstanding ${rupees(f.payment.outstandingPaise)}, overdue ${rupees(f.payment.overduePaise)} (${f.payment.daysOverdue} days), slow payer: ${f.payment.slowPayer ? "yes" : "no"}, supply stopped: ${f.payment.creditBlocked ? "yes" : "no"}.`,
    f.nearby.shops
      ? `Other shops in ${f.city} (${f.nearby.shops}) pay, ex-GST: lowest ${rupees(f.nearby.minEx)}, median ${rupees(f.nearby.medianEx)}, highest ${rupees(f.nearby.maxEx)}.`
      : `No other shop in ${f.city} is priced for it.`,
    f.liveOverride
      ? `It already has a special price of ${rupees(f.liveOverride.rateInclGstPaise)} incl GST${f.liveOverride.validTo ? ` until ${f.liveOverride.validTo}` : ""}.`
      : "It has no special price on this product now.",
  ];
}

function adviceFrom(provider: "openai" | "anthropic", ok: boolean, output: unknown, error: string | null, at: string | null): RequestAdvice {
  const parsed = ok ? adviceSchema.safeParse(output) : null;
  const o = parsed?.success ? parsed.data : null;
  return {
    provider,
    label: PROVIDER_LABEL[provider],
    ok: !!o,
    reason: o ? null : (error ?? "No answer."),
    verdict: o?.verdict ?? null,
    priceInclGstPaise: o?.priceInclGstPaise ?? null,
    months: o?.months ?? null,
    minCansPerMonth: o?.minCansPerMonth ?? null,
    reasons: (o?.reasons ?? []).slice(0, 5),
    risk: o?.risk ?? null,
    at,
  };
}

async function storedAdvice(requestId: string): Promise<RequestAdvice[]> {
  const rows = await db.execute<{ provider: "openai" | "anthropic"; ok: boolean; output: unknown; error: string | null; at: string }>(sql`
    select distinct on (r.provider) r.provider, r.ok, r.output, r.error, ${ISO("r.created_at")} as at
      from price_ai_runs r
     where r.subject_kind = 'price_request' and r.subject_id = ${requestId} and r.feature = 'special_price'
     order by r.provider, r.created_at desc
  `);
  return [...rows].map((r) => adviceFrom(r.provider, r.ok, r.output, r.error, r.at));
}

type RequestRow = {
  id: string;
  customerId: string;
  productId: string;
  status: string;
  reason: string;
  requestedEx: string | number;
  requestedById: string;
  requestedByName: string | null;
};

async function requestRow(requestId: string): Promise<RequestRow | null> {
  const [row] = await db.execute<RequestRow>(sql`
    select q.id, q.customer_id as "customerId", q.product_id as "productId", q.status, q.reason,
           q.requested_rate_ex_gst_paise as "requestedEx", q.requested_by_id as "requestedById",
           (select u.name from users u where u.id = q.requested_by_id) as "requestedByName"
      from price_requests q where q.id = ${requestId}
  `);
  return row ?? null;
}

/**
 * Everything the decide drawer shows. `viewer` is who is asking: the person
 * who raised it or the Price Desk — the same visibility `listRequests` keeps.
 * Anybody else is told it does not exist.
 */
export async function requestContext(requestId: string, viewer: { id: string; deskHolder: boolean }): Promise<RequestContext | null> {
  const q = await requestRow(requestId);
  if (!q) return null;
  if (!viewer.deskHolder && q.requestedById !== viewer.id) return null;
  const day = await today();
  const facts = await shopProductFacts(q.customerId, q.productId, day);
  if (!facts) return null;
  const ex = Number(q.requestedEx);
  return {
    requestId: q.id,
    status: q.status,
    reason: q.reason,
    requestedByName: q.requestedByName,
    requestedExGstPaise: ex,
    requestedInclGstPaise: inclFromEx(ex, facts.gstBp),
    facts,
    advice: await storedAdvice(q.id),
    aiReady: await aiReadiness(),
  };
}

/** Both models, asked separately on the same facts. Advice only — kept in `price_ai_runs`, never acted on. */
export async function adviseOnRequest(requestId: string, viewer: { id: string; deskHolder: boolean }): Promise<RequestAdvice[] | null> {
  const ctx = await requestContext(requestId, viewer);
  if (!ctx) return null;
  const f = ctx.facts;
  const months = 3;
  const gap = f.payToday ? f.payToday.ex - ctx.requestedExGstPaise : null;
  const answer = await askBoth({
    feature: "special_price",
    subject: { kind: "price_request", id: requestId },
    userId: viewer.id,
    timeoutSeconds: 45,
    schema: adviceSchema,
    system: [
      "You advise the pricing desk of an Indian paint-thinner maker on one request for a special price.",
      "You do not decide; a person does. Say approve, counter (a different price) or refuse, with reasons.",
      "Use only the facts given. Never invent a volume, a payment record or a competitor price.",
      "Weigh: the volume against the discount, whether the shop pays on time, what other shops in the same city pay, and whether the book is about to change.",
      "Prices are per can, in paise, INCLUDING GST unless stated.",
    ].join("\n"),
    prompt: [
      ...factsLines(f),
      `Asked for: ${rupees(ctx.requestedInclGstPaise)} incl GST (${rupees(ctx.requestedExGstPaise)} ex).`,
      gap != null && f.avgCansPerMonth != null
        ? `At their average volume that gives away ${rupees(Math.max(0, gap) * f.avgCansPerMonth)} a month, ${rupees(Math.max(0, gap) * f.avgCansPerMonth * months)} over ${months} months.`
        : "The give-away cannot be worked out (no volume or no current price).",
      `Why it was asked: ${ctx.reason}`,
    ].join("\n"),
  });
  return (["openai", "anthropic"] as const).map((p) => {
    const a = answer[p];
    return a.ok ? adviceFrom(p, true, a.output, null, new Date().toISOString()) : adviceFrom(p, false, null, a.reason, null);
  });
}

/* ------------------------------------------------- what a shop pays */

const SCOPE_WORDS: Record<string, string> = {
  customer: "names this shop",
  beat: "covers its beat",
  salesman: "covers its salesman's shops",
  city: "covers its city",
  district: "covers its district",
  region: "covers its region",
  state: "covers its state",
  all: "covers every shop",
};

export async function shopPricesView(customerId: string): Promise<ShopPricesView | null> {
  const day = await today();
  const pricing = await customerPricing(customerId, day);
  if (!pricing) return null;
  const resolution = pricing.resolution;
  const productIds = [...new Set(pricing.rates.map((r) => r.productId))];
  const [rates, agreed, overrides] = await Promise.all([
    chainRates(resolution, productIds),
    agreedListIds(resolution?.candidates.map((c) => c.listId) ?? []),
    listOverrides({ customerId }),
  ]);
  const byProduct = new Map<string, RateRow[]>();
  for (const r of pricing.rates) byProduct.set(r.productId, [...(byProduct.get(r.productId) ?? []), r]);

  const rows: ShopPriceRow[] = [];
  for (const [productId, list] of byProduct) {
    const first = list.find((r) => (r.minCans ?? 0) === 0) ?? list[0];
    const chained = rates.get(productId);
    const fromAgreed = !!first.listId && agreed.has(first.listId);
    const live = overrides.find((o) => o.productId === productId && o.state === "live") ?? null;
    const source: ShopPriceSource = fromAgreed ? (live ? "override" : "agreed") : "book";
    rows.push({
      productId,
      productName: first.productName,
      millilitresPerCan: first.millilitresPerCan,
      payEx: first.rateExGstPaise,
      payIncl: first.rateInclGstPaise,
      offered: first.offered,
      source,
      listName: first.listName ?? "",
      bookEx: source === "book" ? null : (chained?.book?.rateExGstPaise ?? null),
      bookIncl: source === "book" ? null : (chained?.book?.rateInclGstPaise ?? null),
      override: live ? { id: live.id, validTo: live.validTo, minCansPerMonth: live.minCansPerMonth } : null,
      slabs: list.length,
    });
  }

  const candidates = resolution?.candidates ?? [];
  const firstBook = candidates.findIndex((c) => !agreed.has(c.listId));
  const chain = candidates.map((c, i) => {
    const isAgreed = agreed.has(c.listId);
    const count = rows.filter((r) => r.listName === c.listName).length;
    const products = `${count} product${count === 1 ? "" : "s"}`;
    const sentence = isAgreed
      ? `${c.listName} holds this shop's own prices (${products}) and sits on top of everything below it.`
      : i === firstBook
        ? `${c.listName} is its book: it ${SCOPE_WORDS[c.kind] ?? "applies to it"}, and prices ${products} here.`
        : `${c.listName} also ${SCOPE_WORDS[c.kind] ?? "applies"}; it prices only what the lists above leave out (${products} here).`;
    return { listId: c.listId, listName: c.listName, agreed: isAgreed, sentence };
  });

  let next: ShopPricesView["next"] = null;
  const nextDay = await nextScheduledDate(resolution, day);
  if (nextDay) {
    const later = await customerPricing(customerId, nextDay);
    const nowFlat = new Map(rows.map((r) => [r.productId, r]));
    const laterFlat = new Map<string, RateRow>();
    for (const r of later?.rates ?? []) if ((r.minCans ?? 0) === 0 && !laterFlat.has(r.productId)) laterFlat.set(r.productId, r);
    const changes: NonNullable<ShopPricesView["next"]>["changes"] = [];
    for (const id of new Set([...nowFlat.keys(), ...laterFlat.keys()])) {
      const a = nowFlat.get(id);
      const b = laterFlat.get(id);
      if ((a?.payIncl ?? null) === (b?.rateInclGstPaise ?? null)) continue;
      changes.push({
        productId: id,
        productName: a?.productName ?? b?.productName ?? id,
        fromIncl: a?.payIncl ?? null,
        toIncl: b?.rateInclGstPaise ?? null,
        listName: b?.listName ?? a?.listName ?? "",
      });
    }
    changes.sort((x, y) => x.productName.localeCompare(y.productName));
    next = { date: nextDay, changes };
  }

  rows.sort((a, b) => (a.millilitresPerCan ?? 0) - (b.millilitresPerCan ?? 0) || a.productName.localeCompare(b.productName));
  const ready = await aiReadiness();
  return {
    customer: { id: pricing.customer.id, name: pricing.customer.name, city: pricing.customer.city, region: pricing.customer.region },
    chain,
    rows,
    next,
    overrides: overrides.filter((o) => o.state === "live" || o.state === "scheduled"),
    answers: await shopAnswers(customerId),
    aiReady: ready.openai || ready.anthropic,
  };
}

const shopAnswerSchema = z.object({
  answer: z.string().describe("A plain answer in two or three sentences."),
  points: z.array(z.string()).describe("Up to four supporting points, each naming a figure from the facts."),
});

async function shopAnswers(customerId: string): Promise<ShopPricesView["answers"]> {
  const rows = await db.execute<{ provider: "openai" | "anthropic"; output: unknown; question: string | null; at: string }>(sql`
    select r.provider, r.output, a.after_state->>'question' as question, ${ISO("r.created_at")} as at
      from price_ai_runs r
      left join audit_log a on a.entity_type = 'price_ai_run' and a.entity_id = r.id
     where r.subject_kind = 'customer' and r.subject_id = ${customerId} and r.feature = 'shop_prices' and r.ok
     order by r.created_at desc limit 5
  `);
  return [...rows].map((r) => {
    const o = shopAnswerSchema.safeParse(r.output);
    return {
      question: r.question ?? "",
      answer: o.success ? [o.data.answer, ...o.data.points.map((p) => `• ${p}`)].join("\n") : "",
      by: PROVIDER_LABEL[r.provider],
      at: r.at,
    };
  });
}

/** One question about a shop's prices, answered from the facts on the screen and nothing else. */
export async function askShopPrices(
  customerId: string,
  question: string,
  userId: string,
): Promise<{ ok: true; answer: string; by: string } | { ok: false; reason: string }> {
  const view = await shopPricesView(customerId);
  if (!view) return { ok: false, reason: "That shop does not exist." };
  const facts = [
    `Shop: ${view.customer.name}, ${view.customer.city}${view.customer.region ? `, ${view.customer.region}` : ""}.`,
    "Why these prices:",
    ...view.chain.map((c) => `- ${c.sentence}`),
    "Product by product (incl GST per can; where it comes from):",
    ...view.rows.map(
      (r) =>
        `- ${r.productName}: ${rupees(r.payIncl)} (${
          r.source === "override"
            ? `special price${r.override?.validTo ? ` until ${r.override.validTo}` : ", no end date"}`
            : r.source === "agreed"
              ? "agreed price typed by hand"
              : r.listName
        })${r.bookIncl != null ? `; book price ${rupees(r.bookIncl)}` : ""}${r.offered ? "" : "; not offered"}`,
    ),
    view.next
      ? `Next scheduled change on ${view.next.date}: ${view.next.changes.map((c) => `${c.productName} ${rupees(c.fromIncl)} → ${rupees(c.toIncl)}`).join("; ") || "nothing for this shop"}.`
      : "No scheduled change.",
    `Special prices: ${
      view.overrides
        .map((o) => `${o.productName} ${rupees(o.rateInclGstPaise)}${o.state === "scheduled" ? ` from ${o.validFrom}` : ""}${o.validTo ? ` until ${o.validTo}` : ""}`)
        .join("; ") || "none"
    }.`,
  ];
  const answer = await askEither({
    feature: "shop_prices",
    subject: { kind: "customer", id: customerId },
    userId,
    timeoutSeconds: 40,
    schema: shopAnswerSchema,
    system: [
      "You explain one shop's prices to the pricing desk of an Indian paint-thinner maker.",
      "Answer ONLY from the facts given. If the facts do not answer the question, say so plainly.",
      "You never change a price and never recommend writing one; you explain.",
    ].join("\n"),
    prompt: [...facts, "", `Question: ${question}`].join("\n"),
  });
  if (!answer.ok) return { ok: false, reason: answer.reason };
  if (answer.runId) {
    await db.execute(sql`
      insert into audit_log (id, actor_id, action, entity_type, entity_id, after_state)
      values (${gen("aud")}, ${userId}, 'pricelist.shop.ask', 'price_ai_run', ${answer.runId},
              ${JSON.stringify({ question, customerId })}::jsonb)
    `);
  }
  return { ok: true, answer: [answer.output.answer, ...answer.output.points.map((p) => `• ${p}`)].join("\n"), by: PROVIDER_LABEL[answer.provider] };
}

/** Who asked for the special prices behind these overrides, by request id. */
export async function askersOf(requestIds: readonly string[]): Promise<Record<string, string>> {
  if (!requestIds.length) return {};
  const rows = await db.execute<{ id: string; name: string | null }>(sql`
    select q.id, u.name from price_requests q left join users u on u.id = q.requested_by_id
     where q.id in (${sql.join(requestIds.map((id) => sql`${id}`), sql`, `)})
  `);
  return Object.fromEntries([...rows].map((r) => [r.id, r.name ?? "—"]));
}
