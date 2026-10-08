import { AdminPage } from "../../_shell/admin-page";
import { adminContext } from "../../_shell/context";
import { PolicyView } from "@/components/expenses/policy-view";

/**
 * The expense policy, read-only.
 *
 * It used to be a rule builder — versions, drafts, grades, city classes, a
 * simulator and a publish step across five tabs — and it was too much to use,
 * so nothing was ever published. The policy is hard-coded now
 * (`lib/expense-policy-standard.ts`) and this page says what it is. The old
 * tab addresses (`/rules`, `/versions`, …) still land here.
 */
export default async function ExpensePolicyPage() {
  await adminContext();
  return (
    <AdminPage
      title="Expense policy"
      subtitle="What the field is paid back for travel, meals, hotels and bills. One policy for everybody."
    >
      <PolicyView />
    </AdminPage>
  );
}
