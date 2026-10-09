import "server-only";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { customers, employees, erpCredits, erpExpenseCategories, erpFundLedger, erpGodowns, users } from "@/db/schema";
import { err, fieldErr, okVoid, type Result } from "@/lib/result";
import type { ErpContext } from "../access";
import { erpLink } from "../registry";
import { erpId, paise, rupeesField, stampLine, text, type ScreenModule } from "../server";
import type { ActionSpec, ColSpec, FormSpec, ListRow, PromptSpec, SummaryCard, SummaryRow, ToolSpec } from "../ui";
import { fd, inr } from "../ui";
import { today } from "./common";
import { addDaysIso } from "../engines/sales";
import { FUND_TYPE_LABEL, FUND_TYPES, TRANSFER_TYPES, transferType, type FundType } from "../engines/petty-cash";
import { audit, balances, evidenceFor, evidenceLinks, nameOf, pettyConfig, pettyRoles, userNames, WHY, type FundRow } from "../petty/core";
import {
  cancelTransfer,
  closingFor,
  confirmTransfer,
  decideFundAdjustment,
  initiateTransfer,
  proposeOpening,
  recordReceipt,
  requestFundAdjustment,
  reverseReceipt,
  reverseTransfer,
  reviewClosing,
  saveFundAccount,
  submitClosing,
  verifyOpening,
  verifyReceipt,
} from "../petty/funds";
import { exceptions } from "../petty/insight";
import { bookVsStatement } from "../petty/bank";
import { isLive, isPayable, loadBankLines, loadClosings, loadExpenses, loadFundAdjustments, loadReceipts, loadTransfers, receiptCustody, RECON_WORD, TALLY_WORD, tallyByRecord } from "../petty/facts";
import { budgetRows } from "../petty/insight";
import { inTx } from "./common";
import { activeFunds, fundLabel, lookups, requestKey, type PettyLookups } from "./petty-shared";

/* ---------------------------------------------------------------------------
 * Petty cash → Overview, Funds given / transfers, Customer cash, Daily
 * closing, Fund ledger and Settings.
 * ------------------------------------------------------------------------- */

const link = (key: string, ids?: string[], label?: string) => (ids && ids.length ? erpLink(key, { f: ids.join(","), fl: label ?? null }) : erpLink(key));

/* ============================================================ Overview */

const overview: ScreenModule = {
  key: "pettyOverview",
  async load(ctx) {
    const cfg = await pettyConfig();
    const [facts, bal, transfers, receipts, closings, bank, l, exc] = await Promise.all([
      loadExpenses(),
      balances(),
      loadTransfers(),
      loadReceipts(),
      loadClosings(),
      loadBankLines(),
      lookups(ctx),
      exceptions(cfg),
    ]);
    const t = today();
    const month = t.slice(0, 7);
    const live = facts.filter((f) => isLive(f.e));
    const incurred = live.filter((f) => f.e.incurred);
    const sum = (xs: { state: { payablePaise: number } }[]) => xs.reduce((s, f) => s + f.state.payablePaise, 0);
    const ids = (xs: { e: { id: string } }[]) => xs.map((f) => f.e.id);
    const todays = incurred.filter((f) => f.e.expenseDate === t);
    const mtd = incurred.filter((f) => f.e.expenseDate.slice(0, 7) === month);
    const awaiting = live.filter((f) => f.e.approvalStatus === "submitted" || f.e.approvalStatus === "under_review");
    const payable = facts.filter((f) => isPayable(f.e) && f.state.outstandingPaise > 0);
    const pending = payable.filter((f) => f.state.status === "PENDING");
    const partly = payable.filter((f) => f.state.status === "PARTIALLY_PAID");
    const noEvidence = live.filter((f) => f.receiptRequired && (f.e.docStatus === "to_follow" || f.e.docStatus === "not_available"));
    const held = receipts.filter((r) => r.r.status === "posted" && receiptCustody(r.r.id, transfers).word !== "Deposited" && receiptCustody(r.r.id, transfers).word !== "Handed over");
    const unmatched = bank.lines.filter((x) => ["unmatched", "exception", "correction", "suggested"].includes(x.reconStatus));
    const budgets = await budgetRows(month, facts);
    const budgeted = budgets.filter((b) => b.status === "approved" && b.budgetPaise > 0);
    const util = budgeted.length ? Math.round((budgeted.reduce((s, b) => s + b.incurredPaise, 0) / budgeted.reduce((s, b) => s + b.budgetPaise, 0)) * 100) : null;

    const fundCards: SummaryCard[] = [];
    for (const f of activeFunds(l)) {
      const inTransitIn = transfers.filter((x) => x.status === "initiated" && x.toFundId === f.id);
      const inTransitOut = transfers.filter((x) => x.status === "initiated" && x.fromFundId === f.id);
      const rows: SummaryRow[] = [];
      if (inTransitIn.length) rows.push({ l: "In transit (in)", v: inr(inTransitIn.reduce((s, x) => s + x.amountPaise, 0)), tone: "warn", href: link("credits", inTransitIn.map((x) => x.id), "In transit") });
      if (inTransitOut.length) rows.push({ l: "In transit (out)", v: inr(inTransitOut.reduce((s, x) => s + x.amountPaise, 0)), href: link("credits", inTransitOut.map((x) => x.id), "In transit") });
      if (f.type === "BANK") {
        const b = await bookVsStatement(f.id);
        rows.push({ l: "Statement balance", v: b.statementPaise == null ? "No statement" : inr(b.statementPaise), sub: b.asOf ? fd(b.asOf) : undefined, href: link("pettyBank") });
        if (b.differencePaise != null) rows.push({ l: "Statement less book", v: inr(b.differencePaise), tone: b.differencePaise === 0 ? "success" : "warn", href: link("pettyBank") });
      } else {
        const last = closings.find((c) => c.fundAccountId === f.id);
        rows.push({ l: "Last closing", v: last ? `${fd(last.closingDate)} · ${last.status}` : "None yet", tone: !last || last.closingDate < addDaysIso(t, -1) ? "warn" : last.variancePaise ? "danger" : "success", href: link("pettyClosing") });
      }
      if (f.openingStatus !== "verified") rows.push({ l: "Opening balance", v: f.openingStatus === "proposed" ? "Awaiting verification" : "Not set", tone: "warn", href: erpLink("pettySettings", { open: f.id }) });
      fundCards.push({ t: f.name, sub: `${FUND_TYPE_LABEL[f.type]}${f.bankAccountLabel ? ` · ${f.bankAccountLabel}` : ""}`, big: { v: inr(bal.get(f.id) ?? 0), tone: (bal.get(f.id) ?? 0) < 0 ? "danger" : undefined }, rows });
    }
    const physical = activeFunds(l, ["PHYSICAL_CASH", "CUSTOMER_CASH"]);
    const closedToday = closings.filter((c) => c.closingDate === t && c.status !== "returned");
    const variances = closings.filter((c) => c.variancePaise !== 0 && c.status !== "approved");
    const work: SummaryCard = {
      t: "This month",
      big: { v: inr(sum(mtd)), sub: `${mtd.length} expense${mtd.length === 1 ? "" : "s"}` },
      rows: [
        { l: "Today's expenses", v: inr(sum(todays)), href: link("expenses", ids(todays), "Today") },
        { l: "Pending payment", v: inr(pending.reduce((s, f) => s + f.state.outstandingPaise, 0)), href: link("pettyVendors", ids(pending), "Pending") },
        { l: "Partially paid", v: inr(partly.reduce((s, f) => s + f.state.outstandingPaise, 0)), sub: `${partly.length} bill${partly.length === 1 ? "" : "s"}`, href: link("pettyVendors", ids(partly), "Partially paid") },
        { l: "Vendor outstanding", v: inr(payable.reduce((s, f) => s + f.state.outstandingPaise, 0)), href: link("pettyVendors") },
        { l: "Budget used this month", v: util == null ? "No budgets" : `${util}%`, tone: util != null && util > 100 ? "danger" : util != null && util > 85 ? "warn" : undefined, href: link("pettyBudgets") },
      ],
    };
    const control: SummaryCard = {
      t: "Pending actions",
      rows: [
        { l: "Awaiting approval", v: String(awaiting.length), sub: inr(awaiting.reduce((s, f) => s + f.e.amountPaise, 0)), tone: awaiting.length ? "warn" : undefined, href: link("expenses", ids(awaiting), "Awaiting approval") },
        { l: "Missing bill", v: String(noEvidence.length), tone: noEvidence.length ? "warn" : undefined, href: link("expenses", ids(noEvidence), "Missing bill") },
        { l: "Customer cash held", v: inr(held.reduce((s, r) => s + r.r.amountPaise, 0)), sub: `${held.length} receipt${held.length === 1 ? "" : "s"}`, tone: held.length ? "warn" : undefined, href: link("pettyReceipts", held.map((r) => r.r.id), "Held") },
        { l: "Bank lines to reconcile", v: String(unmatched.length), tone: unmatched.length ? "warn" : undefined, href: link("pettyBank", unmatched.map((x) => x.id), "To reconcile") },
        { l: "Today's cash closing", v: `${closedToday.length} of ${physical.length}`, tone: closedToday.length < physical.length ? "warn" : "success", href: link("pettyClosing") },
        { l: "Cash variances", v: String(variances.length), tone: variances.length ? "danger" : undefined, href: link("pettyClosing", variances.map((c) => c.id), "Variance") },
      ],
    };
    const cols: ColSpec[] = [
      { k: "label", l: "Exception", t: "b" },
      { k: "text", l: "What", t: "t", w: 420 },
      { k: "date", l: "Date", t: "d" },
      { k: "severity", l: "Severity", t: "s" },
    ];
    return {
      spec: {
        screen: "pettyOverview",
        cols,
        hidden: [],
        chips: "label",
        summary: [...fundCards, work, control],
        readOnly: true,
        noDataLine: "No exceptions.",
      },
      rows: exc.map((x) => ({
        id: x.key,
        v: { label: x.label, text: x.text, date: x.date, severity: x.tone === "danger" ? "Exception" : x.tone === "warn" ? "Pending" : "Open" },
        flags: [],
        title: x.label,
        header: x.text,
        actions: [{ id: "open", l: "Open the record", primary: true, href: x.open ? erpLink(x.view, { open: x.open }) : link(x.view, x.ids, x.label) }],
      })),
    };
  },
};

