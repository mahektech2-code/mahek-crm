"use client";

import * as React from "react";
import { APP_TIMEZONE } from "@/lib/business-date";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, PageHeader, Select, cx } from "@/components/ui/primitives";
import { CardGrid } from "@/components/ui/card-grid";
import { useToast } from "@/components/ui/toast";
import { bulkUpdateTasks, nudgePerson, quickAddTask, updateTask } from "@/lib/actions/tasks";
import type { TaskRow, TransferHistoryRow, TeamPerson } from "@/lib/tasks/service";
import { PRIORITY_LABEL, PRIORITY_RANK, STATUS_LABEL, TASK_APP_LABEL, daysUntil, plusDays, type TaskApp, type TaskStatus } from "@/lib/tasks/rules";
import { taskOpenHref } from "@/lib/tasks/automations";
import { RowMenu, type MenuItem } from "@/components/ui/overlays";
import { AppChip, Avatar, DueText, FigureCard, PriorityMark, StatusBadge, TaskListCard, TaskRowItem, fromWords, KIND_LABEL, KindGlyph } from "./kit";
import { useTaskDialogs } from "./dialogs";

/* ---------------------------------------------------------------------------
 * The Tasks app's screens. Every one reads rows the server already narrowed
 * to what this person may see, and opens the same dialogs to act on them.
 * ------------------------------------------------------------------------- */

type Base = { today: string; viewerId: string };

const isOpen = (t: TaskRow) => t.status !== "done";
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function Rows({ list, today, viewerId, showApp = true, showAssignee = false }: { list: TaskRow[]; today: string; viewerId: string; showApp?: boolean; showAssignee?: boolean }) {
  const { openTask, openClose } = useTaskDialogs();
  return (
    <>
      {list.map((t) => (
        <TaskRowItem
          key={t.id}
          task={t}
          today={today}
          viewerId={viewerId}
          showApp={showApp}
          showAssignee={showAssignee}
          onOpen={() => openTask(t.id)}
          onClose={t.assigneeId === viewerId || showAssignee ? () => openClose(t.id) : undefined}
          onReopen={t.status === "done" && t.assigneeId === viewerId ? () => openTask(t.id) : undefined}
          menu={<TaskMenu task={t} today={today} viewerId={viewerId} />}
        />
      ))}
    </>
  );
}

/**
 * A row's ⋯: open it, start it, park it as waiting, move it to tomorrow, open
 * it where the work is done, hand it over. Each goes through the same action a
 * button in the task's record would, so a refusal reads the same.
 */
export function TaskMenu({ task: t, today, viewerId }: { task: TaskRow; today: string; viewerId: string }) {
  const router = useRouter();
  const toast = useToast();
  const { openTask, openTransfer } = useTaskDialogs();
  const act = async (p: Promise<{ ok: boolean; message?: string; error?: string }>) => {
    const r = await toast.run(p);
    if (r.ok) router.refresh();
  };
  const href = taskOpenHref(t);
  const open = t.status !== "done";
  const items: MenuItem[] = [{ label: "Open the task", onSelect: () => openTask(t.id) }];
  if (open && t.status !== "doing") items.push({ label: "Start it", onSelect: () => void act(updateTask(t.id, { status: "doing" })) });
  if (open && t.status !== "waiting") items.push({ label: "Waiting on someone", onSelect: () => void act(updateTask(t.id, { status: "waiting" })) });
  if (open) items.push({ label: "Move to tomorrow", onSelect: () => void act(updateTask(t.id, { dueDate: plusDays(today, 1) })) });
  if (href && t.app !== "tasks") items.push({ label: `Open in ${TASK_APP_LABEL[t.app]}`, onSelect: () => router.push(href) });
  if (open && !t.transfer && !t.autoRule && t.assigneeId === viewerId) items.push({ label: "Transfer", onSelect: () => openTransfer(t.id) });
  return <RowMenu items={items} />;
}

function OfferedCallout({ incoming }: { incoming: TaskRow[] }) {
  const { openTask } = useTaskDialogs();
  if (!incoming.length) return null;
  const from = incoming[0].transfer!.fromName.split(" ")[0];
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-card border border-brand-softer bg-brand-soft px-4 py-3 text-sm text-body">
      <span className="flex-1">
        <b className="text-ink">
          {from}
          {incoming.length > 1 ? ` and ${incoming.length - 1} more` : ""}
        </b>{" "}
        want{incoming.length > 1 ? "" : "s"} to hand you {incoming.length > 1 ? `${incoming.length} tasks` : "a task"}. Review, then accept or reject.
      </span>
      <Button size="sm" onClick={() => openTask(incoming[0].id)}>
        Review
      </Button>
    </div>
  );
}

/* ---------------------------------------------------------------- My day */

