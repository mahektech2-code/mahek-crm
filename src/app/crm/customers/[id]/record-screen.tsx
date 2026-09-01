"use client";

import * as React from "react";
import { categoryLabel } from "@/lib/complaint-labels";
import type { CustomerRecordDetail } from "@/lib/services/customer-record-service";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Progress,
  SectionLabel,
  SlowPayerBadge,
  Select,
  cx,
} from "@/components/ui/primitives";
import { FilterPills, Modal } from "@/components/ui/overlays";
import { VoiceTextarea } from "@/components/ui/dictate";
import { useToast } from "@/components/ui/toast";
import { Icon } from "@/components/shell/icons";
import {
  CallPanel,
  type CallTarget,
  type ProductOption,
  type QuickNoteOption,
} from "@/components/crm/call-panel";
import { MessageHistory, type MessageEntry } from "./message-history";
import { NextCallCell, type StoredNextStep } from "@/components/crm/next-call-cell";
import { TIMELINE_KINDS, type TimelineKind } from "@/lib/timeline-kinds";
import {
  createReminder,
  loadCustomerTimeline,
  logComplaint,
} from "@/lib/actions/crm";
import { convertToThirdParty, revertThirdParty } from "@/lib/actions/third-party";
import { ThirdPartyDialog } from "@/components/crm/third-party-dialog";
import { updateAccountManagers } from "@/lib/actions/account-manager";
import { assignSalesManager } from "@/lib/actions/sales-manager";
import { SalesManagerDialog } from "@/components/crm/sales-manager-dialog";
import {
  SHEET_NAME_VALUE,
  StaffDot,
  openingSalesValue,
  openingBackOfficeValue,
  type Row as CustomerListRow,
} from "@/components/customers/customers-screen";
import {
  DeliveryRelations,
  type Relation,
} from "@/components/crm/delivery-relations";
import {
  ageLabel,
  monthLabel,
  money,
  pct,
  phoneDisplay,
  shortDate,
  stamp,
  today,
} from "@/lib/format";

/**
 * The confidence bands, in words. The number alone is not something anybody
 * reads mid-call; "High" is.
 */
function confidenceWord(confidence: number): string {
  if (confidence >= 80) return "High";
  if (confidence >= 60) return "Medium";
  if (confidence >= 40) return "Low";
  return "Very low";
}

type Entry = {
  id: string;
  kind: string;
  at: string;
  actor: string;
  content: string;
  meta: string | null;
};

const KIND_TONE: Record<
  string,
  "brand" | "success" | "warn" | "danger" | "neutral"
> = {
  Call: "brand",
  WhatsApp: "success",
  Order: "success",
  Reminder: "warn",
  Complaint: "danger",
  Payment: "success",
  Bill: "neutral",
};

