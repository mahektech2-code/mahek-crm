import { notFound } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { orders, payments } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { currentPeriod, customerTimeline, getCustomer, today } from "@/lib/queries";
import { getFollowUpDetail } from "@/lib/services/payment-service";
import { listTargets } from "@/lib/services/worklist-services";
import { daysBetween } from "@/lib/format";
import { RecordScreen } from "./record-screen";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const customer = await getCustomer(id);
  return { title: `${customer?.name ?? "Customer"} — MahekOne CRM` };
}

export default async function CustomerRecordPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireUser();

  const customer = await getCustomer(id);
  if (!customer) notFound();

  const day = await today();
  const period = await currentPeriod();

  const [timeline, targets, followUp, stats] = await Promise.all([
    customerTimeline(id),
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
      customer={{
        id: customer.id,
        name: customer.name,
        contactPerson: customer.contactPerson,
        phone: customer.phone,
        city: customer.city,
        ownerName: customer.ownerName,
        status: customer.status,
        slowPayer: customer.slowPayer,
        outstanding: customer.outstanding,
        lastOrderDate: customer.lastOrderDate,
        lastOrderValue: customer.lastOrderValue,
        cycleDays: customer.cycleDays,
        cycleIsDefault: customer.cycleIsDefault,
        avgOrderValue: customer.avgOrderValue,
        orders6m: Number(stats?.orders6m ?? 0),
        paysInDays: Number(stats?.paysInDays ?? 0),
        creditTermDays: customer.creditTermDays,
        gstin: customer.gstin,
        route: customer.route,
        customerSince: customer.customerSince,
        deactivationRequested: customer.deactivationRequested,
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
          ? { amount: promise.promisedAmount ?? 0, promisedBy: promise.promisedDate }
          : null
      }
      billStats={{
        total: bills.length,
        overdue: overdue.length,
        oldestDueDate: overdue[0]?.effectiveDueDate ?? null,
      }}
      timeline={timeline.map((t) => ({
        id: t.id,
        kind: t.kind,
        at: t.at.toISOString(),
        actor: t.actor,
        content: t.content,
        meta: t.meta ?? null,
      }))}
    />
  );
}
