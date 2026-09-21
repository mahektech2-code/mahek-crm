import "server-only";
import { cache } from "react";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import type {
  PriceDeliveryBasis,
  PriceDerivation,
  PriceDiscountKind,
  PriceDocumentStatus,
  PriceFilenameHints,
  PriceFreightTerm,
  PriceListStatus,
  PriceMatchStatus,
  PriceParsedHeader,
  PriceScopeKind,
} from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { addDays } from "@/lib/business-date";
import { today } from "@/lib/recompute";
import { assertCustomerInScope, resolveScope, userIdsInScope } from "@/lib/access-control";
import { canonicalState } from "@/lib/india-states";
import { inferDerivation, perLitrePaise, rateChange } from "@/lib/engines/price-math";
import {
  placeKey,
  resolvePriceList,
  type CustomerGeo,
  type ListMeta,
  type Resolution,
  type ScopeRow,
} from "@/lib/engines/price-resolution";
import { discountTermSentence, SCOPE_KIND_LABEL } from "@/lib/price-list-labels";
import type {
  Comparison,
  CompareRow,
  CoverageReport,
  CustomerHit,
  CustomerPricing,
  CustomerRates,
  DiscountTermView,
  DocumentView,
  GridColumn,
  ParseGrid,
  ParseRowView,
  PriceListDetail,
  PriceListSummary,
  PricingCounts,
  PricingOptions,
  PlaceOption,
  RateGrid,
  RateRow,
  RequestView,
  ScopeView,
  VarianceReport,
  VarianceRow,
} from "@/lib/price-list-views";

/* ---------------------------------------------------------------------------
 * READING PRICE LISTS — every question a screen asks, in one place.
 *
 * The rules themselves are in `engines/price-math.ts` and
 * `engines/price-resolution.ts` and have no I/O in them; this file is the wire
 * between those and the database, which is the split every other module here
 * keeps. Two consequences worth stating because they are easy to undo:
 *
 * THE RESOLVER RUNS IN MEMORY, NOT IN SQL. "Which list applies to this shop"
 * is a hierarchy with a freight term and a priority in it, and expressing that
 * as a query would be a second copy of the engine written in a language the
 * tests cannot reach. The scopes and the lists are a few hundred rows; they
 * are loaded once per request (`activeScopesAndLists`, cached) and the pure
 * function answers for one customer or for five thousand.
 *
 * A SHOP IS KNOWN BY SEVERAL NAMES. `customers.city` holds whatever the sheet
 * typed and `resolved_city_id` holds what the place master made of it, so the
 * geography a scope matches against carries BOTH — the folded raw text and the
 * resolved place's key. A book whose places have never been resolved still
 * matches on what the sheet said, which is the state prod is in today.
 * ------------------------------------------------------------------------- */

const LIST_LIMIT = 500;

/**
 * Whose book a read is narrowed to, as a fragment.
 *
 * Null means every book — a manager or an admin — and an EMPTY list means
 * nobody, which is a real answer and not the same as "no narrowing". An empty
 * array cannot be bound as a Postgres array without a type it does not have,
 * so the two ends are written out rather than parameterised.
 */
function bookClause(ids: string[] | null) {
  if (ids === null) return sql`true`;
  if (!ids.length) return sql`false`;
  const list = sql.join(ids.map((id) => sql`${id}`), sql`, `);
  return sql`(coalesce(c.sales_am_id, c.owner_id) in (${list}) or c.back_office_am_id in (${list}))`;
}

/* ------------------------------------------------------------------ lists */

type ListRow = {
  id: string;
  refNo: string | null;
  name: string;
  version: number;
  status: PriceListStatus;
  effectiveFrom: string;
  effectiveTo: string | null;
  validityDays: number | null;
  taxBasis: "inclusive" | "exclusive";
  gstBp: number;
  deliveryBasis: PriceDeliveryBasis | null;
  freightTerm: PriceFreightTerm;
  unitBasis: "per_can" | "per_litre";
  parentListId: string | null;
  parentListName: string | null;
  derivation: PriceDerivation | null;
  supersedesId: string | null;
  supersededById: string | null;
  documentId: string | null;
  rateCount: number;
  scopeCount: number;
  scopeParts: Array<{ kind: PriceScopeKind; label: string | null; value: string; freight: string }> | null;
  createdAt: string;
  publishedAt: string | null;
  updatedAt: string;
};

/**
 * The scopes said in words: "Odisha · Paid", "Everybody", "S M Traders".
 *
 * A list nobody has scoped says so rather than printing nothing — an empty
 * cell reads as a screen that failed to load, and "nobody yet" is the single
 * most important thing to know about a list that has just been published.
 */
function scopeSummary(parts: ListRow["scopeParts"]): string {
  if (!parts?.length) return "Nobody yet";
  const words = parts.slice(0, 3).map((p) => {
    const where = p.label ?? p.value;
    const term = p.freight === "any" ? "" : p.freight === "paid" ? " · Paid" : " · To Pay";
    if (p.kind === "everybody") return "Everybody";
    if (p.kind === "customer" || p.kind === "salesman") return `${where}${term}`;
    return `${where}${term}`;
  });
  const more = parts.length - words.length;
  return words.join(", ") + (more > 0 ? ` +${more}` : "");
}

function toSummary(row: ListRow, day: string, defaultValidity: number): PriceListSummary {
  const validity = row.validityDays ?? defaultValidity;
  // A list is valid for its own window from the day it takes effect, and the
  // list that supersedes it ends it sooner. The earlier of the two is what a
  // screen has to say, or a list replaced last week reads as current.
  const byValidity = validity > 0 ? addDays(row.effectiveFrom, validity) : null;
  const expiresOn = row.effectiveTo && (!byValidity || row.effectiveTo < byValidity) ? row.effectiveTo : byValidity;
  return {
    id: row.id,
    refNo: row.refNo,
    name: row.name,
    version: row.version,
    status: row.status,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    validityDays: row.validityDays,
    expiresOn,
    expired: row.status === "published" && expiresOn != null && expiresOn < day,
    taxBasis: row.taxBasis,
    gstBp: row.gstBp,
    deliveryBasis: row.deliveryBasis,
    freightTerm: row.freightTerm,
    unitBasis: row.unitBasis,
    parentListId: row.parentListId,
    parentListName: row.parentListName,
    derivation: row.derivation,
    supersedesId: row.supersedesId,
    supersededById: row.supersededById,
    documentId: row.documentId,
    rateCount: Number(row.rateCount),
    scopeCount: Number(row.scopeCount),
    scopeSummary: scopeSummary(row.scopeParts),
    createdAt: row.createdAt,
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt,
  };
}

