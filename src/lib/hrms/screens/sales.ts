import "server-only";
import { and, count, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { customers, hrmsActivities, hrmsCalling, hrmsJourneys, hrmsUserPowers } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { notifyUsers } from "@/lib/notify";
import { recomputeInactivity } from "@/lib/recompute";
import type { ActionSpec, ColSpec, Contact, FieldSpec, FormSpec, ListRow, RowField } from "@/lib/erp/ui";
import { has, type HrmsContext } from "../access";
import {
  err,
  fieldErr,
  first,
  hrmsAudit,
  hrmsId,
  inTx,
  int,
  multi,
  okVoid,
  refuse,
  stampLine,
  text,
  today,
  type HrmsScreenModule,
  type ScreenQuery,
} from "../server";
import { allPeople, byId, isActive, isSales, refList, visibleIds, type Person } from "../services/people";
import {
  CALLING_STATUSES,
  NOT_PICKED,
  ORDER_RECEIVED,
  callingTab,
  checkCall,
  followUpSelection,
  suggestion,
  type SuggestionCfg,
} from "../engines/calling";
import { addDaysISO, fdShort, monthOf } from "../time";
import { hrmsLink } from "../registry";
import { personFrom, personOption, scopeFor } from "./attendance";

/* ---------------------------------------------------------------------------
 * The Sales desk (spec §14): customers, the back-office calling list, sales
 * activity and the journey planner.
 *
 * Customers are MahekOne's own `customers` rows — read and written in place,
 * never copied — so a deactivation asked for here is the same request the
 * CRM's managers see, and a customer closed in the CRM is Deactive here. The
 * calling rules (suggestion, tab, who Take follow-up adds) live in
 * `engines/calling.ts`, so the customer record and the calling list cannot
 * disagree about one customer.
 * ------------------------------------------------------------------------- */

const norm = (s: string | null | undefined) => String(s ?? "").trim().toLowerCase();
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/* -------------------------------------------------------------- configuration */

async function salesCfg(): Promise<{ historyDays: number; activityWindowDays: number; suggestion: SuggestionCfg }> {
  const c = await getConfig();
  return {
    historyDays: c["hrms.calling.historyDays"],
    activityWindowDays: c["hrms.sales.activityWindowDays"],
    suggestion: {
      factor: c["hrms.calling.suggestionFactor"],
      threshold: c["hrms.calling.suggestionThreshold"],
    },
  };
}

/* ------------------------------------------------------------------ customers */

const CUST = {
  id: customers.id,
  externalCode: customers.externalCode,
  name: customers.name,
  phone: customers.phone,
  altPhone: customers.altPhone,
  address: customers.address,
  city: customers.city,
  area: customers.area,
  region: customers.region,
  rating: customers.rating,
  segmentation: customers.segmentation,
  specialInstructions: customers.specialInstructions,
  taggedEmployeeName: customers.taggedEmployeeName,
  salesPersonName: customers.salesPersonName,
  backOfficeAmId: customers.backOfficeAmId,
  backOfficeName: customers.backOfficeName,
  status: customers.status,
  deactivationRequested: customers.deactivationRequested,
  deactivationRequestedById: customers.deactivationRequestedById,
  deactivationRequestedAt: customers.deactivationRequestedAt,
  deactivationReason: customers.deactivationReason,
  gpsLat: customers.gpsLat,
  gpsLng: customers.gpsLng,
  createdAt: customers.createdAt,
};

async function loadCustomers(ids?: string[]) {
  if (ids && !ids.length) return [];
  const q = db.select(CUST).from(customers);
  return ids ? q.where(inArray(customers.id, ids)) : q;
}

type Cust = Awaited<ReturnType<typeof loadCustomers>>[number];

async function oneCustomer(id: string): Promise<Cust | null> {
  const [c] = await loadCustomers([id]);
  return c ?? null;
}

/** The area the calling list groups by: the customer's area, else its city. */
const areaOf = (c: Pick<Cust, "area" | "city">) => (c.area ?? "").trim() || (c.city ?? "").trim();

type CustStatus = "Active" | "Pending deactivation" | "Deactive";

/** Deactive for a closed or quiet account; Pending while a request is open on a live one. */
function statusOf(c: Pick<Cust, "status" | "deactivationRequested">): CustStatus {
  if (c.status !== "active") return "Deactive";
  return c.deactivationRequested ? "Pending deactivation" : "Active";
}

/** "Me" as the back office: the linked account, or my name where the seat holds a name with no login. */
function backOfficeIsMe(ctx: HrmsContext, c: Pick<Cust, "backOfficeAmId" | "backOfficeName">): boolean {
  if (c.backOfficeAmId && c.backOfficeAmId === ctx.user.id) return true;
  return !!ctx.employee && !!c.backOfficeName && norm(c.backOfficeName) === norm(ctx.employee.name);
}

/** How a customer reads in a picker: its name and a code that tells two namesakes apart. */
const custOption = (c: Pick<Cust, "id" | "name" | "externalCode">) => `${c.name} · ${c.externalCode || c.id}`;

function custFrom(v: string | undefined, list: Cust[]): Cust | undefined {
  const code = String(v ?? "").split(" · ").pop() ?? "";
  return list.find((c) => c.externalCode === code || c.id === code) ?? list.find((c) => c.name === v);
}

type Stats = { calls: Map<string, number>; orders: Map<string, number>; acts: Map<string, number>; mood: Map<string, string> };

/** Calls, orders and activities per customer, and the latest activity mood (the calling grade, A31). */
async function customerStats(): Promise<Stats> {
  const [callRows, actRows, moods] = await Promise.all([
    db
      .select({
        customerId: hrmsCalling.customerId,
        calls: count(),
        orders: sql<number>`count(*) filter (where ${hrmsCalling.status} = ${ORDER_RECEIVED})`,
      })
      .from(hrmsCalling)
      .groupBy(hrmsCalling.customerId),
    db
      .select({ customerId: hrmsActivities.customerId, n: count() })
      .from(hrmsActivities)
      .where(isNotNull(hrmsActivities.customerId))
      .groupBy(hrmsActivities.customerId),
    db
      .select({ customerId: hrmsActivities.customerId, mood: hrmsActivities.mood })
      .from(hrmsActivities)
      .where(and(isNotNull(hrmsActivities.customerId), isNotNull(hrmsActivities.mood)))
      .orderBy(desc(hrmsActivities.date), desc(hrmsActivities.createdAt)),
  ]);
  const mood = new Map<string, string>();
  for (const m of moods) if (m.customerId && m.mood && !mood.has(m.customerId)) mood.set(m.customerId, m.mood);
  const acts = new Map<string, number>();
  for (const r of actRows) if (r.customerId) acts.set(r.customerId, Number(r.n));
  return {
    calls: new Map(callRows.map((r) => [r.customerId, Number(r.calls)])),
    /* A count arrives from raw SQL as text; Number() before anything adds it. */
    orders: new Map(callRows.map((r) => [r.customerId, Number(r.orders)])),
    acts,
    mood,
  };
}

/** Customer ids already in a calling row today, and those still waiting on a never-called row. */
async function callingToday(): Promise<{ today: Set<string>; open: Set<string> }> {
  const t = today();
  const rows = await db.select({ customerId: hrmsCalling.customerId, date: hrmsCalling.date, status: hrmsCalling.status }).from(hrmsCalling);
  return {
    today: new Set(rows.filter((r) => r.date === t).map((r) => r.customerId)),
    open: new Set(rows.filter((r) => !r.status.trim()).map((r) => r.customerId)),
  };
}

function phoneContacts(c: Pick<Cust, "phone" | "altPhone" | "address" | "gpsLat" | "gpsLng">): Contact[] {
  const out: Contact[] = [];
  const tel = (s: string) => s.replace(/[^\d+]/g, "");
  for (const p of [c.phone, c.altPhone]) {
    if (!p?.trim()) continue;
    out.push({ l: `Call ${p}`, href: `tel:${tel(p)}` });
    out.push({ l: `Message ${p}`, href: `sms:${tel(p)}` });
  }
  if (c.gpsLat != null && c.gpsLng != null) out.push({ l: "View map", href: `https://maps.google.com/?q=${c.gpsLat},${c.gpsLng}` });
  else if (c.address?.trim()) out.push({ l: "View map", href: `https://maps.google.com/?q=${encodeURIComponent(c.address)}` });
  return out;
}

const CUSTOMER_COLS: ColSpec[] = [
  { k: "name", l: "Customer", t: "b" },
  { k: "area", l: "Area", t: "t" },
  { k: "mobile", l: "Mobile", t: "ph" },
  { k: "rating", l: "Rating", t: "s" },
  { k: "segment", l: "Segment", t: "t" },
  { k: "salesPerson", l: "Sales person", t: "t" },
  { k: "backOffice", l: "Back office", t: "t" },
  { k: "status", l: "Status", t: "s" },
  { k: "orders", l: "Total orders", t: "n" },
  { k: "f", l: "Flags", t: "f" },
];

const RATINGS = ["High Value", "Medium Value", "Low Value"];

function customerActions(ctx: HrmsContext, c: Cust, st: CustStatus, calledToday: boolean): ActionSpec[] {
  const a: ActionSpec[] = [];
  const decide = has(ctx, "custStatus");
  if (st === "Active" && backOfficeIsMe(ctx, c))
    a.push({
      id: "takeFollowUp",
      l: "Take follow-up",
      primary: true,
      why: !ctx.employee ? "Your account is not linked to an employee record yet" : calledToday ? "Already on a calling list today" : undefined,
      confirm: `Add your active customers in ${areaOf(c) || "this area"} to your calling list?`,
    });
  if (st === "Active")
    a.push({
      id: "requestDeactivation",
      l: "Deactivation request",
      prompt: { title: "Request deactivation", sub: c.name, submit: "Send request", fields: [{ k: "reason", l: "Write Deactivation Reason", t: "area", req: !decide }] },
    });
  if (st === "Pending deactivation") {
    const mayWithdraw = decide || c.deactivationRequestedById === ctx.user.id || backOfficeIsMe(ctx, c);
    a.push({ id: "withdrawRequest", l: "Withdraw request", why: mayWithdraw ? undefined : "Only who asked, the back office or admin withdraws it" });
    const why = decide ? undefined : "Only admin decides deactivations";
    a.push({
      id: "acceptDeactivation",
      l: "Accept",
      primary: true,
      why,
      prompt: { title: "Accept deactivation", sub: c.name, submit: "Deactivate customer", fields: [{ k: "remark", l: "Remark", t: "text" }] },
    });
    a.push({
      id: "rejectDeactivation",
      l: "Reject",
      why,
      prompt: { title: "Reject deactivation", sub: c.name, submit: "Keep active", fields: [{ k: "remark", l: "Remark", t: "area", req: true }] },
    });
  }
  if (st === "Deactive")
    a.push({
      id: "makeActive",
      l: "Make active again",
      why: !decide ? "Only admin reactivates a customer" : c.status === "inactive" ? "Inactive because they stopped buying — their next order brings them back" : undefined,
      confirm: `Make ${c.name} active again?`,
    });
  if (has(ctx, "salesAll")) a.push({ id: "edit", l: "Edit", loadsForm: true });
  return a;
}

function customerRow(ctx: HrmsContext, c: Cust, stats: Stats, called: Set<string>, sug: SuggestionCfg): ListRow {
  const st = statusOf(c);
  const calls = stats.calls.get(c.id) ?? 0;
  const acts = stats.acts.get(c.id) ?? 0;
  const orders = stats.orders.get(c.id) ?? 0;
  const fields: RowField[] = [
    { l: "Address", v: c.address ?? "" },
    { l: "Alternate mobile", v: c.altPhone ?? "" },
    { l: "State", v: c.region ?? "" },
    { l: "Tagged employee", v: c.taggedEmployeeName ?? "" },
    { l: "Special instructions", v: c.specialInstructions ?? "" },
    { l: "Deactivation request", v: c.deactivationRequested ? "Deactivation Request Received" : "" },
    { l: "Deactivation remark", v: c.deactivationReason ?? "" },
    { l: "Calls", v: `${calls} call${calls === 1 ? "" : "s"}`, der: true },
    { l: "Sales activities", v: `${acts} activit${acts === 1 ? "y" : "ies"}`, der: true },
    { l: "Suggestion", v: suggestion(calls, orders, sug), der: true },
  ];
  const contacts = phoneContacts(c);
  return {
    id: c.id,
    v: {
      name: c.name,
      area: areaOf(c),
      mobile: c.phone,
      rating: c.rating ?? "",
      segment: c.segmentation ?? "",
      salesPerson: c.salesPersonName ?? "",
      backOffice: c.backOfficeName ?? "",
      status: st,
      orders,
    },
    flags: st === "Pending deactivation" ? ["deactReq"] : [],
    title: c.name,
    header: [areaOf(c), c.phone, st].filter(Boolean).join(" · "),
    fields,
    contacts,
    actions: customerActions(ctx, c, st, called.has(c.id)),
    by: stampLine(null, c.createdAt),
  };
}

/** Whose customers a person sees on the desk: everybody, or those naming someone in their scope. */
function nameScope(ctx: HrmsContext, ids: Set<string> | null, people: Person[]): ((c: Cust) => boolean) | null {
  if (!ids) return null;
  const names = new Set(people.filter((p) => ids.has(p.id)).map((p) => norm(p.name)));
  return (c) =>
    backOfficeIsMe(ctx, c) || names.has(norm(c.backOfficeName)) || names.has(norm(c.salesPersonName)) || names.has(norm(c.taggedEmployeeName));
}

/** Holders of the power to decide deactivations — told when one is asked for. */
async function deciders(): Promise<string[]> {
  const rows = await db.select({ userId: hrmsUserPowers.userId }).from(hrmsUserPowers).where(eq(hrmsUserPowers.power, "custStatus"));
  return [...new Set(rows.map((r) => r.userId))];
}

async function editCustomerForm(c: Cust): Promise<FormSpec> {
  const [segments, people] = await Promise.all([refList("Customer segmentation"), allPeople()]);
  const sales = people.filter((p) => isActive(p) && isSales(p) && !p.dateOfLeaving).map((p) => p.name);
  return {
    screen: "customers",
    id: "edit",
    title: "Edit customer",
    sub: `${c.name} · the Sales desk’s own fields. Who sells to and who back-offices a customer is changed where accounts reassign it.`,
    submit: "Save customer",
    recordId: c.id,
    init: {
      rating: c.rating ?? "",
      segmentation: c.segmentation ?? "",
      tagged: c.taggedEmployeeName ?? "",
      instr: c.specialInstructions ?? "",
    },
    header: [
      { k: "rating", l: "Rating", t: "select", opts: RATINGS },
      { k: "segmentation", l: "Segmentation", t: "select", opts: segments },
      { k: "tagged", l: "Tagged employee", t: "select", opts: sales, hint: "Active sales staff with no date of leaving." },
      { k: "instr", l: "Special instructions", t: "area" },
    ],
  };
}

const NOT_LINKED = "Your account is not linked to an employee record yet. Ask HR to link it on the Access screen.";

const customersScreen: HrmsScreenModule = {
  key: "customers",
  async load(ctx, q) {
    const [people, cfg] = await Promise.all([allPeople(), salesCfg()]);
    const { scope, options } = scopeFor(ctx, q, "salesAll");
    const inScope = nameScope(ctx, visibleIds(ctx, scope, people), people);
    const decide = has(ctx, "custStatus");
    const [all, stats, called] = await Promise.all([loadCustomers(), customerStats(), callingToday()]);
    /* Deactive customers are a decider's tab in the source (Deactive
       Customers, admin); everybody else works the live book. */
    const rows = all.filter((c) => (!inScope || inScope(c)) && (decide || statusOf(c) !== "Deactive"));
    return {
      spec: {
        screen: "customers",
        cols: decide ? CUSTOMER_COLS : CUSTOMER_COLS.filter((c) => c.k !== "status"),
        hidden: decide ? [] : [{ l: "Status", power: "custStatus" }],
        groups: ["area"],
        chips: "status",
        sortDefault: ["name", 1],
        noDataLine: scope === "all" ? "No customers yet." : "No customer names you as their back office, sales person or tagged employee.",
        hrms: { scope: { current: scope, options } },
      },
      rows: rows.map((c) => customerRow(ctx, c, stats, called.today, cfg.suggestion)),
    };
  },
  actions: {
    async takeFollowUp(ctx, id) {
      const me = ctx.employee;
      if (!me) return err(NOT_LINKED, "not_permitted");
      const c = await oneCustomer(id);
      if (!c) return err("That customer no longer exists.", "not_found");
      if (!backOfficeIsMe(ctx, c)) return err("Only the back office of this customer takes its follow-up.", "not_permitted");
      if (statusOf(c) !== "Active") return err("Only an active customer is followed up.");
      const area = areaOf(c);
      const t = today();
      const res = await inTx(async (tx) => {
        const [all, called] = await Promise.all([loadCustomers(), callingToday()]);
        const pick = followUpSelection(
          area,
          all.map((x) => ({ id: x.id, area: areaOf(x), active: statusOf(x) === "Active", mine: backOfficeIsMe(ctx, x) })),
          called.today,
          called.open,
        );
        if (!pick.length) return refuse(err(`Every customer of yours in ${area} is already on a calling list.`));
        await tx.insert(hrmsCalling).values(pick.map((customerId) => ({ id: hrmsId("hcall"), customerId, employeeId: me.id, date: t, createdById: ctx.user.id })));
        return okVoid(`${pick.length} customer${pick.length === 1 ? "" : "s"} in ${area} added to your calling list`);
      });
      if (res.ok) await hrmsAudit(ctx, "hrms.calling.takeFollowUp", "customer", id, null, { area });
      return res;
    },
    async requestDeactivation(ctx, id, v) {
      const c = await oneCustomer(id);
      if (!c) return err("That customer no longer exists.", "not_found");
      if (statusOf(c) !== "Active") return err("Only an active customer with no pending request can be put forward.");
      const reason = text(v.reason);
      if (!reason && !has(ctx, "custStatus")) return fieldErr("reason", "Write Deactivation Reason");
      /* The CRM's own request columns, so its managers' pending list and this
         one are one queue. `requestDeactivation` in actions/crm.ts cannot be
         called: it gates on the CRM book, which a back-office person on HRMS
         need not hold. */
      await db
        .update(customers)
        .set({
          deactivationRequested: true,
          deactivationReason: reason ?? "Requested from HRMS",
          deactivationRequestedById: ctx.user.id,
          deactivationRequestedAt: new Date(),
          updatedAt: new Date(),
          updatedById: ctx.user.id,
        })
        .where(eq(customers.id, id));
      await hrmsAudit(ctx, "hrms.customer.deactivationRequest", "customer", id, { deactivationRequested: false }, { deactivationRequested: true, reason });
      const to = (await deciders()).filter((u) => u !== ctx.user.id);
      await notifyUsers(
        to.map((userId) => ({
          userId,
          title: "Deactivation requested",
          body: `${ctx.user.name} asked to deactivate ${c.name}${reason ? `: ${reason}` : ""}`,
          kind: "warn",
          href: hrmsLink("customers", { open: id }),
        })),
      );
      return okVoid("Deactivation requested · admin decides");
    },
    async withdrawRequest(ctx, id) {
      const c = await oneCustomer(id);
      if (!c) return err("That customer no longer exists.", "not_found");
      if (!c.deactivationRequested) return err("There is no request to withdraw.");
      if (!(has(ctx, "custStatus") || c.deactivationRequestedById === ctx.user.id || backOfficeIsMe(ctx, c)))
        return err("Only who asked, the back office or admin withdraws it", "not_permitted");
      await db
        .update(customers)
        .set({
          deactivationRequested: false,
          deactivationReason: null,
          deactivationRequestedById: null,
          deactivationRequestedAt: null,
          updatedAt: new Date(),
          updatedById: ctx.user.id,
        })
        .where(eq(customers.id, id));
      await hrmsAudit(ctx, "hrms.customer.deactivationWithdraw", "customer", id, { reason: c.deactivationReason }, null);
      return okVoid("Request withdrawn");
    },
    async acceptDeactivation(ctx, id, v) {
      if (!has(ctx, "custStatus")) return err("Only admin decides deactivations", "not_permitted");
      const c = await oneCustomer(id);
      if (!c) return err("That customer no longer exists.", "not_found");
      if (!c.deactivationRequested) return err("There is no pending request on this customer.");
      const reason = text(v.remark) ?? c.deactivationReason ?? `Accepted by ${ctx.user.name}`;
      /* The same write as the CRM's `decideDeactivation`: a status a person
         decided, which the party sheet may no longer restate. */
      await db
        .update(customers)
        .set({
          status: "deactivated",
          deactivatedAt: new Date(),
          deactivatedById: ctx.user.id,
          deactivationReason: reason,
          deactivationRequested: false,
          statusDecidedAt: new Date(),
          updatedAt: new Date(),
          updatedById: ctx.user.id,
        })
        .where(eq(customers.id, id));
      await hrmsAudit(ctx, "hrms.customer.deactivate", "customer", id, { status: c.status }, { status: "deactivated", reason });
      await recomputeInactivity(id);
      if (c.deactivationRequestedById && c.deactivationRequestedById !== ctx.user.id)
        await notifyUsers([{ userId: c.deactivationRequestedById, title: "Deactivation accepted", body: `${c.name} is deactivated.`, href: hrmsLink("customers", { open: id }) }]);
      return okVoid(`${c.name} deactivated`);
    },
    async rejectDeactivation(ctx, id, v) {
      if (!has(ctx, "custStatus")) return err("Only admin decides deactivations", "not_permitted");
      const remark = text(v.remark);
      if (!remark) return fieldErr("remark", "Remark is required");
      const c = await oneCustomer(id);
      if (!c) return err("That customer no longer exists.", "not_found");
      if (!c.deactivationRequested) return err("There is no pending request on this customer.");
      await db
        .update(customers)
        .set({ deactivationRequested: false, deactivationReason: null, updatedAt: new Date(), updatedById: ctx.user.id })
        .where(eq(customers.id, id));
      await hrmsAudit(ctx, "hrms.customer.deactivationReject", "customer", id, { reason: c.deactivationReason }, { remark });
      if (c.deactivationRequestedById && c.deactivationRequestedById !== ctx.user.id)
        await notifyUsers([
          { userId: c.deactivationRequestedById, title: "Deactivation rejected", body: `${c.name} stays active: ${remark}`, kind: "warn", href: hrmsLink("customers", { open: id }) },
        ]);
      return okVoid("Kept active");
    },
    async makeActive(ctx, id) {
      if (!has(ctx, "custStatus")) return err("Only admin reactivates a customer", "not_permitted");
      const c = await oneCustomer(id);
      if (!c) return err("That customer no longer exists.", "not_found");
      /* `inactive` is derived from buying and rebuilt nightly; setting it
         active by hand would be undone. Only a decided closure is reversed. */
      if (c.status !== "deactivated")
        return err(c.status === "active" ? "That customer is already active." : "Inactive because they stopped buying — their next order brings them back");
      /* The CRM's `decideReactivation` write: the closure's fields cleared and
         the decision marked, so the sheet does not close it again. */
      await db
        .update(customers)
        .set({
          status: "active",
          deactivatedAt: null,
          deactivatedById: null,
          deactivationReason: null,
          deactivationRequested: false,
          reactivationRequested: false,
          reactivationReason: null,
          statusDecidedAt: new Date(),
          updatedAt: new Date(),
          updatedById: ctx.user.id,
        })
        .where(eq(customers.id, id));
      await hrmsAudit(ctx, "hrms.customer.reactivate", "customer", id, { status: c.status, reason: c.deactivationReason }, { status: "active" });
      /* A customer quiet for months goes straight onto the inactive watch
         rather than reading as freshly active — the CRM's rule. */
      await recomputeInactivity(id);
      return okVoid(`${c.name} is active again`);
    },
  },
  formLoaders: {
    async edit(ctx, id) {
      if (!has(ctx, "salesAll")) return null;
      const c = await oneCustomer(id);
      return c ? editCustomerForm(c) : null;
    },
  },
  forms: {
    async edit(ctx, h, _lines, recordId) {
      if (!has(ctx, "salesAll")) return err("Editing customers needs the Sales desk for everyone.", "not_permitted");
      const c = recordId ? await oneCustomer(recordId) : null;
      if (!c) return err("That customer no longer exists.", "not_found");
      const rating = text(h.rating);
      if (rating && !RATINGS.includes(rating)) return fieldErr("rating", "INVALID");
      const after = { rating, segmentation: text(h.segmentation), taggedEmployeeName: text(h.tagged), specialInstructions: text(h.instr) };
      await db
        .update(customers)
        .set({ ...after, updatedAt: new Date(), updatedById: ctx.user.id })
        .where(eq(customers.id, c.id));
      await hrmsAudit(
        ctx,
        "hrms.customer.edit",
        "customer",
        c.id,
        { rating: c.rating, segmentation: c.segmentation, taggedEmployeeName: c.taggedEmployeeName, specialInstructions: c.specialInstructions },
        after,
      );
      return okVoid(`${c.name} saved`);
    },
  },
};

/* -------------------------------------------------------------------- calling */

const CALLING_COLS: ColSpec[] = [
  { k: "date", l: "Calling date", t: "d" },
  { k: "customer", l: "Customer", t: "b" },
  { k: "grade", l: "Grade", t: "s" },
  { k: "mobile", l: "Mobile", t: "ph" },
  { k: "area", l: "Area", t: "t" },
  { k: "salesPerson", l: "Sales person", t: "t" },
  { k: "status", l: "Status", t: "s" },
  { k: "second", l: "Second status", t: "t" },
  { k: "note", l: "Discussion", t: "t" },
  { k: "followUp", l: "Follow-up", t: "d" },
  { k: "orders", l: "Orders", t: "n" },
  { k: "suggestion", l: "Suggestion", t: "t" },
  { k: "f", l: "Flags", t: "f" },
];

const callingScreen: HrmsScreenModule = {
  key: "calling",
  async load(ctx, q) {
    const cfg = await salesCfg();
    const t = today();
    const people = await allPeople();
    const { scope, options } = scopeFor(ctx, q, "salesAll");
    const ids = visibleIds(ctx, scope, people);
    const rows = !ids
      ? await db.select().from(hrmsCalling)
      : ids.size
        ? await db.select().from(hrmsCalling).where(inArray(hrmsCalling.employeeId, [...ids]))
        : [];
    const [custs, stats] = await Promise.all([loadCustomers([...new Set(rows.map((r) => r.customerId))]), customerStats()]);
    const cb = new Map(custs.map((c) => [c.id, c]));
    const pb = byId(people);
    return {
      spec: {
        screen: "calling",
        cols: CALLING_COLS,
        hidden: [],
        chips: "tab",
        sortDefault: ["date", -1],
        noDataLine: "Nothing on your calling list. Open a customer you back-office and Take follow-up to fill it.",
        hrms: { scope: { current: scope, options } },
      },
      rows: rows.map((r): ListRow => {
        const c = cb.get(r.customerId);
        const calls = stats.calls.get(r.customerId) ?? 0;
        const orders = stats.orders.get(r.customerId) ?? 0;
        const tab = callingTab({ date: r.date, status: r.status, secondStatus: r.secondStatus, followUp: r.followUp }, t, cfg.historyDays);
        const caller = pb.get(r.employeeId)?.name ?? "";
        const sug = suggestion(calls, orders, cfg.suggestion);
        const grade = stats.mood.get(r.customerId) ?? "";
        const mine = r.employeeId === ctx.employee?.id;
        const actions: ActionSpec[] = [
          {
            id: "logCall",
            l: "Log call",
            primary: true,
            why: mine || has(ctx, "admin") ? undefined : "Only the caller logs this call",
            prompt: {
              title: "Log call",
              sub: `${c?.name ?? ""} · ${c?.phone ?? ""}`,
              submit: "Save call",
              init: { status: r.status, second: r.secondStatus ?? "", note: r.note ?? "", followUp: r.followUp ?? "" },
              fields: [
                { k: "status", l: "Calling status", t: "select", req: true, opts: [...CALLING_STATUSES] },
                { k: "second", l: "2nd calling status", t: "select", req: true, opts: [...CALLING_STATUSES], when: { k: "status", eq: NOT_PICKED } },
                { k: "note", l: "Discussion note", t: "area", mic: true },
                { k: "followUp", l: "Follow-up date", t: "date", hint: "Not in the past." },
              ],
            },
          },
          { id: "customer", l: "View customer", href: hrmsLink("customers", { open: r.customerId }) },
          { id: "delete", l: "Delete", why: has(ctx, "custStatus") ? undefined : "Only admin deletes a calling row", confirm: "Delete this calling row? It cannot be undone." },
        ];
        return {
          id: r.id,
          v: {
            date: r.date,
            customer: c?.name ?? "",
            grade,
            mobile: c?.phone ?? "",
            area: c ? areaOf(c) : "",
            salesPerson: c?.salesPersonName ?? "",
            status: r.status,
            second: r.secondStatus ?? "",
            note: r.note ?? "",
            followUp: r.followUp ?? "",
            orders,
            suggestion: sug,
            tab,
          },
          flags: r.status === NOT_PICKED && !(r.secondStatus ?? "").trim() ? ["secondCall"] : [],
          title: c?.name ?? "",
          header: `${fdShort(r.date)} · ${r.status || "To call"}${scope === "mine" ? "" : ` · ${caller}`}`,
          fields: [
            { l: "Special instruction", v: c?.specialInstructions ?? "" },
            { l: "Grade", v: grade || "No activity mood yet", der: true },
            { l: "Calls not picked up", v: String(r.misses) },
            { l: "Total customer orders", v: String(orders), der: true },
            { l: "Calls to this customer", v: String(calls), der: true },
            { l: "Suggestion", v: sug, der: true },
            { l: "Caller", v: caller },
          ],
          contacts: c ? phoneContacts(c) : [],
          actions,
          by: stampLine(caller, r.updatedAt ?? r.createdAt),
        };
      }),
    };
  },
  actions: {
    async logCall(ctx, id, v) {
      const [r] = await db.select().from(hrmsCalling).where(eq(hrmsCalling.id, id));
      if (!r) return err("That calling row no longer exists.", "not_found");
      if (!(r.employeeId === ctx.employee?.id || has(ctx, "admin"))) return err("Only the caller logs this call", "not_permitted");
      const t = today();
      const status = String(v.status ?? "").trim();
      const second = status === NOT_PICKED ? String(v.second ?? "").trim() : "";
      const followUp = text(v.followUp) ?? "";
      const bad = checkCall({ status, second, followUp }, t);
      if (bad) return fieldErr(bad.field, bad.message);
      await db
        .update(hrmsCalling)
        .set({
          status,
          secondStatus: second || null,
          note: text(v.note),
          followUp: followUp || null,
          date: t,
          misses: r.misses + (status === NOT_PICKED ? 1 : 0),
          updatedAt: new Date(),
          updatedById: ctx.user.id,
        })
        .where(eq(hrmsCalling.id, id));
      await hrmsAudit(ctx, "hrms.calling.log", "hrms_calling", id, { status: r.status, secondStatus: r.secondStatus }, { status, secondStatus: second || null, followUp });
      return okVoid(`Call logged · ${status}${followUp ? ` · follow-up ${fdShort(followUp)}` : ""}`);
    },
    async delete(ctx, id) {
      if (!has(ctx, "custStatus")) return err("Only admin deletes a calling row", "not_permitted");
      const [r] = await db.select().from(hrmsCalling).where(eq(hrmsCalling.id, id));
      if (!r) return err("That calling row no longer exists.", "not_found");
      await db.delete(hrmsCalling).where(eq(hrmsCalling.id, id));
      await hrmsAudit(ctx, "hrms.calling.delete", "hrms_calling", id, r, null);
      return okVoid("Calling row deleted");
    },
  },
};

/* ---------------------------------------------------------------- sales activity */

const ACTIVITY_COLS: ColSpec[] = [
  { k: "date", l: "Date", t: "d" },
  { k: "emp", l: "Salesman", t: "t" },
  { k: "customer", l: "Customer", t: "b" },
  { k: "note", l: "Meeting note", t: "t" },
  { k: "minutes", l: "Minutes", t: "n" },
  { k: "mood", l: "Mood", t: "s" },
  { k: "issue", l: "Issue", t: "t" },
  { k: "reminder", l: "Reminder", t: "d" },
  { k: "meetType", l: "Type", t: "t" },
  { k: "purpose", l: "Purpose", t: "t" },
];

/** Who an activity may be logged for: active sales staff with the desk for everyone, else myself. */
function activityPeople(ctx: HrmsContext, people: Person[]): Person[] {
  if (has(ctx, "salesAll")) return people.filter((p) => isActive(p) && isSales(p) && !p.dateOfLeaving);
  return people.filter((p) => p.id === ctx.employee?.id);
}

const mayEditActivity = (ctx: HrmsContext, employeeId: string) => employeeId === ctx.employee?.id || has(ctx, "salesAll");

async function activityForm(ctx: HrmsContext, init?: Record<string, string>, recordId?: string): Promise<FormSpec | undefined> {
  if (!ctx.employee && !has(ctx, "salesAll")) return undefined;
  const [people, custs, issues, moods, types, purposes] = await Promise.all([
    allPeople(),
    loadCustomers(),
    refList("Activity issues"),
    refList("Moods"),
    refList("Meeting types"),
    refList("Meeting purposes"),
  ]);
  const me = people.find((p) => p.id === ctx.employee?.id);
  const header: FieldSpec[] = [{ k: "date", l: "Date", t: "date", req: true }];
  if (has(ctx, "salesAll"))
    header.push({ k: "emp", l: "Salesman", t: "select", req: true, opts: activityPeople(ctx, people).map(personOption), hint: "Active sales staff with no date of leaving." });
  header.push(
    { k: "customer", l: "Customer", t: "select", req: true, opts: custs.filter((c) => statusOf(c) !== "Deactive").map(custOption) },
    { k: "note", l: "Meeting note", t: "area", req: true, mic: true },
    { k: "minutes", l: "Time given (minutes)", t: "num", req: true, min: 1 },
    { k: "mood", l: "Mood", t: "select", opts: moods.length ? moods : ["Happy", "Normal"] },
    { k: "issue", l: "Issue", t: "select", opts: issues },
    { k: "reminder", l: "Reminder date", t: "date" },
    { k: "meetType", l: "Meeting type", t: "select", opts: types },
    { k: "purpose", l: "Purpose", t: "select", opts: purposes },
  );
  return {
    screen: "activity",
    id: "activity",
    title: recordId ? "Edit sales activity" : "Log sales activity",
    sub: "A meeting or call with a customer.",
    submit: "Save activity",
    recordId,
    init: init ?? { date: today(), emp: me ? personOption(me) : "" },
    header,
  };
}

async function activityFrom(q: ScreenQuery): Promise<string> {
  if (q.from && ISO.test(q.from)) return q.from;
  const cfg = await salesCfg();
  return addDaysISO(today(), -cfg.activityWindowDays);
}

const activityScreen: HrmsScreenModule = {
  key: "activity",
  async load(ctx, q) {
    const people = await allPeople();
    const { scope, options } = scopeFor(ctx, q, "salesAll");
    const ids = visibleIds(ctx, scope, people);
    const from = await activityFrom(q);
    const rows =
      ids && !ids.size
        ? []
        : await db
            .select()
            .from(hrmsActivities)
            .where(and(gte(hrmsActivities.date, from), ids ? inArray(hrmsActivities.employeeId, [...ids]) : undefined));
    const pb = byId(people);
    const custs = await loadCustomers([...new Set(rows.map((r) => r.customerId).filter((x): x is string => !!x))]);
    const cb = new Map(custs.map((c) => [c.id, c]));
    const mayDelete = has(ctx, "admin") || has(ctx, "hr");
    return {
      spec: {
        screen: "activity",
        cols: ACTIVITY_COLS,
        hidden: [],
        groups: ["area", "customer"],
        agg: { k: "minutes", l: "minutes given" },
        sortDefault: ["date", -1],
        newForm: await activityForm(ctx),
        newLabel: "Log activity",
        noDataLine: "No sales activity in this window yet.",
        hrms: {
          scope: { current: scope, options },
          period: { label: "", params: [{ k: "from", l: "From", v: from, type: "date" }] },
        },
      },
      rows: rows.map((r): ListRow => {
        const c = r.customerId ? cb.get(r.customerId) : undefined;
        const emp = pb.get(r.employeeId)?.name ?? "";
        const name = c?.name ?? r.customerName ?? "";
        const area = r.area ?? (c ? areaOf(c) : "");
        const actions: ActionSpec[] = [
          { id: "edit", l: "Edit", loadsForm: true, why: mayEditActivity(ctx, r.employeeId) ? undefined : "Only who logged it, or the Sales desk for everyone, edits it" },
        ];
        if (r.customerId) actions.push({ id: "customer", l: "View customer", href: hrmsLink("customers", { open: r.customerId }) });
        actions.push({ id: "delete", l: "Delete", why: mayDelete ? undefined : "Only admin or HR deletes an activity", confirm: "Delete this activity? It cannot be undone." });
        return {
          id: r.id,
          v: {
            date: r.date,
            emp,
            customer: name,
            note: r.note ?? "",
            minutes: r.minutes,
            mood: r.mood ?? "",
            issue: r.issue ?? "",
            reminder: r.reminder ?? "",
            meetType: r.meetType ?? "",
            purpose: r.purpose ?? "",
            area,
          },
          flags: r.employeeId === ctx.employee?.id ? ["mine"] : [],
          title: name,
          header: `${fdShort(r.date)} · ${emp} · ${r.minutes} min`,
          fields: [
            { l: "Area", v: area, der: true },
            { l: "Meeting note", v: r.note ?? "" },
          ],
          contacts: c ? phoneContacts(c) : [],
          actions,
          by: stampLine(emp, r.createdAt),
        };
      }),
    };
  },
  formLoaders: {
    async edit(ctx, id) {
      const [r] = await db.select().from(hrmsActivities).where(eq(hrmsActivities.id, id));
      if (!r || !mayEditActivity(ctx, r.employeeId)) return null;
      const people = await allPeople();
      const p = people.find((x) => x.id === r.employeeId);
      const c = r.customerId ? await oneCustomer(r.customerId) : null;
      const form = await activityForm(
        ctx,
        {
          date: r.date,
          emp: p ? personOption(p) : "",
          customer: c ? custOption(c) : "",
          note: r.note ?? "",
          minutes: String(r.minutes),
          mood: r.mood ?? "",
          issue: r.issue ?? "",
          reminder: r.reminder ?? "",
          meetType: r.meetType ?? "",
          purpose: r.purpose ?? "",
        },
        r.id,
      );
      return form ?? null;
    },
  },
  forms: {
    async activity(ctx, h, _lines, recordId) {
      const people = await allPeople();
      let emp: Person | undefined;
      if (has(ctx, "salesAll")) {
        emp = personFrom(h.emp, activityPeople(ctx, people));
        if (!emp) return fieldErr("emp", "invalid Name");
      } else {
        emp = people.find((p) => p.id === ctx.employee?.id);
        if (!emp) return err(NOT_LINKED, "not_permitted");
      }
      const date = text(h.date);
      if (!date || !ISO.test(date)) return fieldErr("date", "INVALID");
      const c = custFrom(h.customer, await loadCustomers());
      if (!c || statusOf(c) === "Deactive") return fieldErr("customer", "Choose an active customer");
      const note = text(h.note);
      if (!note) return fieldErr("note", "Meeting note is required");
      const minutes = int(h.minutes);
      if (minutes == null || minutes <= 0) return fieldErr("minutes", "Time given must be more than 0 minutes");
      const reminder = text(h.reminder);
      if (reminder && !ISO.test(reminder)) return fieldErr("reminder", "INVALID");
      const values = {
        date,
        employeeId: emp.id,
        customerId: c.id,
        customerName: c.name,
        note,
        minutes,
        mood: text(h.mood),
        issue: text(h.issue),
        reminder,
        meetType: text(h.meetType),
        purpose: text(h.purpose),
        area: areaOf(c) || null,
      };
      if (recordId) {
        const [r] = await db.select().from(hrmsActivities).where(eq(hrmsActivities.id, recordId));
        if (!r) return err("That activity no longer exists.", "not_found");
        if (!mayEditActivity(ctx, r.employeeId)) return err("Only who logged it, or the Sales desk for everyone, edits it", "not_permitted");
        await db
          .update(hrmsActivities)
          .set({ ...values, updatedAt: new Date(), updatedById: ctx.user.id })
          .where(eq(hrmsActivities.id, recordId));
        await hrmsAudit(ctx, "hrms.activity.edit", "hrms_activities", recordId, r, values);
        return okVoid(`Activity saved for ${c.name}`);
      }
      const id = hrmsId("hact");
      await db.insert(hrmsActivities).values({ id, ...values, createdById: ctx.user.id });
      await hrmsAudit(ctx, "hrms.activity.log", "hrms_activities", id, null, values);
      return okVoid(`Activity logged for ${c.name}`);
    },
  },
  actions: {
    async delete(ctx, id) {
      if (!(has(ctx, "admin") || has(ctx, "hr"))) return err("Only admin or HR deletes an activity", "not_permitted");
      const [r] = await db.select().from(hrmsActivities).where(eq(hrmsActivities.id, id));
      if (!r) return err("That activity no longer exists.", "not_found");
      await db.delete(hrmsActivities).where(eq(hrmsActivities.id, id));
      await hrmsAudit(ctx, "hrms.activity.delete", "hrms_activities", id, r, null);
      return okVoid("Activity deleted");
    },
  },
};

/* ---------------------------------------------------------------- journey planner */

/** Whom a plan may be for: any active employee with `journeyAnyone`, active sales staff with the desk for everyone, else myself. */
function journeyPeople(ctx: HrmsContext, people: Person[]): Person[] {
  if (has(ctx, "journeyAnyone")) return people.filter((p) => isActive(p) && !p.dateOfLeaving);
  if (has(ctx, "salesAll")) return people.filter((p) => isActive(p) && isSales(p) && !p.dateOfLeaving);
  return people.filter((p) => p.id === ctx.employee?.id);
}

const mayChangeJourney = (ctx: HrmsContext, r: { createdById: string | null; employeeId: string }) =>
  r.createdById === ctx.user.id || r.employeeId === ctx.employee?.id || has(ctx, "salesAll");

async function journeyForm(ctx: HrmsContext, init?: Record<string, string>, recordId?: string): Promise<FormSpec | undefined> {
  const [people, locations, custs] = await Promise.all([allPeople(), refList("Journey locations"), loadCustomers()]);
  const emps = journeyPeople(ctx, people);
  if (!emps.length) return undefined;
  const me = emps.find((p) => p.id === ctx.employee?.id) ?? emps[0];
  /* A plan's customers are the active ones of the chosen location. */
  const map: Record<string, string[]> = {};
  for (const loc of locations) map[loc] = custs.filter((c) => statusOf(c) === "Active" && norm(areaOf(c)) === norm(loc)).map(custOption);
  return {
    screen: "journey",
    id: "journey",
    title: recordId ? "Edit journey plan" : "Add a journey plan",
    sub: "Where you will be, and which customers you plan to meet.",
    submit: "Save plan",
    recordId,
    init: init ?? { emp: personOption(me), start: today(), end: today() },
    header: [
      {
        k: "emp",
        l: "Employee",
        t: "select",
        req: true,
        opts: emps.map(personOption),
        hint: has(ctx, "journeyAnyone") ? "Any active employee." : "Active sales staff with no date of leaving.",
      },
      { k: "start", l: "From", t: "date", req: true },
      { k: "end", l: "To", t: "date", req: true },
      { k: "location", l: "Location", t: "select", req: true, opts: locations },
      { k: "plan", l: "Plan", t: "area", req: true, mic: true },
      { k: "customers", l: "Customers", t: "multi", optsBy: { by: "location", map }, hint: "Active customers in the chosen location." },
      { k: "remark", l: "Remark", t: "area" },
      { k: "photo", l: "Attachment", t: "photo" },
    ],
  };
}

const journeyScreen: HrmsScreenModule = {
  key: "journey",
  async load(ctx, q) {
    const people = await allPeople();
    const { scope, options } = scopeFor(ctx, q, "salesAll");
    const ids = visibleIds(ctx, scope, people);
    const rows = !ids
      ? await db.select().from(hrmsJourneys)
      : ids.size
        ? await db.select().from(hrmsJourneys).where(inArray(hrmsJourneys.employeeId, [...ids]))
        : [];
    const pb = byId(people);
    const custs = await loadCustomers([...new Set(rows.flatMap((r) => r.customerIds ?? []))]);
    const cb = new Map(custs.map((c) => [c.id, c]));
    const month = q.month && /^\d{4}-\d{2}$/.test(q.month) ? q.month : monthOf(today());
    return {
      spec: {
        screen: "journey",
        cols: [
          { k: "emp", l: "Salesman", t: "b" },
          { k: "start", l: "From", t: "d" },
          { k: "end", l: "To", t: "d" },
          { k: "location", l: "Location", t: "t" },
          { k: "plan", l: "Plan", t: "t" },
        ],
        hidden: [],
        sortDefault: ["start", -1],
        newForm: await journeyForm(ctx),
        newLabel: "Add a plan",
        noDataLine: "No journey plans yet.",
        hrms: {
          scope: { current: scope, options },
          calendar: { from: "start", to: "end", label: "label", tone: "tone", month },
        },
      },
      rows: rows.map((r): ListRow => {
        const emp = pb.get(r.employeeId)?.name ?? "";
        const may = mayChangeJourney(ctx, r);
        const names = (r.customerIds ?? []).map((id) => cb.get(id)?.name).filter(Boolean);
        return {
          id: r.id,
          v: {
            emp,
            start: r.startDate,
            end: r.endDate,
            location: r.location ?? "",
            plan: r.plan ?? "",
            label: `${first(emp)} · ${r.location ?? ""}`,
            tone: "brand",
          },
          flags: r.employeeId === ctx.employee?.id ? ["mine"] : [],
          title: `${emp} · ${r.location ?? ""}`,
          header: r.startDate === r.endDate ? fdShort(r.startDate) : `${fdShort(r.startDate)} – ${fdShort(r.endDate)}`,
          fields: [
            { l: "Plan", v: r.plan ?? "" },
            { l: "Customers", v: names.join(", ") || "None chosen" },
            { l: "Remark", v: r.remark ?? "" },
            { l: "Attachment", v: r.fileAttachmentId ? "Attached" : "None" },
          ],
          contacts: r.fileAttachmentId ? [{ l: "Open file", href: `/api/attachments/${r.fileAttachmentId}` }] : [],
          actions: [
            { id: "edit", l: "Edit", primary: true, loadsForm: true, why: may ? undefined : "Only who planned it, or the Sales desk for everyone, edits it" },
            { id: "delete", l: "Delete", why: may ? undefined : "Only who planned it, or the Sales desk for everyone, deletes it", confirm: "Delete this journey plan?" },
          ],
          by: stampLine(null, r.createdAt),
        };
      }),
    };
  },
  formLoaders: {
    async edit(ctx, id) {
      const [r] = await db.select().from(hrmsJourneys).where(eq(hrmsJourneys.id, id));
      if (!r || !mayChangeJourney(ctx, r)) return null;
      const people = await allPeople();
      const p = people.find((x) => x.id === r.employeeId);
      const custs = await loadCustomers(r.customerIds ?? []);
      const form = await journeyForm(
        ctx,
        {
          emp: p ? personOption(p) : "",
          start: r.startDate,
          end: r.endDate,
          location: r.location ?? "",
          plan: r.plan ?? "",
          customers: custs.map(custOption).join("|"),
          remark: r.remark ?? "",
          photo: r.fileAttachmentId ?? "",
        },
        r.id,
      );
      return form ?? null;
    },
  },
  forms: {
    async journey(ctx, h, _lines, recordId) {
      const people = await allPeople();
      const emp = personFrom(h.emp, journeyPeople(ctx, people));
      if (!emp) return fieldErr("emp", "invalid Name");
      const start = text(h.start);
      const end = text(h.end) ?? start;
      if (!start || !ISO.test(start)) return fieldErr("start", "INVALID");
      if (!end || !ISO.test(end)) return fieldErr("end", "INVALID");
      if (end < start) return fieldErr("end", "Before Date should Be Greater Than For Date!");
      const location = text(h.location);
      const locations = await refList("Journey locations");
      if (!location || (locations.length && !locations.includes(location))) return fieldErr("location", "Choose a location");
      const plan = text(h.plan);
      if (!plan) return fieldErr("plan", "Plan is required");
      const custs = await loadCustomers();
      const customerIds: string[] = [];
      for (const o of multi(h.customers)) {
        const c = custFrom(o, custs);
        if (!c || statusOf(c) !== "Active" || norm(areaOf(c)) !== norm(location)) return fieldErr("customers", `${o} is not an active customer in ${location}`);
        customerIds.push(c.id);
      }
      const photo = text(h.photo);
      const values = { employeeId: emp.id, startDate: start, endDate: end, location, plan, customerIds, remark: text(h.remark), fileAttachmentId: photo };
      const { bindHrmsFiles } = await import("../attachments");
      if (recordId) {
        const [r] = await db.select().from(hrmsJourneys).where(eq(hrmsJourneys.id, recordId));
        if (!r) return err("That plan no longer exists.", "not_found");
        if (!mayChangeJourney(ctx, r)) return err("Only who planned it, or the Sales desk for everyone, edits it", "not_permitted");
        const res = await inTx(async (tx) => {
          await tx
            .update(hrmsJourneys)
            .set({ ...values, updatedAt: new Date(), updatedById: ctx.user.id })
            .where(eq(hrmsJourneys.id, recordId));
          if (photo && photo !== r.fileAttachmentId) await bindHrmsFiles(tx, [photo], "hrms_journey", recordId, ctx.user.id);
          return okVoid("Journey plan saved");
        });
        if (res.ok) await hrmsAudit(ctx, "hrms.journey.edit", "hrms_journeys", recordId, r, values);
        return res;
      }
      const id = hrmsId("hjrn");
      const res = await inTx(async (tx) => {
        await tx.insert(hrmsJourneys).values({ id, ...values, createdById: ctx.user.id });
        if (photo) await bindHrmsFiles(tx, [photo], "hrms_journey", id, ctx.user.id);
        return okVoid(`Journey plan saved for ${emp.name}`);
      });
      if (res.ok) await hrmsAudit(ctx, "hrms.journey.add", "hrms_journeys", id, null, values);
      return res;
    },
  },
  actions: {
    async delete(ctx, id) {
      const [r] = await db.select().from(hrmsJourneys).where(eq(hrmsJourneys.id, id));
      if (!r) return err("That plan no longer exists.", "not_found");
      if (!mayChangeJourney(ctx, r)) return err("Only who planned it, or the Sales desk for everyone, deletes it", "not_permitted");
      await db.delete(hrmsJourneys).where(eq(hrmsJourneys.id, id));
      await hrmsAudit(ctx, "hrms.journey.delete", "hrms_journeys", id, r, null);
      return okVoid("Journey plan deleted");
    },
  },
};

export const SALES_SCREENS: HrmsScreenModule[] = [customersScreen, callingScreen, activityScreen, journeyScreen];
