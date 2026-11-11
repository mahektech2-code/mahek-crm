"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Field, Input, PageHeader, Select, Textarea, cx } from "@/components/ui/primitives";
import { ConfirmDialog } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { DialogBody, DialogFooter, DialogHeader, DialogTitle, ErpDialog } from "@/app/erp/_ui/dialog";
import { deleteRoutine, saveRoutine, setRoutineActive } from "@/lib/actions/task-routines";
import { PRIORITY_LABEL, TASK_APP_LABEL, TASK_PRIORITIES, isTaskApp, type TaskPriority } from "@/lib/tasks/rules";
import { WORKING_WEEK, routineProblems, scheduleWords, windowWords, type RoutineFrequency } from "@/lib/tasks/routines";
import { EMPTY_AUDIENCE, audienceProblems, type Audience } from "@/lib/tasks/audience";
import { AudienceBuilder, CloseRules, RepeatPicker, ScheduleFields, type ScheduleState } from "./fields";
import type { RoutineRow } from "@/lib/tasks/routine-service";
import type { TeamPerson } from "@/lib/tasks/service";
import { AppChip, PriorityMark, TaskListCard } from "./kit";
import { Switch } from "./screens-more";

/* ---------------------------------------------------------------------------
 * Routines: what comes back, for whom, and when. One card per person, a row per
 * routine, and the same form for a new one and a change — a change reaches the
 * days to come, which the form says before it is saved.
 * ------------------------------------------------------------------------- */

type Props = { routines: RoutineRow[]; people: TeamPerson[]; apps: string[]; viewerId: string };

const RULES = "__rules__";

