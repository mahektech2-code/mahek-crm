import "server-only";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { employees, hrmsAssetAssignments, hrmsAssetStock, hrmsOffices, hrmsStaffTimings, sessions, users } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { inr, type ActionSpec, type Contact, type FieldSpec, type FormSpec, type ListRow, type RowField, type ToolSpec } from "@/lib/erp/ui";
import { syncEmployeesAction } from "@/lib/actions/hrms";
import { has, type HrmsContext, type Scope } from "../access";
import {
  err,
  fieldErr,
  hrmsAudit,
  hrmsId,
  inTx,
  int,
  nextSeries,
  num,
  ok,
  okVoid,
  paise,
  refuse,
  rupeesField,
  stampLine,
  text,
  today,
  type HrmsScreenModule,
  type Values,
} from "../server";
import { allPeople, byId, isActive, offices, refList, visibleIds, type Person } from "../services/people";
import { bindHrmsFiles } from "../attachments";
import { fdShort, tmin, WEEKDAYS, workingAge } from "../time";
import { hrmsLink } from "../registry";
import { availability, dutyDuration, officeDuration } from "../calcs/people";
import { personFrom, personOption, scopeFor } from "./attendance";
import { ADMIN } from "@/lib/admin-routes";

/* ---------------------------------------------------------------------------
 * People (spec §4, §5, §15): the employee directory and its sign-up form, ID
 * cards, offices, staff timings, asset stock and asset assignments.
 *
 * The employee table began as a mirror of the HR sheet. Everything written
 * here stamps `hrmsDecidedAt` (or creates a row with `source = 'hrms'`), and
 * the sheet sync keeps its hands off such a row — otherwise the next pull
 * would quietly undo whatever HR just decided.
 * ------------------------------------------------------------------------- */

type Employee = typeof employees.$inferSelect;
type Refusal = ReturnType<typeof fieldErr>;

/* ---------------------------------------------------------------- helpers */

/** A field under one of the design's form sections. */
const sec = (section: string, f: FieldSpec): FieldSpec => ({ ...f, sec: section });

const STATUS_LABEL: Record<string, string> = { active: "Active", inactive: "Inactive", unknown: "Not set" };
const yn = (b: boolean | null | undefined) => (b == null ? "" : b ? "Yes" : "No");
const digits = (v: string | undefined) => String(v ?? "").replace(/\D/g, "");
const spaced = (d: string) => d.replace(/(\d{4})(?=\d)/g, "$1 ");
const masked = (last4: string | null | undefined) => (last4 ? `XXXX XXXX ${last4}` : "");
const mapHref = (q: string) => `https://maps.google.com/?q=${encodeURIComponent(q)}`;
const attHref = (id: string) => `/api/attachments/${id}`;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const withCurrent = (list: string[], v: string | null | undefined) => (v && !list.includes(v) ? [...list, v] : list);

/** Salary, conveyance, other salary and the bank: payroll, HR, admin and the person themself. */
function seesPay(ctx: HrmsContext, e: { id: string }): boolean {
  return has(ctx, "payroll") || has(ctx, "pay") || has(ctx, "hr") || has(ctx, "admin") || ctx.employee?.id === e.id;
}

/** The full account number: who pays it (a payslip names it), the Aadhaar power, and the person themself. */
function seesFullAccount(ctx: HrmsContext, e: { id: string }): boolean {
  return has(ctx, "payroll") || has(ctx, "pay") || has(ctx, "aadhaar") || ctx.employee?.id === e.id;
}

async function positionTypes(): Promise<string[]> {
  const l = await refList("Position types");
  return l.length ? l : ["Sales", "OfficeStaff", "Other"];
}

const isSalesType = (t: string | null | undefined) => /sales|field/i.test(t ?? "");

/** Positions held by department heads — Report To stores a position, not a person (spec §4.1). */
function headPositions(people: Person[]): string[] {
  return [...new Set(people.filter((p) => isActive(p) && /head\s*$/i.test((p.position ?? "").trim())).map((p) => p.position!.trim()))].sort();
}

/** A select where the list has values, else free text — an empty list must not make a field unfillable. */
function pick(k: string, l: string, opts: string[], extra: Partial<FieldSpec> = {}): FieldSpec {
  return opts.length ? { k, l, t: "select", opts, ...extra } : { k, l, t: "text", hint: `The “${l}” list is empty — add values in Reference lists.`, ...extra };
}

/** How many related rows each employee has, one query for the whole directory. */
async function relatedCounts(ids?: string[]): Promise<Map<string, Record<string, number>>> {
  const only = ids ? sql` where employee_id in ${ids.length ? ids : ["-"]}` : sql``;
  const rows = (await db.execute(sql`
    select 'att' as k, employee_id as id, count(*)::int as n from hrms_attendance ${only} group by employee_id
    union all select 'leave', employee_id, count(*)::int from hrms_leave_requests ${only} group by employee_id
    union all select 'sal', employee_id, count(*)::int from hrms_salaries ${only} group by employee_id
    union all select 'adv', employee_id, count(*)::int from hrms_advances ${only} group by employee_id
    union all select 'help', employee_id, count(*)::int from hrms_help ${only} group by employee_id
    union all select 'tim', employee_id, count(*)::int from hrms_staff_timings ${only} group by employee_id
    union all select 'exp', employee_id, count(*)::int from hrms_expenses ${only} group by employee_id
    union all select 'asset', employee_id, count(*)::int from hrms_asset_assignments ${only} group by employee_id
  `)) as unknown as { k: string; id: string; n: number | string }[];
  const out = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const m = out.get(r.id) ?? {};
    m[r.k] = Number(r.n);
    out.set(r.id, m);
  }
  return out;
}

/* ============================================================== EMPLOYEES */

function employeeRow(ctx: HrmsContext, e: Employee, counts: Record<string, number>, t: string): ListRow {
  const own = ctx.employee?.id === e.id;
  const hr = has(ctx, "hr");
  const sales = isSalesType(e.department);
  let hidden = 0;
  const fields: RowField[] = [];
  const add = (l: string, v: string | null | undefined, der = false) => {
    if (v != null && v !== "") fields.push(der ? { l, v, der } : { l, v });
  };
  if (e.dateOfJoining) add("Working age", workingAge(e.dateOfJoining, t), true);
  add("Gender", e.gender);
  add("Birth date", fdShort(e.dateOfBirth));
  add("Anniversary", fdShort(e.marriageAnniversary));
  add("Children’s birthdays", [e.child1Birthday, e.child2Birthday].filter(Boolean).map((d) => fdShort(d)).join(", "));
  add("Alternate mobile", e.alternateMobile);
  add("Emergency contact", e.emergencyContact);
  add("Company mobile", e.companyMobile);
  add("Email", e.email);
  add("Current address", e.address);
  add("Permanent address", e.permanentAddress);
  add("Leaving date", fdShort(e.dateOfLeaving));
  if (seesPay(ctx, e)) {
    add("Salary allocated", e.netSalaryPaise != null ? inr(e.netSalaryPaise) : "");
    if (sales) add("Conveyance", e.conveyancePaise != null ? inr(e.conveyancePaise) : "");
    add("Other salary", e.otherSalaryPaise != null ? inr(e.otherSalaryPaise) : "");
    add("Bank", e.bankName);
    add("Account", seesFullAccount(ctx, e) && e.accountNumber ? e.accountNumber : masked(e.accountNumberLast4));
    add("IFSC", e.ifscCode);
  } else hidden += sales ? 6 : 5;
  add("PF / ESIC", yn(e.pfEsicApplicable));
  if (e.pfEsicApplicable) {
    add("UAN", e.uanNo);
    add("ESIC number", e.esicNo);
  }
  add("Aadhaar", has(ctx, "aadhaar") && e.aadhaarNumber ? spaced(e.aadhaarNumber) : masked(e.aadhaarLast4), true);
  if (sales) {
    add("Sales area", e.areaAllocated);
    add("Target visits (month)", e.targetVisits?.toString());
    add("Target km (month)", e.targetKm?.toString());
    add("Target litres (month)", e.targetLitres?.toString());
    add("Target hours (month)", e.targetHours?.toString());
    add("Target amount (month)", e.targetAmountPaise != null ? inr(e.targetAmountPaise) : "");
  }
  if (has(ctx, "entitle")) {
    add("Monthly paid leave", e.monthlyPaidLeave?.toString());
    add("Yearly maximum leave", e.yearlyMaximumLeave?.toString());
  } else hidden += 2;
  fields.push(
    { l: "Attendance", v: plural(counts.att ?? 0, "day"), der: true },
    { l: "Leave", v: plural(counts.leave ?? 0, "request"), der: true },
    { l: "Salaries", v: plural(counts.sal ?? 0, "salary", "salaries"), der: true },
    { l: "Advances", v: plural(counts.adv ?? 0, "advance"), der: true },
    { l: "Help requests", v: plural(counts.help ?? 0, "request"), der: true },
    { l: "Timings", v: plural(counts.tim ?? 0, "weekday"), der: true },
    { l: "ID card", v: e.idCardAttachmentId ? "Uploaded" : "None" },
    {
      l: "Record",
      v:
        e.source === "hrms"
          ? "Signed up in HRMS"
          : `From the employee sheet${e.sheetStatus === "withdrawn" ? " · no longer in it" : ""}${e.hrmsDecidedAt ? " · changed in HRMS, so the sheet no longer overwrites it" : ""}`,
    },
  );
  const legacy = Object.entries(e.raw ?? {}).find(([k]) => k.trim().toLowerCase() === "permissions")?.[1];
  if (legacy) fields.push({ l: "Legacy permissions", v: legacy });

  const contacts: Contact[] = [];
  const tel = (l: string, v: string | null) => {
    if (v) contacts.push({ l: `Call ${l}`, href: `tel:${digits(v)}` });
  };
  tel("personal mobile", e.personalMobile);
  tel("alternate mobile", e.alternateMobile);
  tel("emergency contact", e.emergencyContact);
  tel("company mobile", e.companyMobile);
  if (e.email) contacts.push({ l: "Compose email", href: `mailto:${e.email}` });
  if (e.address) contacts.push({ l: "View map (current address)", href: mapHref(e.address) });
  if (e.permanentAddress) contacts.push({ l: "View map (permanent address)", href: mapHref(e.permanentAddress) });
  if (e.photoAttachmentId) contacts.push({ l: "Photo", href: attHref(e.photoAttachmentId) });
  if (e.idCardAttachmentId) contacts.push({ l: "ID card", href: attHref(e.idCardAttachmentId) });

  const actions: ActionSpec[] = [{ id: "edit", l: "Edit", primary: true, loadsForm: true, why: hr ? undefined : "Only HR or admin edits an employee" }];
  if (own && !hr) actions.push({ id: "editSelf", l: "Edit my details", loadsForm: true });
  if (e.status !== "inactive")
    actions.push({
      id: "deactivate",
      l: "Deactivate",
      confirm: `Deactivate ${e.name}? They can no longer sign in to MahekOne, and any open session ends.`,
      why: !hr ? "Only HR or admin deactivates an employee" : own ? "You cannot deactivate your own record" : undefined,
    });
  if (e.status !== "active") actions.push({ id: "activate", l: "Activate", why: hr ? undefined : "Only HR or admin activates an employee" });
  if (has(ctx, "admin")) actions.push({ id: "access", l: "Manage access", href: ADMIN.access });
  if (own || hr)
    actions.push({
      id: "photo",
      l: "Upload photo",
      prompt: {
        title: "Profile photo",
        sub: e.name,
        submit: "Save photo",
        fields: [{ k: "photo", l: "Photo", t: "photo", req: true, hint: "Face the camera in good light. It appears on the ID card and attendance." }],
      },
    });
  if (has(ctx, "admin")) actions.push({ id: "delete", l: "Delete", confirm: `Delete ${e.name}? This cannot be undone. Deactivate instead if they have left.` });

  return {
    id: e.id,
    v: {
      empId: e.employeeCode,
      name: e.name,
      position: e.position ?? "",
      posType: e.department ?? "",
      office: e.officeName ?? "",
      reportTo: e.reportsTo ?? "",
      mobile: e.personalMobile ?? "",
      joining: e.dateOfJoining ?? "",
      status: STATUS_LABEL[e.status] ?? e.status,
    },
    flags: e.status === "inactive" ? ["inactive"] : [],
    title: e.name,
    header: [e.employeeCode, e.position, e.officeName].filter(Boolean).join(" · "),
    fields,
    contacts,
    actions,
    hiddenFields: hidden || undefined,
    by: stampLine(null, e.createdAt),
  };
}

