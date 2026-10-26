import "server-only";
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { attachments, employees, erpCredits, erpExpenses, erpGodowns } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { addDays } from "@/lib/business-date";
import { err, fieldErr, okVoid, type Result } from "@/lib/result";
import type { ErpContext } from "../access";
import { refValues } from "../refs";
import { multi, paise, text, type ScreenModule, type Values } from "../server";
import type { ActionSpec, ColSpec, FieldSpec, FormSpec, ListRow } from "../ui";
import { inr, rupeesField } from "../ui";
import { scopeFor, tooWide, windowWhere, type LoadScope, type ScreenWindow } from "../window";
import { erpLink } from "../registry";
import { translate } from "@/lib/audit-labels";
import { today } from "./common";
import {
  FROM_CUSTOMER_CASH,
  FROM_WITHDRAWAL,
  MONEY_KIND_LABEL,
  PAY_MODES,
  REVIEW_LABEL,
  statement,
  txnLabel,
  advanceLate,
} from "../engines/money";
import {
  accountBalanceMap,
  advanceRows,
  bankLineRows,
  cancelAdvance,
  cancelTxn,
  candidatesFor,
  cashSources,
  createFromBankLine,
  customerChoices,
  giveAdvance,
  importBankStatement,
  matchBankLine,
  moneyAccounts,
  paidFromOf,
  partyOf,
  reopenAdvance,
  reviewTxns,
  saveAccount,
  saveExpense,
  saveReceipt,
  saveTransfer,
  settleAdvance,
  submitAdvanceBills,
  txnRows,
  unmatchBankLine,
  ignoreBankLine,
  type Actor,
  type AdvanceRow,
  type MoneyAccount,
  type TxnRow,
} from "../money";

/* ---------------------------------------------------------------------------
 * PETTY CASH — one ERP module, four sub-modules, tabs under each (the
 * registry's `section`):
 *
 *   Overview      Today (the board, `app/erp/expenses`) · All transactions
 *   Expenses      Paid · Production petty cash · Advances · Needs review · Cancelled
 *   Receipts      All receipts · Not in the bank yet · Scrap buyers
 *   Cash & Bank   Transfers · Statements · Bank statement · Accounts · Old records
 *
 * Every list here is a view of `erp_money_txns` (or of the advances and bank
 * lines that hang off it). The rules are `engines/money.ts`; the writes are
 * `lib/erp/money.ts`. The old per-employee "funds given" and expenses are
 * kept, read-only, on Old records.
 * ------------------------------------------------------------------------- */

/** What a Petty Cash record draws in its first tab: the few figures, the history behind them, and the papers. */
export type MoneyPanel = {
  figures: { l: string; v: string; tone?: "danger" | "success" }[];
  sections: { title: string; empty?: string; lines: { text: string; sub?: string; tone?: "danger" | "success" | "muted"; href?: string }[] }[];
  files: { id: string; name: string; image: boolean }[];
  note?: string;
};

const actorOf = (ctx: ErpContext): Actor => ({ id: ctx.actor.id, name: ctx.actor.name, administrator: ctx.administrator, approver: ctx.powers.has("approveMoney") });
const approverWhy = (ctx: ErpContext) => (ctx.powers.has("approveMoney") ? "" : "Only the accountant for Petty Cash");

const WIN: ScreenWindow = { label: "Date", default: "month" };

/** "+ New ▾" on every Petty Cash tab: each kind of record, opening its form on its own tab. */
export function newMenu(): { l: string; sub: string; href: string }[] {
  return [
    { l: "Expense", sub: "a cost we paid", href: erpLink("expenses", { dlg: "expense" }) },
    { l: "Petty cash expense", sub: "production's small spends", href: erpLink("pettyExpenses", { dlg: "petty" }) },
    { l: "Receipt", sub: "money that came in", href: erpLink("moneyReceipts", { dlg: "receipt" }) },
    { l: "Transfer", sub: "bank ↔ cash, bank ↔ bank", href: erpLink("moneyTransfers", { dlg: "transfer" }) },
    { l: "Advance", sub: "a lump sum to an employee", href: erpLink("advances", { dlg: "advance" }) },
  ];
}

/** An account as a Paid-from card offers it: its name and what it holds now. The name is what is saved. */
async function accountCards(kinds?: MoneyAccount["kind"][]): Promise<{ name: string; label: string }[]> {
  const [accounts, bal] = await Promise.all([moneyAccounts(), accountBalanceMap()]);
  return accounts.filter((a) => a.active && (!kinds || kinds.includes(a.kind))).map((a) => ({ name: a.name, label: `${a.name} · ${inr(bal.get(a.id) ?? 0)}` }));
}
/** The account name inside a card's label. */
const cardName = (v: string | null) => (v ? v.split(" · ")[0] : null);

/** The categories an expense is filed under: the reference list, with the usual ones where it is empty. */
const DEFAULT_CATEGORIES = ["Petrol", "Tea / food", "Transportation", "Freight", "Courier", "Labour", "Repairs & maintenance", "Hardware", "Testing material", "Packing material", "Stationery", "Electricity", "Rent", "Telephone & internet", "Bank charges", "Other"];

async function categories(): Promise<string[]> {
  const configured = await refValues("expenseCategory");
  return configured.length ? [...new Set([...configured, "Other"])] : DEFAULT_CATEGORIES;
}

async function activeEmployees(): Promise<string[]> {
  return (await db.select({ name: employees.name }).from(employees).where(eq(employees.status, "active")).orderBy(asc(employees.name))).map((e) => e.name);
}

/** The papers on a set of transactions, by transaction. */
async function filesOf(ids: string[]): Promise<Map<string, MoneyPanel["files"]>> {
  const out = new Map<string, MoneyPanel["files"]>();
  if (!ids.length) return out;
  const rows = await db
    .select({ id: attachments.id, parentId: attachments.parentId, name: attachments.filename, type: attachments.contentType })
    .from(attachments)
    .where(and(eq(attachments.parentType, "erp_money_txn"), inArray(attachments.parentId, ids), sql`${attachments.status} <> 'removed'`));
  for (const r of rows) out.set(r.parentId!, [...(out.get(r.parentId!) ?? []), { id: r.id, name: r.name, image: r.type.startsWith("image/") }]);
  return out;
}

/** Counts a window first, so a long period answers "too long" instead of building every row. */
async function windowed(where: SQL, s: LoadScope, date: SQL = sql`t.txn_date`): Promise<{ rows: TxnRow[]; wide: ReturnType<typeof tooWide> }> {
  const cond = sql`${where} and ${windowWhere(date, sql`t.id`, s)}`;
  const [n] = (await db.execute(sql`select count(*)::int as n from erp_money_txns t where ${cond}`)) as unknown as { n: number }[];
  const wide = tooWide(Number(n?.n ?? 0), s);
  return { rows: wide ? [] : await txnRows(cond), wide };
}

/* ================================================================== forms */

async function accountNames(kinds?: MoneyAccount["kind"][]): Promise<string[]> {
  return (await moneyAccounts()).filter((a) => a.active && (!kinds || kinds.includes(a.kind))).map((a) => a.name);
}

