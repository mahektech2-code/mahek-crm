import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { employees, erpExpenseAdjustments, erpExpenses } from "@/db/schema";
import { err, fieldErr, type Result } from "@/lib/result";
import type { ErpContext } from "../access";
import { paise, rupeesField, stampLine, text, type ScreenModule, type Values } from "../server";
import type { ActionSpec, ColSpec, FieldSpec, FormSpec, ListRow, SummaryCard } from "../ui";
import { fd, inr } from "../ui";
import { refValues } from "../refs";
import { today } from "./common";
import {
  AGEING_BUCKETS,
  APPROVAL_LABEL,
  APPROVAL_LEVEL_LABEL,
  DOC_STATUS_LABEL,
  EVIDENCE_KINDS,
  PETTY_TXN_TYPES,
  type ApprovalStatus,
} from "../engines/petty-cash";
import { evidenceFor, evidenceLinks, nameOf, pettyRoles, userNames, WHY } from "../petty/core";
import {
  addExpenseEvidence,
  approvalHistory,
  approveDocException,
  cancelExpense,
  cancelPaymentRequest,
  confirmPaymentRequest,
  createExpense,
  decideExpense,
  decideExpenseAdjustment,
  editExpense,
  markReceived,
  recordPayment,
  requestExpenseAdjustment,
  reversePayment,
  submitExpense,
  verifyPayment,
  type ExpenseInput,
  type PaymentInput,
} from "../petty/expenses";
import { requestFundAdjustment } from "../petty/funds";
import { isPayable, loadExpenses, loadPayments, payableWord, RECON_WORD, TALLY_WORD, tallyByRecord, type ExpenseFact } from "../petty/facts";
import { activeFunds, fundLabel, lookups, openExpense, paymentFields, requestKey, yes, type PettyLookups } from "./petty-shared";

/* ---------------------------------------------------------------------------
 * Petty cash → Expenses, Payments and Vendor outstanding. An expense and its
 * payments are separate records, drawn on separate tabs and joined in the
 * drawer: what was billed, what was paid against it from which fund, what is
 * left, and who approved it.
 * ------------------------------------------------------------------------- */

const SITUATIONS = ["Unpaid — pending payment", "Paid in full now", "Part paid now", "Advance paid now"] as const;
const DOC_OPTS = ["Attached", "To follow", "Not available"];
const DOC_FROM: Record<string, string> = { Attached: "attached", "To follow": "to_follow", "Not available": "not_available" };
const SUBMIT_OPTS = ["Submit for approval", "Save as draft"];
const RECEIVED_OPTS = ["Received", "Not yet received (a commitment)"];
const NOT_DUP = "Yes — it is a separate expense";

async function staffNames(ctx: ErpContext): Promise<string[]> {
  const rows = await db.select({ name: employees.name }).from(employees).where(eq(employees.status, "active"));
  const names = [...new Set(rows.map((r) => r.name))].sort();
  return names.includes(ctx.user.name) ? names : [ctx.user.name, ...names];
}

/* ============================================================ the form */