type EmpFormMode = "new" | "edit";

async function employeeForm(ctx: HrmsContext, mode: EmpFormMode, e?: Employee): Promise<FormSpec> {
  const [people, officeList, types, positions, banks, areas] = await Promise.all([
    allPeople(),
    offices(),
    positionTypes(),
    refList("Positions"),
    refList("Bank names"),
    refList("Areas"),
  ]);
  const salesTypes = types.filter(isSalesType);
  const whenSales = { k: "posType", in: salesTypes.length ? salesTypes : ["Sales"] };
  const canAadhaar = mode === "new" || has(ctx, "aadhaar");
  const fullAccount = e ? seesFullAccount(ctx, e) : true;

  const header: FieldSpec[] = [
    sec("Personal", { k: "name", l: "Full name", t: "text", req: true }),
    sec("Personal", { k: "gender", l: "Gender", t: "select", req: true, opts: withCurrent(["Male", "Female"], e?.gender) }),
    sec("Personal", { k: "birth", l: "Birth date", t: "date" }),
    sec("Personal", { k: "anniversary", l: "Marriage anniversary", t: "date" }),
    sec("Personal", { k: "child1", l: "Child 1 birthday", t: "date" }),
    sec("Personal", { k: "child2", l: "Child 2 birthday", t: "date" }),
    ...(mode === "new" ? [sec("Personal", { k: "photo", l: "Photo", t: "photo" })] : []),
    sec("Contact", { k: "mobile", l: "Personal mobile", t: "text", req: true, hint: "10 digits." }),
    sec("Contact", { k: "altMobile", l: "Alternate mobile", t: "text" }),
    sec("Contact", { k: "emergency", l: "Emergency contact", t: "text", req: true }),
    sec("Contact", { k: "companyMobile", l: "Company mobile", t: "text" }),
    sec("Contact", { k: "email", l: "Email", t: "text" }),
    sec("Contact", { k: "address", l: "Current address", t: "area", req: true }),
    sec("Contact", { k: "permAddress", l: "Permanent address", t: "area" }),
    sec("Job", pick("office", "Office", withCurrent(officeList.map((o) => o.name), e?.officeName), { req: true })),
    sec("Job", pick("posType", "Position type", withCurrent(types, e?.department), { req: true })),
    sec("Job", pick("position", "Position", withCurrent(positions, e?.position), { req: true })),
    sec("Job", pick("reportTo", "Reports to", withCurrent(headPositions(people), e?.reportsTo), { hint: "A head’s position. Their team is everyone who reports to it." })),
    sec("Job", { k: "joining", l: "Joining date", t: "date", req: true }),
    ...(mode === "edit" ? [sec("Job", { k: "leaving", l: "Leaving date", t: "date" })] : []),
    sec("Pay", { k: "salary", l: "Salary allocated (₹ per month)", t: "num", req: true, min: 0 }),
    sec("Pay", { k: "conveyance", l: "Conveyance (₹)", t: "num", min: 0, when: whenSales }),
    sec("Pay", { k: "otherSalary", l: "Other salary (₹)", t: "num", min: 0 }),
    sec("Pay", pick("bank", "Bank", withCurrent(banks, e?.bankName), { req: true })),
    sec("Pay", {
      k: "account",
      l: "Account number",
      t: "text",
      req: mode === "new",
      hint: mode === "edit" ? (fullAccount ? "Leave as it is to keep it." : `Leave blank to keep the account ending ${e?.accountNumberLast4 ?? "—"}.`) : undefined,
    }),
    sec("Pay", { k: "ifsc", l: "IFSC", t: "text", req: true }),
    sec("Statutory", { k: "pf", l: "PF / ESIC applies", t: "select", req: true, opts: ["Yes", "No"] }),
    sec("Statutory", { k: "uan", l: "UAN", t: "text", req: true, when: { k: "pf", eq: "Yes" } }),
    sec("Statutory", { k: "esic", l: "ESIC number", t: "text", when: { k: "pf", eq: "Yes" } }),
    sec(
      "Statutory",
      canAadhaar
        ? { k: "aadhaar", l: "Aadhaar", t: "text", req: mode === "new", hint: mode === "edit" ? "Leave blank to keep the number on file." : "12 digits." }
        : { k: "aadhaarShown", l: "Aadhaar", t: "text", readOnly: true, hint: "Only a holder of the Aadhaar power changes it." },
    ),
    sec("Sales targets", pick("area", "Sales area", withCurrent(areas, e?.areaAllocated), { req: true, when: whenSales })),
    sec("Sales targets", { k: "tVisits", l: "Visit target (a month)", t: "num", min: 0, when: whenSales }),
    sec("Sales targets", { k: "tKm", l: "Km target (a month)", t: "num", min: 0, when: whenSales }),
    sec("Sales targets", { k: "tLitres", l: "Litre sales target (a month)", t: "num", min: 0, when: whenSales }),
    sec("Sales targets", { k: "tHours", l: "Working hour target (a month)", t: "num", min: 0, when: whenSales }),
    sec("Sales targets", { k: "tAmount", l: "Sales amount target (₹ a month)", t: "num", min: 0, when: whenSales }),
    ...(has(ctx, "entitle")
      ? [
          sec("Leave entitlement", { k: "monthlyPL", l: "Monthly paid leave", t: "num", min: 0 }),
          sec("Leave entitlement", { k: "yearlyMax", l: "Yearly maximum leave", t: "num", min: 0, hint: "The yearly cap of unpaid leave." }),
        ]
      : []),
  ];

  const init: Record<string, string> = e
    ? {
        name: e.name,
        gender: e.gender ?? "",
        birth: e.dateOfBirth ?? "",
        anniversary: e.marriageAnniversary ?? "",
        child1: e.child1Birthday ?? "",
        child2: e.child2Birthday ?? "",
        mobile: e.personalMobile ?? "",
        altMobile: e.alternateMobile ?? "",
        emergency: e.emergencyContact ?? "",
        companyMobile: e.companyMobile ?? "",
        email: e.email ?? "",
        address: e.address ?? "",
        permAddress: e.permanentAddress ?? "",
        office: e.officeName ?? "",
        posType: e.department ?? "",
        position: e.position ?? "",
        reportTo: e.reportsTo ?? "",
        joining: e.dateOfJoining ?? "",
        leaving: e.dateOfLeaving ?? "",
        salary: rupeesField(e.netSalaryPaise),
        conveyance: rupeesField(e.conveyancePaise),
        otherSalary: rupeesField(e.otherSalaryPaise),
        bank: e.bankName ?? "",
        account: fullAccount ? (e.accountNumber ?? "") : "",
        ifsc: e.ifscCode ?? "",
        pf: e.pfEsicApplicable == null ? "" : e.pfEsicApplicable ? "Yes" : "No",
        uan: e.uanNo ?? "",
        esic: e.esicNo ?? "",
        aadhaar: has(ctx, "aadhaar") ? (e.aadhaarNumber ?? "") : "",
        aadhaarShown: masked(e.aadhaarLast4),
        area: e.areaAllocated ?? "",
        tVisits: e.targetVisits?.toString() ?? "",
        tKm: e.targetKm?.toString() ?? "",
        tLitres: e.targetLitres?.toString() ?? "",
        tHours: e.targetHours?.toString() ?? "",
        tAmount: rupeesField(e.targetAmountPaise),
        monthlyPL: e.monthlyPaidLeave?.toString() ?? "",
        yearlyMax: e.yearlyMaximumLeave?.toString() ?? "",
      }
    : { joining: today(), pf: "Yes", monthlyPL: "1.5", yearlyMax: "12" };

  return {
    screen: "employees",
    id: mode,
    title: mode === "new" ? "Sign up an employee" : `Edit ${e?.name ?? ""}`,
    sub:
      mode === "new"
        ? "Sections appear as they apply: statutory numbers when PF applies, targets for sales staff. Give them MahekOne access afterwards from Manage access."
        : "Saving marks the record as HR’s: the employee sheet no longer overwrites it.",
    submit: mode === "new" ? "Sign up employee" : "Save changes",
    header,
    init,
    recordId: e?.id,
  };
}

