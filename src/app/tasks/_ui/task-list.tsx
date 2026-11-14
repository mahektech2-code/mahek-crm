"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { Button, Select, cx } from "@/components/ui/primitives";
import { Pager } from "@/components/ui/pager";
import { useToast } from "@/components/ui/toast";
import { RowMenu, type MenuItem } from "@/components/ui/overlays";
import { bulkUpdateTasks, updateTask } from "@/lib/actions/tasks";
import { taskIdsMatching } from "@/lib/actions/task-lists";
import type { TaskRow } from "@/lib/tasks/service";
import type { TaskListPage, TaskScopeSpec } from "@/lib/tasks/list-service";
import {
  BULK_CAP,
  TASK_KINDS,
  groupKeyOf,
  groupLabel,
  taskQueryHref,
  taskQueryParams,
  type TaskGroup,
  type TaskListDefaults,
  type TaskListQuery,
  type TaskTab,
} from "@/lib/tasks/list-query";
import { TASK_APP_LABEL, isClosed, plusDays, type TaskApp } from "@/lib/tasks/rules";
import { taskOpenHref } from "@/lib/tasks/automations";
import { AppChip, DueText, PriorityMark, StatusBadge, TaskRowItem, fromWords, KIND_LABEL } from "./kit";
import { useTaskDialogs } from "./dialogs";

/* ---------------------------------------------------------------------------
 * ONE TASK LIST, ONE PAGE AT A TIME.
 *
 * Every list in the Tasks app — All my tasks, By app, an app's own My tasks,
 * Done, a person on Team workload, Assigned by me, the transfers — draws
 * through this. It holds nothing the server did not send: the tab counts, the
 * app choices, each group's size and the total are the server's, over every
 * task the reading matches, and the rows are one page of them. Changing a tab,
 * a filter, the search, the grouping or the page changes the URL, and the
 * server answers the new reading. So a back button, a refresh and a link
 * pasted to a colleague all land on exactly the list somebody was looking at.
 * ------------------------------------------------------------------------- */

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;

export function Rows({
  list,
  today,
  viewerId,
  showApp = true,
  showAssignee = false,
  extra,
}: {
  list: TaskRow[];
  today: string;
  viewerId: string;
  showApp?: boolean;
  showAssignee?: boolean;
  extra?: (t: TaskRow) => React.ReactNode;
}) {
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
          extra={extra?.(t)}
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
  const open = !isClosed(t.status);
  const items: MenuItem[] = [{ label: "Open the task", onSelect: () => openTask(t.id) }];
  if (open && t.status !== "doing") items.push({ label: "Start it", onSelect: () => void act(updateTask(t.id, { status: "doing" })) });
  if (open && t.status !== "waiting") items.push({ label: "Waiting on someone", onSelect: () => void act(updateTask(t.id, { status: "waiting" })) });
  // A routine's task is due when its routine says; moving it would be a way round missing it.
  if (open && !t.routineId) items.push({ label: "Move to tomorrow", onSelect: () => void act(updateTask(t.id, { dueDate: plusDays(today, 1) })) });
  if (href && t.app !== "tasks") items.push({ label: `Open in ${TASK_APP_LABEL[t.app]}`, onSelect: () => router.push(href) });
  if (open && !t.transfer && !t.autoRule && t.assigneeId === viewerId) items.push({ label: "Transfer", onSelect: () => openTransfer(t.id) });
  return <RowMenu items={items} />;
}

export type ListTab = { key: TaskTab; label: string; tone?: "danger" };

const GROUP_LABEL: Record<TaskGroup, string> = { app: "App", due: "Due", priority: "Priority", source: "Where from", day: "Day closed", none: "Nothing" };

