import { db } from "@/db";
import { bills } from "@/db/schema";
import { isManager, requireUser } from "@/lib/auth";
import { getScope, scopeLabel } from "@/lib/scope";
import {
  dayActivity,
  getActiveRun,
  getLastFinishedRun,
  getWaMode,
  listCustomers,
  listMessages,
  listPaymentFollowUps,
  listReplies,
  listTemplates,
  today,
} from "@/lib/queries";
import { clock, nowMs } from "@/lib/format";
import { WhatsappScreen } from "./whatsapp-screen";

export const metadata = { title: "WhatsApp — MahekOne CRM" };

/** Whole minutes a run took, floored at one so "0 min" never shows. */
function runMinutes(from: Date, to: Date | null): number {
  if (!to) return 1;
  return Math.max(1, Math.round((to.getTime() - from.getTime()) / 60000));
}

export default async function WhatsappPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; tab?: string }>;
}) {
  const { customer, tab } = await searchParams;
  const user = await requireUser();
  const scope = await getScope(user);
  const now = nowMs();

  const [customers, templates, messages, replies, mode, activeRun, lastRun, activity, followUps] =
    await Promise.all([
      listCustomers(user, scope),
      listTemplates(),
      listMessages(user, scope),
      listReplies(user, scope),
      getWaMode(),
      getActiveRun(user.id),
      getLastFinishedRun(user.id),
      dayActivity(user.id, today()),
      listPaymentFollowUps(user, scope),
    ]);

  // Oldest open bill per customer feeds the {{bill_no}} / {{bill_due}} fields.
  const openBills = await db
    .select({
      customerId: bills.customerId,
      billNo: bills.billNo,
      dueDate: bills.dueDate,
      amount: bills.amount,
      paid: bills.paid,
    })
    .from(bills);

  const oldestBill = new Map<string, { billNo: string; dueDate: string }>();
  for (const b of openBills.sort((a, z) => a.dueDate.localeCompare(z.dueDate))) {
    if (b.amount <= b.paid) continue;
    if (!oldestBill.has(b.customerId)) {
      oldestBill.set(b.customerId, { billNo: b.billNo, dueDate: b.dueDate });
    }
  }

  const customerPayload = customers.map((c) => ({
    id: c.id,
    name: c.name,
    contactPerson: c.contactPerson,
    phone: c.phone,
    city: c.city,
    outstanding: c.outstanding,
    lastOrderDate: c.lastOrderDate,
    lastOrderValue: c.lastOrderValue,
    ownerName: c.ownerName,
    groupName: c.whatsappGroupName,
    destKind: c.whatsappDest as "personal" | "group",
    oldestBillNo: oldestBill.get(c.id)?.billNo ?? null,
    oldestBillDue: oldestBill.get(c.id)?.dueDate ?? null,
    slowPayer: c.slowPayer,
  }));

  return (
    <WhatsappScreen
      scopeLabel={scopeLabel(scope, user)}
      isManager={isManager(user)}
      mode={mode}
      initialCustomerId={customer ?? customerPayload[0]?.id ?? ""}
      initialTab={tab === "run" || tab === "templates" || tab === "log" ? tab : "send"}
      customers={customerPayload}
      templates={templates.map((t) => ({
        id: t.id,
        name: t.name,
        category: t.category,
        body: t.body,
        appliesTo: t.appliesTo as "personal" | "group",
        uses: t.uses,
        archived: t.archived,
        updatedAt: t.updatedAt.toISOString(),
      }))}
      messages={messages.map((m) => ({
        id: m.id,
        customerId: m.customerId,
        customerName: m.customerName,
        templateName: m.templateName,
        destination: m.destination,
        destKind: m.destKind,
        mode: m.mode,
        status: m.status,
        sentByName: m.sentByName,
        edited: m.edited,
        createdAt: m.createdAt.toISOString(),
      }))}
      replies={replies.map((r) => ({
        id: r.id,
        customerId: r.customerId,
        customerName: r.customerName,
        message: r.message,
        receivedAt: r.receivedAt.toISOString(),
      }))}
      runElapsedMinutes={
        activeRun ? runMinutes(activeRun.startedAt, new Date(now)) : 0
      }
      run={
        activeRun
          ? {
              id: activeRun.id,
              templateId: activeRun.templateId,
              recipients: activeRun.recipients,
              cursor: activeRun.cursor,
              paused: activeRun.paused,
              startedAt: activeRun.startedAt.toISOString(),
            }
          : null
      }
      lastRun={
        lastRun
          ? {
              sent: lastRun.recipients.filter((r) => r.state === "sent").length,
              skipped: lastRun.recipients.filter((r) => r.state === "skipped").length,
              minutes: runMinutes(lastRun.startedAt, lastRun.finishedAt),
            }
          : null
      }
      previewTime={clock(new Date(now))}
      messagesToday={activity.messagesSent}
      followUpCounts={{
        stage1: followUps.filter((f) => f.stage === "Reminder due").length,
        slow: followUps.filter((f) => f.customer.slowPayer).length,
        over60: followUps.filter((f) => f.oldestDays > 60).length,
      }}
    />
  );
}
