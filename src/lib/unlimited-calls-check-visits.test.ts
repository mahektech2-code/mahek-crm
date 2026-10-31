/**
 * UNLIMITED QUALIFICATION CALLS, and CHECK VISITS for the people salesmen
 * report to. Real services against a scratch `mahekone_test*` database.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, appModuleAccess, calls, customers, employeeReporting, employees, mbosVisits, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { captureLead } from "@/lib/actions/lead-intake";
import { logQualificationCall as realLog, requestProspect } from "@/lib/actions/lead-calling-desk";
import { checkVisitsAction } from "@/lib/actions/check-visits";
import { canCheckVisits, reportingSalesmen } from "@/lib/services/visit-oversight-service";
import { canLogQualificationCall } from "@/lib/services/lead-reach-service";
import { DESK_MODULE } from "@/lib/services/lead-desk-assignment-service";
import { afterCall, nextCallNumber, phaseOf } from "@/lib/engines/lead-calling-desk";
import { testPhone } from "@/lib/test-phone";

/* Every call carries a remark; the tests that are not about that use this. */
const logQualificationCall = (i: Parameters<typeof realLog>[0]) => realLog({ notes: "Spoke to the contact.", ...i });

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

async function makeUser(name: string, role: "associate" | "manager" | "admin", app: "crm" | "field", modules: string[] = []) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 4)}@test.local`,
      phone: testPhone(),
      passwordHash: "x",
      role,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app, role });
  for (const m of modules) await db.insert(appModuleAccess).values({ id: id("mod"), userId: row.id, app, module: m });
  return row;
}

let tele: typeof users.$inferSelect;
let head: typeof users.$inferSelect; // a CRM manager: salesmen report to them
let chartBoss: typeof users.$inferSelect; // a CRM user the Org Chart (not reports_to_id) puts over a salesman
let stranger: typeof users.$inferSelect; // a CRM manager nobody reports to
let sA: typeof users.$inferSelect; // reports to head (reports_to_id)
let sB: typeof users.$inferSelect; // reports to chartBoss (Org Chart only)
let sC: typeof users.$inferSelect; // reports to nobody
let admin: typeof users.$inferSelect;
let leadId: string;

async function visit(salesmanId: string, customerId: string, notes: string) {
  await db.insert(mbosVisits).values({
    id: id("vis"),
    customerId,
    salesmanId,
    outcome: "visited",
    notes,
    checkInAt: new Date(),
    checkInLat: 21.1458,
    checkInLng: 79.0882,
  });
}

before(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Integration tests must run against a mahekone_test* database.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table
      mbos_visits, reminders, lead_stage_transitions, mbos_tasks, calls, notifications,
      timeline_events, audit_log, orders, employee_reporting, employees, app_secrets,
      app_module_access, app_access, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  tele = await makeUser("Telecaller T", "associate", "crm", ["crm.dashboard", "crm.leads", DESK_MODULE]);
  head = await makeUser("Head H", "manager", "crm", ["crm.dashboard", "crm.leads"]);
  chartBoss = await makeUser("Chart Boss", "manager", "crm", ["crm.dashboard", "crm.leads"]);
  stranger = await makeUser("Stranger M", "manager", "crm", ["crm.dashboard", "crm.leads"]);
  admin = await makeUser("Office Admin", "admin", "crm");
  sA = await makeUser("Salesman A", "associate", "field");
  sB = await makeUser("Salesman B", "associate", "field");
  sC = await makeUser("Salesman C", "associate", "field");
  await db.update(users).set({ reportsToId: head.id }).where(eq(users.id, sA.id));
  /* The Org Chart: employees are matched to accounts by name. */
  const [eB, eBoss] = await Promise.all(
    [sB.name, chartBoss.name].map(async (name, i) =>
      (
        await db
          .insert(employees)
          .values({ id: id("emp"), employeeCode: `V-${i}`, name, status: "active", rowNumber: 700 + i, raw: {}, rowHash: `v-${i}-${randomUUID()}` })
          .returning()
      )[0],
    ),
  );
  await db.insert(employeeReporting).values({ id: id("er"), employeeId: eB.id, managerId: eBoss.id });

  setTestUser(tele);
  const r = await captureLead({
    salesType: "direct",
    name: "Some Lead",
    phone: testPhone(),
    city: "Nashik",
    source: "telecalling",
  });
  assert.ok(r.ok, r.ok ? "" : r.error);
  leadId = r.data.customerId;
  await visit(sA.id, leadId, "A saw the owner");
  await visit(sB.id, leadId, "B left a sample");
  await visit(sC.id, leadId, "C passed by");
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("calls have no ceiling", () => {
  test("engine: Call 4 and 5 are owed; three misses never close a lead; an explicit no still does", () => {
    const values = {};
    assert.equal(phaseOf("new", values, 3), "call3");
    assert.equal(nextCallNumber("call3", 3), 4);
    assert.equal(nextCallNumber("call3", 6), 7);
    assert.equal(nextCallNumber("call1", 0), 1);
    const miss = afterCall({ callNumber: 3, outcome: "no_answer", merged: values, priorOutcomes: ["no_answer", "no_answer"] });
    assert.deepEqual(miss, { kind: "next", callNumber: 4 });
    assert.equal(afterCall({ callNumber: 9, outcome: "not_interested", merged: values, priorOutcomes: [] }).kind, "lost");
  });

  test("server: calls 4, 5 and 6 are saved with the old ones untouched; the lead is not closed", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await logQualificationCall({ customerId: leadId, outcome: "no_answer", noAnswerReason: "no_response", answers: {} });
      assert.ok(r.ok, r.ok ? "" : r.error);
    }
    const marked = sql`${calls.customerId} = ${leadId} and ${calls.outcomeDetail}->>'qualCall' is not null`;
    const first3 = await db.select({ id: calls.id }).from(calls).where(marked);
    assert.equal(first3.length, 3);
    for (const n of [4, 5, 6]) {
      const r = await logQualificationCall({ customerId: leadId, outcome: "no_answer", noAnswerReason: "no_response", answers: {} });
      assert.ok(r.ok, r.ok ? "" : r.error);
      assert.equal(r.data.callNumber, n);
      assert.equal(r.data.result, "next");
    }
    const all = await db.select({ id: calls.id }).from(calls).where(marked);
    assert.equal(all.length, 6);
    for (const old of first3) assert.ok(all.some((a) => a.id === old.id), "an earlier call survived");
    const [l] = await db.select().from(customers).where(eq(customers.id, leadId));
    assert.notEqual(l.leadStage, "lost");
  });

  test("every call needs an outcome", async () => {
    const none = await logQualificationCall({ customerId: leadId, outcome: "", answers: {} });
    assert.equal(none.ok, false);
    const junk = await logQualificationCall({ customerId: leadId, outcome: "whatever", answers: {} });
    assert.equal(junk.ok, false);
    assert.equal((await db.select().from(calls).where(sql`${calls.outcomeDetail}->>'qualCall' is not null`)).length, 0);
  });
});

describe("every call needs a remark", () => {
  test("no remark, a blank one and a one-letter one are refused — a no answer included — and nothing is written", async () => {
    for (const notes of [undefined, "", "   ", "a"]) {
      for (const outcome of ["no_answer", "spoke_callback"] as const) {
        const r = await realLog({ customerId: leadId, outcome, noAnswerReason: "no_response", answers: {}, notes });
        assert.equal(r.ok, false, `${outcome} with remark ${JSON.stringify(notes)} must be refused`);
      }
    }
    assert.equal((await db.select().from(calls).where(sql`${calls.outcomeDetail}->>'qualCall' is not null`)).length, 0);
  });

  test("a short meaningful remark is accepted on a no answer, and is stored on the call", async () => {
    const r = await realLog({ customerId: leadId, outcome: "no_answer", noAnswerReason: "no_response", answers: {}, notes: "Phone off" });
    assert.ok(r.ok, r.ok ? "" : r.error);
    const [c] = await db.select().from(calls).where(sql`${calls.outcomeDetail}->>'qualCall' = '1'`);
    assert.equal(c.notes, "Phone off");
  });
});

describe("the Call button is for whoever may call THIS lead", () => {
  let plain: typeof users.$inferSelect; // a Telecaller without the Calling desk
  let outsider: typeof users.$inferSelect;

  beforeEach(async () => {
    plain = await makeUser("Plain Telecaller", "associate", "crm", ["crm.dashboard", "crm.leads"]);
    outsider = await makeUser("Outsider", "associate", "crm", ["crm.dashboard", "crm.leads"]);
    await db.update(customers).set({ ownerId: plain.id }).where(eq(customers.id, leadId));
  });

  test("the owner without the Calling desk can log a call on her own lead — remark still required", async () => {
    setTestUser(plain);
    const noRemark = await realLog({ customerId: leadId, outcome: "no_answer", noAnswerReason: "no_response", answers: {} });
    assert.equal(noRemark.ok, false);
    const r = await realLog({ customerId: leadId, outcome: "no_answer", noAnswerReason: "no_response", answers: {}, notes: "Phone switched off" });
    assert.ok(r.ok, r.ok ? "" : r.error);
  });

  test("a Sales Manager whose SEAT it is can call and convert a lead nobody owns", async () => {
    await db.update(customers).set({ ownerId: null, salesManagerId: plain.id }).where(eq(customers.id, leadId));
    setTestUser(plain);
    const r = await realLog({ customerId: leadId, outcome: "no_answer", noAnswerReason: "no_response", answers: {}, notes: "Phone off" });
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.equal(await canLogQualificationCall(leadId, plain.id), true, "the page draws the Call and Convert controls for her");
  });

  test("somebody the lead is not in the scope of is refused, desk or no desk", async () => {
    setTestUser(outsider);
    const r = await realLog({ customerId: leadId, outcome: "spoke_callback", answers: {}, notes: "Hello" });
    assert.equal(r.ok, false, "a lead outside the person's scope cannot be called");
    assert.equal((await db.select().from(calls).where(sql`${calls.outcomeDetail}->>'qualCall' is not null`)).length, 0);
  });

  test("requesting a Prospect no longer needs the Calling desk — and a stranger to the lead is still refused", async () => {
    setTestUser(plain);
    const r = await requestProspect({ customerId: leadId });
    assert.doesNotMatch(!r.ok ? r.error : "", /Calling desk/, "not refused for want of the grant");
    setTestUser(outsider);
    assert.equal((await requestProspect({ customerId: leadId })).ok, false, "outside the lead's scope");
  });
});

describe("Check Visits", () => {
  test("a date range reaches older visits, bounded and paged", async () => {
    const old = new Date(Date.now() - 100 * 86_400_000);
    await db.insert(mbosVisits).values({ id: id("vis"), customerId: leadId, salesmanId: sA.id, outcome: "visited", notes: "Old visit", checkInAt: old });
    for (let i = 0; i < 30; i++) {
      await db.insert(mbosVisits).values({ id: id("vis"), customerId: leadId, salesmanId: sA.id, outcome: "visited", notes: `Recent ${i}`, checkInAt: new Date(Date.now() - i * 3_600_000) });
    }
    setTestUser(head);
    const def = await checkVisitsAction({});
    assert.ok(def.ok);
    assert.equal(def.data.visits.length, 25, "a page is 25");
    assert.equal(def.data.more, true);
    assert.ok(!def.data.visits.some((v) => v.notes === "Old visit"), "the default is the last 30 days");
    const p2 = await checkVisitsAction({ page: 1 });
    assert.ok(p2.ok);
    assert.equal(p2.data.visits.length, 6, "30 + the one from the seed, less the first 25");
    assert.equal(p2.data.more, false);
    const iso = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
    const wide = await checkVisitsAction({ from: iso(new Date(old.getTime() - 86_400_000)), to: iso(new Date(old.getTime() + 86_400_000)) });
    assert.ok(wide.ok);
    assert.deepEqual(wide.data.visits.map((v) => v.notes), ["Old visit"], "an older range finds the older visit");
  });

  test("a bad or oversized range is refused; a salesman still cannot use it", async () => {
    setTestUser(head);
    assert.equal((await checkVisitsAction({ from: "2020-01-01", to: "2026-01-01" })).ok, false, "wider than a year");
    assert.equal((await checkVisitsAction({ from: "2026-02-01", to: "2026-01-01" })).ok, false, "end before start");
    assert.equal((await checkVisitsAction({ from: "yesterday" })).ok, false, "not a date");
    setTestUser(sA);
    const mine = await checkVisitsAction({ from: "2020-01-01", to: "2030-01-01" });
    assert.equal(mine.ok, false, "the range limit applies to everybody");
    const salesman = await checkVisitsAction({ from: "2026-01-01", to: "2026-12-31" });
    assert.ok(salesman.ok && salesman.data.visits.length === 0, "a salesman still sees no visits, not even his own");
  });

  test("a superior by reports_to_id sees exactly their own salesman's visits", async () => {
    assert.equal(await canCheckVisits(head), true);
    setTestUser(head);
    const r = await checkVisitsAction({});
    assert.ok(r.ok);
    assert.deepEqual(r.data.visits.map((v) => v.salesmanName), ["Salesman A"]);
    assert.equal(r.data.visits[0].customerName, "Some Lead");
    assert.equal(Math.round(r.data.visits[0].location?.lat ?? 0), 21);
  });

  test("a superior by the Org Chart sees theirs — matched by the chart, not by a name in code", async () => {
    setTestUser(chartBoss);
    const r = await checkVisitsAction({});
    assert.ok(r.ok);
    assert.deepEqual(r.data.visits.map((v) => v.salesmanName), ["Salesman B"]);
  });

  test("a salesman, an unrelated manager and a CRM user with nobody under them get an EMPTY answer — never anybody's visits", async () => {
    for (const who of [sA, sC, stranger, tele]) {
      setTestUser(who);
      const r = await checkVisitsAction({});
      assert.ok(r.ok, `${who.name} gets the empty state, not an error`);
      assert.equal(r.data.visits.length, 0, `${who.name} sees no visits`);
      assert.equal(r.data.team.length, 0, `${who.name} has nobody reporting`);
      assert.equal(await canCheckVisits(who), false);
    }
  });

  test("naming somebody else's salesman returns nothing, not their visits", async () => {
    setTestUser(head);
    const r = await checkVisitsAction({ salesmanId: sB.id });
    assert.ok(r.ok);
    assert.equal(r.data.visits.length, 0);
  });

  test("a salesman who has reports of their own still has no door (not in the CRM)", async () => {
    await db.update(users).set({ reportsToId: sA.id }).where(eq(users.id, sC.id));
    setTestUser(sA);
    assert.equal((await reportingSalesmen(sA)).length, 0);
    const r = await checkVisitsAction({});
    assert.ok(r.ok && r.data.visits.length === 0 && r.data.team.length === 0);
  });

  test("direct reports only: a head of the head sees nobody through them", async () => {
    await db.update(users).set({ reportsToId: stranger.id }).where(eq(users.id, head.id));
    assert.equal((await reportingSalesmen(stranger)).length, 0);
  });

  test("an administrator reads every salesman's; can filter to this lead only", async () => {
    setTestUser(admin);
    const r = await checkVisitsAction({ customerId: leadId });
    assert.ok(r.ok);
    assert.equal(r.data.visits.length, 3);
  });
});