/* ========================================= Funds given / transfers */

function transferForm(l: PettyLookups, heldReceipts: { label: string }[], init: Record<string, string> = {}): FormSpec {
  const funds = activeFunds(l).map(fundLabel);
  return {
    screen: "credits",
    id: "new",
    title: "Move money between funds",
    submit: "Record transfer",
    header: [
      { k: "type", l: "Kind", t: "select", req: true, opts: TRANSFER_TYPES.map((t) => t.label) },
      { k: "date", l: "Date", t: "date", req: true },
      { k: "from", l: "From", t: "select", req: true, opts: funds },
      { k: "to", l: "To", t: "select", req: true, opts: funds },
      { k: "amount", l: "Amount (₹)", t: "num", req: true, min: 0.01 },
      { k: "bankReference", l: "Bank reference / slip no.", t: "text" },
      { k: "receipts", l: "Customer receipts it carries", t: "multi", opts: heldReceipts.map((r) => r.label) },
      { k: "purpose", l: "Purpose", t: "area" },
      { k: "file", l: "Slip / evidence", t: "photo" },
    ],
    init: { date: today(), requestKey: requestKey(), ...init },
  };
}

const TRANSFER_WORD: Record<string, string> = { initiated: "In transit", confirmed: "Confirmed", cancelled: "Cancelled", reversed: "Reversed" };

