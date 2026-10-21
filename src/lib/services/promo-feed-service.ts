import "server-only";
import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { customers } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { stageLabel, type LeadStage } from "@/lib/lead-labels";
import {
  PROMO_FACET_LIMIT,
  clampPage,
  shapePromoRecord,
  type PromoFacets,
  type PromoFacetsQuery,
  type PromoFeedQuery,
  type PromoListResult,
  type PromoRecord,
  type PromoScope,
} from "@/lib/promo-feed";
import {
  COUNT,
  DISPLAY_OWNER_ID,
  promoAccountManager,
  promoDistrict,
  promoOrderBy,
  promoOwner,
  promoSalesManager,
  promoState,
  promoWhere,
} from "@/lib/promo-feed-sql";

/* ---------------------------------------------------------------------------
 * Reads the leads and customers the Promotional App may show. READ ONLY: this
 * file only selects (a test reads this source and fails if it ever gains a
 * write). It selects EXPLICIT columns — names and flags — and none of the
 * contact, address, tax, credit, location-fix or note columns on `customers`,
 * so none of them can reach the response.
 *
 * Search, filters, sorting, paging and the total are all done in the database,
 * over every eligible record (see `lib/promo-feed-sql.ts`, which builds the
 * WHERE and ORDER BY and is tested by rendering them).
 *
 * Every record is returned whoever owns it. The owner and the sales manager are
 * joined to be shown as names, and filtered on only when the caller asks.
 *
 * Trash: nothing in the trash is returned, by the list, the total, the facets or
 * a lookup by id. In the CRM only a lead can be trashed (an account that has
 * been billed is deactivated instead), and a deactivated customer is not trash:
 * it is listed with its status.
 * ------------------------------------------------------------------------- */

/** The one columns list every read of a record uses, so a record by id is exactly a record in the list. */
const RECORD_COLUMNS = {
  id: customers.id,
  kind: customers.kind,
  name: customers.name,
  companyName: customers.companyName,
  contactPerson: customers.contactPerson,
  city: customers.city,
  districtName: promoDistrict.name,
  stateName: promoState.name,
  ownerUserName: promoOwner.name,
  amUserName: promoAccountManager.name,
  salesPersonName: customers.salesPersonName,
  smUserName: promoSalesManager.name,
  salesManagerPersonName: customers.salesManagerPersonName,
  createdAt: customers.createdAt,
  leadStage: customers.leadStage,
  status: customers.status,
  leadArchived: customers.leadArchived,
  deletedAt: customers.deletedAt,
  doNotContact: customers.doNotContact,
  whatsappDnd: customers.whatsappDnd,
  leadSource: customers.leadSource,
};

async function sourceLabels(): Promise<Map<string, string>> {
  const config = await getConfig();
  return new Map<string, string>((config["leads.sources"] ?? []).map((s: { code: string; label: string }) => [s.code, s.label]));
}

/** One record by id, under the same rule as the list for the scope (a trashed lead is never there; a lost lead only in the lost scope), or null. */
export async function getPromoRecord(id: string, scope: PromoScope = "active"): Promise<PromoRecord | null> {
  const where = and(promoWhere({ scope, kind: null, q: null, state: null, district: null, city: null, owner: null, salesManager: null, stage: null, status: null }), eq(customers.id, id));
  const [row] = await db
    .select(RECORD_COLUMNS)
    .from(customers)
    .leftJoin(promoOwner, eq(customers.ownerId, promoOwner.id))
    .leftJoin(promoAccountManager, eq(customers.salesAmId, promoAccountManager.id))
    .leftJoin(promoSalesManager, eq(customers.salesManagerId, promoSalesManager.id))
    .leftJoin(promoState, eq(customers.resolvedStateId, promoState.id))
    .leftJoin(promoDistrict, eq(customers.resolvedDistrictId, promoDistrict.id))
    .where(where)
    .limit(1);
  return row ? shapePromoRecord(row, await sourceLabels()) : null;
}

export async function listPromoRecords(query: PromoFeedQuery): Promise<PromoListResult> {
  const where = promoWhere(query);

  const [counted] = await db
    .select({ total: COUNT })
    .from(customers)
    .leftJoin(promoState, eq(customers.resolvedStateId, promoState.id))
    .leftJoin(promoDistrict, eq(customers.resolvedDistrictId, promoDistrict.id))
    .where(where);
  const total = Number(counted?.total ?? 0);
  const { page, pageCount, offset } = clampPage(total, query.page, query.pageSize);

  const rows = await db
    .select(RECORD_COLUMNS)
    .from(customers)
    .leftJoin(promoOwner, eq(customers.ownerId, promoOwner.id))
    .leftJoin(promoAccountManager, eq(customers.salesAmId, promoAccountManager.id))
    .leftJoin(promoSalesManager, eq(customers.salesManagerId, promoSalesManager.id))
    .leftJoin(promoState, eq(customers.resolvedStateId, promoState.id))
    .leftJoin(promoDistrict, eq(customers.resolvedDistrictId, promoDistrict.id))
    .where(where)
    .orderBy(...promoOrderBy(query.sort))
    .limit(query.pageSize)
    .offset(offset);

  const labels = await sourceLabels();
  return { records: rows.map((row) => shapePromoRecord(row, labels)), total, page, pageCount };
}

