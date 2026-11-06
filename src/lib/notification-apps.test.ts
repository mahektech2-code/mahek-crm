import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { notificationAppName, notificationAppOf, reachesHandset, shownIn, unreadElsewhere } from "./notification-apps";

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

test("the Salesman App has no web screens, so its notifications are in no web bell", () => {
  assert.equal(notificationAppOf("/field/tasks"), "field");
  assert.equal(notificationAppOf("/field"), "field");
  assert.equal(shownIn("field", "erp"), false);
  assert.equal(shownIn("field", null), false, "All apps does not show them either");
  assert.deepEqual(unreadElsewhere([{ app: "field", unread: 4 }], "erp"), []);
});

test("the phone gets what names a phone screen, and general notices, and nothing else", () => {
  assert.equal(reachesHandset(null, "/tasks"), true);
  assert.equal(reachesHandset("/crm/performance", "/performance"), true);
  assert.equal(reachesHandset(null, null), true, "general is everyone's");
  assert.equal(reachesHandset("/erp/orders", null), false, "a desk's alert does not buzz a phone");
  assert.equal(reachesHandset("/feedback", null), false);
});

test("every direct insert into notifications names where it goes", () => {
  /* notifyUsers is held to this by its type; a raw insert is not. */
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [path] : [];
    });
  const missing: string[] = [];
  for (const file of walk("src")) {
    if (file.endsWith(join("db", "seed.ts"))) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (/\.insert\(notifications\)/.test(line + (lines[i + 1] ?? "")) && !/\.insert\(notifications\)/.test(lines[i - 1] ?? "")) {
        if (!/\b(href|mbosHref)\b/.test(lines.slice(i, i + 30).join("\n"))) missing.push(`${file}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(missing, []);
});
