import test from "node:test";
import assert from "node:assert/strict";
import { notificationAppName, notificationAppOf, shownIn, unreadElsewhere } from "./notification-apps";

test("a notification belongs to the app its link opens", () => {
  assert.equal(notificationAppOf("/crm/customers/c_1"), "crm");
  assert.equal(notificationAppOf("/accounts/approvals?tab=x"), "accounts");
  assert.equal(notificationAppOf("/orders/approvals"), "accounts");
  assert.equal(notificationAppOf("/erp/transport#lr"), "erp");
  assert.equal(notificationAppOf("/sales-lead-pipeline/l_1"), "sales");
  assert.equal(notificationAppOf("/crmx"), null, "a prefix is a whole segment");
});

test("handset-only is the field app; no link, or a link into no app, is general", () => {
  assert.equal(notificationAppOf(null, "/tasks"), "field");
  assert.equal(notificationAppOf(null, null), null);
  assert.equal(notificationAppOf("/feedback"), null);
  assert.equal(notificationAppOf("https://example.com/crm"), null);
  assert.equal(notificationAppOf("/crm/x", "/tasks"), "crm", "the web link wins");
});

test("a bell shows its own app and general ones; outside every app, everything", () => {
  assert.equal(shownIn("crm", "crm"), true);
  assert.equal(shownIn(null, "crm"), true);
  assert.equal(shownIn("erp", "crm"), false);
  assert.equal(shownIn("erp", null), true);
});

test("unread elsewhere leaves out this app and general, biggest first", () => {
  const got = unreadElsewhere(
    [
      { app: "crm", unread: 4 },
      { app: null, unread: 2 },
      { app: "erp", unread: 1 },
      { app: "accounts", unread: 3 },
      { app: "hrms", unread: 0 },
    ],
    "crm",
  );
  assert.deepEqual(got.map((r) => r.app), ["accounts", "erp"]);
  assert.deepEqual(unreadElsewhere([{ app: "erp", unread: 1 }], null), []);
});

test("names come from the app registry", () => {
  assert.equal(notificationAppName("accounts"), "Accounts");
  assert.equal(notificationAppName(null), "General");
  assert.equal(notificationAppName("field"), "Salesman App");
});
