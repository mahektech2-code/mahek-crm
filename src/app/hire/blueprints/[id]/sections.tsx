"use client";

import { APPS } from "@/lib/apps";
import {
  MASKABLE,
  QUESTION_TYPES,
  SCORED_TYPES,
  STAGE_TYPES,
  STAGE_TYPE_LABEL,
  type BriefingPoint,
  type CalcRule,
  type DocumentRequirement,
  type Maskable,
  type Question,
  type Stage,
} from "@/lib/hire/blueprint-types";
import type { StudioDefinition } from "@/lib/hire/engines/diff";
import type { CriticFinding } from "@/lib/hire/ai/rubric-critic";
import { cx } from "@/components/ui/primitives";
import { Callout, Label, Pill } from "../../_ui/kit";
import { Add, Area, Card, Check, ElementHead, F, Num, Remove, Sel, Txt } from "./fields";

export type Mut = (fn: (d: StudioDefinition) => void) => void;
export type SecProps = { def: StudioDefinition; mut: Mut; ro: boolean; critic: CriticFinding[]; goRubric: (ref: string) => void; rubricRef: string };

const nextKey = (prefix: string, taken: string[]) => {
  for (let i = 1; ; i++) if (!taken.includes(`${prefix}${i}`)) return `${prefix}${i}`;
};
const isScoredType = (t: Stage["type"]) => SCORED_TYPES.has(t);
const RUPEE = 100;

/* --------------------------------------------------------- competencies */

