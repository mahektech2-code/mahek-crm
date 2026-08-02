import { isManager, requireUser } from "@/lib/auth";
import { getScope, scopeLabel } from "@/lib/scope";
import {
  dayActivity,
  getEodReport,
  openRemindersDue,
  teamDay,
  today,
} from "@/lib/queries";
import { eodLines, eodMessage } from "@/lib/eod";
import { EodScreen } from "./eod-screen";

export const metadata = { title: "EOD report — MahekOne CRM" };

export default async function EodPage() {
  const user = await requireUser();
  const scope = await getScope(user);
  const day = today();

  const [activity, due, submitted, team] = await Promise.all([
    dayActivity(user.id, day),
    openRemindersDue(user.id, day),
    getEodReport(user.id, day),
    isManager(user) ? teamDay(day) : Promise.resolve([]),
  ]);

  return (
    <EodScreen
      scopeLabel={scopeLabel(scope, user)}
      day={day}
      isManager={isManager(user)}
      lines={eodLines(activity, due.length)}
      message={eodMessage(user.name, day, activity, due.length)}
      dueReminders={due}
      submittedAt={submitted ? submitted.submittedAt.toISOString() : null}
      team={team.map((t) => ({
        name: t.user.name,
        calls: t.activity.attempted,
        connected: t.activity.connected,
        missed: t.activity.missed,
        orders: t.activity.orders,
        value: t.activity.orderValue,
        percent: t.targetPercent,
      }))}
    />
  );
}
