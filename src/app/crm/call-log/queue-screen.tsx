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
import { ConfirmDialog, FilterPills, RowMenu } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { Icon } from "@/components/shell/icons";
import {
  CallPanel,
  type CallTarget,
  type ProductOption,
  type QuickNoteOption,
  type ScriptOption,
} from "@/components/crm/call-panel";
import { rebuildQueue, skipQueueItem } from "@/lib/actions/crm";
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
};

type Suppressed = { customerId: string; name: string; reason: string };

type Filter =
  "all" | "orders" | "complaints" | "reminders" | "checkins" | "leads";

/** The engine's own reason kinds — nothing here invents a category. */
const REASON_TONE: Record<string, "danger" | "warn" | "brand" | "neutral"> = {
  reminderOverdue: "danger",
  reminderDueToday: "warn",
  orderOverdueFullCycle: "danger",
  orderDue: "brand",
  orderDueSoon: "brand",
  checkInOverdue: "warn",
  checkInDue: "neutral",
};

const REMINDER_KINDS = ["reminderOverdue", "reminderDueToday"];
const ORDER_KINDS = ["orderOverdueFullCycle", "orderDue", "orderDueSoon"];
const CHECKIN_KINDS = ["checkInOverdue", "checkInDue"];

export function QueueScreen({
  scopeLabel,
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
  searchEnabled,
  userName,
  products,
  scripts,
}: {
  scopeLabel: string;
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
  const [selectedRaw, setSelected] = React.useState(0);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [heldOpen, setHeldOpen] = React.useState(false);
  const [skipping, setSkipping] = React.useState<Row | null>(null);
  const [busy, setBusy] = React.useState(false);

  // The queue is computed on request: a customer who has been called today is
  // simply no longer a candidate, so there is no "worked" row state to hold.
  const hasAny = (r: Row, kinds: string[]) =>
    r.reasons.some((x) => kinds.includes(x.kind));

  const visibleRef = React.useMemo(() => {
    switch (filter) {
      case "orders":
        return rows.filter((r) => hasAny(r, ORDER_KINDS));
      case "complaints":
        return rows.filter((r) => r.hasComplaint);
      case "reminders":
        return rows.filter((r) => hasAny(r, REMINDER_KINDS));
      case "checkins":
        return rows.filter((r) => hasAny(r, CHECKIN_KINDS));
      case "leads":
        return rows.filter((r) => r.kind === "lead");
      default:
        return rows;
    }
  }, [rows, filter]);

  const visible = visibleRef;
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

      <div className="mb-3 flex items-center gap-2">
        <FilterPills
          value={filter}
          onChange={setFilter}
          options={[
            { key: "all", label: "To work", count: rows.length },
            {
              key: "reminders",
              label: "Reminder due",
              count: rows.filter((r) => hasAny(r, REMINDER_KINDS)).length,
            },
            {
              key: "orders",
              label: "Due to reorder",
              count: rows.filter((r) => hasAny(r, ORDER_KINDS)).length,
            },
            {
              key: "checkins",
              label: "Check-in due",
              count: rows.filter((r) => hasAny(r, CHECKIN_KINDS)).length,
            },
            {
              key: "leads",
              label: "Leads",
              count: rows.filter((r) => r.kind === "lead").length,
            },
            {
              key: "complaints",
              label: "Has complaint",
              count: rows.filter((r) => r.hasComplaint).length,
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
                  {r.kind === "lead" ? <Badge tone="brand">Lead</Badge> : null}
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
        ) : filter === "all" ? (
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
          <EmptyState
            title="Nothing in the log matches that filter"
            body="Clear it to see everyone still to work today."
          />
        )}
      </Card>

      <CallPanel
        target={openTarget}
        complaintCategories={categories}
        quickNotes={quickNotes}
        singleSelectOutcomes={singleSelectOutcomes}
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
