import type { Metadata } from "next";
import { Card, PageHeader } from "@/components/ui/primitives";
import { activeFilterCount, parseFilters, parseKey, type RawParams } from "@/lib/studio/domain/history";
import { historyPage, historyPanel } from "@/lib/studio/history-service";
import { FilterBar, HistoryEmpty, HistoryNotice, HistoryPanel, HistoryTable, Pager, type QueryState } from "../_ui/history-view";
import { Tabs } from "../_ui/parts";

export const metadata: Metadata = { title: "My posters" };
export const dynamic = "force-dynamic";

/* My posters, with the forwarding history in its table. A made poster is one row; so is each recipient of an uploaded
   poster in a started list. See lib/studio/history-service.ts for who sees what. */
export default async function PostersPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  const sp = await searchParams;
  const requested = (Array.isArray(sp.whose) ? sp.whose[0] : sp.whose) === "team" ? "team" : "mine";
  const filters = parseFilters(sp);
  let result = await historyPage(filters, requested);
  /* Somebody with no team has no My team's tab: asking for it answers as Mine, never with a wider view. */
  let whose: "mine" | "team" = requested;
  if (requested === "team" && !result.canTeam) {
    whose = "mine";
    result = await historyPage(filters, "mine");
  }
  const openRaw = Array.isArray(sp.open) ? sp.open[0] : sp.open;
  const open = parseKey(openRaw) ? (openRaw as string) : null;
  const state: QueryState = { whose, filters: { ...filters, page: result.page }, open };
  const panel = open ? await historyPanel(open, whose) : null;
  const filtered = activeFilterCount(filters) > 0 || filters.q !== "";
  return (
    <div className="mx-auto max-w-[1180px] px-6 py-6">
      <PageHeader title={whose === "team" ? "Team's posters" : "My posters"} subtitle="Every poster, newest first — and who it was forwarded to. Open a row for the details." />
      {result.canTeam ? (
        <Tabs
          items={[
            { href: "/studio/posters?whose=mine", label: "Mine", active: whose === "mine" },
            { href: "/studio/posters?whose=team", label: "My team's", active: whose === "team" },
          ]}
        />
      ) : null}
      <HistoryNotice />
      <FilterBar s={state} page={result} />
      {result.rows.length ? (
        <HistoryTable s={state} page={result} />
      ) : (
        <Card>
          <HistoryEmpty filtered={filtered} />
        </Card>
      )}
      <Pager s={state} page={result} />
      {panel ? <HistoryPanel s={state} data={panel} /> : null}
    </div>
  );
}
