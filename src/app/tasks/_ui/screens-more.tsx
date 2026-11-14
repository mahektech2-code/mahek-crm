"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, PageHeader, cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { runAutomationsNow, setAutomation } from "@/lib/actions/task-automations";
import type { AutomationRule } from "@/lib/tasks/automations";
import type { TaskRow } from "@/lib/tasks/service";
import type { CalendarWeek, TaskListPage } from "@/lib/tasks/list-service";
import { DONE_LIST, type TaskListQuery } from "@/lib/tasks/list-query";
import { TASK_APP_LABEL, clock12, daysUntil, isClosed } from "@/lib/tasks/rules";
import { AppChip } from "./kit";
import { useTaskDialogs } from "./dialogs";
import { TaskListView } from "./task-list";

/* ---------------------------------------------------------------------------
 * Calendar, Done and the automatic tasks — the three screens the design adds
 * beside My day, All, the Board and Transfers.
 * ------------------------------------------------------------------------- */

const APP_BAR: Record<string, string> = {
  tasks: "border-l-muted",
  crm: "border-l-brand",
  accounts: "border-l-success",
  sales: "border-l-warn",
  erp: "border-l-info",
  hrms: "border-l-success",
  founder: "border-l-warn",
};

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const weekdayOf = (day: string) => new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10))).getUTCDay();

/* -------------------------------------------------------------- Calendar */