const LIST_SELECT = sql`
  select l.id, l.ref_no as "refNo", l.name, l.version, l.status,
         l.effective_from::text as "effectiveFrom",
         l.effective_to::text as "effectiveTo",
         l.validity_days as "validityDays",
         l.tax_basis as "taxBasis", l.gst_bp as "gstBp",
         l.delivery_basis as "deliveryBasis", l.freight_term as "freightTerm",
         l.unit_basis as "unitBasis",
         l.parent_list_id as "parentListId",
         (select p.name from price_lists p where p.id = l.parent_list_id) as "parentListName",
         l.derivation, l.supersedes_id as "supersedesId",
         (select s.id from price_lists s where s.supersedes_id = l.id order by s.effective_from desc limit 1) as "supersededById",
         l.document_id as "documentId",
         (select count(*)::int from price_list_rates r where r.price_list_id = l.id) as "rateCount",
         (select count(*)::int from price_list_scopes sc where sc.price_list_id = l.id) as "scopeCount",
         (select coalesce(json_agg(json_build_object(
                   'kind', sc.scope_kind, 'label', sc.scope_label,
                   'value', sc.scope_value, 'freight', sc.freight_term_match)
                 order by sc.priority desc, sc.scope_kind), '[]'::json)
            from price_list_scopes sc where sc.price_list_id = l.id) as "scopeParts",
         to_char(l.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "createdAt",
         to_char(l.published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "publishedAt",
         to_char(l.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "updatedAt"
    from price_lists l
`;

export async function listPriceLists(filter?: {
  status?: PriceListStatus | "all";
  q?: string;
  freightTerm?: PriceFreightTerm;
}): Promise<PriceListSummary[]> {
  const [config, day] = await Promise.all([getConfig(), today()]);
  const status = filter?.status && filter.status !== "all" ? filter.status : null;
  const q = filter?.q?.trim() ? `%${filter.q.trim()}%` : null;
  const rows = await db.execute<ListRow>(sql`
    ${LIST_SELECT}
    where (${status}::text is null or l.status = ${status})
      and (${q}::text is null or l.name ilike ${q} or l.ref_no ilike ${q})
      and (${filter?.freightTerm ?? null}::text is null or l.freight_term = ${filter?.freightTerm ?? null})
    order by (l.status = 'published') desc, l.effective_from desc, l.name asc, l.id desc
    limit ${LIST_LIMIT}
  `);
  return [...rows].map((r) => toSummary(r, day, config["pricing.defaultValidityDays"]));
}

/* ------------------------------------------------------------------ rates */

const RATE_SELECT = sql`
  select r.id, r.product_id as "productId", p.name as "productName",
         b.name as "brandName", f.name as "formulationName",
         p.millilitres_per_can as "millilitresPerCan", p.cans_per_box as "cansPerBox",
         p.packing, p.active as "productActive",
         r.rate_ex_gst_paise as "rateExGstPaise", r.rate_incl_gst_paise as "rateInclGstPaise",
         r.min_cans as "minCans", r.max_cans as "maxCans", r.offered,
         r.raw_product_text as "rawProductText", r.raw_pack_text as "rawPackText",
         r.raw_price_text as "rawPriceText",
         r.match_status as "matchStatus", r.match_confidence as "matchConfidence",
         to_char(r.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "updatedAt"
    from price_list_rates r
    join products p on p.id = r.product_id
    left join product_brands b on b.id = p.brand_id
    left join product_formulations f on f.id = p.formulation_id
`;

type RawRate = Omit<RateRow, "perLitrePaise">;

function withPerLitre(row: RawRate): RateRow {
  return { ...row, perLitrePaise: perLitrePaise(Number(row.rateExGstPaise), row.millilitresPerCan) };
}

/**
 * The grid a list is READ as: product families down, pack configurations
 * across, exactly as the PDF prints it.
 *
 * Families are the brand line rather than the SKU, because "Nano Thinner"
 * across six pack sizes is one row on paper and six rows in the catalogue,
 * and a manager checking a list against the document needs the shape they are
 * holding. A cell with no rate is empty; a cell whose rate says `offered:
 * false` is the document's dash, and the two are different facts.
 */
function buildGrid(rates: RateRow[]): RateGrid {
  const columns = new Map<string, GridColumn>();
  for (const r of rates) {
    const key = `${r.millilitresPerCan ?? "?"}|${r.cansPerBox ?? "?"}|${r.packing ?? ""}`;
    if (!columns.has(key)) {
      const litres = r.millilitresPerCan == null ? "?" : r.millilitresPerCan >= 1000 ? `${r.millilitresPerCan / 1000} L` : `${r.millilitresPerCan} ml`;
      columns.set(key, {
        key,
        label: `${litres}${r.packing ? ` · ${r.packing}` : ""}`,
        millilitres: r.millilitresPerCan,
        cansPerBox: r.cansPerBox,
        packing: r.packing,
      });
    }
  }
  const ordered = [...columns.values()].sort(
    (a, b) => (a.millilitres ?? 0) - (b.millilitres ?? 0) || (b.cansPerBox ?? 0) - (a.cansPerBox ?? 0),
  );

  const families = new Map<string, { family: string; familyKey: string; byColumn: Map<string, RateRow> }>();
  for (const r of rates) {
    const family = r.brandName ?? (r.productName.includes(" - ") ? r.productName.slice(0, r.productName.indexOf(" - ")) : r.productName);
    const familyKey = family.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!families.has(familyKey)) families.set(familyKey, { family, familyKey, byColumn: new Map() });
    const key = `${r.millilitresPerCan ?? "?"}|${r.cansPerBox ?? "?"}|${r.packing ?? ""}`;
    // A slabbed SKU shows its base rate in the grid; the table view has them all.
    const existing = families.get(familyKey)!.byColumn.get(key);
    if (!existing || (r.minCans ?? 0) < (existing.minCans ?? 0)) families.get(familyKey)!.byColumn.set(key, r);
  }

  return {
    columns: ordered,
    rows: [...families.values()]
      .sort((a, b) => a.family.localeCompare(b.family))
      .map((f) => ({
        family: f.family,
        familyKey: f.familyKey,
        cells: ordered.map((column) => ({ column, rate: f.byColumn.get(column.key) ?? null })),
      })),
  };
}

