/**
 * Every HRMS delete says what it takes with it before it happens, against a
 * real database through the real handlers: the report names what moves in
 * every app, the bare act is refused, and the act confirmed with the report's
 * fingerprint does what the report said.
 *
 *   npm run test:integration
 *
 * Needs `mahekone_test` (npm run test:db). It truncates what it touches.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  attachments,
  customers,
  employeeReporting,
  employees,
  hrmsActivities,
  hrmsAdvances,
  hrmsAssetAssignments,
  hrmsAssetStock,
  hrmsAttendance,
  hrmsBuddyTasks,
  hrmsCalling,
  hrmsChecklist,
  hrmsExpenses,
  hrmsGrievances,
  hrmsHelp,
  hrmsJourneys,
  hrmsKpi,
  hrmsLeaveCredits,
  hrmsLeaveRequests,
  hrmsMonthlyRemarks,
  hrmsOffices,
  hrmsOvertime,
  hrmsSalaries,
  hrmsStaffTimings,
  hrmsTaskTemplates,
  hrmsTodos,
  mbosAttendanceDays,
  mbosDocuments,
  sessions,
  timelineEvents,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig } from "@/lib/config/store";
import { impactReport } from "@/lib/impact/registry";
import { IMPACT_FIELD, type ImpactReport } from "@/lib/impact/types";
import { impactBatchKey } from "@/lib/impact/batch-key";
import { hrmsContext } from "@/lib/hrms/access";
import { hrmsScreenModule } from "@/lib/hrms/screens";
import { today } from "@/lib/hrms/server";
import { addDaysISO, monthOf, weekdayOf } from "@/lib/hrms/time";
import { HELP } from "@/lib/hrms/values";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const mod = (k: string) => {
  const m = hrmsScreenModule(k);
  if (!m) throw new Error(`no module ${k}`);
  return m;
};

async function person(name: string, x: { office?: string; status?: "active" | "inactive"; monthlyPaidLeave?: number } = {}) {
  const [e] = await db
    .insert(employees)
    .values({
      id: id("emp"),
      rowNumber: 0,
      employeeCode: `E-${Math.floor(Math.random() * 1e6)}`,
      name,
      officeName: x.office ?? "Andheri",
      position: "Salesman",
      department: "Sales",
      status: x.status ?? "active",
      raw: {},
      rowHash: "hrms",
      sheetStatus: "present",
      source: "hrms",
      monthlyPaidLeave: x.monthlyPaidLeave ?? null,
    })
    .returning();
  return e;
}

async function account(name: string, emp: { id: string } | null, level: "associate" | "manager" | "admin" = "associate") {
  const [u] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\s/g, ".")}.${randomUUID().slice(0, 4)}@impact.test`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role: level,
      initials: name.slice(0, 2).toUpperCase(),
      employeeId: emp?.id ?? null,
    })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app: "hrms", role: level });
  return u;
}

async function file(parentType: string, parentId: string | null) {
  const fid = id("att");
  await db.insert(attachments).values({
    id: fid,
    parentType: parentType as never,
    parentId,
    filename: "x.jpg",
    storedRef: `ref/${randomUUID()}`,
    contentType: "image/jpeg",
    sizeBytes: 22,
    status: "available",
    uploadedById: admin.id,
  } as never);
  return fid;
}

/** The report the modal would show, refused loudly if it cannot be read. */
async function report(kind: string, recordId: string): Promise<ImpactReport> {
  const r = await impactReport(kind, recordId);
  assert.ok(r.ok, r.ok ? "" : `${kind}: ${r.error}`);
  return r.data;
}
/** What the modal hands back once the name is typed. */
const yes = (r: ImpactReport) => ({ [IMPACT_FIELD]: JSON.stringify({ typed: r.confirmWord, fingerprint: r.fingerprint }) });
const item = (r: ImpactReport, app: string, effect: string) => r.items.find((i) => i.app === app && i.effect === effect);
const items = (r: ImpactReport) => r.items.map((i) => `${i.app}:${i.effect}:${i.count}:${i.label}`).join(" | ");

let admin: typeof users.$inferSelect;
let asha: typeof employees.$inferSelect;
let ravi: typeof employees.$inferSelect;
let ashaUser: typeof users.$inferSelect;
let customerId: string;

