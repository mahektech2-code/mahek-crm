"use client";

import * as React from "react";
import { placeLine } from "@/lib/place-tree";
import type { PlaceNames } from "@/lib/place-filters";
import { seatLabel, type AmRole } from "@/lib/seat-labels";
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
  Progress,
  SlowPayerBadge,
  Select,
  cx,
} from "@/components/ui/primitives";
import { CardGrid } from "@/components/ui/card-grid";
import { FilterPills, Modal, Tabs } from "@/components/ui/overlays";
import { LogComplaintDialog } from "@/components/crm/log-complaint-dialog";
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
import { CustomerContactsPanel } from "@/components/customers/customer-contacts-panel";
import type { CustomerContact } from "@/lib/services/customer-contact-service";
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
import { HandoverDialog } from "@/components/crm/handover-dialog";
import { handOverRelationships } from "@/lib/actions/relationship-handover";
import { bookUnchangedNote } from "@/lib/seat-effects";
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
import { CustomerPricesPanel } from "@/components/pricing/customer-prices-panel";
import type {
  CustomerPricing,
  DiscountAuthorityInput,
  PricingOptions,
} from "@/lib/price-list-views";
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

/** One kind of history at a time — see the tab strip on the record. */
type RecordTab =
  | "activity"
  | "orders"
  | "bills"
  | "messages"
  | "prices"
  | "issues"
  | "delivery";

/** The label/value grid every side card uses, so their columns line up. */
const FACTS =
  "m-0 grid grid-cols-[112px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm leading-[22px]";

const KIND_TONE: Record<
  string,
  "brand" | "success" | "warn" | "danger" | "neutral"
