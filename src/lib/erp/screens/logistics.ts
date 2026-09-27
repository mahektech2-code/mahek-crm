import "server-only";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { customers, employees, erpCredits, erpExpenses, erpFollowups, erpGodowns, erpOrderDetails, erpRequests, erpTransports, erpVideos, users } from "@/db/schema";
import { calendarDate } from "@/lib/business-date";
import { getConfig } from "@/lib/config/store";
import { err, fieldErr, okVoid, type Result } from "@/lib/result";
import type { ErpContext } from "../access";
import { bindErpFiles } from "../attachments";
import { erpAudit, erpId, int, multi, paise, rupeesField, stampLine, text, visibleCols, withoutHidden, type ScreenModule } from "../server";
import type { ActionSpec, BulkSpec, CellValue, ColSpec, FieldSpec, FormSpec, ListRow } from "../ui";
import { fd, inr } from "../ui";
import { callingDate, cashBalances, cashKey, followFigures } from "../engines/followup";
import { addDaysIso, monthId } from "../engines/sales";
import { refValues } from "../refs";
import { godownIdByName, godownOptions, has, today, type Col } from "./common";
import { customerForm, loadCustomers, phoneContacts, saveCustomerDetails } from "./masters";
import { detailRows, orderLines } from "./sales";
import { traceBill, type Trace } from "../trace";

/* ---------------------------------------------------------------------------
 * Logistics, customer requests and credit notes, order follow-up, petty cash,
 * my customers and help videos (spec §12–§13).
 * ------------------------------------------------------------------------- */

export const MATERIAL_STAGES = ["Dispatch from Bhiwandi", "Dispatch from Ambernath", "In Transit", "On the way to Destination area", "Reached Destination Area", "Close - Received to Party"];
const MODES = ["Bank Cash", "Cash", "Other"];

/* ============================================================ transport */

type TransportScope = "transport" | "pendingLr" | "trackLr";

function transportList(scope: TransportScope): ScreenModule {
  return {
    key: scope,
    async load(ctx) {
      const [rows, details] = await Promise.all([
        db
          .select({ t: erpTransports, party: customers.name, salesPerson: customers.salesPersonName, by: users.name })
          .from(erpTransports)
          .innerJoin(customers, eq(customers.id, erpTransports.billingCustomerId))
          .leftJoin(users, eq(users.id, erpTransports.updatedById))
          .orderBy(desc(erpTransports.billDate), desc(erpTransports.orderNo)),
        detailRows(),
      ]);
      const shown = rows.filter((r) => (scope === "pendingLr" ? !r.t.lrNo : scope === "trackLr" ? !!r.t.lrNo && r.t.trackStatus === "Track" : true));
      const all: Col[] = [
        { k: "orderNo", l: "Order no", t: "mono" },
        { k: "billDate", l: "Bill date", t: "d" },
        { k: "party", l: "Billing party", t: "b" },
        { k: "billNo", l: "Bill no", t: "mono" },
        { k: "lr", l: "LR no", t: "mono" },
        { k: "transporter", l: "Transporter", t: "t" },
        { k: "area", l: "Area", t: "t" },
        { k: "track", l: "Track status", t: "s" },
        { k: "payment", l: "Payment type", t: "s" },
        { k: "extra", l: "Extra expense", t: "m" },
        { k: "note", l: "Note", t: "t" },
        { k: "stage", l: "Material stage", t: "s" },
        { k: "reminder", l: "Reminder call", t: "d" },
        { k: "salesMan", l: "Tag sales man", t: "t" },
        { k: "monthly", l: "Monthly sales", t: "m", pw: "viewSalesAmounts" },
      ];
      const { cols, hidden, hiddenKeys } = visibleCols(all, has(ctx));
      const monthly = details.monthly;
      return {
        spec: {
          screen: scope,
          cols,
          hidden,
          groups: scope === "transport" ? ["billDate"] : ["transporter"],
          readOnly: false,
          noDataLine:
            scope === "pendingLr" ? "Every dispatched bill has its LR number." : scope === "trackLr" ? "No consignment is being tracked." : "Nothing dispatched yet. A bill appears here once its first line is dispatch-verified.",
        },
        rows: shown.map((r): ListRow => {
          const t = r.t;
          const mid = monthId(t.billDate);
          return {
            id: t.id,
            v: withoutHidden(
              {
                orderNo: String(t.orderNo),
                billDate: t.billDate,
                party: r.party,
                billNo: t.billNo,
                lr: t.lrNo,
                transporter: t.transporter,
                area: t.area,
                track: t.trackStatus,
                payment: t.paymentType,
                extra: t.paymentType === "Paid" ? t.extraExpensePaise : null,
                note: t.note,
                stage: t.materialStage,
                reminder: t.reminderDate,
                salesMan: r.salesPerson,
                monthly: mid ? (monthly.get(`${mid}|${t.billingCustomerId}`) ?? 0) : null,
              } as Record<string, CellValue>,
              hiddenKeys,
            ),
            flags: t.reminderDate && t.reminderDate <= today() && t.materialStage !== "Close - Received to Party" ? ["today"] : [],
            title: `${r.party} · bill ${t.billNo ?? t.orderNo}`,
            header: `${t.transporter ?? "No transporter"} · ${t.materialStage}`,
            actions: [
              {
                id: "update",
                l: t.lrNo ? "Update consignment" : "Enter LR",
                primary: true,
                prompt: {
                  title: t.lrNo ? "Update the consignment" : "Enter the LR number",
                  sub: `${r.party} · bill ${t.billNo ?? "—"}`,
                  submit: "Save",
                  fields: [
                    { k: "lr", l: "Despatch LR no", t: "text" },
                    { k: "track", l: "Track status", t: "select", req: true, opts: ["Track", "Don't Track"] },
                    { k: "stage", l: "Material stage", t: "select", req: true, opts: MATERIAL_STAGES },
                    { k: "reminder", l: "Reminder call", t: "date" },
                    { k: "note", l: "Note", t: "area", mic: true },
                  ],
                  init: { lr: t.lrNo ?? "", track: t.trackStatus, stage: t.materialStage, reminder: t.reminderDate ?? "", note: t.note ?? "" },
                },
              },
            ],
            by: stampLine(r.by, t.updatedAt).replace(/^Created/, "Updated"),
          };
        }),
      };
    },
    actions: {
      async update(ctx, id, values) {
        const track = text(values.track);
        const stage = text(values.stage);
        if (!track || !["Track", "Don't Track"].includes(track)) return fieldErr("track", "Track status is required");
        if (!stage || !MATERIAL_STAGES.includes(stage)) return fieldErr("stage", "Material stage is required");
        const lr = text(values.lr);
        if (track === "Track" && !lr) return fieldErr("lr", "A consignment is tracked by its LR number");
        const [before] = await db.select().from(erpTransports).where(eq(erpTransports.id, id));
        if (!before) return err("That bill is not in transport follow-up.", "not_found");
        const after = { lrNo: lr, trackStatus: track, materialStage: stage, reminderDate: text(values.reminder), note: text(values.note), updatedAt: new Date(), updatedById: ctx.user.id };
        await db.update(erpTransports).set(after).where(eq(erpTransports.id, id));
        await erpAudit(ctx, "erp.transport.update", "erp_transport", id, before, after);
        return okVoid(lr && !before.lrNo ? `LR ${lr} recorded` : "Consignment updated");
      },
    },
  };
}

