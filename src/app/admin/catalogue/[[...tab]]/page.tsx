import { ADMIN, ADMIN_TABS, tabIndexOf, type TabsOf } from "@/lib/admin-routes";
import { getConfig } from "@/lib/config/store";
import {
  catalogueSummary,
  listAliases,
  listCategories,
  listDuplicates,
  listExceptions,
  listHierarchy,
  listPackItems,
  listSkus,
} from "@/lib/services/catalogue-service";
import { BOX_TYPES } from "@/lib/erp/refs";
import { SOURCE_DISCREPANCIES } from "@/db/catalogue-seed";
import { AdminPage } from "../../_shell/admin-page";
import { adminContext } from "../../_shell/context";
import { CatalogueBody } from "./catalogue-body";
import { CatalogueActions } from "./catalogue-actions";
import { editedSkuCount, editedSkuIds } from "@/lib/services/admin-data-view-service";

const PER_PAGE = 50;

/**
 * The product master. The SKU list is filtered and paged by the address, so a
 * filtered list is a screen somebody can send to somebody else.
 */
export default async function CataloguePage({
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
  const page = Math.max(1, Number(one("page") ?? 1) || 1);
  const status = one("status") ?? "all";
  const index = tabIndexOf(ADMIN_TABS.catalogue, tab?.[0]);

  const [config, summary, skuPage, hierarchy, categories, duplicates, exceptions, aliases, packItems, editedCount] = await Promise.all([
    getConfig(),
    catalogueSummary(),
    listSkus({
      query: one("q"),
      formulationId: one("formulation"),
      brandId: one("brand"),
      status: status as "all" | "ok" | "needs_canonical_id" | "inactive",
      limit: PER_PAGE,
      offset: (page - 1) * PER_PAGE,
    }),
    listHierarchy(),
    listCategories(),
    listDuplicates(),
    listExceptions(),
    listAliases(),
    listPackItems(),
    editedSkuCount(),
  ]);
  const edited = await editedSkuIds(skuPage.rows.map((r) => r.id));

  /* The canvas's tab strip: Import is the title row's button, not a tab, and
     "Held & excluded" reads as Held. Duplicates carries its count. */
  const LABEL: Record<string, string> = { skus: "SKUs", exceptions: "Held" };
  const tabItems = ADMIN_TABS.catalogue
    .filter((t) => t.slug !== "import")
    .map((t) => ({
      slug: t.slug,
      label: LABEL[t.slug] ?? t.label,
      count: t.slug === "duplicates" && summary.unresolved ? summary.unresolved : null,
    }));

  return (
    <AdminPage
      title="Catalogue"
      subtitle={"Formulation, brand, finished good and SKU. An order line attaches to a SKU and to nothing else."}
      actions={<CatalogueActions query={one("q") ?? ""} hierarchy={hierarchy} canWrite={ctx.canWriteConfig} />}
      figures={[
        { label: "SKUs", value: String(summary.skus) },
        { label: "Orderable", value: String(summary.orderable) },
        { label: "Formulations", value: String(summary.formulations) },
        { label: "Duplicates", value: String(summary.unresolved), tone: summary.unresolved ? "warn" : undefined },
        { label: "Edited here", value: String(editedCount) },
      ]}
      tabs={{
        items: tabItems,
        active: ADMIN_TABS.catalogue[index].slug,
        href: (s) => ADMIN.catalogue(s as TabsOf<"catalogue">),
      }}
    >
      <CatalogueBody
        tab={index}
        canWrite={ctx.canWriteConfig}
        data={{
          summary,
          skus: skuPage.rows,
          total: skuPage.total,
          page,
          pages: Math.max(1, Math.ceil(skuPage.total / PER_PAGE)),
          hierarchy,
          categories,
          duplicates,
          exceptions,
          aliases,
          packItems,
          boxTypes: BOX_TYPES,
          filters: { query: one("q"), formulationId: one("formulation"), brandId: one("brand"), status, open: one("open") },
          edited,
          priceSource: config["products.priceSource"],
          discrepancies: SOURCE_DISCREPANCIES,
          lastReport: null,
        }}
      />
    </AdminPage>
  );
}
