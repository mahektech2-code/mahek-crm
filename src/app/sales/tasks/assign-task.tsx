"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { PlaceFilterSelects } from "@/components/ui/place-filter-selects";
import { MultiSelect } from "@/components/ui/multi-select";
import {
  aiDraftTask,
  aiSuggestLinks,
  assignTaskCampaign,
  loadTaskPlaceOptions,
  previewTaskAudience,
  searchTaskShops,
  type TaskAudiencePreview,
} from "@/lib/actions/sales";
import type { LinkSuggestion } from "@/lib/services/task-ai-service";
import { Button } from "@/components/console/parts";
import type { PlaceFilterOptions, PlaceFilterValues } from "@/lib/place-filters";
import type { PlaceKind } from "@/lib/place-parse";
import {
  blankTaskField,
  canDriveCondition,
  conditionSentence,
  conditionValues,
  guessTaskLink,
  linkTargetsFor,
  MAX_TASK_FIELDS,
  TASK_LINK_TARGETS,
  TASK_FIELD_TYPE_LABELS,
  TASK_FIELD_TYPES,
  TASK_FORM_TEMPLATES,
  taskAnswerProblems,
  taskFormProblems,
  visibleTaskFields,
  type TaskAnswer,
  type TaskAnswers,
  type TaskField,
  type TaskFieldLink,
  type TaskFieldType,
} from "@/lib/task-form";
import { taskAudienceProblem, type TaskAudience, type TaskShopTarget } from "@/lib/task-audience";

/* ---------------------------------------------------------------------------
 * Assigning a task — what to do, what to bring back, and who does it.
 *
 * Four steps in one dialog, because each one changes the next: the form
 * decides what the phone will draw, the shops decide whose phone, and the
 * review says the count back before anything is written.
 *
 * THE FORM IS BUILT, NOT PICKED. Any number of questions, each of any type
 * `lib/task-form.ts` knows — text, numbers, yes/no, picks, photos, a date, a
 * birthday, a phone number, a rating, a location, or an instruction to read —
 * and any question can be shown only when an earlier answer says so. The
 * phone beside the builder is the real rule running: tap an answer in it and
 * the follow-ups appear exactly as they will on the handset.
 *
 * WHO is two independent choices (`lib/task-audience.ts`): which shops (none,
 * a hand-picked list, or everything a place-and-filter reaches) and who does
 * it (each shop's own salesman, or salesmen named here — several at once).
 * One task per salesman per shop, so every answer is somebody's own row.
 * ------------------------------------------------------------------------- */

type Priority = "low" | "medium" | "high";
type Step = "what" | "form" | "who" | "review";

const STEPS: { key: Step; label: string }[] = [
  { key: "what", label: "1 · The task" },
  { key: "form", label: "2 · What to bring back" },
  { key: "who", label: "3 · Who does it" },
  { key: "review", label: "4 · Review" },
];

const TAB = "inline-flex h-8 items-center rounded-[4px] border px-3 text-[13px]";
const TAB_ON = "border-brand bg-brand-soft font-medium text-[#5223E0]";
const TAB_OFF = "border-line bg-surface text-body hover:bg-canvas";
const CONTROL = "h-8.5 w-full rounded-[4px] border border-line bg-surface px-2 text-[13px]";
const AREA = "w-full rounded-[4px] border border-line bg-surface px-2 py-1.5 text-[13px]";
const LABEL = "mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase";
const CARD = "rounded-[6px] border border-line bg-surface p-3";

export type RecentForm = { id: string; title: string; description: string | null; form: TaskField[] };
export type PickSalesman = { id: string; name: string };
type ShopRow = { id: string; name: string; carrierName: string | null; place: string | null };

const newId = () => `q_${Math.random().toString(36).slice(2, 9)}`;