/** Paid-freight detail lines still without their extra expense (spec §12.1 "Transportation Paid"). */
const paidFreight: ScreenModule = {
  key: "paidFreight",
  async load(ctx) {
    const { rows } = await detailRows();
    const shown = rows.filter((r) => r.l.billing.freightTerm === "Paid" && r.d.extraExpensesPaise == null);
    const cols: ColSpec[] = [
      { k: "party", l: "Billing party", t: "b" },
      { k: "extra", l: "Extra expenses", t: "m" },
      { k: "sku", l: "Description of goods", t: "t", w: 240 },
      { k: "litres", l: "Litres", t: "n" },
      { k: "payment", l: "Payment type", t: "s" },
      { k: "transporter", l: "Transporter", t: "t" },
    ];
    const bulk: BulkSpec[] = [{ id: "extra", l: "Extra Expenses", prompt: { title: "Enter Extra Expenses", submit: "Save", fields: [{ k: "amount", l: "Extra expenses (₹)", t: "num", req: true, min: 0 }] } }];
    void ctx;
    return {
      spec: { screen: "paidFreight", cols, hidden: [], groups: ["transporter"], agg: { k: "extra", l: "extra expenses" }, bulk, noDataLine: "Every paid-freight line has its extra expense." },
      rows: shown.map((r) => ({
        id: r.l.o.id,
        v: { party: r.l.billing.name, extra: r.d.extraExpensesPaise, sku: r.l.sku.name, litres: r.litres, payment: r.l.billing.freightTerm, transporter: r.l.o.transporter ?? r.l.delivery.p?.transporter ?? "—" },
        flags: [],
        title: `${r.l.billing.name} · order ${r.l.o.orderNo}`,
        actions: [{ id: "extra", l: "Extra Expenses", primary: true, prompt: { title: "Enter Extra Expenses", submit: "Save", fields: [{ k: "amount", l: "Extra expenses (₹)", t: "num", req: true, min: 0 }] } }],
      })),
    };
  },
  actions: { extra: (ctx, id, v) => setExtra(ctx, [id], v) },
  bulk: { extra: (ctx, ids, v) => setExtra(ctx, ids, v) },
};

async function setExtra(ctx: ErpContext, ids: string[], values: Record<string, string>): Promise<Result<unknown>> {
  const amount = paise(values.amount);
  if (amount == null || amount < 0) return fieldErr("amount", "Extra expenses are required");
  const res = await db
    .update(erpOrderDetails)
    .set({ extraExpensesPaise: amount, updatedAt: new Date(), updatedById: ctx.user.id })
    .where(and(inArray(erpOrderDetails.orderId, ids), sql`${erpOrderDetails.extraExpensesPaise} is null`))
    .returning({ id: erpOrderDetails.orderId });
  if (!res.length) return err("Extra expenses are already entered on these lines.", "rule_violation");
  /* The bill's transport record carries the same figure, copied when it opened. */
  await db.execute(sql`update erp_transports t set extra_expense_paise = ${amount} where t.id in ${ids} and t.extra_expense_paise is null`);
  await erpAudit(ctx, "erp.detail.extra", "erp_order_detail", res.map((r) => r.id).join(","), null, { amount });
  return okVoid(`Extra expenses on ${res.length} line${res.length === 1 ? "" : "s"}`);
}

/* ============================================================= requests */

type RequestScope = "requests" | "issueCn" | "complaints";

async function activeEmployees(): Promise<{ name: string; position: string | null }[]> {
  return db.select({ name: employees.name, position: employees.position }).from(employees).where(eq(employees.status, "active")).orderBy(asc(employees.name));
}

async function requestForm(ctx: ErpContext, init?: Record<string, string>): Promise<FormSpec> {
  const [parties, staff, types, details] = await Promise.all([loadCustomers(), activeEmployees(), refValues("complaintType"), detailRows()]);
  const names = parties.map((p) => p.name);
  const mobile: Record<string, string> = {};
  parties.forEach((p) => (mobile[p.name] = p.phone ?? ""));
  const bills: Record<string, string[]> = {};
  const billDate: Record<string, string> = {};
  const goods: Record<string, string[]> = {};
  for (const r of details.rows) {
    const bill = r.l.o.tallyBillNo;
    if (!bill) continue;
    const party = r.l.billing.name;
    if (!(bills[party] ??= []).includes(bill)) bills[party].push(bill);
    if (r.d.dispatchDate) billDate[`${party}|${bill}`] = r.d.dispatchDate;
    if (!(goods[`${party}|${bill}`] ??= []).includes(r.l.sku.name)) goods[`${party}|${bill}`].push(r.l.sku.name);
  }
  const me = staff.find((s) => s.name.toLowerCase() === ctx.user.name.toLowerCase() && /sales/i.test(s.position ?? ""));
  const salesmen = staff.filter((s) => /sales|office/i.test(s.position ?? "")).map((s) => s.name);
  return {
    screen: "requests",
    id: "new",
    title: "Raise a customer request",
    sub: "A complaint, or a credit note the customer is asking for. The office decides.",
    submit: "Raise request",
    init: { salesman: me?.name ?? "", cn: "No", ...init },
    data: { mobile, billDate },
    header: [
      { k: "salesman", l: "Name of salesman", t: "select", opts: salesmen.length ? salesmen : staff.map((s) => s.name) },
      { k: "customer", l: "Customer", t: "select", req: true, opts: names },
      { k: "mobile", l: "Mobile number", t: "derived", calc: "request.mobile" },
      { k: "type", l: "Complaint type", t: "select", req: true, opts: types },
      { k: "description", l: "Complaint description", t: "area", req: true, mic: true },
      { k: "photo", l: "Complaint picture", t: "photo" },
      { k: "cn", l: "Credit note required", t: "select", req: true, opts: ["Yes", "No"] },
      { k: "bill", l: "Bill number", t: "select", req: true, optsBy: { by: "customer", map: bills }, when: { k: "cn", eq: "Yes" } },
      { k: "billDate", l: "Bill date", t: "derived", calc: "request.billDate", when: { k: "cn", eq: "Yes" } },
      { k: "goods", l: "Description of goods", t: "select", req: true, optsBy: { by: ["customer", "bill"], map: goods }, when: { k: "cn", eq: "Yes" } },
    ],
  };
}

type RequestRow = { r: typeof erpRequests.$inferSelect; party: string; area: string | null; phone: string | null; by: string | null };

async function requestRows(where?: ReturnType<typeof eq>): Promise<RequestRow[]> {
  const q = db
    .select({ r: erpRequests, party: customers.name, area: customers.area, phone: customers.phone, by: users.name })
    .from(erpRequests)
    .innerJoin(customers, eq(customers.id, erpRequests.customerId))
    .leftJoin(users, eq(users.id, erpRequests.createdById));
  return (where ? q.where(where) : q).orderBy(desc(erpRequests.raisedAt));
}

