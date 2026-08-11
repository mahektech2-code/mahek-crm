import { requireUser } from "@/lib/auth";
import { can } from "@/lib/access-control";
import { getConfig } from "@/lib/config/store";
import {
  listAssignableUsers,
  listBackOfficeCandidates,
  listCustomersPage,
} from "@/lib/queries";
import { AccountsCustomersScreen } from "./accounts-customers-screen";

export const metadata = { title: "Customers — Accounts — MahekOne" };

/**
 * The same query the CRM's customer list runs.
 *
 * Deliberately `listCustomersPage()` and not a second read: a number on one
 * screen and the same number on another have to come from one function, or
 * they drift and whoever notices stops trusting both. Filters live in the
 * address for the same reason they do on the CRM list — a filtered book is
 * something people send each other.
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
  const perPage = Number(one("per") ?? 25);

  const [page, team, config, backOfficePeople] = await Promise.all([
    listCustomersPage({
      query: one("q"),
      owner: one("owner"),
      page: Number(one("page") ?? 1) || 1,
      perPage: [25, 50, 100].includes(perPage) ? perPage : 25,
    }),
    listAssignableUsers(),
    getConfig(),
    listBackOfficeCandidates(),
  ]);

  return (
    <AccountsCustomersScreen
      rows={page.rows.map((r) => ({
        id: r.id,
        name: r.name,
        city: r.city,
        status: r.status,
        outstanding: r.outstanding,
        ownerName: r.ownerName,
        salesAmName: r.salesAmName,
        backOfficeAmName: r.backOfficeAmName,
      }))}
      team={team.map((t) => ({ id: t.id, name: t.name, role: t.role }))}
      backOfficePeople={backOfficePeople}
      // The same question the action asks, so the button and the permission
      // cannot disagree. The action checks again regardless — a disabled
      // control is not a permission.
      canReassign={can(user.role, "customer.reassign")}
      amReasons={config["people.amChangeReasons"]}
      amSearchThreshold={config["people.pickerSearchThreshold"]}
      filters={{
        query: one("q") ?? "",
        owner: one("owner") ?? "",
        perPage: [25, 50, 100].includes(perPage) ? perPage : 25,
      }}
      pageInfo={{ page: Number(one("page") ?? 1) || 1, total: page.total }}
    />
  );
}
