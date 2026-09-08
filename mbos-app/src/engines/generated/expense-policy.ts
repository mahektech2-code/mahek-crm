/* GENERATED FILE — DO NOT EDIT.
 * Copied from src/lib/engines/expense-policy.ts by scripts/sync-mbos-engines.mjs.
 * Edit the source and run `npm run mbos:sync-engines`. A stale copy fails
 * the test suite in both projects, which is the point: the handset and the
 * office must never disagree about what a day is worth.
 */
/* ---------------------------------------------------------------------------
 * E11 — the expense policy engine.
 *
 * What a day of travelling is worth, according to the policy that was in force
 * on the day it happened. Pure: no clock, no database, no configuration read.
 * Everything arrives as an argument, which is what lets the same function run
 * on the handset in a market with no signal and on the server an hour later
 * and produce the same rupee.
 *
 * **This file is the whole of "policy-driven, not code-driven".** Every rate,
 * every limit, every time of day and every condition below arrives inside a
 * `Policy` that was typed on a screen. There is not one reimbursement number
 * in this file, and there must never be: a number here is a number a manager
 * cannot change, which is the one thing the client asked for.
 *
 * **The rule vocabulary is CLOSED.** Thirteen kinds, each with its own shape
 * and its own branch. The tempting alternative — a formula the admin types —
 * is a second programming language inside MahekOne: unreviewable, untestable,
 * and one stray character from paying a whole team nothing. A closed
 * vocabulary is the trade, and adding a fourteenth kind is a code change, on
 * purpose: a rule shape nobody has designed a form for is a rule shape nobody
 * has designed a validation for either.
 *
 * The engine never REFUSES anything. It computes what is eligible and it
 * raises exceptions; whether a claim is paid is a person's decision, taken on
 * a different screen. The money is already spent, and a system that refuses to
 * record it has not saved the money — it has only made sure nobody finds out.
 * ------------------------------------------------------------------------- */

/* ------------------------------------------------------------- vocabulary */

export const MEALS = ["breakfast", "lunch", "dinner"] as const;
export type Meal = (typeof MEALS)[number];

export const KM_SOURCES = ["odometer", "gps", "manual"] as const;
export type KmSource = (typeof KM_SOURCES)[number];

export const EXPENSE_KINDS = [
  "travel",
  "food",
  "lodging",
  "local_transport",
  "other",
] as const;
export type ExpenseKind = (typeof EXPENSE_KINDS)[number];

export const POLICY_RULE_KINDS = [
  "per_km",
  "actuals",
  "zero_rated",
  "km_source",
  "odometer_photo",
  "meal_rate",
  "meal_entitlement",
  "meal_disqualifier",
  "dormitory",
  "lodging",
  "proof_threshold",
  "approval_route",
  "exception_bands",
] as const;
export type PolicyRuleKind = (typeof POLICY_RULE_KINDS)[number];

/**
 * The qualifier every rule may carry.
 *
 * **Requirements 7 and 8 are answered HERE rather than by assigning a whole
 * policy per grade and city.** A real expense policy is one document with a
 * table of hotel limits in it, not twelve documents; and twelve policies is
 * twelve places to edit the day the fuel rate moves, eleven of which somebody
 * will forget. So one version carries the variation inside it.
 *
 * Null means "any". The most specific matching rule wins, and a grade match
 * outranks a city match — grade is a fact about the person and city is a fact
 * about the trip, and where a policy states both it means the person's grade
 * to be the stronger word.
 */
export type RuleQualifier = {
  grade: string | null;
  cityClass: string | null;
};

type Q = RuleQualifier;

export type PerKmRule = Q & {
  kind: "per_km";
  modeKey: string;
  paisePerKm: number;
  /** Kilometres. Beyond this the day's own-vehicle KM stops earning. */
  dailyKmCap: number | null;
};

export type ActualsRule = Q & {
  kind: "actuals";
  /** `travel_mode:bus`, `category:local_transport`, `category:other`. */
  scopeKey: string;
  capPerInstancePaise: number | null;
  capPerDayPaise: number | null;
};

/** Recorded, never reimbursed — a customer's vehicle, and walking. */
export type ZeroRatedRule = Q & { kind: "zero_rated"; modeKey: string };

export type KmSourceRule = Q & {
  kind: "km_source";
  /** Null applies to every mode not named by a rule of its own. */
  modeKey: string | null;
  precedence: readonly KmSource[];
  /** Basis points. GPS against odometer beyond this is an exception. */
  varianceFlagBps: number;
};

export type OdometerPhotoRule = Q & {
  kind: "odometer_photo";
  modeKey: string | null;
  when: "always" | "random" | "on_variance" | "never";
  /** Only read where `when` is `random`. The DRAW is made server-side. */
  randomPct: number;
};

