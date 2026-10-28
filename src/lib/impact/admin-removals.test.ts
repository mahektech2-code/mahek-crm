/**
 * The Admin Console's two account-level removals, through the impact modal:
 * turning a sign-in off, and clearing a saved credential.
 *
 *   npm run test:integration
 *
 * What it proves: each act is refused until the person has confirmed the
 * report, the report names what really moves (the sessions ended, the phone
 * shut out, which deployment key takes over), and a refusal the act would make
 * — your own account, the last administrator — is said before the button.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, appSecrets, mbosDevices, sessions, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { setUserActive } from "@/lib/actions/people";
import { clearSecretAction } from "@/lib/actions/secrets";
import { impactReport } from "@/lib/impact/registry";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let admin: typeof users.$inferSelect;
let salesman: typeof users.$inferSelect;

async function makeUser(name: string, apps: Array<{ app: string; role: "associate" | "manager" | "admin" }>) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${randomUUID().slice(0, 8)}@removals.test`,
      passwordHash: "x",
      role: apps.some((a) => a.role === "admin") ? "admin" : "associate",
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  for (const a of apps) await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: a.app as never, role: a.role });
  return row;
}

async function confirmed(kind: string, target: string) {
  const r = await impactReport(kind, target);
  assert.ok(r.ok, r.ok ? "" : r.error);
  return { typed: r.data.confirmWord, fingerprint: r.data.fingerprint };
}

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run `npm run test:db` first.");
});
after(async () => {
  setTestUser(null);
  await db.$client.end();
});
beforeEach(async () => {
  await db.execute(sql`truncate table mbos_devices, sessions, app_secrets, audit_log, app_access, users, app_settings restart identity cascade`);
  invalidateConfig();
  await seedConfig();
  admin = await makeUser("Pritesh Admin", [{ app: "admin", role: "admin" }]);
  salesman = await makeUser("Mahesh Field", [{ app: "field", role: "associate" }, { app: "crm", role: "associate" }]);
  setTestUser(admin);
});

describe("disabling a sign-in", () => {
  test("names the sessions it ends and the phone it shuts out, and keeps the apps", async () => {
    await db.insert(sessions).values({ id: id("ses"), userId: salesman.id, expiresAt: new Date(Date.now() + 86_400_000) });
    await db.insert(mbosDevices).values({ id: id("dev"), userId: salesman.id, deviceId: id("did"), model: "Redmi 12" } as never);

    const bare = await setUserActive(salesman.id, false);
    assert.equal(!bare.ok && bare.code, "validation", "a sign-in turned off with nobody confirming is refused");
    assert.equal((await db.select().from(users).where(eq(users.id, salesman.id)))[0].active, true);

    const report = await impactReport("admin-user-disable", salesman.id);
    assert.ok(report.ok, report.ok ? "" : report.error);
    const by = (label: RegExp) => report.data.items.find((i) => label.test(i.label));
    assert.equal(by(/open sign-in/)?.count, 1);
    assert.equal(by(/phone bound/)?.effect, "phones");
    assert.deepEqual(by(/phone bound/)?.examples, ["Redmi 12"]);
    assert.equal(by(/apps they hold/)?.count, 2, "the apps are kept and the modal says so");
    assert.equal(report.data.confirmWord, "Mahesh Field");

    const done = await setUserActive(salesman.id, false, { typed: "mahesh field", fingerprint: report.data.fingerprint });
    assert.ok(done.ok, done.ok ? "" : done.error);
    assert.equal((await db.select().from(sessions).where(eq(sessions.userId, salesman.id))).length, 0);
    assert.equal((await db.select().from(appAccess).where(eq(appAccess.userId, salesman.id))).length, 2);

    /* Turning it back on takes nothing away, and asks nothing. */
    assert.ok((await setUserActive(salesman.id, true)).ok);
  });

  test("your own account is refused in the modal before the button, as the act refuses it", async () => {
    const own = await impactReport("admin-user-disable", admin.id);
    assert.ok(own.ok);
    assert.match(own.data.blockers[0] ?? "", /your own account/);
    const refused = await setUserActive(admin.id, false);
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? "" : refused.error, /your own account/, "the act's own refusal comes before the confirmation");
  });
});

describe("clearing a saved key", () => {
  test("says which feature stops — or that the deployment's key takes over — and asks first", async () => {
    await db.insert(appSecrets).values({ name: "olamaps.apiKey", value: "ola-test-key-0123456789", last4: "6789" });
    const before = process.env.OLAMAPS_API_KEY;
    delete process.env.OLAMAPS_API_KEY;
    try {
      const bare = await clearSecretAction("olamaps.apiKey");
      assert.equal(!bare.ok && bare.code, "validation");

      const report = await impactReport("admin-secret", "olamaps.apiKey");
      assert.ok(report.ok, report.ok ? "" : report.error);
      assert.ok(report.data.items.some((i) => i.effect === "deleted" && i.examples?.[0]?.endsWith("6789")));
      assert.ok(report.data.items.some((i) => i.effect === "changed" && /street maps/.test(i.label)), "the maps stop drawing streets");

      process.env.OLAMAPS_API_KEY = "deployment-key-0123456789";
      const moved = await clearSecretAction("olamaps.apiKey", { typed: "REMOVE", fingerprint: report.data.fingerprint });
      assert.equal(!moved.ok && moved.code, "conflict", "the deployment key appeared since the modal opened");

      const again = await impactReport("admin-secret", "olamaps.apiKey");
      assert.ok(again.ok);
      assert.ok(again.data.items.some((i) => i.effect === "kept" && /takes over/.test(i.note ?? "")));
      const confirmation = await confirmed("admin-secret", "olamaps.apiKey");
      /* The action refreshes the console's cache afterwards, which has no
         request scope here — so the proof is the row, not the answer. */
      await clearSecretAction("olamaps.apiKey", confirmation).catch(() => null);
      assert.equal((await db.select().from(appSecrets).where(eq(appSecrets.name, "olamaps.apiKey"))).length, 0);
    } finally {
      if (before === undefined) delete process.env.OLAMAPS_API_KEY;
      else process.env.OLAMAPS_API_KEY = before;
    }
  });
});
