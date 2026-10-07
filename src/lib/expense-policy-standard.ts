import type { Meal, Policy, PolicyRule } from "@/lib/engines/expense-policy";

/* ---------------------------------------------------------------------------
 * THE expense policy — Mahek's one standard policy, written in code.
 *
 * **This is a deliberate reversal, and a temporary one.** The module shipped
 * as versioned rules typed into the Admin Console — thirteen rule kinds,
 * grades, city classes, drafts, a simulator and a publish step — and nobody
 * could read it, so nothing was ever published and every day reached a
 * manager unpriced. Mahek asked for it to be made simple and hard-coded first;
 * making it editable again is a later decision. Until then:
 *
 * - every rate below is the whole policy, for everybody, everywhere (no grade
 *   and no city variation — `ANY` on every rule);
 * - it applies to every date, so a day is always priced;
 * - changing a figure is a code change and a deploy, on purpose.
 *
 * The ENGINE is untouched and still pure: it is handed this `Policy` exactly
 * as it was handed a published version, on the server and on the handset.
 * The `id` matches the row migration 0228 writes, so every
 * `mbos_expense_days.policy_id` stamped with it satisfies its foreign key.
 *
 * Pure and client-safe: the Admin Console and the Sales Dashboard both render
 * `policyInWords()` from these same numbers, so the page cannot disagree with
 * the arithmetic.
 * ------------------------------------------------------------------------- */

export const STANDARD_POLICY_ID = "xpol_standard";
export const STANDARD_POLICY_VERSION = 1000;
export const STANDARD_POLICY_TITLE = "Mahek standard expense policy";

const ANY = { grade: null, cityClass: null } as const;
const at = (h: number, m = 0) => h * 60 + m;
const rs = (rupees: number) => rupees * 100;

