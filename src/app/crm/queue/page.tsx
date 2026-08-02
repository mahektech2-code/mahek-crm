import { requireUser } from "@/lib/auth";
import { getScope, scopeLabel } from "@/lib/scope";
import {
  dayActivity,
  listQueue,
  listTargets,
  listTeam,
  today,
} from "@/lib/queries";
import { QueueScreen } from "./queue-screen";
import type { CallTarget } from "@/components/crm/call-panel";

export const metadata = { title: "Call queue — MahekOne CRM" };

export default async function QueuePage() {
  const user = await requireUser();
  const scope = await getScope(user);

  const [rows, activity, targets, team] = await Promise.all([
    listQueue(user, scope),
    dayActivity(scope === "team" ? null : user.id, today()),
    listTargets(user, scope),
    listTeam(),
  ]);

  const ownerName = new Map(team.map((t) => [t.id, t.name]));

  const gapByCustomer = new Map(targets.map((t) => [t.customerId, t.gap]));

  // Everything the call panel needs except the timeline, which it fetches when
  // it opens. Prefetching one timeline per row cost a round trip per customer
  // for panels that mostly never get opened.
  const targetsById = new Map<string, CallTarget>(
    rows.map((r) => [
      r.customer.id,
      {
        customerId: r.customer.id,
        queueItemId: r.id,
        name: r.customer.name,
        contactPerson: r.customer.contactPerson,
        phone: r.customer.phone,
        city: r.customer.city,
        ownerName: ownerName.get(r.customer.ownerId ?? "") ?? null,
        reason: r.reason,
        outstanding: r.customer.outstanding,
        lastOrderDate: r.customer.lastOrderDate,
        lastOrderValue: r.customer.lastOrderValue,
        creditTermDays: r.customer.creditTermDays,
        targetGap: gapByCustomer.get(r.customer.id) ?? 0,
        openComplaint: r.openComplaint,
      },
    ]),
  );

  return (
    <QueueScreen
      scopeLabel={scopeLabel(scope, user)}
      rows={rows.map((r) => ({
        id: r.id,
        customerId: r.customer.id,
        name: r.customer.name,
        contactPerson: r.customer.contactPerson,
        phone: r.customer.phone,
        reason: r.reason,
        worked: r.worked,
        skipped: r.skipped,
        heldBackReason: r.heldBackReason,
        outstanding: r.customer.outstanding,
        slowPayer: r.customer.slowPayer,
        lastOrderDate: r.customer.lastOrderDate,
        lastNote: r.lastNote,
        hasComplaint: Boolean(r.openComplaint),
      }))}
      callTargets={Object.fromEntries(targetsById)}
      activity={{
        connected: activity.connected,
        attempted: activity.attempted,
        missed: activity.missed,
        orders: activity.orders,
        orderValue: activity.orderValue,
        connectRate: activity.connectRate,
      }}
    />
  );
}
