import type { Meal, Policy, PolicyRule } from "@/lib/engines/expense-policy";

/* ---------------------------------------------------------------------------
 * The standard expense policy's SHIPPED FIGURES.
 *
 * The policy was hard-coded here for a while (the versioned rule builder was
 * too much to use). It is editable again, as NAMED POLICIES in
 * `expense_policy_sets` — see `lib/services/expense-policy-set-service.ts`.
 * The standard one is a row like any other, seeded from `STANDARD_POLICY`
 * below the first time it is read, and from then on the ROW is the policy:
 * these figures are only what a fresh database starts with and what the
 * editor's "Reset to shipped defaults" puts back.
 *
 * The ENGINE is untouched and still pure: it is handed a `Policy` built from
 * whichever named policy a salesman is on, on the server and on the handset.
 * The `id` matches the row migration 0228 writes, so every
 * `mbos_expense_days.policy_id` stamped with it satisfies its foreign key.
 *
 * Pure and client-safe: `policyInWords(rules)` renders any policy's rules as
 * the page the Admin Console previews and the Sales Dashboard shows, built
 * from the same rules the engine prices with.
 * ------------------------------------------------------------------------- */

export const STANDARD_POLICY_ID = "xpol_standard";
export const STANDARD_POLICY_VERSION = 1000;
export const STANDARD_POLICY_TITLE = "Mahek standard expense policy";
/**
 * Which edition of the shipped figures `STANDARD_POLICY` is. A standard policy
 * row nobody has edited is moved onto a newer edition on its next read
 * (`ensureStandardSet`); one somebody has edited is left alone, and the editor's
 * "Reset to shipped defaults" is how it takes them.
 */
export const STANDARD_DEFAULTS_VERSION = 2;

/**
 * The written lines of the issued policy document that are not a figure: how
 * a claim is proved, paid and asked about. A policy's guidelines are edited on
 * the console beside its rules; these are only the standard one's defaults.
 */
export const STANDARD_GUIDELINES: readonly string[] = [
  "Bills or travel logs must be submitted with every claim.",
  "Tour expenses are paid by GPay 1–2 days before the tour.",
  "Extra expenses for a valid reason are reimbursed on the next working day.",
  "Local travel — share auto, bus, train and the like — is paid at actuals.",
  "Pay first and claim in the app; the reimbursement comes with your salary.",
  "Please do not call the office about expenses after office hours.",
];

const ANY = { grade: null, cityClass: null } as const;
const at = (h: number, m = 0) => h * 60 + m;
const rs = (rupees: number) => rupees * 100;

/*
 * Mahek's written Expense Policy (the signed English and Hindi sheet), rule for
 * rule. Defaults version 2 — see `STANDARD_DEFAULTS_VERSION`.
 *
 *  - Breakfast ₹100: left the hometown between 11 PM and 8 AM.
 *  - + Lunch ₹150 (₹250 in all): the same early start.
 *  - + Dinner ₹200 (₹450 in all): the same early start AND back after 10:30 PM.
 *  - Leaving after 8 AM earns no meal; a day in the hometown earns none.
 *  - Hotel: a FIXED ₹450 a night; a room for the day only is not paid.
 *  - Dormitory ₹250: overnight travel arriving 6–10 AM with no hotel. It is
 *    where he slept, so it is paid alongside that day's meals, not instead.
 *  - Local travel (share auto, bus, train, auto, taxi) at actuals, no limit.
 *  - Every claim needs a bill, or for travel a trip the app recorded.
 *  - Own vehicles are not in the document: recorded, not paid per kilometre.
 */
const EARLY = { leftFromMinutes: at(23), leftToMinutes: at(8) } as const;
const MEAL_GATE = {
  windowFromMinutes: null,
  windowToMinutes: null,
  minAwayMinutes: null,
  returnedByMinutes: null,
  awayFromHometownOnly: true,
} as const;