export function AssignTask({
  salesmen,
  recentForms,
  placeOptions: initialPlaceOptions,
  aiAvailable,
  today,
}: {
  salesmen: PickSalesman[];
  recentForms: RecentForm[];
  placeOptions: PlaceFilterOptions;
  /** Whether the task brain can be asked — an OpenAI key and the switch on. */
  aiAvailable: boolean;
  /** The business date, for turning "due in 3 days" into a day. */
  today: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [round, setRound] = React.useState(0);

  return (
    <>
      <Button tone="primary" onClick={() => setOpen(true)}>
        {aiAvailable ? "✦ Assign a task" : "Assign a task"}
      </Button>
      {open ? (
        <Builder
          key={round}
          salesmen={salesmen}
          recentForms={recentForms}
          initialPlaceOptions={initialPlaceOptions}
          aiAvailable={aiAvailable}
          today={today}
          onClose={() => {
            setOpen(false);
            setRound((r) => r + 1);
          }}
          onDone={(message, campaignId) => {
            toast.push(message);
            setOpen(false);
            setRound((r) => r + 1);
            router.push(`/sales/tasks/${campaignId}`);
          }}
        />
      ) : null}
    </>
  );
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function Builder({
  salesmen,
  recentForms,
  initialPlaceOptions,
  aiAvailable,
  today,
  onClose,
  onDone,
}: {
  salesmen: PickSalesman[];
  recentForms: RecentForm[];
  initialPlaceOptions: PlaceFilterOptions;
  aiAvailable: boolean;
  today: string;
  onClose: () => void;
  onDone: (message: string, campaignId: string) => void;
}) {
  const [step, setStep] = React.useState<Step>("what");

  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [priority, setPriority] = React.useState<Priority>("medium");
  const [dueDate, setDueDate] = React.useState("");
  const [fields, setFields] = React.useState<TaskField[]>([]);

  const [shops, setShopsRaw] = React.useState<TaskShopTarget>({ kind: "none" });
  const [assignKind, setAssignKind] = React.useState<"carrier" | "chosen">("chosen");
  const [chosen, setChosen] = React.useState<string[]>([]);
  const [pickedShops, setPickedShops] = React.useState<ShopRow[]>([]);
  const [placeOptions, setPlaceOptions] = React.useState(initialPlaceOptions);

  const [preview, setPreview] = React.useState<TaskAudiencePreview | null>(null);
  const [previewing, setPreviewing] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  /* The brain. `brief` is what the manager said in plain words; `aiNote` is
     the model's own account of what it built, shown above the questions so
     nothing it decided is hidden. */
  const [brief, setBrief] = React.useState("");
  const [drafting, setDrafting] = React.useState(false);
  const [aiNote, setAiNote] = React.useState<string | null>(null);
  const [usedBrief, setUsedBrief] = React.useState<string | null>(null);
  const [suggestions, setSuggestions] = React.useState<LinkSuggestion[] | null>(null);
  const [checkingLinks, setCheckingLinks] = React.useState(false);
  const [linksCheckedFor, setLinksCheckedFor] = React.useState<string | null>(null);

  const audience: TaskAudience = {
    shops: shops.kind === "list" ? { kind: "list", customerIds: pickedShops.map((s) => s.id) } : shops,
    assignees: assignKind === "carrier" ? { kind: "carrier" } : { kind: "chosen", salesmanIds: chosen },
  };

  /* Every change to WHO throws the reviewed count away: a count is only worth
     anything for the exact selection it was taken of. */
  const setShops = (next: TaskShopTarget) => {
    setShopsRaw(next);
    setPreview(null);
    if (next.kind === "none") setAssignKind("chosen");
  };
  const touchWho = () => setPreview(null);

  const titleOk = title.trim().length >= 3;
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(dueDate);
  const formProblems = taskFormProblems(fields);
  const audienceProblem = taskAudienceProblem(audience);

  const stepProblem: Record<Step, string | null> = {
    what: !titleOk ? "Give the task a title." : !dateOk ? "Pick the day it is due." : null,
    form: formProblems[0] ?? null,
    who: audienceProblem,
    review: null,
  };

  async function runPreview() {
    if (audienceProblem) {
      setError(audienceProblem);
      return;
    }
    setPreviewing(true);
    setError(null);
    try {
      const r = await previewTaskAudience(audience, fields);
      if (!r.ok) setError(r.error);
      else setPreview(r.data);
    } finally {
      setPreviewing(false);
    }
  }

  function go(next: Step) {
    const order = STEPS.map((s) => s.key);
    for (const s of order.slice(0, order.indexOf(next))) {
      if (stepProblem[s]) {
        setStep(s);
        setError(stepProblem[s]);
        return;
      }
    }
    setError(null);
    setStep(next);
    if ((next === "review" || next === "who") && !preview && !audienceProblem) void runPreview();
    if (next === "review") void checkLinks();
  }

  /** Change the questions — and with them what "already on record" means. */
  function changeFields(next: TaskField[]) {
    setFields(next);
    setPreview(null);
  }

  async function buildWithAi() {
    if (brief.trim().length < 8) {
      setError("Say a little more about what you need from the field.");
      return;
    }
    setDrafting(true);
    setError(null);
    try {
      const r = await aiDraftTask(brief);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      const d = r.data;
      setTitle(d.title);
      setDescription(d.description);
      setPriority(d.priority);
      setDueDate(addDays(today, d.dueInDays ?? 3));
      setFields(d.fields);
      if (d.targeting.shops === "filter") {
        setShopsRaw({ kind: "filter", places: {}, carriedBy: [], accountKinds: d.targeting.accountKinds.length === 1 ? d.targeting.accountKinds : [] });
        setAssignKind(d.targeting.assignTo);
      } else {
        setShopsRaw({ kind: "none" });
        setAssignKind("chosen");
      }
      setPreview(null);
      setAiNote(d.explanation);
      setUsedBrief(brief.trim());
      setSuggestions(null);
      setLinksCheckedFor(null);
      setStep("form");
    } finally {
      setDrafting(false);
    }
  }

  /**
   * The link check: which questions are really the customer record's own
   * fields. Run once per version of the form, on reaching the review, and
   * answered instantly by the keyword guess where the AI is off.
   */
  async function checkLinks() {
    const signature = JSON.stringify(fields.map((f) => [f.id, f.type, f.label, f.link?.target ?? null]));
    if (linksCheckedFor === signature) return;
    if (!fields.some((f) => !f.link && f.type !== "info")) {
      setSuggestions([]);
      setLinksCheckedFor(signature);
      return;
    }
    setCheckingLinks(true);
    try {
      const r = await aiSuggestLinks(fields, title);
      setSuggestions(r.ok ? r.data.suggestions : []);
      setLinksCheckedFor(signature);
    } finally {
      setCheckingLinks(false);
    }
  }

  function applyLink(fieldId: string, link: TaskFieldLink) {
    changeFields(fields.map((f) => (f.id === fieldId ? { ...f, link } : f)));
    setSuggestions((s) => (s ? s.filter((x) => x.fieldId !== fieldId) : s));
  }

  async function save() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const r = await assignTaskCampaign({
        title,
        description: description.trim() || undefined,
        priority,
        dueDate,
        form: fields,
        audience,
        expectedCount: preview.tasks,
        aiBrief: usedBrief ?? undefined,
      });
      if (!r.ok) {
        setError(r.error);
        if (r.code === "conflict") setPreview(null);
        return;
      }
      onDone(r.message ?? "Assigned.", r.data.campaignId);
    } finally {
      setBusy(false);
    }
  }

  const stepAt = STEPS.findIndex((s) => s.key === step);
  const nextStep = STEPS[stepAt + 1]?.key;
  const prevStep = STEPS[stepAt - 1]?.key;

  return (
    <Modal
      open
      onClose={onClose}
      title="Assign a task"
      width={step === "form" ? 1100 : 760}
      footer={
        <div className="flex w-full items-center gap-2">
          {error ? <p className="mr-auto text-[13px] text-pretty text-danger">{error}</p> : <span className="mr-auto" />}
          <Button tone="quiet" onClick={onClose}>
            Cancel
          </Button>
          {prevStep ? <Button onClick={() => go(prevStep)}>Back</Button> : null}
          {nextStep ? (
            <Button tone="primary" onClick={() => go(nextStep)}>
              Next
            </Button>
          ) : (
            <Button
              tone="primary"
              disabled={busy || !preview || preview.tasks === 0 || preview.tooMany}
              title={!preview ? "Check who it reaches first." : undefined}
              onClick={() => void save()}
            >
              {busy ? "Assigning…" : `Assign ${preview?.tasks ?? 0} task${preview?.tasks === 1 ? "" : "s"}`}
            </Button>
          )}
        </div>
      }
    >
      <div className="mb-4 flex flex-wrap gap-1.5">
        {STEPS.map((s) => (
          <button key={s.key} type="button" onClick={() => go(s.key)} className={`${TAB} ${step === s.key ? TAB_ON : TAB_OFF}`}>
            {s.label}
          </button>
        ))}
      </div>

      {step === "what" ? (
        <WhatStep
          title={title}
          setTitle={setTitle}
          description={description}
          setDescription={setDescription}
          dueDate={dueDate}
          setDueDate={setDueDate}
          priority={priority}
          setPriority={setPriority}
          recentForms={recentForms}
          hasFields={fields.length > 0}
          aiAvailable={aiAvailable}
          brief={brief}
          setBrief={setBrief}
          drafting={drafting}
          onBuild={() => void buildWithAi()}
          onTemplate={(t) => {
            if (!title.trim()) setTitle(t.title);
            if (!description.trim() && t.description) setDescription(t.description);
            changeFields(t.fields.map((f) => ({ ...f, options: f.options ? [...f.options] : undefined, link: f.link ? { ...f.link } : undefined })));
            setAiNote(null);
            setStep("form");
          }}
        />
      ) : null}

      {step === "form" ? (
        <FormStep fields={fields} setFields={changeFields} title={title} aiNote={aiNote} onDismissNote={() => setAiNote(null)} />
      ) : null}

      {step === "who" ? (
        <WhoStep
          salesmen={salesmen}
          shops={shops}
          setShops={setShops}
          assignKind={assignKind}
          setAssignKind={(k) => {
            setAssignKind(k);
            touchWho();
          }}
          chosen={chosen}
          setChosen={(c) => {
            setChosen(c);
            touchWho();
          }}
          pickedShops={pickedShops}
          setPickedShops={(s) => {
            setPickedShops(s);
            touchWho();
          }}
          placeOptions={placeOptions}
          setPlaceOptions={setPlaceOptions}
          preview={preview}
          previewing={previewing}
          onPreview={() => void runPreview()}
        />
      ) : null}

      {step === "review" ? (
        <ReviewStep
          title={title}
          description={description}
          dueDate={dueDate}
          priority={priority}
          fields={fields}
          preview={preview}
          previewing={previewing}
          onPreview={() => void runPreview()}
          aiAvailable={aiAvailable}
          suggestions={suggestions}
          checkingLinks={checkingLinks}
          onApplyLink={applyLink}
          onDismissLink={(id) => setSuggestions((s) => (s ? s.filter((x) => x.fieldId !== id) : s))}
        />
      ) : null}
    </Modal>
  );
}