/* ----------------------------------------------------------------- detail */

export async function priceListDetail(id: string): Promise<PriceListDetail | null> {
  const [config, day] = await Promise.all([getConfig(), today()]);
  const [row] = await db.execute<
    ListRow & {
      termsText: string | null;
      signatory: string | null;
      notes: string | null;
      freightPerLitrePaise: number | null;
      withdrawReason: string | null;
      publishedByName: string | null;
      createdByName: string | null;
    }
  >(sql`
    select l.id, l.ref_no as "refNo", l.name, l.version, l.status,
           l.effective_from::text as "effectiveFrom", l.effective_to::text as "effectiveTo",
           l.validity_days as "validityDays", l.tax_basis as "taxBasis", l.gst_bp as "gstBp",
           l.delivery_basis as "deliveryBasis", l.freight_term as "freightTerm",
           l.unit_basis as "unitBasis", l.parent_list_id as "parentListId",
           (select p.name from price_lists p where p.id = l.parent_list_id) as "parentListName",
           l.derivation, l.supersedes_id as "supersedesId",
           (select s.id from price_lists s where s.supersedes_id = l.id order by s.effective_from desc limit 1) as "supersededById",
           l.document_id as "documentId",
           (select count(*)::int from price_list_rates r where r.price_list_id = l.id) as "rateCount",
           (select count(*)::int from price_list_scopes sc where sc.price_list_id = l.id) as "scopeCount",
           (select coalesce(json_agg(json_build_object(
                     'kind', sc.scope_kind, 'label', sc.scope_label,
                     'value', sc.scope_value, 'freight', sc.freight_term_match)
                   order by sc.priority desc, sc.scope_kind), '[]'::json)
              from price_list_scopes sc where sc.price_list_id = l.id) as "scopeParts",
           to_char(l.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "createdAt",
           to_char(l.published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "publishedAt",
           to_char(l.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "updatedAt",
           l.terms_text as "termsText", l.signatory, l.notes,
           l.freight_per_litre_paise as "freightPerLitrePaise",
           l.withdraw_reason as "withdrawReason",
           (select u.name from users u where u.id = l.published_by_id) as "publishedByName",
           (select u.name from users u where u.id = l.created_by_id) as "createdByName"
      from price_lists l
     where l.id = ${id}
  `);
  if (!row) return null;

  const [rateRows, scopeRows, termRows, versionRows, childRows] = await Promise.all([
    db.execute<RawRate>(sql`${RATE_SELECT} where r.price_list_id = ${id}
      order by p.millilitres_per_can asc nulls last, p.name asc, r.min_cans asc nulls first`),
    db.execute<
      Omit<ScopeView, "customersMatched"> & { parentLabel: string | null }
    >(sql`
      select sc.id, sc.scope_kind as "scopeKind", sc.scope_value as "scopeValue",
             sc.scope_label as "scopeLabel", sc.parent_key as "parentKey",
             null::text as "parentLabel",
             sc.freight_term_match as "freightTermMatch", sc.priority,
             sc.valid_from::text as "validFrom", sc.valid_to::text as "validTo"
        from price_list_scopes sc
       where sc.price_list_id = ${id}
       order by sc.priority desc, sc.scope_kind asc, sc.id asc
    `),
    db.execute<Omit<DiscountTermView, "sentence">>(sql`
      select t.id, t.kind, t.percent_bp as "percentBp",
             t.threshold_litres as "thresholdLitres", t.threshold_paise as "thresholdPaise",
             t.raw_text as "rawText"
        from price_list_discount_terms t
       where t.price_list_id = ${id}
       order by t.kind asc, t.percent_bp desc
    `),
    db.execute<{ id: string; version: number; status: PriceListStatus; effectiveFrom: string; effectiveTo: string | null; name: string }>(sql`
      with recursive chain as (
        select v.id, v.version, v.status, v.effective_from, v.effective_to, v.name, v.supersedes_id
          from price_lists v where v.id = ${id}
        union
        select o.id, o.version, o.status, o.effective_from, o.effective_to, o.name, o.supersedes_id
          from price_lists o join chain c on o.id = c.supersedes_id or o.supersedes_id = c.id
      )
      select chain.id, chain.version, chain.status,
             chain.effective_from::text as "effectiveFrom",
             chain.effective_to::text as "effectiveTo", chain.name
        from chain order by chain.effective_from desc, chain.version desc
    `),
    db.execute<{ id: string; name: string; status: PriceListStatus; derivation: PriceDerivation | null }>(sql`
      select c.id, c.name, c.status, c.derivation from price_lists c
       where c.parent_list_id = ${id} order by c.name asc
    `),
  ]);

  const rates = [...rateRows].map(withPerLitre);
  const scopes = await withCustomerCounts([...scopeRows]);
  const document = row.documentId ? await documentView(row.documentId) : null;

  return {
    list: {
      ...toSummary(row, day, config["pricing.defaultValidityDays"]),
      termsText: row.termsText,
      signatory: row.signatory,
      notes: row.notes,
      freightPerLitrePaise: row.freightPerLitrePaise == null ? null : Number(row.freightPerLitrePaise),
      withdrawReason: row.withdrawReason,
      publishedByName: row.publishedByName,
      createdByName: row.createdByName,
    },
    rates,
    grid: buildGrid(rates),
    scopes,
    discountTerms: [...termRows].map((t) => ({ ...t, sentence: discountTermSentence(t) })),
    document,
    versions: [...versionRows],
    children: [...childRows],
    parent: row.parentListId && row.parentListName ? { id: row.parentListId, name: row.parentListName } : null,
  };
}

/**
 * How many shops each scope row actually names.
 *
 * The number nobody can work out from the screen and everybody wants: a city
 * scope that matches four shops is probably the wrong spelling of the city.
 * Counted against the same keys the resolver matches on, not against a
 * prettier version of them.
 */
async function withCustomerCounts(rows: Array<Omit<ScopeView, "customersMatched"> & { parentLabel: string | null }>): Promise<ScopeView[]> {
  if (!rows.length) return [];
  const book = await bookGeography();
  const scopes: ScopeRow[] = rows.map((r) => ({
    id: r.id,
    priceListId: "x",
    scopeKind: r.scopeKind,
    scopeValue: r.scopeValue,
    parentKey: r.parentKey,
    freightTermMatch: r.freightTermMatch,
    priority: r.priority,
    validFrom: r.validFrom,
    validTo: r.validTo,
    scopeLabel: r.scopeLabel,
  }));
  const counts = new Map<string, number>();
  for (const geo of book) {
    for (const s of scopes) {
      if (namesCustomer(s, geo)) counts.set(s.id, (counts.get(s.id) ?? 0) + 1);
    }
  }
  return rows.map((r) => ({ ...r, customersMatched: counts.get(r.id) ?? 0 }));
}

