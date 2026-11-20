import { test } from "node:test";
import assert from "node:assert/strict";

import { canonicalState, stateKey } from "../india-states";
import { placeKey } from "../place-parse";
import { GEOGRAPHY_MASTER, INDIA_GEOGRAPHY } from "./india-districts";
import { mergeMasterWithBook } from "./territory-options";
import type { PlaceTree } from "../services/sales-service";

const EMPTY: PlaceTree = { states: [], statelessShops: 0 };

test("the master has 28 states, 8 union territories and is marked provisional", () => {
  assert.equal(INDIA_GEOGRAPHY.filter((s) => s.type === "State").length, 28);
  assert.equal(INDIA_GEOGRAPHY.filter((s) => s.type === "UT").length, 8);
  assert.equal(GEOGRAPHY_MASTER.status, "provisional");
  assert.equal(GEOGRAPHY_MASTER.lgdCodes, "none");
});

test("every state name folds to itself, and districts are unique inside a state", () => {
  for (const s of INDIA_GEOGRAPHY) {
    assert.equal(canonicalState(s.name), s.name, `${s.name} is not spelled as canonicalState spells it`);
    assert.ok(s.districts.length >= 1, `${s.name} has no districts`);
    const keys = s.districts.map((d) => placeKey(d.name));
    assert.equal(new Set(keys).size, keys.length, `${s.name} repeats a district`);
  }
});

test("the reconciled countries of the provisional master", () => {
  const n = (state: string) => INDIA_GEOGRAPHY.find((s) => s.name === state)!.districts.length;
  assert.equal(n("Nagaland"), 17);
  assert.equal(n("Delhi"), 13);
  assert.equal(n("West Bengal"), 27);
  assert.equal(INDIA_GEOGRAPHY.reduce((t, s) => t + s.districts.length, 0), 796);
});

test("the four West Bengal districts from one source are flagged, and Malda is spelled Malda", () => {
  const wb = INDIA_GEOGRAPHY.find((s) => s.name === "West Bengal")!;
  const flagged = wb.districts.filter((d) => d.provisional).map((d) => d.name).sort();
  assert.deepEqual(flagged, ["Arambagh", "Basirhat", "Jangipur", "Sundarbans"]);
  assert.ok(wb.districts.some((d) => d.name === "Malda"));
  assert.ok(!wb.districts.some((d) => d.name === "Maldah"));
});

test("with an empty book every state and every district is still offered, at zero shops", () => {
  const tree = mergeMasterWithBook(EMPTY);
  assert.equal(tree.states.length, 36);
  const sikkim = tree.states.find((s) => s.state === "Sikkim")!;
  assert.equal(sikkim.shops, 0);
  assert.ok(sikkim.districts.length > 0);
  assert.ok(sikkim.districts.every((d) => d.shops === 0 && !d.bookOnly));
});

test("a book district links only on an exact folded name; the rest stay book-only and are never merged", () => {
  const book: PlaceTree = {
    statelessShops: 0,
    states: [
      {
        state: "Odisha",
        shops: 140,
        undistricted: 3,
        districts: [
          { district: "Cuttack", shops: 10, towns: [{ town: "Cuttack", shops: 10 }] },
          { district: "Khorda", shops: 124, towns: [] },
        ],
      },
    ],
  };
  const odisha = mergeMasterWithBook(book).states.find((s) => s.state === "Odisha")!;
  const cuttack = odisha.districts.find((d) => d.district === "Cuttack")!;
  assert.equal(cuttack.shops, 10);
  assert.equal(cuttack.bookOnly, undefined);

  const khorda = odisha.districts.find((d) => d.district === "Khorda")!;
  assert.equal(khorda.bookOnly, true, "a different spelling is kept apart, not guessed");
  assert.equal(khorda.shops, 124);

  const official = odisha.districts.find((d) => placeKey(d.district) === "khordha");
  assert.ok(official, "the master's own spelling is still offered");
  assert.equal(official!.shops, 0, "and shows zero rather than borrowing the book district's shops");
  assert.equal(odisha.shops, 140);
  assert.equal(odisha.undistricted, 3);
});

test("a state the book spells in a way the master does not know is kept as typed", () => {
  const book: PlaceTree = {
    statelessShops: 5,
    states: [{ state: "Atlantis", shops: 2, undistricted: 0, districts: [{ district: "Deep", shops: 2, towns: [] }] }],
  };
  const tree = mergeMasterWithBook(book);
  assert.equal(tree.states.length, 37);
  assert.equal(tree.statelessShops, 5);
  const atlantis = tree.states.find((s) => stateKey(s.state) === "atlantis")!;
  assert.equal(atlantis.districts[0].bookOnly, true);
});

import { acknowledgementProblem, leavesByState, narrowedStates, offeredDistricts } from "./territory-options";

test("a state is narrowed when something narrower than the whole state is picked under it, and only then", () => {
  assert.deepEqual(narrowedStates([{ kind: "state", value: "Maharashtra", parent: "" }]), []);
  assert.deepEqual(
    narrowedStates([
      { kind: "district", value: "Thane", parent: "Maharashtra" },
      { kind: "town", value: "Kalyan", parent: "Thane, Maharashtra" },
      { kind: "district", value: "Pune", parent: "Gujrat" },
    ]).sort(),
    ["Gujarat", "Maharashtra"],
    "spelled states fold to one canonical name each",
  );
});