/* ----------------------------------------------------------------- step 1 */

function WhatStep(props: {
  title: string;
  setTitle: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  dueDate: string;
  setDueDate: (v: string) => void;
  priority: Priority;
  setPriority: (v: Priority) => void;
  recentForms: RecentForm[];
  hasFields: boolean;
  aiAvailable: boolean;
  brief: string;
  setBrief: (v: string) => void;
  drafting: boolean;
  onBuild: () => void;
  onTemplate: (t: { title: string; description: string | null; fields: TaskField[] }) => void;
}) {
  return (
    <div>
      {props.aiAvailable ? (
        <div className="mb-5 rounded-[8px] border border-brand/40 bg-gradient-to-br from-brand-soft to-surface p-4">
          <p className="text-[14px] font-semibold text-ink">✦ Describe what you need from the field</p>
          <p className="mb-2 text-[12px] text-pretty text-muted">
            In plain words. The AI writes the questions, links each answer to the customer record where it belongs, and
            suggests who should get it. You review everything before it goes.
          </p>
          <textarea
            value={props.brief}
            onChange={(e) => props.setBrief(e.target.value)}
            rows={3}
            maxLength={4000}
            placeholder="e.g. Get the owner's birthday and WhatsApp number at every shop that doesn't have one yet, by Friday."
            className={`${AREA} bg-surface`}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) props.onBuild();
            }}
          />
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Button tone="primary" size="sm" disabled={props.drafting} onClick={props.onBuild}>
              {props.drafting ? "Building…" : "✦ Build it with AI"}
            </Button>
            {AI_EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => props.setBrief(ex)}
                className="rounded-full border border-line bg-surface px-2.5 py-1 text-[12px] text-body hover:border-brand"
              >
                {ex}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    <div className="grid grid-cols-[1fr_280px] gap-5">
      <div>
        <label className="mb-3 block">
          <span className={LABEL}>Task</span>
          <input
            value={props.title}
            onChange={(e) => props.setTitle(e.target.value)}
            placeholder="What should they do? — e.g. Collect the owner's birthday"
            className={CONTROL}
            maxLength={200}
          />
        </label>
        <label className="mb-3 block">
          <span className={LABEL}>Instructions (optional)</span>
          <textarea
            value={props.description}
            onChange={(e) => props.setDescription(e.target.value)}
            rows={4}
            maxLength={4000}
            placeholder="Anything the salesman should know before he starts."
            className={AREA}
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className={LABEL}>Due by</span>
            <input type="date" value={props.dueDate} onChange={(e) => props.setDueDate(e.target.value)} className={CONTROL} />
          </label>
          <label className="block">
            <span className={LABEL}>Priority</span>
            <select value={props.priority} onChange={(e) => props.setPriority(e.target.value as Priority)} className={CONTROL}>
              <option value="low">Low</option>
              <option value="medium">Normal</option>
              <option value="high">High</option>
            </select>
          </label>
        </div>
      </div>

      <div>
        <span className={LABEL}>Start from</span>
        <p className="mb-2 text-[12px] text-pretty text-muted">
          A ready form you can change. {props.hasFields ? "Picking one replaces the questions you have." : ""}
        </p>
        <div className="space-y-1.5">
          {TASK_FORM_TEMPLATES.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => props.onTemplate(t)}
              className="block w-full rounded-[4px] border border-line bg-surface px-2.5 py-1.5 text-left text-[13px] hover:bg-canvas"
            >
              <span className="font-medium text-ink">{t.title}</span>
              <span className="block text-[12px] text-muted">{t.fields.length} questions</span>
            </button>
          ))}
        </div>
        {props.recentForms.length ? (
          <>
            <span className={`${LABEL} mt-3`}>Ask again</span>
            <div className="max-h-48 space-y-1.5 overflow-y-auto">
              {props.recentForms.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => props.onTemplate({ title: r.title, description: r.description, fields: r.form })}
                  className="block w-full rounded-[4px] border border-line bg-surface px-2.5 py-1.5 text-left text-[13px] hover:bg-canvas"
                >
                  <span className="block truncate font-medium text-ink">{r.title}</span>
                  <span className="block text-[12px] text-muted">{r.form.length} questions</span>
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </div>
    </div>
  );
}

const AI_EXAMPLES = [
  "Collect birthdays of every contact at shops missing them",
  "Get a Google review from our happiest customers, with a screenshot",
  "Check which of our products each shop stocks, with a shelf photo",
];

/* ----------------------------------------------------------------- step 2 */

