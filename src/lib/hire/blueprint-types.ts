/* ---------------------------------------------------------------------------
 * A ROLE BLUEPRINT IS DATA, and this file is its shape (PRD §4.1, spec §2.1).
 *
 * One published version of a blueprint is one immutable `hire_blueprints` row
 * whose `definition` column holds a `BlueprintDefinition`. It is a document
 * rather than eleven tables because a version is published, frozen and read
 * whole: a candidate who entered under v3 is scored under v3 for ever, and the
 * simplest way to make that true is for v3 to be one row nothing updates.
 * Editing a published blueprint creates a new draft row (spec §2.1).
 *
 * PURE and client-safe — the studio's editor is a client component and the
 * scoring engine runs the same types on the server.
 * ------------------------------------------------------------------------- */

export const STAGE_TYPES = [
  "application",
  "ai_screen",
  "scored_interview",
  "async_assessment",
  "work_sample",
  "briefing",
  "document_collection",
  "checklist",
  "system_setup",
  "reference_check",
  "decision_gate",
] as const;
export type StageType = (typeof STAGE_TYPES)[number];

export const STAGE_TYPE_LABEL: Record<StageType, string> = {
  application: "Application",
  ai_screen: "AI Screen",
  scored_interview: "Scored Interview",
  async_assessment: "Async Assessment",
  work_sample: "Work Sample",
  briefing: "Briefing",
  document_collection: "Document Collection",
  checklist: "Checklist",
  system_setup: "System Setup",
  reference_check: "Reference Check",
  decision_gate: "Decision Gate",
};

/** Stage types that carry a score (PRD §4.3). */
export const SCORED_TYPES: ReadonlySet<StageType> = new Set([
  "ai_screen",
  "scored_interview",
  "async_assessment",
  "work_sample",
  "reference_check",
]);

export const SCORING_MODES = ["ai_rubric", "fixed_choice", "calculated", "manual"] as const;
export type ScoringMode = (typeof SCORING_MODES)[number];

