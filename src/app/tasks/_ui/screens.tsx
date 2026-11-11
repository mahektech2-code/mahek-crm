"use client";

import * as React from "react";
import { APP_TIMEZONE } from "@/lib/business-date";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, PageHeader, Select, cx } from "@/components/ui/primitives";
import { CardGrid } from "@/components/ui/card-grid";
import { useToast } from "@/components/ui/toast";
import { quickAddTask, updateTask } from "@/lib/actions/tasks";
import type { TaskRow, TransferHistoryRow, TeamPerson } from "@/lib/tasks/service";
import { PRIORITY_LABEL, PRIORITY_RANK, STATUS_LABEL, TASK_APP_LABEL, daysUntil, type TaskApp, type TaskStatus } from "@/lib/tasks/rules";
import { AppChip, Avatar, DueText, FigureCard, PriorityMark, StatusBadge, TaskListCard, TaskRowItem, fromWords } from "./kit";
import { useTaskDialogs } from "./dialogs";

/* ---------------------------------------------------------------------------
 * The Tasks app's screens. Every one reads rows the server already narrowed
 * to what this person may see, and opens the same dialogs to act on them.
 * ------------------------------------------------------------------------- */

type Base = { today: string; viewerId: string };

const isOpen = (t: TaskRow) => t.status !== "done";
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function Rows({ list, today, viewerId, showApp = true, showAssignee = false }: { list: TaskRow[]; today: string; viewerId: string; showApp?: boolean; showAssignee?: boolean }) {
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
        />
      ))}
    </>
  );
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
        <FigureCard label="Across apps" value={apps.length} sub={apps.map((a) => TASK_APP_LABEL[a]).join(", ") || "Nothing open"} pct={100} />
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