async function expenseForm(ctx: ErpContext, l: PettyLookups, edit?: ExpenseFact): Promise<FormSpec> {
  const [names, parts] = await Promise.all([staffNames(ctx), refValues("expenseParticular")]);
  const cats = l.categories.filter((c) => c.active || c.id === edit?.e.categoryId).map((c) => c.name);
  const header: FieldSpec[] = [
    { k: "date", l: "Expense date", t: "date", req: true, sec: "What it was" },
    { k: "particular", l: "Particular", t: "text", req: true, hint: parts.length ? `What it was for, in a few words — e.g. ${parts.slice(0, 3).join(", ")}` : "What it was for, in a few words" },
    { k: "category", l: "Category", t: "select", req: true, opts: cats },
    { k: "txnType", l: "Transaction type", t: "select", req: true, opts: [...PETTY_TXN_TYPES] },
    { k: "godown", l: "Godown", t: "select", req: true, opts: l.godowns.map((g) => g.name) },
    { k: "expenseBy", l: "Spent by", t: "select", opts: names },
    { k: "department", l: "Department", t: "text", hint: "Optional — for department budgets" },
    { k: "vendor", l: "Vendor / payee", t: "text", sec: "The bill", hint: "As on the bill. A name that matches an ERP supplier is linked to it" },
    { k: "amount", l: "Total amount (₹)", t: "num", req: true, min: 0.01 },
    { k: "billNo", l: "Bill / invoice / reference no.", t: "text" },
    { k: "billDate", l: "Bill date", t: "date" },
    { k: "termsDays", l: "Payment terms (days)", t: "num", min: 0, hint: "Due date is the bill date plus this, unless a due date is given" },
    { k: "dueDate", l: "Due date", t: "date" },
    { k: "received", l: "Goods / service", t: "select", req: true, opts: RECEIVED_OPTS, hint: "A commitment is not an expense yet — it becomes one when received" },
    { k: "docStatus", l: "Bill / receipt", t: "select", req: true, opts: DOC_OPTS },
    { k: "file", l: "Bill or receipt photo", t: "photo", when: { k: "docStatus", eq: "Attached" }, reqWhen: { k: "docStatus", eq: "Attached" } },
    { k: "remarks", l: "Remarks / purpose", t: "area", mic: true, wide: true, reqWhen: { k: "txnType", eq: "Other" } },
  ];
  if (!edit) {
    header.push(
      { k: "situation", l: "Payment", t: "select", req: true, opts: [...SITUATIONS], sec: "Payment", hint: "The payment status is worked out from the payments — this only records one made now" },
      { k: "payAmount", l: "Paid now (₹)", t: "num", min: 0.01, when: { k: "situation", in: ["Part paid now", "Advance paid now"] }, reqWhen: { k: "situation", in: ["Part paid now", "Advance paid now"] } },
      ...paymentFields(l, "pay").map((f) => ({ ...f, when: { k: "situation", in: ["Paid in full now", "Part paid now", "Advance paid now"] } as FieldSpec["when"] })),
      { k: "payAckName", l: "Received by (payee's name)", t: "text", when: { k: "situation", in: ["Paid in full now", "Part paid now", "Advance paid now"] }, hint: "A cash payment needs the payee's acknowledgement" },
      { k: "payAckFile", l: "Signed slip / acknowledgement", t: "photo", when: { k: "situation", in: ["Paid in full now", "Part paid now", "Advance paid now"] } },
      { k: "urgentReason", l: "Why it could not wait for approval", t: "area", when: { k: "situation", in: ["Paid in full now", "Part paid now", "Advance paid now"] }, hint: "Only asked if the expense is not approved on submission: paying first is an urgent payment" },
    );
  }
  header.push(
    { k: "submitAs", l: "Save as", t: "select", req: true, opts: SUBMIT_OPTS, sec: "Save" },
    { k: "notDuplicate", l: "If warned of a duplicate", t: "select", opts: [NOT_DUP], hint: "Only if MahekOne warns that this looks like an expense already recorded" },
  );
  const e = edit?.e;
  return {
    screen: "expenses",
    id: edit ? "edit" : "new",
    recordId: e?.id,
    title: edit ? `Edit ${e!.code}` : "New expense",
    sub: edit ? "A draft or a returned expense. Once submitted it is corrected by an adjustment, never edited." : "Record what was bought or spent. Paying it is a separate step — an expense can wait unpaid.",
    submit: edit ? "Save" : "Save expense",
    header,
    init: e
      ? {
          date: e.expenseDate,
          particular: e.particular ?? "",
          category: edit!.category ?? "",
          txnType: e.txnType ?? "",
          godown: edit!.godown,
          expenseBy: e.expenseBy,
          department: e.department ?? "",
          vendor: e.vendorName ?? "",
          amount: rupeesField(e.amountPaise),
          billNo: e.billNo ?? "",
          billDate: e.billDate ?? "",
          termsDays: e.paymentTermsDays == null ? "" : String(e.paymentTermsDays),
          dueDate: e.dueDate ?? "",
          received: e.incurred ? RECEIVED_OPTS[0] : RECEIVED_OPTS[1],
          docStatus: e.docStatus === "attached" ? "Attached" : e.docStatus === "not_available" ? "Not available" : "To follow",
          remarks: e.note ?? "",
          submitAs: "Submit for approval",
          version: String(e.version),
        }
      : { date: today(), godown: ctx.workingGodown?.name ?? "", expenseBy: ctx.user.name, received: RECEIVED_OPTS[0], docStatus: "Attached", situation: SITUATIONS[0], submitAs: SUBMIT_OPTS[0], requestKey: requestKey() },
  };
}

function inputFrom(h: Values, l: PettyLookups): ExpenseInput {
  const situation = text(h.situation) ?? SITUATIONS[0];
  const paying = situation !== SITUATIONS[0];
  const amount = paise(h.amount);
  const fund = l.fundByLabel.get(text(h.payfund) ?? "");
  return {
    date: text(h.date) ?? "",
    particular: text(h.particular),
    category: text(h.category),
    txnType: text(h.txnType),
    godownId: l.godownByName.get(text(h.godown) ?? "") ?? null,
    vendorName: text(h.vendor),
    amountPaise: amount,
    billNo: text(h.billNo),
    billDate: text(h.billDate),
    dueDate: text(h.dueDate),
    termsDays: text(h.termsDays) == null ? null : Math.max(0, Math.trunc(Number(h.termsDays))),
    remarks: text(h.remarks),
    docStatus: DOC_FROM[text(h.docStatus) ?? ""] ?? "to_follow",
    fileId: text(h.file),
    department: text(h.department),
    incurred: text(h.received) !== RECEIVED_OPTS[1],
    expenseBy: text(h.expenseBy),
    submit: text(h.submitAs) !== "Save as draft",
    notDuplicate: text(h.notDuplicate) === NOT_DUP,
    payNow: paying
      ? {
          date: text(h.date) ?? today(),
          amountPaise: situation === "Paid in full now" ? amount : paise(h.payAmount),
          fundId: fund?.id ?? null,
          mode: text(h.paymode),
          reference: text(h.payreference),
          ackName: text(h.payAckName),
          ackFileId: text(h.payAckFile),
          evidenceFileId: text(h.file),
          urgentReason: text(h.urgentReason),
          requestKey: text(h.requestKey),
        }
      : null,
  };
}

/** Field names on the payment sub-form map onto the expense form's `pay*` fields. */
function mapPayErrors(r: Result<unknown>): Result<unknown> {
  if (r.ok || !r.fieldErrors?.length) return r;
  const map: Record<string, string> = { fund: "payfund", mode: "paymode", reference: "payreference", ackName: "payAckName", amount: "payAmount", evidence: "file", urgentReason: "urgentReason" };
  return { ...r, fieldErrors: r.fieldErrors.map((f) => ({ ...f, field: map[f.field] ?? f.field })) };
}

/* ===================================================== the pay form */

