import { notFound } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { bills, orders } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { getScope } from "@/lib/scope";
import {
  currentPeriod,
  customerTimeline,
  getCustomer,
  listTargets,
  today,
} from "@/lib/queries";
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
  const user = await requireUser();
  const scope = await getScope(user);

  const customer = await getCustomer(id);
  if (!customer) notFound();

  const [timeline, targets, openComplaint, ordersThisMonth, openPromise, oldestBill] =
    await Promise.all([
      customerTimeline(id),
      listTargets(user, scope, currentPeriod()),
      db.query.complaints.findFirst({
        where: (c, { and, eq, inArray }) =>
          and(eq(c.customerId, id), inArray(c.status, ["Open", "In progress"])),
        orderBy: (c, { asc }) => asc(c.loggedOn),
      }),
      db
        .select({
          total: sql<number>`coalesce(sum(${orders.value}),0)::bigint`,
        })
        .from(orders)
        .where(
          and(
            eq(orders.customerId, id),
            sql`${orders.placedAt} >= date_trunc('month', current_date)`,
          ),
        )
        .then((r) => Number(r[0]?.total ?? 0)),
      db.query.promises.findFirst({
        where: (p, { and, eq, isNull }) => and(eq(p.customerId, id), isNull(p.kept)),
        orderBy: (p, { desc }) => desc(p.createdAt),
      }),
      db.query.bills.findFirst({
        where: (b, { and, eq, sql: s }) =>
          and(eq(b.customerId, id), s`${b.amount} > ${b.paid}`),
        orderBy: (b, { asc }) => asc(b.dueDate),
      }),
    ]);

  const target = targets.find((t) => t.customerId === id);
  const [billStats] = await db
    .select({
      count: sql<number>`count(*)::int`,
      overdue: sql<number>`count(*) filter (where ${bills.amount} > ${bills.paid} and ${bills.dueDate} < current_date)::int`,
    })
    .from(bills)
    .where(eq(bills.customerId, id));

  const totalTarget = targets.reduce((a, t) => a + t.target, 0);

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
        avgOrderValue: customer.avgOrderValue,
        orders6m: customer.orders6m,
        paysInDays: customer.paysInDays,
        creditTermDays: customer.creditTermDays,
        gstin: customer.gstin,
        route: customer.route,
        customerSince: customer.customerSince,
        deactivationRequested: customer.deactivationRequested,
        deactivationReason: customer.deactivationReason,
      }}
      daysSinceOrder={
        customer.lastOrderDate ? daysBetween(customer.lastOrderDate, today()) : null
      }
      target={{
        amount: target?.target ?? 0,
        achieved: ordersThisMonth,
        isDefault: target?.isDefault ?? true,
        shareOfBook: totalTarget
          ? Math.round(((target?.target ?? 0) / totalTarget) * 100)
          : 0,
      }}
      openComplaint={
        openComplaint
          ? { description: openComplaint.description, category: openComplaint.category }
          : null
      }
      openPromise={
        openPromise
          ? { amount: openPromise.amount, promisedBy: openPromise.promisedBy }
          : null
      }
      billStats={{
        total: billStats?.count ?? 0,
        overdue: billStats?.overdue ?? 0,
        oldestDueDate: oldestBill?.dueDate ?? null,
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
