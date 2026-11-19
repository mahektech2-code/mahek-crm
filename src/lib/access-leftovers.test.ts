/**
 *   npm run test:integration
 *
 * The permission leftovers around `setAccess`: the person is told when their
 * access changes, a Hire role that does not fit its level is refused on the
 * server, the person a factory seat is taken from gets a line on their own
 * trail, and `hrms-for-everyone` gives HRMS to every active, linked account
 * that lacks it — once.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, auditLog, employees, notifications, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { setAccess } from "@/lib/actions/access";
import { hrmsForEveryone } from "@/lib/services/hrms-for-everyone";
import { moduleKeysForApp } from "@/lib/modules";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
let boss: typeof users.$inferSelect;
let phoneSeq = 0;

async function account(name: string, opts: { employee?: "active" | "inactive" | null; notEmployee?: boolean; active?: boolean } = {}) {
  let employeeId: string | null = null;
  if (opts.employee) {
    const [e] = await db
      .insert(employees)
      .values({ id: id("emp"), rowNumber: Math.floor(Math.random() * 1e6), employeeCode: `E${randomUUID().slice(0, 6)}`, name, status: opts.employee, raw: {}, rowHash: randomUUID() })
      .returning();
    employeeId = e.id;
  }
  const [u] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${randomUUID().slice(0, 8)}@test.local`,
      phone: `98300${String(++phoneSeq).padStart(5, "0")}`,
      passwordHash: "x",
      role: "associate",
      initials: name.slice(0, 2).toUpperCase(),
      employeeId,
      notEmployee: opts.notEmployee ?? false,
      active: opts.active ?? true,
    })
    .returning();
  return u;
}

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Integration tests must run against mahekone_test.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table app_module_access, app_access, notifications, factory_team_defaults, factory_staff, hire_user_roles,
      sessions, audit_log, employees, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  const [row] = await db
    .insert(users)
    .values({ id: id("usr"), name: "Boss", email: `boss-${randomUUID().slice(0, 4)}@test.local`, phone: "9820000001", passwordHash: "x", role: "admin", initials: "BO" })
    .returning();
  boss = row;
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "admin", role: "admin" });
  setTestUser(boss);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

const crm = (role = "associate") => ({ app: "crm" as const, modules: moduleKeysForApp("crm"), role: role as "associate" });
const bells = (userId: string) => db.select().from(notifications).where(eq(notifications.userId, userId));

test("a change to somebody's access rings their bell once, in the save's own words — and nothing when nothing changed", async () => {
  const p = await account("Asha Telecaller", { employee: "active" });
  assert.ok((await setAccess({ userId: p.id, grants: [crm()] })).ok);
  let rows = await bells(p.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Your MahekOne access changed");
  assert.match(rows[0].body, /now opens .*CRM/);
  assert.match(rows[0].body, /Changed by Boss/);

  assert.ok((await setAccess({ userId: p.id, grants: [crm("manager")] })).ok);
  rows = await bells(p.id);
  assert.equal(rows.length, 2);
  assert.ok(rows.some((r) => /manager on .*CRM/i.test(r.body)), JSON.stringify(rows.map((r) => r.body)));

  const same = await setAccess({ userId: p.id, grants: [crm("manager")] });
  assert.ok(same.ok);
  assert.equal((await bells(p.id)).length, 2, "no change, no bell");

  /* Nobody is told about their own save. */
  assert.ok((await setAccess({ userId: boss.id, grants: [{ app: "admin", modules: moduleKeysForApp("admin"), role: "admin" }, crm()] })).ok);
  assert.equal((await bells(boss.id)).length, 0);
});

test("a Hire role that does not fit the level is refused on the server; the matching pair saves", async () => {
  const p = await account("Kiran Recruiter", { employee: "active" });
  const hire = (role: string) => ({ app: "hire" as const, modules: moduleKeysForApp("hire"), role: role as "associate" });
  const wrong = await setAccess({ userId: p.id, grants: [hire("associate")], hireRole: "hr_head" });
  assert.equal(wrong.ok, false);
  assert.match(!wrong.ok ? wrong.error : "", /HR Head is held at manager level in Hire, not associate/);
  assert.equal((await db.select().from(appAccess).where(and(eq(appAccess.userId, p.id), eq(appAccess.app, "hire")))).length, 0, "nothing written");

  const right = await setAccess({ userId: p.id, grants: [hire("manager")], hireRole: "hr_head" });
  assert.ok(right.ok, right.ok ? "" : right.error);

  /* Moving the level away from the role, the role kept, is refused too. */
  const drift = await setAccess({ userId: p.id, grants: [hire("associate")] });
  assert.equal(drift.ok, false);
});

test("taking a factory owner seat audits the person moved off it", async () => {
  const first = await account("Ravi Owner");
  const second = await account("Sunil Owner");
  const factory = { app: "factory" as const, modules: ["factory.app"], role: "associate" as const };
  const place = { depts: ["mixing"] as never, crews: { mixing: "owner" } as never, badge: null, hrConfirmed: true };
  assert.ok((await setAccess({ userId: first.id, grants: [factory as never], factoryPlace: place })).ok);
  const r = await setAccess({ userId: second.id, grants: [factory as never], factoryPlace: place });
  assert.ok(r.ok, r.ok ? "" : r.error);
  const seat = (await db.execute(sql`select user_id as "userId" from factory_team_defaults where proc = 'mixing' and role = 'owner'`)) as unknown as { userId: string }[];
  assert.deepEqual(seat.map((s) => s.userId), [second.id]);
  const trail = await db.select().from(auditLog).where(and(eq(auditLog.entityId, first.id), eq(auditLog.action, "access.factory-seat-displaced")));
  assert.equal(trail.length, 1);
  assert.match(String((trail[0].afterState as { detail?: string }).detail), /given to Sunil Owner/);
});