async function expenseForm(ctx: ErpContext, petty: boolean, t?: TxnRow): Promise<FormSpec> {
  const [cats, cards, cust, wd] = await Promise.all([categories(), accountCards(petty ? ["bank", "petty"] : undefined), cashSources("customer"), cashSources("withdrawal")]);
  /* On a correction, the cash it already came from is offered too, with what it took added back. */
  const keep = t?.sourceTxnId && t.sourceLabel ? [`${t.sourceLabel} · already used here`] : [];
  const [src] = t?.sourceTxnId ? await txnRows(sql`t.id = ${t.sourceTxnId}`) : [];
  const cardFor = (name: string | null) => cards.find((c) => c.name === name)?.label ?? name ?? "";
  const paidFrom = t ? (src ? (src.kind === "transfer" ? FROM_WITHDRAWAL : FROM_CUSTOMER_CASH) : cardFor(t.from)) : "";
  return {
    screen: petty ? "pettyExpenses" : "expenses",
    id: "new",
    title: t ? `Correct ${t.label}` : petty ? "New petty cash expense" : "New expense",
    sub: petty
      ? "Submitted by the Production Head as it is paid → the Accountant reviews it."
      : "Entered when it is paid — there is no unpaid state. Needs approval above the limit set in ERP settings.",
    submit: t ? "Save correction" : "Save expense",
    recordId: t?.id,
    init: t
      ? {
          date: t.date,
          category: t.category ?? "",
          payee: t.payee ?? "",
          invoiceNo: t.invoiceNo ?? "",
          description: t.description ?? "",
          amount: rupeesField(t.amountPaise),
          paidFrom,
          source: keep[0] ?? "",
          mode: t.mode ?? "",
          reference: t.reference ?? "",
          note: t.note ?? "",
          different: t.duplicateOverride ? "Yes" : "",
        }
      : { date: today(), mode: petty ? "Cash" : "NEFT", paidFrom: petty ? (cards.find((c) => c.label.startsWith("Petty"))?.label ?? "") : "" },
    header: [
      { k: "date", l: petty ? "Date" : "Paid on", t: "date", req: true, sec: "What & who" },
      { k: "category", l: "Category", t: "select", req: true, opts: cats, sec: "What & who" },
      { k: "amount", l: "Amount (₹)", t: "num", req: true, min: 0.01, sec: "What & who" },
      { k: "payee", l: petty ? "Paid to" : "Vendor / payee", t: "text", sec: "What & who", hint: petty ? "The shop, pump or person." : undefined },
      { k: "invoiceNo", l: petty ? "Invoice / bill no." : "Invoice number", t: "text", req: true, sec: "What & who" },
      { k: "description", l: petty ? "Purpose" : "Description / purpose", t: "text", req: !petty, sec: "What & who" },
      { k: "different", l: "This is a different invoice with the same number", t: "pick", opts: ["Yes"], sec: "What & who", untagged: true, hint: "Only when the duplicate warning is wrong." },
      { k: "paidFrom", l: "Paid from", t: "pick", req: true, opts: [...cards.map((c) => c.label), FROM_CUSTOMER_CASH, FROM_WITHDRAWAL], sec: "Payment", hint: "Cash from a customer, or cash drawn from a bank, is Cash in Hand traced to where it came from." },
      {
        k: "source",
        l: "Which cash",
        t: "select",
        req: true,
        sec: "Payment",
        when: { k: "paidFrom", in: [FROM_CUSTOMER_CASH, FROM_WITHDRAWAL] },
        optsBy: { by: "paidFrom", map: { [FROM_CUSTOMER_CASH]: [...keep, ...cust.map((c) => c.label)], [FROM_WITHDRAWAL]: [...keep, ...wd.map((c) => c.label)] } },
        hint: "The receipt must already be on Receipts — e.g. a customer's cash with something still unused. Only cash with something left is offered.",
      },
      { k: "mode", l: "Mode", t: "select", req: true, opts: [...PAY_MODES], sec: "Payment" },
      { k: "reference", l: "UTR / cheque no. / reference", t: "text", sec: "Payment", hint: "What the bank statement will show — it is how the line is matched." },
      { k: "file1", l: petty ? "Bill photo" : "Invoice / supporting document", t: "photo", sec: "Payment" },
      { k: "file2", l: "Another page", t: "photo", sec: "Payment" },
      { k: "note", l: "Notes", t: "area", sec: "Payment", mic: true },
    ],
  };
}

async function receiptForm(t?: TxnRow): Promise<FormSpec> {
  const [cards, cust] = await Promise.all([accountCards(), customerChoices()]);
  const cardFor = (name: string | null) => cards.find((c) => c.name === name)?.label ?? name ?? "";
  return {
    screen: "moneyReceipts",
    id: "new",
    title: t ? `Correct ${t.label}` : "New receipt",
    sub: "Money that came in: who paid, how much, and which account it landed in.",
    submit: t ? "Save correction" : "Save receipt",
    recordId: t?.id,
    init: t
      ? { date: t.date, into: cardFor(t.to), amount: rupeesField(t.amountPaise), customer: cust.find((c) => c.id === t.customerId)?.label ?? "", payer: t.payer ?? "", mode: t.mode ?? "", reference: t.reference ?? "", billsText: t.billsText ?? "", note: t.note ?? "" }
      : { date: today(), mode: "NEFT" },
    header: [
      { k: "date", l: "Received on", t: "date", req: true, sec: "Money" },
      { k: "into", l: "Received into", t: "pick", req: true, opts: cards.map((c) => c.label), sec: "Money" },
      { k: "amount", l: "Amount (₹)", t: "num", req: true, min: 0.01, sec: "Money" },
      { k: "mode", l: "How it came", t: "select", req: true, opts: [...PAY_MODES], sec: "Money", hint: "Cash in Hand and Petty Cash take only cash." },
      { k: "reference", l: "UTR / cheque no. / slip", t: "text", sec: "Money" },
      { k: "customer", l: "Customer", t: "select", opts: cust.map((c) => c.label), sec: "From", hint: "A customer of the book. Leave empty and name the payer for anybody else." },
      { k: "payer", l: "Paid by (not a customer)", t: "text", sec: "From" },
      { k: "billsText", l: "Bills it pays", t: "text", sec: "From", hint: "As the customer said, e.g. MMI/0981, MMI/1044. Accounts confirm it against the ledger." },
      { k: "file1", l: "Slip / screenshot", t: "photo", sec: "From" },
      { k: "note", l: "Notes", t: "area", sec: "From" },
    ],
  };
}

async function transferForm(t?: TxnRow): Promise<FormSpec> {
  const [cards, cash, cust] = await Promise.all([accountCards(), accountCards(["cash"]), cashSources("customer")]);
  const names = cards.map((c) => c.label);
  const cardFor = (name: string | null) => cards.find((c) => c.name === name)?.label ?? name ?? "";
  const keep = t?.sourceTxnId && t.sourceLabel ? [`${t.sourceLabel} · already used here`] : [];
  return {
    screen: "moneyTransfers",
    id: "new",
    title: t ? `Correct ${t.label}` : "New transfer",
    sub: "Money moved between our own accounts. Both balances change together; it is never income or expense.",
    submit: t ? "Save correction" : "Save transfer",
    recordId: t?.id,
    init: t ? { date: t.date, from: cardFor(t.from), to: cardFor(t.to), amount: rupeesField(t.amountPaise), mode: t.mode ?? "", reference: t.reference ?? "", source: keep[0] ?? "", note: t.note ?? "" } : { date: today(), mode: "Cash" },
    header: [
      { k: "date", l: "Date", t: "date", req: true },
      { k: "from", l: "From", t: "pick", req: true, opts: names },
      { k: "to", l: "To", t: "pick", req: true, opts: names },
      { k: "amount", l: "Amount (₹)", t: "num", req: true, min: 0.01 },
      { k: "mode", l: "How", t: "select", req: true, opts: [...PAY_MODES], hint: "A withdrawal or a deposit is Cash; between banks, NEFT / RTGS / IMPS." },
      { k: "reference", l: "Cheque / slip / UTR", t: "text" },
      ...cash.map(
        (c): FieldSpec => ({ k: "source", l: "Customer cash being deposited", t: "select", opts: [...keep, ...cust.map((x) => x.label)], when: { k: "from", eq: c.label }, hint: "Optional. Naming it lets the receipt show where its cash went." }),
      ),
      { k: "file1", l: "Slip photo", t: "photo" },
      { k: "note", l: "Notes", t: "area" },
    ],
  };
}

async function advanceForm(): Promise<FormSpec> {
  const [people, cards, cfg] = await Promise.all([activeEmployees(), accountCards(), getConfig()]);
  const petty = cards.find((c) => c.label.startsWith("Petty"))?.label ?? "";
  return {
    screen: "advances",
    id: "new",
    title: "Give an advance",
    sub: "A lump sum handed to an employee. It is a transfer into their hands — nothing is an expense until their bills are approved.",
    submit: "Give advance",
    init: { date: today(), billsDueOn: addDays(today(), cfg["erp.money.advanceBillsDays"]), from: petty, mode: "Cash" },
    header: [
      { k: "employee", l: "Given to", t: "select", req: true, opts: people },
      { k: "amount", l: "Amount (₹)", t: "num", req: true, min: 0.01 },
      { k: "date", l: "Given on", t: "date", req: true },
      { k: "purpose", l: "For", t: "text", hint: "e.g. Diesel and loading labour, Bhiwandi trip" },
      { k: "billsDueOn", l: "Bills due by", t: "date", hint: "They are reminded on the list after this day." },
      { k: "from", l: "Paid from", t: "pick", req: true, opts: cards.map((c) => c.label), hint: "A transfer, not an expense: this account goes down and the employee's advance goes up." },
      { k: "mode", l: "Handed over as", t: "select", req: true, opts: [...PAY_MODES] },
      { k: "reference", l: "UTR / reference", t: "text" },
      { k: "note", l: "Notes", t: "area" },
    ],
  };
}

async function billsForm(a: AdvanceRow): Promise<FormSpec> {
  const cats = await categories();
  return {
    screen: "advances",
    id: "bills",
    title: `Submit bills against ${a.label}`,
    sub: `${a.employee} · ${inr(a.position.withThem)} not yet accounted for. A photo for every bill; a line with no bill needs a reason.`,
    submit: "Submit for review",
    recordId: a.id,
    header: [],
    line: [
      { k: "date", l: "Date", t: "date", req: true },
      { k: "category", l: "Category", t: "select", req: true, opts: cats },
      { k: "payee", l: "Paid to", t: "text" },
      { k: "invoiceNo", l: "Bill no.", t: "text" },
      { k: "amount", l: "Amount (₹)", t: "num", req: true, min: 0.01 },
      { k: "photo", l: "Bill photo", t: "photo" },
      { k: "noBillReason", l: "No bill? Why", t: "text" },
      { k: "description", l: "What for", t: "text" },
    ],
    lineLabel: "Bill",
    lineLayout: "cards",
    initLines: [{ date: today() }],
  };
}

/* ================================================================== rows */

const KIND_COL: ColSpec = { k: "kind", l: "Type", t: "s" };