export function RecordScreen({
  detail,
  customer,
  distributors,
  deliveryAddresses,
  distributorSuggestions,
  canClassify,
  canReassign,
  canAssignSalesManager,
  backOfficePeople,
  amReasons,
  amSearchThreshold,
  timelineCursor,
  timelineMore,
  timelineCounts,
  amChanges,
  daysSinceOrder,
  followUpStage,
  target,
  openComplaint,
  openPromise,
  billStats,
  timeline,
  messages,
  messageTotal,
  categories,
  period,
  complaintCategories,
  quickNotes,
  singleSelectOutcomes,
  maxComplaintImages,
  searchEnabled,
  searchMinChars,
  userName,
  products,
}: {
  /** Bills, receipts, orders and the rest — see customer-record-service. */
  detail: CustomerRecordDetail;
  /**
   * The delivery chain, from both ends, and each end is ONE list: what a
   * person recorded and what the order sheet has seen, together. `distributors`
   * is who bills THIS shop; `deliveryAddresses` is which shops are delivered to
   * on its bills. Both are read for every record, because an account can sit at
   * both ends at once.
   */
  distributors: Relation[];
  deliveryAddresses: Relation[];
  /** Who the order history suggests, on a lead nobody has converted yet. */
  distributorSuggestions: Array<{ id: string; name: string; orders: number }>;
  /** `customer.classify` — converting, and editing an arrangement. */
  canClassify: boolean;
  /**
   * `customer.reassign` — moving the sales and back office seats. Accounts'
   * and admin's, deliberately: whose book an account is in decides whose
   * targets it counts toward.
   */
  canReassign: boolean;
  /**
   * `customer.assignSalesManager` — a more generous answer than `canReassign`
   * for a seat that drives no queue, no scope and no target.
   */
  canAssignSalesManager: boolean;
  /** Accounts and current employees both — none of the three seats needs a login. */
  backOfficePeople: Array<{ id: string; name: string; role?: string }>;
  /** `people.amChangeReasons`, asked for whenever a manager changes. */
  amReasons: string[];
  amSearchThreshold: number;
  /** Where the first page of the timeline stopped. Null when it is all of it. */
  timelineCursor: { at: string; id: string } | null;
  timelineMore: boolean;
  /**
   * How many of each kind exist IN THE WHOLE HISTORY, counted in SQL. The
   * pills used to count what had been loaded, which is exactly why the page
   * used to load everything.
   */
  timelineCounts: { all: number } & Record<string, number>;
  customer: {
    id: string;
    name: string;
    contactPerson: string | null;
    phone: string;
    city: string;
    ownerName: string | null;
    kind: "lead" | "customer";
    leadSource: string | null;
    createdAt: string;
    /** Raw ids, alongside the names — the account manager dialog needs both. */
    ownerId: string | null;
    salesAmId: string | null;
    /** Whether a person has decided the sales seat — see `openingSalesValue`. */
    amDecidedAt: Date | null;
    salesAmName: string | null;
    /** Who the salesperson answers to — a third seat, and a manager's to set. */
    salesManagerId: string | null;
    salesManagerName: string | null;
    backOfficeAmId: string | null;
    backOfficeAmName: string | null;
    status: string;
    slowPayer: boolean;
    outstanding: number;
    lastOrderDate: string | null;
    lastOrderValue: number;
    cycleDays: number;
    /** True while the cycle is the configured fallback, not their own history. */
    cycleIsDefault: boolean;
    /** 0–100, or null where the cycle is a default. */
    cycleConfidence?: number | null;
    /** Last order + the cycle. Null for a customer who has never ordered. */
    expectedOrderDate?: string | null;
    /** What the screen told whoever logged the last call — see `NextCallCell`. */
    nextStep: StoredNextStep | null;
    avgOrderValue: number;
    orders6m: number;
    paysInDays: number;
    creditTermDays: number;
    gstin: string | null;
    route: string | null;
    area: string | null;
    territoryRegion: string | null;
    dealerCode: string | null;
    /** A shop we deliver to, billed by its distributor. */
    thirdParty: boolean;
    doNotContact: boolean;
    customerSince: string | null;
    deactivationRequested: boolean;
    deactivationReason: string | null;
    reactivationRequested: boolean;
    reactivationReason: string | null;
  };
  daysSinceOrder: number | null;
  followUpStage: {
    stage: number;
    daysOverdue: number;
    nextChannel: "whatsapp" | "call";
    held: boolean;
    heldReason: string | null;
  } | null;
  target: {
    amount: number;
    achieved: number;
    isDefault: boolean;
    shareOfBook: number;
  };
  openComplaint: { description: string; category: string } | null;
  openPromise: { amount: number; promisedBy: string } | null;
  billStats: { total: number; overdue: number; oldestDueDate: string | null };
  timeline: Entry[];
  /** Every change of account manager, newest first. Names as stored. */
  amChanges: Array<{
    id: string;
    role: "sales" | "sales_manager" | "back_office";
    fromName: string | null;
    toName: string | null;
    reasonCode: string;
    note: string | null;
    changedAt: Date;
    changedBy: string | null;
  }>;
  /** Every WhatsApp message prepared for this customer, newest first. */
  messages: MessageEntry[];
  /** Every message this customer has been sent — `messages` is the newest page. */
  messageTotal: number;
  /** Complaint categories, from configuration rather than a constant. */
  categories: string[];
  /** "2026-08" — the month the target figures belong to. */
  period: string;
  complaintCategories: Array<{ value: string; label: string }>;
  quickNotes: QuickNoteOption[];
  singleSelectOutcomes: string[];
  maxComplaintImages: number;
  /** products.searchOnOrderForms — checked here as well as in the API. */
  searchEnabled: boolean;
  searchMinChars: number;
  /** The signed-in telecaller, for script placeholders. */
  userName: string;
  products: ProductOption[];
}) {
  const router = useRouter();
  const { run } = useToast();

  const [filter, setFilter] = React.useState("All");
  const [calling, setCalling] = React.useState(false);
  const [remOpen, setRemOpen] = React.useState(false);
  const [cmpOpen, setCmpOpen] = React.useState(false);
  const [converting, setConverting] = React.useState(false);
  const [amOpen, setAmOpen] = React.useState(false);
  const [smOpen, setSmOpen] = React.useState(false);

  /*
   * THE TIMELINE IS A PAGE, and this holds the pages read so far.
   *
   * Filtering cannot be done in the browser any more, and that is the point:
   * with fifty of 3,504 entries loaded, "Bill" filtered in JavaScript would
   * show the bills among the newest fifty and call it the bill history. Each
   * pill asks the server for the newest page OF THAT KIND, which is also why
   * the counts beside them are counted in SQL rather than measured here.
   */
  const [entries, setEntries] = React.useState<Entry[]>(timeline);
  const [cursor, setCursor] = React.useState(timelineCursor);
  const [more, setMore] = React.useState(timelineMore);
  const [loading, setLoading] = React.useState<"filter" | "older" | null>(null);

  const kinds = [
    "All",
    // Every kind that HAS anything, from the counts rather than from what
    // happens to be loaded — a pill that appears once you scroll far enough is
    // not a filter, it is a surprise.
    ...TIMELINE_KINDS.filter((k) => (timelineCounts[k] ?? 0) > 0),
  ];

  async function readTimeline(
    kind: string,
    before: { at: string; id: string } | null,
  ) {
    setLoading(before ? "older" : "filter");
    try {
      const result = await run(
        loadCustomerTimeline(customer.id, {
          kind: kind === "All" ? undefined : (kind as TimelineKind),
          before: before ?? undefined,
        }),
      );
      if (!result.ok) return;
      // Appended when paging, replaced when filtering — the same call answers
      // both, and which one it is is decided by whether a cursor was sent.
      setEntries((prev) =>
        before ? [...prev, ...result.data.entries] : result.data.entries,
      );
      setCursor(result.data.cursor);
      setMore(result.data.more);
    } finally {
      setLoading(null);
    }
  }

  const visible = entries;

  const overCycle =
    daysSinceOrder !== null && daysSinceOrder > customer.cycleDays;
  const paysLate = customer.paysInDays > customer.creditTermDays;

  const alert = followUpStage?.held
    ? `Held at stage ${followUpStage.stage} - ${followUpStage.heldReason ?? "a dispute is open"}.`
    : openComplaint
      ? `Open ${openComplaint.category.toLowerCase()} complaint - mention it before anything else.`
      : openPromise && openPromise.promisedBy < today()
        ? `${money(openPromise.amount)} was promised for ${shortDate(openPromise.promisedBy)} and has not arrived.`
        : customer.deactivationRequested
          ? `Deactivation requested - ${customer.deactivationReason ?? "no reason recorded"}. Waiting on a manager.`
          // Above the buying cycle, because a customer nobody has decided on
          // yet is not one whose cycle means anything.
          : customer.reactivationRequested
            ? `Reactivation requested - ${customer.reactivationReason ?? "no reason recorded"}. Waiting on a manager.`
          : overCycle
            ? `${daysSinceOrder} days since the last order, against a ${customer.cycleDays}-day buying cycle.`
            : null;

  const callTarget: CallTarget = {
    customerId: customer.id,
    name: customer.name,
    contactPerson: customer.contactPerson,
    phone: customer.phone,
    city: customer.city,
    ownerName: customer.ownerName,
    outstanding: customer.outstanding,
    lastOrderDate: customer.lastOrderDate,
    lastOrderValue: customer.lastOrderValue,
    creditTermDays: customer.creditTermDays,
    targetGap: Math.max(0, target.amount - target.achieved),
    openComplaint: openComplaint?.description ?? null,
    history: timeline.slice(0, 3).map((t) => ({
      kind: t.kind,
      at: t.at,
      actor: t.actor,
      content: t.content,
    })),
  };

  return (
    <div className="max-w-[1440px] px-6 pt-6 pb-10">
      <Link
        href="/crm/customers"
        className="mb-2.5 inline-flex items-center gap-1.5 text-[13px] text-muted no-underline hover:no-underline hover:text-body"
      >
        <Icon name="chevronLeft" size={14} />
        All customers
      </Link>

      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {customer.name}
            <Badge
              tone={
                customer.status === "Slow payer"
                  ? "warn"
                  : customer.status === "Inactive"
                    ? "muted"
                    : customer.status === "New"
                      ? "brand"
                      : "success"
              }
            >
              {customer.status}
            </Badge>
            {/*
              The status badge already says it where the status IS "Slow
              payer" — `customerStatusLabel` returns that when the flag is set
              and nothing more urgent applies — so drawing both put "Slow payer
              Slow payer" side by side on the header of every flagged account.
              It is still drawn where the status says something else: a
              deactivated or inactive slow payer is two facts, and the second
              one is the one somebody needs before they ring.
            */}
            {customer.slowPayer && customer.status !== "Slow payer" ? (
              <SlowPayerBadge />
            ) : null}
          </span>
        }
        /*
         * The two seats, not the owner.
         *
         * `owner_id` records who FOUND the account and is one person for the
         * whole book here — the import wrote it — so "Owner Priya Sharma" was
         * on every customer in the CRM while the list and the form beside it
         * named the real manager. Whose book a customer is in is the sales AM;
         * the owner is only the answer for a LEAD, which is what
         * `ASSIGNED_TO_SQL` reads for one.
         */
        subtitle={`${customer.contactPerson ?? "No contact person"} · ${phoneDisplay(customer.phone)} · ${customer.city} · ${
          customer.kind === "lead"
            ? `Lead owner ${customer.ownerName ?? "unassigned"}`
            : `Sales ${customer.salesAmName ?? "unassigned"} · Sales manager ${customer.salesManagerName ?? "unassigned"} · Back office ${customer.backOfficeAmName ?? "unassigned"}`
        }`}
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() =>
                router.push(`/crm/whatsapp?customer=${customer.id}`)
              }
            >
              WhatsApp
            </Button>
            <Button variant="secondary" onClick={() => setRemOpen(true)}>
              Set reminder
            </Button>
            {/*
              Offered on a LEAD and on a third-party customer, and on nothing
              else. A direct customer is an account we invoice, so saying it
              does not bill with us is a contradiction — the button is absent
              rather than drawn and refused, which is the same rule the
              customers list follows one screen along.
            */}
            {canClassify && customer.thirdParty ? (
              <Button
                variant="secondary"
                onClick={async () => {
                  const result = await run(revertThirdParty([customer.id]));
                  if (result.ok) router.refresh();
                }}
                title="They bill with us now. Who used to bill them stays on the record."
              >
                No longer third party
              </Button>
            ) : canClassify && customer.kind === "lead" ? (
              <Button variant="secondary" onClick={() => setConverting(true)}>
                Convert to third party
              </Button>
            ) : null}
            <Button variant="secondary" onClick={() => setCmpOpen(true)}>
              Log complaint
            </Button>
            <Button variant="primary" onClick={() => setCalling(true)}>
              <Icon name="phone" size={16} />
              Call
            </Button>
          </>
        }
      />

      {alert ? (
        <div className="mb-4 flex items-center gap-2.5 rounded-[4px] border border-danger-soft border-l-[3px] border-l-danger bg-danger-soft px-3.5 py-2.5">
          <Icon name="alert" size={16} className="flex-none text-danger" />
          <span className="text-sm text-ink">{alert}</span>
        </div>
      ) : null}

      <div className="grid grid-cols-[minmax(0,1fr)_clamp(280px,24%,380px)] items-start gap-4">
        <div className="flex flex-col gap-4">
        <MessageHistory messages={messages} total={messageTotal} />

        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-divider px-5 py-3.5">
            <span className="text-lg leading-6 font-semibold text-ink">
              Timeline
            </span>
            <FilterPills
              value={filter}
              onChange={(k) => {
                if (k === filter) return;
                setFilter(k);
                // The newest page OF THAT KIND, from the server. Filtering the
                // loaded page would answer with the bills among the newest
                // fifty entries and call it the bill history.
                void readTimeline(k, null);
              }}
              options={kinds.map((k) => ({
                key: k,
                label: k,
                count: k === "All" ? timelineCounts.all : (timelineCounts[k] ?? 0),
              }))}
            />
          </div>
          {/*
            FIXED HEIGHT, SCROLLING INSIDE ITSELF — the rule every other panel
            on this page already follows, and the one this panel was written
            before. Growing the page instead is what made COLOUR CAMP
            unreadable: 3,504 entries pushed the orders, the bills, the
            payments and the arrangement a hundred screens down, so the account
            with the most history was the one whose record you could reach the
            least of.
          */}
          <div className="max-h-[560px] overflow-y-auto px-5 py-4">
            {loading === "filter" ? (
              <div className="py-10 text-center text-[15px] text-muted">
                Reading the {filter === "All" ? "timeline" : filter.toLowerCase()}…
              </div>
            ) : visible.length ? (
              visible.map((t) => (
                <div
                  key={t.id}
                  className="relative border-l border-divider pb-4 pl-5 last:pb-0"
                >
                  <span
                    className={cx(
                      "absolute top-1 -left-[4.5px] block h-2 w-2 rounded-full",
                      KIND_TONE[t.kind] === "danger"
                        ? "bg-danger"
                        : KIND_TONE[t.kind] === "warn"
                          ? "bg-warn"
                          : KIND_TONE[t.kind] === "success"
                            ? "bg-success"
                            : KIND_TONE[t.kind] === "brand"
                              ? "bg-brand"
                              : "bg-line-strong",
                    )}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={KIND_TONE[t.kind] ?? "neutral"}>
                      {t.kind}
                    </Badge>
                    <span className="text-[11px] text-muted">
                      {stamp(t.at)}
                    </span>
                    <span className="text-[11px] text-muted">· {t.actor}</span>
                  </div>
                  <div className="mt-1 text-sm text-ink">{t.content}</div>
                  {t.meta ? (
                    <div className="mt-0.5 text-[13px] text-muted">
                      {t.meta}
                    </div>
                  ) : null}
                </div>
              ))
            ) : (
              <div className="py-10 text-center text-[15px] text-muted">
                Nothing of this type has been logged against this customer yet.
              </div>
            )}
            {/*
              WHAT IS SHOWN AND WHAT IS NOT. A list that simply stops reads as
              the whole history — and on these accounts it is one page of
              seventy. The count is the true one, from SQL.
            */}
            {more ? (
              <div className="flex items-center justify-between gap-3 border-t border-divider pt-3">
                <span className="text-[13px] text-muted">
                  Showing the newest {visible.length} of{" "}
                  {(filter === "All"
                    ? timelineCounts.all
                    : (timelineCounts[filter] ?? 0)
                  ).toLocaleString("en-IN")}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={loading !== null}
                  onClick={() => void readTimeline(filter, cursor)}
                >
                  {loading === "older" ? "Loading…" : "Load older"}
                </Button>
              </div>
            ) : visible.length ? (
              <div className="border-t border-divider pt-3 text-[13px] text-muted">
                That is the whole{" "}
                {filter === "All" ? "history" : `${filter.toLowerCase()} history`} for
                this customer.
              </div>
            ) : null}
          </div>
        </Card>

        {/* ------------------------------------------------------------------
            The record itself: what this customer has bought, been billed, paid
            and complained about. All of it was already in the database and
            none of it was on this page — a telecaller preparing for a call had
            a timeline and five figures, while the drawer they open DURING the
            call knew the product history and the buying cycle.

            Every panel is the same height and scrolls inside itself. Growing
            the page instead is what made a customer with three hundred bills
            unreadable: the more history an account had, the less of its record
            you could reach.
        ------------------------------------------------------------------ */}

        <ScrollPanel
          title="Orders"
          count={detail.counts.orders}
          shown={detail.orders.length}
          empty="No orders recorded against this customer."
        >
          {detail.orders.map((o) => (
            <RowLine
              key={o.id}
              left={
                <>
                  {o.orderNo ?? "no number"}
                  {o.deliveredTo ? (
                    <span className="text-muted"> → {o.deliveredTo}</span>
                  ) : null}
                </>
              }
              sub={
                <>
                  {shortDate(o.orderedAt)} · {o.status.replace(/_/g, " ")}
                  {o.lines ? ` · ${o.lines} line${o.lines === 1 ? "" : "s"}` : ""}
                  {/* An order accounts have not agreed to is not a sale, and
                      the figures above it do not count it. Saying so here is
                      what stops the two reading as a contradiction. */}
                  {o.counts ? "" : " · not counted as a sale"}
                </>
              }
              right={money(o.amount)}
              tone={o.counts ? undefined : "muted"}
            />
          ))}
        </ScrollPanel>

        <ScrollPanel
          title="Bills"
          count={detail.counts.bills}
          shown={detail.bills.length}
          empty="No bills raised against this customer."
        >
          {detail.bills.map((b) => (
            <RowLine
              key={b.id}
              left={b.billNo}
              sub={
                <>
                  {shortDate(b.billDate)}
                  {b.dueDate ? ` · due ${shortDate(b.dueDate)}` : " · no due date"}
                  {b.daysOverdue ? ` · ${b.daysOverdue} days overdue` : ""}
                </>
              }
              right={
                /* An `unstated` bill is neither paid nor owed — nobody has
                   spoken for it either way — so its balance is not drawn as a
                   figure. Rendering the full amount beside real balances is
                   the mistake the payment_position column exists to prevent. */
                b.stated ? (
                  <>
                    {money(b.balance)}
                    <span className="block text-[12px] text-muted">
                      of {money(b.amount)}
                    </span>
                  </>
                ) : (
                  <span className="text-[13px] text-muted">
                    not stated
                    <span className="block text-[12px]">{money(b.amount)} billed</span>
                  </span>
                )
              }
              tone={b.daysOverdue ? "danger" : undefined}
            />
          ))}
        </ScrollPanel>

        <ScrollPanel
          title="Payments received"
          count={detail.counts.receipts}
          shown={detail.receipts.length}
          empty="No payment has been recorded for this customer."
        >
          {detail.receipts.map((r) => (
            <RowLine
              key={r.id}
              left={
                <>
                  {r.mode}
                  {r.reference ? (
                    <span className="text-muted"> · {r.reference}</span>
                  ) : null}
                </>
              }
              sub={
                <>
                  {shortDate(r.receivedAt)}
                  {/* A cheque has two dates and they answer different
                      questions: when we got it, and when it can be banked. */}
                  {r.instrumentDate
                    ? ` · dated ${shortDate(r.instrumentDate)}`
                    : ""}
                  {" · "}
                  {r.status}
                  {r.source === "sheet_import" ? " · from the sheet" : ""}
                </>
              }
              right={money(r.amount)}
              /* Only confirmed money counts anywhere else in the system, so
                 anything else is drawn as the claim it is. */
              tone={
                r.status === "confirmed"
                  ? undefined
                  : r.status === "rejected" || r.status === "reversed"
                    ? "danger"
                    : "muted"
              }
            />
          ))}
        </ScrollPanel>

        {/*
          ONE LIST PER DIRECTION, and each one holds both halves of the answer.

          This was three panels: the arrangement somebody recorded, and then —
          under a title of its own — every shop the order sheet shows goods
          going to. Four rows beside eighty-six, two counts, and nothing saying
          how they differed, so the honest reading was that the page showed the
          same list twice. What the sheet has seen and nobody has recorded is
          not a second subject; it is the unfinished part of the first one, and
          it belongs in the same list with the button that finishes it.
        */}
        {distributors.length || customer.thirdParty ? (
          <DeliveryRelations
            anchorId={customer.id}
            anchorName={customer.name}
            relations={distributors}
            canEdit={canClassify}
            direction="distributors"
            isThirdParty={customer.thirdParty}
          />
        ) : null}

        {deliveryAddresses.length ? (
          <DeliveryRelations
            anchorId={customer.id}
            anchorName={customer.name}
            relations={deliveryAddresses}
            canEdit={canClassify}
            direction="addresses"
            isThirdParty={customer.thirdParty}
          />
        ) : null}

        <div className="grid gap-4 md:grid-cols-2">
          <ScrollPanel
            title="Complaints"
            count={detail.counts.complaints}
            shown={detail.complaints.length}
            empty="No complaint has been raised."
          >
            {detail.complaints.map((c) => (
              <RowLine
                key={c.id}
                left={categoryLabel(c.category)}
                sub={
                  <>
                    {shortDate(c.createdAt)} · {c.status.replace(/_/g, " ")}
                    <span className="block">{c.description}</span>
                  </>
                }
                tone={c.status === "resolved" ? "muted" : "warn"}
              />
            ))}
          </ScrollPanel>

          <ScrollPanel
            title="Reminders"
            count={detail.counts.reminders}
            shown={detail.reminders.length}
            empty="No reminder has been set."
          >
            {detail.reminders.map((rm) => (
              <RowLine
                key={rm.id}
                left={rm.note ?? "no note"}
                sub={
                  <>
                    {shortDate(rm.dueDate)} · {rm.status}
                    {rm.ownerName ? ` · ${rm.ownerName}` : ""}
                  </>
                }
                tone={rm.status === "pending" ? undefined : "muted"}
              />
            ))}
          </ScrollPanel>
        </div>
        </div>

        <div className="flex flex-col gap-4">
          <Card className="p-5">
            <SectionLabel>Key figures</SectionLabel>
            <div className="mt-3">
              <Figure
                label="Outstanding"
                tone={customer.outstanding > 0 ? "danger" : undefined}
              >
                {money(customer.outstanding)}
              </Figure>
              <Figure
                label="Bills overdue"
                tone={billStats.overdue ? "danger" : undefined}
              >
                {billStats.overdue} of {billStats.total}
              </Figure>
              <Figure label="Last order">
                {customer.lastOrderDate
                  ? shortDate(customer.lastOrderDate)
                  : "Never"}
              </Figure>
              <Figure
                label="Days since order"
                tone={overCycle ? "danger" : undefined}
              >
                {daysSinceOrder === null ? "-" : ageLabel(daysSinceOrder)}
              </Figure>
              <Figure label="Buying cycle">
                {customer.cycleDays} days
                {customer.cycleIsDefault ? (
                  <span className="ml-1 text-[11px] font-normal text-muted">
                    (default - not enough order history)
                  </span>
                ) : customer.cycleConfidence !== null &&
                  customer.cycleConfidence !== undefined ? (
                  /*
                   * How much the date beside it is worth. 29, 30, 31, 30, 29
                   * and 15, 45, 22, 60, 30 average to nearly the same number
                   * and mean entirely different things; without this the
                   * screen shows one figure for both.
                   */
                  <span className="ml-1 text-[11px] font-normal text-muted">
                    ({confidenceWord(customer.cycleConfidence)} confidence ·{" "}
                    {customer.cycleConfidence}%)
                  </span>
                ) : null}
              </Figure>
              <Figure label="Next call">
                <NextCallCell step={customer.nextStep} today={today()} />
              </Figure>
              {customer.expectedOrderDate ? (
                <Figure label="Expected order">
                  {shortDate(customer.expectedOrderDate)}
                </Figure>
              ) : null}
              {followUpStage ? (
                <Figure
                  label="Collections stage"
                  tone={followUpStage.stage >= 3 ? "danger" : undefined}
                >
                  Stage {followUpStage.stage}
                  <span className="ml-1 text-[11px] font-normal text-muted">
                    ({followUpStage.daysOverdue} days overdue · next by{" "}
                    {followUpStage.nextChannel})
                  </span>
                </Figure>
              ) : null}
              <Figure label="Average order">
                {money(customer.avgOrderValue)}
              </Figure>
              <Figure label="Orders, last 6 months">{customer.orders6m}</Figure>
              <Figure
                label="Pays on average"
                tone={paysLate ? "danger" : "success"}
              >
                {customer.paysInDays} days
                <span className="ml-1 text-[11px] font-normal text-muted">
                  (terms {customer.creditTermDays})
                </span>
              </Figure>
              <Figure label="Share of your target" last>
                {target.shareOfBook}%
              </Figure>
            </div>
            <Link
              href={`/crm/bills?customer=${customer.id}`}
              className="mt-4 flex h-8 items-center justify-center rounded-[4px] border border-line-strong bg-surface text-sm font-medium text-body no-underline hover:bg-canvas hover:no-underline"
            >
              See all bills
            </Link>
          </Card>

          <Card className="p-5">
            <div className="flex items-center justify-between">
              <SectionLabel>
                Target vs achieved - {monthLabel(period)}
              </SectionLabel>
              {target.isDefault ? <Badge tone="muted">Default</Badge> : null}
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-[32px] leading-9 font-semibold text-ink">
                {money(target.achieved)}
              </span>
              <span className="text-[13px] text-muted">
                of {money(target.amount)}
              </span>
            </div>
            <div className="mt-3 flex items-center gap-2.5">
              <Progress
                value={pct(target.achieved, target.amount)}
                className="flex-1"
              />
              <span className="text-[13px] font-medium text-ink">
                {pct(target.achieved, target.amount)}%
              </span>
            </div>
          </Card>

          <Card className="p-5">
            <div className="flex items-center justify-between">
              <SectionLabel>Account</SectionLabel>
              {customer.kind === "customer" && canReassign ? (
                <button
                  type="button"
                  onClick={() => setAmOpen(true)}
                  className="cursor-pointer text-[12px] font-medium text-brand hover:underline"
                >
                  Edit sales / back office
                </button>
              ) : null}
            </div>
            {/*
              A LABEL AND A VALUE, not a sentence.
              
              This was `GSTIN {value}` on one line and `Route {value}` on the
              next, with nothing between the two halves — so "Route not set"
              read as prose and a GST number ran straight on from its own
              label. Two facts sharing a line need something separating them,
              and the separator this codebase already uses is colour on the
              label rather than punctuation: muted label, plain value, so the
              eye picks out the values without reading a word of the labels.
            */}
            <dl className="mt-2.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm leading-[22px]">
              <Fact label="GSTIN" value={customer.gstin} />
              <Fact label="Credit terms" value={`${customer.creditTermDays} days`} />
              <Fact label="Route" value={customer.route} />
              <Fact label="Area" value={customer.area} />
              <Fact label="Territory" value={customer.territoryRegion} />
              <Fact label="Dealer code" value={customer.dealerCode} />
              {customer.kind === "lead" ? (
                <>
                  <Fact label="Lead since" value={shortDate(customer.createdAt)} />
                  <Fact label="Source" value={customer.leadSource} />
                  <Fact label="Owner" value={customer.ownerName} />
                </>
              ) : (
                <>
                  <Fact
                    label="Customer since"
                    value={
                      customer.customerSince ? shortDate(customer.customerSince) : null
                    }
                  />
                  {/* The three seats at ONE size, as the customers list draws
                      them: they are peers, and a hierarchy of type sizes down a
                      column claims an importance ranking that does not exist. */}
                  {/*
                    NO fallback to `ownerName` here. `SALES_AM_NAME_SQL`
                    already carries that fallback — for an account nobody has
                    decided about. Redoing it here would override the one
                    case that fallback deliberately excludes: an account
                    somebody has decided has no salesperson, where null means
                    unassigned and re-showing the importer's name is the exact
                    bug this screen exists to not have.
                  */}
                  <Fact label="Sales" value={customer.salesAmName} />
                  {/* Who the salesperson answers to. Named here rather than
                      left to the list, because this is the screen somebody is
                      on when they ask who to escalate an account to — and it
                      is the one seat of the three that is a manager's to set. */}
                  <dt className="text-muted whitespace-nowrap">Sales manager</dt>
                  <dd className="m-0 flex min-w-0 items-center justify-between gap-2 break-words text-ink">
                    <span>
                      {customer.salesManagerName ?? (
                        <span className="text-muted">-</span>
                      )}
                    </span>
                    {canAssignSalesManager ? (
                      <button
                        type="button"
                        onClick={() => setSmOpen(true)}
                        className="cursor-pointer text-[12px] font-medium text-brand hover:underline"
                      >
                        Edit
                      </button>
                    ) : null}
                  </dd>
                  <Fact label="Back office" value={customer.backOfficeAmName} />
                  <Fact
                    label="Buying cycle"
                    value={
                      customer.cycleIsDefault
                        ? `${customer.cycleDays} days (default)`
                        : `${customer.cycleDays} days${
                            customer.cycleConfidence === null
                              ? ""
                              : ` · ${customer.cycleConfidence}% confident`
                          }`
                    }
                  />
                </>
              )}
              {/*
                WHAT THIS ACCOUNT IS, said once and in full — this is the one
                screen with room for it. The list badge answers the same
                question in two words and has to pick between the mark and the
                kind; here both fit, and the kind underneath is what explains
                why a third-party customer can still be invoiced one day.
              */}
              {customer.thirdParty ? (
                <>
                  <Fact
                    label="Type"
                    value={`Third-party customer - we deliver, a distributor bills. Underneath, still a ${customer.kind}.`}
                  />
                  <Fact
                    label="Billed by"
                    value={billedBy(distributors)}
                  />
                </>
              ) : customer.kind === "customer" && deliveryAddresses.length ? (
                <Fact
                  label="Delivers to"
                  // The RECORDED half, because that is what somebody has
                  // vouched for. The rest is on the panel, where it can say
                  // what it is.
                  value={`${deliveryAddresses.filter((d) => d.recorded).length} recorded of ${deliveryAddresses.length} addresses seen`}
                />
              ) : null}
              {customer.doNotContact ? <Fact label="Standing" value="Do not contact" /> : null}
              {/* Who it was before, and why it moved. The question people ask
                  after a resignation is not who owns this now — the line above
                  answers that — it is what happened to it. */}
              {amChanges.length ? (
                <>
                  <dt className="col-span-2 mt-1.5 border-t border-divider pt-1.5 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                    Manager history
                  </dt>
                  <dd className="col-span-2 m-0">
                    {amChanges.map((c) => (
                      <span key={c.id} className="block text-[11px] text-muted">
                        {shortDate(c.changedAt)} ·{" "}
                        {/* Three seats now, so the label cannot be a boolean. A
                            history line calling a sales manager change "Back
                            office" is worse than one saying nothing. */}
                        {c.role === "sales"
                          ? "Sales"
                          : c.role === "sales_manager"
                            ? "Sales manager"
                            : "Back office"}{" "}
                        {c.fromName ?? "unassigned"} → {c.toName ?? "unassigned"} ·{" "}
                        {c.reasonCode}
                        {c.note ? ` — ${c.note}` : ""}
                        {c.changedBy ? ` (${c.changedBy})` : ""}
                      </span>
                    ))}
                  </dd>
                </>
              ) : null}
            </dl>
          </Card>
        </div>
      </div>

      <ThirdPartyDialog
        open={converting}
        names={[customer.name]}
        suggestions={distributorSuggestions}
        excludeCustomerId={customer.id}
        onClose={() => setConverting(false)}
        onConfirm={async (chosen) => {
          const result = await run(
            convertToThirdParty({
              customerIds: [customer.id],
              distributors: chosen.map((d) => ({
                distributorId: d.id,
                isPrimary: d.isPrimary,
                note: d.note.trim() || undefined,
              })),
            }),
          );
          if (result.ok) router.refresh();
          return result.ok;
        }}
      />

      <AccountManagerDialog
        open={amOpen}
        customer={customer}
        people={backOfficePeople}
        reasons={amReasons}
        onClose={() => setAmOpen(false)}
        onSaved={() => router.refresh()}
      />

      {smOpen ? (
        <SalesManagerDialog
          open
          scope={{
            kind: "ids",
            ids: [customer.id],
            accounts: [
              { id: customer.id, name: customer.name, salesManagerName: customer.salesManagerName },
            ],
          }}
          people={backOfficePeople}
          reasons={amReasons}
          searchThreshold={amSearchThreshold}
          onClose={() => setSmOpen(false)}
          onSubmit={async (change) => {
            const result = await run(
              assignSalesManager({
                scope: { kind: "ids", customerIds: change.ids ?? [customer.id] },
                target: change.target,
                reasonCode: change.reasonCode,
                note: change.note,
                expectedCount: change.expectedCount,
              }),
            );
            if (result.ok) {
              setSmOpen(false);
              router.refresh();
            }
          }}
        />
      ) : null}

      {calling ? (
        <CallPanel
          target={callTarget}
          complaintCategories={complaintCategories}
          quickNotes={quickNotes}
          singleSelectOutcomes={singleSelectOutcomes}
          maxComplaintImages={maxComplaintImages}
          searchEnabled={searchEnabled}
          searchMinChars={searchMinChars}
          userName={userName}
          products={products}
          onClose={() => setCalling(false)}
        />
      ) : null}

      <QuickReminder
        open={remOpen}
        customerName={customer.name}
        onClose={() => setRemOpen(false)}
        onSubmit={async (dueDate, note) => {
          const result = await run(
            createReminder({ customerId: customer.id, dueDate, note }),
          );
          if (result.ok) {
            setRemOpen(false);
            router.refresh();
          }
        }}
      />

      <QuickComplaint
        categories={categories}
        open={cmpOpen}
        customerName={customer.name}
        onClose={() => setCmpOpen(false)}
        onSubmit={async (category, description) => {
          const result = await run(
            logComplaint({ customerId: customer.id, category, description }),
          );
          if (result.ok) {
            setCmpOpen(false);
            router.refresh();
          }
        }}
      />
    </div>
  );
}