test("hrms-for-everyone: active linked accounts get HRMS as associate, once, with an audit row each; the rest are counted", async () => {
  const linked = await account("Linked Lata", { employee: "active" });
  const holds = await account("Already Has", { employee: "active" });
  await db.insert(appAccess).values({ id: id("aca"), userId: holds.id, app: "hrms", role: "manager" });
  const unlinked = await account("Unlinked Uma");
  const outsider = await account("Outside Auditor", { notEmployee: true });
  const leaver = await account("Left Already", { employee: "inactive" });
  const off = await account("Deactivated Dev", { employee: "active", active: false });

  const dry = await hrmsForEveryone({ dryRun: true });
  assert.deepEqual(dry.granted.map((g) => g.name), ["Linked Lata"]);
  assert.deepEqual(dry.skipped.unlinked.sort(), ["Boss", "Unlinked Uma"]);
  assert.deepEqual(dry.skipped.notEmployee, ["Outside Auditor"]);
  assert.deepEqual(dry.skipped.inactiveRecord, ["Left Already"]);
  assert.equal((await db.select().from(appAccess).where(eq(appAccess.app, "hrms"))).length, 1, "a dry run writes nothing");

  const run = await hrmsForEveryone();
  assert.deepEqual(run.granted.map((g) => g.id), [linked.id]);
  const [g] = await db.select().from(appAccess).where(and(eq(appAccess.userId, linked.id), eq(appAccess.app, "hrms")));
  assert.equal(g.role, "associate");
  const [kept] = await db.select().from(appAccess).where(and(eq(appAccess.userId, holds.id), eq(appAccess.app, "hrms")));
  assert.equal(kept.role, "manager", "a level somebody already holds is never touched");
  for (const u of [unlinked, outsider, leaver, off]) {
    assert.equal((await db.select().from(appAccess).where(and(eq(appAccess.userId, u.id), eq(appAccess.app, "hrms")))).length, 0, u.name);
  }
  const audits = await db.select().from(auditLog).where(eq(auditLog.action, "access.hrms-for-everyone"));
  assert.deepEqual(audits.map((a) => a.entityId), [linked.id]);

  const again = await hrmsForEveryone();
  assert.equal(again.granted.length, 0, "idempotent");
  assert.equal((await db.select().from(auditLog).where(eq(auditLog.action, "access.hrms-for-everyone"))).length, 1);
});

test("Roles & seats lists who holds each Hire role, factory seat, godown and region — active accounts only", async () => {
  const { seatsOverview } = await import("@/lib/services/access-overview-service");
  const hr = await account("Hema Head");
  const iv = await account("Ivan Interviewer");
  const gone = await account("Gone Godown", { active: false });
  await db.insert(appAccess).values([
    { id: id("aca"), userId: hr.id, app: "hire", role: "manager" },
    { id: id("aca"), userId: iv.id, app: "hire", role: "associate" },
  ]);
  await db.execute(sql`insert into hire_user_roles (user_id, role) values (${hr.id}, 'hr_head')`);
  await db.execute(sql`insert into factory_staff (user_id, area, areas, hr_confirmed) values (${iv.id}, 'mixing', array['mixing'], true)`);
  await db.execute(sql`insert into factory_team_defaults (proc, role, user_id) values ('mixing', 'operator', ${iv.id})`);
  await db.execute(sql`insert into erp_godowns (id, name) values ('gdn_bhw', 'Seat Test Godown') on conflict do nothing`);
  await db.execute(sql`insert into erp_godown_staff (godown_id, user_id) values ('gdn_bhw', ${hr.id}), ('gdn_bhw', ${gone.id})`);
  await db.execute(sql`insert into mbos_user_territories (id, user_id, kind, region) values (${id("ter")}, ${hr.id}, 'region', 'Gujarat')`);

  const s = await seatsOverview();
  const names = (g: { people: { name: string; note?: string }[] } | undefined) => g?.people.map((p) => (p.note ? `${p.name} (${p.note})` : p.name));
  assert.deepEqual(names(s.hire.find((g) => g.key === "hr_head")), ["Hema Head"]);
  assert.deepEqual(names(s.hire.find((g) => g.key === "interviewer")), ["Ivan Interviewer (by level)"]);
  const mixing = s.factory.find((g) => g.key === "mixing");
  assert.deepEqual(names(mixing), ["Ivan Interviewer (Operator)"]);
  assert.equal(mixing?.hint, "No in charge");
  assert.deepEqual(names(s.godowns.find((g) => g.label === "Seat Test Godown")), ["Hema Head"], "a deactivated account is not listed");
  assert.deepEqual(names(s.regions.find((g) => g.label === "Gujarat")), ["Hema Head"]);
});