const credits: ScreenModule = {
  key: "credits",
  async load(ctx) {
    const [transfers, legacy, l, receipts, bal] = await Promise.all([
      loadTransfers(),
      db.select({ c: erpCredits, godown: erpGodowns.name }).from(erpCredits).innerJoin(erpGodowns, eq(erpGodowns.id, erpCredits.godownId)).orderBy(desc(erpCredits.creditDate)),
      lookups(ctx),
      loadReceipts(),
      balances(),
    ]);
    const roles = pettyRoles(ctx);
    const names = await userNames(transfers.flatMap((t) => [t.initiatedById, t.receivedById]));
    const ev = await evidenceFor("transfer", transfers.map((t) => t.id));
    const fund = new Map(l.funds.map((f) => [f.id, f]));
    const held = receipts.filter((r) => r.r.status === "posted" && receiptCustody(r.r.id, transfers).word === "Held").map((r) => ({ id: r.r.id, label: `${r.r.receiptNo} · ${r.customer} · ${inr(r.r.amountPaise)}` }));
    const cols: ColSpec[] = [
      { k: "date", l: "Date", t: "d" },
      { k: "code", l: "No.", t: "mono" },
      { k: "type", l: "Kind", t: "b" },
      { k: "from", l: "From", t: "t" },
      { k: "to", l: "To", t: "t" },
      { k: "amount", l: "Amount", t: "m" },
      { k: "status", l: "Status", t: "s" },
      { k: "recon", l: "Bank", t: "s" },
      { k: "by", l: "Started by", t: "t" },
      { k: "received", l: "Received by", t: "t" },
    ];
    const rows: ListRow[] = transfers.map((t) => {
      const from = fund.get(t.fromFundId);
      const to = fund.get(t.toFundId);
      const custodian = to?.custodianUserId;
      const confirmWhy = t.initiatedById === ctx.actor.id && !ctx.administrator ? "Whoever receives the money confirms it — not whoever sent it" : custodian && custodian !== ctx.actor.id && !roles.accounts && !roles.approve ? `${to?.name}'s custodian confirms it` : "";
      const actions: ActionSpec[] = [];
      if (t.status === "initiated") {
        actions.push({
          id: "confirm",
          l: "Confirm received",
          primary: !confirmWhy,
          why: confirmWhy,
          prompt: { title: `Confirm ${t.code}`, sub: `${inr(t.amountPaise)} · ${to?.name}`, submit: "Confirm received", fields: [{ k: "file", l: "Acknowledgement photo", t: "photo" }, { k: "note", l: "Note", t: "text" }] },
        });
        actions.push({ id: "cancel", l: "Cancel", prompt: { title: `Cancel ${t.code}`, submit: "Cancel", fields: [{ k: "reason", l: "Why", t: "area", req: true }] } });
      }
      if (t.status === "confirmed") actions.push({ id: "reverse", l: "Reverse", why: !roles.approve && !roles.owner ? WHY.approve : "", prompt: { title: `Reverse ${t.code}`, submit: "Reverse", fields: [{ k: "reason", l: "Why", t: "area", req: true }] } });
      return {
        id: t.id,
        v: { date: t.transferDate, code: t.code, type: transferType(t.transferType)?.label ?? t.transferType, from: from?.name ?? "—", to: to?.name ?? "—", amount: t.amountPaise, status: TRANSFER_WORD[t.status], recon: RECON_WORD[t.reconStatus], by: nameOf(names, t.initiatedById), received: t.receivedById ? nameOf(names, t.receivedById) : "—" },
        flags: t.status === "reversed" ? ["reversed"] : [],
        title: `${t.code} · ${inr(t.amountPaise)}`,
        header: `${transferType(t.transferType)?.label} · ${from?.name} → ${to?.name} · ${TRANSFER_WORD[t.status]}`,
        fields: [
          { l: "Purpose", v: t.purpose ?? "—" },
          { l: "Bank reference", v: t.bankReference ?? "—" },
          { l: "Receipts carried", v: t.linkedReceiptIds.length ? receipts.filter((r) => t.linkedReceiptIds.includes(r.r.id)).map((r) => r.r.receiptNo).join(", ") : "—" },
          ...(t.cancelReason ? [{ l: "Cancelled because", v: t.cancelReason }] : []),
          ...(t.reversalReason ? [{ l: "Reversed because", v: t.reversalReason }] : []),
        ],
        contacts: evidenceLinks(ev.get(t.id)),
        actions,
        by: stampLine(nameOf(names, t.initiatedById), t.createdAt),
      };
    });
    for (const c of legacy) {
      rows.push({
        id: c.c.id,
        v: { date: c.c.creditDate, code: "—", type: "Funds given (before the ledger)", from: c.c.mode, to: c.c.employeeName, amount: c.c.amountPaise, status: "Before the ledger", recon: "—", by: "—", received: c.godown },
        flags: ["legacy"],
        title: `${c.c.employeeName} · ${inr(c.c.amountPaise)}`,
        header: "Recorded before the fund ledger — kept as it was, in no balance.",
        fields: [{ l: "Note", v: c.c.note ?? "—" }],
      });
    }
    const summary: SummaryCard[] = activeFunds(l).map((f) => ({ t: f.name, big: { v: inr(bal.get(f.id) ?? 0), sub: FUND_TYPE_LABEL[f.type] }, rows: [] }));
    return {
      spec: { screen: "credits", cols, hidden: [], chips: "status", summary, newForm: transferForm(l, held), newLabel: "New transfer", noDataLine: "No transfers yet." },
      rows,
    };
  },
  forms: {
    async new(ctx, h) {
      const l = await lookups(ctx);
      const t = TRANSFER_TYPES.find((x) => x.label === text(h.type));
      const receipts = await loadReceipts();
      const picked = (h.receipts ?? "").split("|").filter(Boolean).map((label) => receipts.find((r) => `${r.r.receiptNo} · ${r.customer} · ${inr(r.r.amountPaise)}` === label)?.r.id).filter((x): x is string => !!x);
      return initiateTransfer(ctx, {
        type: t?.key ?? null,
        date: text(h.date),
        fromFundId: l.fundByLabel.get(text(h.from) ?? "")?.id ?? null,
        toFundId: l.fundByLabel.get(text(h.to) ?? "")?.id ?? null,
        amountPaise: paise(h.amount),
        purpose: text(h.purpose),
        bankReference: text(h.bankReference),
        receiptIds: picked,
        evidenceFileId: text(h.file),
        requestKey: text(h.requestKey),
      });
    },
  },
  actions: {
    confirm: (ctx, id, v) => confirmTransfer(ctx, id, { fileId: text(v.file), note: text(v.note) }),
    cancel: (ctx, id, v) => cancelTransfer(ctx, id, text(v.reason)),
    reverse: (ctx, id, v) => reverseTransfer(ctx, id, text(v.reason)),
  },
};

/* ======================================================= Customer cash */

async function customerChoices() {
  const rows = await db.select({ id: customers.id, name: customers.name, city: customers.city }).from(customers).where(ne(customers.status, "deactivated")).orderBy(asc(customers.name));
  const seen = new Map<string, number>();
  const out = rows.map((c) => {
    const base = `${c.name}${c.city ? ` — ${c.city}` : ""}`.replace(/\|/g, "/");
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { id: c.id, label: n === 1 ? base : `${base} (${n})` };
  });
  return out;
}

async function openBillsByCustomer(choices: { id: string; label: string }[]) {
  const rows = (await db.execute(sql`
    select customer_id as "customerId", id, bill_no as "billNo", (amount - paid_amount)::float8 as due
      from bills where amount > paid_amount order by bill_date limit 5000`)) as unknown as { customerId: string; id: string; billNo: string; due: number }[];
  const labelOf = new Map(choices.map((c) => [c.id, c.label]));
  const map: Record<string, string[]> = {};
  const byLabel = new Map<string, string>();
  for (const b of rows) {
    const cl = labelOf.get(b.customerId);
    if (!cl) continue;
    const bl = `${b.billNo} · ${inr(b.due)} due`.replace(/\|/g, "/");
    (map[cl] ??= []).push(bl);
    byLabel.set(`${cl}::${bl}`, b.id);
  }
  return { map, byLabel };
}

