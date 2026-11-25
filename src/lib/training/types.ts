/* ---------------------------------------------------------------------------
 * TRAINING — the shapes. PURE and client-safe: the module editor, the test
 * player and the engine all read these.
 *
 * A module VERSION is one frozen document (content + questions + rules), the
 * way a blueprint version is: an attempt records the version it was taken
 * on, so editing a question never changes what somebody was tested on.
 * ------------------------------------------------------------------------- */

export const TRAINING_CATEGORIES = ["product", "induction", "sales", "objection", "commercial", "final", "other"] as const;
export type TrainingCategory = (typeof TRAINING_CATEGORIES)[number];

export const CATEGORY_LABEL: Record<TrainingCategory, string> = {
  product: "Product",
  induction: "Induction",
  sales: "Sales",
  objection: "Objection",
  commercial: "Commercial",
  final: "Final",
  other: "Other",
};

export type ContentBlock =
  | { key: string; kind: "text"; title: string; body: string; tone?: "normal" | "safety" }
  | { key: string; kind: "link"; title: string; url: string; note?: string }
  /** Live from the catalogue: every active SKU whose product name contains `match`. */
  | { key: string; kind: "product_facts"; title: string; match: string }
  /** The "who to contact" directory, read from configuration at view time. */
  | { key: string; kind: "directory"; title: string };

export type McqOption = { key: string; text: string };

export type McqQuestion = {
  key: string;
  text: string;
  options: McqOption[];
  correctKey: string;
  explanation: string;
  difficulty: "easy" | "medium" | "hard";
  tags: string[];
  active: boolean;
  /** Drafted by a model — refused at publish until a person approves it. */
  ai: boolean;
  approved: boolean;
};

export type FeedbackMode = "none" | "after_each" | "after_submit";

export type ModuleDefinition = {
  content: ContentBlock[];
  questions: McqQuestion[];
  /** Score ≥ this passes (PRD §16 — equal passes). */
  passMarkPercent: number;
  /** How many active questions an attempt draws; null draws them all. */
  questionsPerAttempt: number | null;
  timerMinutes: number | null;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  feedback: FeedbackMode;
  /** Minutes of study logged before the first attempt (and before a retake) may start. */
  minStudyMinutes: number;
};

export type TrackItem = {
  moduleKey: string;
  required: boolean;
  /**
   * The module keys that must be passed first. `null` means "the item before
   * it" when the track is sequential; an empty list means none — it runs
   * alongside (Company Induction).
   */
  after: string[] | null;
};

export type TrackDefinition = {
  designations: string[];
  sequential: boolean;
  completeWithinDays: number | null;
  items: TrackItem[];
};

/** PRD §17 — what a learner's module is, derived from events and attempts. */
export const MODULE_STATES = ["locked", "available", "in_progress", "assessment_pending", "passed", "retraining_required", "retake_open"] as const;
export type ModuleState = (typeof MODULE_STATES)[number];

export const MODULE_STATE_LABEL: Record<ModuleState, string> = {
  locked: "Locked",
  available: "Available",
  in_progress: "In progress",
  assessment_pending: "Test in progress",
  passed: "Passed",
  retraining_required: "Retraining required",
  retake_open: "Retake open",
};

export function emptyModule(): ModuleDefinition {
  return { content: [], questions: [], passMarkPercent: 80, questionsPerAttempt: null, timerMinutes: 15, shuffleQuestions: true, shuffleOptions: true, feedback: "after_submit", minStudyMinutes: 5 };
}
