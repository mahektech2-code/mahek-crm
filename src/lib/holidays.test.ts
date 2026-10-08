/**
 * WHO A HOLIDAY REACHES, end to end.
 *
 *   npm run test:integration
 *
 * Saved through the real `saveHoliday` and `setHolidayPerson`, resolved by the
 * real rebuild, and read back through the handset's real bootstrap and delta —
 * because the promise this feature makes is that a holiday set at the office
 * is on the right phones at the next sync with no app update, and only the
 * whole chain shows that.
 *
 * Needs mahekone_test; `npm run test:db` creates it.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, mbosDevices, mbosUserTerritories, places, users } from "@/db/schema";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { setTestUser } from "@/lib/auth";
import { removeHoliday, saveHoliday, setHolidayPerson } from "@/lib/actions/sales";
import { buildBootstrap, buildPull, type MbosPrincipal } from "@/lib/services/mbos-service";
import { holidayCalendar } from "@/lib/services/holiday-service";
import { setWorkingTerritories } from "@/lib/services/territory-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const YEAR = new Date().getFullYear() + 1;
const DAY = `${YEAR}-06-15`;

let ravi: typeof users.$inferSelect;
let mahesh: typeof users.$inferSelect;
let manager: typeof users.$inferSelect;

async function makeUser(name: string, role: "associate" | "admin", app: "field" | "sales") {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase()}-${randomUUID().slice(0, 4)}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  await db.insert(appAccess).values({ id: id("acc"), userId: row.id, app, role });
  return row;
}

function principalFor(u: typeof users.$inferSelect): MbosPrincipal {
  return { user: u, deviceId: `dev-${u.id}`, role: "associate", scope: { kind: "own", userIds: [u.id] } } as MbosPrincipal;
}

type WireHoliday = { id: string; onDate: string; name: string; scope: string | null; universal: boolean };
const wire = (rows: unknown[]) => rows as WireHoliday[];

async function holidayOnPhone(u: typeof users.$inferSelect, holidayId: string): Promise<WireHoliday | undefined> {
  const boot = await buildBootstrap(principalFor(u));
  return wire(boot.holidays).find((h) => h.id === holidayId);
}

before(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Integration tests must run against mahekone_test.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table
      mbos_holiday_members, mbos_holiday_assignments, mbos_holidays, hrms_holidays, mbos_deletions,
      mbos_devices, mbos_user_territories, places,
      notifications, audit_log, app_access, sessions, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  await db.insert(places).values([
    { id: "od", kind: "state", name: "Odisha", key: "odisha", parentId: null },
    { id: "d-ctc", kind: "district", name: "Cuttack", key: "cuttack", parentId: "od" },
    { id: "c-ctc", kind: "city", name: "Cuttack", key: "cuttack", parentId: "d-ctc" },
    { id: "mh", kind: "state", name: "Maharashtra", key: "maharashtra", parentId: null },
    { id: "d-ngp", kind: "district", name: "Nagpur", key: "nagpur", parentId: "mh" },
    { id: "c-ngp", kind: "city", name: "Nagpur", key: "nagpur", parentId: "d-ngp" },
  ]);

  ravi = await makeUser("Ravi", "associate", "field");
  mahesh = await makeUser("Mahesh", "associate", "field");
  manager = await makeUser("Vikram", "admin", "sales");
  await db.insert(mbosUserTerritories).values([
    { id: id("ut"), userId: ravi.id, kind: "state", region: "Odisha", parent: "" },
    { id: id("ut"), userId: mahesh.id, kind: "city", region: "Nagpur", parent: "Maharashtra" },
  ]);
  for (const u of [ravi, mahesh]) await db.insert(mbosDevices).values({ id: id("dev"), userId: u.id, deviceId: `dev-${u.id}`, active: true });
  setTestUser(manager);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

const base = { category: "Festival", placeIds: [] as string[], include: [] as string[], exclude: [] as string[] };

test("a company-wide holiday is every salesman's day off, on his phone", async () => {
  const r = await saveHoliday({ ...base, onDate: DAY, name: "Founders' Day", level: "company" });
  assert.ok(r.ok, r.ok ? "" : r.error);
  const holidayId = r.ok ? r.data.id : "";
  assert.equal(r.ok && r.data.reaches, 2);
  assert.equal((await holidayOnPhone(ravi, holidayId))?.universal, true);
  assert.equal((await holidayOnPhone(mahesh, holidayId))?.scope, null);
  /* HRMS's copy, for payroll. */
  const [hr] = await db.execute<{ tagged: string }>(sql`select tagged from hrms_holidays where id = ${holidayId}`);
  assert.equal(hr?.tagged, "All employees");
});

