import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { attachments, bills, complaints, complaintStatusHistory, customers, employees, users } from "@/db/schema";
import { canFor } from "@/lib/access-control";
import { calendarDate } from "@/lib/business-date";
import { categoryLabel } from "@/lib/complaint-labels";
import { getConfig } from "@/lib/config/store";
import { err, fieldErr, okVoid, type Result } from "@/lib/result";
import { createComplaint } from "@/lib/services/complaint-create";
import type { ErpContext } from "../access";
import { erpAudit, paise, stampLine, text, type ScreenModule } from "../server";
import type { ActionSpec, ColSpec, FormSpec, ListRow } from "../ui";
import { fd, inr } from "../ui";
import { today } from "./common";
import { loadCustomers, phoneContacts } from "./masters";
import { traceBill, type Trace } from "../trace";

/* ---------------------------------------------------------------------------
 * COMPLAINTS AND CREDIT NOTES — the CRM's own records (spec §12.2, M13).
 *
 * Mahek Plus kept "customer requests" in a sheet of their own, and the first
 * ERP copied that into `erp_requests`: the same fields as a CRM complaint —
 * category, description, photo, mobile, whether a credit note is wanted, the
 * bill, the goods, the amount — in a second table. A complaint a salesman
 * raised in the ERP never reached the telecaller on the customer's next call,
 * and credit notes lived in two ledgers. So this screen reads and writes
 * `complaints`:
 *
 *  - raising goes through `createComplaint`, the writer the CRM uses;
 *  - accepting and rejecting are the complaint's own status, decided by the
 *    ERP's "decide requests" power as before;
 *  - a credit note is ISSUED through the Accounts credit-note service, so it
 *    comes off the bill like every other credit note, and needs Accounts'
 *    `creditnote.issue` — the ledger's decision, not the complaint desk's;
 *  - "Pending CN" and its "Credit Note Updater" are gone: they only copied an
 *    amount from one sheet to another, and the margin reads the credit note
 *    where it is.
 * ------------------------------------------------------------------------- */

export type ComplaintScope = "requests" | "issueCn" | "complaints";

/** The words Mahek Plus used for where a request stands, read off the complaint. */
export function requestStatus(c: { status: string; cnStatus: string | null }): "Requested" | "Accepted" | "Rejected" | "Resolved" {
  if (c.status === "rejected") return "Rejected";
  if (c.status === "resolved" || c.status === "closed" || c.cnStatus === "issued") return "Resolved";
  if (c.status === "open") return "Requested";
  return "Accepted";
}

type Row = {
  c: typeof complaints.$inferSelect;
  party: string;
  area: string | null;
  phone: string | null;
  by: string | null;
  billNo: string | null;
  billDate: string | null;
};

export async function complaintRows(where?: ReturnType<typeof eq>): Promise<Row[]> {
  const q = db
    .select({
      c: complaints,
      party: customers.name,
      area: customers.area,
      phone: customers.phone,
      by: users.name,
      billNo: bills.billNo,
      billDate: bills.billDate,
    })
    .from(complaints)
    .innerJoin(customers, eq(customers.id, complaints.customerId))
    .leftJoin(users, eq(users.id, complaints.loggedByUserId))
    .leftJoin(bills, eq(bills.id, complaints.billId));
  return (where ? q.where(where) : q).orderBy(desc(complaints.createdAt));
}

/** Requests still waiting for a decision, per customer — for My customers and the sidebar. */
export async function openRequestIds(): Promise<string[]> {
  return (await db.select({ id: complaints.id }).from(complaints).where(eq(complaints.status, "open"))).map((r) => r.id);
}

async function staff(): Promise<{ name: string; position: string | null }[]> {
  return db.select({ name: employees.name, position: employees.position }).from(employees).where(eq(employees.status, "active")).orderBy(employees.name);
}

/**
 * The bills a credit note may name: a customer's bills of the last year, with
 * the goods on each. Read off MahekOne's own bills and the order behind each —
 * the same bills Accounts credits against — never off a second list.
 */
