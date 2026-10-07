import type { BlueprintDefinition, Stage } from "../blueprint-types";
import { isScored } from "../blueprint-types";

/* ---------------------------------------------------------------------------
 * ENTRY GATING — the fix for D5 (spec §6.1). Pure.
 *
 * A candidate enters a stage only when the entry rule says so. The default
 * rule is that the stage before it was PASSED. Nothing here has a way to type
 * a candidate into a stage they have not reached; an override is a separate,
 * named act with a reason, and the caller records it.
 * ------------------------------------------------------------------------- */

export type AppState = {
  status: string;
  stageKey: string | null;
  /** Outcome of the CURRENT stage: pass / fail / pending. */
  currentOutcome: "pass" | "fail" | "pending";
  /** Why the current stage is not passed, in words. */
  pendingWhy?: string;
};

export type MoveVerdict =
  | { ok: true }
  | {
      ok: false;
      why: string;
      /** Whether a person with the override capability may move them anyway. */
      overridable: boolean;
      /** Where the work that would satisfy the rule is done. */
      route?: "gate" | "provision" | "scoring" | "briefing" | "documents";
    };

export function canMove(def: BlueprintDefinition, st: AppState, targetKey: string): MoveVerdict {
  const from = def.stages.findIndex((s) => s.key === st.stageKey);
  const to = targetKey === "hired" ? def.stages.length : def.stages.findIndex((s) => s.key === targetKey);
  if (to < 0) return { ok: false, why: "That stage is not in this candidate’s blueprint.", overridable: false };
  if (st.status !== "in_progress")
    return { ok: false, why: `The application is ${st.status.replace("_", " ")} — resume it from the record first.`, overridable: false };
  if (to === from) return { ok: false, why: "They are already in this stage.", overridable: false };
  if (to < from)
    return {
      ok: false,
      why: "Candidates do not move backwards. A correction is recorded on the candidate’s record as a new entry that supersedes the old one.",
      overridable: false,
    };
  const cur = def.stages[from];
  if (cur?.type === "decision_gate")
    return { ok: false, why: `Leaving the decision gate needs a recorded decision with reasoning from a ${cur.gateRole ?? "Hiring Manager"}.`, overridable: false, route: "gate" };
  if (to === def.stages.length)
    return { ok: false, why: "Hired is set only when onboarding is complete and the MahekOne account is provisioned.", overridable: false, route: "provision" };
  if (to > from + 1) {
    const skipped = def.stages.slice(from + 1, to).map((s) => s.name).join(", ");
    return { ok: false, why: `This skips ${skipped}. Every stage in between has to be passed.`, overridable: true };
  }
  if (st.currentOutcome !== "pass")
    return {
      ok: false,
      why: st.pendingWhy ?? (st.currentOutcome === "fail" ? `${cur?.name ?? "This stage"} was not passed.` : `${cur?.name ?? "This stage"} is not complete.`),
      overridable: true,
      route: cur && isScored(cur) ? "scoring" : cur?.type === "briefing" ? "briefing" : cur?.type === "document_collection" ? "documents" : undefined,
    };
  return { ok: true };
}

export function nextStage(def: BlueprintDefinition, key: string | null): Stage | null {
  const i = def.stages.findIndex((s) => s.key === key);
  return def.stages[i + 1] ?? null;
}

/** SLA breach: time in stage past the stage's own target. */
export function slaBreached(stage: Pick<Stage, "slaHours"> | null | undefined, hoursInStage: number): boolean {
  return Boolean(stage && stage.slaHours > 0 && hoursInStage > stage.slaHours);
}

export const OVERRIDE_REASON_MIN = 20;
export const DECISION_REASON_MIN = 30;
