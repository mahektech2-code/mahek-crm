import type { PolicyRule, PolicyRuleKind } from "@/lib/engines/expense-policy";
import { parseRule, ruleSpec, validateRule, type RuleDraft } from "@/lib/expense-rule-forms";

/* ---------------------------------------------------------------------------
 * Named expense policies — the rules as the editor holds them, and the check
 * a list of them has to pass before it is saved.
 *
 * PURE and client-safe. The editor runs `checkRules` on every keystroke to
 * mark the field that is wrong; `savePolicySet` runs the same function before
 * it writes, because a server action is a URL and a form is not a check.
 *
 * The editor works on `RuleDraft`s — the old builder's shape, canonical units
 * (paise, minutes since midnight, basis points) — and the database stores the
 * engine's `PolicyRule[]`. `ruleToDraft` and `parseRule` are the two crossings
 * and there are no others.
 * ------------------------------------------------------------------------- */

export type { RuleDraft };

/** A rule as the engine holds it, back into the form the editor edits. */
export function ruleToDraft(rule: PolicyRule): RuleDraft {
  const q = { grade: rule.grade, cityClass: rule.cityClass };
  switch (rule.kind) {
    case "per_km":
      return {
        ...q,
        kind: rule.kind,
        scopeKey: rule.modeKey,
        value: { paisePerKm: rule.paisePerKm, dailyKmCap: rule.dailyKmCap },
      };
    case "actuals":
      return {
        ...q,
        kind: rule.kind,
        scopeKey: rule.scopeKey,
        value: { capPerInstancePaise: rule.capPerInstancePaise, capPerDayPaise: rule.capPerDayPaise },
      };
    case "zero_rated":
      return { ...q, kind: rule.kind, scopeKey: rule.modeKey, value: {} };
    case "km_source":
      return {
        ...q,
        kind: rule.kind,
        scopeKey: rule.modeKey ?? "*",
        value: { precedence: [...rule.precedence], varianceFlagBps: rule.varianceFlagBps },
      };
    case "odometer_photo":
      return {
        ...q,
        kind: rule.kind,
        scopeKey: rule.modeKey ?? "*",
        value: { when: rule.when, randomPct: rule.randomPct },
      };
    case "meal_rate":
      return { ...q, kind: rule.kind, scopeKey: rule.meal, value: { amountPaise: rule.amountPaise } };
    case "meal_entitlement":
      return {
        ...q,
        kind: rule.kind,
        scopeKey: rule.meal,
        value: {
          windowFromMinutes: rule.windowFromMinutes,
          windowToMinutes: rule.windowToMinutes,
          minAwayMinutes: rule.minAwayMinutes,
        },
      };
    case "meal_disqualifier":
      return { ...q, kind: rule.kind, scopeKey: rule.meal, value: { departedAfterMinutes: rule.departedAfterMinutes } };
    case "dormitory":
      return {
        ...q,
        kind: rule.kind,
        scopeKey: "",
        value: {
          arrivalFromMinutes: rule.arrivalFromMinutes,
          arrivalToMinutes: rule.arrivalToMinutes,
          amountPaise: rule.amountPaise,
          replacesMeals: rule.replacesMeals,
        },
      };
    case "lodging":
      return {
        ...q,
        kind: rule.kind,
        scopeKey: "",
        value: { maxPerNightPaise: rule.maxPerNightPaise, dayUseAllowed: rule.dayUseAllowed },
      };
    case "proof_threshold":
      return { ...q, kind: rule.kind, scopeKey: rule.scopeKey, value: { atPaise: rule.atPaise } };
    case "approval_route":
      return {
        ...q,
        kind: rule.kind,
        scopeKey: "",
        value: {
          autoApproveUpToPaise: rule.autoApproveUpToPaise,
          escalateAboveDayTotalPaise: rule.escalateAboveDayTotalPaise,
          escalateOnSeverity: rule.escalateOnSeverity,
        },
      };
    case "exception_bands":
      return {
        ...q,
        kind: rule.kind,
        scopeKey: "",
        value: {
          dailyKmCeiling: rule.dailyKmCeiling,
          ownSpendBandBps: rule.ownSpendBandBps,
          teamSpendBandBps: rule.teamSpendBandBps,
        },
      };
  }
}

/** Read a stored `rules` column. Anything this release cannot read is counted, never thrown on. */
export function readStoredRules(stored: unknown): { rules: PolicyRule[]; unreadable: number } {
  const list = Array.isArray(stored) ? stored : [];
  const rules: PolicyRule[] = [];
  let unreadable = 0;
  for (const raw of list) {
    const r = raw as Partial<PolicyRule> & { kind?: string };
    if (!r || typeof r !== "object" || typeof r.kind !== "string" || !ruleSpec(r.kind)) {
      unreadable++;
      continue;
    }
    /* Round-trip through the draft so a stored row missing a field reads the
       same way the old `valueJson` reader read it, not as `undefined`. */
    try {
      const draft = ruleToDraft({ grade: null, cityClass: null, ...r } as PolicyRule);
      const parsed = parseRule({ ...draft, valueJson: draft.value });
      if (parsed) rules.push(parsed);
      else unreadable++;
    } catch {
      unreadable++;
    }
  }
  return { rules, unreadable };
}