async function billChoices(): Promise<{ bills: Record<string, string[]>; goods: Record<string, string[]>; billDate: Record<string, string> }> {
  const rows = (await db.execute(sql`
    select c.name as party, b.bill_no as bill, b.bill_date::text as date,
           coalesce((select array_agg(distinct x->>'product') from jsonb_array_elements(o.line_items) x), '{}') as goods
      from bills b
      join customers c on c.id = b.customer_id
      left join orders o on o.id = b.order_id
     where b.bill_date >= (now() at time zone 'Asia/Kolkata')::date - 365
     order by b.bill_date desc
  `)) as unknown as { party: string; bill: string; date: string; goods: string[] | null }[];
  const out = { bills: {} as Record<string, string[]>, goods: {} as Record<string, string[]>, billDate: {} as Record<string, string> };
  for (const r of rows) {
    (out.bills[r.party] ??= []).push(r.bill);
    out.goods[`${r.party}|${r.bill}`] = (r.goods ?? []).filter(Boolean);
    out.billDate[`${r.party}|${r.bill}`] = r.date;
  }
  return out;
}

async function requestForm(ctx: ErpContext, init?: Record<string, string>): Promise<FormSpec> {
  const [parties, people, config, choices] = await Promise.all([loadCustomers(), staff(), getConfig(), billChoices()]);
  const mobile: Record<string, string> = {};
  parties.forEach((p) => (mobile[p.name] = p.phone ?? ""));
  const me = people.find((s) => s.name.toLowerCase() === ctx.user.name.toLowerCase() && /sales/i.test(s.position ?? ""));
  const salesmen = people.filter((s) => /sales|office/i.test(s.position ?? "")).map((s) => s.name);
  return {
    screen: "requests",
    id: "new",
    title: "Raise a customer complaint",
    sub: "A complaint, or a credit note the customer is asking for. It lands on the customer's record in the CRM as well; the office decides.",
    submit: "Raise",
    init: { salesman: me?.name ?? "", cn: "No", ...init },
    data: { mobile, billDate: choices.billDate },
    header: [
      { k: "salesman", l: "Name of salesman", t: "select", opts: salesmen.length ? salesmen : people.map((s) => s.name) },
      { k: "customer", l: "Customer", t: "select", req: true, opts: parties.map((p) => p.name) },
      { k: "mobile", l: "Mobile number", t: "derived", calc: "request.mobile" },
      { k: "type", l: "Complaint type", t: "select", req: true, opts: config["complaints.categories"] },
      { k: "description", l: "Complaint description", t: "area", req: true, mic: true },
      { k: "photo", l: "Complaint picture", t: "photo" },
      { k: "cn", l: "Credit note required", t: "select", req: true, opts: ["Yes", "No"] },
      { k: "bill", l: "Bill number", t: "select", req: true, optsBy: { by: "customer", map: choices.bills }, when: { k: "cn", eq: "Yes" } },
      { k: "billDate", l: "Bill date", t: "derived", calc: "request.billDate", when: { k: "cn", eq: "Yes" } },
      { k: "goods", l: "Description of goods", t: "suggest", req: true, optsBy: { by: ["customer", "bill"], map: choices.goods }, when: { k: "cn", eq: "Yes" } },
    ],
  };
}

async function saveRequest(ctx: ErpContext, h: Record<string, string>): Promise<Result<unknown>> {
  const [c] = await loadCustomers(eq(customers.name, text(h.customer) ?? ""));
  if (!c) return fieldErr("customer", "Customer is required");
  const type = text(h.type);
  if (!type) return fieldErr("type", "Complaint type is required");
  const description = text(h.description);
  if (!description) return fieldErr("description", "Complaint description is required");
  const cn = h.cn === "Yes";
  let billId: string | null = null;
  const goods = cn ? text(h.goods) : null;
  if (cn) {
    const bill = text(h.bill);
    if (!bill) return fieldErr("bill", "Name the bill the credit note is against");
    const [b] = await db.select({ id: bills.id }).from(bills).where(and(eq(bills.billNo, bill), eq(bills.customerId, c.id)));
    if (!b) return fieldErr("bill", "That is not one of this customer's bills");
    if (!goods) return fieldErr("goods", "Name the goods the credit note is for");
    billId = b.id;
  }
  const id = await db.transaction(async (tx) => {
    const made = await createComplaint(
      {
        customerId: c.id,
        loggedById: ctx.user.id,
        loggedByName: ctx.user.name,
        category: type,
        description,
        mobileNumber: c.phone,
        requestCn: cn,
        billId,
        goodsDescription: goods,
        salesmanName: text(h.salesman),
      },
      tx,
    );
    await bindComplaintFiles(tx, [text(h.photo)], made, ctx.user.id);
    return made;
  });
  await erpAudit(ctx, "erp.request.create", "complaint", id, null, { customer: c.name, type, cn });
  return okVoid(`Complaint raised for ${c.name} · on their CRM record too, waiting for the office`);
}

