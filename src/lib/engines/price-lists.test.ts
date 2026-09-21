import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  deriveRate,
  discountAuthority,
  exFromIncl,
  inclFromEx,
  inferDerivation,
  pickSlab,
  priceLine,
  rateChange,
} from "./price-math";
import {
  placeKey,
  resolvePriceList,
  SCOPE_SPECIFICITY,
  type CustomerGeo,
  type ListMeta,
  type ScopeRow,
} from "./price-resolution";
import { PRICE_SCOPE_KINDS } from "@/db/schema";

const TODAY = "2026-09-21";

describe("price math", () => {
  test("the printed inclusive figure is the ex-GST rate times 1.18 to the rupee, on the four sample lists", () => {
    // Nano 20 L: MP & CG 2,286 / Odisha To Pay 2,281 / Odisha Paid 2,521 / S M 2,100,
    // billed on the sheet as 1,937 / 1,933 / 2,136 / 1,780 ex-GST. The stored
    // ex-GST rate keeps its paise, so the printed figure comes back exactly and
    // the billed rupee is the stored rate rounded.
    for (const [incl, billedRupees] of [
      [228_600, 1937],
      [228_100, 1933],
      [252_100, 2136],
      [210_000, 1780],
    ]) {
      const ex = exFromIncl(incl, 1800);
      assert.equal(inclFromEx(ex, 1800), incl);
      assert.equal(Math.round(ex / 100), billedRupees);
    }
  });

  test("ex-GST from a printed figure keeps its paise rather than rounding to a wrong rupee", () => {
    // 2,281 / 1.18 = 1,933.05 — the sheet bills 1,933, and rounding the
    // division to the rupee first would still give 1,933 here, but 643 / 1.18
    // = 544.92 bills as 545 on the sheet and must not become 544.
    assert.equal(exFromIncl(228_100, 1800), 193_305);
    assert.equal(Math.round(exFromIncl(64_300, 1800) / 100), 545);
  });

  test("a per-litre freight rule moves a 20 L can twenty times what it moves a 1 L can", () => {
    const rule = { kind: "per_litre_paise", paise: 1200 } as const;
    assert.equal(deriveRate(100_000, 1000, rule), 101_200);
    assert.equal(deriveRate(2_000_000, 20_000, rule), 2_024_000);
    assert.equal(deriveRate(100_000, null, rule), null);
  });

  test("the Odisha pair reads back as twelve rupees a litre, GST-inclusive", () => {
    // Odisha Paid minus Odisha To Pay, printed: +240 on 20 L, +120 on 10 L,
    // +60 on 5 L, +12 on 1 L. That is 12 rupees a litre INCLUSIVE, and the
    // inferred rule is read on ex-GST rates, so it lands near 10.17 a litre.
    const gst = 1800;
    const pairs = [
      { parentExPaise: exFromIncl(228_100, gst), childExPaise: exFromIncl(252_100, gst), millilitresPerCan: 20_000 },
      { parentExPaise: exFromIncl(115_000, gst), childExPaise: exFromIncl(127_000, gst), millilitresPerCan: 10_000 },
      { parentExPaise: exFromIncl(58_300, gst), childExPaise: exFromIncl(64_300, gst), millilitresPerCan: 5_000 },
      { parentExPaise: exFromIncl(12_300, gst), childExPaise: exFromIncl(13_500, gst), millilitresPerCan: 1_000 },
    ];
    const rule = inferDerivation(pairs);
    assert.ok(rule && rule.kind === "per_litre_paise");
    assert.ok(Math.abs(rule.paise - 1017) <= 5, `got ${rule.paise}`);
  });

  test("a percent rule is recognised when every pair moves by the same share", () => {
    const rule = inferDerivation([
      { parentExPaise: 100_000, childExPaise: 105_000, millilitresPerCan: 1000 },
      { parentExPaise: 450_000, childExPaise: 472_500, millilitresPerCan: 5000 },
      { parentExPaise: 1_700_000, childExPaise: 1_785_000, millilitresPerCan: 20_000 },
    ]);
    assert.deepEqual(rule, { kind: "percent_bp", bp: 500 });
  });

  test("a slab picks the narrowest band the quantity satisfies, and a dash answers nothing", () => {
    const rates = [
      { rateExGstPaise: 100, minCans: null, maxCans: null, offered: true },
      { rateExGstPaise: 90, minCans: 50, maxCans: null, offered: true },
    ];
    assert.equal(pickSlab(rates, 10)?.rateExGstPaise, 100);
    assert.equal(pickSlab(rates, 60)?.rateExGstPaise, 90);
    assert.equal(pickSlab([{ rateExGstPaise: 100, minCans: null, maxCans: null, offered: false }], 1), null);
  });

  test("an associate with no authority is told to ask, a manager inside the ceiling is not", () => {
    const config = { associateMaxBp: 0, managerMaxBp: 1000 };
    assert.equal(discountAuthority(0, "associate", config).allowed, true);
    const refused = discountAuthority(300, "associate", config);
    assert.equal(refused.allowed, false);
    assert.match(refused.reason ?? "", /Ask a manager/);
    assert.equal(discountAuthority(1000, "manager", config).allowed, true);
    assert.equal(discountAuthority(1001, "manager", config).allowed, false);
    assert.equal(discountAuthority(5000, "admin", config).allowed, true);
  });

  test("a line takes its discount before GST", () => {
    const line = priceLine({ rateExGstPaise: 193_300, cans: 2, discountBp: 300, gstBp: 1800 });
    assert.equal(line.grossExPaise, 386_600);
    assert.equal(line.discountPaise, 11_598);
    assert.equal(line.netExPaise, 375_002);
    assert.equal(line.totalPaise, 375_002 + Math.round(375_002 * 0.18));
  });

  test("a change from nothing has no percentage", () => {
    assert.deepEqual(rateChange(null, 100), { deltaPaise: null, deltaBp: null });
    assert.deepEqual(rateChange(100_000, 110_000), { deltaPaise: 10_000, deltaBp: 1000 });
  });
});