function payForm(f: ExpenseFact, l: PettyLookups, roles: ReturnType<typeof pettyRoles>, asRequest: boolean): FormSpec {
  const approved = f.e.approvalStatus === "approved";
  const left = f.state.payablePaise - f.state.paidPaise - f.state.requestedPaise;
  const header: FieldSpec[] = [
    { k: "date", l: "Payment date", t: "date", req: true },
    { k: "amount", l: "Amount (₹)", t: "num", req: true, min: 0.01, max: left / 100, hint: `${inr(left)} left to pay` },
    ...paymentFields(l).map((x) => (x.k === "fund" || x.k === "mode" ? { ...x, req: true } : x)),
    { k: "payee", l: "Payee", t: "text" },
    { k: "ackName", l: "Received by (payee's name)", t: "text", hint: "For cash: who took the money" },
    { k: "ackFile", l: "Signed slip / acknowledgement", t: "photo" },
    { k: "evidence", l: "Proof (UPI screenshot, receipt)", t: "photo", hint: "A screenshot is evidence, not reconciliation — the statement reconciles it" },
    { k: "split", l: "Same transfer pays several bills", t: "select", opts: ["Yes"], hint: "Only where one UPI/UTR reference paid this and another expense" },
  ];
  if (!approved && !asRequest) header.push({ k: "urgentReason", l: "Why it could not wait for approval", t: "area", req: true, hint: "This expense is not approved yet: paying it now is an urgent payment, flagged until it is approved" });
  if (!asRequest && (roles.approve || roles.owner)) {
    header.push(
      { k: "overdrawReason", l: "Authorise paying beyond the fund (approver)", t: "area", hint: "Only if the fund holds less than this payment" },
      { k: "evidenceExceptionReason", l: "Authorise cash with no acknowledgement (approver)", t: "area" },
    );
  }
  return {
    screen: "expenses",
    id: asRequest ? "request" : "pay",
    recordId: f.e.id,
    title: asRequest ? `Request payment · ${f.e.code}` : `Record payment · ${f.e.code}`,
    sub: asRequest
      ? "A request moves no money. Accounts confirm it once it is actually paid, and only then does the fund go down."
      : "Money that has actually left the fund. It goes down once, now, and the expense's status is worked out again.",
    submit: asRequest ? "Request payment" : "Record payment",
    header,
    init: { date: today(), amount: rupeesField(left), payee: f.e.vendorName ?? "", requestKey: requestKey() },
  };
}

function payInput(h: Values, l: PettyLookups, asRequest: boolean): PaymentInput {
  return {
    date: text(h.date) ?? today(),
    amountPaise: paise(h.amount),
    fundId: l.fundByLabel.get(text(h.fund) ?? "")?.id ?? null,
    mode: text(h.mode),
    reference: text(h.reference),
    payee: text(h.payee),
    ackName: text(h.ackName),
    ackFileId: text(h.ackFile),
    evidenceFileId: text(h.evidence),
    urgentReason: text(h.urgentReason),
    overdrawReason: text(h.overdrawReason),
    evidenceExceptionReason: text(h.evidenceExceptionReason),
    splitReference: yes(h.split),
    asRequest,
    requestKey: text(h.requestKey),
  };
}

/* ======================================================= the drawer */

