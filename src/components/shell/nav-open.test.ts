import test from "node:test";
import assert from "node:assert/strict";
import { SHUT, openGroupFor, packChoice } from "./nav-open";

/* ---------------------------------------------------------------------------
 * The accordion's one rule, and mostly the one case that was wrong.
 *
 * Every screen in the CRM belongs to a group, so `activeGroup` was answered on
 * every screen — and it used to win over everything. A heading is a button
 * rather than a link, so pressing one on a screen the sidebar already claimed
 * did nothing at all: no group opened and nothing navigated. Lead Management
 * is the group somebody found it on, standing on Customers.
 * ------------------------------------------------------------------------- */

const GROUPS = [
  { label: "Overview" },
  { label: "Customer records" },
  { label: "Lead Management" },
];

test("a heading pressed on this screen opens, even inside another group", () => {
  assert.equal(
    openGroupFor(
      GROUPS,
      "Customer records",
      packChoice("/crm/customers", "Lead Management"),
      "/crm/customers",
    ),
    "Lead Management",
  );
});

test("and the group you are standing in can be shut from inside it", () => {
  assert.equal(
    openGroupFor(GROUPS, "Customer records", packChoice("/crm/customers", SHUT), "/crm/customers"),
    null,
  );
});

test("but navigating somewhere else opens the group holding the route", () => {
  assert.equal(
    openGroupFor(
      GROUPS,
      "Customer records",
      packChoice("/crm/leads", "Lead Management"),
      "/crm/customers",
    ),
    "Customer records",
  );
});

test("a label stored before the pathname travelled with it is a preference", () => {
  assert.equal(openGroupFor(GROUPS, null, "Lead Management", "/crm/help"), "Lead Management");
  assert.equal(openGroupFor(GROUPS, "Overview", "Lead Management", "/crm/dashboard"), "Overview");
});

test("a remembered group that no longer exists falls back to the first", () => {
  assert.equal(openGroupFor(GROUPS, null, packChoice("/crm/x", "Gone"), "/crm/x"), "Overview");
});

test("nothing remembered and no route claimed opens the first group", () => {
  assert.equal(openGroupFor(GROUPS, null, "", "/crm/whatever"), "Overview");
  assert.equal(openGroupFor([], null, "", "/crm/whatever"), null);
});

test("an old shut stays shut until something claims the route", () => {
  assert.equal(openGroupFor(GROUPS, null, SHUT, "/crm/help"), null);
  assert.equal(openGroupFor(GROUPS, "Overview", SHUT, "/crm/dashboard"), "Overview");
});
