"use client";

import * as React from "react";
import { APP_TIMEZONE } from "@/lib/business-date";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Badge, Button, Field, Input, Select, Textarea, cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { DialogBody, DialogFooter, DialogHeader, DialogTitle, ErpDialog, StepBar, TabBar } from "@/app/erp/_ui/dialog";
import {
  addTaskNote,
  closeTask,
  closeTasks,
  createTask,
  decideTransfer,
  deleteTask,
  loadTaskDetail,
  loadTaskOptions,
  loadTransferCandidates,
  reopenTask,
  toggleChecklistItem,
  transferTask,
  updateTask,
  withdrawTransfer,
  type TaskOptions,
  type TransferCandidate,
} from "@/lib/actions/tasks";
import {
  MAX_PROOFS,
  PRIORITY_LABEL,
  REMARK_MIN,
  STATUS_LABEL,
  TASK_APP_LABEL,
  TASK_PRIORITIES,
  clock12,
  closeProblems,
  dueWords,
  isTaskApp,
  newTaskProblems,
  isClosed,
  plusDays,
  type TaskApp,
  type TaskPriority,
} from "@/lib/tasks/rules";
import type { TaskDetail } from "@/lib/tasks/service";
import { AppChip, Avatar, KIND_LABEL, KindGlyph, PriorityMark, StatusBadge } from "./kit";
import { taskOpenHref } from "@/lib/tasks/automations";
import { AudienceBuilder, CloseRules, RepeatPicker, ScheduleFields, closeWords, type Repeat, type ScheduleState } from "./fields";
import { saveRoutine } from "@/lib/actions/task-routines";
import { EMPTY_AUDIENCE, audienceProblems, audienceWords, type Audience } from "@/lib/tasks/audience";
import { WORKING_WEEK, routineProblems, scheduleWords, windowWords } from "@/lib/tasks/routines";

/* ---------------------------------------------------------------------------
 * EVERY TASKS DIALOG, opened from any screen through one context.
 *
 * A task opens in the middle of the screen with tabs, a new task is a form in
 * pages, and closing is two steps — say it is done, then show it — exactly as
 * the ERP draws its records and forms (app/erp/_ui/dialog.tsx). A `?task=`
 * in the address opens that task, which is where every notification lands.
 * ------------------------------------------------------------------------- */

type Ctx = {
  openTask: (id: string) => void;
  openNew: (defaults?: { app?: TaskApp; assigneeId?: string }) => void;
  openClose: (id: string) => void;
  openTransfer: (id: string) => void;
  /** Close several with one confirmation and one remark — the selection bar's Mark done. */
  openCloseMany: (ids: string[]) => void;
};

const TaskDialogContext = React.createContext<Ctx | null>(null);

export function useTaskDialogs(): Ctx {
  const ctx = React.useContext(TaskDialogContext);
  if (!ctx) throw new Error("useTaskDialogs must be used inside <TaskDialogs>");
  return ctx;
}

type Open =
  | { kind: "task"; id: string; key: number }
  | { kind: "new"; app?: TaskApp; assigneeId?: string; key: number }
  | { kind: "close"; id: string; key: number }
  | { kind: "transfer"; id: string; key: number }
  | { kind: "closeMany"; ids: string[]; key: number };

export function TaskDialogs({ children, defaultApp = "tasks" }: { children: React.ReactNode; defaultApp?: TaskApp }) {
  const params = useSearchParams();
  const fromUrl = params.get("task");
  const [stack, setStack] = React.useState<Open[]>(() => (fromUrl ? [{ kind: "task", id: fromUrl, key: 1 }] : []));
  const seq = React.useRef(2);
  const push = React.useCallback((o: Omit<Open, "key"> & Record<string, unknown>) => setStack((s) => [...s, { ...(o as Open), key: seq.current++ }]), []);
  const pop = React.useCallback(() => setStack((s) => s.slice(0, -1)), []);
  /* After a close or a transfer, the record it was opened from is out of date too. */
  const dropTask = (id: string) => setStack((s) => s.filter((x) => !("id" in x) || x.id !== id));
  const top = stack[stack.length - 1];
  const ctx = React.useMemo<Ctx>(
    () => ({
      openTask: (id) => push({ kind: "task", id }),
      openNew: (d) => push({ kind: "new", app: d?.app ?? defaultApp, assigneeId: d?.assigneeId }),
      openClose: (id) => push({ kind: "close", id }),
      openTransfer: (id) => push({ kind: "transfer", id }),
      openCloseMany: (ids) => (ids.length === 1 ? push({ kind: "close", id: ids[0] }) : ids.length ? push({ kind: "closeMany", ids }) : undefined),
    }),
    [push, defaultApp],
  );
  return (
    <TaskDialogContext.Provider value={ctx}>
      {children}
      {/* Only the top dialog is drawn: a dialog is portalled to <body>, so one
          lower in the stack cannot be hidden by a wrapper, and two open at once
          would both answer Escape. Going back re-opens the one beneath. */}
      {top ? (
        <React.Fragment key={top.key}>
          {top.kind === "task" ? <RecordDialog id={top.id} onClose={pop} ctx={ctx} /> : null}
          {top.kind === "new" ? <NewTaskDialog app={top.app ?? defaultApp} assigneeId={top.assigneeId} onClose={pop} /> : null}
          {top.kind === "close" ? <CloseDialog id={top.id} onClose={pop} onDone={() => dropTask(top.id)} /> : null}
          {top.kind === "transfer" ? <TransferDialog id={top.id} onClose={pop} onDone={() => dropTask(top.id)} /> : null}
          {top.kind === "closeMany" ? <CloseManyDialog ids={top.ids} onClose={pop} /> : null}
        </React.Fragment>
      ) : null}
    </TaskDialogContext.Provider>
  );
}

type Detail = TaskDetail & { today: string; viewerId: string };

function useDetail(id: string) {
  const [state, setState] = React.useState<{ d: Detail | null; error: string | null; v: number }>({ d: null, error: null, v: 0 });
  const [v, setV] = React.useState(0);
  React.useEffect(() => {
    let live = true;
    void loadTaskDetail(id).then((r) => {
      if (!live) return;
      setState(r.ok ? { d: r.data, error: null, v } : { d: null, error: r.error, v });
    });
    return () => {
      live = false;
    };
  }, [id, v]);
  return { ...state, reload: () => setV((n) => n + 1) };
}

/* ------------------------------------------------------------ the record */