/**
 * What one meal is worth.
 *
 * **Per meal, never per combination**, and the client's own figures are what
 * settles it: ₹100 breakfast, ₹250 breakfast and lunch, ₹450 all three. Those
 * decompose exactly — 100, 150, 200 — so storing the three totals would be
 * storing the same three numbers twice, and the copies would disagree the
 * first time somebody raised lunch. It is also the only model in which
 * requirement 28 has an answer: dropping breakfast from a ₹250 combination
 * needs breakfast to have a price of its own.
 */
export type MealRateRule = Q & { kind: "meal_rate"; meal: Meal; amountPaise: number };

/**
 * When a meal is earned: he was away across the window it belongs to.
 * Minutes since local midnight; `windowTo` may exceed 1440 for a late dinner.
 */
export type MealEntitlementRule = Q & {
  kind: "meal_entitlement";
  meal: Meal;
  windowFromMinutes: number;
  windowToMinutes: number;
  /** An additional gate. Null means the window alone decides. */
  minAwayMinutes: number | null;
};

/** Requirement 28: left home after this, and that meal is not earned. */
export type MealDisqualifierRule = Q & {
  kind: "meal_disqualifier";
  meal: Meal;
  departedAfterMinutes: number;
};

/**
 * Requirement 29 — the dormitory morning.
 *
 * `replacesMeals` is true by default and the client's own number is why: ₹250
 * is exactly breakfast plus lunch, so it is plainly the meal allowance for
 * that morning rather than a payment on top of it. Paying both would be ₹500
 * for a morning the policy prices at ₹250.
 */
export type DormitoryRule = Q & {
  kind: "dormitory";
  arrivalFromMinutes: number;
  arrivalToMinutes: number;
  amountPaise: number;
  replacesMeals: boolean;
};

export type LodgingRule = Q & {
  kind: "lodging";
  maxPerNightPaise: number;
  /** Requirement 32 — a daytime room with no night in it is worth nothing. */
  dayUseAllowed: boolean;
};

/** Requirement 37 — at or above this, proof is not optional. */
export type ProofThresholdRule = Q & {
  kind: "proof_threshold";
  /** `category:lodging`, `travel_mode:train`, or `*` for everything. */
  scopeKey: string;
  atPaise: number;
};

/**
 * Requirements 44 and 45 — who decides.
 *
 * `autoApproveUpToPaise` is the whole of 45: a clean day under it is approved
 * on submission with nobody's morning spent on it. A manager asked to tap
 * approve on forty ₹40 auto fares stops reading any of them, and then the one
 * claim that mattered goes through with the rest.
 */
export type ApprovalRouteRule = Q & {
  kind: "approval_route";
  autoApproveUpToPaise: number;
  /** A day at or above this reaches the owner as well as the manager. */
  escalateAboveDayTotalPaise: number | null;
  /** Any exception at this severity or worse is escalated too. */
  escalateOnSeverity: "warn" | "block_route" | null;
};

/** What counts as abnormal. Requirements 42, 48 and 49. */
export type ExceptionBandsRule = Q & {
  kind: "exception_bands";
  /** Kilometres in one day beyond which the day is questioned. */
  dailyKmCeiling: number | null;
  /** Basis points above the person's own recent median day. */
  ownSpendBandBps: number | null;
  /** Basis points above the team's median day. */
  teamSpendBandBps: number | null;
};

export type PolicyRule =
  | PerKmRule
  | ActualsRule
  | ZeroRatedRule
  | KmSourceRule
  | OdometerPhotoRule
  | MealRateRule
  | MealEntitlementRule
  | MealDisqualifierRule
  | DormitoryRule
  | LodgingRule
  | ProofThresholdRule
  | ApprovalRouteRule
  | ExceptionBandsRule;

export type Policy = {
  id: string;
  versionNo: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  rules: readonly PolicyRule[];
};

/* ------------------------------------------------------------- resolution */

/** Who is claiming, and where they were. Both may be unknown. */
export type PolicySubject = {
  grade: string | null;
  cityClass: string | null;
};

function matches(rule: RuleQualifier, subject: PolicySubject): boolean {
  if (rule.grade !== null && rule.grade !== subject.grade) return false;
  if (rule.cityClass !== null && rule.cityClass !== subject.cityClass) return false;
  return true;
}

/**
 * Grade outranks city; either outranks neither. A rule that names both is the
 * most specific thing the policy can say, so it wins outright.
 */
function specificity(rule: RuleQualifier): number {
  return (rule.grade !== null ? 2 : 0) + (rule.cityClass !== null ? 1 : 0);
}

/**
 * The rules that apply to this person on this trip, most specific first.
 *
 * Deliberately returns a LIST rather than one rule per kind: several kinds are
 * genuinely many-per-policy — one `meal_rate` per meal, one `per_km` per mode —
 * and collapsing them here would need a key this function does not know.
 */
