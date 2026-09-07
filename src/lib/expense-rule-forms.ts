/* ---------------------------------------------------------------------------
 * The expense policy rules, as a form and as a sentence.
 *
 * PURE and client-safe: the rule builder is a client component, the review
 * before publishing is a client component, and the handset's "what am I
 * allowed" screen renders the same sentences. A second copy of this
 * vocabulary typed into any one of them would drift — and the half that
 * drifts is always the half somebody reads before spending money.
 *
 * Three jobs, deliberately in one file because they are three views of one
 * thing and separating them is how they come to disagree:
 *
 *   1. `RULE_KINDS` — what each rule kind asks for, so the builder renders
 *      thirteen forms without thirteen bespoke components.
 *   2. `validateRule` — whether an answer is usable, checked here AND in the
 *      action, because a check that lives only in an interface is not a check.
 *   3. `describeRule` — the rule in one English sentence, which is what the
 *      review page, the manager's mirror and the salesman's screen all show.
 *      A policy nobody can read in words is a policy nobody verifies, and
 *      requirement 4 asks somebody to verify it.
 *
 * `parseRule` is the fourth job and the quiet one: `expense_policy_rules`
 * stores `valueJson`, the engine takes typed rules, and this is the ONE place
 * that crosses between them. A second reader of that JSON is a second
 * vocabulary.
 * ------------------------------------------------------------------------- */

import {
  KM_SOURCES,
  MEALS,
  POLICY_RULE_KINDS,
  type ExpenseKind,
  type KmSource,
  type Meal,
  type PolicyRule,
  type PolicyRuleKind,
} from "@/lib/engines/expense-policy";
import type { FieldError } from "@/lib/result";

/* ------------------------------------------------------------------ shapes */

export type RuleFieldType =
  /** Rupees on screen, paise in the row. The form does the ×100, once. */
  | "paise"
  | "integer"
  | "km"
  /** A wall clock, `HH:MM`, stored as minutes since local midnight. */
  | "clock"
  /** A percentage on screen, basis points in the row. */
  | "percent"
  | "boolean"
  | "select"
  | "km_precedence";

export type RuleField = {
  key: string;
  label: string;
  type: RuleFieldType;
  /** A field that may be left empty means something specific — see `emptyMeans`. */
  required: boolean;
  emptyMeans?: string;
  help?: string;
  options?: readonly { value: string; label: string }[];
  min?: number;
  max?: number;
};

/**
 * What a rule's `scopeKey` names.
 *
 * `none` is a kind there can only be one of per qualifier — the approval
 * route, the exception bands — and its scope key is the empty string. Anything
 * else would be a second answer to a question that has one.
 */
export type RuleScope = "travel_mode" | "category" | "meal" | "wildcard" | "none";

export type RuleKindSpec = {
  kind: PolicyRuleKind;
  label: string;
  /** One sentence: what this rule kind decides. Shown above its form. */
  blurb: string;
  scope: RuleScope;
  fields: readonly RuleField[];
  /** The client's own numbered requirements this kind answers. */
  requirements: readonly number[];
};

export const EXPENSE_KIND_OPTIONS: readonly { value: ExpenseKind; label: string }[] = [
  { value: "travel", label: "Travel" },
  { value: "food", label: "Food" },
  { value: "lodging", label: "Hotel" },
  { value: "local_transport", label: "Local transport" },
  { value: "other", label: "Other" },
];

/** The meals, as a picker offers them. Read by the builder's scope field. */
export const MEAL_OPTIONS: readonly { value: Meal; label: string }[] = MEALS.map((m) => ({
  value: m,
  label: m[0]!.toUpperCase() + m.slice(1),
}));

/* --------------------------------------------------------------- the specs */

