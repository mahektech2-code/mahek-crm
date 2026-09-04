import { isManager, requireUser } from "@/lib/auth";
import { getScope, scopeLabel } from "@/lib/scope";
import { customerStatusLabel } from "@/lib/format";
import { can } from "@/lib/access-control";
import { getConfig } from "@/lib/config/store";
import {
  listAmFilterOptions,
  listAssignableUsers,
  listBackOfficeCandidates,
  listCustomersPage,
  salesManagerSuggestions,
  today,
} from "@/lib/queries";
import { accountTypeParam } from "@/lib/account-types";
import { CustomersScreen } from "@/components/customers/customers-screen";

export const metadata = { title: "Customers — Accounts — MahekOne" };

/**
 * The customer book on the accounts side — the SAME screen the CRM renders.
 *
 * It was briefly its own, thinner component, and that showed within a day: a
 * different search box, six columns instead of twelve, no status filter, no
 * totals, no row menu and no way to open anything. Two screens answering "who
 * are our customers" drift, and the thin one is always the one somebody is
 * looking at when they conclude the data is wrong.
 *
 * One component, one query, and a prop naming the few things that genuinely
 * differ — an accounts user holds `apps: ["accounts"]`, so `/crm/...` links
 * are doors they are redirected away from.
 *
 * Why it exists here at all: changing an account manager is accounts' and
 * admin's, and `src/app/crm/layout.tsx` redirects an accounts user out of the
 * CRM before they reach a customer. Without this page the permission would
 * belong to people who could not use it.
 */
export default async function Page({
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
  // The SERVER's working day, for the Next call column — a client component
  // may not read the clock in render, and a laptop set to the wrong date must
  // not change which dates read as past.
  const day = await today();
  const perPage = Number(one("per") ?? 25);

  const [page, team, config, backOfficePeople, amOptions, salesManagerSuggested] =
    await Promise.all([
      listCustomersPage({
        query: one("q"),
        status: one("status"),
        salesAm: one("sales"),
        salesManager: one("salesmanager"),
        backOfficeAm: one("backoffice"),
        // "yes" / "no" / "delivered" — the third is the evidence filter, and
        // the one the conversion work is actually done from. Validated rather
        // than cast: `?party=nonsense` is a typed value the query would carry
        // into a clause that matches nothing, and an empty list reads as a
        // lost book.
        thirdParty: accountTypeParam(one("party")),
        sort: one("sort"),
        page: Number(one("page") ?? 1) || 1,
        perPage: [25, 50, 100].includes(perPage) ? perPage : 25,
      }),
      listAssignableUsers(),
      getConfig(),
      listBackOfficeCandidates(),
      listAmFilterOptions(),
      salesManagerSuggestions(),
    ]);

  return (
    <CustomersScreen
      app="accounts"
      scopeLabel={scopeLabel(scope, user)}
      isManager={isManager(user)}
      // The same question the action asks, so the button and the permission
      // cannot disagree. The action checks again regardless — a disabled
      // control is not a permission.
      canClassify={can(user.role, "customer.classify")}
      canReassign={can(user.role, "customer.reassign")}
      // A different question, and a more generous answer: the sales manager
      // seat drives no queue, no scope and no target, so a manager may set it
      // while the two beside it stay accounts' and admin's.
      canAssignSalesManager={can(user.role, "customer.assignSalesManager")}
      amReasons={config["people.amChangeReasons"]}
      amSearchThreshold={config["people.pickerSearchThreshold"]}
      amOptions={amOptions}
      team={team.map((t) => ({ id: t.id, name: t.name, role: t.role }))}
      backOfficePeople={backOfficePeople}
      // The same list — this seat needs no login either, and several of the
      // people running a sales line here have never signed in.
      salesManagerPeople={backOfficePeople}
      salesManagerSuggestions={salesManagerSuggested}
      filters={{
        query: one("q") ?? "",
        status: one("status") ?? "",
        salesAm: one("sales") ?? "",
        salesManager: one("salesmanager") ?? "",
        backOfficeAm: one("backoffice") ?? "",
        // The validated codes straight through — `,`-separated for more than
        // one. The screen turns codes back into the control's own words.
        accountType: accountTypeParam(one("party")) ?? "",
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
      todayIso={day}
      rows={page.rows.map((c) => ({
        id: c.id,
        name: c.name,
        contactPerson: c.contactPerson,
        phone: c.phone,
        city: c.city,
        ownerId: c.ownerId,
        // Whose book it is, which is not the owner — the shared screen binds
        // its sales field to this.
        salesAmId: c.salesAmId,
        salesManagerId: c.salesManagerId,
        amDecidedAt: c.amDecidedAt,
        ownerName: c.ownerName,
        kind: c.kind,
        leadSource: c.leadSource,
        salesAmName: c.salesAmName,
        salesManagerName: c.salesManagerName,
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
        nextStep: c.nextStep,
        reactivationRequested: c.reactivationRequested,
        reactivationReason: c.reactivationReason,
      }))}
    />
  );
}
