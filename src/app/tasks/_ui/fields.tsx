"use client";

import * as React from "react";
import { Badge, Button, Field, Input, Select, cx } from "@/components/ui/primitives";
import { loadAudienceOptions } from "@/lib/actions/tasks";
import type { AudienceOptions } from "@/lib/tasks/audience-service";
import {
  AUDIENCE_KIND_LABEL,
  LEVEL_LABEL,
  resolveAudience,
  ruleKey,
  type Audience,
  type AudienceKind,
  type AudienceRule,
} from "@/lib/tasks/audience";
import { FREQUENCY_LABEL, ROUTINE_FREQUENCIES, WEEKDAY_SHORT, ordinal, type RoutineFrequency } from "@/lib/tasks/routines";
import { TASK_APP_LABEL, isTaskApp } from "@/lib/tasks/rules";

/* ---------------------------------------------------------------------------
 * The pieces the New task form and the routine form share: what closing asks
 * for, how often it repeats, and who gets it.
 * ------------------------------------------------------------------------- */

const seg = (on: boolean) => cx("h-7.5 cursor-pointer rounded-md px-3 text-[13.5px] font-medium", on ? "bg-surface text-brand-hover shadow-sm" : "text-body");

function Toggle({ value, onChange, options, label }: { value: boolean; onChange: (v: boolean) => void; options: [string, string]; label: string }) {
  return (
    <span className="inline-flex gap-0.5 rounded-lg bg-canvas p-[3px]" role="group" aria-label={label}>
      <button type="button" aria-pressed={value} className={seg(value)} onClick={() => onChange(true)}>
        {options[0]}
      </button>
      <button type="button" aria-pressed={!value} className={seg(!value)} onClick={() => onChange(false)}>
        {options[1]}
      </button>
    </span>
  );
}

/** Two switches: does closing need a screenshot, and does it need a remark. */
export function CloseRules({
  proof,
  remark,
  onProof,
  onRemark,
}: {
  proof: boolean;
  remark: boolean;
  onProof: (v: boolean) => void;
  onRemark: (v: boolean) => void;
}) {
  return (
    <>
      <Field label="Screenshot when closing" required group hint="Required means it cannot be closed without one. You can change this later.">
        <Toggle value={proof} onChange={onProof} options={["Required", "Optional"]} label="Screenshot when closing" />
      </Field>
      <Field label="Remarks when closing" required group hint="Closing always asks them to confirm it is done. Required means they must also write what they did.">
        <Toggle value={remark} onChange={onRemark} options={["Required", "Optional"]} label="Remarks when closing" />
      </Field>
    </>
  );
}

/** "Screenshot required · remarks optional" — for a review line or a card. */
export function closeWords(proof: boolean, remark: boolean) {
  return `Screenshot ${proof ? "required" : "optional"} · remarks ${remark ? "required" : "optional"}`;
}

/* ------------------------------------------------------------- repeats */

export type Repeat = "once" | RoutineFrequency;

export type ScheduleState = {
  weekdays: number[];
  dayOfMonth: string;
  completeByDay: string;
  startTime: string;
  dueTime: string;
};

export function RepeatPicker({ value, onChange, allowOnce = true }: { value: Repeat; onChange: (r: Repeat) => void; allowOnce?: boolean }) {
  const choices: Repeat[] = allowOnce ? ["once", ...ROUTINE_FREQUENCIES] : [...ROUTINE_FREQUENCIES];
  return (
    <span className="inline-flex gap-0.5 rounded-lg bg-canvas p-[3px]">
      {choices.map((f) => (
        <button key={f} type="button" className={seg(value === f)} onClick={() => onChange(f)}>
          {f === "once" ? "Once" : FREQUENCY_LABEL[f]}
        </button>
      ))}
    </span>
  );
}

