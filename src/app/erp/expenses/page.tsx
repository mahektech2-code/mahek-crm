import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { erpContext } from "@/lib/erp/access";
import { erpLink, erpScreenBySlug } from "@/lib/erp/registry";
import { screenModule } from "@/lib/erp/screens";
import { moneyOverview } from "@/lib/erp/money";
import { today } from "@/lib/erp/screens/common";
import { inr, nf } from "@/lib/erp/ui";
import { LIST_QUERY_KEYS, pageOf, parseListQuery } from "@/lib/erp/list-query";
import { FLAG } from "@/lib/erp/ui";
import { withReadMemo } from "@/lib/erp/read-memo";
import { scopeFor, windowInfo } from "@/lib/erp/window";
import { Card, cx, Td, Th, Tr } from "@/components/ui/primitives";
import { CardGrid } from "@/components/ui/card-grid";
import { ListScreen, ListTabs, SectionTabs } from "../_ui/list-screen";
import { screenTabs } from "../_ui/screen-tabs";
import { Page } from "../_ui/page-head";
import { NewMenu } from "../_ui/new-menu";
import { Eyebrow, linkClass, SectionTitle } from "../_ui/look";

/**
 * PETTY CASH — one ERP module: Overview, Expenses, Receipts and Cash & Bank
 * across the top, each with its own tabs (the registry's `section`).
 *
 * Overview › Today is the one tab that is not a list: the balances, the work
 * waiting for somebody, cash by customer and petty cash by category, each
 * opening the list behind it. Every other tab is an ordinary ERP list, drawn
 * exactly as `[slug]/page.tsx` draws one.
 */
export const dynamic = "force-dynamic";

