import { isManager, requireUser } from "@/lib/auth";
import { canFor } from "@/lib/access-control";
import { getScope, scopeLabel } from "@/lib/scope";
import { listCustomers } from "@/lib/queries";
import { listReminders } from "@/lib/services/worklist-services";
import { RemindersScreen } from "./reminders-screen";

export const metadata = { title: "Reminders - MahekOne CRM" };

export default async function RemindersPage() {
  const user = await requireUser();
  const scope = await getScope(user);

  const [rows, customers, canClose] = await Promise.all([
    listReminders(),
    listCustomers(),
    /*
     * WHO MAY CLOSE ONE BY HAND — the capability, never the role.
     *
     * A promise is closed by the evidence that it was kept: the call, the
     * order, the confirmed receipt. What is left for a person is the handful
     * of cases evidence cannot reach, and `reminder.close` is where that is
     * decided — granted with the CRM manager hat on the Access screen today,
     * moveable to another set in `access-control.ts` tomorrow without this
     * file or the screen below knowing. `isManager` beside it is about the
     * team view and is a different question.
     */
    canFor(user, "reminder.close"),
  ]);

  return (
    <RemindersScreen
      scopeLabel={scopeLabel(scope, user)}
      isTeamView={scope === "team" && isManager(user)}
      canClose={canClose}
      rows={rows}
      customers={customers.map((c) => ({ id: c.id, name: c.name }))}
    />
  );
}
