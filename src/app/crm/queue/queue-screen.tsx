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
import { CallPanel, type CallTarget } from "@/components/crm/call-panel";
import { rebuildQueue, restoreWorkedRows, skipQueueItem } from "@/lib/actions/crm";
import { money, phoneDisplay, shortDate } from "@/lib/format";

type Row = {
  id: string;
  customerId: string;
  name: string;
  contactPerson: string;
  phone: string;
  reason: string;
  worked: boolean;
  skipped: boolean;
  heldBackReason: string | null;
  outstanding: number;
  slowPayer: boolean;
  lastOrderDate: string | null;
  lastNote: string | null;
  hasComplaint: boolean;
};

type Filter = "todo" | "all" | "worked" | "overdue" | "complaints";

const REASON_TONE: Record<string, "danger" | "warn" | "brand" | "neutral"> = {
  "Open complaint": "danger",
  "Payment overdue": "danger",
  "Reminder due": "warn",
  "Payment follow-up": "warn",
  "Gone quiet": "neutral",
  "Due to reorder": "brand",
};

export function QueueScreen({
  scopeLabel,
  rows,
  callTargets,
  activity,
}: {
  scopeLabel: string;
  rows: Row[];
  callTargets: Record<string, CallTarget>;
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

  const [filter, setFilter] = React.useState<Filter>("todo");
  const [selectedRaw, setSelected] = React.useState(0);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [heldOpen, setHeldOpen] = React.useState(false);
  const [skipping, setSkipping] = React.useState<Row | null>(null);
  const [busy, setBusy] = React.useState(false);

  const held = rows.filter((r) => r.skipped);
  const active = rows.filter((r) => !r.skipped);
  const worked = active.filter((r) => r.worked).length;
  const total = active.length;

  // Clamped during render — the list shrinks as rows get worked.
  const visibleRef = React.useMemo(() => {
    switch (filter) {
      case "todo":
        return active.filter((r) => !r.worked);
      case "worked":
        return active.filter((r) => r.worked);
      case "overdue":
        return active.filter((r) => r.reason === "Payment overdue" && !r.worked);
      case "complaints":
        return active.filter((r) => r.hasComplaint && !r.worked);
      default:
        return active;
    }
  }, [active, filter]);

  const visible = visibleRef;
  const selected = Math.min(selectedRaw, Math.max(0, visible.length - 1));

  // j / k / Enter — the whole queue can be worked without touching the mouse.
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
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
  const nextUnworked = visible.findIndex((r) => !r.worked && r.customerId !== openId);

  function advance() {
    const remaining = visible.filter((r) => !r.worked && r.customerId !== openId);
    if (remaining.length) {
      setOpenId(remaining[0].customerId);
      setSelected(visible.indexOf(remaining[0]));
    } else {
      setOpenId(null);
    }
  }

  return (
    <div className="max-w-[1400px] px-6 pt-6 pb-10">
      <PageHeader
        title="Call queue"
        subtitle={`${scopeLabel} · Worked top to bottom. The first row is your next call.`}
        actions={
          <>
            <Button
              variant="secondary"
              disabled={busy}
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
              onClick={() => visible[selected] && setOpenId(visible[selected].customerId)}
            >
              {visible[selected] ? `Call ${visible[selected].name}` : "Queue clear"}
            </Button>
          </>
        }
      />

      <Card className="mb-4 flex items-center gap-5 px-5 py-3.5">
        <span className="text-lg font-semibold text-ink">
          {worked} of {total} worked
        </span>
        <Progress
          value={total ? Math.round((worked / total) * 100) : 0}
          className="max-w-[320px] flex-1"
        />
        <span className="text-[13px] font-medium text-body">
          {total ? Math.round((worked / total) * 100) : 0}%
        </span>
        <span className="h-5 w-px bg-divider" />
        <span className="text-[13px] text-muted">
          Queue rebuilds from the book whenever you press Re-prioritise
        </span>
      </Card>

      <MetricStrip
        metrics={[
          { label: "Connected today", value: String(activity.connected), sub: `of ${activity.attempted} attempted` },
          { label: "Connect rate", value: `${activity.connectRate}%` },
          { label: "Missed", value: String(activity.missed), tone: activity.missed > 5 ? "danger" : "ink" },
          { label: "Orders today", value: String(activity.orders) },
          { label: "Booked today", value: money(activity.orderValue) },
        ]}
      />

      <div className="mb-3 flex items-center gap-2">
        <FilterPills
          value={filter}
          onChange={setFilter}
          options={[
            { key: "todo", label: "To work", count: active.filter((r) => !r.worked).length },
            { key: "overdue", label: "Payment overdue", count: active.filter((r) => r.reason === "Payment overdue" && !r.worked).length },
            { key: "complaints", label: "Has complaint", count: active.filter((r) => r.hasComplaint && !r.worked).length },
            { key: "worked", label: "Worked", count: worked },
            { key: "all", label: "All", count: active.length },
          ]}
        />
        <span className="flex-1" />
        <span className="text-[13px] text-muted">
          j / k to move · Enter to open the call panel
        </span>
      </div>

      {held.length ? (
        <Card className="mb-3">
          <button
            onClick={() => setHeldOpen((o) => !o)}
            className="flex w-full cursor-pointer items-center gap-2 px-4 py-2.5 text-left"
          >
            <Icon
              name="chevron"
              size={16}
              className={cx("text-muted transition-transform", heldOpen && "rotate-90")}
            />
            <span className="text-sm text-muted">
              {held.length} customer{held.length === 1 ? "" : "s"} held back today
            </span>
            <span className="flex-1" />
            <span className="text-[13px] text-muted">
              Nothing disappears silently — open this if somebody is missing
            </span>
          </button>
          {heldOpen ? (
            <div className="border-t border-divider py-1 pr-4 pl-10">
              {held.map((h) => (
                <div
                  key={h.id}
                  className="flex items-center gap-3 border-b border-canvas py-1.5 last:border-0"
                >
                  <Link
                    href={`/crm/customers/${h.customerId}`}
                    className="w-[260px] text-sm text-body"
                  >
                    {h.name}
                  </Link>
                  <span className="text-[13px] text-muted">
                    {h.heldBackReason ?? "Held back"}
                  </span>
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
              key={r.id}
              onClick={() => setSelected(i)}
              onDoubleClick={() => setOpenId(r.customerId)}
              className={cx(
                "flex cursor-pointer items-center gap-4 border-b border-divider px-5 py-3 last:border-0",
                i === selected ? "bg-brand-soft/50" : "hover:bg-canvas",
                r.worked && "opacity-60",
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
                  <Badge tone={REASON_TONE[r.reason] ?? "neutral"}>{r.reason}</Badge>
                  {r.slowPayer ? <SlowPayerBadge /> : null}
                  {r.worked ? <Badge tone="success">Worked</Badge> : null}
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
                  variant={r.worked ? "secondary" : "primary"}
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenId(r.customerId);
                  }}
                >
                  {r.worked ? "Log again" : "Call"}
                </Button>
                <RowMenu
                  items={[
                    {
                      label: "Open customer record",
                      onSelect: () => router.push(`/crm/customers/${r.customerId}`),
                    },
                    {
                      label: "Send WhatsApp instead",
                      onSelect: () =>
                        router.push(`/crm/whatsapp?customer=${r.customerId}`),
                    },
                    {
                      label: "See their bills",
                      onSelect: () => router.push(`/crm/bills?customer=${r.customerId}`),
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
        ) : filter === "todo" && total > 0 ? (
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
                <Button
                  variant="secondary"
                  onClick={async () => {
                    await run(restoreWorkedRows());
                    router.refresh();
                  }}
                >
                  Restore worked rows
                </Button>
              </>
            }
          />
        ) : (
          <EmptyState
            title="Nothing in this filter"
            body="Nobody in your book matches it right now. Press Re-prioritise to rebuild the queue from the current state of the book."
          />
        )}
      </Card>

      <CallPanel
        target={openTarget}
        hasNext={nextUnworked !== -1}
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
          await run(skipQueueItem(skipping.id, reason));
          router.refresh();
        }}
      />
    </div>
  );
}
