import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { PROMO_FEED_FIELDS } from "./promo-feed";
import { promoWhatsappTargetWhere } from "./promo-feed-sql";
import {
  PROMO_WHATSAPP_CONTRACT,
  PROMO_WHATSAPP_TARGET_FIELDS,
  RATE_LIMIT,
  chooseWhatsappNumber,
  createRateLimiter,
  handlePromoWhatsappTargetRequest,
  normalizeWhatsappNumber,
  withheldReason,
  shapeWhatsappTarget,
  type PromoWhatsappAudit,
  type PromoWhatsappDeps,
  type PromoWhatsappRow,
  type PromoWhatsappTarget,
} from "./promo-whatsapp-target";

// The WhatsApp target endpoint: who may ask, which lead may have a number, what counts as a number, that nothing else can carry one,
// and that nothing is written. Pure: no database, no framework. Every number here is fictional (+1 555 01xx is reserved for fiction).

const SECRET = "whatsapp-target-secret-for-tests-only";
const FEED_SECRET = "feed-secret-for-tests-only-different";
const NUMBER = "+15550100101";
const HERE = path.join(import.meta.dirname);
const SRC = path.resolve(HERE, "..");

const row = (o: Partial<PromoWhatsappRow> = {}): PromoWhatsappRow => ({ id: "cus_1", kind: "lead", leadStage: "lost", leadArchived: false, deletedAt: null, doNotContact: false, whatsappDnd: false, whatsappPhone: NUMBER, phone: "+15550100999", ...o });
const target = (o: Partial<PromoWhatsappTarget> = {}): PromoWhatsappTarget => ({ id: "cus_1", archived: false, lost: true, trashed: false, dnc: false, whatsappDnd: false, whatsapp: NUMBER, ...o });

const BASE = "http://x/api/integrations/promo/v1/recipients/cus_1/whatsapp-target";
const get = (qs = "scope=lost", headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }, method = "GET") => new Request(`${BASE}${qs ? `?${qs}` : ""}`, { method, headers });
const deps = (o: Partial<PromoWhatsappDeps> = {}): PromoWhatsappDeps => ({
  secret: SECRET,
  feedSecret: FEED_SECRET,
  target: async (id) => (id === "cus_1" ? target() : null),
  now: () => new Date("2026-10-21T10:00:00.000Z"),
  ...o,
});
const ask = (request: Request, d = deps(), id = "cus_1") => handlePromoWhatsappTargetRequest(request, id, d);
const body = async (r: Response) => (await r.json()) as Record<string, unknown>;