const RULES: PolicyRule[] = [
  /* ---- meals: ₹100 / ₹250 / ₹450 ---- */
  { ...ANY, kind: "meal_rate", meal: "breakfast", amountPaise: rs(100) },
  { ...ANY, kind: "meal_rate", meal: "lunch", amountPaise: rs(150) },
  { ...ANY, kind: "meal_rate", meal: "dinner", amountPaise: rs(200) },
  {
    ...ANY,
    kind: "meal_entitlement",
    meal: "breakfast",
    ...MEAL_GATE,
    ...EARLY,
    returnedAfterMinutes: null,
  },
  {
    ...ANY,
    kind: "meal_entitlement",
    meal: "lunch",
    ...MEAL_GATE,
    ...EARLY,
    returnedAfterMinutes: null,
  },
  {
    ...ANY,
    kind: "meal_entitlement",
    meal: "dinner",
    ...MEAL_GATE,
    ...EARLY,
    returnedAfterMinutes: at(22, 30),
  },
  {
    ...ANY,
    kind: "dormitory",
    arrivalFromMinutes: at(6),
    arrivalToMinutes: at(10),
    amountPaise: rs(250),
    replacesMeals: false,
  },

  /* ---- hotel: fixed ₹450 a night, never a day room ---- */
  {
    ...ANY,
    kind: "lodging",
    maxPerNightPaise: rs(450),
    dayUseAllowed: false,
    flatPerNight: true,
  },

  /* ---- local travel at actuals ---- */
  {
    ...ANY,
    kind: "actuals",
    scopeKey: "travel_mode:share_auto",
    capPerInstancePaise: null,
    capPerDayPaise: null,
  },
  {
    ...ANY,
    kind: "actuals",
    scopeKey: "travel_mode:auto_local",
    capPerInstancePaise: null,
    capPerDayPaise: null,
  },
  {
    ...ANY,
    kind: "actuals",
    scopeKey: "travel_mode:bus",
    capPerInstancePaise: null,
    capPerDayPaise: null,
  },
  {
    ...ANY,
    kind: "actuals",
    scopeKey: "travel_mode:train",
    capPerInstancePaise: null,
    capPerDayPaise: null,
  },
  {
    ...ANY,
    kind: "actuals",
    scopeKey: "travel_mode:public_transport",
    capPerInstancePaise: null,
    capPerDayPaise: null,
  },
  {
    ...ANY,
    kind: "actuals",
    scopeKey: "travel_mode:taxi",
    capPerInstancePaise: null,
    capPerDayPaise: null,
  },
  {
    ...ANY,
    kind: "actuals",
    scopeKey: "category:local_transport",
    capPerInstancePaise: null,
    capPerDayPaise: null,
  },
  {
    ...ANY,
    kind: "actuals",
    scopeKey: "category:travel",
    capPerInstancePaise: null,
    capPerDayPaise: null,
  },
  /* A food bill is not paid: meals are the allowance above. */
  {
    ...ANY,
    kind: "actuals",
    scopeKey: "category:food",
    capPerInstancePaise: null,
    capPerDayPaise: 0,
  },
  /* "Extra expenses for valid reasons" — paid at actuals once the manager agrees. */
  {
    ...ANY,
    kind: "actuals",
    scopeKey: "category:other",
    capPerInstancePaise: null,
    capPerDayPaise: null,
  },

  /* ---- recorded, not paid ---- */
  { ...ANY, kind: "zero_rated", modeKey: "own_bike" },
  { ...ANY, kind: "zero_rated", modeKey: "own_car" },
  { ...ANY, kind: "zero_rated", modeKey: "company_vehicle" },
  { ...ANY, kind: "zero_rated", modeKey: "customer_vehicle" },
  { ...ANY, kind: "zero_rated", modeKey: "walking" },

  /* ---- which distance a trip is recorded on ---- */
  {
    ...ANY,
    kind: "km_source",
    modeKey: null,
    precedence: ["odometer", "gps", "manual"],
    varianceFlagBps: 2500,
  },

  /* ---- bills or travel logs, with every claim ---- */
  {
    ...ANY,
    kind: "proof_threshold",
    scopeKey: "*",
    atPaise: 0,
    travelLogCounts: true,
  },
];

/** The policy, for every date. `effectiveFrom` reaches back over the whole book. */
export const STANDARD_POLICY: Policy = {
  id: STANDARD_POLICY_ID,
  versionNo: STANDARD_POLICY_VERSION,
  effectiveFrom: "2000-01-01",
  effectiveTo: null,
  rules: RULES,
};

/* ----------------------------------------------------------- in words */

export type PolicyLine = { label: string; value: string; note?: string };
export type PolicySection = { key: string; title: string; lines: PolicyLine[] };

const MODE_LABELS: Record<string, string> = {
  own_bike: "Own bike",
  own_car: "Own car",
  bus: "Bus",
  train: "Train",
  public_transport: "Public transport",
  auto_local: "Auto / local transport",
  share_auto: "Share auto",
  taxi: "Taxi",
  company_vehicle: "Company vehicle",
  customer_vehicle: "Customer's vehicle",
  walking: "Walking",
};

const CATEGORY_LABELS: Record<string, string> = {
  local_transport: "Local transport bills",
  travel: "Other travel bills",
  food: "Food bills",
  other: "Anything else",
};

