import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanGodowns, mirrorsFrom } from "./transporter-godowns";

test("empty rows are dropped, a godown needs a town or an address", () => {
  const r = cleanGodowns([{ town: "", contacts: [{ name: " ", phones: ["", " "] }] }, { town: "  Bhiwandi " }]);
  assert.ok(r.ok && r.godowns.length === 1 && r.godowns[0].town === "Bhiwandi");
  const bad = cleanGodowns([{ label: "Main", contacts: [] }]);
  assert.deepEqual(bad, { ok: false, field: "g1.town", message: "Type the town for godown 1" });
  const typed = cleanGodowns([{ address: "Plot 4, Kalyan Road" }]);
  assert.ok(typed.ok && typed.godowns[0].address === "Plot 4, Kalyan Road" && typed.godowns[0].town === null);
});

test("a person takes at most three numbers, and each must be a number", () => {
  const four = cleanGodowns([{ town: "Bhiwandi", contacts: [{ name: "Ravi", phones: ["9820011001", "9820011002", "9820011003", "9820011004"] }] }]);
  assert.equal(!four.ok && four.field, "g1.c1.phones");
  const word = cleanGodowns([{ town: "Bhiwandi", contacts: [{ name: "Ravi", phones: ["call office"] }] }]);
  assert.equal(!word.ok && word.field, "g1.c1.phones");
  const dup = cleanGodowns([{ town: "Bhiwandi", contacts: [{ name: "Ravi", phones: ["98200 11001", "98200  11001", "022-2567 1234"] }] }]);
  assert.ok(dup.ok);
  assert.deepEqual(dup.ok && dup.godowns[0].contacts[0].phones, ["98200 11001", "022-2567 1234"]);
});

test("the row mirrors the first person with a number", () => {
  const r = cleanGodowns([
    { town: "Bhiwandi", contacts: [{ role: "Booking", phones: [], name: "Asha" }] },
    { town: "Narpoli", contacts: [{ name: "Ravi", phones: ["9820011001", "9820011002"] }] },
  ]);
  assert.ok(r.ok);
  assert.deepEqual(mirrorsFrom(r.ok ? r.godowns : []), { contactPerson: "Ravi", phone: "9820011001", altPhone: "9820011002" });
  assert.deepEqual(mirrorsFrom([]), { contactPerson: null, phone: null, altPhone: null });
});