export const RULE_KINDS: readonly RuleKindSpec[] = [
  {
    kind: "per_km",
    label: "Rate per kilometre",
    blurb: "What a kilometre on this vehicle is worth. The distance × this rate is the reimbursement.",
    scope: "travel_mode",
    requirements: [9, 10],
    fields: [
      { key: "paisePerKm", label: "Rate per kilometre", type: "paise", required: true, min: 0 },
      {
        key: "dailyKmCap",
        label: "Most kilometres in a day",
        type: "km",
        required: false,
        emptyMeans: "no ceiling on the distance",
        min: 0,
      },
    ],
  },
  {
    kind: "actuals",
    label: "Reimbursed at actuals",
    blurb: "Paid what it cost, up to a limit. A ticket, a rickshaw, anything with a receipt behind it.",
    scope: "category",
    requirements: [11, 12, 13],
    fields: [
      {
        key: "capPerInstancePaise",
        label: "Most for one claim",
        type: "paise",
        required: false,
        emptyMeans: "whatever it cost",
        min: 0,
      },
      {
        key: "capPerDayPaise",
        label: "Most in a day",
        type: "paise",
        required: false,
        emptyMeans: "no daily limit",
        min: 0,
      },
    ],
  },
  {
    kind: "zero_rated",
    label: "Recorded, not reimbursed",
    blurb:
      "The distance is still recorded and the salesman is told it pays nothing BEFORE he saves — a customer's vehicle, and walking.",
    scope: "travel_mode",
    requirements: [14, 15],
    fields: [],
  },
  {
    kind: "km_source",
    label: "Which distance is paid on",
    blurb:
      "The odometer, the day's GPS track, or a figure entered by hand — in the order they are tried. The first one present wins.",
    scope: "travel_mode",
    requirements: [17, 18, 19],
    fields: [
      {
        key: "precedence",
        label: "Try these in order",
        type: "km_precedence",
        required: true,
        help: "GPS sampled every few minutes cuts corners and reads SHORT, so paying on it under-pays whoever covers the most ground. The odometer is what the vehicle did, and it can be photographed.",
      },
      {
        key: "varianceFlagBps",
        label: "Flag when they disagree by more than",
        type: "percent",
        required: true,
        min: 0,
        max: 100,
      },
    ],
  },
  {
    kind: "odometer_photo",
    label: "When an odometer photo is needed",
    blurb: "Always, on a random share of legs, or only where the reading and the track disagree.",
    scope: "travel_mode",
    requirements: [20],
    fields: [
      {
        key: "when",
        label: "Ask for a photograph",
        type: "select",
        required: true,
        options: [
          { value: "never", label: "Never" },
          { value: "always", label: "On every leg" },
          { value: "random", label: "On a random share of legs" },
          { value: "on_variance", label: "Only where GPS and the odometer disagree" },
        ],
      },
      {
        key: "randomPct",
        label: "Share of legs, where random",
        type: "integer",
        required: false,
        emptyMeans: "none",
        min: 0,
        max: 100,
        help: "The draw is made in the office and sent down. A check the handset rolls for itself is a check it can decline to fail.",
      },
    ],
  },
  {
    kind: "meal_rate",
    label: "What a meal is worth",
    blurb:
      "One amount per meal, never per combination. Breakfast ₹100 and lunch ₹150 IS breakfast-and-lunch ₹250, and it is the only way a single meal can be withheld.",
    scope: "meal",
    requirements: [26, 27],
    fields: [{ key: "amountPaise", label: "Amount", type: "paise", required: true, min: 0 }],
  },
  {
    kind: "meal_entitlement",
    label: "When a meal is earned",
    blurb: "He was away across this part of the day.",
    scope: "meal",
    requirements: [26],
    fields: [
      { key: "windowFromMinutes", label: "Window opens", type: "clock", required: true },
      { key: "windowToMinutes", label: "Window closes", type: "clock", required: true },
      {
        key: "minAwayMinutes",
        label: "And away at least",
        type: "integer",
        required: false,
        emptyMeans: "the window alone decides",
        min: 0,
        max: 24 * 60,
        help: "Minutes.",
      },
    ],
  },
  {
    kind: "meal_disqualifier",
    label: "A meal not paid to a late start",
    blurb: "Leaving home after this time, and that meal is not earned however long the day runs.",
    scope: "meal",
    requirements: [28],
    fields: [{ key: "departedAfterMinutes", label: "Left after", type: "clock", required: true }],
  },
  {
    kind: "dormitory",
    label: "The dormitory morning",
    blurb:
      "Arriving overnight in this window with no hotel taken. It REPLACES the day's meals rather than adding to them.",
    scope: "none",
    requirements: [29],
    fields: [
      { key: "arrivalFromMinutes", label: "Arrived no earlier than", type: "clock", required: true },
      { key: "arrivalToMinutes", label: "And no later than", type: "clock", required: true },
      { key: "amountPaise", label: "Amount", type: "paise", required: true, min: 0 },
      {
        key: "replacesMeals",
        label: "Instead of the day's meals",
        type: "boolean",
        required: true,
        help: "On the client's own figures ₹250 is breakfast plus lunch, so it plainly IS the morning's meal allowance rather than a payment on top of it.",
      },
    ],
  },
  {
    kind: "lodging",
    label: "Hotel",
    blurb: "The most a night may cost, and whether a room taken for the day counts at all.",
    scope: "none",
    requirements: [31, 32, 33],
    fields: [
      { key: "maxPerNightPaise", label: "Most for one night", type: "paise", required: true, min: 0 },
      {
        key: "dayUseAllowed",
        label: "A daytime room is reimbursed",
        type: "boolean",
        required: true,
        help: "Off means a room with no night in it is ₹0 — still recorded, with the reason beside it.",
      },
    ],
  },
  {
    kind: "proof_threshold",
    label: "When proof is compulsory",
    blurb: "At or above this, a bill or ticket is not optional.",
    scope: "wildcard",
    requirements: [34, 37],
    fields: [{ key: "atPaise", label: "At or above", type: "paise", required: true, min: 0 }],
  },
  {
    kind: "approval_route",
    label: "Who decides",
    blurb:
      "A clean day under the automatic limit approves itself. Anything flagged goes to the manager, and the owner is escalated to on top of that — never instead.",
    scope: "none",
    requirements: [44, 45],
    fields: [
      {
        key: "autoApproveUpToPaise",
        label: "Approve a clean day automatically up to",
        type: "paise",
        required: true,
        min: 0,
        help: "Requirement 45. A manager asked to approve forty ₹40 fares stops reading any of them, and then the one that mattered goes through with the rest.",
      },
      {
        key: "escalateAboveDayTotalPaise",
        label: "Send to the owner above a day total of",
        type: "paise",
        required: false,
        emptyMeans: "never on size alone",
        min: 0,
        help: "Per DAY, not per line. A line can be split; a day cannot.",
      },
      {
        key: "escalateOnSeverity",
        label: "And send to the owner when something is flagged at",
        type: "select",
        required: false,
        emptyMeans: "never on a flag alone",
        options: [
          { value: "warn", label: "Anything questioned" },
          { value: "block_route", label: "Only what is missing proof" },
        ],
      },
    ],
  },
  {
    kind: "exception_bands",
    label: "What counts as abnormal",
    blurb: "The distances and amounts worth somebody looking at. These question a claim; they never refuse one.",
    scope: "none",
    requirements: [42, 48, 49],
    fields: [
      {
        key: "dailyKmCeiling",
        label: "Kilometres in a day beyond which the day is questioned",
        type: "km",
        required: false,
        emptyMeans: "no distance is questioned",
        min: 0,
      },
      {
        key: "ownSpendBandBps",
        label: "Above his own recent average by",
        type: "percent",
        required: false,
        emptyMeans: "his own history is not compared",
        min: 0,
        max: 1000,
      },
      {
        key: "teamSpendBandBps",
        label: "Above the team average by",
        type: "percent",
        required: false,
        emptyMeans: "the team is not compared",
        min: 0,
        max: 1000,
      },
    ],
  },
];

