/**
 * The HRMS restructure, against a real database through the real handlers:
 * tabs open with their screen, a department head reaches their team and
 * office and nobody else's, and the fixes the audit asked for hold.
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
import { appAccess, appModuleAccess, employeeReporting, employees, hrmsAssetAssignments, hrmsAssetStock, hrmsAttendance, hrmsHelp, hrmsLeaveRequests, hrmsNotifications, hrmsUserPowers, mbosDeletions, mbosDocuments, notifications, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { hrmsContext, requireHrmsWrite, HrmsNotPermitted } from "@/lib/hrms/access";
import { hrmsScreenModule } from "@/lib/hrms/screens";
import { hrmsSearch } from "@/lib/actions/hrms-screens";
import { setManager } from "@/lib/actions/org";
import { LEAVE_WAITING, HELP } from "@/lib/hrms/values";
import { today } from "@/lib/hrms/server";
import { addDaysISO } from "@/lib/hrms/time";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const mod = (k: string) => {
  const m = hrmsScreenModule(k);
  if (!m) throw new Error(`no module ${k}`);
  return m;
};

async function person(name: string, x: { office: string; position: string; type: string; reportsTo?: string; source?: string }) {
  const [e] = await db
    .insert(employees)
    .values({
      id: id("emp"),
      rowNumber: 0,
      employeeCode: `E-${Math.floor(Math.random() * 1e6)}`,
      name,
      officeName: x.office,
      position: x.position,
      department: x.type,
      reportsTo: x.reportsTo ?? null,
      status: "active",
      raw: {},
      rowHash: "hrms",
      sheetStatus: "present",
      source: x.source ?? "hrms",
      netSalaryPaise: 2000000,
      gender: "Male",
    })
    .returning();
  return e;
}

async function account(name: string, emp: { id: string } | null, level: "associate" | "manager" | "admin" = "associate", platform = false) {
  const [u] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\s/g, ".")}@hrms.test`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role: platform ? "admin" : level,
      initials: name.slice(0, 2).toUpperCase(),
      employeeId: emp?.id ?? null,
    })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app: "hrms", role: level });
  return u;
}

async function as(u: typeof users.$inferSelect) {
  setTestUser(u);
  return hrmsContext();
}

const day = (employeeId: string, date: string, out: string | null = "18:30") =>
  db.insert(hrmsAttendance).values({ id: id("hatt"), employeeId, date, officeName: "Andheri", method: "geo", checkIn: "09:30", checkOut: out });

let head: typeof users.$inferSelect;
let headEmp: typeof employees.$inferSelect;
let teamEmp: typeof employees.$inferSelect;
let officeEmp: typeof employees.$inferSelect;
let strangerEmp: typeof employees.$inferSelect;
let staff: typeof users.$inferSelect;
let hr: typeof users.$inferSelect;
let narrowed: typeof users.$inferSelect;

before(async () => {
  await db.execute(sql`truncate users, employees, employee_reporting, hrms_attendance, hrms_help, hrms_leave_requests, hrms_user_powers, hrms_asset_stock, hrms_asset_assignments, hrms_notifications, mbos_documents, mbos_deletions, notifications, audit_log restart identity cascade`);
  headEmp = await person("Ravi Head", { office: "Andheri", position: "Sales Head", type: "Sales" });
  teamEmp = await person("Tara Team", { office: "Pune", position: "Salesman", type: "Sales", reportsTo: "Sales Head" });
  officeEmp = await person("Omkar Office", { office: "Andheri", position: "Field Boy", type: "Field" });
  strangerEmp = await person("Sana Stranger", { office: "Nagpur", position: "Salesman", type: "Sales" });
  head = await account("Ravi Head", headEmp);
  staff = await account("Sana Stranger", strangerEmp);
  hr = await account("Hema HR", null, "associate");
  await db.insert(hrmsUserPowers).values([
    { userId: hr.id, power: "hr" },
    { userId: hr.id, power: "resolve" },
    { userId: hr.id, power: "editAtt" },
  ]);
  narrowed = await account("Nina Narrow", null);
  await db.insert(appModuleAccess).values({ id: id("ama"), userId: narrowed.id, app: "hrms", module: "hrms.leave" });
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("tabs", () => {
  test("holding a screen opens every tab of it, and nothing else", async () => {
    const n = await as(narrowed);
    for (const k of ["leave", "approvals", "leaveCal", "holidays", "leaveSetup", "home"]) assert.ok(n.screens.has(k), k);
    for (const k of ["attendance", "pendingOut", "payroll", "org"]) assert.ok(!n.screens.has(k), k);
    await requireHrmsWrite("approvals");
    await assert.rejects(() => requireHrmsWrite("pendingOut"), HrmsNotPermitted);
  });

  test("overtime is not opened while its setting is off", async () => {
    const h = await as(hr);
    assert.ok(h.screens.has("attendance"));
    assert.ok(!h.screens.has("overtime"));
  });
});

describe("a department head", () => {
  test("holds check-out by position, and it does not widen any list to everybody", async () => {
    const ctx = await as(head);
    assert.ok(ctx.powers.has("checkoutStaff") && ctx.powers.has("markStaff"));
    assert.ok(!ctx.granted.has("checkoutStaff"));
    const t = today();
    await day(strangerEmp.id, t, null);
    await day(teamEmp.id, t, null);
    await day(officeEmp.id, t, null);
    const { rows, spec } = await mod("pendingOut").load(ctx, {});
    const names = new Set(rows.map((r) => r.v.emp));
    assert.ok(names.has("Tara Team") && names.has("Omkar Office"));
    assert.ok(!names.has("Sana Stranger"), "another office's day is not the head's");
    assert.deepEqual(spec.hrms?.scope?.options, ["mine", "team"]);
  });

  test("checks out their team and their office, and is refused anybody else's day", async () => {
    const ctx = await as(head);
    const t = today();
    const [stranger] = await db.select().from(hrmsAttendance).where(and(eq(hrmsAttendance.employeeId, strangerEmp.id), eq(hrmsAttendance.date, t)));
    const [office] = await db.select().from(hrmsAttendance).where(and(eq(hrmsAttendance.employeeId, officeEmp.id), eq(hrmsAttendance.date, t)));
    const refused = await mod("attendance").actions!.officerOut(ctx, stranger.id, { out: "18:30" });
    assert.equal(refused.ok, false);
    const allowed = await mod("attendance").actions!.officerOut(ctx, office.id, { out: "18:30" });
    assert.equal(allowed.ok, true);
  });

  test("sees absentees in their team and office only", async () => {
    const ctx = await as(head);
    const { rows } = await mod("absentees").load(ctx, { date: addDaysISO(today(), -1) });
    const names = new Set(rows.map((r) => r.v.emp));
    assert.ok(!names.has("Sana Stranger"));
    assert.ok(names.has("Tara Team"));
  });
});

describe("search", () => {
  test("an associate finds only themselves among employees", async () => {
    await as(staff);
    const hits = await hrmsSearch("ra");
    const people = hits.filter((h) => h.kind === "Employee").map((h) => h.name);
    assert.deepEqual(people, ["Sana Stranger"]);
  });
});

describe("leave", () => {
  test("a request is stored as Waiting, in today's word", async () => {
    const ctx = await as(staff);
    const start = addDaysISO(today(), 3);
    const r = await mod("leave").forms!.apply(ctx, { type: "Half Day", start, reason: "Doctor" }, []);
    assert.equal(r.ok, true, JSON.stringify(r));
    const [row] = await db.select().from(hrmsLeaveRequests).where(eq(hrmsLeaveRequests.employeeId, strangerEmp.id));
    assert.equal(row.status, LEAVE_WAITING);
  });
});

describe("help requests", () => {
  test("approving “forgot to check in” with times writes the day", async () => {
    const date = addDaysISO(today(), -2);
    const hid = id("hhlp");
    await db.insert(hrmsHelp).values({ id: hid, date, employeeId: officeEmp.id, type: HELP.forgotCheckIn, inTime: "09:40", outTime: "18:10", text: "Phone was dead" });
    const ctx = await as(hr);
    const r = await mod("help").actions!.approve(ctx, hid, { remark: "", apply: "Yes" });
    assert.equal(r.ok, true, JSON.stringify(r));
    const [d] = await db.select().from(hrmsAttendance).where(and(eq(hrmsAttendance.employeeId, officeEmp.id), eq(hrmsAttendance.date, date)));
    assert.equal(d?.checkIn, "09:40");
    assert.equal(d?.checkOut, "18:10");
  });

  test("“I am late today” from the check-in card tells the people who resolve it", async () => {
    await as(staff);
    const { hrmsRaiseLateHelp } = await import("@/lib/actions/hrms-checkin");
    const r = await hrmsRaiseLateHelp("Train was late");
    assert.equal(r.ok, true, JSON.stringify(r));
    const bells = (await db.execute(sql`select user_id from notifications where title like 'Help request from%'`)) as unknown as { user_id: string }[];
    assert.ok(bells.some((b) => b.user_id === hr.id));
  });
});

describe("employees", () => {
  test("a person with any history cannot be deleted — help requests count", async () => {
    const admin = await account("Asha Admin", null, "admin");
    const ctx = await as(admin);
    const r = await mod("employees").actions!.delete(ctx, officeEmp.id, {});
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /help request/);
  });

  test("editing your own details does not take your row from the sheet", async () => {
    const sheetEmp = await person("Sheet Sunil", { office: "Andheri", position: "Clerk", type: "OfficeStaff", source: "sheet" });
    const u = await account("Sheet Sunil", sheetEmp);
    const ctx = await as(u);
    const r = await mod("employees").forms!.editSelf(ctx, { mobile: "9876543210", emergency: "9876500000", address: "Thane" }, [], sheetEmp.id);
    assert.equal(r.ok, true, JSON.stringify(r));
    const [after] = await db.select().from(employees).where(eq(employees.id, sheetEmp.id));
    assert.equal(after.personalMobile, "9876543210");
    assert.equal(after.hrmsDecidedAt, null);
  });
});

describe("assets", () => {
  test("an assignment comes back in parts, and closes when everything is back", async () => {
    const ctx = await as(hr);
    const stockId = id("hast");
    await db.insert(hrmsAssetStock).values({ id: stockId, code: "AST-1", purchaseDate: today(), name: "Laptop", category: "Equipment", costPaise: 0, qty: 3, officeName: "Andheri" });
    const aid = id("hasg");
    await db.insert(hrmsAssetAssignments).values({ id: aid, stockId, employeeId: teamEmp.id, qty: 3, date: today(), status: "Assigned" });
    const r1 = await mod("assignments").actions!.restore(ctx, aid, { date: today(), by: "Hema", qty: "1", remark: "One back", photo: "att_x" });
    assert.equal(r1.ok, true, JSON.stringify(r1));
    let [a] = await db.select().from(hrmsAssetAssignments).where(eq(hrmsAssetAssignments.id, aid));
    assert.equal(a.status, "Assigned");
    assert.equal(a.restoredQty, 1);
    const r2 = await mod("assignments").actions!.restore(ctx, aid, { date: today(), by: "Hema", qty: "2", remark: "Rest back", photo: "att_y" });
    assert.equal(r2.ok, true, JSON.stringify(r2));
    [a] = await db.select().from(hrmsAssetAssignments).where(eq(hrmsAssetAssignments.id, aid));
    assert.equal(a.status, "Restored");
    assert.equal(a.restoredQty, 3);
  });
});

describe("org chart", () => {
  test("holding HRMS is not holding the org chart", async () => {
    setTestUser(narrowed);
    const r = await setManager(teamEmp.id, headEmp.id);
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /Org chart/);
  });
});

describe("my team is the org chart, with the job title as the fallback", () => {
  test("placing somebody on the chart under another manager takes them out of the head's team", async () => {
    const other = await person("Mira Manager", { office: "Pune", position: "Area Manager", type: "Sales" });
    await db.insert(employeeReporting).values({ id: id("rep"), employeeId: teamEmp.id, managerId: other.id });
    await db.insert(employeeReporting).values({ id: id("rep"), employeeId: strangerEmp.id, managerId: headEmp.id });
    const ctx = await as(head);
    assert.ok(!ctx.team.has(teamEmp.id), "the chart says Tara reports to Mira");
    assert.ok(ctx.team.has(strangerEmp.id), "the chart says Sana reports to Ravi");
    await db.delete(employeeReporting);
  });
});

describe("one document library", () => {
  test("HR's document is a row of the company library, and withdrawing it tombstones the handsets", async () => {
    const ctx = await as(hr);
    const r = await mod("documents").forms!.new(ctx, { title: "Leave policy", type: "Link", url: "https://example.com/policy", tagged: "All employees" }, []);
    assert.equal(r.ok, true, JSON.stringify(r));
    const [d] = await db.select().from(mbosDocuments).where(eq(mbosDocuments.title, "Leave policy"));
    assert.equal(d.audience, "All employees");
    assert.deepEqual(d.visibleToRoles, ["hrms"], "a link never reaches a handset");
    const staffView = await mod("documents").load(await as(staff), {});
    assert.ok(staffView.rows.some((x) => x.v.title === "Leave policy"));
    const w = await mod("documents").actions!.delete(await as(hr), d.id, {});
    assert.equal(w.ok, true, JSON.stringify(w));
    const [after] = await db.select().from(mbosDocuments).where(eq(mbosDocuments.id, d.id));
    assert.equal(after.active, false, "withdrawn, not deleted");
    const tomb = await db.select().from(mbosDeletions).where(eq(mbosDeletions.entityId, d.id));
    assert.equal(tomb.length, 1);
  });
});

describe("one announcement sender", () => {
  test("an edit reaches the bell, seen is the bell's read mark, and a delete leaves the bell", async () => {
    const ctx = await as(hr);
    const r = await mod("notifications").forms!.new(ctx, { to: `${strangerEmp.name} · ${strangerEmp.employeeCode}`, text: "Bring your PAN card", landing: "home" }, []);
    assert.equal(r.ok, true, JSON.stringify(r));
    const [n] = await db.select().from(hrmsNotifications);
    assert.equal(n.bellIds.length, 1);
    await mod("notifications").actions!.edit(ctx, n.id, { text: "Bring your PAN card on Monday" });
    const [bell] = await db.select().from(notifications).where(eq(notifications.id, n.bellIds[0]));
    assert.equal(bell.body, "Bring your PAN card on Monday");
    const seen = await mod("notifications").actions!.seen(await as(staff), n.id, {});
    assert.equal(seen.ok, true, JSON.stringify(seen));
    const [read] = await db.select().from(notifications).where(eq(notifications.id, n.bellIds[0]));
    assert.equal(read.read, true);
    await mod("notifications").actions!.delete(await as(hr), n.id, {});
    assert.equal((await db.select().from(notifications).where(eq(notifications.id, n.bellIds[0]))).length, 0);
  });
});
