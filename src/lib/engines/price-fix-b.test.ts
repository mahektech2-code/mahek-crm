import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  lineageRoot,
  listValidity,
  rateAtQuantity,
  rateFromCandidates,
  resolvePriceList,
  type CustomerGeo,
  type ListMeta,
  type ResolveOptions,
  type ScopeRow,
} from "./price-resolution";
import type { SlabRate } from "./price-math";

/* ---------------------------------------------------------------------------
 * How a price is RESOLVED and READ: the candidate chain and its per-product
 * fall-through, validity that the screens and the resolver agree on, versions
 * resolved as of a date, ties that do not depend on row order, and a list's
 * lineage for "has their list changed".
 * ------------------------------------------------------------------------- */

const TODAY = "2026-09-21";
const KEEP: ResolveOptions = { expiredListsKeepPricing: true, defaultValidityDays: 30 };
const STOP: ResolveOptions = { expiredListsKeepPricing: false, defaultValidityDays: 30 };

function list(partial: Partial<ListMeta> & { id: string }): ListMeta {
  return {
    name: partial.id,
    status: "published",
    effectiveFrom: "2026-09-01",
    effectiveTo: null,
    freightTerm: "not_stated",
    version: 1,
    validityDays: 365,
    ...partial,
  };
}

function scope(partial: Partial<ScopeRow> & { id: string; priceListId: string; scopeKind: ScopeRow["scopeKind"] }): ScopeRow {
  return {
    scopeValue: "",
    parentKey: "",
    freightTermMatch: "any",
    priority: 0,
    validFrom: null,
    validTo: null,
    ...partial,
  };
}

const geo = (partial: Partial<CustomerGeo> = {}): CustomerGeo => ({
  customerId: "C_shop",
  salesmanIds: [],
  beatKeys: [],
  areaKeys: [],
  cityKeys: [],
  districtKeys: [],
  stateKeys: ["maharashtra"],
  customerType: null,
  freightTerm: null,
  ...partial,
});

type Row = SlabRate & { productId: string; tag: string };
const row = (productId: string, rate: number, tag: string, extra: Partial<Row> = {}): Row => ({
  productId,
  rateExGstPaise: rate,
  minCans: null,
  maxCans: null,
  offered: true,
  tag,
  ...extra,
});

describe("the candidate chain", () => {
  const lists = [list({ id: "L_agreed", name: "Bharat — agreed prices" }), list({ id: "L_mh", name: "Pan Maharashtra" }), list({ id: "L_all" })];
  const scopes = [
    scope({ id: "s1", priceListId: "L_agreed", scopeKind: "customer", scopeValue: "C_shop" }),
    scope({ id: "s2", priceListId: "L_mh", scopeKind: "state", scopeValue: "maharashtra" }),
    scope({ id: "s3", priceListId: "L_all", scopeKind: "everybody" }),
  ];

  test("lists every list naming the shop, narrowest first, winner first", () => {
    const r = resolvePriceList(geo(), scopes, lists, TODAY, KEEP)!;
    assert.equal(r.listId, "L_agreed");
    assert.deepEqual(
      r.candidates.map((c) => c.listId),
      ["L_agreed", "L_mh", "L_all"],
    );
    // The chain of reasons still stops at the winning kind.
    assert.equal(r.chain.at(-1)?.kind, "customer");
  });

  test("a one-rate agreed list adds to the shop's prices instead of replacing them (B1)", () => {
    const r = resolvePriceList(geo(), scopes, lists, TODAY, KEEP)!;
    const rows: Record<string, Row[]> = {
      L_agreed: [row("P_nano20", 180_000, "agreed")],
      L_mh: [row("P_nano20", 193_300, "mh"), row("P_nano5", 50_000, "mh")],
      L_all: [row("P_pu1", 9_000, "all")],
    };
    const rowsOf = (product: string) => (listId: string) => (rows[listId] ?? []).filter((x) => x.productId === product);

    const nano20 = rateFromCandidates(r.candidates, rowsOf("P_nano20"))!;
    assert.equal(nano20.listId, "L_agreed");
    assert.equal(nano20.row?.rateExGstPaise, 180_000);
    assert.equal(nano20.fellThrough, false);

    const nano5 = rateFromCandidates(r.candidates, rowsOf("P_nano5"))!;
    assert.equal(nano5.listId, "L_mh");
    assert.equal(nano5.listName, "Pan Maharashtra");
    assert.equal(nano5.row?.rateExGstPaise, 50_000);
    assert.equal(nano5.fellThrough, true);

    const pu = rateFromCandidates(r.candidates, rowsOf("P_pu1"))!;
    assert.equal(pu.listId, "L_all");

    assert.equal(rateFromCandidates(r.candidates, rowsOf("P_unknown")), null);
  });

  test("a dash on a nearer list is an answer and does not fall through to a wider list", () => {
    const r = resolvePriceList(geo(), scopes, lists, TODAY, KEEP)!;
    const rows: Record<string, Row[]> = {
      L_agreed: [row("P_x", 0, "agreed", { offered: false })],
      L_mh: [row("P_x", 77_000, "mh")],
    };
    const got = rateFromCandidates(r.candidates, (id) => rows[id] ?? [])!;
    assert.equal(got.listId, "L_agreed");
    assert.equal(got.offered, false);
    assert.equal(got.row, null);
  });

  test("a list naming the shop twice appears once", () => {
    const twice = [...scopes, scope({ id: "s4", priceListId: "L_mh", scopeKind: "everybody" })];
    const r = resolvePriceList(geo(), twice, lists, TODAY, KEEP)!;
    assert.deepEqual(
      r.candidates.map((c) => c.listId),
      ["L_agreed", "L_mh", "L_all"],
    );
  });
});