function requestRow(ctx: ErpContext, x: RequestRow, panel?: ListRow["panel"]): ListRow {
  const r = x.r;
  const decider = ctx.powers.has("decideRequests");
  const why = decider ? "" : "Only an admin or the office decides a request";
  const actions: ActionSpec[] = [];
  if (r.status !== "Accepted") actions.push({ id: "accept", l: "Accepted", primary: r.status === "Requested", why });
  if (r.status !== "Rejected") actions.push({ id: "reject", l: "Rejected", why, confirm: `Reject the request from ${x.party}?` });
  if (r.status === "Accepted" && r.cnRequired)
    actions.push({
      id: "issue",
      l: "Issue Credit Note",
      primary: true,
      why,
      prompt: {
        title: "Issue the credit note",
        sub: `${x.party} · bill ${r.billNo ?? "—"} · ${r.goods ?? ""}`,
        submit: "Issue",
        fields: [
          { k: "amount", l: "Credit note amount (₹, before GST)", t: "num", req: true, min: 0.01 },
          { k: "date", l: "Credit note date", t: "date", req: true },
          { k: "number", l: "Credit note number", t: "text", req: true },
          { k: "remark", l: "Remark", t: "area" },
          { k: "file", l: "Credit note file", t: "photo" },
        ],
        init: { amount: rupeesField(r.cnAmountPaise), date: r.cnDate ?? today(), number: r.cnNumber ?? "", remark: r.remark ?? "" },
      },
    });
  if (r.status === "Accepted" && !r.cnRequired)
    actions.push({
      id: "resolve",
      l: "Resolve Complaint",
      primary: true,
      why,
      prompt: {
        title: "Resolve the complaint",
        submit: "Resolve",
        fields: [
          { k: "remark", l: "Remark", t: "area", req: true, mic: true },
          { k: "responsible", l: "Responsible employee", t: "text", req: true },
        ],
        init: { remark: r.remark ?? "", responsible: r.responsible ?? "" },
      },
    });
  actions.push({ id: "more", l: "Add More Credit", loadsForm: true });
  actions.push({ id: "customer", l: "View customer", href: `/erp/customers?open=${r.customerId}` });
  if (r.cnFileId) actions.push({ id: "file", l: "Open credit note", href: `/api/attachments/${r.cnFileId}` });
  if (r.photoId) actions.push({ id: "photo", l: "Open picture", href: `/api/attachments/${r.photoId}` });
  const response = r.resolvedAt ? Math.round((r.resolvedAt.getTime() - r.raisedAt.getTime()) / 3600000) : null;
  return {
    id: r.id,
    v: {
      raised: calendarDate(r.raisedAt),
      status: r.status,
      salesman: r.salesmanName,
      party: x.party,
      mobile: r.mobile,
      type: r.complaintType,
      cn: r.cnRequired ? "Yes" : "No",
      bill: r.billNo,
      goods: r.goods,
      amount: r.cnAmountPaise,
      description: r.description,
    },
    flags: [r.status === "Accepted" ? "accepted" : r.status === "Rejected" ? "rejected" : "requested"],
    title: x.party,
    header: `${r.complaintType ?? "Request"} · raised ${fd(calendarDate(r.raisedAt))}`,
    fields: [
      { l: "Area", v: x.area ?? "—", der: true },
      { l: "Bill date", v: r.billDate ? fd(r.billDate) : "—" },
      { l: "Credit note amount (with GST)", v: r.cnAmountPaise == null ? "—" : inr(Math.round(r.cnAmountPaise * 1.18)), der: true },
      { l: "Credit note date", v: r.cnDate ? fd(r.cnDate) : "—" },
      { l: "Credit note number", v: r.cnNumber ?? "—" },
      { l: "Remark", v: r.remark ?? "—" },
      { l: "Responsible employee", v: r.responsible ?? "—" },
      { l: "Response time", v: response == null ? "—" : response < 48 ? `${response} h` : `${Math.round(response / 24)} days`, der: true },
      { l: "Month", v: calendarDate(r.raisedAt).slice(0, 7), der: true },
    ],
    contacts: phoneContacts(x.phone),
    panel,
    actions,
    by: stampLine(x.by, r.raisedAt),
  };
}

/**
 * AI-6 for the decider: each request's trace, the other requests sharing its
 * lots inside the window (a possible batch problem at the threshold), who made
 * what was traced, and the customer's earlier requests. All deterministic.
 */
async function requestAssist(rows: RequestRow[]): Promise<Map<string, ListRow["panel"]>> {
  const out = new Map<string, ListRow["panel"]>();
  const c = await getConfig();
  if (!c["erp.ai.complaints.enabled"]) return out;
  const threshold = c["erp.ai.complaints.clusterThreshold"];
  const since = Date.now() - c["erp.ai.complaints.clusterDays"] * 86400000;
  const traces = new Map<string, Trace>();
  for (const x of rows) if (x.r.billNo) traces.set(x.r.id, await traceBill(x.r.customerId, x.r.billNo, x.r.goods));
  for (const x of rows) {
    const t = traces.get(x.r.id);
    const mine = new Set((t?.lots ?? []).filter((l) => !l.startsWith("pack:")));
    const sharing = rows.filter((o) => {
      if (o.r.id === x.r.id || o.r.status === "Rejected" || o.r.raisedAt.getTime() < since) return false;
      return (traces.get(o.r.id)?.lots ?? []).some((l) => mine.has(l));
    });
    const previous = rows.filter((o) => o.r.customerId === x.r.customerId && o.r.raisedAt < x.r.raisedAt).slice(0, 5);
    out.set(x.r.id, {
      kind: "trace",
      data: {
        steps: t?.steps ?? [],
        missing: t ? t.missing : ["This request names no bill, so there is nothing to trace."],
        cluster: sharing.length + 1 >= threshold ? { count: sharing.length + 1, parties: [...new Set(sharing.map((o) => o.party))], lots: [...mine].filter((l) => sharing.some((o) => traces.get(o.r.id)?.lots.includes(l))) } : null,
        people: t?.people ?? [],
        previous: previous.map((o) => ({ date: calendarDate(o.r.raisedAt), type: o.r.complaintType, status: o.r.status, cn: o.r.cnAmountPaise })),
      },
    });
  }
  return out;
}