/* ------------------------------------------------------------ the check */

export type RuleError = { index: number; field: string; message: string };

const TRAVEL_PREFIX = "travel_mode:";
const CATEGORY_PREFIX = "category:";

/** What a rule's scope names, on the KEY the uniqueness check compares. */
function identity(d: RuleDraft): string {
  return [d.kind, d.scopeKey, d.grade ?? "", d.cityClass ?? ""].join("|");
}

/**
 * Whether a list of rules can be saved, and every reason it cannot.
 *
 * Each rule is checked by `validateRule` — the per-kind checks the builder
 * always ran — and then the list as a whole: two rules answering the same
 * question for the same people is an ambiguous policy, and the engine would
 * quietly take the later one, so it is refused here with both named.
 */
export function checkRules(drafts: readonly RuleDraft[]): { rules: PolicyRule[]; errors: RuleError[] } {
  const errors: RuleError[] = [];
  const rules: PolicyRule[] = [];
  const seen = new Map<string, number>();

  drafts.forEach((d, index) => {
    const draft: RuleDraft = {
      ...d,
      scopeKey: (d.scopeKey ?? "").trim(),
      grade: d.grade || null,
      cityClass: d.cityClass || null,
    };
    for (const e of validateRule(draft)) errors.push({ index, ...e });

    if (
      draft.kind === "actuals" &&
      !draft.scopeKey.startsWith(TRAVEL_PREFIX) &&
      !draft.scopeKey.startsWith(CATEGORY_PREFIX)
    ) {
      errors.push({ index, field: "scopeKey", message: "Pick the travel mode or the kind of bill this limit is for." });
    }
    if (
      draft.kind === "proof_threshold" &&
      draft.scopeKey !== "*" &&
      !draft.scopeKey.startsWith(TRAVEL_PREFIX) &&
      !draft.scopeKey.startsWith(CATEGORY_PREFIX)
    ) {
      errors.push({ index, field: "scopeKey", message: "Pick everything, a travel mode or a kind of bill." });
    }
    if (
      (draft.kind === "per_km" || draft.kind === "zero_rated") &&
      (draft.scopeKey === "*" || draft.scopeKey.includes(":"))
    ) {
      errors.push({ index, field: "scopeKey", message: "Pick the vehicle this rate is for." });
    }

    const key = identity(draft);
    const first = seen.get(key);
    if (first !== undefined) {
      errors.push({
        index,
        field: "scopeKey",
        message: `This repeats rule ${first + 1} for the same people — two answers to one question. Change who it applies to, or remove one.`,
      });
    } else {
      seen.set(key, index);
    }

    const parsed = parseRule({ ...draft, valueJson: draft.value });
    if (parsed) rules.push(parsed);
  });

  return { rules, errors };
}

/**
 * What a policy is MISSING — said, never refused. A policy with no hotel
 * ceiling is a legitimate choice for a team that never stays over, and the
 * engine already raises `unpriced_lodging` on the night it matters.
 */
export function policyGaps(rules: readonly PolicyRule[]): string[] {
  const has = (k: PolicyRuleKind) => rules.some((r) => r.kind === k);
  const gaps: string[] = [];
  if (!has("per_km")) gaps.push("No vehicle is paid per kilometre, so own-vehicle trips earn nothing.");
  if (!has("meal_rate")) gaps.push("No meal is priced, so nobody earns a meal allowance.");
  if (has("meal_rate") && !has("meal_entitlement"))
    gaps.push("Meals are priced but no meal says when it is earned, so none ever is.");
  if (!has("lodging")) gaps.push("No hotel ceiling — every hotel night is flagged as unpriced.");
  if (!has("km_source")) gaps.push("No rule says which kilometres count.");
  if (!has("proof_threshold")) gaps.push("No bill or ticket photo is ever required.");
  return gaps;
}

/* ------------------------------------------------------------- sections */

export type RuleSectionKey = "travel" | "distance" | "meals" | "hotel" | "bills" | "approval";

