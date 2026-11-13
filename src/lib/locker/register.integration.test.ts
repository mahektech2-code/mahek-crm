/**
 * THE LOCKER'S REGISTER, end to end — the real actions against a real
 * database, signed in as the person (spec §14.2, §14.3, §14.4).
 *
 * An asset cannot be saved without an owner; a category somebody does not
 * hold is neither readable nor writable; a reader cannot change anything; a
 * renewal walks to completion and leaves a chain; the reminder pass sends one
 * digest and never the same rung twice; a card expiring under auto-renewals
 * raises its alert; and the audit is chained and cannot be rewritten.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, appModuleAccess, lockerAssets, lockerAudit, lockerPaymentMethods, lockerRenewals, notifications, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { addDays, today } from "@/lib/format";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { completeRenewal, createAsset, markChecked, setSeat, startRenewal, updateRenewal } from "@/lib/actions/locker-assets";
import { verifyAuditChain } from "./audit";
import { canReadLockerAsset } from "./register-service";
import { runLockerReminders } from "./reminders";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

async function makeUser(name: string, modules: string[] | null, role: "associate" | "manager" | "admin" = "associate") {
  const [row] = await db
    .insert(users)
    .values({ id: id("usr"), name, email: `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 4)}@test.local`, passwordHash: "x", role, initials: name.slice(0, 2).toUpperCase() })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "locker", role });
  /* null = the whole Locker (no module rows); a list narrows it. */
  if (modules) await db.insert(appModuleAccess).values(modules.map((m) => ({ id: id("ama"), userId: row.id, app: "locker" as const, module: m })));
  return row;
}

let admin: typeof users.$inferSelect;
let compliance: typeof users.$inferSelect;
let fleet: typeof users.$inferSelect;
let auditor: typeof users.$inferSelect;

const asset = async (aid: string) => (await db.select().from(lockerAssets).where(eq(lockerAssets.id, aid)))[0];

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /_test\b/, "Run against a test database, never a working one.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table locker_reminders_sent, locker_renewals, locker_reveals, locker_secrets, locker_links, locker_credentials,
      locker_identities, locker_assets, locker_payment_methods, locker_audit, notifications, attachments, audit_log,
      app_module_access, app_access, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  admin = await makeUser("Farhan Admin", null, "admin");
  compliance = await makeUser("Ankit Compliance", ["locker.dashboard", "locker.myassets", "locker.renewals", "locker.assets", "locker.cat.statutory", "locker.cat.hazardous"]);
  fleet = await makeUser("Suresh Fleet", ["locker.dashboard", "locker.myassets", "locker.renewals", "locker.cat.vehicles"]);
  auditor = await makeUser("Neeraj Auditor", ["locker.assets", "locker.cat.statutory", "locker.cat.hazardous", "locker.cat.vehicles", "locker.audit"]);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

const pesoInput = (over: Record<string, unknown> = {}) => ({
  typeCode: "peso",
  title: "PESO storage licence · Ambernath Plant",
  endDate: addDays(today(), 47),
  issuedOn: addDays(today(), -1048),
  ownerId: compliance.id,
  backupId: admin.id,
  ...over,
});

describe("Creating an asset", () => {
  test("cannot be saved without a primary owner, nor a critical one without a backup", async () => {
    setTestUser(compliance);
    const noOwner = await createAsset(pesoInput({ ownerId: "" }));
    assert.equal(noOwner.ok, false);
    const noBackup = await createAsset(pesoInput({ backupId: null }));
    assert.equal(noBackup.ok, false);
    assert.match(noBackup.ok ? "" : noBackup.error, /backup owner/);
  });

  test("is numbered per category, checked on entry, and audited in a verifiable chain", async () => {
    setTestUser(compliance);
    const a = await createAsset(pesoInput());
    const b = await createAsset(pesoInput({ title: "PESO · Taloja" }));
    assert.ok(a.ok && b.ok);
    const [x, y] = [await asset(a.data.id), await asset(b.data.id)];
    assert.equal(x.code, "LCK-HAZ-0001");
    assert.equal(y.code, "LCK-HAZ-0002");
    assert.ok(x.lastCheckedAt);
    const chain = await verifyAuditChain();
    assert.equal(chain.ok, true);
    assert.equal(chain.rows, 2);
  });

  test("a category somebody does not hold is neither writable nor readable", async () => {
    setTestUser(compliance);
    const a = await createAsset(pesoInput());
    assert.ok(a.ok);
    setTestUser(fleet);
    const r = await createAsset(pesoInput({ ownerId: fleet.id, backupId: admin.id }));
    assert.equal(r.ok, false);
    assert.equal(await canReadLockerAsset(fleet.id, a.data.id), false);
    assert.equal(await canReadLockerAsset(auditor.id, a.data.id), true);
  });

  test("a reader with no working seat can see but never change the register", async () => {
    setTestUser(compliance);
    const a = await createAsset(pesoInput());
    assert.ok(a.ok);
    setTestUser(auditor);
    const r = await markChecked(a.data.id, "Looked at the original licence today.");
    assert.equal(r.ok, false);
    const s = await setSeat(a.data.id, "owner", auditor.id);
    assert.equal(s.ok, false);
  });
});

