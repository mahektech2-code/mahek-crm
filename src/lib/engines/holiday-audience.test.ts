import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { audienceLabel, indexTree, resolveHoliday, type HolidayPerson, type PlaceNode } from "./holiday-audience";

/*
 * Who a holiday reaches. The tree is a slice of the real one: Odisha with
 * Cuttack district (Cuttack city, Choudwar city, Buxi Bazar area in Cuttack)
 * and Khordha district (Bhubaneswar), Maharashtra with Nagpur.
 */
const NODES: PlaceNode[] = [
  { id: "od", kind: "state", name: "Odisha", parentId: null },
  { id: "d-ctc", kind: "district", name: "Cuttack", parentId: "od" },
  { id: "c-ctc", kind: "city", name: "Cuttack", parentId: "d-ctc" },
  { id: "c-chw", kind: "city", name: "Choudwar", parentId: "d-ctc" },
  { id: "a-buxi", kind: "area", name: "Buxi Bazar", parentId: "c-ctc" },
  { id: "d-kh", kind: "district", name: "Khordha", parentId: "od" },
  { id: "c-bbsr", kind: "city", name: "Bhubaneswar", parentId: "d-kh" },
  { id: "mh", kind: "state", name: "Maharashtra", parentId: null },
  { id: "d-ngp", kind: "district", name: "Nagpur", parentId: "mh" },
  { id: "c-ngp", kind: "city", name: "Nagpur", parentId: "d-ngp" },
];
const tree = indexTree(NODES);

const PEOPLE: HolidayPerson[] = [
  { id: "ravi", territories: [{ kind: "state", value: "Orissa", parent: "" }] },
  { id: "sita", territories: [{ kind: "city", value: "Choudwar", parent: "Odisha" }] },
  { id: "anil", territories: [{ kind: "beat", value: "Buxi Bazar", parent: "Cuttack" }] },
  { id: "mahesh", territories: [{ kind: "city", value: "Nagpur", parent: "Maharashtra" }] },
  { id: "nobody", territories: [] },
  { id: "bbsr", territories: [{ kind: "city", value: "Bhubaneswar", parent: "" }] },
];

const rule = (over: Partial<Parameters<typeof resolveHoliday>[0]>) => ({
  level: "company" as const,
  placeIds: [],
  include: [],
  exclude: [],
  ...over,
});
const who = (m: Map<string, unknown>) => [...m.keys()].sort();

describe("holiday audience", () => {
  test("company-wide reaches everybody, territories or not", () => {
    assert.deepEqual(who(resolveHoliday(rule({}), PEOPLE, tree)), ["anil", "bbsr", "mahesh", "nobody", "ravi", "sita"]);
  });

  test("an exclude takes the day away even from a company-wide holiday", () => {
    assert.ok(!resolveHoliday(rule({ exclude: ["mahesh"] }), PEOPLE, tree).has("mahesh"));
  });

  test("a state reaches its state, its cities and its beats — on any spelling", () => {
    const got = resolveHoliday(rule({ level: "state", placeIds: ["od"] }), PEOPLE, tree);
    /* "Orissa" is Odisha; Bhubaneswar states no parent and is placed by the tree. */
    assert.deepEqual(who(got), ["anil", "bbsr", "ravi", "sita"]);
    assert.deepEqual(got.get("ravi")?.reasons, ["Odisha"]);
  });

  test("a district reaches the cities under it, not the whole state", () => {
    assert.deepEqual(who(resolveHoliday(rule({ level: "district", placeIds: ["d-ctc"] }), PEOPLE, tree)), ["anil", "sita"]);
  });

  test("a city reaches that city and the beats inside it", () => {
    assert.deepEqual(who(resolveHoliday(rule({ level: "city", placeIds: ["c-ctc"] }), PEOPLE, tree)), ["anil"]);
    assert.deepEqual(who(resolveHoliday(rule({ level: "city", placeIds: ["c-ngp"] }), PEOPLE, tree)), ["mahesh"]);
  });

  test("an area reaches the beat of that name in that city", () => {
    assert.deepEqual(who(resolveHoliday(rule({ level: "area", placeIds: ["a-buxi"] }), PEOPLE, tree)), ["anil"]);
  });

  test("named people get it wherever they work, and an exclude still wins", () => {
    const got = resolveHoliday(rule({ level: "people", include: ["mahesh", "nobody"], exclude: ["nobody"] }), PEOPLE, tree);
    assert.deepEqual(who(got), ["mahesh"]);
    assert.deepEqual(got.get("mahesh"), { reasons: ["Named"], byPlace: false });
  });

  test("an include adds somebody the place does not reach", () => {
    const got = resolveHoliday(rule({ level: "state", placeIds: ["od"], include: ["mahesh"] }), PEOPLE, tree);
    assert.ok(got.has("mahesh"));
    assert.equal(got.get("mahesh")?.byPlace, false);
  });

  test("the label says where, and company says nothing", () => {
    assert.equal(audienceLabel(rule({}), tree), null);
    assert.equal(audienceLabel(rule({ level: "state", placeIds: ["od"] }), tree), "Odisha");
    assert.equal(audienceLabel(rule({ level: "people", include: ["a", "b"] }), tree), "2 named people");
  });
});