function requestList(scope: RequestScope): ScreenModule {
  return {
    key: scope,
    async load(ctx) {
      const rows = await requestRows(scope === "issueCn" ? eq(erpRequests.cnRequired, true) : scope === "complaints" ? eq(erpRequests.cnRequired, false) : undefined);
      const cols: ColSpec[] = [
        { k: "raised", l: "Raised", t: "d" },
        { k: "status", l: "Status", t: "s" },
        { k: "salesman", l: "Salesman", t: "t" },
        { k: "party", l: "Customer", t: "b" },
        { k: "mobile", l: "Mobile", t: "ph" },
        { k: "type", l: "Complaint type", t: "s" },
        { k: "cn", l: "CN", t: "s" },
        { k: "bill", l: "Bill no", t: "mono" },
        { k: "goods", l: "Goods", t: "t" },
        { k: "amount", l: "CN amount", t: "m" },
        { k: "description", l: "Description", t: "t", w: 260 },
        { k: "f", l: "Flags", t: "f" },
      ];
      const decider = ctx.powers.has("decideRequests");
      return {
        spec: {
          screen: scope,
          cols,
          hidden: [],
          groups: scope === "requests" ? ["status"] : scope === "complaints" ? ["type"] : undefined,
          chips: "status",
          bulk: decider ? [{ id: "accept", l: "Accepted" }, { id: "reject", l: "Rejected", confirm: "Reject every selected request?" }] : undefined,
          newForm: scope === "requests" ? await requestForm(ctx) : undefined,
          newLabel: "Raise request",
          noDataLine: scope === "issueCn" ? "No credit-note requests." : scope === "complaints" ? "No complaints." : "No customer requests yet.",
        },
        rows: await (async () => {
          const assist = await requestAssist(rows);
          return rows.map((x) => requestRow(ctx, x, assist.get(x.r.id)));
        })(),
      };
    },
    forms: {
      new: (ctx, h) => saveRequest(ctx, h),
    },
    formLoaders: {
      async more(ctx, id) {
        const [x] = await requestRows(eq(erpRequests.id, id));
        if (!x) return null;
        const f = await requestForm(ctx, { salesman: x.r.salesmanName ?? "", customer: x.party, type: x.r.complaintType ?? "", description: x.r.description ?? "", cn: x.r.cnRequired ? "Yes" : "No", bill: x.r.billNo ?? "" });
        return { ...f, title: "Raise another request for this bill" };
      },
    },
    actions: {
      accept: (ctx, id) => decide(ctx, [id], "Accepted"),
      reject: (ctx, id) => decide(ctx, [id], "Rejected"),
      async issue(ctx, id, v) {
        if (!ctx.powers.has("decideRequests")) return err("Only an admin or the office issues a credit note.", "not_permitted");
        const [r] = await db.select().from(erpRequests).where(eq(erpRequests.id, id));
        if (!r) return err("That request no longer exists.", "not_found");
        if (r.status !== "Accepted" || !r.cnRequired) return err("A credit note is issued on an accepted credit-note request.", "rule_violation");
        const amount = paise(v.amount);
        if (amount == null || amount <= 0) return fieldErr("amount", "Credit note amount is required");
        const number = text(v.number);
        if (!number) return fieldErr("number", "Credit note number is required");
        const date = text(v.date) ?? today();
        await db.transaction(async (tx) => {
          await tx
            .update(erpRequests)
            .set({ cnAmountPaise: amount, cnDate: date, cnNumber: number, remark: text(v.remark), cnFileId: text(v.file), resolvedAt: new Date(), updatedAt: new Date() })
            .where(eq(erpRequests.id, id));
          await bindErpFiles(tx as unknown as typeof db, [text(v.file)], "erp_request", id, ctx.user.id);
        });
        await erpAudit(ctx, "erp.request.issueCn", "erp_request", id, { cnAmountPaise: r.cnAmountPaise }, { cnAmountPaise: amount, number });
        return okVoid(`Credit note ${number} issued · ${inr(amount)} before GST. Update the order line from Pending CN.`);
      },
      async resolve(ctx, id, v) {
        if (!ctx.powers.has("decideRequests")) return err("Only an admin or the office resolves a complaint.", "not_permitted");
        const remark = text(v.remark);
        const responsible = text(v.responsible);
        if (!remark) return fieldErr("remark", "Remark is required");
        if (!responsible) return fieldErr("responsible", "Responsible employee is required");
        const [r] = await db.select().from(erpRequests).where(eq(erpRequests.id, id));
        if (!r) return err("That request no longer exists.", "not_found");
        if (r.status !== "Accepted" || r.cnRequired) return err("A complaint is resolved once it is accepted.", "rule_violation");
        await db.update(erpRequests).set({ remark, responsible, resolvedAt: new Date(), updatedAt: new Date() }).where(eq(erpRequests.id, id));
        await erpAudit(ctx, "erp.request.resolve", "erp_request", id, null, { remark, responsible });
        return okVoid("Complaint resolved");
      },
    },
    bulk: {
      accept: (ctx, ids) => decide(ctx, ids, "Accepted"),
      reject: (ctx, ids) => decide(ctx, ids, "Rejected"),
    },
  };
}

async function decide(ctx: ErpContext, ids: string[], status: "Accepted" | "Rejected"): Promise<Result<unknown>> {
  if (!ctx.powers.has("decideRequests")) return err("Only an admin or the office decides a request.", "not_permitted");
  const res = await db
    .update(erpRequests)
    .set({ status, approvedAt: new Date(), approvedById: ctx.user.id, updatedAt: new Date() })
    .where(and(inArray(erpRequests.id, ids), sql`${erpRequests.status} <> ${status}`))
    .returning({ id: erpRequests.id });
  if (!res.length) return err(`Already ${status}.`, "conflict");
  await erpAudit(ctx, `erp.request.${status.toLowerCase()}`, "erp_request", res.map((r) => r.id).join(","));
  return okVoid(`${res.length} request${res.length === 1 ? "" : "s"} ${status}`);
}

async function saveRequest(ctx: ErpContext, h: Record<string, string>): Promise<Result<unknown>> {
  const [c] = await loadCustomers(eq(customers.name, text(h.customer) ?? ""));
  if (!c) return fieldErr("customer", "Customer is required");
  const type = text(h.type);
  if (!type) return fieldErr("type", "Complaint type is required");
  const description = text(h.description);
  if (!description) return fieldErr("description", "Complaint description is required");
  const cn = h.cn === "Yes";
  const bill = cn ? text(h.bill) : null;
  const goods = cn ? text(h.goods) : null;
  if (cn && !bill) return fieldErr("bill", "Name the bill the credit note is against");
  let billDate: string | null = null;
  if (bill) {
    const { rows } = await detailRows();
    const on = rows.filter((r) => r.l.o.billingCustomerId === c.id && r.l.o.tallyBillNo === bill);
    if (!on.length) return fieldErr("bill", "That is not one of this customer's bills");
    if (!goods) return fieldErr("goods", "Name the goods the credit note is for");
    if (goods && !on.some((r) => r.l.sku.name === goods)) return fieldErr("goods", "That SKU is not on this bill");
    billDate = on.find((r) => r.d.dispatchDate)?.d.dispatchDate ?? null;
  }
  const id = erpId("req");
  await db.transaction(async (tx) => {
    await tx.insert(erpRequests).values({
      id,
      salesmanName: text(h.salesman),
      customerId: c.id,
      mobile: c.phone,
      complaintType: type,
      description,
      photoId: text(h.photo),
      cnRequired: cn,
      billNo: bill,
      billDate,
      goods,
      createdById: ctx.user.id,
    });
    await bindErpFiles(tx as unknown as typeof db, [text(h.photo)], "erp_request", id, ctx.user.id);
  });
  await erpAudit(ctx, "erp.request.create", "erp_request", id, null, { customer: c.name, type, cn });
  return okVoid(`Request raised for ${c.name} · waiting for the office`);
}

/* ============================================================ pending CN */

/** Detail lines whose credit note differs from the accepted request's for the same customer, bill and SKU. */
export async function pendingCnRows() {
  const [{ rows }, reqs] = await Promise.all([
    detailRows(),
    db.select().from(erpRequests).where(and(eq(erpRequests.status, "Accepted"), eq(erpRequests.cnRequired, true))),
  ]);
  const cnFor = new Map<string, number>();
  for (const r of reqs) if (r.billNo && r.goods && r.cnAmountPaise != null) cnFor.set(`${r.customerId}|${r.billNo}|${r.goods}`, (cnFor.get(`${r.customerId}|${r.billNo}|${r.goods}`) ?? 0) + r.cnAmountPaise);
  return rows
    .map((r) => ({ r, cn: cnFor.get(`${r.l.o.billingCustomerId}|${r.l.o.tallyBillNo}|${r.l.sku.name}`) }))
    .filter((x) => x.cn != null && x.cn !== (x.r.d.creditNotePaise ?? null));
}