/** The code of a file without its comments, so a mention of a word in a comment is not read as use. */
const code = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("what counts as a number (the normalization rule)", () => {
  const ok = (raw: unknown, e164: string, via: string, options = {}) => assert.deepEqual(normalizeWhatsappNumber(raw, options), { ok: true, e164, via }, String(raw));
  const no = (raw: unknown, reason: string, options = {}) => assert.deepEqual(normalizeWhatsappNumber(raw, options), { ok: false, reason }, String(raw));

  test("a number with its own country code is accepted in every common way of writing it, and no country is assumed", () => {
    ok("+919876543210", "+919876543210", "international");
    ok("+91 98765 43210", "+919876543210", "international");
    ok("+91-98765-43210", "+919876543210", "international");
    ok("+91 (98765) 43210", "+919876543210", "international");
    ok("  +91.98765.43210  ", "+919876543210", "international");
    ok("+1 (555) 010-0123", "+15550100123", "international");
    ok("+44 7911 123456", "+447911123456", "international");
    ok("+971 50 123 4567", "+971501234567", "international");
    ok("+49 151 12345678", "+4915112345678", "international");
    ok("+1/555/010/0123", "+15550100123", "international");
  });
  test("the 00 international prefix is the same as +", () => {
    ok("0091 98765 43210", "+919876543210", "00-prefix");
    ok("0044 7911 123456", "+447911123456", "00-prefix");
    ok("00 1 555 010 0123", "+15550100123", "00-prefix");
  });
  test("the length rule is E.164: 8 to 15 digits after the +, the first not 0", () => {
    ok("+12345678", "+12345678", "international");
    ok("+123456789012345", "+123456789012345", "international");
    no("+1234567", "invalid");
    no("+1234567890123456", "invalid");
    no("+0123456789", "invalid");
    no("+", "invalid");
    no("+91", "invalid");
    no("0091", "invalid");
    no("00", "invalid");
    no("0012345", "invalid");
  });
  test("a local number is never given a country: without + or 00 there is no number", () => {
    for (const local of ["9876543210", "09876543210", "98765 43210", "(022) 2345 6789", "022-23456789", "5550100101", "2345678", "919876543210", "12025550100", "4915112345678"]) no(local, "no_country_code");
  });
  test("a number is never repaired, trimmed to fit, or completed", () => {
    for (const bad of ["+91 98765 4321O", "+91 98765 43210 ext 5", "+91 98765 43210, +91 98123 45678", "+91 98765 43210 / 98123 45678 x", "++919876543210", "+91+9876543210", "91+9876543210", "+91 98765 43210 !", "tel:+919876543210", "+91 98765\n43210", "+91 98765\t43210x"]) no(bad, "invalid");
  });
  test("digits from other scripts, control characters and oversized input are refused", () => {
    for (const bad of ["+٩١٩٨٧٦٥٤٣٢١٠", "+९१९८७६५४३२१०", "+91 98765 43210\u0000", "+91​9876543210", "+91 98765 43210‮", "+" + "9".repeat(60), "0".repeat(60), "+91 " + "98765 ".repeat(10)]) no(bad, "invalid");
  });
  test("anything that is not text, or is blank, is no number", () => {
    for (const empty of [null, undefined, 9876543210, {}, [], true]) no(empty, "empty");
    for (const blank of ["", "   ", "\t\n"]) no(blank, "empty");
  });
  test("a default country is OFF unless the owner names one; naming one never changes a number that has its own country code", () => {
    no("9876543210", "no_country_code");
    no("9876543210", "no_country_code", { defaultCountry: null });
    no("9876543210", "no_country_code", { defaultCountry: "" });
    no("9876543210", "no_country_code", { defaultCountry: "  " });
    ok("+15550100123", "+15550100123", "international", { defaultCountry: "91" });
    ok("0044 7911 123456", "+447911123456", "00-prefix", { defaultCountry: "91" });
  });
  test("with India chosen, a ten-digit mobile number (6 to 9 first) is read as +91, with at most one leading 0, and nothing else is guessed", () => {
    const india = { defaultCountry: "91" };
    ok("9876543210", "+919876543210", "default-country", india);
    ok("98765 43210", "+919876543210", "default-country", india);
    ok("09876543210", "+919876543210", "default-country", india);
    ok("6000000000", "+916000000000", "default-country", india);
    for (const bad of ["5876543210", "987654321", "98765432101", "009876543210x", "00987", "919876543210", "0919876543210", "(022) 2345 6789", "022-23456789", "1234567890"]) assert.equal(normalizeWhatsappNumber(bad, india).ok, false, bad);
    no("919876543210", "invalid", india); // 12 digits: not read as +91, and not a ten-digit national number
  });
  test("a default country that has no written rule is ignored, loudly: nothing is guessed for any country but India", () => {
    for (const unsupported of ["1", "44", "971", "49", "999", "abc", "+91", "0091", "9", "9111", "091"]) {
      const r = normalizeWhatsappNumber("9876543210", { defaultCountry: unsupported });
      assert.deepEqual(r, { ok: false, reason: "unsupported_default_country" }, unsupported);
    }
    // stray spaces around the configured value are trimmed, not treated as a different country
    assert.equal(normalizeWhatsappNumber("9876543210", { defaultCountry: " 91 " }).ok, true);
    no("5550100123", "unsupported_default_country", { defaultCountry: "1" });
  });
});