async function expenseRow(ctx: ErpContext, f: ExpenseFact, l: PettyLookups, names: Map<string, string>, evidence: Map<string, ReturnType<typeof evidenceLinks>>, advances: ExpenseFact[], bills: ExpenseFact[]): Promise<ListRow> {
  const e = f.e;
  const roles = pettyRoles(ctx);
  const approver = roles.approve || roles.owner;
  const maker = e.createdById === ctx.actor.id || e.submittedById === ctx.actor.id || e.expenseBy.trim().toLowerCase() === ctx.actor.name.trim().toLowerCase();
  const waiting = e.approvalStatus === "submitted" || e.approvalStatus === "under_review";
  const editable = !e.legacy && (e.approvalStatus === "draft" || e.approvalStatus === "returned");
  const left = f.state.payablePaise - f.state.paidPaise - f.state.requestedPaise;
  const payWhy = e.legacy
    ? "Recorded before the ledger"
    : !e.incurred && !e.isAdvance
      ? "Not received yet — mark it received first"
      : !["approved", "submitted", "under_review"].includes(e.approvalStatus)
        ? "Submit it first"
        : left <= 0
          ? "Nothing left to pay"
          : "";
  const decideWhy = !waiting ? "It is not waiting for a decision" : maker ? "Nobody approves an expense they raised, submitted or spent" : e.approvalLevel === "owner" && !roles.owner ? WHY.owner : !approver ? WHY.approve : "";
  const pendingAdj = f.adjustments.filter((a) => a.status === "requested");
  const actions: ActionSpec[] = [];
  if (editable && (e.createdById === ctx.actor.id || ctx.administrator)) {
    actions.push({ id: "submit", l: "Submit for approval", primary: true, confirm: `Submit ${e.code} for approval? It cannot be edited after this — only adjusted.` });
    actions.push({ id: "edit", l: "Edit", loadsForm: true });
  }
  if (!e.legacy && waiting) {
    actions.push({ id: "approve", l: "Approve", primary: !decideWhy, why: decideWhy, confirm: `Approve ${e.code} for ${inr(e.amountPaise)}? Approval does not pay it.` });
    actions.push({ id: "return", l: "Return for correction", why: decideWhy, prompt: { title: `Return ${e.code}`, submit: "Return", fields: [{ k: "comment", l: "What needs correcting", t: "area", req: true }] } });
    actions.push({ id: "reject", l: "Reject", why: decideWhy, prompt: { title: `Reject ${e.code}`, submit: "Reject", fields: [{ k: "comment", l: "Why it is rejected", t: "area", req: true }] } });
    if (e.approvalStatus === "submitted") actions.push({ id: "review", l: "Take for review", why: decideWhy });
  }
  if (!e.legacy && !["draft", "rejected", "cancelled", "returned"].includes(e.approvalStatus)) {
    actions.push({ id: "pay", l: e.isAdvance ? "Pay the advance" : "Record payment", primary: !payWhy && !waiting, why: payWhy, form: payWhy ? undefined : payForm(f, l, roles, false) });
    if (e.approvalStatus === "approved") actions.push({ id: "request", l: "Request payment", why: payWhy, form: payWhy ? undefined : payForm(f, l, roles, true) });
  }
  if (!e.legacy && !e.incurred && !["rejected", "cancelled"].includes(e.approvalStatus)) {
    actions.push({ id: "received", l: "Mark received", prompt: { title: `${e.code} received`, submit: "Mark received", fields: [{ k: "date", l: "Received on", t: "date", req: true }], init: { date: today() } } });
  }
  if (!e.legacy && e.docStatus !== "attached" && e.docStatus !== "exception_approved" && f.receiptRequired && !["rejected", "cancelled"].includes(e.approvalStatus)) {
    actions.push({ id: "docException", l: "Allow without a bill", why: !approver ? WHY.approve : maker ? "Not on your own expense" : "", prompt: { title: "Missing-document exception", submit: "Approve exception", fields: [{ k: "reason", l: "Why it can stand without a bill", t: "area", req: true }] } });
  }
  if (!e.legacy) {
    actions.push({ id: "evidence", l: "Add a document", prompt: { title: `Add to ${e.code}`, sub: "Documents are added, never replaced — each one keeps who added it and when.", submit: "Add", fields: [{ k: "kind", l: "What it is", t: "select", req: true, opts: [...EVIDENCE_KINDS] }, { k: "file", l: "File", t: "photo", req: true }] } });
  }
  if (!e.legacy && ["submitted", "under_review", "approved"].includes(e.approvalStatus)) {
    actions.push({
      id: "adjust",
      l: "Request an adjustment",
      prompt: {
        title: `Adjust ${e.code}`,
        sub: "A vendor credit, a correction or a write-off changes what is payable — it never edits the bill. An approver decides it.",
        submit: "Request",
        fields: [
          { k: "kind", l: "Kind", t: "select", req: true, opts: ["Vendor credit / return", "Correction — less is payable", "Correction — more is payable", "Write-off", ...(advances.length ? ["Set an advance against this bill"] : [])] },
          { k: "advance", l: "Advance", t: "select", opts: advances.map((a) => `${a.e.code} · ${a.e.vendorName ?? a.e.expenseBy} · ${inr(a.advanceOpenPaise)} open`), when: { k: "kind", eq: "Set an advance against this bill" } },
          { k: "amount", l: "Amount (₹)", t: "num", req: true, min: 0.01 },
          { k: "reason", l: "Why", t: "area", req: true },
        ],
      },
    });
  }
  if (pendingAdj.length) {
    actions.push({
      id: "decideAdj",
      l: `Decide adjustment${pendingAdj.length > 1 ? "s" : ""}`,
      why: !approver ? WHY.approve : "",
      prompt: {
        title: "Decide an adjustment",
        submit: "Save decision",
        fields: [
          { k: "adj", l: "Adjustment", t: "select", req: true, opts: pendingAdj.map((a) => adjLabel(a)) },
          { k: "decision", l: "Decision", t: "select", req: true, opts: ["Approve", "Reject"] },
          { k: "note", l: "Note", t: "area" },
        ],
      },
    });
  }
  if (e.isAdvance && f.advanceOpenPaise > 0) {
    actions.push({
      id: "settleBill",
      l: "Set against a bill",
      prompt: {
        title: `Set ${e.code} against a bill`,
        sub: `${inr(f.advanceOpenPaise)} of this advance is open. Setting it against the bill reduces what is payable on the bill; an approver decides it.`,
        submit: "Request",
        fields: [
          { k: "bill", l: "Bill", t: "select", req: true, opts: bills.map((b) => `${b.e.code} · ${b.e.vendorName ?? ""} · ${inr(b.state.outstandingPaise)} outstanding`) },
          { k: "amount", l: "Amount (₹)", t: "num", req: true, min: 0.01, max: f.advanceOpenPaise / 100 },
          { k: "reason", l: "Note", t: "area", req: true },
        ],
        init: { amount: rupeesField(f.advanceOpenPaise) },
      },
    });
    actions.push({
      id: "recover",
      l: "Recovered in cash",
      prompt: {
        title: `Recover ${e.code}`,
        sub: "Money handed back comes into a fund through an adjustment an approver decides.",
        submit: "Request",
        fields: [
          { k: "fund", l: "Into", t: "select", req: true, opts: activeFunds(l).map(fundLabel) },
          { k: "date", l: "Date", t: "date", req: true },
          { k: "amount", l: "Amount (₹)", t: "num", req: true, min: 0.01, max: f.advanceOpenPaise / 100 },
          { k: "reason", l: "Note", t: "area", req: true },
        ],
        init: { date: today(), amount: rupeesField(f.advanceOpenPaise) },
      },
    });
  }
  if (!e.legacy && ["draft", "submitted", "under_review", "returned"].includes(e.approvalStatus) && !f.state.paidPaise && !f.state.requestedPaise) {
    actions.push({ id: "cancel", l: "Cancel expense", prompt: { title: `Cancel ${e.code}`, submit: "Cancel it", fields: [{ k: "reason", l: "Why", t: "area", req: true }] } });
  }

  const flags: string[] = [];
  if (e.legacy) flags.push("legacy");
  if (f.urgent && e.approvalStatus !== "approved") flags.push("urgentPaid");
  if (!e.legacy && f.receiptRequired && (e.docStatus === "to_follow" || e.docStatus === "not_available")) flags.push("missingDoc");
  if (isPayable(e) && f.daysOverdue > 0) flags.push("overdue");
  if (!e.legacy && !e.incurred) flags.push("commitment");
  if (e.approvalRule?.includes("over budget")) flags.push("overBudget");
  if (e.isAdvance && f.advanceOpenPaise > 0) flags.push("advanceOpen");

  const history = await approvalHistory(e.id);
  return {
    id: e.id,
    v: {
      date: e.expenseDate,
      code: e.code ?? "—",
      particular: e.particular ?? e.category ?? "Expense",
      category: f.category,
      vendor: e.vendorName ?? (e.legacy ? e.expenseBy : null),
      amount: e.amountPaise,
      paid: e.legacy ? null : f.state.paidPaise,
      outstanding: e.legacy ? null : f.state.outstandingPaise,
      payment: payableWord(f),
      approval: e.legacy ? "Before the ledger" : e.approvalLevel === "policy" && e.approvalStatus === "approved" ? "Approved by policy" : APPROVAL_LABEL[e.approvalStatus as ApprovalStatus],
      godown: f.godown,
      who: e.expenseBy,
      flags: null,
    },
    flags,
    title: `${e.code ?? "Expense"} · ${e.particular ?? "Expense"} · ${inr(e.amountPaise)}`,
    header: e.legacy
      ? `Recorded before the fund ledger · ${e.mode ?? ""} · not in any balance or payable`
      : `${payableWord(f)} · ${inr(f.state.paidPaise)} paid · ${inr(f.state.outstandingPaise)} outstanding${f.state.requestedPaise ? ` · ${inr(f.state.requestedPaise)} requested` : ""}`,
    fields: [
      { l: "Transaction type", v: e.txnType ?? "—" },
      { l: "Bill no.", v: e.billNo ?? "—" },
      { l: "Bill date", v: e.billDate ? fd(e.billDate) : "—" },
      { l: "Due date", v: f.due ? `${fd(f.due)}${f.daysOverdue ? ` · ${f.daysOverdue} days overdue` : ""}` : "—", der: !e.dueDate },
      { l: "Bill / receipt", v: DOC_STATUS_LABEL[e.docStatus] ?? e.docStatus },
      { l: "Received", v: e.incurred ? (e.receivedAt ? fd(e.receivedAt) : "Yes") : "Not yet — a commitment" },
      { l: "Approval needed from", v: e.approvalLevel ? APPROVAL_LEVEL_LABEL[e.approvalLevel as keyof typeof APPROVAL_LEVEL_LABEL] : "—" },
      { l: "Rule applied", v: e.approvalRule ?? "—" },
      { l: "Decided by", v: e.decidedById ? `${nameOf(names, e.decidedById)} · ${e.decisionNote ?? ""}` : e.approvalLevel === "policy" ? "Policy" : "—" },
      { l: "Department", v: e.department ?? "—" },
      ...(f.state.adjustedPaise ? [{ l: "Adjusted by", v: inr(f.state.adjustedPaise), der: true }] : []),
      ...(e.isAdvance ? [{ l: "Advance still open", v: inr(f.advanceOpenPaise), der: true }] : []),
      ...(e.docExceptionReason ? [{ l: "Bill excused", v: `${nameOf(names, e.docExceptionById)}: ${e.docExceptionReason}` }] : []),
      { l: "Remarks", v: e.note ?? "—" },
    ],
    contacts: evidence.get(e.id),
    actions,
    panel: {
      kind: "pettyTables",
      data: [
        {
          t: "Payments",
          head: ["Code", "Date", "From", "Mode", "Amount", "Reference", "Status"],
          rows: f.payments.map((p) => [p.code, fd(p.paymentDate), l.funds.find((x) => x.id === p.fundAccountId)?.name ?? "—", p.mode, inr(p.amountPaise), p.reference ?? "—", `${p.status === "confirmed" ? (p.approval === "urgent" ? "Paid · urgent" : "Paid") : p.status[0].toUpperCase() + p.status.slice(1)}${p.reconStatus !== "not_applicable" ? ` · ${RECON_WORD[p.reconStatus]}` : ""}`]),
          empty: e.legacy ? "Recorded before the ledger: payments were not tracked." : "Nothing paid yet.",
        },
        ...(f.adjustments.length
          ? [{ t: "Adjustments", head: ["Kind", "Amount", "Reason", "Status"], rows: f.adjustments.map((a) => [a.kind.replace(/_/g, " "), inr(Math.abs(a.amountPaise)) + (a.amountPaise < 0 ? " more" : " less"), a.reason, a.status]) }]
          : []),
        { t: "History", head: ["When", "What", "Who", "Note"], rows: history.map((h) => [stampLine(null, h.a.at).replace("Created ", ""), h.a.action.replace(/_/g, " "), h.by ?? (h.a.level === "policy" ? "Policy" : "—"), [h.a.ruleApplied, h.a.comment].filter(Boolean).join(" · ") || "—"]) },
      ],
    },
    by: stampLine(nameOf(names, e.createdById), e.createdAt),
  };
}