/** Validates the sign-up / edit form and returns the columns to write, or a refusal under the field. */
async function readEmployee(
  ctx: HrmsContext,
  h: Values,
  e?: Employee,
): Promise<{ ok: true; cols: Partial<typeof employees.$inferInsert> } | { ok: false; res: Refusal }> {
  const bad = (f: string, m: string) => ({ ok: false as const, res: fieldErr(f, m) });
  const name = text(h.name);
  if (!name) return bad("name", "Required");
  const [dupe] = await db
    .select({ id: employees.id })
    .from(employees)
    .where(and(sql`lower(${employees.name}) = ${name.toLowerCase()}`, e ? ne(employees.id, e.id) : undefined))
    .limit(1);
  if (dupe) return bad("name", "Duplicate Entry!");
  if (!text(h.gender)) return bad("gender", "Required");
  const mobile = digits(h.mobile);
  if (!mobile) return bad("mobile", "Required");
  if (mobile.length !== 10) return bad("mobile", "INVALID");
  if (!text(h.emergency)) return bad("emergency", "Required");
  if (!text(h.address)) return bad("address", "Required");
  const office = text(h.office);
  if (!office) return bad("office", "Required");
  if (office !== e?.officeName && !(await offices()).some((o) => o.name === office)) return bad("office", "Pick one of the offices");
  const posType = text(h.posType);
  if (!posType) return bad("posType", "Required");
  if (!text(h.position)) return bad("position", "Required");
  const joining = text(h.joining);
  if (!joining || !DATE.test(joining)) return bad("joining", "Required");
  for (const k of ["birth", "anniversary", "child1", "child2", "leaving"]) if (text(h[k]) && !DATE.test(h[k])) return bad(k, "INVALID");
  const salary = paise(h.salary);
  if (salary == null || salary < 0) return bad("salary", salary == null ? "Required" : "INVALID");
  for (const k of ["conveyance", "otherSalary", "tVisits", "tKm", "tLitres", "tHours", "tAmount", "monthlyPL", "yearlyMax"]) {
    const n = num(h[k]);
    if (text(h[k]) && (n == null || n < 0)) return bad(k, "INVALID");
  }
  if (!text(h.bank)) return bad("bank", "Required");
  const ifsc = (text(h.ifsc) ?? "").toUpperCase();
  if (!ifsc) return bad("ifsc", "Required");
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) return bad("ifsc", "INVALID");
  const pf = text(h.pf);
  if (pf !== "Yes" && pf !== "No") return bad("pf", "Required");
  if (pf === "Yes" && !text(h.uan)) return bad("uan", "Required");
  const sales = isSalesType(posType);
  if (sales && !text(h.area)) return bad("area", "Required");

  const cols: Partial<typeof employees.$inferInsert> = {
    name,
    gender: text(h.gender),
    dateOfBirth: text(h.birth),
    marriageAnniversary: text(h.anniversary),
    child1Birthday: text(h.child1),
    child2Birthday: text(h.child2),
    personalMobile: mobile,
    alternateMobile: text(h.altMobile),
    emergencyContact: text(h.emergency),
    companyMobile: text(h.companyMobile),
    email: text(h.email),
    address: text(h.address),
    permanentAddress: text(h.permAddress),
    officeName: office,
    department: posType,
    position: text(h.position),
    reportsTo: text(h.reportTo),
    dateOfJoining: joining,
    netSalaryPaise: salary,
    // Conveyance is paid only to sales staff (spec §4.1).
    conveyancePaise: sales ? paise(h.conveyance) : null,
    otherSalaryPaise: paise(h.otherSalary),
    bankName: text(h.bank),
    ifscCode: ifsc,
    pfEsicApplicable: pf === "Yes",
    uanNo: pf === "Yes" ? text(h.uan) : null,
    esicNo: pf === "Yes" ? text(h.esic) : null,
    areaAllocated: sales ? text(h.area) : (e?.areaAllocated ?? null),
    targetVisits: sales ? int(h.tVisits) : null,
    targetKm: sales ? int(h.tKm) : null,
    targetLitres: sales ? int(h.tLitres) : null,
    targetHours: sales ? int(h.tHours) : null,
    targetAmountPaise: sales ? paise(h.tAmount) : null,
  };
  if (e) cols.dateOfLeaving = text(h.leaving);

  // The account number: required on sign-up; on an edit, blank keeps what is on file.
  const account = digits(h.account);
  if (!e && !account) return bad("account", "Required");
  if (account) {
    if (account.length < 6 || account.length > 20 || account !== String(h.account).trim()) return bad("account", "INVALID");
    cols.accountNumber = account;
    cols.accountNumberLast4 = account.slice(-4);
  }

  // Aadhaar: typed at sign-up, changed afterwards only with the Aadhaar power.
  if (!e || has(ctx, "aadhaar")) {
    const a = String(h.aadhaar ?? "").replace(/\s/g, "");
    if (a || !e) {
      if (!/^\d{12}$/.test(a)) return bad("aadhaar", "Enter 12 Digit Valid Adhar Number");
      cols.aadhaarNumber = a;
      cols.aadhaarLast4 = a.slice(-4);
    }
  }

  // Leave entitlements only with the power that sees them (spec §4.1).
  if (has(ctx, "entitle")) {
    cols.monthlyPaidLeave = num(h.monthlyPL);
    cols.yearlyMaximumLeave = int(h.yearlyMax);
  } else if (!e) {
    cols.monthlyPaidLeave = 1.5;
    cols.yearlyMaximumLeave = 12;
  }
  return { ok: true, cols };
}

/**
 * Activate / deactivate, one or many. The linked MahekOne sign-in follows the
 * employee (spec §2.1): disabled with its sessions ended, or enabled again.
 * Stamps `hrmsDecidedAt` so the sheet's own status column cannot undo it.
 */
async function setEmployeeStatus(ctx: HrmsContext, ids: string[], active: boolean) {
  if (!has(ctx, "hr")) return err(`Only HR or admin ${active ? "activates" : "deactivates"} an employee`, "not_permitted");
  if (!active && ctx.employee && ids.includes(ctx.employee.id)) return err("You cannot deactivate your own record.");
  const rows = await db
    .select({ id: employees.id, name: employees.name, status: employees.status, leaving: employees.dateOfLeaving })
    .from(employees)
    .where(inArray(employees.id, ids));
  const change = rows.filter((r) => (active ? r.status !== "active" : r.status !== "inactive"));
  if (!change.length) return okVoid("Nothing to change.");
  const changeIds = change.map((r) => r.id);
  const t = today();
  let ended = 0;
  const res = await inTx(async (tx) => {
    for (const r of change)
      await tx
        .update(employees)
        .set({ status: active ? "active" : "inactive", dateOfLeaving: active ? null : (r.leaving ?? t), hrmsDecidedAt: new Date(), updatedAt: new Date() })
        .where(eq(employees.id, r.id));
    const linked = await tx.update(users).set({ active, updatedAt: new Date() }).where(inArray(users.employeeId, changeIds)).returning({ id: users.id });
    // A session row is good for thirty days; a leaver's should not outlive the decision.
    if (!active && linked.length) {
      const gone = await tx
        .delete(sessions)
        .where(inArray(sessions.userId, linked.map((u) => u.id)))
        .returning({ id: sessions.id });
      ended = gone.length;
    }
    return okVoid();
  });
  if (!res.ok) return res;
  await hrmsAudit(ctx, active ? "hrms.employee.activate" : "hrms.employee.deactivate", "employees", changeIds.length === 1 ? changeIds[0] : null, null, {
    ids: changeIds,
    sessionsEnded: ended,
  });
  const who = change.length === 1 ? change[0].name : `${change.length} employees`;
  return okVoid(active ? `${who} activated · their MahekOne sign-in works again` : `${who} deactivated${ended ? ` · ${plural(ended, "open session")} ended` : ""}`);
}

async function employeeById(id: string): Promise<Employee | null> {
  const [e] = await db.select().from(employees).where(eq(employees.id, id)).limit(1);
  return e ?? null;
}

/** What a person changes on their own record (Q13, as proposed): contact details and family dates. */
const SELF_FIELDS: FieldSpec[] = [
  { k: "mobile", l: "Personal mobile", t: "text", req: true, hint: "10 digits." },
  { k: "altMobile", l: "Alternate mobile", t: "text" },
  { k: "emergency", l: "Emergency contact", t: "text", req: true },
  { k: "email", l: "Email", t: "text" },
  { k: "address", l: "Current address", t: "area", req: true },
  { k: "permAddress", l: "Permanent address", t: "area" },
  { k: "anniversary", l: "Marriage anniversary", t: "date" },
  { k: "child1", l: "Child 1 birthday", t: "date" },
  { k: "child2", l: "Child 2 birthday", t: "date" },
];

