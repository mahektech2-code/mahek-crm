import { isManager, requireUser } from "@/lib/auth";
import { can } from "@/lib/access-control";
import { getConfig } from "@/lib/config/store";
import { getScope, scopeLabel } from "@/lib/scope";
import {
  listAmFilterOptions,
  listAssignableUsers,
  listBackOfficeCandidates,
  listCustomersPage,
} from "@/lib/queries";
import { customerStatusLabel } from "@/lib/format";
import {
  accountTypeFilterLabel,
  accountTypeParam,
} from "@/lib/account-types";
import { CustomersScreen } from "@/components/customers/customers-screen";

export const metadata = { title: "Customers - MahekOne CRM" };

/**
 * Filters and the page live in the URL rather than in component state.
 *
 * The list is filtered and counted in Postgres now, so the server has to be
 * told what to fetch — and once it is in the address, a telecaller can send
 * somebody "the slow payers in Nashik" as a link, and the back button walks
 * back through what they were looking at instead of dropping them at the top
 * of an unfiltered book.
 */
export default async function CustomersPage({
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

  const perPage = Number(one("per") ?? 25);
  const [page, team, config, backOfficePeople, amOptions] = await Promise.all([
    listCustomersPage({
      query: one("q"),
      status: one("status"),
      salesAm: one("sales"),
      backOfficeAm: one("backoffice"),
      // "yes" / "no" / "delivered" — the third is the evidence filter, and the
      // one the conversion work is actually done from. Validated rather than
      // cast: `?party=nonsense` is a typed value the query would carry into a
      // clause that matches nothing, and an empty list reads as a lost book.
      thirdParty: accountTypeParam(one("party")),
      page: Number(one("page") ?? 1) || 1,
      perPage: [25, 50, 100].includes(perPage) ? perPage : 25,
    }),
    // The staff list, NOT the reader's scope — see `listAssignableUsers`.
    // Built from `listTeam()` this offered an admin on My book exactly one
    // person: themselves.
    listAssignableUsers(),
    getConfig(),
    listBackOfficeCandidates(),
    listAmFilterOptions(),
  ]);

  return (
    <CustomersScreen
      app="crm"
      scopeLabel={scopeLabel(scope, user)}
      isManager={isManager(user)}
      // Asked of the same function the action asks, so a visible button and a
      // permitted action can never disagree. The action checks again anyway —
      // a disabled control is not a permission.
      canClassify={can(user.role, "customer.classify")}
      canReassign={can(user.role, "customer.reassign")}
      amReasons={config["people.amChangeReasons"]}
      amSearchThreshold={config["people.pickerSearchThreshold"]}
      amOptions={amOptions}
      team={team.map((t) => ({ id: t.id, name: t.name, role: t.role }))}
      backOfficePeople={backOfficePeople}
      filters={{
        query: one("q") ?? "",
        status: one("status") ?? "",
        salesAm: one("sales") ?? "",
        backOfficeAm: one("backoffice") ?? "",
        // The filter's own word for what `?party=` holds, so the control shows
        // what was actually applied rather than resetting itself to "All".
        accountType: accountTypeFilterLabel(one("party")),
        perPage: [25, 50, 100].includes(perPage) ? perPage : 25,
      }}
      pageInfo={{
        page: page.page,
        pageCount: page.pageCount,
        total: page.total,
        bookTotal: page.bookTotal,
      }}
      totals={page.totals}
      rows={page.rows.map((c) => ({
        id: c.id,
        name: c.name,
        contactPerson: c.contactPerson,
        phone: c.phone,
        city: c.city,
        ownerId: c.ownerId,
        salesAmId: c.salesAmId,
        ownerName: c.ownerName,
        kind: c.kind,
        leadSource: c.leadSource,
        salesAmName: c.salesAmName,
        backOfficeAmId: c.backOfficeAmId,
        backOfficeAmName: c.backOfficeAmName,
        status: customerStatusLabel(c),
        lastOrderDate: c.lastOrderDate,
        lastContactAt: c.lastContactDate,
        outstanding: c.outstanding,
        slowPayer: c.slowPayer,
        openComplaints: c.openComplaints,
        gstin: c.gstin,
        creditTermDays: c.creditTermDays,
        cycleDays: c.cycleDays,
        route: c.route,
        deactivationRequested: c.deactivationRequested,
        thirdParty: c.thirdParty,
        deliveredOrders: c.deliveredOrders,
        servedShops: c.servedShops,
        reactivationRequested: c.reactivationRequested,
        reactivationReason: c.reactivationReason,
      }))}
    />
  );
}
