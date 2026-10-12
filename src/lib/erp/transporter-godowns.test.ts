import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanGodowns, godownGstProblem, lookup, mirrorsFrom, pickOf, pickPath, placeChain, placeChoices, placePath, resolvePick, setRung, unlistedStates, type PlaceOption } from "./transporter-godowns";

const nodes: PlaceOption[] = [
  { id: "mh", kind: "state", name: "Maharashtra", parentId: null },
  { id: "thane", kind: "district", name: "Thane", parentId: "mh" },
  { id: "bhiwandi", kind: "city", name: "Bhiwandi", parentId: "thane" },
  { id: "narpoli", kind: "area", name: "Narpoli", parentId: "bhiwandi" },
  { id: "kalyan", kind: "city", name: "Kalyan", parentId: "thane" },
  { id: "gj", kind: "state", name: "Gujarat", parentId: null },
  { id: "pune", kind: "district", name: "Pune", parentId: "mh" },
];
const byId = lookup(nodes);
const MH = "27AAPCS1234A1ZN";
const GJ = "24AAPCS1234A1ZT";
const narpoli = { state: { id: "mh" }, district: { id: "thane" }, city: { id: "bhiwandi" }, area: { id: "narpoli" } };

test("four pickers, each narrowed by the one above", () => {
  assert.deepEqual(placeChoices(nodes, "state", {}).map((n) => n.id), ["gj", "mh"]);
  assert.deepEqual(placeChoices(nodes, "district", {}), []);
  assert.deepEqual(placeChoices(nodes, "district", { state: { id: "mh" } }).map((n) => n.id), ["pune", "thane"]);
  assert.deepEqual(placeChoices(nodes, "area", narpoli).map((n) => n.id), ["narpoli"]);
  /* Nothing is filed under a rung somebody added — it has no children yet. */
  assert.deepEqual(placeChoices(nodes, "area", { ...narpoli, city: { name: "Shelar" } }), []);
  assert.deepEqual(placeChain("narpoli", byId), { area: "narpoli", city: "bhiwandi", district: "thane", state: "mh" });
  assert.equal(placePath("bhiwandi", byId), "Bhiwandi, Thane, Maharashtra");
  assert.deepEqual(pickOf("thane", byId), { state: { id: "mh" }, district: { id: "thane" } });
  assert.equal(pickPath({ ...narpoli, area: { name: "Shelar" } }, byId), "Shelar, Bhiwandi, Thane, Maharashtra");
});

test("setting a rung clears every rung below it", () => {
  assert.deepEqual(setRung(narpoli, "district", { id: "pune" }), { state: { id: "mh" }, district: { id: "pune" } });
  assert.deepEqual(setRung(narpoli, "city", null), { state: { id: "mh" }, district: { id: "thane" } });
  /* "Add a city not listed" pressed and not typed into yet is still a typed rung. */
  assert.deepEqual(setRung(narpoli, "city", { name: "" }), { state: { id: "mh" }, district: { id: "thane" }, city: { name: "" } });
});

test("all four rungs are required, and an unlisted one is typed under its parent", () => {
  const short = resolvePick({ state: { id: "mh" }, district: { id: "thane" }, city: { id: "kalyan" } }, byId, nodes);
  assert.deepEqual(short, { ok: false, kind: "area", message: "Pick the area, or add it if it is not listed" });
  const added = resolvePick({ state: { id: "mh" }, district: { id: "thane" }, city: { id: "kalyan" }, area: { name: "  Shil   Phata " } }, byId, nodes);
  assert.ok(added.ok);
  assert.deepEqual(added.ok && added.rungs.map((r) => [r.kind, r.id, r.name]), [["state", "mh", "Maharashtra"], ["district", "thane", "Thane"], ["city", "kalyan", "Kalyan"], ["area", null, "Shil Phata"]]);
  /* A typed name already listed under the same parent is the listed place, never a second one. */
  const dup = resolvePick({ ...narpoli, area: { name: "NARPOLI" } }, byId, nodes);
  assert.equal(dup.ok && dup.rungs[3].id, "narpoli");
  /* Below a typed rung everything is new, even a name listed elsewhere. */
  const deep = resolvePick({ state: { id: "mh" }, district: { name: "Raigad" }, city: { name: "Bhiwandi" }, area: { name: "Narpoli" } }, byId, nodes);
  assert.deepEqual(deep.ok && deep.rungs.map((r) => r.id), ["mh", null, null, null]);
  /* A listed id under the wrong parent is refused. */
  assert.equal(resolvePick({ ...narpoli, district: { id: "pune" } }, byId, nodes).ok, false);
});

