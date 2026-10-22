import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { customers } from "@/db/schema";
import {
  PROMO_FACET_LIMIT,
  PROMO_FEED_CONTRACT,
  PROMO_FEED_DEFAULT_PAGE_SIZE,
  PROMO_FEED_FIELDS,
  PROMO_FEED_MAX_PAGE_SIZE,
  authorizePromoFeed,
  clampPage,
  handlePromoFacetsRequest,
  handlePromoRecordRequest,
  handlePromoFeedRequest,
  likePattern,
  parsePromoFacetsQuery,
  parsePromoFeedQuery,
  searchTerms,
  shapePromoRecord,
  type PromoFacets,
  type PromoFeedDeps,
  type PromoFeedQuery,
  type PromoFilters,
  type PromoRawRow,
  type PromoRecord,
} from "./promo-feed";
import { promoOrderBy, promoWhere } from "./promo-feed-sql";

// The contract of the Promotional App feed: exactly which fields leave, who may ask, what a request may
// be, that the SQL is built from bound parameters, and that nothing is written. Pure: no database.

const SECRET = "test-secret-do-not-use-anywhere-else";
const dialect = new PgDialect();
const render = (where: ReturnType<typeof promoWhere>) => {
  assert.ok(where, "a where clause");
  return dialect.sqlToQuery(where);
};
const root = path.join(import.meta.dirname);
const source = (...p: string[]) => fs.readFileSync(path.join(root, ...p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const raw = (o: Partial<PromoRawRow> = {}): PromoRawRow => ({
  id: "cus_abc123",
  kind: "lead",
  name: "Shah Paints",
  companyName: null,
  contactPerson: "Rajesh Shah",
  city: "Rajkot",
  districtName: "Rajkot",
  stateName: "Gujarat",
  ownerUserName: "Priya Sharma",
  amUserName: null,
  salesPersonName: null,
  smUserName: "Anil Mehta",
  salesManagerPersonName: null,
  createdAt: new Date("2026-10-01T05:30:00.000Z"),
  leadStage: "new",
  status: "active",
  leadArchived: false,
  deletedAt: null,
  doNotContact: false,
  whatsappDnd: false,
  leadSource: "website",
  ...o,
});

const NONE: PromoFilters = { scope: "active", kind: null, q: null, state: null, district: null, city: null, owner: null, salesManager: null, stage: null, status: null };
const EMPTY_FACETS: PromoFacets = { states: [], districts: [], cities: [], owners: [], salesManagers: [], stages: [], statuses: [], truncated: { states: false, districts: false, cities: false, owners: false, salesManagers: false } };

const URL_BASE = "http://x/api/integrations/promo/v1/recipients";
const get = (qs = "", headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }, method = "GET", base = URL_BASE) => new Request(`${base}${qs ? `?${qs}` : ""}`, { method, headers });
const parse = (qs: string) => parsePromoFeedQuery(new URL(`${URL_BASE}?${qs}`));
const deps = (o: Partial<PromoFeedDeps> = {}): PromoFeedDeps => ({
  secret: SECRET,
  list: async (q) => ({ records: [shapePromoRecord(raw())], total: 1, page: q.page, pageCount: 1 }),
  facets: async () => EMPTY_FACETS,
  get: async (id) => (id === "cus_1" ? shapePromoRecord(raw()) : null),
  now: () => new Date("2026-10-09T10:00:00.000Z"),
  ...o,
});

describe("the feed's fields are an allow-list", () => {
  test("a shaped record has exactly the contract's fields, in that order, and nothing else", () => {
    assert.deepEqual(Object.keys(shapePromoRecord(raw())), [...PROMO_FEED_FIELDS]);
  });
  test("the contract names no phone, address, tax, credit, location-fix, note or e-mail field", () => {
    for (const field of PROMO_FEED_FIELDS) assert.ok(!/phone|mobile|email|address|gst|credit|outstanding|gps|note|pincode/i.test(field), field);
  });
  test("a row that somehow carries sensitive columns still produces a record without them", () => {
    const dirty = { ...raw(), phone: "+919876543210", whatsappPhone: "9876543210", email: "x@y.in", address: "12 Main Rd", gstin: "24AAAAA0000A1Z5", creditLimitPaise: 5_000_000, gpsLat: 22.3, leadNotes: "private" } as unknown as PromoRawRow;
    const record = shapePromoRecord(dirty);
    const text = JSON.stringify(record);
    for (const needle of ["9876543210", "x@y.in", "12 Main Rd", "24AAAAA0000A1Z5", "5000000", "private"]) assert.ok(!text.includes(needle), needle);
    assert.deepEqual(Object.keys(record), [...PROMO_FEED_FIELDS]);
  });
  test("the handler strips anything the service returns beyond the contract", async () => {
    const leaky = async () => ({ records: [{ ...shapePromoRecord(raw()), phone: "+919876543210", gstin: "24AAAAA0000A1Z5" } as unknown as PromoRecord], total: 1, page: 1, pageCount: 1 });
    const body = (await (await handlePromoFeedRequest(get(), deps({ list: leaky }))).json()) as { records: Record<string, unknown>[] };
    assert.deepEqual(Object.keys(body.records[0]!), [...PROMO_FEED_FIELDS]);
    assert.ok(!JSON.stringify(body).includes("9876543210"));
  });
});

describe("shaping a record", () => {
  test("company is companyName when there is one, otherwise the business name", () => {
    assert.equal(shapePromoRecord(raw({ companyName: "Shah Paints Pvt. Ltd." })).company, "Shah Paints Pvt. Ltd.");
    for (const empty of [null, "", "   "]) assert.equal(shapePromoRecord(raw({ companyName: empty })).company, "Shah Paints");
  });
  test("a lead's owner is its owner; a customer's is its account manager, then the sheet's sales person, then who found it", () => {
    assert.equal(shapePromoRecord(raw()).owner, "Priya Sharma");
    const customer = (o: Partial<PromoRawRow>) => shapePromoRecord(raw({ kind: "customer", leadStage: null, ...o }));
    assert.equal(customer({ amUserName: "AM", salesPersonName: "Sheet" }).owner, "AM");
    assert.equal(customer({ amUserName: null, salesPersonName: "Sheet" }).owner, "Sheet");
    assert.equal(customer({ amUserName: null, salesPersonName: null }).owner, "Priya Sharma");
  });
  test("the sales manager is the user's name, or the plain name when that person has no login", () => {
    assert.equal(shapePromoRecord(raw()).salesManager, "Anil Mehta");
    assert.equal(shapePromoRecord(raw({ smUserName: null, salesManagerPersonName: "No Login" })).salesManager, "No Login");
  });
  test("lead flags are as stated, and a customer is never lost or archived; null flags read as false", () => {
    assert.equal(shapePromoRecord(raw({ leadStage: "lost" })).lost, true);
    assert.equal(shapePromoRecord(raw({ leadArchived: true })).archived, true);
    assert.equal(shapePromoRecord(raw({ deletedAt: new Date() })).trashed, true);
    const customer = shapePromoRecord(raw({ kind: "customer", leadStage: "lost", leadArchived: true }));
    assert.deepEqual([customer.lost, customer.archived, customer.stage], [false, false, null]);
    const nulls = shapePromoRecord(raw({ leadArchived: null, doNotContact: null, whatsappDnd: null }));
    assert.deepEqual([nulls.archived, nulls.dnc, nulls.whatsappDnd], [false, false, false]);
  });
  test("the source is a code with its label when configured, else the code; customers carry none", () => {
    const labels = new Map([["website", "Website / Online Enquiry"]]);
    assert.equal(shapePromoRecord(raw(), labels).sourceLabel, "Website / Online Enquiry");
    assert.equal(shapePromoRecord(raw({ leadSource: "new_channel" }), labels).sourceLabel, "new_channel");
    assert.deepEqual([shapePromoRecord(raw({ kind: "customer" })).sourceCode, shapePromoRecord(raw({ kind: "customer" })).sourceLabel], [null, null]);
  });
});

describe("who may ask (fail closed)", () => {
  test("no secret configured closes both endpoints with 503 and no data", async () => {
    for (const secret of [undefined, null, ""]) {
      for (const handler of [handlePromoFeedRequest, handlePromoFacetsRequest]) {
        const res = await handler(get(), deps({ secret }));
        assert.equal(res.status, 503);
        assert.deepEqual(await res.json(), { ok: false, error: "The feed is not configured." });
      }
    }
  });
  test("a missing, malformed or wrong bearer token is 401 with no data", async () => {
    for (const authorization of [undefined, "", "Bearer", "Bearer ", "Basic abc", `bearer ${SECRET}`, SECRET, `Bearer ${SECRET}x`, `Bearer x${SECRET}`, "Bearer wrong"]) {
      const headers: Record<string, string> = authorization === undefined ? {} : { authorization };
      for (const handler of [handlePromoFeedRequest, handlePromoFacetsRequest]) {
        const res = await handler(get("", headers), deps());
        assert.equal(res.status, 401, String(authorization));
        const text = await res.text();
        assert.ok(!text.includes("records") && !text.includes("facets") && !text.includes(SECRET));
      }
    }
  });
  test("a different-length token is refused as well as a same-length wrong one", () => {
    assert.equal(authorizePromoFeed("Bearer short", SECRET).ok, false);
    assert.equal(authorizePromoFeed(`Bearer ${"x".repeat(SECRET.length)}`, SECRET).ok, false);
    assert.equal(authorizePromoFeed(`Bearer ${SECRET}`, SECRET).ok, true);
  });
  test("an unauthenticated request with an invalid query is still 401, never a hint about the query", async () => {
    const res = await handlePromoFeedRequest(get("pageSize=9999", {}), deps());
    assert.equal(res.status, 401);
  });
});

describe("read only", () => {
  test("every method but GET is 405 with Allow: GET before anything is read", async () => {
    let called = 0;
    const d = deps({ list: async () => { called++; return { records: [], total: 0, page: 1, pageCount: 1 }; }, facets: async () => { called++; return EMPTY_FACETS; }, get: async () => { called++; return null; } });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const handler of [handlePromoFeedRequest, handlePromoFacetsRequest, (r: Request, dd: PromoFeedDeps) => handlePromoRecordRequest(r, "cus_1", dd)]) {
        const res = await handler(new Request(URL_BASE, { method, headers: { authorization: `Bearer ${SECRET}` }, body: "{}" }), d);
        assert.equal(res.status, 405, method);
        assert.equal(res.headers.get("allow"), "GET");
      }
    }
    assert.equal(called, 0);
  });
  test("the service and the SQL module contain no insert, update, delete or transaction, and only whitelisted raw SQL", () => {
    const text = source("services", "promo-feed-service.ts") + "\n" + source("promo-feed-sql.ts");
    assert.ok(/\.select\(/.test(text));
    for (const forbidden of [/\.insert\(/, /\.update\(/, /\.delete\(/, /\.execute\(/, /\.transaction\(/, /onConflict/i]) assert.ok(!forbidden.test(text), String(forbidden));
    const templates = [...text.matchAll(/sql(?:<\w+>)?`([^`]*)`/g)].map((m) => m[1]!).sort();
    assert.deepEqual(
      templates,
      [
        "${promoOwner.id} = ${DISPLAY_OWNER_ID}",
        "lower(${customers.city}) = lower(${f.city})",
        "lower(${customers.name})",
        "lower(${customers.name})",
        "${DISPLAY_OWNER_ID} = ${f.owner}",
        "case when ${customers.kind} = 'lead' then ${customers.ownerId} else coalesce(${customers.salesAmId}, ${customers.ownerId}) end",
        "count(*)::int",
      ].sort(),
    );
  });
  test("the code reads exactly these customers columns and no others (an allow-list, so a new free-text column cannot slip in)", () => {
    const text = source("services", "promo-feed-service.ts") + "\n" + source("promo-feed-sql.ts");
    const used = [...new Set([...text.matchAll(/customers\.([A-Za-z]+)/g)].map((m) => m[1]))].sort();
    assert.deepEqual(used, ["city", "companyName", "contactPerson", "createdAt", "deletedAt", "doNotContact", "id", "kind", "leadArchived", "leadSource", "leadStage", "name", "ownerId", "resolvedDistrictId", "resolvedStateId", "salesAmId", "salesManagerId", "salesManagerPersonName", "salesPersonName", "status", "whatsappDnd"]);
  });
  test("the route files export only the five handlers, the secret comes from the environment, and each is its own file", () => {
    for (const dir of ["recipients", "recipients/[id]", "facets"]) {
      const text = fs.readFileSync(path.join(root, "..", "app", "api", "integrations", "promo", "v1", ...dir.split("/"), "route.ts"), "utf8");
      assert.deepEqual([...text.matchAll(/export const ([A-Z]+) =/g)].map((m) => m[1]), ["GET", "POST", "PUT", "PATCH", "DELETE"], dir);
      assert.ok(/process\.env\.PROMO_FEED_SECRET/.test(text), dir);
    }
  });
});

describe("the request: parameters", () => {
  test("defaults: both kinds, no filter, newest first, page 1 of 50", () => {
    const r = parse("");
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.query, { ...NONE, sort: "created_desc", page: 1, pageSize: PROMO_FEED_DEFAULT_PAGE_SIZE });
  });
  test("every filter is parsed", () => {
    const r = parse("kind=lead&q=%20shah%20%20paints%20&state=pl_st1&district=pl_d1&city=Rajkot&owner=u_1&salesManager=u_2&stage=new&sort=name_asc&page=3&pageSize=25");
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.query, { scope: "active", kind: "lead", q: "shah paints", state: "pl_st1", district: "pl_d1", city: "Rajkot", owner: "u_1", salesManager: "u_2", stage: "new", status: null, sort: "name_asc", page: 3, pageSize: 25 });
  });
  test("pageSize is at most 100, a whole number from 1", () => {
    assert.equal(PROMO_FEED_MAX_PAGE_SIZE, 100);
    assert.equal(parse("pageSize=100").ok, true);
    for (const bad of ["pageSize=0", "pageSize=101", "pageSize=-1", "pageSize=1.5", "pageSize=abc", "pageSize=", "pageSize=9999"]) assert.equal(parse(bad).ok, false, bad);
  });
  test("page is a whole number from 1 and bounded", () => {
    for (const bad of ["page=0", "page=-1", "page=1.5", "page=x", "page=", "page=100001", "page=9999999"]) assert.equal(parse(bad).ok, false, bad);
    assert.equal(parse("page=100000").ok, true);
  });
  test("unknown parameters are refused: the old limit and cursor, any attempt to widen, ask for fields or filter by phone", () => {
    for (const bad of ["limit=10", "cursor=abc", "fields=phone", "include=phone", "phone=9876543210", "email=a@b.c", "order=asc", "ownerId=u1", "deleted=1"]) assert.equal(parse(bad).ok, false, bad);
  });
  test("a repeated parameter is refused", () => {
    assert.equal(parse("kind=lead&kind=customer").ok, false);
    assert.equal(parse("q=a&q=b").ok, false);
  });
  test("ids are plain id characters only", () => {
    for (const key of ["state", "district", "owner", "salesManager"]) {
      for (const bad of ["a b", "a;b", "a'b", "a%27b", "a/b", "x".repeat(101), "<script>"]) assert.equal(parse(`${key}=${encodeURIComponent(bad)}`).ok, false, `${key}=${bad}`);
      assert.equal(parse(`${key}=ok_id-1`).ok, true);
    }
  });
  test("q and city are bounded and refuse control characters; blank means no filter", () => {
    assert.equal(parse(`q=${"a".repeat(101)}`).ok, false);
    assert.equal(parse(`q=${"a".repeat(100)}`).ok, true);
    assert.equal(parse("q=%00").ok, false);
    assert.equal(parse("q=a%0Ab").ok, false);
    assert.equal(parse(`city=${"a".repeat(101)}`).ok, false);
    const blank = parse("q=%20%20&city=%20");
    assert.ok(blank.ok);
    if (blank.ok) assert.deepEqual([blank.query.q, blank.query.city], [null, null]);
  });
  test("stage, status, kind and sort accept only known values", () => {
    for (const bad of ["stage=made_up", "stage=NEW", "status=gone", "kind=vendor", "kind=", "sort=owner"]) assert.equal(parse(bad).ok, false, bad);
    for (const ok of ["stage=lost", "stage=active_distributor", "status=inactive", "status=deactivated", "sort=created_asc", "sort=name_desc"]) assert.equal(parse(ok).ok, true, ok);
  });
  test("the facets request takes only scope and kind", () => {
    assert.equal(parsePromoFacetsQuery(new URL("http://x/f?kind=lead")).ok, true);
    for (const bad of ["q=a", "page=2", "owner=u1", "kind=vendor"]) assert.equal(parsePromoFacetsQuery(new URL(`http://x/f?${bad}`)).ok, false, bad);
  });
});

describe("search words and paging arithmetic", () => {
  test("LIKE wildcards and the escape character in a word are matched literally", () => {
    assert.equal(likePattern("50%"), "%50\\%%");
    assert.equal(likePattern("a_b"), "%a\\_b%");
    assert.equal(likePattern("a\\b"), "%a\\\\b%");
    assert.equal(likePattern("plain"), "%plain%");
  });
  test("at most five words of at most 60 characters are searched", () => {
    assert.deepEqual(searchTerms("a b c d e f g"), ["a", "b", "c", "d", "e"]);
    assert.equal(searchTerms("x".repeat(200))[0]!.length, 60);
    assert.deepEqual(searchTerms(""), []);
  });
  test("a page is clamped to the pages that exist; no records is one empty page", () => {
    assert.deepEqual(clampPage(0, 5, 50), { page: 1, pageCount: 1, offset: 0 });
    assert.deepEqual(clampPage(101, 3, 50), { page: 3, pageCount: 3, offset: 100 });
    assert.deepEqual(clampPage(101, 99, 50), { page: 3, pageCount: 3, offset: 100 });
    assert.deepEqual(clampPage(100, 2, 50), { page: 2, pageCount: 2, offset: 50 });
    assert.deepEqual(clampPage(100, 3, 50), { page: 2, pageCount: 2, offset: 50 });
    assert.deepEqual(clampPage(7, 1, 100), { page: 1, pageCount: 1, offset: 0 });
  });
  test("walking every page covers each of 237 records exactly once", () => {
    const seen: number[] = [];
    const first = clampPage(237, 1, 50);
    for (let p = 1; p <= first.pageCount; p++) {
      const { offset } = clampPage(237, p, 50);
      for (let i = offset; i < Math.min(237, offset + 50); i++) seen.push(i);
    }
    assert.deepEqual(seen, Array.from({ length: 237 }, (_, i) => i));
  });
});

describe("the SQL is built from bound parameters (query safety)", () => {
  const hostile = ["'; drop table customers; --", "\" or 1=1 --", "%", "_", "\\", "a%b_c", "Robert'); DELETE FROM customers;--", "𝒳", "<script>alert(1)</script>"];
  test("a search word never appears in the SQL text, only as a bound, escaped parameter", () => {
    for (const q of hostile) {
      const { sql, params } = render(promoWhere({ ...NONE, q }));
      for (const needle of ["drop table", "DELETE FROM", "1=1", "script"]) assert.ok(!sql.toLowerCase().includes(needle.toLowerCase()), `${needle} in sql for ${q}`);
      assert.ok(params.some((p) => typeof p === "string" && p.startsWith("%") && p.endsWith("%")), q);
    }
  });
  test("every other filter is a bound parameter too", () => {
    const { sql, params } = render(promoWhere({ ...NONE, kind: "lead", state: "st_1", district: "d_1", city: "O'Brien Town", owner: "u_1", salesManager: "u_2", stage: "new", status: "active" }));
    for (const v of ["st_1", "d_1", "O'Brien Town", "u_1", "u_2"]) {
      assert.ok(params.includes(v), v);
      assert.ok(!sql.includes(v), `${v} spliced into the SQL text`);
    }
  });
  test("with no filter only the trash, archived leads and lost leads are excluded; nothing restricts by owner, manager, status or source", () => {
    const { sql, params } = render(promoWhere(NONE));
    assert.match(sql, /"deleted_at" is null/);
    assert.deepEqual(params, ["customer", false, "lost"]);
    assert.ok(!/owner|sales_manager|sales_am|status|lead_source/.test(sql), sql);
  });
  test("archived and lost leads are always left out, for every kind and every filter; customers are never subject to it", () => {
    for (const f of [NONE, { ...NONE, kind: "lead" as const }, { ...NONE, kind: "customer" as const }, { ...NONE, stage: "lost" }, { ...NONE, q: "shah" }]) {
      const { sql } = render(promoWhere(f));
      assert.match(sql, /"customers"\."kind" = \$\d+ or \("customers"\."lead_archived" = \$\d+ and \("customers"\."lead_stage" is null or "customers"\."lead_stage" <> \$\d+\)\)/, JSON.stringify(f));
    }
    assert.ok(!/"status"/.test(render(promoWhere(NONE)).sql), "a deactivated or inactive customer is not filtered out");
  });
  test("a caller cannot ask for them: the parameter that used to allow it is refused, on the list and on the facets", () => {
    for (const qs of ["restricted=include", "restricted=exclude", "restricted="]) {
      assert.equal(parse(qs).ok, false, qs);
      assert.equal(parsePromoFacetsQuery(new URL(`http://x/f?${qs}`)).ok, false, qs);
    }
  });
  test("an owner filter uses the same display-owner rule the records are shown with", () => {
    const { sql } = render(promoWhere({ ...NONE, owner: "u_1" }));
    assert.match(sql, /case when "customers"\."kind" = 'lead' then "customers"\."owner_id" else coalesce\("customers"\."sales_am_id", "customers"\."owner_id"\) end = /);
  });
  test("a stage filter only ever matches leads, a status filter only customers", () => {
    assert.match(render(promoWhere({ ...NONE, stage: "new" })).sql, /"kind" = \$\d+ and "customers"\."lead_stage" = /);
    assert.match(render(promoWhere({ ...NONE, status: "inactive" })).sql, /"kind" = \$\d+ and "customers"\."status" = /);
  });
  test("every ordering ends on the id, so the order is total and pages do not overlap", () => {
    for (const sort of ["created_desc", "created_asc", "name_asc", "name_desc"] as const) {
      const parts = promoOrderBy(sort).map((p) => dialect.sqlToQuery(p).sql);
      assert.equal(parts.length, 2, sort);
      assert.match(parts[1]!, /"id"/, sort);
    }
  });
  test("a facets query uses the same eligibility, with no free-text or owner filter", () => {
    const { sql } = render(promoWhere({ ...NONE, kind: "customer" }));
    assert.match(sql, /"deleted_at" is null/);
  });
});

describe("the list and facets endpoints", () => {
  test("a good request returns the contract, a timestamp, the totals, the page and the allow-listed records", async () => {
    const res = await handlePromoFeedRequest(get("kind=customer&page=2&pageSize=25"), deps({ list: async (q) => ({ records: [shapePromoRecord(raw())], total: 61, page: q.page, pageCount: 3 }) }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body), ["ok", "contract", "generatedAt", "total", "page", "pageSize", "pageCount", "records"]);
    assert.deepEqual([body.contract, body.generatedAt, body.total, body.page, body.pageSize, body.pageCount], [PROMO_FEED_CONTRACT, "2026-10-09T10:00:00.000Z", 61, 2, 25, 3]);
  });
  test("the parsed query reaches the service exactly, and an invalid query never does", async () => {
    let seen: PromoFeedQuery | null = null;
    const d = deps({ list: async (q) => { seen = q; return { records: [], total: 0, page: 1, pageCount: 1 }; } });
    await handlePromoFeedRequest(get("q=shah&state=st_1&sort=name_desc&page=2&pageSize=10"), d);
    assert.deepEqual(seen, { ...NONE, q: "shah", state: "st_1", sort: "name_desc", page: 2, pageSize: 10 });
    seen = null;
    for (const bad of ["pageSize=101", "limit=5", "kind=vendor", "stage=made_up"]) {
      const res = await handlePromoFeedRequest(get(bad), d);
      assert.equal(res.status, 400, bad);
      assert.equal(seen, null);
    }
  });
  test("the facets endpoint returns the values, and says when a list was cut", async () => {
    const facets: PromoFacets = { ...EMPTY_FACETS, cities: [{ name: "Rajkot", count: 3 }], truncated: { ...EMPTY_FACETS.truncated, cities: true } };
    const res = await handlePromoFacetsRequest(get("kind=lead", undefined, "GET", "http://x/api/integrations/promo/v1/facets"), deps({ facets: async () => facets }));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { facets: PromoFacets; contract: string };
    assert.equal(body.contract, PROMO_FEED_CONTRACT);
    assert.deepEqual(body.facets.cities, [{ name: "Rajkot", count: 3 }]);
    assert.equal(body.facets.truncated.cities, true);
    assert.equal(PROMO_FACET_LIMIT, 500);
  });
  test("a failing service is 503 with a fixed message that names no table, column or value", async () => {
    const boom = async () => { throw new Error('relation "customers" does not exist (Shah Paints)'); };
    for (const d of [deps({ list: boom }), deps({ facets: boom })]) {
      const res = await (d.list === boom ? handlePromoFeedRequest(get(), d) : handlePromoFacetsRequest(get(), d));
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { ok: false, error: "The feed could not be read." });
    }
  });
  test("the server log of a failure carries the kind and a short code only, plus a missing column's name and nothing else", async () => {
    const lines: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void lines.push(args);
    try {
      const pw = Object.assign(new Error('password authentication failed for user "mahek" (Shah Paints)'), { code: "28P01" });
      await handlePromoFeedRequest(get(), deps({ list: async () => { throw pw; } }));
      const gap = Object.assign(new Error('column "customers.deleted_at" does not exist'), { code: "42703" });
      await handlePromoFeedRequest(get(), deps({ list: async () => { throw Object.assign(new Error("Failed query: select Shah Paints"), { cause: gap }); } }));
    } finally {
      console.error = original;
    }
    assert.equal(lines.length, 2);
    assert.ok(!/mahek|Shah|password/i.test(JSON.stringify(lines[0])));
    assert.ok(JSON.stringify(lines[1]).includes("deleted_at"));
    assert.ok(!/Shah|Failed query|select/i.test(JSON.stringify(lines[1])));
  });
  test("the secret never appears in any response", async () => {
    for (const d of [deps(), deps({ secret: undefined }), deps({ list: async () => { throw new Error(`boom ${SECRET}`); } })]) {
      assert.ok(!(await (await handlePromoFeedRequest(get(), d)).text()).includes(SECRET));
    }
  });
});

describe("a record by id", () => {
  const byId = (id: string, o: { qs?: string; headers?: Record<string, string>; deps?: Partial<PromoFeedDeps> } = {}) =>
    handlePromoRecordRequest(new Request(`${URL_BASE}/${id}${o.qs ? `?${o.qs}` : ""}`, { method: "GET", headers: o.headers ?? { authorization: `Bearer ${SECRET}` } }), id, deps(o.deps));

  test("returns the record with exactly the allow-listed fields, and the same record the list carries", async () => {
    const res = await byId("cus_1");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = (await res.json()) as { ok: boolean; contract: string; generatedAt: string; record: Record<string, unknown> };
    assert.deepEqual(Object.keys(body).sort(), ["contract", "generatedAt", "ok", "record"]);
    assert.deepEqual(Object.keys(body.record), [...PROMO_FEED_FIELDS]);
    assert.deepEqual(body.record, JSON.parse(JSON.stringify(shapePromoRecord(raw()))));
  });
  test("a field the service should not have returned is dropped before it leaves", async () => {
    const leaky = async () => ({ ...shapePromoRecord(raw()), phone: "9876543210", address: "12 Main Rd" }) as unknown as ReturnType<typeof shapePromoRecord>;
    const text = await (await byId("cus_1", { deps: { get: leaky } })).text();
    assert.ok(!/9876543210|12 Main/.test(text));
  });
  test("an id with no record, or one the feed does not show, is 404 and says nothing about why", async () => {
    const res = await byId("cus_missing");
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { ok: false, error: "There is no such record." });
  });
  test("an id that is not an id is 400 and is never passed to the service", async () => {
    let called = 0;
    for (const bad of ["a b", "x'; drop table customers; --", "..%2F..", "a".repeat(101), "%", "id.with.dots"]) {
      const res = await byId(bad, { deps: { get: async () => { called++; return null; } } });
      assert.equal(res.status, 400, bad);
    }
    assert.equal(called, 0);
  });
  test("a query string is refused: the path takes none", async () => {
    assert.equal((await byId("cus_1", { qs: "kind=lead" })).status, 400);
  });
  test("the same bearer rule: 401 without or with a wrong token, 503 with no secret configured, and nothing is read", async () => {
    let called = 0;
    const get = async () => { called++; return null; };
    assert.equal((await byId("cus_1", { headers: {}, deps: { get } })).status, 401);
    assert.equal((await byId("cus_1", { headers: { authorization: "Bearer nope" }, deps: { get } })).status, 401);
    assert.equal((await byId("cus_1", { deps: { secret: undefined, get } })).status, 503);
    assert.equal(called, 0);
  });
  test("a failing service is 503 with a fixed message, and the secret is not in the response", async () => {
    const res = await byId("cus_1", { deps: { get: async () => { throw new Error(`boom ${SECRET} Shah Paints`); } } });
    assert.equal(res.status, 503);
    const text = await res.text();
    assert.ok(!text.includes(SECRET) && !text.includes("Shah") && !text.includes("boom"));
  });
  test("the lookup uses the list's own rule: same columns, the trash rule, and the id as a bound parameter", () => {
    const text = source("services", "promo-feed-service.ts");
    assert.match(text, /export async function getPromoRecord/);
    assert.match(text, /\.select\(RECORD_COLUMNS\)[\s\S]*\.where\(where\)\s*\.limit\(1\)/);
    const { sql, params } = render(and(promoWhere(NONE), eq(customers.id, "x'; drop table customers; --"))!);
    assert.match(sql, /"deleted_at" is null/);
    assert.ok(params.includes("x'; drop table customers; --") && !sql.includes("drop table"));
  });
});

describe("what is in the trash", () => {
  test("a customer in the trash is left out of the list, its total and its facets, exactly as a lead is (one rule: promoWhere)", () => {
    const service = source("services", "promo-feed-service.ts");
    assert.equal([...service.matchAll(/promoWhere\(/g)].length, 3, "list, facets and lookup all use the one rule");
    for (const kind of ["lead", "customer"] as const) assert.match(render(promoWhere({ ...NONE, kind })).sql, /"deleted_at" is null/);
  });
  test("a deactivated or inactive customer is not trash: no status filter is applied unless asked for", () => {
    assert.ok(!/"status"/.test(render(promoWhere(NONE)).sql));
  });
});

describe("stage labels", () => {
  test("every stage the CRM defines has its own label, and the facets carry it beside the code", async () => {
    const { stageLabel } = await import("./lead-labels");
    const { mbosLeadStageEnum } = await import("@/db/schema");
    for (const code of mbosLeadStageEnum.enumValues) {
      const label = stageLabel(code);
      assert.ok(label && label !== code, code);
    }
    assert.equal(stageLabel("sample_trial"), "Sample / trial");
    assert.equal(stageLabel("first_order"), "1st order");
    assert.match(source("services", "promo-feed-service.ts"), /label: stageLabel\(r\.value as LeadStage\)/);
  });
});

describe("archived and lost leads: one rule for the list, the total, the facets and a lookup by id", () => {
  test("the list, the facets and the lookup all build their filter with the one promoWhere, which carries the rule", () => {
    const service = source("services", "promo-feed-service.ts");
    assert.equal([...service.matchAll(/promoWhere\(/g)].length, 3);
    assert.ok(!/[^A-Za-z](ne|isNull|or)\(/.test(service), "the service adds no filter of its own and drops none");
  });
  test("a lookup by id adds the id to that same rule, as a bound parameter", () => {
    const { sql, params } = render(and(promoWhere(NONE), eq(customers.id, "lead_archived_1"))!);
    assert.match(sql, /"lead_archived" = /);
    assert.match(sql, /"lead_stage" <> /);
    assert.ok(params.includes("lost") && params.includes("lead_archived_1") && !sql.includes("lead_archived_1"));
  });
  test("an archived or lost lead is 404 by id when the service does not return it, with nothing said about why", async () => {
    for (const flag of [{ archived: true }, { lost: true }]) {
      const res = await handlePromoRecordRequest(new Request(`${URL_BASE}/lead_x`, { headers: { authorization: `Bearer ${SECRET}` } }), "lead_x", deps({ get: async () => null }));
      assert.equal(res.status, 404, JSON.stringify(flag));
      assert.deepEqual(await res.json(), { ok: false, error: "There is no such record." });
    }
  });
  test("every record the list returns is not archived and not lost: the flags remain in the contract but are false", () => {
    const listed = shapePromoRecord(raw());
    assert.deepEqual([listed.archived, listed.lost, listed.trashed], [false, false, false]);
  });
});

describe("the lost scope (separate Lost Leads section)", () => {
  const lostWhere = (f: Partial<PromoFilters> = {}) => render(promoWhere({ ...NONE, scope: "lost", ...f }));

  test("the default is active, and an unknown scope is refused on the list, the facets and a record", async () => {
    const r = parse("");
    assert.ok(r.ok && r.query.scope === "active");
    for (const bad of ["scope=all", "scope=", "scope=LOST", "scope=archived", "scope=lost&scope=active"]) {
      assert.equal(parse(bad).ok, false, bad);
      assert.equal(parsePromoFacetsQuery(new URL(`http://x/f?${bad}`)).ok, false, bad);
    }
    assert.ok(parse("scope=lost").ok);
    assert.ok(parse("scope=active").ok);
  });
  test("scope=lost is leads only: customers, another stage or a customer status contradict it and are refused", () => {
    for (const bad of ["scope=lost&kind=customer", "scope=lost&stage=new", "scope=lost&stage=lost", "scope=lost&status=active"]) assert.equal(parse(bad).ok, false, bad);
    for (const ok of ["scope=lost&kind=lead", "scope=lost&q=shah&state=st_1&sort=name_asc&page=2"]) assert.equal(parse(ok).ok, true, ok);
  });
  test("the lost scope selects lost, unarchived, untrashed leads, with every value bound", () => {
    const { sql, params } = lostWhere();
    assert.match(sql, /"deleted_at" is null/);
    assert.match(sql, /"customers"\."kind" = \$\d+ and "customers"\."lead_archived" = \$\d+ and "customers"\."lead_stage" = \$\d+/);
    assert.deepEqual(params, ["lead", false, "lost"]);
    assert.ok(!/<>/.test(sql), "the lost scope never uses the active scope's exclusion");
  });
  test("the lost scope keeps the trash and archived leads out whatever else is asked, and filters still apply", () => {
    for (const f of [{}, { q: "shah" }, { state: "st_1", city: "Rajkot", owner: "u_1" }, { kind: "lead" as const }]) {
      const { sql, params } = lostWhere(f);
      assert.match(sql, /"deleted_at" is null/, JSON.stringify(f));
      assert.match(sql, /"lead_archived" = \$\d+/, JSON.stringify(f));
      assert.ok(params.includes("lost") && params.includes(false), JSON.stringify(f));
    }
    assert.ok(lostWhere({ owner: "u_1" }).params.includes("u_1"));
  });
  test("the active scope is byte-for-byte what it was: it still hides lost and archived leads", () => {
    const { sql, params } = render(promoWhere(NONE));
    assert.match(sql, /"customers"\."kind" = \$\d+ or \("customers"\."lead_archived" = \$\d+ and \("customers"\."lead_stage" is null or "customers"\."lead_stage" <> \$\d+\)\)/);
    assert.deepEqual(params, ["customer", false, "lost"]);
    assert.deepEqual(render(promoWhere({ ...NONE, scope: undefined as never })).params, params, "a missing scope can never widen to lost leads");
  });
  test("the scope reaches the service for the list, the facets and a record, and the default never reaches lost", async () => {
    let list: PromoFeedQuery | null = null;
    let facets: unknown = null;
    const seenScopes: string[] = [];
    const d = deps({
      list: async (q) => { list = q; return { records: [], total: 0, page: 1, pageCount: 1 }; },
      facets: async (q) => { facets = q; return EMPTY_FACETS; },
      get: async (_id, scope) => { seenScopes.push(scope); return scope === "lost" ? shapePromoRecord(raw({ leadStage: "lost" })) : null; },
    });
    await handlePromoFeedRequest(get("scope=lost"), d);
    assert.equal((list as PromoFeedQuery | null)?.scope, "lost");
    await handlePromoFeedRequest(get(""), d);
    assert.equal((list as PromoFeedQuery | null)?.scope, "active");
    await handlePromoFacetsRequest(get("scope=lost", undefined, "GET", "http://x/api/integrations/promo/v1/facets"), d);
    assert.deepEqual(facets, { kind: null, scope: "lost" });
    const rec = (qs: string) => handlePromoRecordRequest(new Request(`${URL_BASE}/cus_1${qs}`, { method: "GET", headers: { authorization: `Bearer ${SECRET}` } }), "cus_1", d);
    assert.equal((await rec("")).status, 404, "a lost lead is not found in the default scope");
    const found = await rec("?scope=lost");
    assert.equal(found.status, 200);
    assert.equal(((await found.json()) as { record: { lost: boolean } }).record.lost, true);
    assert.deepEqual(seenScopes, ["active", "lost"]);
    assert.equal((await rec("?scope=bogus")).status, 400);
    assert.equal((await rec("?kind=lead")).status, 400, "no other parameter is accepted on a record");
  });
  test("the record in the lost scope carries the same allow-listed fields and no contact detail", async () => {
    const res = await handlePromoRecordRequest(new Request(`${URL_BASE}/cus_1?scope=lost`, { method: "GET", headers: { authorization: `Bearer ${SECRET}` } }), "cus_1", deps({ get: async () => shapePromoRecord(raw({ leadStage: "lost" })) }));
    const body = (await res.json()) as { record: Record<string, unknown> };
    assert.deepEqual(Object.keys(body.record), [...PROMO_FEED_FIELDS]);
  });
});
