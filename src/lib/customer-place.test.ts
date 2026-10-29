import { test } from "node:test";
import assert from "node:assert/strict";
import { customerPick, resolveCustomerPick, samePick } from "@/lib/customer-place";
import type { PlaceOption } from "@/lib/erp/transporter-godowns";

const tree: PlaceOption[] = [
  { id: "mh", kind: "state", name: "Maharashtra", parentId: null },
  { id: "ngd", kind: "district", name: "Nagpur", parentId: "mh" },
  { id: "ngc", kind: "city", name: "Nagpur", parentId: "ngd" },
  { id: "sit", kind: "area", name: "Sitabuldi", parentId: "ngc" },
];

test("a customer's area may be left out; state, district and city may not", () => {
  const noArea = resolveCustomerPick({ state: { id: "mh" }, district: { id: "ngd" }, city: { id: "ngc" } }, tree);
  assert.ok(noArea.ok);
  if (noArea.ok) assert.deepEqual(noArea.rungs.map((r) => r.kind), ["state", "district", "city"]);
  const noCity = resolveCustomerPick({ state: { id: "mh" }, district: { id: "ngd" } }, tree);
  assert.equal(noCity.ok, false);
  if (!noCity.ok) assert.equal(noCity.kind, "city");
});

test("a typed name that is already listed is the listed place", () => {
  const r = resolveCustomerPick({ state: { id: "mh" }, district: { id: "ngd" }, city: { id: "ngc" }, area: { name: " sitabuldi " } }, tree);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.rungs.at(-1)?.id, "sit");
});

test("the form opens on the stored place, else on the state the typed text names", () => {
  assert.deepEqual(customerPick({ stateId: "mh", districtId: "ngd", cityId: "ngc", areaId: "sit" }, tree), {
    state: { id: "mh" },
    district: { id: "ngd" },
    city: { id: "ngc" },
    area: { id: "sit" },
  });
  assert.deepEqual(customerPick({ stateId: null, districtId: null, cityId: null, areaId: null, region: "maharashtra" }, tree), { state: { id: "mh" } });
  assert.deepEqual(customerPick({ stateId: null, districtId: null, cityId: null, areaId: null, region: "Atlantis" }, tree), {});
});

test("samePick tells an untouched place from a moved one", () => {
  assert.ok(samePick({ state: { id: "mh" } }, { state: { id: "mh" } }));
  assert.ok(!samePick({ state: { id: "mh" } }, { state: { id: "mh" }, district: { id: "ngd" } }));
});