const adjLabel = (a: typeof erpExpenseAdjustments.$inferSelect) => `${a.kind.replace(/_/g, " ")} · ${inr(Math.abs(a.amountPaise))} · ${a.reason.slice(0, 40)} · ${a.id.slice(-6)}`;

/* ========================================================= Expenses */

const expenses: ScreenModule = {
  key: "expenses",
  async load(ctx) {
    const [facts, l] = await Promise.all([loadExpenses(), lookups(ctx)]);
    const names = await userNames(facts.flatMap((f) => [f.e.createdById, f.e.decidedById, f.e.docExceptionById]));
    const ev = await evidenceFor("expense", facts.map((f) => f.e.id));
    const evLinks = new Map([...ev].map(([k, v]) => [k, evidenceLinks(v)]));
    const advances = facts.filter((f) => f.e.isAdvance && f.advanceOpenPaise > 0);
    const bills = facts.filter((f) => isPayable(f.e) && !f.e.isAdvance && f.state.outstandingPaise > 0);
    const roles = pettyRoles(ctx);
    const cols: ColSpec[] = [
      { k: "date", l: "Date", t: "d" },
      { k: "code", l: "No.", t: "mono" },
      { k: "particular", l: "Particular", t: "b" },
      { k: "vendor", l: "Vendor / payee", t: "t" },
      { k: "amount", l: "Amount", t: "m" },
      { k: "paid", l: "Paid", t: "m" },
      { k: "outstanding", l: "Outstanding", t: "m" },
      { k: "payment", l: "Payment", t: "s" },
      { k: "approval", l: "Approval", t: "s" },
      { k: "category", l: "Category", t: "t" },
      { k: "godown", l: "Godown", t: "t" },
      { k: "flags", l: "Flags", t: "f" },
    ];
    const rows = await Promise.all(facts.map((f) => expenseRow(ctx, f, l, names, evLinks, advances.filter((a) => a.e.id !== f.e.id), bills.filter((b) => b.e.id !== f.e.id))));
    const live = facts.filter((f) => !f.e.legacy);
    const waiting = live.filter((f) => ["submitted", "under_review"].includes(f.e.approvalStatus));
    return {
      spec: {
        screen: "expenses",
        cols,
        hidden: [],
        chips: "approval",
        godownKey: "godown",
        bulk: roles.approve || roles.owner ? [{ id: "approve", l: "Approve", confirm: "Approve the selected expenses? Your own are skipped — another approver decides them." }] : undefined,
        newForm: await expenseForm(ctx, l),
        newLabel: "New expense",
        noDataLine: "No expenses yet.",
        notes: waiting.length && (roles.approve || roles.owner) ? [{ tone: "warn", text: `${waiting.length} expense${waiting.length === 1 ? " waits" : "s wait"} for a decision — ${inr(waiting.reduce((s, f) => s + f.e.amountPaise, 0))}. Open one to approve, return or reject it.` }] : undefined,
      },
      rows,
    };
  },
  formLoaders: {
    async edit(ctx, id) {
      const [f] = await loadExpenses({ ids: [id] });
      if (!f) return null;
      return expenseForm(ctx, await lookups(ctx), f);
    },
  },
  forms: {
    async new(ctx, h) {
      const l = await lookups(ctx);
      const input = inputFrom(h, l);
      const r = await createExpense(ctx, input);
      return mapPayErrors(r);
    },
    async edit(ctx, h, _lines, id) {
      if (!id) return err("Nothing to edit.", "not_found");
      const l = await lookups(ctx);
      return editExpense(ctx, id, { ...inputFrom(h, l), payNow: null, version: text(h.version) ? Number(h.version) : null });
    },
    async pay(ctx, h, _lines, id) {
      if (!id) return err("Nothing to pay.", "not_found");
      return recordPayment(ctx, id, payInput(h, await lookups(ctx), false));
    },
    async request(ctx, h, _lines, id) {
      if (!id) return err("Nothing to pay.", "not_found");
      return recordPayment(ctx, id, payInput(h, await lookups(ctx), true));
    },
  },
  actions: {
    submit: (ctx, id) => submitExpense(ctx, id),
    approve: (ctx, id) => decideExpense(ctx, [id], "approve", null),
    reject: (ctx, id, v) => decideExpense(ctx, [id], "reject", text(v.comment)),
    return: (ctx, id, v) => decideExpense(ctx, [id], "return", text(v.comment)),
    review: (ctx, id) => decideExpense(ctx, [id], "review", null),
    received: (ctx, id, v) => markReceived(ctx, id, text(v.date)),
    docException: (ctx, id, v) => approveDocException(ctx, id, text(v.reason)),
    evidence: (ctx, id, v) => addExpenseEvidence(ctx, id, text(v.file), text(v.kind)),
    cancel: (ctx, id, v) => cancelExpense(ctx, id, text(v.reason)),
    async adjust(ctx, id, v) {
      const kind = text(v.kind) ?? "";
      const map: Record<string, { kind: string; increase?: boolean }> = {
        "Vendor credit / return": { kind: "vendor_credit" },
        "Correction — less is payable": { kind: "correction" },
        "Correction — more is payable": { kind: "correction", increase: true },
        "Write-off": { kind: "write_off" },
        "Set an advance against this bill": { kind: "advance_applied" },
      };
      const m = map[kind];
      if (!m) return fieldErr("kind", "Pick the kind");
      let advanceExpenseId: string | null = null;
      if (m.kind === "advance_applied") {
        const code = (text(v.advance) ?? "").split(" · ")[0];
        const [a] = code ? await db.select({ id: erpExpenses.id }).from(erpExpenses).where(eq(erpExpenses.code, code)) : [];
        if (!a) return fieldErr("advance", "Pick the advance");
        advanceExpenseId = a.id;
      }
      return requestExpenseAdjustment(ctx, id, { kind: m.kind, amountPaise: paise(v.amount), reason: text(v.reason), advanceExpenseId, increase: m.increase });
    },
    async decideAdj(ctx, id, v) {
      const pick = text(v.adj) ?? "";
      const rows = await db.select().from(erpExpenseAdjustments).where(eq(erpExpenseAdjustments.expenseId, id));
      const a = rows.find((x) => x.status === "requested" && adjLabel(x) === pick);
      if (!a) return fieldErr("adj", "Pick the adjustment");
      const decision = text(v.decision);
      if (decision !== "Approve" && decision !== "Reject") return fieldErr("decision", "Approve or reject");
      return decideExpenseAdjustment(ctx, a.id, decision === "Approve", text(v.note));
    },
    async settleBill(ctx, id, v) {
      const code = (text(v.bill) ?? "").split(" · ")[0];
      const [b] = code ? await db.select({ id: erpExpenses.id }).from(erpExpenses).where(eq(erpExpenses.code, code)) : [];
      if (!b) return fieldErr("bill", "Pick the bill");
      return requestExpenseAdjustment(ctx, b.id, { kind: "advance_applied", amountPaise: paise(v.amount), reason: text(v.reason), advanceExpenseId: id });
    },
    async recover(ctx, id, v) {
      const l = await lookups(ctx);
      const fund = l.fundByLabel.get(text(v.fund) ?? "");
      return requestFundAdjustment(ctx, { fundId: fund?.id ?? null, date: text(v.date), amountPaise: paise(v.amount), direction: "credit", kind: "advance_recovery", reason: text(v.reason), expenseId: id });
    },
  },
  bulk: { approve: (ctx, ids) => decideExpense(ctx, ids, "approve", null) },
};

