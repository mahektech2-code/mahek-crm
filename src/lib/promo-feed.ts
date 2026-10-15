/* ---------------------------------------------------------------------------
 * The Promotional App feed — what the poster tool is allowed to learn about a
 * lead or a customer, and nothing else.
 *
 * The Promotional App is a separate program that makes greeting posters. It
 * needs to show a salesperson WHO a poster could go to, never how to reach
 * them and never what they owe. So the shape below is an allow-list: a record
 * leaves the CRM carrying exactly the fields in `PROMO_FEED_FIELDS`, and the
 * query in `services/promo-feed-service.ts` selects exactly the columns those
 * fields come from. There is no phone number, address, GST number, credit
 * figure, GPS fix, note or e-mail in it, by construction — a column that is
 * not selected cannot be returned by a bug in the mapping.
 *
 * It answers one PAGE at a time (at most 100 records), with the total, so the
 * other program never has to hold the book: search, filters and sorting are
 * done here, in the database, over every eligible record. A second call lists
 * the values the filters can take (the "facets").
 *
 * This file is PURE (no database connection, no framework) so the contract
 * can be tested without either. It is read-only end to end: nothing here
 * writes, and the handlers refuse every method but GET.
 *
 * Owner and Sales Manager are NAMES TO DISPLAY and values a person may FILTER
 * by. They never restrict what is returned: with no filter every eligible
 * record is returned whoever owns it, because the poster tool shows all of
 * them to every authorised user.
 * ------------------------------------------------------------------------- */

import { timingSafeEqual } from "node:crypto";
import { customerStatusEnum, mbosLeadStageEnum } from "@/db/schema";

export const PROMO_FEED_CONTRACT = "promo-feed-v1";
export const PROMO_FEED_DEFAULT_PAGE_SIZE = 50;
export const PROMO_FEED_MAX_PAGE_SIZE = 100;
export const PROMO_FEED_MAX_PAGE = 100_000;
/** Most values a facet list carries; when more exist the list says so (`truncated`), never silently. */
export const PROMO_FACET_LIMIT = 500;

/** The ONLY fields a record may carry. Adding one is a contract change and breaks the contract test on purpose. */
export const PROMO_FEED_FIELDS = [
  "id",
  "kind",
  "businessName",
  "company",
  "contact",
  "city",
  "district",
  "state",
  "owner",
  "salesManager",
  "createdAt",
  "stage",
  "status",
  "archived",
  "lost",
  "trashed",
  "dnc",
  "whatsappDnd",
  "sourceCode",
  "sourceLabel",
] as const;

export type PromoRecord = {
  id: string;
  kind: "lead" | "customer";
  /** `customers.name`: the business name as the CRM holds it. */
  businessName: string;
  /** `company_name` when there is one, otherwise the business name. */
  company: string;
  contact: string | null;
  city: string;
  district: string | null;
  state: string | null;
  owner: string | null;
  salesManager: string | null;
  createdAt: string;
  /** A lead's pipeline stage, as the CRM's own code. Null for a customer. */
  stage: string | null;
  status: string;
  archived: boolean;
  /** A lead whose stage is `lost`. */
  lost: boolean;
  trashed: boolean;
  /** Do Not Contact (a call instruction) and WhatsApp-only DND: two separate facts, sent as stated. */
  dnc: boolean;
  whatsappDnd: boolean;
  sourceCode: string | null;
  sourceLabel: string | null;
};

/** What the service reads for one record. Names only for people and places; no contact, address or money column. */
export type PromoRawRow = {
  id: string;
  kind: "lead" | "customer";
  name: string;
  companyName: string | null;
  contactPerson: string | null;
  city: string;
  districtName: string | null;
  stateName: string | null;
  ownerUserName: string | null;
  amUserName: string | null;
  salesPersonName: string | null;
  smUserName: string | null;
  salesManagerPersonName: string | null;
  createdAt: Date | string;
  leadStage: string | null;
  status: string;
  leadArchived: boolean | null;
  deletedAt: Date | string | null;
  doNotContact: boolean | null;
  whatsappDnd: boolean | null;
  leadSource: string | null;
};

const clean = (value: string | null | undefined): string | null => {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text === "" ? null : text;
};

const iso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();

/**
 * One record out of one row. The owner of a customer is its sales account
 * manager (the person the record answers to), falling back to the sheet's
 * sales-person name and then to whoever first found it; a lead's owner is its
 * owner. Display only.
 */