const employeesScreen: HrmsScreenModule = {
  key: "employees",
  async load(ctx, q) {
    const t = today();
    const [rows, people] = await Promise.all([db.select().from(employees).orderBy(asc(employees.name)), allPeople()]);
    const { scope, options } = scopeFor(ctx, q, "hr");
    const ids = visibleIds(ctx, scope, people);
    const shown = ids ? rows.filter((r) => ids.has(r.id)) : rows;
    const counts = await relatedCounts(ids ? [...ids] : undefined);
    const hr = has(ctx, "hr");
    const tools: ToolSpec[] = hr
      ? [{ id: "pullSheet", l: "Pull the employee sheet", confirm: "Read the Employee Details sheet now? Records HR has signed up or changed here are left as they are." }]
      : [];
    return {
      spec: {
        screen: "employees",
        cols: [
          { k: "empId", l: "ID", t: "mono" },
          { k: "name", l: "Employee", t: "b" },
          { k: "position", l: "Position", t: "t" },
          { k: "posType", l: "Type", t: "s" },
          { k: "office", l: "Office", t: "t" },
          { k: "reportTo", l: "Reports to", t: "t" },
          { k: "mobile", l: "Mobile", t: "ph" },
          { k: "joining", l: "Joined", t: "d" },
          { k: "status", l: "Status", t: "s" },
          { k: "f", l: "", t: "f" },
        ],
        hidden: [],
        groups: ["status"],
        chips: "posType",
        sortDefault: ["name", 1],
        godownKey: "office",
        bulk: hr
          ? [
              { id: "empActivate", l: "Activate", confirm: "Activate the selected employees? Their MahekOne sign-in works again." },
              { id: "empDeactivate", l: "Deactivate", confirm: "Deactivate the selected employees? They can no longer sign in, and open sessions end." },
            ]
          : undefined,
        newForm: hr ? await employeeForm(ctx, "new") : undefined,
        newLabel: "Sign up an employee",
        tools,
        noDataLine: "No employees yet. Sign one up, or pull the employee sheet.",
        hrms: { scope: { current: scope, options } },
      },
      rows: shown.map((e) => employeeRow(ctx, e, counts.get(e.id) ?? {}, t)),
    };
  },
  formLoaders: {
    async edit(ctx, id) {
      if (!has(ctx, "hr")) return null;
      const e = await employeeById(id);
      return e ? employeeForm(ctx, "edit", e) : null;
    },
    async editSelf(ctx, id) {
      if (ctx.employee?.id !== id) return null;
      const e = await employeeById(id);
      if (!e) return null;
      return {
        screen: "employees",
        id: "editSelf",
        title: "Edit my details",
        sub: "Your contact details and family dates. HR changes everything else.",
        submit: "Save",
        header: SELF_FIELDS,
        init: {
          mobile: e.personalMobile ?? "",
          altMobile: e.alternateMobile ?? "",
          emergency: e.emergencyContact ?? "",
          email: e.email ?? "",
          address: e.address ?? "",
          permAddress: e.permanentAddress ?? "",
          anniversary: e.marriageAnniversary ?? "",
          child1: e.child1Birthday ?? "",
          child2: e.child2Birthday ?? "",
        },
        recordId: e.id,
      };
    },
  },
  forms: {
    async new(ctx, h) {
      if (!has(ctx, "hr")) return err("Only HR or admin signs up an employee", "not_permitted");
      const read = await readEmployee(ctx, h);
      if (!read.ok) return read.res;
      const id = hrmsId("emp");
      let code = "";
      const res = await inTx(async (tx) => {
        // The next unused EMP number (spec §1.3): migrated codes are random,
        // so a number the series reaches may already be taken.
        for (let i = 0; i < 50 && !code; i++) {
          const c = `EMP-${String(await nextSeries(tx, "employee")).padStart(4, "0")}`;
          const [taken] = await tx.select({ id: employees.id }).from(employees).where(eq(employees.employeeCode, c)).limit(1);
          if (!taken) code = c;
        }
        if (!code) return refuse(err("Could not allocate an employee ID. Try again."));
        await tx.insert(employees).values({
          ...read.cols,
          id,
          name: read.cols.name!,
          employeeCode: code,
          status: "active",
          statusRaw: "Active",
          source: "hrms",
          rowNumber: 0,
          raw: {},
          rowHash: "hrms",
          sheetStatus: "present",
          photoAttachmentId: text(h.photo),
        });
        if (h.photo) await bindHrmsFiles(tx, [h.photo], "hrms_employee", id, ctx.user.id);
        return okVoid(`${read.cols.name} signed up as ${code} · give them MahekOne access from Manage access`);
      });
      if (res.ok) await hrmsAudit(ctx, "hrms.employee.signUp", "employees", id, null, { code, name: read.cols.name });
      return res;
    },
    async edit(ctx, h, _lines, recordId) {
      if (!has(ctx, "hr")) return err("Only HR or admin edits an employee", "not_permitted");
      const e = recordId ? await employeeById(recordId) : null;
      if (!e) return err("That employee no longer exists.", "not_found");
      const read = await readEmployee(ctx, h, e);
      if (!read.ok) return read.res;
      await db
        .update(employees)
        .set({ ...read.cols, hrmsDecidedAt: new Date(), updatedAt: new Date() })
        .where(eq(employees.id, e.id));
      // The audit trail names what changed, never the full numbers.
      const logged = { ...read.cols };
      delete logged.aadhaarNumber;
      delete logged.accountNumber;
      await hrmsAudit(ctx, "hrms.employee.edit", "employees", e.id, { name: e.name }, logged);
      return okVoid(`${read.cols.name} updated`);
    },
    async editSelf(ctx, h, _lines, recordId) {
      if (!recordId || ctx.employee?.id !== recordId) return err("You edit only your own details here.", "not_permitted");
      const mobile = digits(h.mobile);
      if (!mobile) return fieldErr("mobile", "Required");
      if (mobile.length !== 10) return fieldErr("mobile", "INVALID");
      if (!text(h.emergency)) return fieldErr("emergency", "Required");
      if (!text(h.address)) return fieldErr("address", "Required");
      for (const k of ["anniversary", "child1", "child2"]) if (text(h[k]) && !DATE.test(h[k])) return fieldErr(k, "INVALID");
      const cols = {
        personalMobile: mobile,
        alternateMobile: text(h.altMobile),
        emergencyContact: text(h.emergency),
        email: text(h.email),
        address: text(h.address),
        permanentAddress: text(h.permAddress),
        marriageAnniversary: text(h.anniversary),
        child1Birthday: text(h.child1),
        child2Birthday: text(h.child2),
      };
      await db
        .update(employees)
        .set({ ...cols, hrmsDecidedAt: new Date(), updatedAt: new Date() })
        .where(eq(employees.id, recordId));
      await hrmsAudit(ctx, "hrms.employee.editSelf", "employees", recordId, null, cols);
      return okVoid("Your details are saved");
    },
  },
  actions: {
    async deactivate(ctx, id) {
      return setEmployeeStatus(ctx, [id], false);
    },
    async activate(ctx, id) {
      return setEmployeeStatus(ctx, [id], true);
    },
    async photo(ctx, id, v) {
      if (!(ctx.employee?.id === id || has(ctx, "hr"))) return err("Only the person or HR changes a profile photo.", "not_permitted");
      const photo = text(v.photo);
      if (!photo) return fieldErr("photo", "Required");
      const res = await inTx(async (tx) => {
        const up = await tx.update(employees).set({ photoAttachmentId: photo, updatedAt: new Date() }).where(eq(employees.id, id)).returning({ id: employees.id });
        if (!up.length) return refuse(err("That employee no longer exists.", "not_found"));
        await bindHrmsFiles(tx, [photo], "hrms_employee", id, ctx.user.id);
        return okVoid("Photo updated");
      });
      if (res.ok) await hrmsAudit(ctx, "hrms.employee.photo", "employees", id, null, { photo });
      return res;
    },
    async delete(ctx, id) {
      if (!has(ctx, "admin")) return err("Only admin deletes an employee", "not_permitted");
      const e = await employeeById(id);
      if (!e) return err("That employee no longer exists.", "not_found");
      const c = (await relatedCounts([id])).get(id) ?? {};
      const history = [
        c.att && plural(c.att, "attendance day"),
        c.leave && plural(c.leave, "leave request"),
        c.sal && plural(c.sal, "salary", "salaries"),
        c.adv && plural(c.adv, "advance"),
        c.exp && plural(c.exp, "expense"),
        c.asset && plural(c.asset, "asset assignment"),
      ].filter(Boolean);
      // A49: history outlives the person. Deactivating keeps it; deleting would cascade it away.
      if (history.length) return err(`${e.name} has ${history.join(", ")}. Deactivate instead — deleting would erase that history.`, "rule_violation");
      if (e.source !== "hrms" && e.sheetStatus === "present")
        return err(`${e.name} is still on the employee sheet, so the next pull would bring them back. Remove the row from the sheet, or deactivate.`, "rule_violation");
      await db.delete(employees).where(eq(employees.id, id));
      await hrmsAudit(ctx, "hrms.employee.delete", "employees", id, { code: e.employeeCode, name: e.name }, null);
      return okVoid(`${e.name} deleted`);
    },
  },
  bulk: {
    async empActivate(ctx, ids) {
      return setEmployeeStatus(ctx, ids, true);
    },
    async empDeactivate(ctx, ids) {
      return setEmployeeStatus(ctx, ids, false);
    },
  },
  tools: {
    async pullSheet(ctx) {
      if (!has(ctx, "hr")) return err("Only HR or admin pulls the employee sheet", "not_permitted");
      return syncEmployeesAction(true);
    },
  },
};

/* =============================================================== ID CARDS */

const idCards: HrmsScreenModule = {
  key: "idCards",
  async load(ctx) {
    const hr = has(ctx, "hr");
    const rows = await db
      .select({
        id: employees.id,
        code: employees.employeeCode,
        name: employees.name,
        position: employees.position,
        office: employees.officeName,
        card: employees.idCardAttachmentId,
        photo: employees.photoAttachmentId,
      })
      .from(employees)
      .where(and(eq(employees.status, "active"), hr ? undefined : eq(employees.id, ctx.employee?.id ?? "-")))
      .orderBy(asc(employees.name));
    return {
      spec: {
        screen: "idCards",
        cols: [
          { k: "name", l: "Employee", t: "b" },
          { k: "empId", l: "ID", t: "mono" },
          { k: "position", l: "Position", t: "t" },
          { k: "office", l: "Office", t: "t" },
          { k: "card", l: "ID card", t: "s" },
        ],
        hidden: [],
        chips: "card",
        sortDefault: ["name", 1],
        godownKey: "office",
        noDataLine: hr ? "No active employees." : "Your ID card is not here yet.",
        /* The design draws ID cards as a gallery: an ID card is checked by
           looking at it, not by reading "Uploaded" in a column. */
        cards: { img: "img", title: "name", lines: ["empId", "position", "office"], empty: "No ID card uploaded" },
      },
      rows: rows.map((r) => {
        const actions: ActionSpec[] = [];
        if (r.card) actions.push({ id: "view", l: "Open ID card", primary: true, href: attHref(r.card) });
        actions.push({
          id: "upload",
          l: r.card ? "Replace ID card" : "Upload ID card",
          primary: !r.card,
          why: hr ? undefined : "HR uploads ID cards",
          prompt: { title: "ID card image", sub: `${r.name} · ${r.code}`, submit: "Save ID card", fields: [{ k: "image", l: "ID card image", t: "photo", req: true }] },
        });
        if (r.card) actions.push({ id: "remove", l: "Remove ID card", why: has(ctx, "admin") ? undefined : "Only admin removes an ID card", confirm: `Remove ${r.name}’s ID card image?` });
        const contacts: Contact[] = [];
        if (r.card) contacts.push({ l: "ID card", href: attHref(r.card) });
        if (r.photo) contacts.push({ l: "Photo", href: attHref(r.photo) });
        return {
          id: r.id,
          v: { name: r.name, empId: r.code, position: r.position ?? "", office: r.office ?? "", card: r.card ? "Uploaded" : "Missing", img: r.card ? attHref(r.card) : "" },
          flags: [],
          title: r.name,
          header: [r.code, r.position, r.office].filter(Boolean).join(" · "),
          contacts,
          actions,
        };
      }),
    };
  },
  actions: {
    async upload(ctx, id, v) {
      if (!has(ctx, "hr")) return err("HR uploads ID cards", "not_permitted");
      const image = text(v.image);
      if (!image) return fieldErr("image", "Required");
      const res = await inTx(async (tx) => {
        const up = await tx.update(employees).set({ idCardAttachmentId: image, updatedAt: new Date() }).where(eq(employees.id, id)).returning({ id: employees.id });
        if (!up.length) return refuse(err("That employee no longer exists.", "not_found"));
        await bindHrmsFiles(tx, [image], "hrms_employee", id, ctx.user.id);
        return okVoid("ID card saved");
      });
      if (res.ok) await hrmsAudit(ctx, "hrms.employee.idCard", "employees", id, null, { idCard: image });
      return res;
    },
    async remove(ctx, id) {
      if (!has(ctx, "admin")) return err("Only admin removes an ID card", "not_permitted");
      await db.update(employees).set({ idCardAttachmentId: null, updatedAt: new Date() }).where(eq(employees.id, id));
      await hrmsAudit(ctx, "hrms.employee.idCardRemove", "employees", id, null, null);
      return okVoid("ID card removed");
    },
  },
};

