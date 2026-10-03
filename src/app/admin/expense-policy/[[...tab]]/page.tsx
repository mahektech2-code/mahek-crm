import { ADMIN, ADMIN_TABS, tabIndexOf, type TabsOf } from "@/lib/admin-routes";
import { canFor } from "@/lib/access-control";
import { today } from "@/lib/queries";
import { AdminPage } from "../../_shell/admin-page";
import { adminContext } from "../../_shell/context";
import { expensePolicyData } from "../../expense-policy-data";
import { ExpensePolicySection } from "../../expense-policy-section";

/**
 * The expense policy is shared data rather than one app's settings: MBOS
 * computes against it on the handset, the Sales Dashboard reads it to explain
 * a claim, and accounts pay on it. Writing is accounts' and admin's,
 * publishing is admin's alone — both checked again in the action.
 */
export default async function ExpensePolicyPage({
  params,
  searchParams,
}: {
  params: Promise<{ tab?: string[] }>;
  searchParams: Promise<{ policy?: string }>;
}) {
  const ctx = await adminContext();
  const [{ tab }, { policy }] = await Promise.all([params, searchParams]);
  const index = tabIndexOf(ADMIN_TABS.expensePolicy, tab?.[0]);
  const data = await expensePolicyData(
    await today(),
    policy,
    await canFor(ctx.user, "expense.policy.write"),
    await canFor(ctx.user, "expense.policy.publish"),
  );

  return (
    <AdminPage
      title="Expense policy"
      subtitle={"The travel and expense policy, as versioned rules. Every rate, limit and time of day below is typed on this screen and none of it is in code — which is the whole point of the module. A published version can never be edited: a change is a new version with its own effective date, which is what keeps an old claim worth what it was worth on the day it was made."}
      tabs={{
        items: ADMIN_TABS.expensePolicy,
        active: ADMIN_TABS.expensePolicy[index].slug,
        href: (s) => ADMIN.expensePolicy(s as TabsOf<"expensePolicy">),
      }}
    >
      <ExpensePolicySection data={data} tab={index} />
    </AdminPage>
  );
}