/* ------------------------------------------------------------ resolution */

const lists: ListMeta[] = [
  { id: "L_all", name: "Pan India", status: "published", effectiveFrom: "2026-08-01", effectiveTo: null, freightTerm: "to_pay", version: 1 },
  { id: "L_mh", name: "Pan Maharashtra", status: "published", effectiveFrom: "2026-08-01", effectiveTo: null, freightTerm: "to_pay", version: 1 },
  { id: "L_od_topay", name: "Odisha To Pay", status: "published", effectiveFrom: "2026-08-01", effectiveTo: null, freightTerm: "to_pay", version: 1 },
  { id: "L_od_paid", name: "Odisha Paid", status: "published", effectiveFrom: "2026-08-01", effectiveTo: null, freightTerm: "paid", version: 1 },
  { id: "L_thane", name: "Thane", status: "published", effectiveFrom: "2026-08-01", effectiveTo: null, freightTerm: "not_stated", version: 1 },
  { id: "L_sm", name: "S M Distributors", status: "published", effectiveFrom: "2026-08-01", effectiveTo: null, freightTerm: "not_stated", version: 1 },
  { id: "L_draft", name: "Draft", status: "draft", effectiveFrom: "2026-08-01", effectiveTo: null, freightTerm: "not_stated", version: 1 },
  { id: "L_old", name: "Old Maharashtra", status: "published", effectiveFrom: "2026-01-01", effectiveTo: "2026-07-31", freightTerm: "to_pay", version: 1 },
];

const scope = (partial: Partial<ScopeRow> & Pick<ScopeRow, "id" | "priceListId" | "scopeKind">): ScopeRow => ({
  scopeValue: "",
  parentKey: "",
  freightTermMatch: "any",
  priority: 0,
  validFrom: null,
  validTo: null,
  ...partial,
});

const scopes: ScopeRow[] = [
  scope({ id: "s1", priceListId: "L_all", scopeKind: "everybody" }),
  scope({ id: "s2", priceListId: "L_mh", scopeKind: "state", scopeValue: "maharashtra" }),
  scope({ id: "s2old", priceListId: "L_old", scopeKind: "state", scopeValue: "maharashtra" }),
  scope({ id: "s3", priceListId: "L_od_topay", scopeKind: "state", scopeValue: "odisha" }),
  scope({ id: "s4", priceListId: "L_od_paid", scopeKind: "state", scopeValue: "odisha" }),
  scope({ id: "s5", priceListId: "L_thane", scopeKind: "city", scopeValue: "thane", parentKey: "maharashtra", scopeLabel: "Thane" }),
  scope({ id: "s6", priceListId: "L_sm", scopeKind: "customer", scopeValue: "C_sm" }),
  scope({ id: "s7", priceListId: "L_draft", scopeKind: "customer", scopeValue: "C_draft" }),
];