/* ================================================================ OFFICES */

type Office = typeof hrmsOffices.$inferSelect;
const canOffice = (ctx: HrmsContext) => has(ctx, "hr") || has(ctx, "admin");

/** "19.2094, 73.0939" → the pin; anything else is refused rather than guessed at. */
function parsePin(v: string | undefined): { lat: number; lng: number } | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(v ?? ""));
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

async function officeForm(office?: Office): Promise<FormSpec> {
  const max = (await getConfig())["hrms.office.maxRangeM"];
  return {
    screen: "offices",
    id: office ? "edit" : "new",
    title: office ? `Edit ${office.name}` : "Add office",
    sub: "Check-in compares the phone’s location with this pin and radius.",
    submit: "Save office",
    header: [
      {
        k: "name",
        l: "Office name",
        t: "text",
        req: true,
        readOnly: !!office,
        hint: office ? "People and assets are filed under this name, so it does not change here." : undefined,
      },
      { k: "city", l: "City", t: "text", req: true },
      { k: "state", l: "State", t: "text", req: true },
      { k: "region", l: "Region", t: "text", req: true },
      { k: "pin", l: "Map pin", t: "pin", req: true, hint: "Pick the doorway on the map, use your location while standing there, or type latitude, longitude." },
      { k: "address", l: "Address", t: "area", req: true },
      { k: "radius", l: "Radius (metres)", t: "num", req: true, min: 1, max },
      { k: "open", l: "Opening time", t: "time", req: true },
      { k: "close", l: "Closing time", t: "time", req: true },
      { k: "timing", l: "Timing type", t: "select", req: true, opts: ["Full Day", "Half Day", "24*7"] },
      { k: "duration", l: "Duration", t: "derived", calc: "hrms.office.duration" },
      { k: "plNote", l: "Official paid-leave note", t: "area" },
      {
        k: "qr",
        l: "Attendance QR text",
        t: "text",
        hint: office ? "What the printed QR code carries. Changing it means printing it again." : "Left blank, the next MMI-ATT number is given.",
      },
      { k: "image", l: "Office image", t: "photo" },
    ],
    init: office
      ? {
          name: office.name,
          city: office.city ?? "",
          state: office.state ?? "",
          region: office.region ?? "",
          pin: office.lat != null && office.lng != null ? `${office.lat}, ${office.lng}` : "",
          address: office.address ?? "",
          radius: String(office.radiusM),
          open: office.openingTime ?? "",
          close: office.closingTime ?? "",
          timing: office.timingType,
          plNote: office.paidLeaveNote ?? "",
          qr: office.qrText ?? "",
        }
      : { radius: "200", open: "09:30", close: "18:30", timing: "Full Day" },
    recordId: office?.id,
  };
}

async function saveOffice(ctx: HrmsContext, h: Values, existing?: Office) {
  if (!canOffice(ctx)) return err("Only HR or admin sets up offices", "not_permitted");
  const max = (await getConfig())["hrms.office.maxRangeM"];
  const name = existing ? existing.name : text(h.name);
  if (!name) return fieldErr("name", "Required");
  for (const k of ["city", "state", "region", "address"]) if (!text(h[k])) return fieldErr(k, "Required");
  const pin = parsePin(h.pin);
  if (!pin) return fieldErr("pin", "INVALID");
  const radius = num(h.radius);
  if (radius == null) return fieldErr("radius", "Required");
  // A42: the source's limit is 20 km whatever its message says.
  if (radius > max) return fieldErr("radius", `Set Range less than ${max / 1000} km`);
  if (radius <= 0) return fieldErr("radius", "INVALID");
  const timing = text(h.timing) ?? "Full Day";
  if (!["Full Day", "Half Day", "24*7"].includes(timing)) return fieldErr("timing", "INVALID");
  const open = tmin(h.open);
  const close = tmin(h.close);
  if (open == null) return fieldErr("open", "Required");
  if (close == null) return fieldErr("close", "Required");
  if (timing !== "24*7" && close <= open) return fieldErr("close", "Closing must be after opening");
  const cols = {
    city: text(h.city),
    state: text(h.state),
    region: text(h.region),
    lat: pin.lat,
    lng: pin.lng,
    address: text(h.address),
    radiusM: Math.round(radius),
    openingTime: h.open,
    closingTime: h.close,
    timingType: timing,
    paidLeaveNote: text(h.plNote),
  };
  const id = existing?.id ?? hrmsId("hoff");
  const res = await inTx(async (tx) => {
    if (!existing) {
      const [dupe] = await tx
        .select({ id: hrmsOffices.id })
        .from(hrmsOffices)
        .where(sql`lower(${hrmsOffices.name}) = ${name.toLowerCase()}`)
        .limit(1);
      if (dupe) return refuse(fieldErr("name", "Duplicate Entry!"));
    }
    const qr = text(h.qr) ?? existing?.qrText ?? `MMI-ATT-${100 + (await nextSeries(tx, "officeQr"))}`;
    const [qrDupe] = await tx
      .select({ id: hrmsOffices.id })
      .from(hrmsOffices)
      .where(and(eq(hrmsOffices.qrText, qr), ne(hrmsOffices.id, id)))
      .limit(1);
    if (qrDupe) return refuse(fieldErr("qr", "Duplicate Entry!"));
    const image = text(h.image);
    if (existing)
      await tx
        .update(hrmsOffices)
        .set({ ...cols, qrText: qr, ...(image ? { imageAttachmentId: image } : {}), updatedAt: new Date(), updatedById: ctx.user.id })
        .where(eq(hrmsOffices.id, id));
    else await tx.insert(hrmsOffices).values({ id, name, ...cols, qrText: qr, imageAttachmentId: image, createdById: ctx.user.id });
    if (image) await bindHrmsFiles(tx, [image], "hrms_office", id, ctx.user.id);
    return okVoid(existing ? `${name} saved` : `${name} added · print its QR code from the record`);
  });
  if (res.ok) await hrmsAudit(ctx, existing ? "hrms.office.edit" : "hrms.office.add", "hrms_offices", id, existing ?? null, { name, ...cols });
  return res;
}

const officesScreen: HrmsScreenModule = {
  key: "offices",
  async load(ctx) {
    const [list, people] = await Promise.all([offices(), allPeople()]);
    const staff = new Map<string, number>();
    for (const p of people) if (isActive(p) && p.office) staff.set(p.office, (staff.get(p.office) ?? 0) + 1);
    const can = canOffice(ctx);
    return {
      spec: {
        screen: "offices",
        cols: [
          { k: "name", l: "Office", t: "b" },
          { k: "city", l: "City", t: "t" },
          { k: "region", l: "Region", t: "t" },
          { k: "radius", l: "Radius (m)", t: "n" },
          { k: "open", l: "Opens", t: "t" },
          { k: "close", l: "Closes", t: "t" },
          { k: "timing", l: "Timing", t: "s" },
          { k: "emp", l: "Staff", t: "n" },
          { k: "f", l: "", t: "f" },
        ],
        hidden: [],
        groups: ["region"],
        sortDefault: ["name", 1],
        newForm: can ? await officeForm() : undefined,
        newLabel: "Add office",
        noDataLine: "No offices yet. Add one so people can check in.",
      },
      rows: list.map((o) => {
        const pin = o.lat != null && o.lng != null ? `${o.lat}, ${o.lng}` : "";
        const n = staff.get(o.name) ?? 0;
        const fields: RowField[] = [
          { l: "Address", v: o.address ?? "" },
          { l: "Map pin", v: pin || "No map pin — check-in cannot measure distance" },
          { l: "State", v: o.state ?? "" },
          { l: "Duration", v: officeDuration(o.openingTime ?? undefined, o.closingTime ?? undefined, o.timingType), der: true },
          { l: "Official paid-leave note", v: o.paidLeaveNote ?? "" },
          { l: "Attendance QR text", v: o.qrText ?? "" },
        ].filter((f) => f.v !== "");
        const contacts: Contact[] = [];
        if (pin) contacts.push({ l: "View map (pin)", href: mapHref(pin) });
        if (o.address) contacts.push({ l: "View map (address)", href: mapHref(o.address) });
        if (o.imageAttachmentId) contacts.push({ l: "Office image", href: attHref(o.imageAttachmentId) });
        const actions: ActionSpec[] = [
          { id: "qr", l: "Print QR code", primary: true, href: `/hrms/offices/${o.id}/qr`, why: o.qrText ? undefined : "Give the office a QR text first" },
          { id: "edit", l: "Edit", loadsForm: true, why: can ? undefined : "Only HR or admin edits an office" },
        ];
        if (pin) actions.push({ id: "map", l: "View map", href: mapHref(pin) });
        if (has(ctx, "admin"))
          actions.push({ id: "delete", l: "Delete", confirm: `Delete ${o.name}? Its QR code stops working.`, why: n ? `${plural(n, "active employee")} work here` : undefined });
        return {
          id: o.id,
          v: { name: o.name, city: o.city ?? "", region: o.region ?? "", radius: o.radiusM, open: o.openingTime ?? "", close: o.closingTime ?? "", timing: o.timingType, emp: n },
          flags: pin ? [] : ["noPin"],
          title: o.name,
          header: [o.city, o.state, `${o.radiusM} m`].filter(Boolean).join(" · "),
          fields,
          contacts,
          actions,
          by: stampLine(null, o.createdAt),
        };
      }),
    };
  },
  formLoaders: {
    async edit(ctx, id) {
      if (!canOffice(ctx)) return null;
      const [o] = await db.select().from(hrmsOffices).where(eq(hrmsOffices.id, id)).limit(1);
      return o ? officeForm(o) : null;
    },
  },
  forms: {
    async new(ctx, h) {
      return saveOffice(ctx, h);
    },
    async edit(ctx, h, _l, recordId) {
      const [o] = recordId ? await db.select().from(hrmsOffices).where(eq(hrmsOffices.id, recordId)).limit(1) : [];
      if (!o) return err("That office no longer exists.", "not_found");
      return saveOffice(ctx, h, o);
    },
  },
  actions: {
    async delete(ctx, id) {
      if (!has(ctx, "admin")) return err("Only admin deletes an office", "not_permitted");
      const [o] = await db.select().from(hrmsOffices).where(eq(hrmsOffices.id, id)).limit(1);
      if (!o) return err("That office no longer exists.", "not_found");
      const n = (await allPeople()).filter((p) => isActive(p) && p.office === o.name).length;
      if (n) return err(`${plural(n, "active employee")} work at ${o.name}. Move them first.`, "rule_violation");
      await db.delete(hrmsOffices).where(eq(hrmsOffices.id, id));
      await hrmsAudit(ctx, "hrms.office.delete", "hrms_offices", id, o, null);
      return okVoid(`${o.name} deleted`);
    },
  },
};