test("a state holiday reaches only the people working in that state", async () => {
  const r = await saveHoliday({ ...base, onDate: DAY, name: "Raja Parba", level: "state", placeIds: ["od"] });
  assert.ok(r.ok, r.ok ? "" : r.error);
  const holidayId = r.ok ? r.data.id : "";
  const onRavi = await holidayOnPhone(ravi, holidayId);
  const onMahesh = await holidayOnPhone(mahesh, holidayId);
  assert.equal(onRavi?.universal, true);
  assert.equal(onRavi?.scope, "Odisha");
  /* Still sent, so his phone can list it — but not his day off. */
  assert.equal(onMahesh?.universal, false);

  const cal = await holidayCalendar(YEAR, null);
  const entry = cal.holidays.find((h) => h.id === holidayId);
  assert.deepEqual(entry?.members.map((m) => m.userId), [ravi.id]);
});

test("allocating and deallocating one person reaches his phone on the next delta", async () => {
  const r = await saveHoliday({ ...base, onDate: DAY, name: "Raja Parba", level: "state", placeIds: ["od"] });
  const holidayId = r.ok ? r.data.id : "";
  const boot = await buildBootstrap(principalFor(mahesh));
  await new Promise((res) => setTimeout(res, 20));

  const given = await setHolidayPerson({ holidayId, userId: mahesh.id, mode: "include", reason: "Family in Cuttack" });
  assert.ok(given.ok, given.ok ? "" : given.error);
  const delta = await buildPull(principalFor(mahesh), boot.cursor);
  assert.equal(wire(delta.holidays).find((h) => h.id === holidayId)?.universal, true);

  /* Taking it away needs a reason, and wins over the place. */
  const refused = await setHolidayPerson({ holidayId, userId: ravi.id, mode: "exclude" });
  assert.equal(refused.ok, false);
  const taken = await setHolidayPerson({ holidayId, userId: ravi.id, mode: "exclude", reason: "Covering the market" });
  assert.ok(taken.ok);
  assert.equal((await holidayOnPhone(ravi, holidayId))?.universal, false);

  const back = await setHolidayPerson({ holidayId, userId: ravi.id, mode: "clear" });
  assert.ok(back.ok);
  assert.equal((await holidayOnPhone(ravi, holidayId))?.universal, true);
});

test("an exclusion from a company-wide holiday is honoured", async () => {
  const r = await saveHoliday({ ...base, onDate: DAY, name: "Founders' Day", level: "company", exclude: [mahesh.id] });
  const holidayId = r.ok ? r.data.id : "";
  assert.equal((await holidayOnPhone(mahesh, holidayId))?.universal, false);
  assert.equal((await holidayOnPhone(ravi, holidayId))?.universal, true);
});

test("moving a salesman's area moves which holidays are his", async () => {
  const r = await saveHoliday({ ...base, onDate: DAY, name: "Raja Parba", level: "city", placeIds: ["c-ctc"] });
  const holidayId = r.ok ? r.data.id : "";
  assert.equal((await holidayOnPhone(mahesh, holidayId))?.universal, false);
  await setWorkingTerritories(mahesh.id, [{ kind: "city", value: "Cuttack", parent: "Odisha" }], manager.id);
  assert.equal((await holidayOnPhone(mahesh, holidayId))?.universal, true);
});

test("a holiday for named people needs somebody named, and reaches only them", async () => {
  const empty = await saveHoliday({ ...base, onDate: DAY, name: "Village fair", level: "people" });
  assert.equal(empty.ok, false);
  const r = await saveHoliday({ ...base, onDate: DAY, name: "Village fair", level: "people", include: [mahesh.id] });
  const holidayId = r.ok ? r.data.id : "";
  assert.equal((await holidayOnPhone(mahesh, holidayId))?.universal, true);
  assert.equal((await holidayOnPhone(ravi, holidayId))?.universal, false);
});

test("editing keeps one row, and removing tombstones the phones", async () => {
  const r = await saveHoliday({ ...base, onDate: DAY, name: "Raja Parba", level: "state", placeIds: ["od"] });
  const holidayId = r.ok ? r.data.id : "";
  const edited = await saveHoliday({ ...base, id: holidayId, onDate: DAY, name: "Raja Parba", level: "company" });
  assert.ok(edited.ok, edited.ok ? "" : edited.error);
  assert.equal((await holidayOnPhone(mahesh, holidayId))?.universal, true);
  const dup = await saveHoliday({ ...base, onDate: DAY, name: "raja parba", level: "company" });
  assert.equal(dup.ok, false);

  const gone = await removeHoliday(holidayId);
  assert.ok(gone.ok);
  const [tomb] = await db.execute<{ n: number }>(sql`select count(*)::int as n from mbos_deletions where entity = 'holidays' and entity_id = ${holidayId}`);
  assert.equal(tomb?.n, 1);
});
