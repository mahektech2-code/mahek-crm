import { requireUser } from "@/lib/auth";
import { canFor } from "@/lib/access-control";
import { getScope, scopeLabel } from "@/lib/scope";
import { currentPeriod, listAmFilterOptions } from "@/lib/queries";
import { listTargetsPage, shortfallAnalysis } from "@/lib/services/worklist-services";
import { MonthlyTargetsScreen } from "@/components/customers/monthly-targets-screen";

export const metadata = { title: "Monthly targets - MahekOne CRM" };

/**
 * Filters and the page live in the URL, the same as the customers list —
 * so the list is filtered and counted in Postgres, and a manager's whole
 * team is not sent over the wire to show twenty-five of it.
 */
export default async function TargetsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const one = (k: string) => {
    const v = params[k];
    const s = Array.isArray(v) ? v[0] : v;
    return s && s.trim() ? s.trim() : undefined;
  };

  const user = await requireUser();
  const scope = await getScope(user);
  const activePeriod = one("period") ?? (await currentPeriod());

  const canSet = await canFor(user, "target.set");
  const perPage = Number(one("per") ?? 25);
  const [page, amOptions] = await Promise.all([
    listTargetsPage(activePeriod, {
      query: one("q"),
      status: one("status"),
      salesAm: one("sales"),
      salesManager: one("salesmanager"),
      backOfficeAm: one("backoffice"),
      sort: one("sort"),
      page: Number(one("page") ?? 1) || 1,
      perPage: [25, 50, 100].includes(perPage) ? perPage : 25,
    }),
    // The SAME names the Customers filter offers — read from the columns
    // the sheet actually fills, most of whom have no MahekOne account.
    listAmFilterOptions(),
  ]);
  // Coverage gap or customer gap. Held by anybody who works a book — it is
  // the read that tells a telecaller which half of a bad month is hers to
  // fix — and narrowed to her own customers by `targetVisibilityClause`, one
  // layer down. Null only where somebody genuinely does not hold it, and the
  // screen then says so rather than drawing two empty groups.
  const shortfall = await canFor(user, "target.shortfall")
    ? await shortfallAnalysis(activePeriod, {
        // The SAME four answers the table above is narrowed by, and the same
        // search box. Read from the URL once and handed to both, so the tab a
        // manager switches to cannot be describing a different set of people
        // from the one they were just looking at.
        query: one("q"),
        status: one("status"),
        salesAm: one("sales"),
        salesManager: one("salesmanager"),
        backOfficeAm: one("backoffice"),
      })
    : null;

  return (
    <MonthlyTargetsScreen
      app="crm"
      basePath="/crm/targets"
      customerHrefTemplate="/crm/customers/{id}"
      scopeLabel={scopeLabel(scope, user)}
      canSet={canSet}
      period={activePeriod}
      rows={page.rows}
      shortfall={shortfall}
      filters={{
        query: one("q") ?? "",
        status: one("status") ?? "",
        salesAm: one("sales") ?? "",
        salesManager: one("salesmanager") ?? "",
        backOfficeAm: one("backoffice") ?? "",
        sort: one("sort") ?? "",
        perPage: [25, 50, 100].includes(perPage) ? perPage : 25,
      }}
      pageInfo={{
        page: page.page,
        pageCount: page.pageCount,
        total: page.total,
        bookTotal: page.bookTotal,
      }}
      totals={page.totals}
      amOptions={amOptions}
    />
  );
}