/* ========================================================= Payments */

const payments: ScreenModule = {
  key: "pettyPayments",
  async load(ctx) {
    const [rows, l, tally] = await Promise.all([loadPayments(), lookups(ctx), tallyByRecord()]);
    const names = await userNames(rows.flatMap((r) => [r.p.recordedById, r.p.confirmedById, r.p.verifiedById, r.p.requestedById]));
    const ev = await evidenceFor("payment", rows.map((r) => r.p.id));
    const roles = pettyRoles(ctx);
    const cols: ColSpec[] = [
      { k: "date", l: "Date", t: "d" },
      { k: "code", l: "No.", t: "mono" },
      { k: "expense", l: "Expense", t: "b" },
      { k: "payee", l: "Payee", t: "t" },
      { k: "amount", l: "Amount", t: "m" },
      { k: "fund", l: "From", t: "t" },
      { k: "mode", l: "Mode", t: "t" },
      { k: "reference", l: "Reference", t: "mono" },
      { k: "status", l: "Status", t: "s" },
      { k: "recon", l: "Bank", t: "s" },
      { k: "tally", l: "Tally", t: "s" },
      { k: "flags", l: "Flags", t: "f" },
    ];
    const fundName = new Map(l.funds.map((f) => [f.id, f.name]));
    const status = (s: string) => ({ requested: "Requested", confirmed: "Confirmed", reversed: "Reversed", cancelled: "Cancelled" })[s] ?? s;
    return {
      spec: {
        screen: "pettyPayments",
        cols,
        hidden: [],
        chips: "status",
        bulk: roles.accounts ? [{ id: "verify", l: "Mark verified" }] : undefined,
        noDataLine: "No payments yet. A payment is recorded from its expense.",
      },
      rows: rows.map(({ p, expenseCode, particular, vendor }) => {
        const t = tally.get(`payment:${p.id}`);
        const own = p.recordedById === ctx.actor.id || p.requestedById === ctx.actor.id;
        const actions: ActionSpec[] = [openExpense(p.expenseId)];
        if (p.status === "requested") {
          actions.unshift({
            id: "confirm",
            l: "Confirm it was paid",
            primary: true,
            why: !roles.accounts && !roles.approve ? WHY.accounts : p.requestedById === ctx.actor.id && !ctx.administrator ? "Somebody other than whoever asked for it confirms it" : "",
            prompt: {
              title: `Confirm ${p.code}`,
              sub: `${inr(p.amountPaise)} out of ${fundName.get(p.fundAccountId)} — the fund goes down now.`,
              submit: "Confirm paid",
              fields: [
                { k: "date", l: "Paid on", t: "date", req: true },
                { k: "reference", l: "UPI / UTR / cheque reference", t: "text" },
                { k: "ackName", l: "Received by", t: "text" },
                { k: "file", l: "Proof", t: "photo" },
              ],
              init: { date: today(), reference: p.reference ?? "" },
            },
          });
          actions.push({ id: "cancel", l: "Cancel request", prompt: { title: `Cancel ${p.code}`, submit: "Cancel", fields: [{ k: "reason", l: "Why", t: "area", req: true }] } });
        }
        if (p.status === "confirmed") {
          if (!p.verifiedAt) actions.push({ id: "verify", l: "Mark verified", why: !roles.accounts ? WHY.accounts : own && !ctx.administrator ? "Somebody other than whoever recorded it verifies it" : "" });
          actions.push({
            id: "reverse",
            l: "Reverse",
            why: !roles.approve && !roles.owner ? WHY.approve : p.reconStatus === "matched" || p.reconStatus === "reconciled" ? "Matched to the bank statement — unmatch it first" : "",
            prompt: {
              title: `Reverse ${p.code}`,
              sub: "The payment stays on record; a reversing entry puts the money back and the expense's status is worked out again.",
              submit: "Reverse",
              fields: [
                { k: "reason", l: "Why", t: "area", req: true },
                { k: "when", l: "Date the reversal", t: "select", req: true, opts: ["Today", "On the payment's own date (reopens that day's closing)"] },
              ],
              init: { when: "Today" },
            },
          });
        }
        const flags = [...(p.approval === "urgent" ? ["urgentPaid"] : []), ...(p.status === "reversed" ? ["reversed"] : []), ...(p.overdrawReason ? ["overdrawn"] : [])];
        return {
          id: p.id,
          v: {
            date: p.paymentDate,
            code: p.code,
            expense: `${expenseCode ?? "—"} · ${particular ?? ""}`,
            payee: p.payee ?? vendor,
            amount: p.amountPaise,
            fund: fundName.get(p.fundAccountId) ?? "—",
            mode: p.mode,
            reference: p.reference,
            status: status(p.status),
            recon: RECON_WORD[p.reconStatus],
            tally: t ? TALLY_WORD[t.status] : "—",
            flags: null,
          },
          flags,
          title: `${p.code} · ${inr(p.amountPaise)}`,
          header: `${status(p.status)} · ${fundName.get(p.fundAccountId)} · ${p.mode}${p.approval === "urgent" ? " · paid before approval" : ""}`,
          fields: [
            { l: "Acknowledged by", v: p.ackName ?? "—" },
            { l: "Recorded by", v: nameOf(names, p.recordedById) },
            { l: "Confirmed by", v: p.confirmedById ? `${nameOf(names, p.confirmedById)}` : "—" },
            { l: "Verified by", v: p.verifiedById ? nameOf(names, p.verifiedById) : "Not yet" },
            ...(p.urgentReason ? [{ l: "Why it was urgent", v: p.urgentReason }] : []),
            ...(p.overdrawReason ? [{ l: "Paid beyond the fund because", v: p.overdrawReason }] : []),
            ...(p.evidenceExceptionReason ? [{ l: "No acknowledgement because", v: p.evidenceExceptionReason }] : []),
            ...(p.reversalReason ? [{ l: p.status === "cancelled" ? "Cancelled because" : "Reversed because", v: p.reversalReason }] : []),
            ...(t ? [{ l: "Tally voucher", v: t.voucherNo ? `${t.voucherType ?? ""} ${t.voucherNo}` : TALLY_WORD[t.status] }] : []),
          ],
          contacts: evidenceLinks(ev.get(p.id)),
          actions,
          by: stampLine(nameOf(names, p.recordedById), p.createdAt),
        };
      }),
    };
  },
  actions: {
    confirm: (ctx, id, v) => confirmPaymentRequest(ctx, id, { date: text(v.date), reference: text(v.reference), ackName: text(v.ackName), fileId: text(v.file) }),
    cancel: (ctx, id, v) => cancelPaymentRequest(ctx, id, text(v.reason)),
    verify: (ctx, id) => verifyPayment(ctx, [id]),
    reverse: (ctx, id, v) => reversePayment(ctx, id, text(v.reason), (text(v.when) ?? "").startsWith("On the")),
  },
  bulk: { verify: (ctx, ids) => verifyPayment(ctx, ids) },
};

