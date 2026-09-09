import { HEALTH_BAND_LABELS, type HealthBand } from "./engines/inactivity";
import type { MbosHealthComponent } from "./config/registry";

/* ---------------------------------------------------------------------------
 * B3-16 — ONE VOCABULARY FOR CUSTOMER HEALTH.
 *
 * There were two models and FOUR renderings of them, and two of the four used
 * the same two words to mean different things:
 *
 *   the BAND      active / at-risk / dormant / lost, from how many of the
 *                 customer's OWN cycles have passed since they last ordered.
 *                 One fact. It already governs `customers.status`, the Call
 *                 Log and the owner's retention report.
 *   the SCORE     0-100, weighted across five components — order recency,
 *                 order value trend, payment behaviour, visit engagement,
 *                 complaints. Five facts, computed on the server.
 *
 *   `/sales/leads` called a customer "At risk" below a SCORE of 40.
 *   `/reports`     called a customer "At risk" at 1.25 CYCLES overdue.
 *   the handset    coloured a pill green/amber/red at 70/50, as literals.
 *   the manager's own customer list fetched a score and rendered nothing.
 *
 * So a manager and an owner could each read "At risk" about one shop, on the
 * same afternoon, and mean different things — which is the state B3-16 was
 * raised about, and the reason it says "pick one, or nobody will trust either".
 *
 * THE ANSWER IS NOT TO DELETE ONE. They answer different questions and both
 * are worth asking. It is that the BAND OWNS THE RETENTION WORD and the score
 * stops borrowing it. A customer buying perfectly on time whose score is 30 is
 * not "at risk of leaving" — they are paying late with two complaints open,
 * and saying so is both truer and more useful than a word that sends somebody
 * to win back a customer who never went anywhere.
 *
 * PURE and client-safe, like `account-types`, `seat-labels` and
 * `next-step-labels` before it: three of the four surfaces are client
 * components, and a copy typed into any of them is the copy that drifts.
 * ------------------------------------------------------------------------- */

export type HealthTone = "success" | "warn" | "danger" | "muted";

/** What the score is docking marks for, worst first. */
export type HealthConcern = { component: MbosHealthComponent; score: number; label: string };

export type HealthView = {
  /** The retention answer, or null where the customer has never ordered. */
  band: HealthBand | null;
  /** "Active" · "At risk" · "Dormant" · "Lost" — or the reason there is none. */
  bandLabel: string;
  bandTone: HealthTone;
  /** The weighted score, or null where nothing has computed one yet. */
  score: number | null;
  scoreTone: HealthTone;
  /**
   * True where the score is low enough to be worth a look. Deliberately NOT
   * called `atRisk`: that phrase is the band's, and a customer can be squarely
   * Active and still be worth watching.
   */
  watch: boolean;
  /** Why, in the customer's own components. Empty where nothing is low. */
  concerns: HealthConcern[];
};

export const COMPONENT_LABELS: Record<MbosHealthComponent, string> = {
  orderRecency: "Ordering",
  orderValueTrend: "Order value",
  paymentBehaviour: "Payments",
  visitEngagement: "Visits",
  complaints: "Complaints",
};

const BAND_TONE: Record<HealthBand, HealthTone> = {
  active: "success",
  "at-risk": "warn",
  dormant: "danger",
  lost: "danger",
};

/**
 * WHY THERE IS NO BAND, said in words rather than left blank.
 *
 * A customer who has never ordered has not stopped buying — they have not
 * started, which belongs on a prospect list and not in a retention figure. The
 * owner's report already refuses to band them; this is the same refusal made
 * legible on a screen, because a blank cell reads as missing data and this is
 * a real and different answer.
 */
export const NO_BAND_LABEL = "Not ordered yet";

export type HealthThresholds = {
  /** A score below this is worth a look. `mbos.health.atRiskBelow`. */
  watchBelow: number;
  /** At or above this the score is strong. `mbos.health.strongAtOrAbove`. */
  strongAtOrAbove: number;
};

/**
 * The one reading. Every surface calls this and renders what it returns.
 */
export function healthView(
  input: {
    band: HealthBand | null;
    score: number | null;
    components?: Partial<Record<MbosHealthComponent, number>> | null;
  },
  thresholds: HealthThresholds,
): HealthView {
  const { band, score } = input;

  const bandLabel = band ? HEALTH_BAND_LABELS[band] : NO_BAND_LABEL;
  const bandTone: HealthTone = band ? BAND_TONE[band] : "muted";

  const watch = score !== null && score < thresholds.watchBelow;
  const scoreTone: HealthTone =
    score === null
      ? "muted"
      : score >= thresholds.strongAtOrAbove
        ? "success"
        : watch
          ? "danger"
          : "warn";

  /*
   * The components that are actually dragging, worst first — this is what
   * makes a 42 something somebody can act on. A score nobody can decompose is
   * a number nobody argues with, and one nobody argues with is one nobody acts
   * on either; the engine stores the components for exactly this reason and
   * until now nothing read them.
   */
  const concerns: HealthConcern[] = Object.entries(input.components ?? {})
    .filter(([, v]) => typeof v === "number" && v < thresholds.watchBelow)
    .map(([k, v]) => ({
      component: k as MbosHealthComponent,
      score: v as number,
      label: COMPONENT_LABELS[k as MbosHealthComponent] ?? k,
    }))
    .sort((a, b) => a.score - b.score);

  return { band, bandLabel, bandTone, score, scoreTone, watch, concerns };
}

/**
 * The one-line summary, for a place with room for a sentence and not a panel.
 *
 * The band first because it is the headline, then the score's concern named as
 * what it IS. Never "at risk" for a score.
 */
export function healthSentence(view: HealthView): string {
  const parts = [view.bandLabel];
  if (view.score !== null) parts.push(`score ${view.score}`);
  if (view.concerns.length) {
    parts.push(`watch ${view.concerns.slice(0, 2).map((c) => c.label.toLowerCase()).join(" and ")}`);
  }
  return parts.join(" · ");
}