export function shapePromoRecord(row: PromoRawRow, sourceLabels: ReadonlyMap<string, string> = new Map()): PromoRecord {
  const isLead = row.kind === "lead";
  const businessName = clean(row.name) ?? "";
  const sourceCode = isLead ? clean(row.leadSource) : null;
  return {
    id: row.id,
    kind: row.kind,
    businessName,
    company: clean(row.companyName) ?? businessName,
    contact: clean(row.contactPerson),
    city: clean(row.city) ?? "",
    district: clean(row.districtName),
    state: clean(row.stateName),
    owner: isLead ? clean(row.ownerUserName) : (clean(row.amUserName) ?? clean(row.salesPersonName) ?? clean(row.ownerUserName)),
    salesManager: clean(row.smUserName) ?? clean(row.salesManagerPersonName),
    createdAt: iso(row.createdAt),
    stage: isLead ? clean(row.leadStage) : null,
    status: row.status,
    archived: isLead && row.leadArchived === true,
    lost: isLead && row.leadStage === "lost",
    trashed: row.deletedAt !== null && row.deletedAt !== undefined,
    dnc: row.doNotContact === true,
    whatsappDnd: row.whatsappDnd === true,
    sourceCode,
    sourceLabel: sourceCode === null ? null : (sourceLabels.get(sourceCode) ?? sourceCode),
  };
}

/* ---- the request ---- */

export const PROMO_SORTS = ["created_desc", "created_asc", "name_asc", "name_desc"] as const;
export type PromoSort = (typeof PROMO_SORTS)[number];

export type PromoFilters = {
  kind: "lead" | "customer" | null;
  /** Free text: every word must match the name, company, contact, city, state or district. Never a phone or e-mail. */
  q: string | null;
  /** A place id from the facets (the resolved state / district). */
  state: string | null;
  district: string | null;
  /** The city text as the CRM holds it (from the facets, or typed). Matched whole, ignoring case. */
  city: string | null;
  /** A user id from the facets. A FILTER a person chooses, never a restriction. */
  owner: string | null;
  salesManager: string | null;
  /** A lead stage code. */
  stage: string | null;
  /** A customer status. */
  status: "active" | "inactive" | "deactivated" | null;
  /** `exclude` leaves out archived and lost leads; `include` (the default) returns them, flagged. */
  restricted: "include" | "exclude";
};

export type PromoFeedQuery = PromoFilters & { sort: PromoSort; page: number; pageSize: number };
export type PromoFacetsQuery = Pick<PromoFilters, "kind" | "restricted">;

export type PromoFacetValue = { id: string; name: string; count: number };
export type PromoFacets = {
  states: PromoFacetValue[];
  districts: (PromoFacetValue & { stateId: string | null })[];
  cities: { name: string; count: number }[];
  owners: PromoFacetValue[];
  salesManagers: PromoFacetValue[];
  stages: { value: string; count: number }[];
  statuses: { value: string; count: number }[];
  /** Which lists were cut at PROMO_FACET_LIMIT. Never silent. */
  truncated: { states: boolean; districts: boolean; cities: boolean; owners: boolean; salesManagers: boolean };
};

const LIST_PARAMS = ["kind", "q", "state", "district", "city", "owner", "salesManager", "stage", "status", "restricted", "sort", "page", "pageSize"] as const;
const FACET_PARAMS = ["kind", "restricted"] as const;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_TERMS = 5;

/** The search words of a free-text value: whitespace-split, at most five words, each at most 60 characters. */
export function searchTerms(q: string): string[] {
  return q
    .split(" ")
    .filter(Boolean)
    .slice(0, MAX_TERMS)
    .map((t) => t.slice(0, 60));
}

type Parsed<T> = { ok: true; query: T } | { ok: false; message: string };

function readParams(url: URL, allowed: readonly string[]): { ok: true; get: (key: string) => string | null } | { ok: false; message: string } {
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key)) return { ok: false, message: `Unknown parameter "${key}".` };
    if (seen.has(key)) return { ok: false, message: `Parameter "${key}" was given more than once.` };
    seen.add(key);
  }
  return { ok: true, get: (key) => url.searchParams.get(key) };
}

