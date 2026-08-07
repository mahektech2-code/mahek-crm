"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  MetricStrip,
  PageHeader,
  Select,
  Textarea,
  cx,
} from "@/components/ui/primitives";
import { Modal, RowMenu, Tabs } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import {
  cancelReminder,
  completeReminder,
  createReminder,
  rescheduleReminder,
} from "@/lib/actions/crm";
import { addDays, ageLabel, shortDate, today } from "@/lib/format";

import type { ReminderRow as Row } from "@/lib/services/worklist-services";

const TYPE_LABEL: Record<string, string> = {
  call_back: "call back",
  payment_promise: "payment promise",
  order_confirmation: "order confirmation",
  send_information: "information to send",
  check_stock: "stock check",
  other: "other",
};

type Tab = "today" | "overdue" | "upcoming" | "done" | "all";

function overdueByPerson(overdue: Row[]) {
  const map = new Map<string, { name: string; overdue: number; oldest: number }>();
  for (const r of overdue) {
    const entry = map.get(r.assignedUserName) ?? {
      name: r.assignedUserName,
      overdue: 0,
      oldest: 0,
    };
    entry.overdue += 1;
    entry.oldest = Math.max(entry.oldest, r.overdueDays);
    map.set(r.assignedUserName, entry);
  }
  return [...map.values()].sort((a, b) => b.overdue - a.overdue);
}

