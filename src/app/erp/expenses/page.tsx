import { NavLink } from "@/components/shell/nav-link";
import { notFound, redirect } from "next/navigation";
import { heldViews } from "../_ui/screen-tabs";
import { erpContext } from "@/lib/erp/access";
import { erpLink, erpScreenBySlug } from "@/lib/erp/registry";
import { screenModule } from "@/lib/erp/screens";
import { newMenu } from "@/lib/erp/screens/money";
import { moneyOverview, seesBalances } from "@/lib/erp/money";
import { advanceList, advanceView, filterOptions, moneyKitData, PERIODS, periodOf, statementView, TXN_VIEWS, txnDetail, txnView } from "@/lib/erp/money-views";
import { today } from "@/lib/erp/screens/common";
import { FLAG, inr, nf } from "@/lib/erp/ui";
import { LIST_QUERY_KEYS, pageOf, parseListQuery } from "@/lib/erp/list-query";
import { withReadMemo } from "@/lib/erp/read-memo";
import { scopeFor, windowInfo } from "@/lib/erp/window";
import { Card, cx } from "@/components/ui/primitives";
import { ListScreen } from "../_ui/list-screen";
import { lightPage, lightRow, lightSpec } from "@/lib/erp/lazy-forms";
import { Page } from "../_ui/page-head";
import { linkClass, SectionTitle } from "../_ui/look";
import { MoneyDialogHost } from "./money-dialogs";
import type { FilterDef } from "./money-client";
import type { MoneyKit } from "./money-ui";
import { AccountCards, SegSwitch, AdvancePage, AdvancesTable, Panel, QuickAdd, StatementView, TopTabs, TxnDrawerView, TxnTable, type ListKind, type Tab } from "./screens";
import { Icon } from "@/components/shell/icons";
import { buttonClass } from "@/components/ui/primitives";

/**
 * PETTY CASH — one ERP module: Overview, Expenses, Receipts and Cash & Bank
 * across the top, each with its own tabs (the registry's `section`), drawn as
 * the mockups in docs/erp/money-flow draw them. Every list, the statements,
 * an advance's page and the bank statement are Petty Cash's own screens
 * (`screens.tsx`); Reports, Audit trail, Accounts and Old records are the
 * ERP's ordinary list. "+ New" opens a dialog (`?dlg=`); a row opens its
 * record in a drawer (`?open=`).
 */
export const dynamic = "force-dynamic";

const LIST_KIND: Record<string, ListKind> = {
  expenses: "paid",
  pettyExpenses: "petty",
  moneyReview: "review",
  expensesCancelled: "cancelled",
  moneyTxns: "all",
  moneyReceipts: "receipts",
  receiptsBank: "receipts",
  receiptsCash: "receipts",
  receiptsUnmatched: "receipts",
  moneyTransfers: "transfers",
};
const STATEMENTS: Record<string, string> = { stmtKotak: "macc_kotak", stmtIcici: "macc_icici", stmtCash: "macc_cash", stmtPetty: "macc_petty" };
/*
 * LAYERED: four everyday tabs, and inside a tab a small switch for its kinds.
 * Paid holds expenses, petty cash and advances; Received holds all money in
 * and what the bank has not shown yet. A view not listed in a switch (bank or
 * cash receipts) still belongs to its tab. Everything else is under "More".
 */
