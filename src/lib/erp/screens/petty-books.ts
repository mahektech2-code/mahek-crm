import "server-only";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { erpBankImports, erpTallySync } from "@/db/schema";
import { err, ok, type Result } from "@/lib/result";
import { paise, stampLine, text, type ScreenModule } from "../server";
import type { ActionSpec, ColSpec, ListRow, SummaryCard, ToolResult, ToolSpec } from "../ui";
import { fd, inr } from "../ui";
import { today } from "./common";
import { addDaysIso } from "../engines/sales";
import { nameOf, pettyConfig, pettyRoles, userNames, WHY } from "../petty/core";
import { bookVsStatement, confirmLines, importStatement, lineCandidates, lineToAdjustment, lineToWithdrawal, markException, matchManually, rematch, unmatchLine } from "../petty/bank";
import { approveBudgets, budgetRows, saveBudget } from "../petty/insight";
import { BANK_WORD, isLive, loadBankLines, loadExpenses, loadPayments, TALLY_WORD } from "../petty/facts";
import { exportVoucher, postToTally, recordVoucher, setTallyStatus } from "../petty/tally";
import { activeFunds, fundLabel, lookups } from "./petty-shared";

/* ---------------------------------------------------------------------------
 * Petty cash → Bank reconciliation, Budgets, Reports and Tally sync.
 * ------------------------------------------------------------------------- */

/* ================================================== Bank reconciliation */