const receiptsScreen: ScreenModule = {
  key: "pettyReceipts",
  async load(ctx) {
    const [rows, transfers, l, tally, choices] = await Promise.all([loadReceipts(), loadTransfers(), lookups(ctx), tallyByRecord(), customerChoices()]);
    const roles = pettyRoles(ctx);
    const names = await userNames(rows.flatMap((r) => [r.r.recordedById, r.r.verifiedById]));
    const ev = await evidenceFor("receipt", rows.map((r) => r.r.id));
    const bills2 = await openBillsByCustomer(choices);
    const custFunds = activeFunds(l, ["CUSTOMER_CASH"]);
    const fund = new Map(l.funds.map((f) => [f.id, f.name]));
    const cols: ColSpec[] = [
      { k: "date", l: "Date", t: "d" },
      { k: "no", l: "Receipt", t: "mono" },
      { k: "customer", l: "Customer", t: "b" },
      { k: "amount", l: "Amount", t: "m" },
      { k: "fund", l: "Held in", t: "t" },
      { k: "custody", l: "Where it is", t: "s" },
      { k: "verified", l: "Accounts", t: "s" },
      { k: "bills", l: "Against invoices", t: "t" },
      { k: "tally", l: "Tally", t: "s" },
    ];
    const form: FormSpec = {
      screen: "pettyReceipts",
      id: "new",
      title: "Customer cash received",
      submit: "Record receipt",
      header: [
        { k: "customer", l: "Customer", t: "select", req: true, opts: choices.map((c) => c.label) },
        { k: "date", l: "Received on", t: "date", req: true },
        { k: "amount", l: "Amount (₹)", t: "num", req: true, min: 0.01 },
        { k: "fund", l: "Held in", t: "select", req: true, opts: custFunds.map(fundLabel) },
        { k: "bills", l: "Against invoices", t: "multi", optsBy: { by: "customer", map: bills2.map } },
        { k: "ack", l: "Customer's acknowledgement", t: "photo" },
        { k: "remarks", l: "Remarks", t: "area" },
      ],
      init: { date: today(), fund: custFunds[0] ? fundLabel(custFunds[0]) : "", requestKey: requestKey() },
    };
    const bankFunds = activeFunds(l, ["BANK"]);
    return {
      spec: {
        screen: "pettyReceipts",
        cols,
        hidden: [],
        chips: "custody",
        newForm: form,
        newLabel: "Cash received",
        bulk: [
          {
            id: "deposit",
            l: "Deposit into bank",
            prompt: { title: "Deposit the selected cash", submit: "Record deposit", fields: [{ k: "to", l: "Into", t: "select", req: true, opts: bankFunds.map(fundLabel) }, { k: "date", l: "Date", t: "date", req: true }, { k: "bankReference", l: "Deposit slip no.", t: "text", req: true }], init: { date: today(), ...(bankFunds[0] ? { to: fundLabel(bankFunds[0]) } : {}) } },
          },
          {
            id: "handover",
            l: "Hand over",
            prompt: { title: "Hand the selected cash over", submit: "Record handover", fields: [{ k: "to", l: "To", t: "select", req: true, opts: activeFunds(l, ["PHYSICAL_CASH", "CUSTOMER_CASH"]).map(fundLabel) }, { k: "date", l: "Date", t: "date", req: true }], init: { date: today() } },
          },
        ],
        noDataLine: "No receipts yet.",
      },
      rows: rows.map(({ r, customer }) => {
        const c = receiptCustody(r.id, transfers);
        const t = tally.get(`receipt:${r.id}`);
        const actions: ActionSpec[] = [];
        if (r.status === "posted" && !r.verifiedAt)
          actions.push({ id: "verify", l: "Verify against the ledger", primary: true, why: !roles.accounts ? WHY.accounts : r.recordedById === ctx.actor.id && !ctx.administrator ? "Somebody other than whoever recorded it verifies it" : "", prompt: { title: `Verify ${r.receiptNo}`, submit: "Verified", fields: [{ k: "crm", l: "Accounts receipt reference", t: "text" }, { k: "note", l: "Note", t: "area" }] } });
        if (r.status === "posted" && c.word === "Held") actions.push({ id: "reverse", l: "Reverse", why: !roles.approve && !roles.owner ? WHY.approve : "", prompt: { title: `Reverse ${r.receiptNo}`, submit: "Reverse", fields: [{ k: "reason", l: "Why", t: "area", req: true }] } });
        return {
          id: r.id,
          v: { date: r.receiptDate, no: r.receiptNo, customer, amount: r.amountPaise, fund: fund.get(r.fundAccountId) ?? "—", custody: r.status === "reversed" ? "Reversed" : c.word, verified: r.verifiedAt ? "Verified" : "To verify", bills: r.allocations.map((a) => a.billNo).join(", ") || "—", tally: t ? TALLY_WORD[t.status] : "—" },
          flags: r.status === "reversed" ? ["reversed"] : [],
          title: `${r.receiptNo} · ${customer} · ${inr(r.amountPaise)}`,
          header: `${c.word}${c.transferCode ? ` on ${c.transferCode}` : ""} · ${r.verifiedAt ? "verified by accounts" : "accounts to verify"}`,
          fields: [
            { l: "Against", v: r.allocations.map((a) => `${a.billNo} (${inr(a.amountPaise)})`).join(", ") || "No invoice named" },
            { l: "Remarks", v: r.remarks ?? "—" },
            { l: "Verified by", v: r.verifiedById ? `${nameOf(names, r.verifiedById)}${r.verifyNote ? ` · ${r.verifyNote}` : ""}` : "—" },
            { l: "Accounts reference", v: r.crmReference ?? "—" },
            ...(r.reversalReason ? [{ l: "Reversed because", v: r.reversalReason }] : []),
          ],
          contacts: evidenceLinks(ev.get(r.id)),
          actions,
          by: stampLine(nameOf(names, r.recordedById), r.createdAt),
        };
      }),
    };
  },
  forms: {
    async new(ctx, h) {
      const l = await lookups(ctx);
      const choices = await customerChoices();
      const cust = choices.find((c) => c.label === text(h.customer));
      const b = await openBillsByCustomer(choices);
      const billIds = (h.bills ?? "").split("|").filter(Boolean).map((x) => b.byLabel.get(`${cust?.label}::${x}`)).filter((x): x is string => !!x);
      return recordReceipt(ctx, { customerId: cust?.id ?? null, date: text(h.date), amountPaise: paise(h.amount), fundId: l.fundByLabel.get(text(h.fund) ?? "")?.id ?? null, billIds, ackFileId: text(h.ack), remarks: text(h.remarks), requestKey: text(h.requestKey) });
    },
  },
  actions: {
    verify: (ctx, id, v) => verifyReceipt(ctx, id, text(v.note), text(v.crm)),
    reverse: (ctx, id, v) => reverseReceipt(ctx, id, text(v.reason)),
  },
  bulk: {
    deposit: (ctx, ids, v) => moveReceipts(ctx, ids, "customerDeposit", text(v.to), text(v.date), text(v.bankReference)),
    handover: (ctx, ids, v) => moveReceipts(ctx, ids, "customerHandover", text(v.to), text(v.date), null),
  },
};

async function moveReceipts(ctx: ErpContext, ids: string[], type: string, to: string | null, date: string | null, ref: string | null): Promise<Result<unknown>> {
  const l = await lookups(ctx);
  const rows = (await loadReceipts()).filter((r) => ids.includes(r.r.id));
  const funds = [...new Set(rows.map((r) => r.r.fundAccountId))];
  if (funds.length !== 1) return err("Pick receipts held in one fund.", "validation");
  return initiateTransfer(ctx, { type, date, fromFundId: funds[0], toFundId: l.fundByLabel.get(to ?? "")?.id ?? null, amountPaise: rows.reduce((s, r) => s + r.r.amountPaise, 0), purpose: `${type === "customerDeposit" ? "Deposit" : "Handover"} of ${rows.map((r) => r.r.receiptNo).join(", ")}`, bankReference: ref, receiptIds: ids });
}

/* ======================================================= Daily closing */

