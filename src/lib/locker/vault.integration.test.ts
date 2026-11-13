/**
 * THE VAULT, END TO END — the rules against a real database, signed in as
 * different people. Spec §14.2–14.4: an auditor cannot reveal by any path; a
 * restricted reveal fails without a second person, never approved by the
 * asker, spent once; the audit row is written before the value leaves, and a
 * failed audit write fails the reveal; a tampered value is not returned;
 * emergency access is never self-approved; offboarding cannot be signed off
 * with open tasks; the audit chain finds an altered row.
 *
 * Runs ONLY against a test database, mahekone_test or a private mahekone_locker_test (see the `before`).
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, appModuleAccess, lockerAudit, lockerCredentials, lockerReveals, lockerSecrets, users, type User } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { verifyAuditChain } from "./audit";
import * as core from "./vault-core";
import * as ops from "./ops-core";

process.env.MBOS_JWT_SECRET = process.env.MBOS_JWT_SECRET || "integration-secret-for-the-locker";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const PW = "correct horse battery";

async function person(name: string, modules: string[]): Promise<User> {
  const [u] = await db
    .insert(users)
    .values({ id: id("usr"), name, email: `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 4)}@test.local`, passwordHash: await hashPassword(PW), role: "associate", initials: name.slice(0, 2).toUpperCase() })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app: "locker", role: "associate" });
  if (modules.length) await db.insert(appModuleAccess).values(modules.map((m) => ({ id: id("mod"), userId: u.id, app: "locker" as const, module: m })));
  return u;
}

const VAULT = ["locker.dashboard", "locker.credentials", "locker.identities", "locker.graph", "locker.rotation"];
let admin: User, rahul: User, meera: User, auditor: User;
let restrictedId: string, sensitiveId: string;

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone(_locker)?_test/, "Runs only against a test database — `npm run test:db` first.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table locker_audit, locker_reveals, locker_secrets, locker_links, locker_credentials, locker_identities, locker_breakglass,
      locker_offboarding, locker_review_items, locker_settings, notifications, app_module_access, app_access, users
    restart identity cascade
  `);
  admin = await person("Farhan Admin", [...VAULT, "locker.approvals", "locker.access", "locker.offboard", "locker.review", "locker.audit"]);
  rahul = await person("Rahul Lead", [...VAULT, "locker.approvals"]);
  meera = await person("Meera Finance", ["locker.dashboard", "locker.approvals"]);
  auditor = await person("Neeraj Auditor", ["locker.assets", "locker.audit"]);
  const base = { provider: "ICICI Bank", url: "cib.icicibank.com", username: "MAHEKCORP01", env: "Production", auth: "direct", viaIdentityId: null, sole: false, identityId: null, assetId: null, backupOwnerId: null, mfa: true, mfaMethod: "hardware_key", recoveryEmail: "", accessLevel: "", rotateEveryDays: null, notes: "" };
  const r1 = await core.createCredential(admin, { ...base, title: "ICICI net banking", kind: "Banking", tier: "standard", ownerId: admin.id, revealers: [rahul.id], secrets: { "Login password": "Icici#Login-2026" } });
  assert.ok(r1.ok, r1.ok ? "" : r1.error);
  restrictedId = r1.data.id;
  const r2 = await core.createCredential(admin, { ...base, title: "DigitalOcean API", kind: "API key", tier: "sensitive", provider: "DigitalOcean", ownerId: rahul.id, revealers: [], secrets: { "API key": "dop_v1_abcdef123456" } });
  assert.ok(r2.ok);
  sensitiveId = r2.data.id;
});

after(async () => {
  await db.$client.end();
});

describe("who may reveal", () => {
  test("a bank login is restricted whatever level was asked for", async () => {
    const [c] = await db.select().from(lockerCredentials).where(eq(lockerCredentials.id, restrictedId));
    assert.equal(c.tier, "restricted");
  });

  test("the auditor, without the vault, is refused by every path (A1)", async () => {
    const plan = await core.planReveal(auditor, sensitiveId, "API key", null);
    assert.equal(plan.step, "denied");
    const r = await core.performReveal(auditor, { credentialId: sensitiveId, field: "API key", password: PW, reason: "I would like to see the API key please" });
    assert.equal(r.ok, false);
    const req = await core.requestReveal(auditor, restrictedId, "Login password", null, "auditor wants the bank login please");
    assert.equal(req.ok, false);
    const n = await db.select({ n: sql<number>`count(*)::int` }).from(lockerReveals).where(eq(lockerReveals.state, "revealed"));
    assert.equal(Number(n[0].n), 0);
  });

  test("a sensitive reveal needs the person's own password and a reason", async () => {
    assert.equal((await core.performReveal(rahul, { credentialId: sensitiveId, field: "API key", password: "wrong", reason: "rotating the deploy key for staging" })).ok, false);
    assert.equal((await core.performReveal(rahul, { credentialId: sensitiveId, field: "API key", password: PW, reason: "short" })).ok, false);
    const ok = await core.performReveal(rahul, { credentialId: sensitiveId, field: "API key", password: PW, reason: "rotating the deploy key for staging" });
    assert.ok(ok.ok);
    assert.equal(ok.data.value, "dop_v1_abcdef123456");
    assert.ok(ok.data.watermark?.includes("RAHUL LEAD"));
  });
});

describe("restricted reveals need a second person (A2)", () => {
  test("refused without an approval, refused when the asker approves it, spent exactly once", async () => {
    const none = await core.performReveal(rahul, { credentialId: restrictedId, field: "Login password", password: PW });
    assert.equal(none.ok, false);

    const req = await core.requestReveal(rahul, restrictedId, "Login password", null, "monthly settlement report download");
    assert.ok(req.ok);
    const self = await core.decideReveal(rahul, req.data.requestId, true, "");
    assert.equal(self.ok, false);
    assert.match(self.ok ? "" : self.error, /own/);

    const appr = await core.decideReveal(meera, req.data.requestId, true, "");
    assert.ok(appr.ok);
    const once = await core.performReveal(rahul, { credentialId: restrictedId, field: "Login password", password: PW, requestId: req.data.requestId });
    assert.ok(once.ok, once.ok ? "" : once.error);
    assert.equal(once.data.value, "Icici#Login-2026");
    assert.equal(once.data.clipboardSeconds, 0, "restricted values cannot be copied");
    const twice = await core.performReveal(rahul, { credentialId: restrictedId, field: "Login password", password: PW, requestId: req.data.requestId });
    assert.equal(twice.ok, false);

    const [audit] = await db.select().from(lockerAudit).where(eq(lockerAudit.action, "locker.secret.revealed"));
    assert.equal(audit.approvedById, meera.id);
    assert.ok(!JSON.stringify(audit).includes("Icici#Login-2026"), "the audit never holds the value");
  });

  test("somebody not named on a restricted login cannot even ask", async () => {
    const outsider = await person("Sagar Exec", VAULT);
    const r = await core.requestReveal(outsider, restrictedId, "Login password", null, "need to check the balance today");
    assert.equal(r.ok, false);
  });
});

describe("the audit comes first (E7)", () => {
  test("if the audit row cannot be written, nothing is revealed", async () => {
    await db.execute(sql`create or replace function locker_test_refuse() returns trigger as $$ begin raise exception 'audit store unavailable'; end; $$ language plpgsql`);
    await db.execute(sql`create trigger locker_test_refuse before insert on locker_audit for each row when (new.action = 'locker.secret.revealed') execute function locker_test_refuse()`);
    try {
      const r = await core.performReveal(rahul, { credentialId: sensitiveId, field: "API key", password: PW, reason: "checking the key while the audit is down" });
      assert.equal(r.ok, false);
      const n = await db.select({ n: sql<number>`count(*)::int` }).from(lockerReveals).where(eq(lockerReveals.state, "revealed"));
      assert.equal(Number(n[0].n), 0, "no reveal row survives a failed audit write");
    } finally {
      await db.execute(sql`drop trigger if exists locker_test_refuse on locker_audit`);
    }
  });

  test("a tampered value is refused and the failure is recorded", async () => {
    const [s] = await db.select().from(lockerSecrets).where(eq(lockerSecrets.credentialId, sensitiveId));
    const [iv, tag, data] = s.ciphertext.split(":");
    const b = Buffer.from(data, "base64");
    b[0] ^= 0x01;
    await db.update(lockerSecrets).set({ ciphertext: `${iv}:${tag}:${b.toString("base64")}` }).where(eq(lockerSecrets.id, s.id));
    const r = await core.performReveal(rahul, { credentialId: sensitiveId, field: "API key", password: PW, reason: "checking after a suspected tamper" });
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /integrity/);
    const fails = await db.select().from(lockerAudit).where(and(eq(lockerAudit.action, "locker.secret.reveal_declined"), eq(lockerAudit.entityId, sensitiveId)));
    assert.ok(fails.some((f) => /integrity/.test(f.summary)));
  });
});

describe("a password change keeps the old value", () => {
  test("the old value is retired, not overwritten, and reuse is found by fingerprint", async () => {
    const r = await core.recordChange(rahul, sensitiveId, "API key", "Icici#Login-2026", "rotated after the vendor change");
    assert.ok(r.ok);
    assert.deepEqual(r.data.reusedWith, ["ICICI net banking"]);
    const rows = await db.select().from(lockerSecrets).where(eq(lockerSecrets.credentialId, sensitiveId));
    assert.equal(rows.length, 2);
    assert.equal(rows.filter((x) => !x.retiredAt).length, 1);
  });
});

describe("emergency access (A3)", () => {
  test("never approved by the person who started it", async () => {
    const s = await core.startBreakglass(rahul, [restrictedId], "Production payment page is down and the finance manager is unreachable");
    assert.ok(s.ok, s.ok ? "" : s.error);
    const self = await core.decideBreakglass(rahul, s.data.id, true);
    assert.equal(self.ok, false);
    const other = await core.decideBreakglass(meera, s.data.id, true);
    assert.ok(other.ok);
    /* Inside the window a named restricted login reveals without a separate approval, still with the password and a reason. */
    const r = await core.performReveal(rahul, { credentialId: restrictedId, field: "Login password", password: PW, reason: "emergency: settle the failed payroll" });
    assert.ok(r.ok, r.ok ? "" : r.error);
    const [rev] = await db.select().from(lockerReveals).where(eq(lockerReveals.state, "revealed"));
    assert.equal(rev.breakglassId, s.data.id);
    assert.equal((await core.reviewBreakglass(rahul, s.data.id, "looked fine to me")).ok, false, "not reviewed by the person who used it");
  });
});

