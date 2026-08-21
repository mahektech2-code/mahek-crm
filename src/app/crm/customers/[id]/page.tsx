import { notFound } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { orders, payments } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import {
  assertCustomerInScope,
  NotPermittedError,
} from "@/lib/access-control";
import {
  currentPeriod,
  customerMessages,
  customerTimeline,
  getCustomer,
  listAmChanges,
  today,
} from "@/lib/queries";
import { getFollowUpDetail } from "@/lib/services/payment-service";
import { getConfig } from "@/lib/config/store";
import { popularProducts } from "@/lib/services/product-service";
import { quickNotes as quickNotesTable } from "@/db/schema";
import { listTargets } from "@/lib/services/worklist-services";
import { customerStatusLabel, daysBetween } from "@/lib/format";
import { addDays, calendarDate } from "@/lib/business-date";
import { RecordScreen } from "./record-screen";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const customer = await getCustomer(id);
  return { title: `${customer?.name ?? "Customer"} - MahekOne CRM` };
}

export default async function CustomerRecordPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireUser();

  const customer = await getCustomer(id);
  if (!customer) notFound();

  /*
   * A record this person may not read is ABSENT to them, never a crash.
   *
   * The check is made here rather than left to fire from inside one of the
   * parallel queries below, where a refusal is an uncaught throw in a server
   * component — which renders as "This page couldn't load. A server error
   * occurred." Every link into this page, from the queue, the reminders, the
   * bills and global search, produced that instead of a 404, so a permission
   * boundary working exactly as designed read as a broken application.
   */
  try {
    await assertCustomerInScope(customer);
  } catch (e) {
    if (e instanceof NotPermittedError) notFound();
    throw e;
  }

  const day = await today();
  const period = await currentPeriod();

  const [config, timeline, messages, targets, followUp, stats] = await Promise.all([
    getConfig(),
    customerTimeline(id),
    customerMessages(id),
    listTargets(period),
    getFollowUpDetail(id),
    // Order count, month-to-date value and how long they actually take to pay,
    // in one round trip.
    db
      .select({
        orders6m: sql<number>`(
          select count(*)::int from ${orders} o
           where o.customer_id = ${id} and o.status <> 'cancelled'
             and o.ordered_at >= now() - interval '6 months'
        )`,
        thisMonth: sql<number>`coalesce((
          select sum(o.total_amount) from ${orders} o
           where o.customer_id = ${id} and o.status <> 'cancelled'
             and o.ordered_at >= date_trunc('month', current_date)
        ), 0)`,
        paysInDays: sql<number>`coalesce((
          select round(avg(p.paid_at - b.bill_date))::int
            from ${payments} p join bills b on b.id = p.bill_id
           where p.customer_id = ${id}
        ), 0)`,
      })
      .from(orders)
      .where(and(eq(orders.customerId, id)))
      .limit(1)
      .then((r) => r[0]),
  ]);

  const [quickNoteRows, productRows, amChanges] = await Promise.all([
    db.select().from(quickNotesTable).where(eq(quickNotesTable.active, true)),
    popularProducts(),
    listAmChanges(id),
  ]);

  const target = targets.find((t) => t.customerId === id);
  const totalTarget = targets.reduce((a, t) => a + t.target, 0);

  const openComplaint = timeline.find(
    (t) => t.kind === "Complaint" && !t.meta?.includes("resolved"),
  );

  // The latest dated promise from the follow-up attempt log.
  const promise = followUp?.attempts.find((a) => a.promisedDate);

  const bills = followUp?.bills ?? [];
  const overdue = bills.filter((b) => b.balance > 0 && b.overdueDays > 0);

  return (
    <RecordScreen
      amChanges={amChanges}
      customer={{
        id: customer.id,
        name: customer.name,
        contactPerson: customer.contactPerson,
        phone: customer.phone,
        city: customer.city,
        ownerName: customer.ownerName,
        kind: customer.kind,
        leadSource: customer.leadSource,
        createdAt: calendarDate(customer.createdAt),
        salesAmName: customer.salesAmName,
        salesManagerName: customer.salesManagerName,
        backOfficeAmName: customer.backOfficeAmName,
        status: customerStatusLabel(customer),
        slowPayer: customer.slowPayer,
        outstanding: customer.outstanding,
        lastOrderDate: customer.lastOrderDate,
        lastOrderValue: customer.lastOrderValue,
        cycleDays: customer.cycleDays,
        cycleIsDefault: customer.cycleIsDefault,
        cycleConfidence: customer.cycleConfidence,
        /*
         * Last order + the cycle. Computed here rather than stored: it is two
         * columns and an addition, and a stored copy would be one more thing
         * to keep in step every time either half moves.
         */
        expectedOrderDate:
          customer.lastOrderDate && !customer.cycleIsDefault
            ? addDays(customer.lastOrderDate, customer.cycleDays)
            : null,
        avgOrderValue: customer.avgOrderValue,
        orders6m: Number(stats?.orders6m ?? 0),
        paysInDays: Number(stats?.paysInDays ?? 0),
        creditTermDays: customer.creditTermDays,
        gstin: customer.gstin,
        route: customer.route,
        customerSince: customer.customerSince,
        deactivationRequested: customer.deactivationRequested,
        reactivationRequested: customer.reactivationRequested,
        reactivationReason: customer.reactivationReason,
        deactivationReason: customer.deactivationReason,
      }}
      daysSinceOrder={
        customer.lastOrderDate ? daysBetween(customer.lastOrderDate, day) : null
      }
      // The escalation state, shown where the customer is looked at rather than
      // only on the collections worklist.
      followUpStage={
        followUp?.state
          ? {
              stage: followUp.state.stage,
              daysOverdue: followUp.state.daysOverdue,
              nextChannel: followUp.state.nextChannel,
              held: followUp.state.held,
              heldReason: followUp.state.heldReason,
            }
          : null
      }
      target={{
        amount: target?.target ?? 0,
        achieved: Number(stats?.thisMonth ?? 0),
        isDefault: target?.isDefault ?? true,
        shareOfBook: totalTarget
          ? Math.round(((target?.target ?? 0) / totalTarget) * 100)
          : 0,
      }}
      openComplaint={
        openComplaint
          ? {
              description: openComplaint.content,
              category: openComplaint.meta?.split(" · ")[0] ?? "Complaint",
            }
          : null
      }
      openPromise={
        promise?.promisedDate
          ? {
              amount: promise.promisedAmount ?? 0,
              promisedBy: promise.promisedDate,
            }
          : null
      }
      billStats={{
        total: bills.length,
        overdue: overdue.length,
        oldestDueDate: overdue[0]?.effectiveDueDate ?? null,
      }}
      categories={config["complaints.categories"]}
      period={period}
      complaintCategories={config["complaints.categories"].map((c) => ({
        value: c
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_|_$/g, ""),
        label: c,
      }))}
      quickNotes={quickNoteRows.map((n) => ({
        id: n.id,
        interactionType: n.interactionType,
        outcome: n.outcome,
        label: n.label,
      }))}
      singleSelectOutcomes={config["interactions.singleSelectOutcomes"]}
      maxComplaintImages={config["attachments.maxPerComplaint"]}
      searchEnabled={config["products.searchOnOrderForms"]}
      searchMinChars={config["products.searchMinChars"]}
      userName={user.name}
      products={productRows.map((p) => ({
        id: p.productId,
        name: p.name,
        packSize: p.packSize,
        subtitle: p.subtitle,
        millilitresPerCan: p.millilitresPerCan,
        cansPerBox: p.cansPerBox,
      }))}
      timeline={timeline.map((t) => ({
        id: t.id,
        kind: t.kind,
        at: t.at.toISOString(),
        actor: t.actor,
        content: t.content,
        meta: t.meta ?? null,
      }))}
      messages={messages.map((m) => ({
        id: m.id,
        at: m.at.toISOString(),
        by: m.by,
        status: m.status,
        channelLabel: m.channelLabel,
        destination: m.destination,
        destKind: m.destKind,
        templateName: m.templateName,
        body: m.body,
        edited: m.edited,
      }))}
    />
  );
}
