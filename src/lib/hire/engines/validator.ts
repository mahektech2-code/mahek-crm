import type { BlueprintDefinition, Question, Stage } from "../blueprint-types";
import { MASKABLE, isScored } from "../blueprint-types";
import { formulaIdentifiers } from "./scoring";

/* ---------------------------------------------------------------------------
 * THE PUBLICATION VALIDATOR (design brief §7.7, spec §3.4, §3.6). Pure.
 *
 * Errors block publishing; warnings do not. Every rule here exists because a
 * blueprint that broke it would mis-score a real person:
 *  - a reachable answer with no defined score penalises somebody for a gap in
 *    the rules rather than for what they said (D7),
 *  - an unapproved AI element is something no person has read,
 *  - an offer with no decision gate before it is a hire nobody decided.
 * ------------------------------------------------------------------------- */

export type Issue = { level: "error" | "warning"; section: string; where: string; message: string };

/** Words that ask about, or score, a protected attribute. Questions may not. */
const PROTECTED = /\b(married|marital|wife|husband|pregnan|children|kids|religio|caste|age\b|how old|date of birth|disabilit|health|hindu|muslim|christian|jain|sikh)\b/i;
/** Trait language — a rubric scores what was said and done, not who somebody is. */
const TRAIT = /\b(personality|confident|confidence|charisma|attitude|energetic|culture fit|smart|presentable|good looking|appearance|accent)\b/i;

export function validateBlueprint(def: BlueprintDefinition): Issue[] {
  const out: Issue[] = [];
  const err = (section: string, where: string, message: string) => out.push({ level: "error", section, where, message });
  const warn = (section: string, where: string, message: string) => out.push({ level: "warning", section, where, message });

  /* Competencies */
  const compKeys = new Set(def.competencies.map((c) => c.key));
  if (def.competencies.length < 3) err("competencies", "Competency model", "A role needs at least three competencies.");
  const wsum = def.competencies.reduce((n, c) => n + c.weight, 0);
  if (Math.abs(wsum - 1) > 0.001) err("competencies", "Competency weights", `Weights total ${(wsum * 100).toFixed(0)}% — they must total 100%.`);
  for (const c of def.competencies) {
    if (!c.definition.trim()) err("competencies", c.name, "Has no definition.");
    if (!c.anchors.low.trim() || !c.anchors.mid.trim() || !c.anchors.high.trim()) warn("competencies", c.name, "Low, mid and high anchors should all be described.");
  }
  for (const c of def.competencies) if (!def.stages.some((s) => s.questions.some((q) => q.competencyKeys.includes(c.key)))) warn("competencies", c.name, "No question tests this competency.");

  /* Stages */
  if (!def.stages.length) err("stages", "Stage pipeline", "There are no stages.");
  const keys = new Set<string>();
  for (const s of def.stages) {
    if (keys.has(s.key)) err("stages", s.name, "Two stages share one key.");
    keys.add(s.key);
    if (s.graceRange > 10 || s.graceRange < 0) err("thresholds", s.name, "Grace range is between 0 and 10.");
    if (isScored(s)) stageChecks(s, compKeys, err, warn);
    if (s.type === "briefing") {
      if (!s.briefing?.length) err("briefing", s.name, "A briefing stage needs at least one point.");
      for (const p of s.briefing ?? []) {
        if (p.blocking && p.responseType === "told_only") err("briefing", p.title, "A blocking point must ask for agreement — told-only cannot be disagreed with.");
        if (!p.approved) err("briefing", p.title, "Not approved yet.");
      }
    }
    if (!s.approved) err("stages", s.name, "Not approved yet.");
  }
  const gateAt = def.stages.findIndex((s) => s.type === "decision_gate");
  const offerAt = def.stages.findIndex((s) => s.type === "document_collection");
  if (gateAt < 0) err("stages", "Decision gate", "There must be at least one decision gate before an offer.");
  else if (offerAt >= 0 && gateAt > offerAt) err("stages", "Decision gate", "The decision gate has to come before documents and offer.");
  if (def.stages[0] && def.stages[0].type !== "application") warn("stages", def.stages[0].name, "Pipelines usually start with an Application stage.");
  if (!def.stages.some((s) => s.type === "system_setup")) warn("stages", "System setup", "No system setup stage — provisioning will run straight after the checklist.");

  /* Documents */
  for (const d of def.documents) if (!d.approved) err("documents", d.label, "Not approved yet.");
  for (const d of def.documents) if ((d.kind === "aadhaar" || d.kind === "pan" || d.kind === "bank") && d.pii === "none") err("documents", d.label, "Identity and bank documents must be classed sensitive or restricted.");

  /* Offer */
  const o = def.offer;
  if (!o.approved) err("offer", "Offer model", "Not approved yet.");
  if (!o.grades.length) err("offer", "Grades", "There are no grades.");
  for (const g of o.grades) if (g.basicMinPaise > g.basicMaxPaise) err("offer", g.label, "Minimum basic is above the maximum.");
  const gk = new Set(o.grades.map((g) => g.key));
  for (const st of o.growth) if (!gk.has(st.fromGrade) || !gk.has(st.toGrade)) err("offer", "Growth path", `A step names a grade that does not exist (${st.fromGrade} → ${st.toGrade}).`);
  const types = new Set(o.growth.map((g) => g.incrementType));
  if (types.size > 1) warn("offer", "Growth path", "The ladder mixes percentage and fixed increments — make sure that is intended, the briefing and the letter both say it.");

  if (!def.onboarding.approved) err("onboarding", "Onboarding plan", "Not approved yet.");
  for (const m of def.onboarding.modules) if (!m.topics.length) err("onboarding", m.name, "A training module needs at least one topic.");
  if (!def.provisioning.approved) err("provisioning", "Provisioning", "Not approved yet.");
  if (!def.provisioning.apps.length) err("provisioning", "Provisioning", "No MahekOne app is granted on hire.");

  /* Fairness */
  const f = def.fairness;
  if (!f.approved) err("fairness", "Fairness configuration", "Not approved yet.");
  if (f.adverseImpactThreshold <= 0 || f.adverseImpactThreshold > 1) err("fairness", "Adverse impact", "The threshold is a ratio between 0 and 1 (four-fifths is 0.8).");
  for (const a of MASKABLE) if (!f.masked.includes(a) && !f.unmaskedJustification[a]?.trim()) warn("fairness", a.replace("_", " "), "Not masked during evaluation, and no reason is recorded.");

  for (const q of def.openQuestions) warn("identity", "Open question for the business", q);
  return out;
}