function FormStep({
  fields,
  setFields,
  title,
  aiNote,
  onDismissNote,
}: {
  fields: TaskField[];
  setFields: (f: TaskField[]) => void;
  title: string;
  aiNote: string | null;
  onDismissNote: () => void;
}) {
  const problems = taskFormProblems(fields);
  const update = (i: number, patch: Partial<TaskField>) =>
    setFields(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const move = (i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= fields.length) return;
    const next = [...fields];
    [next[i], next[j]] = [next[j], next[i]];
    setFields(next);
  };
  const add = (type: TaskFieldType) => setFields([...fields, blankTaskField(type, newId())]);
  const remove = (i: number) => {
    const gone = fields[i].id;
    /* A question that depended on the one removed would point at nothing. */
    setFields(
      fields
        .filter((_, j) => j !== i)
        .map((f) => (f.showIf?.field === gone ? { ...f, showIf: undefined } : f)),
    );
  };
  const duplicate = (i: number) => {
    const copy = { ...fields[i], id: newId(), options: fields[i].options ? [...fields[i].options!] : undefined };
    setFields([...fields.slice(0, i + 1), copy, ...fields.slice(i + 1)]);
  };

  return (
    <div className="grid grid-cols-[1fr_340px] gap-5">
      <div>
        {aiNote ? (
          <div className="mb-3 flex gap-2 rounded-[6px] border border-brand/40 bg-brand-soft p-3 text-[13px] text-pretty text-ink">
            <span aria-hidden>✦</span>
            <span className="flex-1">
              <span className="font-medium">The AI drafted this.</span> {aiNote} Check every question — nothing is sent until you assign it.
            </span>
            <IconBtn label="Dismiss" onClick={onDismissNote}>✕</IconBtn>
          </div>
        ) : null}
        {fields.length === 0 ? (
          <div className={`${CARD} mb-3 text-[13px] text-pretty text-muted`}>
            No questions yet — the salesman will just mark it done with a note. Add what you want back below:
            text, numbers, choices, photos, a birthday, a location… in any order, as many as you need.
          </div>
        ) : null}

        <div className="space-y-2.5">
          {fields.map((f, i) => (
            <FieldEditor
              key={f.id}
              index={i}
              field={f}
              earlier={fields.slice(0, i)}
              all={fields}
              onChange={(patch) => update(i, patch)}
              onMove={(by) => move(i, by)}
              onRemove={() => remove(i)}
              onDuplicate={() => duplicate(i)}
              first={i === 0}
              last={i === fields.length - 1}
            />
          ))}
        </div>

        <div className="mt-3">
          <span className={LABEL}>Add a question</span>
          <div className="flex flex-wrap gap-1.5">
            {TASK_FIELD_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                disabled={fields.length >= MAX_TASK_FIELDS}
                title={TASK_FIELD_TYPE_LABELS[t].hint}
                onClick={() => add(t)}
                className="h-7.5 rounded-[4px] border border-line bg-surface px-2.5 text-[12px] text-body hover:border-brand hover:bg-brand-soft disabled:opacity-50"
              >
                + {TASK_FIELD_TYPE_LABELS[t].label}
              </button>
            ))}
          </div>
        </div>

        {problems.length ? (
          <ul className="mt-3 list-disc pl-5 text-[12px] text-danger">
            {problems.slice(0, 6).map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <PhonePreview title={title} fields={fields} />
    </div>
  );
}

function FieldEditor({
  index,
  field: f,
  earlier,
  all,
  onChange,
  onMove,
  onRemove,
  onDuplicate,
  first,
  last,
}: {
  index: number;
  field: TaskField;
  earlier: TaskField[];
  all: TaskField[];
  onChange: (patch: Partial<TaskField>) => void;
  onMove: (by: number) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  first: boolean;
  last: boolean;
}) {
  const drivers = earlier.filter(canDriveCondition);
  const parent = f.showIf ? earlier.find((p) => p.id === f.showIf!.field) : undefined;
  const values = parent ? conditionValues(parent) : [];
  const isChoice = f.type === "single_choice" || f.type === "multi_choice";

  const changeType = (type: TaskFieldType) => {
    const blank = blankTaskField(type, f.id);
    onChange({
      type,
      options: blank.options && f.options?.some((o) => o.trim()) ? f.options : blank.options,
      min: blank.min,
      max: blank.max,
      unit: undefined,
      required: type === "info" ? undefined : (f.required ?? true),
      link: f.link && linkTargetsFor(type).includes(f.link.target) ? f.link : undefined,
    });
  };

  return (
    <div className={CARD}>
      <div className="mb-2 flex items-center gap-2">
        <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-brand-soft px-1.5 text-[12px] font-semibold text-[#5223E0]">
          {index + 1}
        </span>
        <select value={f.type} onChange={(e) => changeType(e.target.value as TaskFieldType)} className={`${CONTROL} w-44`}>
          {TASK_FIELD_TYPES.map((t) => (
            <option key={t} value={t}>
              {TASK_FIELD_TYPE_LABELS[t].label}
            </option>
          ))}
        </select>
        {f.type !== "info" ? (
          <label className="flex items-center gap-1 text-[12px] text-body">
            <input type="checkbox" checked={Boolean(f.required)} onChange={(e) => onChange({ required: e.target.checked })} />
            Needed
          </label>
        ) : null}
        <span className="ml-auto flex gap-0.5">
          <IconBtn label="Move up" disabled={first} onClick={() => onMove(-1)}>↑</IconBtn>
          <IconBtn label="Move down" disabled={last} onClick={() => onMove(1)}>↓</IconBtn>
          <IconBtn label="Duplicate" onClick={onDuplicate}>⧉</IconBtn>
          <IconBtn label="Remove" onClick={onRemove}>✕</IconBtn>
        </span>
      </div>

      <input
        value={f.label}
        onChange={(e) => onChange({ label: e.target.value })}
        placeholder={f.type === "info" ? "What should he read? — e.g. Ask for the owner, not the staff." : "The question — e.g. Owner's birthday"}
        className={CONTROL}
        maxLength={300}
      />
      <input
        value={f.help ?? ""}
        onChange={(e) => onChange({ help: e.target.value || undefined })}
        placeholder="Hint under it (optional)"
        className={`${CONTROL} mt-1.5`}
        maxLength={1000}
      />

      {isChoice ? (
        <div className="mt-2">
          <span className={LABEL}>Options</span>
          <div className="space-y-1">
            {(f.options ?? []).map((o, j) => (
              <div key={j} className="flex gap-1">
                <input
                  value={o}
                  onChange={(e) => onChange({ options: (f.options ?? []).map((x, k) => (k === j ? e.target.value : x)) })}
                  placeholder={`Option ${j + 1}`}
                  className={CONTROL}
                  maxLength={200}
                />
                <IconBtn
                  label="Remove option"
                  disabled={(f.options ?? []).length <= 2}
                  onClick={() => onChange({ options: (f.options ?? []).filter((_, k) => k !== j) })}
                >
                  ✕
                </IconBtn>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="mt-1 text-[12px] text-brand hover:underline"
            onClick={() => onChange({ options: [...(f.options ?? []), ""] })}
          >
            + Add option
          </button>
        </div>
      ) : null}

      {f.type === "number" ? (
        <div className="mt-2 grid grid-cols-3 gap-2">
          <NumberBox label="Lowest" value={f.min} onChange={(v) => onChange({ min: v })} />
          <NumberBox label="Highest" value={f.max} onChange={(v) => onChange({ max: v })} />
          <label className="block">
            <span className={LABEL}>Counted in</span>
            <input value={f.unit ?? ""} onChange={(e) => onChange({ unit: e.target.value || undefined })} placeholder="litres, cans, ₹" className={CONTROL} />
          </label>
        </div>
      ) : null}
      {f.type === "photo" ? (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <NumberBox label="At least" value={f.min} onChange={(v) => onChange({ min: v })} />
          <NumberBox label="At most (up to 10)" value={f.max} onChange={(v) => onChange({ max: v })} />
        </div>
      ) : null}
      {f.type === "rating" ? (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <NumberBox label="From" value={f.min} onChange={(v) => onChange({ min: v })} />
          <NumberBox label="To" value={f.max} onChange={(v) => onChange({ max: v })} />
        </div>
      ) : null}
      {f.type === "short_text" || f.type === "long_text" ? (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <NumberBox label="Fewest characters" value={f.min} onChange={(v) => onChange({ min: v })} />
          <NumberBox label="Most characters" value={f.max} onChange={(v) => onChange({ max: v })} />
        </div>
      ) : null}

      <LinkEditor field={f} onChange={(link) => onChange({ link })} />

      {drivers.length ? (
        <div className="mt-2 rounded-[4px] bg-canvas p-2">
          <label className="flex items-center gap-1.5 text-[12px] text-body">
            <input
              type="checkbox"
              checked={Boolean(f.showIf)}
              onChange={(e) =>
                onChange({
                  showIf: e.target.checked
                    ? { field: drivers[drivers.length - 1].id, op: "is", value: conditionValues(drivers[drivers.length - 1])[0] ?? "" }
                    : undefined,
                })
              }
            />
            Only ask this when an earlier answer says so
          </label>
          {f.showIf ? (
            <div className="mt-1.5 grid grid-cols-[1fr_120px_1fr] gap-1.5">
              <select
                value={f.showIf.field}
                onChange={(e) => {
                  const p = drivers.find((d) => d.id === e.target.value);
                  onChange({
                    showIf: {
                      field: e.target.value,
                      op: p?.type === "multi_choice" ? "includes" : "is",
                      value: p ? (conditionValues(p)[0] ?? "") : "",
                    },
                  });
                }}
                className={CONTROL}
              >
                {drivers.map((d) => (
                  <option key={d.id} value={d.id}>
                    {`${all.indexOf(d) + 1}. ${d.label || TASK_FIELD_TYPE_LABELS[d.type].label}`}
                  </option>
                ))}
              </select>
              <select
                value={f.showIf.op}
                onChange={(e) => onChange({ showIf: { ...f.showIf!, op: e.target.value as "is" } })}
                className={CONTROL}
              >
                {parent?.type === "multi_choice" ? <option value="includes">includes</option> : null}
                <option value="is">is</option>
                <option value="is_not">is not</option>
                <option value="answered">is answered</option>
              </select>
              {f.showIf.op === "answered" ? (
                <span />
              ) : values.length ? (
                <select
                  value={f.showIf.value ?? ""}
                  onChange={(e) => onChange({ showIf: { ...f.showIf!, value: e.target.value } })}
                  className={CONTROL}
                >
                  {values.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={f.showIf.value ?? ""}
                  onChange={(e) => onChange({ showIf: { ...f.showIf!, value: e.target.value } })}
                  placeholder="this answer"
                  className={CONTROL}
                />
              )}
            </div>
          ) : null}
          {f.showIf ? <p className="mt-1 text-[12px] text-muted">{conditionSentence(f.showIf, all)}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function IconBtn({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-7 w-7 items-center justify-center rounded-[4px] text-[13px] text-muted hover:bg-canvas hover:text-ink disabled:opacity-30"
    >
      {children}
    </button>
  );
}

function NumberBox({ label, value, onChange }: { label: string; value?: number; onChange: (v: number | undefined) => void }) {
  return (
    <label className="block">
      <span className={LABEL}>{label}</span>
      <input
        type="number"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        className={CONTROL}
      />
    </label>
  );
}

/* ----------------------------------------------------------- the phone preview */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * What the salesman will see, running the same `visibleTaskFields` the
 * handset runs. It is interactive on purpose: tapping "No" here is how a
 * manager checks the follow-up he wrote for "No" actually appears.
 */
function PhonePreview({ title, fields }: { title: string; fields: TaskField[] }) {
  const [answers, setAnswers] = React.useState<TaskAnswers>({});
  const [checked, setChecked] = React.useState(false);
  const shown = visibleTaskFields(fields, answers);
  const problems = new Map(taskAnswerProblems(fields, answers).map((p) => [p.fieldId, p.message]));
  const set = (id: string, v: TaskAnswer | undefined) => {
    const next = { ...answers };
    if (v === undefined) delete next[id];
    else next[id] = v;
    setAnswers(next);
  };

  return (
    <div className="sticky top-0 self-start">
      <span className={LABEL}>On the salesman&apos;s phone — try it</span>
      <div className="rounded-[22px] border-[6px] border-[#1f1f24] bg-[#f6f6f9] p-3 shadow-sm">
        <div className="max-h-[52vh] overflow-y-auto">
          <p className="text-[15px] font-semibold text-ink">{fields.length ? "Answer and finish" : "Mark as done"}</p>
          <p className="mb-3 text-[12px] text-muted">{title || "Your task title"}</p>
          {shown.length === 0 ? <p className="text-[12px] text-muted">A note box and a Done button.</p> : null}
          <div className="space-y-3">
            {shown.map((f, i) => (
              <div key={f.id}>
                {f.type === "info" ? (
                  <div className="rounded-[8px] border-l-[3px] border-brand bg-white p-2 text-[12px] text-ink">
                    {f.label || "Instruction"}
                    {f.help ? <span className="block text-muted">{f.help}</span> : null}
                  </div>
                ) : (
                  <>
                    <p className="text-[11px] font-semibold tracking-[0.04em] text-muted uppercase">
                      {`${i + 1}. ${f.label || "Question"}${f.required ? " · needed" : ""}`}
                    </p>
                    {f.help ? <p className="text-[11px] text-muted">{f.help}</p> : null}
                    {f.link ? (
                      <p className="text-[11px] text-[#5223E0]">
                        {`↻ Shows what the record holds; saved to ${TASK_LINK_TARGETS[f.link.target].label.toLowerCase()}${f.link.scope === "each" ? " — asked once per contact" : ""}`}
                      </p>
                    ) : null}
                    <div className="mt-1">
                      <PreviewInput field={f} value={answers[f.id]} onChange={(v) => set(f.id, v)} />
                    </div>
                  </>
                )}
                {checked && problems.get(f.id) ? <p className="mt-0.5 text-[11px] text-danger">{problems.get(f.id)}</p> : null}
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setChecked(true)}
            className="mt-4 h-9 w-full rounded-[10px] bg-brand text-[13px] font-medium text-white"
          >
            {fields.length ? "Submit" : "Done"}
          </button>
          {checked ? (
            <p className="mt-1 text-center text-[11px] text-muted">
              {problems.size ? `${problems.size} still needed` : "Everything needed is answered."}
            </p>
          ) : null}
          {Object.keys(answers).length ? (
            <button type="button" onClick={() => { setAnswers({}); setChecked(false); }} className="mt-1 block w-full text-center text-[11px] text-brand">
              Clear the test answers
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function chip(on: boolean) {
  return `rounded-[8px] border px-2 py-1 text-[12px] ${on ? "border-brand bg-brand text-white" : "border-line bg-white text-body"}`;
}

function PreviewInput({ field: f, value, onChange }: { field: TaskField; value: TaskAnswer | undefined; onChange: (v: TaskAnswer | undefined) => void }) {
  const box = "h-8 w-full rounded-[8px] border border-line bg-white px-2 text-[12px]";
  switch (f.type) {
    case "short_text":
    case "phone":
      return <input className={box} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || undefined)} />;
    case "long_text":
      return <textarea rows={2} className="w-full rounded-[8px] border border-line bg-white px-2 py-1 text-[12px]" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || undefined)} />;
    case "number":
      return (
        <div className="flex items-center gap-1">
          <input type="number" className={box} value={typeof value === "number" ? value : ""} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} />
          {f.unit ? <span className="text-[11px] text-muted">{f.unit}</span> : null}
        </div>
      );
    case "yes_no":
      return (
        <div className="flex gap-1.5">
          <button type="button" className={`flex-1 ${chip(value === true)}`} onClick={() => onChange(value === true ? undefined : true)}>Yes</button>
          <button type="button" className={`flex-1 ${chip(value === false)}`} onClick={() => onChange(value === false ? undefined : false)}>No</button>
        </div>
      );
    case "single_choice":
    case "multi_choice": {
      const opts = (f.options ?? []).filter((o) => o.trim());
      const picked = Array.isArray(value) ? value : [];
      return (
        <div className="flex flex-wrap gap-1">
          {opts.length === 0 ? <span className="text-[11px] text-muted">Add options</span> : null}
          {opts.map((o) => {
            const on = f.type === "multi_choice" ? picked.includes(o) : value === o;
            return (
              <button
                key={o}
                type="button"
                className={chip(on)}
                onClick={() => {
                  if (f.type === "single_choice") onChange(on ? undefined : o);
                  else {
                    const next = on ? picked.filter((p) => p !== o) : [...picked, o];
                    onChange(next.length ? next : undefined);
                  }
                }}
              >
                {o}
              </button>
            );
          })}
        </div>
      );
    }
    case "rating": {
      const out: number[] = [];
      for (let n = f.min ?? 1; n <= (f.max ?? 5) && out.length < 11; n++) out.push(n);
      return (
        <div className="flex flex-wrap gap-1">
          {out.map((n) => (
            <button key={n} type="button" className={chip(value === n)} onClick={() => onChange(value === n ? undefined : n)}>
              {n}
            </button>
          ))}
        </div>
      );
    }
    case "photo": {
      const n = Array.isArray(value) ? value.length : 0;
      return (
        <div className="flex items-center gap-1.5">
          <button type="button" className={chip(false)} onClick={() => onChange([...(Array.isArray(value) ? value : []), `test${n}`].slice(0, f.max ?? 1))}>
            Camera
          </button>
          <button type="button" className={chip(false)} onClick={() => onChange(undefined)}>
            Clear
          </button>
          <span className="text-[11px] text-muted">{`${n} of ${f.max ?? 1}`}</span>
        </div>
      );
    }
    case "date":
      return <input type="date" className={box} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || undefined)} />;
    case "birthday": {
      const b = (value as { day: number; month: number } | undefined) ?? { day: 0, month: 0 };
      return (
        <div className="flex gap-1">
          <select className={box} value={b.day || ""} onChange={(e) => onChange({ day: Number(e.target.value), month: b.month })}>
            <option value="">Day</option>
            {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
          <select className={box} value={b.month || ""} onChange={(e) => onChange({ day: b.day, month: Number(e.target.value) })}>
            <option value="">Month</option>
            {MONTHS.map((m, i) => (
              <option key={m} value={i + 1}>{m}</option>
            ))}
          </select>
        </div>
      );
    }
    case "location":
      return (
        <button type="button" className={`w-full ${chip(Boolean(value))}`} onClick={() => onChange(value ? undefined : { lat: 19.07, lng: 72.87 })}>
          {value ? "Location taken ✓" : "Use where I am now"}
        </button>
      );
    case "info":
      return null;
  }
}

/* ----------------------------------------------------------------- step 3 */

function WhoStep(props: {
  salesmen: PickSalesman[];
  shops: TaskShopTarget;
  setShops: (s: TaskShopTarget) => void;
  assignKind: "carrier" | "chosen";
  setAssignKind: (k: "carrier" | "chosen") => void;
  chosen: string[];
  setChosen: (c: string[]) => void;
  pickedShops: ShopRow[];
  setPickedShops: (s: ShopRow[]) => void;
  placeOptions: PlaceFilterOptions;
  setPlaceOptions: (o: PlaceFilterOptions) => void;
  preview: TaskAudiencePreview | null;
  previewing: boolean;
  onPreview: () => void;
}) {
  const { shops } = props;
  const filter = shops.kind === "filter" ? shops : null;
  const setFilter = (patch: Partial<Extract<TaskShopTarget, { kind: "filter" }>>) =>
    props.setShops({ ...(filter ?? { kind: "filter", places: {}, carriedBy: [], accountKinds: [] }), ...patch });

  async function changePlaces(patch: Partial<Record<PlaceKind, string | undefined>>) {
    const places: PlaceFilterValues = { ...(filter?.places ?? {}), ...patch };
    for (const k of Object.keys(places) as PlaceKind[]) if (!places[k]) delete places[k];
    setFilter({ places });
    const r = await loadTaskPlaceOptions(places);
    if (r.ok) props.setPlaceOptions(r.data);
  }

  return (
    <div className="space-y-4">
      <section>
        <span className={LABEL}>Which shops is it about?</span>
        <div className="flex flex-wrap gap-1.5">
          {(
            [
              ["none", "No shop — just the salesmen"],
              ["list", "Shops I pick"],
              ["filter", "Shops in an area / matching a filter"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() =>
                props.setShops(
                  k === "none"
                    ? { kind: "none" }
                    : k === "list"
                      ? { kind: "list", customerIds: [] }
                      : { kind: "filter", places: {}, carriedBy: [], accountKinds: [] },
                )
              }
              className={`${TAB} ${shops.kind === k ? TAB_ON : TAB_OFF}`}
            >
              {label}
            </button>
          ))}
        </div>

        {shops.kind === "list" ? <ShopPicker picked={props.pickedShops} setPicked={props.setPickedShops} /> : null}

        {filter ? (
          <div className={`${CARD} mt-2 space-y-2`}>
            <div className="grid grid-cols-4 gap-2">
              <PlaceFilterSelects
                options={props.placeOptions}
                values={filter.places}
                onChange={(patch) => void changePlaces(patch)}
                className="w-full"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <MultiSelect
                label="Carried by"
                placeholder="Carried by anybody"
                options={props.salesmen.map((s) => ({ value: s.id, label: s.name }))}
                selected={filter.carriedBy}
                onChange={(next) => setFilter({ carriedBy: next })}
              />
              <input
                value={filter.search ?? ""}
                onChange={(e) => setFilter({ search: e.target.value || undefined })}
                placeholder="Name, phone or town contains… (optional)"
                className={CONTROL}
              />
            </div>
            <div className="flex flex-wrap items-center gap-4 text-[13px] text-body">
              {(["customer", "lead"] as const).map((k) => (
                <label key={k} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={filter.accountKinds.length === 0 || filter.accountKinds.includes(k)}
                    onChange={(e) => {
                      const both: ("customer" | "lead")[] = ["customer", "lead"];
                      const now = filter.accountKinds.length ? filter.accountKinds : both;
                      const next = e.target.checked ? [...new Set([...now, k])] : now.filter((x) => x !== k);
                      setFilter({ accountKinds: next.length === 2 ? [] : next.length ? next : [k === "lead" ? "customer" : "lead"] });
                    }}
                  />
                  {k === "customer" ? "Customers" : "Leads"}
                </label>
              ))}
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={Boolean(filter.missingGpsOnly)} onChange={(e) => setFilter({ missingGpsOnly: e.target.checked || undefined })} />
                Only shops with no location saved
              </label>
            </div>
          </div>
        ) : null}
      </section>

      <section>
        <span className={LABEL}>Who does it?</span>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            disabled={shops.kind === "none"}
            title={shops.kind === "none" ? "With no shop there is no shop's salesman." : undefined}
            onClick={() => props.setAssignKind("carrier")}
            className={`${TAB} ${props.assignKind === "carrier" ? TAB_ON : TAB_OFF} disabled:opacity-50`}
          >
            Each shop&apos;s own salesman
          </button>
          <button type="button" onClick={() => props.setAssignKind("chosen")} className={`${TAB} ${props.assignKind === "chosen" ? TAB_ON : TAB_OFF}`}>
            Salesmen I choose
          </button>
        </div>
        {props.assignKind === "chosen" ? (
          <SalesmanPicker salesmen={props.salesmen} chosen={props.chosen} setChosen={props.setChosen} perShop={shops.kind !== "none"} />
        ) : null}
      </section>

      <AudienceSummary preview={props.preview} previewing={props.previewing} onPreview={props.onPreview} />
    </div>
  );
}

function SalesmanPicker({
  salesmen,
  chosen,
  setChosen,
  perShop,
}: {
  salesmen: PickSalesman[];
  chosen: string[];
  setChosen: (c: string[]) => void;
  perShop: boolean;
}) {
  const [q, setQ] = React.useState("");
  const list = salesmen.filter((s) => s.name.toLowerCase().includes(q.trim().toLowerCase()));
  const all = list.length > 0 && list.every((s) => chosen.includes(s.id));
  return (
    <div className={`${CARD} mt-2`}>
      <div className="mb-2 flex items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a salesman" className={CONTROL} />
        <Button
          size="sm"
          onClick={() =>
            setChosen(all ? chosen.filter((id) => !list.some((s) => s.id === id)) : [...new Set([...chosen, ...list.map((s) => s.id)])])
          }
        >
          {all ? "Clear these" : "Select all"}
        </Button>
      </div>
      <div className="grid max-h-44 grid-cols-3 gap-1 overflow-y-auto">
        {list.map((s) => (
          <label key={s.id} className="flex items-center gap-1.5 truncate text-[13px] text-body">
            <input
              type="checkbox"
              checked={chosen.includes(s.id)}
              onChange={(e) => setChosen(e.target.checked ? [...chosen, s.id] : chosen.filter((x) => x !== s.id))}
            />
            <span className="truncate">{s.name}</span>
          </label>
        ))}
        {list.length === 0 ? <span className="text-[13px] text-muted">Nobody by that name in your field team.</span> : null}
      </div>
      <p className="mt-2 text-[12px] text-muted">
        {`${chosen.length} chosen.`} {perShop ? "Each of them gets one task for every shop." : "Each of them gets one task."}
      </p>
    </div>
  );
}

function ShopPicker({ picked, setPicked }: { picked: ShopRow[]; setPicked: (s: ShopRow[]) => void }) {
  const [q, setQ] = React.useState("");
  const [found, setFound] = React.useState<ShopRow[]>([]);
  const [searching, setSearching] = React.useState(false);
  const seq = React.useRef(0);

  async function search(term: string) {
    setQ(term);
    const mine = ++seq.current;
    if (term.trim().length < 2) {
      setFound([]);
      return;
    }
    setSearching(true);
    const r = await searchTaskShops(term);
    if (mine !== seq.current) return;
    setSearching(false);
    setFound(r.ok ? r.data : []);
  }

  const has = (id: string) => picked.some((p) => p.id === id);
  return (
    <div className={`${CARD} mt-2 grid grid-cols-2 gap-3`}>
      <div>
        <input value={q} onChange={(e) => void search(e.target.value)} placeholder="Search shops by name, phone or town" className={CONTROL} />
        <div className="mt-1.5 max-h-56 space-y-0.5 overflow-y-auto">
          {searching ? <p className="text-[12px] text-muted">Searching…</p> : null}
          {!searching && q.trim().length >= 2 && found.length === 0 ? <p className="text-[12px] text-muted">Nothing found in your team&apos;s book.</p> : null}
          {found.map((s) => (
            <button
              key={s.id}
              type="button"
              disabled={has(s.id)}
              onClick={() => setPicked([...picked, s])}
              className="block w-full rounded-[4px] px-2 py-1 text-left text-[13px] hover:bg-canvas disabled:opacity-40"
            >
              <span className="text-ink">{has(s.id) ? "✓ " : "+ "}{s.name}</span>
              <span className="block text-[11px] text-muted">{[s.place, s.carrierName ?? "nobody carries it"].filter(Boolean).join(" · ")}</span>
            </button>
          ))}
        </div>
      </div>
      <div>
        <span className={LABEL}>{`Picked (${picked.length})`}</span>
        <div className="max-h-60 space-y-0.5 overflow-y-auto">
          {picked.length === 0 ? <p className="text-[12px] text-muted">Search on the left and click a shop to add it.</p> : null}
          {picked.map((s) => (
            <div key={s.id} className="flex items-center gap-1 rounded-[4px] bg-canvas px-2 py-1 text-[13px]">
              <span className="truncate">{s.name}</span>
              <span className="ml-auto truncate text-[11px] text-muted">{s.carrierName ?? "—"}</span>
              <IconBtn label="Remove" onClick={() => setPicked(picked.filter((p) => p.id !== s.id))}>✕</IconBtn>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function AudienceSummary({
  preview,
  previewing,
  onPreview,
}: {
  preview: TaskAudiencePreview | null;
  previewing: boolean;
  onPreview: () => void;
}) {
  if (!preview) {
    return (
      <div className={CARD}>
        <Button size="sm" disabled={previewing} onClick={onPreview}>
          {previewing ? "Checking…" : "See who this reaches"}
        </Button>
      </div>
    );
  }
  return (
    <div className={CARD}>
      <p className="text-[14px] text-ink">
        <span className="font-semibold">{preview.tasks.toLocaleString("en-IN")} tasks</span>
        {` for ${preview.salesmen.length} salesm${preview.salesmen.length === 1 ? "an" : "en"}`}
        {preview.shops !== null ? ` across ${preview.shops.toLocaleString("en-IN")} shops` : ""}.
      </p>
      {preview.sample.length ? (
        <p className="text-[12px] text-muted">{`${preview.sample.join(", ")}${(preview.shops ?? 0) > preview.sample.length ? ", …" : ""}`}</p>
      ) : null}
      {preview.alreadyComplete ? (
        <p className="mt-1 text-[12px] text-success">
          {`✓ ${preview.alreadyComplete} shop${preview.alreadyComplete === 1 ? " already has" : "s already have"} everything this asks for on the customer record, so ${preview.alreadyComplete === 1 ? "it is" : "they are"} left out — nobody visits a shop to collect what we already hold.`}
        </p>
      ) : null}
      {preview.noCarrier || preview.outsideTeam ? (
        <p className="mt-1 text-[12px] text-warn">
          {preview.noCarrier ? `${preview.noCarrier} shop${preview.noCarrier === 1 ? " has" : "s have"} no salesman and will be skipped. ` : ""}
          {preview.outsideTeam ? `${preview.outsideTeam} ${preview.outsideTeam === 1 ? "is" : "are"} for somebody who is not an active salesman in your field team (no MBOS app, or not in your team) and will be skipped.` : ""}
        </p>
      ) : null}
      {preview.tooMany ? <p className="mt-1 text-[12px] text-danger">Too many in one go — narrow it down.</p> : null}
      {preview.salesmen.length ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {preview.salesmen.slice(0, 30).map((s) => (
            <span key={s.id} className="rounded-full bg-canvas px-2 py-0.5 text-[12px] text-body">
              {s.name} · {s.count}
            </span>
          ))}
          {preview.salesmen.length > 30 ? <span className="text-[12px] text-muted">+{preview.salesmen.length - 30} more</span> : null}
        </div>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------------- step 4 */

function ReviewStep(props: {
  title: string;
  description: string;
  dueDate: string;
  priority: Priority;
  fields: TaskField[];
  preview: TaskAudiencePreview | null;
  previewing: boolean;
  onPreview: () => void;
  aiAvailable: boolean;
  suggestions: LinkSuggestion[] | null;
  checkingLinks: boolean;
  onApplyLink: (fieldId: string, link: TaskFieldLink) => void;
  onDismissLink: (fieldId: string) => void;
}) {
  const pending = (props.suggestions ?? []).filter((x) => props.fields.some((f) => f.id === x.fieldId && !f.link));
  return (
    <div className="space-y-3">
      {props.checkingLinks || pending.length ? (
        <div className="rounded-[8px] border border-brand/40 bg-brand-soft p-3">
          <p className="text-[13px] font-semibold text-ink">
            ✦ {props.checkingLinks ? "Checking which answers belong on the customer record…" : "These answers look like customer data"}
          </p>
          {!props.checkingLinks ? (
            <>
              <p className="mb-2 text-[12px] text-muted">
                Link them and each answer updates the shop&apos;s record, the phone shows what we already hold, and a shop
                that already has it is never visited for it.
              </p>
              <div className="space-y-1.5">
                {pending.map((x) => {
                  const f = props.fields.find((ff) => ff.id === x.fieldId)!;
                  return (
                    <div key={x.fieldId} className="flex items-center gap-2 rounded-[6px] bg-surface p-2 text-[13px]">
                      <span className="flex-1">
                        <span className="font-medium text-ink">“{f.label}”</span>
                        {" → "}
                        <span className="text-[#5223E0]">{linkWords(x.link)}</span>
                        <span className="block text-[12px] text-muted">
                          {x.reason}
                          {x.source === "ai" ? ` · AI, ${x.confidence}% sure` : " · matched by its words"}
                        </span>
                      </span>
                      <Button size="sm" tone="primary" onClick={() => props.onApplyLink(x.fieldId, x.link)}>
                        Link it
                      </Button>
                      <Button size="sm" tone="quiet" onClick={() => props.onDismissLink(x.fieldId)}>
                        No
                      </Button>
                    </div>
                  );
                })}
              </div>
              {pending.length > 1 ? (
                <div className="mt-2">
                  <Button size="sm" onClick={() => pending.forEach((x) => props.onApplyLink(x.fieldId, x.link))}>
                    Link all {pending.length}
                  </Button>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      <div className={CARD}>
        <p className="text-[15px] font-semibold text-ink">{props.title}</p>
        {props.description ? <p className="mt-1 text-[13px] whitespace-pre-line text-body">{props.description}</p> : null}
        <p className="mt-1 text-[12px] text-muted">
          {`Due ${props.dueDate} · ${props.priority === "medium" ? "Normal" : props.priority === "high" ? "High" : "Low"} priority`}
        </p>
      </div>
      <div className={CARD}>
        <span className={LABEL}>{props.fields.length ? `${props.fields.length} questions` : "No questions — done with a note"}</span>
        <ol className="list-decimal space-y-0.5 pl-5 text-[13px] text-body">
          {props.fields.map((f) => (
            <li key={f.id}>
              {f.label} <span className="text-muted">— {TASK_FIELD_TYPE_LABELS[f.type].label}{f.required ? ", needed" : ""}</span>
              {f.link ? <LinkBadge link={f.link} /> : null}
              {f.showIf ? <span className="block text-[12px] text-muted">{conditionSentence(f.showIf, props.fields)}</span> : null}
            </li>
          ))}
        </ol>
      </div>
      <AudienceSummary preview={props.preview} previewing={props.previewing} onPreview={props.onPreview} />
    </div>
  );
}


/* ------------------------------------------------------------ record links */

function linkWords(link: TaskFieldLink): string {
  const target = TASK_LINK_TARGETS[link.target];
  const who = target.contact ? (link.scope === "each" ? " (every contact)" : " (main contact)") : "";
  return `${target.label}${who}, ${link.mode === "fill" ? "collected where missing" : "checked and corrected"}`;
}

function LinkBadge({ link }: { link: TaskFieldLink }) {
  return (
    <span
      className="ml-1.5 inline-flex items-center gap-1 rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-[#5223E0]"
      title={linkWords(link)}
    >
      ↻ {TASK_LINK_TARGETS[link.target].label}
    </span>
  );
}

/**
 * Where a question's answer goes on the customer record. Offered only for a
 * question whose type the record field can hold; a keyword guess is offered
 * as a one-click suggestion where nothing is linked yet.
 */
function LinkEditor({ field: f, onChange }: { field: TaskField; onChange: (link: TaskFieldLink | undefined) => void }) {
  const targets = linkTargetsFor(f.type);
  if (!targets.length) return null;
  const guess = !f.link ? guessTaskLink(f) : null;
  const target = f.link ? TASK_LINK_TARGETS[f.link.target] : null;
  return (
    <div className="mt-2 rounded-[4px] border border-dashed border-brand/40 p-2">
      <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
        <span className="font-medium text-ink">↻ Save the answer to the customer record</span>
        <select
          value={f.link?.target ?? ""}
          onChange={(e) => {
            const t = e.target.value as TaskFieldLink["target"] | "";
            if (!t) return onChange(undefined);
            onChange({ target: t, mode: f.link?.mode ?? "fill", ...(TASK_LINK_TARGETS[t].contact ? { scope: f.link?.scope ?? "primary" } : {}) });
          }}
          className={`${CONTROL} h-7.5 w-auto`}
        >
          <option value="">No — keep it on the task</option>
          {targets.map((t) => (
            <option key={t} value={t}>
              {TASK_LINK_TARGETS[t].label}
            </option>
          ))}
        </select>
        {f.link && target?.contact ? (
          <select
            value={f.link.scope ?? "primary"}
            onChange={(e) => onChange({ ...f.link!, scope: e.target.value as "primary" | "each" })}
            className={`${CONTROL} h-7.5 w-auto`}
          >
            <option value="primary">Main contact</option>
            <option value="each">Every contact (asked once per person)</option>
          </select>
        ) : null}
        {f.link ? (
          <select
            value={f.link.mode}
            onChange={(e) => onChange({ ...f.link!, mode: e.target.value as "fill" | "update" })}
            className={`${CONTROL} h-7.5 w-auto`}
          >
            <option value="fill">Collect where missing</option>
            <option value="update">Check and correct</option>
          </select>
        ) : null}
      </div>
      {f.link ? (
        <p className="mt-1 text-[11px] text-muted">
          {f.link.mode === "fill"
            ? "The phone shows what the record holds. Shops that already have it are skipped, and the task completes itself if somebody fills it in elsewhere."
            : "The phone shows what the record holds; whatever the salesman confirms or corrects is written back."}
        </p>
      ) : guess ? (
        <p className="mt-1 text-[11px] text-muted">
          This looks like the {TASK_LINK_TARGETS[guess.target].label.toLowerCase()}.{" "}
          <button type="button" className="text-brand hover:underline" onClick={() => onChange(guess)}>
            Link it
          </button>
        </p>
      ) : null}
    </div>
  );
}
