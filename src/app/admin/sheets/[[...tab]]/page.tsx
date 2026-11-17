import Link from "next/link";
import { CardGrid } from "@/components/ui/card-grid";
import { ADMIN, ADMIN_TABS, tabIndexOf } from "@/lib/admin-routes";
import { canFor, isPlatformAdmin } from "@/lib/access-control";
import { nowMs } from "@/lib/format";
import { calendarDate } from "@/lib/business-date";
import { openConflicts, sheetSourceCards, type SheetSourceCard } from "@/lib/services/admin-data-view-service";
import { sheetsConfigured } from "@/lib/sheets";
import { getConfig } from "@/lib/config/store";
import { retiredReason, sheetSwitches } from "@/lib/engines/sheet-retirement";
import { importHistory } from "@/lib/services/admin-platform-service";
import {
  assignableOwners,
  listSheetIssues,
  listSheetOrders,
  listSheetRows,
  sheetSummary,
} from "@/lib/services/sheet-order-service";
import { orderSheetId, orderTabTitle } from "@/lib/services/sheet-sync-service";
import { AdminPage } from "../../_shell/admin-page";
import { Pill, Tabs } from "../../_shell/kit";
import { ConflictsCard, SheetsActions } from "./sheets-parts";
import { adminContext } from "../../_shell/context";
import { SHEET_SUBTITLE } from "../../sheet-data";
import { SheetSection } from "../../sheet-section";
import { ImportsTab } from "../../platform-real";

/**
 * Every sheet MahekOne reads, the canvas's way: a card per source saying when
 * it was last read and what it brought, then the work — conflicts first,
 * because a conflict is a person's decision the sheet still disagrees with.
 *
 * The routes are the ones the console always had; the bare address is the
 * Conflicts tab, and Sync is reached from "Sync now" rather than a tab.
 */
