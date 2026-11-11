"use client";

import * as React from "react";
import Link from "next/link";
import { APP_TIMEZONE } from "@/lib/business-date";
import { Badge, Button, cx } from "@/components/ui/primitives";
import type { TaskRow } from "@/lib/tasks/service";
import {
  PRIORITY_LABEL,
  STATUS_LABEL,
  TASK_APP_LABEL,
  clock12,
  daysUntil,
  dueWords,
  shortDate,
  weekday,
  type TaskApp,
  type TaskPriority,
  type TaskStatus,
} from "@/lib/tasks/rules";

/* ---------------------------------------------------------------------------
 * The small pieces every Tasks screen draws the same way: which app a task is
 * in, its status, its priority, when it is due, and the row itself — the
 * CRM Reminders row, which is where a telecaller already reads their day.
 * ------------------------------------------------------------------------- */

const APP_TONE: Record<TaskApp, string> = {
  tasks: "bg-divider text-muted",
  crm: "bg-brand-soft text-brand-hover",
  accounts: "bg-success-soft text-success",
  sales: "bg-warn-soft text-warn-ink",
  erp: "bg-info-soft text-info",
  hrms: "bg-success-soft text-success",
  founder: "bg-warn-soft text-warn-ink",
  enquiries: "bg-info-soft text-info",
  website: "bg-info-soft text-info",
  hire: "bg-brand-soft text-brand-hover",
  factory: "bg-warn-soft text-warn-ink",
};

const APP_SHORT: Partial<Record<TaskApp, string>> = { crm: "CRM", sales: "Sales", enquiries: "Enquiries" };

export function AppChip({ app, long = false }: { app: TaskApp; long?: boolean }) {
  return (
    <span className={cx("inline-flex h-5 flex-none items-center rounded-[5px] px-1.5 text-[11.5px] font-semibold whitespace-nowrap", APP_TONE[app] ?? APP_TONE.tasks)}>
      {long ? TASK_APP_LABEL[app] : (APP_SHORT[app] ?? TASK_APP_LABEL[app])}
    </span>
  );
}

export function StatusBadge({ status }: { status: TaskStatus }) {
  const tone = status === "done" ? "success" : status === "doing" ? "brand" : status === "waiting" ? "warn" : "neutral";
  return <Badge tone={tone}>{STATUS_LABEL[status]}</Badge>;
}

export function PriorityMark({ priority, quiet = true }: { priority: TaskPriority; quiet?: boolean }) {
  if (priority === "normal" && quiet) return null;
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 text-[12.5px] whitespace-nowrap",
        priority === "urgent" ? "font-semibold text-danger" : priority === "high" ? "font-semibold text-warn-ink" : "text-muted",
      )}
    >
      <FlagGlyph />
      {PRIORITY_LABEL[priority]}
    </span>
  );
}

function FlagGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7" />
    </svg>
  );
}

/** The left column of a row: the day, and under it the time or how late. */
export function DueCell({ task, today }: { task: TaskRow; today: string }) {
  if (task.status === "done") {
    return (
      <div className="text-sm leading-[18px] text-success">
        Done
        <span className="block text-xs">{task.closedAt ? new Date(task.closedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: APP_TIMEZONE }) : ""}</span>
      </div>
    );
  }
  const d = daysUntil(task.dueDate, today);
  if (d < 0)
    return (
      <div className="text-sm leading-[18px] text-danger">
        {shortDate(task.dueDate)}
        <span className="block text-xs">{dueWords(task.dueDate, today)}</span>
      </div>
    );
  return (
    <div className={cx("text-sm leading-[18px]", d === 0 ? "font-semibold text-brand-hover" : "text-ink")}>
      {d === 0 ? "Today" : d === 1 ? "Tomorrow" : shortDate(task.dueDate)}
      <span className="block text-xs font-normal text-muted">{task.dueTime ? clock12(task.dueTime) : d > 1 ? weekday(task.dueDate) : "Any time"}</span>
    </div>
  );
}

