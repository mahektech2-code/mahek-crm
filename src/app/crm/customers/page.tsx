import { isManager, requireUser } from "@/lib/auth";
import { getScope, scopeLabel } from "@/lib/scope";
import { listCustomersPage, listTeam } from "@/lib/queries";
import { customerStatusLabel } from "@/lib/format";
import { CustomersScreen } from "./customers-screen";

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
  const [page, team] = await Promise.all([
    listCustomersPage({
      query: one("q"),
      status: one("status"),
      owner: one("owner"),
      page: Number(one("page") ?? 1) || 1,
      perPage: [25, 50, 100].includes(perPage) ? perPage : 25,
    }),
    listTeam(),
  ]);

  return (
    <CustomersScreen
      scopeLabel={scopeLabel(scope, user)}
      isManager={isManager(user)}
      team={team.map((t) => ({ id: t.id, name: t.name }))}
      filters={{
        query: one("q") ?? "",
        status: one("status") ?? "",
        owner: one("owner") ?? "",
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
      }))}
    />
  );
}
