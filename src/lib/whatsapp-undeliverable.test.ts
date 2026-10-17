import { test } from "node:test";
import assert from "node:assert/strict";
import { isUndeliverableNumber, UNDELIVERABLE_SQL_PATTERN } from "./whatsapp-undeliverable";

test("Meta's 131026 is a number that cannot receive WhatsApp", () => {
  assert.equal(isUndeliverableNumber("131026 — Message undeliverable"), true);
  assert.equal(isUndeliverableNumber("Error 131026: undeliverable"), true);
});

test("every other failure is still a sending failure", () => {
  for (const r of [null, undefined, "", "131047 — Re-engagement message", "1310260 something", "Template not approved", "Wati timed out"]) {
    assert.equal(isUndeliverableNumber(r), false, String(r));
  }
});

test("the SQL pattern agrees with the function", () => {
  const re = new RegExp(UNDELIVERABLE_SQL_PATTERN);
  for (const r of ["131026 — Message undeliverable", "Error 131026: x", "1310260", "131047 — x"]) {
    assert.equal(re.test(r), isUndeliverableNumber(r), r);
  }
});
