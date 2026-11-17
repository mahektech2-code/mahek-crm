import { test } from "node:test";
import assert from "node:assert/strict";
import { changedFields } from "./changed-fields";

test("nothing differs: no write at all", () => {
  assert.equal(changedFields({ salesAmId: "usr_1", city: "Pune" }, { salesAmId: "usr_1", city: "Pune" }), null);
});

test("only the fields that moved are kept", () => {
  assert.deepEqual(changedFields({ salesAmId: "usr_2", city: "Pune" }, { salesAmId: "usr_1", city: "Pune" }), { salesAmId: "usr_2" });
});

test("null and undefined on the row are the same blank", () => {
  assert.equal(changedFields({ deactivationReason: null }, { deactivationReason: undefined }), null);
  assert.deepEqual(changedFields({ deactivationReason: null }, { deactivationReason: "master" }), { deactivationReason: null });
});

test("dates compare by instant, not by object", () => {
  const t = new Date("2026-11-01T00:00:00Z");
  assert.equal(changedFields({ deactivatedAt: new Date(t.getTime()) }, { deactivatedAt: t }), null);
  assert.ok(changedFields({ deactivatedAt: new Date(t.getTime() + 1) }, { deactivatedAt: t }));
});

test("a field the row was not read with counts as a change", () => {
  assert.deepEqual(changedFields({ creditTermDays: 30 }, {}), { creditTermDays: 30 });
});

test("an undefined planned value is skipped", () => {
  assert.equal(changedFields({ phone: undefined }, { phone: "98" }), null);
});