const geo = (partial: Partial<CustomerGeo>): CustomerGeo => ({
  customerId: "C_x",
  salesmanIds: [],
  beatKeys: [],
  areaKeys: [],
  cityKeys: [],
  districtKeys: [],
  stateKeys: [],
  customerType: null,
  freightTerm: null,
  ...partial,
});

describe("price resolution", () => {
  test("every scope kind the schema knows has a place in the specificity order", () => {
    assert.deepEqual([...SCOPE_SPECIFICITY].sort(), [...PRICE_SCOPE_KINDS].sort());
  });

  test("a shop in no state at all falls through to the list for everybody, and the chain says so", () => {
    const r = resolvePriceList(geo({}), scopes, lists, TODAY);
    assert.equal(r?.listId, "L_all");
    assert.equal(r?.chain.at(-1)?.kind, "everybody");
    assert.ok(r?.chain.find((s) => s.kind === "state")?.note.includes("No state"));
  });

  test("a Maharashtra shop gets the state list, and the list dated out in July is ignored", () => {
    const r = resolvePriceList(geo({ stateKeys: ["maharashtra"] }), scopes, lists, TODAY);
    assert.equal(r?.listId, "L_mh");
  });

  test("a city list under its state beats the state list, on the resolved key or the sheet's spelling", () => {
    const resolved = resolvePriceList(geo({ stateKeys: ["maharashtra"], cityKeys: ["thane"] }), scopes, lists, TODAY);
    assert.equal(resolved?.listId, "L_thane");
    const typed = resolvePriceList(
      geo({ stateKeys: [placeKey("Maharashtra")], cityKeys: [placeKey("THANE (W)")] }),
      scopes,
      lists,
      TODAY,
    );
    assert.equal(typed?.listId, "L_mh", "a spelling that does not fold to the key is not matched");
    assert.equal(placeKey("Thane"), "thane");
  });

  test("a city scope with a parent does not match the same city name in another state", () => {
    const r = resolvePriceList(geo({ stateKeys: ["bihar"], cityKeys: ["thane"] }), scopes, lists, TODAY);
    assert.equal(r?.listId, "L_all");
  });

  test("the freight term picks between Odisha To Pay and Odisha Paid", () => {
    assert.equal(resolvePriceList(geo({ stateKeys: ["odisha"], freightTerm: "paid" }), scopes, lists, TODAY)?.listId, "L_od_paid");
    assert.equal(resolvePriceList(geo({ stateKeys: ["odisha"], freightTerm: "to_pay" }), scopes, lists, TODAY)?.listId, "L_od_topay");
  });

  test("a shop whose freight term the sheet never stated still gets an Odisha list rather than nothing", () => {
    const r = resolvePriceList(geo({ stateKeys: ["odisha"] }), scopes, lists, TODAY);
    assert.ok(r && ["L_od_paid", "L_od_topay"].includes(r.listId));
    assert.ok(r.chain.at(-1)?.note.includes("2 lists matched"));
  });

  test("a customer's own list wins over everything, and a draft one counts for nothing", () => {
    assert.equal(resolvePriceList(geo({ customerId: "C_sm", stateKeys: ["maharashtra"] }), scopes, lists, TODAY)?.listId, "L_sm");
    assert.equal(resolvePriceList(geo({ customerId: "C_draft", stateKeys: ["maharashtra"] }), scopes, lists, TODAY)?.listId, "L_mh");
  });

  test("priority breaks a tie inside one kind", () => {
    const two = [
      ...scopes,
      scope({ id: "s8", priceListId: "L_od_paid", scopeKind: "state", scopeValue: "maharashtra", priority: 5 }),
    ];
    const r = resolvePriceList(geo({ stateKeys: ["maharashtra"] }), two, lists, TODAY);
    assert.equal(r?.listId, "L_od_paid");
  });

  test("a scope that has not started, or has ended, does not name anybody", () => {
    const dated = [
      ...scopes,
      scope({ id: "s9", priceListId: "L_sm", scopeKind: "customer", scopeValue: "C_x", validFrom: "2026-10-01" }),
      scope({ id: "s10", priceListId: "L_sm", scopeKind: "salesman", scopeValue: "U_1", validTo: "2026-09-01" }),
    ];
    const r = resolvePriceList(geo({ customerId: "C_x", salesmanIds: ["U_1"] }), dated, lists, TODAY);
    assert.equal(r?.listId, "L_all");
  });

  test("nothing resolves when no list applies, rather than the first list in the table", () => {
    const r = resolvePriceList(geo({ stateKeys: ["kerala"] }), scopes.filter((s) => s.id !== "s1"), lists, TODAY);
    assert.equal(r, null);
  });
});
