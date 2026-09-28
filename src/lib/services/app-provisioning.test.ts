/**
 * `crm.lead-calling-desk` is `offByDefault`, meant to be granted a person at
 * a time — but `npm run app:grant`, the provisioning endpoint and the
 * back-office bulk provision all used to write an `app_access` row with no
 * module rows at all, which `moduleAllowed()` reads as "every module",
 * `offByDefault` ones included. `grantAppWithDefaultModules` is the fix, and
 * these are the three live callers it now runs through, plus the function
 * itself and the two things it must NOT change: `moduleAllowed()`'s own
 * semantics and an administrator's automatic reach into the desk.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  appModuleAccess,
  sheetPartyRows,
  sheetSyncRuns,
  users,
} from "@/db/schema";
import { moduleAllowed, modulesForApp } from "@/lib/modules";
import { grantAppWithDefaultModules } from "@/lib/services/app-provisioning";
import { provisionUser } from "@/lib/services/provisioning-service";
import { provisionBackOffice } from "@/lib/services/team-service";
import { partyNameKey } from "@/lib/sheet-parse";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

async function makeUser(name: string, role: "associate" | "manager" | "admin" = "associate") {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 6)}@test.local`,
      phone: String(9700000000 + Math.floor(Math.random() * 99999999)),
      passwordHash: "x",
      role,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  return row;
}

async function grantedModules(userId: string, app: "crm" | "sales" = "crm") {
  return (
    await db
      .select({ module: appModuleAccess.module })
      .from(appModuleAccess)
      .where(eq(appModuleAccess.userId, userId))
  )
    .map((r) => r.module)
    .filter((m) => m.startsWith(`${app}.`));
}

before(() => {
  assert.match(
    process.env.DATABASE_URL ?? "",
    /mahekone_test/,
    "Integration tests must run against mahekone_test. Run `npm run test:db` first.",
  );
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table app_module_access, app_access, sheet_party_rows, sheet_sync_runs, users
    restart identity cascade
  `);
});

after(async () => {
  await db.$client.end();
});

describe("grantAppWithDefaultModules", () => {
  test("a fresh non-admin CRM grant gets every ordinary module, and not the calling desk", async () => {
    const person = await makeUser("Fresh Telecaller");
    await grantAppWithDefaultModules(db, { userId: person.id, app: "crm", grantedById: null });

    const [access] = await db.select().from(appAccess).where(eq(appAccess.userId, person.id));
    assert.ok(access, "the app_access row was written");
    assert.equal(access.app, "crm");
    assert.equal(access.grantedById, null, "grantedById is preserved exactly as passed");

    const rows = await grantedModules(person.id);
    const everyOrdinary = modulesForApp("crm").filter((m) => !m.offByDefault).map((m) => m.key);
    assert.deepEqual(rows.sort(), everyOrdinary.sort(), "every non-offByDefault module got an explicit row");
    assert.ok(!rows.includes("crm.lead-calling-desk"), "the desk is not among them");

    assert.equal(moduleAllowed("crm.lead-calling-desk", rows, "crm", false), false);
    assert.equal(moduleAllowed("crm.customers", rows, "crm", false), true);
  });

  test("an administrator still reaches the calling desk automatically, despite the explicit rows", async () => {
    const admin = await makeUser("Fresh Admin", "admin");
    await grantAppWithDefaultModules(db, { userId: admin.id, app: "crm", grantedById: null });
    const rows = await grantedModules(admin.id);

    // The rows themselves omit the desk, exactly like a non-admin's — the
    // bypass is `moduleAllowed`'s own administrator check, not a difference
    // in what got written.
    assert.ok(!rows.includes("crm.lead-calling-desk"));
    assert.equal(moduleAllowed("crm.lead-calling-desk", rows, "crm", true), true);
  });

  test("an explicit Telecaller grant still works, on top of this", async () => {
    const person = await makeUser("Explicitly Granted");
    await grantAppWithDefaultModules(db, { userId: person.id, app: "crm", grantedById: null });
    // The Access screen's own path: add the one row it omitted.
    await db.insert(appModuleAccess).values({
      id: id("mod"),
      userId: person.id,
      app: "crm",
      module: "crm.lead-calling-desk",
      grantedById: null,
    });
    const rows = await grantedModules(person.id);
    assert.equal(moduleAllowed("crm.lead-calling-desk", rows, "crm", false), true);
  });

  test("sales.lead-pipeline is untouched — explicitOnly stays explicitOnly", async () => {
    const person = await makeUser("Sales Grant");
    await grantAppWithDefaultModules(db, { userId: person.id, app: "sales", grantedById: null });
    const rows = await grantedModules(person.id, "sales");

    assert.ok(!rows.includes("sales.lead-pipeline"), "explicitOnly is offByDefault too, so it is excluded from the write");
    // And unlike the desk, an administrator does NOT get it for free either —
    // explicitOnly answers to nothing but its own row.
    assert.equal(moduleAllowed("sales.lead-pipeline", rows, "sales", true), false);
    assert.equal(moduleAllowed("sales.lead-pipeline", rows, "sales", false), false);
  });

  test("an app with no offByDefault modules writes no rows at all — unchanged, zero-row behaviour", async () => {
    const person = await makeUser("Reports Only");
    await grantAppWithDefaultModules(db, { userId: person.id, app: "reports", grantedById: null });
    const rows = await db
      .select()
      .from(appModuleAccess)
      .where(eq(appModuleAccess.userId, person.id));
    assert.equal(rows.length, 0, "no offByDefault module on this app, so nothing needed narrowing");
    // Zero rows still means every module — moduleAllowed's own rule, untouched.
    for (const m of modulesForApp("reports")) {
      assert.equal(moduleAllowed(m.key, [], "reports"), true);
    }
  });
});

describe("provisionUser (the provisioning API path)", () => {
  test("a fresh CRM grant through provisionUser does not carry the calling desk", async () => {
    const person = await makeUser("API Provisioned");
    await provisionUser({ user: person.email!, apps: ["crm"] });

    const rows = await grantedModules(person.id);
    assert.ok(!rows.includes("crm.lead-calling-desk"));
    assert.equal(moduleAllowed("crm.lead-calling-desk", rows, "crm", false), false);
    // And the rest of the CRM is still whole.
    assert.equal(moduleAllowed("crm.dashboard", rows, "crm", false), true);
  });

  test("existing users and their module rows are untouched by a later provisionUser call for a different app", async () => {
    const person = await makeUser("Already Narrowed");
    await db.insert(appAccess).values({ id: id("acc"), userId: person.id, app: "crm", grantedById: null });
    // Somebody had already narrowed them by hand, desk included, on purpose.
    await db.insert(appModuleAccess).values([
      { id: id("mod"), userId: person.id, app: "crm", module: "crm.dashboard", grantedById: null },
      { id: id("mod"), userId: person.id, app: "crm", module: "crm.lead-calling-desk", grantedById: null },
    ]);

    await provisionUser({ user: person.email!, addApps: ["reports"] });

    const rows = await grantedModules(person.id, "crm");
    assert.deepEqual(rows.sort(), ["crm.dashboard", "crm.lead-calling-desk"].sort(), "the existing CRM rows were not touched by granting a different app");
  });
});

describe("provisionBackOffice (the customer-master bulk provision job)", () => {
  async function stageBackOfficeParty(backOfficeName: string) {
    const [run] = await db
      .insert(sheetSyncRuns)
      .values({ id: id("syn"), source: "sales_party", spreadsheetId: "test-sheet", tabTitle: "Sales Party", mode: "reconcile", status: "ok" })
      .returning();
    await db.insert(sheetPartyRows).values({
      id: id("spr"),
      syncId: run.id,
      rowNumber: 1,
      partyName: `${backOfficeName} — party`,
      partyKey: partyNameKey(`${backOfficeName} — party`),
      raw: {},
      rowHash: randomUUID(),
      backOfficeName,
    });
  }

  test("a name newly provisioned from the customer master does not get the calling desk by default", async () => {
    const zzName = `ZZTEST Back Office ${randomUUID().slice(0, 6)}`;
    await stageBackOfficeParty(zzName);

    const report = await provisionBackOffice({ password: "test-password-1234" });
    const made = report.people.find((p) => p.name === zzName);
    assert.ok(made?.created, "a new account was created for the name on the master");

    const [person] = await db.select().from(users).where(eq(users.email, made!.email));
    assert.ok(person, "the account exists");

    const rows = await grantedModules(person.id);
    assert.ok(!rows.includes("crm.lead-calling-desk"), "provisionBackOffice no longer opens the calling desk by default");
    assert.equal(moduleAllowed("crm.lead-calling-desk", rows, "crm", false), false);
    assert.equal(moduleAllowed("crm.dashboard", rows, "crm", false), true, "the rest of the CRM is still granted whole");
  });
});