async function asAdmin() {
  setTestUser(admin);
  return hrmsContext();
}

before(async () => {
  await db.execute(sql`truncate users, employees, employee_reporting, hrms_offices, hrms_staff_timings, hrms_attendance, hrms_leave_requests,
    hrms_leave_credits, hrms_overtime, hrms_monthly_remarks, hrms_salaries, hrms_advances, hrms_expenses, hrms_task_templates, hrms_checklist,
    hrms_todos, hrms_buddy_tasks, hrms_kpi, hrms_calling, hrms_activities, hrms_journeys, hrms_asset_stock, hrms_asset_assignments, hrms_help,
    hrms_grievances, hrms_notifications, hrms_user_powers, mbos_attendance_days, mbos_deletions, mbos_documents, notifications, sessions,
    attachments, timeline_events, customers, audit_log restart identity cascade`);
  await db.insert(hrmsOffices).values({ id: id("hoff"), name: "Andheri", qrText: "MAHEK-ANDHERI" });
  asha = await person("Asha Patil", { monthlyPaidLeave: 1.5 });
  ravi = await person("Ravi Kumar");
  ashaUser = await account("Asha Patil", asha);
  await db.insert(appAccess).values({ id: id("aca"), userId: ashaUser.id, app: "field", role: "associate" });
  admin = await account("Anil Admin", null, "admin");
  customerId = id("cus");
  await db.insert(customers).values({ id: customerId, name: "Sai Paint Depot", phone: "9822200011", city: "Pune", kind: "customer" });
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("time records", () => {
  test("approved leave says payroll, the field verdict and a salary already made, and goes only when confirmed", async () => {
    const ctx = await asAdmin();
    const d1 = addDaysISO(today(), -10);
    const lid = id("hlr");
    await db.insert(hrmsLeaveRequests).values({ id: lid, reqNo: "LR-T1", employeeId: asha.id, appliedOn: d1, type: "Casual", startDate: d1, endDate: addDaysISO(d1, 1), days: 2, status: "Approved", paid: 2, unpaid: 0 });
    await db.insert(mbosAttendanceDays).values({ id: id("mad"), userId: ashaUser.id, day: d1, status: "on_leave" });
    await db.insert(hrmsSalaries).values({ id: id("hsal"), salaryNo: "SAL-L1", employeeId: asha.id, month: monthOf(d1), salaryDate: d1, daysInMonth: 30, figures: {}, inHandPaise: 0 });

    const r = await report("hrms-leave-request", lid);
    assert.equal(item(r, "HRMS", "changed")?.count, 2, items(r));
    assert.equal(item(r, "Sales Dashboard", "changed")?.count, 1, items(r));
    assert.equal(item(r, "HRMS", "kept")?.count, 1, items(r));
    assert.equal(r.confirmWord, "DELETE");

    const bare = await mod("leave").actions!.delete(ctx, lid, {});
    assert.equal(bare.ok, false, "no confirmation, no delete");
    const stale = await mod("leave").actions!.delete(ctx, lid, { [IMPACT_FIELD]: JSON.stringify({ typed: "DELETE", fingerprint: "1:stale" }) });
    assert.equal(stale.ok ? "ok" : stale.code, "conflict");
    const done = await mod("leave").actions!.delete(ctx, lid, yes(r));
    assert.ok(done.ok, JSON.stringify(done));
    assert.equal((await db.select().from(hrmsLeaveRequests).where(eq(hrmsLeaveRequests.id, lid))).length, 0);
  });

  test("a job credit deleted in its own month says the monthly job puts it back", async () => {
    const ctx = await asAdmin();
    const cid = id("hlc");
    await db.insert(hrmsLeaveCredits).values({ id: cid, employeeId: asha.id, month: monthOf(today()), days: 1.5, source: "job" });
    const r = await report("hrms-leave-credit", cid);
    assert.ok(r.items.some((i) => /tonight’s monthly job/.test(i.label)), items(r));
    assert.equal((await mod("leaveSetup").actions!.deleteCredit(ctx, cid, {})).ok, false);
    assert.ok((await mod("leaveSetup").actions!.deleteCredit(ctx, cid, yes(r))).ok);
  });

  test("overtime and a report remark touch nothing else, and still ask", async () => {
    await db.execute(sql`insert into app_settings (key, value, value_type, category, label) values ('hrms.ot.enabled', 'true'::jsonb, 'boolean', 'hrms', 'Overtime') on conflict (key) do update set value = 'true'::jsonb`);
    invalidateConfig();
    try {
      const ctx = await asAdmin();
      const oid = id("hot");
      await db.insert(hrmsOvertime).values({ id: oid, employeeId: asha.id, date: addDaysISO(today(), -20), slot: "After Duty", startTime: "18:30", endTime: "20:00", minutes: 90 });
      const r = await report("hrms-overtime", oid);
      assert.deepEqual(r.items, []);
      assert.equal((await mod("overtime").actions!.delete(ctx, oid, {})).ok, false);
      assert.ok((await mod("overtime").actions!.delete(ctx, oid, yes(r))).ok);
    } finally {
      await db.execute(sql`delete from app_settings where key = 'hrms.ot.enabled'`);
      invalidateConfig();
    }
    const ctx = await asAdmin();
    const month = monthOf(today());
    await db.insert(hrmsMonthlyRemarks).values({ employeeId: asha.id, month, remark: "Late three times" });
    const key = `${asha.id}|${month}`;
    const r = await report("hrms-monthly-remark", key);
    assert.equal((await mod("monthly").actions!.deleteRemark(ctx, key, {})).ok, false);
    assert.ok((await mod("monthly").actions!.deleteRemark(ctx, key, yes(r))).ok);
  });

  test("an attendance day takes its photographs off with it, and says what it leaves", async () => {
    const ctx = await asAdmin();
    const date = addDaysISO(today(), -3);
    const aid = id("hatt");
    await db.insert(hrmsAttendance).values({ id: aid, employeeId: asha.id, date, officeName: "Andheri", method: "geo", checkIn: "09:30", checkOut: "20:30" });
    const photo = await file("hrms_attendance", aid);
    await db.insert(hrmsOvertime).values({ id: id("hot"), employeeId: asha.id, date, slot: "After Duty", startTime: "18:30", endTime: "20:30", minutes: 120 });

    const r = await report("hrms-attendance-day", aid);
    assert.equal(item(r, "HRMS", "deleted")?.count, 1, items(r));
    assert.ok(r.items.some((i) => i.effect === "kept" && /overtime/.test(i.label)), items(r));
    assert.equal((await mod("attendance").actions!.delete(ctx, aid, {})).ok, false);
    assert.ok((await mod("attendance").actions!.delete(ctx, aid, yes(r))).ok);
    /* The photograph is not left bound to a day nobody can find any more. */
    const [f] = await db.select().from(attachments).where(eq(attachments.id, photo));
    assert.equal(f.status, "removed");
    assert.equal(f.parentId, null);
  });
});

describe("conversations and the library", () => {
  test("an approved help request says the day it corrected stays", async () => {
    const ctx = await asAdmin();
    const date = addDaysISO(today(), -5);
    await db.insert(hrmsAttendance).values({ id: id("hatt"), employeeId: asha.id, date, method: "geo", checkIn: "09:40", remark: `From help request: ${HELP.forgotCheckIn}` });
    const hid = id("hhlp");
    await db.insert(hrmsHelp).values({ id: hid, date, employeeId: asha.id, type: HELP.forgotCheckIn, status: "Approved" });
    const r = await report("hrms-help", hid);
    assert.equal(item(r, "HRMS", "kept")?.count, 1, items(r));
    assert.equal((await mod("help").actions!.delete(ctx, hid, {})).ok, false);
    assert.ok((await mod("help").actions!.delete(ctx, hid, yes(r))).ok);

    const gid = id("hgrv");
    await db.insert(hrmsGrievances).values({ id: gid, no: 1, date, byEmployeeId: asha.id, toLabel: "HR", issue: "The fan is broken" });
    const g = await report("hrms-grievance", gid);
    assert.equal((await mod("grievances").actions!.delete(ctx, gid, {})).ok, false);
    assert.ok((await mod("grievances").actions!.delete(ctx, gid, yes(g))).ok);
  });

  test("a document on the field app names the phones it comes off", async () => {
    const ctx = await asAdmin();
    const did = id("hdoc");
    await db.insert(mbosDocuments).values({ id: did, title: "Safety policy", category: "policy", audience: "Field staff", visibleToRoles: [], active: true } as never);
    const r = await report("hrms-document", did);
    assert.equal(item(r, "MBOS handsets", "phones")?.count, 1, items(r));
    assert.equal(r.confirmWord, "Safety policy");
    assert.ok((await mod("documents").actions!.delete(ctx, did, yes(r))).ok);
    const again = await report("hrms-document", did);
    assert.deepEqual(again.blockers, ["Safety policy is already withdrawn."]);
  });
});

describe("the sales desk", () => {
  test("withdrawing a deactivation request says it leaves the managers' list", async () => {
    const ctx = await asAdmin();
    await db.update(customers).set({ deactivationRequested: true, deactivationReason: "Shop closed", deactivationRequestedById: admin.id, deactivationRequestedAt: new Date() }).where(eq(customers.id, customerId));
    const r = await report("hrms-deactivation-request", customerId);
    assert.equal(item(r, "CRM", "deleted")?.count, 1, items(r));
    assert.equal((await mod("customers").actions!.withdrawRequest(ctx, customerId, {})).ok, false);
    assert.ok((await mod("customers").actions!.withdrawRequest(ctx, customerId, yes(r))).ok);
    const [c] = await db.select().from(customers).where(eq(customers.id, customerId));
    assert.equal(c.deactivationRequested, false);
    assert.equal((await report("hrms-deactivation-request", customerId)).blockers.length, 1);
  });

  test("a calling row and an activity leave the customer's history standing, and say so", async () => {
    const ctx = await asAdmin();
    const callId = id("hcal");
    await db.insert(hrmsCalling).values({ id: callId, customerId, employeeId: asha.id, date: today(), followUp: addDaysISO(today(), 5) });
    await db.insert(timelineEvents).values({ id: id("tle"), customerId, eventType: "hrms_call", sourceApp: "hrms", sourceRecordId: `${callId}:${today()}:picked`, occurredAt: new Date(), summary: "Back office call" });
    const r = await report("hrms-calling-row", callId);
    assert.equal(item(r, "HRMS", "deleted")?.count, 1, items(r));
    assert.equal(item(r, "CRM", "kept")?.count, 1, items(r));
    assert.equal((await mod("calling").actions!.delete(ctx, callId, {})).ok, false);
    assert.ok((await mod("calling").actions!.delete(ctx, callId, yes(r))).ok);
    assert.equal((await db.select().from(timelineEvents).where(eq(timelineEvents.customerId, customerId))).length, 1, "the call happened");

    const day = addDaysISO(today(), -1);
    const actId = id("hact");
    await db.insert(hrmsActivities).values({ id: actId, date: day, employeeId: asha.id, customerId, customerName: "Sai Paint Depot", minutes: 30, note: "Talked about the new thinner" });
    await db.insert(hrmsKpi).values({ id: id("hkpi"), date: day, employeeId: asha.id });
    await db.insert(timelineEvents).values({ id: id("tle"), customerId, eventType: "hrms_activity", sourceApp: "hrms", sourceRecordId: actId, occurredAt: new Date(), summary: "Meeting" });
    const a = await report("hrms-activity", actId);
    assert.equal(item(a, "HRMS", "changed")?.count, 1, items(a));
    assert.equal(item(a, "CRM", "kept")?.count, 1, items(a));
    assert.ok((await mod("activity").actions!.delete(ctx, actId, yes(a))).ok);
  });

  test("a journey plan and a sales entry ask before they go", async () => {
    const ctx = await asAdmin();
    const jid = id("hjr");
    await db.insert(hrmsJourneys).values({ id: jid, employeeId: asha.id, startDate: today(), endDate: today(), location: "Nashik" });
    const j = await report("hrms-journey", jid);
    assert.deepEqual(j.items, []);
    assert.equal((await mod("journey").actions!.delete(ctx, jid, {})).ok, false);
    assert.ok((await mod("journey").actions!.delete(ctx, jid, yes(j))).ok);

    const kid = id("hkpi");
    await db.insert(hrmsKpi).values({ id: kid, date: addDaysISO(today(), -2), employeeId: asha.id });
    const k = await report("hrms-sales-entry", kid);
    assert.equal(item(k, "HRMS", "deleted")?.count, 1, items(k));
    assert.equal((await mod("kpi").actions!.delete(ctx, kid, {})).ok, false);
    assert.ok((await mod("kpi").actions!.delete(ctx, kid, yes(k))).ok);
  });
});

describe("money", () => {
  test("a paid salary names its payment record and the advance it gives back, and is typed by its number", async () => {
    const ctx = await asAdmin();
    const sid = id("hsal");
    await db.insert(hrmsSalaries).values({ id: sid, salaryNo: "SAL-T9", employeeId: asha.id, month: "2026-01", salaryDate: "2026-01-31", daysInMonth: 31, figures: {}, inHandPaise: 0, status: "Paid", utr: "UTR123", paidOn: "2026-02-01", advanceDeductionPaise: 50000 });
    const r = await report("hrms-salary", sid);
    assert.equal(item(r, "HRMS", "deleted")?.count, 1, items(r));
    assert.equal(item(r, "HRMS", "changed")?.count, 1, items(r));
    assert.equal(r.confirmWord, "SAL-T9");
    assert.equal((await mod("payroll").actions!.delete(ctx, sid, {})).ok, false);
    assert.ok((await mod("payroll").actions!.delete(ctx, sid, yes(r))).ok);
  });

  test("an advance salary has begun recovering is refused in the modal, with the act's own words", async () => {
    const ctx = await asAdmin();
    const older = id("hadv");
    const newer = id("hadv");
    await db.insert(hrmsAdvances).values([
      { id: older, employeeId: ravi.id, date: "2026-01-05", amountPaise: 100000 },
      { id: newer, employeeId: ravi.id, date: "2026-02-05", amountPaise: 50000 },
    ]);
    await db.insert(hrmsSalaries).values({ id: id("hsal"), salaryNo: "SAL-R1", employeeId: ravi.id, month: "2026-02", salaryDate: "2026-02-28", daysInMonth: 28, figures: {}, inHandPaise: 0, advanceDeductionPaise: 60000 });
    const blocked = await report("hrms-advance", older);
    assert.match(blocked.blockers[0] ?? "", /already been recovered/);
    const fine = await report("hrms-advance", newer);
    assert.deepEqual(fine.blockers, []);
    assert.equal(item(fine, "HRMS", "changed")?.count, 1, items(fine));
    assert.equal((await mod("advances").actions!.delete(ctx, newer, {})).ok, false);
    assert.ok((await mod("advances").actions!.delete(ctx, newer, yes(fine))).ok);
    assert.equal((await mod("advances").actions!.delete(ctx, older, { [IMPACT_FIELD]: JSON.stringify({ typed: "DELETE", fingerprint: blocked.fingerprint }) })).ok, false);

    const xid = id("hexp");
    await db.insert(hrmsExpenses).values({ id: xid, serial: "EXP-T1", employeeId: asha.id, date: today(), payType: "Claim", claimPaise: 120000, verify: "Verified" });
    const x = await report("hrms-expense", xid);
    assert.equal(item(x, "HRMS", "changed")?.count, 1, items(x));
    assert.equal(x.confirmWord, "EXP-T1");
    assert.ok((await mod("expenses").actions!.delete(ctx, xid, yes(x))).ok);
  });
});

describe("people", () => {
  test("deleting somebody with no history names their timings, templates, credits, org chart and account", async () => {
    const ctx = await asAdmin();
    const neel = await person("Neel New");
    const mira = await person("Mira Report");
    const neelUser = await account("Neel New", neel);
    await db.insert(hrmsStaffTimings).values({ id: id("htm"), employeeId: neel.id, weekday: "Monday", inTime: "09:30", outTime: "18:30" });
    await db.insert(hrmsTaskTemplates).values({ id: id("htt"), serial: 1, employeeId: neel.id, task: "Open the shutter", frequency: "Daily", weekdays: ["Monday"] });
    await db.insert(hrmsLeaveCredits).values({ id: id("hlc"), employeeId: neel.id, month: monthOf(today()), days: 1, source: "hand" });
    await db.insert(employeeReporting).values([
      { id: id("rep"), employeeId: neel.id, managerId: asha.id },
      { id: id("rep"), employeeId: mira.id, managerId: neel.id },
    ]);
    const r = await report("hrms-employee", neel.id);
    assert.deepEqual(r.blockers, []);
    assert.equal(r.confirmWord, "Neel New");
    const deleted = r.items.filter((i) => i.app === "HRMS" && i.effect === "deleted").reduce((n, i) => n + i.count, 0);
    assert.equal(deleted, 4, items(r));
    assert.equal(item(r, "HRMS", "unlinked")?.count, 1, items(r));
    assert.equal(item(r, "Admin Console", "unlinked")?.count, 1, items(r));
    assert.equal((await mod("employees").actions!.delete(ctx, neel.id, {})).ok, false);
    assert.ok((await mod("employees").actions!.delete(ctx, neel.id, yes(r))).ok);
    const [u] = await db.select().from(users).where(eq(users.id, neelUser.id));
    assert.equal(u.employeeId, null, "the account stays, unlinked");
    assert.equal((await db.select().from(employeeReporting).where(eq(employeeReporting.employeeId, mira.id))).length, 0);
  });

  test("deactivating a selection names the sign-ins and sessions it ends, and is one confirmation for the batch", async () => {
    const ctx = await asAdmin();
    const one = await person("Dev One");
    const two = await person("Dev Two");
    const u = await account("Dev One", one);
    const later = new Date(Date.now() + 86_400_000);
    await db.insert(sessions).values([
      { id: id("ses"), userId: u.id, expiresAt: later },
      { id: id("ses"), userId: u.id, expiresAt: later },
    ] as never);
    const key = impactBatchKey([two.id, one.id]);
    const r = await report("hrms-employee-deactivate", key);
    assert.equal(item(r, "HRMS", "changed")?.count, 2, items(r));
    assert.equal(item(r, "Admin Console", "changed")?.count, 1, items(r));
    assert.equal(item(r, "Admin Console", "deleted")?.count, 2, items(r));
    assert.equal(r.confirmWord, "DEACTIVATE");
    assert.equal((await report("hrms-employee-deactivate", one.id)).confirmWord, "Dev One");

    assert.equal((await mod("employees").bulk!.empDeactivate(ctx, [one.id, two.id], {})).ok, false);
    const done = await mod("employees").bulk!.empDeactivate(ctx, [one.id, two.id], yes(r));
    assert.ok(done.ok, JSON.stringify(done));
    const [after] = await db.select().from(users).where(eq(users.id, u.id));
    assert.equal(after.active, false);
    assert.equal((await db.select().from(sessions).where(eq(sessions.userId, u.id))).length, 0);
  });

  test("an ID card, an office, a timing, a lot and an assignment each ask, and say what is in the way", async () => {
    const ctx = await asAdmin();
    const card = await file("hrms_employee", asha.id);
    await db.update(employees).set({ idCardAttachmentId: card }).where(eq(employees.id, asha.id));
    const c = await report("hrms-id-card", asha.id);
    assert.equal(c.confirmWord, "REMOVE");
    assert.equal((await mod("idCards").actions!.remove(ctx, asha.id, {})).ok, false);
    assert.ok((await mod("idCards").actions!.remove(ctx, asha.id, yes(c))).ok);

    /* Andheri still has staff: refused in the modal, in the act's own words. */
    const [andheri] = await db.select().from(hrmsOffices).where(eq(hrmsOffices.name, "Andheri"));
    assert.match((await report("hrms-office", andheri.id)).blockers[0] ?? "", /Move them to another office first/);
    const pune = id("hoff");
    await db.insert(hrmsOffices).values({ id: pune, name: "Pune", qrText: "MAHEK-PUNE" });
    await person("Old Timer", { office: "Pune", status: "inactive" });
    const o = await report("hrms-office", pune);
    assert.equal(item(o, "HRMS", "deleted")?.count, 1, items(o));
    assert.equal(item(o, "HRMS", "kept")?.count, 1, items(o));
    assert.equal(o.confirmWord, "Pune");
    assert.ok((await mod("offices").actions!.delete(ctx, pune, yes(o))).ok);

    let monday = addDaysISO(today(), -7);
    while (weekdayOf(monday) !== "Monday") monday = addDaysISO(monday, -1);
    const tid = id("htm");
    await db.insert(hrmsStaffTimings).values({ id: tid, employeeId: asha.id, weekday: "Monday", inTime: "09:30", outTime: "18:30" });
    await db.insert(hrmsAttendance).values({ id: id("hatt"), employeeId: asha.id, date: monday, method: "geo", checkIn: "09:31", officialIn: "09:30" });
    const t = await report("hrms-timing", tid);
    assert.equal(item(t, "HRMS", "changed")?.count, 1, items(t));
    assert.equal(item(t, "HRMS", "kept")?.count, 1, items(t));
    assert.ok((await mod("timings").actions!.delete(ctx, tid, yes(t))).ok);

    const used = id("hast");
    const free = id("hast");
    await db.insert(hrmsAssetStock).values([
      { id: used, code: "AST-U", purchaseDate: today(), name: "Laptop", category: "Equipment", qty: 3, officeName: "Andheri" },
      { id: free, code: "AST-F", purchaseDate: today(), name: "Chair", category: "Furniture", qty: 2, officeName: "Andheri" },
    ]);
    const asg = id("hasg");
    await db.insert(hrmsAssetAssignments).values({ id: asg, stockId: used, employeeId: asha.id, qty: 3, restoredQty: 1, date: today(), status: "Assigned" });
    assert.match((await report("hrms-asset-lot", used)).blockers[0] ?? "", /has assignments/);
    const f = await report("hrms-asset-lot", free);
    assert.equal(f.confirmWord, "AST-F");
    assert.ok((await mod("assetStock").actions!.delete(ctx, free, yes(f))).ok);
    const a = await report("hrms-asset-assignment", asg);
    assert.equal(item(a, "HRMS", "changed")?.count, 2, items(a));
    assert.equal((await mod("assignments").actions!.delete(ctx, asg, {})).ok, false);
    assert.ok((await mod("assignments").actions!.delete(ctx, asg, yes(a))).ok);
  });
});

describe("tasks", () => {
  test("a template stops the rows coming and keeps the ones written; the rows move the month's score", async () => {
    const ctx = await asAdmin();
    const tpl = id("htt");
    await db.insert(hrmsTaskTemplates).values({ id: tpl, serial: 1, employeeId: asha.id, task: "Count the stock", frequency: "Daily", weekdays: ["Monday"] });
    const cl = id("hcl");
    await db.insert(hrmsChecklist).values({ id: cl, date: today(), employeeId: asha.id, templateId: tpl, task: "Count the stock" });
    await db.insert(hrmsTodos).values({ id: id("htd"), forDate: today(), fromLabel: "Monthly", toEmployeeId: asha.id, task: "Count the stock", templateId: tpl });
    const t = await report("hrms-task-template", tpl);
    assert.equal(item(t, "HRMS", "changed")?.count, 1, items(t));
    assert.equal(t.items.filter((i) => i.effect === "kept").length, 2, items(t));
    assert.equal(t.confirmWord, "Count the stock");
    assert.equal((await mod("templates").actions!.delete(ctx, tpl, {})).ok, false);
    assert.ok((await mod("templates").actions!.delete(ctx, tpl, yes(t))).ok);

    const c = await report("hrms-checklist-item", cl);
    assert.equal(item(c, "HRMS", "changed")?.count, 1, items(c));
    assert.ok((await mod("checklist").actions!.delete(ctx, cl, yes(c))).ok);

    const todo = id("htd");
    await db.insert(hrmsTodos).values({ id: todo, forDate: today(), fromEmployeeId: ravi.id, fromLabel: "Ravi Kumar", toEmployeeId: asha.id, task: "Send the quote" });
    const d = await report("hrms-todo", todo);
    assert.equal((await mod("todos").actions!.delete(ctx, todo, {})).ok, false);
    assert.ok((await mod("todos").actions!.delete(ctx, todo, yes(d))).ok);

    const bt = id("hbt");
    await db.insert(hrmsBuddyTasks).values({ id: bt, date: today(), fromEmployeeId: asha.id, toEmployeeId: ravi.id, task: "Cover the counter" });
    const b = await report("hrms-shared-task", bt);
    assert.equal(b.confirmWord, "Cover the counter");
    assert.ok((await mod("buddy").actions!.delete(ctx, bt, yes(b))).ok);
    assert.equal((await db.select().from(hrmsBuddyTasks).where(and(eq(hrmsBuddyTasks.id, bt)))).length, 0);
  });
});