const bank: ScreenModule = {
  key: "pettyBank",
  async load(ctx) {
    const [{ lines, matches }, l, payments] = await Promise.all([loadBankLines(), lookups(ctx), loadPayments()]);
    const roles = pettyRoles(ctx);
    const bankFunds = activeFunds(l, ["BANK"]);
    const cashFunds = activeFunds(l, ["PHYSICAL_CASH"]);
    const imports = await db.select().from(erpBankImports).orderBy(desc(erpBankImports.importedAt)).limit(10);
    const names = await userNames([...lines.map((x) => x.reconciledById), ...imports.map((i) => i.importedById)]);
    const codes = new Map<string, string>(payments.map((p) => [p.p.id, p.p.code]));
    const { erpFundTransfers, erpFundAdjustments } = await import("@/db/schema");
    const [tr, adj] = await Promise.all([db.select({ id: erpFundTransfers.id, code: erpFundTransfers.code }).from(erpFundTransfers), db.select({ id: erpFundAdjustments.id, code: erpFundAdjustments.code }).from(erpFundAdjustments)]);
    tr.forEach((t) => codes.set(t.id, t.code));
    adj.forEach((a) => codes.set(a.id, a.code));
    const accountsWhy = roles.accounts ? "" : WHY.accounts;
    const open = lines.filter((x) => !["reconciled"].includes(x.reconStatus));
    const cands = new Map<string, Awaited<ReturnType<typeof lineCandidates>>>();
    if (roles.accounts) for (const x of open.slice(0, 150)) cands.set(x.id, await lineCandidates(x.id));
    const summary: SummaryCard[] = [];
    for (const f of bankFunds) {
      const b = await bookVsStatement(f.id);
      const mine = lines.filter((x) => x.fundAccountId === f.id);
      summary.push({
        t: f.name,
        big: { v: b.statementPaise == null ? "—" : inr(b.statementPaise), sub: b.asOf ? `Statement · ${fd(b.asOf)}` : "Statement" },
        rows: [
          { l: `Book balance${b.asOf ? ` to ${fd(b.asOf)}` : ""}`, v: inr(b.bookPaise) },
          { l: "Difference", v: b.differencePaise == null ? "—" : inr(b.differencePaise), tone: b.differencePaise ? "warn" : b.differencePaise === 0 ? "success" : undefined },
          { l: "Lines to reconcile", v: String(mine.filter((x) => x.reconStatus !== "reconciled").length), tone: mine.some((x) => x.reconStatus !== "reconciled") ? "warn" : "success" },
        ],
      });
    }
    if (imports.length)
      summary.push({
        t: "Imports",
        rows: imports.slice(0, 5).map((i) => ({ l: `${fd(i.statementFrom)} – ${fd(i.statementTo)}`, v: `${i.linesNew} new`, tone: i.duplicateOfImportId ? "warn" : undefined })),
      });
    const tools: ToolSpec[] = [
      {
        id: "import",
        l: "Import statement",
        primary: true,
        why: accountsWhy,
        prompt: {
          title: "Import a bank statement",
          submit: "Import",
          fields: [
            { k: "fund", l: "Account", t: "select", req: true, opts: bankFunds.map(fundLabel) },
            { k: "csv", l: "Statement (CSV)", t: "csv", req: true },
          ],
          init: { fund: bankFunds[0] ? fundLabel(bankFunds[0]) : "" },
        },
      },
      { id: "rematch", l: "Match again", why: accountsWhy },
    ];
    const cols: ColSpec[] = [
      { k: "date", l: "Date", t: "d" },
      { k: "narration", l: "Narration", t: "b", w: 280 },
      { k: "reference", l: "Reference", t: "mono" },
      { k: "debit", l: "Debit", t: "m" },
      { k: "credit", l: "Credit", t: "m" },
      { k: "balance", l: "Balance", t: "m" },
      { k: "status", l: "Status", t: "s" },
      { k: "matched", l: "Matched to", t: "t" },
    ];
    const rows: ListRow[] = lines.map((x) => {
      const ms = matches.get(x.id) ?? [];
      const amount = x.debitPaise || x.creditPaise;
      const actions: ActionSpec[] = [];
      if (["matched", "suggested"].includes(x.reconStatus) && ms.length) actions.push({ id: "confirm", l: x.reconStatus === "suggested" ? "Confirm the suggestion" : "Reconcile", primary: true, why: accountsWhy });
      if (x.reconStatus !== "reconciled") {
        const c = cands.get(x.id) ?? [];
        actions.push({
          id: "match",
          l: "Match by hand",
          why: accountsWhy || (!c.length ? "Nothing recorded runs this way and is unclaimed — record the movement first" : ""),
          prompt: { title: "What is this line?", sub: `${x.debitPaise ? "Debit" : "Credit"} ${inr(amount)} · ${fd(x.txnDate)}`, submit: "Match", fields: [{ k: "records", l: "Recorded movements", t: "multi", req: true, opts: c.map((y) => y.label.replace(/\|/g, "/")) }] },
        });
        if (x.debitPaise && !ms.length && cashFunds.length) actions.push({ id: "withdrawal", l: "It is a cash withdrawal", why: accountsWhy, prompt: { title: "Record the withdrawal", submit: "Record", fields: [{ k: "to", l: "Cash taken to", t: "select", req: true, opts: cashFunds.map(fundLabel) }, { k: "purpose", l: "Purpose", t: "text" }], init: { to: fundLabel(cashFunds[0]) } } });
        if (!ms.length) actions.push({ id: "charge", l: x.debitPaise ? "It is a bank charge" : "It is bank interest / other", why: accountsWhy, prompt: { title: "Record it", submit: "Request", fields: [{ k: "reason", l: "What it was", t: "area", req: true }] } });
        if (x.reconStatus !== "exception") actions.push({ id: "exception", l: "Mark as exception", why: accountsWhy, prompt: { title: "Exception", submit: "Mark", fields: [{ k: "reason", l: "What is wrong", t: "area", req: true }] } });
      }
      if (ms.length) actions.push({ id: "unmatch", l: "Unmatch", why: accountsWhy, prompt: { title: "Unmatch", submit: "Unmatch", fields: [{ k: "reason", l: "Why", t: "area", req: true }] } });
      return {
        id: x.id,
        v: { date: x.txnDate, narration: x.narration ?? "—", reference: x.reference, debit: x.debitPaise || null, credit: x.creditPaise || null, balance: x.balancePaise, status: BANK_WORD[x.reconStatus], matched: ms.map((m) => `${codes.get(m.recordId) ?? m.recordType}${m.confirmed ? "" : " (to confirm)"}`).join(", ") || "—" },
        flags: x.reconStatus === "exception" && x.exceptionReason?.startsWith("Ambiguous") ? ["ambiguous"] : [],
        title: `${x.debitPaise ? "Debit" : "Credit"} ${inr(amount)} · ${fd(x.txnDate)}`,
        header: `${BANK_WORD[x.reconStatus]}${x.exceptionReason ? ` — ${x.exceptionReason}` : ""}`,
        fields: [
          { l: "Value date", v: x.valueDate ? fd(x.valueDate) : "—" },
          { l: "Statement id", v: x.statementTxnId ?? "—" },
          { l: "Match rule", v: ms.map((m) => ({ reference: "Exact reference / UTR", amount_date: "Amount and date", narration: "Amount, date and payee", manual: "By hand" })[m.rule] ?? m.rule).join(", ") || "—" },
          { l: "Reconciled by", v: x.reconciledById ? nameOf(names, x.reconciledById) : "—" },
        ],
        actions,
      };
    });
    return {
      spec: {
        screen: "pettyBank",
        cols,
        hidden: [],
        chips: "status",
        tools,
        summary,
        bulk: roles.accounts ? [{ id: "confirm", l: "Reconcile matched" }] : undefined,
        noDataLine: "No statement imported yet.",
      },
      rows,
    };
  },
  tools: {
    async import(ctx, v) {
      const l = await lookups(ctx);
      const r = await importStatement(ctx, { fundId: l.fundByLabel.get(text(v.fund) ?? "")?.id ?? null, csv: v.csv ?? null });
      if (!r.ok) return r;
      const d = r.data;
      const res: ToolResult = {
        dialog: {
          title: d.repeatOf && !d.added ? "Already imported" : "Statement imported",
          lines: [
            { text: `${d.total} line${d.total === 1 ? "" : "s"} read · ${d.added} new · ${d.duplicates} already imported${d.repeatOf ? " (the same file was imported before)" : ""}`, tone: d.repeatOf ? "warn" : "info" },
            { text: `${d.matched} matched by reference · ${d.suggested} suggested for you to confirm`, tone: "success" },
            ...d.skipped.slice(0, 8).map((s) => ({ text: `Row ${s.row} skipped: ${s.reason}`, tone: "warn" as const })),
          ],
        },
      };
      return ok(res, r.message);
    },
    rematch: (ctx) => rematch(ctx, null),
  },
  actions: {
    confirm: (ctx, id) => confirmLines(ctx, [id]),
    async match(ctx, id, v) {
      const c = await lineCandidates(id);
      const picked = (v.records ?? "").split("|").filter(Boolean).map((label) => c.find((x) => x.label.replace(/\|/g, "/") === label)?.key).filter((x): x is string => !!x);
      return matchManually(ctx, id, picked);
    },
    async withdrawal(ctx, id, v) {
      const l = await lookups(ctx);
      return lineToWithdrawal(ctx, id, { toFundId: l.fundByLabel.get(text(v.to) ?? "")?.id ?? null, purpose: text(v.purpose) });
    },
    charge: (ctx, id, v) => lineToAdjustment(ctx, id, text(v.reason)),
    exception: (ctx, id, v) => markException(ctx, id, text(v.reason)),
    unmatch: (ctx, id, v) => unmatchLine(ctx, id, text(v.reason)),
  },
  bulk: { confirm: (ctx, ids) => confirmLines(ctx, ids) },
};

