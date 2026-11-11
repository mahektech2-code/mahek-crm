"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Field, Input, PageHeader, Select, Textarea, cx } from "@/components/ui/primitives";
import { ConfirmDialog } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { DialogBody, DialogFooter, DialogHeader, DialogTitle, ErpDialog } from "@/app/erp/_ui/dialog";
import { deleteRoutine, saveRoutine, setRoutineActive } from "@/lib/actions/task-routines";
import { PRIORITY_LABEL, TASK_APP_LABEL, TASK_PRIORITIES, isTaskApp, type TaskPriority } from "@/lib/tasks/rules";
import { FREQUENCY_LABEL, ROUTINE_FREQUENCIES, WEEKDAY_SHORT, WORKING_WEEK, ordinal, routineProblems, scheduleWords, windowWords, type RoutineFrequency } from "@/lib/tasks/routines";
import type { RoutineRow } from "@/lib/tasks/routine-service";
import type { TeamPerson } from "@/lib/tasks/service";
import { AppChip, PriorityMark, TaskListCard } from "./kit";

/* ---------------------------------------------------------------------------
 * Routines: what comes back, for whom, and when. One card per person, a row per
 * routine, and the same form for a new one and a change — a change reaches the
 * days to come, which the form says before it is saved.
 * ------------------------------------------------------------------------- */

type Props = { routines: RoutineRow[]; people: TeamPerson[]; apps: string[]; viewerId: string };