/** A file taken on the ERP form becomes the complaint's own attachment, read under the complaint's rules. */
async function bindComplaintFiles(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], ids: (string | null)[], complaintId: string, userId: string) {
  const list = ids.filter((x): x is string => !!x);
  if (!list.length) return;
  await tx
    .update(attachments)
    .set({ parentType: "complaint", parentId: complaintId, updatedAt: new Date() })
    .where(and(inArray(attachments.id, list), sql`${attachments.parentId} is null`, eq(attachments.uploadedById, userId)));
}

async function history(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], complaintId: string, from: string, to: string, by: string, note: string) {
  await tx.insert(complaintStatusHistory).values({ id: `csh_${randomUUID().slice(0, 12)}`, complaintId, fromStatus: from as never, toStatus: to as never, changedById: by, note });
}

async function decide(ctx: ErpContext, ids: string[], verdict: "Accepted" | "Rejected"): Promise<Result<unknown>> {
  if (!ctx.powers.has("decideRequests")) return err("Only an admin or the office decides a request.", "not_permitted");
  const rows = await db.select().from(complaints).where(inArray(complaints.id, ids));
  const open = rows.filter((c) => (verdict === "Accepted" ? c.status === "open" : c.status !== "rejected" && c.status !== "resolved" && c.status !== "closed"));
  if (!open.length) return err(`Already ${verdict === "Accepted" ? "decided" : "Rejected"}.`, "conflict");
  await db.transaction(async (tx) => {
    for (const c of open) {
      const to = verdict === "Accepted" ? "in_progress" : "rejected";
      await tx
        .update(complaints)
        .set({
          status: to,
          cnStatus: c.requestCn && c.cnStatus !== "issued" ? (verdict === "Accepted" ? "under_review" : "rejected") : c.cnStatus,
          updatedAt: new Date(),
          updatedById: ctx.user.id,
        })
        .where(eq(complaints.id, c.id));
      await history(tx, c.id, c.status, to, ctx.user.id, `${verdict} in the ERP by ${ctx.user.name}`);
    }
  });
  await erpAudit(ctx, `erp.request.${verdict.toLowerCase()}`, "complaint", open.map((c) => c.id).join(","));
  return okVoid(`${open.length} request${open.length === 1 ? "" : "s"} ${verdict}`);
}

/**
 * AI-6 for the decider: each complaint's trace, the others sharing its lots
 * inside the window (a possible batch problem at the threshold), who made what
 * was traced, and the customer's earlier complaints. All deterministic.
 */
async function assist(rows: Row[]): Promise<Map<string, ListRow["panel"]>> {
  const out = new Map<string, ListRow["panel"]>();
  const c = await getConfig();
  if (!c["erp.ai.complaints.enabled"]) return out;
  const threshold = c["erp.ai.complaints.clusterThreshold"];
  const since = Date.now() - c["erp.ai.complaints.clusterDays"] * 86400000;
  const traces = new Map<string, Trace>();
  for (const x of rows) if (x.billNo) traces.set(x.c.id, await traceBill(x.c.customerId, x.billNo, x.c.goodsDescription));
  for (const x of rows) {
    const t = traces.get(x.c.id);
    const mine = new Set((t?.lots ?? []).filter((l) => !l.startsWith("pack:")));
    const sharing = rows.filter((o) => {
      if (o.c.id === x.c.id || o.c.status === "rejected" || o.c.createdAt.getTime() < since) return false;
      return (traces.get(o.c.id)?.lots ?? []).some((l) => mine.has(l));
    });
    const previous = rows.filter((o) => o.c.customerId === x.c.customerId && o.c.createdAt < x.c.createdAt).slice(0, 5);
    out.set(x.c.id, {
      kind: "trace",
      data: {
        steps: t?.steps ?? [],
        missing: t ? t.missing : ["This complaint names no bill, so there is nothing to trace."],
        cluster: sharing.length + 1 >= threshold ? { count: sharing.length + 1, parties: [...new Set(sharing.map((o) => o.party))], lots: [...mine].filter((l) => sharing.some((o) => traces.get(o.c.id)?.lots.includes(l))) } : null,
        people: t?.people ?? [],
        previous: previous.map((o) => ({ date: calendarDate(o.c.createdAt), type: categoryLabel(o.c.category), status: requestStatus(o.c), cn: o.c.cnAmount })),
      },
    });
  }
  return out;
}