/** The engine's own matching, asked about one scope rather than a whole list. */
function namesCustomer(scope: ScopeRow, geo: CustomerGeo): boolean {
  const single = resolvePriceList(
    geo,
    [scope],
    [
      {
        id: "x",
        name: "x",
        status: "published",
        effectiveFrom: "1970-01-01",
        effectiveTo: null,
        freightTerm: "not_stated",
        version: 1,
      },
    ],
    "9999-12-31",
  );
  return single != null;
}

/* ------------------------------------------------------------- documents */

const DOCUMENT_SELECT = sql`
  select d.id, d.filename, d.source_kind as "sourceKind", d.byte_size as "byteSize",
         d.page_count as "pageCount", d.parse_status as "parseStatus",
         d.stage_note as "stageNote",
         to_char(d.stage_started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "stageStartedAt",
         d.confidence, d.layout, d.header, d.problems,
         d.filename_hints as "filenameHints", d.attachment_id as "attachmentId",
         d.price_list_id as "priceListId",
         (select l.name from price_lists l where l.id = d.price_list_id) as "priceListName",
         (select u.name from users u where u.id = d.uploaded_by_id) as "uploadedByName",
         to_char(d.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "createdAt",
         to_char(d.parsed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "parsedAt",
         to_char(d.published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "publishedAt",
         d.reject_reason as "rejectReason",
         (select count(*)::int from price_list_parse_rows r where r.document_id = d.id) as "rowCount",
         (select count(*)::int from price_list_parse_rows r
           where r.document_id = d.id and r.match_status in ('matched','alias','manual')) as "matchedCount",
         (select count(*)::int from price_list_parse_rows r
           where r.document_id = d.id and r.match_status = 'suggested') as "suggestedCount",
         (select count(*)::int from price_list_parse_rows r
           where r.document_id = d.id and r.match_status = 'held') as "heldCount",
         (select count(*)::int from price_list_parse_rows r
           where r.document_id = d.id and r.match_status = 'skipped') as "skippedCount"
    from price_list_documents d
`;

export async function listDocuments(filter?: { view?: "waiting" | "all" }): Promise<DocumentView[]> {
  const waiting = (filter?.view ?? "waiting") === "waiting";
  const rows = await db.execute<DocumentView>(sql`
    ${DOCUMENT_SELECT}
    where (${!waiting}::boolean or d.parse_status not in ('published','rejected'))
    order by d.created_at desc, d.id desc
    limit 200
  `);
  return [...rows];
}

async function documentView(id: string): Promise<DocumentView | null> {
  const [row] = await db.execute<DocumentView>(sql`${DOCUMENT_SELECT} where d.id = ${id}`);
  return row ?? null;
}

export async function documentDetail(
  id: string,
): Promise<{ document: DocumentView; rows: ParseRowView[]; grid: ParseGrid } | null> {
  const document = await documentView(id);
  if (!document) return null;

  const rows = await db.execute<ParseRowView>(sql`
    select r.id, r.page, r.row_index as "rowIndex", r.col_index as "colIndex",
           r.raw_product_text as "rawProductText", r.raw_pack_text as "rawPackText",
           r.raw_price_text as "rawPriceText", r.millilitres, r.cans_per_box as "cansPerBox",
           r.container, r.rate_incl_gst_paise as "rateInclGstPaise",
           r.rate_ex_gst_paise as "rateExGstPaise", r.offered,
           r.matched_product_id as "matchedProductId",
           (select p.name from products p where p.id = r.matched_product_id) as "matchedProductName",
           r.match_status as "matchStatus", r.match_confidence as "matchConfidence",
           r.candidates, r.problem,
           to_char(r.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "decidedAt"
      from price_list_parse_rows r
     where r.document_id = ${id}
     order by r.row_index asc, r.col_index asc
  `);

  const all = [...rows];
  const columns = new Map<number, string>();
  for (const r of all) if (!columns.has(r.colIndex)) columns.set(r.colIndex, r.rawPackText ?? `Column ${r.colIndex + 1}`);
  const byRow = new Map<number, ParseRowView[]>();
  for (const r of all) byRow.set(r.rowIndex, [...(byRow.get(r.rowIndex) ?? []), r]);

  return {
    document,
    rows: all,
    grid: {
      columns: [...columns.entries()].sort((a, b) => a[0] - b[0]).map(([colIndex, label]) => ({ colIndex, label })),
      rows: [...byRow.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([rowIndex, cells]) => ({
          rowIndex,
          rawProductText: cells[0]?.rawProductText ?? "",
          cells: cells.sort((a, b) => a.colIndex - b.colIndex),
        })),
    },
  };
}

/* -------------------------------------------------------------- resolving */

/**
 * Every published list and every scope row, once per request.
 *
 * Cached because the resolver needs the whole picture to answer about ONE
 * customer, and the customer record, the order form and the coverage report
 * all ask within a single render.
 */
export const activeScopesAndLists = cache(async function activeScopesAndLists(): Promise<{
  scopes: ScopeRow[];
  lists: ListMeta[];
}> {
  const [scopeRows, listRows] = await Promise.all([
    db.execute<ScopeRow>(sql`
      select sc.id, sc.price_list_id as "priceListId", sc.scope_kind as "scopeKind",
             sc.scope_value as "scopeValue", sc.scope_label as "scopeLabel",
             sc.parent_key as "parentKey", sc.freight_term_match as "freightTermMatch",
             sc.priority, sc.valid_from::text as "validFrom", sc.valid_to::text as "validTo"
        from price_list_scopes sc
        join price_lists l on l.id = sc.price_list_id
       where l.status = 'published'
    `),
    db.execute<ListMeta>(sql`
      select l.id, l.name, l.status, l.effective_from::text as "effectiveFrom",
             l.effective_to::text as "effectiveTo", l.freight_term as "freightTerm", l.version
        from price_lists l
       where l.status = 'published'
    `),
  ]);
  return { scopes: [...scopeRows], lists: [...listRows] };
});

