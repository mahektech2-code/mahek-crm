/**
 * EDIT AND DELETE TICKS ON PURCHASE, against the database — a grant saved
 * through Manage access (`setAccess` with `screenGrants`), read by the ERP
 * (`erpContext` → `ticks`), drawn by the list (`screenModule(...).load` marks
 * what the person may not do) and refused by the server
 * (`erpRunAction`/`erpSubmitForm`/`erpRunBulk`, `erpQuoteApply`).
 *
 *   npm run test:integration
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, employees, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { setAccess, type ScreenGrantInput } from "@/lib/actions/access";
import { erpRunAction, erpRunBulk, erpSubmitForm } from "@/lib/actions/erp";
import { erpQuoteApply } from "@/lib/actions/erp-quotes";
import { erpContext } from "@/lib/erp/access";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
let boss: typeof users.$inferSelect;

async function account(name: string) {
  const [e] = await db
    .insert(employees)
    .values({ id: id("emp"), rowNumber: Math.floor(Math.random() * 1e6), employeeCode: `E${randomUUID().slice(0, 6)}`, name, status: "active", raw: {}, rowHash: randomUUID() })
    .returning();
  const [u] = await db
    .insert(users)
    .values({ id: id("usr"), name, email: `${randomUUID().slice(0, 8)}@test.local`, phone: `98330${String(Math.floor(Math.random() * 1e5)).padStart(5, "0")}`, passwordHash: "x", role: "associate", initials: name.slice(0, 2).toUpperCase(), employeeId: e.id })
    .returning();
  return u;
}


/** Purchase given with these ticks per page: [edit, delete]. */
function purchase(pages: Record<string, [boolean, boolean]>): ScreenGrantInput {
  return {
    app: "erp",
    position: "associate",
    modules: ["ERP · Purchase"],
    screens: Object.entries(pages).map(([k, [edit, del]]) => ({ screen: `erp.${k}`, edit: edit || del, delete: del, autoEdit: false })),
  };
}

async function asPerson(u: typeof users.$inferSelect) {
  setTestUser((await db.select().from(users).where(eq(users.id, u.id)))[0]);
  return erpContext();
}

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Integration tests must run against mahekone_test.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table app_screen_access, app_module_access, app_access, erp_user_powers, hrms_user_powers, task_user_powers,
      notifications, sessions, audit_log, employees, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  const [row] = await db
    .insert(users)
    .values({ id: id("usr"), name: "Boss", email: `boss-${randomUUID().slice(0, 4)}@test.local`, phone: "9820000002", passwordHash: "x", role: "admin", initials: "BO" })
    .returning();
  boss = row;
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "admin", role: "admin" });
  setTestUser(boss);
});


after(async () => {
  setTestUser(null);
  await db.$client.end();
});

const refusedFor = (r: { ok: boolean; code?: string; error?: string }) => !r.ok && r.code === "not_permitted";

test("the ERP reads the ticks a converted grant was saved with", async () => {
  const p = await account("Store Clerk");
  assert.ok((await setAccess({ userId: p.id, grants: [], screenGrants: [purchase({ requisitions: [false, false], inward: [true, false], register: [true, true] })] })).ok);
  const ctx = await asPerson(p);
  assert.deepEqual(ctx.ticks?.get("requisitions"), { edit: false, delete: false });
  assert.deepEqual(ctx.ticks?.get("inward"), { edit: true, delete: false });
  assert.deepEqual(ctx.ticks?.get("register"), { edit: true, delete: true });
});