const GROUPS: { label: string; segs: { key: string; label: string }[]; also?: string[] }[] = [
  { label: "Home", segs: [{ key: "moneyOverview", label: "Home" }] },
  { label: "Paid", segs: [{ key: "expenses", label: "Expenses" }, { key: "pettyExpenses", label: "Petty cash" }, { key: "advances", label: "Advances" }] },
  { label: "Received", segs: [{ key: "moneyReceipts", label: "All" }, { key: "receiptsUnmatched", label: "Not in bank yet" }], also: ["receiptsBank", "receiptsCash"] },
  { label: "Moved", segs: [{ key: "moneyTransfers", label: "Moved" }] },
  { label: "To approve", segs: [{ key: "moneyReview", label: "To approve" }] },
];
/* Rarely needed: behind "More ▾". */
const MORE: { key: string; label: string }[] = [
  { key: "stmtKotak", label: "Statements" },
  { key: "moneyAccounts", label: "Accounts" },
  { key: "moneyReports", label: "Reports" },
  { key: "moneyAudit", label: "Audit trail" },
  { key: "moneyTxns", label: "All expenses" },
  { key: "expensesCancelled", label: "Cancelled" },
  { key: "legacyPetty", label: "Old records" },
];
/* Pages that show what the accounts hold, or the money's totals: the
   accountant's and an administrator's only. Everybody else never sees them. */
const BALANCE_VIEWS = new Set<string>([...Object.keys(STATEMENTS), "moneyAccounts", "moneyReports", "moneyAudit"]);
const seesBalanceView = (key: string, sees: boolean) => sees || !BALANCE_VIEWS.has(key);

/* The one obvious button on a tab: add the thing this tab lists. */
const ADD: Record<string, { l: string; dlg: string }> = {
  expenses: { l: "Add expense", dlg: "expense" },
  moneyTxns: { l: "Add expense", dlg: "expense" },
  pettyExpenses: { l: "Add petty cash spend", dlg: "petty" },
  advances: { l: "Give advance", dlg: "advance" },
  moneyReceipts: { l: "Add money received", dlg: "receipt" },
  receiptsBank: { l: "Add money received", dlg: "receipt" },
  receiptsCash: { l: "Add money received", dlg: "receipt" },
  receiptsUnmatched: { l: "Add money received", dlg: "receipt" },
  moneyTransfers: { l: "Move money", dlg: "transfer" },
};
const EMPTY: Record<string, string> = {
  expenses: "No expenses this period. An expense is entered when it is paid, with the account it left.",
  pettyExpenses: "No petty cash this period. The Production Head's small spends land here, and the accountant reviews them.",
  moneyReview: "Nothing waiting for approval.",
  expensesCancelled: "Nothing cancelled this period.",
  moneyTxns: "No expenses this period.",
  moneyReceipts: "No receipts this period.",
  receiptsBank: "No bank receipts this period.",
  receiptsCash: "No cash receipts this period.",
  receiptsUnmatched: "Every bank receipt is on its statement.",
  moneyTransfers: "No transfers this period.",
};

type Raw = Record<string, string | string[] | undefined>;