export function RemindersScreen({
  scopeLabel,
  isTeamView,
  rows,
  customers,
}: {
  scopeLabel: string;
  isTeamView: boolean;
  rows: Row[];
  customers: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const { run } = useToast();
  const t = today();

  const [tab, setTab] = React.useState<Tab>("today");
  const [newOpen, setNewOpen] = React.useState(false);
  const [rescheduling, setRescheduling] = React.useState<Row | null>(null);
  const [dismissing, setDismissing] = React.useState<Row | null>(null);

  // displayStatus is derived on the server against the business day. Deriving
  // it again here from a browser clock is how the two end up disagreeing.
  const buckets = {
    today: rows.filter((r) => r.displayStatus === "due_today"),
    overdue: rows.filter((r) => r.displayStatus === "overdue"),
    upcoming: rows.filter((r) => r.displayStatus === "upcoming"),
    done: rows.filter((r) => r.status !== "pending"),
    all: rows,
  };
  const visible = buckets[tab];

  const oldest = buckets.overdue.reduce(
    (a, r) => Math.max(a, r.overdueDays),
    0,
  );

  // Manager view: who is sitting on the overdue pile.
  const byPerson = overdueByPerson(buckets.overdue);

  return (
    <div className="max-w-[1200px] px-6 pt-6 pb-10">
      <PageHeader
        title="Reminders"
        subtitle={`${scopeLabel} · ${
          buckets.overdue.length
            ? `${buckets.overdue.length} overdue - the oldest by ${ageLabel(oldest)}.`
            : "Nothing overdue. Every promise is being kept on time."
        }`}
        actions={
          <Button variant="primary" onClick={() => setNewOpen(true)}>
            Set reminder
          </Button>
        }
      />

      <MetricStrip
        metrics={[
          { label: "Due today", value: String(buckets.today.length) },
          {
            label: "Overdue",
            value: String(buckets.overdue.length),
            tone: buckets.overdue.length ? "danger" : "ink",
            sub: oldest ? `oldest by ${ageLabel(oldest)}` : undefined,
          },
          { label: "Upcoming", value: String(buckets.upcoming.length) },
          { label: "Closed", value: String(buckets.done.length) },
        ]}
      />

      {isTeamView && byPerson.length ? (
        <Card className="mb-4">
          <div className="border-b border-divider px-3.5 py-3 text-xs font-medium tracking-[0.04em] text-muted uppercase">
            Overdue reminders by telecaller
          </div>
          {byPerson.map((p) => (
            <div
              key={p.name}
              className="flex items-center gap-3 border-b border-divider px-3.5 py-2.5 last:border-0"
            >
              <span className="w-[180px] text-sm text-ink">{p.name}</span>
              <span
                className={cx(
                  "inline-flex h-5 min-w-5 items-center justify-center rounded-[3px] px-1.5 text-[11px] font-medium",
                  p.overdue > 5
                    ? "bg-danger-soft text-danger"
                    : "bg-warn-soft text-warn-ink",
                )}
              >
                {p.overdue}
              </span>
              <span className="text-[13px] text-muted">
                overdue · oldest by {ageLabel(p.oldest)}
              </span>
            </div>
          ))}
        </Card>
      ) : null}

      <Card className="overflow-hidden">
        <Tabs
          value={tab}
          onChange={setTab}
          className="px-5"
          tabs={[
            { key: "today", label: "Due today", count: buckets.today.length },
            { key: "overdue", label: "Overdue", count: buckets.overdue.length },
            { key: "upcoming", label: "Upcoming", count: buckets.upcoming.length },
            { key: "done", label: "Closed", count: buckets.done.length },
            { key: "all", label: "All", count: rows.length },
          ]}
        />

        {visible.length ? (
          visible.map((r) => (
            <div
              key={r.id}
              className="flex items-center gap-4 border-b border-divider px-5 py-3.5 last:border-0 hover:bg-canvas"
            >
              <div className="w-[110px] flex-none">
                <div
                  className={cx(
                    "text-sm font-medium",
                    r.status !== "pending"
                      ? "text-muted"
                      : r.displayStatus === "overdue"
                        ? "text-danger"
                        : r.displayStatus === "due_today"
                          ? "text-ink"
                          : "text-body",
                  )}
                >
                  {shortDate(r.dueDate)}
                </div>
                {r.status === "pending" && r.overdueDays > 0 ? (
                  <div className="mt-0.5 text-[11px] text-danger">
                    {ageLabel(r.overdueDays)} late
                  </div>
                ) : null}
              </div>

              <div className="min-w-0 flex-1">
                <div
                  className={cx(
                    "text-[15px] leading-[21px]",
                    r.status === "pending" ? "text-ink" : "text-muted line-through",
                  )}
                >
                  {r.note}
                </div>
                <div className="mt-1 text-[13px] text-muted">
                  <Link
                    href={`/crm/customers/${r.customerId}`}
                    className="no-underline hover:underline"
                  >
                    {r.customerName}
                  </Link>
                  {isTeamView ? ` · ${r.assignedUserName}` : ""} ·{" "}
                  {TYPE_LABEL[r.type] ?? r.type}
                  {r.systemGenerated ? " · set by the system" : ""}
                  {r.rescheduledOften
                    ? ` · moved ${r.rescheduleCount} times`
                    : ""}
                </div>
              </div>

              {r.status === "pending" ? (
                <div className="flex flex-none items-center gap-2">
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={async () => {
                      await run(completeReminder(r.id));
                      router.refresh();
                    }}
                  >
                    Mark done
                  </Button>
                  <RowMenu
                    items={[
                      {
                        label: "Reschedule",
                        onSelect: () => setRescheduling(r),
                      },
                      {
                        label: "Carry forward to tomorrow",
                        onSelect: async () => {
                          await run(rescheduleReminder(r.id, addDays(t, 1)));
                          router.refresh();
                        },
                      },
                      {
                        label: "Open customer record",
                        onSelect: () => router.push(`/crm/customers/${r.customerId}`),
                      },
                      {
                        label: "Dismiss reminder",
                        destructive: true,
                        onSelect: () => setDismissing(r),
                      },
                    ]}
                  />
                </div>
              ) : (
                <Badge tone={r.status === "completed" ? "success" : "muted"}>
                  {r.status === "completed" ? "Done" : "Dismissed"}
                </Badge>
              )}
            </div>
          ))
        ) : (
          <EmptyState
            title="Nothing here"
            body="Reminders you set on a call will appear in this tab."
            action={
              <Button variant="primary" onClick={() => setNewOpen(true)}>
                Set reminder
              </Button>
            }
          />
        )}
      </Card>

      <NewReminderModal
        open={newOpen}
        customers={customers}
        onClose={() => setNewOpen(false)}
        onSubmit={async (customerId, dueDate, note) => {
          const result = await run(createReminder({ customerId, dueDate, note }));
          if (result.ok) {
            setNewOpen(false);
            router.refresh();
          }
        }}
      />

      <RescheduleModal
        reminder={rescheduling}
        onClose={() => setRescheduling(null)}
        onSubmit={async (dueDate, note) => {
          if (!rescheduling) return;
          const result = await run(rescheduleReminder(rescheduling.id, dueDate, note));
          if (result.ok) {
            setRescheduling(null);
            router.refresh();
          }
        }}
      />

      <DismissModal
        reminder={dismissing}
        onClose={() => setDismissing(null)}
        onSubmit={async (reason) => {
          if (!dismissing) return;
          const result = await run(cancelReminder(dismissing.id, reason));
          if (result.ok) {
            setDismissing(null);
            router.refresh();
          }
        }}
      />
    </div>
  );
}

/**
 * A reminder is never deleted, only dismissed with a reason — otherwise the
 * overdue pile can be cleared without anyone being able to ask why.
 */
function DismissModal({
  reminder,
  onClose,
  onSubmit,
}: {
  reminder: Row | null;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(false);

  return (
    <Modal
      open={Boolean(reminder)}
      onClose={onClose}
      title="Dismiss reminder"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep it
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={async () => {
              if (!reason.trim()) {
                setError(true);
                return;
              }
              setBusy(true);
              try {
                await onSubmit(reason);
                setReason("");
                setError(false);
              } finally {
                setBusy(false);
              }
            }}
          >
            Dismiss
          </Button>
        </>
      }
    >
      <div className="mb-3 text-sm text-muted">{reminder?.note}</div>
      <Field
        label="Why is this no longer needed?"
        error={error ? "Give a reason - this stays on the customer record." : null}
      >
        <Textarea
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setError(false);
          }}
          className="h-16"
          placeholder="Customer already paid, order cancelled, duplicate…"
        />
      </Field>
    </Modal>
  );
}