export function MyDayScreen({ tasks, incoming, today, viewerId, greeting, dateLine }: Base & { tasks: TaskRow[]; incoming: TaskRow[]; greeting: string; dateLine: string }) {
  const router = useRouter();
  const toast = useToast();
  const { openNew } = useTaskDialogs();
  const [text, setText] = React.useState("");
  const open = tasks.filter(isOpen);
  const late = open.filter((t) => daysUntil(t.dueDate, today) < 0);
  const due = open.filter((t) => daysUntil(t.dueDate, today) === 0);
  const soon = open.filter((t) => {
    const d = daysUntil(t.dueDate, today);
    return d > 0 && d <= 3;
  });
  const doneToday = tasks.filter((t) => t.status === "done" && t.closedOn === today);
  const total = late.length + due.length + doneToday.length;
  const pct = total ? Math.round((doneToday.length / total) * 100) : 0;
  const apps = [...new Set(open.map((t) => t.app))];

  const add = async () => {
    if (!text.trim()) return;
    const r = await toast.run(quickAddTask(text));
    if (r.ok) {
      setText("");
      router.refresh();
    }
  };

  return (
    <div className="mx-auto max-w-[1440px] px-6 pt-6 pb-14">
      <div className="mb-0.5 text-[13.5px] text-muted">{dateLine}</div>
      <PageHeader
        title={greeting}
        actions={
          <Button variant="primary" onClick={() => openNew()}>
            + New task
          </Button>
        }
      />
      <CardGrid min={180} gap="gap-3" className="mb-4">
        <FigureCard label="Late" value={late.length} sub={late.length ? "Do these first" : "Nothing late"} pct={late.length ? 100 : 0} tone={late.length ? "danger" : "success"} />
        <FigureCard label="Due today" value={due.length} sub={(() => { const n = due.filter((t) => t.dueTime).length; return n ? `${n} at a set time` : "None at a set time"; })()} pct={total ? (due.length / total) * 100 : 0} tone="brand" />
        <FigureCard label="Done today" value={doneToday.length} sub={`${pct}% of today's work`} pct={pct} tone="success" />
        <FigureCard label="Across apps" value={apps.length} sub={apps.map((a) => (a === "tasks" ? "Personal" : TASK_APP_LABEL[a])).join(", ") || "Nothing open"} pct={100} />
      </CardGrid>
      <OfferedCallout incoming={incoming} />
      <div className="grid grid-cols-[minmax(0,1fr)_320px] items-start gap-4 max-xl:grid-cols-1">
        <div className="min-w-0">
          <form
            className="mb-4 flex h-11 items-center gap-2.5 rounded-card border border-line bg-surface px-3 text-muted focus-within:border-brand"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <span aria-hidden>+</span>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="h-10 min-w-0 flex-1 border-0 bg-transparent text-sm text-ink outline-none"
              placeholder="Add a task for yourself — try “Call Hari Om Paints tomorrow 3pm !high”"
              aria-label="Add a task for yourself"
            />
            <kbd className="rounded border border-line px-1.5 font-mono text-[11px] max-sm:hidden">Enter</kbd>
          </form>
          <TaskListCard heading="Late" count={late.length} tone="danger">
            {late.length ? <Rows list={late} today={today} viewerId={viewerId} /> : null}
          </TaskListCard>
          <TaskListCard heading="Today" count={due.length} empty="Nothing else due today.">
            {due.length ? <Rows list={due} today={today} viewerId={viewerId} /> : null}
          </TaskListCard>
          <TaskListCard heading="Next 3 days" count={soon.length} empty="Nothing in the next three days.">
            {soon.length ? <Rows list={soon} today={today} viewerId={viewerId} /> : null}
          </TaskListCard>
          <TaskListCard heading="Done today" count={doneToday.length}>
            {doneToday.length ? <Rows list={doneToday} today={today} viewerId={viewerId} /> : null}
          </TaskListCard>
        </div>
        <aside className="flex min-w-0 flex-col gap-4">
          <div className="overflow-hidden rounded-card border border-line bg-surface">
            <div className="border-b border-divider px-4 py-3 text-sm font-semibold text-ink">Where your work is</div>
            {apps.length ? (
              apps.map((a) => {
                const n = open.filter((t) => t.app === a).length;
                const l = open.filter((t) => t.app === a && daysUntil(t.dueDate, today) < 0).length;
                return (
                  <Link key={a} href={`/tasks/all?app=${a}`} className="flex items-center gap-2.5 border-t border-divider px-4 py-2 text-sm text-ink no-underline first:border-t-0 hover:bg-[#f7f5fe] hover:no-underline">
                    <AppChip app={a} />
                    <span className="flex-1">{TASK_APP_LABEL[a]}</span>
                    {l ? <Badge tone="danger">{l} late</Badge> : null}
                    <span className="min-w-5 rounded-full bg-divider px-1.5 text-center text-[11px] leading-[18px] font-semibold">{n}</span>
                  </Link>
                );
              })
            ) : (
              <div className="px-4 py-3 text-sm text-muted">Nothing open anywhere.</div>
            )}
          </div>
          <div className="overflow-hidden rounded-card border border-line bg-surface">
            <div className="border-b border-divider px-4 py-3 text-sm font-semibold text-ink">Where they come from</div>
            <div className="flex flex-col gap-2.5 px-4 py-3">
              {(["auto", "assigned", "routine", "self"] as const).map((k) => (
                <span key={k} className="flex items-start gap-2 text-[13px] leading-[18px] text-muted">
                  <span className="mt-0.5">
                    <KindGlyph kind={k} />
                  </span>
                  <span>
                    <b className="text-ink">
                      {open.filter((t) => t.kind === k).length} {k === "self" ? "added by you" : KIND_LABEL[k].toLowerCase()}
                    </b>{" "}
                    — {k === "auto" ? "the apps raise these and close them when the work is done." : k === "assigned" ? "given to you by your manager." : k === "routine" ? "set on a schedule, added afresh each day they run." : "only you and your managers see these."}
                  </span>
                </span>
              ))}
            </div>
          </div>
          <div className="rounded-card border border-line bg-surface px-4 py-3 text-[13px] text-muted">
            <div className="mb-1.5 font-semibold text-ink">Closing a task</div>
            Mark done asks you to confirm it is done, then for a remark and a screenshot — each required or optional, as whoever gave it chose.
          </div>
        </aside>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- All my tasks */

type Tab = "open" | "late" | "doing" | "waiting" | "done" | "all";
type Group = "app" | "due" | "priority" | "source" | "none";

export function AllTasksScreen({ tasks, today, viewerId, startApp, lockApp = false }: Base & { tasks: TaskRow[]; startApp: string | null; lockApp?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const { openTask, openClose, openCloseMany, openNew } = useTaskDialogs();
  const [tab, setTab] = React.useState<Tab>("open");
  const [app, setApp] = React.useState<string>(startApp ?? "all");
  const [kind, setKind] = React.useState<"all" | TaskRow["kind"]>("all");
  const [q, setQ] = React.useState("");
  const [group, setGroup] = React.useState<Group>(lockApp ? "due" : "app");
  const [sel, setSel] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const count = (f: (t: TaskRow) => boolean) => tasks.filter(f).length;
  const lateF = (t: TaskRow) => isOpen(t) && daysUntil(t.dueDate, today) < 0;
  const tabs: [Tab, string, number][] = [
    ["open", "Open", count(isOpen)],
    ["late", "Late", count(lateF)],
    ["doing", "In progress", count((t) => t.status === "doing")],
    ["waiting", "Waiting", count((t) => t.status === "waiting")],
    ["done", "Done", count((t) => t.status === "done")],
    ["all", "Everything", tasks.length],
  ];
  const apps = [...new Set(tasks.map((t) => t.app))];
  const term = q.trim().toLowerCase();
  const list = tasks.filter(
    (t) =>
      (tab === "all" || (tab === "open" ? isOpen(t) : tab === "late" ? lateF(t) : t.status === tab)) &&
      (app === "all" || t.app === app) &&
      (kind === "all" || t.kind === kind) &&
      (!term || `${t.title} ${t.customerName ?? ""} ${t.createdByName} ${TASK_APP_LABEL[t.app]}`.toLowerCase().includes(term)),
  );
  const dueKey = (t: TaskRow) => (t.status === "done" ? "Done" : daysUntil(t.dueDate, today) < 0 ? "Late" : daysUntil(t.dueDate, today) === 0 ? "Today" : daysUntil(t.dueDate, today) === 1 ? "Tomorrow" : "Later");
  const keyOf = (t: TaskRow) =>
    group === "app" ? (t.app === "tasks" ? "Personal" : TASK_APP_LABEL[t.app]) : group === "priority" ? PRIORITY_LABEL[t.priority] : group === "due" ? dueKey(t) : group === "source" ? KIND_LABEL[t.kind] : "";
  const rankOf = (t: TaskRow): number =>
    group === "priority" ? PRIORITY_RANK[t.priority] : group === "due" ? ({ Late: 0, Today: 1, Tomorrow: 2, Later: 3, Done: 4 } as Record<string, number>)[dueKey(t)] : group === "source" ? ["auto", "assigned", "routine", "self"].indexOf(t.kind) : 0;
  const sorted = [...list].sort((a, b) => rankOf(a) - rankOf(b) || keyOf(a).localeCompare(keyOf(b)) || Number(isOpen(b)) - Number(isOpen(a)) || a.dueDate.localeCompare(b.dueDate) || (a.dueTime ?? "99").localeCompare(b.dueTime ?? "99"));
  /* Each row knows whether it opens a group: the key differs from the row above. */
  const heads = sorted.map((t, i) => (group !== "none" && (i === 0 || keyOf(sorted[i - 1]) !== keyOf(t)) ? keyOf(t) : null));
  const picked = sorted.filter((t) => sel.has(t.id));
  const allOn = sorted.length > 0 && sorted.every((t) => sel.has(t.id));
  const toggle = (id: string) => setSel((s0) => {
    const s1 = new Set(s0);
    if (s1.has(id)) s1.delete(id);
    else s1.add(id);
    return s1;
  });
  const bulk = async (op: "doing" | "tomorrow") => {
    setBusy(true);
    const r = await toast.run(bulkUpdateTasks(picked.map((t) => t.id), op)).finally(() => setBusy(false));
    if (r.ok) {
      setSel(new Set());
      router.refresh();
    }
  };
  const exportCsv = () => {
    const cell = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const head = ["Task", "About", "App", "Where from", "Status", "Priority", "Due", "Time", "Checklist", "Given by", "Closed remark"];
    const lines = sorted.map((t) =>
      [
        t.title,
        t.customerName ?? "",
        t.app === "tasks" ? "Personal" : TASK_APP_LABEL[t.app],
        KIND_LABEL[t.kind],
        STATUS_LABEL[t.status],
        PRIORITY_LABEL[t.priority],
        t.dueDate,
        t.dueTime ?? "",
        t.checklist.length ? `${t.checklist.filter((c) => c.done).length} of ${t.checklist.length}` : "",
        t.createdByName,
        t.closeRemark ?? "",
      ]
        .map(cell)
        .join(","),
    );
    const blob = new Blob([[head.map(cell).join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `tasks-${today}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const title = app === "all" ? "All my tasks" : app === "tasks" ? "Personal tasks" : `${TASK_APP_LABEL[app as TaskApp]} tasks`;
  return (
    <div className="mx-auto max-w-[1440px] px-6 pt-6 pb-14">
      <PageHeader
        title={title}
        actions={
          <>
            <Button onClick={exportCsv} disabled={!sorted.length} title="Download the list as it is filtered, as a spreadsheet (CSV)">
              Export
            </Button>
            <Button variant="primary" onClick={() => openNew(app !== "all" ? { app: app as TaskApp } : undefined)}>
              + New task
            </Button>
          </>
        }
      />
      <div className="mb-4 flex gap-5 overflow-x-auto border-b border-line">
        {tabs.map(([k, l, n]) => (
          <button
            key={k}
            onClick={() => {
              setTab(k);
              setSel(new Set());
            }}
            className={cx("-mb-px flex cursor-pointer items-center gap-1.5 border-b-2 pt-1.5 pb-2.5 text-sm whitespace-nowrap", tab === k ? "border-brand font-semibold text-ink" : "border-transparent text-muted hover:text-ink")}
          >
            {l}
            {n ? <span className={cx("rounded-full px-1.5 text-[11px] leading-[18px] font-semibold", k === "late" ? "bg-danger-soft text-danger" : "bg-warn-soft text-warn-ink")}>{n}</span> : null}
          </button>
        ))}
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search tasks" className="h-8.5 w-[280px] rounded-control border border-line bg-surface px-3 text-sm outline-none focus:border-brand" />
        {lockApp ? null : (
          <Select value={app} onChange={(e) => setApp(e.target.value)} aria-label="App">
            <option value="all">Every app</option>
            {apps.map((a) => (
              <option key={a} value={a}>
                {a === "tasks" ? "Personal" : TASK_APP_LABEL[a]}
              </option>
            ))}
          </Select>
        )}
        <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Where from">
          <option value="all">From anywhere</option>
          {(["auto", "assigned", "routine", "self"] as const).map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </Select>
        <span className="flex-1" />
        <span className="text-[13px] text-muted">Group by</span>
        <Select value={group} onChange={(e) => setGroup(e.target.value as Group)} aria-label="Group by">
          {lockApp ? null : <option value="app">App</option>}
          <option value="due">Due</option>
          <option value="priority">Priority</option>
          <option value="source">Where from</option>
          <option value="none">Nothing</option>
        </Select>
      </div>
      {picked.length ? (
        <div className="mb-2.5 flex flex-wrap items-center gap-2.5 rounded-card bg-ink px-3.5 py-2.5 text-[13.5px] text-white">
          <b>{picked.length} selected</b>
          {[
            ["Mark done", () => openCloseMany(picked.filter(isOpen).map((t) => t.id))],
            ["Move to tomorrow", () => void bulk("tomorrow")],
            ["Start", () => void bulk("doing")],
          ].map(([l, f]) => (
            <button key={l as string} type="button" disabled={busy} onClick={f as () => void} className="h-7.5 cursor-pointer rounded-control border border-white/30 bg-transparent px-3 text-[13px] text-white hover:bg-white/10 disabled:opacity-50">
              {l as string}
            </button>
          ))}
          <span className="flex-1" />
          <button type="button" onClick={() => setSel(new Set())} className="h-7.5 cursor-pointer rounded-control border border-white/30 bg-transparent px-3 text-[13px] text-white hover:bg-white/10">
            Clear
          </button>
        </div>
      ) : null}
      {sorted.length ? (
        <div className="overflow-x-auto rounded-card border border-line bg-surface">
          <table className="w-full min-w-[900px] border-separate border-spacing-0 text-[13px]">
            <thead>
              <tr>
                <th className="w-10 bg-ink px-3 py-2.5 first:rounded-tl-[7px]">
                  <input type="checkbox" className="h-4 w-4 accent-brand" checked={allOn} onChange={() => setSel(allOn ? new Set() : new Set(sorted.map((t) => t.id)))} aria-label="Select all" />
                </th>
                {["Task", "App", "Status", "Priority", "Due", "Checklist", ""].map((h) => (
                  <th key={h} className="bg-ink px-3 py-2.5 text-left text-[11px] font-bold tracking-[0.05em] whitespace-nowrap text-white uppercase last:rounded-tr-[7px]">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((t, i) => {
                const head = heads[i];
                return (
                  <React.Fragment key={t.id}>
                    {head ? (
                      <tr>
                        <td colSpan={8} className="border-t border-[#c9d3e2] bg-[#dde4ef] px-3 py-2 text-[13px] font-bold text-black">
                          {head} <span className="ml-1 font-medium text-muted">{plural(sorted.filter((x) => keyOf(x) === head).length, "task")}</span>
                        </td>
                      </tr>
                    ) : null}
                    <tr className={cx("cursor-pointer hover:bg-[#f7f5fe]", sel.has(t.id) && "bg-brand-soft")} onClick={() => openTask(t.id)}>
                      <td className="border-t border-divider px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" className="h-4 w-4 accent-brand" checked={sel.has(t.id)} onChange={() => toggle(t.id)} aria-label={`Select ${t.title}`} />
                      </td>
                      <td className="border-t border-divider px-3 py-2.5">
                        <span className={cx("font-medium", t.status === "done" ? "text-faint line-through" : "text-ink")}>{t.title}</span>
                        <span className="block text-xs text-muted">
                          {t.customerName ? `${t.customerName} · ` : ""}
                          {fromWords(t, viewerId)}
                        </span>
                      </td>
                      <td className="border-t border-divider px-3 py-2.5">
                        <AppChip app={t.app} />
                      </td>
                      <td className="border-t border-divider px-3 py-2.5">
                        <StatusBadge status={t.status} />
                      </td>
                      <td className="border-t border-divider px-3 py-2.5">
                        <PriorityMark priority={t.priority} quiet={false} />
                      </td>
                      <td className="border-t border-divider px-3 py-2.5">
                        <DueText task={t} today={today} />
                      </td>
                      <td className="border-t border-divider px-3 py-2.5 text-body">{t.checklist.length ? `${t.checklist.filter((c) => c.done).length} of ${t.checklist.length}` : "—"}</td>
                      <td className="border-t border-divider px-3 py-2.5 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                        {isOpen(t) && !(t.transfer && t.transfer.toId === viewerId) ? (
                          <Button size="sm" onClick={() => openClose(t.id)}>
                            Mark done
                          </Button>
                        ) : !isOpen(t) ? (
                          <Button size="sm" onClick={() => openTask(t.id)}>
                            Reopen
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-card border border-line bg-surface px-6 py-12 text-center">
          <div className="text-[17px] font-semibold text-ink">No tasks match.</div>
          <Button variant="primary" className="mt-3" onClick={() => openNew(app !== "all" ? { app: app as TaskApp } : undefined)}>
            New task
          </Button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ Board */

const COLUMNS: [TaskStatus, string][] = [
  ["todo", "To do"],
  ["doing", "In progress"],
  ["waiting", "Waiting on someone"],
  ["done", "Done today"],
];

export function BoardScreen({ tasks, today, viewerId }: Base & { tasks: TaskRow[] }) {
  const router = useRouter();
  const toast = useToast();
  const { openTask, openClose, openNew } = useTaskDialogs();
  const [dragging, setDragging] = React.useState<string | null>(null);
  const [over, setOver] = React.useState<TaskStatus | null>(null);
  const [app, setApp] = React.useState("all");
  const apps = [...new Set(tasks.map((t) => t.app))];
  // Done is today's done: a column of everything ever finished is not a board.
  const mine = tasks.filter((t) => t.assigneeId === viewerId && (app === "all" || t.app === app) && (t.status !== "done" || t.closedOn === today));
  const drop = async (status: TaskStatus) => {
    const t = mine.find((x) => x.id === dragging);
    setDragging(null);
    setOver(null);
    if (!t || t.status === status) return;
    if (status === "done") return openClose(t.id);
    if (t.status === "done") return toast.push("Open the task and press Reopen first.", "error");
    const r = await toast.run(updateTask(t.id, { status: status as "todo" | "doing" | "waiting" }));
    if (r.ok) router.refresh();
  };
  return (
    <div className="mx-auto max-w-[1440px] px-6 pt-6 pb-14">
      <PageHeader
        title="Board"
        subtitle="Drag a card to move it. Dropping one on Done asks you to close it."
        actions={
          <>
            <Select value={app} onChange={(e) => setApp(e.target.value)} aria-label="App">
              <option value="all">Every app</option>
              {apps.map((a) => (
                <option key={a} value={a}>
                  {a === "tasks" ? "Personal" : TASK_APP_LABEL[a]}
                </option>
              ))}
            </Select>
            <Button variant="primary" onClick={() => openNew()}>
              + New task
            </Button>
          </>
        }
      />
      <div className="grid grid-cols-[repeat(4,minmax(240px,1fr))] gap-3 overflow-x-auto pb-2">
        {COLUMNS.map(([k, l]) => {
          const cards = mine.filter((t) => t.status === k);
          return (
            <div
              key={k}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(k);
              }}
              onDragLeave={() => setOver((o) => (o === k ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                void drop(k);
              }}
              className={cx("flex min-h-[380px] flex-col rounded-card border bg-page", over === k ? "border-brand shadow-[0_0_0_3px_var(--color-brand-soft)]" : "border-line")}
            >
              <div className="flex items-center gap-2 px-3 pt-3 pb-2 text-sm font-semibold text-ink">
                {l}
                <span className="min-w-5 rounded-full bg-divider px-1.5 text-center text-[11px] leading-[18px] font-semibold text-body">{cards.length}</span>
              </div>
              <div className="flex flex-1 flex-col gap-2 px-2.5 pb-3">
                {cards.map((t) => (
                  <div
                    key={t.id}
                    draggable
                    onDragStart={() => setDragging(t.id)}
                    onDragEnd={() => setDragging(null)}
                    onClick={() => openTask(t.id)}
                    className={cx("flex cursor-grab flex-col gap-2 rounded-card border border-line bg-surface px-3 py-2.5 hover:border-line-strong", dragging === t.id && "opacity-40")}
                  >
                    <div className={cx("text-[13.5px] font-medium", t.status === "done" ? "text-faint line-through" : "text-ink")}>{t.title}</div>
                    {t.customerName ? <div className="text-xs text-muted">{t.customerName}</div> : null}
                    <div className="flex flex-wrap items-center justify-between gap-1.5">
                      <span className="flex items-center gap-1.5">
                        <AppChip app={t.app} />
                        <PriorityMark priority={t.priority} />
                      </span>
                      <DueText task={t} today={today} />
                    </div>
                    {t.checklist.length ? (
                      <span className="block h-1 overflow-hidden rounded-full bg-divider" title={`${t.checklist.filter((c) => c.done).length} of ${t.checklist.length} steps`}>
                        <i className="block h-full bg-success" style={{ width: `${(t.checklist.filter((c) => c.done).length / t.checklist.length) * 100}%` }} />
                      </span>
                    ) : null}
                  </div>
                ))}
                {!cards.length ? <span className="px-1 py-2 text-[13px] text-muted">Nothing here.</span> : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- Transfers */

export function TransfersScreen({ incoming, outgoing, history, today, viewerId }: Base & { incoming: TaskRow[]; outgoing: TaskRow[]; history: TransferHistoryRow[] }) {
  const { openTask } = useTaskDialogs();
  const [tab, setTab] = React.useState<"in" | "out" | "history">(incoming.length || !outgoing.length ? "in" : "out");
  const tabs: ["in" | "out" | "history", string, number][] = [
    ["in", "Waiting for you", incoming.length],
    ["out", "Sent by you", outgoing.length],
    ["history", "History", history.length],
  ];
  const card = (t: TaskRow) => (
    <TaskRowItem
      key={t.id}
      task={t}
      today={today}
      viewerId={viewerId}
      onOpen={() => openTask(t.id)}
      extra={
        <Button size="sm" variant={t.transfer!.toId === viewerId ? "primary" : "secondary"} onClick={() => openTask(t.id)}>
          {t.transfer!.toId === viewerId ? "Review" : "Open"}
        </Button>
      }
    />
  );
  return (
    <div className="mx-auto max-w-[1440px] px-6 pt-6 pb-14">
      <PageHeader title="Transfers" subtitle="A colleague can hand you a task; it stays theirs until you accept. A manager above both people moves a task straight away." />
      <div className="mb-4 flex gap-5 border-b border-line">
        {tabs.map(([k, l, n]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={cx("-mb-px flex cursor-pointer items-center gap-1.5 border-b-2 pt-1.5 pb-2.5 text-sm whitespace-nowrap", tab === k ? "border-brand font-semibold text-ink" : "border-transparent text-muted hover:text-ink")}
          >
            {l}
            {n ? <span className={cx("rounded-full px-1.5 text-[11px] leading-[18px] font-semibold", k === "in" ? "bg-warn-soft text-warn-ink" : "bg-divider text-body")}>{n}</span> : null}
          </button>
        ))}
      </div>
      {tab === "in" ? <TaskListCard empty="Nobody is handing you a task.">{incoming.map(card)}</TaskListCard> : null}
      {tab === "out" ? <TaskListCard empty="You haven't asked anybody to take a task. Open one of yours and press Transfer.">{outgoing.map(card)}</TaskListCard> : null}
      {tab === "history" ? (
        history.length ? (
          <div className="overflow-x-auto rounded-card border border-line bg-surface">
            <table className="w-full min-w-[760px] border-separate border-spacing-0 text-[13px]">
              <thead>
                <tr>
                  {["Task", "From", "To", "What happened", "When"].map((h) => (
                    <th key={h} className="bg-ink px-3 py-2.5 text-left text-[11px] font-bold tracking-[0.05em] text-white uppercase first:rounded-tl-[7px] last:rounded-tr-[7px]">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td className="border-t border-divider px-3 py-2.5">
                      <span className="font-medium text-ink">{h.title}</span>
                      {h.note ? <span className="block text-xs text-muted">“{h.note}”</span> : h.reason ? <span className="block text-xs text-muted">“{h.reason}”</span> : null}
                    </td>
                    <td className="border-t border-divider px-3 py-2.5">{h.fromName}</td>
                    <td className="border-t border-divider px-3 py-2.5">{h.toName}</td>
                    <td className="border-t border-divider px-3 py-2.5">
                      {h.status === "accepted" ? (
                        <Badge tone="success">Accepted</Badge>
                      ) : h.status === "rejected" ? (
                        <Badge tone="danger">Rejected</Badge>
                      ) : h.status === "withdrawn" ? (
                        <Badge>Withdrawn</Badge>
                      ) : (
                        <Badge tone="brand">Moved by {h.decidedByName?.split(" ")[0]}</Badge>
                      )}
                    </td>
                    <td className="border-t border-divider px-3 py-2.5 whitespace-nowrap">{new Date(h.decidedAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: APP_TIMEZONE })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <TaskListCard empty="No transfers yet.">{[]}</TaskListCard>
        )
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------- Team */

export function TeamScreen({ tasks, people, today, viewerId, person }: Base & { tasks: TaskRow[]; people: TeamPerson[]; person: string | null }) {
  const router = useRouter();
  const { openNew } = useTaskDialogs();
  const rows = people.map((p) => {
    const ts = tasks.filter((t) => t.assigneeId === p.id);
    const open = ts.filter(isOpen);
    const late = open.filter((t) => daysUntil(t.dueDate, today) < 0).length;
    return { p, ts, open: open.length, late, today: open.filter((t) => t.dueDate === today).length, done: ts.length - open.length };
  });
  const sum = (k: "open" | "late" | "today" | "done") => rows.reduce((a, r) => a + r[k], 0);
  const picked = person ? people.find((p) => p.id === person) : null;
  const theirs = picked ? tasks.filter((t) => t.assigneeId === picked.id) : [];
  return (
    <div className="mx-auto max-w-[1440px] px-6 pt-6 pb-14">
      <PageHeader
        title="Team workload"
        subtitle="Everybody whose tasks you can see — below you on the org chart, or everyone if you hold the permission — and every task they have in every app."
        actions={
          <Button variant="primary" onClick={() => openNew()}>
            + Give a task
          </Button>
        }
      />
      <CardGrid min={180} gap="gap-3" className="mb-4">
        <FigureCard label="Open" value={sum("open")} sub={plural(people.length, "person", "people")} pct={100} />
        <FigureCard label="Late" value={sum("late")} sub={`${rows.filter((r) => r.late).length} with something late`} pct={sum("open") ? (sum("late") / sum("open")) * 100 : 0} tone="danger" />
        <FigureCard label="Due today" value={sum("today")} sub="In every app" pct={sum("open") ? (sum("today") / sum("open")) * 100 : 0} tone="brand" />
        <FigureCard label="Done" value={sum("done")} sub="In the last fortnight" pct={sum("done") + sum("open") ? (sum("done") / (sum("done") + sum("open"))) * 100 : 0} tone="success" />
      </CardGrid>
      <div className="overflow-x-auto rounded-card border border-line bg-surface">
        <table className="w-full min-w-[760px] border-separate border-spacing-0 text-[13px]">
          <thead>
            <tr>
              {["Person", "Open", "Late", "Due today", "Done", "Load", ""].map((h) => (
                <th key={h} className="bg-ink px-3 py-2.5 text-left text-[11px] font-bold tracking-[0.05em] text-white uppercase first:rounded-tl-[7px] last:rounded-tr-[7px]">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.p.id}
                className={cx("cursor-pointer hover:bg-[#f7f5fe]", person === r.p.id && "bg-brand-soft")}
                onClick={() => router.push(person === r.p.id ? "/tasks/team" : `/tasks/team?person=${r.p.id}`, { scroll: false })}
              >
                <td className="border-t border-divider px-3 py-2.5">
                  <span className="flex items-center gap-2.5">
                    <Avatar name={r.p.name} size={24} />
                    <span>
                      <span className="font-medium text-ink">{r.p.name}</span>
                      <span className="block text-xs text-muted">{r.p.apps.filter((a) => a !== "tasks").map((a) => TASK_APP_LABEL[a as TaskApp] ?? a).join(", ") || "Tasks"}</span>
                    </span>
                  </span>
                </td>
                <td className="border-t border-divider px-3 py-2.5">{r.open}</td>
                <td className="border-t border-divider px-3 py-2.5">{r.late ? <Badge tone="danger">{r.late}</Badge> : 0}</td>
                <td className="border-t border-divider px-3 py-2.5">{r.today}</td>
                <td className="border-t border-divider px-3 py-2.5">{r.done}</td>
                <td className="border-t border-divider px-3 py-2.5">
                  <span className="flex h-1.5 w-[160px] overflow-hidden rounded-full bg-divider" title={`${r.done} done, ${r.open - r.late} open, ${r.late} late`}>
                    <i className="block h-full bg-success" style={{ width: `${r.ts.length ? (r.done / r.ts.length) * 100 : 0}%` }} />
                    <i className="block h-full bg-brand-softer" style={{ width: `${r.ts.length ? ((r.open - r.late) / r.ts.length) * 100 : 0}%` }} />
                    <i className="block h-full bg-danger" style={{ width: `${r.ts.length ? (r.late / r.ts.length) * 100 : 0}%` }} />
                  </span>
                </td>
                <td className="border-t border-divider px-3 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                  {r.late && r.p.manage !== false ? <NudgeButton personId={r.p.id} /> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {picked ? (
        <>
          <div className="mt-6 mb-2.5 flex items-center gap-2 text-[15px] font-bold text-ink">
            {picked.name}
            <span className="flex-1" />
            <Button size="sm" onClick={() => openNew({ assigneeId: picked.id })}>
              + Give {picked.name.split(" ")[0]} a task
            </Button>
          </div>
          <TaskListCard empty="Nothing open, nothing closed lately.">{theirs.length ? <Rows list={theirs} today={today} viewerId={viewerId} /> : null}</TaskListCard>
        </>
      ) : (
        <p className="mt-4 text-[13px] text-muted">Pick a person to see every task they have.</p>
      )}
    </div>
  );
}

/** Tell somebody under you that something of theirs is late — one notification, naming how many. */
function NudgeButton({ personId }: { personId: string }) {
  const toast = useToast();
  const [sent, setSent] = React.useState(false);
  return (
    <Button
      size="sm"
      disabled={sent}
      onClick={async () => {
        const r = await toast.run(nudgePerson(personId));
        if (r.ok) setSent(true);
      }}
    >
      {sent ? "Nudged" : "Nudge"}
    </Button>
  );
}

/* ---------------------------------------------------------- Assigned by me */

export function AssignedScreen({ tasks, today, viewerId }: Base & { tasks: TaskRow[] }) {
  const { openTask, openNew } = useTaskDialogs();
  const batches = new Map<string, TaskRow[]>();
  const single: TaskRow[] = [];
  for (const t of tasks) {
    if (t.batchId) batches.set(t.batchId, [...(batches.get(t.batchId) ?? []), t]);
    else single.push(t);
  }
  return (
    <div className="mx-auto max-w-[1440px] px-6 pt-6 pb-14">
      <PageHeader
        title="Assigned by me"
        actions={
          <Button variant="primary" onClick={() => openNew()}>
            + Give a task
          </Button>
        }
      />
      {[...batches.values()].map((copies) => {
        const done = copies.filter((t) => t.status === "done").length;
        return (
          <div key={copies[0].batchId} className="mb-3 flex flex-col gap-3 rounded-card border border-line bg-surface px-5 py-4">
            <div className="flex flex-wrap items-start gap-4">
              <div className="min-w-[220px] flex-1">
                <div className="text-[15px] font-medium text-ink">{copies[0].title}</div>
                <div className="mt-1 flex items-center gap-1.5 text-[13px] text-muted">
                  <AppChip app={copies[0].app} /> {copies.length} copies, one each · given {new Date(copies[0].createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: APP_TIMEZONE })} · due <DueText task={copies[0]} today={today} />
                </div>
              </div>
              <div className="min-w-[200px]">
                <div className="mb-1.5 text-xs text-muted">
                  {done} of {copies.length} done
                </div>
                <span className="block h-1 overflow-hidden rounded-full bg-divider">
                  <i className="block h-full bg-success" style={{ width: `${(done / copies.length) * 100}%` }} />
                </span>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {copies.map((t) => (
                <button
                  key={t.id}
                  onClick={() => openTask(t.id)}
                  className={cx("inline-flex cursor-pointer items-center gap-1.5 rounded-full py-0.5 pr-2.5 pl-0.5 text-[12.5px]", t.status === "done" ? "bg-success-soft text-success" : "bg-divider text-body")}
                >
                  <Avatar name={t.assigneeName} size={18} /> {t.assigneeName.split(" ")[0]} · {STATUS_LABEL[t.status]}
                </button>
              ))}
            </div>
          </div>
        );
      })}
      <TaskListCard heading="Given to one person" count={single.length} empty="Nothing given to one person yet.">
        {single.map((t) => (
          <TaskRowItem
            key={t.id}
            task={t}
            today={today}
            viewerId={viewerId}
            showAssignee
            onOpen={() => openTask(t.id)}
            extra={t.status !== "done" && daysUntil(t.dueDate, today) < 0 ? <NudgeButton personId={t.assigneeId} /> : null}
            menu={<TaskMenu task={t} today={today} viewerId={viewerId} />}
          />
        ))}
      </TaskListCard>
    </div>
  );
}

/* ---------------------------------------------------------- TeleCRM's own */

export function CrmTasksScreen({ tasks, incoming, elsewhere, today, viewerId, hasTasksApp }: Base & { tasks: TaskRow[]; incoming: TaskRow[]; elsewhere: { count: number; apps: string[] }; hasTasksApp: boolean }) {
  const { openNew } = useTaskDialogs();
  const [tab, setTab] = React.useState<"now" | "late" | "upcoming" | "done" | "all">("now");
  const open = tasks.filter(isOpen);
  const lists = {
    now: open.filter((t) => daysUntil(t.dueDate, today) <= 0),
    late: open.filter((t) => daysUntil(t.dueDate, today) < 0),
    upcoming: open.filter((t) => daysUntil(t.dueDate, today) > 0),
    done: tasks.filter((t) => t.status === "done"),
    all: tasks,
  };
  const tabs: [keyof typeof lists, string][] = [
    ["now", "Needs action"],
    ["late", "Late"],
    ["upcoming", "Upcoming"],
    ["done", "Done"],
    ["all", "All"],
  ];
  const fromManager = open.filter((t) => t.kind === "assigned").length;
  return (
    <div>
      <PageHeader
        title="My tasks"
        subtitle="Everything you have to do in the CRM — tasks your manager gave you and ones you added. Closing one asks you to confirm it, and for whatever proof the task needs."
        actions={
          <Button variant="primary" onClick={() => openNew({ app: "crm" })}>
            New task
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap gap-8 rounded-card border border-line bg-surface px-5 py-3.5">
        {[
          ["Due today", open.filter((t) => t.dueDate === today).length, plural(open.filter((t) => t.dueDate === today && t.autoRule === "crm.callback").length, "callback") + " promised", "now"],
          ["Late", lists.late.length, lists.late.length ? `oldest by ${-daysUntil(lists.late[0].dueDate, today)} days` : "nothing late", "late"],
          ["Upcoming", lists.upcoming.length, "", "upcoming"],
          ["From your manager", fromManager, "", null],
          ["Done today", tasks.filter((t) => t.status === "done" && t.closedOn === today).length, "", "done"],
        ].map(([l, n, s, k]) => (
          <button key={l as string} type="button" disabled={!k} onClick={() => k && setTab(k as keyof typeof lists)} className="flex cursor-pointer flex-col text-left disabled:cursor-default">
            <span className="text-[12.5px] text-body">{l}</span>
            <span className={cx("text-[22px] leading-7 font-bold", l === "Late" && Number(n) > 0 ? "text-danger" : "text-ink")}>{n}</span>
            {s ? <span className="text-xs text-muted">{s}</span> : null}
          </button>
        ))}
      </div>
      <OfferedCallout incoming={incoming} />
      {elsewhere.count ? (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface px-4 py-3 text-sm text-body">
          <span className="flex-1">
            You also have <b className="text-ink">{plural(elsewhere.count, "task")} in other apps</b> — {elsewhere.apps.join(", ")}.
          </span>
          {hasTasksApp ? (
            <Link href="/tasks" className="text-sm font-medium text-brand">
              Open Tasks
            </Link>
          ) : null}
        </div>
      ) : null}
      <div className="overflow-hidden rounded-card border border-line bg-surface">
        <div className="flex gap-5 border-b border-line px-5">
          {tabs.map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} className={cx("-mb-px cursor-pointer border-b-2 pt-3 pb-2.5 text-sm whitespace-nowrap", tab === k ? "border-brand font-semibold text-ink" : "border-transparent text-muted hover:text-ink")}>
              {l} <span className="font-normal text-muted">{lists[k].length}</span>
            </button>
          ))}
        </div>
        {lists[tab].length ? <Rows list={lists[tab]} today={today} viewerId={viewerId} showApp={false} /> : <div className="px-5 py-8 text-center text-sm text-muted">Nothing here.</div>}
      </div>
    </div>
  );
}