export const QUESTION_TYPES = [
  "behavioural",
  "situational",
  "technical",
  "factual",
  "calculated",
  "multi_select",
  "acknowledgement",
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export type Competency = {
  key: string;
  name: string;
  definition: string;
  /** Weights sum to 1.0 within a blueprint. */
  weight: number;
  anchors: { low: string; mid: string; high: string };
};

export type RubricTier = "zero" | "partial" | "full";

export type RubricCriterion = {
  key: string;
  descriptor: string;
  points: number | null;
  tier: RubricTier;
  indicators: string[];
};

/** The legacy capture mode, preserved exactly (spec §2.1 FixedChoiceOption). */
export type FixedOption = {
  key: string;
  label: string;
  /** Null means "no score defined" — a D7 gap the validator refuses to publish. */
  points: number | null;
};

/** One input a calculated rule reads, typed in by the interviewer. */
export type CalcInput = { key: string; label: string; unit?: string };

/**
 * A formula-driven item. Two kinds cover every item the AppSheet app has:
 *  - `formula`: an arithmetic expression over the inputs, e.g. Level 3's
 *    efficiency `(visits * hours / 8) * 10`.
 *  - `bands`: one input placed into ranges, each scoring a fixed number or
 *    scaling linearly across the range (Level 3's achievement 60–90%).
 */
export type CalcRule =
  | {
      kind: "formula";
      inputs: CalcInput[];
      expression: string;
      cap: number | null;
      floor: number | null;
      /** Said on the blueprint and the scoring card: something the business should look at. */
      anomaly?: string;
    }
  | {
      kind: "bands";
      input: CalcInput;
      /** `min` inclusive, `max` exclusive; null is open-ended. `to` makes it linear from `points` to `to`. */
      bands: { min: number | null; max: number | null; points: number; to?: number }[];
      /** What an input no band covers scores. Null is a D7 gap. */
      uncovered: number | null;
      anomaly?: string;
    };

export type Question = {
  key: string;
  text: string;
  type: QuestionType;
  competencyKeys: string[];
  maxPoints: number;
  weight: number;
  mode: ScoringMode;
  idealAnswer: string;
  probes: string[];
  rubric: RubricCriterion[];
  /** fixed_choice only. */
  options?: FixedOption[];
  /** fixed_choice: several may be picked and their points ADD. */
  cumulative?: boolean;
  /** fixed_choice cumulative: the most the selections can total. */
  cap?: number | null;
  /** fixed_choice cumulative: the least (a negative option can push below 0). */
  floor?: number | null;
  calc?: CalcRule;
  mandatory: boolean;
  knockout: boolean;
  /** A note the studio and the scoring card both show — the history behind a value. */
  note?: string;
  /** Approved by a person — an unapproved AI element blocks publication. */
  approved: boolean;
  ai: boolean;
};

export type BriefingResponseType = "told_only" | "agree_disagree" | "agree_disagree_willtry";

export type BriefingPoint = {
  key: string;
  title: string;
  body: string;
  responseType: BriefingResponseType;
  /** A disagreement here halts progression (fixes D8). */
  blocking: boolean;
  commentOnDisagree: boolean;
  approved: boolean;
  ai: boolean;
};

export type Stage = {
  key: string;
  name: string;
  type: StageType;
  /** Sum of question maxPoints, for scored stages. */
  maxPoints: number;
  /** ONE threshold governs status, message and progression (fixes D4). */
  passThreshold: number;
  /** Below this, a rejection is PROPOSED for a person to confirm. Null: none. */
  autoRejectFloor: number | null;
  strongSignal: number | null;
  /** Grace range either side of zero; default 5, at most 10 (spec §3.5). */
  graceRange: number;
  slaHours: number;
  /** For decision_gate: who may record the decision. */
  gateRole?: string;
  questions: Question[];
  /** briefing only. */
  briefing?: BriefingPoint[];
  rationale?: string;
  approved: boolean;
  ai: boolean;
};

export type PiiClass = "none" | "personal" | "sensitive" | "restricted";

export type DocumentRequirement = {
  key: string;
  label: string;
  /** `aadhaar` and `pan` are vaulted and masked; the rest are files. */
  kind: "aadhaar" | "pan" | "bank" | "photo" | "certificate" | "payslip" | "address" | "other";
  mandatory: boolean;
  verify: boolean;
  retentionMonths: number;
  pii: PiiClass;
  approved: boolean;
  ai: boolean;
};

export type Grade = {
  key: string;
  label: string;
  /** Monthly basic, whole paise, INR. */
  basicMinPaise: number;
  basicMaxPaise: number;
};

/** One definition of growth, read by the briefing AND the offer letter (fixes D12). */
export type GrowthStep = {
  fromGrade: string;
  toGrade: string;
  criterion: string;
  incrementType: "percentage" | "fixed_amount";
  /** Percent for `percentage`; whole paise for `fixed_amount`. */
  value: number;
};

export type OfferModel = {
  currency: "INR";
  grades: Grade[];
  incentive: string;
  growth: GrowthStep[];
  approved: boolean;
  ai: boolean;
};

export type OnboardingPlan = {
  assets: { key: string; label: string; serial: boolean }[];
  modules: { key: string; name: string; topics: { key: string; title: string }[] }[];
  setup: { key: string; system: string; steps: { key: string; label: string }[] }[];
  approved: boolean;
  ai: boolean;
};

export type Provisioning = {
  /** MahekOne app ids granted on hire. */
  apps: string[];
  /** The app level the grant carries. */
  level: "associate" | "manager";
  /** In-app role, in words — "Field Sales Executive", "Telecaller". */
  roleLabel: string;
  device: boolean;
  approved: boolean;
  ai: boolean;
};

export const MASKABLE = ["name", "gender_markers", "age", "photo", "location", "institution"] as const;
export type Maskable = (typeof MASKABLE)[number];

export type FairnessConfig = {
  masked: Maskable[];
  /** Required for each attribute deliberately NOT masked. */
  unmaskedJustification: Partial<Record<Maskable, string>>;
  monitor: { gender: boolean; age: boolean; location: boolean };
  /** Four-fifths rule by default. */
  adverseImpactThreshold: number;
  redactBeforeTransmission: boolean;
  approved: boolean;
  ai: boolean;
};

export type CoolingOff = { reasonCode: string; days: number };

export type BlueprintDefinition = {
  competencies: Competency[];
  stages: Stage[];
  documents: DocumentRequirement[];
  offer: OfferModel;
  onboarding: OnboardingPlan;
  provisioning: Provisioning;
  fairness: FairnessConfig;
  coolingOff: CoolingOff[];
  /** Business questions the seeding could not answer — shown as warnings. */
  openQuestions: string[];
};

/** Rejection reason codes, shared by the gate, the queue and cooling-off. */
export const REJECTION_REASONS = [
  ["below_pass", "Below the pass mark"],
  ["knockout", "Failed a knockout question"],
  ["blocking_briefing", "Disagreed with a blocking briefing point"],
  ["compensation", "Compensation outside the band"],
  ["documents", "Documents could not be verified"],
  ["no_show", "Did not attend"],
  ["decision", "Decision gate: not advanced"],
  ["other", "Other — stated in the reasoning"],
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number][0];
export const REJECTION_LABEL: Record<string, string> = Object.fromEntries(REJECTION_REASONS);

/** Every question in a blueprint, with the stage it belongs to. */
export function allQuestions(def: BlueprintDefinition): { stage: Stage; q: Question }[] {
  return def.stages.flatMap((stage) => stage.questions.map((q) => ({ stage, q })));
}

export function stageByKey(def: BlueprintDefinition, key: string): Stage | undefined {
  return def.stages.find((s) => s.key === key);
}

export function stageIndex(def: BlueprintDefinition, key: string | null | undefined): number {
  if (!key) return -1;
  return def.stages.findIndex((s) => s.key === key);
}

export const isScored = (s: Pick<Stage, "type">) => SCORED_TYPES.has(s.type);