/* ================================================ Vendor outstanding */

const vendors: ScreenModule = {
  key: "pettyVendors",
  async load(ctx) {
    const [facts, l] = await Promise.all([loadExpenses(), lookups(ctx)]);
    const roles = pettyRoles(ctx);
    const open = facts.filter((f) => isPayable(f.e) && f.state.outstandingPaise > 0);
    const cols: ColSpec[] = [
      { k: "vendor", l: "Vendor", t: "b" },
      { k: "code", l: "Expense", t: "mono" },
      { k: "billNo", l: "Bill no.", t: "t" },
      { k: "billDate", l: "Bill date", t: "d" },
      { k: "due", l: "Due", t: "d" },
      { k: "amount", l: "Original", t: "m" },
      { k: "paid", l: "Paid", t: "m" },
      { k: "outstanding", l: "Outstanding", t: "m" },
      { k: "payment", l: "Status", t: "s" },
      { k: "overdue", l: "Days overdue", t: "n" },
      { k: "bucket", l: "Ageing", t: "t" },
      { k: "category", l: "Category", t: "t" },
      { k: "godown", l: "Godown", t: "t" },
      { k: "next", l: "Next action", t: "t" },
    ];
    const total = (list: ExpenseFact[]) => list.reduce((s, f) => s + f.state.outstandingPaise, 0);
    const byBucket = AGEING_BUCKETS.map((b) => ({ b, list: open.filter((f) => f.bucket === b) }));
    const byVendor = new Map<string, number>();
    for (const f of open) byVendor.set(f.e.vendorName ?? "No payee named", (byVendor.get(f.e.vendorName ?? "No payee named") ?? 0) + f.state.outstandingPaise);
    const top = [...byVendor].sort((a, b) => b[1] - a[1]).slice(0, 6);
    const summary: SummaryCard[] = [
      { t: "Ageing", big: { v: inr(total(open)), sub: `outstanding on ${open.length} approved bill${open.length === 1 ? "" : "s"}` }, rows: byBucket.map(({ b, list }) => ({ l: b, v: inr(total(list)), sub: `${list.length} bill${list.length === 1 ? "" : "s"}`, tone: b === "Not yet due" ? undefined : b.startsWith("More") || b.startsWith("16") ? "danger" : "warn" })) },
      { t: "Largest balances", rows: top.length ? top.map(([v, amt]) => ({ l: v, v: inr(amt) })) : [{ l: "Nothing outstanding", v: "—" }] },
    ];
    return {
      spec: {
        screen: "pettyVendors",
        cols,
        hidden: [],
        groups: ["vendor"],
        agg: { k: "outstanding", l: "outstanding" },
        chips: "bucket",
        godownKey: "godown",
        sortDefault: ["overdue", -1],
        summary,
        notes: [{ tone: "info", text: "Only approved, received bills are liabilities here. Drafts, bills awaiting approval and commitments not yet received are not — they are on the Expenses tab." }],
        noDataLine: "Nothing is owed to any vendor.",
      },
      rows: open.map((f) => {
        const e = f.e;
        const next = f.state.requestedPaise ? "Payment requested — accounts to confirm" : f.daysOverdue > 0 ? "Pay now — overdue" : "Pay by the due date";
        return {
          id: e.id,
          v: {
            vendor: e.vendorName ?? "No payee named",
            code: e.code,
            billNo: e.billNo,
            billDate: e.billDate ?? e.expenseDate,
            due: f.due,
            amount: f.state.payablePaise,
            paid: f.state.paidPaise,
            outstanding: f.state.outstandingPaise,
            payment: payableWord(f),
            overdue: f.daysOverdue,
            bucket: f.bucket,
            category: f.category,
            godown: f.godown,
            next,
          },
          flags: f.daysOverdue > 0 ? ["overdue"] : [],
          title: `${e.vendorName ?? "Payee"} · ${e.code} · ${inr(f.state.outstandingPaise)} outstanding`,
          header: `${f.bucket}${f.due ? ` · due ${fd(f.due)}` : ""}`,
          actions: [{ id: "pay", l: "Record payment", primary: true, form: payForm(f, l, roles, false) }, { id: "request", l: "Request payment", form: payForm(f, l, roles, true) }, openExpense(e.id)],
        };
      }),
    };
  },
};

export const PETTY_EXPENSE_SCREENS: ScreenModule[] = [expenses, payments, vendors];
