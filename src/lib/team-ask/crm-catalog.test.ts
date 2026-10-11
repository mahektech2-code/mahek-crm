import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedTables, buildViews } from "./catalog";
import { CRM_MODULE_LABEL, CRM_TABLES } from "./crm-catalog";
import { getModule } from "@/lib/modules";
import { looksLikeQuestion } from "@/lib/search-hit";

/* ------------------------------------------------------- the CRM's catalog */

test("every module a CRM table needs is a real CRM module, and is named", () => {
  for (const t of CRM_TABLES) {
    for (const m of t.modules) {
      assert.equal(getModule(m)?.app, "crm", `${t.table} names ${m}, which is not a CRM module`);
      assert.ok(CRM_MODULE_LABEL[m], `${m} has no label for "you would need …"`);
    }
  }
});

test("a table is offered only to somebody holding a screen that shows it", () => {
  const names = (mods: string[]) => allowedTables(new Set(mods), CRM_TABLES).map((t) => t.table);
  const bare = names([]);
  assert.ok(bare.includes("customers"));
  assert.ok(!bare.includes("bills"), "bills need Sales Bills, Outstanding or Payment Follow-up");
  assert.ok(!bare.includes("complaints"));
  assert.ok(!bare.includes("wa_messages"));
  assert.ok(names(["crm.outstanding"]).includes("bills"));
  assert.ok(names(["crm.complaints"]).includes("complaints"));
});

test("a telecaller's views name only the people in their book, and never a trashed lead", () => {
  const columns = new Map(CRM_TABLES.map((t) => [t.table, ["id", "customer_id", "user_id", "name", "password_hash", "deleted_at", "body"]]));
  const { statements } = buildViews({
    salesmanIds: ["usr_a"],
    selfId: "usr_a",
    own: true,
    modules: new Set(["crm.whatsapp"]),
    columns,
    tables: CRM_TABLES,
  });
  const all = statements.join("\n");
  assert.match(all, /insert into pg_temp\.ask_scope_users \(id\) values \('usr_a'\)/);
  const customers = statements.find((s) => s.startsWith('create temp view "customers"'))!;
  assert.match(customers, /deleted_at is null/);
  assert.match(customers, /back_office_am_id in \(select id from pg_temp\.ask_scope_users\)/);
  assert.ok(!/password_hash/.test(all), "credentials are never in a view");
  const wa = statements.find((s) => s.startsWith('create temp view "wa_messages"'))!;
  assert.ok(!/"body"/.test(wa), "a message's text stays out of the WhatsApp view");
});

/* ------------------------------------------------- what reads as a question */

test("a question is told from a name", () => {
  for (const q of ["who owes the most?", "Which customers are due to order this week", "how many calls did Priya make today", "kaun sa customer due hai", "sharma?"]) {
    assert.equal(looksLikeQuestion(q), true, q);
  }
  for (const q of ["Sharma Paints", "MM/2026/4021", "98200", "who", "how paints"]) {
    assert.equal(looksLikeQuestion(q), false, q);
  }
});