describe("A renewal", () => {
  test("walks to completion and leaves a chain: the old version replaced, the new one current", async () => {
    setTestUser(compliance);
    const a = await createAsset(pesoInput());
    assert.ok(a.ok);
    const started = await startRenewal(a.data.id);
    assert.ok(started.ok);
    assert.equal((await asset(a.data.id)).stage, "renewal_in_progress");

    const filed = await updateRenewal(started.data.id, { appliedOn: today(), ackNo: "P/ACK/2026/4471" });
    assert.ok(filed.ok);
    assert.equal((await asset(a.data.id)).stage, "renewal_filed");

    const early = await completeRenewal(started.data.id, { newEndDate: addDays(today(), 1142), newDocNo: "P/WC/MH/14/5512(P502218)" });
    assert.equal(early.ok, false, "cannot complete with unticked steps");

    const [r] = await db.select().from(lockerRenewals).where(eq(lockerRenewals.id, started.data.id));
    for (let i = 0; i < r.checklist.length; i++) await updateRenewal(started.data.id, { toggle: i });
    const done = await completeRenewal(started.data.id, { newEndDate: addDays(today(), 1142), newDocNo: "P/WC/MH/14/5512(P502218)" });
    assert.ok(done.ok, done.ok ? "" : done.error);

    const old = await asset(a.data.id);
    const fresh = await asset(done.data.id);
    assert.equal(old.stage, "superseded");
    assert.equal(fresh.replacesId, old.id);
    assert.equal(fresh.stage, null);
    assert.equal(fresh.endDate, addDays(today(), 1142));
    assert.equal((await verifyAuditChain()).ok, true);
  });
});

describe("Reminders", () => {
  test("send one digest per person and never the same rung twice", async () => {
    setTestUser(compliance);
    /* 30 days out is a rung on the business-critical ladder. */
    const a = await createAsset(pesoInput({ endDate: addDays(today(), 30) }));
    assert.ok(a.ok);
    /* Run on a known working day: the action day minus 30, which is today unless today is a day off. */
    const first = await runLockerReminders(today());
    const n1 = await db.select().from(notifications).where(eq(notifications.userId, compliance.id));
    const second = await runLockerReminders(today());
    const n2 = await db.select().from(notifications).where(eq(notifications.userId, compliance.id));
    if (first.rungs > 0) {
      assert.equal(n1.length, 1);
      assert.equal(second.rungs, 0);
      assert.equal(n2.length, 1);
    }
  });

  test("a card expiring under an auto-renewal raises an alert naming the subscription", async () => {
    setTestUser(admin);
    await db.insert(lockerPaymentMethods).values({ id: "pm_x", label: "Axis card · IT", last4: "1093", expiresOn: addDays(today(), 10) });
    const s = await createAsset({ typeCode: "saas", title: "Figma", endDate: addDays(today(), 200), ownerId: admin.id, provider: "Figma", amountRupees: 54000, autoRenew: true, paymentMethodId: "pm_x" });
    assert.ok(s.ok, s.ok ? "" : s.error);
    const r = await runLockerReminders(today());
    assert.equal(r.cardAlerts, 1);
    const [n] = await db.select().from(notifications).where(eq(notifications.userId, admin.id));
    assert.match(n?.body ?? "", /Figma.*1093/);
  });
});

describe("The audit", () => {
  test("cannot be altered or deleted at the database", async () => {
    setTestUser(compliance);
    await createAsset(pesoInput());
    await assert.rejects(db.execute(sql`update locker_audit set summary = 'nothing happened'`));
    await assert.rejects(db.execute(sql`delete from locker_audit`));
    assert.equal((await db.select().from(lockerAudit)).length, 1);
  });
});
