/**
 * ERP designations — assigning one on the Access dialog, editing it so the
 * people who match it move and the customised ones do not, deleting it, and
 * previewing the ERP as a designation or a person, read-only. Against a real
 * database through the real actions.
 *
 *   npm run test:integration
 *
 * Needs `mahekone_test` (npm run test:db). It truncates what it touches.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, appModuleAccess, erpUserDesignations, erpUserPowers, users } from "@/db/schema";
import { setAccess } from "@/lib/actions/access";
import { deleteErpDesignation, saveErpDesignation } from "@/lib/actions/erp-designations";
import { erpLoadForm, erpRunAction, erpSetWorkingGodown, erpStartViewAs, erpStopViewAs } from "@/lib/actions/erp";
import { moduleKeysForApp } from "@/lib/modules";
import type { AppId } from "@/lib/apps";
import { setTestUser } from "@/lib/auth";
import { erpContext, setTestViewAs } from "@/lib/erp/access";
import { draftFor } from "@/lib/erp/designations";
import { designationStandings, listErpDesignations } from "@/lib/services/erp-designation-service";
import { listAccess } from "@/lib/services/access-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const ALL = moduleKeysForApp("erp");

async function makeUser(name: string, level: "associate" | "manager" | "admin", apps: AppId[] = ["erp"]) {
  const [u] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\s/g, ".")}@designation.test`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role: level,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  for (const app of apps) await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app, role: level });
  return u;
}

let platform: typeof users.$inferSelect;
let erpAdmin: typeof users.$inferSelect;
let meena: typeof users.$inferSelect;
let sunil: typeof users.$inferSelect;
let testerId: string;

const TESTER = {
  name: "Quality tester",
  description: "Records purchase tests.",
  level: "associate" as const,
  allScreens: false,
  modules: ["erp.testing", "erp.expenses", "erp.videos"],
  powers: [] as string[],
};

/** A grant shaped exactly as the Access dialog sends it after a designation is picked. */
function grantFor(d: { level: "associate" | "manager" | "admin"; allScreens: boolean; modules: string[]; powers: string[] }) {
  const f = draftFor({ ...d, powers: d.powers as never }, ALL);
  return { grants: [{ app: "erp", modules: f.modules, role: f.level }], erpPowers: f.powers };
}

before(async () => {
  await db.execute(sql`truncate users, erp_designations, erp_user_powers, erp_user_settings, audit_log restart identity cascade`);
  platform = await makeUser("Meera Platform", "admin", ["admin"]);
  erpAdmin = await makeUser("Rajiv Owner", "admin");
  meena = await makeUser("Meena Tester", "associate");
  sunil = await makeUser("Sunil Tester", "associate");
});

after(async () => {
  setTestUser(null);
  setTestViewAs(null);
  await db.$client.end();
});