export default async function PettyCashPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await erpContext();
  if (!ctx.screens.has("expenses")) redirect("/erp");
  const raw = await searchParams;
  const one = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : undefined);
  const screen = erpScreenBySlug("expenses")!;
  const views = screen.views ?? [];
  const known = new Set(views.map((v) => v.key));
  const view = one("view") && known.has(one("view")!) ? one("view")! : views[0].key;

  if (view !== "moneyOverview") {
    const mod = screenModule(view);
    if (!mod) notFound();
    const RESERVED = new Set<string>(["f", "fl", "open", "view", "new", ...LIST_QUERY_KEYS]);
    const initialNew = one("new") ? Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => !RESERVED.has(e[0]) && typeof e[1] === "string")) : null;
    const query = parseListQuery(raw);
    const open = one("open");
    const scope = scopeFor(mod.window, query, open ?? null);
    const [{ spec, rows, tooWide }, { tabs, toggle, sections }] = await withReadMemo(() => Promise.all([mod.load(ctx, scope), screenTabs(ctx, screen, view)]));
    const page = { ...pageOf(spec, rows, query, FLAG), ...(mod.window ? { window: windowInfo(mod.window, scope, tooWide ?? null) } : {}) };
    const f = one("f");
    return (
      <ListScreen
        key={`${view}|${f ?? ""}|${open ?? ""}`}
        initialNew={initialNew}
        spec={spec}
        rows={page.rows}
        server={{ ...page, query }}
        openRow={open ? (rows.find((r) => r.id === open) ?? null) : null}
        label={screen.label}
        sub={screen.sub}
        tabs={tabs}
        sections={sections}
        toggle={toggle}
        initialOpen={open ?? null}
        filter={f ? { label: one("fl") ?? "Filtered", ids: f.split(",") } : null}
        godowns={ctx.assignedGodowns.map((g) => ({ v: g.name, l: g.name }))}
      />
    );
  }

  const day = today();
  const [o, { tabs, sections }] = await Promise.all([moneyOverview(day), screenTabs(ctx, screen, view)]);
  const approver = ctx.powers.has("approveMoney");
  const canWrite = !ctx.viewingAs;
  const NEW: { l: string; sub: string; href: string }[] = [
    { l: "Expense", sub: "a cost we paid", href: erpLink("expenses", { new: "1" }) },
    { l: "Petty cash expense", sub: "production's small spends", href: erpLink("pettyExpenses", { new: "1" }) },
    { l: "Receipt", sub: "money that came in", href: erpLink("moneyReceipts", { new: "1" }) },
    { l: "Transfer", sub: "bank ↔ cash, bank ↔ bank", href: erpLink("moneyTransfers", { new: "1" }) },
    { l: "Advance", sub: "a lump sum to an employee", href: erpLink("advances", { new: "1" }) },
  ];
  const work: { l: string; n: number; v: string; href: string; danger?: boolean; hide?: boolean }[] = [
    { l: "Expenses waiting for approval", n: o.review.n, v: inr(o.review.paise), href: erpLink("moneyReview") },
    { l: "Petty cash to review", n: o.pettyReview.n, v: inr(o.pettyReview.paise), href: erpLink("moneyReview") },
    { l: "Sent back, waiting to be fixed", n: o.sentBack.n, v: inr(o.sentBack.paise), href: erpLink("moneyReview"), hide: !o.sentBack.n },
    { l: "Advances open", n: o.advancesOpen.n, v: inr(o.advancesOpen.withThem), href: erpLink("advances"), hide: !o.advancesOpen.n },
    { l: "Advances with bills late", n: o.advancesOpen.late, v: "", href: erpLink("advances"), danger: true, hide: !o.advancesOpen.late },
    { l: "Receipts not matched to bank", n: o.receiptsNotInBank.n, v: inr(o.receiptsNotInBank.paise), href: erpLink("receiptsUnmatched") },
    { l: "Bank lines not matched", n: o.unmatchedLines.n, v: inr(o.unmatchedLines.paise), href: erpLink("bankLines"), hide: !approver || !o.unmatchedLines.n },
    { l: "Possible duplicates", n: o.duplicates.n, v: inr(o.duplicates.paise), href: erpLink("expenses"), danger: true },
  ];
  const maxCat = Math.max(1, ...o.byCategory.map((c) => c.paise));
  const month = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][Number(day.slice(5, 7)) - 1];

  return (
    <Page
      title={screen.label}
      sub={screen.sub}
      actions={canWrite ? <NewMenu items={NEW} /> : null}
    >
      {sections?.length ? <SectionTabs label={screen.label} sections={sections} /> : null}
      {tabs.length > 1 ? <ListTabs label={screen.label} tabs={tabs} /> : null}

      <CardGrid min="card" className="mb-4">
        {o.accounts.map((a) => (
          <Card key={a.id} className="p-4">
            <Eyebrow>
              {a.name}
              {a.last4 ? ` ••${a.last4}` : ""}
            </Eyebrow>
            <div className={cx("mt-1 text-2xl font-semibold tabular-nums", a.balance < 0 ? "text-danger" : "text-ink")}>{inr(a.balance)}</div>
            <div className="mt-1 text-meta text-muted">
              {a.kind === "bank" ? (a.unmatched ? `${nf(a.unmatched)} bank line${a.unmatched === 1 ? "" : "s"} not matched` : "Every imported line matched") : a.balance < 0 ? "Below zero — a transfer in is missing" : a.kind === "petty" ? "The petty cash float" : "Cash in the office"}
            </div>
          </Card>
        ))}
      </CardGrid>


      <CardGrid min="panel">
        <Card className="p-4">
          <SectionTitle>Needs somebody</SectionTitle>
          <ul className="mt-2 divide-y divide-divider">
            {work
              .filter((w) => !w.hide)
              .map((w) => (
                <li key={w.l}>
                  <Link href={w.href} className="flex items-center gap-3 py-2 hover:bg-canvas">
                    <span className={cx("flex-1 text-sm", w.danger ? "text-danger" : "text-body")}>{w.l}</span>
                    <span className="w-8 text-right text-sm font-semibold tabular-nums text-ink">{nf(w.n)}</span>
                    <span className="w-32 text-right text-meta tabular-nums text-muted">{w.v}</span>
                  </Link>
                </li>
              ))}
          </ul>
        </Card>

        <Card className="p-4">
          <SectionTitle aside={<span className="text-meta text-muted">{month}</span>}>Cash received by customer</SectionTitle>
          {o.byCustomer.length ? (
            <table className="mt-2 w-full table-fixed">
              <thead>
                <Tr>
                  <Th>Customer</Th>
                  <Th align="right" className="w-24">
                    Cash
                  </Th>
                  <Th align="right" className="w-24">
                    Bank
                  </Th>
                </Tr>
              </thead>
              <tbody>
                {o.byCustomer.map((c) => (
                  <Tr key={c.name}>
                    <Td className="truncate font-medium text-ink" title={c.name}>
                      {c.name}
                    </Td>
                    <Td align="right">{c.cash ? inr(c.cash) : "—"}</Td>
                    <Td align="right">{c.bank ? inr(c.bank) : "—"}</Td>
                  </Tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="mt-2 text-meta text-muted">Nothing received this month yet.</p>
          )}
          <Link href={erpLink("moneyReceipts")} className={linkClass("brand", "mt-3 inline-block text-meta")}>
            All receipts
          </Link>
        </Card>

        <Card className="p-4">
          <SectionTitle aside={<span className="text-meta text-muted">{month}</span>}>Petty cash by category</SectionTitle>
          {o.byCategory.length ? (
            <ul className="mt-3 grid gap-2.5">
              {o.byCategory.map((c) => (
                <li key={c.name} className="text-meta">
                  <div className="flex justify-between">
                    <span className="text-body">{c.name}</span>
                    <span className="font-semibold tabular-nums text-ink">{inr(c.paise)}</span>
                  </div>
                  <div className="mt-1 h-2 rounded-full bg-divider">
                    <div className="h-full rounded-full bg-brand" style={{ width: `${Math.max(4, Math.round((c.paise / maxCat) * 100))}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-meta text-muted">No petty cash or advance bills this month yet.</p>
          )}
          <Link href={erpLink("pettyExpenses")} className={linkClass("brand", "mt-3 inline-block text-meta")}>
            Production petty cash
          </Link>
        </Card>
      </CardGrid>
    </Page>
  );
}
