import { requireUser } from "@/lib/auth";
import { canFor } from "@/lib/access-control";
import { getScope, scopeLabel, managesHere } from "@/lib/scope";
import { dayActivity, listInteractions, listTeam, today } from "@/lib/queries";
import { pendingRemindersFor } from "@/lib/services/worklist-services";
import { nowMs } from "@/lib/format";
import { HistoryScreen } from "./history-screen";

export const metadata = { title: "Call history - MahekOne CRM" };

/**
 * How many calls one read of the history may carry.
 *
 * Passed IN rather than left to `listInteractions`' own default, so the number
 * the query uses and the number the screen says out loud are one value. The
 * screen had been printing the length of what arrived and calling it the count
 * of interactions — "400 interactions" on a book of twelve thousand calls, with
 * a range filter offering "All time" over it.
 */
const CALL_HISTORY_LIMIT = 400;

export default async function HistoryPage() {
  const user = await requireUser();
  /* A manager OF THE CRM — `isManager` was the widest level held in any app. */
  const managerHere = await managesHere(user, "crm");
  const scope = await getScope(user);
  const teamView = scope === "team" && managerHere;
  const day = await today();

  const [rows, team, activity] = await Promise.all([
    listInteractions(CALL_HISTORY_LIMIT),
    listTeam(),
    dayActivity(teamView ? null : user.id, day),
  ]);
  /* Only the customers on this page — the whole book's reminders used to be
     read, with a queue check per future one, to draw a note beside 400 rows. */
  const commitments = await pendingRemindersFor(rows.map((r) => r.customerId));

  return (
    <HistoryScreen
      scopeLabel={scopeLabel(scope, user)}
      canExport={await canFor(user, "customer.export")}
      team={team.map((t) => t.name)}
      /* A full page is a page that was cut off. There is no `count(*)` behind
         this yet — `listInteractions` returns rows and nothing else — so the
         screen says what it HAS rather than inventing a total out of it. */
      capped={rows.length >= CALL_HISTORY_LIMIT}
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
        nextStep: r.nextStep,
        detail: r.detail,
      }))}
      openCommitments={commitments.map((c) => ({ ...c, note: c.note ?? "" }))}
      nowMs={nowMs()}
      today={day}
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
