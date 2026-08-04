import { requireUser } from "@/lib/auth";
import { getScope, scopeLabel } from "@/lib/scope";
import { dayActivity, today } from "@/lib/queries";
import { getConfig } from "@/lib/config/store";
import { listActiveProducts } from "@/db/seed-catalogue";
import { db } from "@/db";
import { helpArticles, quickNotes as quickNotesTable } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getQueue } from "@/lib/services/queue-service";
import { QueueScreen } from "./queue-screen";
import type { CallTarget } from "@/components/crm/call-panel";

export const metadata = { title: "Call Log — MahekOne CRM" };

export default async function QueuePage() {
  const user = await requireUser();
  const scope = await getScope(user);

  const day = await today();
  const [queue, activity, config] = await Promise.all([
    getQueue(),
    dayActivity(scope === "team" ? null : user.id, day),
    getConfig(),
  ]);

  // The panel needs the whole catalogue up front: a telecaller mid-call should
  // never wait on a round trip to pick a product or a quick note.
  const [quickNoteRows, productRows, scriptRows] = await Promise.all([
    db.select().from(quickNotesTable).where(eq(quickNotesTable.active, true)),
    listActiveProducts(),
    // Call scripts live in the help centre, so there is one place they are
    // written and the panel simply shows the relevant one.
    db.select().from(helpArticles).where(eq(helpArticles.type, "call_script")),
  ]);
  const quickNoteOptions = quickNoteRows.map((n) => ({
    id: n.id,
    interactionType: n.interactionType,
    outcome: n.outcome,
    label: n.label,
  }));
  const productOptions = productRows.map((p) => ({
    id: p.id,
    name: p.name,
    packSize: p.packSize,
  }));

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
        reasonKind: r.reasons[0]?.kind,
        kind: r.kind,
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
        kind: r.kind,
        slowPayer: r.slowPayer,
        lastOrderDate: r.lastOrderDate,
        lastNote: r.lastNote,
        hasComplaint: Boolean(r.openComplaint),
      }))}
      // Suppression is shown, never silently applied — a telecaller has to be
      // able to see why somebody they expected is not on the list.
      suppressed={queue.suppressed}
      progress={queue.progress}
      carriedOver={queue.carriedOver}
      snapshotHour={queue.snapshotHour}
      callTargets={callTargets}
      categories={config["complaints.categories"].map((c) => ({
        value: c
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_|_$/g, ""),
        label: c,
      }))}
      quickNotes={quickNoteOptions}
      products={productOptions}
      scripts={scriptRows.map((a) => ({
        id: a.id,
        title: a.title,
        body: a.scriptBody ?? a.body,
        guidance: a.scriptBody ? a.body : "",
        outcome: null,
      }))}
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