> = {
  Call: "brand",
  Opportunity: "brand",
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
  contacts,
  distributors,
  deliveryAddresses,
  distributorSuggestions,
  canClassify,
  canReassign,
  canAssignSalesManager,
  canHandOver,
  pricing,
  pricingLists,
  gstBp,
  canManagePrices,
  discountAuthority,
  useListForOrderValue,
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
  /** The people at this shop and which number gets what. */
  contacts: CustomerContact[];
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
  /**
   * `customer.handOver` — a manager's, like the seat above and unlike the two
   * that move an account's numbers. Passed in rather than derived here: a
   * client component asking its own permission question is a permission
   * question answered on the client.
   */
  canHandOver: boolean;
  /**
   * WHAT THIS SHOP PAYS — the resolved list, its rates and anything asked for.
   *
   * Null where nothing could be read for them at all, which is not the same as
   * "no list applies": that case arrives as a `pricing` with a null
   * `resolution`, and the panel says so in words. A missing read draws no
   * panel rather than an empty one.
   */
  pricing: CustomerPricing | null;
  /** Every list somebody could be put on, for the assign dialog. */
  pricingLists: PricingOptions["lists"];
  /** `pricing.gstBp` — the fallback where a list carries none of its own. */
  gstBp: number;
  /** `pricelist.manage`. The action checks again; this only decides a button. */
  canManagePrices: boolean;
  /** What this caller may take off a price on their own — see the call panel. */
  discountAuthority: DiscountAuthorityInput;
  /** `pricing.useListForOrderValue` — off, the rates are reference only. */
  useListForOrderValue: boolean;
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
    /** Where the shop is on the reviewed location tree — see `place-tree-service.ts`. */
    place: PlaceNames | null;
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
    relationshipOwnerName: string | null;
    handedOverAt: Date | string | null;
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
    /** A+ to C, kept on the ERP's Sales Party profile. */
    grade: string | null;
    route: string | null;
    area: string | null;
    territoryRegion: string | null;
    dealerCode: string | null;
    /** A shop we deliver to, billed by its distributor. */
    thirdParty: boolean;
    doNotContact: boolean;
    whatsappDnd: boolean;
    whatsappDndReason: string | null;
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
    /**
     * Null on an account the Monthly Targets list does not carry — a lead,
     * which has never bought from us, or a third-party shop, whose goods are
     * billed to its distributor. `achieved` is beside it rather than inside
     * it because the month's value is a fact about every account, target or
     * no target: it is read off the orders and not off `monthly_targets`.
     *
     * Rendering a null as ₹0 drew "₹1,20,000 of ₹0" at 0% on a delivery shop
     * with real orders behind it, which is worse than saying nothing — that
     * figure is not a shortfall, there is no target for it to fall short of.
     */
    amount: number | null;
    achieved: number;
    isDefault: boolean;
    shareOfBook: number | null;
    /** Sales bills asked for this month — null where no count is set. */
    billTarget: number | null;
    billsAchieved: number;
  };
  openComplaint: { description: string; category: string } | null;
  openPromise: { amount: number; promisedBy: string } | null;
  billStats: { total: number; overdue: number; oldestDueDate: string | null };
  timeline: Entry[];
  /** Every change of account manager, newest first. Names as stored. */
  amChanges: Array<{
    id: string;
    role: AmRole;
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
  const [hoOpen, setHoOpen] = React.useState(false);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [tab, setTab] = React.useState<RecordTab>("activity");

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
    targetGap: target.amount === null ? 0 : Math.max(0, target.amount - target.achieved),
    openComplaint: openComplaint?.description ?? null,
    history: timeline.slice(0, 3).map((t) => ({
      kind: t.kind,
      at: t.at,
      actor: t.actor,
      content: t.content,
    })),
  };

  /*
   * THE RECORD IS TABS, NOT A STACK.
   *
   * It was eleven panels down one column beside a sidebar of thirteen figures,
   * so the answer to any one question — what do they owe, what did they buy,
   * what did we last tell them — was somewhere in a scroll of three thousand
   * pixels. Now the page has one shape: who they are, five numbers, then one
   * kind of history at a time beside the account's standing facts. Every
   * panel and every read behind it is the same as before; only where each
   * one sits has changed.
   */
  const tabs: Array<{ key: RecordTab; label: string; count?: number }> = [
    { key: "activity", label: "Activity", count: timelineCounts.all },
    { key: "orders", label: "Orders", count: detail.counts.orders },
    { key: "bills", label: "Bills & payments", count: detail.counts.bills },
    { key: "messages", label: "WhatsApp", count: messageTotal },
    ...(pricing ? [{ key: "prices" as const, label: "Prices" }] : []),
    {
      key: "issues",
      label: "Complaints & reminders",
      count: detail.counts.complaints + detail.counts.reminders,
    },
    ...(distributors.length || customer.thirdParty || deliveryAddresses.length
      ? [
          {
            key: "delivery" as const,
            label: "Delivery",
            count: distributors.length + deliveryAddresses.length,
          },
        ]
      : []),
  ];
  const activeTab = tabs.some((t) => t.key === tab) ? tab : "activity";

  const typeLabel = customer.thirdParty
    ? "Third-party customer"
    : customer.kind === "lead"
      ? "Lead"
      : "Direct customer";
  const where = (customer.place?.state ? placeLine(customer.place) : "") || customer.city;
  const targetPct =
    target.amount === null ? null : pct(target.achieved, target.amount);

  return (
    <div className="max-w-[1440px] px-6 pt-6 pb-10">
      <Link
        href="/crm/customers"
        className="mb-2.5 inline-flex items-center gap-1.5 text-[13px] text-muted no-underline hover:no-underline hover:text-body"
      >
        <Icon name="chevronLeft" size={14} />
        All customers
      </Link>

      {/* --------------------------------------------------------- header */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="m-0 flex flex-wrap items-center gap-2.5 text-[26px] leading-8 font-semibold text-ink">
            <span className="min-w-0 break-words">{customer.name}</span>
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
            {/* The status already says "Slow payer" where that is the status;
                drawn again only where it says something else. */}
            {customer.slowPayer && customer.status !== "Slow payer" ? (
              <SlowPayerBadge />
            ) : null}
            <Badge tone={customer.thirdParty ? "warn" : customer.kind === "lead" ? "brand" : "neutral"}>
              {typeLabel}
            </Badge>
            {customer.doNotContact ? <Badge tone="danger">Do not contact</Badge> : null}
            {customer.whatsappDnd ? (
              <Badge tone="danger" title={customer.whatsappDndReason ?? undefined}>
                WhatsApp DND
              </Badge>
            ) : null}
          </h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-body">
            <span className="inline-flex items-center gap-1.5">
              <Icon name="person" size={14} className="text-muted" />
              {customer.contactPerson ?? <span className="text-muted">No contact person</span>}
            </span>
            <a
              href={`tel:${customer.phone}`}
              className="inline-flex items-center gap-1.5 font-medium text-ink no-underline hover:underline"
            >
              <Icon name="phone" size={14} className="text-muted" />
              {phoneDisplay(customer.phone)}
            </a>
            {where ? (
              <span className="text-muted">{where}</span>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/*
            Offered on a LEAD and on a third-party customer, and on nothing
            else. A direct customer is an account we invoice, so saying it
            does not bill with us is a contradiction — the button is absent
            rather than drawn and refused.
          */}
          {canClassify && customer.thirdParty ? (
            <Button
              variant="ghost"
              onClick={async () => {
                const result = await run(revertThirdParty([customer.id]));
                if (result.ok) router.refresh();
              }}
              title="They bill with us now. Who used to bill them stays on the record."
            >
              No longer third party
            </Button>
          ) : canClassify && customer.kind === "lead" ? (
            <Button variant="ghost" onClick={() => setConverting(true)}>
              Convert to third party
            </Button>
          ) : null}
          <Button variant="secondary" onClick={() => setCmpOpen(true)}>
            Log complaint
          </Button>
          <Button variant="secondary" onClick={() => setRemOpen(true)}>
            Set reminder
          </Button>
          <Button
            variant="secondary"
            onClick={() => router.push(`/crm/whatsapp?customer=${customer.id}`)}
          >
            WhatsApp
          </Button>
          <Button variant="primary" onClick={() => setCalling(true)}>
            <Icon name="phone" size={16} />
            Call
          </Button>
        </div>
      </div>

      {alert ? (
        <div className="mb-4 flex items-center gap-2.5 rounded-[6px] border border-danger-soft border-l-[3px] border-l-danger bg-danger-soft px-3.5 py-2.5">
          <Icon name="alert" size={16} className="flex-none text-danger" />
          <span className="text-sm text-ink">{alert}</span>
        </div>
      ) : null}

      {/* ---------------------------------------------------- the numbers */}
      <CardGrid min={200} gap="gap-3" className="mb-4">
        <Tile
          label="Outstanding"
          tone={customer.outstanding > 0 ? "danger" : undefined}
          value={money(customer.outstanding)}
          sub={
            billStats.total
              ? `${billStats.overdue} of ${billStats.total} bills overdue`
              : "No open bills"
          }
          subTone={billStats.overdue ? "danger" : undefined}
          link={{ href: `/crm/bills?customer=${customer.id}`, label: "See all bills →" }}
        />
        <Tile
          label="Last order"
          value={customer.lastOrderDate ? shortDate(customer.lastOrderDate) : "Never"}
          sub={
            daysSinceOrder === null
              ? "Has not ordered yet"
              : `${ageLabel(daysSinceOrder)} ago · cycle ${customer.cycleDays} days`
          }
          subTone={overCycle ? "danger" : undefined}
        />
        <Tile
          label={`This month · ${monthLabel(period)}`}
          value={money(target.achieved)}
          sub={
            target.amount === null
              ? /* Said in words rather than drawn as a 0% bar: the account
                   is not behind on anything. */
                customer.thirdParty
                ? "No target — billed by its distributor, so it counts to that account's month"
                : "No target — a lead picks one up on its first order"
              : `of ${money(target.amount)}${target.isDefault ? " (default target)" : ""}`
          }
          progress={targetPct}
        />
        <Tile
          label="Pays on average"
          value={customer.paysInDays ? `${customer.paysInDays} days` : "—"}
          tone={customer.paysInDays ? (paysLate ? "danger" : "success") : undefined}
          sub={
            customer.paysInDays
              ? `Credit terms ${customer.creditTermDays} days`
              : `No confirmed payment yet · terms ${customer.creditTermDays} days`
          }
        />
        <Tile
          label="Next call"
          value={
            customer.nextStep ? (
              <NextCallCell step={customer.nextStep} today={today()} />
            ) : (
              // Nobody has logged a call yet, so nothing has been promised.
              <span className="text-[16px] font-normal text-muted">Not set</span>
            )
          }
          sub={
            followUpStage
              ? `Collections stage ${followUpStage.stage} · ${followUpStage.daysOverdue} days overdue · next by ${followUpStage.nextChannel === "whatsapp" ? "WhatsApp" : "call"}`
              : customer.expectedOrderDate
                ? `Order expected ${shortDate(customer.expectedOrderDate)}`
                : undefined
          }
          subTone={followUpStage && followUpStage.stage >= 3 ? "danger" : undefined}
        />
      </CardGrid>

      <div className="grid grid-cols-[minmax(0,1fr)_clamp(300px,26%,380px)] items-start gap-4">
        {/* ------------------------------------------------- history tabs */}
        <Card className="min-w-0 overflow-hidden">
          <div className="overflow-x-auto">
            <Tabs
              value={activeTab}
              onChange={setTab}
              className="px-2"
              tabs={tabs}
            />
          </div>

          {activeTab === "activity" ? (
            <div>
              <div className="flex flex-wrap items-center gap-2 border-b border-divider px-5 py-3">
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
              {/* Fixed height, scrolling inside itself — the record is a
                  fixed-length page however old the account is. */}
              <div className="max-h-[600px] overflow-y-auto px-5 py-4">
                {loading === "filter" ? (
                  <div className="py-10 text-center text-sm text-muted">
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
                          "absolute top-1.5 -left-[4.5px] block h-2 w-2 rounded-full",
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
                        <Badge tone={KIND_TONE[t.kind] ?? "neutral"}>{t.kind}</Badge>
                        <span className="text-[12px] text-muted">
                          {stamp(t.at)} · {t.actor}
                        </span>
                      </div>
                      <div className="mt-1 text-sm text-ink">{t.content}</div>
                      {t.meta ? (
                        <div className="mt-0.5 text-[13px] text-muted">{readableMeta(t.meta)}</div>
                      ) : null}
                    </div>
                  ))
                ) : (
                  <div className="py-10 text-center text-sm text-muted">
                    Nothing of this type logged yet.
                  </div>
                )}
                {/* A list that simply stops reads as the whole history. The
                    count is the true one, from SQL. */}
                {more ? (
                  <div className="mt-2 flex items-center justify-between gap-3 border-t border-divider pt-3">
                    <span className="text-[13px] text-muted">
                      Newest {visible.length} of{" "}
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
                  <div className="mt-2 border-t border-divider pt-3 text-[13px] text-muted">
                    That is the whole {filter === "All" ? "history" : `${filter.toLowerCase()} history`}.
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {activeTab === "orders" ? (
            <TabList
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
                      {/* An order accounts have not agreed to is not a sale,
                          and the figures above do not count it. */}
                      {o.counts ? "" : " · not counted as a sale"}
                    </>
                  }
                  right={money(o.amount)}
                  tone={o.counts ? undefined : "muted"}
                />
              ))}
            </TabList>
          ) : null}

          {activeTab === "bills" ? (
            /* Two questions always asked together — what they were billed and
               what they paid against it — so they sit side by side. */
            <div className="grid divide-divider md:grid-cols-2 md:divide-x">
              <div className="min-w-0">
                <SubHead
                  title="Bills"
                  count={detail.counts.bills}
                  shown={detail.bills.length}
                  right={
                    <Link
                      href={`/crm/bills?customer=${customer.id}`}
                      className="text-[12px] text-brand no-underline"
                    >
                      All bills →
                    </Link>
                  }
                />
                <TabList
                  count={detail.counts.bills}
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
                        /* An `unstated` bill is neither paid nor owed, so its
                           balance is not drawn as a figure. */
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
                </TabList>
              </div>
              <div className="min-w-0">
                <SubHead
                  title="Payments received"
                  count={detail.counts.receipts}
                  shown={detail.receipts.length}
                />
                <TabList
                  count={detail.counts.receipts}
                  empty="No payment recorded."
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
                          {/* A cheque has two dates: when we got it, and when
                              it can be banked. */}
                          {r.instrumentDate ? ` · dated ${shortDate(r.instrumentDate)}` : ""}
                          {" · "}
                          {r.status}
                          {r.source === "sheet_import" ? " · from the sheet" : ""}
                        </>
                      }
                      right={money(r.amount)}
                      /* Only confirmed money counts anywhere else, so anything
                         else is drawn as the claim it is. */
                      tone={
                        r.status === "confirmed"
                          ? undefined
                          : r.status === "rejected" || r.status === "reversed"
                            ? "danger"
                            : "muted"
                      }
                    />
                  ))}
                </TabList>
              </div>
            </div>
          ) : null}

          {activeTab === "messages" ? (
            <div className="p-4">
              <MessageHistory
                messages={messages}
                total={messageTotal}
                chatHref={`/crm/whatsapp?tab=replies&chat=${customer.id}`}
              />
            </div>
          ) : null}

          {activeTab === "prices" && pricing ? (
            <div className="p-4">
              <CustomerPricesPanel
                pricing={pricing}
                canManage={canManagePrices}
                basePath="/crm/price-lists"
                app="crm"
                gstBp={gstBp}
                lists={pricingLists}
              />
            </div>
          ) : null}

          {activeTab === "issues" ? (
            <div className="grid divide-divider md:grid-cols-2 md:divide-x">
              <div className="min-w-0">
                <SubHead
                  title="Complaints"
                  count={detail.counts.complaints}
                  shown={detail.complaints.length}
                />
                <TabList count={detail.counts.complaints} empty="No complaint raised.">
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
                </TabList>
              </div>
              <div className="min-w-0">
                <SubHead
                  title="Reminders"
                  count={detail.counts.reminders}
                  shown={detail.reminders.length}
                />
                <TabList count={detail.counts.reminders} empty="No reminder set.">
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
                </TabList>
              </div>
            </div>
          ) : null}

          {activeTab === "delivery" ? (
            /* One list per direction, each holding both what somebody
               recorded and what the order sheet has seen. */
            <div className="flex flex-col gap-4 p-4">
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
            </div>
          ) : null}
        </Card>

        {/* --------------------------------------------------- the account */}
        <div className="flex flex-col gap-4">
          <SideCard title="Buying pattern">
            <dl className={FACTS}>
              <Fact
                label="Buying cycle"
                value={
                  customer.cycleIsDefault
                    ? `${customer.cycleDays} days (default — not enough order history)`
                    : `${customer.cycleDays} days${
                        customer.cycleConfidence === null || customer.cycleConfidence === undefined
                          ? ""
                          : ` · ${confidenceWord(customer.cycleConfidence).toLowerCase()} confidence (${customer.cycleConfidence}%)`
                      }`
                }
              />
              <Fact
                label="Order expected"
                value={customer.expectedOrderDate ? shortDate(customer.expectedOrderDate) : null}
              />
              <Fact label="Average order" value={money(customer.avgOrderValue)} />
              <Fact label="Orders, 6 months" value={customer.orders6m} />
              {target.billTarget ? (
                <Fact
                  label="Bills this month"
                  value={`${target.billsAchieved} of ${target.billTarget}${
                    target.billsAchieved >= target.billTarget ? " · met" : ""
                  }`}
                />
              ) : null}
              <Fact
                label="Share of target"
                value={target.shareOfBook === null ? null : `${target.shareOfBook}%`}
              />
            </dl>
          </SideCard>

          <SideCard
            title="People"
            action={
              customer.kind === "customer" && canReassign ? (
                <button
                  type="button"
                  onClick={() => setAmOpen(true)}
                  className="flex-none cursor-pointer border-none bg-transparent p-0 text-[12px] font-medium whitespace-nowrap text-brand hover:text-brand-hover"
                >
                  Change sales / back office
                </button>
              ) : null
            }
          >
            {/*
              Whose book this is. NO fallback to `ownerName` for a customer:
              `SALES_AM_NAME_SQL` already carries it for an account nobody
              decided about, and redoing it here would re-show the importer's
              name on one somebody deliberately emptied. A lead answers to its
              owner, which is what `ASSIGNED_TO_SQL` reads for one.
            */}
            <dl className={FACTS}>
              {customer.kind === "lead" ? (
                <Fact label="Lead owner" value={customer.ownerName} />
              ) : (
                <Fact label="Sales" value={customer.salesAmName} />
              )}
              <dt className="whitespace-nowrap text-muted">Sales manager</dt>
              <dd className="m-0 flex min-w-0 flex-wrap items-center justify-between gap-x-2 break-words text-ink">
                <span>{customer.salesManagerName ?? <span className="text-muted">-</span>}</span>
                {canAssignSalesManager ? (
                  <button
                    type="button"
                    onClick={() => setSmOpen(true)}
                    className="flex-none cursor-pointer border-none bg-transparent p-0 text-[12px] font-medium whitespace-nowrap text-brand hover:text-brand-hover"
                  >
                    Edit
                  </button>
                ) : null}
              </dd>
              {customer.kind === "customer" ? (
                <>
                  <Fact label="Back office" value={customer.backOfficeAmName} />
                  {/* "Not handed over" in words: a real, actionable state,
                      not missing data. */}
                  <dt className="whitespace-nowrap text-muted">Relationship</dt>
                  <dd className="m-0 flex min-w-0 flex-wrap items-center justify-between gap-x-2 break-words text-ink">
                    <span>
                      {customer.relationshipOwnerName ?? (
                        <span className="text-muted">Not handed over</span>
                      )}
                    </span>
                    {canHandOver ? (
                      <button
                        type="button"
                        onClick={() => setHoOpen(true)}
                        className="flex-none cursor-pointer border-none bg-transparent p-0 text-[12px] font-medium whitespace-nowrap text-brand hover:text-brand-hover"
                      >
                        {customer.relationshipOwnerName ? "Move" : "Hand over"}
                      </button>
                    ) : null}
                  </dd>
                </>
              ) : null}
            </dl>
            {/* Who it was before, and why it moved — the question people ask
                after a resignation. Folded: it is history, not the answer. */}
            {amChanges.length ? (
              <div className="mt-3 border-t border-divider pt-2.5">
                <button
                  type="button"
                  onClick={() => setHistoryOpen((o) => !o)}
                  className="cursor-pointer border-none bg-transparent p-0 text-[12px] text-brand"
                  aria-expanded={historyOpen}
                >
                  {historyOpen ? "Hide" : "Show"} manager history ({amChanges.length})
                </button>
                {historyOpen ? (
                  <div className="mt-2 space-y-1.5">
                    {amChanges.map((c) => (
                      <div key={c.id} className="text-[12px] leading-[18px] text-muted">
                        <span className="text-body">
                          {seatLabel(c.role)}: {c.fromName ?? "unassigned"} → {c.toName ?? "unassigned"}
                        </span>
                        <span className="block">
                          {shortDate(c.changedAt)} · {c.reasonCode}
                          {c.note ? ` — ${c.note}` : ""}
                          {c.changedBy ? ` · ${c.changedBy}` : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </SideCard>

          <SideCard title="Details">
            <dl className={FACTS}>
              {customer.kind === "lead" ? (
                <>
                  <Fact label="Lead since" value={shortDate(customer.createdAt)} />
                  <Fact label="Source" value={customer.leadSource} />
                </>
              ) : (
                <Fact
                  label="Customer since"
                  value={customer.customerSince ? shortDate(customer.customerSince) : null}
                />
              )}
              <Fact label="GSTIN" value={customer.gstin} />
              <Fact label="Credit terms" value={`${customer.creditTermDays} days`} />
              <Fact label="Grade" value={customer.grade} />
              <Fact label="Dealer code" value={customer.dealerCode} />
              <Fact label="Territory" value={customer.territoryRegion} />
              <Fact label="Area" value={customer.area} />
              <Fact label="Route" value={customer.route} />
              {/* Only what somebody recorded: "Billed by X" reads as a fact
                  somebody stands behind. */}
              {/* What this account is, in full — the badge says it in two
                  words; the kind underneath explains why a third-party
                  customer can still be invoiced one day. */}
              {customer.thirdParty ? (
                <Fact
                  label="Type"
                  value={`Third-party customer — we deliver, a distributor bills. Underneath, still a ${customer.kind}.`}
                />
              ) : null}
              {customer.doNotContact ? <Fact label="Standing" value="Do not contact" /> : null}
              {customer.whatsappDnd ? (
                <Fact
                  label="WhatsApp"
                  value={`DND${customer.whatsappDndReason ? ` — ${customer.whatsappDndReason}` : ""}`}
                />
              ) : null}
              {customer.thirdParty ? (
                <Fact label="Billed by" value={billedBy(distributors)} />
              ) : customer.kind === "customer" && deliveryAddresses.length ? (
                <Fact
                  label="Delivers to"
                  value={`${deliveryAddresses.filter((d) => d.recorded).length} recorded of ${deliveryAddresses.length} seen`}
                />
              ) : null}
            </dl>
          </SideCard>
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

      {/* Mounted only while open, like the dialog above it — that is how every
          modal here gets fresh initial state without an effect resetting it,
          which the React Compiler rules forbid. */}
      {hoOpen ? (
        <HandoverDialog
          open
          accounts={[
            {
              id: customer.id,
              name: customer.name,
              kind: customer.kind,
              relationshipOwnerName: customer.relationshipOwnerName,
            },
          ]}
          people={backOfficePeople.filter((p) => p.role !== "employee")}
          reasons={amReasons}
          searchThreshold={amSearchThreshold}
          onClose={() => setHoOpen(false)}
          onSubmit={async (change) => {
            const result = await run(
              handOverRelationships({
                customerIds: change.ids,
                toUserId: change.toUserId,
                reasonCode: change.reasonCode,
                note: change.note,
              }),
            );
            if (result.ok) {
              setHoOpen(false);
              router.refresh();
            }
          }}
        />
      ) : null}

      {calling ? (
        <CallPanel
          target={callTarget}
          customerId={customer.id}
          discountAuthority={discountAuthority}
          gstBp={gstBp}
          useListForOrderValue={useListForOrderValue}
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

      {/* The SAME dialog the complaints screen opens — photographs, the
        * mobile number and the Request CN answer included. What it does not
        * do here is ask who the complaint is about: we are standing on that
        * customer's record, so the answer is handed over rather than
        * searched for. */}
      <LogComplaintDialog
        open={cmpOpen}
        categories={categories}
        maxImages={maxComplaintImages}
        customer={{
          id: customer.id,
          name: customer.name,
          phone: customer.phone,
        }}
        onClose={() => setCmpOpen(false)}
        onSubmit={async (input) => {
          const result = await run(logComplaint(input));
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
  const bookNote = bookUnchangedNote({
    changingSales: salesMoved,
    changingBackOffice: backOfficeMoved,
    salesHolder: customer.salesAmName ?? null,
  });

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
      {/*
        THE BOOK HAS NOT MOVED, SAID OUT LOUD. Moving the paperwork seat and
        leaving the book behind is an ordinary thing to do and is never
        refused — but it is also exactly what happened on forty-two accounts
        under the reason "Salesperson left", with nothing on this form saying
        the salesperson still had them. The sentence is shared, because there
        are three dialogs that can do this.
      */}
      {bookNote ? (
        <p className="mt-3 rounded-[4px] border border-warn-line bg-warn-soft px-3 py-2 text-[12px] text-warn-ink">
          {bookNote}
        </p>
      ) : null}
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
function Fact({
  label,
  value,
  title,
}: {
  label: string;
  value: string | number | null;
  /** The longer explanation, on hover, where the value is the short form. */
  title?: string;
}) {
  return (
    <>
      <dt className="text-muted whitespace-nowrap">{label}</dt>
      <dd className="m-0 min-w-0 break-words text-ink" title={title}>
        {value === null || value === "" ? <span className="text-muted">-</span> : value}
      </dd>
    </>
  );
}

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

/**
 * A tab's list, at a fixed height whose CONTENTS scroll — the more history an
 * account has, the more of its record must still be reachable, so nothing
 * here grows the page.
 */
function TabList({
  count,
  shown,
  empty,
  children,
}: {
  count: number;
  /** How many are rendered, where fewer than the count — said, never silent. */
  shown?: number;
  empty: string;
  children: React.ReactNode;
}) {
  if (count === 0) return <p className="m-0 px-5 py-8 text-sm text-muted">{empty}</p>;
  return (
    <div className="max-h-[600px] overflow-y-auto px-5 py-2">
      {children}
      {shown !== undefined && shown < count ? (
        <div className="border-t border-divider py-2.5 text-[12px] text-muted">
          Newest {shown} of {count.toLocaleString("en-IN")}
        </div>
      ) : null}
    </div>
  );
}

/** The heading over one half of a split tab, with the true count. */
function SubHead({
  title,
  count,
  shown,
  right,
}: {
  title: string;
  count: number;
  shown?: number;
  right?: React.ReactNode;
}) {
  const capped = shown !== undefined && shown < count;
  return (
    <div className="flex items-center gap-2 border-b border-divider bg-canvas px-5 py-2">
      <span className="text-[13px] font-semibold text-ink">{title}</span>
      <span className="text-[12px] text-muted">
        {count === 0 ? "none" : capped ? `newest ${shown} of ${count}` : count}
      </span>
      {right ? (
        <>
          <span className="flex-1" />
          {right}
        </>
      ) : null}
    </div>
  );
}

/** A titled card in the side column. */
function SideCard({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="px-5 py-4">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <span className="text-[13px] font-semibold text-ink">{title}</span>
        {action}
      </div>
      {children}
    </Card>
  );
}

/** One of the five numbers under the header. */
function Tile({
  label,
  value,
  sub,
  tone,
  subTone,
  progress,
  link,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  tone?: "danger" | "success";
  subTone?: "danger";
  /** 0–100, drawn as a bar under the value — the target tile. */
  progress?: number | null;
  /** Where to go for the whole of what this number summarises. */
  link?: { href: string; label: string };
}) {
  return (
    <Card className="px-4 py-3">
      <div className="text-[12px] font-medium text-muted">{label}</div>
      <div
        className={cx(
          "mt-0.5 text-[20px] leading-7 font-semibold",
          tone === "danger" ? "text-danger" : tone === "success" ? "text-success" : "text-ink",
        )}
      >
        {value}
      </div>
      {progress !== undefined && progress !== null ? (
        <div className="mt-1.5 flex items-center gap-2">
          <Progress value={progress} className="flex-1" />
          <span className="text-[12px] font-medium text-ink">{progress}%</span>
        </div>
      ) : null}
      {sub ? (
        <div className={cx("mt-0.5 text-[12px]", subTone === "danger" ? "text-danger" : "text-muted")}>
          {sub}
        </div>
      ) : null}
      {link ? (
        <Link href={link.href} className="mt-1 inline-block text-[12px] text-brand no-underline">
          {link.label}
        </Link>
      ) : null}
    </Card>
  );
}

/**
 * "sent_manually" → "sent manually". Timeline meta carries stored codes beside
 * real words; a code is not a label, and only snake_case tokens are touched so
 * a bill number or a UTR is never rewritten.
 */
function readableMeta(meta: string): string {
  return meta.replace(/\b[a-z]+(?:_[a-z]+)+\b/g, (code) => code.replace(/_/g, " "));
}

/** A row of the lists inside the tabs. */
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
