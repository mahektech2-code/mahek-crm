import type { ModuleDefinition, ModuleState, McqQuestion, TrackDefinition } from "./types";

/* ---------------------------------------------------------------------------
 * THE TRAINING ENGINE (PRD §16–18). PURE: everything it needs is passed in,
 * including "now", so the rules are testable without a database.
 *
 *  - a score at or above the pass mark passes;
 *  - a fail means retraining: the retake opens only after a trainer signs the
 *    review off AND the learner has studied the module again since the fail;
 *  - a module unlocks when everything it comes after is passed;
 *  - progress counts required modules only.
 * ------------------------------------------------------------------------- */

export type AttemptLite = { moduleKey: string; attemptNo: number; startedAt: string; submittedAt: string | null; deadlineAt: string | null; result: "passed" | "failed" | null; scorePercent: number | null };
export type EventLite = { moduleKey: string; kind: "studied" | "retraining_signed_off"; seconds: number | null; at: string };

/** PRD §16: equal to the pass mark passes. Rounded to one decimal so 79.96 does not read as 80. */
export function score(correct: number, total: number, passMark: number): { percent: number; result: "passed" | "failed" } {
  const percent = total > 0 ? Math.round((correct / total) * 1000) / 10 : 0;
  return { percent, result: percent >= passMark ? "passed" : "failed" };
}

/** A small, fast, seeded generator — the same seed draws the same order on every reload. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFrom(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function shuffle<T>(xs: readonly T[], seed: number): T[] {
  const r = mulberry32(seed);
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** The questions an attempt is drawn: active ones, shuffled and cut to size as the module says. */
export function drawAttempt(def: ModuleDefinition, seed: number): { questionKey: string; optionOrder: string[] }[] {
  const pool = def.questions.filter((q) => q.active && q.approved);
  const ordered = def.shuffleQuestions ? shuffle(pool, seed) : pool;
  const n = def.questionsPerAttempt && def.questionsPerAttempt > 0 ? Math.min(def.questionsPerAttempt, ordered.length) : ordered.length;
  return ordered.slice(0, n).map((q, i) => ({
    questionKey: q.key,
    optionOrder: def.shuffleOptions ? shuffle(q.options.map((o) => o.key), seed + i + 1) : q.options.map((o) => o.key),
  }));
}

/** What would stop a module version being published. */
export function moduleProblems(def: ModuleDefinition): string[] {
  const out: string[] = [];
  const usable = def.questions.filter((q) => q.active && q.approved);
  if (!usable.length) out.push("It has no active, approved question — nobody could take its test.");
  if (def.passMarkPercent < 1 || def.passMarkPercent > 100) out.push("The pass mark must be between 1% and 100%.");
  if (def.questionsPerAttempt != null && def.questionsPerAttempt > usable.length) out.push(`It draws ${def.questionsPerAttempt} questions but has ${usable.length} active and approved.`);
  for (const q of def.questions) out.push(...questionProblems(q).map((p) => `“${q.text.slice(0, 60) || q.key}”: ${p}`));
  const unapproved = def.questions.filter((q) => q.active && q.ai && !q.approved).length;
  if (unapproved) out.push(`${unapproved} AI-drafted question${unapproved === 1 ? " is" : "s are"} active but not approved by a person.`);
  return out;
}

export function questionProblems(q: McqQuestion): string[] {
  const out: string[] = [];
  if (!q.text.trim()) out.push("the question is empty");
  const opts = q.options.filter((o) => o.text.trim());
  if (opts.length < 2) out.push("it needs at least two options");
  if (!opts.some((o) => o.key === q.correctKey)) out.push("no option is marked correct");
  if (new Set(opts.map((o) => o.text.trim().toLowerCase())).size !== opts.length) out.push("two options say the same thing");
  return out;
}

export function trackProblems(def: TrackDefinition, publishedModuleKeys: ReadonlySet<string>): string[] {
  const out: string[] = [];
  if (!def.items.length) out.push("The track has no modules.");
  const keys = def.items.map((i) => i.moduleKey);
  if (new Set(keys).size !== keys.length) out.push("A module appears twice.");
  for (const it of def.items) {
    if (!publishedModuleKeys.has(it.moduleKey)) out.push(`${it.moduleKey} has no published version.`);
    for (const a of it.after ?? []) if (!keys.includes(a)) out.push(`${it.moduleKey} comes after ${a}, which is not in the track.`);
  }
  if (!def.items.some((i) => i.required)) out.push("No module is required, so the track could never be completed.");
  return out;
}

/** The modules each module waits for, resolving "the one before" for a sequential track. */
export function prerequisites(def: TrackDefinition): Map<string, string[]> {
  const m = new Map<string, string[]>();
  def.items.forEach((it, i) => {
    if (it.after) m.set(it.moduleKey, it.after);
    else m.set(it.moduleKey, def.sequential && i > 0 ? [def.items[i - 1].moduleKey] : []);
  });
  return m;
}