function reviewWord(t: TxnRow): string {
  if (t.status === "cancelled") return "Cancelled";
  return t.review === "none" ? "Posted" : REVIEW_LABEL[t.review];
}

function bankWord(t: TxnRow): string {
  const bankSide = t.fromKind === "bank" || t.toKind === "bank";
  if (!bankSide) return t.advanceId && !t.from ? "Advance" : "Cash — none";
  if (t.status === "cancelled") return "—";
  return t.matchedPaise >= t.amountPaise ? "Matched" : t.matchedPaise > 0 ? "Part matched" : "Not matched";
}

/** One transaction as every Petty Cash list draws it: its record, and what may be done to it. */
async function txnListRows(ctx: ErpContext, rows: TxnRow[]): Promise<ListRow[]> {
  const ids = rows.map((r) => r.id);
  const [papers, uses] = await Promise.all([filesOf(ids), ids.length ? txnRows(sql`t.source_txn_id in ${ids}`) : Promise.resolve([] as TxnRow[])]);
  const approver = ctx.powers.has("approveMoney");
  return rows.map((t) => {
    const live = t.status === "active";
    const own = t.createdById === ctx.actor.id && !ctx.administrator;
    const mine = uses.filter((u) => u.sourceTxnId === t.id);
    const actions: ActionSpec[] = [];
    if (live && (t.review === "to_review" || t.review === "sent_back")) {
      const why = approverWhy(ctx) || (own ? "Somebody else reviews what you entered" : "");
      actions.push({ id: "approve", l: "Approve", primary: true, why });
      if (t.review === "to_review") actions.push({ id: "sendBack", l: "Send back", why, prompt: { title: `Send ${t.label} back`, sub: "It stays recorded; whoever entered it fixes it and it comes back for review.", submit: "Send back", fields: [{ k: "note", l: "What needs fixing", t: "area", req: true }] } });
    }
    const editable = live && !t.scrapReceiptId && !t.advanceId && (t.kind === "expense" || t.kind === "receipt" || t.kind === "transfer");
    if (editable)
      actions.push({
        id: "edit",
        l: "Correct",
        loadsForm: true,
        why: t.review === "approved" && !approver ? "Approved — only the accountant corrects it" : t.createdById !== ctx.actor.id && !approver ? "Only whoever entered it, or the accountant" : "",
      });
    const cancellable = live && !t.scrapReceiptId && t.kind !== "advance" && t.kind !== "advance_return" && t.kind !== "advance_topup";
    if (cancellable)
      actions.push({
        id: "cancel",
        l: "Cancel",
        why: t.matchedPaise > 0 ? "Matched to a bank line — undo the match first" : t.usedPaise > 0 ? "Cash from it has been paid onward" : !approver && (t.createdById !== ctx.actor.id || t.review === "approved") ? "Only the accountant, or whoever entered it before approval" : "",
        prompt: { title: `Cancel ${t.label}?`, sub: "It stays on record, marked cancelled, and stops counting in every balance.", submit: "Cancel it", fields: [{ k: "reason", l: "Why", t: "area", req: true }] },
      });
    const figures: MoneyPanel["figures"] = [{ l: MONEY_KIND_LABEL[t.kind], v: inr(t.amountPaise), tone: t.kind === "receipt" ? "success" : undefined }];
    if (t.fromKind === "bank" || t.toKind === "bank") figures.push({ l: "Bank matched", v: inr(t.matchedPaise), tone: t.matchedPaise >= t.amountPaise ? "success" : "danger" });
    if (t.kind === "receipt" || (t.kind === "transfer" && t.toKind === "cash")) figures.push({ l: "Still unused", v: inr(t.amountPaise - t.usedPaise), tone: t.amountPaise - t.usedPaise > 0 ? undefined : "success" });
    const sections: MoneyPanel["sections"] = [];
    if (t.kind === "receipt" || (t.kind === "transfer" && t.toKind === "cash"))
      sections.push({
        title: "How this cash was used",
        empty: t.toKind === "bank" ? "Money in a bank is not traced onward." : "Not linked to any use yet.",
        lines: [
          ...mine.map((u) => ({ text: `${inr(u.amountPaise)} · ${u.kind === "transfer" ? `deposited to ${u.to}` : `${u.category ?? "expense"} — ${u.payee ?? "—"}`}`, sub: `${u.label} · ${u.date}${u.status === "cancelled" ? " · cancelled" : ""}`, tone: u.status === "cancelled" ? ("muted" as const) : undefined })),
          ...(t.amountPaise - t.usedPaise > 0 && t.toKind !== "bank" ? [{ text: `${inr(t.amountPaise - t.usedPaise)} still in ${t.to}`, sub: "not linked to any use yet" }] : []),
        ],
      });
    const history: MoneyPanel["sections"][number]["lines"] = [{ text: `Entered by ${t.by ?? "—"}`, sub: new Date(t.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) }];
    if (t.reviewedBy) history.push({ text: `${t.review === "sent_back" ? "Sent back" : "Approved"} by ${t.reviewedBy}`, sub: t.reviewNote ?? undefined, tone: t.review === "sent_back" ? "danger" : "success" });
    if (t.status === "cancelled") history.push({ text: "Cancelled", sub: t.cancelReason ?? undefined, tone: "danger" });
    sections.push({ title: "History", lines: history });
    const fields = [
      { l: "Transaction", v: t.label },
      { l: "Date", v: t.date },
      ...(t.category ? [{ l: "Category", v: t.category }] : []),
      ...(t.invoiceNo ? [{ l: "Invoice / bill no.", v: t.invoiceNo }] : []),
      ...(t.noBillReason ? [{ l: "No bill because", v: t.noBillReason }] : []),
      ...(t.description ? [{ l: "For", v: t.description }] : []),
      ...(t.kind === "expense" || t.kind === "advance" || t.kind === "advance_topup" ? [{ l: "Paid from", v: paidFromOf(t) }] : []),
      ...(t.kind === "receipt" || t.kind === "advance_return" ? [{ l: "Received into", v: `${t.to ?? "—"}${t.mode ? ` · ${t.mode}` : ""}` }] : []),
      ...(t.kind === "transfer" ? [{ l: "From → to", v: `${t.from} → ${t.to}${t.mode ? ` · ${t.mode}` : ""}` }] : []),
      ...(t.reference ? [{ l: "Reference", v: t.reference }] : []),
      ...(t.billsText ? [{ l: "Bills it pays", v: t.billsText }] : []),
      ...(t.advanceLabel ? [{ l: "Advance", v: `${t.advanceLabel} · ${t.advanceEmployee}` }] : []),
      ...(t.scrapReceiptId ? [{ l: "Scrap", v: "A scrap buyer's receipt — corrected or voided on Receipts → Scrap buyers" }] : []),
      ...(t.duplicateOverride ? [{ l: "Duplicate check", v: "Saved as a different invoice with the same number" }] : []),
      ...(t.note ? [{ l: "Notes", v: t.note }] : []),
    ];
    return {
      id: t.id,
      v: {
        txn: t.label,
        date: t.date,
        kind: MONEY_KIND_LABEL[t.kind],
        category: t.category,
        party: partyOf(t),
        invoice: t.invoiceNo ?? (t.noBillReason ? "No bill" : null),
        amount: t.amountPaise,
        from: t.kind === "receipt" || t.kind === "advance_return" ? (t.to ?? "—") : paidFromOf(t),
        to: t.to,
        into: t.to,
        mode: t.mode,
        reference: t.reference,
        review: reviewWord(t),
        bank: bankWord(t),
        left: t.kind === "receipt" && t.toKind !== "bank" ? t.amountPaise - t.usedPaise : null,
        description: t.description,
      },
      flags: [...(t.duplicateOverride ? ["duplicate"] : []), ...(t.review === "sent_back" ? ["sentBack"] : []), ...(t.noBillReason ? ["noBill"] : [])],
      title: `${t.label} · ${partyOf(t)} · ${inr(t.amountPaise)}`,
      header: `${MONEY_KIND_LABEL[t.kind]} · ${t.date} · ${reviewWord(t)}`,
      fields,
      actions,
      by: `Entered by ${t.by ?? "—"}`,
      panel: { kind: "money", data: { figures, sections, files: papers.get(t.id) ?? [], note: t.review === "sent_back" && t.reviewNote ? `Sent back: ${t.reviewNote}` : undefined } satisfies MoneyPanel },
    } satisfies ListRow;
  });
}

const TXN_ACTIONS = {
  async approve(ctx: ErpContext, id: string) {
    return reviewTxns(actorOf(ctx), [id], "approved", null);
  },
  async sendBack(ctx: ErpContext, id: string, v: Values) {
    return reviewTxns(actorOf(ctx), [id], "sent_back", text(v.note));
  },
  async cancel(ctx: ErpContext, id: string, v: Values) {
    return cancelTxn(actorOf(ctx), id, v.reason ?? "");
  },
};