export function ruleSpec(kind: string): RuleKindSpec | null {
  return RULE_KINDS.find((r) => r.kind === kind) ?? null;
}

/* ------------------------------------------------------------- validation */

export type RuleDraft = {
  kind: string;
  scopeKey: string;
  grade: string | null;
  cityClass: string | null;
  value: Record<string, unknown>;
};

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * Whether a rule can be saved, and what is wrong with it if not.
 *
 * Field-level, because these forms have up to four inputs and a banner saying
 * "invalid" sends somebody hunting. The action runs this too: a server action
 * is a URL, and a form is not a permission.
 */
export function validateRule(draft: RuleDraft): FieldError[] {
  const spec = ruleSpec(draft.kind);
  if (!spec) return [{ field: "kind", message: `There is no rule kind called "${draft.kind}".` }];

  const errors: FieldError[] = [];

  if (spec.scope === "none") {
    if (draft.scopeKey !== "") {
      errors.push({ field: "scopeKey", message: `A ${spec.label.toLowerCase()} rule applies to the whole day, so it names nothing.` });
    }
  } else if (!draft.scopeKey.trim()) {
    errors.push({ field: "scopeKey", message: "This rule has to say what it applies to." });
  }

  if (spec.scope === "meal" && !MEALS.includes(draft.scopeKey as Meal)) {
    errors.push({ field: "scopeKey", message: `A meal is one of ${MEALS.join(", ")}.` });
  }

  for (const field of spec.fields) {
    const raw = draft.value[field.key];
    const missing = raw === null || raw === undefined || raw === "";

    if (missing) {
      if (field.required) {
        errors.push({ field: field.key, message: `${field.label} is needed.` });
      }
      continue;
    }

    if (field.type === "boolean") {
      if (typeof raw !== "boolean") {
        errors.push({ field: field.key, message: `${field.label} is yes or no.` });
      }
      continue;
    }

    if (field.type === "select") {
      const allowed = (field.options ?? []).map((o) => o.value);
      if (typeof raw !== "string" || !allowed.includes(raw)) {
        errors.push({ field: field.key, message: `${field.label} must be one of: ${allowed.join(", ")}.` });
      }
      continue;
    }

    if (field.type === "km_precedence") {
      const list = Array.isArray(raw) ? raw : null;
      if (!list || list.length === 0) {
        errors.push({ field: field.key, message: "Name at least one source of distance." });
      } else if (list.some((s) => !KM_SOURCES.includes(s as KmSource))) {
        errors.push({ field: field.key, message: `A distance comes from one of: ${KM_SOURCES.join(", ")}.` });
      } else if (new Set(list).size !== list.length) {
        errors.push({ field: field.key, message: "Each source may only be named once." });
      }
      continue;
    }

    const n = num(raw);
    if (n === null) {
      errors.push({ field: field.key, message: `${field.label} has to be a number.` });
      continue;
    }
    if (!Number.isInteger(n)) {
      errors.push({ field: field.key, message: `${field.label} has to be a whole number — money is paise and time is minutes.` });
      continue;
    }
    const min = field.type === "clock" ? 0 : (field.min ?? 0);
    const max = field.type === "clock" ? 36 * 60 : field.max;
    if (n < min) errors.push({ field: field.key, message: `${field.label} cannot be below ${min}.` });
    if (max !== undefined && n > max) {
      errors.push({ field: field.key, message: `${field.label} cannot be above ${max}.` });
    }
  }

  /* ---- the cross-field rules, which are where the real mistakes are ---- */

  if (draft.kind === "meal_entitlement") {
    const from = num(draft.value.windowFromMinutes);
    const to = num(draft.value.windowToMinutes);
    if (from !== null && to !== null && to <= from) {
      errors.push({
        field: "windowToMinutes",
        message: "The window has to close after it opens. A late dinner runs past midnight — 23:00 to 25:30.",
      });
    }
  }

  if (draft.kind === "dormitory") {
    const from = num(draft.value.arrivalFromMinutes);
    const to = num(draft.value.arrivalToMinutes);
    if (from !== null && to !== null && to <= from) {
      errors.push({ field: "arrivalToMinutes", message: "The arrival window has to close after it opens." });
    }
  }

  if (draft.kind === "odometer_photo" && draft.value.when === "random") {
    const pct = num(draft.value.randomPct);
    if (pct === null || pct <= 0) {
      errors.push({
        field: "randomPct",
        message: "A random check of nought per cent is a check that never happens — either give it a share, or set this to Never.",
      });
    }
  }

  if (draft.kind === "actuals") {
    const perInstance = num(draft.value.capPerInstancePaise);
    const perDay = num(draft.value.capPerDayPaise);
    if (perInstance !== null && perDay !== null && perDay < perInstance) {
      errors.push({
        field: "capPerDayPaise",
        message: "A day may not allow less than one claim of it, or the second claim of the day is refused before it exists.",
      });
    }
  }

  return errors;
}