export function CalendarScreen({ data, days, today, week, rangeWords }: { data: CalendarWeek; days: string[]; today: string; week: number; rangeWords: string }) {
  const { openTask, openNew } = useTaskDialogs();
  // Late open work sits on today, wherever it was due — it is today's to do. The server has already left it off its own day.
  const late = data.late;
  return (
    <div className="mx-auto max-w-[1560px] px-6 pt-6 pb-14">
      <div className="mb-0.5 text-[13.5px] text-muted">{rangeWords}</div>
      <PageHeader
        title="Calendar"
        actions={
          <>
            <Link href={`/tasks/calendar?week=${week - 1}`} aria-label="Previous week" className="inline-flex h-9 w-9 items-center justify-center rounded-control border border-line bg-surface text-ink no-underline hover:no-underline">
              ‹
            </Link>
            <Link href="/tasks/calendar" className="inline-flex h-9 items-center rounded-control border border-line bg-surface px-3.5 text-sm font-semibold text-ink no-underline hover:no-underline">
              This week
            </Link>
            <Link href={`/tasks/calendar?week=${week + 1}`} aria-label="Next week" className="inline-flex h-9 w-9 items-center justify-center rounded-control border border-line bg-surface text-ink no-underline hover:no-underline">
              ›
            </Link>
            <Button variant="primary" onClick={() => openNew()}>
              + New task
            </Button>
          </>
        }
      />
      <div className="grid grid-cols-[repeat(7,minmax(140px,1fr))] gap-2 overflow-x-auto pb-2">
        {days.map((day) => {
          const isToday = day === today;
          const own = data.byDay[day] ?? { rows: [], total: 0 };
          const list: TaskRow[] = [...(isToday ? late.rows : []), ...own.rows];
          const hidden = (isToday ? late.total - late.rows.length : 0) + (own.total - own.rows.length);
          const wd = weekdayOf(day);
          return (
            <div key={day} className={cx("flex min-h-[380px] flex-col rounded-card border", isToday ? "border-brand shadow-[0_0_0_3px_var(--color-brand-soft)]" : "border-line", wd === 0 ? "bg-page" : "bg-surface")}>
              <div className="flex items-baseline justify-between border-b border-divider px-3 pt-2.5 pb-2">
                <span className="text-[12.5px] text-muted">{WD[wd]}</span>
                <b className={cx("text-lg", isToday ? "text-brand-hover" : "text-ink")}>{Number(day.slice(8, 10))}</b>
              </div>
              <div className="flex flex-col gap-1.5 p-2">
                {list.map((t) => {
                  const behind = daysUntil(t.dueDate, today);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => openTask(t.id)}
                      className={cx(
                        "w-full cursor-pointer rounded-md border-0 border-l-[3px] bg-page px-2 py-1.5 text-left text-[12.5px] leading-4 text-ink hover:bg-[#f7f5fe]",
                        APP_BAR[t.app] ?? "border-l-brand",
                        t.status === "done" && "line-through opacity-55",
                      )}
                    >
                      {t.title}
                      <small className="mt-0.5 block text-[11.5px] text-muted">
                        {isToday && behind < 0 && !isClosed(t.status) ? <span className="text-danger">{-behind}d late · </span> : null}
                        {t.dueTime ? `${clock12(t.dueTime)} · ` : ""}
                        {t.app === "tasks" ? "Personal" : TASK_APP_LABEL[t.app]}
                      </small>
                    </button>
                  );
                })}
                {hidden > 0 ? (
                  <Link href={isToday ? "/tasks/all?tab=now&group=due" : "/tasks/all?tab=upcoming&group=due"} className="px-1 text-[12.5px] font-medium text-brand">
                    + {hidden.toLocaleString("en-IN")} more
                  </Link>
                ) : null}
                {!list.length && wd === 0 ? <span className="px-1 text-[12.5px] text-muted">Sunday</span> : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Done */

/** Everything this person finished, newest first, grouped by the day it closed — a page at a time. */
export function DoneScreen({ page, query, today, viewerId }: { page: TaskListPage; query: TaskListQuery; today: string; viewerId: string }) {
  return (
    <div className="mx-auto max-w-[1440px] px-6 pt-6 pb-14">
      <PageHeader title="Done" />
      <TaskListView
        page={page}
        query={query}
        defaults={DONE_LIST}
        scope={{ kind: "mine" }}
        tabs={[]}
        today={today}
        viewerId={viewerId}
        look="rows"
        showKindFilter={false}
        bulk={false}
        empty="Nothing finished yet. Tasks you close land here, with the remark you wrote."
      />
    </div>
  );
}

/* -------------------------------------------------------- Automatic tasks */

export function AutomaticScreen({ rules, states, counts, canManage }: { rules: AutomationRule[]; states: Record<string, boolean>; counts: Record<string, number>; canManage: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState<string | null>(null);
  const apps = [...new Set(rules.map((r) => r.app))];
  const flip = async (r: AutomationRule) => {
    setBusy(r.id);
    const res = await toast.run(setAutomation(r.id, !states[r.id])).finally(() => setBusy(null));
    if (res.ok) router.refresh();
  };
  const runNow = async () => {
    setBusy("all");
    const res = await toast.run(runAutomationsNow()).finally(() => setBusy(null));
    if (res.ok) router.refresh();
  };
  return (
    <div className="mx-auto max-w-[1440px] px-6 pt-6 pb-14">
      <PageHeader
        title="Automatic tasks"
        actions={
          canManage ? (
            <Button onClick={() => void runNow()} disabled={busy === "all"}>
              {busy === "all" ? "Running…" : "Run now"}
            </Button>
          ) : null
        }
      />
      <p className="-mt-2 mb-5 max-w-[820px] text-sm text-muted">
        Each app raises these on its own, from its own records. They go to whoever the app&apos;s rules name, and close themselves when the work is done in that app — nobody types them and nobody has to tick them off. They are checked every hour.
        {canManage ? "" : " Only somebody holding Run automatic tasks switches one on or off."}
      </p>
      {apps.map((a) => (
        <div key={a} className="mb-6">
          <div className="mb-2.5 flex items-center gap-2 text-[15px] font-bold text-ink">
            <AppChip app={a} long />
          </div>
          <div className="overflow-x-auto rounded-card border border-line bg-surface">
            <table className="w-full min-w-[860px] border-separate border-spacing-0 text-[13px]">
              <thead>
                <tr>
                  {["On", "When", "Who gets it", "Closes when", "Open now"].map((h) => (
                    <th key={h} className="bg-ink px-3 py-2.5 text-left text-[11px] font-bold tracking-[0.05em] whitespace-nowrap text-white uppercase first:rounded-tl-[7px] last:rounded-tr-[7px]">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rules
                  .filter((r) => r.app === a)
                  .map((r) => {
                    const on = states[r.id];
                    return (
                      <tr key={r.id}>
                        <td className="w-14 border-t border-divider px-3 py-2.5">
                          <Switch on={on} disabled={!canManage || busy === r.id} label={`${on ? "Switch off" : "Switch on"}: ${r.when}`} onClick={() => void flip(r)} />
                        </td>
                        <td className={cx("border-t border-divider px-3 py-2.5 font-medium", on ? "text-ink" : "text-faint")}>{r.when}</td>
                        <td className="border-t border-divider px-3 py-2.5 text-body">{r.who}</td>
                        <td className="border-t border-divider px-3 py-2.5 text-body">{r.closes}</td>
                        <td className="border-t border-divider px-3 py-2.5">{on ? counts[r.id] ? <Badge tone="brand">{counts[r.id]}</Badge> : "0" : "—"}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

export function Switch({ on, onClick, label, disabled }: { on: boolean; onClick: () => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      title={disabled && !onClick ? undefined : label}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "relative h-5 w-9 flex-none cursor-pointer rounded-full border-0 p-0 transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        on ? "bg-brand" : "bg-line-strong",
      )}
    >
      <span className={cx("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-[left]", on ? "left-[18px]" : "left-0.5")} />
    </button>
  );
}