const closing: ScreenModule = {
  key: "pettyClosing",
  async load(ctx) {
    const [rows, l, bal] = await Promise.all([loadClosings(), lookups(ctx), balances()]);
    const roles = pettyRoles(ctx);
    const names = await userNames(rows.flatMap((c) => [c.submittedById, c.reviewedById]));
    const ev = await evidenceFor("closing", rows.map((c) => c.id));
    const cash = activeFunds(l, ["PHYSICAL_CASH", "CUSTOMER_CASH"]);
    const fund = new Map(l.funds.map((f) => [f.id, f.name]));
    const t = today();
    /* Expected for each cash fund over the last week, so the form shows it as the fund and date are picked. */
    const expected: Record<string, string> = {};
    for (const f of cash)
      for (let d = 0; d < 8; d++) {
        const day = addDaysIso(t, -d);
        const fig = await closingFor(f.id, day);
        expected[`${fundLabel(f)}|${day}`] = `${inr(fig.expectedPaise)}  (opening ${inr(fig.openingPaise)} + in ${inr(fig.inPaise)} − out ${inr(fig.outPaise)})`;
      }
    const form: FormSpec = {
      screen: "pettyClosing",
      id: "new",
      title: "Close the day",
      submit: "Submit closing",
      header: [
        { k: "fund", l: "Cash fund", t: "select", req: true, opts: cash.map(fundLabel) },
        { k: "date", l: "Day", t: "date", req: true },
        { k: "expected", l: "Expected (from the ledger)", t: "text", readOnly: true, fillBy: { by: ["fund", "date"], map: expected }, wide: true },
        { k: "counted", l: "Counted (₹)", t: "num", req: true, min: 0 },
        { k: "explanation", l: "Explain any difference", t: "area", mic: true },
        { k: "file", l: "Photo of the count", t: "photo" },
      ],
      init: { date: t, fund: cash[0] ? fundLabel(cash[0]) : "", expected: cash[0] ? (expected[`${fundLabel(cash[0])}|${t}`] ?? "") : "" },
    };
    const cols: ColSpec[] = [
      { k: "date", l: "Day", t: "d" },
      { k: "fund", l: "Fund", t: "b" },
      { k: "opening", l: "Opening", t: "m" },
      { k: "in", l: "In", t: "m" },
      { k: "out", l: "Out", t: "m" },
      { k: "expected", l: "Expected", t: "m" },
      { k: "counted", l: "Counted", t: "m" },
      { k: "variance", l: "Variance", t: "m" },
      { k: "status", l: "Status", t: "s" },
      { k: "resolution", l: "Resolution", t: "s" },
      { k: "by", l: "Counted by", t: "t" },
    ];
    const summary: SummaryCard[] = cash.map((f) => {
      const last = rows.find((c) => c.fundAccountId === f.id);
      const todayRow = rows.find((c) => c.fundAccountId === f.id && c.closingDate === t);
      return {
        t: f.name,
        big: { v: inr(bal.get(f.id) ?? 0) },
        rows: [
          { l: "Today", v: todayRow ? todayRow.status : "Not closed", tone: todayRow ? (todayRow.variancePaise ? "danger" : "success") : "warn" },
          { l: "Last closing", v: last ? fd(last.closingDate) : "None yet" },
        ],
      };
    });
    const STATUS: Record<string, string> = { submitted: "Submitted", approved: "Approved", returned: "Returned for correction", reopened: "Reopened" };
    return {
      spec: { screen: "pettyClosing", cols, hidden: [], chips: "status", summary, newForm: form, newLabel: "Close the day", noDataLine: "No closings yet." },
      rows: rows.map((c) => {
        const fName = fund.get(c.fundAccountId) ?? "—";
        const reviewWhy = !roles.approve && !roles.owner ? WHY.approve : c.submittedById === ctx.actor.id ? "Somebody other than whoever counted reviews it" : c.status !== "submitted" ? "It is not waiting for review" : "";
        const actions: ActionSpec[] = [];
        if (c.status === "submitted") {
          actions.push({
            id: "approve",
            l: "Approve",
            primary: !reviewWhy,
            why: reviewWhy,
            prompt: c.variancePaise
              ? { title: `Approve ${fName} · ${c.closingDate}`, sub: `Variance ${inr(c.variancePaise)}`, submit: "Approve", fields: [{ k: "resolution", l: "Resolution", t: "select", req: true, opts: ["Explained — accept as it stands", "Post an adjustment for the variance"] }, { k: "note", l: "Resolution in words", t: "area", req: true }] }
              : { title: `Approve ${fName} · ${c.closingDate}`, submit: "Approve", fields: [{ k: "note", l: "Note", t: "area" }] },
          });
          actions.push({ id: "return", l: "Return for a recount", why: reviewWhy, prompt: { title: "Return the closing", submit: "Return", fields: [{ k: "note", l: "What to recount or explain", t: "area", req: true }] } });
        }
        if (c.status === "returned" || c.status === "reopened")
          actions.push({ id: "recount", l: "Count again", primary: true, form: { ...form, init: { ...form.init, fund: fName, date: c.closingDate, expected: expected[`${fName}|${c.closingDate}`] ?? "" } } });
        return {
          id: c.id,
          v: { date: c.closingDate, fund: fName, opening: c.openingPaise, in: c.inPaise, out: c.outPaise, expected: c.expectedPaise, counted: c.countedPaise, variance: c.variancePaise, status: STATUS[c.status], resolution: c.resolution === "adjusted" ? "Adjusted" : c.resolution === "explained" ? "Explained" : "—", by: nameOf(names, c.submittedById) },
          flags: [...(c.variancePaise ? ["variance"] : []), ...(c.status === "reopened" ? ["reopened"] : [])],
          title: `${fName} · ${fd(c.closingDate)}`,
          header: c.variancePaise ? `${c.variancePaise < 0 ? "Short" : "Over"} by ${inr(Math.abs(c.variancePaise))}` : "Count matches",
          fields: [
            { l: "Explanation", v: c.explanation ?? "—" },
            { l: "Reviewed by", v: c.reviewedById ? `${nameOf(names, c.reviewedById)}${c.reviewNote ? ` · ${c.reviewNote}` : ""}` : "—" },
            ...(c.reopenedReason ? [{ l: "Reopened because", v: c.reopenedReason }] : []),
          ],
          contacts: evidenceLinks(ev.get(c.id)),
          actions,
          by: stampLine(nameOf(names, c.submittedById), c.submittedAt),
        };
      }),
    };
  },
  forms: {
    async new(ctx, h) {
      const l = await lookups(ctx);
      return submitClosing(ctx, { fundId: l.fundByLabel.get(text(h.fund) ?? "")?.id ?? null, date: text(h.date), countedPaise: paise(h.counted), explanation: text(h.explanation), fileId: text(h.file) });
    },
  },
  actions: {
    approve: (ctx, id, v) => reviewClosing(ctx, id, { decision: "approve", note: text(v.note), resolution: text(v.resolution)?.startsWith("Post") ? "adjusted" : text(v.resolution) ? "explained" : null }),
    return: (ctx, id, v) => reviewClosing(ctx, id, { decision: "return", note: text(v.note) }),
  },
};

/* ========================================================== Fund ledger */

const ADJ_KIND: Record<string, string> = { variance: "Cash variance", bank_charge: "Bank charge", correction: "Correction", advance_recovery: "Advance recovered", other: "Other" };

