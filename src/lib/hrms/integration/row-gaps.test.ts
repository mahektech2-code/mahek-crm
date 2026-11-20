/**
 * What HRMS lists is changed where it is listed, by the person it belongs to:
 * an asset assignment edited (and deleted) by HR, a help request edited by
 * whoever asked, a grievance withdrawn by whoever raised it, a workday claim
 * corrected or withdrawn by the claimant, and a document's title and audience
 * edited by whoever manages documents. Real database, real handlers.
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
import {
  appAccess,
  employees,
  hrmsAssetAssignments,
  hrmsAssetStock,
  hrmsAttendance,
  hrmsGrievances,
  hrmsHelp,
  hrmsOffices,
  hrmsUserPowers,
  hrmsWorkdayClaims,
  mbosDeletions,
  mbosDocuments,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { impactReport } from "@/lib/impact/registry";
import { IMPACT_FIELD } from "@/lib/impact/types";
import { hrmsContext } from "@/lib/hrms/access";
import { hrmsScreenModule } from "@/lib/hrms/screens";
import { today } from "@/lib/hrms/server";
import { HELP } from "@/lib/hrms/values";
import { testPhone } from "@/lib/test-phone";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const mod = (k: string) => {
  const m = hrmsScreenModule(k);
  if (!m) throw new Error(`no module ${k}`);
  return m;
};
const code = (r: { ok: boolean; code?: string }) => (r.ok ? "ok" : r.code);
const field = (r: { ok: boolean; fieldErrors?: { field: string }[] }) => (r.ok ? "ok" : r.fieldErrors?.[0]?.field);

async function person(name: string) {
  const [e] = await db
    .insert(employees)
    .values({
      id: id("emp"),
      rowNumber: 0,
      employeeCode: `G-${Math.floor(Math.random() * 1e6)}`,
      name,
      officeName: "Andheri",
      position: "Telecaller",
      department: "Office",
      status: "active",
      raw: {},
      rowHash: "gaps",
      sheetStatus: "present",
      source: "hrms",
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
      email: `${name.toLowerCase().replace(/\s/g, ".")}.${randomUUID().slice(0, 4)}@gaps.test`,
      phone: testPhone(),
      passwordHash: "x",
      role: level,
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

let asha: typeof employees.$inferSelect;
let ravi: typeof employees.$inferSelect;
let ashaUser: typeof users.$inferSelect;
let raviUser: typeof users.$inferSelect;
let hrUser: typeof users.$inferSelect;

before(async () => {
  await db.execute(sql`truncate users, employees, employee_reporting, hrms_offices, hrms_attendance, hrms_asset_stock, hrms_asset_assignments, hrms_help,
    hrms_grievances, hrms_workday_claims, hrms_user_powers, mbos_deletions, mbos_documents, notifications, sessions, audit_log restart identity cascade`);
  await db.insert(hrmsOffices).values({ id: id("hoff"), name: "Andheri", qrText: "MAHEK-ANDHERI-GAPS" });
  asha = await person("Asha Patil");
  ravi = await person("Ravi Kumar");
  ashaUser = await account("Asha Patil", asha);
  raviUser = await account("Ravi Kumar", ravi);
  const hrEmp = await person("Hema HR");
  hrUser = await account("Hema HR", hrEmp);
  await db.insert(hrmsUserPowers).values({ userId: hrUser.id, power: "hr" });
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("Assets › With people", () => {
  test("HR edits an assignment and deletes one made in error; nobody else does", async () => {
    const stock = id("hast");
    await db.insert(hrmsAssetStock).values({ id: stock, code: "AST-G", purchaseDate: today(), name: "Laptop", category: "Equipment", qty: 5, officeName: "Andheri" });
    const asg = id("hasg");
    await db.insert(hrmsAssetAssignments).values({ id: asg, stockId: stock, employeeId: asha.id, qty: 3, restoredQty: 2, date: today(), status: "Assigned" });

    const hr = await as(hrUser);
    const row = (await mod("assignments").load(hr, { scope: "all" })).rows.find((r) => r.id === asg);
    assert.deepEqual(row?.actions?.filter((a) => a.id === "edit" || a.id === "delete").map((a) => [a.id, a.why ?? ""]), [["edit", ""], ["delete", ""]]);

    assert.equal(code(await mod("assignments").actions!.edit(await as(ashaUser), asg, { qty: "2", date: today() })), "not_permitted");
    assert.equal(field(await mod("assignments").actions!.edit(hr, asg, { qty: "0", date: today() })), "qty");
    const below = await mod("assignments").actions!.edit(hr, asg, { qty: "1", date: today() });
    assert.equal(field(below), "qty", "cannot go below what already came back");
    const saved = await mod("assignments").actions!.edit(hr, asg, { qty: "4", date: today(), resp: "Keep it charged" });
    assert.ok(saved.ok, JSON.stringify(saved));
    const [after] = await db.select().from(hrmsAssetAssignments).where(eq(hrmsAssetAssignments.id, asg));
    assert.deepEqual([after.qty, after.responsibility, after.status], [4, "Keep it charged", "Assigned"]);

    setTestUser(ashaUser);
    assert.equal(code(await impactReport("hrms-asset-assignment", asg)), "not_permitted");
    setTestUser(hrUser);
    const r = await impactReport("hrms-asset-assignment", asg);
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.equal((await mod("assignments").actions!.delete(hr, asg, {})).ok, false, "the bare act is refused");
    assert.equal(code(await mod("assignments").actions!.delete(await as(ashaUser), asg, { [IMPACT_FIELD]: JSON.stringify({ typed: r.data.confirmWord, fingerprint: r.data.fingerprint }) })), "not_permitted");
    const done = await mod("assignments").actions!.delete(await as(hrUser), asg, { [IMPACT_FIELD]: JSON.stringify({ typed: r.data.confirmWord, fingerprint: r.data.fingerprint }) });
    assert.ok(done.ok, JSON.stringify(done));
    assert.equal((await db.select().from(hrmsAssetAssignments).where(eq(hrmsAssetAssignments.id, asg))).length, 0);
  });
});

describe("Help requests", () => {
  test("whoever asked edits the time and the words while it is pending", async () => {
    const hid = id("hhlp");
    await db.insert(hrmsHelp).values({ id: hid, date: today(), employeeId: asha.id, type: HELP.forgotCheckIn, inTime: "09:30", outTime: "18:30", text: "Phone died", status: "Pending" });
    const mine = (await mod("help").load(await as(ashaUser), { scope: "mine" })).rows.find((r) => r.id === hid);
    const act = mine?.actions?.find((a) => a.id === "edit");
    assert.deepEqual(act?.prompt?.fields.map((f) => f.k), ["inTime", "outTime", "text"]);

    assert.equal(code(await mod("help").actions!.edit(await as(raviUser), hid, { inTime: "09:00", text: "x" })), "not_permitted");
    assert.equal(field(await mod("help").actions!.edit(await as(ashaUser), hid, { inTime: "09:10", outTime: "18:30", text: "" })), "text");
    const ok = await mod("help").actions!.edit(await as(ashaUser), hid, { inTime: "09:10", outTime: "18:45", text: "Phone died at the gate" });
    assert.ok(ok.ok, JSON.stringify(ok));
    const [h] = await db.select().from(hrmsHelp).where(eq(hrmsHelp.id, hid));
    assert.deepEqual([h.inTime, h.outTime, h.text], ["09:10", "18:45", "Phone died at the gate"]);

    await db.update(hrmsHelp).set({ status: "Approved" }).where(eq(hrmsHelp.id, hid));
    assert.equal((await mod("help").actions!.edit(await as(ashaUser), hid, { inTime: "09:00", text: "late edit" })).ok, false, "a decided request stays");
  });
});

describe("Grievances", () => {
  test("whoever raised it withdraws it while it is pending; it is kept, marked withdrawn", async () => {
    const gid = id("hgrv");
    await db.insert(hrmsGrievances).values({ id: gid, no: 7, date: today(), byEmployeeId: asha.id, toLabel: "HR", issue: "The fan is broken" });
    const row = (await mod("grievances").load(await as(ashaUser), { scope: "mine" })).rows.find((r) => r.id === gid);
    assert.ok(row?.actions?.some((a) => a.id === "withdraw"));
    assert.equal(code(await mod("grievances").actions!.withdraw(await as(hrUser), gid, {})), "not_found", "somebody it is not theirs to read");
    const done = await mod("grievances").actions!.withdraw(await as(ashaUser), gid, { reason: "Fixed by the office" });
    assert.ok(done.ok, JSON.stringify(done));
    const [g] = await db.select().from(hrmsGrievances).where(eq(hrmsGrievances.id, gid));
    assert.equal(g.status, "Withdrawn");
    assert.match(g.solution ?? "", /Fixed by the office/);
    assert.equal((await mod("grievances").actions!.withdraw(await as(ashaUser), gid, {})).ok, false, "only once");
    assert.equal((await mod("grievances").actions!.solve(await as(ashaUser), gid, { solution: "x" })).ok, false, "nothing to solve now");
  });
});

describe("Attendance › Corrections", () => {
  test("the claimant corrects or withdraws a pending claim; nobody else does", async () => {
    const aid = id("hatt");
    await db.insert(hrmsAttendance).values({ id: aid, employeeId: asha.id, date: today(), officeName: "Andheri", method: "geo", checkIn: "09:30" });
    const cid = id("hwdc");
    const from = new Date(Date.now() - 3600_000);
    await db.insert(hrmsWorkdayClaims).values({ id: cid, attendanceId: aid, employeeId: asha.id, date: today(), fromAt: from, toAt: new Date(), kind: "auto_break", category: "On a call", note: "With a dealer" });

    const mine = (await mod("workdayClaims").load(await as(ashaUser), { scope: "mine" })).rows.find((r) => r.id === cid);
    assert.deepEqual(mine?.actions?.map((a) => a.id), ["editClaim", "withdraw"], "the claimant edits or withdraws; never decides");

    assert.equal(code(await mod("workdayClaims").actions!.editClaim(await as(raviUser), cid, { category: "Other", note: "x" })), "not_permitted");
    const fixed = await mod("workdayClaims").actions!.editClaim(await as(ashaUser), cid, { category: "In a meeting", note: "Supplier meeting" });
    assert.ok(fixed.ok, JSON.stringify(fixed));
    const [c1] = await db.select().from(hrmsWorkdayClaims).where(eq(hrmsWorkdayClaims.id, cid));
    assert.deepEqual([c1.category, c1.note], ["In a meeting", "Supplier meeting"]);

    assert.equal(code(await mod("workdayClaims").actions!.withdraw(await as(hrUser), cid, {})), "not_permitted");
    assert.ok((await mod("workdayClaims").actions!.withdraw(await as(ashaUser), cid, {})).ok);
    const [c2] = await db.select().from(hrmsWorkdayClaims).where(eq(hrmsWorkdayClaims.id, cid));
    assert.equal(c2.status, "withdrawn");
    assert.equal((await mod("workdayClaims").actions!.approve(await as(hrUser), cid, {})).ok, false, "a withdrawn claim is not decided");
    const shown = (await mod("workdayClaims").load(await as(ashaUser), { scope: "mine" })).rows.find((r) => r.id === cid);
    assert.equal(shown?.v.status, "Withdrawn");
  });
});

describe("Documents", () => {
  test("whoever manages documents edits the title and who it is for; leaving the field app tombstones it", async () => {
    const did = id("hdoc");
    await db.insert(mbosDocuments).values({ id: did, title: "Safety policy", category: "policy", audience: "Field staff", media: "PDF & audio", attachmentId: null, visibleToRoles: [], active: true });
    const row = (await mod("documents").load(await as(hrUser), {})).rows.find((r) => r.id === did);
    assert.ok(row?.actions?.some((a) => a.id === "edit"));
    assert.ok(!(await mod("documents").load(await as(ashaUser), {})).rows.find((r) => r.id === did)?.actions?.some((a) => a.id === "edit"));

    assert.equal(code(await mod("documents").actions!.edit(await as(ashaUser), did, { title: "Mine", tagged: "Andheri" })), "not_permitted");
    assert.equal(field(await mod("documents").actions!.edit(await as(hrUser), did, { title: "", tagged: "Andheri" })), "title");
    assert.equal(field(await mod("documents").actions!.edit(await as(hrUser), did, { title: "Safety", tagged: "Nowhere" })), "tagged");
    const ok = await mod("documents").actions!.edit(await as(hrUser), did, { title: "Safety policy 2026", desc: "Updated", tagged: "Andheri" });
    assert.ok(ok.ok, JSON.stringify(ok));
    const [d] = await db.select().from(mbosDocuments).where(eq(mbosDocuments.id, did));
    assert.deepEqual([d.title, d.audience, d.description, d.visibleToRoles], ["Safety policy 2026", "Andheri", "Updated", ["hrms"]]);
    assert.equal((await db.select().from(mbosDeletions).where(eq(mbosDeletions.entityId, did))).length, 1, "the handsets that pulled it drop it");
  });
});
