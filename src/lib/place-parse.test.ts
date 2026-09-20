import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PLACE_KINDS,
  PLACE_PARENT,
  parsePlace,
  placeChain,
  placeKey,
  type ReverseGeocodeResult,
} from "./place-parse";

/* A real answer, taken verbatim from Ola Maps for Nagpur city centre. */
const NAGPUR: ReverseGeocodeResult = {
  formatted_address: "Sitabuldi, Nagpur, Maharashtra, 440012, India",
  address_components: [
    { types: ["country"], long_name: "India", short_name: "India" },
    { types: ["administrative_area_level_1"], long_name: "Maharashtra", short_name: "MH" },
    { types: ["administrative_area_level_2"], long_name: "Nagpur", short_name: "Nagpur" },
    { types: ["administrative_area_level_3"], long_name: "Nagpur (Urban)" },
    { types: ["locality"], long_name: "Nagpur", short_name: "Nagpur" },
    { types: ["sublocality"], long_name: "Sitabuldi", short_name: "Sitabuldi" },
    { types: ["neighborhood"], long_name: "Baba Farid Nagar" },
    { types: ["postal_code"], long_name: "440012" },
  ],
};

test("the four rungs come off the components they are named for", () => {
  const p = parsePlace(NAGPUR);
  assert.equal(p.state, "Maharashtra");
  assert.equal(p.district, "Nagpur");
  assert.equal(p.city, "Nagpur");
  assert.equal(p.area, "Sitabuldi");
  assert.equal(p.pincode, "440012");
});

test("the long name wins over the short one", () => {
  /* "MH" and "Maharashtra" would be two nodes for one state, and which of the
     two came back is not stable between answers. */
  assert.equal(parsePlace(NAGPUR).state, "Maharashtra");
});

test("a neighbourhood is never promoted into the area", () => {
  /* It is a FINER rung than sublocality, so reading it as one would put two
     different grains in one column with nothing on the screen saying which. */
  const withoutSub: ReverseGeocodeResult = {
    address_components: NAGPUR.address_components!.filter(
      (c) => !c.types?.includes("sublocality"),
    ),
  };
  assert.equal(parsePlace(withoutSub).area, "");
});

test("a missing rung is never filled in from the one above it", () => {
  const rural: ReverseGeocodeResult = {
    address_components: [
      { types: ["administrative_area_level_1"], long_name: "Madhya Pradesh" },
      { types: ["administrative_area_level_2"], long_name: "Betul" },
    ],
  };
  const p = parsePlace(rural);
  assert.equal(p.city, "");
  assert.equal(p.area, "");
});

test("a chain stops at the first rung nothing answered", () => {
  /* A TREE CANNOT HAVE A HOLE IN IT: an area arriving under a missing city
     would have to hang off the district, which is not the rung it is a child
     of, and every count above it would then be counting two things. */
  const holed: ReverseGeocodeResult = {
    address_components: [
      { types: ["administrative_area_level_1"], long_name: "Kerala" },
      { types: ["administrative_area_level_2"], long_name: "Ernakulam" },
      { types: ["sublocality"], long_name: "Panampilly Nagar" },
    ],
  };
  const chain = placeChain(parsePlace(holed));
  assert.deepEqual(
    chain.map((c) => c.kind),
    ["state", "district"],
  );
});

test("a chain never skips a rung", () => {
  const chain = placeChain(parsePlace(NAGPUR));
  for (const [i, step] of chain.entries()) {
    assert.equal(step.kind, PLACE_KINDS[i], "the chain is in tree order");
  }
});

test("every rung but the top says what it hangs from", () => {
  /* One statement of the shape. The picker reads it to decide what opens what
     and the writer reads it to refuse a node with no parent. */
  assert.equal(PLACE_PARENT.state, null);
  for (const kind of PLACE_KINDS) {
    if (kind === "state") continue;
    assert.ok(PLACE_PARENT[kind], `${kind} must name a parent rung`);
    assert.ok(
      PLACE_KINDS.indexOf(PLACE_PARENT[kind]!) < PLACE_KINDS.indexOf(kind),
      "a parent is always a coarser rung",
    );
  }
});

test("no answer at all is empty rather than a throw", () => {
  assert.equal(parsePlace(undefined).state, "");
  assert.deepEqual(placeChain(parsePlace(undefined)), []);
});

test("the fold joins the spellings of one place and keeps the digits", () => {
  assert.equal(placeKey("Mira Road"), placeKey("mira  road"));
  assert.equal(placeKey("Nagpur"), placeKey(" NAGPUR "));
  /* Digits are kept, unlike `stateKey`: "Sector 18" and "Sector 19" are two
     areas, and folding them would make every sector of a township one. */
  assert.notEqual(placeKey("Sector 18"), placeKey("Sector 19"));
  assert.equal(placeKey(null), "");
});
