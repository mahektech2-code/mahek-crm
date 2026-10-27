import { NavLink } from "@/components/shell/nav-link";
import { notFound, redirect } from "next/navigation";
import { erpContext } from "@/lib/erp/access";
import { erpLink, erpScreenBySlug } from "@/lib/erp/registry";
import { screenModule } from "@/lib/erp/screens";
import { newMenu } from "@/lib/erp/screens/money";
import { moneyOverview } from "@/lib/erp/money";
import { advanceList, advanceView, filterOptions, moneyKitData, PERIODS, periodOf, statementView, tabCounts, TXN_VIEWS, txnDetail, txnView } from "@/lib/erp/money-views";
import { today } from "@/lib/erp/screens/common";
import { FLAG, inr, nf } from "@/lib/erp/ui";
import { LIST_QUERY_KEYS, pageOf, parseListQuery } from "@/lib/erp/list-query";
import { withReadMemo } from "@/lib/erp/read-memo";
import { scopeFor, windowInfo } from "@/lib/erp/window";
import { Card, cx, Td, Th, Tr } from "@/components/ui/primitives";
import { CardGrid } from "@/components/ui/card-grid";
import { ListScreen } from "../_ui/list-screen";
import { lightPage, lightRow, lightSpec } from "@/lib/erp/lazy-forms";
import { Page } from "../_ui/page-head";
import { NewMenu } from "../_ui/new-menu";
import { linkClass, SectionTitle } from "../_ui/look";
import { MoneyDialogHost } from "./money-dialogs";
import type { FilterDef } from "./money-client";
import type { MoneyKit } from "./money-ui";
import { AccountCards, AdvancePage, AdvancesTable, Panel, SectionNav, StatementView, SubTabs, TxnDrawerView, TxnTable, type ListKind, type Tab } from "./screens";

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
  const views = screen.views ?? [];
  const known = new Set(views.map((v) => v.key));
  const view = one("view") && known.has(one("view")!) ? one("view")! : views[0].key;
  const day = today();
  const period = periodOf(one("p"));
  const approver = ctx.powers.has("approveMoney");
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

  /* The sub-modules and the current one's tabs, with counts. */
  const current = views.find((v) => v.key === view)!;
  const sectionNames = [...new Set(views.map((v) => v.section ?? ""))];
  const mine = views.filter((v) => (v.section ?? "") === current.section);
  const [counts, overview, kitBase] = await Promise.all([
    tabCounts([...mine.map((v) => v.key)], period, day),
    moneyOverview(day),
    moneyKitData(day),
  ]);
  const sectionCount: Record<string, number> = {
    Overview: 0,
    Expenses: overview.review.n + overview.pettyReview.n + overview.sentBack.n,
    Receipts: overview.receiptsNotInBank.n,
    "Cash & Bank": 0,
  };
  const sections: Tab[] = sectionNames.map((n) => {
    const first = views.find((v) => (v.section ?? "") === n)!;
    return { key: n, label: n, href: erpLink(first.key), active: n === current.section, count: sectionCount[n] || undefined };
  });
  /* The four account statements are ONE tab, "Petty Cash statements", with the accounts inside it. */
  const tabs: Tab[] = [];
  for (const v of mine) {
    if (STATEMENTS[v.key]) {
      if (!tabs.some((t) => t.key === "stmt")) tabs.push({ key: "stmt", label: "Petty Cash statements", href: erpLink(v.key), active: !!STATEMENTS[view] });
      continue;
    }
    tabs.push({ key: v.key, label: v.label, href: erpLink(v.key), active: v.key === view, count: counts[v.key] });
  }
  const stmtTabs: Tab[] = mine.filter((v) => STATEMENTS[v.key]).map((v) => ({ key: v.key, label: v.label, href: erpLink(v.key), active: v.key === view }));

  const kit: MoneyKit = { ...kitBase, today: day, me: ctx.actor.name, approver };
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
    <Page title="Petty Cash" sub="Expenses, receipts, cash and bank — each transaction entered once" actions={canWrite ? <NewMenu items={newMenu()} /> : null}>
      <SectionNav sections={sections} />
      {body}
      {host}
    </Page>
  );
  const openId = one("open") ?? null;
  const drawer = openId && (LIST_KIND[view] || STATEMENTS[view]) ? await txnDetail(openId) : null;
  const drawerView = drawer ? <TxnDrawerView d={drawer} accounts={kit.accounts} approver={approver} canWrite={canWrite} /> : null;

  /* ---------------------------------------------------------- the lists */
  if (LIST_KIND[view]) {
    const f = { period, category: one("cat"), party: one("party"), account: one("acc"), q: one("q") };
    const [data, opts] = await Promise.all([txnView(view, f, day), filterOptions(view)]);
    const kind = LIST_KIND[view];
    const filters: FilterDef[] = [];
    if (TXN_VIEWS[view].windowed) filters.push({ name: "p", label: "Period", value: period, options: PERIODS.map((p) => ({ v: p.v, l: `${p.l} ▾` })) });
    if (kind !== "receipts" && kind !== "transfers") filters.push({ name: "cat", label: "Category", value: f.category ?? "", options: [{ v: "", l: "Category: All ▾" }, ...opts.categories.map((c) => ({ v: c, l: c }))] });
    filters.push({
      name: "party",
      label: kind === "receipts" ? "Received from" : "Vendor",
      value: f.party ?? "",
      options: [{ v: "", l: kind === "receipts" ? "Received from: All ▾" : kind === "transfers" ? "Party: All ▾" : "Vendor: All ▾" }, ...opts.parties.map((c) => ({ v: c, l: c }))],
    });
    filters.push({ name: "acc", label: "Account", value: f.account ?? "", options: [{ v: "", l: kind === "receipts" ? "Into: All ▾" : "Paid from: All ▾" }, ...kit.accounts.map((a) => ({ v: a.id, l: a.name }))] });
    return shell(
      <>
        <Panel>
          <SubTabs tabs={tabs} />
          <TxnTable kind={kind} rows={data.rows} accounts={kit.accounts} approver={approver && canWrite} openId={openId} filters={filters} total={data.total} sum={data.sum} capped={data.capped} empty={EMPTY[view] ?? "Nothing here."} />
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
        <AdvancePage a={d.a} files={d.files} history={d.history} approver={approver} canWrite={canWrite} accounts={kit.accounts} billsHref={here({ dlg: "bills" })} backHref={erpLink("advances")} />,
      );
    }
    const rows = await advanceList();
    const depts = new Map(kit.employees.map((e) => [e.name.toLowerCase(), e.dept]));
    return shell(
      <Panel>
        <SubTabs tabs={tabs} />
        <AdvancesTable rows={rows} depts={depts} today={day} />
      </Panel>,
    );
  }

  /* --------------------------------------------------------- statements */
  if (STATEMENTS[view]) {
    const st = await statementView(STATEMENTS[view], period, day);
    return shell(
      <>
        <Panel className="mb-3">
          <SubTabs
            tabs={tabs}
            aside={
              <NavLink href="/accounts/bank-statements" className="text-sm font-semibold whitespace-nowrap text-brand hover:underline">
                Bank PDFs and reconciling → Accounts · Bank statement management ↗
              </NavLink>
            }
          />
        </Panel>
        <div className="mb-3 flex items-center justify-between gap-3">
          <SubTabs tabs={stmtTabs} />
          <PeriodLinks period={period} href={(p) => here({ p, open: null })} />
        </div>
        {st ? <StatementView st={st} openId={openId} /> : <Card className="p-6 text-sm text-muted">This account is not set up. Add it on Cash &amp; Bank › Accounts.</Card>}
        {drawerView}
      </>,
    );
  }

  /* ----------------------------------------------------------- overview */
  if (view === "moneyOverview") {
    const o = overview;
    const work: { l: string; n: number; v: string; href: string; danger?: boolean; hide?: boolean }[] = [
      { l: "Expenses waiting for approval", n: o.review.n, v: inr(o.review.paise), href: erpLink("moneyReview") },
      { l: "Petty cash to review", n: o.pettyReview.n, v: inr(o.pettyReview.paise), href: erpLink("moneyReview") },
      { l: "Sent back, waiting to be fixed", n: o.sentBack.n, v: inr(o.sentBack.paise), href: erpLink("moneyReview"), hide: !o.sentBack.n },
      { l: "Advances open", n: o.advancesOpen.n, v: inr(o.advancesOpen.withThem), href: erpLink("advances"), hide: !o.advancesOpen.n },
      { l: "Advances with bills late", n: o.advancesOpen.late, v: "", href: erpLink("advances"), danger: true, hide: !o.advancesOpen.late },
      { l: "Receipts not matched to bank", n: o.receiptsNotInBank.n, v: inr(o.receiptsNotInBank.paise), href: erpLink("receiptsUnmatched") },
      { l: "Bank lines not matched", n: o.unmatchedLines.n, v: inr(o.unmatchedLines.paise), href: "/accounts/bank-reconcile", hide: !approver || !o.unmatchedLines.n },
      { l: "Possible duplicates", n: o.duplicates.n, v: inr(o.duplicates.paise), href: erpLink("expenses"), danger: true },
    ];
    const maxCat = Math.max(1, ...o.byCategory.map((c) => c.paise));
    const month = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][Number(day.slice(5, 7)) - 1];
    return shell(
      <>
        {/* v4: the overview's tabs stand on the page, underlined, with no card round them. */}
        <div className="mb-5 [&>nav]:px-0">
          <SubTabs tabs={tabs} />
        </div>
        <AccountCards accounts={o.accounts.map((a) => ({ id: a.id, name: a.name, kind: a.kind, last4: a.last4, balance: a.balance, unmatched: a.unmatched }))} day={day} />
        <CardGrid min="panel">
          <Panel>
            <div className="border-b border-divider px-5 py-4">
              <SectionTitle>Needs somebody</SectionTitle>
            </div>
            <ul className="divide-y divide-divider">
              {work
                .filter((w) => !w.hide)
                .map((w) => (
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
          <Panel>
            <div className="border-b border-divider px-5 py-4">
              <SectionTitle aside={<span className="text-sm text-muted">{month}</span>}>Cash received by customer</SectionTitle>
            </div>
            {o.byCustomer.length ? (
              <table className="w-full table-fixed">
                <thead>
                  <Tr>
                    <Th className="bg-surface">Customer</Th>
                    <Th align="right" className="w-28 bg-surface">
                      Cash
                    </Th>
                    <Th align="right" className="w-28 bg-surface">
                      Bank
                    </Th>
                  </Tr>
                </thead>
                <tbody>
                  {o.byCustomer.map((c) => (
                    <Tr key={c.name} className="[&>td]:h-10 [&>td]:text-sm">
                      <Td className="truncate font-semibold text-ink" title={c.name}>
                        {c.name}
                      </Td>
                      <Td align="right">{c.cash ? inr(c.cash) : "—"}</Td>
                      <Td align="right">{c.bank ? inr(c.bank) : "—"}</Td>
                    </Tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="px-5 py-4 text-sm text-muted">Nothing received this month yet.</p>
            )}
            <div className="px-5 py-3">
              <NavLink href={erpLink("moneyReceipts")} className={linkClass("brand", "text-sm")}>
                All receipts
              </NavLink>
            </div>
          </Panel>
          <Panel>
            <div className="border-b border-divider px-5 py-4">
              <SectionTitle aside={<span className="text-sm text-muted">{month}</span>}>Petty cash by category</SectionTitle>
            </div>
            {o.byCategory.length ? (
              <ul className="grid gap-3 px-5 py-4">
                {o.byCategory.map((c) => (
                  <li key={c.name}>
                    <div className="flex justify-between text-sm">
                      <span className="text-body">{c.name}</span>
                      <span className="font-semibold text-ink tabular-nums">{inr(c.paise)}</span>
                    </div>
                    <div className="mt-1.5 h-2 rounded-full bg-divider">
                      <div className="h-full rounded-full bg-brand" style={{ width: `${Math.max(4, Math.round((c.paise / maxCat) * 100))}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 py-4 text-sm text-muted">No petty cash or advance bills this month yet.</p>
            )}
          </Panel>
        </CardGrid>
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
      <Panel className="mb-5">
        <SubTabs tabs={tabs} />
      </Panel>
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
      {PERIODS.slice(0, 4).map((p) => (
        <NavLink key={p.v} href={href(p.v)} className={cx("rounded-control px-2.5 py-1 text-sm", p.v === period ? "bg-brand-soft font-semibold text-brand-hover" : "text-muted hover:text-body")}>
          {p.l}
        </NavLink>
      ))}
    </span>
  );
}
