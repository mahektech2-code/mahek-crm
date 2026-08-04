import { requireUser } from "@/lib/auth";
import { getScope, scopeLabel } from "@/lib/scope";
import { dayActivity, today } from "@/lib/queries";
import { getConfig } from "@/lib/config/store";
import { getQueue } from "@/lib/services/queue-service";
import { QueueScreen } from "./queue-screen";
import type { CallTarget } from "@/components/crm/call-panel";

export const metadata = { title: "Call queue — MahekOne CRM" };

export default async function QueuePage() {
  const user = await requireUser();
  const scope = await getScope(user);

  const day = await today();
  const [queue, activity, config] = await Promise.all([
    getQueue(),
    dayActivity(scope === "team" ? null : user.id, day),
    getConfig(),
  ]);

  // Everything the call panel needs except the timeline, which it fetches when
  // it opens. Prefetching one timeline per row cost a round trip per customer
  // for panels that mostly never get opened.
  const callTargets: Record<string, CallTarget> = Object.fromEntries(
    queue.entries.map((r) => [
      r.customerId,
      {
        customerId: r.customerId,
        sourceModule: "call_queue",
        name: r.name,
        contactPerson: r.contactPerson,
        phone: r.phone,
        city: r.city,
        ownerName: r.ownerName,
        reason: r.reasons[0]?.label,
        outstanding: r.outstanding,
        lastOrderDate: r.lastOrderDate,
        lastOrderValue: r.lastOrderValue,
        creditTermDays: r.creditTermDays,
        targetGap: r.targetGap,
        openComplaint: r.openComplaint,
      } satisfies CallTarget,
    ]),
  );

  return (
    <QueueScreen
      scopeLabel={scopeLabel(scope, user)}
      rows={queue.entries.map((r) => ({
        customerId: r.customerId,
        name: r.name,
        contactPerson: r.contactPerson,
        phone: r.phone,
        score: r.score,
        reasons: r.reasons,
        daysSinceContact: r.daysSinceContact,
        outstanding: r.outstanding,
        slowPayer: r.slowPayer,
        lastOrderDate: r.lastOrderDate,
        lastNote: r.lastNote,
        hasComplaint: Boolean(r.openComplaint),
      }))}
      // Suppression is shown, never silently applied — a telecaller has to be
      // able to see why somebody they expected is not on the list.
      suppressed={queue.suppressed}
      progress={queue.progress}
      callTargets={callTargets}
      categories={config["complaints.categories"]}
      activity={{
        connected: activity.callsConnected,
        attempted: activity.callsAttempted,
        missed: activity.callsMissed,
        orders: activity.ordersCount,
        orderValue: activity.ordersValue,
        connectRate: activity.connectRate,
      }}
    />
  );
}