const ledger: ScreenModule = {
  key: "pettyLedger",
  async load(ctx) {
    const [entries, adjustments, l, facts] = await Promise.all([db.select().from(erpFundLedger).orderBy(asc(erpFundLedger.txnDate), asc(erpFundLedger.postedAt)), loadFundAdjustments(), lookups(ctx), loadExpenses()]);
    const roles = pettyRoles(ctx);
    const names = await userNames([...entries.map((e) => e.postedById), ...adjustments.flatMap((a) => [a.requestedById, a.decidedById])]);
    const fund = new Map(l.funds.map((f) => [f.id, f.name]));
    const running = new Map<string, number>();
    const rows: ListRow[] = [];
    for (const e of entries) {
      const b = (running.get(e.fundAccountId) ?? 0) + (e.direction === "credit" ? e.amountPaise : -e.amountPaise);
      running.set(e.fundAccountId, b);
      rows.push({
        id: e.id,
        v: { date: e.txnDate, code: e.code, fund: fund.get(e.fundAccountId) ?? "—", type: e.txnType.replace(/_/g, " "), dir: e.direction === "credit" ? "In" : "Out", amount: e.amountPaise, balance: b, status: "Posted", narration: e.narration, by: nameOf(names, e.postedById) },
        flags: e.reversalOfId ? ["reversed"] : [],
        title: `${e.code} · ${e.direction === "credit" ? "+" : "−"}${inr(e.amountPaise)}`,
        header: `${fund.get(e.fundAccountId)} · balance after ${inr(b)}`,
        fields: [
          { l: "Source", v: `${e.sourceType} ${e.sourceId}` },
          { l: "Posting key", v: e.postingKey },
          ...(e.reversalOfId ? [{ l: "Reverses", v: entries.find((x) => x.id === e.reversalOfId)?.code ?? e.reversalOfId }] : []),
        ],
        by: stampLine(nameOf(names, e.postedById), e.postedAt),
      });
    }
    rows.reverse();
    for (const a of adjustments.filter((x) => x.status !== "approved")) {
      const why = a.status !== "requested" ? "It is decided" : !roles.approve && !roles.owner ? WHY.approve : a.requestedById === ctx.actor.id ? "Somebody other than whoever asked for it decides it" : "";
      rows.unshift({
        id: a.id,
        v: { date: a.adjDate, code: a.code, fund: fund.get(a.fundAccountId) ?? "—", type: `adjustment · ${ADJ_KIND[a.kind]}`, dir: a.direction === "credit" ? "In" : "Out", amount: a.amountPaise, balance: null, status: a.status === "requested" ? "Awaiting approval" : "Rejected", narration: a.reason, by: nameOf(names, a.requestedById) },
        flags: [],
        title: `${a.code} · ${ADJ_KIND[a.kind]} · ${inr(a.amountPaise)}`,
        header: a.status === "requested" ? "Not posted — an approver decides it" : `Rejected: ${a.decisionNote ?? ""}`,
        actions: a.status === "requested" ? [{ id: "approveAdj", l: "Approve and post", primary: !why, why, confirm: `Post ${a.code}: ${inr(a.amountPaise)} ${a.direction === "credit" ? "into" : "out of"} ${fund.get(a.fundAccountId)}?` }, { id: "rejectAdj", l: "Reject", why, prompt: { title: `Reject ${a.code}`, submit: "Reject", fields: [{ k: "note", l: "Why", t: "area", req: true }] } }] : [],
        by: stampLine(nameOf(names, a.requestedById), a.requestedAt),
      });
    }
    const advances = facts.filter((f) => f.e.isAdvance && f.advanceOpenPaise > 0);
    const tools: ToolSpec[] = [
      {
        id: "adjust",
        l: "Request an adjustment",
        prompt: {
          title: "Fund adjustment",
          submit: "Request",
          fields: [
            { k: "fund", l: "Fund", t: "select", req: true, opts: l.funds.map(fundLabel) },
            { k: "date", l: "Date", t: "date", req: true },
            { k: "direction", l: "It", t: "select", req: true, opts: ["Adds to the fund", "Takes from the fund"] },
            { k: "amount", l: "Amount (₹)", t: "num", req: true, min: 0.01 },
            { k: "kind", l: "Kind", t: "select", req: true, opts: ["Bank charge", "Correction", "Advance recovered", "Other"] },
            { k: "advance", l: "Advance", t: "select", opts: advances.map((a) => `${a.e.code} · ${a.e.vendorName ?? a.e.expenseBy} · ${inr(a.advanceOpenPaise)} open`), when: { k: "kind", eq: "Advance recovered" } },
            { k: "reason", l: "Why", t: "area", req: true },
          ],
          init: { date: today() },
        },
      },
    ];
    const cols: ColSpec[] = [
      { k: "date", l: "Date", t: "d" },
      { k: "code", l: "No.", t: "mono" },
      { k: "fund", l: "Fund", t: "b" },
      { k: "type", l: "Movement", t: "t" },
      { k: "dir", l: "In / out", t: "s" },
      { k: "amount", l: "Amount", t: "m" },
      { k: "balance", l: "Balance after", t: "m" },
      { k: "status", l: "Status", t: "s" },
      { k: "narration", l: "Narration", t: "t", w: 260 },
    ];
    return {
      spec: {
        screen: "pettyLedger",
        cols,
        hidden: [],
        chips: "fund",
        tools,
        noDataLine: "No entries yet.",
      },
      rows,
    };
  },
  tools: {
    async adjust(ctx, v) {
      const l = await lookups(ctx);
      const kind = { "Bank charge": "bank_charge", Correction: "correction", "Advance recovered": "advance_recovery", Other: "other" }[text(v.kind) ?? ""] ?? null;
      let expenseId: string | null = null;
      if (kind === "advance_recovery") {
        const code = (text(v.advance) ?? "").split(" · ")[0];
        const f = (await loadExpenses()).find((x) => x.e.code === code);
        expenseId = f?.e.id ?? null;
      }
      return requestFundAdjustment(ctx, { fundId: l.fundByLabel.get(text(v.fund) ?? "")?.id ?? null, date: text(v.date), amountPaise: paise(v.amount), direction: text(v.direction) === "Adds to the fund" ? "credit" : text(v.direction) ? "debit" : null, kind, reason: text(v.reason), expenseId });
    },
  },
  actions: {
    approveAdj: (ctx, id) => decideFundAdjustment(ctx, id, true, null),
    rejectAdj: (ctx, id, v) => decideFundAdjustment(ctx, id, false, text(v.note)),
  },
};

/* ============================================================= Settings */

const RULE_WORD: Record<string, string> = { standard: "By amount", approver: "Always an approver", owner: "Always the owner" };
const RULE_FROM: Record<string, string> = { "By amount": "standard", "Always an approver": "approver", "Always the owner": "owner" };

async function people() {
  const [emps, us] = await Promise.all([
    db.select({ id: employees.id, name: employees.name }).from(employees).where(eq(employees.status, "active")).orderBy(asc(employees.name)),
    db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.active, true)).orderBy(asc(users.name)),
  ]);
  return { emps, us: us.map((u) => ({ id: u.id, label: `${u.name} · ${u.email}` })) };
}