/** The days a routine runs on, and its time window. */
export function ScheduleFields({
  frequency,
  s,
  set,
  problems,
}: {
  frequency: RoutineFrequency;
  s: ScheduleState;
  set: (patch: Partial<ScheduleState>) => void;
  problems: Record<string, string>;
}) {
  const days = Array.from({ length: 31 }, (_, i) => i + 1);
  return (
    <>
      {frequency === "monthly" ? (
        <>
          <Field label="Appears on" required error={problems.dayOfMonth || null} hint="A day past the end of a short month lands on its last day.">
            <Select value={s.dayOfMonth} onChange={(e) => set({ dayOfMonth: e.target.value })}>
              {days.map((d) => (
                <option key={d} value={d}>
                  The {ordinal(d)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Done by" optional error={problems.completeByDay || null} hint="Empty means the same day.">
            <Select value={s.completeByDay} onChange={(e) => set({ completeByDay: e.target.value })}>
              <option value="">The same day</option>
              {days
                .filter((d) => d > Number(s.dayOfMonth))
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
              const on = s.weekdays.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  onClick={() => set({ weekdays: on ? s.weekdays.filter((x) => x !== d) : [...s.weekdays, d] })}
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
        <Input type="time" value={s.startTime} onChange={(e) => set({ startTime: e.target.value })} />
      </Field>
      <Field label="End" optional hint="Each day's task is due by then." error={problems.dueTime || null}>
        <Input type="time" value={s.dueTime} onChange={(e) => set({ dueTime: e.target.value })} />
      </Field>
    </>
  );
}

/* ---------------------------------------------------------- who gets it */

const PICKABLE: Exclude<AudienceKind, "everyone">[] = ["person", "team", "designation", "department", "level", "erpDesignation"];

function ruleLabel(kind: AudienceKind, choiceLabel: string, appLabel: string): string {
  switch (kind) {
    case "everyone":
      return `Everybody with ${appLabel}`;
    case "person":
    case "team":
      return choiceLabel;
    case "level":
      return `${choiceLabel}s in ${appLabel}`;
    default:
      return `${AUDIENCE_KIND_LABEL[kind]}: ${choiceLabel}`;
  }
}

/**
 * Include and exclude, each a list of rules, and a live preview of who that
 * comes to. Only people who hold `app` are offered — the choices themselves
 * (teams, designations, departments, levels) are read off those people.
 */
export function AudienceBuilder({ app, value, onChange, error }: { app: string; value: Audience; onChange: (a: Audience) => void; error?: string | null }) {
  const [opts, setOpts] = React.useState<{ app: string; data: AudienceOptions } | null>(null);
  const [showAll, setShowAll] = React.useState(false);
  const appLabel = isTaskApp(app) ? (app === "tasks" ? "Tasks" : TASK_APP_LABEL[app]) : app;

  React.useEffect(() => {
    let live = true;
    void loadAudienceOptions(app).then((r) => {
      if (live && r.ok) setOpts({ app, data: r.data });
    });
    return () => {
      live = false;
    };
  }, [app]);

  // A person picked before the options arrived (the team screen's "Give a task") gets their name.
  const data = opts?.app === app ? opts.data : null;
  React.useEffect(() => {
    if (!data) return;
    const named = (r: AudienceRule) => (r.kind === "person" && !r.label ? { ...r, label: data.people.find((p) => p.id === r.value)?.name ?? "Somebody" } : r);
    if ([...value.include, ...value.exclude].some((r) => r.kind === "person" && !r.label)) onChange({ include: value.include.map(named), exclude: value.exclude.map(named) });
  }, [data, value, onChange]);

  if (!data) return <p className="text-sm text-muted">Finding who holds {appLabel}…</p>;
  if (!data.people.length) return <p className="text-sm text-muted">Nobody you can give tasks to holds {appLabel} yet. Give them the app on the Access screen first.</p>;

  const resolved = resolveAudience(value, data.people);
  const add = (list: "include" | "exclude", rule: AudienceRule) => {
    if (value[list].some((r) => ruleKey(r) === ruleKey(rule))) return;
    const other = list === "include" ? "exclude" : "include";
    onChange({ ...value, [list]: [...value[list], rule], [other]: value[other].filter((r) => ruleKey(r) !== ruleKey(rule)) });
  };
  const remove = (list: "include" | "exclude", rule: AudienceRule) => onChange({ ...value, [list]: value[list].filter((r) => ruleKey(r) !== ruleKey(rule)) });

  const shown = showAll ? data.people : data.people.filter((p) => resolved.why.has(p.id));

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
        <RuleList title="Include" tone="success" rules={value.include} onRemove={(r) => remove("include", r)} empty="Nobody yet — add a person, a team, a designation…">
          <AddRule data={data} appLabel={appLabel} onAdd={(r) => add("include", r)} allowEveryone />
        </RuleList>
        <RuleList title="Exclude" tone="danger" rules={value.exclude} onRemove={(r) => remove("exclude", r)} empty="Nobody left out.">
          <AddRule data={data} appLabel={appLabel} onAdd={(r) => add("exclude", r)} />
        </RuleList>
      </div>
      {error ? <p className="text-[13px] text-danger">{error}</p> : null}
      <div className="rounded-card border border-line">
        <div className="flex items-center justify-between border-b border-divider px-3 py-2 text-sm">
          <span className="font-medium text-ink">
            {resolved.ids.length === 0 ? "Nobody gets it yet" : resolved.ids.length === 1 ? "1 person gets it" : `${resolved.ids.length} people get it — each their own copy`}
            <span className="font-normal text-muted"> · of {data.people.length} who hold {appLabel}</span>
          </span>
          <button type="button" className="cursor-pointer text-[13px] font-medium text-brand" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Only those the rules touch" : "Show everybody"}
          </button>
        </div>
        <div className="max-h-[200px] overflow-y-auto">
          {shown.length ? (
            shown.map((p) => {
              const w = resolved.why.get(p.id);
              return (
                <div key={p.id} className="flex items-center gap-2.5 px-3 py-1.5 text-sm">
                  <span className={cx("w-4 text-center font-bold", w?.in ? "text-success" : "text-faint")}>{w?.in ? "✓" : "–"}</span>
                  <span className={cx("min-w-0 flex-1 truncate", w?.in ? "text-ink" : "text-muted")}>{p.name}</span>
                  <span className="truncate text-xs text-muted">{[p.designation, p.level ? LEVEL_LABEL[p.level] : null].filter(Boolean).join(" · ")}</span>
                  <span className={cx("w-[170px] flex-none truncate text-right text-xs", w?.in ? "text-success" : "text-muted")}>{w?.because ?? "Not in the rules"}</span>
                </div>
              );
            })
          ) : (
            <p className="px-3 py-3 text-sm text-muted">Add a rule to Include to see who it reaches.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function RuleList({
  title,
  tone,
  rules,
  onRemove,
  empty,
  children,
}: {
  title: string;
  tone: "success" | "danger";
  rules: AudienceRule[];
  onRemove: (r: AudienceRule) => void;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-card border border-line p-3">
      <div className={cx("mb-2 text-[13px] font-semibold", tone === "success" ? "text-success" : "text-danger")}>{title}</div>
      <div className="mb-2.5 flex min-h-7 flex-wrap gap-1.5">
        {rules.length ? (
          rules.map((r) => (
            <span key={ruleKey(r)} className="inline-flex items-center gap-1">
              <Badge tone={tone}>{r.label}</Badge>
              <button type="button" aria-label={`Remove ${r.label}`} className="cursor-pointer px-1 text-muted hover:text-ink" onClick={() => onRemove(r)}>
                ×
              </button>
            </span>
          ))
        ) : (
          <span className="text-[13px] text-muted">{empty}</span>
        )}
      </div>
      {children}
    </div>
  );
}

function AddRule({ data, appLabel, onAdd, allowEveryone = false }: { data: AudienceOptions; appLabel: string; onAdd: (r: AudienceRule) => void; allowEveryone?: boolean }) {
  const kinds = PICKABLE.filter((k) => data.choices[k].length);
  const [kind, setKind] = React.useState<AudienceKind>(kinds[0] ?? "person");
  const choices = kind === "everyone" ? [] : data.choices[kind];
  const [pick, setPick] = React.useState("");
  const chosen = choices.find((c) => c.value === pick);

  return (
    <div className="flex flex-wrap gap-1.5">
      <Select
        value={kind}
        onChange={(e) => {
          setKind(e.target.value as AudienceKind);
          setPick("");
        }}
        aria-label="Kind of rule"
        className="w-[150px]"
      >
        {allowEveryone ? <option value="everyone">Everybody</option> : null}
        {kinds.map((k) => (
          <option key={k} value={k}>
            {k === "level" ? `Level in ${appLabel}` : AUDIENCE_KIND_LABEL[k]}
          </option>
        ))}
      </Select>
      {kind !== "everyone" ? (
        <Select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Which" className="min-w-[150px] flex-1">
          <option value="">Choose…</option>
          {choices.map((c) => (
            <option key={c.value} value={c.value}>
              {kind === "person" ? c.label : `${c.label} (${c.count})`}
            </option>
          ))}
        </Select>
      ) : null}
      <Button
        size="sm"
        disabled={kind !== "everyone" && !chosen}
        onClick={() => {
          if (kind === "everyone") onAdd({ kind, value: "*", label: ruleLabel(kind, "", appLabel) });
          else if (chosen) onAdd({ kind, value: chosen.value, label: ruleLabel(kind, chosen.label, appLabel) });
          setPick("");
        }}
      >
        Add
      </Button>
    </div>
  );
}
