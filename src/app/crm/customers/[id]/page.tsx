import { notFound } from "next/navigation";
import { customerRecordDetail } from "@/lib/services/customer-record-service";
import { orderCountsSql } from "@/lib/order-status";
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
  customerTimelineCounts,
  getCustomer,
  listAmChanges,
  today,
} from "@/lib/queries";
import { getFollowUpDetail } from "@/lib/services/payment-service";
import {
  deliveryAddressesFor,
  distributorsFor,
  suggestedDistributors,
} from "@/lib/services/distributor-service";
import { can } from "@/lib/access-control";
import { getConfig } from "@/lib/config/store";
import { popularProducts } from "@/lib/services/product-service";
import { quickNotes as quickNotesTable } from "@/db/schema";
import { listTargets } from "@/lib/services/worklist-services";
import { customerStatusLabel, daysBetween } from "@/lib/format";
import { categoryLabel } from "@/lib/complaint-labels";
// How much of the timeline the page arrives with — see `TIMELINE_PAGE`. The
// number that matters is not the ten, it is that it IS a number: the page used
// to carry the account's whole history, so the oldest customers took the
// longest to open and were the hardest to read.
import { TIMELINE_PAGE } from "@/lib/timeline-kinds";
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

  const [config, timeline, timelineCounts, messages, targets, followUp, stats] =
    await Promise.all([
    getConfig(),
    // The FIRST PAGE of it, not the history. See `customerTimeline`.
    customerTimeline(id, { limit: TIMELINE_PAGE }),
    customerTimelineCounts(id),
    customerMessages(id),
    listTargets(period),
    getFollowUpDetail(id),
    // Order count, month-to-date value and how long they actually take to pay,
    // in one round trip.
    db
      .select({
        /*
         * DID THE BUSINESS SELL ANYTHING — `orderCountsSql`, the one place
         * that question is answered.
         *
         * These two said `status <> 'cancelled'`, which is the spelling
         * `lib/order-status.ts` was written to replace: it counts an order
         * accounts have not approved yet and one they refused outright. This
         * page was the last place in `src/` still using it, so a customer's
         * six-month count and their month-to-date included orders the business
         * declined — on the screen a telecaller opens to decide how to talk to
         * them.
         */
        orders6m: sql<number>`(
          select count(*)::int from ${orders} o
           where o.customer_id = ${id} and ${orderCountsSql("o")}
             and o.ordered_at >= now() - interval '6 months'
        )`,
        thisMonth: sql<number>`coalesce((
          select sum(o.total_amount) from ${orders} o
           where o.customer_id = ${id} and ${orderCountsSql("o")}
             and o.ordered_at >= date_trunc('month', current_date)
        ), 0)`,
        /*
         * HOW LONG THEY ACTUALLY TAKE TO PAY, over money that actually arrived.
         *
         * `payments` rows exist for every receipt whatever its status, so this
         * average was taken over reported claims nobody had checked, receipts
         * accounts rejected, and — overwhelmingly — reversed ones: 9,421 of
         * the reversed lines are the assume-everything-settled sheet imports,
         * spread across 513 of the 561 customers. For almost the whole book
         * this figure was computed mostly from money the business decided had
         * never arrived.
         *
         * `r.status = 'confirmed'` is the same join `recomputeBillPaid` uses,
         * and for the same reason: confirmed is the only status that is money.
         */
        paysInDays: sql<number>`coalesce((
          select round(avg(p.paid_at - b.bill_date))::int
            from ${payments} p
            join bills b on b.id = p.bill_id
            join payment_receipts r on r.id = p.receipt_id
           where p.customer_id = ${id} and r.status = 'confirmed'
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

  /*
   * THE DELIVERY CHAIN, from whichever end this record sits at.
   *
   * `distributors` is who bills this shop; `servedShops` is which shops are
   * billed through it. Both are read for every record rather than branched on
   * here, because an account can be at both ends at once — a direct customer
   * that distributes for us and is also delivered to on somebody else's bill
   * is unusual and real — and asking for the empty one costs an index lookup.
   *
   * The suggestions are only worth fetching where they could be acted on: a
   * lead nobody has converted yet, whose order history already shows goods
   * arriving on somebody's bill.
   */
  const [distributors, deliveryAddresses, suggestions] = await Promise.all([
    distributorsFor(id),
    deliveryAddressesFor(id),
    customer.kind === "lead" && !customer.thirdParty
      ? suggestedDistributors(id)
      : Promise.resolve([]),
  ]);

  // Everything the record itself is made of. Its own round trip rather than a
  // join onto the customer read: these are six independent lists and one of
  // them being slow should not hold the others up.
  const detail = await customerRecordDetail(id, day);

  const target = targets.find((t) => t.customerId === id);
  const totalTarget = targets.reduce((a, t) => a + t.target, 0);

  /*
   * The open complaint the banner shouts about, read from the COMPLAINTS
   * rather than from the timeline.
   *
   * It used to scan the timeline, which was every entry this customer had.
   * Now that the timeline is a page, the same scan would look at the newest
   * fifty — so on any busy account the complaint would fall off the bottom and
   * the banner telling a telecaller to mention it before anything else would
   * quietly stop appearing. The complaints list is the right place to ask, it
   * is already fetched, and it answers the same question directly.
   */
  const openComplaint = detail.complaints.find((c) => c.status !== "resolved");

  // The latest dated promise from the follow-up attempt log.
  const promise = followUp?.attempts.find((a) => a.promisedDate);

  const bills = followUp?.bills ?? [];
  const overdue = bills.filter((b) => b.balance > 0 && b.overdueDays > 0);

  return (
    <RecordScreen
      detail={detail}
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
        area: customer.area,
        territoryRegion: customer.territoryRegion,
        dealerCode: customer.dealerCode,
        thirdParty: customer.thirdParty,
        doNotContact: customer.doNotContact,
        customerSince: customer.customerSince,
        deactivationRequested: customer.deactivationRequested,
        reactivationRequested: customer.reactivationRequested,
        reactivationReason: customer.reactivationReason,
        deactivationReason: customer.deactivationReason,
      }}
      distributors={distributors}
      deliveryAddresses={deliveryAddresses}
      distributorSuggestions={suggestions}
      // The same question the action asks, so a drawn control and a permitted
      // action cannot disagree. The action checks again regardless.
      canClassify={can(user.role, "customer.classify")}
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
              description: openComplaint.description,
              // The stored enum is not a label — `packaging_damage` was what
              // the timeline's meta carried, and it reached the sentence.
              category: categoryLabel(openComplaint.category),
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
      timeline={timeline.entries.map((t) => ({
        id: t.id,
        kind: t.kind,
        at: t.at.toISOString(),
        actor: t.actor,
        content: t.content,
        meta: t.meta ?? null,
      }))}
      timelineCursor={timeline.cursor}
      timelineMore={timeline.more}
      timelineCounts={timelineCounts}
      messageTotal={messages.total}
      messages={messages.messages.map((m) => ({
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
