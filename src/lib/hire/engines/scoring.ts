import type { BlueprintDefinition, CalcRule, Question, Stage } from "../blueprint-types";

/* ---------------------------------------------------------------------------
 * THE SCORING ENGINE (spec Part B). Pure — no I/O, no clock.
 *
 * The formula is the AppSheet app's and it does not change:
 *
 *   normalised = (points earned ÷ max points) × 100
 *   final      = normalised + grace
 *   outcome    = final ≥ pass threshold ? pass : fail
 *
 * It is why an 80-point Level 1 and a 130-point Level 3 compare on one scale.
 * Grace is carried beside the rubric score and never merged into it, so a
 * screen can always show both (spec §3.5).
 * ------------------------------------------------------------------------- */

export type Scored = { points: number | null; why: string };

/** A fixed-choice answer. Cumulative questions add, then cap and floor. */
export function scoreFixed(q: Question, selected: string[]): Scored {
  const opts = q.options ?? [];
  const picked = opts.filter((o) => selected.includes(o.key));
  if (!picked.length) return { points: null, why: "Nothing selected." };
  if (!q.cumulative) {
    const o = picked[0];
    if (o.points == null) return { points: null, why: `“${o.label}” has no score defined in this blueprint.` };
    return { points: o.points, why: `Selected: ${o.label} · ${o.points}` };
  }
  const undefinedOne = picked.find((o) => o.points == null);
  if (undefinedOne) return { points: null, why: `“${undefinedOne.label}” has no score defined in this blueprint.` };
  let total = picked.reduce((n, o) => n + (o.points ?? 0), 0);
  const parts = picked.map((o) => `${o.label} ${signed(o.points ?? 0)}`).join(", ");
  let note = "";
  if (q.cap != null && total > q.cap) {
    note = ` · capped at ${q.cap}`;
    total = q.cap;
  }
  if (q.floor != null && total < q.floor) {
    note = ` · floored at ${q.floor}`;
    total = q.floor;
  }
  return { points: total, why: `${parts}${note}` };
}

const signed = (n: number) => (n < 0 ? `−${Math.abs(n)}` : `+${n}`);

/* ------------------------------------------------------- expression reader */