function toRow(ctx: ErpContext, x: Row, files: Map<string, string[]>, canIssue: boolean, panel?: ListRow["panel"], ai?: { on: boolean; pending: boolean; summary?: string }): ListRow {
  const c = x.c;
  const word = requestStatus(c);
  const decider = ctx.powers.has("decideRequests");
  const why = decider ? "" : "Only an admin or the office decides a request";
  const actions: ActionSpec[] = [];
  if (word === "Requested") actions.push({ id: "accept", l: "Accepted", primary: true, why });
  if (word === "Requested" || word === "Accepted") actions.push({ id: "reject", l: "Rejected", why, confirm: `Reject the complaint from ${x.party}?` });
  if (word === "Accepted" && c.requestCn)
    actions.push({
      id: "issue",
      l: "Issue Credit Note",
      primary: true,
      why: canIssue ? "" : "Accounts issue credit notes — it comes off the bill in the ledger",
      prompt: {
        title: "Issue the credit note",
        sub: `${x.party} · bill ${x.billNo ?? "on account"} · ${c.goodsDescription ?? ""}. It is credited against the bill in Accounts, as every credit note is.`,
        submit: "Issue",
        fields: [
          { k: "amount", l: "Credit note amount (₹, as it comes off the bill)", t: "num", req: true, min: 0.01 },
          { k: "date", l: "Credit note date", t: "date", req: true },
          { k: "number", l: "Credit note number", t: "text", req: true },
          { k: "remark", l: "Remark", t: "area" },
          { k: "file", l: "Credit note file", t: "photo" },
        ],
        init: { date: today() },
      },
    });
  if (word === "Accepted" && !c.requestCn)
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
      },
    });
  if (ai?.pending) {
    actions.unshift({ id: "aiComplaint", l: "Review the suggestion", ai: true, primary: true, loadsForm: true });
    actions.push({ id: "aiComplaintReject", l: "Reject the suggestion", confirm: "Reject the suggested type and summary?" });
  } else if (ai?.on && c.description) actions.push({ id: "aiComplaintRead", l: "Suggest type and summary", ai: true });
  actions.push({ id: "more", l: "Add More Credit", loadsForm: true });
  actions.push({ id: "customer", l: "View customer", href: `/erp/customers?open=${c.customerId}` });
  for (const f of files.get(c.id) ?? []) actions.push({ id: `file-${f}`, l: "Open attachment", href: `/api/attachments/${f}` });
  const response = c.resolvedAt ? Math.round((c.resolvedAt.getTime() - c.createdAt.getTime()) / 3600000) : null;
  return {
    id: c.id,
    v: {
      raised: calendarDate(c.createdAt),
      status: word,
      salesman: c.salesmanName ?? x.by,
      party: x.party,
      mobile: c.mobileNumber ?? x.phone,
      type: categoryLabel(c.category),
      cn: c.requestCn ? "Yes" : "No",
      bill: x.billNo,
      goods: c.goodsDescription,
      amount: c.cnAmount,
      description: c.description,
    },
    flags: [word === "Accepted" ? "accepted" : word === "Rejected" ? "rejected" : word === "Resolved" ? "resolved" : "requested"],
    title: x.party,
    header: `${categoryLabel(c.category)} · raised ${fd(calendarDate(c.createdAt))}`,
    fields: [
      ...(ai?.summary ? [{ l: "Summary (confirmed)", v: ai.summary }] : []),
      { l: "Area", v: x.area ?? "—", der: true },
      { l: "Bill date", v: x.billDate ? fd(x.billDate) : "—" },
      { l: "Credit note", v: c.cnStatus === "issued" ? `${inr(c.cnAmount)} · ${c.cnReference ?? "no number"}${c.cnDate ? ` · ${fd(c.cnDate)}` : ""}` : c.requestCn ? (c.cnStatus ?? "requested").replace("_", " ") : "Not asked for" },
      { l: "Resolution", v: c.resolutionNotes ?? "—" },
      { l: "Response time", v: response == null ? "—" : response < 48 ? `${response} h` : `${Math.round(response / 24)} days`, der: true },
      { l: "Month", v: calendarDate(c.createdAt).slice(0, 7), der: true },
    ],
    contacts: phoneContacts(c.mobileNumber ?? x.phone),
    panel,
    actions,
    by: stampLine(x.by, c.createdAt),
  };
}