export default async function SheetsPage({
  params,
  searchParams,
}: {
  params: Promise<{ tab?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await adminContext();
  const [{ tab }, query] = await Promise.all([params, searchParams]);
  const one = (k: string) => {
    const v = query[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const conflictsTab = !tab?.[0];
  const index = tabIndexOf(ADMIN_TABS.sheets, tab?.[0]);
  const slug = conflictsTab ? "conflicts" : ADMIN_TABS.sheets[index].slug;

  const [cards, conflicts, config, canRun] = await Promise.all([
    sheetSourceCards(),
    openConflicts(),
    getConfig(),
    (async () => (await isPlatformAdmin(ctx.user)) || (await canFor(ctx.user, "sheet.import")))(),
  ]);
  const now = nowMs();
  const switches = sheetSwitches(config);
  const cutover = config["fieldActivity.cutoverDate"];

  const tabs = [
    { slug: "conflicts", label: "Conflicts", count: conflicts.total || null, urgent: true, href: ADMIN.sheets() },
    { slug: "issues", label: "Needs attention", href: ADMIN.sheets("issues") },
    { slug: "lines", label: "Order lines", href: ADMIN.sheets("lines") },
    { slug: "orders", label: "Orders", href: ADMIN.sheets("orders") },
    { slug: "history", label: "History", href: ADMIN.sheets("history") },
    ...(slug === "sync" ? [{ slug: "sync", label: "Sync", href: ADMIN.sheets("sync") }] : []),
  ];

  return (
    <AdminPage
      title="Sheets &amp; imports"
      subtitle={SHEET_SUBTITLE}
      actions={<SheetsActions canRun={canRun} />}
    >
      <SourceCards cards={cards} now={now} switches={switches} cutover={cutover} />
      <Tabs items={tabs} active={slug} />
      {conflictsTab ? (
        <ConflictsCard rows={conflicts.rows} total={conflicts.total} canResolve={canRun} />
      ) : slug === "history" ? (
        <ImportsTab data={{ imports: await importHistory() }} />
      ) : (
        <SheetBody index={index} one={one} canImport={ctx.canWriteConfig} />
      )}
    </AdminPage>
  );
}

function ago(iso: string | null, now: number): string {
  if (!iso) return "Never read";
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (min < 1) return "Just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

const n = (v: number) => v.toLocaleString("en-IN");

/** A switch's state, drawn as the canvas's toggle — it opens the setting rather than flipping it here. */
function Switch({ on, label }: { on: boolean; label: string }) {
  return (
    <Link
      href={`${ADMIN.settingsFor("erp", "general")}#${label}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      title="Changed on the ERP settings page"
      className={`relative inline-block h-[22px] w-[38px] flex-none rounded-full ${on ? "bg-brand" : "bg-line-strong"}`}
    >
      <span className={`absolute top-[3px] h-4 w-4 rounded-full bg-white ${on ? "left-[19px]" : "left-[3px]"}`} />
    </Link>
  );
}

function SourceCards({
  cards,
  now,
  switches,
  cutover,
}: {
  cards: SheetSourceCard[];
  now: number;
  switches: ReturnType<typeof sheetSwitches>;
  cutover: string;
}) {
  const today = calendarDate(new Date(now));
  return (
    <CardGrid min={260} gap="gap-3">
      {cards.map((c) => {
        const pastOnly = c.key === "field_activity" && cutover <= today;
        const quiet = c.state === "retired" || pastOnly;
        const pill =
          c.state === "retired" ? (
            <Pill tone="muted" title={c.retiredWhy ?? undefined}>Retired</Pill>
          ) : pastOnly ? (
            <Pill tone="muted" title={`Rows after ${cutover} are not stored — MBOS is the record`}>Past only</Pill>
          ) : c.state === "failing" ? (
            <Pill tone="danger" title={c.error ?? undefined}>Failing</Pill>
          ) : c.state === "never" ? (
            <Pill tone="muted">Not read</Pill>
          ) : (
            <Pill tone="ok">Live</Pill>
          );
        const moved = (c.created ?? 0) + (c.updated ?? 0);
        return (
          <div key={c.key} className={`flex flex-col gap-2 rounded-card border text-sm border-line px-4 py-3.5 ${quiet ? "bg-[#f7f9fc]" : "bg-surface"}`}>
            <div className="flex items-center gap-2.5">
              <b className="text-[15px] font-bold text-ink">{c.label}</b>
              <span className="flex-1" />
              {pill}
            </div>
            <span className="text-[20px] leading-7 font-bold text-ink">{ago(c.at, now)}</span>
            <div className="flex flex-wrap items-center gap-2.5 text-muted">
              {c.read != null ? <span>{n(c.read)} rows</span> : <span>No run recorded here</span>}
              {c.read != null ? <span>· {moved ? `${n(c.created ?? 0)} new${c.updated ? `, ${n(c.updated)} changed` : ""}` : "no change"}</span> : null}
            </div>
            {c.key === "order_details" ? (
              <div className="flex items-center gap-2.5">
                <span className="flex-1 text-muted">Retire when ERP takes orders</span>
                <Switch on={switches.ordersLive} label="erp.orders.live" />
              </div>
            ) : c.key === "sales_party" ? (
              <div className="flex items-center gap-2.5">
                <span className="flex-1 text-muted">Party sheet {switches.partySheetLive ? "on" : "off"}</span>
                <Switch on={switches.partySheetLive} label="erp.orders.partySheet" />
              </div>
            ) : null}
          </div>
        );
      })}
    </CardGrid>
  );
}

async function SheetBody({
  index,
  one,
  canImport,
}: {
  index: number;
  one: (k: string) => string | undefined;
  canImport: boolean;
}) {
  const [summary, page, orders, issues, owners, config] = await Promise.all([
    sheetSummary(),
    listSheetRows({
      query: one("sq"),
      issuesOnly: one("sissues") === "1",
      page: Math.max(1, Number(one("spage") ?? 1) || 1),
      perPage: 100,
    }),
    listSheetOrders(200),
    listSheetIssues(),
    assignableOwners(),
    getConfig(),
  ]);
  return (
    <SheetSection
      tab={index}
      data={{
        summary,
        rows: page.rows,
        total: page.total,
        page: page.page,
        pages: page.pages,
        orders,
        issues,
        filters: { query: one("sq"), issuesOnly: one("sissues") === "1" },
        source: { spreadsheetId: orderSheetId(), tabTitle: orderTabTitle(), configured: sheetsConfigured() },
        owners,
        canImport,
        retired: retiredReason("sheet-reconcile", sheetSwitches(config)),
      }}
    />
  );
}