type Tok = { t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      out.push({ t: "num", v: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      out.push({ t: "id", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if ("+-*/(),".includes(c)) {
      out.push({ t: "op", v: c });
      i++;
      continue;
    }
    throw new Error(`Unexpected “${c}” in the formula.`);
  }
  return out;
}

/**
 * Evaluates an arithmetic expression over named inputs: + − × ÷, brackets,
 * min(a, b) and max(a, b). Nothing else — a formula in a blueprint is data
 * somebody typed, and it must never be able to run code.
 */
export function evaluate(expression: string, vars: Record<string, number>): number {
  const toks = tokenize(expression);
  let p = 0;
  const peek = () => toks[p];
  const take = () => toks[p++];
  const expect = (v: string) => {
    const t = take();
    if (!t || t.t !== "op" || t.v !== v) throw new Error(`Expected “${v}” in the formula.`);
  };
  function primary(): number {
    const t = take();
    if (!t) throw new Error("The formula ends early.");
    if (t.t === "num") return t.v;
    if (t.t === "op" && t.v === "(") {
      const v = expr();
      expect(")");
      return v;
    }
    if (t.t === "op" && t.v === "-") return -primary();
    if (t.t === "id") {
      const n = peek();
      if (n && n.t === "op" && n.v === "(") {
        take();
        const args = [expr()];
        while (peek() && peek().t === "op" && peek().v === ",") {
          take();
          args.push(expr());
        }
        expect(")");
        if (t.v === "min") return Math.min(...args);
        if (t.v === "max") return Math.max(...args);
        throw new Error(`Unknown function “${t.v}”.`);
      }
      if (!(t.v in vars)) throw new Error(`“${t.v}” is not an input of this question.`);
      return vars[t.v];
    }
    throw new Error("The formula could not be read.");
  }
  function term(): number {
    let v = primary();
    while (peek() && peek().t === "op" && (peek().v === "*" || peek().v === "/")) {
      const op = take().v;
      const r = primary();
      v = op === "*" ? v * r : v / r;
    }
    return v;
  }
  function expr(): number {
    let v = term();
    while (peek() && peek().t === "op" && (peek().v === "+" || peek().v === "-")) {
      const op = take().v;
      const r = term();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  const v = expr();
  if (p < toks.length) throw new Error("The formula has something left over at the end.");
  return v;
}

/** The identifiers a formula names — for the validator to check against inputs. */
export function formulaIdentifiers(expression: string): string[] {
  try {
    return tokenize(expression)
      .filter((t, i, all) => t.t === "id" && !(all[i + 1]?.t === "op" && all[i + 1]?.v === "("))
      .map((t) => String(t.v));
  } catch {
    return [];
  }
}

/** A calculated answer. Returns null points where the rule has no defined score. */
export function scoreCalc(rule: CalcRule, inputs: Record<string, number>): Scored & { raw: number | null } {
  if (rule.kind === "formula") {
    for (const i of rule.inputs) if (!Number.isFinite(inputs[i.key])) return { points: null, raw: null, why: `${i.label} is missing.` };
    let raw: number;
    try {
      raw = evaluate(rule.expression, inputs);
    } catch (e) {
      return { points: null, raw: null, why: e instanceof Error ? e.message : "The formula could not be read." };
    }
    let pts = raw;
    let note = "";
    if (rule.cap != null && pts > rule.cap) {
      pts = rule.cap;
      note = ` · capped at ${rule.cap}`;
    }
    if (rule.floor != null && pts < rule.floor) {
      pts = rule.floor;
      note = ` · floored at ${rule.floor}`;
    }
    pts = round1(pts);
    return { points: pts, raw: round1(raw), why: `${rule.expression} = ${round1(raw)}${note}` };
  }
  const v = inputs[rule.input.key];
  if (!Number.isFinite(v)) return { points: null, raw: null, why: `${rule.input.label} is missing.` };
  const band = rule.bands.find((b) => (b.min == null || v >= b.min) && (b.max == null || v < b.max));
  if (!band) {
    if (rule.uncovered == null) return { points: null, raw: v, why: `${v} falls in no band, and this blueprint defines no score for it.` };
    return { points: rule.uncovered, raw: v, why: `${v} falls in no band · scores ${rule.uncovered}` };
  }
  if (band.to != null && band.min != null && band.max != null && band.max > band.min) {
    const pts = round1(band.points + ((v - band.min) / (band.max - band.min)) * (band.to - band.points));
    return { points: pts, raw: v, why: `${v} in ${band.min}–${band.max}, scaled ${band.points}→${band.to} · ${pts}` };
  }
  return { points: band.points, raw: v, why: `${v} in ${bandLabel(band)} · ${band.points}` };
}

const bandLabel = (b: { min: number | null; max: number | null }) =>
  b.min == null ? `below ${b.max}` : b.max == null ? `${b.min} and above` : `${b.min}–${b.max}`;

export const round1 = (n: number) => Math.round(n * 10) / 10;

/* ------------------------------------------------------------- stage score */

export type StageResult = {
  earned: number;
  max: number;
  /** (earned ÷ max) × 100, to one decimal. */
  normalised: number;
  grace: number;
  final: number;
  outcome: "pass" | "fail" | "pending";
  /** Questions still without a confirmed score. */
  missing: string[];
  /** Grace changed the outcome — flagged in analytics and on the record (spec §3.5). */
  graceFlipped: boolean;
  belowFloor: boolean;
};

export function stageResult(stage: Stage, points: Record<string, number | null | undefined>, grace = 0): StageResult {
  const max = stage.maxPoints || stage.questions.reduce((n, q) => n + q.maxPoints, 0);
  const missing = stage.questions.filter((q) => q.mandatory !== false && points[q.key] == null).map((q) => q.key);
  const earned = stage.questions.reduce((n, q) => n + (points[q.key] ?? 0), 0);
  const normalised = max ? round1((earned / max) * 100) : 0;
  const final = round1(normalised + grace);
  if (missing.length) {
    return { earned, max, normalised, grace, final, outcome: "pending", missing, graceFlipped: false, belowFloor: false };
  }
  const outcome = final >= stage.passThreshold ? "pass" : "fail";
  const without = normalised >= stage.passThreshold ? "pass" : "fail";
  return {
    earned,
    max,
    normalised,
    grace,
    final,
    outcome,
    missing,
    graceFlipped: grace !== 0 && outcome !== without,
    belowFloor: stage.autoRejectFloor != null && final < stage.autoRejectFloor,
  };
}

export const GRACE_REASON_MIN = 20;

/** Grace is legitimate judgement, constrained (spec §3.5). Null when acceptable. */
export function graceProblem(stage: Stage, grace: number, reason: string): string | null {
  if (!Number.isFinite(grace) || !Number.isInteger(grace)) return "Grace is a whole number of points.";
  const range = Math.min(10, Math.max(0, stage.graceRange));
  if (Math.abs(grace) > range) return `Grace on ${stage.name} is between −${range} and +${range}.`;
  if (grace !== 0 && reason.trim().length < GRACE_REASON_MIN)
    return `A grace adjustment needs a reason of at least ${GRACE_REASON_MIN} characters — it is shown on the record and in calibration.`;
  return null;
}

/* ------------------------------------------------------ competency roll-up */

/**
 * spec §3.7:
 *   competency = Σ(question score × weight) ÷ Σ(weight), over questions
 *                mapped to it, across every stage
 *   profile    = Σ(competency × competency weight)
 * Question scores are put on a 0–10 scale first so a 4-point question and a
 * 10-point one mean the same thing.
 */
export function competencyRollup(
  def: BlueprintDefinition,
  points: Record<string, number | null | undefined>,
): { scores: Record<string, number | null>; overall: number | null } {
  const sums: Record<string, { w: number; s: number }> = {};
  for (const st of def.stages)
    for (const q of st.questions) {
      const p = points[`${st.key}.${q.key}`];
      if (p == null || !q.maxPoints) continue;
      const ten = Math.max(0, Math.min(10, (p / q.maxPoints) * 10));
      for (const c of q.competencyKeys) {
        const s = (sums[c] ??= { w: 0, s: 0 });
        s.w += q.weight || 1;
        s.s += ten * (q.weight || 1);
      }
    }
  const scores: Record<string, number | null> = {};
  let overall = 0;
  let weightSeen = 0;
  for (const c of def.competencies) {
    const s = sums[c.key];
    scores[c.key] = s && s.w ? round1(s.s / s.w) : null;
    if (scores[c.key] != null) {
      overall += (scores[c.key] as number) * c.weight;
      weightSeen += c.weight;
    }
  }
  return { scores, overall: weightSeen ? round1(overall / weightSeen) : null };
}

/** Confidence in words, never a bare percentage (design brief §5.2). */
export function confidenceWord(c: number | null | undefined): "High" | "Moderate" | "Low" {
  if (c == null) return "Low";
  if (c >= 0.8) return "High";
  if (c >= 0.55) return "Moderate";
  return "Low";
}
