import { requireUser } from "@/lib/auth";
import { getScope, scopeLabel } from "@/lib/scope";
import { dayActivity, today } from "@/lib/queries";
import { getConfig } from "@/lib/config/store";
import { popularProducts } from "@/lib/services/product-service";
import { db } from "@/db";
import { helpArticles, quickNotes as quickNotesTable } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getQueue } from "@/lib/services/queue-service";
import { QueueScreen } from "./queue-screen";
import type { CallTarget } from "@/components/crm/call-panel";

export const metadata = { title: "Call Log - MahekOne CRM" };

export default async function QueuePage() {
  const user = await requireUser();
  const scope = await getScope(user);

  const day = await today();
  const [queue, activity, config] = await Promise.all([
    getQueue(),
    dayActivity(scope === "team" ? null : user.id, day),
    getConfig(),
  ]);

  // Quick notes come up front — there are a few dozen and a telecaller
  // mid-call should never wait on a round trip for a chip.
  //
  // Products do NOT. The catalogue runs to two hundred SKUs, so shipping it
  // would be a payload on every page load and a list nobody can read. What
  // comes up front is the handful worth offering unprompted; everything else
  // is the search box, which reaches the formulation and the brand as well as
  // the name.
  const [quickNoteRows, productRows, scriptRows] = await Promise.all([
    db.select().from(quickNotesTable).where(eq(quickNotesTable.active, true)),
    popularProducts(),
    // Call scripts live in the help centre, so there is one place they are
    // written and the panel simply shows the relevant one.
    db
      .select()
      .from(helpArticles)
      .where(eq(helpArticles.type, "call_script"))
      // Ordered, or which script greets the telecaller is whatever the
      // planner happened to return first.
      .orderBy(helpArticles.title),
  ]);
  const quickNoteOptions = quickNoteRows.map((n) => ({
    id: n.id,
    interactionType: n.interactionType,
    outcome: n.outcome,
    label: n.label,
  }));
  const productOptions = productRows.map((p) => ({
    id: p.productId,
    name: p.name,
    packSize: p.packSize,
    subtitle: p.subtitle,
    millilitresPerCan: p.millilitresPerCan,
    cansPerBox: p.cansPerBox,
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
      // On a team list a row is somebody else's call, and a manager reading it
      // has to know whose. On their own book every row is theirs, so naming a
      // person on each one is a column of the same word repeated.
      showAssignee={scope === "team"}
      rows={queue.entries.map((r) => ({
        customerId: r.customerId,
        name: r.name,
        assignedToName: r.assignedToName,
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
      singleSelectOutcomes={config["interactions.singleSelectOutcomes"]}
      maxComplaintImages={config["attachments.maxPerComplaint"]}
      searchEnabled={config["products.searchOnOrderForms"]}
      searchMinChars={config["products.searchMinChars"]}
      userName={user.name}
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
        // What the telecaller took today, whatever accounts have decided.
        orders: activity.ordersCaptured,
        orderValue: activity.ordersValue,
        connectRate: activity.connectRate,
      }}
    />
  );
}