/* ============================================================== Budgets */

const monthWord = (p: string) => new Date(`${p}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });

const budgets: ScreenModule = {
  key: "pettyBudgets",
  async load(ctx) {
    const [facts, l] = await Promise.all([loadExpenses(), lookups(ctx)]);
    const roles = pettyRoles(ctx);
    const t = today();
    const months = [addDaysIso(`${t.slice(0, 7)}-01`, 32).slice(0, 7), t.slice(0, 7), addDaysIso(`${t.slice(0, 7)}-01`, -1).slice(0, 7), addDaysIso(`${t.slice(0, 7)}-01`, -32).slice(0, 7)];
    const all = (await Promise.all(months.map((m) => budgetRows(m, facts)))).flat();
    const cats = l.categories.filter((c) => c.active && c.budgetApplicable).map((c) => c.name);
    const setWhy = !roles.approve && !roles.owner ? "An approver or the owner sets budgets" : "";
    const cols: ColSpec[] = [
      { k: "month", l: "Month", t: "t" },
      { k: "category", l: "Category", t: "b" },
      { k: "godown", l: "Godown", t: "t" },
      { k: "budget", l: "Budget", t: "m" },
      { k: "incurred", l: "Incurred", t: "m" },
      { k: "paid", l: "Paid", t: "m" },
      { k: "unpaid", l: "Unpaid", t: "m" },
      { k: "committed", l: "Committed", t: "m" },
      { k: "remaining", l: "Remaining", t: "m" },
      { k: "forecast", l: "Forecast", t: "m" },
      { k: "variance", l: "Variance", t: "n", u: "%" },
      { k: "status", l: "Status", t: "s" },
    ];
    const cur = all.filter((b) => b.period === t.slice(0, 7));
    const sum = (k: "budgetPaise" | "incurredPaise" | "paidPaise" | "committedPaise") => cur.reduce((s, b) => s + b[k], 0);
    const summary: SummaryCard[] = [
      {
        t: `This month · ${monthWord(t.slice(0, 7))}`,
        big: { v: inr(sum("incurredPaise")), sub: `of ${inr(sum("budgetPaise"))}` },
        rows: [
          { l: "Paid", v: inr(sum("paidPaise")) },
          { l: "Unpaid", v: inr(sum("incurredPaise") - sum("paidPaise")) },
          { l: "Committed, not yet received", v: inr(sum("committedPaise")) },
          { l: "Categories over budget", v: String(cur.filter((b) => b.budgetPaise > 0 && b.incurredPaise > b.budgetPaise).length), tone: cur.some((b) => b.budgetPaise > 0 && b.incurredPaise > b.budgetPaise) ? "danger" : "success" },
        ],
      },
    ];
    return {
      spec: {
        screen: "pettyBudgets",
        cols,
        hidden: [],
        chips: "month",
        summary,
        newForm: {
          screen: "pettyBudgets",
          id: "new",
          title: "Set a monthly budget",
          submit: "Save budget",
          header: [
            { k: "period", l: "Month (YYYY-MM)", t: "select", req: true, opts: months },
            { k: "category", l: "Category", t: "select", req: true, opts: cats },
            { k: "godown", l: "Godown", t: "select", opts: ["All godowns", ...l.godowns.map((g) => g.name)] },
            { k: "department", l: "Department", t: "text" },
            { k: "amount", l: "Budget (₹)", t: "num", req: true, min: 0 },
          ],
          init: { period: t.slice(0, 7), godown: "All godowns" },
        },
        newLabel: "Set a budget",
        bulk: roles.owner ? [{ id: "approve", l: "Approve" }] : undefined,
        noDataLine: "No budgets.",
      },
      rows: all.map((b, i) => ({
        id: b.id ?? `nobudget-${b.period}-${b.categoryId}-${i}`,
        v: { month: monthWord(b.period), category: b.category, godown: b.godown, budget: b.id ? b.budgetPaise : null, incurred: b.incurredPaise, paid: b.paidPaise, unpaid: b.unpaidPaise, committed: b.committedPaise, remaining: b.id ? b.remainingPaise : null, forecast: b.forecastPaise, variance: b.variancePct, status: b.status === "approved" ? "Approved" : b.status === "draft" ? "Draft" : b.status },
        flags: b.budgetPaise > 0 && b.incurredPaise > b.budgetPaise ? ["overBudget"] : [],
        title: `${b.category} · ${monthWord(b.period)}`,
        header: `${b.godown}${b.department !== "—" ? ` · ${b.department}` : ""} · ${b.count} expense${b.count === 1 ? "" : "s"}`,
        actions: b.id
          ? [
              { id: "edit", l: "Change the amount", why: setWhy, prompt: { title: "Budget", submit: "Save", fields: [{ k: "amount", l: "Budget (₹)", t: "num", req: true, min: 0 }], init: { amount: String(b.budgetPaise / 100) } } },
              ...(b.status !== "approved" ? [{ id: "approve", l: "Approve", primary: true, why: roles.owner ? "" : WHY.owner } as ActionSpec] : []),
            ]
          : [],
      })),
    };
  },
  forms: {
    async new(ctx, h) {
      const l = await lookups(ctx);
      return saveBudget(ctx, { period: text(h.period), category: text(h.category), godownId: text(h.godown) === "All godowns" ? null : (l.godownByName.get(text(h.godown) ?? "") ?? null), department: text(h.department), amountPaise: paise(h.amount) });
    },
  },
  actions: {
    async edit(ctx, id, v) {
      const { erpExpenseBudgets, erpExpenseCategories } = await import("@/db/schema");
      const [b] = await db.select().from(erpExpenseBudgets).where(eq(erpExpenseBudgets.id, id));
      if (!b) return err("That budget no longer exists.", "not_found");
      const [c] = await db.select().from(erpExpenseCategories).where(eq(erpExpenseCategories.id, b.categoryId));
      return saveBudget(ctx, { id, period: b.period, category: c?.name ?? null, godownId: b.godownId, department: b.department, amountPaise: paise(v.amount) });
    },
    approve: (ctx, id) => approveBudgets(ctx, [id]),
  },
  bulk: { approve: (ctx, ids) => approveBudgets(ctx, ids) },
};

/* ============================================================== Reports */

const reports: ScreenModule = {
  key: "pettyReports",
  async load() {
    const [facts, payments] = await Promise.all([loadExpenses(), loadPayments()]);
    const t = today();
    const month = t.slice(0, 7);
    const live = facts.filter((f) => isLive(f.e) && f.e.incurred);
    const rows: ListRow[] = [];
    const push = (report: string, line: string, period: string, list: typeof live) => {
      rows.push({
        id: `${report}|${line}|${period}`,
        v: { report, line, period: monthWord(period), incurred: list.reduce((s, f) => s + f.state.payablePaise, 0), paid: list.reduce((s, f) => s + f.state.paidPaise, 0), outstanding: list.reduce((s, f) => s + f.state.outstandingPaise, 0), count: list.length },
        flags: [],
        title: `${report}: ${line}`,
        header: monthWord(period),
      });
    };
    const groupBy = (report: string, key: (f: (typeof live)[number]) => string, period = month) => {
      const by = new Map<string, typeof live>();
      for (const f of live.filter((x) => x.e.expenseDate.slice(0, 7) === period)) by.set(key(f), [...(by.get(key(f)) ?? []), f]);
      [...by].sort((a, b) => b[1].reduce((s, f) => s + f.state.payablePaise, 0) - a[1].reduce((s, f) => s + f.state.payablePaise, 0)).forEach(([k, list]) => push(report, k, period, list));
    };
    groupBy("By category", (f) => f.category ?? "Uncategorised");
    groupBy("By godown", (f) => f.godown);
    groupBy("By employee", (f) => f.e.expenseBy);
    groupBy("By vendor", (f) => f.e.vendorName ?? "No payee named");
    groupBy("By transaction type", (f) => f.e.txnType ?? "—");
    for (let i = 5; i >= 0; i--) {
      const p = addDaysIso(`${month}-01`, -i * 28).slice(0, 7);
      if (rows.some((r) => r.id === `Monthly trend|All expenses|${p}`)) continue;
      push("Monthly trend", "All expenses", p, live.filter((f) => f.e.expenseDate.slice(0, 7) === p));
    }
    const out = new Map<string, number>();
    for (const p of payments.filter((x) => x.p.status === "confirmed" && x.p.paymentDate.slice(0, 7) === month)) out.set(p.p.mode, (out.get(p.p.mode) ?? 0) + p.p.amountPaise);
    for (const [mode, amt] of out) rows.push({ id: `pay|${mode}`, v: { report: "Paid out by mode", line: mode, period: monthWord(month), incurred: null, paid: amt, outstanding: null, count: null }, flags: [] });
    const cols: ColSpec[] = [
      { k: "report", l: "Report", t: "t" },
      { k: "line", l: "Line", t: "b" },
      { k: "period", l: "Month", t: "t" },
      { k: "incurred", l: "Incurred", t: "m" },
      { k: "paid", l: "Paid", t: "m" },
      { k: "outstanding", l: "Outstanding", t: "m" },
      { k: "count", l: "Expenses", t: "n" },
    ];
    return { spec: { screen: "pettyReports", cols, hidden: [], chips: "report", readOnly: true, download: true, noDataLine: "Nothing recorded yet." }, rows };
  },
};

/* ============================================================ Tally sync */

const tally: ScreenModule = {
  key: "pettyTally",
  async load(ctx) {
    const cfg = await pettyConfig();
    const roles = pettyRoles(ctx);
    const rows = await db.select().from(erpTallySync).orderBy(desc(erpTallySync.updatedAt));
    const why = roles.accounts ? "" : WHY.accounts;
    const cols: ColSpec[] = [
      { k: "record", l: "Record", t: "b" },
      { k: "kind", l: "Kind", t: "t" },
      { k: "status", l: "Status", t: "s" },
      { k: "voucher", l: "Voucher", t: "t" },
      { k: "attempts", l: "Attempts", t: "n" },
      { k: "error", l: "Last error", t: "t", w: 260 },
      { k: "updated", l: "Updated", t: "d" },
    ];
    const KIND: Record<string, string> = { expense: "Expense (journal)", payment: "Payment", transfer: "Transfer (contra)", receipt: "Customer receipt", adjustment: "Adjustment" };
    return {
      spec: {
        screen: "pettyTally",
        cols,
        hidden: [],
        chips: "status",
        bulk: roles.accounts && cfg.tallyMode === "live" ? [{ id: "post", l: "Post to Tally" }] : undefined,
        notes: cfg.tallyMode === "off" ? [{ tone: "warn", text: "Tally sync is off." }] : undefined,
        noDataLine: "Nothing queued.",
      },
      rows: rows.map((r) => {
        const actions: ActionSpec[] = [];
        if (r.status !== "posted" && r.status !== "not_required") {
          actions.push({ id: "post", l: r.status === "failed" ? "Retry" : "Post to Tally", primary: cfg.tallyMode === "live", why: why || (cfg.tallyMode !== "live" ? "Live posting is off — export the voucher and record its number" : "") });
          actions.push({ id: "export", l: "Export voucher", primary: cfg.tallyMode !== "live", why });
          actions.push({ id: "voucher", l: "Record voucher number", why, prompt: { title: "Posted in Tally by hand", submit: "Record", fields: [{ k: "type", l: "Voucher type", t: "select", req: true, opts: ["Payment", "Receipt", "Contra", "Journal", "Purchase"] }, { k: "no", l: "Voucher number", t: "text", req: true }] } });
          actions.push({ id: "notRequired", l: "Not required", why, prompt: { title: "Mark not required", submit: "Mark", fields: [{ k: "reason", l: "Why", t: "area", req: true }] } });
        }
        if (r.status === "correction") actions.push({ id: "reversed", l: "Reversed in Tally", why, prompt: { title: "Reversed in Tally", submit: "Mark", fields: [{ k: "reason", l: "What was done in Tally", t: "area", req: true }] } });
        return {
          id: r.id,
          v: { record: r.remoteId.replace("MAHEKONE-", ""), kind: KIND[r.recordType] ?? r.recordType, status: TALLY_WORD[r.status], voucher: r.voucherNo ? `${r.voucherType ?? ""} ${r.voucherNo}` : "—", attempts: r.attempts, error: r.lastError, updated: new Date(r.updatedAt).toISOString().slice(0, 10) },
          flags: [],
          title: `${r.remoteId}`,
          header: `${TALLY_WORD[r.status]}${r.tallyCompany ? ` · ${r.tallyCompany}` : ""}`,
          fields: [{ l: "Posted", v: r.postedAt ? stampLine(null, r.postedAt).replace("Created ", "") : "—" }],
          actions,
        };
      }),
    };
  },
  actions: {
    post: (ctx, id) => postToTally(ctx, id),
    async export(ctx, id) {
      const r = await exportVoucher(ctx, id);
      if (!r.ok) return r;
      return ok({ dialog: { title: `Voucher · ${r.data.remoteId}`, text: r.data.xml, copy: true } } satisfies ToolResult, "Voucher written out");
    },
    voucher: (ctx, id, v) => recordVoucher(ctx, id, { voucherType: text(v.type), voucherNo: text(v.no) }),
    notRequired: (ctx, id, v) => setTallyStatus(ctx, id, "not_required", text(v.reason)),
    reversed: (ctx, id, v) => setTallyStatus(ctx, id, "reversed", text(v.reason)),
  },
  bulk: {
    async post(ctx, ids) {
      let okN = 0;
      let last: Result<unknown> | null = null;
      for (const id of ids) {
        last = await postToTally(ctx, id);
        if (last.ok) okN++;
      }
      if (!okN && last && !last.ok) return last;
      return ok(undefined, `${okN} of ${ids.length} posted`);
    },
  },
};

export const PETTY_BOOK_SCREENS: ScreenModule[] = [bank, budgets, reports, tally];