function RecordDialog({ id, onClose, ctx }: { id: string; onClose: () => void; ctx: Ctx }) {
  const router = useRouter();
  const toast = useToast();
  const { d, error, reload } = useDetail(id);
  const [tab, setTab] = React.useState("details");
  const [rejecting, setRejecting] = React.useState(false);
  const [rejectNote, setRejectNote] = React.useState("");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const act = async (p: Promise<{ ok: boolean; message?: string; error?: string }>, close = false) => {
    setBusy(true);
    const r = await toast.run(p).finally(() => setBusy(false));
    if (r.ok) {
      router.refresh();
      if (close) onClose();
      else reload();
    }
    return r;
  };

  if (!d) {
    return (
      <ErpDialog onClose={onClose} label="Task" size="lg" tall={false}>
        <DialogHeader onClose={onClose}>
          <DialogTitle>{error ? "Task not found" : "Opening the task…"}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm text-muted">{error ?? "One moment."}</p>
        </DialogBody>
      </ErpDialog>
    );
  }

  const t = d.task;
  const steps = t.checklist.length;
  const ticked = t.checklist.filter((c) => c.done).length;
  const tabs = [
    { key: "details", label: "Details" },
    ...(steps ? [{ key: "steps", label: "Checklist", count: `${ticked}/${steps}` }] : []),
    { key: "activity", label: "Activity", count: d.events.length },
  ];
  const offeredToMe = t.transfer && t.transfer.toId === d.viewerId;

  return (
    <ErpDialog onClose={onClose} label="Task" size="lg">
      <DialogHeader onClose={onClose}>
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <AppChip app={t.app} long />
          <StatusBadge status={t.status} />
          <PriorityMark priority={t.priority} />
          {t.assigneeId !== d.viewerId ? (
            <span className="inline-flex items-center gap-1.5 text-[13px] text-muted">
              <Avatar name={t.assigneeName} size={18} /> {t.assigneeName}&rsquo;s task
            </span>
          ) : null}
        </div>
        <DialogTitle>{t.title}</DialogTitle>
      </DialogHeader>
      <TabBar tabs={tabs} active={tab} onChange={setTab} />
      <DialogBody>
        {t.transfer ? (
          <div className="flex flex-wrap items-center gap-3 rounded-card border border-warn-line bg-warn-soft px-4 py-3 text-sm text-body">
            {offeredToMe ? (
              <>
                <span className="min-w-[240px] flex-1">
                  <b className="text-ink">{t.transfer.fromName}</b> wants to hand you this task. {t.transfer.reason ? <>“{t.transfer.reason}”</> : null} It stays theirs until you accept.
                </span>
                {rejecting ? (
                  <span className="flex w-full flex-wrap gap-2">
                    <Input
                      autoFocus
                      className="min-w-[220px] flex-1"
                      value={rejectNote}
                      onChange={(e) => setRejectNote(e.target.value)}
                      placeholder={`Why you can't take it — ${t.transfer.fromName.split(" ")[0]} reads this`}
                    />
                    <Button size="sm" onClick={() => setRejecting(false)}>
                      Back
                    </Button>
                    <Button size="sm" variant="danger" disabled={busy || rejectNote.trim().length < 3} onClick={() => void act(decideTransfer(t.id, { accept: false, note: rejectNote }), true)}>
                      Reject
                    </Button>
                  </span>
                ) : (
                  <>
                    <Button size="sm" onClick={() => setRejecting(true)}>
                      Reject
                    </Button>
                    <Button size="sm" variant="primary" disabled={busy} onClick={() => void act(decideTransfer(t.id, { accept: true }))}>
                      Accept
                    </Button>
                  </>
                )}
              </>
            ) : (
              <>
                <span className="flex-1">
                  Waiting for <b className="text-ink">{t.transfer.toName}</b> to accept. It stays with {t.transfer.fromId === d.viewerId ? "you" : t.transfer.fromName.split(" ")[0]} until then.
                </span>
                {d.can.withdrawTransfer ? (
                  <Button size="sm" disabled={busy} onClick={() => void act(withdrawTransfer(t.id))}>
                    Withdraw
                  </Button>
                ) : null}
              </>
            )}
          </div>
        ) : null}

        {tab === "details" ? <DetailsTab d={d} busy={busy} act={act} /> : null}

        {tab === "steps" ? (
          <div className="rounded-card border border-line px-4 py-1">
            {t.checklist.map((c, i) => (
              <label key={i} className="flex items-center gap-3 border-t border-divider py-2.5 text-sm text-ink first:border-t-0">
                <input type="checkbox" className="h-4 w-4 accent-brand" checked={c.done} disabled={!d.can.close || busy} onChange={() => void act(toggleChecklistItem(t.id, i))} />
                <span className={c.done ? "text-faint line-through" : undefined}>{c.text}</span>
              </label>
            ))}
          </div>
        ) : null}

        {tab === "activity" ? (
          <div className="flex flex-col gap-3.5">
            {d.events.map((e) => (
              <div key={e.id} className="grid grid-cols-[24px_minmax(0,1fr)] gap-2.5 text-[13.5px]">
                <Avatar name={e.actorName ?? "MahekOne"} size={22} />
                <div>
                  <span className="text-xs text-muted">
                    <b className="text-ink">{e.actorName ?? "MahekOne"}</b> · {new Date(e.at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: APP_TIMEZONE })}
                  </span>
                  <div className="mt-1 rounded-card border border-divider bg-page px-3 py-2 text-ink">{e.body}</div>
                </div>
              </div>
            ))}
            {d.can.note ? (
              <form
                className="mt-1 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(addTaskNote(t.id, note)).then((r) => r.ok && setNote(""));
                }}
              >
                <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note — whoever gave it and whoever holds it see it" />
                <Button type="submit" disabled={busy || !note.trim()}>
                  Add
                </Button>
              </form>
            ) : null}
          </div>
        ) : null}
      </DialogBody>
      <DialogFooter
        left={
          d.can.delete ? (
            <button type="button" className="cursor-pointer text-danger hover:underline" disabled={busy} onClick={() => void act(deleteTask(t.id), true)}>
              Delete
            </button>
          ) : null
        }
      >
        {d.can.transfer ? (
          <Button onClick={() => ctx.openTransfer(t.id)} disabled={busy}>
            Transfer
          </Button>
        ) : null}
        {d.can.edit && !t.routineId ? (
          <Button onClick={() => void act(updateTask(t.id, { dueDate: plusDays(d.today, 1) }))} disabled={busy}>
            Move to tomorrow
          </Button>
        ) : null}
        {d.can.close ? (
          <Button variant="primary" onClick={() => ctx.openClose(t.id)} disabled={busy}>
            Mark done
          </Button>
        ) : null}
        {d.can.reopen ? (
          <Button onClick={() => void act(reopenTask(t.id))} disabled={busy}>
            Reopen
          </Button>
        ) : null}
        {!d.can.close && !d.can.reopen && !d.can.transfer ? <Button onClick={onClose}>Close</Button> : null}
      </DialogFooter>
    </ErpDialog>
  );
}