/* ========================================================== STAFF TIMINGS */

/** Monday first — the working week the way people read it. */
const WEEK: string[] = [...WEEKDAYS.slice(1), WEEKDAYS[0]];
const canTimings = (ctx: HrmsContext) => has(ctx, "timings") || has(ctx, "hr");
const dutyHours = (i: string, o: string) => {
  const a = tmin(i);
  const b = tmin(o);
  return a == null || b == null ? null : Math.round((b - a) / 6) / 10;
};

function badTimes(v: Values): Refusal | null {
  const a = tmin(v.in);
  const b = tmin(v.out);
  if (a == null) return fieldErr("in", "Required");
  if (b == null) return fieldErr("out", "Required");
  if (b <= a) return fieldErr("out", "Out time must be after in time");
  return null;
}

/** One row per employee per weekday (A50): a second is "Duplicate Entry!". */
async function addTiming(ctx: HrmsContext, employeeId: string, weekday: string, inT: string, outT: string) {
  const id = hrmsId("htim");
  const res = await inTx(async (tx) => {
    const [dupe] = await tx
      .select({ id: hrmsStaffTimings.id })
      .from(hrmsStaffTimings)
      .where(and(eq(hrmsStaffTimings.employeeId, employeeId), eq(hrmsStaffTimings.weekday, weekday)))
      .limit(1);
    if (dupe) return refuse(fieldErr("weekday", "Duplicate Entry!"));
    await tx.insert(hrmsStaffTimings).values({ id, employeeId, weekday, inTime: inT, outTime: outT, createdById: ctx.user.id });
    return okVoid();
  });
  if (res.ok) await hrmsAudit(ctx, "hrms.timing.add", "hrms_staff_timings", id, null, { employeeId, weekday, in: inT, out: outT });
  return res;
}

const timings: HrmsScreenModule = {
  key: "timings",
  async load(ctx, q) {
    const [rows, people] = await Promise.all([db.select().from(hrmsStaffTimings), allPeople()]);
    const { scope, options } = scopeFor(ctx, q, "timings", "hr");
    const ids = visibleIds(ctx, scope, people);
    const pb = byId(people);
    const can = canTimings(ctx);
    const usedBy = new Map<string, Set<string>>();
    for (const r of rows) usedBy.set(r.employeeId, (usedBy.get(r.employeeId) ?? new Set<string>()).add(r.weekday));
    const shown = rows
      .filter((r) => !ids || ids.has(r.employeeId))
      .sort((a, b) => (pb.get(a.employeeId)?.name ?? "").localeCompare(pb.get(b.employeeId)?.name ?? "") || WEEK.indexOf(a.weekday) - WEEK.indexOf(b.weekday));
    return {
      spec: {
        screen: "timings",
        cols: [
          { k: "emp", l: "Employee", t: "b" },
          { k: "weekday", l: "Weekday", t: "t" },
          { k: "in", l: "In", t: "t" },
          { k: "out", l: "Out", t: "t" },
          { k: "duty", l: "Duty (h)", t: "n" },
        ],
        hidden: [],
        groups: ["emp"],
        godownKey: "office",
        newForm: can
          ? {
              screen: "timings",
              id: "new",
              title: "Add a staff timing",
              sub: "One weekday per row. Use Add more time on a row to copy it to another weekday.",
              submit: "Save timing",
              header: [
                { k: "emp", l: "Employee", t: "select", req: true, opts: people.filter(isActive).map(personOption) },
                { k: "weekday", l: "Weekday", t: "select", req: true, opts: WEEK },
                { k: "in", l: "In time", t: "time", req: true },
                { k: "out", l: "Out time", t: "time", req: true },
                { k: "duty", l: "Duty duration", t: "derived", calc: "hrms.timing.duty" },
              ],
              init: { in: "09:30", out: "18:30" },
            }
          : undefined,
        newLabel: "Add timing",
        noDataLine: "No timings yet. Without one, a day has no official in time and nobody is late.",
        hrms: { scope: { current: scope, options } },
      },
      rows: shown.map((r) => {
        const p = pb.get(r.employeeId);
        const free = WEEK.filter((w) => !usedBy.get(r.employeeId)?.has(w));
        const actions: ActionSpec[] = [
          {
            id: "addMore",
            l: "Add more time",
            primary: true,
            why: !can ? "Only HR or whoever sets timings adds them" : free.length ? undefined : "Every weekday has a timing",
            prompt: {
              title: "Copy to another weekday",
              sub: `${p?.name ?? ""} · ${r.inTime}–${r.outTime}`,
              submit: "Add timing",
              fields: [{ k: "weekday", l: "Weekday", t: "select", req: true, opts: free }],
            },
          },
          {
            id: "quickEdit",
            l: "Quick edit",
            why: can ? undefined : "Only HR or whoever sets timings changes them",
            prompt: {
              title: "Edit timing",
              sub: `${p?.name ?? ""} · ${r.weekday}`,
              submit: "Save",
              init: { in: r.inTime, out: r.outTime },
              fields: [
                { k: "in", l: "In time", t: "time", req: true },
                { k: "out", l: "Out time", t: "time", req: true },
              ],
            },
          },
          { id: "employee", l: "View employee", href: hrmsLink("employees", { open: r.employeeId, scope: "all" }) },
        ];
        if (can) actions.push({ id: "delete", l: "Delete", confirm: `Delete ${p?.name ?? "this person"}’s ${r.weekday} timing? That weekday then has no official in time.` });
        return {
          id: r.id,
          v: { emp: p?.name ?? "", weekday: r.weekday, in: r.inTime, out: r.outTime, duty: dutyHours(r.inTime, r.outTime), office: p?.office ?? "" },
          flags: [],
          title: `${p?.name ?? ""} · ${r.weekday}`,
          header: `${r.inTime} – ${r.outTime}`,
          fields: [
            { l: "Employee ID", v: p?.code ?? "" },
            { l: "Duty duration", v: dutyDuration(r.inTime, r.outTime), der: true },
          ],
          actions,
          by: stampLine(null, r.createdAt),
        };
      }),
    };
  },
  forms: {
    async new(ctx, h) {
      if (!canTimings(ctx)) return err("Only HR or whoever sets timings adds them", "not_permitted");
      const p = personFrom(h.emp, await allPeople());
      if (!p) return fieldErr("emp", "invalid Name");
      if (!WEEK.includes(h.weekday)) return fieldErr("weekday", "Required");
      const bad = badTimes(h);
      if (bad) return bad;
      const res = await addTiming(ctx, p.id, h.weekday, h.in, h.out);
      return res.ok ? okVoid(`Timing saved · ${p.name} · ${h.weekday}`) : res;
    },
  },
  actions: {
    async addMore(ctx, id, v) {
      if (!canTimings(ctx)) return err("Only HR or whoever sets timings adds them", "not_permitted");
      const [r] = await db.select().from(hrmsStaffTimings).where(eq(hrmsStaffTimings.id, id)).limit(1);
      if (!r) return err("That timing no longer exists.", "not_found");
      if (!WEEK.includes(v.weekday)) return fieldErr("weekday", "Required");
      const res = await addTiming(ctx, r.employeeId, v.weekday, r.inTime, r.outTime);
      return res.ok ? okVoid(`Added for ${v.weekday}`) : res;
    },
    async quickEdit(ctx, id, v) {
      if (!canTimings(ctx)) return err("Only HR or whoever sets timings changes them", "not_permitted");
      const bad = badTimes(v);
      if (bad) return bad;
      const [r] = await db.select().from(hrmsStaffTimings).where(eq(hrmsStaffTimings.id, id)).limit(1);
      if (!r) return err("That timing no longer exists.", "not_found");
      await db
        .update(hrmsStaffTimings)
        .set({ inTime: v.in, outTime: v.out, updatedAt: new Date(), updatedById: ctx.user.id })
        .where(eq(hrmsStaffTimings.id, id));
      await hrmsAudit(ctx, "hrms.timing.edit", "hrms_staff_timings", id, { in: r.inTime, out: r.outTime }, { in: v.in, out: v.out });
      return okVoid("Timing updated · days already recorded keep the timing they were stamped with");
    },
    async delete(ctx, id) {
      if (!canTimings(ctx)) return err("Only HR or whoever sets timings deletes them", "not_permitted");
      const [r] = await db.select().from(hrmsStaffTimings).where(eq(hrmsStaffTimings.id, id)).limit(1);
      if (!r) return err("That timing no longer exists.", "not_found");
      await db.delete(hrmsStaffTimings).where(eq(hrmsStaffTimings.id, id));
      await hrmsAudit(ctx, "hrms.timing.delete", "hrms_staff_timings", id, r, null);
      return okVoid(`${r.weekday} timing deleted`);
    },
  },
};

