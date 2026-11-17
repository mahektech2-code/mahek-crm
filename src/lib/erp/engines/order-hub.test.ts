import test from "node:test";
import assert from "node:assert/strict";
import { bothChecked, duplicateOf, gateRefusal, gateStage, intakeEditable, lineCleared, nextCheck, type Checker } from "./order-hub";
import { HOLD_REASONS, reasonsFor } from "./order-tracking";
import { ACCOUNTS_HOLD_REASONS, PRODUCTION_HOLD_REASONS } from "./order-hub";

const backOffice: Checker = { userId: "neha", backOffice: true, production: false, admin: false };
const head: Checker = { userId: "ravi", backOffice: false, production: true, admin: false };
const both: Checker = { userId: "asha", backOffice: true, production: true, admin: false };
const admin: Checker = { userId: "vikram", backOffice: false, production: false, admin: true };
const telecaller: Checker = { userId: "priya", backOffice: false, production: false, admin: false };
const open = { status: "open", backOfficeById: null, productionById: null };

test("a TO is edited only while it is a TO", () => {
  assert.equal(intakeEditable("open"), true);
  assert.equal(intakeEditable("correction"), true);
  for (const s of ["hold", "verified", "cancelled"]) assert.equal(intakeEditable(s), false, s);
});

test("each power makes its own check, and somebody with neither makes none", () => {
  assert.deepEqual(nextCheck(open, backOffice), { ok: true, check: "backOffice" });
  assert.deepEqual(nextCheck(open, head), { ok: true, check: "production" });
  assert.equal(nextCheck(open, telecaller).ok, false);
});

test("the two checks are two people, an administrator excepted", () => {
  const afterNeha = { ...open, backOfficeById: "neha" };
  assert.equal(nextCheck(afterNeha, backOffice).ok, false, "the same person cannot check twice");
  assert.deepEqual(nextCheck(afterNeha, head), { ok: true, check: "production" });
  /* Somebody holding both powers makes only the one still owed, and never both. */
  assert.deepEqual(nextCheck(open, both), { ok: true, check: "production" });
  const afterAsha = { ...open, productionById: "asha" };
  assert.equal(nextCheck(afterAsha, both).ok, false);
  /* An administrator may make both. */
  const afterAdmin = { ...open, productionById: "vikram" };
  assert.deepEqual(nextCheck(afterAdmin, admin), { ok: true, check: "backOffice" });
});

test("a held, sent-back, cancelled or numbered TO takes no check", () => {
  for (const status of ["hold", "correction", "cancelled", "verified"]) assert.equal(nextCheck({ ...open, status }, head).ok, false, status);
});

test("the order number is made when both checks are on the TO", () => {
  assert.equal(bothChecked({ backOfficeById: "neha", productionById: null }), false);
  assert.equal(bothChecked({ backOfficeById: "neha", productionById: "ravi" }), true);
});

test("a line reaches production only once Accounts approved and the Production Head cleared it", () => {
  assert.equal(lineCleared({ accountsCheck: "Approved", productionCheck: "Cleared" }), true);
  assert.equal(lineCleared({ accountsCheck: "Pending", productionCheck: "Cleared" }), false);
  assert.equal(lineCleared({ accountsCheck: "Approved", productionCheck: "Pending" }), false);
  assert.match(gateRefusal({ accountsCheck: "Hold", productionCheck: "Pending" })!, /Accounts/);
  assert.match(gateRefusal({ accountsCheck: "Approved", productionCheck: "Hold" })!, /Production Head/);
  assert.equal(gateRefusal({ accountsCheck: "Approved", productionCheck: "Cleared" }), null);
  assert.equal(gateStage({ accountsCheck: "Approved", productionCheck: "Pending" }), "mrp");
});

test("a duplicate is the same party, day and goods, whatever order the lines are in", () => {
  const me = { key: "new", billingId: "c1", date: "2026-11-16", lines: [{ skuId: "a", qtyCans: 6 }, { skuId: "b", qtyCans: 24 }] };
  assert.equal(duplicateOf(me, [{ key: "TO-1", billingId: "c1", date: "2026-11-16", lines: [{ skuId: "b", qtyCans: 24 }, { skuId: "a", qtyCans: 6 }] }]), "TO-1");
  assert.equal(duplicateOf(me, [{ key: "TO-1", billingId: "c1", date: "2026-11-16", lines: [{ skuId: "a", qtyCans: 6 }] }]), null);
  assert.equal(duplicateOf(me, [{ key: "new", billingId: "c1", date: "2026-11-16", lines: me.lines }]), null, "never itself");
});

test("every desk's hold reason is a hold reason, and none of them is offered on Orders' own hold", () => {
  const office = reasonsFor("hold").map((r) => r.code);
  for (const r of [...ACCOUNTS_HOLD_REASONS, ...PRODUCTION_HOLD_REASONS]) assert.ok(HOLD_REASONS.some((h) => h.code === r.code), r.code);
  for (const desk of ["over_credit_limit", "overdue_bills", "packing_shortage", "capacity"]) assert.ok(!office.includes(desk), desk);
});