test("Access only: ordinary work goes through, change and take-back are refused with the reason", async () => {
  const p = await account("Raiser");
  assert.ok((await setAccess({ userId: p.id, grants: [], screenGrants: [purchase({ requisitions: [false, false], inward: [false, false], register: [false, false], quoteManager: [false, false] })] })).ok);
  await asPerson(p);
  const cancel = await erpRunAction("requisitions", "cancel", "no-such-id", { reason: "x" });
  assert.ok(refusedFor(cancel), JSON.stringify(cancel));
  assert.match((cancel as { error: string }).error, /Needs Delete on Requirements/);
  assert.ok(refusedFor(await erpRunAction("requisitions", "linkPo", "no-such-id", { poNo: "PO-1" })), "linking a PO is Edit");
  assert.ok(refusedFor(await erpSubmitForm("requisitions", "edit", {}, [], "no-such-id")), "the Edit form is Edit");
  assert.ok(refusedFor(await erpRunAction("inward", "void", "no-such-id", {})), "voiding a receipt line is Delete");
  assert.ok(refusedFor(await erpRunBulk("register", "verifyMany", ["no-such-id"])), "a bulk change is Edit");
  assert.ok(refusedFor(await erpQuoteApply([{ op: "deleteRow", rowId: "eqr_nosuchrow1" }])), "deleting a quotation row is Delete");
  const raise = await erpSubmitForm("requisitions", "new", {}, []);
  assert.equal(refusedFor(raise), false, "raising a requirement is Access — refused only for its empty fields");
});

test("Edit without Delete: changes go through to the handler, take-backs do not", async () => {
  const p = await account("Buyer");
  assert.ok((await setAccess({ userId: p.id, grants: [], screenGrants: [purchase({ requisitions: [true, false], purchaseOrders: [true, false] })] })).ok);
  await asPerson(p);
  assert.equal(refusedFor(await erpRunAction("requisitions", "linkPo", "no-such-id", { poNo: "PO-1" })), false, "reaches the handler (which finds no such record)");
  assert.ok(refusedFor(await erpRunAction("requisitions", "cancel", "no-such-id", { reason: "x" })));
  assert.ok(refusedFor(await erpRunAction("purchaseOrders", "cancel", "no-such-id", { reason: "x" })));
  assert.equal(refusedFor(await erpRunAction("purchaseOrders", "close", "no-such-id", { reason: "x" })), false);
});

test("an unconverted grant keeps every act it had", async () => {
  const p = await account("Old Grant");
  await db.insert(appAccess).values({ id: id("aca"), userId: p.id, app: "erp", role: "associate" });
  const ctx = await asPerson(p);
  assert.equal(ctx.ticks, undefined);
  assert.equal(refusedFor(await erpRunAction("requisitions", "cancel", "no-such-id", { reason: "x" })), false);
});

test("Create one PO is Create PO for several: offered with Edit on Requirements, refused at the server without it", async () => {
  const p = await account("Raiser Two");
  assert.ok((await setAccess({ userId: p.id, grants: [], screenGrants: [purchase({ requisitions: [false, false], purchaseOrders: [false, false] })] })).ok);
  const ctx = await asPerson(p);
  const { applyTicks } = await import("@/lib/erp/action-ticks");
  const spec = { screen: "requisitions", cols: [], hidden: [], bulk: [{ id: "createOnePo", l: "Create one PO", client: "startInRecord" as const, fits: "createPo" }] };
  const rows: import("@/lib/erp/ui").ListRow[] = [{ id: "r1", v: {}, flags: [], actions: [{ id: "createPo", l: "Create PO", primary: true, opens: true }] }];
  const read = applyTicks(ctx, "requisitions", { spec, rows });
  assert.deepEqual(read.spec.bulk, [], "the bulk act is not offered without Edit on Requirements");
  assert.equal(read.rows[0].actions![0].tickHidden, true, "nor the row's Create PO");
  /* The record's Create PO — what Create one PO runs — is refused at the server. */
  assert.ok(refusedFor(await erpRunAction("requisitions", "createPo", "no-such-id", { vendor: "x" })));
  /* There is no server bulk to slip past: the selection only ever runs Create PO. */
  assert.equal((await erpRunBulk("requisitions", "createOnePo", ["no-such-id"])).ok, false);
});