export function RoutinesScreen({ routines, people, apps, viewerId }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = React.useState<RoutineRow | "new" | null>(null);
  const [deleting, setDeleting] = React.useState<RoutineRow | null>(null);
  const [person, setPerson] = React.useState<string>("all");
  const [busy, setBusy] = React.useState<string | null>(null);

  const hasTeam = people.length > 1;
  const shown = person === "all" ? routines : routines.filter((r) => (person === RULES ? r.audience : r.assigneeId === person));
  // A routine given by rules has no one person, so they share one card.
  const keyOf = (r: RoutineRow) => r.assigneeId ?? RULES;
  const byPerson = new Map<string, RoutineRow[]>();
  for (const r of shown) byPerson.set(keyOf(r), [...(byPerson.get(keyOf(r)) ?? []), r]);
  // Given by rules first, then your own, then everybody else by name.
  const rank = (k: string) => (k === RULES ? 0 : k === viewerId ? 1 : 2);
  const order = [...byPerson.keys()].sort((a, b) => rank(a) - rank(b) || (byPerson.get(a)![0].assigneeName ?? "").localeCompare(byPerson.get(b)![0].assigneeName ?? ""));

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
                {routines.some((r) => r.audience) ? <option value={RULES}>Given by rules</option> : null}
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
        A routine adds the same task on the days it runs — every morning, on a few days of the week, or once a month. Each day&apos;s task is closed like any other. Give one to yourself, one person, or a set of people, teams and roles — the rules are read again each day it runs.
      </p>

      {!order.length ? (
        <TaskListCard empty={person === "all" ? "No routines yet. Add one, and its task appears on My day each day it runs." : "No routines for this person."}>{null}</TaskListCard>
      ) : null}

      {order.map((pid) => {
        const list = byPerson.get(pid)!;
        const live = list.filter((r) => r.active).length;
        return (
          <TaskListCard key={pid} heading={pid === RULES ? "Given by rules — to teams and roles" : pid === viewerId ? "Mine" : (list[0].assigneeName ?? "")} count={live}>
            {list.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-divider px-4 py-3 last:border-b-0">
                <Switch on={r.active} disabled={!r.canManage || busy === r.id} label={`${r.active ? "Pause" : "Resume"} ${r.title}`} onClick={() => void toggle(r)} />
                <div className={cx("min-w-[260px] flex-1", !r.active && "opacity-60")}>
                  <div className="flex items-center gap-2 text-[14.5px] font-medium text-ink">
                    <PriorityMark priority={r.priority} />
                    <span className="truncate">{r.title}</span>
                    {!r.active ? <Badge tone="neutral">Paused</Badge> : null}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[13px] text-muted">
                    <AppChip app={r.app} />
                    <span>{scheduleWords(r)}</span>
                    {windowWords(r.startTime, r.dueTime) ? <span>· {windowWords(r.startTime, r.dueTime)}</span> : null}
                    {r.audience ? <span>· for {r.forWords}</span> : null}
                    <span>· {r.reach === 1 ? "1 person" : `${r.reach} people`}</span>
                    {r.proofRequired ? <span>· screenshot to close</span> : null}
                    {!r.remarkRequired ? <span>· remark optional</span> : null}
                    {r.createdById !== r.assigneeId ? <span>· set by {r.createdById === viewerId ? "you" : r.createdByName}</span> : null}
                  </div>
                </div>
                {r.canManage ? (
                  <div className="flex flex-none gap-1.5">
                    <Button size="sm" onClick={() => setEditing(r)}>
                      Edit
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
  const hasTeam = people.length > 1;
  const [who, setWho] = React.useState<"me" | "person" | "rules">(routine?.audience ? "rules" : routine && routine.assigneeId !== viewerId ? "person" : "me");
  const [assigneeId, setAssigneeId] = React.useState(routine?.assigneeId ?? viewerId);
  const [audience, setAudience] = React.useState<Audience>(routine?.audience ?? EMPTY_AUDIENCE);
  const [title, setTitle] = React.useState(routine?.title ?? "");
  const [app, setApp] = React.useState<string>(routine?.app ?? "tasks");
  const [frequency, setFrequency] = React.useState<RoutineFrequency>(routine?.frequency ?? "daily");
  const [sched, setSched] = React.useState<ScheduleState>({
    weekdays: routine?.weekdays.length ? routine.weekdays : WORKING_WEEK,
    dayOfMonth: routine?.dayOfMonth != null ? String(routine.dayOfMonth) : "1",
    completeByDay: routine?.completeByDay != null ? String(routine.completeByDay) : "",
    startTime: routine?.startTime ?? "",
    dueTime: routine?.dueTime ?? "",
  });
  const [priority, setPriority] = React.useState<TaskPriority>(routine?.priority ?? "normal");
  const [proof, setProof] = React.useState(routine?.proofRequired ?? false);
  const [remarkReq, setRemarkReq] = React.useState(routine?.remarkRequired ?? true);
  const [checklist, setChecklist] = React.useState(routine?.checklist.map((c) => c.text).join("\n") ?? "");
  const [note, setNote] = React.useState(routine?.note ?? "");
  const [problems, setProblems] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);

  const forId = who === "me" ? viewerId : assigneeId;
  // The apps it can be filed under: Personal, and the viewer's own apps — given to one person, only those they hold too.
  const one = people.find((p) => p.id === forId);
  const appChoices = apps.filter((a) => a === "tasks" || who === "rules" || (one?.apps ?? []).includes(a) || a === routine?.app);
  const input = {
    id: routine?.id,
    assigneeId: who === "rules" ? null : forId,
    audience: who === "rules" ? audience : null,
    title,
    app,
    priority,
    frequency,
    weekdays: sched.weekdays,
    dayOfMonth: frequency === "monthly" && sched.dayOfMonth ? Number(sched.dayOfMonth) : null,
    completeByDay: frequency === "monthly" && sched.completeByDay ? Number(sched.completeByDay) : null,
    startTime: sched.startTime || null,
    dueTime: sched.dueTime || null,
    proofRequired: proof,
    remarkRequired: remarkReq,
    note,
    checklist,
  };
  const summary = routineProblems(input).length ? null : `${scheduleWords(input)}${windowWords(input.startTime, input.dueTime) ? `, ${windowWords(input.startTime, input.dueTime)}` : ""}`;

  const save = async () => {
    const p = [...routineProblems(input), ...(who === "rules" ? audienceProblems(audience) : [])];
    if (p.length) return setProblems(Object.fromEntries(p.map((x) => [x.field, x.message])));
    setBusy(true);
    const r = await saveRoutine(input).finally(() => setBusy(false));
    if (!r.ok) return setProblems(Object.fromEntries((r.fieldErrors ?? [{ field: "title", message: r.error }]).map((f) => [f.field, f.message])));
    toast.push(r.message ?? "Saved");
    router.refresh();
    onClose();
  };

  const seg = (on: boolean) => cx("h-7.5 cursor-pointer rounded-md px-3 text-[13.5px] font-medium", on ? "bg-surface text-brand-hover shadow-sm" : "text-body");

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
          <Field label="App" required hint="Where the work happens. Only people who hold it can be given the routine." error={problems.app || null}>
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
          <div />

          <Field label="For" required group error={who !== "rules" ? problems.assignee || null : null} className="col-span-3 max-md:col-span-1">
            <span className="inline-flex gap-0.5 rounded-lg bg-canvas p-[3px]">
              <button type="button" className={seg(who === "me")} onClick={() => setWho("me")}>
                Me
              </button>
              {hasTeam ? (
                <>
                  <button type="button" className={seg(who === "person")} onClick={() => setWho("person")}>
                    One person
                  </button>
                  <button type="button" className={seg(who === "rules")} onClick={() => setWho("rules")}>
                    People, teams or roles
                  </button>
                </>
              ) : null}
            </span>
            {who === "person" ? (
              <Select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} className="mt-2 max-w-[320px]" aria-label="Who">
                {people
                  .filter((p) => p.id !== viewerId && (app === "tasks" ? p.apps.includes("tasks") : p.apps.includes(app)))
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </Select>
            ) : null}
          </Field>
          {who === "rules" ? (
            <div className="col-span-3 max-md:col-span-1">
              <AudienceBuilder app={app} value={audience} onChange={setAudience} error={problems.audience || null} />
              <p className="mt-2 text-[13px] text-muted">The rules are read again on every day it runs, so whoever matches that day gets it — somebody who joins a team or takes the designation later included.</p>
            </div>
          ) : null}

          <Field label="How often" required group error={problems.frequency || null} className="col-span-3 max-md:col-span-1">
            <RepeatPicker value={frequency} onChange={(f) => f !== "once" && setFrequency(f)} allowOnce={false} />
          </Field>
          <ScheduleFields frequency={frequency} s={sched} set={(p) => setSched((x) => ({ ...x, ...p }))} problems={problems} />
          <CloseRules proof={proof} remark={remarkReq} onProof={setProof} onRemark={setRemarkReq} />
          <div />
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
