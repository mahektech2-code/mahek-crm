import { can, requireCapability } from "@/lib/access-control";
import { getScope, scopeLabel } from "@/lib/scope";
import { requireUser } from "@/lib/auth";
import { currentPeriod, listAmFilterOptions } from "@/lib/queries";
import { listTargetsPage, shortfallAnalysis } from "@/lib/services/worklist-services";
import { MonthlyTargetsScreen } from "@/components/customers/monthly-targets-screen";

export const metadata = { title: "Customer targets — Accounts — MahekOne" };

/**
 * Monthly targets, on the Accounts side.
 *
 * The SAME reads and the SAME actions the CRM's own targets screen uses —
 * `listTargets`, `setTarget`, `setTargetsBulk`, `shortfallAnalysis` — because
 * this is not a second target system, it is `/crm/targets` reached from a
 * second door. Accounts hold `apps: ["accounts"]` and are redirected out of
 * the CRM before they reach it, the same way `src/app/crm/layout.tsx`
 * redirects them out before they reach a customer record — without this page
 * the capability granted in `lib/access-control.ts` would belong to people
 * who had nowhere to use it.
 *
 * Kept as its OWN module and route rather than a third tab on the Accounts
 * "Sales targets" screen: that screen is the five-figure KPI target set on a
 * PERSON; this one is a rupee quota set on a CUSTOMER. Folding a customer
 * grain and a person grain into one screen with tabs would answer "what is
 * this person's target" and "what is this customer's target" from the same
 * page without ever saying which question a given tab was answering.
 *
 * `target.set` is checked HERE as well as in every action it guards. The
 * action is the rule — a server action is a URL and a hidden button is not a
 * permission — but a screen that renders and then refuses every save is worse
 * than one that is simply not there.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireCapability("target.set");

  const params = await searchParams;
  const one = (k: string) => {
    const v = params[k];
    const s = Array.isArray(v) ? v[0] : v;
    return s && s.trim() ? s.trim() : undefined;
  };

  const user = await requireUser();
  const scope = await getScope(user);
  const activePeriod = one("period") ?? (await currentPeriod());

  const canSet = can(user.role, "target.set");
  const perPage = Number(one("per") ?? 25);
  const [page, amOptions] = await Promise.all([
    listTargetsPage(activePeriod, {
      query: one("q"),
      status: one("status"),
      salesAm: one("sales"),
      salesManager: one("salesmanager"),
      backOfficeAm: one("backoffice"),
      page: Number(one("page") ?? 1) || 1,
      perPage: [25, 50, 100].includes(perPage) ? perPage : 25,
    }),
    listAmFilterOptions(),
  ]);
  const shortfall = can(user.role, "target.shortfall")
    ? await shortfallAnalysis(activePeriod)
    : null;

  return (
    <MonthlyTargetsScreen
      app="accounts"
      basePath="/accounts/customer-targets"
      customerHrefTemplate="/accounts/ledger?customer={id}"
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