function fundPrompt(f: FundRow | null, p: Awaited<ReturnType<typeof people>>, gds: string[], godown: string): PromptSpec {
  return {
    title: f ? `Edit ${f.name}` : "New fund account",
    submit: "Save",
    fields: [
      { k: "code", l: "Code", t: "text" as const, req: true },
      { k: "name", l: "Name", t: "text" as const, req: true },
      { k: "type", l: "Type", t: "select" as const, req: true, opts: FUND_TYPES.map((x) => FUND_TYPE_LABEL[x]) },
      { k: "bank", l: "Bank account (for a bank fund)", t: "text" as const },
      { k: "custodian", l: "Custodian — who signs in to confirm and close", t: "select" as const, opts: p.us.map((u) => u.label) },
      { k: "employee", l: "Custodian in HRMS", t: "select" as const, opts: p.emps.map((e) => e.name) },
      { k: "godown", l: "Godown", t: "select" as const, opts: gds },
      { k: "tally", l: "Tally ledger name", t: "text" as const },
      { k: "status", l: "Status", t: "select" as const, req: true, opts: ["Active", "Inactive"] },
    ],
    init: f
      ? { code: f.code, name: f.name, type: FUND_TYPE_LABEL[f.type], bank: f.bankAccountLabel ?? "", custodian: p.us.find((u) => u.id === f.custodianUserId)?.label ?? "", employee: p.emps.find((e) => e.id === f.custodianEmployeeId)?.name ?? "", godown, tally: f.tallyLedger ?? "", status: f.status === "active" ? "Active" : "Inactive" }
      : ({ status: "Active", type: FUND_TYPE_LABEL.PHYSICAL_CASH } as Record<string, string>),
  };
}

function categoryPrompt(c: typeof erpExpenseCategories.$inferSelect | null): PromptSpec {
  return {
    title: c ? `Edit ${c.name}` : "New expense category",
    submit: "Save",
    fields: [
      { k: "code", l: "Expense code", t: "text" as const, req: true },
      { k: "name", l: "Name", t: "text" as const, req: true },
      { k: "rule", l: "Approval", t: "select" as const, req: true, opts: Object.values(RULE_WORD) },
      { k: "receipt", l: "Bill / receipt required", t: "select" as const, req: true, opts: ["Yes", "No"] },
      { k: "budget", l: "Budgeted", t: "select" as const, req: true, opts: ["Yes", "No"] },
      { k: "tally", l: "Tally ledger", t: "text" as const },
      { k: "costCentre", l: "Cost centre", t: "text" as const },
      { k: "active", l: "Status", t: "select" as const, req: true, opts: ["Active", "Inactive"] },
    ],
    init: c
      ? { code: c.code, name: c.name, rule: RULE_WORD[c.approvalRule], receipt: c.receiptRequired ? "Yes" : "No", budget: c.budgetApplicable ? "Yes" : "No", tally: c.tallyLedger ?? "", costCentre: c.costCentre ?? "", active: c.active ? "Active" : "Inactive" }
      : ({ rule: RULE_WORD.standard, receipt: "Yes", budget: "Yes", active: "Active" } as Record<string, string>),
  };
}

