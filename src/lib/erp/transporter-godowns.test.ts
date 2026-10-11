import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanGodowns, lookup, mirrorsFrom, placePath, townOptions, type PlaceOption } from "./transporter-godowns";

const nodes: PlaceOption[] = [
  { id: "mh", kind: "state", name: "Maharashtra", parentId: null },
  { id: "thane", kind: "district", name: "Thane", parentId: "mh" },
  { id: "bhiwandi", kind: "city", name: "Bhiwandi", parentId: "thane" },
  { id: "narpoli", kind: "area", name: "Narpoli", parentId: "bhiwandi" },
];
const byId = lookup(nodes);
const known = (id: string) => byId.has(id);

test("a town is a city or an area, named with its path", () => {
  assert.deepEqual(townOptions(nodes, byId), [
    { id: "bhiwandi", label: "Bhiwandi, Thane, Maharashtra" },
    { id: "narpoli", label: "Narpoli, Bhiwandi, Thane, Maharashtra" },
  ]);
  assert.equal(placePath(null, byId), "");
});

test("empty rows are dropped, a godown needs a town or an address", () => {
  const r = cleanGodowns([{ placeId: "", contacts: [{ name: " ", phones: ["", " "] }] }, { placeId: "bhiwandi" }], known);
  assert.ok(r.ok && r.godowns.length === 1 && r.godowns[0].placeId === "bhiwandi");
  const bad = cleanGodowns([{ label: "Main", contacts: [] }], known);
  assert.deepEqual(bad, { ok: false, field: "g1.placeId", message: "Pick the town for godown 1" });
  const typed = cleanGodowns([{ address: "Plot 4, Kalyan Road" }], known);
  assert.ok(typed.ok && typed.godowns[0].address === "Plot 4, Kalyan Road");
});

test("a person takes at most three numbers, and each must be a number", () => {
  const four = cleanGodowns([{ placeId: "bhiwandi", contacts: [{ name: "Ravi", phones: ["9820011001", "9820011002", "9820011003", "9820011004"] }] }], known);
  assert.equal(!four.ok && four.field, "g1.c1.phones");
  const word = cleanGodowns([{ placeId: "bhiwandi", contacts: [{ name: "Ravi", phones: ["call office"] }] }], known);
  assert.equal(!word.ok && word.field, "g1.c1.phones");
  const dup = cleanGodowns([{ placeId: "bhiwandi", contacts: [{ name: "Ravi", phones: ["98200 11001", "98200  11001", "022-2567 1234"] }] }], known);
  assert.ok(dup.ok);
  assert.deepEqual(dup.ok && dup.godowns[0].contacts[0].phones, ["98200 11001", "022-2567 1234"]);
});

test("an unknown town is refused", () => {
  const r = cleanGodowns([{ placeId: "gone" }], known);
  assert.equal(!r.ok && r.field, "g1.placeId");
});

test("the row mirrors the first person with a number", () => {
  const r = cleanGodowns(
    [
      { placeId: "bhiwandi", contacts: [{ role: "Booking", phones: [], name: "Asha" }] },
      { placeId: "narpoli", contacts: [{ name: "Ravi", phones: ["9820011001", "9820011002"] }] },
    ],
    known,
  );
  assert.ok(r.ok);
  assert.deepEqual(mirrorsFrom(r.ok ? r.godowns : []), { contactPerson: "Ravi", phone: "9820011001", altPhone: "9820011002" });
  assert.deepEqual(mirrorsFrom([]), { contactPerson: null, phone: null, altPhone: null });
});
