import test from "node:test";
import assert from "node:assert/strict";
import { routeNextActions, routingNote } from "./next-action-routing";

const ME = "u_me";
const SALESMAN = "u_salesman";
const BACK_OFFICE = "u_backoffice";
const MANAGER = "u_manager";
const ALL = { salesUserId: SALESMAN, backOfficeUserId: BACK_OFFICE, salesManagerUserId: MANAGER };
const NONE = { salesUserId: null, backOfficeUserId: null, salesManagerUserId: null };

/* ---------------------------------------------------------------------------
 * WHO A NEXT ACTION IS FOR.
 *
 * Before this, every action became a reminder on the caller's own list —
 * including three the caller cannot do. These pin the three that move, the
 * ones that must not, and the fall-back that says where a seat is empty.
 * ------------------------------------------------------------------------- */

test("actions that belong to the caller stay with the caller, in one group", () => {
  const g = routeNextActions(["call_back", "send_price"], ALL, ME);
  assert.equal(g.length, 1);
  assert.equal(g[0].assigneeId, ME);
  assert.equal(g[0].routedTo, "self");
  assert.deepEqual(g[0].actions, ["call_back", "send_price"]);
  assert.equal(g[0].fellBack, null);
});

test("a salesman visit goes to the salesperson on the account", () => {
  const g = routeNextActions(["salesman_visit"], ALL, ME);
  assert.deepEqual(g.map((x) => [x.assigneeId, x.routedTo]), [[SALESMAN, "salesman"]]);
});

test("contact logistics goes to the back office person, and escalate to the sales manager", () => {
  const g = routeNextActions(["contact_logistics", "escalate"], ALL, ME);
  assert.deepEqual(
    g.map((x) => [x.assigneeId, x.routedTo]),
    [
      [BACK_OFFICE, "back_office"],
      [MANAGER, "sales_manager"],
    ],
  );
});

test("a mixed call makes the caller's own group FIRST, so the call keeps pointing at its own reminder", () => {
  const g = routeNextActions(["salesman_visit", "send_quotation", "contact_logistics"], ALL, ME);
  assert.equal(g[0].assigneeId, ME);
  assert.deepEqual(g[0].actions, ["send_quotation"]);
  assert.deepEqual(g.slice(1).map((x) => x.assigneeId).sort(), [BACK_OFFICE, SALESMAN].sort());
});

test("two actions for one person are one reminder for that person", () => {
  const g = routeNextActions(["salesman_visit", "salesman_visit"], ALL, ME);
  assert.equal(g.length, 1);
});

test("an EMPTY seat keeps the action with the caller and says why", () => {
  const g = routeNextActions(["salesman_visit"], NONE, ME);
  assert.equal(g.length, 1);
  assert.equal(g[0].assigneeId, ME);
  assert.match(g[0].fellBack ?? "", /no salesperson is recorded/);
});

test("where the caller IS the seat there is nothing to hand over and nothing to announce", () => {
  const g = routeNextActions(["salesman_visit"], { ...NONE, salesUserId: ME }, ME);
  assert.equal(g.length, 1);
  assert.equal(g[0].routedTo, "self");
  assert.equal(g[0].fellBack, null);
});

test("the Accounts desk is NOT routed — it has no per-customer seat to name", () => {
  const g = routeNextActions(["accounts_follow_up", "payment_proof_required"], ALL, ME);
  assert.equal(g.length, 1);
  assert.equal(g[0].assigneeId, ME);
});

test("no actions, no groups", () => {
  assert.deepEqual(routeNextActions([], ALL, ME), []);
});

test("the panel's sentence appears only where something is actually handed over", () => {
  assert.equal(routingNote(["call_back", "send_price"]), null);
  assert.match(routingNote(["salesman_visit"]) ?? "", /salesperson on the account/);
  assert.match(routingNote(["contact_logistics", "escalate"]) ?? "", /back office.*sales manager/);
});