export function Competencies({ def, mut, ro }: SecProps) {
  const sum = def.competencies.reduce((n, c) => n + c.weight, 0);
  const off = Math.abs(sum - 1) > 0.001;
  return (
    <div className="flex flex-col gap-3">
      <Card tone={off ? "warn" : undefined}>
        <ElementHead
          title={<>Competency model · weights total <span className={cx("tabular-nums", off ? "text-danger" : "")}>{Math.round(sum * 1000) / 10}%</span>{off ? " — they must total 100%" : ""}</>}
          ai={def.competencies.some(() => def.stages.some((s) => s.ai))}
          approved={def.competenciesApproved !== false}
          ro={ro}
          onApprove={() => mut((d) => void (d.competenciesApproved = true))}
        />
      </Card>
      {def.competencies.map((c, i) => (
        <Card key={c.key}>
          <div className="grid grid-cols-[minmax(0,1fr)_120px_auto] gap-3">
            <F label="Name"><Txt value={c.name} ro={ro} onChange={(v) => mut((d) => void (d.competencies[i].name = v))} /></F>
            <F label="Weight (%)"><Num value={Math.round(c.weight * 1000) / 10} step={5} ro={ro} onChange={(v) => mut((d) => void (d.competencies[i].weight = (v ?? 0) / 100))} /></F>
            <div className="flex items-end"><Remove ro={ro} onClick={() => mut((d) => void d.competencies.splice(i, 1))} /></div>
          </div>
          <F label="Definition" className="mt-3"><Area value={c.definition} ro={ro} onChange={(v) => mut((d) => void (d.competencies[i].definition = v))} /></F>
          <div className="mt-3 grid grid-cols-3 gap-3">
            {(["low", "mid", "high"] as const).map((k) => (
              <F key={k} label={`Anchor · ${k}`}><Area value={c.anchors[k]} ro={ro} onChange={(v) => mut((d) => void (d.competencies[i].anchors[k] = v))} /></F>
            ))}
          </div>
        </Card>
      ))}
      <Add ro={ro} onClick={() => mut((d) => void d.competencies.push({ key: nextKey("c", d.competencies.map((x) => x.key)), name: "New competency", definition: "", weight: 0, anchors: { low: "", mid: "", high: "" } }))}>Add a competency</Add>
      <div className="flex gap-2">
        {!ro && off && def.competencies.length ? (
          <button
            className="h-[30px] cursor-pointer rounded-[4px] border border-line bg-surface px-3 text-[13px]"
            onClick={() =>
              mut((d) => {
                const t = d.competencies.reduce((n, c) => n + c.weight, 0) || 1;
                d.competencies.forEach((c) => (c.weight = Math.round((c.weight / t) * 1000) / 1000));
                const drift = 1 - d.competencies.reduce((n, c) => n + c.weight, 0);
                d.competencies[0].weight = Math.round((d.competencies[0].weight + drift) * 1000) / 1000;
              })
            }
          >
            Scale the weights to total 100%
          </button>
        ) : null}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- stages */

export function Stages({ def, mut, ro }: SecProps) {
  return (
    <div className="flex flex-col gap-3">
      {def.stages.map((s, i) => (
        <Card key={s.key}>
          <ElementHead
            title={<><span className="mr-2 text-muted tabular-nums">{i + 1}</span>{s.name}</>}
            ai={s.ai}
            approved={s.approved}
            ro={ro}
            onApprove={() => mut((d) => void (d.stages[i].approved = true))}
            actions={
              ro ? null : (
                <>
                  <button disabled={i === 0} title="Move earlier" onClick={() => mut((d) => void d.stages.splice(i - 1, 0, d.stages.splice(i, 1)[0]))} className="h-[30px] w-[30px] cursor-pointer rounded-[4px] border border-line bg-surface text-[13px] disabled:cursor-not-allowed disabled:text-faint">↑</button>
                  <button disabled={i === def.stages.length - 1} title="Move later" onClick={() => mut((d) => void d.stages.splice(i + 1, 0, d.stages.splice(i, 1)[0]))} className="h-[30px] w-[30px] cursor-pointer rounded-[4px] border border-line bg-surface text-[13px] disabled:cursor-not-allowed disabled:text-faint">↓</button>
                  <Remove ro={ro} onClick={() => mut((d) => void d.stages.splice(i, 1))} />
                </>
              )
            }
          />
          {s.rationale ? <div className="mt-1 text-[13px] text-muted">{s.ai ? "◈ " : ""}{s.rationale}</div> : null}
          <div className="mt-3 grid grid-cols-[minmax(0,1fr)_200px_110px_170px] gap-3">
            <F label="Name"><Txt value={s.name} ro={ro} onChange={(v) => mut((d) => void (d.stages[i].name = v))} /></F>
            <F label="Type"><Sel value={s.type} ro={ro} options={STAGE_TYPES.map((t) => [t, STAGE_TYPE_LABEL[t]] as const)} onChange={(v) => mut((d) => void (d.stages[i].type = v))} /></F>
            <F label="SLA (hours)"><Num value={s.slaHours} ro={ro} onChange={(v) => mut((d) => void (d.stages[i].slaHours = v ?? 0))} /></F>
            {s.type === "decision_gate" ? (
              <F label="Who decides"><Sel value={s.gateRole ?? "Hiring Manager"} ro={ro} options={[["Hiring Manager", "Hiring Manager"], ["HR Head", "HR Head"], ["Admin", "Admin"]] as const} onChange={(v) => mut((d) => void (d.stages[i].gateRole = v))} /></F>
            ) : isScoredType(s.type) ? (
              <div className="pt-6 text-[13px] text-muted tabular-nums">{s.questions.length} questions · max {s.questions.reduce((n, q) => n + q.maxPoints, 0)} · pass {s.passThreshold}</div>
            ) : (
              <div />
            )}
          </div>
        </Card>
      ))}
      <Add
        ro={ro}
        onClick={() =>
          mut((d) => {
            const key = nextKey("s", d.stages.map((x) => x.key));
            const gate = d.stages.findIndex((x) => x.type === "decision_gate");
            d.stages.splice(gate < 0 ? d.stages.length : gate, 0, { key, name: "New interview", type: "scored_interview", maxPoints: 0, passThreshold: 70, autoRejectFloor: null, strongSignal: null, graceRange: 5, slaHours: 72, questions: [], approved: false, ai: false });
          })
        }
      >
        Add a stage
      </Add>
    </div>
  );
}

/* ------------------------------------------------------------ questions */

const MODES = [["ai_rubric", "AI rubric"], ["fixed_choice", "Fixed choice"], ["calculated", "Calculated"], ["manual", "Manual"]] as const;

export function Questions({ def, mut, ro, critic, goRubric }: SecProps) {
  const scored = def.stages.map((s, si) => ({ s, si })).filter(({ s }) => isScoredType(s.type));
  if (!scored.length) return <Callout>No scored stage yet. Add an interview, a screen or a work sample under Stages.</Callout>;
  return (
    <div className="flex flex-col gap-6">
      {scored.map(({ s, si }) => (
        <div key={s.key}>
          <div className="mb-2 flex items-baseline gap-2">
            <span className="text-[15px] font-semibold text-heading">{s.name}</span>
            <span className="text-[13px] text-muted tabular-nums">{s.questions.length} questions · max {s.questions.reduce((n, q) => n + q.maxPoints, 0)}</span>
          </div>
          <div className="flex flex-col gap-3">
            {s.questions.map((q, qi) => {
              const ref = `${s.key}.${q.key}`;
              const findings = critic.filter((c) => c.where === ref);
              return (
                <Card key={q.key}>
                  <ElementHead
                    title={<span className="text-muted">{q.key.toUpperCase()}</span>}
                    ai={q.ai}
                    approved={q.approved}
                    ro={ro}
                    onApprove={() => mut((d) => void (d.stages[si].questions[qi].approved = true))}
                    actions={
                      <>
                        <button onClick={() => goRubric(ref)} className="h-[30px] cursor-pointer rounded-[4px] border border-line bg-surface px-2.5 text-[13px] text-body">Rubric →</button>
                        <Remove ro={ro} onClick={() => mut((d) => void d.stages[si].questions.splice(qi, 1))} />
                      </>
                    }
                  />
                  <div className="mt-2"><Area value={q.text} ro={ro} onChange={(v) => mut((d) => void (d.stages[si].questions[qi].text = v))} /></div>
                  <div className="mt-3 grid grid-cols-[150px_150px_100px_auto] items-end gap-3">
                    <F label="Type"><Sel value={q.type} ro={ro} options={QUESTION_TYPES.map((t) => [t, t.replace("_", " ")] as const)} onChange={(v) => mut((d) => void (d.stages[si].questions[qi].type = v))} /></F>
                    <F label="Scoring"><Sel value={q.mode} ro={ro} options={MODES} onChange={(v) => mut((d) => void (d.stages[si].questions[qi].mode = v))} /></F>
                    <F label="Max points"><Num value={q.maxPoints} ro={ro} onChange={(v) => mut((d) => void (d.stages[si].questions[qi].maxPoints = v ?? 0))} /></F>
                    <div className="flex gap-4 pb-2">
                      <Check ro={ro} checked={q.mandatory} label="Mandatory" onChange={(v) => mut((d) => void (d.stages[si].questions[qi].mandatory = v))} />
                      <Check ro={ro} checked={q.knockout} label="Knockout" onChange={(v) => mut((d) => void (d.stages[si].questions[qi].knockout = v))} />
                    </div>
                  </div>
                  <div className="mt-3">
                    <Label className="mb-1.5">Competencies tested</Label>
                    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                      {def.competencies.map((c) => (
                        <Check
                          key={c.key}
                          ro={ro}
                          checked={q.competencyKeys.includes(c.key)}
                          label={c.name}
                          onChange={(v) =>
                            mut((d) => {
                              const k = d.stages[si].questions[qi].competencyKeys;
                              d.stages[si].questions[qi].competencyKeys = v ? [...k, c.key] : k.filter((x) => x !== c.key);
                            })
                          }
                        />
                      ))}
                      {!q.competencyKeys.length ? <span className="text-[13px] text-danger">Maps to no competency</span> : null}
                    </div>
                  </div>
                  {findings.map((f, i) => (
                    <Callout key={i} tone="ai" className="mt-3">◈ Rubric critic · {f.message}{f.suggestion ? ` Suggestion: ${f.suggestion}` : ""}</Callout>
                  ))}
                </Card>
              );
            })}
            <Add
              ro={ro}
              onClick={() =>
                mut((d) =>
                  void d.stages[si].questions.push({
                    key: nextKey("q", d.stages[si].questions.map((x) => x.key)),
                    text: "",
                    type: "behavioural",
                    competencyKeys: [],
                    maxPoints: 10,
                    weight: 1,
                    mode: "ai_rubric",
                    idealAnswer: "",
                    probes: [],
                    rubric: [
                      { key: "r0", descriptor: "No example; answers in general terms", points: 0, tier: "zero", indicators: [] },
                      { key: "r1", descriptor: "One specific example of what they did", points: 5, tier: "partial", indicators: [] },
                      { key: "r2", descriptor: "Specific examples, the result, and what they changed afterwards", points: 10, tier: "full", indicators: [] },
                    ],
                    mandatory: true,
                    knockout: false,
                    approved: false,
                    ai: false,
                  }),
                )
              }
            >
              Add a question to {s.name}
            </Add>
          </div>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- rubrics */

export function Rubrics({ def, mut, ro, critic, goRubric, rubricRef }: SecProps) {
  const all = def.stages.flatMap((s, si) => s.questions.map((q, qi) => ({ s, si, q, qi, ref: `${s.key}.${q.key}` })));
  if (!all.length) return <Callout>No questions yet. Add them under Questions.</Callout>;
  const cur = all.find((x) => x.ref === rubricRef) ?? all[0];
  const { s, si, q, qi } = cur;
  const set = (fn: (q: Question) => void) => mut((d) => fn(d.stages[si].questions[qi]));
  const findings = critic.filter((c) => c.where === cur.ref);
  return (
    <div className="flex flex-col gap-4">
      <select value={cur.ref} onChange={(e) => goRubric(e.target.value)} className="h-9 rounded-[4px] border border-line-strong bg-surface px-2.5 text-sm">
        {all.map((x) => (
          <option key={x.ref} value={x.ref}>
            {x.s.name} · {x.q.key.toUpperCase()} · {x.q.text.slice(0, 80) || "(no text)"}
            {critic.some((c) => c.where === x.ref) ? " · ◈ critic" : ""}
          </option>
        ))}
      </select>
      <Card>
        <ElementHead title={`${s.name} · ${q.key.toUpperCase()}`} ai={q.ai} approved={q.approved} ro={ro} onApprove={() => set((x) => void (x.approved = true))} />
        <F label="Question" className="mt-3"><Area value={q.text} ro={ro} onChange={(v) => set((x) => void (x.text = v))} /></F>
        <div className="mt-3 grid grid-cols-[minmax(0,1fr)_110px_170px] gap-3">
          <F label="Competency">
            <Sel
              value={q.competencyKeys[0] ?? ""}
              ro={ro}
              options={[["", "— none —"] as const, ...def.competencies.map((c) => [c.key, c.name] as const)]}
              onChange={(v) => set((x) => void (x.competencyKeys = v ? [v, ...x.competencyKeys.filter((k) => k !== v)] : x.competencyKeys.slice(1)))}
            />
          </F>
          <F label="Max points"><Num value={q.maxPoints} ro={ro} onChange={(v) => set((x) => void (x.maxPoints = v ?? 0))} /></F>
          <F label="Scoring mode"><Sel value={q.mode} ro={ro} options={MODES} onChange={(v) => set((x) => void (x.mode = v))} /></F>
        </div>

        {q.mode === "ai_rubric" || q.mode === "manual" ? (
          <>
            <F label="What a strong answer contains" className="mt-3"><Area value={q.idealAnswer} ro={ro} onChange={(v) => set((x) => void (x.idealAnswer = v))} /></F>
            <F label="Probes (one per line)" className="mt-3">
              <Area value={q.probes.join("\n")} ro={ro} onChange={(v) => set((x) => void (x.probes = v.split("\n")))} />
            </F>
            <Label className="mt-4 mb-2">Criteria</Label>
            <div className="flex flex-col gap-2">
              {q.rubric.map((r, ri) => (
                <div key={r.key} className="grid grid-cols-[110px_80px_minmax(0,1fr)_auto] items-center gap-2">
                  <Sel value={r.tier} ro={ro} options={[["zero", "Zero"], ["partial", "Partial"], ["full", "Full"]] as const} onChange={(v) => set((x) => void (x.rubric[ri].tier = v))} />
                  <Num value={r.points} allowNull ro={ro} invalid={r.points == null} title={r.points == null ? "No points — every reachable outcome needs a score" : undefined} onChange={(v) => set((x) => void (x.rubric[ri].points = v))} />
                  <Txt value={r.descriptor} ro={ro} onChange={(v) => set((x) => void (x.rubric[ri].descriptor = v))} />
                  <Remove ro={ro} onClick={() => set((x) => void x.rubric.splice(ri, 1))} />
                </div>
              ))}
              <Add ro={ro} onClick={() => set((x) => void x.rubric.push({ key: nextKey("r", x.rubric.map((y) => y.key)), descriptor: "", points: 0, tier: "partial", indicators: [] }))}>Add a criterion</Add>
            </div>
          </>
        ) : null}

        {q.mode === "fixed_choice" ? (
          <>
            <div className="mt-4 flex flex-wrap items-center gap-4">
              <Label>Options</Label>
              <Check ro={ro} checked={Boolean(q.cumulative)} label="Several may be picked; points add" onChange={(v) => set((x) => void (x.cumulative = v))} />
              {q.cumulative ? (
                <>
                  <span className="flex items-center gap-1.5 text-[13px] text-muted">Cap <Num className="w-20" value={q.cap ?? null} allowNull ro={ro} onChange={(v) => set((x) => void (x.cap = v))} /></span>
                  <span className="flex items-center gap-1.5 text-[13px] text-muted">Floor <Num className="w-20" value={q.floor ?? null} allowNull ro={ro} onChange={(v) => set((x) => void (x.floor = v))} /></span>
                </>
              ) : null}
            </div>
            <div className="mt-2 flex flex-col gap-2">
              {(q.options ?? []).map((o, oi) => (
                <div key={o.key} className="grid grid-cols-[minmax(0,1fr)_100px_auto] items-center gap-2">
                  <Txt value={o.label} ro={ro} onChange={(v) => set((x) => void (x.options![oi].label = v))} />
                  <Num value={o.points} allowNull ro={ro} invalid={o.points == null} title={o.points == null ? "No score defined (D7) — publication is blocked" : undefined} onChange={(v) => set((x) => void (x.options![oi].points = v))} />
                  <Remove ro={ro} onClick={() => set((x) => void x.options!.splice(oi, 1))} />
                </div>
              ))}
              <Add ro={ro} onClick={() => set((x) => void (x.options = [...(x.options ?? []), { key: nextKey("o", (x.options ?? []).map((y) => y.key)), label: "", points: 0 }]))}>Add an option</Add>
            </div>
          </>
        ) : null}

        {q.mode === "calculated" ? <CalcEditor rule={q.calc} ro={ro} onChange={(c) => set((x) => void (x.calc = c))} /> : null}

        {q.note ? <div className="mt-3 text-[13px] text-muted">{q.note}</div> : null}
        {findings.map((f, i) => (
          <Callout key={i} tone="ai" className="mt-3">◈ Rubric critic · {f.kind.replace(/_/g, " ")} · {f.message}{f.suggestion ? ` Suggestion: ${f.suggestion}` : ""}</Callout>
        ))}
      </Card>
    </div>
  );
}

function CalcEditor({ rule, ro, onChange }: { rule: CalcRule | undefined; ro: boolean; onChange: (c: CalcRule) => void }) {
  const r: CalcRule = rule ?? { kind: "bands", input: { key: "value", label: "Value" }, bands: [{ min: null, max: null, points: 0 }], uncovered: null };
  return (
    <div className="mt-4 flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Label>Rule</Label>
        <Sel
          value={r.kind}
          ro={ro}
          className="w-48"
          options={[["bands", "Bands over one input"], ["formula", "A formula"]] as const}
          onChange={(k) => onChange(k === "formula" ? { kind: "formula", inputs: [{ key: "x", label: "Input" }], expression: "x", cap: null, floor: 0 } : { kind: "bands", input: { key: "value", label: "Value" }, bands: [{ min: null, max: null, points: 0 }], uncovered: null })}
        />
      </div>
      {r.kind === "formula" ? (
        <>
          <F label="Inputs (key = label, one per line)">
            <Area
              value={r.inputs.map((i) => `${i.key} = ${i.label}`).join("\n")}
              ro={ro}
              onChange={(v) => onChange({ ...r, inputs: v.split("\n").map((l) => l.split("=")).filter((p) => p[0]?.trim()).map(([k, ...l]) => ({ key: k.trim(), label: l.join("=").trim() || k.trim() })) })}
            />
          </F>
          <div className="grid grid-cols-[minmax(0,1fr)_100px_100px] gap-3">
            <F label="Expression (+ − × ÷, min, max)"><Txt value={r.expression} ro={ro} onChange={(v) => onChange({ ...r, expression: v })} /></F>
            <F label="Cap"><Num value={r.cap} allowNull ro={ro} onChange={(v) => onChange({ ...r, cap: v })} /></F>
            <F label="Floor"><Num value={r.floor} allowNull ro={ro} onChange={(v) => onChange({ ...r, floor: v })} /></F>
          </div>
          {r.anomaly ? <Callout tone="warn">{r.anomaly}</Callout> : null}
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <F label="Input key"><Txt value={r.input.key} ro={ro} onChange={(v) => onChange({ ...r, input: { ...r.input, key: v } })} /></F>
            <F label="Input label"><Txt value={r.input.label} ro={ro} onChange={(v) => onChange({ ...r, input: { ...r.input, label: v } })} /></F>
          </div>
          <Label>Bands — from (inclusive), to (exclusive), points, and optionally scale to</Label>
          {r.bands.map((b, i) => (
            <div key={i} className="grid grid-cols-[100px_100px_100px_100px_auto] items-center gap-2">
              <Num value={b.min} allowNull ro={ro} onChange={(v) => onChange({ ...r, bands: r.bands.map((x, j) => (j === i ? { ...x, min: v } : x)) })} />
              <Num value={b.max} allowNull ro={ro} onChange={(v) => onChange({ ...r, bands: r.bands.map((x, j) => (j === i ? { ...x, max: v } : x)) })} />
              <Num value={b.points} ro={ro} onChange={(v) => onChange({ ...r, bands: r.bands.map((x, j) => (j === i ? { ...x, points: v ?? 0 } : x)) })} />
              <Num value={b.to ?? null} allowNull ro={ro} onChange={(v) => onChange({ ...r, bands: r.bands.map((x, j) => (j === i ? { ...x, to: v ?? undefined } : x)) })} />
              <Remove ro={ro} onClick={() => onChange({ ...r, bands: r.bands.filter((_, j) => j !== i) })} />
            </div>
          ))}
          <Add ro={ro} onClick={() => onChange({ ...r, bands: [...r.bands, { min: null, max: null, points: 0 }] })}>Add a band</Add>
          <F label="An input no band covers scores" className="w-64"><Num value={r.uncovered} allowNull ro={ro} invalid={r.uncovered == null} onChange={(v) => onChange({ ...r, uncovered: v })} /></F>
          {r.anomaly ? <Callout tone="warn">{r.anomaly}</Callout> : null}
        </>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- thresholds */

export function Thresholds({ def, mut, ro }: SecProps) {
  const scored = def.stages.map((s, si) => ({ s, si })).filter(({ s }) => isScoredType(s.type));
  return (
    <div className="flex flex-col gap-3">
      <Callout>One threshold per stage governs the status, the message and the progression. Scores are on the normalised 0–100 scale: (points earned ÷ maximum) × 100. Grace is shown beside the rubric score, never merged into it, and needs a reason.</Callout>
      <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs font-medium tracking-[0.04em] text-muted uppercase">
              {["Stage", "Max", "Pass mark", "Auto-reject floor", "Strong signal", "Grace ±"].map((h) => (
                <th key={h} className="border-b border-divider px-3 py-2.5 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {scored.map(({ s, si }) => (
              <tr key={s.key} className="border-b border-divider">
                <td className="px-3 py-2 font-medium text-heading">{s.name}</td>
                <td className="px-3 tabular-nums">{s.questions.reduce((n, q) => n + q.maxPoints, 0)}</td>
                <td className="w-28 px-3 py-2"><Num value={s.passThreshold} ro={ro} onChange={(v) => mut((d) => void (d.stages[si].passThreshold = v ?? 0))} /></td>
                <td className="w-32 px-3 py-2"><Num value={s.autoRejectFloor} allowNull ro={ro} onChange={(v) => mut((d) => void (d.stages[si].autoRejectFloor = v))} /></td>
                <td className="w-32 px-3 py-2"><Num value={s.strongSignal} allowNull ro={ro} onChange={(v) => mut((d) => void (d.stages[si].strongSignal = v))} /></td>
                <td className="w-24 px-3 py-2"><Num value={s.graceRange} ro={ro} onChange={(v) => mut((d) => void (d.stages[si].graceRange = Math.min(10, Math.max(0, v ?? 0))))} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="m-0 text-[13px] text-muted">A score below the floor PROPOSES a rejection for a named person to confirm — the system never rejects anybody on its own.</p>
    </div>
  );
}

/* ------------------------------------------------------------- briefing */

export function Briefing({ def, mut, ro }: SecProps) {
  const stages = def.stages.map((s, si) => ({ s, si })).filter(({ s }) => s.type === "briefing");
  if (!stages.length) return <Callout>No briefing stage. Add one under Stages if candidates must hear and accept terms — pay, travel, targets — before an offer.</Callout>;
  return (
    <div className="flex flex-col gap-6">
      {stages.map(({ s, si }) => (
        <div key={s.key} className="flex flex-col gap-3">
          <div className="text-[15px] font-semibold text-heading">{s.name}</div>
          {(s.briefing ?? []).map((p, pi) => {
            const set = (fn: (p: BriefingPoint) => void) => mut((d) => fn(d.stages[si].briefing![pi]));
            return (
              <Card key={p.key}>
                <ElementHead title={p.title || "Untitled point"} ai={p.ai} approved={p.approved} ro={ro} onApprove={() => set((x) => void (x.approved = true))} actions={<Remove ro={ro} onClick={() => mut((d) => void d.stages[si].briefing!.splice(pi, 1))} />} />
                <div className="mt-3 grid grid-cols-[minmax(0,1fr)_240px] gap-3">
                  <F label="Title"><Txt value={p.title} ro={ro} onChange={(v) => set((x) => void (x.title = v))} /></F>
                  <F label="Response">
                    <Sel value={p.responseType} ro={ro} options={[["told_only", "Told only"], ["agree_disagree", "Agree / disagree"], ["agree_disagree_willtry", "Agree / disagree / will try"]] as const} onChange={(v) => set((x) => void (x.responseType = v))} />
                  </F>
                </div>
                <F label="What is said" className="mt-3"><Area value={p.body} ro={ro} onChange={(v) => set((x) => void (x.body = v))} /></F>
                <div className="mt-3 flex gap-5">
                  <Check ro={ro} checked={p.blocking} label="Blocking — a disagreement halts progression" onChange={(v) => set((x) => void (x.blocking = v))} />
                  <Check ro={ro} checked={p.commentOnDisagree} label="Ask for a comment on disagreement" onChange={(v) => set((x) => void (x.commentOnDisagree = v))} />
                </div>
                {p.blocking && p.responseType === "told_only" ? <div className="mt-2 text-[13px] text-danger">A blocking point must ask for agreement.</div> : null}
              </Card>
            );
          })}
          <Add ro={ro} onClick={() => mut((d) => void (d.stages[si].briefing = [...(d.stages[si].briefing ?? []), { key: nextKey("p", (d.stages[si].briefing ?? []).map((x) => x.key)), title: "", body: "", responseType: "agree_disagree", blocking: false, commentOnDisagree: true, approved: false, ai: false }]))}>Add a briefing point</Add>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ documents */

const DOC_KINDS = [["aadhaar", "Aadhaar"], ["pan", "PAN"], ["bank", "Bank"], ["photo", "Photograph"], ["certificate", "Certificate"], ["payslip", "Payslip"], ["address", "Address proof"], ["other", "Other"]] as const;

export function Documents({ def, mut, ro }: SecProps) {
  return (
    <div className="flex flex-col gap-3">
      {def.documents.map((d0, i) => {
        const set = (fn: (x: DocumentRequirement) => void) => mut((d) => fn(d.documents[i]));
        return (
          <Card key={d0.key}>
            <ElementHead title={d0.label || "Untitled document"} ai={d0.ai} approved={d0.approved} ro={ro} onApprove={() => set((x) => void (x.approved = true))} actions={<Remove ro={ro} onClick={() => mut((d) => void d.documents.splice(i, 1))} />} />
            <div className="mt-3 grid grid-cols-[minmax(0,1fr)_150px_160px_110px] gap-3">
              <F label="Label"><Txt value={d0.label} ro={ro} onChange={(v) => set((x) => void (x.label = v))} /></F>
              <F label="Kind"><Sel value={d0.kind} ro={ro} options={DOC_KINDS} onChange={(v) => set((x) => void (x.kind = v))} /></F>
              <F label="PII class"><Sel value={d0.pii} ro={ro} options={[["none", "None"], ["personal", "Personal"], ["sensitive", "Sensitive"], ["restricted", "Restricted"]] as const} onChange={(v) => set((x) => void (x.pii = v))} /></F>
              <F label="Keep (months)"><Num value={d0.retentionMonths} ro={ro} onChange={(v) => set((x) => void (x.retentionMonths = v ?? 0))} /></F>
            </div>
            <div className="mt-3 flex gap-5">
              <Check ro={ro} checked={d0.mandatory} label="Mandatory" onChange={(v) => set((x) => void (x.mandatory = v))} />
              <Check ro={ro} checked={d0.verify} label="Must be verified" onChange={(v) => set((x) => void (x.verify = v))} />
            </div>
          </Card>
        );
      })}
      <Add ro={ro} onClick={() => mut((d) => void d.documents.push({ key: nextKey("d", d.documents.map((x) => x.key)), label: "", kind: "other", mandatory: true, verify: true, retentionMonths: 24, pii: "personal", approved: false, ai: false }))}>Add a document</Add>
    </div>
  );
}

/* ---------------------------------------------------------------- offer */

export function OfferSec({ def, mut, ro }: SecProps) {
  const o = def.offer;
  return (
    <div className="flex flex-col gap-3">
      <Card>
        <ElementHead title="Offer model · INR" ai={o.ai} approved={o.approved} ro={ro} onApprove={() => mut((d) => void (d.offer.approved = true))} />
        <Label className="mt-4 mb-2">Grades — monthly basic, ₹</Label>
        {o.grades.map((g, i) => (
          <div key={g.key} className="mb-2 grid grid-cols-[80px_minmax(0,1fr)_130px_130px_auto] items-center gap-2">
            <Txt value={g.key} ro={ro} onChange={(v) => mut((d) => void (d.offer.grades[i].key = v))} />
            <Txt value={g.label} ro={ro} onChange={(v) => mut((d) => void (d.offer.grades[i].label = v))} />
            <Num value={g.basicMinPaise / RUPEE} ro={ro} step={500} onChange={(v) => mut((d) => void (d.offer.grades[i].basicMinPaise = Math.round((v ?? 0) * RUPEE)))} />
            <Num value={g.basicMaxPaise / RUPEE} ro={ro} step={500} invalid={g.basicMinPaise > g.basicMaxPaise} onChange={(v) => mut((d) => void (d.offer.grades[i].basicMaxPaise = Math.round((v ?? 0) * RUPEE)))} />
            <Remove ro={ro} onClick={() => mut((d) => void d.offer.grades.splice(i, 1))} />
          </div>
        ))}
        <Add ro={ro} onClick={() => mut((d) => void d.offer.grades.push({ key: `G${d.offer.grades.length + 1}`, label: "", basicMinPaise: 0, basicMaxPaise: 0 }))}>Add a grade</Add>
        <F label="Incentive" className="mt-4"><Area value={o.incentive} ro={ro} onChange={(v) => mut((d) => void (d.offer.incentive = v))} /></F>
        <Label className="mt-4 mb-2">Growth path — one definition, read by the briefing and the offer letter</Label>
        {o.growth.map((g, i) => (
          <div key={i} className="mb-2 grid grid-cols-[90px_90px_minmax(0,1fr)_150px_110px_auto] items-center gap-2">
            <Sel value={g.fromGrade} ro={ro} options={o.grades.map((x) => [x.key, x.key] as const)} onChange={(v) => mut((d) => void (d.offer.growth[i].fromGrade = v))} />
            <Sel value={g.toGrade} ro={ro} options={o.grades.map((x) => [x.key, x.key] as const)} onChange={(v) => mut((d) => void (d.offer.growth[i].toGrade = v))} />
            <Txt value={g.criterion} ro={ro} placeholder="Cumulative sales of ₹10,00,000" onChange={(v) => mut((d) => void (d.offer.growth[i].criterion = v))} />
            <Sel value={g.incrementType} ro={ro} options={[["percentage", "Percent"], ["fixed_amount", "Fixed ₹"]] as const} onChange={(v) => mut((d) => void (d.offer.growth[i].incrementType = v))} />
            <Num
              value={g.incrementType === "percentage" ? g.value : g.value / RUPEE}
              ro={ro}
              onChange={(v) => mut((d) => void (d.offer.growth[i].value = g.incrementType === "percentage" ? (v ?? 0) : Math.round((v ?? 0) * RUPEE)))}
            />
            <Remove ro={ro} onClick={() => mut((d) => void d.offer.growth.splice(i, 1))} />
          </div>
        ))}
        <Add ro={ro || o.grades.length < 2} onClick={() => mut((d) => void d.offer.growth.push({ fromGrade: o.grades[0].key, toGrade: o.grades[1].key, criterion: "", incrementType: "percentage", value: 10 }))}>Add a promotion step</Add>
      </Card>
    </div>
  );
}

/* ----------------------------------------------------------- onboarding */

export function Onboarding({ def, mut, ro }: SecProps) {
  const o = def.onboarding;
  return (
    <Card>
      <ElementHead title="Onboarding plan" ai={o.ai} approved={o.approved} ro={ro} onApprove={() => mut((d) => void (d.onboarding.approved = true))} />
      <Label className="mt-4 mb-2">Work kit</Label>
      {o.assets.map((a, i) => (
        <div key={a.key} className="mb-2 grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3">
          <Txt value={a.label} ro={ro} onChange={(v) => mut((d) => void (d.onboarding.assets[i].label = v))} />
          <Check ro={ro} checked={a.serial} label="Has a serial" onChange={(v) => mut((d) => void (d.onboarding.assets[i].serial = v))} />
          <Remove ro={ro} onClick={() => mut((d) => void d.onboarding.assets.splice(i, 1))} />
        </div>
      ))}
      <Add ro={ro} onClick={() => mut((d) => void d.onboarding.assets.push({ key: nextKey("a", d.onboarding.assets.map((x) => x.key)), label: "", serial: false }))}>Add an item</Add>

      <Label className="mt-5 mb-2">Training modules — complete only when every topic is ticked</Label>
      {o.modules.map((m, i) => (
        <div key={m.key} className="mb-3 rounded-[4px] border border-divider p-3">
          <div className="flex items-center gap-2">
            <Txt value={m.name} ro={ro} onChange={(v) => mut((d) => void (d.onboarding.modules[i].name = v))} />
            <Remove ro={ro} onClick={() => mut((d) => void d.onboarding.modules.splice(i, 1))} />
          </div>
          <div className="mt-2"><Area rows={Math.max(2, m.topics.length)} value={m.topics.map((t) => t.title).join("\n")} ro={ro} onChange={(v) => mut((d) => void (d.onboarding.modules[i].topics = v.split("\n").map((title, j) => ({ key: m.topics[j]?.key ?? `t${j + 1}`, title }))))} /></div>
        </div>
      ))}
      <Add ro={ro} onClick={() => mut((d) => void d.onboarding.modules.push({ key: nextKey("m", d.onboarding.modules.map((x) => x.key)), name: "New module", topics: [] }))}>Add a module</Add>

      <Label className="mt-5 mb-2">System setup — one step per line</Label>
      {o.setup.map((g, i) => (
        <div key={g.key} className="mb-3 rounded-[4px] border border-divider p-3">
          <div className="flex items-center gap-2">
            <Txt value={g.system} ro={ro} onChange={(v) => mut((d) => void (d.onboarding.setup[i].system = v))} />
            <Remove ro={ro} onClick={() => mut((d) => void d.onboarding.setup.splice(i, 1))} />
          </div>
          <div className="mt-2"><Area rows={Math.max(2, g.steps.length)} value={g.steps.map((s) => s.label).join("\n")} ro={ro} onChange={(v) => mut((d) => void (d.onboarding.setup[i].steps = v.split("\n").map((label, j) => ({ key: g.steps[j]?.key ?? `s${j + 1}`, label }))))} /></div>
        </div>
      ))}
      <Add ro={ro} onClick={() => mut((d) => void d.onboarding.setup.push({ key: nextKey("g", d.onboarding.setup.map((x) => x.key)), system: "", steps: [] }))}>Add a system</Add>
    </Card>
  );
}

/* --------------------------------------------------------- provisioning */

export function Provisioning({ def, mut, ro }: SecProps) {
  const p = def.provisioning;
  const grantable = APPS.filter((a) => a.id !== "admin" && a.id !== "founder" && a.id !== "hire" && a.built);
  return (
    <Card>
      <ElementHead title="What the hire receives" ai={p.ai} approved={p.approved} ro={ro} onApprove={() => mut((d) => void (d.provisioning.approved = true))} />
      <p className="mt-2 mb-3 text-[13px] text-muted">Provisioning the MahekOne account is the last act of the pipeline and what makes a candidate hired.</p>
      <Label className="mb-2">Apps granted</Label>
      <div className="grid grid-cols-2 gap-2">
        {grantable.map((a) => (
          <Check
            key={a.id}
            ro={ro}
            checked={p.apps.includes(a.id)}
            label={<span>{a.name} <span className="text-muted">— {a.description.slice(0, 60)}</span></span>}
            onChange={(v) => mut((d) => void (d.provisioning.apps = v ? [...d.provisioning.apps, a.id] : d.provisioning.apps.filter((x) => x !== a.id)))}
          />
        ))}
      </div>
      <div className="mt-4 grid grid-cols-[180px_minmax(0,1fr)] gap-3">
        <F label="Level"><Sel value={p.level} ro={ro} options={[["associate", "Associate"], ["manager", "Manager"]] as const} onChange={(v) => mut((d) => void (d.provisioning.level = v))} /></F>
        <F label="In-app role"><Txt value={p.roleLabel} ro={ro} placeholder="Field Sales Executive" onChange={(v) => mut((d) => void (d.provisioning.roleLabel = v))} /></F>
      </div>
      <div className="mt-3"><Check ro={ro} checked={p.device} label="Bind a handset (MBOS)" onChange={(v) => mut((d) => void (d.provisioning.device = v))} /></div>
    </Card>
  );
}

/* ------------------------------------------------------------- fairness */

const MASK_LABEL: Record<Maskable, string> = { name: "Name", gender_markers: "Gender markers", age: "Age", photo: "Photograph", location: "Location", institution: "Institution" };

export function Fairness({ def, mut, ro }: SecProps) {
  const f = def.fairness;
  return (
    <Card>
      <ElementHead title="Fairness configuration" ai={f.ai} approved={f.approved} ro={ro} onApprove={() => mut((d) => void (d.fairness.approved = true))} />
      <p className="mt-2 mb-3 text-[13px] text-muted">What is hidden from evaluators and from the model while scoring. Not a blanket default: where an attribute is a genuine job requirement, leave it unmasked and say why.</p>
      <div className="flex flex-col divide-y divide-divider rounded-[4px] border border-divider">
        {MASKABLE.map((a) => {
          const masked = f.masked.includes(a);
          return (
            <div key={a} className="px-3 py-2.5">
              <div className="flex items-center gap-3">
                <span className="flex-1 text-sm text-heading">{MASK_LABEL[a]}</span>
                <Pill tone={masked ? "neutral" : "warn"}>{masked ? "Masked" : "Visible"}</Pill>
                <Check ro={ro} checked={masked} label="Mask" onChange={(v) => mut((d) => void (d.fairness.masked = v ? [...d.fairness.masked, a] : d.fairness.masked.filter((x) => x !== a)))} />
              </div>
              {!masked ? (
                <div className="mt-2">
                  <Txt value={f.unmaskedJustification[a] ?? ""} ro={ro} placeholder="Why this is a job requirement — kept on the record" onChange={(v) => mut((d) => void (d.fairness.unmaskedJustification = { ...d.fairness.unmaskedJustification, [a]: v }))} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="mt-4 flex flex-wrap gap-5">
        {(["gender", "age", "location"] as const).map((k) => (
          <Check key={k} ro={ro} checked={f.monitor[k]} label={`Monitor adverse impact by ${k}`} onChange={(v) => mut((d) => void (d.fairness.monitor = { ...d.fairness.monitor, [k]: v }))} />
        ))}
      </div>
      <div className="mt-4 grid grid-cols-[200px_minmax(0,1fr)] items-end gap-3">
        <F label="Adverse impact threshold"><Num value={f.adverseImpactThreshold} step={0.05} ro={ro} onChange={(v) => mut((d) => void (d.fairness.adverseImpactThreshold = v ?? 0.8))} /></F>
        <Check ro={ro} checked={f.redactBeforeTransmission} label="Redact personal numbers before any model call" onChange={(v) => mut((d) => void (d.fairness.redactBeforeTransmission = v))} />
      </div>
      <p className="mt-4 mb-0 text-[13px] text-muted">Always blocked, whatever is set here: inferences about personality, emotion, appearance, health, religion, caste, marital status and family planning.</p>
    </Card>
  );
}