const pendingCn: ScreenModule = {
  key: "pendingCn",
  async load(ctx) {
    const rows = await pendingCnRows();
    const all: Col[] = [
      { k: "party", l: "Billing party", t: "b" },
      { k: "bill", l: "Bill no", t: "mono" },
      { k: "sku", l: "Description of goods", t: "t", w: 240 },
      { k: "line", l: "On the line", t: "m", pw: "viewSalesAmounts" },
      { k: "request", l: "Accepted CN", t: "m", pw: "viewSalesAmounts" },
      { k: "orderNo", l: "Order no", t: "mono" },
    ];
    const { cols, hidden, hiddenKeys } = visibleCols(all, has(ctx));
    return {
      spec: { screen: "pendingCn", cols, hidden, bulk: [{ id: "update", l: "Credit Note Updater" }], noDataLine: "Every accepted credit note is on its order line." },
      rows: rows.map(({ r, cn }) => ({
        id: r.l.o.id,
        v: withoutHidden({ party: r.l.billing.name, bill: r.l.o.tallyBillNo, sku: r.l.sku.name, line: r.d.creditNotePaise, request: cn ?? null, orderNo: String(r.l.o.orderNo) }, hiddenKeys),
        flags: ["cnSync"],
        title: `${r.l.billing.name} · ${r.l.o.tallyBillNo}`,
        actions: [{ id: "update", l: "Credit Note Updater", primary: true }],
      })),
    };
  },
  actions: { update: (ctx, id) => updateCn(ctx, [id]) },
  bulk: { update: (ctx, ids) => updateCn(ctx, ids) },
};

async function updateCn(ctx: ErpContext, ids: string[]): Promise<Result<unknown>> {
  const want = new Set(ids);
  const rows = (await pendingCnRows()).filter((x) => want.has(x.r.l.o.id));
  if (!rows.length) return err("These lines already carry their credit note.", "conflict");
  for (const x of rows) await db.update(erpOrderDetails).set({ creditNotePaise: x.cn ?? null, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpOrderDetails.orderId, x.r.l.o.id));
  await erpAudit(ctx, "erp.detail.creditNote", "erp_order_detail", rows.map((x) => x.r.l.o.id).join(","));
  return okVoid(`Credit note copied onto ${rows.length} line${rows.length === 1 ? "" : "s"}`);
}

/* ============================================================ follow-up */

async function followRows() {
  const [lines, fus] = await Promise.all([orderLines(), db.select().from(erpFollowups)]);
  const fg = new Map<string, string>();
  const fgNames = (await db.execute(sql`select id, name from finished_goods`)) as unknown as { id: string; name: string }[];
  fgNames.forEach((f) => fg.set(f.id, f.name));
  const product = (l: (typeof lines)[number]) => (l.sku.fgId ? (fg.get(l.sku.fgId) ?? l.sku.name) : l.sku.name);
  /* Every order line is history for the party; only lines with a follow-up record are rows. */
  const figs = followFigures(lines.filter((l) => l.o.status !== "Cancel").map((l) => ({ id: l.o.id, party: l.delivery.id, product: product(l), date: l.o.orderDate })));
  const byId = new Map(lines.map((l) => [l.o.id, l]));
  return fus
    .map((f) => ({ f, l: byId.get(f.orderId), fig: figs.get(f.orderId) }))
    .filter((x): x is { f: typeof x.f; l: NonNullable<typeof x.l>; fig: NonNullable<typeof x.fig> } => !!x.l && !!x.fig)
    .map((x) => ({ ...x, product: product(x.l) }))
    .sort((a, b) => (a.l.o.orderDate < b.l.o.orderDate ? 1 : -1));
}

/**
 * AI-7: the CRM's own prediction for a party — its measured buying cycle from
 * the last order it knows of — shown beside the follow-up's arithmetic, and
 * labelled as the date the telecallers are working from. It is not a second
 * model.
 */
async function crmPredictions(): Promise<Map<string, { next: string | null; confidence: number | null; isDefault: boolean }>> {
  const rows = (await db.execute(sql`select id, last_order_date::text as last, cycle_days as cycle, cycle_confidence as confidence, cycle_is_default as "isDefault" from customers where last_order_date is not null`)) as unknown as { id: string; last: string; cycle: number; confidence: number | null; isDefault: boolean }[];
  return new Map(rows.map((r) => [r.id, { next: addDaysIso(r.last, Number(r.cycle)), confidence: r.confidence == null ? null : Number(r.confidence), isDefault: Boolean(r.isDefault) }]));
}

const followup: ScreenModule = {
  key: "followup",
  async load() {
    const [rows, crm] = await Promise.all([followRows(), crmPredictions()]);
    const cols: ColSpec[] = [
      { k: "date", l: "Order date", t: "d" },
      { k: "dayCount", l: "Day count", t: "n" },
      { k: "party", l: "Delivery party", t: "b" },
      { k: "calling", l: "Calling date", t: "d" },
      { k: "next", l: "Next order", t: "d" },
      { k: "average", l: "Average days", t: "n" },
      { k: "product", l: "FG product", t: "t" },
      { k: "orderNo", l: "Order no", t: "mono" },
      { k: "qty", l: "Qty", t: "n" },
      { k: "lastParty", l: "Last order (party)", t: "d" },
      { k: "reminderParty", l: "Reminder days (party)", t: "n" },
      { k: "lastProduct", l: "Last order (product)", t: "d" },
      { k: "dayCountProduct", l: "Day count (product)", t: "n" },
      { k: "reminderProduct", l: "Reminder days (product)", t: "n" },
      { k: "remark", l: "Remark", t: "t" },
      { k: "f", l: "Flags", t: "f" },
    ];
    const now = today();
    return {
      spec: { screen: "followup", cols, hidden: [], sortDefault: ["date", -1], noDataLine: "No follow-ups yet. A line gets one when it reaches order details." },
      rows: rows.map(({ f, l, fig, product }) => {
        const calling = callingDate(fig.nextOrder, f.reminderDaysParty);
        return {
          id: f.orderId,
          v: {
            date: l.o.orderDate,
            dayCount: fig.dayCountParty,
            party: l.delivery.name,
            calling,
            next: fig.nextOrder,
            average: fig.averageDays,
            product,
            orderNo: String(l.o.orderNo),
            qty: l.o.qtyCans,
            lastParty: fig.lastParty,
            reminderParty: f.reminderDaysParty,
            lastProduct: fig.lastProduct,
            dayCountProduct: fig.dayCountProduct,
            reminderProduct: f.reminderDaysProduct,
            remark: f.remark,
          },
          flags: calling && calling <= now ? ["today"] : [],
          title: `${l.delivery.name} · ${product}`,
          header: calling ? `Call on ${fd(calling)}` : "Not enough orders to predict the next one yet",
          fields: (() => {
            const p = crm.get(l.delivery.id);
            if (!p) return [{ l: "CRM prediction", v: "The CRM has no order for this party yet.", der: true }];
            const conf = p.isDefault ? "a default cycle, not yet measured" : p.confidence == null ? "measured" : `${p.confidence}% confident`;
            const differs = p.next && fig.nextOrder && p.next !== fig.nextOrder;
            return [
              { l: "CRM predicted next order", v: `${p.next ? fd(p.next) : "—"} (${conf})${differs ? " — the date the telecallers are working from" : ""}`, der: true },
            ];
          })(),
          contacts: phoneContacts(l.delivery.phone),
          actions: [
            {
              id: "edit",
              l: "Reminder and remark",
              primary: true,
              prompt: {
                title: "Follow-up",
                sub: `${l.delivery.name} · order ${l.o.orderNo}`,
                submit: "Save",
                fields: [
                  { k: "party", l: "Reminder days (party)", t: "num" },
                  { k: "product", l: "Reminder days (product)", t: "num" },
                  { k: "remark", l: "Remark", t: "area", mic: true },
                ],
                init: { party: f.reminderDaysParty == null ? "" : String(f.reminderDaysParty), product: f.reminderDaysProduct == null ? "" : String(f.reminderDaysProduct), remark: f.remark ?? "" },
              },
            },
          ],
        };
      }),
    };
  },
  actions: {
    async edit(ctx, id, v) {
      const party = int(v.party);
      const product = int(v.product);
      await db.update(erpFollowups).set({ reminderDaysParty: party, reminderDaysProduct: product, remark: text(v.remark), updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpFollowups.orderId, id));
      await erpAudit(ctx, "erp.followup.edit", "erp_followup", id, null, { party, product });
      return okVoid("Follow-up saved");
    },
  },
};