/* ============================================================ ASSET STOCK */

type Stock = typeof hrmsAssetStock.$inferSelect;
const CATEGORIES = ["Stationery", "Tangible Assets", "Other"];

async function stockAndAssignments() {
  const [stock, assigned] = await Promise.all([db.select().from(hrmsAssetStock), db.select().from(hrmsAssetAssignments)]);
  return { stock, assigned, ...availability(stock, assigned) };
}

async function assetForm(stock?: Stock): Promise<FormSpec> {
  const [names, officeList] = await Promise.all([refList("Asset names"), offices()]);
  const tangible = { k: "category", eq: "Tangible Assets" };
  return {
    screen: "assetStock",
    id: stock ? "edit" : "new",
    title: stock ? `Edit ${stock.code}` : "Add asset stock",
    sub: "Warranty and images are asked only for tangible assets.",
    submit: "Save stock",
    header: [
      { k: "date", l: "Purchase date", t: "date", req: true },
      pick("name", "Asset name", withCurrent(names, stock?.name), { req: true }),
      { k: "category", l: "Category", t: "select", req: true, opts: CATEGORIES },
      { k: "cost", l: "Purchase cost (₹)", t: "num", req: true, min: 0 },
      { k: "qty", l: "Quantity", t: "num", req: true, min: 1 },
      pick("office", "Location", withCurrent(officeList.map((o) => o.name), stock?.officeName), { req: true }),
      { k: "desc", l: "Description", t: "area" },
      { k: "warranty", l: "Warranty till", t: "date", when: tangible },
      { k: "invoice", l: "Invoice image", t: "photo", when: tangible },
      { k: "image", l: "Asset image", t: "photo", when: tangible },
    ],
    init: stock
      ? {
          date: stock.purchaseDate,
          name: stock.name,
          category: stock.category,
          cost: rupeesField(stock.costPaise),
          qty: String(stock.qty),
          office: stock.officeName ?? "",
          desc: stock.description ?? "",
          warranty: stock.warrantyTill ?? "",
        }
      : { date: today(), category: "Stationery" },
    recordId: stock?.id,
  };
}

async function saveStock(ctx: HrmsContext, h: Values, existing?: Stock) {
  if (!has(ctx, "hr")) return err("Only HR keeps the asset stock", "not_permitted");
  const date = text(h.date);
  if (!date || !DATE.test(date)) return fieldErr("date", "Required");
  const name = text(h.name);
  if (!name) return fieldErr("name", "Required");
  const category = text(h.category);
  if (!category || !CATEGORIES.includes(category)) return fieldErr("category", "Required");
  const cost = paise(h.cost);
  if (cost == null || cost < 0) return fieldErr("cost", cost == null ? "Required" : "INVALID");
  const qty = int(h.qty);
  if (qty == null || qty < 1) return fieldErr("qty", qty == null ? "Required" : "INVALID");
  const office = text(h.office);
  if (!office) return fieldErr("office", "Required");
  const tangible = category === "Tangible Assets";
  if (tangible && text(h.warranty) && !DATE.test(h.warranty)) return fieldErr("warranty", "INVALID");
  const cols = {
    purchaseDate: date,
    name,
    category,
    costPaise: cost,
    qty,
    officeName: office,
    description: text(h.desc),
    warrantyTill: tangible ? text(h.warranty) : null,
  };
  const invoice = tangible ? text(h.invoice) : null;
  const image = tangible ? text(h.image) : null;
  const id = existing?.id ?? hrmsId("hast");
  let code = existing?.code ?? "";
  const res = await inTx(async (tx) => {
    if (existing)
      await tx
        .update(hrmsAssetStock)
        .set({ ...cols, ...(invoice ? { invoiceAttachmentId: invoice } : {}), ...(image ? { imageAttachmentId: image } : {}), updatedAt: new Date(), updatedById: ctx.user.id })
        .where(eq(hrmsAssetStock.id, id));
    else {
      code = `AST-${String(await nextSeries(tx, "asset")).padStart(4, "0")}`;
      await tx.insert(hrmsAssetStock).values({ id, code, ...cols, invoiceAttachmentId: invoice, imageAttachmentId: image, createdById: ctx.user.id });
    }
    await bindHrmsFiles(tx, [invoice, image], "hrms_asset", id, ctx.user.id);
    return okVoid(existing ? `${code} saved` : `${qty} × ${name} added to stock as ${code}`);
  });
  if (res.ok) await hrmsAudit(ctx, existing ? "hrms.asset.edit" : "hrms.asset.add", "hrms_asset_stock", id, existing ?? null, { code, ...cols });
  return res;
}

const assetStock: HrmsScreenModule = {
  key: "assetStock",
  async load(ctx) {
    const { stock, assigned, lot, byName, inUseByName } = await stockAndAssignments();
    const hr = has(ctx, "hr");
    return {
      spec: {
        screen: "assetStock",
        cols: [
          { k: "date", l: "Purchased", t: "d" },
          { k: "code", l: "Code", t: "mono" },
          { k: "name", l: "Asset", t: "b" },
          { k: "category", l: "Category", t: "s" },
          { k: "cost", l: "Cost", t: "m" },
          { k: "qty", l: "Quantity", t: "n" },
          { k: "lot", l: "This lot", t: "n" },
          { k: "available", l: "Available (all lots)", t: "n" },
          { k: "office", l: "Location", t: "t" },
          { k: "warranty", l: "Warranty till", t: "d" },
          { k: "f", l: "", t: "f" },
        ],
        hidden: [],
        groups: ["category"],
        sortDefault: ["date", -1],
        godownKey: "office",
        newForm: hr ? await assetForm() : undefined,
        newLabel: "Add stock",
        noDataLine: "Nothing in stock yet.",
      },
      rows: stock.map((s) => {
        const left = lot.get(s.id) ?? s.qty;
        const n = assigned.filter((a) => a.stockId === s.id).length;
        const contacts: Contact[] = [];
        if (s.invoiceAttachmentId) contacts.push({ l: "Invoice image", href: attHref(s.invoiceAttachmentId) });
        if (s.imageAttachmentId) contacts.push({ l: "Asset image", href: attHref(s.imageAttachmentId) });
        const actions: ActionSpec[] = [
          { id: "edit", l: "Edit", primary: true, loadsForm: true, why: hr ? undefined : "Only HR keeps the asset stock" },
          { id: "assignments", l: "View assignments", href: hrmsLink("assignments", { scope: "all" }) },
        ];
        if (hr) actions.push({ id: "delete", l: "Delete", confirm: `Delete ${s.code}?`, why: n ? `${plural(n, "assignment")} name this lot` : undefined });
        return {
          id: s.id,
          v: {
            date: s.purchaseDate,
            code: s.code,
            name: s.name,
            category: s.category,
            cost: s.costPaise,
            qty: s.qty,
            lot: left,
            available: byName.get(s.name) ?? 0,
            office: s.officeName ?? "",
            warranty: s.warrantyTill ?? "",
          },
          flags: left > 0 ? (left < 2 ? ["lowStock"] : ["inStock"]) : [],
          title: `${s.name} · ${s.code}`,
          header: `${s.qty} bought ${fdShort(s.purchaseDate)} · ${left} left in this lot`,
          fields: [
            { l: "Description", v: s.description ?? "" },
            { l: "Stock of this lot", v: String(left), der: true },
            { l: `Available ${s.name} (all lots)`, v: String(byName.get(s.name) ?? 0), der: true },
            { l: `${s.name} in use`, v: String(inUseByName.get(s.name) ?? 0), der: true },
            { l: "Assignments", v: plural(n, "assignment"), der: true },
          ].filter((f) => f.v !== ""),
          contacts,
          actions,
          by: stampLine(null, s.createdAt),
        };
      }),
    };
  },
  formLoaders: {
    async edit(ctx, id) {
      if (!has(ctx, "hr")) return null;
      const [s] = await db.select().from(hrmsAssetStock).where(eq(hrmsAssetStock.id, id)).limit(1);
      return s ? assetForm(s) : null;
    },
  },
  forms: {
    async new(ctx, h) {
      return saveStock(ctx, h);
    },
    async edit(ctx, h, _l, recordId) {
      const [s] = recordId ? await db.select().from(hrmsAssetStock).where(eq(hrmsAssetStock.id, recordId)).limit(1) : [];
      if (!s) return err("That stock no longer exists.", "not_found");
      return saveStock(ctx, h, s);
    },
  },
  actions: {
    async delete(ctx, id) {
      if (!has(ctx, "hr")) return err("Only HR keeps the asset stock", "not_permitted");
      const [s] = await db.select().from(hrmsAssetStock).where(eq(hrmsAssetStock.id, id)).limit(1);
      if (!s) return err("That stock no longer exists.", "not_found");
      const [used] = await db.select({ id: hrmsAssetAssignments.id }).from(hrmsAssetAssignments).where(eq(hrmsAssetAssignments.stockId, id)).limit(1);
      if (used) return err(`${s.code} has assignments — deleting it would erase who holds it.`, "rule_violation");
      await db.delete(hrmsAssetStock).where(eq(hrmsAssetStock.id, id));
      await hrmsAudit(ctx, "hrms.asset.delete", "hrms_asset_stock", id, s, null);
      return okVoid(`${s.code} deleted`);
    },
  },
};

/* ============================================================ ASSIGNMENTS */

const stockLabel = (s: Stock) => `${s.name} · ${s.code} · ${s.officeName ?? ""}`;