function stageChecks(
  s: Stage,
  compKeys: Set<string>,
  err: (section: string, where: string, m: string) => void,
  warn: (section: string, where: string, m: string) => void,
) {
  if (!s.questions.length) err("questions", s.name, "A scored stage needs at least one question.");
  const sum = s.questions.reduce((n, q) => n + q.maxPoints, 0);
  if (s.maxPoints !== sum) err("thresholds", s.name, `Maximum is ${s.maxPoints} but its questions total ${sum}.`);
  if (s.passThreshold <= 0 || s.passThreshold > 100) err("thresholds", s.name, "The pass mark is on the 0–100 normalised scale.");
  if (s.autoRejectFloor != null && s.autoRejectFloor >= s.passThreshold) err("thresholds", s.name, "The auto-reject floor must sit below the pass mark.");
  for (const q of s.questions) questionChecks(s, q, compKeys, err, warn);
}

function questionChecks(
  s: Stage,
  q: Question,
  compKeys: Set<string>,
  err: (section: string, where: string, m: string) => void,
  warn: (section: string, where: string, m: string) => void,
) {
  const where = `${s.name} · ${q.text.slice(0, 60)}`;
  if (!q.approved) err("questions", where, "Not approved yet.");
  if (!q.competencyKeys.length) err("questions", where, "Maps to no competency.");
  for (const c of q.competencyKeys) if (!compKeys.has(c)) err("questions", where, `Maps to a competency that does not exist (${c}).`);
  if (q.maxPoints <= 0) err("questions", where, "Maximum points must be above zero.");
  if (PROTECTED.test(q.text)) err("questions", where, "Asks about, or implies, a protected attribute.");
  if (q.mode === "ai_rubric") {
    if (!q.rubric.length) err("rubrics", where, "An AI-scored question needs rubric criteria.");
    for (const r of q.rubric) {
      if (r.points == null) err("rubrics", where, `“${r.descriptor}” has no points — every reachable outcome needs a score.`);
      if (TRAIT.test(r.descriptor)) warn("rubrics", where, `“${r.descriptor}” scores a trait rather than something observable.`);
    }
    if (!q.idealAnswer.trim()) warn("rubrics", where, "No ideal-answer anchor.");
  }
  if (q.mode === "fixed_choice") {
    if (!q.options?.length) err("questions", where, "A fixed-choice question needs options.");
    for (const o of q.options ?? []) if (o.points == null) err("rubrics", where, `“${o.label}” has no score defined (D7).`);
    const best = q.cumulative ? (q.cap ?? (q.options ?? []).reduce((n, o) => n + Math.max(0, o.points ?? 0), 0)) : Math.max(0, ...(q.options ?? []).map((o) => o.points ?? 0));
    if (best > q.maxPoints) err("rubrics", where, `Can score ${best}, above its maximum of ${q.maxPoints}.`);
  }
  if (q.mode === "calculated") {
    const c = q.calc;
    if (!c) err("questions", where, "A calculated question needs a rule.");
    else if (c.kind === "formula") {
      const known = new Set(c.inputs.map((i) => i.key));
      for (const id of formulaIdentifiers(c.expression)) if (!known.has(id)) err("rubrics", where, `The formula names “${id}”, which is not one of its inputs.`);
      if (c.cap == null) warn("rubrics", where, `Uncapped: it can score above ${q.maxPoints}.`);
      if (c.anomaly) warn("rubrics", where, c.anomaly);
    } else {
      if (c.uncovered == null && !bandsCoverEverything(c.bands)) err("rubrics", where, "Some inputs fall in no band and have no defined score (D7).");
      if (c.anomaly) warn("rubrics", where, c.anomaly);
    }
  }
  if (q.note && /D1[03]|open question/i.test(q.note)) warn("rubrics", where, q.note);
}

function bandsCoverEverything(bands: { min: number | null; max: number | null }[]): boolean {
  if (!bands.length) return false;
  const sorted = [...bands].sort((a, b) => (a.min ?? -Infinity) - (b.min ?? -Infinity));
  if (sorted[0].min != null) return false;
  for (let i = 1; i < sorted.length; i++) if (sorted[i].min !== sorted[i - 1].max) return false;
  return sorted[sorted.length - 1].max == null;
}

export const blocking = (issues: Issue[]) => issues.filter((i) => i.level === "error");