/** Party order pivot (spec §13.1, A-23): per delivery party and order, the previous order and the gap. */
const pivot: ScreenModule = {
  key: "pivot",
  async load() {
    const rows = await followRows();
    const seen = new Set<string>();
    const cols: ColSpec[] = [
      { k: "party", l: "Delivery party", t: "b" },
      { k: "orderNo", l: "Order no", t: "mono" },
      { k: "date", l: "Order date", t: "d" },
      { k: "last", l: "Last order date", t: "d" },
      { k: "diff", l: "Order diff (days)", t: "n" },
    ];
    return {
      spec: { screen: "pivot", cols, hidden: [], groups: ["party"], readOnly: true, download: true, noDataLine: "No orders to compare yet." },
      rows: rows
        .filter(({ l }) => {
          const k = `${l.delivery.id}|${l.o.orderNo}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .map(({ l, fig }) => ({
          id: `${l.delivery.id}|${l.o.orderNo}`,
          v: { party: l.delivery.name, orderNo: String(l.o.orderNo), date: l.o.orderDate, last: fig.lastParty, diff: fig.dayCountParty },
          flags: [],
          title: `${l.delivery.name} · order ${l.o.orderNo}`,
        })),
    };
  },
};

/* ============================================================ petty cash */

async function balances() {
  const [credits, expenses] = await Promise.all([db.select().from(erpCredits), db.select().from(erpExpenses)]);
  return cashBalances(
    credits.map((c) => ({ employee: c.employeeName, godownId: c.godownId, mode: c.mode, amountPaise: c.amountPaise })),
    expenses.map((e) => ({ employee: e.expenseBy, godownId: e.godownId, mode: e.mode, amountPaise: e.amountPaise })),
  );
}

async function staffNames(ctx: ErpContext): Promise<string[]> {
  const names = (await activeEmployees()).map((e) => e.name);
  return names.includes(ctx.user.name) ? names : [ctx.user.name, ...names];
}

async function cashForm(ctx: ErpContext, kind: "credit" | "expense"): Promise<FormSpec> {
  const [gds, names, notes, cats, parts] = await Promise.all([
    godownOptions(ctx, { lost: false }),
    staffNames(ctx),
    refValues("creditNote"),
    refValues("expenseCategory"),
    refValues("expenseParticular"),
  ]);
  const common: FieldSpec[] = [
    { k: "date", l: "Date", t: "date", req: true },
    { k: "godown", l: "Godown", t: "select", req: true, opts: gds.map((g) => g.name) },
    { k: "who", l: kind === "credit" ? "Employee" : "Expense by", t: "select", req: true, opts: names },
    { k: "mode", l: kind === "credit" ? "Credit mode" : "Expense mode", t: "select", req: true, opts: MODES },
  ];
  return kind === "credit"
    ? {
        screen: "credits",
        id: "new",
        title: "Give funds",
        submit: "Save credit",
        init: { date: today(), godown: ctx.workingGodown?.name ?? "", who: ctx.user.name },
        header: [...common, { k: "amount", l: "Credit amount (₹)", t: "num", req: true, min: 0.01 }, { k: "note", l: "Credit note", t: "select", opts: notes }],
      }
    : {
        screen: "expenses",
        id: "new",
        title: "New expense",
        submit: "Save expense",
        init: { date: today(), godown: ctx.workingGodown?.name ?? "", who: ctx.user.name },
        header: [
          ...common,
          { k: "category", l: "Category", t: "select", opts: cats },
          { k: "particular", l: "Particular", t: "select", opts: parts },
          { k: "amount", l: "Amount (₹)", t: "num", req: true, min: 0.01 },
          { k: "note", l: "Expense note", t: "area", mic: true },
        ],
      };
}

const credits: ScreenModule = {
  key: "credits",
  async load(ctx) {
    const [rows, bal] = await Promise.all([
      db.select({ c: erpCredits, godown: erpGodowns.name, by: users.name }).from(erpCredits).innerJoin(erpGodowns, eq(erpGodowns.id, erpCredits.godownId)).leftJoin(users, eq(users.id, erpCredits.createdById)).orderBy(desc(erpCredits.creditDate), desc(erpCredits.createdAt)),
      balances(),
    ]);
    const cols: ColSpec[] = [
      { k: "date", l: "Date", t: "d" },
      { k: "amount", l: "Amount", t: "m" },
      { k: "note", l: "Credit note", t: "t" },
      { k: "available", l: "Available", t: "m" },
      { k: "who", l: "Employee", t: "b" },
      { k: "mode", l: "Mode", t: "s" },
      { k: "godown", l: "Godown", t: "t" },
      { k: "id", l: "Credit id", t: "mono" },
    ];
    return {
      spec: { screen: "credits", cols, hidden: [], groups: ["godown", "mode"], godownKey: "godown", newForm: await cashForm(ctx, "credit"), newLabel: "Give funds", noDataLine: "No funds given yet." },
      rows: rows.map((r) => {
        const available = bal.get(cashKey(r.c.employeeName, r.c.godownId, r.c.mode)) ?? 0;
        return {
          id: r.c.id,
          v: { date: r.c.creditDate, amount: r.c.amountPaise, note: r.c.note, available, who: r.c.employeeName, mode: r.c.mode, godown: r.godown, id: r.c.id },
          flags: [],
          title: `${r.c.employeeName} · ${inr(r.c.amountPaise)}`,
          header: `${inr(available)} available · ${r.c.mode}`,
          actions: [{ id: "mode", l: "Change mode", prompt: { title: "Credit mode", submit: "Save", fields: [{ k: "mode", l: "Mode", t: "select", req: true, opts: MODES }], init: { mode: r.c.mode } } }],
          by: stampLine(r.by, r.c.createdAt),
        };
      }),
    };
  },
  forms: {
    async new(ctx, h) {
      const godownId = await godownIdByName(text(h.godown));
      if (!godownId) return fieldErr("godown", "Godown is required");
      const who = text(h.who);
      if (!who) return fieldErr("who", "Employee is required");
      const mode = text(h.mode);
      if (!mode || !MODES.includes(mode)) return fieldErr("mode", "Credit mode is required");
      const amount = paise(h.amount);
      if (amount == null || amount <= 0) return fieldErr("amount", "Credit amount is required");
      const id = erpId("cr");
      await db.insert(erpCredits).values({ id, creditDate: text(h.date) ?? today(), godownId, employeeName: who, mode, amountPaise: amount, note: text(h.note), createdById: ctx.user.id });
      await erpAudit(ctx, "erp.credit.create", "erp_credit", id, null, { who, amount, mode });
      return okVoid(`${inr(amount)} given to ${who}`);
    },
  },
  actions: {
    async mode(ctx, id, v) {
      const mode = text(v.mode);
      if (!mode || !MODES.includes(mode)) return fieldErr("mode", "Mode is required");
      await db.update(erpCredits).set({ mode, updatedAt: new Date() }).where(eq(erpCredits.id, id));
      await erpAudit(ctx, "erp.credit.mode", "erp_credit", id, null, { mode });
      return okVoid("Mode changed");
    },
  },
};

const expenses: ScreenModule = {
  key: "expenses",
  async load(ctx) {
    const [rows, bal] = await Promise.all([
      db.select({ e: erpExpenses, godown: erpGodowns.name, by: users.name }).from(erpExpenses).innerJoin(erpGodowns, eq(erpGodowns.id, erpExpenses.godownId)).leftJoin(users, eq(users.id, erpExpenses.createdById)).orderBy(desc(erpExpenses.expenseDate), desc(erpExpenses.createdAt)),
      balances(),
    ]);
    const cols: ColSpec[] = [
      { k: "date", l: "Date", t: "d" },
      { k: "particular", l: "Particular", t: "b" },
      { k: "amount", l: "Amount", t: "m" },
      { k: "note", l: "Note", t: "t" },
      { k: "available", l: "Available", t: "m" },
      { k: "mode", l: "Mode", t: "s" },
      { k: "godown", l: "Godown", t: "t" },
      { k: "status", l: "Status", t: "s" },
      { k: "who", l: "Expense by", t: "t" },
    ];
    const verifier = ctx.administrator || ctx.level === "manager";
    return {
      spec: {
        screen: "expenses",
        cols,
        hidden: [],
        groups: ["godown", "mode"],
        agg: { k: "available", l: "average available", t: "avg" },
        chips: "status",
        godownKey: "godown",
        bulk: verifier ? [{ id: "verify", l: "Verify" }] : undefined,
        newForm: await cashForm(ctx, "expense"),
        newLabel: "New expense",
        noDataLine: "No expenses yet.",
      },
      rows: rows.map((r) => {
        const available = bal.get(cashKey(r.e.expenseBy, r.e.godownId, r.e.mode)) ?? 0;
        return {
          id: r.e.id,
          v: { date: r.e.expenseDate, particular: r.e.particular ?? r.e.category ?? "Expense", amount: r.e.amountPaise, note: r.e.note, available, mode: r.e.mode, godown: r.godown, status: r.e.status, who: r.e.expenseBy },
          flags: available < 0 ? ["below"] : [],
          title: `${r.e.particular ?? "Expense"} · ${inr(r.e.amountPaise)}`,
          header: `${inr(available)} available · ${r.e.mode}`,
          fields: [{ l: "Category", v: r.e.category ?? "—" }],
          actions: [
            ...(r.e.status !== "Verify" ? [{ id: "verify", l: "Verify", primary: true, why: verifier ? "" : "A manager verifies expenses" } as ActionSpec] : [{ id: "pending", l: "Back to Pending", why: verifier ? "" : "A manager verifies expenses" } as ActionSpec]),
            { id: "amount", l: "Change amount", why: r.e.status === "Verify" ? "A verified expense is closed" : "", prompt: { title: "Amount", submit: "Save", fields: [{ k: "amount", l: "Amount (₹)", t: "num", req: true, min: 0.01 }], init: { amount: rupeesField(r.e.amountPaise) } } },
          ],
          by: stampLine(r.by, r.e.createdAt),
        };
      }),
    };
  },
  forms: {
    async new(ctx, h) {
      const godownId = await godownIdByName(text(h.godown));
      if (!godownId) return fieldErr("godown", "Godown is required");
      const who = text(h.who);
      if (!who) return fieldErr("who", "Expense by is required");
      const mode = text(h.mode);
      if (!mode || !MODES.includes(mode)) return fieldErr("mode", "Expense mode is required");
      const amount = paise(h.amount);
      if (amount == null || amount <= 0) return fieldErr("amount", "Amount is required");
      const id = erpId("exp");
      await db.insert(erpExpenses).values({ id, expenseDate: text(h.date) ?? today(), godownId, expenseBy: who, category: text(h.category), mode, particular: text(h.particular), amountPaise: amount, note: text(h.note), createdById: ctx.user.id, updatedById: ctx.user.id });
      await erpAudit(ctx, "erp.expense.create", "erp_expense", id, null, { who, amount, mode });
      const bal = (await balances()).get(cashKey(who, godownId, mode)) ?? 0;
      return okVoid(`Expense saved · ${inr(bal)} left with ${who}${bal < 0 ? " — more spent than given" : ""}`);
    },
  },
  actions: {
    verify: (ctx, id) => setExpenseStatus(ctx, [id], "Verify"),
    pending: (ctx, id) => setExpenseStatus(ctx, [id], "Pending"),
    async amount(ctx, id, v) {
      const amount = paise(v.amount);
      if (amount == null || amount <= 0) return fieldErr("amount", "Amount is required");
      const [e] = await db.select().from(erpExpenses).where(eq(erpExpenses.id, id));
      if (!e) return err("That expense no longer exists.", "not_found");
      if (e.status === "Verify") return err("A verified expense is closed.", "rule_violation");
      await db.update(erpExpenses).set({ amountPaise: amount, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpExpenses.id, id));
      await erpAudit(ctx, "erp.expense.amount", "erp_expense", id, { amountPaise: e.amountPaise }, { amountPaise: amount });
      return okVoid("Amount changed");
    },
  },
  bulk: { verify: (ctx, ids) => setExpenseStatus(ctx, ids, "Verify") },
};

async function setExpenseStatus(ctx: ErpContext, ids: string[], status: "Verify" | "Pending"): Promise<Result<unknown>> {
  if (!(ctx.administrator || ctx.level === "manager")) return err("A manager verifies expenses.", "not_permitted");
  await db.update(erpExpenses).set({ status, updatedAt: new Date(), updatedById: ctx.user.id }).where(inArray(erpExpenses.id, ids));
  await erpAudit(ctx, `erp.expense.${status.toLowerCase()}`, "erp_expense", ids.join(","));
  return okVoid(`${ids.length} expense${ids.length === 1 ? "" : "s"} ${status === "Verify" ? "verified" : "back to Pending"}`);
}

/* ========================================================= my customers */

const myCustomers: ScreenModule = {
  key: "myCustomers",
  async load(ctx) {
    const mine = await loadCustomers(or(eq(customers.salesAmId, ctx.user.id), sql`lower(${customers.salesPersonName}) = lower(${ctx.user.name})`));
    const ids = mine.map((c) => c.id);
    const reqs = ids.length ? await requestRows(sql`${erpRequests.customerId} in ${ids}` as unknown as ReturnType<typeof eq>) : [];
    const reqBy = new Map<string, number>();
    reqs.forEach((r) => reqBy.set(r.r.customerId, (reqBy.get(r.r.customerId) ?? 0) + (r.r.status === "Requested" ? 1 : 0)));
    const cols: ColSpec[] = [
      { k: "name", l: "Sales party", t: "b" },
      { k: "grade", l: "Grade", t: "s" },
      { k: "area", l: "Area", t: "t" },
      { k: "city", l: "Location", t: "t" },
      { k: "transporter", l: "Transport", t: "t" },
      { k: "payment", l: "Payment type", t: "s" },
      { k: "mobile", l: "Mobile", t: "ph" },
      { k: "credit", l: "Credit days", t: "n" },
      { k: "target", l: "Monthly target", t: "m" },
      { k: "open", l: "Open requests", t: "n" },
    ];
    return {
      spec: { screen: "myCustomers", cols, hidden: [], readOnly: false, noDataLine: "No customers are tagged to you as their sales person." },
      rows: mine.map((c) => ({
        id: c.id,
        v: {
          name: c.name,
          grade: c.p?.grade ?? null,
          area: c.area,
          city: c.city,
          transporter: c.p?.transporter ?? null,
          payment: c.freightTerm,
          mobile: c.phone,
          credit: c.creditDays,
          target: c.p?.monthlyTargetPaise ?? null,
          open: reqBy.get(c.id) ?? 0,
        },
        flags: [],
        title: c.name,
        header: `${c.city ?? ""}${c.area ? ` · ${c.area}` : ""}`,
        contacts: phoneContacts(c.phone, c.email),
        fields: reqs
          .filter((r) => r.r.customerId === c.id)
          .slice(0, 6)
          .map((r) => ({ l: `Request · ${fd(calendarDate(r.r.raisedAt))}`, v: `${r.r.complaintType ?? "Request"} — ${r.r.status}${r.r.cnAmountPaise ? ` · CN ${inr(r.r.cnAmountPaise)}` : ""}` })),
        actions: [{ id: "edit", l: "Edit", primary: true, loadsForm: true }],
      })),
    };
  },
  formLoaders: { edit: (_ctx, id) => customerForm(id, true) },
  forms: {
    async edit(ctx, h, _l, id) {
      if (!id) return err("No customer named.", "not_found");
      const [c] = await loadCustomers(and(eq(customers.id, id), or(eq(customers.salesAmId, ctx.user.id), sql`lower(${customers.salesPersonName}) = lower(${ctx.user.name})`)));
      if (!c) return err("That customer is not tagged to you.", "not_permitted");
      return saveCustomerDetails(ctx, id, h, true);
    },
  },
};

/* ================================================================ videos */

function youtubeId(url: string): string | null {
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{11})/);
  return m ? m[1] : null;
}

const videos: ScreenModule = {
  key: "videos",
  async load(ctx) {
    const [rows, tags] = await Promise.all([db.select({ v: erpVideos, by: users.name }).from(erpVideos).leftJoin(users, eq(users.id, erpVideos.createdById)).orderBy(desc(erpVideos.createdAt)), refValues("videoTag")]);
    const cols: ColSpec[] = [
      { k: "title", l: "Title", t: "b" },
      { k: "tags", l: "Tags", t: "t" },
      { k: "description", l: "Description", t: "t", w: 320 },
      { k: "source", l: "Source", t: "s" },
    ];
    const editor = ctx.administrator || ctx.level === "manager";
    return {
      spec: {
        screen: "videos",
        cols,
        hidden: [],
        newForm: editor
          ? {
              screen: "videos",
              id: "new",
              title: "Add a help video",
              submit: "Add video",
              init: { source: "From YouTube URL" },
              header: [
                { k: "title", l: "Title", t: "text", req: true },
                { k: "source", l: "Video from", t: "select", req: true, opts: ["From YouTube URL", "From File Upload"] },
                { k: "url", l: "YouTube URL", t: "text", req: true, when: { k: "source", eq: "From YouTube URL" } },
                { k: "file", l: "Video file", t: "video", req: true, when: { k: "source", eq: "From File Upload" } },
                { k: "tags", l: "Search tags", t: "multi", opts: tags },
                { k: "description", l: "Description", t: "area" },
              ],
            }
          : undefined,
        newLabel: "Add video",
        noDataLine: "No help videos yet.",
      },
      rows: rows.map((r) => {
        const yt = r.v.youtubeUrl ? youtubeId(r.v.youtubeUrl) : null;
        return {
          id: r.v.id,
          v: { title: r.v.title, tags: r.v.tags.join(", "), description: r.v.description, source: r.v.source === "youtube" ? "YouTube" : "File" },
          flags: [],
          title: r.v.title,
          header: r.v.tags.join(" · "),
          panel: { kind: "video", data: { youtube: yt, file: r.v.fileId, url: r.v.youtubeUrl } },
          actions: editor ? [{ id: "delete", l: "Delete", confirm: `Remove "${r.v.title}"?` }] : [],
          by: stampLine(r.by, r.v.createdAt),
        };
      }),
    };
  },
  forms: {
    async new(ctx, h) {
      if (!(ctx.administrator || ctx.level === "manager")) return err("A manager adds help videos.", "not_permitted");
      const title = text(h.title);
      if (!title) return fieldErr("title", "Title is required");
      const youtube = h.source !== "From File Upload";
      const url = youtube ? text(h.url) : null;
      if (youtube && (!url || !youtubeId(url))) return fieldErr("url", "Paste a YouTube link");
      const file = youtube ? null : text(h.file);
      if (!youtube && !file) return fieldErr("file", "Upload the video");
      const id = erpId("vid");
      await db.transaction(async (tx) => {
        await tx.insert(erpVideos).values({ id, title, source: youtube ? "youtube" : "file", youtubeUrl: url, fileId: file, tags: multi(h.tags), description: text(h.description), createdById: ctx.user.id });
        await bindErpFiles(tx as unknown as typeof db, [file], "erp_video", id, ctx.user.id);
      });
      await erpAudit(ctx, "erp.video.create", "erp_video", id, null, { title });
      return okVoid(`"${title}" added`);
    },
  },
  actions: {
    async delete(ctx, id) {
      if (!(ctx.administrator || ctx.level === "manager")) return err("A manager removes help videos.", "not_permitted");
      await db.delete(erpVideos).where(eq(erpVideos.id, id));
      await erpAudit(ctx, "erp.video.delete", "erp_video", id);
      return okVoid("Video removed");
    },
  },
};

export const LOGISTICS_SCREENS: ScreenModule[] = [
  transportList("transport"),
  transportList("pendingLr"),
  transportList("trackLr"),
  paidFreight,
  requestList("requests"),
  requestList("issueCn"),
  requestList("complaints"),
  pendingCn,
  followup,
  pivot,
  credits,
  expenses,
  myCustomers,
  videos,
];