export const RULE_SECTIONS: readonly {
  key: RuleSectionKey;
  title: string;
  blurb: string;
  /** The rule kinds a person may add in this section. */
  kinds: readonly PolicyRuleKind[];
}[] = [
  {
    key: "travel",
    title: "Travel",
    blurb: "How each way of getting about is paid: per kilometre, at the ticket price, or not at all.",
    kinds: ["per_km", "actuals", "zero_rated"],
  },
  {
    key: "distance",
    title: "Kilometres & checks",
    blurb: "Which distance is paid on, when a meter photo is asked for, and what counts as an unusual day.",
    kinds: ["km_source", "odometer_photo", "exception_bands"],
  },
  {
    key: "meals",
    title: "Meals",
    blurb: "What each meal is worth, when it is earned, who loses it for a late start, and the overnight morning.",
    kinds: ["meal_rate", "meal_entitlement", "meal_disqualifier", "dormitory"],
  },
  {
    key: "hotel",
    title: "Hotel",
    blurb: "The most a night may cost, and whether a daytime room counts.",
    kinds: ["lodging"],
  },
  {
    key: "bills",
    title: "Other bills",
    blurb: "Food, local transport and anything else logged as an expense — paid what it cost, up to a limit.",
    kinds: ["actuals"],
  },
  {
    key: "approval",
    title: "Proof & approval",
    blurb: "When a bill or ticket photo is compulsory, and the approval limits.",
    kinds: ["proof_threshold", "approval_route"],
  },
];

/** Which section of the editor a rule is drawn in. */
export function sectionOf(d: { kind: string; scopeKey: string }): RuleSectionKey {
  switch (d.kind) {
    case "per_km":
    case "zero_rated":
      return "travel";
    case "actuals":
      return d.scopeKey.startsWith(CATEGORY_PREFIX) ? "bills" : "travel";
    case "km_source":
    case "odometer_photo":
    case "exception_bands":
      return "distance";
    case "meal_rate":
    case "meal_entitlement":
    case "meal_disqualifier":
    case "dormitory":
      return "meals";
    case "lodging":
      return "hotel";
    default:
      return "approval";
  }
}

/** A fresh rule of a kind, with sensible starting figures, for "Add a rule". */
export function blankRule(kind: PolicyRuleKind, section: RuleSectionKey): RuleDraft {
  const q = { grade: null, cityClass: null };
  switch (kind) {
    case "per_km":
      return { ...q, kind, scopeKey: "", value: { paisePerKm: 0, dailyKmCap: null } };
    case "actuals":
      return {
        ...q,
        kind,
        scopeKey: section === "bills" ? "category:other" : "",
        value: { capPerInstancePaise: null, capPerDayPaise: null },
      };
    case "zero_rated":
      return { ...q, kind, scopeKey: "", value: {} };
    case "km_source":
      return { ...q, kind, scopeKey: "*", value: { precedence: ["odometer", "gps", "manual"], varianceFlagBps: 2500 } };
    case "odometer_photo":
      return { ...q, kind, scopeKey: "*", value: { when: "on_variance", randomPct: 0 } };
    case "meal_rate":
      return { ...q, kind, scopeKey: "breakfast", value: { amountPaise: 0 } };
    case "meal_entitlement":
      return {
        ...q,
        kind,
        scopeKey: "breakfast",
        value: { windowFromMinutes: 360, windowToMinutes: 600, minAwayMinutes: null },
      };
    case "meal_disqualifier":
      return { ...q, kind, scopeKey: "breakfast", value: { departedAfterMinutes: 480 } };
    case "dormitory":
      return {
        ...q,
        kind,
        scopeKey: "",
        value: { arrivalFromMinutes: 360, arrivalToMinutes: 600, amountPaise: 0, replacesMeals: true },
      };
    case "lodging":
      return { ...q, kind, scopeKey: "", value: { maxPerNightPaise: 0, dayUseAllowed: false } };
    case "proof_threshold":
      return { ...q, kind, scopeKey: "*", value: { atPaise: 0 } };
    case "approval_route":
      return {
        ...q,
        kind,
        scopeKey: "",
        value: { autoApproveUpToPaise: 0, escalateAboveDayTotalPaise: null, escalateOnSeverity: null },
      };
    case "exception_bands":
      return {
        ...q,
        kind,
        scopeKey: "",
        value: { dailyKmCeiling: null, ownSpendBandBps: null, teamSpendBandBps: null },
      };
  }
}

/* ------------------------------------------------------------- the diff */

/** How two rule lists differ, in counts — for the save confirmation and the history. */
export function diffRules(
  before: readonly RuleDraft[],
  after: readonly RuleDraft[],
): { added: number; removed: number; changed: number } {
  const key = (d: RuleDraft) => identity({ ...d, grade: d.grade || null, cityClass: d.cityClass || null });
  const b = new Map(before.map((d) => [key(d), JSON.stringify(d.value)]));
  const a = new Map(after.map((d) => [key(d), JSON.stringify(d.value)]));
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const [k, v] of a) {
    if (!b.has(k)) added++;
    else if (b.get(k) !== v) changed++;
  }
  for (const k of b.keys()) if (!a.has(k)) removed++;
  return { added, removed, changed };
}