describe("which stored number is used", () => {
  test("the WhatsApp number wins; the phone is used only when there is no WhatsApp number at all", () => {
    assert.equal(chooseWhatsappNumber({ whatsappPhone: "+15550100101", phone: "+15550100999" }), "+15550100101");
    assert.equal(chooseWhatsappNumber({ whatsappPhone: null, phone: "+15550100999" }), "+15550100999");
    assert.equal(chooseWhatsappNumber({ whatsappPhone: "", phone: "+15550100999" }), "+15550100999");
    assert.equal(chooseWhatsappNumber({ whatsappPhone: "   ", phone: "+15550100999" }), "+15550100999");
  });
  test("a WhatsApp number that is there but unusable gives NO number: the phone is not used instead", () => {
    assert.equal(chooseWhatsappNumber({ whatsappPhone: "9876543210", phone: "+15550100999" }), null);
    assert.equal(chooseWhatsappNumber({ whatsappPhone: "not a number", phone: "+15550100999" }), null);
    assert.equal(chooseWhatsappNumber({ whatsappPhone: "+123", phone: "+15550100999" }), null);
  });
  test("no number, or a local-only phone with no default country, gives none", () => {
    assert.equal(chooseWhatsappNumber({ whatsappPhone: null, phone: null }), null);
    assert.equal(chooseWhatsappNumber({ whatsappPhone: null, phone: "9876543210" }), null);
    assert.equal(chooseWhatsappNumber({ whatsappPhone: null, phone: "9876543210" }, { defaultCountry: "91" }), "+919876543210");
    assert.equal(chooseWhatsappNumber({ whatsappPhone: null, phone: "9876543210" }, { defaultCountry: "44" }), null);
  });
});

describe("which lead may have a number (decided on the row read now)", () => {
  test("an eligible lost lead gets its number, and exactly the allow-listed fields", () => {
    const t = shapeWhatsappTarget(row());
    assert.deepEqual(t, { id: "cus_1", archived: false, lost: true, trashed: false, dnc: false, whatsappDnd: false, whatsapp: NUMBER });
    assert.deepEqual(Object.keys(t), [...PROMO_WHATSAPP_TARGET_FIELDS]);
  });
  test("each restriction on its own withholds the number, and the flags say why", () => {
    const cases: [string, Partial<PromoWhatsappRow>, Partial<PromoWhatsappTarget>][] = [
      ["Do Not Contact", { doNotContact: true }, { dnc: true }],
      ["WhatsApp DND", { whatsappDnd: true }, { whatsappDnd: true }],
      ["trashed", { deletedAt: new Date("2026-10-01T00:00:00Z") }, { trashed: true }],
      ["trashed (as text)", { deletedAt: "2026-10-01T00:00:00Z" }, { trashed: true }],
      ["archived", { leadArchived: true }, { archived: true }],
      ["not lost", { leadStage: "new" }, { lost: false }],
      ["no stage", { leadStage: null }, { lost: false }],
      ["a customer", { kind: "customer", leadStage: null, leadArchived: null }, { lost: false, archived: true }],
    ];
    for (const [name, patch, flags] of cases) {
      const t = shapeWhatsappTarget(row(patch));
      assert.equal(t.whatsapp, null, name);
      for (const [k, v] of Object.entries(flags)) assert.equal(t[k as keyof PromoWhatsappTarget], v, `${name}: ${k}`);
    }
  });
  test("a flag that is missing or not a clear value fails closed: it withholds the number rather than releasing it", () => {
    for (const patch of [{ leadArchived: null }, { doNotContact: null }, { whatsappDnd: null }, { leadArchived: undefined as never }, { doNotContact: undefined as never }, { whatsappDnd: undefined as never }]) {
      assert.equal(shapeWhatsappTarget(row(patch)).whatsapp, null, JSON.stringify(patch));
    }
    assert.equal(shapeWhatsappTarget(row({ leadArchived: null })).archived, true);
    assert.equal(shapeWhatsappTarget(row({ doNotContact: null })).dnc, true);
  });
  test("a restricted lead's number is not in the answer even though one is stored", () => {
    for (const patch of [{ doNotContact: true }, { whatsappDnd: true }, { doNotContact: true, whatsappDnd: true }]) {
      const t = shapeWhatsappTarget(row(patch));
      assert.equal(t.whatsapp, null);
      assert.ok(!JSON.stringify(t).includes("5550100"), "no digits of either stored number");
    }
  });
  test("an eligible lead with no usable number gets null (and the app says there is no number on file)", () => {
    assert.equal(shapeWhatsappTarget(row({ whatsappPhone: null, phone: null })).whatsapp, null);
    assert.equal(shapeWhatsappTarget(row({ whatsappPhone: "98765", phone: "+15550100999" })).whatsapp, null);
    assert.equal(shapeWhatsappTarget(row({ whatsappPhone: null, phone: "9876543210" })).whatsapp, null, "a local number, no default country");
    assert.equal(shapeWhatsappTarget(row({ whatsappPhone: null, phone: "9876543210" }), { defaultCountry: "91" }).whatsapp, "+919876543210");
  });
});