export function rulesFor<K extends PolicyRuleKind>(
  policy: Policy,
  kind: K,
  subject: PolicySubject,
): Extract<PolicyRule, { kind: K }>[] {
  /*
   * Ties are broken by declaring LAST, not first.
   *
   * Two rules of one kind at one specificity is an ambiguous policy, and the
   * database refuses to store one — but this engine also runs on a handset,
   * over whatever came down the wire, and "the sort was stable so the first
   * one won" is not a rule anybody can predict from looking at a screen.
   * Last-wins is the reading people already have of a list of overrides, and
   * it is the one that makes an appended correction actually correct anything.
   */
  return policy.rules
    .map((r, index) => ({ r, index }))
    .filter((x): x is { r: Extract<PolicyRule, { kind: K }>; index: number } => x.r.kind === kind)
    .filter((x) => matches(x.r, subject))
    .sort((a, b) => specificity(b.r) - specificity(a.r) || b.index - a.index)
    .map((x) => x.r);
}

/**
 * The single most specific rule of a kind, narrowed further by a predicate.
 *
 * Used wherever a kind can only have one answer for one subject — the ₹/km for
 * own bike, the hotel ceiling, the approval route. Null where the policy is
 * silent, which is a real state and never an error: a mode nobody wrote a rule
 * for is a mode nobody has priced, and saying so is better than paying zero.
 */
export function ruleFor<K extends PolicyRuleKind>(
  policy: Policy,
  kind: K,
  subject: PolicySubject,
  where?: (r: Extract<PolicyRule, { kind: K }>) => boolean,
): Extract<PolicyRule, { kind: K }> | null {
  const all = rulesFor(policy, kind, subject);
  const narrowed = where ? all.filter(where) : all;
  return narrowed[0] ?? null;
}

/**
 * The statuses a version has to be in to be capable of being in force.
 *
 * `superseded` belongs here and leaving it out is the whole of the bug this
 * constant exists to make impossible. Publishing v2 flips v1 to `superseded`
 * IMMEDIATELY — at the moment somebody presses the button, not on the day the
 * new rates start — so between scheduling a revision and its effective date
 * the version actually pricing every claim carries that status. A reader that
 * asks for `published` alone answers "no policy is in force" for a month at a
 * time while the handsets are quite correctly still computing against v1.
 *
 * `draft` and `archived` are absent because neither has ever been put into
 * force, which is the difference this list is drawing.
 */
export const IN_FORCE_STATUSES = ["published", "superseded"] as const;

export type InForceStatus = (typeof IN_FORCE_STATUSES)[number];

/**
 * Is this version the authority on that date?
 *
 * ONE definition, and every caller reads it — the screens, the publish path
 * and the pricing. There were three before, they disagreed, and the two that
 * were wrong were the two a person actually looks at.
 */
export function isInForceOn(
  policy: { status: string; effectiveFrom: string; effectiveTo: string | null },
  onDate: string,
): boolean {
  if (!(IN_FORCE_STATUSES as readonly string[]).includes(policy.status)) return false;
  return coversDate(policy, onDate);
}

/** The date half of it, on its own — `policyOn` has already filtered by status. */
export function coversDate(
  range: { effectiveFrom: string; effectiveTo: string | null },
  onDate: string,
): boolean {
  return range.effectiveFrom <= onDate && (range.effectiveTo === null || range.effectiveTo >= onDate);
}

/**
 * The policy in force on a date.
 *
 * **This is requirement 6**, and it is one comparison rather than a rule
 * anybody has to remember, because a published version is immutable: an old
 * expense re-read through this function can only ever get the same answer it
 * got the first time.
 */
export function policyOn(policies: readonly Policy[], onDate: string): Policy | null {
  const covering = policies.filter((p) => coversDate(p, onDate));
  if (covering.length === 0) return null;
  /* Two published versions covering one date is refused at the database. If
     one ever arrives anyway, the LATER version wins and the caller can see the
     count — a silent pick of the older one would be the worse failure. */
  return covering.sort((a, b) => b.versionNo - a.versionNo)[0]!;
}

/* -------------------------------------------------------------- exceptions */

export const EXCEPTION_KINDS = [
  "over_cap",
  "over_km_ceiling",
  "missing_proof",
  "gps_odometer_variance",
  "manual_km_disagrees",
  "unpriced_mode",
  /**
   * An overnight hotel on a policy that names no ceiling for one.
   *
   * The sibling of `unpriced_mode`, and it was missing for the same reason it
   * matters: with no `lodging` rule the line is skipped, so the night is worth
   * NOTHING and the whole claim becomes excess — silently, where an unpriced
   * kilometre says so loudly. A salesman is out the price of a room and no
   * screen anywhere gives the office a reason to look.
   */
  "unpriced_lodging",
  "day_hotel",
  "no_policy",
  "open_day",
  "odometer_chain_broken",
  "arrival_time_disagrees",
  /**
   * This claim looks like one already recorded — requirement 47.
   *
   * Raised by `expense-fraud.ts` rather than by this engine, which has no
   * history to compare against. It is here because the exception vocabulary is
   * one vocabulary: a screen listing what a day raised should not have to know
   * which engine raised each item.
   */
  "duplicate_suspect",
  /**
   * The handset and the office worked the day out differently.
   *
   * Almost always a policy the phone had not yet pulled. Recorded rather than
   * silently resolved in the office's favour — a salesman told ₹450 and paid
   * ₹250 with nothing on any screen explaining it stops trusting the app.
   */
  "client_disagreement",
] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