/** "Today · 3 PM", "2 days late" — for a cell or a card. */
export function DueText({ task, today }: { task: TaskRow; today: string }) {
  if (task.status === "done") return <span className="text-[12.5px] font-semibold text-success">Done</span>;
  const d = daysUntil(task.dueDate, today);
  return (
    <span className={cx("text-[12.5px] font-semibold whitespace-nowrap", d < 0 ? "text-danger" : d === 0 ? "text-brand-hover" : "text-body")}>
      {dueWords(task.dueDate, today)}
      {task.dueTime && d >= 0 ? ` · ${clock12(task.dueTime)}` : ""}
    </span>
  );
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function Avatar({ name, size = 22 }: { name: string; size?: number }) {
  return (
    <span
      title={name}
      style={{ width: size, height: size, fontSize: size < 24 ? 9 : 11 }}
      className="inline-grid flex-none place-items-center rounded-full bg-brand font-semibold text-white"
    >
      {initials(name)}
    </span>
  );
}

const Sep = () => <span className="text-faint">·</span>;

/** Who it came from, in words. */
export function fromWords(t: TaskRow, viewerId: string): string {
  if (t.kind === "auto") return `${t.app === "tasks" ? "Tasks" : TASK_APP_LABEL[t.app]}, automatically`;
  if (t.kind === "routine") return t.createdById === t.assigneeId ? "Routine" : `Routine from ${t.createdByName.split(" ")[0]}`;
  if (t.createdById === t.assigneeId) return t.createdById === viewerId ? "Added by you" : `Added by ${t.createdByName.split(" ")[0]}`;
  return t.createdById === viewerId ? `You gave it to ${t.assigneeName.split(" ")[0]}` : `From ${t.createdByName.split(" ")[0]}`;
}

/**
 * One task as a row: when it is due, what it is, and the two things somebody
 * does to it most — Mark done, and the menu. Clicking anywhere else opens it.
 */
export function TaskRowItem({
  task,
  today,
  viewerId,
  showApp = true,
  showAssignee = false,
  onOpen,
  onClose,
  onReopen,
  extra,
  menu,
}: {
  task: TaskRow;
  today: string;
  viewerId: string;
  showApp?: boolean;
  showAssignee?: boolean;
  onOpen: () => void;
  onClose?: () => void;
  onReopen?: () => void;
  extra?: React.ReactNode;
  /** The ⋯ menu, drawn last. */
  menu?: React.ReactNode;
}) {
  const steps = task.checklist.length;
  const ticked = task.checklist.filter((c) => c.done).length;
  const offered = task.transfer && task.transfer.toId === viewerId;
  const asked = task.transfer && task.transfer.toId !== viewerId;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === "Enter" ? onOpen() : undefined)}
      className="grid cursor-pointer grid-cols-[110px_minmax(0,1fr)_auto] items-center gap-4 border-t border-divider px-5 py-3.5 first:border-t-0 hover:bg-[#f7f5fe] max-sm:grid-cols-1 max-sm:gap-2"
    >
      <DueCell task={task} today={today} />
      <div className="min-w-0">
        <div className={cx("truncate text-[15px] leading-5 font-medium", task.status === "done" ? "text-faint line-through" : "text-ink")}>{task.title}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[13px] text-muted">
          {showApp ? <AppChip app={task.app} /> : null}
          {task.customerName ? <span className="font-medium text-brand">{task.customerName}</span> : null}
          {task.customerName ? <Sep /> : null}
          <span className="inline-flex items-center gap-1">
            <KindGlyph kind={task.kind} />
            {fromWords(task, viewerId)}
          </span>
          {showAssignee ? (
            <>
              <Sep />
              <span className="inline-flex items-center gap-1">
                <Avatar name={task.assigneeName} size={18} /> {task.assigneeName}
              </span>
            </>
          ) : null}
          {steps ? (
            <>
              <Sep />
              <span>
                {ticked} of {steps} steps
              </span>
            </>
          ) : null}
          {task.status === "doing" || task.status === "waiting" ? (
            <>
              <Sep />
              <StatusBadge status={task.status} />
            </>
          ) : null}
          {task.priority !== "normal" ? (
            <>
              <Sep />
              <PriorityMark priority={task.priority} />
            </>
          ) : null}
          {task.proofRequired && task.status !== "done" ? (
            <>
              <Sep />
              <span title="A screenshot is needed to close this">Screenshot needed</span>
            </>
          ) : null}
          {offered ? (
            <>
              <Sep />
              <Badge tone="warn">Offered to you by {task.transfer!.fromName.split(" ")[0]}</Badge>
            </>
          ) : asked ? (
            <>
              <Sep />
              <Badge tone="warn">Waiting for {task.transfer!.toName.split(" ")[0]} to accept</Badge>
            </>
          ) : null}
        </div>
        {task.status === "done" && task.closeRemark ? <div className="mt-1 truncate text-[13px] text-muted">“{task.closeRemark}”</div> : null}
      </div>
      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
        {task.status !== "done" && task.customerId && task.app === "crm" && task.assigneeId === viewerId ? (
          <Link href={`/crm/customers/${task.customerId}?call=1`} className="inline-flex h-8 items-center rounded-control border border-brand bg-brand px-3 text-[13px] font-semibold text-white no-underline hover:bg-brand-hover hover:no-underline">
            Call
          </Link>
        ) : null}
        {extra}
        {task.status === "done" ? (
          onReopen ? (
            <Button size="sm" onClick={onReopen}>
              Reopen
            </Button>
          ) : null
        ) : onClose && !offered ? (
          <Button size="sm" onClick={onClose}>
            Mark done
          </Button>
        ) : null}
        {menu}
      </div>
    </div>
  );
}

