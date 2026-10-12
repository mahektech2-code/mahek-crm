import { requireUser } from "@/lib/auth";
import { canFor } from "@/lib/access-control";
import { getScope, scopeLabel, managesHere } from "@/lib/scope";
import { listReminders } from "@/lib/services/worklist-services";
import { RemindersScreen } from "./reminders-screen";

export const metadata = { title: "Reminders - MahekOne CRM" };

/** How far back the Done tab reaches. Older ones live on the customer's timeline. */
const CLOSED_WITHIN_DAYS = 60;

export default async function RemindersPage() {
  const user = await requireUser();
  /* A manager OF THE CRM — `isManager` was the widest level held in any app. */
  const managerHere = await managesHere(user, "crm");
  const scope = await getScope(user);

  const [rows, canClose] = await Promise.all([
    listReminders(undefined, { closedWithinDays: CLOSED_WITHIN_DAYS }),
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
      isTeamView={scope === "team" && managerHere}
      canClose={canClose}
      rows={rows}
      closedWithinDays={CLOSED_WITHIN_DAYS}
    />
  );
}
