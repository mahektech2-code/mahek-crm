import { redirect } from "next/navigation";
import { requireUser, isManager } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { APPS } from "@/lib/apps";
import { can } from "@/lib/access-control";
import { getConfig, configWarnings } from "@/lib/config/store";
import { listCollections } from "@/lib/config/entity-collections";
import { crmSchema, schemaFields, toConsole } from "@/lib/config/schema-contract";
import {
  catalogueSummary,
  listAliases,
  listDuplicates,
  listExceptions,
  listHierarchy,
  listSkus,
} from "@/lib/services/catalogue-service";
import { SOURCE_DISCREPANCIES } from "@/db/catalogue-seed";
import {
  listSheetIssues,
  listSheetOrders,
  listSheetRows,
  sheetSummary,
} from "@/lib/services/sheet-order-service";
import { sheetsConfigured } from "@/lib/sheets";
import {
  orderSheetId,
  orderTabTitle,
} from "@/lib/services/sheet-sync-service";
import type { Config } from "@/lib/config/registry";
import { AdminConsole } from "../console";

export const metadata = { title: "Admin Console · MahekOne" };

/**
 * Access is checked here, not just hidden on the launcher — a bookmarked
 * /admin must not open for somebody who was never given the app.
 *
 * A CRM manager reaches this console too, for their own app's section. They
 * hold no platform access, so nothing outside it renders for them.
 */
/**
 * One page for every screen in the console: /admin, /admin/people,
 * /admin/people/security. The segments ARE the address — the same shape the
 * rest of MahekOne uses, rather than the console being the one place addressed
 * by query string.
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ path?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { path } = await params;
  const [section, tab] = path ?? [];
  const user = await requireUser();
  const apps = await listUserApps(user.id);

  const isPlatformAdmin = apps.includes("admin");
  const canConfigureCrm = can(user.role, "config.write") && apps.includes("crm");
  if (!isPlatformAdmin && !canConfigureCrm) redirect("/apps");

  const [config, warnings, collections] = await Promise.all([
    getConfig(),
    configWarnings(),
    listCollections(),
  ]);

  // The SKU list is filtered and paged by the address, so a filtered list is a
  // screen somebody can send to somebody else.
  const query = await searchParams;
  const one = (k: string) => {
    const v = query[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const page = Math.max(1, Number(one("page") ?? 1) || 1);
  const PER_PAGE = 50;
  const status = one("status") ?? "all";

  const [summary, skuPage, hierarchy, duplicates, exceptions, aliases] = await Promise.all([
    catalogueSummary(),
    listSkus({
      query: one("q"),
      formulationId: one("formulation"),
      status: status as "all" | "ok" | "needs_canonical_id" | "inactive",
      limit: PER_PAGE,
      offset: (page - 1) * PER_PAGE,
    }),
    listHierarchy(),
    listDuplicates(),
    listExceptions(),
    listAliases(),
  ]);

  // The imported order sheet. Read here rather than in the client component so
  // the section arrives rendered, like every other section in this console.
  const [sheetStats, sheetPage, sheetOrders, sheetIssues] = await Promise.all([
    sheetSummary(),
    listSheetRows({
      query: one("sq"),
      issuesOnly: one("sissues") === "1",
      page: Math.max(1, Number(one("spage") ?? 1) || 1),
      perPage: 100,
    }),
    listSheetOrders(200),
    listSheetIssues(),
  ]);

  // Stored values, projected into the shapes the console's controls edit.
  const values: Record<string, unknown> = {};
  for (const f of schemaFields(crmSchema())) {
    values[f.key] = toConsole(config[f.key as keyof Config], f.control, f.parts);
  }

  return (
    <AdminConsole
      apps={APPS.filter((a) => apps.includes(a.id))}
      isPlatformAdmin={isPlatformAdmin}
      initial={{ section, tab }}
      sheet={{
        summary: sheetStats,
        rows: sheetPage.rows,
        total: sheetPage.total,
        page: sheetPage.page,
        pages: sheetPage.pages,
        orders: sheetOrders,
        issues: sheetIssues,
        filters: { query: one("sq"), issuesOnly: one("sissues") === "1" },
        source: {
          spreadsheetId: orderSheetId(),
          tabTitle: orderTabTitle(),
          configured: sheetsConfigured(),
        },
      }}
      catalogue={{
        summary,
        skus: skuPage.rows,
        total: skuPage.total,
        page,
        pages: Math.max(1, Math.ceil(skuPage.total / PER_PAGE)),
        hierarchy,
        duplicates,
        exceptions,
        aliases,
        filters: { query: one("q"), formulationId: one("formulation"), status },
        priceSource: config["products.priceSource"],
        discrepancies: SOURCE_DISCREPANCIES,
        lastReport: null,
      }}
      crm={{
        values,
        config,
        warnings,
        canWrite: canConfigureCrm || (isPlatformAdmin && isManager(user)),
        collections,
      }}
    />
  );
}