/* --------------------------------------------------------------- parsing */

/**
 * A stored row as the engine's typed rule, or null where it cannot be one.
 *
 * The ONE crossing between `valueJson` and `PolicyRule`. Null rather than a
 * throw, because a row written by an older release with a kind this one does
 * not know is a real thing to encounter on a running deployment — and the
 * honest response is to leave it out of the policy and SAY the count, not to
 * fail the whole read of a policy somebody is being paid on.
 */
export function parseRule(row: {
  kind: string;
  scopeKey: string;
  grade: string | null;
  cityClass: string | null;
  valueJson: Record<string, unknown>;
}): PolicyRule | null {
  const spec = ruleSpec(row.kind);
  if (!spec) return null;
  const v = row.valueJson ?? {};
  const q = { grade: row.grade, cityClass: row.cityClass };
  const n = (k: string): number | null => num(v[k]);
  const req = (k: string): number => num(v[k]) ?? 0;

  switch (row.kind as PolicyRuleKind) {
    case "per_km":
      return { ...q, kind: "per_km", modeKey: modeOf(row.scopeKey), paisePerKm: req("paisePerKm"), dailyKmCap: n("dailyKmCap") };
    case "actuals":
      return {
        ...q,
        kind: "actuals",
        scopeKey: row.scopeKey,
        capPerInstancePaise: n("capPerInstancePaise"),
        capPerDayPaise: n("capPerDayPaise"),
      };
    case "zero_rated":
      return { ...q, kind: "zero_rated", modeKey: modeOf(row.scopeKey) };
    case "km_source": {
      const list = Array.isArray(v.precedence) ? (v.precedence as KmSource[]) : [];
      return {
        ...q,
        kind: "km_source",
        modeKey: row.scopeKey === "*" || row.scopeKey === "" ? null : modeOf(row.scopeKey),
        precedence: list.filter((s) => KM_SOURCES.includes(s)),
        varianceFlagBps: req("varianceFlagBps"),
      };
    }
    case "odometer_photo":
      return {
        ...q,
        kind: "odometer_photo",
        modeKey: row.scopeKey === "*" || row.scopeKey === "" ? null : modeOf(row.scopeKey),
        when: (v.when as "always" | "random" | "on_variance" | "never") ?? "never",
        randomPct: n("randomPct") ?? 0,
      };
    case "meal_rate":
      return { ...q, kind: "meal_rate", meal: row.scopeKey as Meal, amountPaise: req("amountPaise") };
    case "meal_entitlement":
      return {
        ...q,
        kind: "meal_entitlement",
        meal: row.scopeKey as Meal,
        windowFromMinutes: req("windowFromMinutes"),
        windowToMinutes: req("windowToMinutes"),
        minAwayMinutes: n("minAwayMinutes"),
      };
    case "meal_disqualifier":
      return {
        ...q,
        kind: "meal_disqualifier",
        meal: row.scopeKey as Meal,
        departedAfterMinutes: req("departedAfterMinutes"),
      };
    case "dormitory":
      return {
        ...q,
        kind: "dormitory",
        arrivalFromMinutes: req("arrivalFromMinutes"),
        arrivalToMinutes: req("arrivalToMinutes"),
        amountPaise: req("amountPaise"),
        replacesMeals: v.replacesMeals !== false,
      };
    case "lodging":
      return {
        ...q,
        kind: "lodging",
        maxPerNightPaise: req("maxPerNightPaise"),
        dayUseAllowed: v.dayUseAllowed === true,
      };
    case "proof_threshold":
      return { ...q, kind: "proof_threshold", scopeKey: row.scopeKey || "*", atPaise: req("atPaise") };
    case "approval_route":
      return {
        ...q,
        kind: "approval_route",
        autoApproveUpToPaise: req("autoApproveUpToPaise"),
        escalateAboveDayTotalPaise: n("escalateAboveDayTotalPaise"),
        escalateOnSeverity: (v.escalateOnSeverity as "warn" | "block_route" | null) ?? null,
      };
    case "exception_bands":
      return {
        ...q,
        kind: "exception_bands",
        dailyKmCeiling: n("dailyKmCeiling"),
        ownSpendBandBps: n("ownSpendBandBps"),
        teamSpendBandBps: n("teamSpendBandBps"),
      };
    default:
      return null;
  }
}