type GeoRow = {
  customerId: string;
  salesAmId: string | null;
  ownerId: string | null;
  city: string | null;
  area: string | null;
  beat: string | null;
  region: string | null;
  territoryRegion: string | null;
  resolvedState: string | null;
  resolvedDistrict: string | null;
  resolvedCity: string | null;
  resolvedArea: string | null;
  customerType: string | null;
  freightTerm: string | null;
};

/** Every spelling a shop can be matched by, folded to keys. */
function toGeo(row: GeoRow): CustomerGeo {
  const keys = (...values: Array<string | null>) =>
    [...new Set(values.map((v) => placeKey(v)).filter((v) => v !== ""))];
  return {
    customerId: row.customerId,
    salesmanIds: [row.salesAmId, row.ownerId].filter((v): v is string => !!v),
    beatKeys: keys(row.beat),
    areaKeys: keys(row.area, row.resolvedArea),
    cityKeys: keys(row.city, row.resolvedCity),
    districtKeys: keys(row.resolvedDistrict, row.territoryRegion),
    // The sheet writes a state into `region` and spells it several ways;
    // `canonicalState` folds those together, and the raw text is kept beside
    // it so a scope written from the sheet's own spelling still matches.
    stateKeys: keys(row.region, canonicalState(row.region), row.resolvedState, row.territoryRegion),
    customerType: row.customerType,
    freightTerm: row.freightTerm === "paid" || row.freightTerm === "to_pay" ? row.freightTerm : null,
  };
}

const GEO_SELECT = sql`
  select c.id as "customerId", c.sales_am_id as "salesAmId", c.owner_id as "ownerId",
         c.city, c.area, c.beat, c.region, c.territory_region as "territoryRegion",
         (select p.name from places p where p.id = c.resolved_state_id) as "resolvedState",
         (select p.name from places p where p.id = c.resolved_district_id) as "resolvedDistrict",
         (select p.name from places p where p.id = c.resolved_city_id) as "resolvedCity",
         (select p.name from places p where p.id = c.resolved_area_id) as "resolvedArea",
         c.customer_type::text as "customerType", c.freight_term as "freightTerm"
    from customers c
`;

export async function customerGeo(customerId: string): Promise<CustomerGeo | null> {
  const [row] = await db.execute<GeoRow>(sql`${GEO_SELECT} where c.id = ${customerId}`);
  return row ? toGeo(row) : null;
}

/** The whole book's geography, for the reports that resolve every shop. */
async function bookGeography(): Promise<CustomerGeo[]> {
  const ids = await userIdsInScope();
  const rows = await db.execute<GeoRow>(sql`
    ${GEO_SELECT}
    where c.kind = 'customer' and c.status <> 'deactivated' and ${bookClause(ids)}
  `);
  return [...rows].map(toGeo);
}

export async function resolveForCustomer(customerId: string, todayIso: string): Promise<Resolution | null> {
  const [geo, { scopes, lists }] = await Promise.all([customerGeo(customerId), activeScopesAndLists()]);
  if (!geo) return null;
  return resolvePriceList(geo, scopes, lists, todayIso);
}

/* ------------------------------------------------------- one customer */

export async function customerPricing(customerId: string, todayIso: string): Promise<CustomerPricing | null> {
  const [row] = await db.execute<{
    id: string;
    name: string;
    city: string;
    region: string | null;
    freightTerm: string | null;
    priceTag: string | null;
    salesmanName: string | null;
    kind: "lead" | "customer";
    salesAmId: string | null;
    ownerId: string | null;
    backOfficeAmId: string | null;
  }>(sql`
    select c.id, c.name, c.city, c.region, c.freight_term as "freightTerm",
           c.price_tag as "priceTag", c.kind,
           coalesce(c.sales_person_name, (select u.name from users u where u.id = c.sales_am_id)) as "salesmanName",
           c.sales_am_id as "salesAmId", c.owner_id as "ownerId", c.back_office_am_id as "backOfficeAmId"
      from customers c where c.id = ${customerId}
  `);
  if (!row) return null;
  await assertCustomerInScope({
    id: row.id,
    kind: row.kind,
    ownerId: row.ownerId,
    salesAmId: row.salesAmId,
    backOfficeAmId: row.backOfficeAmId,
  } as never);

  const [config, day, resolution] = await Promise.all([
    getConfig(),
    today(),
    resolveForCustomer(customerId, todayIso),
  ]);

  const list = resolution ? (await listById(resolution.listId, day, config["pricing.defaultValidityDays"])) : null;
  const rates = resolution ? await ratesOfList(resolution.listId) : [];
  const discountTerms = resolution
    ? [...(await db.execute<Omit<DiscountTermView, "sentence">>(sql`
        select t.id, t.kind, t.percent_bp as "percentBp", t.threshold_litres as "thresholdLitres",
               t.threshold_paise as "thresholdPaise", t.raw_text as "rawText"
          from price_list_discount_terms t where t.price_list_id = ${resolution.listId}
      `))].map((t) => ({ ...t, sentence: discountTermSentence(t) }))
    : [];

  const [lastOrder] = await db.execute<{ listId: string | null; listName: string | null; orderedAt: string }>(sql`
    select o.price_list_id as "listId",
           (select l.name from price_lists l where l.id = o.price_list_id) as "listName",
           o.ordered_at::text as "orderedAt"
      from orders o
     where o.customer_id = ${customerId}
     order by o.ordered_at desc, o.id desc limit 1
  `);

  return {
    customer: {
      id: row.id,
      name: row.name,
      city: row.city,
      region: row.region,
      freightTerm: row.freightTerm === "paid" || row.freightTerm === "to_pay" ? row.freightTerm : null,
      priceTag: row.priceTag,
      salesmanName: row.salesmanName,
      kind: row.kind,
    },
    resolution,
    list,
    rates,
    grid: rates.length ? buildGrid(rates) : null,
    discountTerms,
    lastOrder: lastOrder ?? null,
    // Their last order was priced off a different list. The telecaller has to
    // say so before the customer finds out from the invoice.
    listChangedSinceLastOrder: !!(lastOrder?.listId && resolution && lastOrder.listId !== resolution.listId),
    pendingRequests: await listRequests({ status: "pending", customerId }),
  };
}

async function listById(id: string, day: string, defaultValidity: number): Promise<PriceListSummary | null> {
  const [row] = await db.execute<ListRow>(sql`${LIST_SELECT} where l.id = ${id}`);
  return row ? toSummary(row, day, defaultValidity) : null;
}