describe("designations", () => {
  test("only a platform administrator creates one, and a screen-less one is refused", async () => {
    setTestUser(erpAdmin);
    assert.ok(!(await saveErpDesignation(TESTER)).ok, "an ERP administrator created a designation");
    setTestUser(platform);
    const empty = await saveErpDesignation({ ...TESTER, modules: [] });
    assert.ok(!empty.ok && empty.fieldErrors?.[0]?.field === "modules");
    const made = await saveErpDesignation(TESTER);
    assert.ok(made.ok, made.ok ? "" : made.error);
    testerId = made.data.id;
    const dup = await saveErpDesignation(TESTER);
    assert.ok(!dup.ok && dup.fieldErrors?.[0]?.field === "name", "two designations shared a name");
  });

  test("the Access dialog assigns it with its screens, and the person then matches it", async () => {
    setTestUser(platform);
    for (const u of [meena, sunil]) {
      const r = await setAccess({ userId: u.id, ...grantFor(TESTER), erpDesignationId: testerId });
      assert.ok(r.ok, r.ok ? "" : r.error);
    }
    const standings = await designationStandings();
    assert.equal(standings.get(meena.id)?.matches, true);
    setTestUser(meena);
    const ctx = await erpContext();
    assert.ok(ctx.screens.has("testing") && !ctx.screens.has("stock"));
    assert.equal(ctx.designation, "Quality tester");
    /* An unknown designation is refused, not quietly dropped. */
    setTestUser(platform);
    const bad = await setAccess({ userId: meena.id, ...grantFor(TESTER), erpDesignationId: "erpd_nope" });
    assert.ok(!bad.ok);
  });

  test("a change by hand keeps the name and marks them customised", async () => {
    setTestUser(platform);
    const extra = grantFor(TESTER);
    extra.grants[0].modules.push("erp.stock");
    await setAccess({ userId: sunil.id, ...extra });
    const s = (await designationStandings()).get(sunil.id)!;
    assert.equal(s.name, "Quality tester");
    assert.equal(s.matches, false);
    assert.deepEqual(s.diff.extraScreens, ["erp.stock"]);
    const row = (await listAccess()).find((r) => r.userId === sunil.id)!;
    assert.equal(row.erpDesignation?.matches, false);
  });

  test("editing it moves everybody who matched, and leaves the customised alone", async () => {
    setTestUser(platform);
    const r = await saveErpDesignation({ ...TESTER, id: testerId, modules: [...TESTER.modules, "erp.register"], powers: ["viewPurchaseMoney"] });
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.deepEqual(r.data.moved, ["Meena Tester"]);
    assert.deepEqual(r.data.leftAlone, ["Sunil Tester"]);

    setTestUser(meena);
    const m = await erpContext();
    assert.ok(m.screens.has("register"), "the edit did not reach the person who matched");
    assert.ok(m.powers.has("viewPurchaseMoney"));
    assert.equal((await designationStandings()).get(meena.id)?.matches, true, "moving them left them customised");

    setTestUser(sunil);
    const s = await erpContext();
    assert.ok(!s.screens.has("register") && s.screens.has("stock"), "the edit overwrote a customised holder");
    assert.equal((await db.select().from(erpUserPowers).where(eq(erpUserPowers.userId, sunil.id))).length, 0);
  });

  test("raising the level moves the holder's grant and their account level", async () => {
    setTestUser(platform);
    const r = await saveErpDesignation({ ...TESTER, id: testerId, level: "manager", modules: [...TESTER.modules, "erp.register"], powers: ["viewPurchaseMoney"] });
    assert.ok(r.ok);
    const [grant] = await db.select().from(appAccess).where(eq(appAccess.userId, meena.id));
    assert.equal(grant.role, "manager");
    const [u] = await db.select().from(users).where(eq(users.id, meena.id));
    assert.equal(u.role, "manager");
  });

  test("an every-screen designation stores no module rows, which is the whole app", async () => {
    setTestUser(platform);
    const owner = await saveErpDesignation({ name: "Admin", level: "manager", allScreens: true, modules: [], powers: ["viewCost"] });
    assert.ok(owner.ok);
    const kavita = await makeUser("Kavita Admin", "manager");
    const d = (await listErpDesignations()).find((x) => x.id === owner.data.id)!;
    await setAccess({ userId: kavita.id, ...grantFor(d), erpDesignationId: d.id });
    assert.equal((await db.select().from(appModuleAccess).where(eq(appModuleAccess.userId, kavita.id))).length, 0);
    assert.equal((await designationStandings()).get(kavita.id)?.matches, true);
  });

  test("taking the ERP away takes the designation with it", async () => {
    setTestUser(platform);
    const x = await makeUser("Ravi Leaving", "associate", ["erp", "crm"]);
    await setAccess({ userId: x.id, ...grantFor(TESTER), erpDesignationId: testerId });
    await setAccess({ userId: x.id, grants: [{ app: "crm", modules: moduleKeysForApp("crm"), role: "associate" }] });
    assert.equal((await db.select().from(erpUserDesignations).where(eq(erpUserDesignations.userId, x.id))).length, 0);
  });

  test("deleting it keeps every holder's access and drops only the name", async () => {
    setTestUser(platform);
    const temp = await saveErpDesignation({ ...TESTER, name: "Temporary" });
    assert.ok(temp.ok);
    const y = await makeUser("Asha Temp", "associate");
    await setAccess({ userId: y.id, ...grantFor(TESTER), erpDesignationId: temp.data.id });
    const del = await deleteErpDesignation(temp.data.id);
    assert.ok(del.ok && del.data.unlinked === 1);
    setTestUser(y);
    assert.ok((await erpContext()).screens.has("testing"), "deleting a designation took a screen away");
  });
});

describe("previewing the ERP as somebody", () => {
  test("only an ERP administrator may preview", async () => {
    setTestUser(meena);
    assert.ok(!(await erpStartViewAs({ kind: "designation", id: testerId })).ok);
    setTestViewAs(`designation:${testerId}`);
    assert.equal((await erpContext()).viewingAs, null, "a cookie alone opened a preview for a non-administrator");
    setTestViewAs(null);
  });

  test("as a designation: its screens and powers, the administrator's own identity, and no writes", async () => {
    setTestUser(erpAdmin);
    const r = await erpStartViewAs({ kind: "designation", id: testerId });
    assert.ok(r.ok, r.ok ? "" : r.error);
    const ctx = await erpContext();
    assert.equal(ctx.viewingAs?.label, "Quality tester");
    assert.equal(ctx.actor.id, erpAdmin.id);
    assert.equal(ctx.administrator, false);
    assert.ok(ctx.screens.has("testing") && ctx.screens.has("register") && !ctx.screens.has("stock"));
    assert.ok(ctx.powers.has("viewPurchaseMoney") && !ctx.powers.has("viewCost"));

    const write = await erpRunAction("testing", "anything", "x");
    assert.ok(!write.ok && /previewing/.test(write.error), "a write went through during a preview");
    const godown = await erpSetWorkingGodown("anything");
    assert.ok(!godown.ok && /previewing/.test(godown.error));
    /* Opening a form writes nothing, so it is allowed — the submit is not. */
    const form = await erpLoadForm("stock", "x", "y");
    assert.ok(!form.ok && !/previewing/.test(form.error), "a form refused as a write; it should refuse only for the screen");
  });

  test("as a person: their own book, and back again", async () => {
    setTestUser(erpAdmin);
    const r = await erpStartViewAs({ kind: "user", id: sunil.id });
    assert.ok(r.ok);
    const ctx = await erpContext();
    assert.equal(ctx.user.id, sunil.id);
    assert.equal(ctx.actor.id, erpAdmin.id);
    assert.ok(ctx.screens.has("stock"), "the preview did not show the person's customised access");
    const stop = await erpStopViewAs();
    assert.ok(stop.ok);
    const back = await erpContext();
    assert.equal(back.viewingAs, null);
    assert.equal(back.administrator, true);
  });

  test("a preview of somebody without the ERP is refused", async () => {
    setTestUser(erpAdmin);
    assert.ok(!(await erpStartViewAs({ kind: "user", id: platform.id })).ok);
  });
});