/** "Correct" opens the form the transaction was made with, filled in. */
async function editLoader(ctx: ErpContext, id: string): Promise<FormSpec | null> {
  const [t] = await txnRows(sql`t.id = ${id}`);
  if (!t || t.status !== "active") return null;
  const f = t.kind === "expense" ? await expenseForm(ctx, t.petty, t) : t.kind === "receipt" ? await receiptForm(t) : t.kind === "transfer" ? await transferForm(t) : null;
  /* The form posts to the list its kind lives on, whichever tab it was opened from. */
  return f;
}

/** Saves any of the three forms, a new row or a correction (`recordId`). */
async function saveFromForm(ctx: ErpContext, kind: "expense" | "petty" | "receipt" | "transfer", h: Values, recordId?: string): Promise<Result<unknown>> {
  const files = [text(h.file1), text(h.file2)].filter((x): x is string => !!x);
  const actor = actorOf(ctx);
  if (kind === "expense" || kind === "petty") {
    let source = text(h.source);
    let petty = kind === "petty";
    if (recordId) {
      const [t] = await txnRows(sql`t.id = ${recordId}`);
      petty = !!t?.petty;
      if (source?.endsWith("· already used here") && t?.sourceLabel) source = `${t.sourceLabel}`;
    }
    const r = await saveExpense(actor, {
      id: recordId,
      petty,
      date: text(h.date) ?? "",
      category: text(h.category),
      payee: text(h.payee),
      invoiceNo: text(h.invoiceNo),
      description: text(h.description),
      amountPaise: paise(h.amount),
      paidFrom: h.paidFrom === FROM_CUSTOMER_CASH || h.paidFrom === FROM_WITHDRAWAL ? text(h.paidFrom) : cardName(text(h.paidFrom)),
      source,
      mode: text(h.mode),
      reference: text(h.reference),
      note: text(h.note),
      files,
      duplicateOverride: h.different === "Yes",
    });
    return r.ok ? okVoid(r.message) : r;
  }
  if (kind === "receipt") {
    const r = await saveReceipt(actor, { id: recordId, date: text(h.date) ?? "", into: cardName(text(h.into)), amountPaise: paise(h.amount), customer: text(h.customer), payer: text(h.payer), mode: text(h.mode), reference: text(h.reference), billsText: text(h.billsText), note: text(h.note), files });
    return r.ok ? okVoid(r.message) : r;
  }
  let source = text(h.source);
  if (recordId && source?.endsWith("· already used here")) {
    const [t] = await txnRows(sql`t.id = ${recordId}`);
    source = t?.sourceLabel ?? source;
  }
  const r = await saveTransfer(actor, { id: recordId, date: text(h.date) ?? "", from: cardName(text(h.from)), to: cardName(text(h.to)), amountPaise: paise(h.amount), mode: text(h.mode), reference: text(h.reference), source, note: text(h.note), files });
  return r.ok ? okVoid(r.message) : r;
}

/** Which form a correction of this row saves through. */
async function kindOf(id: string): Promise<"expense" | "petty" | "receipt" | "transfer" | null> {
  const [t] = await txnRows(sql`t.id = ${id}`);
  if (!t) return null;
  return t.kind === "expense" ? (t.petty ? "petty" : "expense") : t.kind === "receipt" ? "receipt" : t.kind === "transfer" ? "transfer" : null;
}

const formsFor = (kind: "expense" | "petty" | "receipt" | "transfer") => ({
  async new(ctx: ErpContext, h: Values, _l: Values[], recordId?: string) {
    if (recordId) {
      const k = await kindOf(recordId);
      if (!k) return err("That transaction no longer exists.", "not_found");
      return saveFromForm(ctx, k, h, recordId);
    }
    return saveFromForm(ctx, kind, h);
  },
});

/* ============================================================ the lists */

/* The columns each list draws, as the mockups lay them out. */
const PAID_COLS: ColSpec[] = [
  { k: "txn", l: "TXN ID", t: "mono" },
  { k: "date", l: "Date", t: "d" },
  { k: "category", l: "Category", t: "t" },
  { k: "party", l: "Vendor / payee", t: "b" },
  { k: "invoice", l: "Invoice no.", t: "t" },
  { k: "description", l: "Description", t: "t" },
  { k: "amount", l: "Amount", t: "m" },
  { k: "from", l: "Paid from", t: "t" },
  { k: "review", l: "Status", t: "s" },
  { k: "bank", l: "Bank match", t: "s" },
];

const PETTY_COLS: ColSpec[] = [
  { k: "txn", l: "TXN ID", t: "mono" },
  { k: "date", l: "Date", t: "d" },
  { k: "category", l: "Category", t: "t" },
  { k: "party", l: "Paid to", t: "b" },
  { k: "invoice", l: "Bill no.", t: "t" },
  { k: "from", l: "Paid from", t: "t" },
  { k: "amount", l: "Amount", t: "m" },
  { k: "review", l: "Status", t: "s" },
];

const REVIEW_COLS: ColSpec[] = [
  { k: "txn", l: "TXN ID", t: "mono" },
  { k: "date", l: "Date", t: "d" },
  KIND_COL,
  { k: "party", l: "Paid to", t: "b" },
  { k: "category", l: "Category", t: "t" },
  { k: "invoice", l: "Bill no.", t: "t" },
  { k: "amount", l: "Amount", t: "m" },
  { k: "from", l: "Paid from", t: "t" },
  { k: "review", l: "Status", t: "s" },
];

const RECEIPT_COLS: ColSpec[] = [
  { k: "txn", l: "TXN ID", t: "mono" },
  { k: "date", l: "Date", t: "d" },
  { k: "party", l: "Customer / payer", t: "b" },
  { k: "into", l: "Received into", t: "t" },
  { k: "mode", l: "Mode", t: "s" },
  { k: "reference", l: "Reference", t: "mono" },
  { k: "amount", l: "Amount", t: "m" },
  { k: "left", l: "Cash unused", t: "m" },
  { k: "bank", l: "Bank match", t: "s" },
];

const TRANSFER_COLS: ColSpec[] = [
  { k: "txn", l: "TXN ID", t: "mono" },
  { k: "date", l: "Date", t: "d" },
  { k: "party", l: "From → To", t: "b" },
  { k: "mode", l: "Mode", t: "s" },
  { k: "reference", l: "Reference", t: "mono" },
  { k: "amount", l: "Amount", t: "m" },
  { k: "bank", l: "Bank match", t: "s" },
];

function txnList(key: string, o: { where: SQL; cols?: ColSpec[]; chips?: string; groups?: string[]; newForm?: (ctx: ErpContext) => Promise<FormSpec | undefined>; newLabel?: string; noData: string; bulkApprove?: boolean; form?: "expense" | "petty" | "receipt" | "transfer"; window?: ScreenWindow | null }): ScreenModule {
  const win = o.window === null ? undefined : (o.window ?? WIN);
  return {
    key,
    ...(win ? { window: win } : {}),
    async load(ctx, scope) {
      const s = scope ?? scopeFor(win, { pd: "", ids: null }, null);
      const { rows, wide } = win ? await windowed(o.where, s) : { rows: await txnRows(o.where), wide: null };
      const approver = ctx.powers.has("approveMoney");
      return {
        spec: {
          screen: key,
          cols: o.cols ?? PAID_COLS,
          hidden: [],
          ...(o.groups ? { groups: o.groups } : {}),
          chips: o.chips ?? "review",
          agg: { k: "amount", l: "total" },
          bulk: o.bulkApprove && approver ? [{ id: "approve", l: "Approve" }] : undefined,
          newForm: o.newForm ? await o.newForm(ctx) : undefined,
          newLabel: o.newLabel,
          newMenu: newMenu(),
          readOnly: !!ctx.viewingAs,
          noDataLine: o.noData,
        },
        rows: await txnListRows(ctx, rows),
        tooWide: wide,
      };
    },
    actions: TXN_ACTIONS,
    bulk: {
      async approve(ctx, ids) {
        return reviewTxns(actorOf(ctx), ids, "approved", null);
      },
    },
    forms: o.form ? formsFor(o.form) : undefined,
    formLoaders: { edit: editLoader },
  };
}

const expensesPaid = txnList("expenses", {
  where: sql`t.kind = 'expense' and t.status = 'active'`,
  cols: PAID_COLS,
  chips: "bank",
  newForm: (ctx) => expenseForm(ctx, false),
  newLabel: "New expense",
  form: "expense",
  bulkApprove: true,
  noData: "No expenses this period. An expense is entered when it is paid, with the account it left.",
});

const pettyExpenses = txnList("pettyExpenses", {
  where: sql`t.kind = 'expense' and t.status = 'active' and t.petty`,
  cols: PETTY_COLS,
  newForm: (ctx) => expenseForm(ctx, true),
  newLabel: "New petty cash expense",
  form: "petty",
  bulkApprove: true,
  noData: "No petty cash this period. The Production Head's small spends are entered here as they are paid, and the accountant reviews them.",
});

const moneyReview = txnList("moneyReview", {
  where: sql`t.status = 'active' and t.review in ('to_review', 'sent_back')`,
  cols: REVIEW_COLS,
  window: null,
  bulkApprove: true,
  form: "expense",
  noData: "Nothing waiting for approval. Petty cash, bills against advances and office expenses above the limit come here.",
});