describe("who may ask (fail closed)", () => {
  test("no secret configured closes the endpoint with 503 and no data, and the service is never called", async () => {
    let called = 0;
    const d = deps({ secret: undefined, target: async () => { called++; return target(); } });
    for (const secret of [undefined, null, ""]) {
      const r = await ask(get(), { ...d, secret });
      assert.equal(r.status, 503);
      assert.ok(!JSON.stringify(await r.json()).includes("5550100"));
    }
    assert.equal(called, 0);
  });
  test("a missing, malformed or wrong bearer token is 401, and a feed-secret holder cannot read a number", async () => {
    let called = 0;
    const d = deps({ target: async () => { called++; return target(); } });
    for (const headers of [{}, { authorization: "" }, { authorization: SECRET }, { authorization: `Basic ${SECRET}` }, { authorization: "Bearer " }, { authorization: "Bearer wrong" }, { authorization: `bearer ${SECRET}` }, { authorization: `Bearer ${FEED_SECRET}` }] as Record<string, string>[]) {
      const r = await ask(get("scope=lost", headers), d);
      assert.equal(r.status, 401, JSON.stringify(headers));
      assert.deepEqual(await r.json(), { ok: false, error: "Not authorised." });
    }
    assert.equal(called, 0);
  });
  test("a same-length wrong token and a different-length one are refused alike", async () => {
    assert.equal((await ask(get("scope=lost", { authorization: `Bearer ${"x".repeat(SECRET.length)}` }))).status, 401);
    assert.equal((await ask(get("scope=lost", { authorization: "Bearer x" }))).status, 401);
  });
  test("if the endpoint's secret is the same value as the feed secret, it refuses to answer", async () => {
    let called = 0;
    const r = await ask(get("scope=lost", { authorization: `Bearer ${SECRET}` }), deps({ feedSecret: SECRET, target: async () => { called++; return target(); } }));
    assert.equal(r.status, 503);
    assert.equal(called, 0);
    assert.equal((await ask(get(), deps({ feedSecret: undefined }))).status, 200, "an unset feed secret is not a clash");
  });
  test("an unauthenticated request with an invalid query is still 401: it learns nothing about the query", async () => {
    const r = await ask(get("scope=nonsense&phone=1", {}));
    assert.equal(r.status, 401);
  });
  test("the secret never appears in any response", async () => {
    for (const r of [await ask(get()), await ask(get("scope=lost", {})), await ask(get("scope=active")), await ask(get(), deps({ secret: undefined })), await ask(get("scope=lost", { authorization: "Bearer wrong" }))]) {
      const text = await r.text();
      assert.ok(!text.includes(SECRET) && !text.includes(FEED_SECRET));
    }
  });
});