export type Severity = "info" | "warn" | "block_route";

export type PolicyException = {
  kind: ExceptionKind;
  severity: Severity;
  /** A sentence somebody reads on a screen, with the numbers already in it. */
  message: string;
  detail: Record<string, number | string | null>;
  legId?: string;
  lineId?: string;
};

const SEVERITY_ORDER: Record<Severity, number> = { info: 0, warn: 1, block_route: 2 };

export function worstSeverity(exceptions: readonly PolicyException[]): Severity | null {
  let worst: Severity | null = null;
  for (const e of exceptions) {
    if (worst === null || SEVERITY_ORDER[e.severity] > SEVERITY_ORDER[worst]) worst = e.severity;
  }
  return worst;
}

/* ------------------------------------------------------------------ money */

function rupees(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
}

function km(metres: number): string {
  return `${(metres / 1000).toFixed(1)} km`;
}

/** Metres × paise-per-kilometre, kept in integers the whole way. */
function kmValue(metres: number, paisePerKm: number): number {
  return Math.round((metres * paisePerKm) / 1000);
}

/* ------------------------------------------------------------------- legs */

export type TravelLegFacts = {
  id: string;
  modeKey: string;
  gpsMetres: number | null;
  gpsCoveragePct: number | null;
  manualMetres: number | null;
  odometerMetres: number | null;
  hasOdometerPhoto: boolean;
  /** What a bus or train ticket cost. Null on an own-vehicle leg. */
  ticketAmountPaise: number | null;
  hasTicketProof: boolean;
  /** Set by the server's own draw, never by the handset. */
  odometerPhotoDemanded?: boolean;
};

export type LegComputation = {
  legId: string;
  modeKey: string;
  chosenMetres: number | null;
  chosenSource: KmSource | null;
  paisePerKm: number | null;
  claimedPaise: number;
  eligiblePaise: number;
  excessPaise: number;
  varianceBps: number | null;
  proofRequired: boolean;
  odometerPhotoRequired: boolean;
  /** Where the policy says nothing about this mode. */
  unpricedReason: string | null;
  exceptions: PolicyException[];
};

/** |a − b| ÷ max(a, b), in basis points. Null unless both are present. */
export function varianceBps(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  const top = Math.max(a, b);
  if (top <= 0) return null;
  return Math.round((Math.abs(a - b) / top) * 10_000);
}

/**
 * Which distance the money is paid on.
 *
 * The precedence is POLICY, and the shipped default is odometer → gps →
 * manual. That default is the biggest single lever on what this module costs
 * and the reasoning is in the plan: a GPS trail sampled every few minutes cuts
 * every corner and structurally UNDER-reads, so paying on it short-pays the
 * salesman who covered the most ground, permanently and invisibly. The
 * odometer is what the vehicle actually did and it can be photographed.
 */
export function chooseDistance(
  precedence: readonly KmSource[],
  candidates: { odometer: number | null; gps: number | null; manual: number | null },
): { metres: number | null; source: KmSource | null } {
  for (const source of precedence) {
    const metres = candidates[source];
    if (metres !== null && metres > 0) return { metres, source };
  }
  return { metres: null, source: null };
}

