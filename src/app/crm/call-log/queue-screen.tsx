"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  MetricStrip,
  PageHeader,
  Progress,
  SlowPayerBadge,
  cx,
} from "@/components/ui/primitives";
import {
  ConfirmDialog,
  FilterPills,
  RowMenu,
  SegmentedControl,
} from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { Icon } from "@/components/shell/icons";
import {
  CallPanel,
  type CallTarget,
  type ProductOption,
  type QuickNoteOption,
  type ScriptOption,
} from "@/components/crm/call-panel";
import {
  rebuildQueue,
  setQueueAudience,
  skipQueueItem,
} from "@/lib/actions/crm";
import { audienceLabel, type QueueAudience } from "@/lib/queue-audience";
import { money, phoneDisplay, shortDate } from "@/lib/format";

type Reason = { kind: string; label: string; weight: number };

type Row = {
  customerId: string;
  name: string;
  contactPerson: string;
  phone: string;
  score: number;
  /** Every reason the customer qualified, strongest first. */
  reasons: Reason[];
  daysSinceContact: number | null;
  outstanding: number;
  kind: "lead" | "customer";
  slowPayer: boolean;
  lastOrderDate: string | null;
  lastNote: string | null;
  hasComplaint: boolean;
  /** Whose call it is. Null where the record answers to nobody. */
  assignedToName: string | null;
};

type Suppressed = { customerId: string; name: string; reason: string };

/**
 * WHY a call is due. Who it is due for is the other axis, and it is a
 * `QueueAudience` rather than a value in here — folding the two together is
 * what made "Leads" read as an alternative to "Payment due".
 */
type Filter =
  | "all"
  | "orders"
  | "complaints"
  | "reminders"
  | "checkins"
  | "payments"
  | "retry";

/** The engine's own reason kinds — nothing here invents a category. */
const REASON_TONE: Record<string, "danger" | "warn" | "brand" | "neutral"> = {
  paymentOverdue: "danger",
  reminderOverdue: "danger",
  reminderDueToday: "warn",
  orderOverdueFullCycle: "danger",
  orderDue: "brand",
  routineCall: "brand",
  checkInOverdue: "warn",
  checkInDue: "neutral",
  unreachable: "warn",
  noAnswerRetry: "neutral",
  orderStatus: "neutral",
};

const REMINDER_KINDS = ["reminderOverdue", "reminderDueToday"];
const ORDER_KINDS = ["orderOverdueFullCycle", "orderDue", "routineCall"];
const CHECKIN_KINDS = ["checkInOverdue", "checkInDue"];
const PAYMENT_KINDS = ["paymentOverdue"];
const RETRY_KINDS = ["noAnswerRetry", "unreachable"];