async function ratesOfList(listId: string): Promise<RateRow[]> {
  const rows = await db.execute<RawRate>(sql`
    ${RATE_SELECT} where r.price_list_id = ${listId}
    order by p.millilitres_per_can asc nulls last, p.name asc, r.min_cans asc nulls first
  `);
  return [...rows].map(withPerLitre);
}

/**
 * What this shop pays for these products, for an order form.
 *
 * Keyed by product so a cart can be priced in one lookup. An empty answer is
 * the honest one where no list resolves — the form then shows quantities and
 * no money, which is what it did before price lists existed.
 */
export async function ratesForCustomer(
  customerId: string,
  productIds: string[],
  todayIso: string,
): Promise<CustomerRates> {
  if (!productIds.length) return {};
  const resolution = await resolveForCustomer(customerId, todayIso);
  if (!resolution) return {};
  const rows = await db.execute<{
    productId: string;
    rateExGstPaise: number;
    rateInclGstPaise: number;
    gstBp: number;
    offered: boolean;
  }>(sql`
    select r.product_id as "productId", r.rate_ex_gst_paise as "rateExGstPaise",
           r.rate_incl_gst_paise as "rateInclGstPaise", l.gst_bp as "gstBp", r.offered
      from price_list_rates r
      join price_lists l on l.id = r.price_list_id
     where r.price_list_id = ${resolution.listId}
       and r.product_id in (${sql.join(productIds.map((id) => sql`${id}`), sql`, `)})
       and r.min_cans is null
  `);
  const out: CustomerRates = {};
  for (const r of rows) {
    out[r.productId] = {
      listId: resolution.listId,
      listName: resolution.listName,
      rateExGstPaise: Number(r.rateExGstPaise),
      rateInclGstPaise: Number(r.rateInclGstPaise),
      gstBp: Number(r.gstBp),
      offered: r.offered,
    };
  }
  return out;
}

/* ------------------------------------------------------------- comparing */

export async function compareLists(aId: string, bId: string): Promise<Comparison | null> {
  const [config, day] = await Promise.all([getConfig(), today()]);
  const [a, b] = await Promise.all([
    listById(aId, day, config["pricing.defaultValidityDays"]),
    listById(bId, day, config["pricing.defaultValidityDays"]),
  ]);
  if (!a || !b) return null;

  const [aRates, bRates] = await Promise.all([ratesOfList(aId), ratesOfList(bId)]);
  const byProduct = new Map<string, CompareRow>();
  for (const r of aRates) {
    if (r.minCans != null) continue;
    byProduct.set(r.productId, {
      productId: r.productId,
      productName: r.productName,
      millilitresPerCan: r.millilitresPerCan,
      cansPerBox: r.cansPerBox,
      aEx: Number(r.rateExGstPaise),
      bEx: null,
      aIncl: Number(r.rateInclGstPaise),
      bIncl: null,
      deltaPaise: null,
      deltaBp: null,
    });
  }
  for (const r of bRates) {
    if (r.minCans != null) continue;
    const existing = byProduct.get(r.productId);
    if (existing) {
      existing.bEx = Number(r.rateExGstPaise);
      existing.bIncl = Number(r.rateInclGstPaise);
    } else {
      byProduct.set(r.productId, {
        productId: r.productId,
        productName: r.productName,
        millilitresPerCan: r.millilitresPerCan,
        cansPerBox: r.cansPerBox,
        aEx: null,
        bEx: Number(r.rateExGstPaise),
        aIncl: null,
        bIncl: Number(r.rateInclGstPaise),
        deltaPaise: null,
        deltaBp: null,
      });
    }
  }

  const rows = [...byProduct.values()].map((r) => ({ ...r, ...rateChange(r.aEx, r.bEx) }));
  rows.sort((x, y) => (x.deltaBp ?? 0) - (y.deltaBp ?? 0) || x.productName.localeCompare(y.productName));

  const moved = rows.filter((r) => r.deltaBp != null && r.deltaBp !== 0);
  const deltas = moved.map((r) => r.deltaBp!).sort((p, q) => p - q);

  return {
    a,
    b,
    rows,
    summary: {
      changed: moved.length,
      up: moved.filter((r) => (r.deltaBp ?? 0) > 0).length,
      down: moved.filter((r) => (r.deltaBp ?? 0) < 0).length,
      onlyInA: rows.filter((r) => r.aEx != null && r.bEx == null).length,
      onlyInB: rows.filter((r) => r.bEx != null && r.aEx == null).length,
      medianDeltaBp: deltas.length ? deltas[Math.floor(deltas.length / 2)] : null,
    },
    // What rule would turn A into B, where one would. It is what makes "this
    // month is last month plus twelve rupees a litre" a thing somebody can
    // see rather than work out with a calculator on ten rows.
    inferredDerivation: inferDerivation(
      rows
        .filter((r) => r.aEx != null && r.bEx != null)
        .map((r) => ({ parentExPaise: r.aEx!, childExPaise: r.bEx!, millilitresPerCan: r.millilitresPerCan })),
    ),
  };
}

/* ------------------------------------------------------------- coverage */

export async function coverageReport(todayIso: string): Promise<CoverageReport> {
  const [config, day, { scopes, lists }] = await Promise.all([getConfig(), today(), activeScopesAndLists()]);
  const ids = await userIdsInScope();
  const rows = await db.execute<GeoRow & { name: string; salesmanName: string | null }>(sql`
    select c.id as "customerId", c.sales_am_id as "salesAmId", c.owner_id as "ownerId",
           c.city, c.area, c.beat, c.region, c.territory_region as "territoryRegion",
           (select p.name from places p where p.id = c.resolved_state_id) as "resolvedState",
           (select p.name from places p where p.id = c.resolved_district_id) as "resolvedDistrict",
           (select p.name from places p where p.id = c.resolved_city_id) as "resolvedCity",
           (select p.name from places p where p.id = c.resolved_area_id) as "resolvedArea",
           c.customer_type::text as "customerType", c.freight_term as "freightTerm",
           c.name,
           coalesce(c.sales_person_name, (select u.name from users u where u.id = c.sales_am_id)) as "salesmanName"
      from customers c
     where c.kind = 'customer' and c.status <> 'deactivated' and ${bookClause(ids)}
     order by c.name asc
  `);

  const perList = new Map<string, number>();
  const unresolved: CoverageReport["unresolvedCustomers"] = [];
  let resolved = 0;
  let noFreightTerm = 0;

  for (const row of rows) {
    const geo = toGeo(row);
    if (geo.freightTerm == null) noFreightTerm++;
    const r = resolvePriceList(geo, scopes, lists, todayIso);
    if (r) {
      resolved++;
      perList.set(r.listId, (perList.get(r.listId) ?? 0) + 1);
    } else if (unresolved.length < 200) {
      unresolved.push({
        id: row.customerId,
        name: row.name,
        city: row.city ?? "",
        region: row.region,
        freightTerm: row.freightTerm,
        salesmanName: row.salesmanName,
      });
    }
  }

  const listRows = await db.execute<ListRow>(sql`${LIST_SELECT} where l.status = 'published'`);
  const summaries = [...listRows].map((l) => toSummary(l, day, config["pricing.defaultValidityDays"]));

  return {
    customersConsidered: rows.length,
    resolved,
    unresolved: rows.length - resolved,
    noFreightTerm,
    unresolvedCustomers: unresolved,
    perList: summaries
      .map((l) => ({ listId: l.id, name: l.name, status: l.status, customers: perList.get(l.id) ?? 0 }))
      .sort((a, b) => b.customers - a.customers || a.name.localeCompare(b.name)),
    listsWithNobody: summaries.filter((l) => !perList.get(l.id)),
  };
}

