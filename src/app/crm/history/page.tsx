import { isManager, requireUser } from "@/lib/auth";
import { getScope, scopeLabel } from "@/lib/scope";
import { dayActivity, listInteractions, listTeam, today } from "@/lib/queries";
import { listReminders } from "@/lib/services/worklist-services";
import { nowMs } from "@/lib/format";
import { HistoryScreen } from "./history-screen";

export const metadata = { title: "Call history — MahekOne CRM" };

export default async function HistoryPage() {
  const user = await requireUser();
  const scope = await getScope(user);
  const teamView = scope === "team" && isManager(user);
  const day = await today();

  const [rows, team, activity, reminders] = await Promise.all([
    listInteractions(),
    listTeam(),
    dayActivity(teamView ? null : user.id, day),
    listReminders(),
  ]);

  return (
    <HistoryScreen
      scopeLabel={scopeLabel(scope, user)}
      isManager={isManager(user)}
      team={team.map((t) => t.name)}
      rows={rows.map((r) => ({
        id: r.id,
        occurredAt: r.occurredAt.toISOString(),
        customerId: r.customerId,
        customerName: r.customerName,
        userName: r.userName,
        channel: r.channel,
        connection: r.connection,
        outcome: r.outcome,
        note: r.note,
        produced: r.produced,
      }))}
      openCommitments={reminders
        .filter((r) => r.status === "pending")
        .map((r) => ({
          customerId: r.customerId,
          note: r.note,
          dueDate: r.dueDate,
        }))}
      nowMs={nowMs()}
      activity={{
        attempted: activity.callsAttempted,
        connected: activity.callsConnected,
        missed: activity.callsMissed,
        connectRate: activity.connectRate,
        messagesSent: activity.whatsappSent,
      }}
    />
  );
}