function NewReminderModal({
  open,
  customers,
  onClose,
  onSubmit,
}: {
  open: boolean;
  customers: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSubmit: (customerId: string, dueDate: string, note: string) => Promise<void>;
}) {
  const [customerId, setCustomerId] = React.useState(customers[0]?.id ?? "");
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
                await onSubmit(customerId, dueDate, note);
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
      <div className="grid gap-3">
        <Field label="Customer">
          <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
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
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="h-20"
            placeholder="Call back with the revised drum rate"
          />
        </Field>
      </div>
    </Modal>
  );
}

type RescheduleProps = {
  reminder: Row | null;
  onClose: () => void;
  onSubmit: (dueDate: string, note: string) => Promise<void>;
};

function RescheduleModal(props: RescheduleProps) {
  if (!props.reminder) return null;
  return <RescheduleModalBody key={props.reminder.id} {...props} />;
}

function RescheduleModalBody({ reminder, onClose, onSubmit }: RescheduleProps) {
  const [dueDate, setDueDate] = React.useState(addDays(today(), 1));
  const [note, setNote] = React.useState(reminder?.note ?? "");
  const [busy, setBusy] = React.useState(false);

  return (
    <Modal
      open={Boolean(reminder)}
      onClose={onClose}
      title="Reschedule reminder"
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
            Reschedule
          </Button>
        </>
      }
    >
      <div className="mb-3 text-sm text-muted">{reminder?.customerName}</div>
      <div className="grid gap-3">
        <Field label="New due date · required">
          <Input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="w-[200px]"
          />
        </Field>
        <Field label="Note" hint="Update it if the promise itself has changed.">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="h-20"
          />
        </Field>
      </div>
    </Modal>
  );
}