function parseFilters(get: (key: string) => string | null): { ok: true; filters: PromoFilters } | { ok: false; message: string } {
  const kind = get("kind");
  if (kind !== null && kind !== "lead" && kind !== "customer") return { ok: false, message: 'kind must be "lead" or "customer".' };

  const qRaw = get("q");
  let q: string | null = null;
  if (qRaw !== null) {
    if (CONTROL.test(qRaw)) return { ok: false, message: "q has characters that are not allowed." };
    const collapsed = qRaw.replace(/\s+/g, " ").trim();
    if (collapsed.length > 100) return { ok: false, message: "q is too long (100 characters at most)." };
    q = collapsed === "" ? null : collapsed;
  }

  const ids: Record<"state" | "district" | "owner" | "salesManager", string | null> = { state: null, district: null, owner: null, salesManager: null };
  for (const key of ["state", "district", "owner", "salesManager"] as const) {
    const v = get(key);
    if (v !== null && v !== "") {
      if (!ID.test(v)) return { ok: false, message: `${key} is not a valid id.` };
      ids[key] = v;
    }
  }

  const cityRaw = get("city");
  let city: string | null = null;
  if (cityRaw !== null && cityRaw.trim() !== "") {
    if (CONTROL.test(cityRaw)) return { ok: false, message: "city has characters that are not allowed." };
    city = cityRaw.replace(/\s+/g, " ").trim();
    if (city.length > 100) return { ok: false, message: "city is too long (100 characters at most)." };
  }

  const stage = get("stage");
  if (stage !== null && stage !== "" && !(mbosLeadStageEnum.enumValues as readonly string[]).includes(stage)) return { ok: false, message: "stage is not a known lead stage." };
  const status = get("status");
  if (status !== null && status !== "" && !(customerStatusEnum.enumValues as readonly string[]).includes(status)) return { ok: false, message: "status is not a known customer status." };

  const restricted = get("restricted");
  if (restricted !== null && restricted !== "include" && restricted !== "exclude") return { ok: false, message: 'restricted must be "include" or "exclude".' };

  return {
    ok: true,
    filters: {
      kind,
      q,
      state: ids.state,
      district: ids.district,
      city,
      owner: ids.owner,
      salesManager: ids.salesManager,
      stage: stage === null || stage === "" ? null : stage,
      status: status === null || status === "" ? null : (status as PromoFilters["status"]),
      restricted: restricted === "exclude" ? "exclude" : "include",
    },
  };
}

/** Strict: an unknown or repeated parameter is refused rather than ignored, so a typo cannot silently widen a request. */
export function parsePromoFeedQuery(url: URL): Parsed<PromoFeedQuery> {
  const params = readParams(url, LIST_PARAMS);
  if (!params.ok) return params;
  const filters = parseFilters(params.get);
  if (!filters.ok) return filters;

  const sortRaw = params.get("sort");
  if (sortRaw !== null && !(PROMO_SORTS as readonly string[]).includes(sortRaw)) return { ok: false, message: `sort must be one of ${PROMO_SORTS.join(", ")}.` };

  const pageRaw = params.get("page");
  let page = 1;
  if (pageRaw !== null) {
    if (!/^\d{1,6}$/.test(pageRaw)) return { ok: false, message: "page must be a whole number from 1." };
    page = Number(pageRaw);
    if (page < 1 || page > PROMO_FEED_MAX_PAGE) return { ok: false, message: `page must be from 1 to ${PROMO_FEED_MAX_PAGE}.` };
  }
  const sizeRaw = params.get("pageSize");
  let pageSize = PROMO_FEED_DEFAULT_PAGE_SIZE;
  if (sizeRaw !== null) {
    if (!/^\d{1,4}$/.test(sizeRaw)) return { ok: false, message: "pageSize must be a whole number." };
    pageSize = Number(sizeRaw);
    if (pageSize < 1 || pageSize > PROMO_FEED_MAX_PAGE_SIZE) return { ok: false, message: `pageSize must be from 1 to ${PROMO_FEED_MAX_PAGE_SIZE}.` };
  }
  return { ok: true, query: { ...filters.filters, sort: (sortRaw as PromoSort | null) ?? "created_desc", page, pageSize } };
}

export function parsePromoFacetsQuery(url: URL): Parsed<PromoFacetsQuery> {
  const params = readParams(url, FACET_PARAMS);
  if (!params.ok) return params;
  const filters = parseFilters(params.get);
  if (!filters.ok) return filters;
  return { ok: true, query: { kind: filters.filters.kind, restricted: filters.filters.restricted } };
}

/** Clamp a requested page to the pages that exist (the first page when there are no records). */
export function clampPage(total: number, page: number, pageSize: number): { page: number; pageCount: number; offset: number } {
  const pageCount = Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
  const clamped = Math.min(Math.max(1, page), pageCount);
  return { page: clamped, pageCount, offset: (clamped - 1) * pageSize };
}

