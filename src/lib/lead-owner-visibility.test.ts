/**
 * A LEAD'S OWNER IS RESPECTED FOR VISIBILITY.
 *
 * A Sales Manager raises a lead and it must not turn up in a Telecaller's list,
 * counts or search just because it exists. The leak was `seatVisible`'s "nobody
 * owns it" arm, written for managers (who assign unowned leads) and applied to
 * every associate too: a lead raised by a Sales Manager carries no owner by
 * default, so every Telecaller saw it on `/crm/leads`.
 *
 *   A  a Sales Manager's lead, owned by them or unowned with their seat, is not
 *      in a Telecaller's list, search, tile counts, desk or record;
 *   B  it stays visible to the Sales Manager, in their workspace;
 *   C  a lead assigned to a Telecaller is visible to them, everywhere;
 *   D  a manager still sees the unowned leads they exist to assign;
 *   E  reading changes no lead.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, appModuleAccess, customers, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { assertCustomerInScope } from "@/lib/access-control";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { captureLead } from "@/lib/actions/lead-intake";
import { assignDeskLead } from "@/lib/actions/lead-desk-assignment";
import { CRM_SALES_MANAGER_WORKSPACE } from "@/proxy";
import { setTestWorkspace } from "@/lib/services/crm-sales-manager-scope";
import { callingDesk } from "@/lib/services/lead-calling-desk-service";
import { leadTileCounts } from "@/lib/services/lead-views-service";
import { leadsPage } from "@/lib/services/sales-service";
import { pipelineList } from "@/lib/sales-lead-pipeline/sales-manager-pipeline-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const DAY = "2026-10-05";
const NAME = "J P paints and hardware stores";
type Level = "associate" | "manager";

async function makeUser(name: string, level: Level, modules: string[] = []) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 4)}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role: level,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "crm", role: level });
  for (const key of modules) {
    await db.insert(appModuleAccess).values({ id: id("ama"), userId: row.id, app: "crm", module: key });
  }
  return row;
}

let seema: typeof users.$inferSelect; // a Sales Manager (CRM associate hat + the module)
let tele: typeof users.$inferSelect; // a Telecaller on the Calling desk
let otherTele: typeof users.$inferSelect;
let boss: typeof users.$inferSelect; // a CRM manager

const raise = (over: Record<string, unknown> = {}) =>
  captureLead({
    salesType: "direct",
    name: NAME,
    phone: String(9800000000 + Math.floor(Math.random() * 99999999)),
    city: "Nashik",
    source: "telecalling",
    ...over,
  } as never);

const row = async (leadId: string) => (await db.select().from(customers).where(eq(customers.id, leadId)))[0];

/** Every read a user has, narrowed to the one lead. */
async function seenBy(user: typeof users.$inferSelect, leadId: string) {
  setTestUser(user);
  const list = (await leadsPage(DAY, { filters: { search: "J P paints" }, perPage: 50 })).rows.map((r) => r.id);
  const desk = (await callingDesk(DAY, "all" as never)).rows.map((r) => r.id);
  const tiles = await leadTileCounts(DAY, {} as never);
  let record = true;
  try {
    await assertCustomerInScope(await row(leadId));
  } catch {
    record = false;
  }
  return {
    list: list.includes(leadId),
    desk: desk.includes(leadId),
    tiles: JSON.stringify(tiles),
    record,
  };
}

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run `npm run test:db` first.");
});
after(async () => {
  setTestUser(null);
  setTestWorkspace(null);
  await db.$client.end();
});
beforeEach(async () => {
  await db.execute(sql`
    truncate table lead_stage_transitions, notifications, timeline_events, audit_log,
      app_module_access, app_access, customers, users, app_settings restart identity cascade`);
  invalidateConfig();
  await seedConfig();
  setTestWorkspace(null);
  seema = await makeUser("Seema Roy", "associate", ["crm.sales-manager", "crm.leads"]);
  tele = await makeUser("Tele Caller", "associate");
  otherTele = await makeUser("Other Caller", "associate");
  boss = await makeUser("Big Manager", "manager");
  /* No request names an app in a test, so a manager is read at the level they hold on the Sales Dashboard. */
  await db.insert(appAccess).values({ id: id("aca"), userId: boss.id, app: "sales", role: "manager" });
});