describe("slabs by quantity (B20)", () => {
  const slabs: Row[] = [
    row("P", 100_000, "base"),
    row("P", 95_000, "10+", { minCans: 10 }),
    row("P", 90_000, "50-99", { minCans: 50, maxCans: 99 }),
  ];

  test("no quantity reads the base row; a quantity reads its slab", () => {
    assert.equal(rateAtQuantity(slabs, null)?.tag, "base");
    assert.equal(rateAtQuantity(slabs, 5)?.tag, "base");
    assert.equal(rateAtQuantity(slabs, 12)?.tag, "10+");
    assert.equal(rateAtQuantity(slabs, 60)?.tag, "50-99");
    assert.equal(rateAtQuantity(slabs, 120)?.tag, "10+");
  });

  test("a list printing slabs only has the lowest slab as its base", () => {
    const only: Row[] = [row("P", 95_000, "10+", { minCans: 10 }), row("P", 99_000, "1-9", { minCans: 1, maxCans: 9 })];
    assert.equal(rateAtQuantity(only, null)?.tag, "1-9");
  });

  test("the chain picks the slab on the list it settled on", () => {
    const got = rateFromCandidates([{ listId: "L", listName: "L" }], () => slabs, 60)!;
    assert.equal(got.row?.rateExGstPaise, 90_000);
    assert.equal(got.rows.length, 3);
  });
});

describe("validity, as the screens and the resolver both read it (B5)", () => {
  const old = list({ id: "L_old", effectiveFrom: "2026-07-01", validityDays: null });

  test("past its validity: keeps pricing under the default, and says so", () => {
    const v = listValidity(old, TODAY, KEEP);
    assert.equal(v.validUntil, "2026-07-31");
    assert.equal(v.pastValidity, true);
    assert.equal(v.state, "past_validity_pricing");
    const scopes = [scope({ id: "s", priceListId: "L_old", scopeKind: "everybody" })];
    assert.equal(resolvePriceList(geo(), scopes, [old], TODAY, KEEP)?.listId, "L_old");
    // No options at all is the shipped behaviour too.
    assert.equal(resolvePriceList(geo(), scopes, [old], TODAY)?.listId, "L_old");
  });

  test("with the setting off it stops pricing, and the screens say it is not pricing", () => {
    assert.equal(listValidity(old, TODAY, STOP).state, "expired");
    const fallback = list({ id: "L_new", effectiveFrom: "2026-09-10" });
    const scopes = [
      scope({ id: "s1", priceListId: "L_old", scopeKind: "customer", scopeValue: "C_shop" }),
      scope({ id: "s2", priceListId: "L_new", scopeKind: "everybody" }),
    ];
    assert.equal(resolvePriceList(geo(), scopes, [old, fallback], TODAY, STOP)?.listId, "L_new");
    // Inside its validity it still prices on the very same rule.
    assert.equal(resolvePriceList(geo(), scopes, [old, fallback], "2026-07-20", STOP)?.listId, "L_old");
  });

  test("a list whose effective_to has passed is expired whatever the setting", () => {
    const ended = list({ id: "L_e", effectiveFrom: "2026-09-01", effectiveTo: "2026-09-10" });
    assert.equal(listValidity(ended, TODAY, KEEP).state, "expired");
    assert.equal(listValidity(ended, TODAY, KEEP).expiresOn, "2026-09-10");
  });

  test("a current list is current", () => {
    assert.equal(listValidity(list({ id: "L" }), TODAY, STOP).state, "current");
  });
});