const assignments: HrmsScreenModule = {
  key: "assignments",
  async load(ctx, q) {
    const hr = has(ctx, "hr");
    // HR sees every assignment; everybody else what they hold.
    const options: Scope[] = hr ? ["mine", "all"] : ["mine"];
    const scope: Scope = hr && q.scope !== "mine" ? "all" : "mine";
    const [{ stock, assigned, lot, byName, inUseByName }, people] = await Promise.all([stockAndAssignments(), allPeople()]);
    const pb = byId(people);
    const sb = new Map(stock.map((s) => [s.id, s]));
    const me = ctx.employee?.id;
    const shown = assigned.filter((a) => scope === "all" || a.employeeId === me);
    const available: Record<string, { lot: number; name: number; asset: string }> = {};
    for (const s of stock) available[stockLabel(s)] = { lot: lot.get(s.id) ?? s.qty, name: byName.get(s.name) ?? 0, asset: s.name };
    return {
      spec: {
        screen: "assignments",
        cols: [
          { k: "to", l: "Assigned to", t: "b" },
          { k: "asset", l: "Asset", t: "t" },
          { k: "qty", l: "Qty", t: "n" },
          { k: "restoredQty", l: "Restored", t: "n" },
          { k: "inUse", l: "In use", t: "n" },
          { k: "from", l: "From", t: "t" },
          { k: "date", l: "Date", t: "d" },
          { k: "status", l: "Status", t: "s" },
          { k: "restoredOn", l: "Restored on", t: "d" },
          { k: "f", l: "", t: "f" },
        ],
        hidden: [],
        groups: ["to"],
        chips: "status",
        sortDefault: ["date", -1],
        godownKey: "office",
        newForm: hr
          ? {
              screen: "assignments",
              id: "new",
              title: "Assign an asset",
              sub: "The person signs for it with a photo at hand-over.",
              submit: "Assign asset",
              header: [
                { k: "to", l: "Assign to", t: "select", req: true, opts: people.filter(isActive).map(personOption) },
                { k: "stock", l: "Asset", t: "select", req: true, opts: stock.map(stockLabel) },
                { k: "available", l: "Available", t: "derived", calc: "hrms.asset.available" },
                { k: "qty", l: "Quantity", t: "num", req: true, min: 1 },
                { k: "date", l: "Assigned date", t: "date", req: true },
                { k: "resp", l: "Responsibility & suggestion", t: "area" },
                { k: "photo1", l: "Hand-over photo", t: "photo", hint: "Left empty, the asset’s own image is used." },
                { k: "photo2", l: "Second photo", t: "photo", when: { k: "photo1", notEmpty: true } },
              ],
              data: { available },
              init: { qty: "1", date: today() },
            }
          : undefined,
        newLabel: "Assign asset",
        noDataLine: scope === "all" ? "Nothing has been assigned yet." : "No assets are assigned to you.",
        hrms: { scope: { current: scope, options } },
      },
      rows: shown.map((a) => {
        const s = sb.get(a.stockId);
        const p = pb.get(a.employeeId);
        const contacts: Contact[] = [];
        if (a.photo1Id) contacts.push({ l: "Photo 1", href: attHref(a.photo1Id) });
        if (a.photo2Id) contacts.push({ l: "Photo 2", href: attHref(a.photo2Id) });
        if (a.restoredPhotoId) contacts.push({ l: "Restore photo", href: attHref(a.restoredPhotoId) });
        const actions: ActionSpec[] = [];
        if (a.status === "Assigned")
          actions.push({
            id: "restore",
            l: "Restored asset",
            primary: true,
            why: hr ? undefined : "HR records a return",
            prompt: {
              title: "Restore asset",
              sub: `${s?.name ?? ""} · ${p?.name ?? ""}`,
              submit: "Mark restored",
              init: { date: today(), by: ctx.employee?.name ?? ctx.user.name, qty: String(a.qty) },
              fields: [
                { k: "date", l: "Restored date", t: "date", req: true },
                { k: "by", l: "Restored by", t: "text", req: true },
                { k: "qty", l: "Restored quantity", t: "num", req: true, min: 1, max: a.qty },
                { k: "remark", l: "Restored remark", t: "area", req: true },
                { k: "photo", l: "Restore-time image", t: "photo", req: true },
              ],
            },
          });
        actions.push({ id: "asset", l: "View asset", href: hrmsLink("assetStock", { open: a.stockId }) });
        if (has(ctx, "admin")) actions.push({ id: "delete", l: "Delete", confirm: "Delete this assignment? The quantity goes back into stock." });
        return {
          id: a.id,
          v: {
            to: p?.name ?? "",
            asset: s?.name ?? "",
            qty: a.qty,
            restoredQty: a.restoredQty ?? "",
            inUse: a.qty - (a.restoredQty ?? 0),
            from: a.fromName ?? "",
            date: a.date,
            status: a.status,
            restoredOn: a.restoredOn ?? "",
            office: s?.officeName ?? "",
          },
          flags: a.status === "Assigned" ? ["assigned"] : [],
          title: `${s?.name ?? "Asset"} · ${p?.name ?? ""}`,
          header: `${a.qty} assigned ${fdShort(a.date)}${a.restoredOn ? ` · ${a.restoredQty ?? 0} back ${fdShort(a.restoredOn)}` : ""}`,
          fields: [
            { l: "Asset code", v: s?.code ?? "" },
            { l: "Office", v: s?.officeName ?? "" },
            { l: "Responsibility & suggestion", v: a.responsibility ?? "" },
            { l: "Restored by", v: a.restoredBy ?? "" },
            { l: "Restored quantity", v: a.restoredQty?.toString() ?? "" },
            { l: "Restored remark", v: a.restoredRemark ?? "" },
            { l: `${s?.name ?? "This asset"} in use (company)`, v: String(inUseByName.get(s?.name ?? "") ?? 0), der: true },
          ].filter((f) => f.v !== ""),
          contacts,
          actions,
          by: stampLine(a.fromName, a.createdAt),
        };
      }),
    };
  },
  forms: {
    async new(ctx, h) {
      if (!has(ctx, "hr")) return err("Only HR assigns assets", "not_permitted");
      const p = personFrom(h.to, await allPeople());
      if (!p || !isActive(p)) return fieldErr("to", "invalid Name");
      const { stock, lot } = await stockAndAssignments();
      const s = stock.find((x) => stockLabel(x) === h.stock || x.id === h.stock);
      if (!s) return fieldErr("stock", "Required");
      const qty = int(h.qty);
      if (qty == null || qty < 1) return fieldErr("qty", qty == null ? "Required" : "INVALID");
      const date = text(h.date);
      if (!date || !DATE.test(date)) return fieldErr("date", "Required");
      // Image 1 defaults to the asset's own image (spec §15.2); image 2 only beside a first.
      const photo1 = text(h.photo1) ?? s.imageAttachmentId;
      const photo2 = text(h.photo1) ? text(h.photo2) : null;
      const id = hrmsId("hasg");
      const res = await inTx(async (tx) => {
        await tx.insert(hrmsAssetAssignments).values({
          id,
          stockId: s.id,
          employeeId: p.id,
          fromName: ctx.employee?.name ?? ctx.user.name,
          qty,
          date,
          responsibility: text(h.resp),
          photo1Id: photo1,
          photo2Id: photo2,
          status: "Assigned",
          createdById: ctx.user.id,
        });
        await bindHrmsFiles(tx, [text(h.photo1), photo2], "hrms_asset", id, ctx.user.id);
        return okVoid();
      });
      if (!res.ok) return res;
      await hrmsAudit(ctx, "hrms.asset.assign", "hrms_asset_assignments", id, null, { stock: s.code, to: p.code, qty });
      const left = (lot.get(s.id) ?? s.qty) - qty;
      // A60: allowed, as in the source — but the count is said out loud.
      return left < 0
        ? ok(null, `${qty} × ${s.name} assigned to ${p.name} · this takes ${s.code} to ${left} in stock — check the count`, [`${s.code} is now below zero in stock`])
        : okVoid(`${qty} × ${s.name} assigned to ${p.name}`);
    },
  },
  actions: {
    async restore(ctx, id, v) {
      if (!has(ctx, "hr")) return err("HR records a return", "not_permitted");
      const [a] = await db.select().from(hrmsAssetAssignments).where(eq(hrmsAssetAssignments.id, id)).limit(1);
      if (!a) return err("That assignment no longer exists.", "not_found");
      if (a.status !== "Assigned") return err("Already restored.");
      const date = text(v.date);
      if (!date || !DATE.test(date)) return fieldErr("date", "Required");
      if (date < a.date) return fieldErr("date", "INVALID");
      const by = text(v.by);
      if (!by) return fieldErr("by", "Required");
      const qty = int(v.qty);
      if (qty == null) return fieldErr("qty", "Required");
      if (qty < 1 || qty > a.qty) return fieldErr("qty", "INVALID");
      const remark = text(v.remark);
      if (!remark) return fieldErr("remark", "Required");
      const photo = text(v.photo);
      if (!photo) return fieldErr("photo", "Required");
      const res = await inTx(async (tx) => {
        await tx
          .update(hrmsAssetAssignments)
          .set({ status: "Restored", restoredOn: date, restoredBy: by, restoredQty: qty, restoredRemark: remark, restoredPhotoId: photo, updatedAt: new Date(), updatedById: ctx.user.id })
          .where(eq(hrmsAssetAssignments.id, id));
        await bindHrmsFiles(tx, [photo], "hrms_asset", id, ctx.user.id);
        return okVoid(`${qty} back in stock`);
      });
      if (res.ok) await hrmsAudit(ctx, "hrms.asset.restore", "hrms_asset_assignments", id, { status: a.status }, { status: "Restored", qty, date });
      return res;
    },
    async delete(ctx, id) {
      if (!has(ctx, "admin")) return err("Only admin deletes an assignment", "not_permitted");
      const [a] = await db.select().from(hrmsAssetAssignments).where(eq(hrmsAssetAssignments.id, id)).limit(1);
      if (!a) return err("That assignment no longer exists.", "not_found");
      await db.delete(hrmsAssetAssignments).where(eq(hrmsAssetAssignments.id, id));
      await hrmsAudit(ctx, "hrms.asset.assignmentDelete", "hrms_asset_assignments", id, a, null);
      return okVoid("Assignment deleted");
    },
  },
};

export const PEOPLE_SCREENS: HrmsScreenModule[] = [employeesScreen, idCards, officesScreen, timings, assetStock, assignments];