const expensesCancelled = txnList("expensesCancelled", {
  where: sql`t.status = 'cancelled'`,
  cols: [...PAID_COLS.slice(0, 4), KIND_COL, { k: "amount", l: "Amount", t: "m" }, { k: "review", l: "Status", t: "s" }],
  chips: "kind",
  noData: "Nothing cancelled this period. A cancelled transaction stays here with its reason; it counts in no balance.",
});

const moneyTxns = txnList("moneyTxns", {
  where: sql`t.kind = 'expense'`,
  cols: PAID_COLS,
  newForm: (ctx) => expenseForm(ctx, false),
  newLabel: "New expense",
  form: "expense",
  noData: "No expenses this period, paid or cancelled.",
});

const RECEIPT_NEW = { newForm: async () => receiptForm(), newLabel: "New receipt", form: "receipt" as const };

const moneyReceipts = txnList("moneyReceipts", {
  where: sql`t.kind = 'receipt'`,
  cols: RECEIPT_COLS,
  chips: "bank",
  ...RECEIPT_NEW,
  noData: "No receipts this period. Money that comes in is recorded here, into the account it landed in.",
});

const receiptsBank = txnList("receiptsBank", {
  where: sql`t.kind = 'receipt' and exists (select 1 from erp_money_accounts a where a.id = t.to_account_id and a.kind = 'bank')`,
  cols: RECEIPT_COLS.filter((c) => c.k !== "left"),
  chips: "bank",
  ...RECEIPT_NEW,
  noData: "No bank receipts this period.",
});

const receiptsCash = txnList("receiptsCash", {
  where: sql`t.kind = 'receipt' and exists (select 1 from erp_money_accounts a where a.id = t.to_account_id and a.kind <> 'bank')`,
  cols: RECEIPT_COLS.filter((c) => c.k !== "bank"),
  chips: "into",
  ...RECEIPT_NEW,
  noData: "No cash receipts this period. Opening one shows how its cash was used.",
});

const receiptsUnmatched = txnList("receiptsUnmatched", {
  where: sql`t.kind = 'receipt' and t.status = 'active' and exists (select 1 from erp_money_accounts a where a.id = t.to_account_id and a.kind = 'bank')
             and t.amount_paise > coalesce((select sum(m.amount_paise) from erp_bank_matches m where m.txn_id = t.id and m.voided_at is null), 0)`,
  cols: RECEIPT_COLS.filter((c) => c.k !== "left"),
  chips: "into",
  window: null,
  ...RECEIPT_NEW,
  noData: "Every bank receipt is on its statement. One appears here until a line of the bank's statement is matched to it.",
});

const moneyTransfers = txnList("moneyTransfers", {
  where: sql`t.kind = 'transfer'`,
  cols: TRANSFER_COLS,
  chips: "bank",
  newForm: async () => transferForm(),
  newLabel: "New transfer",
  form: "transfer",
  noData: "No transfers this period. Bank → cash, cash → bank and bank → bank are recorded here: both balances move, and the books' income and expense do not.",
});

/* ---------------------------------------------------------------- advances */

const advances: ScreenModule = {
  key: "advances",
  window: { label: "Given on", default: "90d" },
  async load(ctx, scope) {
    const s = scope ?? scopeFor({ label: "Given on", default: "90d" }, { pd: "", ids: null }, null);
    /* Open advances always show, whatever the period: they are work, not history. */
    const rows = await advanceRows(sql`(a.status = 'open' or ${windowWhere(sql`a.issued_on`, sql`a.id`, s)})`);
    const day = today();
    const approver = ctx.powers.has("approveMoney");
    const accounts = await accountNames();
    const billIds = rows.flatMap((a) => a.bills.map((b) => b.id));
    const papers = await filesOf(billIds);
    const depts = new Map(((await db.execute(sql`select lower(name) as name, coalesce(department, position) as dept from employees`)) as unknown as { name: string; dept: string | null }[]).map((e) => [e.name, e.dept]));
    const bills = new Map<string, FormSpec>();
    for (const a of rows) if (a.status === "open") bills.set(a.id, await billsForm(a));
    return {
      spec: {
        screen: "advances",
        cols: [
          { k: "no", l: "Advance", t: "mono" },
          { k: "employee", l: "Given to", t: "b" },
          { k: "dept", l: "Department", t: "t" },
          { k: "date", l: "Issued", t: "d" },
          { k: "from", l: "From", t: "t" },
          { k: "given", l: "Given", t: "m" },
          { k: "approved", l: "Bills approved", t: "m" },
          { k: "review", l: "Bills to review", t: "m" },
          { k: "withThem", l: "Still with them", t: "m" },
          { k: "state", l: "Status", t: "s" },
        ],
        hidden: [],
        chips: "state",
        agg: { k: "withThem", l: "still with employees" },
        newForm: await advanceForm(),
        newLabel: "Give an advance",
        newMenu: newMenu(),
        readOnly: !!ctx.viewingAs,
        noDataLine: "No advances. A lump sum given to an employee is recorded here; they submit their bills against it and the accountant settles what is left.",
      },
      rows: rows.map((a) => {
        const p = a.position;
        const late = advanceLate({ status: a.status, billsDueOn: a.billsDueOn, billCount: a.bills.filter((b) => b.status === "active").length }, day);
        const state = a.status === "settled" ? "Settled" : a.status === "cancelled" ? "Cancelled" : late ? "Bills late" : p.toReview > 0 ? "Bills to review" : p.sentBack > 0 ? "Bill sent back" : a.bills.length ? "Open" : "Open · no bills yet";
        const settleSub = p.settleAmount > 0 ? `${inr(p.settleAmount)} comes back from ${a.employee}.` : p.settleAmount < 0 ? `${a.employee} spent ${inr(-p.settleAmount)} more than given — it is paid to them.` : "Spent exactly what was given: nothing moves.";
        const actions: ActionSpec[] = [
          ...(a.status === "open" ? [{ id: "bills", l: "Submit bills", primary: p.toReview === 0, form: bills.get(a.id) } as ActionSpec] : []),
          ...(a.status === "open"
            ? [
                {
                  id: "settle",
                  l: "Settle",
                  primary: !p.settleWhy,
                  why: approverWhy(ctx) || p.settleWhy || "",
                  prompt: {
                    title: `Settle ${a.label}`,
                    sub: settleSub,
                    submit: p.settleAmount > 0 ? `Settle · ${inr(p.settleAmount)} returned` : p.settleAmount < 0 ? `Settle · pay ${inr(-p.settleAmount)}` : "Settle",
                    fields: [
                      { k: "account", l: p.settleAmount >= 0 ? "Returned into" : "Paid from", t: "select", req: true, opts: accounts },
                      { k: "mode", l: "How", t: "select", req: true, opts: [...PAY_MODES] },
                    ],
                    init: { account: a.issueTxn?.from ?? "", mode: "Cash" },
                  },
                } as ActionSpec,
                {
                  id: "cancelAdvance",
                  l: "Cancel advance",
                  why: a.bills.some((b) => b.status === "active") ? "Bills are against it" : !approver && a.issueTxn?.createdById !== ctx.actor.id ? "Only the accountant, or whoever gave it" : "",
                  prompt: { title: `Cancel ${a.label}?`, sub: "For an advance recorded in error. The money goes back to its account; the advance stays on record, cancelled.", submit: "Cancel advance", fields: [{ k: "reason", l: "Why", t: "area", req: true }] },
                } as ActionSpec,
              ]
            : []),
          ...(a.status === "settled" ? [{ id: "reopen", l: "Reopen", why: approverWhy(ctx), prompt: { title: `Reopen ${a.label}?`, sub: "Its settlement is cancelled and the advance is open again.", submit: "Reopen", fields: [{ k: "reason", l: "Why", t: "area", req: true }] } } as ActionSpec] : []),
        ];
        const sections: MoneyPanel["sections"] = [
          {
            title: "Bills",
            empty: "No bills submitted yet.",
            lines: a.bills.map((b) => ({
              text: `${inr(b.amountPaise)} · ${b.category ?? "—"} — ${b.payee ?? "—"}${b.invoiceNo ? ` · ${b.invoiceNo}` : " · no bill"}`,
              sub: `${b.label} · ${b.date} · ${b.status === "cancelled" ? "cancelled" : REVIEW_LABEL[b.review]}${b.noBillReason ? ` · ${b.noBillReason}` : ""}${b.reviewNote ? ` · ${b.reviewNote}` : ""}`,
              tone: b.status === "cancelled" ? ("muted" as const) : b.review === "approved" ? ("success" as const) : b.review === "sent_back" ? ("danger" as const) : undefined,
            })),
          },
          {
            title: "History",
            lines: [
              ...(a.issueTxn ? [{ text: `${inr(a.issueTxn.amountPaise)} given from ${a.issueTxn.from} · ${a.issueTxn.mode ?? ""}`, sub: `${a.issueTxn.label} · ${a.issuedOn} · by ${a.by ?? "—"}`, tone: a.issueTxn.status === "cancelled" ? ("muted" as const) : ("success" as const) }] : []),
              ...a.settlements.map((t) => ({ text: t.kind === "advance_return" ? `${inr(t.amountPaise)} returned into ${t.to}` : `${inr(t.amountPaise)} paid to ${a.employee} from ${t.from}`, sub: `${t.label} · ${t.date}${t.status === "cancelled" ? ` · cancelled — ${t.cancelReason}` : ""}`, tone: t.status === "cancelled" ? ("muted" as const) : undefined })),
            ],
          },
        ];
        return {
          id: a.id,
          v: { no: a.label, employee: a.employee, dept: depts.get(a.employee.toLowerCase()) ?? null, date: a.issuedOn, from: a.issueTxn?.from ?? "—", given: p.given, approved: p.approved, review: p.toReview, withThem: p.withThem, state },
          flags: late ? ["late"] : p.withThem < 0 && a.status === "open" ? ["overspent"] : [],
          title: `${a.label} · ${a.employee} · ${inr(p.given)}`,
          header: `${state}${a.purpose ? ` · ${a.purpose}` : ""}`,
          fields: [
            { l: "For", v: a.purpose ?? "—" },
            { l: "Bills due by", v: a.billsDueOn ?? "—" },
            { l: "Still with them", v: inr(p.withThem) },
            ...(a.status === "open" && !p.settleWhy ? [{ l: "Settling now", v: settleSub }] : []),
          ],
          actions,
          by: `Given by ${a.by ?? "—"}`,
          panel: {
            kind: "money",
            data: {
              figures: [
                { l: "Given", v: inr(p.given) },
                { l: "Approved", v: inr(p.approved), tone: "success" },
                { l: "To review", v: inr(p.toReview) },
                { l: "Still with them", v: inr(p.withThem), tone: p.withThem < 0 ? "danger" : undefined },
              ],
              sections,
              files: a.bills.flatMap((b) => papers.get(b.id) ?? []),
              note: p.sentBack ? `${inr(p.sentBack)} of bills sent back — cancel and resubmit them before settling.` : undefined,
            } satisfies MoneyPanel,
          },
        } satisfies ListRow;
      }),
    };
  },
  forms: {
    async new(ctx, h) {
      const r = await giveAdvance(actorOf(ctx), { employee: text(h.employee), amountPaise: paise(h.amount), date: text(h.date) ?? "", purpose: text(h.purpose), billsDueOn: text(h.billsDueOn), from: cardName(text(h.from)), mode: text(h.mode), reference: text(h.reference), note: text(h.note) });
      return r.ok ? okVoid(r.message) : r;
    },
    async bills(ctx, _h, lines, recordId) {
      if (!recordId) return err("Which advance?");
      const r = await submitAdvanceBills(
        actorOf(ctx),
        recordId,
        lines.map((l) => ({ date: text(l.date), category: text(l.category), payee: text(l.payee), invoiceNo: text(l.invoiceNo), amountPaise: paise(l.amount), noBillReason: text(l.noBillReason), description: text(l.description), photo: text(l.photo) })),
      );
      return r.ok ? okVoid(r.message) : r;
    },
  },
  actions: {
    async settle(ctx, id, v) {
      return settleAdvance(actorOf(ctx), id, text(v.account), text(v.mode));
    },
    async reopen(ctx, id, v) {
      return reopenAdvance(actorOf(ctx), id, v.reason ?? "");
    },
    async cancelAdvance(ctx, id, v) {
      return cancelAdvance(actorOf(ctx), id, v.reason ?? "");
    },
  },
};

