"use client";

import * as React from "react";
import { APP_TIMEZONE } from "@/lib/business-date";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Badge, Button, PageHeader, Select, cx } from "@/components/ui/primitives";
import { CardGrid } from "@/components/ui/card-grid";
import { Pager } from "@/components/ui/pager";
import { useToast } from "@/components/ui/toast";
import { nudgePerson, quickAddTask, updateTask } from "@/lib/actions/tasks";
import type { TaskRow } from "@/lib/tasks/service";
import type { AppSummary, BoardColumns, GivenBatch, MyDay, Section, TaskListPage, TransferHistoryRow, Workload } from "@/lib/tasks/list-service";
import {
  ALL_TASKS_LIST,
  APP_TASKS_LIST,
  BY_APP_LIST,
  GIVEN_LIST,
  PERSON_LIST,
  TRANSFER_LIST,
  type TaskListQuery,
} from "@/lib/tasks/list-query";
import { STATUS_LABEL, TASK_APP_LABEL, daysUntil, type TaskApp, type TaskStatus } from "@/lib/tasks/rules";
import { AppChip, Avatar, DueText, FigureCard, TaskListCard, KIND_LABEL, KindGlyph } from "./kit";
import { useTaskDialogs } from "./dialogs";
import { Rows, TaskListView, TaskMenu } from "./task-list";

export { Rows, TaskMenu };

/* ---------------------------------------------------------------------------
 * The Tasks app's screens. Every one draws what the server read for it — one
 * page of a list, or a capped preview with the whole count beside it — and
 * opens the same dialogs to act on it. None of them counts what it was sent:
 * a list of ten thousand tasks is read a page at a time (list-service.ts).
 * ------------------------------------------------------------------------- */

type Base = { today: string; viewerId: string };

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;

/** "Showing 25 of 1,240 · See all" under a capped preview. */
function MoreLink({ shown, total, href }: { shown: number; total: number; href: string }) {
  if (total <= shown) return null;
  return (
    <Link href={href} className="flex items-center justify-between border-t border-divider px-4 py-2.5 text-[13px] text-muted no-underline hover:bg-[#f7f5fe] hover:no-underline">
      <span>
        Showing {shown.toLocaleString("en-IN")} of {total.toLocaleString("en-IN")}
      </span>
      <span className="font-medium text-brand">See all</span>
    </Link>
  );
}