test("a state is the country's, never invented", () => {
  const ka = resolvePick({ state: { name: "karnataka" }, district: { name: "Bengaluru Urban" }, city: { name: "Bengaluru" }, area: { name: "Peenya" } }, byId, nodes);
  assert.equal(ka.ok && ka.rungs[0].name, "Karnataka");
  const bad = resolvePick({ state: { name: "Atlantis" }, district: { name: "X" }, city: { name: "Y" }, area: { name: "Z" } }, byId, nodes);
  assert.deepEqual(bad, { ok: false, kind: "state", message: "Atlantis is not a state or union territory" });
  assert.ok(unlistedStates(nodes).includes("Karnataka") && !unlistedStates(nodes).includes("Gujarat"));
});

test("each godown has its own GST number, registered in the godown's state", () => {
  assert.equal(godownGstProblem(MH, "Maharashtra"), null);
  assert.match(godownGstProblem(GJ, "Maharashtra") ?? "", /registered in Gujarat, but the godown is in Maharashtra/);
  assert.match(godownGstProblem("27AAPCS1234A1ZX", "Maharashtra") ?? "", /does not check out/);
  const none = cleanGodowns([{ label: "Main", place: narpoli }], nodes);
  assert.deepEqual(none, { ok: false, field: "g1.gstin", message: "Main: give its GST number" });
  const two = cleanGodowns(
    [
      { place: narpoli, gstin: MH.toLowerCase() },
      { place: { state: { id: "gj" }, district: { name: "Surat" }, city: { name: "Surat" }, area: { name: "Sachin GIDC" } }, gstin: GJ },
    ],
    nodes,
  );
  assert.ok(two.ok);
  assert.deepEqual(two.ok && two.godowns.map((g) => g.gstin), [MH, GJ]);
});

test("a godown saved at a district before the four rungs is refused until its city and area are picked", () => {
  const old = cleanGodowns([{ placeId: "thane", gstin: MH }], nodes);
  assert.deepEqual(old, { ok: false, field: "g1.place.city", message: "Godown 1: Pick the city, or add it if it is not listed" });
});

test("empty rows are dropped", () => {
  const r = cleanGodowns([{ contacts: [{ name: " ", phones: ["", " "] }] }, { place: narpoli, gstin: MH }], nodes);
  assert.ok(r.ok && r.godowns.length === 1 && r.godowns[0].place[3].id === "narpoli");
});

test("a person takes at most three numbers, and each must be a number", () => {
  const four = cleanGodowns([{ place: narpoli, gstin: MH, contacts: [{ name: "Ravi", phones: ["9820011001", "9820011002", "9820011003", "9820011004"] }] }], nodes);
  assert.equal(!four.ok && four.field, "g1.c1.phones");
  const word = cleanGodowns([{ place: narpoli, gstin: MH, contacts: [{ name: "Ravi", phones: ["call office"] }] }], nodes);
  assert.equal(!word.ok && word.field, "g1.c1.phones");
  const dup = cleanGodowns([{ place: narpoli, gstin: MH, contacts: [{ name: "Ravi", phones: ["98200 11001", "98200  11001", "022-2567 1234"] }] }], nodes);
  assert.deepEqual(dup.ok && dup.godowns[0].contacts[0].phones, ["98200 11001", "022-2567 1234"]);
});

test("the row mirrors the first person with a number", () => {
  const r = cleanGodowns(
    [
      { place: narpoli, gstin: MH, contacts: [{ role: "Booking", phones: [], name: "Asha" }] },
      { place: narpoli, gstin: MH, contacts: [{ name: "Ravi", phones: ["9820011001", "9820011002"] }] },
    ],
    nodes,
  );
  assert.ok(r.ok);
  assert.deepEqual(mirrorsFrom(r.ok ? r.godowns : []), { contactPerson: "Ravi", phone: "9820011001", altPhone: "9820011002" });
  assert.deepEqual(mirrorsFrom([]), { contactPerson: null, phone: null, altPhone: null });
});
