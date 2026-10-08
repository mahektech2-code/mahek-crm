import { ADMIN, ADMIN_TABS, tabIndexOf, type TabsOf } from "@/lib/admin-routes";
import { getConfig } from "@/lib/config/store";
import {
  catalogueSummary,
  listAliases,
  listCategories,
  listDuplicates,
  listExceptions,
  listHierarchy,
  listSkus,
} from "@/lib/services/catalogue-service";
import { SOURCE_DISCREPANCIES } from "@/db/catalogue-seed";
import { AdminPage } from "../../_shell/admin-page";
import { adminContext } from "../../_shell/context";
import { CatalogueBody } from "./catalogue-body";

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

  const [config, summary, skuPage, hierarchy, categories, duplicates, exceptions, aliases] = await Promise.all([
    getConfig(),
    catalogueSummary(),
    listSkus({
      query: one("q"),
      formulationId: one("formulation"),
      status: status as "all" | "ok" | "needs_canonical_id" | "inactive",
      limit: PER_PAGE,
      offset: (page - 1) * PER_PAGE,
    }),
    listHierarchy(),
    listCategories(),
    listDuplicates(),
    listExceptions(),
    listAliases(),
  ]);

  return (
    <AdminPage
      title="Catalogue"
      subtitle={"Formulation, brand, finished good and SKU. An order line attaches to a SKU and to nothing else."}
      tabs={{
        items: ADMIN_TABS.catalogue,
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
          filters: { query: one("q"), formulationId: one("formulation"), status },
          priceSource: config["products.priceSource"],
          discrepancies: SOURCE_DISCREPANCIES,
          lastReport: null,
        }}
      />
    </AdminPage>
  );
}
