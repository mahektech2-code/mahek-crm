"use client";

import * as React from "react";
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
  Textarea,
  Select,
  cx,
} from "@/components/ui/primitives";
import { FilterPills, Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { Icon } from "@/components/shell/icons";
import { CallPanel, type CallTarget } from "@/components/crm/call-panel";
import { createReminder, logComplaint } from "@/lib/actions/crm";
import { COMPLAINT_CATEGORIES } from "@/lib/constants";
import {
  ageLabel,
  money,
  pct,
  phoneDisplay,
  shortDate,
  stamp,
  today,
} from "@/lib/format";

type Entry = {
  id: string;
  kind: string;
  at: string;
  actor: string;
  content: string;
  meta: string | null;
};

const KIND_TONE: Record<string, "brand" | "success" | "warn" | "danger" | "neutral"> = {
  Call: "brand",
  WhatsApp: "success",
  Order: "success",
  Reminder: "warn",
  Complaint: "danger",
  Payment: "success",
  Bill: "neutral",
};

export function RecordScreen({
  customer,
  daysSinceOrder,
  target,
  openComplaint,
  openPromise,
  billStats,
  timeline,
}: {
  customer: {
    id: string;
    name: string;
    contactPerson: string;
    phone: string;
    city: string;
    ownerName: string | null;
    status: string;
    slowPayer: boolean;
    outstanding: number;
    lastOrderDate: string | null;
    lastOrderValue: number;
    cycleDays: number;
    avgOrderValue: number;
    orders6m: number;
    paysInDays: number;
    creditTermDays: number;
    gstin: string | null;
    route: string | null;
    customerSince: string | null;
    deactivationRequested: boolean;
    deactivationReason: string | null;
  };
  daysSinceOrder: number | null;
  target: { amount: number; achieved: number; isDefault: boolean; shareOfBook: number };
  openComplaint: { description: string; category: string } | null;
  openPromise: { amount: number; promisedBy: string } | null;
  billStats: { total: number; overdue: number; oldestDueDate: string | null };
  timeline: Entry[];
}) {
  const router = useRouter();
  const { run } = useToast();

  const [filter, setFilter] = React.useState("All");
  const [calling, setCalling] = React.useState(false);
  const [remOpen, setRemOpen] = React.useState(false);
  const [cmpOpen, setCmpOpen] = React.useState(false);

  const kinds = ["All", ...Array.from(new Set(timeline.map((t) => t.kind)))];
  const visible = filter === "All" ? timeline : timeline.filter((t) => t.kind === filter);

  const overCycle = daysSinceOrder !== null && daysSinceOrder > customer.cycleDays;
  const paysLate = customer.paysInDays > customer.creditTermDays;

  const alert = openComplaint
    ? `Open ${openComplaint.category.toLowerCase()} complaint — mention it before anything else.`
    : openPromise && openPromise.promisedBy < today()
      ? `${money(openPromise.amount)} was promised for ${shortDate(openPromise.promisedBy)} and has not arrived.`
      : customer.deactivationRequested
        ? `Deactivation requested — ${customer.deactivationReason ?? "no reason recorded"}. Waiting on a manager.`
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
    <div className="max-w-[1400px] px-6 pt-6 pb-10">
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
            {customer.slowPayer ? <SlowPayerBadge /> : null}
          </span>
        }
        subtitle={`${customer.contactPerson} · ${phoneDisplay(customer.phone)} · ${customer.city} · Owner ${customer.ownerName ?? "unassigned"}`}
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => router.push(`/crm/whatsapp?customer=${customer.id}`)}
            >
              WhatsApp
            </Button>
            <Button variant="secondary" onClick={() => setRemOpen(true)}>
              Set reminder
            </Button>
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

      <div className="grid grid-cols-[1fr_320px] items-start gap-4">
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-divider px-5 py-3.5">
            <span className="text-lg leading-6 font-semibold text-ink">Timeline</span>
            <FilterPills
              value={filter}
              onChange={setFilter}
              options={kinds.map((k) => ({
                key: k,
                label: k,
                count: k === "All" ? timeline.length : timeline.filter((t) => t.kind === k).length,
              }))}
            />
          </div>
          <div className="px-5 py-4">
            {visible.length ? (
              visible.map((t) => (
                <div key={t.id} className="relative border-l border-divider pb-4 pl-5 last:pb-0">
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
                    <Badge tone={KIND_TONE[t.kind] ?? "neutral"}>{t.kind}</Badge>
                    <span className="text-[11px] text-muted">{stamp(t.at)}</span>
                    <span className="text-[11px] text-muted">· {t.actor}</span>
                  </div>
                  <div className="mt-1 text-sm text-ink">{t.content}</div>
                  {t.meta ? (
                    <div className="mt-0.5 text-[13px] text-muted">{t.meta}</div>
                  ) : null}
                </div>
              ))
            ) : (
              <div className="py-10 text-center text-[15px] text-muted">
                Nothing of this type has been logged against this customer yet.
              </div>
            )}
          </div>
        </Card>

        <div className="flex flex-col gap-4">
          <Card className="p-5">
            <SectionLabel>Key figures</SectionLabel>
            <div className="mt-3">
              <Figure label="Outstanding" tone={customer.outstanding > 0 ? "danger" : undefined}>
                {money(customer.outstanding)}
              </Figure>
              <Figure label="Bills overdue" tone={billStats.overdue ? "danger" : undefined}>
                {billStats.overdue} of {billStats.total}
              </Figure>
              <Figure label="Last order">
                {customer.lastOrderDate ? shortDate(customer.lastOrderDate) : "Never"}
              </Figure>
              <Figure label="Days since order" tone={overCycle ? "danger" : undefined}>
                {daysSinceOrder === null ? "—" : ageLabel(daysSinceOrder)}
              </Figure>
              <Figure label="Buying cycle">{customer.cycleDays} days</Figure>
              <Figure label="Average order">{money(customer.avgOrderValue)}</Figure>
              <Figure label="Orders, last 6 months">{customer.orders6m}</Figure>
              <Figure label="Pays on average" tone={paysLate ? "danger" : "success"}>
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
              <SectionLabel>Target vs achieved — this month</SectionLabel>
              {target.isDefault ? <Badge tone="muted">Default</Badge> : null}
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-[32px] leading-9 font-semibold text-ink">
                {money(target.achieved)}
              </span>
              <span className="text-[13px] text-muted">of {money(target.amount)}</span>
            </div>
            <div className="mt-3 flex items-center gap-2.5">
              <Progress value={pct(target.achieved, target.amount)} className="flex-1" />
              <span className="text-[13px] font-medium text-ink">
                {pct(target.achieved, target.amount)}%
              </span>
            </div>
          </Card>

          <Card className="p-5">
            <SectionLabel>Account</SectionLabel>
            <div className="mt-2.5 text-sm leading-[22px] text-body">
              GSTIN {customer.gstin ?? "not recorded"}
              <br />
              Credit terms {customer.creditTermDays} days
              <br />
              Route {customer.route ?? "not set"}
              <br />
              Customer since{" "}
              {customer.customerSince ? shortDate(customer.customerSince) : "unknown"}
            </div>
          </Card>
        </div>
      </div>

      {calling ? (
        <CallPanel target={callTarget} onClose={() => setCalling(false)} />
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
          tone === "danger" ? "text-danger" : tone === "success" ? "text-success" : "text-ink",
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
          hint="This note is what you will see in the reminders list — write it for your future self."
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

export function QuickComplaint({
  open,
  customerName,
  onClose,
  onSubmit,
}: {
  open: boolean;
  customerName: string;
  onClose: () => void;
  onSubmit: (category: string, description: string) => Promise<void>;
}) {
  const [category, setCategory] = React.useState<string>(COMPLAINT_CATEGORIES[0]);
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
          <Select value={category} onChange={(e) => setCategory(e.target.value)}>
            {COMPLAINT_CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        </Field>
        <Field
          label="Description · required"
          hint="Write it in the customer's words — this is what the resolver reads."
        >
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="h-20"
          />
        </Field>
      </div>
    </Modal>
  );
}