/** A search word as a LIKE pattern: the wildcards `%`, `_` and the escape `\` in it are matched literally. */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, "\\$&")}%`;
}

/* ---- who may ask ---- */

function safeTimingEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // different lengths still take a constant-time comparison, as /api/public/enquiries does
  if (bufA.length !== bufB.length) return timingSafeEqual(bufA, bufA) && false;
  return timingSafeEqual(bufA, bufB);
}

/** Fail closed: no secret configured means the feed is closed, and a wrong or missing bearer token is refused. */
export function authorizePromoFeed(authorization: string | null, secret: string | null | undefined): { ok: true } | { ok: false; status: 401 | 503; message: string } {
  if (!secret) return { ok: false, status: 503, message: "The feed is not configured." };
  const presented = authorization !== null && authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!presented || !safeTimingEqual(presented, secret)) return { ok: false, status: 401, message: "Not authorised." };
  return { ok: true };
}

/* ---- the handlers ---- */

export type PromoListResult = { records: PromoRecord[]; total: number; page: number; pageCount: number };

export type PromoFeedDeps = {
  /** The configured bearer secret (env). Null or empty closes the feed. */
  secret: string | null | undefined;
  /** Reads one page with the filters applied, and the total. Read-only by its type: it returns records and counts. */
  list: (query: PromoFeedQuery) => Promise<PromoListResult>;
  /** The values the filters can take. */
  facets: (query: PromoFacetsQuery) => Promise<PromoFacets>;
  now?: () => Date;
};

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const;

const refuse = (status: number, message: string, extra: Record<string, string> = {}) =>
  Response.json({ ok: false, error: message }, { status, headers: { ...NO_STORE, ...extra } });

function logFailure(e: unknown): void {
  // never echo the reason to the caller: it can name a table or a value. The server log gets only the
  // kind of failure and a short error code (for example a Postgres code), never the message or a value.
  const codeOf = (x: unknown): string => (typeof x === "object" && x !== null && "code" in x ? String((x as { code: unknown }).code).replace(/[^A-Za-z0-9_]/g, "").slice(0, 20) : "");
  const cause = typeof e === "object" && e !== null && "cause" in e ? (e as { cause: unknown }).cause : null;
  const code = codeOf(e) || codeOf(cause);
  // a missing column or table (Postgres 42703 / 42P01: the database is behind this code's schema) names
  // only the column or table, never a value, so that one message may be logged; no other is
  const schemaGap = (code === "42703" || code === "42P01") && cause instanceof Error ? cause.message.replace(/[^A-Za-z0-9_." ]/g, "").slice(0, 120) : "";
  console.error("promo-feed: read failed", e instanceof Error ? e.name : "error", code, schemaGap);
}

/** GET only, authenticated, no-store. Everything that is not a clean read answers with a refusal and no data. */
async function guarded(request: Request, deps: PromoFeedDeps, run: (url: URL) => Promise<Response>): Promise<Response> {
  if (request.method !== "GET") return refuse(405, "This feed is read-only.", { Allow: "GET" });
  const auth = authorizePromoFeed(request.headers.get("authorization"), deps.secret);
  if (!auth.ok) return refuse(auth.status, auth.message);
  try {
    return await run(new URL(request.url));
  } catch (e) {
    logFailure(e);
    return refuse(503, "The feed could not be read.");
  }
}

const generatedAt = (deps: PromoFeedDeps) => (deps.now ?? (() => new Date()))().toISOString();

export function handlePromoFeedRequest(request: Request, deps: PromoFeedDeps): Promise<Response> {
  return guarded(request, deps, async (url) => {
    const parsed = parsePromoFeedQuery(url);
    if (!parsed.ok) return refuse(400, parsed.message);
    const result = await deps.list(parsed.query);
    // belt and braces: whatever the service returned, only allow-listed fields leave
    const records = result.records.map((r) => Object.fromEntries(PROMO_FEED_FIELDS.map((f) => [f, r[f]])));
    return Response.json(
      { ok: true, contract: PROMO_FEED_CONTRACT, generatedAt: generatedAt(deps), total: result.total, page: result.page, pageSize: parsed.query.pageSize, pageCount: result.pageCount, records },
      { headers: NO_STORE },
    );
  });
}

export function handlePromoFacetsRequest(request: Request, deps: PromoFeedDeps): Promise<Response> {
  return guarded(request, deps, async (url) => {
    const parsed = parsePromoFacetsQuery(url);
    if (!parsed.ok) return refuse(400, parsed.message);
    const facets = await deps.facets(parsed.query);
    return Response.json({ ok: true, contract: PROMO_FEED_CONTRACT, generatedAt: generatedAt(deps), facets }, { headers: NO_STORE });
  });
}