export function computeLeg(
  policy: Policy,
  subject: PolicySubject,
  leg: TravelLegFacts,
): LegComputation {
  const exceptions: PolicyException[] = [];
  const base = {
    legId: leg.id,
    modeKey: leg.modeKey,
    chosenMetres: null as number | null,
    chosenSource: null as KmSource | null,
    paisePerKm: null as number | null,
    claimedPaise: 0,
    eligiblePaise: 0,
    excessPaise: 0,
    varianceBps: varianceBps(leg.gpsMetres, leg.odometerMetres),
    proofRequired: false,
    odometerPhotoRequired: false,
    unpricedReason: null as string | null,
    exceptions,
  };

  /* ---- recorded and not reimbursed: a customer's van, and walking ---- */
  const zero = ruleFor(policy, "zero_rated", subject, (r) => r.modeKey === leg.modeKey);
  if (zero) {
    const distance = leg.odometerMetres ?? leg.gpsMetres ?? leg.manualMetres;
    return {
      ...base,
      chosenMetres: distance,
      chosenSource: distance === null ? null : leg.odometerMetres !== null ? "odometer" : leg.gpsMetres !== null ? "gps" : "manual",
      claimedPaise: 0,
      eligiblePaise: 0,
    };
  }

  /* ---- a ticket: what it actually cost, up to what the policy allows ---- */
  const actuals = ruleFor(
    policy,
    "actuals",
    subject,
    (r) => r.scopeKey === `travel_mode:${leg.modeKey}`,
  );
  if (actuals) {
    const claimed = leg.ticketAmountPaise ?? 0;
    const cap = actuals.capPerInstancePaise;
    const eligible = cap === null ? claimed : Math.min(claimed, cap);
    if (cap !== null && claimed > cap) {
      exceptions.push({
        kind: "over_cap",
        severity: "warn",
        message: `${rupees(claimed)} claimed against a ${rupees(cap)} limit for ${leg.modeKey.replace(/_/g, " ")} — ${rupees(claimed - cap)} over.`,
        detail: { claimedPaise: claimed, capPaise: cap, modeKey: leg.modeKey },
        legId: leg.id,
      });
    }
    const proofAt = proofThresholdFor(policy, subject, `travel_mode:${leg.modeKey}`);
    const proofRequired = proofAt !== null && claimed >= proofAt;
    if (proofRequired && !leg.hasTicketProof) {
      exceptions.push({
        kind: "missing_proof",
        severity: "block_route",
        message: `A ${leg.modeKey.replace(/_/g, " ")} claim of ${rupees(claimed)} needs the ticket attached.`,
        detail: { claimedPaise: claimed, thresholdPaise: proofAt, modeKey: leg.modeKey },
        legId: leg.id,
      });
    }
    return {
      ...base,
      claimedPaise: claimed,
      eligiblePaise: eligible,
      excessPaise: Math.max(0, claimed - eligible),
      proofRequired,
    };
  }

  /* ---- own vehicle: distance × rate ---- */
  const perKm = ruleFor(policy, "per_km", subject, (r) => r.modeKey === leg.modeKey);
  if (!perKm) {
    return {
      ...base,
      unpricedReason: `This policy sets no rate for ${leg.modeKey.replace(/_/g, " ")}, so the office has to price this leg by hand.`,
      exceptions: [
        ...exceptions,
        {
          kind: "unpriced_mode",
          severity: "warn",
          message: `Policy version ${policy.versionNo} names no rate for ${leg.modeKey.replace(/_/g, " ")}.`,
          detail: { modeKey: leg.modeKey, policyVersion: policy.versionNo },
          legId: leg.id,
        },
      ],
    };
  }

  const source = ruleFor(
    policy,
    "km_source",
    subject,
    (r) => r.modeKey === leg.modeKey || r.modeKey === null,
  );
  const precedence = source?.precedence ?? (["odometer", "gps", "manual"] as const);
  const { metres, source: chosenSource } = chooseDistance(precedence, {
    odometer: leg.odometerMetres,
    gps: leg.gpsMetres,
    manual: leg.manualMetres,
  });

  const variance = varianceBps(leg.gpsMetres, leg.odometerMetres);
  if (source && variance !== null && variance > source.varianceFlagBps) {
    exceptions.push({
      kind: "gps_odometer_variance",
      severity: "warn",
      message: `The odometer says ${km(leg.odometerMetres!)} and the day's track says ${km(leg.gpsMetres!)} — ${(variance / 100).toFixed(0)}% apart.`,
      detail: {
        odometerMetres: leg.odometerMetres,
        gpsMetres: leg.gpsMetres,
        varianceBps: variance,
        bandBps: source.varianceFlagBps,
      },
      legId: leg.id,
    });
  }

  /* A typed figure standing against a measured one is worth a question, and
     it is a DIFFERENT question to the one above: that one asks whether the
     odometer was read correctly, this one asks why a number was typed at all
     on a leg the phone was watching. */
  if (chosenSource === "manual" && leg.gpsMetres !== null) {
    const v = varianceBps(leg.manualMetres, leg.gpsMetres);
    if (v !== null && source && v > source.varianceFlagBps) {
      exceptions.push({
        kind: "manual_km_disagrees",
        severity: "warn",
        message: `${km(leg.manualMetres!)} was entered by hand on a leg the day's track measured at ${km(leg.gpsMetres!)}.`,
        detail: { manualMetres: leg.manualMetres, gpsMetres: leg.gpsMetres, varianceBps: v },
        legId: leg.id,
      });
    }
  }

  const photoRule = ruleFor(
    policy,
    "odometer_photo",
    subject,
    (r) => r.modeKey === leg.modeKey || r.modeKey === null,
  );
  const photoRequired =
    photoRule === null || photoRule.when === "never"
      ? false
      : photoRule.when === "always"
        ? true
        : photoRule.when === "on_variance"
          ? variance !== null && source !== null && variance > source.varianceFlagBps
          : /* random */ leg.odometerPhotoDemanded === true;

  if (photoRequired && !leg.hasOdometerPhoto) {
    exceptions.push({
      kind: "missing_proof",
      severity: "warn",
      message: `This leg needs a photograph of the odometer${photoRule?.when === "on_variance" ? " — the reading and the track disagree" : ""}.`,
      detail: { modeKey: leg.modeKey, when: photoRule?.when ?? null },
      legId: leg.id,
    });
  }

  const eligible = metres === null ? 0 : kmValue(metres, perKm.paisePerKm);
  return {
    ...base,
    chosenMetres: metres,
    chosenSource,
    paisePerKm: perKm.paisePerKm,
    claimedPaise: eligible,
    eligiblePaise: eligible,
    varianceBps: variance,
    odometerPhotoRequired: photoRequired,
    unpricedReason:
      metres === null
        ? "No distance was recorded for this leg — GPS, odometer or a figure entered by hand."
        : null,
  };
}