export default async function PettyCashPage({ searchParams }: { searchParams: Promise<Raw> }) {
  const ctx = await erpContext();
  if (!ctx.screens.has("expenses")) redirect("/erp");
  const raw = await searchParams;
  const one = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : undefined);
  const screen = erpScreenBySlug("expenses")!;
  const views = heldViews(ctx, screen);
  if (!views.length) redirect("/erp");
  const known = new Set(views.map((v) => v.key).filter((k) => seesBalanceView(k, seesBalances({ approver: ctx.powers.has("approveMoney"), administrator: ctx.administrator }))));
  if (!known.size) redirect("/erp");
  const view = one("view") && known.has(one("view")!) ? one("view")! : (views.find((v) => known.has(v.key)) ?? views[0]).key;
  const day = today();
  const period = periodOf(one("p"));
  const approver = ctx.powers.has("approveMoney");
  /* Balances are the accountant's and an administrator's — never the team's (`seesBalances`). */
  const seesBal = seesBalances({ approver, administrator: ctx.administrator });
  const canWrite = !ctx.viewingAs;

  /* Where a link goes: this page, these parameters. */
  const here = (set: Record<string, string | null>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(raw)) if (typeof v === "string") u.set(k, v);
    for (const [k, v] of Object.entries(set)) {
      if (v == null) u.delete(k);
      else u.set(k, v);
    }
    const base = erpLink("expenses");
    return `${base.split("?")[0]}?${u.toString()}`;
  };

  /* The tabs, the current tab's switch, and "More". The registry's views
     (and so every grant) are unchanged; this only decides how they are drawn. */
  const [overview, kitBase] = await Promise.all([moneyOverview(day), moneyKitData(day)]);
  const toApprove = overview.review.n + overview.pettyReview.n + overview.sentBack.n;
  const main: Tab[] = [];
  let segs: Tab[] = [];
  for (const g of GROUPS) {
    const held = g.segs.filter((x) => known.has(x.key));
    if (!held.length) continue;
    /* "To approve" is the accountant's desk; the team reaches what was sent back from Home. */
    if (g.label === "To approve" && !approver) continue;
    const active = g.segs.some((x) => x.key === view) || !!g.also?.includes(view);
    main.push({ key: g.label, label: g.label, href: erpLink(held[0].key), active, count: g.label === "To approve" ? toApprove || undefined : undefined });
    if (active && held.length > 1) segs = held.map((x) => ({ key: x.key, label: x.label, href: erpLink(x.key), active: x.key === view }));
  }
  const inStatements = !!STATEMENTS[view];
  const more = MORE.filter((m) => known.has(m.key)).map((m) => ({ key: m.key, label: m.label, href: erpLink(m.key), active: m.key === view || (m.key === "stmtKotak" && inStatements) }));
  /* The account statements: the accounts as the switch. */
  if (inStatements) segs = views.filter((v) => STATEMENTS[v.key]).map((v) => ({ key: v.key, label: v.label, href: erpLink(v.key), active: v.key === view }));

  /* Without balances, the accounts reach the browser without them too. */
  const kit: MoneyKit = { ...kitBase, accounts: seesBal ? kitBase.accounts : kitBase.accounts.map((a) => ({ ...a, balance: 0 })), today: day, me: ctx.actor.name, approver, seesBalances: seesBal };
  const dlg = canWrite ? (one("dlg") ?? null) : null;
  const advId = one("adv") ?? null;
  const billsTarget = dlg === "bills" && advId ? await advanceView(advId) : null;
  const host = (
    <MoneyDialogHost
      kit={kit}
      dlg={dlg}
      bills={billsTarget ? { id: billsTarget.a.id, label: billsTarget.a.label, employee: billsTarget.a.employee, withThem: billsTarget.a.position.withThem, issuedOn: billsTarget.a.issuedOn } : null}
    />
  );
  const shell = (body: React.ReactNode) => (
    <Page
      title="Petty Cash"
      actions={
        canWrite ? (
          ADD[view] ? (
            <NavLink href={here({ dlg: ADD[view].dlg, open: null })} className={buttonClass({ variant: "primary" })}>
              <Icon name="plus" size={16} />
              {ADD[view].l}
            </NavLink>
          ) : null
        ) : null
      }
    >
      <TopTabs tabs={main} more={more} />
      {segs.length ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <SegSwitch tabs={segs} />
          {inStatements ? <PeriodLinks period={period} href={(p) => here({ p, open: null })} /> : null}
        </div>
      ) : null}
      {body}
      {host}
    </Page>
  );
  const openId = one("open") ?? null;
  const drawer = openId && (LIST_KIND[view] || STATEMENTS[view]) ? await txnDetail(openId) : null;
  const drawerView = drawer ? <TxnDrawerView d={seesBal ? drawer : { ...drawer, balanceAfter: null }} accounts={kit.accounts} approver={approver} canWrite={canWrite} /> : null;

  /* ---------------------------------------------------------- the lists */
  if (LIST_KIND[view]) {
    const f = { period, category: one("cat"), party: one("party"), account: one("acc"), q: one("q") };
    const [data, opts] = await Promise.all([txnView(view, f, day), filterOptions(view)]);
    const kind = LIST_KIND[view];
    const filters: FilterDef[] = [];
    if (TXN_VIEWS[view].windowed) filters.push({ name: "p", label: "Period", value: period, options: PERIODS.map((p) => ({ v: p.v, l: `${p.l} ▾` })) });
    if (kind !== "receipts" && kind !== "transfers") filters.push({ name: "cat", label: "Category", value: f.category ?? "", options: [{ v: "", l: "Category: All ▾" }, ...opts.categories.map((c) => ({ v: c, l: c }))] });
    if (seesBal) filters.push({
      name: "party",
      label: kind === "receipts" ? "Received from" : "Vendor",
      value: f.party ?? "",
      options: [{ v: "", l: kind === "receipts" ? "Received from: All ▾" : kind === "transfers" ? "Party: All ▾" : "Vendor: All ▾" }, ...opts.parties.map((c) => ({ v: c, l: c }))],
    });
    if (seesBal) filters.push({ name: "acc", label: "Account", value: f.account ?? "", options: [{ v: "", l: kind === "receipts" ? "Into: All ▾" : "Paid from: All ▾" }, ...kit.accounts.map((a) => ({ v: a.id, l: a.name }))] });
    return shell(
      <>
        <Panel>
          <TxnTable bank={seesBal} kind={kind} rows={data.rows} accounts={kit.accounts} approver={approver && canWrite} openId={openId} filters={filters} total={data.total} sum={data.sum} capped={data.capped} empty={EMPTY[view] ?? "Nothing here."} />
        </Panel>
        {drawerView}
      </>,
    );
  }

  /* ----------------------------------------------------------- advances */
  if (view === "advances") {
    if (advId && dlg !== "bills") {
      const d = await advanceView(advId);
      if (!d) notFound();
      return shell(
        <AdvancePage a={d.a} files={d.files} history={d.history} me={ctx.actor.id} approver={approver} canWrite={canWrite} accounts={kit.accounts} billsHref={here({ dlg: "bills" })} backHref={erpLink("advances")} />,
      );
    }
    const rows = await advanceList();
    const depts = new Map(kit.employees.map((e) => [e.id, e.dept]));
    return shell(
      <Panel>
        <AdvancesTable rows={rows} depts={depts} today={day} me={ctx.actor.id} approver={approver} canWrite={canWrite} />
      </Panel>,
    );
  }

  /* --------------------------------------------------------- statements */
  if (STATEMENTS[view]) {
    const st = await statementView(STATEMENTS[view], period, day);
    return shell(
      <>
        {st ? <StatementView st={st} openId={openId} /> : <Card className="p-6 text-sm text-muted">This account is not set up. Set it up under More › Accounts.</Card>}
        <p className="mt-3 text-sm text-muted">
          The bank&apos;s own statement:{" "}
          <NavLink href="/accounts/bank-statements" className={linkClass("brand", "font-semibold")}>
            Accounts › Bank statements
          </NavLink>
        </p>
        {drawerView}
      </>,
    );
  }

  /* ----------------------------------------------------------- overview */
  if (view === "moneyOverview") {
    const o = overview;
    /* Only what is actually waiting: a line with nothing in it is not shown. */
    const work: { l: string; n: number; v: string; href: string; danger?: boolean }[] = [
      { l: "Expenses to approve", n: o.review.n, v: inr(o.review.paise), href: erpLink("moneyReview") },
      { l: "Petty cash to check", n: o.pettyReview.n, v: inr(o.pettyReview.paise), href: erpLink("moneyReview") },
      { l: "Sent back to fix", n: o.sentBack.n, v: inr(o.sentBack.paise), href: erpLink("moneyReview") },
      { l: "Advances open", n: o.advancesOpen.n, v: inr(o.advancesOpen.withThem), href: erpLink("advances") },
      { l: "Advance bills late", n: o.advancesOpen.late, v: "", href: erpLink("advances"), danger: true },
      { l: "Not in bank yet", n: o.receiptsNotInBank.n, v: inr(o.receiptsNotInBank.paise), href: erpLink("receiptsUnmatched") },
      ...(approver ? [{ l: "Bank lines to match", n: o.unmatchedLines.n, v: inr(o.unmatchedLines.paise), href: "/accounts/bank-reconcile" }] : []),
      /* No list narrows to just these, so the line says where they are marked. */
      { l: "Possible double entries", n: o.duplicates.n, v: inr(o.duplicates.paise), href: erpLink("expenses"), danger: true },
    ].filter((w) => w.n > 0);
    return shell(
      <>
        {seesBal ? <AccountCards accounts={o.accounts.map((a) => ({ id: a.id, name: a.name, kind: a.kind, last4: a.last4, balance: a.balance, unmatched: a.unmatched }))} day={day} /> : null}
        {canWrite ? <QuickAdd items={newMenu()} /> : null}
        {work.length ? (
          <Panel>
            <div className="border-b border-divider px-5 py-3.5">
              <SectionTitle>Waiting</SectionTitle>
            </div>
            <ul className="divide-y divide-divider">
              {work.map((w) => (
                <li key={w.l}>
                  <NavLink href={w.href} className="flex items-center gap-3 px-5 py-3 hover:bg-canvas">
                    <span className={cx("flex-1 text-sm", w.danger ? "text-danger" : "text-body")}>{w.l}</span>
                    <span className="w-8 text-right text-sm font-semibold text-ink tabular-nums">{nf(w.n)}</span>
                    <span className="w-28 text-right text-sm text-body tabular-nums">{w.v}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          </Panel>
        ) : (
          <p className="text-sm text-muted">Nothing waiting.</p>
        )}
      </>,
    );
  }

  /* -------------------- the rest: Reports, Audit, Accounts, Old records */
  const mod = screenModule(view);
  if (!mod) notFound();
  const RESERVED = new Set<string>(["f", "fl", "open", "view", "new", "dlg", ...LIST_QUERY_KEYS]);
  const initialNew = one("new") ? Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => !RESERVED.has(e[0]) && typeof e[1] === "string")) : null;
  const query = parseListQuery(raw);
  const scope = { ...scopeFor(mod.window, query, openId), forms: "defer" as const };
  const { spec, rows, tooWide } = await withReadMemo(() => mod.load(ctx, scope));
  const page = lightPage(mod, { ...pageOf(spec, rows, query, FLAG), ...(mod.window ? { window: windowInfo(mod.window, scope, tooWide ?? null) } : {}) });
  const found = openId ? (rows.find((r) => r.id === openId) ?? null) : null;
  const fParam = one("f");
  return shell(
    <>
      <ListScreen
        key={`${view}|${fParam ?? ""}|${openId ?? ""}`}
        initialNew={initialNew}
        spec={lightSpec({ ...spec, newMenu: undefined, strip: undefined })}
        rows={page.rows}
        server={{ ...page, query }}
        openRow={found ? lightRow(mod, found) : null}
        label={screen.label}
        tabs={[]}
        sections={null}
        toggle={null}
        initialOpen={openId}
        filter={fParam ? { label: one("fl") ?? "Filtered", ids: fParam.split(",") } : null}
        godowns={ctx.assignedGodowns.map((g) => ({ v: g.name, l: g.name }))}
        bare
      />
    </>,
  );
}

function PeriodLinks({ period, href }: { period: string; href: (p: string) => string }) {
  return (
    <span className="flex items-center gap-1">
      {PERIODS.slice(0, 5).map((p) => (
        <NavLink key={p.v} href={href(p.v)} className={cx("rounded-control px-2.5 py-1 text-sm", p.v === period ? "bg-brand-soft font-semibold text-brand-hover" : "text-muted hover:text-body")}>
          {p.l}
        </NavLink>
      ))}
    </span>
  );
}