export function AllTasksScreen({ tasks, today, viewerId, startApp }: Base & { tasks: TaskRow[]; startApp: string | null }) {
  const { openTask, openClose, openNew } = useTaskDialogs();
  const [tab, setTab] = React.useState<Tab>("open");
  const [app, setApp] = React.useState<string>(startApp ?? "all");
  const [q, setQ] = React.useState("");
  const [group, setGroup] = React.useState<"app" | "due" | "priority" | "none">("app");
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
      (!term || `${t.title} ${t.customerName ?? ""} ${t.createdByName}`.toLowerCase().includes(term)),
  );
  const keyOf = (t: TaskRow) =>
    group === "app" ? TASK_APP_LABEL[t.app] : group === "priority" ? PRIORITY_LABEL[t.priority] : group === "due" ? (t.status === "done" ? "Done" : daysUntil(t.dueDate, today) < 0 ? "Late" : daysUntil(t.dueDate, today) === 0 ? "Today" : daysUntil(t.dueDate, today) === 1 ? "Tomorrow" : "Later") : "";
  const order = group === "priority" ? (t: TaskRow) => PRIORITY_RANK[t.priority] : () => 0;
  const sorted = [...list].sort((a, b) => keyOf(a).localeCompare(keyOf(b)) || order(a) - order(b));
  if (group === "due") {
    const rank: Record<string, number> = { Late: 0, Today: 1, Tomorrow: 2, Later: 3, Done: 4 };
    sorted.sort((a, b) => rank[keyOf(a)] - rank[keyOf(b)]);
  }
  /* Each row knows whether it opens a group: the key differs from the row above. */
  const heads = sorted.map((t, i) => (group !== "none" && (i === 0 || keyOf(sorted[i - 1]) !== keyOf(t)) ? keyOf(t) : null));
  return (
    <div className="mx-auto max-w-[1440px] px-6 pt-6 pb-14">
      <PageHeader
        title={app === "all" ? "All my tasks" : `${TASK_APP_LABEL[app as TaskApp]} tasks`}
        actions={
          <Button variant="primary" onClick={() => openNew(app !== "all" ? { app: app as TaskApp } : undefined)}>
            + New task
          </Button>
        }
      />
      <div className="mb-4 flex gap-5 overflow-x-auto border-b border-line">
        {tabs.map(([k, l, n]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={cx("-mb-px flex cursor-pointer items-center gap-1.5 border-b-2 pt-1.5 pb-2.5 text-sm whitespace-nowrap", tab === k ? "border-brand font-semibold text-ink" : "border-transparent text-muted hover:text-ink")}
          >
            {l}
            {n ? <span className={cx("rounded-full px-1.5 text-[11px] leading-[18px] font-semibold", k === "late" ? "bg-danger-soft text-danger" : "bg-warn-soft text-warn-ink")}>{n}</span> : null}
          </button>
        ))}
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search tasks" className="h-8.5 w-[280px] rounded-control border border-line bg-surface px-3 text-sm outline-none focus:border-brand" />
        <Select value={app} onChange={(e) => setApp(e.target.value)} aria-label="App">
          <option value="all">Every app</option>
          {apps.map((a) => (
            <option key={a} value={a}>
              {TASK_APP_LABEL[a]}
            </option>
          ))}
        </Select>
        <span className="flex-1" />
        <span className="text-[13px] text-muted">Group by</span>
        <Select value={group} onChange={(e) => setGroup(e.target.value as typeof group)} aria-label="Group by">
          <option value="app">App</option>
          <option value="due">Due</option>
          <option value="priority">Priority</option>
          <option value="none">Nothing</option>
        </Select>
      </div>
      {sorted.length ? (
        <div className="overflow-x-auto rounded-card border border-line bg-surface">
          <table className="w-full min-w-[860px] border-separate border-spacing-0 text-[13px]">
            <thead>
              <tr>
                {["Task", "App", "Status", "Priority", "Due", "Checklist", ""].map((h) => (
                  <th key={h} className="bg-ink px-3 py-2.5 text-left text-[11px] font-bold tracking-[0.05em] whitespace-nowrap text-white uppercase first:rounded-tl-[7px] last:rounded-tr-[7px]">
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
                        <td colSpan={7} className="border-t border-[#c9d3e2] bg-[#dde4ef] px-3 py-2 text-[13px] font-bold text-black">
                          {head} <span className="ml-1 font-medium text-muted">{plural(sorted.filter((x) => keyOf(x) === head).length, "task")}</span>
                        </td>
                      </tr>
                    ) : null}
                    <tr className="cursor-pointer hover:bg-[#f7f5fe]" onClick={() => openTask(t.id)}>
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
                      <td className="border-t border-divider px-3 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                        {isOpen(t) && !(t.transfer && t.transfer.toId === viewerId) ? (
                          <Button size="sm" onClick={() => openClose(t.id)}>
                            Mark done
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
          <div className="text-[17px] font-semibold text-ink">No tasks here.</div>
          <Button variant="primary" className="mt-3" onClick={() => openNew()}>
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
  ["done", "Done"],
];

export function BoardScreen({ tasks, today, viewerId }: Base & { tasks: TaskRow[] }) {
  const router = useRouter();
  const toast = useToast();
  const { openTask, openClose, openNew } = useTaskDialogs();
  const [dragging, setDragging] = React.useState<string | null>(null);
  const [over, setOver] = React.useState<TaskStatus | null>(null);
  const mine = tasks.filter((t) => t.assigneeId === viewerId);
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
          <Button variant="primary" onClick={() => openNew()}>
            + New task
          </Button>
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
        subtitle="Everybody below you on the org chart, and every task they have in every app."
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
              {["Person", "Open", "Late", "Due today", "Done", "Load"].map((h) => (
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
                    <span className="font-medium text-ink">{r.p.name}</span>
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
                  <AppChip app={copies[0].app} /> {copies.length} copies, one each · <DueText task={copies[0]} today={today} />
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
        {single.length ? <Rows list={single} today={today} viewerId={viewerId} showAssignee /> : null}
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
  const fromManager = open.filter((t) => t.createdById !== t.assigneeId).length;
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
          ["Due today", open.filter((t) => t.dueDate === today).length, "", "now"],
          ["Late", lists.late.length, lists.late.length ? `oldest by ${-daysUntil(lists.late[0].dueDate, today)} days` : "nothing late", "late"],
          ["Upcoming", lists.upcoming.length, "", "upcoming"],
          ["From your manager", fromManager, "", null],
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