/* ------------------------------------------------------------- statements */

/**
 * One account's statement, as its own tab: Opening + In − Out = Closing over
 * the period, then every live transaction on it, oldest first, with the
 * running balance. Each row opens the transaction — a cash receipt says how
 * its cash was used.
 */
function statementTab(key: string, accountId: string): ScreenModule {
  return {
    key,
    window: WIN,
    async load(ctx, scope) {
      const s = scope ?? scopeFor(WIN, { pd: "", ids: null }, null);
      const a = (await moneyAccounts()).find((x) => x.id === accountId);
      const cash = a?.kind !== "bank";
      const cols: ColSpec[] = [
        { k: "date", l: "Date", t: "d" },
        { k: "txn", l: "TXN ID", t: "mono" },
        { k: "kind", l: "Type", t: "t" },
        { k: "party", l: "Party", t: "b" },
        { k: "in", l: cash ? "Cash in" : "Money in", t: "m", w: 120 },
        { k: "out", l: cash ? "Cash out" : "Money out", t: "m", w: 120 },
        { k: "balance", l: "Balance", t: "m", w: 130 },
      ];
      if (!a) return { spec: { screen: key, cols, hidden: [], readOnly: true, noDataLine: "This account is not set up. Add it on Cash & Bank › Accounts." }, rows: [] };
      const from = s.window.from;
      const opening = from ? ((await accountBalanceMap(db, from)).get(a.id) ?? a.openingPaise) : a.openingPaise;
      const { rows: txns, wide } = await windowed(sql`t.status = 'active' and (t.from_account_id = ${a.id} or t.to_account_id = ${a.id})`, { ...s, ids: null, open: null });
      const st = statement(a.id, opening, txns);
      const built = new Map((await txnListRows(ctx, st.rows.map((r) => r.t))).map((r) => [r.id, r]));
      const rows: ListRow[] = [
        { id: `${a.id}:open`, v: { date: from ?? a.openingDate, txn: "—", kind: "Opening", party: from ? "Brought forward" : "Opening balance", in: null, out: null, balance: st.opening }, flags: [], title: `${a.name} · opening` },
        ...st.rows.map((r) => ({ ...built.get(r.t.id)!, v: { date: r.t.date, txn: r.t.label, kind: MONEY_KIND_LABEL[r.t.kind], party: partyOf(r.t), in: r.inPaise || null, out: r.outPaise || null, balance: r.balance } })),
      ];
      const opened = from ? new Date(`${from}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }) : "start";
      return {
        spec: {
          screen: key,
          cols,
          hidden: [],
          strip: [
            { l: `Opening · ${opened}`, v: inr(st.opening) },
            { l: cash ? "Cash in" : "Money in", v: inr(st.inPaise), op: "+", tone: "success" },
            { l: cash ? "Cash out" : "Money out", v: inr(st.outPaise), op: "−", tone: "danger" },
            { l: "Closing", v: inr(st.closing), op: "=" },
          ],
          newMenu: newMenu(),
          readOnly: !!ctx.viewingAs,
          noDataLine: `Nothing moved in ${a.name} this period.`,
        },
        rows,
        tooWide: wide,
      };
    },
    actions: TXN_ACTIONS,
    formLoaders: { edit: editLoader },
  };
}

const stmtKotak = statementTab("stmtKotak", "macc_kotak");
const stmtIcici = statementTab("stmtIcici", "macc_icici");
const stmtCash = statementTab("stmtCash", "macc_cash");
const stmtPetty = statementTab("stmtPetty", "macc_petty");

/* ------------------------------------------------------------------ reports */

/** Overview › Reports: what went where, month by month — expenses by category, money in by account. */
const moneyReports: ScreenModule = {
  key: "moneyReports",
  window: { label: "Month", default: "fy" },
  async load(ctx, scope) {
    const s = scope ?? scopeFor({ label: "Month", default: "fy" }, { pd: "", ids: null }, null);
    const rows = (await db.execute(sql`
      select to_char(t.txn_date, 'YYYY-MM') as month,
             case when t.kind = 'expense' then 'Paid out' when t.kind = 'receipt' then 'Received' else 'Moved' end as side,
             case when t.kind = 'expense' then coalesce(t.category, 'Uncategorised') when t.kind = 'receipt' then coalesce(a.name, '—') else 'Transfers and advances' end as head,
             count(*)::int as n, sum(t.amount_paise)::float8 as amount,
             coalesce(sum(t.amount_paise) filter (where t.petty or t.advance_id is not null), 0)::float8 as petty
        from erp_money_txns t left join erp_money_accounts a on a.id = t.to_account_id
       where t.status = 'active' and ${windowWhere(sql`t.txn_date`, sql`t.id`, { ...s, ids: null, open: null })}
       group by 1, 2, 3 order by 1 desc, 2, 5 desc`)) as unknown as { month: string; side: string; head: string; n: number; amount: number; petty: number }[];
    return {
      spec: {
        screen: "moneyReports",
        cols: [
          { k: "month", l: "Month", t: "t" },
          { k: "side", l: "Side", t: "s" },
          { k: "head", l: "Category / account", t: "b" },
          { k: "n", l: "Transactions", t: "n" },
          { k: "amount", l: "Amount", t: "m" },
          { k: "petty", l: "Of it, petty cash & advances", t: "m" },
        ],
        hidden: [],
        chips: "side",
        newMenu: newMenu(),
        readOnly: true,
        noDataLine: "Nothing recorded in this period.",
      },
      rows: rows.map((r) => ({ id: `${r.month}|${r.side}|${r.head}`, v: { month: r.month, side: r.side, head: r.head, n: Number(r.n), amount: Number(r.amount), petty: Number(r.petty) || null }, flags: [] })),
    };
  },
};

/** Overview › Audit trail: every write to Petty Cash, who and when, in words. Nothing here is ever deleted. */
const moneyAudit: ScreenModule = {
  key: "moneyAudit",
  window: { label: "When", default: "30d" },
  async load(ctx, scope) {
    const s = scope ?? scopeFor({ label: "When", default: "30d" }, { pd: "", ids: null }, null);
    const rows = (await db.execute(sql`
      select l.id, l.action, l.entity_id as "entityId", (l.at at time zone 'Asia/Kolkata')::date::text as day, l.at::text as at, u.name as who,
             t.txn_no as no, t.txn_date::text as "txnDate"
        from audit_log l
        left join users u on u.id = l.actor_id
        left join erp_money_txns t on t.id = l.entity_id
       where l.entity_type = 'erp_money_txn' and ${windowWhere(sql`(l.at at time zone 'Asia/Kolkata')::date`, sql`l.id`, { ...s, ids: null, open: null })}
       order by l.at desc limit 3000`)) as unknown as { id: string; action: string; entityId: string | null; day: string; at: string; who: string | null; no: number | null; txnDate: string | null }[];
    return {
      spec: {
        screen: "moneyAudit",
        cols: [
          { k: "day", l: "Date", t: "d" },
          { k: "who", l: "Who", t: "b" },
          { k: "what", l: "What happened", t: "t" },
          { k: "txn", l: "Record", t: "mono" },
        ],
        hidden: [],
        newMenu: newMenu(),
        readOnly: true,
        noDataLine: "Nothing changed in this period.",
      },
      rows: rows.map((r) => ({ id: r.id, v: { day: r.day, who: r.who ?? "—", what: translate(r.action).says, txn: r.no != null ? txnLabel(Number(r.no), r.txnDate!) : null }, flags: [], by: r.at })),
    };
  },
};

/* ---------------------------------------------------------- bank statements */

function lineLabel(c: { t: TxnRow; score: string; left: number }): string {
  const tag = c.score === "exact" ? "Exact" : c.score === "amount" ? "Amount" : "Part";
  return `${c.t.label} · ${tag} · ${partyOf(c.t)} · ${inr(c.left)} · ${c.t.date}`;
}

const bankLines: ScreenModule = {
  key: "bankLines",
  window: { label: "Statement date", default: "month" },
  async load(ctx, scope) {
    const s = scope ?? scopeFor({ label: "Statement date", default: "month" }, { pd: "", ids: null }, null);
    const cfg = await getConfig();
    const lines = await bankLineRows(windowWhere(sql`l.line_date`, sql`l.id`, s));
    const open = lines.filter((l) => l.status === "open" && l.matchedPaise === 0);
    const cands = await candidatesFor(open, cfg["erp.money.bankMatchDays"]);
    const approver = ctx.powers.has("approveMoney");
    const [banks, cats, all] = await Promise.all([accountNames(["bank"]), categories(), accountNames()]);
    return {
      spec: {
        screen: "bankLines",
        cols: [
          { k: "date", l: "Date", t: "d" },
          { k: "account", l: "Account", t: "s" },
          { k: "description", l: "Narration", t: "b" },
          { k: "reference", l: "Reference", t: "mono" },
          { k: "out", l: "Debit", t: "m" },
          { k: "in", l: "Credit", t: "m" },
          { k: "state", l: "State", t: "s" },
          { k: "matched", l: "Matched to", t: "t" },
        ],
        hidden: [],
        chips: "state",
        tools: [
          {
            id: "import",
            l: "Import statement",
            primary: true,
            why: approverWhy(ctx) || (ctx.viewingAs ? "Previewing" : ""),
            prompt: {
              title: "Import a bank statement",
              sub: "The CSV the bank's net-banking exports, or a block copied out of Excel. A line already imported is skipped; a line that names a transaction's UTR is matched as it lands.",
              submit: "Import",
              fields: [
                { k: "account", l: "Bank", t: "select", req: true, opts: banks },
                { k: "file", l: "Statement (CSV)", t: "csv", req: true },
              ],
            },
          },
        ],
        newMenu: newMenu(),
        readOnly: !!ctx.viewingAs,
        noDataLine: "No statement lines this period. Import the bank's statement; each line is matched to the transaction that explains it, never entered again.",
      },
      rows: lines.map((l) => {
        const c = cands.get(l.id) ?? [];
        const amount = l.debitPaise || l.creditPaise;
        const state = l.status === "ignored" ? "Set aside" : l.matchedPaise >= amount ? "Matched" : "Not matched";
        const strong = c.filter((x) => x.score !== "near");
        const actions: ActionSpec[] =
          state === "Matched"
            ? [{ id: "unmatch", l: "Undo match", why: approverWhy(ctx), confirm: "Undo this match? The line and its transactions are open again." }]
            : state === "Set aside"
              ? [{ id: "restore", l: "Bring back", why: approverWhy(ctx) }]
              : [
                  {
                    id: "match",
                    l: "Match",
                    primary: true,
                    why: approverWhy(ctx) || (c.length ? "" : "Nothing on the books fits — create the transaction instead"),
                    prompt: {
                      title: `Match ${inr(amount)} ${l.debitPaise ? "out of" : "into"} ${l.account}`,
                      sub: `${l.date} · ${l.description}. Pick one, or several that add up to the line (a split).`,
                      submit: "Match",
                      fields: [{ k: "txns", l: "Transactions", t: "multi", req: true, opts: c.map(lineLabel) }],
                      init: { txns: strong.length === 1 ? lineLabel(strong[0]) : "" },
                    },
                  },
                  {
                    id: "create",
                    l: "Create transaction from this line",
                    why: approverWhy(ctx) || (strong.length ? `${strong[0].t.label} may already be this line — match it` : ""),
                    prompt: {
                      title: l.debitPaise ? "Create the payment this line shows" : "Create the receipt this line shows",
                      sub: "Only when nothing on the books explains the line. Name the other account for a transfer; otherwise it is an expense (debit) or a receipt (credit).",
                      submit: "Create and match",
                      fields: [
                        { k: "counter", l: "Transfer to / from our own account", t: "select", opts: all.filter((n) => n !== l.account) },
                        { k: "category", l: "Category", t: "select", opts: cats, when: { k: "counter", eq: "" } },
                        { k: "party", l: l.debitPaise ? "Paid to" : "Received from", t: "text" },
                        { k: "description", l: "What it is", t: "text" },
                      ],
                    },
                  },
                  { id: "ignore", l: "Set aside", why: approverWhy(ctx), prompt: { title: "Set this line aside?", sub: "For a line that needs no transaction of its own. It stays on the statement, set aside, with your reason.", submit: "Set aside", fields: [{ k: "reason", l: "Why", t: "text", req: true }] } },
                ];
        return {
          id: l.id,
          v: { date: l.date, account: l.account, description: l.description, reference: l.reference, out: l.debitPaise || null, in: l.creditPaise || null, state, matched: l.matches.map((m) => m.label).join(", ") || (l.ignoreReason ?? null) },
          flags: state === "Not matched" && !c.length ? ["noCandidate"] : [],
          title: `${l.account} · ${l.date} · ${inr(amount)}`,
          header: l.description,
          fields: [
            ...(l.balancePaise != null ? [{ l: "Balance on the statement", v: inr(l.balancePaise) }] : []),
            ...(l.ignoreReason ? [{ l: "Set aside because", v: l.ignoreReason }] : []),
          ],
          actions: approver || state !== "Not matched" ? actions : actions,
          panel: {
            kind: "money",
            data: {
              figures: [
                { l: l.debitPaise ? "Debit" : "Credit", v: inr(amount) },
                { l: "Matched", v: inr(l.matchedPaise), tone: l.matchedPaise >= amount ? "success" : undefined },
              ],
              sections: [
                {
                  title: state === "Matched" ? "Matched to" : "Suggested",
                  empty: "Nothing on the books fits this line.",
                  lines:
                    state === "Matched"
                      ? l.matches.map((m) => ({ text: `${m.label} · ${inr(m.amountPaise)}`, sub: m.party }))
                      : c.slice(0, 6).map((x) => ({ text: `${x.t.label} · ${x.score === "exact" ? "Exact — the line names its reference" : x.score === "amount" ? "Same amount" : "Part of it"}`, sub: `${partyOf(x.t)} · ${inr(x.left)} · ${x.t.date}`, tone: x.score === "exact" ? ("success" as const) : undefined })),
                },
              ],
              files: [],
            } satisfies MoneyPanel,
          },
        } satisfies ListRow;
      }),
    };
  },
  tools: {
    async import(ctx, v) {
      const r = await importBankStatement(actorOf(ctx), text(v.account), v.file ?? null);
      return r.ok ? okVoid(r.message) : r;
    },
  },
  actions: {
    async match(ctx, id, v) {
      const cfg = await getConfig();
      const [l] = await bankLineRows(sql`l.id = ${id}`);
      if (!l) return err("That line is gone.", "not_found");
      const c = (await candidatesFor([l], cfg["erp.money.bankMatchDays"])).get(id) ?? [];
      const picked = multi(v.txns);
      const ids = picked.map((p) => c.find((x) => lineLabel(x) === p)?.t.id).filter((x): x is string => !!x);
      if (!ids.length || ids.length !== picked.length) return fieldErr("txns", "Pick from the list again — it has changed.");
      return matchBankLine(actorOf(ctx), id, ids);
    },
    async unmatch(ctx, id) {
      return unmatchBankLine(actorOf(ctx), id);
    },
    async ignore(ctx, id, v) {
      return ignoreBankLine(actorOf(ctx), id, text(v.reason));
    },
    async restore(ctx, id) {
      return ignoreBankLine(actorOf(ctx), id, null, true);
    },
    async create(ctx, id, v) {
      return createFromBankLine(actorOf(ctx), id, { category: text(v.category), party: text(v.party), description: text(v.description), counter: text(v.counter) });
    },
  },
};

/* ---------------------------------------------------------------- accounts */

function accountRow(ctx: ErpContext, a: MoneyAccount, balance: number, unmatched: number): ListRow {
  const kind = a.kind === "bank" ? "Bank" : a.kind === "cash" ? "Cash in hand" : "Petty cash";
  return {
    id: a.id,
    v: { name: a.name, kind, balance, opening: a.openingPaise, openingDate: a.openingDate, unmatched: a.kind === "bank" ? unmatched : null, state: a.active ? "Active" : "Inactive" },
    flags: balance < 0 && a.kind !== "bank" ? ["below"] : [],
    title: `${a.name}${a.last4 ? ` ••${a.last4}` : ""} · ${inr(balance)}`,
    header: kind,
    actions: [
      {
        id: "edit",
        l: "Edit",
        why: approverWhy(ctx),
        prompt: {
          title: `Edit ${a.name}`,
          sub: "The opening balance is what the account held on its opening date, before the first transaction here. Every balance is read from it and the transactions.",
          submit: "Save",
          fields: [
            { k: "name", l: "Name", t: "text", req: true },
            ...(a.kind === "bank" ? [{ k: "last4", l: "Last four digits", t: "text" } as FieldSpec] : []),
            { k: "opening", l: "Opening balance (₹)", t: "num" },
            { k: "openingDate", l: "As on", t: "date" },
            { k: "active", l: "In use", t: "pick", opts: ["Yes", "No"] },
          ],
          init: { name: a.name, last4: a.last4 ?? "", opening: rupeesField(a.openingPaise), openingDate: a.openingDate ?? "", active: a.active ? "Yes" : "No" },
        },
      },
    ],
  };
}

const moneyAccountsScreen: ScreenModule = {
  key: "moneyAccounts",
  async load(ctx) {
    const [accounts, bal] = await Promise.all([moneyAccounts(), accountBalanceMap()]);
    const un = (await db.execute(sql`select l.account_id as a, count(*)::int as n from erp_bank_lines l where l.status = 'open' and not exists (select 1 from erp_bank_matches m where m.line_id = l.id and m.voided_at is null) group by l.account_id`)) as unknown as { a: string; n: number }[];
    const unMap = new Map(un.map((u) => [u.a, Number(u.n)]));
    return {
      spec: {
        screen: "moneyAccounts",
        cols: [
          { k: "name", l: "Account", t: "b" },
          { k: "kind", l: "Kind", t: "s" },
          { k: "balance", l: "Balance", t: "m" },
          { k: "opening", l: "Opening", t: "m" },
          { k: "openingDate", l: "As on", t: "d" },
          { k: "unmatched", l: "Bank lines not matched", t: "n" },
          { k: "state", l: "State", t: "s" },
        ],
        hidden: [],
        newForm: ctx.powers.has("approveMoney")
          ? {
              screen: "moneyAccounts",
              id: "new",
              title: "Add an account",
              sub: "A bank account, a cash box or a petty cash float.",
              submit: "Add account",
              header: [
                { k: "name", l: "Name", t: "text", req: true },
                { k: "kind", l: "Kind", t: "pick", req: true, opts: ["Bank", "Cash in hand", "Petty cash"] },
                { k: "last4", l: "Last four digits", t: "text", when: { k: "kind", eq: "Bank" } },
                { k: "opening", l: "Opening balance (₹)", t: "num" },
                { k: "openingDate", l: "As on", t: "date" },
              ],
            }
          : undefined,
        newLabel: "Add account",
        readOnly: !!ctx.viewingAs,
        noDataLine: "No accounts yet.",
      },
      rows: accounts.map((a) => accountRow(ctx, a, bal.get(a.id) ?? 0, unMap.get(a.id) ?? 0)),
    };
  },
  forms: {
    async new(ctx, h) {
      return saveAccount(actorOf(ctx), { name: text(h.name), kind: text(h.kind), last4: text(h.last4), openingPaise: paise(h.opening), openingDate: text(h.openingDate), active: true });
    },
  },
  actions: {
    async edit(ctx, id, v) {
      return saveAccount(actorOf(ctx), { id, name: text(v.name), kind: null, last4: text(v.last4), openingPaise: paise(v.opening), openingDate: text(v.openingDate), active: v.active !== "No" });
    },
  },
};

/**
 * The overview tab as a list, for the places that read it as one (the
 * assistant, the scale test). The board itself is `app/erp/expenses/page.tsx`.
 */
const moneyOverviewList: ScreenModule = {
  key: "moneyOverview",
  async load(ctx) {
    const r = await moneyAccountsScreen.load(ctx);
    return { spec: { ...r.spec, screen: "moneyOverview", newForm: undefined, readOnly: true }, rows: r.rows };
  },
};

/* ------------------------------------------------------------- old records */

/* The old expense sheet (Credit Expense + Expenses, from 2022) is thousands of rows, so this reads by date like every register. */
const LEGACY_WIN: ScreenWindow = { label: "Date", default: "fy" };

const legacyPetty: ScreenModule = {
  key: "legacyPetty",
  window: LEGACY_WIN,
  async load(_ctx, scope) {
    const s = scope ?? scopeFor(LEGACY_WIN, { pd: "", ids: null }, null);
    const inCredits = windowWhere(sql`${erpCredits.creditDate}`, sql`${erpCredits.id}`, s);
    const inExpenses = windowWhere(sql`${erpExpenses.expenseDate}`, sql`${erpExpenses.id}`, s);
    const [[c], [e]] = await Promise.all([
      db.select({ n: sql<number>`count(*)::int` }).from(erpCredits).where(inCredits),
      db.select({ n: sql<number>`count(*)::int` }).from(erpExpenses).where(inExpenses),
    ]);
    const wide = tooWide(Number(c?.n ?? 0) + Number(e?.n ?? 0), s);
    const [credits, expenses] = wide
      ? [[], []]
      : await Promise.all([
          db.select({ c: erpCredits, godown: erpGodowns.name }).from(erpCredits).innerJoin(erpGodowns, eq(erpGodowns.id, erpCredits.godownId)).where(inCredits),
          db.select({ e: erpExpenses, godown: erpGodowns.name }).from(erpExpenses).innerJoin(erpGodowns, eq(erpGodowns.id, erpExpenses.godownId)).where(inExpenses),
        ]);
    /* The sheet's own words: money given in is a credit, an expense paid out is a debit. */
    const rows: ListRow[] = [
      ...credits.map((r) => ({ id: r.c.id, v: { date: r.c.creditDate, kind: "Credit", who: r.c.employeeName, what: r.c.note, amount: r.c.amountPaise, mode: r.c.mode, godown: r.godown, status: "—" }, flags: [] })),
      ...expenses.map((r) => ({ id: r.e.id, v: { date: r.e.expenseDate, kind: "Debit", who: r.e.expenseBy, what: [r.e.category, r.e.particular, r.e.note].filter(Boolean).join(" · "), amount: r.e.amountPaise, mode: r.e.mode, godown: r.godown, status: r.e.status === "Verify" ? "Verified" : r.e.status }, flags: [] })),
    ].sort((a, b) => String(b.v.date).localeCompare(String(a.v.date)));
    return {
      spec: {
        screen: "legacyPetty",
        cols: [
          { k: "date", l: "Date", t: "d" },
          { k: "kind", l: "Type", t: "s" },
          { k: "who", l: "Employee", t: "b" },
          { k: "what", l: "Details", t: "t" },
          { k: "amount", l: "Amount", t: "m" },
          { k: "mode", l: "Mode", t: "s" },
          { k: "godown", l: "Godown", t: "t" },
          { k: "status", l: "Status", t: "s" },
        ],
        hidden: [],
        chips: "kind",
        newMenu: newMenu(),
        readOnly: true,
        noDataLine: "No old records in this period. Credits and expenses from before the Petty Cash module are kept here, read-only.",
      },
      rows,
      tooWide: wide,
    };
  },
};

export const MONEY_SCREENS: ScreenModule[] = [
  moneyOverviewList,
  moneyTxns,
  expensesPaid,
  pettyExpenses,
  advances,
  moneyReview,
  expensesCancelled,
  moneyReceipts,
  receiptsUnmatched,
  moneyTransfers,
  stmtKotak,
  stmtIcici,
  stmtCash,
  stmtPetty,
  moneyReports,
  moneyAudit,
  receiptsBank,
  receiptsCash,
  bankLines,
  moneyAccountsScreen,
  legacyPetty,
];