describe("versions resolved as of a date (B6, B17)", () => {
  const v1 = list({ id: "L_v1", status: "superseded", effectiveFrom: "2026-08-01", effectiveTo: "2026-08-31" });
  const v2 = list({ id: "L_v2", status: "published", effectiveFrom: "2026-09-01" });
  const scopes = [
    scope({ id: "a", priceListId: "L_v1", scopeKind: "state", scopeValue: "maharashtra" }),
    scope({ id: "b", priceListId: "L_v2", scopeKind: "state", scopeValue: "maharashtra" }),
  ];

  test("an August date reads the superseded August version; September reads its successor", () => {
    assert.equal(resolvePriceList(geo(), scopes, [v1, v2], "2026-08-15", KEEP)?.listId, "L_v1");
    assert.equal(resolvePriceList(geo(), scopes, [v1, v2], TODAY, KEEP)?.listId, "L_v2");
  });

  test("a list still marked published until its successor starts resolves by its dates alike", () => {
    const stillPublished = { ...v1, status: "published" };
    assert.equal(resolvePriceList(geo(), scopes, [stillPublished, v2], "2026-08-15", KEEP)?.listId, "L_v1");
    assert.equal(resolvePriceList(geo(), scopes, [stillPublished, v2], TODAY, KEEP)?.listId, "L_v2");
  });

  test("a superseded list with no end date never prices; drafts and withdrawn lists never do", () => {
    const openEnded = { ...v1, effectiveTo: null };
    assert.equal(resolvePriceList(geo(), scopes.slice(0, 1), [openEnded], "2026-08-15", KEEP), null);
    for (const status of ["draft", "withdrawn"]) {
      assert.equal(resolvePriceList(geo(), scopes.slice(0, 1), [{ ...v1, status }], "2026-08-15", KEEP), null);
    }
  });
});

describe("ties never depend on row order (B28)", () => {
  test("two lists alike in every respect resolve the same way whichever order they arrive in", () => {
    const a = list({ id: "L_a" });
    const b = list({ id: "L_b" });
    const sa = scope({ id: "sa", priceListId: "L_a", scopeKind: "everybody" });
    const sb = scope({ id: "sb", priceListId: "L_b", scopeKind: "everybody" });
    const one = resolvePriceList(geo(), [sa, sb], [a, b], TODAY, KEEP)!;
    const two = resolvePriceList(geo(), [sb, sa], [b, a], TODAY, KEEP)!;
    assert.equal(one.listId, two.listId);
    assert.deepEqual(
      one.candidates.map((c) => c.listId),
      two.candidates.map((c) => c.listId),
    );
  });
});

describe("salesman lists name the sales seat only (B18)", () => {
  test("a geography carries whatever the service puts in salesmanIds, and an owner is never in it", () => {
    // The service builds salesmanIds from sales_am_id alone; a list for the
    // person who ran an import does not catch a shop whose sales seat is
    // somebody else.
    const l = list({ id: "L_importer" });
    const s = scope({ id: "s", priceListId: "L_importer", scopeKind: "salesman", scopeValue: "U_importer" });
    assert.equal(resolvePriceList(geo({ salesmanIds: ["U_seller"] }), [s], [l], TODAY, KEEP), null);
    assert.equal(resolvePriceList(geo({ salesmanIds: ["U_importer"] }), [s], [l], TODAY, KEEP)?.listId, "L_importer");
  });
});

describe("a list's lineage (B19)", () => {
  const supersedes = new Map<string, string | null>([
    ["L_v3", "L_v2"],
    ["L_v2", "L_v1"],
    ["L_v1", null],
    ["L_other", null],
    ["L_loop_a", "L_loop_b"],
    ["L_loop_b", "L_loop_a"],
  ]);
  const of = (id: string) => supersedes.get(id);

  test("every version of one list shares a root; a different list does not", () => {
    assert.equal(lineageRoot("L_v3", of), "L_v1");
    assert.equal(lineageRoot("L_v1", of), "L_v1");
    assert.notEqual(lineageRoot("L_v3", of), lineageRoot("L_other", of));
  });

  test("a cycle in bad data ends rather than spinning", () => {
    assert.ok(["L_loop_a", "L_loop_b"].includes(lineageRoot("L_loop_a", of)));
  });
});