/* ------------------------------------------------------------- variance */

/**
 * What was BILLED against what the list says, off the order sheet.
 *
 * The sheet's Rate is ex-GST per can, which is the same figure a list stores,
 * so the two are comparable without converting anything. Each row is resolved
 * as of its own order date, because a list published since would otherwise
 * make last month look like a month of discounting.
 */
export async function varianceReport(month: string): Promise<VarianceReport> {
  const { scopes, lists } = await activeScopesAndLists();
  const from = `${month}-01`;
  const to = addDays(`${month}-01`, 31).slice(0, 8) + "01";

  const rows = await db.execute<{
    orderDate: string;
    orderNumber: string | null;
    customerId: string | null;
    customerName: string;
    productId: string | null;
    productName: string;
    cans: number | null;
    billedExPaise: number;
    sheetDiscountBp: number | null;
  }>(sql`
    select o.order_date::text as "orderDate", o.order_number as "orderNumber",
           o.matched_customer_id as "customerId",
           coalesce(c.name, o.billing_party_name, 'Unknown') as "customerName",
           o.matched_product_id as "productId",
           coalesce(p.name, o.description, 'Unknown') as "productName",
           o.cans, o.rate_paise as "billedExPaise", o.discount_bp as "sheetDiscountBp"
      from sheet_order_rows o
      left join customers c on c.id = o.matched_customer_id
      left join products p on p.id = o.matched_product_id
     where o.status = 'present'
       and o.rate_paise is not null
       and o.order_date >= ${from}::date and o.order_date < ${to}::date
     order by o.order_date asc, o.id asc
     limit 2000
  `);

  // One resolution per customer per date, not per line: a twelve-line order
  // asks the same question twelve times.
  const geoCache = new Map<string, CustomerGeo | null>();
  const resolutionCache = new Map<string, Resolution | null>();
  const rateCache = new Map<string, Map<string, number>>();

  const out: VarianceRow[] = [];
  for (const row of rows) {
    let listId: string | null = null;
    let listName: string | null = null;
    if (row.customerId) {
      const key = `${row.customerId}|${row.orderDate}`;
      if (!resolutionCache.has(key)) {
        if (!geoCache.has(row.customerId)) geoCache.set(row.customerId, await customerGeo(row.customerId));
        const geo = geoCache.get(row.customerId) ?? null;
        resolutionCache.set(key, geo ? resolvePriceList(geo, scopes, lists, row.orderDate) : null);
      }
      const r = resolutionCache.get(key) ?? null;
      listId = r?.listId ?? null;
      listName = r?.listName ?? null;
    }

    let listExPaise: number | null = null;
    if (listId && row.productId) {
      if (!rateCache.has(listId)) {
        const rateRows = await db.execute<{ productId: string; rateExGstPaise: number }>(sql`
          select r.product_id as "productId", r.rate_ex_gst_paise as "rateExGstPaise"
            from price_list_rates r where r.price_list_id = ${listId} and r.min_cans is null
        `);
        rateCache.set(listId, new Map([...rateRows].map((r) => [r.productId, Number(r.rateExGstPaise)])));
      }
      listExPaise = rateCache.get(listId)!.get(row.productId) ?? null;
    }

    const billed = Number(row.billedExPaise);
    const { deltaPaise, deltaBp } = rateChange(listExPaise, billed);
    out.push({
      orderDate: row.orderDate,
      orderNumber: row.orderNumber,
      customerId: row.customerId,
      customerName: row.customerName,
      productId: row.productId,
      productName: row.productName,
      cans: row.cans,
      billedExPaise: billed,
      listExPaise,
      listId,
      listName,
      deltaPaise,
      deltaBp,
      sheetDiscountBp: row.sheetDiscountBp,
    });
  }

  out.sort((a, b) => (a.deltaBp ?? 1e9) - (b.deltaBp ?? 1e9));
  const priced = out.filter((r) => r.listExPaise != null);
  return {
    month,
    rows: out,
    summary: {
      lines: out.length,
      onList: priced.filter((r) => r.deltaPaise === 0).length,
      belowList: priced.filter((r) => (r.deltaPaise ?? 0) < 0).length,
      aboveList: priced.filter((r) => (r.deltaPaise ?? 0) > 0).length,
      unresolved: out.length - priced.length,
      totalBelowPaise: priced
        .filter((r) => (r.deltaPaise ?? 0) < 0)
        .reduce((sum, r) => sum + Math.abs(r.deltaPaise ?? 0) * (r.cans ?? 1), 0),
    },
  };
}

/* ------------------------------------------------------------- requests */