describe("offboarding", () => {
  test("cannot be signed off with open tasks, and a login is ticked only once it has really been changed", async () => {
    const s = await ops.startOffboarding(admin, rahul.id);
    assert.ok(s.ok);
    const signEarly = await ops.signOffOffboarding(admin, s.data.id);
    assert.equal(signEarly.ok, false);
    const [ob] = await db.execute<{ items: ops.OffItem[] }>(sql`select items from locker_offboarding where id = ${s.data.id}`);
    const items = (ob as unknown as { items: ops.OffItem[] }).items;
    const rotIdx = items.findIndex((i) => i.kind === "rotate" && i.id === sensitiveId);
    assert.ok(rotIdx >= 0, "the login he owns is on the list");
    assert.equal((await ops.completeOffItem(admin, s.data.id, rotIdx, { done: true })).ok, false, "not before a new value is recorded");
    assert.ok((await core.recordChange(admin, sensitiveId, "API key", "dop_v1_newvalue987", "rotated for the leaver")).ok);
    assert.ok((await ops.completeOffItem(admin, s.data.id, rotIdx, { done: true })).ok);
    for (let i = 0; i < items.length; i++) if (i !== rotIdx) assert.ok((await ops.completeOffItem(admin, s.data.id, i, { done: true, to: admin.id })).ok);
    assert.ok((await ops.signOffOffboarding(admin, s.data.id)).ok);
  });
});

describe("the audit chain", () => {
  test("is intact after real writes, and finds a row altered behind the app's back", async () => {
    const v1 = await verifyAuditChain();
    assert.ok(v1.ok && v1.rows > 0);
    /* The trigger refuses UPDATE for the app; the test, as the table's owner, steps around it on purpose. */
    await assert.rejects(db.execute(sql`update locker_audit set summary = 'nothing happened' where seq = 1`));
    await db.execute(sql`alter table locker_audit disable trigger locker_audit_no_change`);
    try {
      await db.execute(sql`update locker_audit set summary = 'nothing happened' where seq = 1`);
    } finally {
      await db.execute(sql`alter table locker_audit enable trigger locker_audit_no_change`);
    }
    const v2 = await verifyAuditChain();
    assert.equal(v2.ok, false);
    assert.equal(v2.ok ? 0 : v2.brokenAt, 1);
  });
});