export function QueueScreen({
  scopeLabel,
  showAssignee,
  audience: savedAudience,
  rows,
  suppressed,
  progress,
  carriedOver,
  snapshotHour,
  callTargets,
  activity,
  categories,
  quickNotes,
  singleSelectOutcomes,
  maxComplaintImages,
  searchEnabled,
  userName,
  products,
  scripts,
}: {
  scopeLabel: string;
  /** Team view: every row belongs to somebody, so every row says who. */
  showAssignee: boolean;
  /** The half of the book this person last chose to work. */
  audience: QueueAudience;
  rows: Row[];
  suppressed: Suppressed[];
  progress: { worked: number; total: number; percent: number };
  carriedOver: number | null;
  snapshotHour: number;
  callTargets: Record<string, CallTarget>;
  /** Complaint categories, from configuration rather than a constant. */
  categories: Array<{ value: string; label: string }>;
  quickNotes: QuickNoteOption[];
  singleSelectOutcomes: string[];
  maxComplaintImages: number;
  /** products.searchOnOrderForms — checked here as well as in the API. */
  searchEnabled: boolean;
  /** The signed-in telecaller, for script placeholders. */
  userName: string;
  products: ProductOption[];
  scripts: ScriptOption[];
  activity: {
    connected: number;
    attempted: number;
    missed: number;
    orders: number;
    orderValue: number;
    connectRate: number;
  };
}) {
  const router = useRouter();
  const { run } = useToast();

  const [filter, setFilter] = React.useState<Filter>("all");
  const [audience, setAudience] = React.useState<QueueAudience>(savedAudience);
  const [selectedRaw, setSelected] = React.useState(0);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [heldOpen, setHeldOpen] = React.useState(false);
  const [skipping, setSkipping] = React.useState<Row | null>(null);
  const [busy, setBusy] = React.useState(false);

  // The queue is computed on request: a customer who has been called today is
  // simply no longer a candidate, so there is no "worked" row state to hold.
  const hasAny = (r: Row, kinds: string[]) =>
    r.reasons.some((x) => kinds.includes(x.kind));

  // Who first, why second. Every count below is taken from this rather than
  // from `rows`, because a pill reading "Payment due 12" over a list narrowed
  // to leads is the screen stating a figure it is not showing.
  const inAudience = React.useMemo(
    () =>
      audience === "all"
        ? rows
        : rows.filter((r) =>
            audience === "leads" ? r.kind === "lead" : r.kind !== "lead",
          ),
    [rows, audience],
  );

  const visible = React.useMemo(() => {
    switch (filter) {
      case "orders":
        return inAudience.filter((r) => hasAny(r, ORDER_KINDS));
      case "complaints":
        return inAudience.filter((r) => r.hasComplaint);
      case "reminders":
        return inAudience.filter((r) => hasAny(r, REMINDER_KINDS));
      case "payments":
        return inAudience.filter((r) => hasAny(r, PAYMENT_KINDS));
      case "retry":
        return inAudience.filter((r) => hasAny(r, RETRY_KINDS));
      case "checkins":
        return inAudience.filter((r) => hasAny(r, CHECKIN_KINDS));
      default:
        return inAudience;
    }
  }, [inAudience, filter]);
  const selected = Math.min(selectedRaw, Math.max(0, visible.length - 1));

  // j / k / Enter — the whole queue can be worked without touching the mouse.
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable)
      ) {
        return;
      }
      if (openId) return;

      if (e.key === "j") {
        e.preventDefault();
        setSelected((s) => Math.min(s + 1, visible.length - 1));
      } else if (e.key === "k") {
        e.preventDefault();
        setSelected((s) => Math.max(s - 1, 0));
      } else if (e.key === "Enter" && visible[selected]) {
        e.preventDefault();
        setOpenId(visible[selected].customerId);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [visible, selected, openId]);

  const openTarget = openId ? (callTargets[openId] ?? null) : null;
  // Where the open customer sits in the list, so the modal's Previous/Next
  // walk the queue in the order it is shown rather than in save order.
  const openIndex = visible.findIndex((r) => r.customerId === openId);
  const hasPrevious = openIndex > 0;
  const hasNext = openIndex !== -1 && openIndex < visible.length - 1;

  function goTo(index: number) {
    const row = visible[index];
    if (!row) return;
    setOpenId(row.customerId);
    setSelected(index);
  }

  function advance() {
    // After a save the worked row drops out on the next load, so stepping
    // forward means the same index, not the next one.
    if (hasNext) goTo(openIndex + 1);
    else setOpenId(null);
  }

  return (
    <div className="max-w-[1440px] px-6 pt-6 pb-10">
      <PageHeader
        title="Call Log"
        subtitle={`${scopeLabel} · Worked top to bottom. The first row is your next call - log an inbound call or an order that arrived without one from any row.`}
        actions={
          <>
            <Button
              variant="secondary"
              disabled={busy}
              title="The queue is recomputed on every load - this just re-reads it"
              onClick={async () => {
                setBusy(true);
                await run(rebuildQueue());
                setBusy(false);
                router.refresh();
              }}
            >
              Re-prioritise
            </Button>
            <Button
              variant="primary"
              disabled={!visible.length}
              title={
                visible.length
                  ? "Open the selected row"
                  : "Nothing left in this filter"
              }
              onClick={() =>
                visible[selected] && setOpenId(visible[selected].customerId)
              }
            >
              {visible[selected]
                ? `Call ${visible[selected].name}`
                : "Queue clear"}
            </Button>
          </>
        }
      />

      <Card className="mb-4 flex items-center gap-5 px-5 py-3.5">
        <span className="text-lg font-semibold text-ink">
          {progress.worked} of {progress.total} worked
        </span>
        <Progress value={progress.percent} className="max-w-[320px] flex-1" />
        <span className="text-[13px] font-medium text-body">
          {progress.percent}%
        </span>
        <span className="h-5 w-px bg-divider" />
        <span className="text-[13px] text-muted">
          {carriedOver === null
            ? "Computed fresh on every load from the current state of the book"
            : `${carriedOver} ${carriedOver === 1 ? "row" : "rows"} carried over from the previous working day · list settles at ${hourLabel(snapshotHour)}`}
        </span>
      </Card>

      <MetricStrip
        metrics={[
          {
            label: "Connected today",
            value: String(activity.connected),
            sub: `of ${activity.attempted} attempted`,
          },
          { label: "Connect rate", value: `${activity.connectRate}%` },
          {
            label: "Missed",
            value: String(activity.missed),
            tone: activity.missed > 5 ? "danger" : "ink",
          },
          { label: "Orders today", value: String(activity.orders) },
          { label: "Booked today", value: money(activity.orderValue) },
        ]}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SegmentedControl
          label="Calling"
          value={audience}
          onChange={(next) => {
            // The rows are already here, so the narrowing is immediate and the
            // cookie is only written for the next load — nothing waits on it.
            setAudience(next);
            setSelected(0);
            void setQueueAudience(next).catch(() => {
              /* a display preference that failed to stick is not worth a toast
                 mid-call — the screen has already done what was asked */
            });
          }}
          options={[
            { key: "all", label: "Everyone", count: rows.length },
            {
              key: "leads",
              label: "Leads",
              count: rows.filter((r) => r.kind === "lead").length,
            },
            {
              key: "customers",
              label: "Customers",
              count: rows.filter((r) => r.kind !== "lead").length,
            },
          ]}
        />
        <FilterPills
          value={filter}
          onChange={setFilter}
          options={[
            { key: "all", label: "To work", count: inAudience.length },
            {
              key: "payments",
              label: "Payment due",
              count: inAudience.filter((r) => hasAny(r, PAYMENT_KINDS)).length,
            },
            {
              key: "reminders",
              label: "Reminder due",
              count: inAudience.filter((r) => hasAny(r, REMINDER_KINDS)).length,
            },
            {
              key: "retry",
              label: "No answer",
              count: inAudience.filter((r) => hasAny(r, RETRY_KINDS)).length,
            },
            {
              key: "orders",
              label: "Due to reorder",
              count: inAudience.filter((r) => hasAny(r, ORDER_KINDS)).length,
            },
            {
              key: "checkins",
              label: "Check-in due",
              count: inAudience.filter((r) => hasAny(r, CHECKIN_KINDS)).length,
            },
            {
              key: "complaints",
              label: "Has complaint",
              count: inAudience.filter((r) => r.hasComplaint).length,
            },
          ]}
        />
        <span className="flex-1" />
        <span className="text-[13px] text-muted">
          j / k to move · Enter to open the call panel
        </span>
      </div>

      {suppressed.length ? (
        <Card className="mb-3">
          <button
            onClick={() => setHeldOpen((o) => !o)}
            className="flex w-full cursor-pointer items-center gap-2 px-4 py-2.5 text-left"
          >
            <Icon
              name="chevron"
              size={16}
              className={cx(
                "text-muted transition-transform",
                heldOpen && "rotate-90",
              )}
            />
            <span className="text-sm text-muted">
              {suppressed.length} customer{suppressed.length === 1 ? "" : "s"}{" "}
              held back today
            </span>
            <span className="flex-1" />
            <span className="text-[13px] text-muted">
              Nothing disappears silently - open this if somebody is missing
            </span>
          </button>
          {heldOpen ? (
            <div className="border-t border-divider py-1 pr-4 pl-10">
              {suppressed.map((h) => (
                <div
                  key={h.customerId}
                  className="flex items-center gap-3 border-b border-canvas py-1.5 last:border-0"
                >
                  <Link
                    href={`/crm/customers/${h.customerId}`}
                    className="w-[260px] text-sm text-body"
                  >
                    {h.name}
                  </Link>
                  <span className="text-[13px] text-muted">{h.reason}</span>
                </div>
              ))}
            </div>
          ) : null}
        </Card>
      ) : null}

      <Card className="overflow-hidden">
        {visible.length ? (
          visible.map((r, i) => (
            <div
              key={r.customerId}
              onClick={() => {
                // One click opens the call, the way the payment worklist does.
                // The row still becomes the selection, so j/k carries on from
                // wherever the mouse left off.
                setSelected(i);
                setOpenId(r.customerId);
              }}
              className={cx(
                "flex cursor-pointer items-center gap-4 border-b border-divider px-5 py-3 last:border-0",
                i === selected ? "bg-brand-soft/50" : "hover:bg-canvas",
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2.5">
                  <Link
                    href={`/crm/customers/${r.customerId}`}
                    onClick={(e) => e.stopPropagation()}
                    className="text-sm font-medium text-ink no-underline hover:underline"
                  >
                    {r.name}
                  </Link>
                  {/* Two overdue reminders are two reasons of the same kind,
                      each naming its own note, so the kind alone is not a key. */}
                  {r.reasons.map((reason, ri) => (
                    <Badge
                      key={`${reason.kind}:${ri}`}
                      tone={REASON_TONE[reason.kind] ?? "neutral"}
                    >
                      {reason.label}
                    </Badge>
                  ))}
                  {/* Under the Leads cut every row is one, so the badge is a
                      column of the same word repeated. */}
                  {r.kind === "lead" && audience !== "leads" ? (
                    <Badge tone="brand">Lead</Badge>
                  ) : null}
                  {r.slowPayer ? <SlowPayerBadge /> : null}
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[13px] text-muted">
                  <span>{r.contactPerson}</span>
                  <span>·</span>
                  <span>{phoneDisplay(r.phone)}</span>
                  <span>·</span>
                  <span>
                    Last order{" "}
                    {r.lastOrderDate ? shortDate(r.lastOrderDate) : "never"}
                  </span>
                  <span>·</span>
                  <span>
                    {r.daysSinceContact === null
                      ? "Never contacted"
                      : `Contacted ${r.daysSinceContact}d ago`}
                  </span>
                </div>
                <div className="mt-0.5 truncate text-[13px] text-muted">
                  {r.lastNote ? `Last note: ${r.lastNote}` : "No notes yet"}
                </div>
              </div>

              {showAssignee ? (
                <div className="w-[140px] flex-none">
                  <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                    Assigned to
                  </div>
                  <div
                    className={cx(
                      "truncate text-sm",
                      r.assignedToName ? "text-ink" : "text-muted",
                    )}
                    title={r.assignedToName ?? undefined}
                  >
                    {/* Unassigned is said, not left blank: a call nobody owns
                        is the one a manager most needs to see on this list. */}
                    {r.assignedToName ?? "Unassigned"}
                  </div>
                </div>
              ) : null}

              <div className="w-[120px] flex-none text-right">
                <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                  Outstanding
                </div>
                <div
                  className={cx(
                    "text-sm font-medium",
                    r.outstanding > 0 ? "text-danger" : "text-ink",
                  )}
                >
                  {money(r.outstanding)}
                </div>
              </div>

              <div className="flex flex-none items-center gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenId(r.customerId);
                  }}
                >
                  Call
                </Button>
                <RowMenu
                  items={[
                    {
                      label: "Open customer record",
                      onSelect: () =>
                        router.push(`/crm/customers/${r.customerId}`),
                    },
                    {
                      label: "Send WhatsApp instead",
                      onSelect: () =>
                        router.push(`/crm/whatsapp?customer=${r.customerId}`),
                    },
                    {
                      label: "See their bills",
                      onSelect: () =>
                        router.push(`/crm/bills?customer=${r.customerId}`),
                    },
                    {
                      label: "Skip for today",
                      destructive: true,
                      onSelect: () => setSkipping(r),
                    },
                  ]}
                />
              </div>
            </div>
          ))
        ) : filter === "all" && audience === "all" ? (
          <EmptyState
            icon={<Icon name="check" size={24} className="text-success" />}
            title="Queue cleared for today"
            body="Every customer due today has been worked. Suggested next work: the payment follow-up list, and the customers sitting on the inactive watch without a decision."
            action={
              <>
                <Link
                  href="/crm/payments"
                  className="inline-flex h-9 items-center rounded-[4px] border border-brand bg-brand px-4 text-sm font-medium text-white no-underline hover:bg-brand-hover hover:no-underline"
                >
                  Open payment follow-up
                </Link>
                <Link
                  href="/crm/inactive"
                  className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-4 text-sm font-medium text-body no-underline hover:bg-canvas hover:no-underline"
                >
                  Open the inactive watch
                </Link>
              </>
            }
          />
        ) : (
          // Three emptinesses, and the screen says which: no leads at all
          // today, no leads matching this reason, or nothing matching the
          // reason across the whole book. A blank list under two selections
          // otherwise reads as broken filtering rather than as an answer.
          <EmptyState
            title={
              filter === "all"
                ? `No ${audienceLabel(audience)} to work today`
                : `Nothing in the log matches that filter`
            }
            body={
              filter === "all"
                ? `The rest of the book still has ${rows.length - inAudience.length} to work — switch to Everyone to see them.`
                : audience === "all"
                  ? "Clear it to see everyone still to work today."
                  : `Nothing among the ${audienceLabel(audience)} matches it. Clear the filter, or switch to Everyone to look across the whole book.`
            }
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  setFilter("all");
                  setAudience("all");
                  setSelected(0);
                  void setQueueAudience("all").catch(() => {});
                }}
              >
                Show everyone still to work
              </Button>
            }
          />
        )}
      </Card>

      <CallPanel
        target={openTarget}
        complaintCategories={categories}
        quickNotes={quickNotes}
        singleSelectOutcomes={singleSelectOutcomes}
        maxComplaintImages={maxComplaintImages}
        searchEnabled={searchEnabled}
        userName={userName}
        products={products}
        scripts={scripts}
        hasNext={hasNext}
        hasPrevious={hasPrevious}
        onPrevious={() => goTo(openIndex - 1)}
        onNext={() => goTo(openIndex + 1)}
        position={
          openIndex >= 0
            ? `Customer ${openIndex + 1} of ${visible.length}`
            : undefined
        }
        queueTotal={progress.worked}
        queueComplete={visible.length === 0}
        onClose={() => setOpenId(null)}
        onSaved={(advanceNext) => {
          if (advanceNext) advance();
        }}
      />

      <ConfirmDialog
        open={Boolean(skipping)}
        title={`Skip ${skipping?.name ?? ""} for today?`}
        body="They stay in the book and come back tomorrow. The reason is kept on the record so nobody wonders why the queue got shorter."
        confirmLabel="Skip for today"
        needsReason
        reasonLabel="Why are you skipping"
        onClose={() => setSkipping(null)}
        onConfirm={async (reason) => {
          if (!skipping) return;
          await run(skipQueueItem(skipping.customerId, reason));
          router.refresh();
        }}
      />
    </div>
  );
}

/** "8 am" / "8:30 am" — the hour a telecaller would actually say. */
function hourLabel(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h} ${hour < 12 ? "am" : "pm"}`;
}