test("a typed city, and a beat under it, narrow the state the city was picked under", () => {
  const leaves = [
    { kind: "city", value: "Pune", parent: "Maharashtra" },
    { kind: "beat", value: "Camp", parent: "Pune" },
    { kind: "district", value: "Thane", parent: "Maharashtra" },
  ];
  const by = leavesByState(leaves);
  assert.deepEqual([...by.keys()], ["Maharashtra"]);
  assert.equal(by.get("Maharashtra")!.length, 3, "the beat rides with its city; both narrow the same state");
});

test("a typed city that never named its state, or a beat with no city, has no state to say and is not guessed into one", () => {
  assert.deepEqual(narrowedStates([{ kind: "city", value: "Pune", parent: "" }]), []);
  assert.deepEqual(narrowedStates([{ kind: "beat", value: "Camp", parent: "Pune" }]), []);
});

test("the acknowledgement: an unchanged save and a save that leaves nothing outside need none", () => {
  assert.equal(acknowledgementProblem({ changed: false, outside: [{ state: "Maharashtra", shops: 31 }], acknowledged: undefined }), null);
  assert.equal(acknowledgementProblem({ changed: true, outside: [], acknowledged: undefined }), null);
  assert.equal(acknowledgementProblem({ changed: true, outside: [{ state: "Goa", shops: 0 }], acknowledged: undefined }), null);
});

test("the acknowledgement: a missing one is refused, and says how many in all", () => {
  const m = acknowledgementProblem({
    changed: true,
    outside: [{ state: "Maharashtra", shops: 31 }, { state: "Gujarat", shops: 9 }],
    acknowledged: undefined,
  });
  assert.match(m ?? "", /40 shops/);
  assert.match(m ?? "", /Confirm/);
});

test("the acknowledgement: a matching one passes, whatever spelling the state was confirmed under", () => {
  assert.equal(
    acknowledgementProblem({
      changed: true,
      outside: [{ state: "Gujarat", shops: 9 }, { state: "Maharashtra", shops: 31 }],
      acknowledged: [{ state: "Maharashtra", shops: 31 }, { state: "Gujrat", shops: 9 }],
    }),
    null,
  );
});

test("the acknowledgement: a stale count in ANY state is refused, and names the state", () => {
  const outside = [{ state: "Maharashtra", shops: 31 }, { state: "Gujarat", shops: 9 }];
  const stale = acknowledgementProblem({
    changed: true,
    outside,
    acknowledged: [{ state: "Maharashtra", shops: 31 }, { state: "Gujarat", shops: 8 }],
  });
  assert.match(stale ?? "", /Gujarat/);
  assert.match(stale ?? "", /9 now, 8 confirmed/);
});

test("the acknowledgement: a total that adds up is not enough when the states moved in opposite directions", () => {
  const swapped = acknowledgementProblem({
    changed: true,
    outside: [{ state: "Maharashtra", shops: 31 }, { state: "Gujarat", shops: 9 }],
    acknowledged: [{ state: "Maharashtra", shops: 30 }, { state: "Gujarat", shops: 10 }],
  });
  assert.ok(swapped, "40 confirmed in total is still not 31 and 9");
});

test("the acknowledgement: a state left out of it counts as zero confirmed, and a state with nothing outside now counts as stale", () => {
  const outside = [{ state: "Maharashtra", shops: 31 }];
  assert.match(
    acknowledgementProblem({ changed: true, outside, acknowledged: [] }) ?? "",
    /31 now, 0 confirmed/,
  );
  assert.match(
    acknowledgementProblem({
      changed: true,
      outside,
      acknowledged: [{ state: "Maharashtra", shops: 31 }, { state: "Goa", shops: 4 }],
    }) ?? "",
    /Goa.*0 now, 4 confirmed/,
  );
});

test("a district already allocated that nothing on offer names is kept as an earlier pick", () => {
  const state = {
    state: "Maharashtra",
    shops: 10,
    undistricted: 0,
    districts: [{ district: "Thane", shops: 10, towns: [] }],
  };
  const picked = [
    { kind: "district", value: "Thane", parent: "Maharashtra" },
    { kind: "district", value: "Mumbai", parent: "Maharashtra" },
    { kind: "district", value: "Elsewhere", parent: "Gujarat" },
  ];
  const offered = offeredDistricts(state, picked);
  assert.deepEqual(
    offered.map((d) => d.district),
    ["Thane", "Mumbai"],
    "the stored district stays, and another state's pick is not pulled in",
  );
  assert.equal(offered[1].earlierPick, true);
  assert.equal(offered[1].shops, 0);
  assert.equal(offered.filter((d) => d.district === "Thane").length, 1, "a district on offer is not listed twice");
});

test("the missing-acknowledgement message says '1 shop' for one and 'N shops' for more", () => {
  const one = acknowledgementProblem({ changed: true, outside: [{ state: "Maharashtra", shops: 1 }], acknowledged: undefined });
  assert.match(one ?? "", /^1 shop is not placed in any district/);
  assert.doesNotMatch(one ?? "", /1 shops/);
  const many = acknowledgementProblem({ changed: true, outside: [{ state: "Maharashtra", shops: 2 }], acknowledged: undefined });
  assert.match(many ?? "", /^2 shops are not placed in any district/);
  const across = acknowledgementProblem({
    changed: true,
    outside: [{ state: "Maharashtra", shops: 1 }, { state: "Gujarat", shops: 1 }],
    acknowledged: undefined,
  });
  assert.match(across ?? "", /^2 shops are not placed/, "the total across states is what is said");
});