describe("read only", () => {
  test("every method but GET is 405 with Allow: GET, before anything is checked or read", async () => {
    let called = 0;
    const d = deps({ target: async () => { called++; return target(); } });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const r = await ask(new Request(`${BASE}?scope=lost`, { method, headers: { authorization: `Bearer ${SECRET}` }, body: "{}" }), d);
      assert.equal(r.status, 405, method);
      assert.equal(r.headers.get("allow"), "GET");
    }
    assert.equal(called, 0);
  });
  test("the service contains no insert, update, delete or transaction", () => {
    const text = code("lib", "services", "promo-whatsapp-target-service.ts");
    assert.ok(/\.select\(/.test(text));
    for (const forbidden of [/\.insert\(/, /\.update\(/, /\.delete\(/, /\.execute\(/, /\.transaction\(/, /onConflict/i, /sql`/]) assert.ok(!forbidden.test(text), String(forbidden));
  });
});

describe("the request", () => {
  test("the scope must be named and must be lost; nothing else is accepted, and nothing reaches the service", async () => {
    let called = 0;
    const d = deps({ target: async () => { called++; return target(); } });
    for (const qs of ["", "scope=", "scope=active", "scope=LOST", "scope=all", "scope=lost&scope=lost", "scope=lost&kind=lead", "scope=lost&fields=phone", "scope=lost&include=phone", "scope=lost&phone=1", "scope=lost&q=a", "scope=lost&page=1", "scope=lost&format=full", "kind=lead", "restricted=include&scope=lost"]) {
      const r = await ask(get(qs), d);
      assert.equal(r.status, 400, qs);
    }
    assert.equal(called, 0);
  });
  test("an id that is not an id is 400 and is never passed to the service", async () => {
    let called = 0;
    const d = deps({ target: async () => { called++; return target(); } });
    for (const bad of ["a b", "x'; drop table customers; --", "..%2F..", "a".repeat(101), "%", "id.with.dots", "", "a/b", "id\u0000"]) assert.equal((await ask(get(), d, bad)).status, 400, bad);
    assert.equal(called, 0);
  });
  test("a good request reads the target once, passes the default country on, and nothing else", async () => {
    const calls: unknown[][] = [];
    const d = deps({ defaultCountry: "91", target: async (...a) => { calls.push(a); return target(); } });
    assert.equal((await ask(get(), d)).status, 200);
    assert.deepEqual(calls, [["cus_1", { defaultCountry: "91" }]]);
  });
});

describe("the answer", () => {
  test("it carries the contract, a timestamp and the allow-listed target, and is never stored", async () => {
    const r = await ask(get());
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    const b = await body(r);
    assert.deepEqual(Object.keys(b), ["ok", "contract", "generatedAt", "target"]);
    assert.deepEqual([b.ok, b.contract, b.generatedAt], [true, PROMO_WHATSAPP_CONTRACT, "2026-10-21T10:00:00.000Z"]);
    assert.deepEqual(Object.keys(b.target as object), [...PROMO_WHATSAPP_TARGET_FIELDS]);
    assert.equal((b.target as { whatsapp: string }).whatsapp, NUMBER);
  });
  test("the number is in the body only: no header carries it", async () => {
    const r = await ask(get());
    assert.ok(![...r.headers.entries()].some(([, v]) => v.includes("5550100")));
  });
  test("whatever the service returns beyond the contract is dropped before it leaves", async () => {
    const leaky = async () => ({ ...target(), phone: "+15550100999", address: "12 Main Rd", gstin: "24AAAAA0000A1Z5", contactPerson: "Asha", whatsappPhone: "+15550100101", creditLimitPaise: 5_000_000 }) as unknown as PromoWhatsappTarget;
    const text = await (await ask(get(), deps({ target: leaky }))).text();
    for (const secret of ["5550100999", "Main Rd", "24AAAAA", "Asha", "creditLimit", "gpsLat", '"phone"', '"whatsappPhone"']) assert.ok(!text.includes(secret), secret);
    assert.deepEqual(Object.keys(((await (await ask(get(), deps({ target: leaky }))).json()) as { target: object }).target), [...PROMO_WHATSAPP_TARGET_FIELDS]);
  });
  test("a lead the lost scope does not have is 404 and says nothing about why", async () => {
    const r = await ask(get(), deps(), "cus_missing");
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { ok: false, error: "There is no such record." });
  });
  test("a restricted lead is answered with its flags and no number", async () => {
    const t = shapeWhatsappTarget(row({ doNotContact: true }));
    const b = await body(await ask(get(), deps({ target: async () => t })));
    assert.equal((b.target as PromoWhatsappTarget).whatsapp, null);
    assert.equal((b.target as PromoWhatsappTarget).dnc, true);
  });
});

describe("failures", () => {
  test("a service that fails is 503 with a fixed message that names no table, column or value", async () => {
    const boom = Object.assign(new Error('column "whatsapp_phone" of relation "customers" does not exist: +15550100101'), { code: "42703" });
    const r = await ask(get(), deps({ target: async () => { throw boom; } }));
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { ok: false, error: "The target could not be read." });
  });
  test("the server log of a failure holds the kind of failure and a short code, never the message or a number", async () => {
    const lines: string[] = [];
    const saved = console.error;
    console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      await ask(get(), deps({ target: async () => { throw Object.assign(new Error("failed for +15550100101 at 12 Main Rd"), { code: "08006" }); } }));
    } finally {
      console.error = saved;
    }
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^promo-whatsapp-target: read failed Error 08006$/);
    assert.ok(!/5550100|Main Rd/.test(lines[0]!));
  });
  test("a failure that carries no code and is not an Error is still handled", async () => {
    const saved = console.error;
    console.error = () => undefined;
    try {
      assert.equal((await ask(get(), deps({ target: async () => { throw "plain text with +15550100101"; } }))).status, 503);
    } finally {
      console.error = saved;
    }
  });
});

describe("the rate limit", () => {
  test("at most the limit in a minute, then 429 with Retry-After, and the service is not called for a refused request", async () => {
    let called = 0;
    const now = { t: 1_000_000 };
    const d = deps({ limiter: createRateLimiter({ max: 3, now: () => now.t }), target: async () => { called++; return target(); } });
    for (let i = 0; i < 3; i++) assert.equal((await ask(get(), d)).status, 200);
    const refused = await ask(get(), d);
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get("retry-after"), "60");
    assert.equal(called, 3);
    now.t += 60_001;
    assert.equal((await ask(get(), d)).status, 200, "the window moves on");
  });
  test("a request that is not authorised does not use up the allowance", async () => {
    const d = deps({ limiter: createRateLimiter({ max: 2 }) });
    for (let i = 0; i < 20; i++) await ask(get("scope=lost", { authorization: "Bearer wrong" }), d);
    assert.equal((await ask(get(), d)).status, 200);
    assert.equal((await ask(get(), d)).status, 200);
    assert.equal((await ask(get(), d)).status, 429);
  });
  test("the default is thirty a minute", () => {
    assert.equal(RATE_LIMIT, 30);
    const l = createRateLimiter();
    for (let i = 0; i < 30; i++) assert.equal(l.allow(), true);
    assert.equal(l.allow(), false);
  });
});

describe("the query selects only a lost, unarchived, untrashed lead, by id, with bound values", () => {
  const dialect = new PgDialect();
  test("lost scope plus the id, every value a bound parameter", () => {
    const where = promoWhatsappTargetWhere("cus_1");
    assert.ok(where);
    const { sql, params } = dialect.sqlToQuery(where);
    assert.match(sql, /"deleted_at" is null/);
    assert.match(sql, /"customers"\."kind" = \$\d+ and "customers"\."lead_archived" = \$\d+ and "customers"\."lead_stage" = \$\d+/);
    assert.match(sql, /"customers"\."id" = \$\d+/);
    assert.ok(!/<>/.test(sql), "never the active scope's exclusion");
    assert.deepEqual(params.map(String).sort(), ["cus_1", "false", "lead", "lead", "lost"]); // the kind filter and the lost-scope clause each bind "lead"
    assert.ok(!sql.includes("cus_1"), "the id is not in the SQL text");
  });
  test("a hostile id is a bound parameter, never part of the SQL text", () => {
    for (const hostile of ["'; drop table customers; --", "\" or 1=1 --", "x' or '1'='1"]) {
      const { sql, params } = dialect.sqlToQuery(promoWhatsappTargetWhere(hostile)!);
      assert.ok(params.includes(hostile));
      assert.ok(!sql.includes(hostile) && !/drop table|1=1/i.test(sql));
    }
  });
});

describe("a number can leave through this endpoint and no other", () => {
  const phoneWords = /\b(?:whatsappPhone|whatsapp_phone|paymentWhatsappPhone)\b|customers\.phone\b/;

  test("only the WhatsApp target code reads a phone column; the list, facets, by-id and SQL code do not", () => {
    const readers = ["lib/promo-feed.ts", "lib/promo-feed-sql.ts", "lib/services/promo-feed-service.ts", "lib/services/promo-whatsapp-target-service.ts"].filter((f) => phoneWords.test(code(...f.split("/"))));
    assert.deepEqual(readers, ["lib/services/promo-whatsapp-target-service.ts"]);
  });
  test("every route of the promo feed other than the WhatsApp target ignores the number code, and has its own file", () => {
    const base = ["app", "api", "integrations", "promo", "v1"];
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name === "route.ts" ? [path.join(dir, e.name)] : []));
    const routes = walk(path.join(SRC, ...base)).map((f) => path.relative(path.join(SRC, ...base), f).replace(/\\/g, "/")).sort();
    assert.deepEqual(routes, ["facets/route.ts", "recipients/[id]/route.ts", "recipients/[id]/whatsapp-target/route.ts", "recipients/route.ts"]);
    for (const r of routes) {
      const text = fs.readFileSync(path.join(SRC, ...base, ...r.split("/")), "utf8");
      assert.deepEqual([...text.matchAll(/export const ([A-Z]+) =/g)].map((m) => m[1]), ["GET", "POST", "PUT", "PATCH", "DELETE"], r);
      const isTarget = r.endsWith("whatsapp-target/route.ts");
      assert.equal(/promo-whatsapp-target/.test(text), isTarget, `${r}: only the target route imports the number code`);
      assert.ok(isTarget ? /process\.env\.PROMO_WHATSAPP_TARGET_SECRET/.test(text) && !/secret: process\.env\.PROMO_FEED_SECRET/.test(text) : /process\.env\.PROMO_FEED_SECRET/.test(text), `${r}: the secret it uses`);
    }
  });
  test("the feed's own contract still names no phone, and a record the feed shapes has no WhatsApp field", () => {
    for (const field of PROMO_FEED_FIELDS) assert.ok(!/phone|mobile|whatsapp(?!Dnd)/i.test(field), field);
    assert.deepEqual([...PROMO_WHATSAPP_TARGET_FIELDS], ["id", "archived", "lost", "trashed", "dnc", "whatsappDnd", "whatsapp"]);
  });
  test("the service reads exactly these columns, and the number columns only here", () => {
    const text = code("lib", "services", "promo-whatsapp-target-service.ts");
    const used = [...new Set([...text.matchAll(/customers\.([A-Za-z]+)/g)].map((m) => m[1]))].sort();
    assert.deepEqual(used, ["deletedAt", "doNotContact", "id", "kind", "leadArchived", "leadStage", "phone", "whatsappDnd", "whatsappPhone"]);
  });
  test("the number code writes exactly two kinds of log line: the kind of a failure, and the audit line (codes and an opaque id)", () => {
    const text = code("lib", "promo-whatsapp-target.ts") + code("lib", "services", "promo-whatsapp-target-service.ts") + code("app", "api", "integrations", "promo", "v1", "recipients", "[id]", "whatsapp-target", "route.ts");
    const logs = [...text.matchAll(/console\.(log|warn|error|info|debug)\(([^;]*)\);/g)].map((m) => m[0]);
    assert.equal(logs.length, 2);
    assert.ok(logs.some((l) => /"promo-whatsapp-target: read failed", e instanceof Error \? e\.name : "error", code/.test(l)));
    assert.ok(logs.some((l) => /console\.info\(JSON\.stringify\(\{ event: "promo_whatsapp_target", time: new Date\(\)\.toISOString\(\), \.\.\.event \}\)\)/.test(l)), "the audit line is the event and a time, nothing added");
  });
  test("the env names it reads are the ones documented in both example files", () => {
    const route = fs.readFileSync(path.join(SRC, "app", "api", "integrations", "promo", "v1", "recipients", "[id]", "whatsapp-target", "route.ts"), "utf8");
    const names = [...new Set([...route.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]!))].sort();
    assert.deepEqual(names, ["PROMO_FEED_SECRET", "PROMO_WHATSAPP_DEFAULT_COUNTRY", "PROMO_WHATSAPP_TARGET_SECRET"]);
    for (const file of [".env.example", ".env.production.example"]) {
      const text = fs.readFileSync(path.join(SRC, "..", file), "utf8");
      for (const n of names) assert.ok(new RegExp(`^#?\\s*${n}=`, "m").test(text), `${file} documents ${n}`);
    }
  });
});

describe("the access trail (privacy-safe audit)", () => {
  const collect = () => {
    const events: PromoWhatsappAudit[] = [];
    return { events, d: (o: Partial<PromoWhatsappDeps> = {}) => deps({ audit: (e) => void events.push(e), ...o }) };
  };

  test("a released number is recorded as released, with the opaque id and no number", async () => {
    const { events, d } = collect();
    await ask(get(), d());
    assert.deepEqual(events, [{ outcome: "released", reason: "eligible", lead: "cus_1" }]);
  });
  test("each reason a number is withheld is a code from the flags, never from the number", async () => {
    const cases: [string, Partial<PromoWhatsappTarget>, string][] = [
      ["dnc", { whatsapp: null, dnc: true }, "dnc"],
      ["whatsapp dnd", { whatsapp: null, whatsappDnd: true }, "whatsapp_dnd"],
      ["trashed", { whatsapp: null, trashed: true }, "ineligible"],
      ["archived", { whatsapp: null, archived: true }, "ineligible"],
      ["not lost", { whatsapp: null, lost: false }, "ineligible"],
      ["no usable number", { whatsapp: null }, "no_number"],
    ];
    for (const [name, patch, reason] of cases) {
      const { events, d } = collect();
      await ask(get(), d({ target: async () => target(patch) }));
      assert.deepEqual(events, [{ outcome: "withheld", reason, lead: "cus_1" }], name);
      assert.equal(withheldReason(target(patch)), reason);
    }
  });
  test("a record the lost scope does not have is recorded as not found; a failing read as failed", async () => {
    const a = collect();
    await ask(get(), a.d(), "cus_missing");
    assert.deepEqual(a.events, [{ outcome: "not_found", reason: "no_such_lost_lead", lead: "cus_missing" }]);
    const b = collect();
    const saved = console.error;
    console.error = () => undefined;
    try {
      await ask(get(), b.d({ target: async () => { throw new Error("boom +15550100101"); } }));
    } finally {
      console.error = saved;
    }
    assert.deepEqual(b.events, [{ outcome: "failed", reason: "read_failed", lead: "cus_1" }]);
  });
  test("every refusal is recorded with a code; an unauthorized or unconfigured request carries NO id at all", async () => {
    const run = async (request: Request, o: Partial<PromoWhatsappDeps> = {}, id = "cus_1") => {
      const { events, d } = collect();
      await ask(request, d(o), id);
      return events;
    };
    assert.deepEqual(await run(new Request(`${BASE}?scope=lost`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } })), [{ outcome: "refused", reason: "method" }]);
    assert.deepEqual(await run(get("scope=lost", { authorization: "Bearer wrong" })), [{ outcome: "refused", reason: "unauthorized" }]);
    assert.deepEqual(await run(get(), { secret: undefined }), [{ outcome: "refused", reason: "not_configured" }]);
    assert.deepEqual(await run(get(), { feedSecret: SECRET }), [{ outcome: "refused", reason: "same_secret" }]);
    assert.deepEqual(await run(get(), { limiter: { allow: () => false } }), [{ outcome: "refused", reason: "rate_limited" }]);
    assert.deepEqual(await run(get("scope=active")), [{ outcome: "refused", reason: "bad_request", lead: "cus_1" }]);
    assert.deepEqual(await run(get("scope=lost&phone=1")), [{ outcome: "refused", reason: "bad_request", lead: "cus_1" }]);
    assert.deepEqual(await run(get(), {}, "x'; drop table customers; --"), [{ outcome: "refused", reason: "bad_request" }], "a hostile id is never written to the trail");
  });
  test("nothing in any recorded line holds a number, a secret or request text, across every outcome", async () => {
    const { events, d } = collect();
    for (const request of [get(), get("scope=lost", { authorization: `Bearer ${FEED_SECRET}` }), get("scope=lost&x=%2B15550100101"), get("scope=lost", {}, "POST")]) await ask(request, d());
    await ask(get(), d({ target: async () => target({ whatsapp: null, dnc: true }) }));
    const text = JSON.stringify(events);
    for (const secret of [SECRET, FEED_SECRET, "5550100", "+1", "Bearer", "x=", "phone", "whatsapp\":\"+"]) assert.ok(!text.includes(secret), secret);
    assert.ok(events.length >= 4);
    for (const e of events) assert.deepEqual(Object.keys(e).filter((k) => !["outcome", "reason", "lead"].includes(k)), []);
  });
  test("a broken audit sink never changes what the caller is told", async () => {
    const r = await ask(get(), deps({ audit: () => { throw new Error("sink down"); } }));
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as { target: { whatsapp: string } }).target.whatsapp, NUMBER);
  });
  test("with no sink at all the endpoint works as before", async () => {
    assert.equal((await ask(get(), deps())).status, 200);
  });
});