describe("A: a Sales Manager's lead is not a Telecaller's", () => {
  test("owned by the Sales Manager", async () => {
    setTestUser(seema);
    const r = await raise({ ownerId: seema.id });
    assert.ok(r.ok);
    const leadId = r.data.customerId;
    assert.equal((await row(leadId)).ownerId, seema.id);

    const t = await seenBy(tele, leadId);
    assert.equal(t.list, false);
    assert.equal(t.desk, false);
    assert.equal(t.record, false);
  });

  test("unowned, with the Sales Manager's seat: the case that leaked", async () => {
    setTestUser(seema);
    const r = await raise();
    assert.ok(r.ok);
    const leadId = r.data.customerId;
    const c = await row(leadId);
    assert.equal(c.ownerId, null);
    assert.equal(c.salesManagerId, seema.id);

    const t = await seenBy(tele, leadId);
    assert.equal(t.list, false);
    assert.equal(t.desk, false);
    assert.equal(t.record, false);
  });

  test("the tile counts agree with the list", async () => {
    setTestUser(seema);
    const r = await raise();
    assert.ok(r.ok);
    const withLead = (await seenBy(tele, r.data.customerId)).tiles;
    await db.delete(customers).where(eq(customers.id, r.data.customerId));
    const without = (await seenBy(tele, r.data.customerId)).tiles;
    assert.equal(withLead, without, "removing the lead moves no Telecaller count");
  });
});

describe("B: the Sales Manager still sees it", () => {
  test("in the Sales Manager workspace, owned or not", async () => {
    setTestUser(seema);
    const owned = await raise({ ownerId: seema.id });
    const unowned = await raise({ phone: "9811111111" });
    assert.ok(owned.ok && unowned.ok);
    setTestWorkspace(CRM_SALES_MANAGER_WORKSPACE);
    const ids = (await pipelineList(DAY, { q: "", stage: "", view: "", page: 1 })).rows.map((r) => r.id);
    assert.ok(ids.includes(owned.data.customerId));
    assert.ok(ids.includes(unowned.data.customerId));
  });

  test("outside the workspace, the one they own", async () => {
    setTestUser(seema);
    const r = await raise({ ownerId: seema.id });
    assert.ok(r.ok);
    assert.equal((await seenBy(seema, r.data.customerId)).list, true);
  });
});

describe("C: an intentional hand-off still reaches the Telecaller", () => {
  test("assigned through the desk", async () => {
    setTestUser(seema);
    const r = await raise();
    assert.ok(r.ok);
    const leadId = r.data.customerId;

    setTestUser(boss);
    const given = await assignDeskLead({ customerId: leadId, ownerId: tele.id } as never);
    assert.ok(given.ok, JSON.stringify(given));

    const mine = await seenBy(tele, leadId);
    assert.equal(mine.list, true);
    assert.equal(mine.desk, true);
    assert.equal(mine.record, true);
    const theirs = await seenBy(otherTele, leadId);
    assert.equal(theirs.list, false);
    assert.equal(theirs.desk, false);
    assert.equal(theirs.record, false);
  });

  test("a Telecaller's own capture is theirs", async () => {
    setTestUser(tele);
    const r = await raise();
    assert.ok(r.ok);
    const t = await seenBy(tele, r.data.customerId);
    assert.equal(t.list, true);
    assert.equal(t.desk, true);
  });
});

describe("D: a manager still sees the unowned leads they assign", () => {
  test("an unowned lead is in a manager's list", async () => {
    setTestUser(seema);
    const r = await raise();
    assert.ok(r.ok);
    assert.equal((await seenBy(boss, r.data.customerId)).list, true);
  });
});

describe("E: reading changes nothing", () => {
  test("the lead row is identical after every read", async () => {
    setTestUser(seema);
    const r = await raise();
    assert.ok(r.ok);
    const before = await row(r.data.customerId);
    await seenBy(tele, r.data.customerId);
    await seenBy(boss, r.data.customerId);
    assert.deepEqual(await row(r.data.customerId), before);
  });
});