export type ModuleProgress = {
  moduleKey: string;
  required: boolean;
  state: ModuleState;
  attempts: number;
  bestScore: number | null;
  lastScore: number | null;
  studiedSeconds: number;
  /** Why it is locked, or what the learner does next. */
  why: string;
  /** An attempt started and not submitted (still within its deadline). */
  openAttemptNo: number | null;
};

/**
 * Every module's state for one learner. `nowMs` decides whether an open
 * attempt has run out of time — an expired one counts as abandoned here and
 * is scored on what was answered by the service that finds it.
 */
export function moduleStates(def: TrackDefinition, attempts: AttemptLite[], events: EventLite[], minStudyByModule: Record<string, number>, nowMs: number): ModuleProgress[] {
  const pre = prerequisites(def);
  const passed = new Set(attempts.filter((a) => a.result === "passed").map((a) => a.moduleKey));
  return def.items.map((it) => {
    const mine = attempts.filter((a) => a.moduleKey === it.moduleKey).sort((a, b) => a.attemptNo - b.attemptNo);
    const submitted = mine.filter((a) => a.submittedAt);
    const last = submitted[submitted.length - 1] ?? null;
    const open = mine.find((a) => !a.submittedAt && (!a.deadlineAt || new Date(a.deadlineAt).getTime() > nowMs)) ?? null;
    const ev = events.filter((e) => e.moduleKey === it.moduleKey);
    const studied = ev.filter((e) => e.kind === "studied").reduce((s, e) => s + (e.seconds ?? 0), 0);
    const scores = submitted.map((a) => a.scorePercent ?? 0);
    const base = { moduleKey: it.moduleKey, required: it.required, attempts: submitted.length, bestScore: scores.length ? Math.max(...scores) : null, lastScore: last?.scorePercent ?? null, studiedSeconds: studied, openAttemptNo: open?.attemptNo ?? null };
    if (passed.has(it.moduleKey)) return { ...base, state: "passed" as const, why: `Passed with ${base.bestScore}%.` };
    const waiting = (pre.get(it.moduleKey) ?? []).filter((k) => !passed.has(k));
    if (waiting.length) return { ...base, state: "locked" as const, why: `Opens after ${waiting.join(", ")}.` };
    if (open) return { ...base, state: "assessment_pending" as const, why: "A test is in progress." };
    const minSec = (minStudyByModule[it.moduleKey] ?? 0) * 60;
    if (last?.result === "failed") {
      const failedAt = new Date(last.submittedAt!).getTime();
      const signed = ev.some((e) => e.kind === "retraining_signed_off" && new Date(e.at).getTime() > failedAt);
      if (!signed) return { ...base, state: "retraining_required" as const, why: `Scored ${last.scorePercent}%. A trainer reviews the module with the learner, then the retake opens.` };
      const restudied = ev.filter((e) => e.kind === "studied" && new Date(e.at).getTime() > failedAt).reduce((s, e) => s + (e.seconds ?? 0), 0);
      if (restudied < minSec) return { ...base, state: "retraining_required" as const, why: `Signed off. Study the module again (${Math.ceil((minSec - restudied) / 60)} min more) and the retake opens.` };
      return { ...base, state: "retake_open" as const, why: `Retake ${submitted.length + 1} is open.` };
    }
    if (studied > 0) return { ...base, state: (studied >= minSec ? "available" : "in_progress") as ModuleState, why: studied >= minSec ? "Ready for the test." : `Study ${Math.ceil((minSec - studied) / 60)} min more before the test.` };
    return { ...base, state: "available" as const, why: "Open the module to start." };
  });
}

/** Whether a learner may start an attempt on this module now. */
export function canStartAttempt(p: ModuleProgress, minStudyMinutes: number): { ok: true } | { ok: false; why: string } {
  if (p.state === "locked" || p.state === "passed" || p.state === "retraining_required") return { ok: false, why: p.why };
  if (p.state === "assessment_pending") return { ok: false, why: "A test is already in progress — carry on with it." };
  if (p.state !== "retake_open" && p.studiedSeconds < minStudyMinutes * 60) return { ok: false, why: `Study the module for ${minStudyMinutes} minutes first.` };
  return { ok: true };
}

export function progress(states: ModuleProgress[]): { required: number; passed: number; percent: number; current: ModuleProgress | null; next: ModuleProgress | null } {
  const req = states.filter((s) => s.required);
  const passed = req.filter((s) => s.state === "passed").length;
  const current = states.find((s) => s.state !== "passed" && s.state !== "locked") ?? null;
  const next = states.find((s) => s.state === "locked") ?? null;
  return { required: req.length, passed, percent: req.length ? Math.round((passed / req.length) * 100) : 0, current, next };
}
