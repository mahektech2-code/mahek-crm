import { isManager, requireUser } from "@/lib/auth";
import { getScope, scopeLabel } from "@/lib/scope";
import { dayActivity, listCustomers, today } from "@/lib/queries";
import { getConfig } from "@/lib/config/store";
import { getFollowUpWorklist, listBills } from "@/lib/services/payment-service";
import {
  findResumableRun,
  listMessages,
  listReplies,
  listTemplates,
  listUnconfirmedCopies,
} from "@/lib/services/whatsapp-service";
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
  const day = await today();

  const [
    config,
    customers,
    templates,
    messages,
    replies,
    activeRun,
    activity,
    followUps,
    bills,
    unconfirmed,
  ] = await Promise.all([
    getConfig(),
    listCustomers(),
    listTemplates(),
    listMessages(),
    listReplies(),
    findResumableRun(user.id),
    dayActivity(user.id, day),
    getFollowUpWorklist(),
    listBills(),
    isManager(user) ? listUnconfirmedCopies() : Promise.resolve([]),
  ]);

  // Oldest open bill per customer feeds the {{bill_no}} / {{bill_due}} fields.
  const oldestBill = new Map<string, { billNo: string; dueDate: string }>();
  for (const b of [...bills].sort((a, z) => a.dueDate.localeCompare(z.dueDate))) {
    if (b.balance <= 0) continue;
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
    destKind: c.whatsappDest,
    oldestBillNo: oldestBill.get(c.id)?.billNo ?? null,
    oldestBillDue: oldestBill.get(c.id)?.dueDate ?? null,
    slowPayer: c.slowPayer,
  }));

  return (
    <WhatsappScreen
      scopeLabel={scopeLabel(scope, user)}
      isManager={isManager(user)}
      // Manual is the default and stays fully usable — automatic sending is an
      // addition, never a replacement.
      mode={config["whatsapp.mode"]}
      // Automatic sending is configured but the last attempts failed. Derived
      // from the messages themselves rather than a health-check endpoint we do
      // not have — a banner that cannot be wrong is better than one that is
      // green because nothing has been asked of it.
      sendingFailing={
        config["whatsapp.mode"] === "automatic" &&
        messages.some((m) => m.status === "failed")
      }
      initialCustomerId={customer ?? customerPayload[0]?.id ?? ""}
      initialTab={tab === "run" || tab === "templates" || tab === "log" ? tab : "send"}
      customers={customerPayload}
      templates={templates.map((t) => ({
        id: t.id,
        name: t.name,
        category: t.category,
        body: t.body,
        appliesTo: t.appliesTo,
        uses: t.usageCount,
        archived: !t.active,
        updatedAt: t.updatedAt.toISOString(),
      }))}
      messages={messages.map((m) => ({
        id: m.id,
        customerId: m.customerId,
        customerName: m.customerName,
        templateName: m.templateName,
        destination: m.resolvedDestination,
        destKind: m.destKind,
        mode: m.mode,
        status: m.status,
        sentByName: m.userName ?? "—",
        edited: m.edited,
        createdAt: m.preparedAt.toISOString(),
        copiedAt: m.copiedAt?.toISOString() ?? null,
        confirmedSentAt: m.confirmedSentAt?.toISOString() ?? null,
      }))}
      replies={replies.map((r) => ({
        id: r.id,
        customerId: r.customerId,
        customerName: r.customerName,
        message: r.message,
        receivedAt: r.receivedAt.toISOString(),
      }))}
      runElapsedMinutes={activeRun ? runMinutes(activeRun.run.startedAt, new Date(now)) : 0}
      run={
        activeRun
          ? {
              id: activeRun.run.id,
              templateId: activeRun.run.templateId,
              paused: activeRun.run.status === "paused",
              startedAt: activeRun.run.startedAt.toISOString(),
              sent: activeRun.sent,
              skipped: activeRun.skipped,
              total: activeRun.recipients.length,
              recipients: activeRun.recipients.map((r) => ({
                messageId: r.id,
                customerName: r.customerName,
                status: r.status,
                done: r.done,
              })),
              // The record set is the state, so a refresh resumes exactly here.
              current: activeRun.current
                ? {
                    messageId: activeRun.current.id,
                    customerId: activeRun.current.customerId,
                    customerName: activeRun.current.customerName,
                    destination: activeRun.current.resolvedDestination,
                    // A prepared row is always one leg, never "both".
                    destKind: activeRun.current.destKind as "personal" | "group",
                    body: activeRun.current.body,
                    status: activeRun.current.status,
                  }
                : null,
            }
          : null
      }
      previewTime={clock(new Date(now))}
      messagesToday={activity.whatsappSent}
      // Copied but never confirmed: each one is a customer who may or may not
      // have been contacted. Managers get the number; nobody gets a guess.
      unconfirmedCount={unconfirmed.length}
      followUpCounts={{
        stage1: followUps.filter((f) => f.stage === 1).length,
        slow: followUps.filter((f) => f.slowPayer).length,
        over60: followUps.filter((f) => f.daysOverdue > 60).length,
      }}
      followUpIds={{
        stage1: followUps.filter((f) => f.stage === 1).map((f) => f.customerId),
        slow: followUps.filter((f) => f.slowPayer).map((f) => f.customerId),
        over60: followUps.filter((f) => f.daysOverdue > 60).map((f) => f.customerId),
      }}
    />
  );
}