function complaintList(scope: ComplaintScope): ScreenModule {
  return {
    key: scope,
    async load(ctx) {
      const rows = await complaintRows(scope === "issueCn" ? eq(complaints.requestCn, true) : scope === "complaints" ? eq(complaints.requestCn, false) : undefined);
      const fileRows = rows.length
        ? await db
            .select({ parent: attachments.parentId, id: attachments.id })
            .from(attachments)
            .where(and(eq(attachments.parentType, "complaint"), eq(attachments.status, "available"), inArray(attachments.parentId, rows.map((r) => r.c.id))))
        : [];
      const files = new Map<string, string[]>();
      fileRows.forEach((f) => f.parent && files.set(f.parent, [...(files.get(f.parent) ?? []), f.id]));
      const canIssue = await canFor(ctx.user, "creditnote.issue");
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
      const ai = await import("../ai");
      const cmp = await import("../ai-complaints");
      const [panels, on, pend, summaries] = await Promise.all([assist(rows), ai.featureState("complaints").then((s) => s.on), ai.pendingFor("complaints"), cmp.confirmedSummaries(rows.map((x) => x.c.id))]);
      return {
        spec: {
          screen: scope,
          cols,
          hidden: [],
          groups: scope === "requests" ? ["status"] : scope === "complaints" ? ["type"] : undefined,
          chips: "status",
          bulk: decider ? [{ id: "accept", l: "Accepted" }, { id: "reject", l: "Rejected", confirm: "Reject every selected complaint?" }] : undefined,
          newForm: await requestForm(ctx),
          newLabel: "Raise complaint",
          noDataLine: scope === "issueCn" ? "No credit notes asked for." : scope === "complaints" ? "No complaints without a credit note." : "No customer complaints yet.",
        },
        rows: rows.map((x) => toRow(ctx, x, files, canIssue, panels.get(x.c.id), { on, pending: pend.has(x.c.id), summary: summaries.get(x.c.id) })),
      };
    },
    forms: {
      new: (ctx, h) => saveRequest(ctx, h),
      aiComplaint: async (ctx, h, _l, id) => (id ? (await import("../ai-complaints")).applyComplaint(ctx, id, h) : err("No suggestion named.", "not_found")),
    },
    formLoaders: {
      aiComplaint: async (_ctx, id) => (await import("../ai-complaints")).complaintReviewForm(scope, id),
      async more(ctx, id) {
        const [x] = await complaintRows(eq(complaints.id, id));
        if (!x) return null;
        const f = await requestForm(ctx, { salesman: x.c.salesmanName ?? "", customer: x.party, type: categoryLabel(x.c.category), description: x.c.description, cn: x.c.requestCn ? "Yes" : "No", bill: x.billNo ?? "" });
        return { ...f, title: "Raise another credit note for this bill" };
      },
    },
    actions: {
      aiComplaintRead: async (ctx, id) => (await import("../ai-complaints")).suggestComplaint(ctx, id),
      aiComplaintReject: async (ctx, id) => (await import("../ai-complaints")).rejectComplaint(ctx, id),
      accept: (ctx, id) => decide(ctx, [id], "Accepted"),
      reject: (ctx, id) => decide(ctx, [id], "Rejected"),
      async issue(ctx, id, v) {
        const [c] = await db.select().from(complaints).where(eq(complaints.id, id));
        if (!c) return err("That complaint no longer exists.", "not_found");
        if (requestStatus(c) !== "Accepted" || !c.requestCn) return err("A credit note is issued on an accepted credit-note request.", "rule_violation");
        const amount = paise(v.amount);
        if (amount == null || amount <= 0) return fieldErr("amount", "Credit note amount is required");
        const number = text(v.number);
        if (!number) return fieldErr("number", "Credit note number is required");
        /* The Accounts service decides it: its capability, its ledger entry,
           its limit of what is still open on the bill. */
        const { issueCreditNote } = await import("@/lib/services/credit-note-service");
        const issued = await issueCreditNote({ complaintId: id, amount, reference: number });
        if (!issued.ok) return issued;
        const remark = text(v.remark);
        await db.transaction(async (tx) => {
          await tx
            .update(complaints)
            .set({ cnDate: text(v.date) ?? today(), status: "resolved", resolvedAt: new Date(), resolvedById: ctx.user.id, resolutionNotes: [`Credit note ${number} issued`, remark].filter(Boolean).join(" · "), updatedAt: new Date(), updatedById: ctx.user.id })
            .where(eq(complaints.id, id));
          await history(tx, id, c.status, "resolved", ctx.user.id, `Credit note ${number} issued from the ERP`);
          await bindComplaintFiles(tx, [text(v.file)], id, ctx.user.id);
        });
        await erpAudit(ctx, "erp.request.issueCn", "complaint", id, null, { amount, number });
        return okVoid(`Credit note ${number} issued · ${inr(amount)} off the bill`);
      },
      async resolve(ctx, id, v) {
        if (!ctx.powers.has("decideRequests")) return err("Only an admin or the office resolves a complaint.", "not_permitted");
        const remark = text(v.remark);
        const responsible = text(v.responsible);
        if (!remark) return fieldErr("remark", "Remark is required");
        if (!responsible) return fieldErr("responsible", "Responsible employee is required");
        const [c] = await db.select().from(complaints).where(eq(complaints.id, id));
        if (!c) return err("That complaint no longer exists.", "not_found");
        if (requestStatus(c) !== "Accepted" || c.requestCn) return err("A complaint is resolved once it is accepted.", "rule_violation");
        await db.transaction(async (tx) => {
          await tx
            .update(complaints)
            .set({ status: "resolved", resolvedAt: new Date(), resolvedById: ctx.user.id, resolutionNotes: `${remark} · Responsible: ${responsible}`, updatedAt: new Date(), updatedById: ctx.user.id })
            .where(eq(complaints.id, id));
          await history(tx, id, c.status, "resolved", ctx.user.id, `Resolved in the ERP by ${ctx.user.name}`);
        });
        await erpAudit(ctx, "erp.request.resolve", "complaint", id, null, { remark, responsible });
        return okVoid("Complaint resolved");
      },
    },
    bulk: {
      accept: (ctx, ids) => decide(ctx, ids, "Accepted"),
      reject: (ctx, ids) => decide(ctx, ids, "Rejected"),
    },
  };
}

/**
 * Credit notes issued against a bill, per customer, bill number and goods —
 * what an order line's margin gives back. Read where the credit note IS, so
 * nothing has to copy it onto the order line first.
 */
export async function issuedCreditNotes(): Promise<Map<string, number>> {
  const rows = (await db.execute(sql`
    select c.customer_id as customer, b.bill_no as bill, c.goods_description as goods, sum(c.cn_amount)::bigint as amount
      from complaints c
      join bills b on b.id = c.bill_id
     where c.cn_status = 'issued' and c.cn_amount is not null
     group by 1, 2, 3
  `)) as unknown as { customer: string; bill: string; goods: string | null; amount: string | number }[];
  return new Map(rows.map((r) => [`${r.customer}|${r.bill}|${r.goods ?? ""}`, Number(r.amount)]));
}

export const COMPLAINT_SCREENS: ScreenModule[] = [complaintList("requests"), complaintList("issueCn"), complaintList("complaints")];