const RULES: PolicyRule[] = [
  /* ---- own vehicle: paid per kilometre ---- */
  { ...ANY, kind: "per_km", modeKey: "own_bike", paisePerKm: 350, dailyKmCap: null },
  { ...ANY, kind: "per_km", modeKey: "own_car", paisePerKm: 900, dailyKmCap: null },

  /* ---- tickets: paid at what they cost ---- */
  { ...ANY, kind: "actuals", scopeKey: "travel_mode:bus", capPerInstancePaise: null, capPerDayPaise: null },
  { ...ANY, kind: "actuals", scopeKey: "travel_mode:train", capPerInstancePaise: null, capPerDayPaise: null },
  { ...ANY, kind: "actuals", scopeKey: "travel_mode:public_transport", capPerInstancePaise: null, capPerDayPaise: null },
  { ...ANY, kind: "actuals", scopeKey: "travel_mode:auto_local", capPerInstancePaise: null, capPerDayPaise: rs(600) },
  { ...ANY, kind: "actuals", scopeKey: "travel_mode:taxi", capPerInstancePaise: rs(500), capPerDayPaise: null },

  /* ---- recorded, never paid ---- */
  { ...ANY, kind: "zero_rated", modeKey: "company_vehicle" },
  { ...ANY, kind: "zero_rated", modeKey: "customer_vehicle" },
  { ...ANY, kind: "zero_rated", modeKey: "walking" },

  /* ---- which distance counts ---- */
  { ...ANY, kind: "km_source", modeKey: null, precedence: ["odometer", "gps", "manual"], varianceFlagBps: 2500 },
  { ...ANY, kind: "odometer_photo", modeKey: null, when: "on_variance", randomPct: 0 },

  /* ---- meals: the client's own figures, ₹100 / ₹250 / ₹450 ---- */
  { ...ANY, kind: "meal_rate", meal: "breakfast", amountPaise: rs(100) },
  { ...ANY, kind: "meal_rate", meal: "lunch", amountPaise: rs(150) },
  { ...ANY, kind: "meal_rate", meal: "dinner", amountPaise: rs(200) },
  { ...ANY, kind: "meal_entitlement", meal: "breakfast", windowFromMinutes: at(6), windowToMinutes: at(10), minAwayMinutes: null },
  { ...ANY, kind: "meal_entitlement", meal: "lunch", windowFromMinutes: at(12), windowToMinutes: at(15), minAwayMinutes: null },
  { ...ANY, kind: "meal_entitlement", meal: "dinner", windowFromMinutes: at(19), windowToMinutes: at(22), minAwayMinutes: null },
  { ...ANY, kind: "meal_disqualifier", meal: "breakfast", departedAfterMinutes: at(8) },
  { ...ANY, kind: "dormitory", arrivalFromMinutes: at(6), arrivalToMinutes: at(10), amountPaise: rs(250), replacesMeals: true },

  /* ---- hotel ---- */
  { ...ANY, kind: "lodging", maxPerNightPaise: rs(1500), dayUseAllowed: false },

  /* ---- other bills, a limit a day each ---- */
  { ...ANY, kind: "actuals", scopeKey: "category:local_transport", capPerInstancePaise: null, capPerDayPaise: rs(600) },
  { ...ANY, kind: "actuals", scopeKey: "category:travel", capPerInstancePaise: null, capPerDayPaise: rs(1000) },
  { ...ANY, kind: "actuals", scopeKey: "category:food", capPerInstancePaise: null, capPerDayPaise: rs(450) },
  { ...ANY, kind: "actuals", scopeKey: "category:other", capPerInstancePaise: null, capPerDayPaise: rs(500) },

  /* ---- proof, approval, and what is unusual ---- */
  { ...ANY, kind: "proof_threshold", scopeKey: "*", atPaise: rs(200) },
  { ...ANY, kind: "approval_route", autoApproveUpToPaise: rs(1000), escalateAboveDayTotalPaise: rs(5000), escalateOnSeverity: null },
  { ...ANY, kind: "exception_bands", dailyKmCeiling: 300, ownSpendBandBps: null, teamSpendBandBps: null },
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

const MEAL_LABELS: Record<Meal, string> = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner" };

function money(paise: number): string {
  const r = paise / 100;
  return `₹${r.toLocaleString("en-IN", { maximumFractionDigits: r % 1 ? 2 : 0, minimumFractionDigits: r % 1 ? 2 : 0 })}`;
}

function clock(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const suffix = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, "0")} ${suffix}` : `${h12} ${suffix}`;
}

function only<K extends PolicyRule["kind"]>(kind: K): Extract<PolicyRule, { kind: K }>[] {
  return RULES.filter((r): r is Extract<PolicyRule, { kind: K }> => r.kind === kind);
}

/**
 * The policy as a short list a salesman, a manager and accounts can all read.
 * Built FROM the rules above, never typed beside them.
 */
export function policyInWords(): PolicySection[] {
  const travel: PolicyLine[] = [
    ...only("per_km").map((r) => ({
      label: MODE_LABELS[r.modeKey] ?? r.modeKey,
      value: `${money(r.paisePerKm)} per km`,
      note: r.dailyKmCap ? `up to ${r.dailyKmCap} km a day` : undefined,
    })),
    ...only("actuals")
      .filter((r) => r.scopeKey.startsWith("travel_mode:"))
      .map((r) => {
        const mode = r.scopeKey.slice("travel_mode:".length);
        const limits = [
          r.capPerInstancePaise ? `up to ${money(r.capPerInstancePaise)} a ride` : null,
          r.capPerDayPaise ? `up to ${money(r.capPerDayPaise)} a day` : null,
        ].filter(Boolean);
        return {
          label: MODE_LABELS[mode] ?? mode,
          value: "Ticket price",
          note: limits.length ? limits.join(", ") : undefined,
        };
      }),
    ...only("zero_rated").map((r) => ({
      label: MODE_LABELS[r.modeKey] ?? r.modeKey,
      value: "Not paid",
      note: "recorded only",
    })),
  ];

  const source = only("km_source")[0];
  const ceiling = only("exception_bands")[0]?.dailyKmCeiling;
  const distance: PolicyLine[] = [
    {
      label: "Which km count",
      value: source ? source.precedence.map((s) => (s === "gps" ? "GPS" : s)).join(", then ") : "odometer",
      note: "the first one that was recorded",
    },
    ...(source
      ? [{ label: "Meter and GPS disagree", value: `by more than ${source.varianceFlagBps / 100}%`, note: "the day is flagged and a meter photo is asked for" }]
      : []),
    ...(ceiling ? [{ label: "Long day", value: `over ${ceiling} km`, note: "the day is flagged for the manager" }] : []),
  ];

  const rates = only("meal_rate");
  const windows = only("meal_entitlement");
  const late = only("meal_disqualifier");
  const meals: PolicyLine[] = rates.map((r) => {
    const w = windows.find((x) => x.meal === r.meal);
    const d = late.find((x) => x.meal === r.meal);
    const notes = [
      w ? `if away between ${clock(w.windowFromMinutes)} and ${clock(w.windowToMinutes)}` : null,
      d ? `not if he left after ${clock(d.departedAfterMinutes)}` : null,
    ].filter(Boolean);
    return { label: MEAL_LABELS[r.meal], value: money(r.amountPaise), note: notes.join(", ") || undefined };
  });
  const dorm = only("dormitory")[0];
  if (dorm) {
    meals.push({
      label: "Overnight travel, no hotel",
      value: money(dorm.amountPaise),
      note: `arriving between ${clock(dorm.arrivalFromMinutes)} and ${clock(dorm.arrivalToMinutes)}${dorm.replacesMeals ? ", instead of that morning's meals" : ""}`,
    });
  }

  const lodging = only("lodging")[0];
  const hotel: PolicyLine[] = lodging
    ? [
        { label: "Hotel", value: `up to ${money(lodging.maxPerNightPaise)} a night` },
        ...(lodging.dayUseAllowed ? [] : [{ label: "Room for the day only", value: "Not paid", note: "a stay needs a night" }]),
      ]
    : [];

  const bills: PolicyLine[] = only("actuals")
    .filter((r) => r.scopeKey.startsWith("category:"))
    .map((r) => {
      const kind = r.scopeKey.slice("category:".length);
      return {
        label: CATEGORY_LABELS[kind] ?? kind,
        value: r.capPerDayPaise ? `up to ${money(r.capPerDayPaise)} a day` : "Bill amount",
        note: r.capPerInstancePaise ? `up to ${money(r.capPerInstancePaise)} a bill` : undefined,
      };
    });

  const proof = only("proof_threshold")[0];
  const route = only("approval_route")[0];
  const approval: PolicyLine[] = [
    ...(proof ? [{ label: "Bill or ticket photo", value: `needed from ${money(proof.atPaise)}` }] : []),
    ...(route
      ? [
          { label: "Approved automatically", value: `up to ${money(route.autoApproveUpToPaise)} a day`, note: "only when nothing on the day is flagged" },
          { label: "Everything else", value: "Sales manager decides" },
          ...(route.escalateAboveDayTotalPaise
            ? [{ label: "Owner also sees it", value: `from ${money(route.escalateAboveDayTotalPaise)} a day` }]
            : []),
        ]
      : []),
    { label: "Over the limit", value: "Still recorded", note: "the extra is shown to the manager, who decides" },
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
