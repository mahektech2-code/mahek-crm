import { test } from "node:test";
import assert from "node:assert/strict";
import { guardSql } from "./sql-guard";
import { TtlCache, normaliseQuestion, normaliseSql } from "./cache";
import { TABLES, allowedTables, buildViews, visibleColumns } from "./catalog";

/* --------------------------------------------------------------- the guard */

test("an ordinary read passes, with one trailing semicolon stripped", () => {
  const r = guardSql("select u.name, count(*) from users u join mbos_visits v on v.salesman_id = u.id group by 1;");
  assert.equal(r.ok, true);
  if (r.ok) assert.ok(!r.sql.endsWith(";"));
  assert.equal(guardSql("with x as (select 1) select * from x").ok, true);
});

test("a literal may contain any word without being refused", () => {
  assert.equal(guardSql("select * from customers where name ilike '%public paints; delete%'").ok, false, "a semicolon is still refused");
  assert.equal(guardSql("select * from customers where name ilike '%Public Paints delete%'").ok, true);
});

test("everything that reaches past the views is refused", () => {
  for (const q of [
    "select * from public.app_secrets",
    'select * from "public"."users"',
    "select * from pg_catalog.pg_user",
    "select pg_read_file('/etc/passwd')",
    "select pg_terminate_backend(1)",
    "select query_to_xml('select * from public.app_secrets', true, true, '')",
    "select * from ts_stat('select 1')",
    "select lo_import('/etc/passwd')",
    "select set_config('search_path','public',true)",
    "select * from information_schema.tables",
    "select 1; delete from users",
    "delete from users",
    "update users set name = 'x'",
    "copy (select 1) to program 'id'",
    "select * from users for update",
    "select * into x from users",
    "select 1 -- hi",
    "select 1 /* hi */",
    "select E'\\x41'",
    "select * from U&\"\\0070ublic\".users",
    "explain select 1",
  ]) {
    assert.equal(guardSql(q).ok, false, q);
  }
});

/* ---------------------------------------------------------------- the cache */

test("a cache entry expires and the oldest is evicted past the cap", () => {
  let now = 0;
  const c = new TtlCache<number>(2, () => now);
  c.set("a", 1, 100);
  c.set("b", 2, 100);
  assert.equal(c.get("a"), 1); // a is now the most recent
  c.set("c", 3, 100);
  assert.equal(c.get("b"), undefined, "b was least recently used");
  assert.equal(c.get("a"), 1);
  now = 150;
  assert.equal(c.get("a"), undefined, "expired");
});

test("normalised SQL folds case and space outside literals only", () => {
  assert.equal(
    normaliseSql("SELECT  *\n FROM users WHERE name = 'Mahesh  K';"),
    "select * from users where name = 'Mahesh  K'",
  );
  assert.notEqual(normaliseSql("select 'A'"), normaliseSql("select 'a'"));
  assert.equal(normaliseQuestion("Who is on leave today?"), normaliseQuestion("who is on  leave today"));
});

/* -------------------------------------------------------------- the catalog */

const columns = new Map(TABLES.map((t) => [t.table, ["id", "user_id", "customer_id", "name", "password_hash", "net_salary_paise", "raw", "salesman_id", "employee_id", "owner_id", "sales_am_id", "back_office_am_id", "sales_manager_id", "lead_manager_id", "relationship_owner_id", "deleted_at", "plan_id", "assigned_to_user_id", "assigned_by_user_id", "requested_by_user_id", "approver_user_id", "reported_by_id", "actor_user_id", "matched_salesman_id"]]));

test("a table is offered only to a holder of a screen that shows it", () => {
  const none = new Set(allowedTables(new Set()).map((t) => t.table));
  assert.ok(none.has("users") && none.has("customers"));
  assert.ok(!none.has("mbos_leave_requests"), "leave needs the Leave screen");
  assert.ok(!none.has("hrms_salaries"), "salaries need the Salary screen");
  assert.ok(!none.has("mbos_positions"), "the trail needs the Live map");
  const leave = new Set(allowedTables(new Set(["sales.leave"])).map((t) => t.table));
  assert.ok(leave.has("mbos_leave_requests"));
});

test("credentials and identity numbers are never a column, salary only with the Salary screen", () => {
  const employees = TABLES.find((t) => t.table === "employees")!;
  const cols = ["id", "name", "password_hash", "aadhaar_number", "pan_number", "account_number", "net_salary_paise", "raw"];
  assert.deepEqual(visibleColumns(employees, cols, new Set()), ["id", "name"]);
  assert.deepEqual(visibleColumns(employees, cols, new Set(["sales.salary"])), ["id", "name", "net_salary_paise"]);
});

test("a regional reader's views are narrowed to their people; a national one's are not", () => {
  const regional = buildViews({ salesmanIds: ["u1", "u2"], selfId: "me", own: false, modules: new Set(["sales.leave"]), columns });
  const leave = regional.statements.find((s) => s.includes('view "mbos_leave_requests"'))!;
  assert.match(leave, /"user_id" in \(select id from pg_temp\.ask_scope_users\)/);
  assert.ok(regional.statements.some((s) => s.includes("('me'), ('u1'), ('u2')")));
  assert.ok(regional.statements.every((s) => !s.includes("password_hash")));

  const national = buildViews({ salesmanIds: null, selfId: "me", own: false, modules: new Set(["sales.leave"]), columns });
  const nleave = national.statements.find((s) => s.includes('view "mbos_leave_requests"'))!;
  assert.match(nleave, /where true$/);
  const ncust = national.statements.find((s) => s.includes('view "customers"'))!;
  assert.match(ncust, /where deleted_at is null$/, "the trash is out even for a national reader");
});

test("an associate's customers leave out the leads nobody holds", () => {
  const own = buildViews({ salesmanIds: ["me"], selfId: "me", own: true, modules: new Set(), columns });
  const mgr = buildViews({ salesmanIds: ["me"], selfId: "me", own: false, modules: new Set(), columns });
  const cust = (b: typeof own) => b.statements.find((s) => s.includes('view "customers"'))!;
  assert.ok(!cust(own).includes("owner_id is null"));
  assert.ok(cust(mgr).includes("owner_id is null"));
});