const MEAL_LABELS: Record<Meal, string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
};

function money(paise: number): string {
  const r = paise / 100;
  return `₹${r.toLocaleString("en-IN", { maximumFractionDigits: r % 1 ? 2 : 0, minimumFractionDigits: r % 1 ? 2 : 0 })}`;
}

function clock(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const suffix = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m
    ? `${h12}:${String(m).padStart(2, "0")} ${suffix}`
    : `${h12} ${suffix}`;
}

function onlyOf(rules: readonly PolicyRule[]) {
  return <K extends PolicyRule["kind"]>(
    kind: K,
  ): Extract<PolicyRule, { kind: K }>[] =>
    rules.filter((r): r is Extract<PolicyRule, { kind: K }> => r.kind === kind);
}

/** "Grade A, metro cities" — empty where a rule applies to everybody. */
function whoFor(
  r: { grade: string | null; cityClass: string | null },
  gradeLabel?: (k: string) => string,
): string {
  const bits: string[] = [];
  if (r.grade) bits.push(gradeLabel ? gradeLabel(r.grade) : r.grade);
  if (r.cityClass) bits.push(`${r.cityClass} cities`);
  return bits.join(", ");
}

const withWho = (
  label: string,
  r: { grade: string | null; cityClass: string | null },
  gradeLabel?: (k: string) => string,
) => {
  const who = whoFor(r, gradeLabel);
  return who ? `${label} (${who})` : label;
};

/**
 * A policy as a short list a salesman, a manager and accounts can all read.
 * Built FROM the rules it is given — the standard policy's by default, or any
 * named policy's from the database — never typed beside them. `modeLabel` lets
 * the caller name travel modes from `mbos_travel_modes`, so a mode an admin
 * added reads as its label rather than its key.
 */