function proofThresholdFor(
  policy: Policy,
  subject: PolicySubject,
  scopeKey: string,
): number | null {
  const exact = ruleFor(policy, "proof_threshold", subject, (r) => r.scopeKey === scopeKey);
  if (exact) return exact.atPaise;
  const wildcard = ruleFor(policy, "proof_threshold", subject, (r) => r.scopeKey === "*");
  return wildcard?.atPaise ?? null;
}

/* ------------------------------------------------------- food and lodging */

/**
 * When the salesman was away, in minutes since local midnight on the day.
 *
 * **Minutes, not instants, and that is deliberate.** A meal window is a wall
 * clock — "breakfast is before eight" — and comparing a wall clock to a stored
 * instant needs a timezone, which is the single most expensive class of bug in
 * this codebase. The conversion happens once, in `business-date.ts`, where the
 * zone is named; this engine sees numbers and cannot get it wrong.
 *
 * `returnedMinutes` may exceed 1440 — an overnight return is 26:30, not 02:30
 * the day before.
 */
export type DayClock = {
  departedMinutes: number | null;
  returnedMinutes: number | null;
  arrivedAtDestinationMinutes: number | null;
};

export type ExpenseLineFacts = {
  id: string;
  kind: ExpenseKind;
  claimedPaise: number;
  hasProof: boolean;
  /** Lodging only: nights. A day room is 0 and requirement 32 is about it. */
  nights?: number;
};

export type DayFacts = {
  day: string;
  clock: DayClock;
  departedFromHometown: boolean;
  stayedInHotel: boolean;
  overnight: boolean;
  legs: readonly TravelLegFacts[];
  lines: readonly ExpenseLineFacts[];
};

export type MealComputation = {
  meal: Meal;
  earned: boolean;
  amountPaise: number;
  /** Why not, in words, where it was not earned. */
  withheldReason: string | null;
};

export type DayComputation = {
  day: string;
  policyId: string;
  policyVersionNo: number;
  legs: LegComputation[];
  meals: MealComputation[];
  dormitoryPaise: number;
  dormitoryApplied: boolean;
  foodPaise: number;
  travelPaise: number;
  lodgingClaimedPaise: number;
  lodgingEligiblePaise: number;
  otherClaimedPaise: number;
  otherEligiblePaise: number;
  totalClaimedPaise: number;
  totalEligiblePaise: number;
  totalExcessPaise: number;
  totalMetres: number;
  exceptions: PolicyException[];
};

function overlaps(a1: number, a2: number, b1: number, b2: number): boolean {
  return Math.max(a1, b1) < Math.min(a2, b2);
}

export function computeMeals(
  policy: Policy,
  subject: PolicySubject,
  day: DayFacts,
): MealComputation[] {
  const { departedMinutes, returnedMinutes } = day.clock;
  const rates = rulesFor(policy, "meal_rate", subject);

  return MEALS.map((meal): MealComputation => {
    const rate = rates.find((r) => r.meal === meal);
    const amount = rate?.amountPaise ?? 0;
    const none = (reason: string): MealComputation => ({
      meal,
      earned: false,
      amountPaise: 0,
      withheldReason: reason,
    });

    if (!rate) return none(`This policy sets no ${meal} allowance.`);
    if (departedMinutes === null) return none("The day was never opened.");

    const entitlement = ruleFor(policy, "meal_entitlement", subject, (r) => r.meal === meal);
    if (!entitlement) return none(`This policy says nothing about when ${meal} is earned.`);

    const awayTo = returnedMinutes ?? 24 * 60;
    if (!overlaps(departedMinutes, awayTo, entitlement.windowFromMinutes, entitlement.windowToMinutes)) {
      return none(`He was not away over ${meal}.`);
    }

    if (entitlement.minAwayMinutes !== null && awayTo - departedMinutes < entitlement.minAwayMinutes) {
      return none(
        `Away ${Math.round((awayTo - departedMinutes) / 60)} hours, and ${meal} needs ${Math.round(entitlement.minAwayMinutes / 60)}.`,
      );
    }

    /* Requirement 28 — and it is deliberately NOT the same test as the window
       above. The window asks whether he was away when the meal happens; this
       asks when he LEFT, which is the question the client's policy actually
       poses, and the two differ on a trip that started yesterday. */
    const disqualifier = ruleFor(policy, "meal_disqualifier", subject, (r) => r.meal === meal);
    if (disqualifier && departedMinutes > disqualifier.departedAfterMinutes) {
      return none(
        `He left at ${clockOf(departedMinutes)} and ${meal} is not paid to anybody leaving after ${clockOf(disqualifier.departedAfterMinutes)}.`,
      );
    }

    return { meal, earned: true, amountPaise: amount, withheldReason: null };
  });
}