/** Bolt for an app's own task, arrows for a routine, a person for one given or added. */
export function KindGlyph({ kind }: { kind: TaskRow["kind"] }) {
  const d =
    kind === "auto"
      ? "M13 2 3 14h9l-1 8 10-12h-9l1-8z"
      : kind === "routine"
        ? "m17 1 4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3"
        : "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z";
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="flex-none">
      <path d={d} />
    </svg>
  );
}

export const KIND_LABEL: Record<TaskRow["kind"], string> = {
  auto: "Raised by an app",
  routine: "From a routine",
  assigned: "Given to you",
  self: "Added by you",
};

/** A card of rows under a heading — "Late 2". */
export function TaskListCard({ heading, count, tone, children, empty }: { heading?: string; count?: number; tone?: "danger"; children: React.ReactNode; empty?: string }) {
  const hasRows = React.Children.toArray(children).length > 0;
  if (!hasRows && !empty) return null;
  return (
    <div className="mb-4 overflow-hidden rounded-card border border-line bg-surface">
      {heading ? (
        <div className={cx("flex items-center gap-2 border-b border-divider px-4 py-3 text-[13px] font-medium", tone === "danger" ? "text-danger" : "text-body")}>
          {heading}
          {count != null ? (
            <span className={cx("min-w-5 rounded-full px-1.5 text-center text-[11px] leading-[18px] font-semibold", tone === "danger" ? "bg-danger-soft text-danger" : "bg-divider text-body")}>{count}</span>
          ) : null}
        </div>
      ) : null}
      {hasRows ? children : <div className="px-5 py-5 text-sm text-muted">{empty}</div>}
    </div>
  );
}

/** A figure card: dot, label, number, bar, line — the ERP list's cards. */
export function FigureCard({
  label,
  value,
  sub,
  pct,
  tone = "ink",
  onClick,
  on,
}: {
  label: string;
  value: React.ReactNode;
  sub: string;
  pct: number;
  tone?: "ink" | "danger" | "brand" | "success";
  onClick?: () => void;
  on?: boolean;
}) {
  const color = tone === "danger" ? "bg-danger" : tone === "brand" ? "bg-info" : tone === "success" ? "bg-success" : "bg-ink";
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      onClick={onClick}
      className={cx(
        "flex min-w-0 flex-col rounded-card border bg-surface px-4 pt-3.5 pb-3 text-left",
        on ? "border-brand shadow-[0_0_0_3px_var(--color-brand-soft)]" : "border-line",
        onClick ? "cursor-pointer hover:border-line-strong" : null,
      )}
    >
      <span className="flex items-center gap-2 text-[13px] font-medium text-body">
        <i className={cx("h-1.5 w-1.5 flex-none rounded-full", color)} />
        {label}
      </span>
      <span className={cx("mt-1.5 text-2xl leading-[30px] font-bold tracking-tight", tone === "danger" ? "text-danger" : "text-ink")}>{value}</span>
      <span className="my-2 block h-1 overflow-hidden rounded-full bg-divider">
        <i className={cx("block h-full", color)} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
      </span>
      <span className="truncate text-xs text-muted">{sub}</span>
    </Tag>
  );
}