/** The values the filters can take, over the same eligible records the list covers. */
export async function promoFacets(query: PromoFacetsQuery): Promise<PromoFacets> {
  const where = promoWhere({ scope: query.scope, kind: query.kind, q: null, state: null, district: null, city: null, owner: null, salesManager: null, stage: null, status: null });
  const take = PROMO_FACET_LIMIT + 1;
  const cut = <T>(rows: T[]) => ({ rows: rows.slice(0, PROMO_FACET_LIMIT), truncated: rows.length > PROMO_FACET_LIMIT });

  const [states, districts, cities, owners, managers, stages, statuses] = await Promise.all([
    db
      .select({ id: promoState.id, name: promoState.name, count: COUNT })
      .from(customers)
      .innerJoin(promoState, eq(customers.resolvedStateId, promoState.id))
      .where(where)
      .groupBy(promoState.id, promoState.name)
      .orderBy(asc(promoState.name), asc(promoState.id))
      .limit(take),
    db
      .select({ id: promoDistrict.id, name: promoDistrict.name, stateId: promoDistrict.parentId, count: COUNT })
      .from(customers)
      .innerJoin(promoDistrict, eq(customers.resolvedDistrictId, promoDistrict.id))
      .where(where)
      .groupBy(promoDistrict.id, promoDistrict.name, promoDistrict.parentId)
      .orderBy(asc(promoDistrict.name), asc(promoDistrict.id))
      .limit(take),
    db
      .select({ name: customers.city, count: COUNT })
      .from(customers)
      .where(and(where, isNotNull(customers.city)))
      .groupBy(customers.city)
      .orderBy(desc(COUNT), asc(customers.city))
      .limit(take),
    db
      .select({ id: promoOwner.id, name: promoOwner.name, count: COUNT })
      .from(customers)
      .innerJoin(promoOwner, sql`${promoOwner.id} = ${DISPLAY_OWNER_ID}`)
      .where(where)
      .groupBy(promoOwner.id, promoOwner.name)
      .orderBy(asc(promoOwner.name), asc(promoOwner.id))
      .limit(take),
    db
      .select({ id: promoSalesManager.id, name: promoSalesManager.name, count: COUNT })
      .from(customers)
      .innerJoin(promoSalesManager, eq(customers.salesManagerId, promoSalesManager.id))
      .where(where)
      .groupBy(promoSalesManager.id, promoSalesManager.name)
      .orderBy(asc(promoSalesManager.name), asc(promoSalesManager.id))
      .limit(take),
    db
      .select({ value: customers.leadStage, count: COUNT })
      .from(customers)
      .where(and(where, eq(customers.kind, "lead"), isNotNull(customers.leadStage)))
      .groupBy(customers.leadStage)
      .orderBy(asc(customers.leadStage)),
    db
      .select({ value: customers.status, count: COUNT })
      .from(customers)
      .where(and(where, eq(customers.kind, "customer")))
      .groupBy(customers.status)
      .orderBy(asc(customers.status)),
  ]);

  const s = cut(states);
  const d = cut(districts);
  const c = cut(cities);
  const o = cut(owners);
  const m = cut(managers);
  return {
    states: s.rows.map((r) => ({ id: r.id, name: r.name, count: Number(r.count) })),
    districts: d.rows.map((r) => ({ id: r.id, name: r.name, stateId: r.stateId ?? null, count: Number(r.count) })),
    cities: c.rows.map((r) => ({ name: r.name, count: Number(r.count) })),
    owners: o.rows.map((r) => ({ id: r.id, name: r.name, count: Number(r.count) })),
    salesManagers: m.rows.map((r) => ({ id: r.id, name: r.name, count: Number(r.count) })),
    stages: stages.flatMap((r) => (r.value === null ? [] : [{ value: r.value, label: stageLabel(r.value as LeadStage), count: Number(r.count) }])),
    statuses: statuses.map((r) => ({ value: String(r.value), count: Number(r.count) })),
    truncated: { states: s.truncated, districts: d.truncated, cities: c.truncated, owners: o.truncated, salesManagers: m.truncated },
  };
}