function DetailsTab({ d, busy, act }: { d: Detail; busy: boolean; act: (p: Promise<{ ok: boolean; message?: string; error?: string }>) => Promise<unknown> }) {
  const t = d.task;
  const edit = d.can.edit && !busy;
  const href = taskOpenHref(t);
  return (
    <>
      {t.status === "done" ? (
        <div className="rounded-card border border-success-soft bg-success-soft px-4 py-3">
          <div className="text-sm font-semibold text-success">
            Closed {t.closedAt ? new Date(t.closedAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: APP_TIMEZONE }) : ""} by {t.closedByName}
          </div>
          {t.closeRemark ? <div className="mt-1 text-sm text-ink">“{t.closeRemark}”</div> : null}
          {d.proofs.length ? (
            <div className="mt-2.5 flex flex-wrap gap-2">
              {d.proofs.map((p) => (
                <a key={p.id} href={`/api/attachments/${p.id}`} target="_blank" rel="noopener noreferrer" title={p.filename}>
                  {p.isImage ? (
                    // eslint-disable-next-line @next/next/no-img-element -- a stored screenshot, served by the attachment endpoint
                    <img src={`/api/attachments/${p.id}`} alt={p.filename} className="h-24 rounded-md border border-line object-cover" />
                  ) : (
                    <span className="inline-flex h-24 items-center rounded-md border border-line bg-surface px-3 text-xs text-body">{p.filename}</span>
                  )}
                </a>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {t.status === "missed" ? (
        <div className="rounded-card border border-danger-soft bg-danger-soft px-4 py-3">
          <div className="text-sm font-semibold text-danger">Missed</div>
          <div className="mt-1 text-sm text-ink">{t.closeRemark ?? "Not done by its due time."} A routine&apos;s task belongs to its own day, so it can&apos;t be done later — the next one comes with its own day.</div>
        </div>
      ) : null}

      {d.origin.auto && t.status !== "done" ? (
        <div className="flex items-center gap-2.5 rounded-card bg-brand-soft px-4 py-2.5 text-[13.5px] text-body">
          <KindGlyph kind="auto" />
          <span>
            Raised by {t.app === "tasks" ? "Tasks" : TASK_APP_LABEL[t.app]} when {d.origin.auto.when.charAt(0).toLowerCase() + d.origin.auto.when.slice(1)}. It closes itself when {d.origin.auto.closes.charAt(0).toLowerCase() + d.origin.auto.closes.slice(1)}.
          </span>
        </div>
      ) : null}

      {t.customerName || (href && t.app !== "tasks") ? (
        <div className="flex flex-wrap items-center gap-3 rounded-card border border-line px-4 py-3">
          <AppChip app={t.app} />
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-ink">{t.customerName ?? (t.app === "tasks" ? "Personal" : TASK_APP_LABEL[t.app])}</div>
            <div className="text-xs text-muted">{t.customerName ? `The record this task is about, in ${t.app === "tasks" ? "TeleCRM" : TASK_APP_LABEL[t.app]}` : "Where this work is done"}</div>
          </div>
          {t.app === "crm" && t.customerId && !isClosed(t.status) && t.assigneeId === d.viewerId ? (
            <Link href={`/crm/customers/${t.customerId}?call=1`} className="inline-flex h-8 items-center rounded-control border border-brand bg-brand px-3 text-[13px] font-semibold text-white no-underline hover:bg-brand-hover hover:no-underline">
              Call
            </Link>
          ) : null}
          {href ? (
            <Link href={href} className="text-sm font-medium text-brand">
              Open in {t.app === "tasks" ? "TeleCRM" : TASK_APP_LABEL[t.app]}
            </Link>
          ) : null}
        </div>
      ) : null}

      <div className="grid grid-cols-3 gap-x-5 gap-y-4 rounded-card border border-line p-4 max-md:grid-cols-1">
        <Item label="Status">
          {edit ? (
            <Select
              value={t.status}
              onChange={(e) => void act(updateTask(t.id, { status: e.target.value as "todo" | "doing" | "waiting" }))}
              aria-label="Status"
            >
              {(["todo", "doing", "waiting"] as const).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </Select>
          ) : (
            <StatusBadge status={t.status} />
          )}
        </Item>
        <Item label="Due">
          {edit && !t.routineId ? (
            <span className="flex gap-2">
              <Input type="date" className="w-[150px]" defaultValue={t.dueDate} onBlur={(e) => e.target.value && e.target.value !== t.dueDate && void act(updateTask(t.id, { dueDate: e.target.value }))} aria-label="Due day" />
              <Input type="time" className="w-[110px]" defaultValue={t.dueTime ?? ""} onBlur={(e) => (e.target.value || null) !== t.dueTime && void act(updateTask(t.id, { dueTime: e.target.value || null }))} aria-label="Due time" />
            </span>
          ) : (
            <span>
              {dueWords(t.dueDate, d.today)}
              {t.dueTime ? ` · ${clock12(t.dueTime)}` : ""}
            </span>
          )}
        </Item>
        <Item label="Priority">
          {edit ? (
            <Select value={t.priority} onChange={(e) => void act(updateTask(t.id, { priority: e.target.value as TaskPriority }))} aria-label="Priority">
              {TASK_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </Select>
          ) : (
            PRIORITY_LABEL[t.priority]
          )}
        </Item>
        <Item label="Assigned to">
          <span className="inline-flex items-center gap-2">
            <Avatar name={t.assigneeName} /> {t.assigneeName}
          </span>
        </Item>
        <Item label="Given by">
          {t.kind === "auto" ? `${t.app === "tasks" ? "Tasks" : TASK_APP_LABEL[t.app]}, automatically` : t.createdById === t.assigneeId ? `Added by ${t.createdByName.split(" ")[0]}` : t.createdByName}
        </Item>
        <Item label="App">
          <span className="inline-flex items-center gap-2">
            <AppChip app={t.app} /> {TASK_APP_LABEL[t.app]}
          </span>
        </Item>
        <Item label="To close it">
          {d.can.setProof ? (
            <span className="flex flex-wrap gap-2">
              <Select value={t.proofRequired ? "1" : "0"} disabled={busy} onChange={(e) => void act(updateTask(t.id, { proofRequired: e.target.value === "1" }))} aria-label="Screenshot when closing" className="w-auto">
                <option value="1">Screenshot required</option>
                <option value="0">Screenshot optional</option>
              </Select>
              <Select value={t.remarkRequired ? "1" : "0"} disabled={busy} onChange={(e) => void act(updateTask(t.id, { remarkRequired: e.target.value === "1" }))} aria-label="Remarks when closing" className="w-auto">
                <option value="1">Remarks required</option>
                <option value="0">Remarks optional</option>
              </Select>
            </span>
          ) : (
            <span>
              {closeWords(t.proofRequired, t.remarkRequired)}
              {t.createdById !== d.viewerId && t.createdById !== t.assigneeId ? <span className="text-muted"> · set by {t.createdByName.split(" ")[0]}</span> : null}
            </span>
          )}
        </Item>
        <Item label="Where from">
          <span className="inline-flex items-center gap-1.5">
            <KindGlyph kind={t.kind} /> {KIND_LABEL[t.kind]}
          </span>
        </Item>
        {d.origin.repeats ? <Item label="Repeats">{d.origin.repeats}</Item> : null}
        {d.origin.partOf ? (
          <Item label="Part of">
            {d.origin.partOf.audience} · {d.origin.partOf.done} of {d.origin.partOf.total} done
          </Item>
        ) : null}
      </div>

      {t.note ? (
        <div className="rounded-card border border-line px-4 py-3 text-sm">
          <div className="mb-1 text-xs text-muted">Note</div>
          <div className="whitespace-pre-wrap text-ink">{t.note}</div>
        </div>
      ) : null}
    </>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[12.5px] text-muted">{label}</div>
      <div className="text-sm font-medium text-ink">{children}</div>
    </div>
  );
}

/* --------------------------------------------------------------- closing */

type Proof = { key: number; name: string; preview: string; id: string | null; error: string | null };

/**
 * Closing is two steps, and the first one is a question: is it done? Only
 * then the evidence — a remark and a screenshot, each where the task asks.
 * The server asks the same things again (`closeProblems`).
 */
function CloseDialog({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const { d, error } = useDetail(id);
  const [step, setStep] = React.useState(0);
  const [confirmed, setConfirmed] = React.useState(false);
  const [remark, setRemark] = React.useState("");
  const [proofs, setProofs] = React.useState<Proof[]>([]);
  const [problems, setProblems] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const seq = React.useRef(1);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const add = React.useCallback((files: File[]) => {
    const room = MAX_PROOFS - proofs.length;
    for (const f of files.filter((x) => x.type.startsWith("image/") || x.type === "application/pdf").slice(0, Math.max(0, room))) {
      const key = seq.current++;
      const preview = f.type.startsWith("image/") ? URL.createObjectURL(f) : "";
      setProofs((p) => [...p, { key, name: f.name || "screenshot.png", preview, id: null, error: null }]);
      const body = new FormData();
      body.append("file", f, f.name || "screenshot.png");
      void fetch("/api/tasks/proof", { method: "POST", body })
        .then((r) => r.json())
        .then((r: { ok: boolean; data?: { id: string }; error?: string }) =>
          setProofs((p) => p.map((x) => (x.key === key ? { ...x, id: r.ok ? r.data!.id : null, error: r.ok ? null : (r.error ?? "It did not upload.") } : x))),
        )
        .catch(() => setProofs((p) => p.map((x) => (x.key === key ? { ...x, error: "It did not upload — check the connection." } : x))));
    }
    setProblems((p) => ({ ...p, proof: "" }));
  }, [proofs.length]);

  React.useEffect(() => {
    if (step !== 1) return;
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.items ?? [])].filter((i) => i.type.startsWith("image/")).map((i) => i.getAsFile()).filter((f): f is File => Boolean(f));
      if (files.length) {
        e.preventDefault();
        add(files);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [step, add]);

  if (!d) {
    return (
      <ErpDialog onClose={onClose} label="Close the task" size="sm" tall={false}>
        <DialogHeader onClose={onClose}>
          <DialogTitle>{error ? "Task not found" : "Close the task"}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm text-muted">{error ?? "One moment."}</p>
        </DialogBody>
      </ErpDialog>
    );
  }
  const t = d.task;
  const uploading = proofs.some((p) => !p.id && !p.error);
  const ready = proofs.filter((p) => p.id);
  const unticked = t.checklist.filter((c) => !c.done).length;

  const next = () => {
    if (!confirmed) return setProblems({ confirmed: "Tick the box to say it is done." });
    setProblems({});
    setStep(1);
  };
  const submit = async () => {
    const local = closeProblems({ confirmed, remark, proofs: ready.length, proofRequired: t.proofRequired, remarkRequired: t.remarkRequired });
    if (local.length) return setProblems(Object.fromEntries(local.map((p) => [p.field, p.message])));
    setBusy(true);
    const r = await closeTask(t.id, { confirmed, remark, attachmentIds: ready.map((p) => p.id!) }).finally(() => setBusy(false));
    if (!r.ok) {
      setProblems(Object.fromEntries((r.fieldErrors ?? [{ field: "remark", message: r.error }]).map((f) => [f.field, f.message])));
      return;
    }
    toast.push(t.createdById !== d.viewerId ? `Closed — ${t.createdByName.split(" ")[0]} is told` : "Closed");
    router.refresh();
    onDone();
  };

  return (
    <ErpDialog onClose={onClose} label="Close the task" size="sm" tall={false}>
      <DialogHeader onClose={onClose}>
        <DialogTitle>Close the task</DialogTitle>
      </DialogHeader>
      <StepBar steps={["Is it done?", "Proof"]} active={step} reached={step} onChange={setStep} />
      <DialogBody>
        {step === 0 ? (
          <>
            <div className="rounded-card border border-line px-4 py-3">
              <div className="mb-1 flex items-center gap-2 text-[13px] text-muted">
                <AppChip app={t.app} /> {t.customerName}
              </div>
              <div className="text-[15px] font-medium text-ink">{t.title}</div>
            </div>
            {unticked ? (
              <div className="rounded-card border border-warn-line bg-warn-soft px-4 py-2.5 text-sm text-warn-ink">
                {unticked} checklist step{unticked === 1 ? " is" : "s are"} not ticked.
              </div>
            ) : null}
            <Field label="Have you finished this?" required error={problems.confirmed || null} group>
              <label className={cx("flex cursor-pointer items-start gap-3 rounded-card border px-4 py-3 text-sm text-ink", confirmed ? "border-brand bg-brand-soft" : "border-line")}>
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-brand"
                  checked={confirmed}
                  onChange={(e) => {
                    setConfirmed(e.target.checked);
                    setProblems({});
                  }}
                />
                <span>
                  Yes — {t.assigneeId === d.viewerId ? "I have" : `${t.assigneeName.split(" ")[0]} has`} done this, and it can be closed.
                </span>
              </label>
            </Field>
            <p className="text-[13px] text-muted">
              Next {t.remarkRequired ? "you write what was done" : "you can say what was done"}
              {t.proofRequired ? " and add a screenshot — this task needs one" : ". A screenshot is optional"}.
            </p>
          </>
        ) : (
          <>
            <Field label="Screenshot" required={t.proofRequired} optional={!t.proofRequired} error={problems.proof || null} group>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className={cx(
                  "flex w-full cursor-pointer flex-col items-center gap-1.5 rounded-card border-[1.5px] border-dashed bg-page px-4 py-5 text-center text-sm text-muted",
                  problems.proof ? "border-danger" : "border-line-strong",
                )}
              >
                <span>
                  <b className="text-brand">Choose a screenshot</b> or paste one with Ctrl+V
                </span>
                <span className="text-xs">JPG, PNG or PDF — up to {MAX_PROOFS}</span>
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*,application/pdf"
                multiple
                hidden
                onChange={(e) => {
                  add([...(e.target.files ?? [])]);
                  e.target.value = "";
                }}
              />
              {proofs.length ? (
                <div className="mt-2.5 flex flex-wrap gap-2.5">
                  {proofs.map((p) => (
                    <div key={p.key} className="relative">
                      {p.preview ? (
                        // eslint-disable-next-line @next/next/no-img-element -- a local preview of the file being uploaded
                        <img src={p.preview} alt={p.name} className={cx("h-20 rounded-md border object-cover", p.error ? "border-danger opacity-50" : "border-line", !p.id && !p.error && "opacity-60")} />
                      ) : (
                        <span className="inline-flex h-20 items-center rounded-md border border-line px-3 text-xs">{p.name}</span>
                      )}
                      <button
                        type="button"
                        aria-label={`Remove ${p.name}`}
                        onClick={() => setProofs((ps) => ps.filter((x) => x.key !== p.key))}
                        className="absolute top-1 right-1 grid h-6 w-6 cursor-pointer place-items-center rounded-full border border-line bg-surface text-xs"
                      >
                        ✕
                      </button>
                      {p.error ? <div className="mt-1 max-w-[160px] text-xs text-danger">{p.error}</div> : !p.id ? <div className="mt-1 text-xs text-muted">Uploading…</div> : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </Field>
            <Field label="Remarks" required={t.remarkRequired} optional={!t.remarkRequired} error={problems.remark || null} hint={t.createdById !== d.viewerId ? `${t.createdByName.split(" ")[0]} reads this.` : undefined} hintShown>
              <Textarea
                rows={4}
                value={remark}
                invalid={Boolean(problems.remark)}
                onChange={(e) => {
                  setRemark(e.target.value);
                  if (e.target.value.trim().length >= REMARK_MIN) setProblems((p) => ({ ...p, remark: "" }));
                }}
                placeholder="What was done — e.g. “Spoke to the owner, he pays on Friday.”"
              />
            </Field>
          </>
        )}
      </DialogBody>
      <DialogFooter left={`Step ${step + 1} of 2`}>
        {step === 0 ? (
          <>
            <Button onClick={onClose}>Not yet</Button>
            <Button variant="primary" onClick={next}>
              Yes, it&rsquo;s done
            </Button>
          </>
        ) : (
          <>
            <Button onClick={() => setStep(0)} disabled={busy}>
              Back
            </Button>
            <Button variant="primary" onClick={() => void submit()} disabled={busy || uploading}>
              {uploading ? "Uploading…" : "Close the task"}
            </Button>
          </>
        )}
      </DialogFooter>
    </ErpDialog>
  );
}

/* ------------------------------------------------------------- transfers */

/* ------------------------------------------------------- close several */

/**
 * Closing several at once: one "it is done" and one remark for all of them.
 * A task that needs a screenshot cannot be in the batch — a screenshot is
 * evidence about one task — and the dialog says so before anything is sent.
 */
function CloseManyDialog({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [rows, setRows] = React.useState<Detail[] | null>(null);
  const [step, setStep] = React.useState(0);
  const [confirmed, setConfirmed] = React.useState(false);
  const [remark, setRemark] = React.useState("");
  const [problems, setProblems] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    let live = true;
    void Promise.all(ids.map((id) => loadTaskDetail(id))).then((rs) => {
      if (live) setRows(rs.filter((r) => r.ok).map((r) => (r as { ok: true; data: Detail }).data));
    });
    return () => {
      live = false;
    };
  }, [ids]);
  const proof = rows?.filter((r) => r.task.proofRequired) ?? [];
  const needRemark = rows?.some((r) => r.task.remarkRequired) ?? true;
  const finish = async () => {
    const local = closeProblems({ confirmed, remark, proofs: 0, proofRequired: false, remarkRequired: needRemark });
    if (local.length) return setProblems(Object.fromEntries(local.map((p) => [p.field, p.message])));
    setBusy(true);
    const r = await toast.run(closeTasks(ids, { confirmed, remark })).finally(() => setBusy(false));
    if (r.ok) {
      router.refresh();
      onClose();
    }
  };
  return (
    <ErpDialog onClose={onClose} label="Close tasks" size="sm" tall={false}>
      <DialogHeader onClose={onClose}>
        <DialogTitle>Close {ids.length} tasks</DialogTitle>
      </DialogHeader>
      <StepBar steps={["Is it done?", "Proof"]} active={step} reached={step} onChange={(i) => i < step && setStep(i)} />
      <DialogBody>
        {!rows ? <p className="text-sm text-muted">One moment.</p> : null}
        {rows && proof.length ? (
          <div className="rounded-card border border-warn-line bg-warn-soft px-4 py-3 text-sm text-body">
            {proof.length === 1 ? "One of these needs" : `${proof.length} of these need`} a screenshot: <b className="text-ink">{proof.map((p) => p.task.title).join(", ")}</b>. Close {proof.length === 1 ? "it" : "those"} on {proof.length === 1 ? "its" : "their"} own — untick {proof.length === 1 ? "it" : "them"} and try again.
          </div>
        ) : null}
        {rows && !proof.length && step === 0 ? (
          <div className="flex flex-col gap-4">
            <div className="rounded-card border border-line px-4 py-3 text-sm text-ink">{rows.map((r) => r.task.title).join(" · ")}</div>
            <Field label="Have you finished these?" required error={problems.confirmed || null} group>
              <label className={cx("flex cursor-pointer items-center gap-2.5 rounded-card border px-3.5 py-3 text-sm", confirmed ? "border-brand bg-brand-soft" : "border-line")}>
                <input type="checkbox" className="h-4 w-4 accent-brand" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                Yes — all of these are done and can be closed.
              </label>
            </Field>
          </div>
        ) : null}
        {rows && !proof.length && step === 1 ? (
          <Field label="Remarks" required={needRemark} optional={!needRemark} error={problems.remark || null} hint="Written on every one of them." hintShown>
            <Textarea rows={4} value={remark} invalid={Boolean(problems.remark)} onChange={(e) => setRemark(e.target.value)} placeholder="What was done" />
          </Field>
        ) : null}
      </DialogBody>
      <DialogFooter left={`Step ${step + 1} of 2`}>
        {step === 0 ? (
          <>
            <Button onClick={onClose}>Not yet</Button>
            <Button
              variant="primary"
              disabled={!rows || proof.length > 0}
              onClick={() => {
                if (!confirmed) return setProblems({ confirmed: "Tick the box to say they are done." });
                setProblems({});
                setStep(1);
              }}
            >
              Yes, they&apos;re done
            </Button>
          </>
        ) : (
          <>
            <Button onClick={() => setStep(0)}>Back</Button>
            <Button variant="primary" disabled={busy} onClick={() => void finish()}>
              Close {ids.length} tasks
            </Button>
          </>
        )}
      </DialogFooter>
    </ErpDialog>
  );
}

function TransferDialog({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [people, setPeople] = React.useState<TransferCandidate[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [q, setQ] = React.useState("");
  const [to, setTo] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState("");
  const [problems, setProblems] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    void loadTransferCandidates(id).then((r) => {
      if (!live) return;
      if (r.ok) setPeople(r.data);
      else setLoadError(r.error);
    });
    return () => {
      live = false;
    };
  }, [id]);

  const pick = people?.find((p) => p.id === to) ?? null;
  const shown = (people ?? []).filter((p) => !q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 60);
  const submit = async () => {
    if (!pick) return setProblems({ to: "Pick who takes it." });
    if (pick.route === "request" && reason.trim().length < 3) return setProblems({ reason: "Say why — they read this before they decide." });
    setBusy(true);
    const r = await transferTask(id, { toId: pick.id, reason }).finally(() => setBusy(false));
    if (!r.ok) return setProblems(Object.fromEntries((r.fieldErrors ?? [{ field: "to", message: r.error }]).map((f) => [f.field, f.message])));
    toast.push(r.message ?? "Done");
    router.refresh();
    onDone();
  };

  return (
    <ErpDialog onClose={onClose} label="Transfer the task" size="sm">
      <DialogHeader onClose={onClose}>
        <DialogTitle>Transfer the task</DialogTitle>
      </DialogHeader>
      <DialogBody>
        {loadError ? <p className="text-sm text-danger">{loadError}</p> : null}
        <Field label="Transfer to" required error={problems.to || null} group>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people" aria-label="Search people" />
          <div className="mt-2 flex max-h-[260px] flex-col gap-1 overflow-y-auto">
            {people === null ? <span className="py-2 text-sm text-muted">Finding people…</span> : null}
            {people && !shown.length ? <span className="py-2 text-sm text-muted">Nobody here can take it.</span> : null}
            {shown.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  setTo(p.id);
                  setProblems({});
                }}
                className={cx("flex cursor-pointer items-center gap-2.5 rounded-control border px-3 py-2 text-left text-sm", to === p.id ? "border-brand bg-brand-soft text-brand-hover" : "border-line hover:bg-canvas")}
              >
                <Avatar name={p.name} size={24} />
                <span className="flex-1 font-medium">{p.name}</span>
                {p.route === "move" ? <Badge tone="brand">Moves now</Badge> : <Badge>Asks first</Badge>}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Why" required={pick?.route !== "move"} optional={pick?.route === "move"} error={problems.reason || null}>
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={pick?.route === "move" ? "Optional — both of them see it" : "They read this before they decide"} />
        </Field>
        {pick ? (
          <div className="rounded-card bg-brand-soft px-4 py-3 text-sm text-body">
            {pick.route === "move"
              ? `You manage both of them, so it moves to ${pick.name.split(" ")[0]} straight away. Both are told.`
              : `${pick.name.split(" ")[0]} reviews it and accepts or rejects. It stays where it is until then.`}
          </div>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => void submit()} disabled={busy || !pick}>
          {pick?.route === "move" ? "Move the task" : "Send for acceptance"}
        </Button>
      </DialogFooter>
    </ErpDialog>
  );
}

/* --------------------------------------------------------------- new task */

type CustomerHit = { id: string; name: string; city: string | null };

function NewTaskDialog({ app: startApp, assigneeId, onClose }: { app: TaskApp; assigneeId?: string; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [opts, setOpts] = React.useState<TaskOptions | null>(null);
  const [step, setStep] = React.useState(0);
  const [reached, setReached] = React.useState(0);
  const [title, setTitle] = React.useState("");
  const [app, setApp] = React.useState<string>(startApp);
  const [customer, setCustomer] = React.useState<CustomerHit | null>(null);
  const [checklist, setChecklist] = React.useState("");
  const [note, setNote] = React.useState("");
  const [proof, setProof] = React.useState(false);
  const [remarkReq, setRemarkReq] = React.useState(true);
  const [who, setWho] = React.useState<"me" | "rules">(assigneeId ? "rules" : "me");
  const [audience, setAudience] = React.useState<Audience>(() => (assigneeId ? { include: [{ kind: "person", value: assigneeId, label: "" }], exclude: [] } : EMPTY_AUDIENCE));
  const [repeat, setRepeat] = React.useState<Repeat>("once");
  const [sched, setSched] = React.useState<ScheduleState>({ weekdays: WORKING_WEEK, dayOfMonth: "1", completeByDay: "", startTime: "", dueTime: "" });
  const [dueDate, setDueDate] = React.useState("");
  const [dueTime, setDueTime] = React.useState("");
  const [priority, setPriority] = React.useState<TaskPriority>("normal");
  const [problems, setProblems] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    void loadTaskOptions().then((r) => {
      if (!live || !r.ok) return;
      setOpts(r.data);
      setDueDate((d) => d || r.data.today);
      setApp((a) => (r.data.apps.includes(a) ? a : r.data.apps.includes("crm") ? "crm" : "tasks"));
    });
    return () => {
      live = false;
    };
  }, []);

  const hasTeam = Boolean(opts?.team.length);
  const routineInput = () => ({
    title,
    app,
    priority,
    frequency: repeat === "once" ? "daily" : repeat,
    weekdays: sched.weekdays,
    dayOfMonth: repeat === "monthly" && sched.dayOfMonth ? Number(sched.dayOfMonth) : null,
    completeByDay: repeat === "monthly" && sched.completeByDay ? Number(sched.completeByDay) : null,
    startTime: sched.startTime || null,
    dueTime: sched.dueTime || null,
    note,
  });
  const steps = ["Task", "Who and when", "Review"];
  const go = (i: number) => {
    if (i > step && step === 0) {
      const p = newTaskProblems({ title, app, dueDate: dueDate || "2000-01-01", priority }).filter((x) => x.field === "title" || x.field === "app");
      if (p.length) return setProblems(Object.fromEntries(p.map((x) => [x.field, x.message])));
    }
    if (i > step && step === 1) {
      const p = repeat === "once" ? newTaskProblems({ title, app, dueDate, dueTime, priority }) : routineProblems(routineInput());
      if (who === "rules") p.push(...audienceProblems(audience));
      if (p.length) return setProblems(Object.fromEntries(p.map((x) => [x.field, x.message])));
    }
    setProblems({});
    setStep(i);
    setReached((r) => Math.max(r, i));
  };
  const save = async () => {
    setBusy(true);
    const rules = who === "rules" ? audience : null;
    const r =
      repeat === "once"
        ? await createTask({
            title,
            app,
            customerId: customer?.id ?? null,
            dueDate,
            dueTime: dueTime || null,
            priority,
            note,
            checklist,
            proofRequired: proof,
            remarkRequired: remarkReq,
            assigneeIds: [],
            audience: rules,
          }).finally(() => setBusy(false))
        : await saveRoutine({
            ...routineInput(),
            assigneeId: rules ? null : (opts?.me.id ?? null),
            audience: rules,
            proofRequired: proof,
            remarkRequired: remarkReq,
            checklist,
          }).finally(() => setBusy(false));
    if (!r.ok) {
      setProblems(Object.fromEntries((r.fieldErrors ?? [{ field: "title", message: r.error }]).map((f) => [f.field, f.message])));
      setStep(r.fieldErrors?.some((f) => ["assignees", "assignee", "audience", "dueDate", "dueTime", "priority", "weekdays", "dayOfMonth", "completeByDay", "startTime"].includes(f.field)) ? 1 : 0);
      return;
    }
    toast.push(r.message ?? "Saved");
    router.refresh();
    onClose();
  };

  const appLabel = isTaskApp(app) ? (app === "tasks" ? "Personal — no app" : TASK_APP_LABEL[app]) : app;
  const whenWords =
    repeat === "once"
      ? `${dueDate && opts ? dueWords(dueDate, opts.today) : "—"}${dueTime ? ` · ${clock12(dueTime)}` : ""}`
      : `${scheduleWords({ frequency: repeat, weekdays: sched.weekdays, dayOfMonth: Number(sched.dayOfMonth) || 1, completeByDay: sched.completeByDay ? Number(sched.completeByDay) : null })}${
          windowWords(sched.startTime || null, sched.dueTime || null) ? `, ${windowWords(sched.startTime || null, sched.dueTime || null)}` : ""
        } — starting today`;

  return (
    <ErpDialog onClose={onClose} label="New task" size="lg">
      <DialogHeader onClose={onClose}>
        <DialogTitle>New task</DialogTitle>
      </DialogHeader>
      <StepBar steps={steps} active={step} reached={reached} onChange={go} />
      <DialogBody>
        {!opts ? <p className="text-sm text-muted">One moment.</p> : null}
        {opts && step === 0 ? (
          <div className="grid grid-cols-3 gap-4 rounded-card border border-line p-4 max-md:grid-cols-1">
            <Field label="What needs doing" required error={problems.title || null} className="col-span-3 max-md:col-span-1">
              <Input autoFocus value={title} invalid={Boolean(problems.title)} onChange={(e) => setTitle(e.target.value)} placeholder="Call Hari Om Paints about the 20 L rate" maxLength={200} />
            </Field>
            <Field label="App" required hint="The app this work happens in. Only people who hold it can be given the task." error={problems.app || null}>
              <Select value={app} onChange={(e) => setApp(e.target.value)}>
                {opts.apps.filter(isTaskApp).map((a) => (
                  <option key={a} value={a}>
                    {a === "tasks" ? "Personal — no app" : TASK_APP_LABEL[a]}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="col-span-2 max-md:col-span-1">
              <CustomerPicker value={customer} onChange={setCustomer} />
            </div>
            <CloseRules proof={proof} remark={remarkReq} onProof={setProof} onRemark={setRemarkReq} />
            <div />
            <Field label="Checklist" optional hint="One step per line." className="col-span-3 max-md:col-span-1">
              <Textarea rows={3} value={checklist} onChange={(e) => setChecklist(e.target.value)} placeholder="One step per line" />
            </Field>
            <Field label="Note" optional className="col-span-3 max-md:col-span-1">
              <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What they need to know" />
            </Field>
          </div>
        ) : null}
        {opts && step === 1 ? (
          <div className="grid grid-cols-3 gap-4 rounded-card border border-line p-4 max-md:grid-cols-1">
            <Field label="Give it to" required group error={who === "me" ? problems.assignees || problems.assignee || null : null} className="col-span-3 max-md:col-span-1">
              <span className="inline-flex gap-0.5 rounded-lg bg-canvas p-[3px]">
                {(
                  [
                    ["me", "Me"],
                    ...(hasTeam ? [["rules", "People, teams or roles"]] : []),
                  ] as [string, string][]
                ).map(([v, l]) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setWho(v as "me" | "rules")}
                    className={cx("h-7.5 cursor-pointer rounded-md px-3 text-[13.5px] font-medium", who === v ? "bg-surface text-brand-hover shadow-sm" : "text-body")}
                  >
                    {l}
                  </button>
                ))}
              </span>
              {!hasTeam ? <span className="mt-1.5 block text-[13px] text-muted">Nobody reports to you on the org chart, so tasks you add are yours.</span> : null}
            </Field>
            {who === "rules" ? (
              <div className="col-span-3 max-md:col-span-1">
                <AudienceBuilder app={app} value={audience} onChange={setAudience} error={problems.audience || problems.assignees || null} />
              </div>
            ) : null}
            <Field label="Repeats" required group className="col-span-3 max-md:col-span-1" hint="A repeating task is added afresh on each day it runs. Given by rules, it reaches whoever matches on that day — a new joiner included.">
              <RepeatPicker value={repeat} onChange={setRepeat} />
            </Field>
            {repeat === "once" ? (
              <>
                <Field label="Due" required error={problems.dueDate || null}>
                  <Input type="date" value={dueDate} min={opts.today} onChange={(e) => setDueDate(e.target.value)} />
                </Field>
                <Field label="Time" optional error={problems.dueTime || null}>
                  <Input type="time" value={dueTime} onChange={(e) => setDueTime(e.target.value)} />
                </Field>
              </>
            ) : (
              <ScheduleFields frequency={repeat} s={sched} set={(p) => setSched((s) => ({ ...s, ...p }))} problems={problems} />
            )}
            <Field label="Priority" required>
              <Select value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
                {TASK_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        ) : null}
        {opts && step === 2 ? (
          <>
            <Review title="Task" onChange={() => setStep(0)}>
              <ReviewItem label="What">{title}</ReviewItem>
              <ReviewItem label="App">{appLabel}</ReviewItem>
              <ReviewItem label="About">{customer?.name ?? "—"}</ReviewItem>
              <ReviewItem label="To close it">{closeWords(proof, remarkReq)}</ReviewItem>
              <ReviewItem label="Checklist">{checklist.split("\n").filter((s) => s.trim()).join(", ") || "—"}</ReviewItem>
              <ReviewItem label="Note">{note || "—"}</ReviewItem>
            </Review>
            <Review title="Who and when" onChange={() => setStep(1)}>
              <ReviewItem label="Given to">{who === "me" ? "You" : audienceWords(audience)}</ReviewItem>
              <ReviewItem label={repeat === "once" ? "Due" : "Repeats"}>{whenWords}</ReviewItem>
              <ReviewItem label="Priority">{PRIORITY_LABEL[priority]}</ReviewItem>
            </Review>
          </>
        ) : null}
      </DialogBody>
      <DialogFooter left={`Step ${step + 1} of 3`}>
        <Button onClick={onClose}>Cancel</Button>
        {step > 0 ? (
          <Button onClick={() => setStep(step - 1)} disabled={busy}>
            Back
          </Button>
        ) : null}
        {step < 2 ? (
          <Button variant="primary" onClick={() => go(step + 1)} disabled={!opts}>
            Next
          </Button>
        ) : (
          <Button variant="primary" onClick={() => void save()} disabled={busy}>
            {repeat !== "once" ? "Set the routine" : who === "me" ? "Add task" : "Give the task"}
          </Button>
        )}
      </DialogFooter>
    </ErpDialog>
  );
}

function Review({ title, onChange, children }: { title: string; onChange: () => void; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-sm font-bold text-ink">
        {title}
        <button type="button" onClick={onChange} className="cursor-pointer text-sm font-medium text-brand hover:underline">
          Change
        </button>
      </div>
      <div className="grid grid-cols-3 gap-4 rounded-card border border-line p-4 max-md:grid-cols-1">{children}</div>
    </div>
  );
}

function ReviewItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[12.5px] text-muted">{label}</div>
      <div className="mt-0.5 text-sm font-medium break-words text-ink">{children}</div>
    </div>
  );
}

/** Find a customer or lead — the CRM's own search, so it answers only within this person's book. */
function CustomerPicker({ value, onChange }: { value: CustomerHit | null; onChange: (c: CustomerHit | null) => void }) {
  const [q, setQ] = React.useState("");
  const [hits, setHits] = React.useState<CustomerHit[]>([]);
  const [note, setNote] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (q.trim().length < 2) return;
    let live = true;
    const timer = window.setTimeout(() => {
      void fetch(`/api/search?q=${encodeURIComponent(q.trim())}`)
        .then(async (r) => {
          if (!live) return;
          if (r.status === 403) {
            setNote("Searching customers needs TeleCRM.");
            setHits([]);
            return;
          }
          const body = (await r.json()) as { customers?: CustomerHit[] };
          setHits((body.customers ?? []).slice(0, 8));
          setNote(body.customers?.length ? null : "No customer by that name.");
        })
        .catch(() => live && setNote("Search is not answering — try again."));
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [q]);
  if (value) {
    return (
      <Field label="About" optional group>
        <span className="flex h-8.5 items-center gap-2 rounded-control border border-line px-3 text-sm text-ink">
          <span className="flex-1 truncate">{value.name}</span>
          <button type="button" className="cursor-pointer text-[13px] text-brand hover:underline" onClick={() => onChange(null)}>
            Change
          </button>
        </span>
      </Field>
    );
  }
  return (
    <Field label="About" optional hint="A customer or lead. The task opens it.">
      <span className="relative block">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search customers and leads" />
        {q.trim().length >= 2 && (hits.length || note) ? (
          <span className="absolute top-full right-0 left-0 z-10 mt-1 block max-h-[220px] overflow-y-auto rounded-card border border-line bg-surface p-1 shadow-[0_12px_32px_rgba(15,27,51,0.16)]">
            {hits.map((h) => (
              <button key={h.id} type="button" onClick={() => onChange(h)} className="block w-full cursor-pointer rounded-md px-2.5 py-1.5 text-left text-sm text-ink hover:bg-canvas">
                {h.name}
                {h.city ? <span className="text-muted"> · {h.city}</span> : null}
              </button>
            ))}
            {note ? <span className="block px-2.5 py-1.5 text-[13px] text-muted">{note}</span> : null}
          </span>
        ) : null}
      </span>
    </Field>
  );
}