export async function listRequests(filter?: { status?: "pending" | "all"; customerId?: string }): Promise<RequestView[]> {
  const { user, role } = await resolveScope();
  const pendingOnly = (filter?.status ?? "pending") === "pending";
  // A salesman sees what he asked for; a manager sees the queue. The narrower
  // answer is the default so a screen that forgets to say cannot leak one.
  const mineOnly = role === "associate";
  const rows = await db.execute<RequestView & { requestedRateExGstPaise: number }>(sql`
    select q.id, q.customer_id as "customerId", c.name as "customerName",
           q.product_id as "productId", p.name as "productName",
           q.requested_rate_ex_gst_paise as "requestedRateExGstPaise",
           q.current_rate_ex_gst_paise as "currentRateExGstPaise",
           q.current_list_id as "currentListId",
           (select l.name from price_lists l where l.id = q.current_list_id) as "currentListName",
           q.reason, q.status,
           q.requested_by_id as "requestedById",
           (select u.name from users u where u.id = q.requested_by_id) as "requestedByName",
           to_char(q.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "requestedAt",
           (select u.name from users u where u.id = q.decided_by_id) as "decidedByName",
           to_char(q.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "decidedAt",
           q.decision_note as "decisionNote", q.resulting_list_id as "resultingListId",
           coalesce((select l.gst_bp from price_lists l where l.id = q.current_list_id), 1800) as "gstBp"
      from price_requests q
      join customers c on c.id = q.customer_id
      join products p on p.id = q.product_id
     where (${!pendingOnly}::boolean or q.status = 'pending')
       and (${filter?.customerId ?? null}::text is null or q.customer_id = ${filter?.customerId ?? null})
       and (${!mineOnly}::boolean or q.requested_by_id = ${user.id})
     order by (q.status = 'pending') desc, q.created_at desc, q.id desc
     limit 300
  `);
  return [...rows].map((r) => {
    const gstBp = (r as RequestView & { gstBp?: number }).gstBp ?? 1800;
    const ex = Number(r.requestedRateExGstPaise);
    return {
      ...r,
      requestedRateExGstPaise: ex,
      requestedRateInclGstPaise: Math.round(ex * (1 + gstBp / 10_000)),
      currentRateExGstPaise: r.currentRateExGstPaise == null ? null : Number(r.currentRateExGstPaise),
    };
  });
}

/* --------------------------------------------------------------- options */

/**
 * What the pickers offer.
 *
 * Places come from the place master where it has been built, and from the
 * book's own raw text where it has not — which is prod today: `places` is
 * empty, `city` holds 1,165 strings and `region` about twenty. Offering
 * nothing there would make the scope editor unusable on the only book that
 * matters, so the fallback counts the shops behind each spelling and orders by
 * that, biggest first, exactly as the territory picker does.
 */
export async function pricingOptions(): Promise<PricingOptions> {
  const [products, placeRows, fallbackStates, fallbackCities, beats, salesmen, lists] = await Promise.all([
    db.execute<PricingOptions["products"][number]>(sql`
      select p.id, p.name, p.millilitres_per_can as "millilitresPerCan",
             p.cans_per_box as "cansPerBox", p.packing,
             b.name as "brandName", f.name as "formulationName", p.active
        from products p
        left join product_brands b on b.id = p.brand_id
        left join product_formulations f on f.id = p.formulation_id
       where p.finished_good_id is not null
       order by p.name asc
    `),
    db.execute<PlaceOption & { kind: string }>(sql`
      select p.kind, p.key, p.name as label, coalesce(q.key, '') as "parentKey",
             q.name as "parentLabel", p.shops
        from places p left join places q on q.id = p.parent_id
       where p.shops > 0
       order by p.shops desc, p.name asc
    `),
    db.execute<PlaceOption>(sql`
      select lower(regexp_replace(c.region, '[^a-zA-Z0-9]', '', 'g')) as key,
             min(c.region) as label, '' as "parentKey", null::text as "parentLabel",
             count(*)::int as shops
        from customers c
       where c.region is not null and c.region <> ''
       group by 1 order by 5 desc, 2 asc limit 200
    `),
    db.execute<PlaceOption>(sql`
      select lower(regexp_replace(c.city, '[^a-zA-Z0-9]', '', 'g')) as key,
             min(c.city) as label,
             lower(regexp_replace(coalesce(min(c.region), ''), '[^a-zA-Z0-9]', '', 'g')) as "parentKey",
             min(c.region) as "parentLabel",
             count(*)::int as shops
        from customers c
       where c.city is not null and c.city <> ''
       group by 1 order by 5 desc, 2 asc limit 500
    `),
    db.execute<{ beat: string }>(sql`
      select distinct c.beat from customers c where c.beat is not null and c.beat <> '' order by c.beat asc limit 300
    `),
    db.execute<{ id: string; name: string }>(sql`
      select u.id, u.name from users u where u.active order by u.name asc
    `),
    db.execute<PricingOptions["lists"][number]>(sql`
      select l.id, l.name, l.status, l.version, l.effective_from::text as "effectiveFrom"
        from price_lists l order by (l.status = 'published') desc, l.name asc
    `),
  ]);

  const byKind = (kind: string) => [...placeRows].filter((p) => p.kind === kind).map(({ kind: _k, ...rest }) => rest);
  const states = byKind("state");
  const cities = byKind("city");

  return {
    products: [...products],
    places: {
      states: states.length ? states : [...fallbackStates],
      districts: byKind("district"),
      cities: cities.length ? cities : [...fallbackCities],
      areas: byKind("area"),
    },
    beats: [...beats].map((b) => b.beat),
    salesmen: [...salesmen],
    customerTypes: ["dealer", "manufacturer", "distributor", "retailer"],
    lists: [...lists],
  };
}

export async function searchCustomers(q: string, limit = 10): Promise<CustomerHit[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  const ids = await userIdsInScope();
  const like = `%${term}%`;
  const rows = await db.execute<CustomerHit>(sql`
    select c.id, c.name, c.city, c.region, c.kind
      from customers c
     where (c.name ilike ${like} or c.city ilike ${like} or c.dealer_code ilike ${like})
       and ${bookClause(ids)}
     order by c.name asc
     limit ${limit}
  `);
  return [...rows];
}

export async function pricingCounts(): Promise<PricingCounts> {
  const [row] = await db.execute<PricingCounts>(sql`
    select (select count(*)::int from price_lists where status = 'published') as published,
           (select count(*)::int from price_lists where status = 'draft') as drafts,
           (select count(*)::int from price_list_documents
             where parse_status not in ('published','rejected')) as "documentsWaiting",
           (select count(*)::int from price_requests where status = 'pending') as "requestsPending",
           null::int as "unresolvedCustomers"
  `);
  return row ?? { published: 0, drafts: 0, documentsWaiting: 0, requestsPending: 0, unresolvedCustomers: null };
}

/** The label a scope kind is shown under, for a screen that has only the code. */
export function scopeKindLabel(kind: PriceScopeKind): string {
  return SCOPE_KIND_LABEL[kind];
}

export type {
  PriceDocumentStatus,
  PriceFilenameHints,
  PriceMatchStatus,
  PriceParsedHeader,
  PriceDiscountKind,
};