export function RoutinesScreen({ routines, people, apps, viewerId }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = React.useState<RoutineRow | "new" | null>(null);
  const [deleting, setDeleting] = React.useState<RoutineRow | null>(null);
  const [person, setPerson] = React.useState<string>("all");
  const [busy, setBusy] = React.useState<string | null>(null);

  const hasTeam = people.length > 1;
  const shown = person === "all" ? routines : routines.filter((r) => r.assigneeId === person);
  const byPerson = new Map<string, RoutineRow[]>();
  for (const r of shown) byPerson.set(r.assigneeId, [...(byPerson.get(r.assigneeId) ?? []), r]);
  // Your own first, then everybody else by name.
  const order = [...byPerson.keys()].sort((a, b) => (a === viewerId ? -1 : b === viewerId ? 1 : byPerson.get(a)![0].assigneeName.localeCompare(byPerson.get(b)![0].assigneeName)));

  const toggle = async (r: RoutineRow) => {
    setBusy(r.id);
    const res = await setRoutineActive(r.id, !r.active).finally(() => setBusy(null));
    toast.push(res.ok ? (res.message ?? "Saved") : res.error, res.ok ? undefined : "error");
    if (res.ok) router.refresh();
  };

  return (
    <div className="mx-auto max-w-[1440px] px-6 pt-6 pb-14">
      <PageHeader
        title="Routines"
        actions={
          <>
            {hasTeam ? (
              <Select value={person} onChange={(e) => setPerson(e.target.value)} aria-label="Whose routines" className="w-56">
                <option value="all">Everybody</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id === viewerId ? "Mine" : p.name}
                  </option>
                ))}
              </Select>
            ) : null}
            <Button variant="primary" onClick={() => setEditing("new")}>
              + New routine
            </Button>
          </>
        }
      />
      <p className="-mt-2 mb-5 max-w-[760px] text-sm text-muted">
        A routine adds the same task on the days it runs — every morning, on a few days of the week, or once a month. Each day&apos;s task is closed like any other, with a remark.
      </p>

      {!order.length ? (
        <TaskListCard empty={person === "all" ? "No routines yet. Add one, and its task appears on My day each day it runs." : "No routines for this person."}>{null}</TaskListCard>
      ) : null}

      {order.map((pid) => {
        const list = byPerson.get(pid)!;
        const live = list.filter((r) => r.active).length;
        return (
          <TaskListCard key={pid} heading={pid === viewerId ? "Mine" : list[0].assigneeName} count={live}>
            {list.map((r) => (
              <div key={r.id} className={cx("flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-divider px-4 py-3 last:border-b-0", !r.active && "opacity-60")}>
                <div className="min-w-[260px] flex-1">
                  <div className="flex items-center gap-2 text-[14.5px] font-medium text-ink">
                    <PriorityMark priority={r.priority} />
                    <span className="truncate">{r.title}</span>
                    {!r.active ? <Badge tone="neutral">Paused</Badge> : null}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[13px] text-muted">
                    <AppChip app={r.app} />
                    <span>{scheduleWords(r)}</span>
                    {windowWords(r.startTime, r.dueTime) ? <span>· {windowWords(r.startTime, r.dueTime)}</span> : null}
                    {r.proofRequired ? <span>· screenshot to close</span> : null}
                    {r.createdById !== r.assigneeId ? <span>· set by {r.createdById === viewerId ? "you" : r.createdByName}</span> : null}
                  </div>
                </div>
                {r.canManage ? (
                  <div className="flex flex-none gap-1.5">
                    <Button size="sm" onClick={() => setEditing(r)}>
                      Edit
                    </Button>
                    <Button size="sm" onClick={() => void toggle(r)} disabled={busy === r.id}>
                      {r.active ? "Pause" : "Resume"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeleting(r)}>
                      Delete
                    </Button>
                  </div>
                ) : (
                  <span className="flex-none text-xs text-muted" title="A routine is changed by whoever set it, or a manager above you.">
                    Set by {r.createdByName}
                  </span>
                )}
              </div>
            ))}
          </TaskListCard>
        );
      })}

      {editing ? <RoutineDialog key={editing === "new" ? "new" : editing.id} routine={editing === "new" ? null : editing} people={people} apps={apps} viewerId={viewerId} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog
        open={Boolean(deleting)}
        title="Delete this routine?"
        body={
          <>
            <b>{deleting?.title}</b> stops being added from tomorrow. The tasks it already added stay, open or done, as the work they were. To stop it for a while instead, pause it.
          </>
        }
        confirmLabel="Delete routine"
        cancelLabel="Keep it"
        destructive
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          const res = await deleteRoutine(deleting.id);
          toast.push(res.ok ? (res.message ?? "Deleted") : res.error, res.ok ? undefined : "error");
          setDeleting(null);
          if (res.ok) router.refresh();
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ form */

function RoutineDialog({ routine, people, apps, viewerId, onClose }: { routine: RoutineRow | null; people: TeamPerson[]; apps: string[]; viewerId: string; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [assigneeId, setAssigneeId] = React.useState(routine?.assigneeId ?? viewerId);
  const [title, setTitle] = React.useState(routine?.title ?? "");
  const [app, setApp] = React.useState<string>(routine?.app ?? "tasks");
  const [frequency, setFrequency] = React.useState<RoutineFrequency>(routine?.frequency ?? "daily");
  const [weekdays, setWeekdays] = React.useState<number[]>(routine?.weekdays.length ? routine.weekdays : WORKING_WEEK);
  const [dayOfMonth, setDayOfMonth] = React.useState(routine?.dayOfMonth != null ? String(routine.dayOfMonth) : "1");
  const [completeByDay, setCompleteByDay] = React.useState(routine?.completeByDay != null ? String(routine.completeByDay) : "");
  const [startTime, setStartTime] = React.useState(routine?.startTime ?? "");
  const [dueTime, setDueTime] = React.useState(routine?.dueTime ?? "");
  const [priority, setPriority] = React.useState<TaskPriority>(routine?.priority ?? "normal");
  const [proof, setProof] = React.useState(routine?.proofRequired ?? false);
  const [checklist, setChecklist] = React.useState(routine?.checklist.map((c) => c.text).join("\n") ?? "");
  const [note, setNote] = React.useState(routine?.note ?? "");
  const [problems, setProblems] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);

  // The apps this person can be given work in: Personal, and whichever of the viewer's apps they hold too.
  const who = people.find((p) => p.id === assigneeId);
  const appChoices = apps.filter((a) => a === "tasks" || (who?.apps ?? []).includes(a) || a === routine?.app);
  const input = {
    id: routine?.id,
    assigneeId,
    title,
    app,
    priority,
    frequency,
    weekdays,
    dayOfMonth: frequency === "monthly" && dayOfMonth ? Number(dayOfMonth) : null,
    completeByDay: frequency === "monthly" && completeByDay ? Number(completeByDay) : null,
    startTime: startTime || null,
    dueTime: dueTime || null,
    proofRequired: proof,
    note,
    checklist,
  };
  const summary = routineProblems(input).length ? null : `${scheduleWords(input)}${windowWords(input.startTime, input.dueTime) ? `, ${windowWords(input.startTime, input.dueTime)}` : ""}`;

  const save = async () => {
    const p = routineProblems(input);
    if (p.length) return setProblems(Object.fromEntries(p.map((x) => [x.field, x.message])));
    setBusy(true);
    const r = await saveRoutine(input).finally(() => setBusy(false));
    if (!r.ok) return setProblems(Object.fromEntries((r.fieldErrors ?? [{ field: "title", message: r.error }]).map((f) => [f.field, f.message])));
    toast.push(r.message ?? "Saved");
    router.refresh();
    onClose();
  };

  const seg = (on: boolean) => cx("h-7.5 cursor-pointer rounded-md px-3 text-[13.5px] font-medium", on ? "bg-surface text-brand-hover shadow-sm" : "text-body");
  const days = Array.from({ length: 31 }, (_, i) => i + 1);

  return (
    <ErpDialog onClose={onClose} label={routine ? "Edit routine" : "New routine"} size="lg">
      <DialogHeader onClose={onClose}>
        <DialogTitle>{routine ? "Edit routine" : "New routine"}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <div className="grid grid-cols-3 gap-4 rounded-card border border-line p-4 max-md:grid-cols-1">
          <Field label="What needs doing" required error={problems.title || null} className="col-span-3 max-md:col-span-1">
            <Input autoFocus value={title} invalid={Boolean(problems.title)} onChange={(e) => setTitle(e.target.value)} placeholder="Download the HDFC statement and enter it in Tally" maxLength={200} />
          </Field>
          <Field label="For" required error={problems.assignee || null}>
            <Select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} disabled={Boolean(routine)}>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id === viewerId ? `Me (${p.name})` : p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="App" required hint="Where the work happens. Its tasks also show on that app's My tasks." error={problems.app || null}>
            <Select value={app} onChange={(e) => setApp(e.target.value)}>
              {appChoices.filter(isTaskApp).map((a) => (
                <option key={a} value={a}>
                  {a === "tasks" ? "Personal — no app" : TASK_APP_LABEL[a]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Priority" required>
            <Select value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
              {TASK_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="How often" required group error={problems.frequency || null} className="col-span-3 max-md:col-span-1">
            <span className="inline-flex gap-0.5 rounded-lg bg-canvas p-[3px]">
              {ROUTINE_FREQUENCIES.map((f) => (
                <button key={f} type="button" className={seg(frequency === f)} onClick={() => setFrequency(f)}>
                  {FREQUENCY_LABEL[f]}
                </button>
              ))}
            </span>
          </Field>
          {frequency === "monthly" ? (
            <>
              <Field label="Appears on" required error={problems.dayOfMonth || null} hint="A day past the end of a short month lands on its last day.">
                <Select value={dayOfMonth} onChange={(e) => setDayOfMonth(e.target.value)}>
                  {days.map((d) => (
                    <option key={d} value={d}>
                      The {ordinal(d)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Done by" optional error={problems.completeByDay || null} hint="Empty means the same day.">
                <Select value={completeByDay} onChange={(e) => setCompleteByDay(e.target.value)}>
                  <option value="">The same day</option>
                  {days
                    .filter((d) => d > Number(dayOfMonth))
                    .map((d) => (
                      <option key={d} value={d}>
                        The {ordinal(d)}
                      </option>
                    ))}
                </Select>
              </Field>
              <div />
            </>
          ) : (
            <Field label="On" required group error={problems.weekdays || null} className="col-span-3 max-md:col-span-1">
              <span className="inline-flex flex-wrap gap-1.5">
                {[1, 2, 3, 4, 5, 6, 0].map((d) => {
                  const on = weekdays.includes(d);
                  return (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setWeekdays((w) => (on ? w.filter((x) => x !== d) : [...w, d]))}
                      className={cx("h-8 w-12 cursor-pointer rounded-md border text-[13px] font-medium", on ? "border-brand bg-brand-soft text-brand-hover" : "border-line bg-surface text-body")}
                    >
                      {WEEKDAY_SHORT[d]}
                    </button>
                  );
                })}
              </span>
            </Field>
          )}
          <Field label="Start" optional error={problems.startTime || null}>
            <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          </Field>
          <Field label="End" optional hint="The task's own time — it is due by then." error={problems.dueTime || null}>
            <Input type="time" value={dueTime} onChange={(e) => setDueTime(e.target.value)} />
          </Field>
          <Field label="To close it" required group>
            <span className="inline-flex gap-0.5 rounded-lg bg-canvas p-[3px]">
              <button type="button" className={seg(!proof)} onClick={() => setProof(false)}>
                Remarks only
              </button>
              <button type="button" className={seg(proof)} onClick={() => setProof(true)}>
                Screenshot
              </button>
            </span>
          </Field>
          <Field label="Checklist" optional hint="One step per line. Each day's task starts with every step unticked." className="col-span-3 max-md:col-span-1">
            <Textarea rows={3} value={checklist} onChange={(e) => setChecklist(e.target.value)} placeholder="One step per line" />
          </Field>
          <Field label="Note" optional className="col-span-3 max-md:col-span-1">
            <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What they need to know" />
          </Field>
        </div>
      </DialogBody>
      <DialogFooter left={summary ? `${summary}${routine ? " — from the next day it runs" : ""}` : undefined}>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => void save()} disabled={busy}>
          {routine ? "Save routine" : "Set routine"}
        </Button>
      </DialogFooter>
    </ErpDialog>
  );
}