function clockOf(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/* -------------------------------------------------------------- the whole */

export function computeDay(
  policy: Policy,
  subject: PolicySubject,
  day: DayFacts,
): DayComputation {
  const exceptions: PolicyException[] = [];

  if (day.clock.departedMinutes !== null && day.clock.returnedMinutes === null) {
    exceptions.push({
      kind: "open_day",
      severity: "info",
      message: "The day has not been closed, so the allowances are worked out as far as midnight.",
      detail: { day: day.day },
    });
  }

  const legs = day.legs.map((leg) => computeLeg(policy, subject, leg));
  for (const l of legs) exceptions.push(...l.exceptions);

  const travelPaise = legs.reduce((n, l) => n + l.eligiblePaise, 0);
  const travelClaimed = legs.reduce((n, l) => n + l.claimedPaise, 0);
  const totalMetres = legs.reduce((n, l) => n + (l.chosenMetres ?? 0), 0);

  /* ---- the day's own KM ceiling ---- */
  const bands = ruleFor(policy, "exception_bands", subject);
  if (bands?.dailyKmCeiling != null && totalMetres > bands.dailyKmCeiling * 1000) {
    exceptions.push({
      kind: "over_km_ceiling",
      severity: "warn",
      message: `${km(totalMetres)} in one day, against a ${bands.dailyKmCeiling} km ceiling.`,
      detail: { totalMetres, ceilingKm: bands.dailyKmCeiling },
    });
  }

  /* ---- food ---- */
  const meals = computeMeals(policy, subject, day);

  const dorm = ruleFor(policy, "dormitory", subject);
  const arrived = day.clock.arrivedAtDestinationMinutes;
  const dormitoryApplied =
    dorm !== null &&
    day.overnight &&
    !day.stayedInHotel &&
    arrived !== null &&
    arrived >= dorm.arrivalFromMinutes &&
    arrived <= dorm.arrivalToMinutes;

  const dormitoryPaise = dormitoryApplied ? dorm!.amountPaise : 0;
  const mealPaise = meals.reduce((n, m) => n + m.amountPaise, 0);
  const foodPaise =
    dormitoryApplied && dorm!.replacesMeals ? dormitoryPaise : mealPaise + dormitoryPaise;

  /* ---- lodging ---- */
  const lodgingRule = ruleFor(policy, "lodging", subject);
  const lodgingLines = day.lines.filter((l) => l.kind === "lodging");
  let lodgingClaimed = 0;
  let lodgingEligible = 0;
  for (const line of lodgingLines) {
    lodgingClaimed += line.claimedPaise;
    const nights = line.nights ?? 0;
    if (nights <= 0) {
      /* Requirement 32 — a room taken for the afternoon is not lodging. It is
         still RECORDED, which is the point: a zero with a reason beside it is
         an answer, and a line quietly dropped is not. */
      exceptions.push({
        kind: "day_hotel",
        severity: "info",
        message: `${rupees(line.claimedPaise)} for a room with no night in it — this policy does not reimburse a day room.`,
        detail: { claimedPaise: line.claimedPaise },
        lineId: line.id,
      });
      continue;
    }
    if (!lodgingRule) {
      /* Counted as claimed above and deliberately NOT counted as eligible:
         this engine does not invent a ceiling. What changes is that it says
         so, exactly as an unpriced travel mode does. */
      exceptions.push({
        kind: "unpriced_lodging",
        severity: "warn",
        message: `Policy version ${policy.versionNo} says nothing about what a hotel night may cost, so ${rupees(line.claimedPaise)} has to be priced by hand.`,
        detail: { claimedPaise: line.claimedPaise, nights, policyVersion: policy.versionNo },
        lineId: line.id,
      });
      continue;
    }
    const ceiling = lodgingRule.maxPerNightPaise * nights;
    const eligible = Math.min(line.claimedPaise, ceiling);
    lodgingEligible += eligible;
    if (line.claimedPaise > ceiling) {
      exceptions.push({
        kind: "over_cap",
        severity: "warn",
        message: `${rupees(line.claimedPaise)} for ${nights} night${nights === 1 ? "" : "s"}, against ${rupees(lodgingRule.maxPerNightPaise)} a night — ${rupees(line.claimedPaise - ceiling)} over.`,
        detail: { claimedPaise: line.claimedPaise, ceilingPaise: ceiling, nights },
        lineId: line.id,
      });
    }
    const proofAt = proofThresholdFor(policy, subject, "category:lodging");
    if (proofAt !== null && line.claimedPaise >= proofAt && !line.hasProof) {
      exceptions.push({
        kind: "missing_proof",
        severity: "block_route",
        message: `A hotel claim of ${rupees(line.claimedPaise)} needs the bill attached.`,
        detail: { claimedPaise: line.claimedPaise, thresholdPaise: proofAt },
        lineId: line.id,
      });
    }
  }

  /* ---- everything else ---- */
  let otherClaimed = 0;
  let otherEligible = 0;
  for (const line of day.lines) {
    if (line.kind === "lodging") continue;
    otherClaimed += line.claimedPaise;
    const rule = ruleFor(policy, "actuals", subject, (r) => r.scopeKey === `category:${line.kind}`);
    const cap = rule?.capPerInstancePaise ?? null;
    const eligible = cap === null ? line.claimedPaise : Math.min(line.claimedPaise, cap);
    otherEligible += eligible;
    if (cap !== null && line.claimedPaise > cap) {
      exceptions.push({
        kind: "over_cap",
        severity: "warn",
        message: `${rupees(line.claimedPaise)} of ${line.kind.replace(/_/g, " ")} against a ${rupees(cap)} limit — ${rupees(line.claimedPaise - cap)} over.`,
        detail: { claimedPaise: line.claimedPaise, capPaise: cap, kind: line.kind },
        lineId: line.id,
      });
    }
    const proofAt = proofThresholdFor(policy, subject, `category:${line.kind}`);
    if (proofAt !== null && line.claimedPaise >= proofAt && !line.hasProof) {
      exceptions.push({
        kind: "missing_proof",
        severity: "block_route",
        message: `${rupees(line.claimedPaise)} of ${line.kind.replace(/_/g, " ")} needs a bill.`,
        detail: { claimedPaise: line.claimedPaise, thresholdPaise: proofAt },
        lineId: line.id,
      });
    }
  }

  const totalClaimed = travelClaimed + foodPaise + lodgingClaimed + otherClaimed;
  const totalEligible = travelPaise + foodPaise + lodgingEligible + otherEligible;

  return {
    day: day.day,
    policyId: policy.id,
    policyVersionNo: policy.versionNo,
    legs,
    meals,
    dormitoryPaise,
    dormitoryApplied,
    foodPaise,
    travelPaise,
    lodgingClaimedPaise: lodgingClaimed,
    lodgingEligiblePaise: lodgingEligible,
    otherClaimedPaise: otherClaimed,
    otherEligiblePaise: otherEligible,
    totalClaimedPaise: totalClaimed,
    totalEligiblePaise: totalEligible,
    totalExcessPaise: Math.max(0, totalClaimed - totalEligible),
    totalMetres,
    exceptions,
  };
}

/* -------------------------------------------------------------- routing */

export type Route = {
  autoApproved: boolean;
  escalate: boolean;
  reason: string;
};

/**
 * Requirements 44 and 45 — where a submitted day goes.
 *
 * A clean day under the ceiling is approved on submission. Anything flagged
 * goes to the manager. The owner is escalated TO, never substituted for: a
 * manager skipped is the person who actually knows whether that salesman was
 * in Pune on Tuesday, and requirement 45 is about keeping routine work off
 * senior desks rather than moving it up one.
 */
export function routeDay(
  policy: Policy,
  subject: PolicySubject,
  computation: DayComputation,
): Route {
  const rule = ruleFor(policy, "approval_route", subject);
  const worst = worstSeverity(computation.exceptions);
  const flagged = worst === "warn" || worst === "block_route";

  if (!rule) {
    return { autoApproved: false, escalate: false, reason: "This policy names no approval route, so the day waits for a person." };
  }

  const escalate =
    (rule.escalateAboveDayTotalPaise !== null &&
      computation.totalClaimedPaise >= rule.escalateAboveDayTotalPaise) ||
    (rule.escalateOnSeverity !== null &&
      worst !== null &&
      SEVERITY_ORDER[worst] >= SEVERITY_ORDER[rule.escalateOnSeverity]);

  if (!flagged && computation.totalClaimedPaise <= rule.autoApproveUpToPaise && !escalate) {
    return {
      autoApproved: true,
      escalate: false,
      reason: `Within policy and under ${rupees(rule.autoApproveUpToPaise)} — approved on submission.`,
    };
  }

  return {
    autoApproved: false,
    escalate,
    reason: escalate
      ? "Above the escalation threshold, so the owner sees it as well as the manager."
      : flagged
        ? "Something on this day is outside policy, so a manager decides it."
        : `${rupees(computation.totalClaimedPaise)} is above the ${rupees(rule.autoApproveUpToPaise)} automatic limit.`,
  };
}