/**
 * Moving the sales or back office seat, from the record itself.
 *
 * The list's "Edit details" dialog already does this correctly — same
 * fields, same `updateAccountManagers` call, same unassign path — but a
 * telecaller looking at one account has no reason to go and find it on a
 * list of fifty-two. Same logic as that dialog's submit handler, deliberately
 * NOT shared as a function: this only ever acts on one customer, and the
 * list's diffing has to stay free to change for its own bulk-editing reasons
 * without this screen moving underneath it.
 */
function AccountManagerDialog({
  open,
  customer,
  people,
  reasons,
  onClose,
  onSaved,
}: {
  open: boolean;
  customer: {
    id: string;
    name: string;
    kind: "lead" | "customer";
    ownerId: string | null;
    salesAmId: string | null;
    amDecidedAt: Date | null;
    salesAmName: string | null;
    backOfficeAmId: string | null;
    backOfficeAmName: string | null;
  };
  people: Array<{ id: string; name: string; role?: string }>;
  reasons: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  if (!open) return null;
  return (
    <AccountManagerDialogBody
      key={customer.id}
      customer={customer}
      people={people}
      reasons={reasons}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

function AccountManagerDialogBody({
  customer,
  people,
  reasons,
  onClose,
  onSaved,
}: {
  customer: {
    id: string;
    name: string;
    kind: "lead" | "customer";
    ownerId: string | null;
    salesAmId: string | null;
    amDecidedAt: Date | null;
    salesAmName: string | null;
    backOfficeAmId: string | null;
    backOfficeAmName: string | null;
  };
  people: Array<{ id: string; name: string; role?: string }>;
  reasons: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { run } = useToast();
  const [busy, setBusy] = React.useState(false);

  // A Partial<Row> built from the fields this screen actually has — the same
  // shape `openingSalesValue`/`openingBackOfficeValue` already read on the
  // customers list, so a sheet-only name resolves to the same picker entry
  // (or the same "not on the staff list" sentinel) on both screens.
  const rowLike: Partial<CustomerListRow> = {
    ownerId: customer.ownerId,
    salesAmId: customer.salesAmId,
    amDecidedAt: customer.amDecidedAt,
    salesAmName: customer.salesAmName,
    backOfficeAmId: customer.backOfficeAmId,
    backOfficeAmName: customer.backOfficeAmName,
  };
  const assignedBefore = openingSalesValue(customer.kind, rowLike, people);
  const backOfficeBefore = openingBackOfficeValue(rowLike, people);

  const [salesId, setSalesId] = React.useState(assignedBefore);
  const [backOfficeId, setBackOfficeId] = React.useState(backOfficeBefore);
  const [reasonCode, setReasonCode] = React.useState(reasons[0] ?? "");

  const salesMoved = salesId !== SHEET_NAME_VALUE && salesId !== assignedBefore;
  const backOfficeMoved =
    backOfficeId !== SHEET_NAME_VALUE && backOfficeId !== backOfficeBefore;
  const changed = salesMoved || backOfficeMoved;

  return (
    <Modal
      open
      onClose={onClose}
      title={`Account managers — ${customer.name}`}
      width={480}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            disabled={busy || !changed || !reasonCode}
            onClick={async () => {
              setBusy(true);
              try {
                const result = await run(
                  updateAccountManagers({
                    customerIds: [customer.id],
                    ...(salesMoved
                      ? salesId.startsWith("emp:")
                        ? {
                            salesEmployeeId: salesId.slice(4),
                            sales: { reasonCode },
                          }
                        : { salesAmId: salesId || null, sales: { reasonCode } }
                      : {}),
                    ...(backOfficeMoved
                      ? {
                          backOffice: !backOfficeId
                            ? ({ kind: "none" } as const)
                            : backOfficeId.startsWith("emp:")
                              ? ({
                                  kind: "employee",
                                  employeeId: backOfficeId.slice(4),
                                } as const)
                              : ({ kind: "user", userId: backOfficeId } as const),
                          backOfficeReason: { reasonCode },
                        }
                      : {}),
                  }),
                );
                if (result.ok) {
                  onSaved();
                  onClose();
                }
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <Field label="Account manager · sales" hint="Whose book this account is in.">
        <span className="relative block">
          {salesId ? <StaffDot gone={salesId === SHEET_NAME_VALUE} /> : null}
          <Select
            value={salesId}
            onChange={(e) => setSalesId(e.target.value)}
            disabled={busy}
            className={cx("w-full", salesId ? "pl-6" : "")}
          >
            {salesId === SHEET_NAME_VALUE ? (
              <option value={SHEET_NAME_VALUE}>{customer.salesAmName}</option>
            ) : null}
            <option value="">Unassigned</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </span>
        {salesId === SHEET_NAME_VALUE ? (
          <span className="mt-1 block text-[12px] text-danger">
            No longer on the staff list. Pick who has taken the book over.
          </span>
        ) : null}
      </Field>
      <Field
        label="Account manager · back office"
        hint="Dispatch, billing and paperwork for this account."
        className="mt-3"
      >
        <span className="relative block">
          {backOfficeId ? (
            <StaffDot gone={backOfficeId === SHEET_NAME_VALUE} />
          ) : null}
          <Select
            value={backOfficeId}
            onChange={(e) => setBackOfficeId(e.target.value)}
            disabled={busy}
            className={cx("w-full", backOfficeId ? "pl-6" : "")}
          >
            {backOfficeId === SHEET_NAME_VALUE ? (
              <option value={SHEET_NAME_VALUE}>{customer.backOfficeAmName}</option>
            ) : null}
            <option value="">Unassigned</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </span>
        {backOfficeId === SHEET_NAME_VALUE ? (
          <span className="mt-1 block text-[12px] text-danger">
            No longer on the staff list. Pick who is doing the paperwork now.
          </span>
        ) : null}
      </Field>
      {changed ? (
        <Field label="Why this is changing" className="mt-3">
          <Select
            value={reasonCode}
            onChange={(e) => setReasonCode(e.target.value)}
            disabled={busy}
          >
            {reasons.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </Select>
        </Field>
      ) : null}
    </Modal>
  );
}

/**
 * One fact: a muted label and its value, side by side.
 *
 * `-` where there is nothing, in the value's own place rather than as prose,
 * so a missing GSTIN and a missing route line up as two blanks instead of
 * reading as two half-sentences.
 */
function Fact({ label, value }: { label: string; value: string | number | null }) {
  return (
    <>
      <dt className="text-muted whitespace-nowrap">{label}</dt>
      <dd className="m-0 min-w-0 break-words text-ink">
        {value === null || value === "" ? <span className="text-muted">-</span> : value}
      </dd>
    </>
  );
}

/**
 * A card of fixed height whose CONTENTS scroll.
 *
 * Everything on this page used to grow the page instead: a customer with three
 * hundred bills pushed the panel below them off the bottom of the screen, so
 * the more history an account had the less of its record you could reach. The
 * height is the same for every panel so the page has a rhythm rather than one
 * enormous box and five small ones.
 *
 * The count in the header is the WHOLE count, not the number of rows loaded —
 * a list silently cut at two hundred is a list somebody trusts and should not.
 */

/**
 * Who bills this shop, in one line — the RECORDED ones only.
 *
 * The panel below lists what the order sheet has seen as well, and says so on
 * each row. This line cannot: "Billed by X" is read as a fact somebody stands
 * behind, so an account nobody has recorded must not appear in it under a
 * label that grants it authority it does not have.
 */
function billedBy(relations: Array<{ recorded: boolean; isPrimary: boolean; name: string }>): string | null {
  const recorded = relations.filter((r) => r.recorded);
  if (!recorded.length) {
    // The state the conversion rules prevent, reachable only on an account
    // converted before distributors were recorded.
    return "nobody recorded yet";
  }
  const first = recorded.find((r) => r.isPrimary) ?? recorded[0];
  const others = recorded.length - 1;
  return others
    ? `${first.name} and ${others} other${others === 1 ? "" : "s"}`
    : first.name;
}

function ScrollPanel({
  title,
  count,
  shown,
  empty,
  children,
}: {
  title: string;
  count: number;
  /** How many are actually rendered, where that is fewer than the count. */
  shown?: number;
  empty: string;
  children: React.ReactNode;
}) {
  const capped = shown !== undefined && shown < count;
  return (
    <Card className="flex max-h-[420px] flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-divider px-5 py-3.5">
        <span className="text-lg leading-6 font-semibold text-ink">{title}</span>
        <span className="text-[13px] text-muted">
          {count === 0
            ? "none"
            : capped
              ? `showing ${shown} of ${count}`
              : `${count}`}
        </span>
      </div>
      {count === 0 ? (
        <p className="px-5 py-6 text-sm text-muted">{empty}</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">{children}</div>
      )}
    </Card>
  );
}

/** A row of the tables inside the panels above. */
function RowLine({
  left,
  right,
  sub,
  tone,
}: {
  left: React.ReactNode;
  right?: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "danger" | "warn" | "muted";
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-divider py-2 last:border-b-0">
      <div className="min-w-0">
        <div
          className={
            tone === "danger"
              ? "text-sm text-danger"
              : tone === "muted"
                ? "text-sm text-muted"
                : "text-sm text-ink"
          }
        >
          {left}
        </div>
        {sub ? <div className="text-[12px] text-muted">{sub}</div> : null}
      </div>
      {right !== undefined ? (
        <div className="shrink-0 text-right text-sm tabular-nums text-ink">{right}</div>
      ) : null}
    </div>
  );
}

function Figure({
  label,
  children,
  tone,
  last,
}: {
  label: string;
  children: React.ReactNode;
  tone?: "danger" | "success";
  last?: boolean;
}) {
  return (
    <div
      className={cx(
        "flex items-center justify-between py-1.5",
        !last && "border-b border-canvas",
      )}
    >
      <span className="text-sm text-muted">{label}</span>
      <span
        className={cx(
          "text-sm font-medium",
          tone === "danger"
            ? "text-danger"
            : tone === "success"
              ? "text-success"
              : "text-ink",
        )}
      >
        {children}
      </span>
    </div>
  );
}

export function QuickReminder({
  open,
  customerName,
  onClose,
  onSubmit,
}: {
  open: boolean;
  customerName: string;
  onClose: () => void;
  onSubmit: (dueDate: string, note: string) => Promise<void>;
}) {
  const [dueDate, setDueDate] = React.useState(today());
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Set reminder"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSubmit(dueDate, note);
              } finally {
                setBusy(false);
              }
            }}
          >
            Set reminder
          </Button>
        </>
      }
    >
      <div className="mb-3 text-sm text-muted">{customerName}</div>
      <div className="grid gap-3">
        <Field label="Due date · required">
          <Input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="w-[200px]"
          />
        </Field>
        <Field
          label="What was promised · required"
          hint="This note is what you will see in the reminders list - write it for your future self."
        >
          <VoiceTextarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onDictate={setNote}
            className="h-20"
            placeholder="Call back with the revised drum rate"
          />
        </Field>
      </div>
    </Modal>
  );
}

export function QuickComplaint({
  open,
  customerName,
  categories,
  onClose,
  onSubmit,
}: {
  open: boolean;
  customerName: string;
  categories: string[];
  onClose: () => void;
  onSubmit: (category: string, description: string) => Promise<void>;
}) {
  const [category, setCategory] = React.useState<string>(
    categories[0] ?? "Other",
  );
  const [description, setDescription] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Log complaint"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSubmit(category, description);
              } finally {
                setBusy(false);
              }
            }}
          >
            Log complaint
          </Button>
        </>
      }
    >
      <div className="mb-3 text-sm text-muted">{customerName}</div>
      <div className="grid gap-3">
        <Field label="Category">
          <Select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            {categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        </Field>
        <Field
          label="Description · required"
          hint="Write it in the customer's words - this is what the resolver reads."
        >
          <VoiceTextarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onDictate={setDescription}
            className="h-20"
          />
        </Field>
      </div>
    </Modal>
  );
}