export function TaskListView({
  page,
  query,
  defaults,
  scope,
  tabs,
  today,
  viewerId,
  keep = {},
  look = "table",
  showAppFilter = true,
  showKindFilter = true,
  groups,
  showAssignee = false,
  showApp = true,
  extra,
  bulk = true,
  exportable = true,
  empty = "No tasks match.",
  onNew,
}: {
  page: TaskListPage;
  query: TaskListQuery;
  defaults: TaskListDefaults;
  scope: TaskScopeSpec;
  tabs: ListTab[];
  today: string;
  viewerId: string;
  /** The screen's own URL parameters, carried through every change of the list. */
  keep?: Record<string, string>;
  look?: "table" | "rows";
  showAppFilter?: boolean;
  showKindFilter?: boolean;
  /** The groupings offered; none, or one, draws no Group by. */
  groups?: readonly TaskGroup[];
  showAssignee?: boolean;
  showApp?: boolean;
  /** Something drawn at the end of each row, in the rows look. */
  extra?: (t: TaskRow) => React.ReactNode;
  bulk?: boolean;
  exportable?: boolean;
  empty?: string;
  onNew?: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  const { openTask, openClose, openCloseMany } = useTaskDialogs();
  const [pending, startTransition] = React.useTransition();
  const [text, setText] = React.useState(query.q);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sel, setSel] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);

  const go = (patch: Partial<TaskListQuery>) => {
    setSel(new Set());
    startTransition(() => router.push(taskQueryHref(pathname, query, patch, defaults, keep), { scroll: false }));
  };
  const onSearch = (v: string) => {
    setText(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => go({ q: v }), 350);
  };

  const rows = page.rows;
  const key = (t: TaskRow) => groupKeyOf(query.group, t, today);
  const heads = rows.map((t, i) => (query.group !== "none" && (i === 0 || key(rows[i - 1]) !== key(t)) ? key(t) : null));
  const picked = [...sel];
  const allOnPage = rows.length > 0 && rows.every((t) => sel.has(t.id));
  const toggle = (id: string) =>
    setSel((s0) => {
      const s1 = new Set(s0);
      if (s1.has(id)) s1.delete(id);
      else s1.add(id);
      return s1;
    });
  const selectEveryMatch = async () => {
    setBusy(true);
    const r = await taskIdsMatching(scope, taskQueryParams(query)).finally(() => setBusy(false));
    if (!r.ok) return toast.push(r.error, "error");
    setSel(new Set(r.data.ids));
    if (r.data.capped) toast.push(`Selected the first ${r.data.ids.length} of ${r.data.total.toLocaleString("en-IN")} — one action takes at most ${BULK_CAP}.`);
  };
  const runBulk = async (op: "doing" | "tomorrow") => {
    setBusy(true);
    const r = await toast.run(bulkUpdateTasks(picked, op)).finally(() => setBusy(false));
    if (r.ok) {
      setSel(new Set());
      router.refresh();
    }
  };
  const exportHref = `/api/tasks/export?${new URLSearchParams({ ...taskQueryParams(query), scope: JSON.stringify(scope) }).toString()}`;
  const groupOptions = groups ?? [];

  const headRow = (k: string, colSpan?: number) => {
    const n = page.groupCounts[k] ?? 0;
    const label = groupLabel(query.group, k, today);
    return colSpan ? (
      <tr key={`h-${k}`}>
        <td colSpan={colSpan} className="border-t border-[#c9d3e2] bg-[#dde4ef] px-3 py-2 text-[13px] font-bold text-black">
          {label} <span className="ml-1 font-medium text-muted">{plural(n, "task")}</span>
        </td>
      </tr>
    ) : (
      <div key={`h-${k}`} className="border-t border-[#c9d3e2] bg-[#dde4ef] px-4 py-2 text-[13px] font-bold text-black first:border-t-0">
        {label} <span className="ml-1 font-medium text-muted">{plural(n, "task")}</span>
      </div>
    );
  };

  return (
    <div className={cx("transition-opacity", pending && "opacity-60")} aria-busy={pending}>
      {tabs.length > 1 ? (
        <div className="mb-4 flex gap-5 overflow-x-auto border-b border-line">
          {tabs.map((t) => {
            const n = page.tabCounts[t.key];
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => go({ tab: t.key })}
                className={cx("-mb-px flex cursor-pointer items-center gap-1.5 border-b-2 pt-1.5 pb-2.5 text-sm whitespace-nowrap", query.tab === t.key ? "border-brand font-semibold text-ink" : "border-transparent text-muted hover:text-ink")}
              >
                {t.label}
                {n ? <span className={cx("rounded-full px-1.5 text-[11px] leading-[18px] font-semibold", t.tone === "danger" ? "bg-danger-soft text-danger" : "bg-divider text-body")}>{n.toLocaleString("en-IN")}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input value={text} onChange={(e) => onSearch(e.target.value)} placeholder="Search" aria-label="Search tasks" className="h-8.5 w-[280px] rounded-control border border-line bg-surface px-3 text-sm outline-none focus:border-brand" />
        {showAppFilter && page.apps.length > 1 ? (
          <Select value={query.app ?? "all"} onChange={(e) => go({ app: e.target.value === "all" ? null : (e.target.value as TaskApp) })} aria-label="App">
            <option value="all">Every app</option>
            {page.apps.map((a) => (
              <option key={a.app} value={a.app}>
                {a.app === "tasks" ? "Personal" : TASK_APP_LABEL[a.app]} ({a.n.toLocaleString("en-IN")})
              </option>
            ))}
          </Select>
        ) : null}
        {showKindFilter ? (
          <Select value={query.kind} onChange={(e) => go({ kind: e.target.value as TaskListQuery["kind"] })} aria-label="Where from">
            <option value="all">From anywhere</option>
            {TASK_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        ) : null}
        <span className="flex-1" />
        {groupOptions.length > 1 ? (
          <>
            <span className="text-[13px] text-muted">Group by</span>
            <Select value={query.group} onChange={(e) => go({ group: e.target.value as TaskGroup })} aria-label="Group by">
              {groupOptions.map((g) => (
                <option key={g} value={g}>
                  {GROUP_LABEL[g]}
                </option>
              ))}
            </Select>
          </>
        ) : null}
        {exportable ? (
          <a
            href={page.total ? exportHref : undefined}
            aria-disabled={!page.total}
            title={`Download every task this list matches${page.total ? ` (${page.total.toLocaleString("en-IN")})` : ""}, as a spreadsheet (CSV)`}
            className={cx("inline-flex h-8.5 items-center rounded-control border border-line bg-surface px-3 text-sm font-medium text-ink no-underline hover:no-underline", !page.total && "pointer-events-none opacity-50")}
          >
            Export
          </a>
        ) : null}
      </div>
      {bulk && picked.length ? (
        <div className="mb-2.5 flex flex-wrap items-center gap-2.5 rounded-card bg-ink px-3.5 py-2.5 text-[13.5px] text-white">
          <b>{picked.length.toLocaleString("en-IN")} selected</b>
          {allOnPage && page.total > rows.length && picked.length < Math.min(page.total, BULK_CAP) ? (
            <button type="button" disabled={busy} onClick={() => void selectEveryMatch()} className="cursor-pointer border-0 bg-transparent p-0 text-[13px] text-white underline disabled:opacity-50">
              Select all {page.total.toLocaleString("en-IN")} that match{page.total > BULK_CAP ? ` (first ${BULK_CAP})` : ""}
            </button>
          ) : null}
          {[
            ["Mark done", () => openCloseMany(picked)],
            ["Move to tomorrow", () => void runBulk("tomorrow")],
            ["Start", () => void runBulk("doing")],
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
      {rows.length ? (
        look === "table" ? (
          <div className="overflow-x-auto rounded-card border border-line bg-surface">
            <table className="w-full min-w-[900px] border-separate border-spacing-0 text-[13px]">
              <thead>
                <tr>
                  {bulk ? (
                    <th className="w-10 bg-ink px-3 py-2.5 first:rounded-tl-[7px]">
                      <input type="checkbox" className="h-4 w-4 accent-brand" checked={allOnPage} onChange={() => setSel(allOnPage ? new Set() : new Set(rows.map((t) => t.id)))} aria-label="Select this page" />
                    </th>
                  ) : null}
                  {["Task", ...(showAssignee ? ["For"] : []), "App", "Status", "Priority", "Due", "Checklist", ""].map((h) => (
                    <th key={h} className="bg-ink px-3 py-2.5 text-left text-[11px] font-bold tracking-[0.05em] whitespace-nowrap text-white uppercase first:rounded-tl-[7px] last:rounded-tr-[7px]">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((t, i) => (
                  <React.Fragment key={t.id}>
                    {heads[i] != null ? headRow(heads[i]!, (bulk ? 8 : 7) + (showAssignee ? 1 : 0)) : null}
                    <tr className={cx("cursor-pointer hover:bg-[#f7f5fe]", sel.has(t.id) && "bg-brand-soft")} onClick={() => openTask(t.id)}>
                      {bulk ? (
                        <td className="border-t border-divider px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                          <input type="checkbox" className="h-4 w-4 accent-brand" checked={sel.has(t.id)} onChange={() => toggle(t.id)} aria-label={`Select ${t.title}`} />
                        </td>
                      ) : null}
                      <td className="border-t border-divider px-3 py-2.5">
                        <span className={cx("font-medium", t.status === "done" ? "text-faint line-through" : t.status === "missed" ? "text-muted" : "text-ink")}>{t.title}</span>
                        <span className="block text-xs text-muted">
                          {t.customerName ? `${t.customerName} · ` : ""}
                          {fromWords(t, viewerId)}
                        </span>
                      </td>
                      {showAssignee ? <td className="border-t border-divider px-3 py-2.5 whitespace-nowrap">{t.assigneeName}</td> : null}
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
                        {!isClosed(t.status) && !(t.transfer && t.transfer.toId === viewerId) && (t.assigneeId === viewerId || showAssignee) ? (
                          <Button size="sm" onClick={() => openClose(t.id)}>
                            Mark done
                          </Button>
                        ) : t.status === "done" ? (
                          <Button size="sm" onClick={() => openTask(t.id)}>
                            Reopen
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  </React.Fragment>
                ))}
              </tbody>
            </table>
            <Pager look="v4" total={page.total} page={page.page} perPage={page.per} onPage={(p) => go({ page: p })} onPerPage={(n) => go({ per: n })} />
          </div>
        ) : (
          <div className="overflow-hidden rounded-card border border-line bg-surface">
            {rows.map((t, i) => (
              <React.Fragment key={t.id}>
                {heads[i] != null ? headRow(heads[i]!) : null}
                <Rows list={[t]} today={today} viewerId={viewerId} showApp={showApp} showAssignee={showAssignee} extra={extra} />
              </React.Fragment>
            ))}
            {page.total > rows.length || page.page > 1 ? (
              <div className="border-t border-divider">
                <Pager look="v4" total={page.total} page={page.page} perPage={page.per} onPage={(p) => go({ page: p })} onPerPage={(n) => go({ per: n })} />
              </div>
            ) : null}
          </div>
        )
      ) : (
        <div className="rounded-card border border-line bg-surface px-6 py-12 text-center">
          <div className="text-[17px] font-semibold text-ink">{query.q || query.app || query.kind !== "all" ? "No tasks match." : empty}</div>
          {onNew ? (
            <Button variant="primary" className="mt-3" onClick={onNew}>
              New task
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