export function policyInWords(
  rules: readonly PolicyRule[] = RULES,
  opts: {
    modeLabel?: (key: string) => string | undefined;
    gradeLabel?: (key: string) => string;
  } = {},
): PolicySection[] {
  const only = onlyOf(rules);
  const modeName = (k: string) =>
    opts.modeLabel?.(k) ?? MODE_LABELS[k] ?? k.replace(/_/g, " ");
  const g = opts.gradeLabel;
  const travel: PolicyLine[] = [
    ...only("per_km").map((r) => ({
      label: withWho(modeName(r.modeKey), r, g),
      value: `${money(r.paisePerKm)} per km`,
      note: r.dailyKmCap ? `up to ${r.dailyKmCap} km a day` : undefined,
    })),
    ...only("actuals")
      .filter((r) => r.scopeKey.startsWith("travel_mode:"))
      .map((r) => {
        const mode = r.scopeKey.slice("travel_mode:".length);
        const limits = [
          r.capPerInstancePaise
            ? `up to ${money(r.capPerInstancePaise)} a ride`
            : null,
          r.capPerDayPaise ? `up to ${money(r.capPerDayPaise)} a day` : null,
        ].filter(Boolean);
        return {
          label: withWho(modeName(mode), r, g),
          value: "Ticket price",
          note: limits.length ? limits.join(", ") : undefined,
        };
      }),
    ...only("zero_rated").map((r) => ({
      label: withWho(modeName(r.modeKey), r, g),
      value: "Not paid",
      note: "recorded only",
    })),
  ];

  const source = only("km_source")[0];
  const ceiling = only("exception_bands")[0]?.dailyKmCeiling;
  const distance: PolicyLine[] = [
    {
      label: "Which km count",
      value: source
        ? source.precedence
            .map((s) => (s === "gps" ? "GPS" : s))
            .join(", then ")
        : "odometer",
      note: "the first one that was recorded",
    },
    ...(source
      ? [
          {
            label: "Meter and GPS disagree",
            value: `by more than ${source.varianceFlagBps / 100}%`,
            note: "the day is flagged and a meter photo is asked for",
          },
        ]
      : []),
    ...(ceiling
      ? [
          {
            label: "Long day",
            value: `over ${ceiling} km`,
            note: "the day is flagged for the manager",
          },
        ]
      : []),
  ];

  const rates = only("meal_rate");
  const windows = only("meal_entitlement");
  const late = only("meal_disqualifier");
  const meals: PolicyLine[] = rates.map((r) => {
    const w = windows.find((x) => x.meal === r.meal);
    const d = late.find((x) => x.meal === r.meal);
    const notes = [
      w && w.leftFromMinutes != null && w.leftToMinutes != null
        ? `if he left between ${clock(w.leftFromMinutes)} and ${clock(w.leftToMinutes)}`
        : null,
      w && w.returnedAfterMinutes != null
        ? `and came back after ${clock(w.returnedAfterMinutes)}`
        : null,
      w && w.returnedByMinutes != null
        ? `and was back by ${clock(w.returnedByMinutes)}`
        : null,
      w && w.windowFromMinutes !== null && w.windowToMinutes !== null
        ? `if away between ${clock(w.windowFromMinutes)} and ${clock(w.windowToMinutes)}`
        : null,
      w?.awayFromHometownOnly ? "only on a day away from his hometown" : null,
      d ? `not if he left after ${clock(d.departedAfterMinutes)}` : null,
    ].filter(Boolean);
    return {
      label: withWho(MEAL_LABELS[r.meal], r, g),
      value: money(r.amountPaise),
      note: notes.join(", ") || undefined,
    };
  });
  const dorm = only("dormitory")[0];
  if (dorm) {
    meals.push({
      label: "Overnight travel, no hotel",
      value: money(dorm.amountPaise),
      note: `arriving between ${clock(dorm.arrivalFromMinutes)} and ${clock(dorm.arrivalToMinutes)}${dorm.replacesMeals ? ", instead of that morning's meals" : ""}`,
    });
  }

  const hotel: PolicyLine[] = only("lodging").flatMap((lodging) => [
    {
      label: withWho("Hotel", lodging, g),
      value: lodging.flatPerNight
        ? `${money(lodging.maxPerNightPaise)} a night`
        : `up to ${money(lodging.maxPerNightPaise)} a night`,
      note: lodging.flatPerNight ? "fixed, whatever the bill" : undefined,
    },
    lodging.dayUseAllowed
      ? {
          label: withWho("Room for the day only", lodging, g),
          value: "Paid",
          note: "within the night's limit",
        }
      : {
          label: withWho("Room for the day only", lodging, g),
          value: "Not paid",
          note: "a stay needs a night",
        },
  ]);

  const bills: PolicyLine[] = only("actuals")
    .filter((r) => r.scopeKey.startsWith("category:"))
    .map((r) => {
      const kind = r.scopeKey.slice("category:".length);
      return {
        label: withWho(CATEGORY_LABELS[kind] ?? kind.replace(/_/g, " "), r, g),
        value:
          r.capPerDayPaise === 0 || r.capPerInstancePaise === 0
            ? "Not paid"
            : r.capPerDayPaise
              ? `up to ${money(r.capPerDayPaise)} a day`
              : "Bill amount",
        note:
          r.capPerDayPaise === 0 || r.capPerInstancePaise === 0
            ? kind === "food"
              ? "meals are paid as the allowance above"
              : undefined
            : r.capPerInstancePaise
              ? `up to ${money(r.capPerInstancePaise)} a bill`
              : undefined,
      };
    });

  /* Said as it now works, not as the `approval_route` rule reads: there is no
     closing a day, so nothing is "approved automatically up to a day's total".
     Allowances are automatic and every logged expense is decided on its own. */
  const approval: PolicyLine[] = [
    ...only("proof_threshold").map((p) => ({
      label: withWho(
        p.scopeKey === "*"
          ? "Bill or ticket photo"
          : `Bill or ticket photo — ${p.scopeKey.startsWith("travel_mode:") ? modeName(p.scopeKey.slice(12)) : (CATEGORY_LABELS[p.scopeKey.replace(/^category:/, "")] ?? p.scopeKey.replace(/^category:/, "").replace(/_/g, " "))}`,
        p,
        g,
      ),
      value:
        p.atPaise === 0
          ? "needed with every claim"
          : `needed from ${money(p.atPaise)}`,
      note: p.travelLogCounts
        ? "for travel, a trip the app recorded counts as the log"
        : undefined,
    })),
    {
      label: "Allowances",
      value: "Automatic",
      note: "worked out from your punch times and trips, no approval needed",
    },
    {
      label: "Every expense you log",
      value: "Sales manager decides",
      note: "each one on its own, as soon as it is logged",
    },
    {
      label: "Over the limit",
      value: "Still recorded",
      note: "the extra is shown to the manager, who decides",
    },
  ];

  return [
    { key: "travel", title: "Travel", lines: travel },
    { key: "distance", title: "Kilometres", lines: distance },
    { key: "meals", title: "Meals", lines: meals },
    { key: "hotel", title: "Hotel", lines: hotel },
    { key: "bills", title: "Other bills", lines: bills },
    { key: "approval", title: "Bills & approval", lines: approval },
  ].filter((s) => s.lines.length > 0);
}