const settings: ScreenModule = {
  key: "pettySettings",
  async load(ctx) {
    const [l, p, cfg] = await Promise.all([lookups(ctx), people(), pettyConfig()]);
    const roles = pettyRoles(ctx);
    const names = await userNames(l.funds.flatMap((f) => [f.openingProposedById, f.openingVerifiedById, f.custodianUserId]));
    const gName = new Map(l.godowns.map((g) => [g.id, g.name]));
    const gds = l.godowns.map((g) => g.name);
    const ownerWhy = !roles.owner && !roles.admin ? WHY.owner : "";
    const rows: ListRow[] = l.funds.map((f) => {
      const openingWhy = !roles.accounts && !roles.owner ? "The accounts team or the owner proposes it" : f.openingStatus === "verified" ? "Verified and posted — correct it with an adjustment" : "";
      const verifyWhy = f.openingStatus !== "proposed" ? "Nothing proposed to verify" : f.openingProposedById === ctx.actor.id ? "Somebody other than whoever proposed it verifies it" : !roles.approve && !roles.owner ? WHY.approve : "";
      return {
        id: f.id,
        v: { kind: "Fund account", name: f.name, code: f.code, type: FUND_TYPE_LABEL[f.type], who: f.custodianUserId ? nameOf(names, f.custodianUserId) : "—", godown: f.godownId ? (gName.get(f.godownId) ?? "—") : "—", opening: f.openingBalancePaise, openingStatus: f.openingStatus === "verified" ? "Verified" : f.openingStatus === "proposed" ? "Proposed" : "Not set", status: f.status === "active" ? "Active" : "Inactive", tally: f.tallyLedger },
        flags: [],
        title: f.name,
        header: `${FUND_TYPE_LABEL[f.type]} · opening ${f.openingStatus === "verified" ? `${inr(f.openingBalancePaise)} on ${fd(f.openingBalanceDate)}` : f.openingStatus}`,
        fields: [
          { l: "Bank account", v: f.bankAccountLabel ?? "—" },
          { l: "Opening based on", v: f.openingNote ?? "—" },
          { l: "Proposed by", v: f.openingProposedById ? nameOf(names, f.openingProposedById) : "—" },
          { l: "Verified by", v: f.openingVerifiedById ? nameOf(names, f.openingVerifiedById) : "—" },
        ],
        actions: [
          { id: "editFund", l: "Edit", why: ownerWhy, prompt: fundPrompt(f, p, gds, f.godownId ? (gName.get(f.godownId) ?? "") : "") },
          { id: "proposeOpening", l: "Propose opening balance", primary: f.openingStatus === "none" && !openingWhy, why: openingWhy, prompt: { title: `Opening balance · ${f.name}`, submit: "Propose", fields: [{ k: "amount", l: "Opening balance (₹)", t: "num", req: true, min: 0 }, { k: "date", l: "As of", t: "date", req: true }, { k: "note", l: "Based on", t: "area", req: true }], init: { amount: rupeesField(f.openingBalancePaise), date: f.openingBalanceDate ?? today() } } },
          { id: "verifyOpening", l: "Verify and post opening", primary: !verifyWhy, why: verifyWhy, confirm: `Post ${f.name}'s opening balance of ${inr(f.openingBalancePaise ?? 0)} as of ${f.openingBalanceDate}? It cannot be changed afterwards except by an adjustment.` },
        ],
      };
    });
    for (const c of l.categories) {
      rows.push({
        id: c.id,
        v: { kind: "Category", name: c.name, code: c.code, type: RULE_WORD[c.approvalRule], who: c.receiptRequired ? "Bill required" : "No bill needed", godown: c.budgetApplicable ? "Budgeted" : "Not budgeted", opening: null, openingStatus: null, status: c.active ? "Active" : "Inactive", tally: c.tallyLedger },
        flags: [],
        title: c.name,
        actions: [{ id: "editCategory", l: "Edit", why: ownerWhy, prompt: categoryPrompt(c) }],
      });
    }
    const cols: ColSpec[] = [
      { k: "kind", l: "What", t: "t" },
      { k: "name", l: "Name", t: "b" },
      { k: "code", l: "Code", t: "mono" },
      { k: "type", l: "Type / approval", t: "t" },
      { k: "who", l: "Custodian / bill", t: "t" },
      { k: "godown", l: "Godown / budget", t: "t" },
      { k: "opening", l: "Opening", t: "m" },
      { k: "openingStatus", l: "Opening status", t: "s" },
      { k: "status", l: "Status", t: "s" },
      { k: "tally", l: "Tally ledger", t: "t" },
    ];
    const tools: ToolSpec[] = [
      { id: "newFund", l: "New fund account", why: ownerWhy, prompt: fundPrompt(null, p, gds, "") },
      { id: "newCategory", l: "New category", why: ownerWhy, prompt: categoryPrompt(null) },
      {
        id: "limits",
        l: "Approval limits",
        why: ownerWhy,
        prompt: {
          title: "Approval limits and timings",
          submit: "Save",
          fields: [
            { k: "auto", l: "Approved on submission up to (₹) — 0 sends everything to an approver", t: "num", req: true, min: 0 },
            { k: "approver", l: "An approver decides up to (₹)", t: "num", req: true, min: 0 },
            { k: "budget", l: "When an expense passes its budget", t: "select", req: true, opts: ["Warn", "Needs the owner"] },
            { k: "review", l: "Days an expense may wait for a decision", t: "num", req: true, min: 1, max: 60 },
            { k: "handover", l: "Hours customer cash may be held", t: "num", req: true, min: 1, max: 720 },
          ],
          init: { auto: String(cfg.autoApproveUpToPaise / 100), approver: String(cfg.approverLimitPaise / 100), budget: cfg.budgetRule === "approval" ? "Needs the owner" : "Warn", review: String(cfg.reviewDays), handover: String(cfg.handoverHours) },
        },
      },
    ];
    return {
      spec: {
        screen: "pettySettings",
        cols,
        hidden: [],
        chips: "kind",
        tools,
        noDataLine: "No fund accounts yet.",
      },
      rows,
    };
  },
  tools: {
    async newFund(ctx, v) {
      return saveFundFromPrompt(ctx, null, v);
    },
    async newCategory(ctx, v) {
      return saveCategory(ctx, null, v);
    },
    async limits(ctx, v) {
      const roles = pettyRoles(ctx);
      if (!roles.owner && !roles.admin) return err("The owner sets approval limits.", "not_permitted");
      const { updateSettings } = await import("@/lib/config/store");
      const auto = paise(v.auto);
      const approver = paise(v.approver);
      if (auto == null || auto < 0) return fieldErr("auto", "Enter an amount");
      if (approver == null || approver < 0) return fieldErr("approver", "Enter an amount");
      const r = await updateSettings(
        [
          { key: "erp.pettyCash.autoApproveUpToPaise", value: auto },
          { key: "erp.pettyCash.approverLimitPaise", value: approver },
          { key: "erp.pettyCash.budgetRule", value: text(v.budget) === "Needs the owner" ? "approval" : "warn" },
          { key: "erp.pettyCash.reviewDays", value: Math.trunc(Number(v.review)) },
          { key: "erp.pettyCash.handoverHours", value: Math.trunc(Number(v.handover)) },
        ],
        ctx.actor.id,
      );
      if (!r.ok) return err(r.error, "validation");
      return okVoid("Approval limits saved");
    },
  },
  actions: {
    editFund: (ctx, id, v) => saveFundFromPrompt(ctx, id, v),
    editCategory: (ctx, id, v) => saveCategory(ctx, id, v),
    proposeOpening: (ctx, id, v) => proposeOpening(ctx, id, { amountPaise: paise(v.amount), date: text(v.date), note: text(v.note) }),
    verifyOpening: (ctx, id) => verifyOpening(ctx, id),
  },
};

async function saveFundFromPrompt(ctx: ErpContext, id: string | null, v: Record<string, string>): Promise<Result<unknown>> {
  const p = await people();
  const l = await lookups(ctx);
  const type = FUND_TYPES.find((x) => FUND_TYPE_LABEL[x] === text(v.type)) as FundType | undefined;
  return saveFundAccount(ctx, {
    id,
    code: text(v.code),
    name: text(v.name),
    type: type ?? null,
    bankLabel: text(v.bank),
    custodianUserId: p.us.find((u) => u.label === text(v.custodian))?.id ?? null,
    custodianEmployeeId: p.emps.find((e) => e.name === text(v.employee))?.id ?? null,
    godownId: l.godownByName.get(text(v.godown) ?? "") ?? null,
    tallyLedger: text(v.tally),
    active: text(v.status) !== "Inactive",
  });
}

async function saveCategory(ctx: ErpContext, id: string | null, v: Record<string, string>): Promise<Result<unknown>> {
  const roles = pettyRoles(ctx);
  if (!roles.owner && !roles.admin) return err("The owner or an ERP administrator sets categories.", "not_permitted");
  const code = text(v.code)?.toUpperCase();
  const name = text(v.name);
  if (!code) return fieldErr("code", "Give it a code");
  if (!name) return fieldErr("name", "Name it");
  const rule = RULE_FROM[text(v.rule) ?? ""] ?? "standard";
  return inTx(async (tx) => {
    const clash = await tx.select({ id: erpExpenseCategories.id }).from(erpExpenseCategories).where(and(sql`(lower(${erpExpenseCategories.name}) = lower(${name}) or ${erpExpenseCategories.code} = ${code})`, id ? ne(erpExpenseCategories.id, id) : undefined));
    if (clash.length) return fieldErr("name", "A category already has that name or code");
    const values = { code, name, approvalRule: rule, receiptRequired: text(v.receipt) !== "No", budgetApplicable: text(v.budget) !== "No", tallyLedger: text(v.tally), costCentre: text(v.costCentre), active: text(v.active) !== "Inactive", updatedAt: new Date(), updatedById: ctx.actor.id };
    if (id) {
      const [c] = await tx.select().from(erpExpenseCategories).where(eq(erpExpenseCategories.id, id));
      if (!c) return err("That category no longer exists.", "not_found");
      await tx.update(erpExpenseCategories).set(values).where(eq(erpExpenseCategories.id, id));
      await audit(tx, ctx, "erp.petty.category.edit", "erp_expense_category", id, { name: c.name, rule: c.approvalRule, active: c.active }, { name, rule, active: values.active });
      return okVoid(`${name} saved`);
    }
    const newId = erpId("xcat");
    await tx.insert(erpExpenseCategories).values({ id: newId, ...values, sort: 200 });
    await audit(tx, ctx, "erp.petty.category.create", "erp_expense_category", newId, null, { name, rule });
    return okVoid(`${name} added`);
  });
}

export const PETTY_FUND_SCREENS: ScreenModule[] = [overview, credits, receiptsScreen, closing, ledger, settings];