function OfferedCallout({ incoming }: { incoming: Section }) {
  const { openTask } = useTaskDialogs();
  const first = incoming.rows[0];
  if (!incoming.total || !first) return null;
  const from = first.transfer!.fromName.split(" ")[0];
  const more = incoming.total - 1;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-card border border-brand-softer bg-brand-soft px-4 py-3 text-sm text-body">
      <span className="flex-1">
        <b className="text-ink">
          {from}
          {more > 0 ? ` and ${more.toLocaleString("en-IN")} more` : ""}
        </b>{" "}
        want{more > 0 ? "" : "s"} to hand you {more > 0 ? plural(incoming.total, "task") : "a task"}. Review, then accept or reject.
      </span>
      <Button size="sm" onClick={() => openTask(first.id)}>
        Review
      </Button>
      {more > 0 ? (
        <Link href="/tasks/transfers" className="text-sm font-medium text-brand">
          See all
        </Link>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- My day */

export function MyDayScreen({
  day,
  byApp,
  incoming,
  today,
  viewerId,
  greeting,
  dateLine,
}: Base & { day: MyDay; byApp: { app: string; open: number; late: number }[]; incoming: Section; greeting: string; dateLine: string }) {
  const router = useRouter();
  const toast = useToast();
  const { openNew } = useTaskDialogs();
  const [text, setText] = React.useState("");
  const { late, today: due, soon, doneToday } = day;
  const total = late.total + due.total + doneToday.total;
  const pct = total ? Math.round((doneToday.total / total) * 100) : 0;
  const apps = byApp.filter((a) => a.open > 0);

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
        <FigureCard label="Late" value={late.total.toLocaleString("en-IN")} sub={late.total ? "Do these first" : "Nothing late"} pct={late.total ? 100 : 0} tone={late.total ? "danger" : "success"} />
        <FigureCard label="Due today" value={due.total.toLocaleString("en-IN")} sub={day.timedToday ? `${day.timedToday} at a set time` : "None at a set time"} pct={total ? (due.total / total) * 100 : 0} tone="brand" />
        <FigureCard label="Done today" value={doneToday.total.toLocaleString("en-IN")} sub={`${pct}% of today's work`} pct={pct} tone="success" />
        <FigureCard label="Across apps" value={apps.length} sub={apps.map((a) => (a.app === "tasks" ? "Personal" : (TASK_APP_LABEL[a.app as TaskApp] ?? a.app))).join(", ") || "Nothing open"} pct={100} />
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
          <TaskListCard heading="Late" count={late.total} tone="danger">
            {late.rows.length ? [<Rows key="r" list={late.rows} today={today} viewerId={viewerId} />, <MoreLink key="m" shown={late.rows.length} total={late.total} href="/tasks/all?tab=late&group=due" />] : null}
          </TaskListCard>
          <TaskListCard heading="Today" count={due.total} empty="Nothing else due today.">
            {due.rows.length ? [<Rows key="r" list={due.rows} today={today} viewerId={viewerId} />, <MoreLink key="m" shown={due.rows.length} total={due.total} href="/tasks/all?tab=today" />] : null}
          </TaskListCard>
          <TaskListCard heading="Next 3 days" count={soon.total} empty="Nothing in the next three days.">
            {soon.rows.length ? [<Rows key="r" list={soon.rows} today={today} viewerId={viewerId} />, <MoreLink key="m" shown={soon.rows.length} total={soon.total} href="/tasks/all?tab=upcoming&group=due" />] : null}
          </TaskListCard>
          <TaskListCard heading="Done today" count={doneToday.total}>
            {doneToday.rows.length ? [<Rows key="r" list={doneToday.rows} today={today} viewerId={viewerId} />, <MoreLink key="m" shown={doneToday.rows.length} total={doneToday.total} href="/tasks/done" />] : null}
          </TaskListCard>
        </div>
        <aside className="flex min-w-0 flex-col gap-4">
          <div className="overflow-hidden rounded-card border border-line bg-surface">
            <div className="border-b border-divider px-4 py-3 text-sm font-semibold text-ink">Where your work is</div>
            {apps.length ? (
              apps.map(({ app: a, open: n, late: l }) => {
                return (
                  <Link key={a} href={`/tasks/app/${a}`} className="flex items-center gap-2.5 border-t border-divider px-4 py-2 text-sm text-ink no-underline first:border-t-0 hover:bg-[#f7f5fe] hover:no-underline">
                    <AppChip app={a as TaskApp} />
                    <span className="flex-1">{a === "tasks" ? "Personal" : (TASK_APP_LABEL[a as TaskApp] ?? a)}</span>
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
                      {day.byKind[k].toLocaleString("en-IN")} {k === "self" ? "added by you" : KIND_LABEL[k].toLowerCase()}
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

/** A list read a page at a time, and what it needs to write its next URL. */
export type ListProps = { page: TaskListPage; query: TaskListQuery };

const ALL_TABS = [
  { key: "open", label: "Open" },
  { key: "late", label: "Late", tone: "danger" },
  { key: "today", label: "Today" },
  { key: "upcoming", label: "Upcoming" },
  { key: "doing", label: "In progress" },
  { key: "waiting", label: "Waiting" },
  { key: "done", label: "Done" },
  { key: "all", label: "Everything" },
] as const;

/** All my tasks, and By app with `lockApp`: every task of this person's, a page at a time. */
export function AllTasksScreen({ page, query, today, viewerId, lockApp = null }: Base & ListProps & { lockApp?: TaskApp | null }) {
  const { openNew } = useTaskDialogs();
  const app = lockApp ?? query.app;
  const title = !app ? "All my tasks" : app === "tasks" ? "Personal tasks" : `${TASK_APP_LABEL[app]} tasks`;
  const defaults = lockApp ? BY_APP_LIST : ALL_TASKS_LIST;
  return (
    <div className="mx-auto max-w-[1440px] px-6 pt-6 pb-14">
      <PageHeader
        title={title}
        actions={
          <Button variant="primary" onClick={() => openNew(app ? { app } : undefined)}>
            + New task
          </Button>
        }
      />
      <TaskListView
        page={page}
        query={query}
        defaults={defaults}
        scope={lockApp ? { kind: "mine", apps: [lockApp] } : { kind: "mine" }}
        tabs={[...ALL_TABS]}
        today={today}
        viewerId={viewerId}
        showAppFilter={!lockApp}
        groups={defaults.groups}
        onNew={() => openNew(app ? { app } : undefined)}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ Board */

const COLUMNS: [keyof BoardColumns, string, string][] = [
  ["todo", "To do", "/tasks/all?tab=open"],
  ["doing", "In progress", "/tasks/all?tab=doing"],
  ["waiting", "Waiting on someone", "/tasks/all?tab=waiting"],
  ["done", "Done today", "/tasks/done"],
];

/** The board: each column the first fifty, with the whole count — a column of a thousand cards is not a board. */
export function BoardScreen({ cols, apps, app, today }: Base & { cols: BoardColumns; apps: { app: string; open: number }[]; app: TaskApp | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  const { openTask, openClose, openNew } = useTaskDialogs();
  const [dragging, setDragging] = React.useState<string | null>(null);
  const [over, setOver] = React.useState<TaskStatus | null>(null);
  const all = [...cols.todo.rows, ...cols.doing.rows, ...cols.waiting.rows, ...cols.done.rows];
  const drop = async (status: TaskStatus) => {
    const t = all.find((x) => x.id === dragging);
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
            <Select value={app ?? "all"} onChange={(e) => router.push(e.target.value === "all" ? pathname : `${pathname}?app=${e.target.value}`, { scroll: false })} aria-label="App">
              <option value="all">Every app</option>
              {apps.map((a) => (
                <option key={a.app} value={a.app}>
                  {a.app === "tasks" ? "Personal" : (TASK_APP_LABEL[a.app as TaskApp] ?? a.app)}
                </option>
              ))}
            </Select>
            <Button variant="primary" onClick={() => openNew(app ? { app } : undefined)}>
              + New task
            </Button>
          </>
        }
      />
      <div className="grid grid-cols-[repeat(4,minmax(240px,1fr))] gap-3 overflow-x-auto pb-2">
        {COLUMNS.map(([k, l, href]) => {
          const col = cols[k];
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
                <span className="min-w-5 rounded-full bg-divider px-1.5 text-center text-[11px] leading-[18px] font-semibold text-body">{col.total.toLocaleString("en-IN")}</span>
              </div>
              <div className="flex flex-1 flex-col gap-2 px-2.5 pb-3">
                {col.rows.map((t) => (
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
                {!col.rows.length ? <span className="px-1 py-2 text-[13px] text-muted">Nothing here.</span> : null}
                {col.total > col.rows.length ? (
                  <Link href={`${href}${app ? `${href.includes("?") ? "&" : "?"}app=${app}` : ""}`} className="px-1 py-1 text-[13px] font-medium text-brand">
                    + {(col.total - col.rows.length).toLocaleString("en-IN")} more — see them as a list
                  </Link>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- Transfers */

export type TransfersView =
  | { tab: "in" | "out"; list: ListProps }
  | { tab: "history"; history: { rows: TransferHistoryRow[]; total: number; page: number; per: number } };

export function TransfersScreen({ view, counts, today, viewerId }: Base & { view: TransfersView; counts: { incoming: number; outgoing: number; history: number } }) {
  const router = useRouter();
  const pathname = usePathname();
  const { openTask } = useTaskDialogs();
  const tabs: ["in" | "out" | "history", string, number][] = [
    ["in", "Waiting for you", counts.incoming],
    ["out", "Sent by you", counts.outgoing],
    ["history", "History", counts.history],
  ];
  const go = (t: string, page?: number, per?: number) => {
    const p = new URLSearchParams();
    if (t !== "in") p.set("t", t);
    if (page && page > 1) p.set("page", String(page));
    if (per && per !== 50) p.set("per", String(per));
    const q = p.toString();
    router.push(q ? `${pathname}?${q}` : pathname, { scroll: false });
  };
  return (
    <div className="mx-auto max-w-[1440px] px-6 pt-6 pb-14">
      <PageHeader title="Transfers" subtitle="A colleague can hand you a task; it stays theirs until you accept. A manager above both people moves a task straight away." />
      <div className="mb-4 flex gap-5 border-b border-line">
        {tabs.map(([k, l, n]) => (
          <button
            key={k}
            onClick={() => go(k)}
            className={cx("-mb-px flex cursor-pointer items-center gap-1.5 border-b-2 pt-1.5 pb-2.5 text-sm whitespace-nowrap", view.tab === k ? "border-brand font-semibold text-ink" : "border-transparent text-muted hover:text-ink")}
          >
            {l}
            {n ? <span className={cx("rounded-full px-1.5 text-[11px] leading-[18px] font-semibold", k === "in" ? "bg-warn-soft text-warn-ink" : "bg-divider text-body")}>{n.toLocaleString("en-IN")}</span> : null}
          </button>
        ))}
      </div>
      {view.tab !== "history" ? (
        <TaskListView
          page={view.list.page}
          query={view.list.query}
          defaults={TRANSFER_LIST}
          scope={{ kind: view.tab === "in" ? "incoming" : "outgoing" }}
          keep={view.tab === "out" ? { t: "out" } : {}}
          tabs={[]}
          today={today}
          viewerId={viewerId}
          look="rows"
          bulk={false}
          exportable={false}
          empty={view.tab === "in" ? "Nobody is handing you a task." : "You haven't asked anybody to take a task. Open one of yours and press Transfer."}
          extra={(t) => (
            <Button size="sm" variant={t.transfer?.toId === viewerId ? "primary" : "secondary"} onClick={() => openTask(t.id)}>
              {t.transfer?.toId === viewerId ? "Review" : "Open"}
            </Button>
          )}
        />
      ) : view.history.total ? (
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
              {view.history.rows.map((h) => (
                <tr key={h.id} className="cursor-pointer hover:bg-[#f7f5fe]" onClick={() => openTask(h.taskId)}>
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
          <Pager look="v4" total={view.history.total} page={view.history.page} perPage={view.history.per} onPage={(p) => go("history", p, view.history.per)} onPerPage={(n) => go("history", 1, n)} />
        </div>
      ) : (
        <TaskListCard empty="No transfers yet.">{[]}</TaskListCard>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- Team */

/**
 * Team workload: a row per person with figures the database counted, a page
 * of people at a time, and — for a picked person — their tasks, a page at a
 * time. The figures above the table are the whole team's.
 */
export function TeamScreen({
  workload,
  q,
  person,
  personName,
  list,
  today,
  viewerId,
}: Base & { workload: Workload; q: string; person: string | null; personName: string | null; list: ListProps | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const { openNew } = useTaskDialogs();
  const [text, setText] = React.useState(q);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pending, startTransition] = React.useTransition();
  const href = (patch: { pq?: string; pp?: number; pper?: number; person?: string | null }) => {
    const p = new URLSearchParams();
    const pq = patch.pq ?? q;
    const pp = patch.pp ?? ("pq" in patch ? 1 : workload.page);
    const pper = patch.pper ?? workload.per;
    const who = patch.person === undefined ? person : patch.person;
    if (pq) p.set("pq", pq);
    if (pp > 1) p.set("pp", String(pp));
    if (pper !== 50) p.set("pper", String(pper));
    if (who) p.set("person", who);
    const s = p.toString();
    return s ? `${pathname}?${s}` : pathname;
  };
  const go = (patch: Parameters<typeof href>[0]) => startTransition(() => router.push(href(patch), { scroll: false }));
  const keep: Record<string, string> = {};
  if (q) keep.pq = q;
  if (workload.page > 1) keep.pp = String(workload.page);
  if (workload.per !== 50) keep.pper = String(workload.per);
  if (person) keep.person = person;
  const t = workload.totals;
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
        <FigureCard label="Open" value={t.open.toLocaleString("en-IN")} sub={plural(t.people, "person", "people")} pct={100} />
        <FigureCard label="Late" value={t.late.toLocaleString("en-IN")} sub={`${plural(t.withLate, "person", "people")} with something late`} pct={t.open ? (t.late / t.open) * 100 : 0} tone="danger" />
        <FigureCard label="Due today" value={t.today.toLocaleString("en-IN")} sub="In every app" pct={t.open ? (t.today / t.open) * 100 : 0} tone="brand" />
        <FigureCard label="Done" value={t.done.toLocaleString("en-IN")} sub="In the last fortnight" pct={t.done + t.open ? (t.done / (t.done + t.open)) * 100 : 0} tone="success" />
      </CardGrid>
      <div className="mb-3 flex items-center gap-2">
        <input
          value={text}
          onChange={(e) => {
            const v = e.target.value;
            setText(v);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => go({ pq: v.trim() }), 350);
          }}
          placeholder="Find a person"
          aria-label="Find a person"
          className="h-8.5 w-[280px] rounded-control border border-line bg-surface px-3 text-sm outline-none focus:border-brand"
        />
        <span className="text-[13px] text-muted">Most late first</span>
      </div>
      <div className={cx("overflow-x-auto rounded-card border border-line bg-surface transition-opacity", pending && "opacity-60")}>
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
            {workload.rows.map((r) => {
              const all = r.open + r.done;
              return (
                <tr key={r.id} className={cx("cursor-pointer hover:bg-[#f7f5fe]", person === r.id && "bg-brand-soft")} onClick={() => go({ person: person === r.id ? null : r.id })}>
                  <td className="border-t border-divider px-3 py-2.5">
                    <span className="flex items-center gap-2.5">
                      <Avatar name={r.name} size={24} />
                      <span>
                        <span className="font-medium text-ink">{r.name}</span>
                        <span className="block text-xs text-muted">{r.apps.filter((a) => a !== "tasks").map((a) => TASK_APP_LABEL[a as TaskApp] ?? a).join(", ") || "Tasks"}</span>
                      </span>
                    </span>
                  </td>
                  <td className="border-t border-divider px-3 py-2.5">{r.open.toLocaleString("en-IN")}</td>
                  <td className="border-t border-divider px-3 py-2.5">{r.late ? <Badge tone="danger">{r.late.toLocaleString("en-IN")}</Badge> : 0}</td>
                  <td className="border-t border-divider px-3 py-2.5">{r.today.toLocaleString("en-IN")}</td>
                  <td className="border-t border-divider px-3 py-2.5">{r.done.toLocaleString("en-IN")}</td>
                  <td className="border-t border-divider px-3 py-2.5">
                    <span className="flex h-1.5 w-[160px] overflow-hidden rounded-full bg-divider" title={`${r.done} done, ${r.open - r.late} open, ${r.late} late`}>
                      <i className="block h-full bg-success" style={{ width: `${all ? (r.done / all) * 100 : 0}%` }} />
                      <i className="block h-full bg-brand-softer" style={{ width: `${all ? ((r.open - r.late) / all) * 100 : 0}%` }} />
                      <i className="block h-full bg-danger" style={{ width: `${all ? (r.late / all) * 100 : 0}%` }} />
                    </span>
                  </td>
                  <td className="border-t border-divider px-3 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                    {r.late && r.manage ? <NudgeButton personId={r.id} /> : null}
                  </td>
                </tr>
              );
            })}
            {!workload.rows.length ? (
              <tr>
                <td colSpan={7} className="border-t border-divider px-3 py-6 text-center text-muted">
                  {q ? "Nobody matches." : "Nobody's tasks to show."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        {workload.people > workload.per || workload.page > 1 ? (
          <Pager look="v4" total={workload.people} page={workload.page} perPage={workload.per} onPage={(p) => go({ pp: p })} onPerPage={(n) => go({ pp: 1, pper: n })} />
        ) : null}
      </div>
      {person && personName && list ? (
        <>
          <div className="mt-6 mb-2.5 flex items-center gap-2 text-[15px] font-bold text-ink">
            {personName}
            <span className="flex-1" />
            <Button size="sm" onClick={() => openNew({ assigneeId: person })}>
              + Give {personName.split(" ")[0]} a task
            </Button>
          </div>
          <TaskListView
            key={person}
            page={list.page}
            query={list.query}
            defaults={PERSON_LIST}
            scope={{ kind: "person", personId: person }}
            keep={keep}
            tabs={[
              { key: "open", label: "Open" },
              { key: "late", label: "Late", tone: "danger" },
              { key: "done", label: "Done" },
              { key: "all", label: "Everything" },
            ]}
            today={today}
            viewerId={viewerId}
            look="rows"
            groups={PERSON_LIST.groups}
            showAssignee
            empty="Nothing open, nothing closed."
          />
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

/**
 * What this person gave out: groups as cards, a page of groups at a time, and
 * the tasks given to one person as a list, a page at a time. A group given to
 * five hundred people shows its first two dozen and counts the rest.
 */
export function AssignedScreen({
  batches,
  singles,
  today,
  viewerId,
}: Base & { batches: { rows: GivenBatch[]; total: number; page: number; per: number }; singles: ListProps }) {
  const router = useRouter();
  const pathname = usePathname();
  const { openTask, openNew } = useTaskDialogs();
  const keep: Record<string, string> = batches.page > 1 ? { bp: String(batches.page) } : {};
  const goBatches = (p: number) => {
    const sp = new URLSearchParams(window.location.search);
    if (p > 1) sp.set("bp", String(p));
    else sp.delete("bp");
    const s = sp.toString();
    router.push(s ? `${pathname}?${s}` : pathname, { scroll: false });
  };
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
      {batches.total ? (
        <>
          <div className="mb-2 text-[13px] font-medium text-body">Given to a group · {plural(batches.total, "group")}</div>
          {batches.rows.map((b) => {
            const due: TaskRow = { dueDate: b.dueDate, dueTime: b.dueTime, status: b.done === b.total ? "done" : "todo" } as TaskRow;
            return (
              <div key={b.id} className="mb-3 flex flex-col gap-3 rounded-card border border-line bg-surface px-5 py-4">
                <div className="flex flex-wrap items-start gap-4">
                  <div className="min-w-[220px] flex-1">
                    <div className="text-[15px] font-medium text-ink">{b.title}</div>
                    <div className="mt-1 flex items-center gap-1.5 text-[13px] text-muted">
                      <AppChip app={b.app} /> {b.audience} · {plural(b.total, "copy", "copies")} · given {new Date(b.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: APP_TIMEZONE })} · due <DueText task={due} today={today} />
                    </div>
                  </div>
                  <div className="min-w-[200px]">
                    <div className="mb-1.5 text-xs text-muted">
                      {b.done.toLocaleString("en-IN")} of {b.total.toLocaleString("en-IN")} done
                    </div>
                    <span className="block h-1 overflow-hidden rounded-full bg-divider">
                      <i className="block h-full bg-success" style={{ width: `${b.total ? (b.done / b.total) * 100 : 0}%` }} />
                    </span>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {b.people.map((p) => (
                    <button
                      key={p.taskId}
                      onClick={() => openTask(p.taskId)}
                      className={cx("inline-flex cursor-pointer items-center gap-1.5 rounded-full py-0.5 pr-2.5 pl-0.5 text-[12.5px]", p.status === "done" ? "bg-success-soft text-success" : "bg-divider text-body")}
                    >
                      <Avatar name={p.name} size={18} /> {p.name.split(" ")[0]} · {STATUS_LABEL[p.status]}
                    </button>
                  ))}
                  {b.total > b.people.length ? <span className="text-[12.5px] text-muted">+ {(b.total - b.people.length).toLocaleString("en-IN")} more</span> : null}
                </div>
              </div>
            );
          })}
          {batches.total > batches.per ? (
            <div className="mb-5 overflow-hidden rounded-card border border-line bg-surface">
              <Pager look="v4" total={batches.total} page={batches.page} perPage={batches.per} onPage={goBatches} onPerPage={() => undefined} />
            </div>
          ) : null}
        </>
      ) : null}
      <div className="mb-2 text-[13px] font-medium text-body">Given to one person</div>
      <TaskListView
        page={singles.page}
        query={singles.query}
        defaults={GIVEN_LIST}
        scope={{ kind: "given", singles: true }}
        keep={keep}
        tabs={[
          { key: "open", label: "Open" },
          { key: "late", label: "Late", tone: "danger" },
          { key: "done", label: "Done" },
          { key: "all", label: "Everything" },
        ]}
        today={today}
        viewerId={viewerId}
        look="rows"
        showAssignee
        bulk={false}
        empty="Nothing given to one person yet."
        extra={(t) => (t.status !== "done" && daysUntil(t.dueDate, today) < 0 ? <NudgeButton personId={t.assigneeId} /> : null)}
      />
    </div>
  );
}

/* ------------------------------------------------------- an app's own */

/**
 * AN APP'S OWN MY TASKS — TeleCRM's first, now every app's. The same rows as
 * the Tasks app, narrowed to the work that happens in this app and personal
 * tasks; what waits in other apps is counted and named, never hidden.
 */
export function AppTasksScreen({
  app,
  summary,
  incoming,
  elsewhere,
  list,
  today,
  viewerId,
  hasTasksApp,
}: Base & { app: TaskApp; summary: AppSummary; incoming: Section; elsewhere: { count: number; apps: TaskApp[] }; list: ListProps; hasTasksApp: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const { openNew } = useTaskDialogs();
  const tabHref = (tab: string) => (tab === APP_TASKS_LIST.tab ? pathname : `${pathname}?tab=${tab}`);
  return (
    <div>
      <PageHeader
        title="My tasks"
        subtitle={`Everything you have to do in ${TASK_APP_LABEL[app]} — tasks your manager gave you, ones the app raised, and ones you added. Closing one asks you to confirm it, and for whatever proof the task needs.`}
        actions={
          <Button variant="primary" onClick={() => openNew({ app })}>
            New task
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap gap-8 rounded-card border border-line bg-surface px-5 py-3.5">
        {(
          [
            ["Due today", summary.dueToday, app === "crm" ? `${plural(summary.callbacksToday, "callback")} promised` : "", "now"],
            ["Late", summary.late, summary.late ? `oldest by ${summary.oldestLateDays} days` : "nothing late", "late"],
            ["Upcoming", summary.upcoming, "", "upcoming"],
            ["From your manager", summary.fromManager, "", null],
            ["Done today", summary.doneToday, "", "done"],
          ] as [string, number, string, string | null][]
        ).map(([l, n, s, k]) => (
          <button key={l} type="button" disabled={!k} onClick={() => k && router.push(tabHref(k), { scroll: false })} className="flex cursor-pointer flex-col text-left disabled:cursor-default">
            <span className="text-[12.5px] text-body">{l}</span>
            <span className={cx("text-[22px] leading-7 font-bold", l === "Late" && n > 0 ? "text-danger" : "text-ink")}>{n.toLocaleString("en-IN")}</span>
            {s ? <span className="text-xs text-muted">{s}</span> : null}
          </button>
        ))}
      </div>
      <OfferedCallout incoming={incoming} />
      {elsewhere.count ? (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface px-4 py-3 text-sm text-body">
          <span className="flex-1">
            You also have <b className="text-ink">{plural(elsewhere.count, "task")} in other apps</b> — {elsewhere.apps.map((a) => (a === "tasks" ? "Personal" : (TASK_APP_LABEL[a] ?? a))).join(", ")}.
          </span>
          {hasTasksApp ? (
            <Link href="/tasks" className="text-sm font-medium text-brand">
              Open Tasks
            </Link>
          ) : null}
        </div>
      ) : null}
      <TaskListView
        page={list.page}
        query={list.query}
        defaults={APP_TASKS_LIST}
        scope={{ kind: "mine", apps: app === "tasks" ? ["tasks"] : [app, "tasks"] }}
        tabs={[
          { key: "now", label: "Needs action" },
          { key: "late", label: "Late", tone: "danger" },
          { key: "upcoming", label: "Upcoming" },
          { key: "done", label: "Done" },
          { key: "all", label: "All" },
        ]}
        today={today}
        viewerId={viewerId}
        look="rows"
        showApp={false}
        showAppFilter={false}
        bulk={false}
        empty="Nothing here."
      />
    </div>
  );
}
