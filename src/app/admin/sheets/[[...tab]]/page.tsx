import { ADMIN, ADMIN_TABS, tabIndexOf, type TabsOf } from "@/lib/admin-routes";
import { sheetsConfigured } from "@/lib/sheets";
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
import { adminContext } from "../../_shell/context";
import { SHEET_SUBTITLE } from "../../sheet-data";
import { SheetSection } from "../../sheet-section";
import { ImportsTab } from "../../platform-real";

/**
 * The imported order sheet, and the history of every sheet sync.
 *
 * The history was Data → Sheet imports, a second place to read about the same
 * syncs the Sync tab here runs — and the platform's Health tab printed the
 * last one a third time. It is one tab of this page now.
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
  const index = tabIndexOf(ADMIN_TABS.sheets, tab?.[0]);
  const slug = ADMIN_TABS.sheets[index].slug;

  return (
    <AdminPage
      title="Sheets"
      subtitle={SHEET_SUBTITLE}
      tabs={{ items: ADMIN_TABS.sheets, active: slug, href: (s) => ADMIN.sheets(s as TabsOf<"sheets">) }}
    >
      {slug === "history" ? (
        <ImportsTab data={{ imports: await importHistory() }} />
      ) : (
        <div className="mt-5">
          <SheetBody index={index} one={one} canImport={ctx.canWriteConfig} />
        </div>
      )}
    </AdminPage>
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
  const [summary, page, orders, issues, owners] = await Promise.all([
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
      }}
    />
  );
}