function modeOf(scopeKey: string): string {
  return scopeKey.startsWith("travel_mode:") ? scopeKey.slice("travel_mode:".length) : scopeKey;
}

/* ------------------------------------------------------------- sentences */

export function rupeesOf(paise: number): string {
  const whole = paise / 100;
  return `₹${(Number.isInteger(whole) ? whole : Number(whole.toFixed(2))).toLocaleString("en-IN")}`;
}

export function clockOf(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const humanMode = (key: string) => key.replace(/^travel_mode:/, "").replace(/_/g, " ");
const humanCategory = (key: string) => key.replace(/^category:/, "").replace(/_/g, " ");

/**
 * The rule in one sentence.
 *
 * This is what makes requirement 4 possible. A verifier handed a table of
 * `valueJson` blobs has not verified anything; a verifier handed "Own bike is
 * paid ₹3.50 a kilometre" can hold it against the document HR issued.
 */
export function describeRule(rule: PolicyRule): string {
  switch (rule.kind) {
    case "per_km":
      return `${humanMode(rule.modeKey)} is paid ${rupeesOf(rule.paisePerKm)} a kilometre${
        rule.dailyKmCap !== null ? `, up to ${rule.dailyKmCap} km in a day` : ""
      }.`;
    case "actuals": {
      const what = rule.scopeKey.startsWith("travel_mode:")
        ? humanMode(rule.scopeKey)
        : humanCategory(rule.scopeKey);
      if (rule.capPerInstancePaise === null && rule.capPerDayPaise === null) {
        return `${what} is paid what it cost, with no limit.`;
      }
      const parts: string[] = [];
      if (rule.capPerInstancePaise !== null) parts.push(`${rupeesOf(rule.capPerInstancePaise)} for one claim`);
      if (rule.capPerDayPaise !== null) parts.push(`${rupeesOf(rule.capPerDayPaise)} in a day`);
      return `${what} is paid what it cost, up to ${parts.join(" and ")}.`;
    }
    case "zero_rated":
      return `${humanMode(rule.modeKey)} is recorded and pays nothing.`;
    case "km_source":
      return `${rule.modeKey === null ? "Distance" : `Distance on ${humanMode(rule.modeKey)}`} is taken from the ${rule.precedence.join(", then the ")}, and flagged where two of them disagree by more than ${rule.varianceFlagBps / 100}%.`;
    case "odometer_photo":
      switch (rule.when) {
        case "always":
          return `Every ${rule.modeKey === null ? "leg" : humanMode(rule.modeKey) + " leg"} needs a photograph of the odometer.`;
        case "random":
          return `${rule.randomPct}% of legs are asked for a photograph of the odometer, drawn in the office.`;
        case "on_variance":
          return "A photograph of the odometer is asked for where the reading and the day's track disagree.";
        default:
          return "No photograph of the odometer is asked for.";
      }
    case "meal_rate":
      return `${rule.meal[0]!.toUpperCase()}${rule.meal.slice(1)} is worth ${rupeesOf(rule.amountPaise)}.`;
    case "meal_entitlement":
      return `${rule.meal[0]!.toUpperCase()}${rule.meal.slice(1)} is earned by being away between ${clockOf(rule.windowFromMinutes)} and ${clockOf(rule.windowToMinutes)}${
        rule.minAwayMinutes !== null ? `, and away at least ${Math.round(rule.minAwayMinutes / 60)} hours` : ""
      }.`;
    case "meal_disqualifier":
      return `${rule.meal[0]!.toUpperCase()}${rule.meal.slice(1)} is not paid to anybody leaving after ${clockOf(rule.departedAfterMinutes)}.`;
    case "dormitory":
      return `Arriving overnight between ${clockOf(rule.arrivalFromMinutes)} and ${clockOf(rule.arrivalToMinutes)} with no hotel is worth ${rupeesOf(rule.amountPaise)}${
        rule.replacesMeals ? ", instead of the day's meals" : ", on top of the day's meals"
      }.`;
    case "lodging":
      return `A hotel night is allowed up to ${rupeesOf(rule.maxPerNightPaise)}${
        rule.dayUseAllowed ? ", and a daytime room is reimbursed too" : ". A room with no night in it pays nothing"
      }.`;
    case "proof_threshold":
      return `${rule.scopeKey === "*" ? "Anything" : rule.scopeKey.startsWith("travel_mode:") ? humanMode(rule.scopeKey) : humanCategory(rule.scopeKey)} at or above ${rupeesOf(rule.atPaise)} needs a bill or a ticket.`;
    case "approval_route": {
      const bits = [
        `A day within policy under ${rupeesOf(rule.autoApproveUpToPaise)} is approved on submission`,
      ];
      if (rule.escalateAboveDayTotalPaise !== null) {
        bits.push(`a day of ${rupeesOf(rule.escalateAboveDayTotalPaise)} or more also reaches the owner`);
      }
      if (rule.escalateOnSeverity !== null) {
        bits.push(
          rule.escalateOnSeverity === "warn"
            ? "anything questioned also reaches the owner"
            : "anything missing its proof also reaches the owner",
        );
      }
      return `${bits.join("; ")}. Everything else waits for a manager.`;
    }
    case "exception_bands": {
      const bits: string[] = [];
      if (rule.dailyKmCeiling !== null) bits.push(`a day over ${rule.dailyKmCeiling} km`);
      if (rule.ownSpendBandBps !== null) bits.push(`spending ${rule.ownSpendBandBps / 100}% above his own average`);
      if (rule.teamSpendBandBps !== null) bits.push(`spending ${rule.teamSpendBandBps / 100}% above the team's`);
      return bits.length ? `Questioned: ${bits.join(", ")}.` : "Nothing is questioned automatically.";
    }
  }
}

/** Who a rule applies to, in words. Empty string where it applies to everybody. */
export function describeQualifier(
  rule: { grade: string | null; cityClass: string | null },
  gradeLabel: (key: string) => string,
): string {
  const bits: string[] = [];
  if (rule.grade) bits.push(gradeLabel(rule.grade));
  if (rule.cityClass) bits.push(`${rule.cityClass} cities`);
  return bits.join(", in ");
}

/** Every rule kind is specified. A kind with no form is a kind nobody can set. */
export function unspecifiedKinds(): string[] {
  return POLICY_RULE_KINDS.filter((k) => !RULE_KINDS.some((s) => s.kind === k));
}
