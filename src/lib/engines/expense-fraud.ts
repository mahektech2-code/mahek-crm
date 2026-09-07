/* ---------------------------------------------------------------------------
 * E13 — §I, duplicate claims and abnormal ones.
 *
 * Pure. Candidates, bands and history arrive as arguments; nothing here reads
 * a clock or a table.
 *
 * **Modelled on `receipt-match.ts`, deliberately.** That engine already solves
 * this exact shape of problem for payments, and the two rules it settled apply
 * here unchanged:
 *
 *   - **A candidate is a SUGGESTION and never a gate.** A gate in front of the
 *     ordinary case is a gate people learn to click through, and two salesmen
 *     claiming ₹250 of auto fare on the same Tuesday is an ordinary Tuesday.
 *   - **Two records with nothing to match on match on NOTHING.** Otherwise
 *     every unreferenced ₹200 fare matches every other one, the screen is a
 *     wall of red, and the flag stops meaning anything.
 *
 * And one rule of its own, because this is about a person rather than a
 * payment: **every finding says the numbers it was made from.** "Unusually
 * high" is an accusation nobody can answer. "240 km claimed, 31 km on the
 * odometer, 6 km on the day's track, against your own 84 km median" is a
 * question somebody can answer in a sentence.
 * ------------------------------------------------------------------------- */

import type { PolicyException, Severity } from "./expense-policy";

/* ---------------------------------------------------------- §I47 duplicates */

export type ClaimFacts = {
  id: string;
  userId: string;
  /** ISO date. */
  expenseDate: string;
  kind: string;
  claimedPaise: number;
  vendorName: string | null;
  billNumber: string | null;
  /** A perceptual hash of the bill image, where there is one. */
  billHash: string | null;
  /** A PNR or ticket number, where the line came from a travel leg. */
  reference: string | null;
};

export type DuplicateStrength = "certain" | "likely" | "possible";

export type DuplicateCandidate = {
  otherId: string;
  strength: DuplicateStrength;
  /** The sentence a person reads. Always names what actually matched. */
  reason: string;
  matchedOn: readonly string[];
};

export type DuplicateOptions = {
  /** How far either side of the claim to look. */
  windowDays: number;
  /** Two amounts within this many basis points are "near". */
  nearAmountBps: number;
};

function normaliseRef(value: string | null): string | null {
  if (!value) return null;
  const key = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  /* A three-character reference matches half the book. Somebody typing "NA"
     into a reference box is not evidence of anything. */
  return key.length >= 4 ? key : null;
}

function daysApart(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

function nearBps(a: number, b: number): number {
  const top = Math.max(a, b);
  return top <= 0 ? 0 : Math.round((Math.abs(a - b) / top) * 10_000);
}

/**
 * Other claims that might be this one written down twice, strongest first.
 *
 * The ladder, and why it is in this order:
 *
 *  1. **The same bill image.** A perceptual hash matching is the same
 *     photograph, and one photograph is one bill however it was typed in.
 *  2. **The same bill or ticket number.** A number names one document. Where
 *     the amounts then differ, that difference is the most interesting thing
 *     on the screen rather than a reason to stop matching.
 *  3. **Same vendor, same day, same amount.** Three coincidences is a
 *     question.
 *  4. **Same day, near amount, same kind.** One coincidence. Offered as
 *     `possible` and worded as a question.
 *
 * A claim with no bill number, no hash and no vendor matches on nothing at all.
 */
export function duplicateCandidates(
  claim: ClaimFacts,
  history: readonly ClaimFacts[],
  opts: DuplicateOptions,
): DuplicateCandidate[] {
  const out: DuplicateCandidate[] = [];
  const ref = normaliseRef(claim.billNumber) ?? normaliseRef(claim.reference);

  for (const other of history) {
    if (other.id === claim.id) continue;
    if (daysApart(claim.expenseDate, other.expenseDate) > opts.windowDays) continue;

    if (claim.billHash && other.billHash && claim.billHash === other.billHash) {
      out.push({
        otherId: other.id,
        strength: "certain",
        matchedOn: ["bill image"],
        reason:
          claim.claimedPaise === other.claimedPaise
            ? "The same photograph of the same bill is already claimed."
            : `The same photograph of the same bill is already claimed, for a different amount — ₹${Math.round(other.claimedPaise / 100)}.`,
      });
      continue;
    }

    const otherRef = normaliseRef(other.billNumber) ?? normaliseRef(other.reference);
    if (ref && otherRef && ref === otherRef) {
      out.push({
        otherId: other.id,
        strength: "certain",
        matchedOn: ["bill number"],
        reason:
          claim.claimedPaise === other.claimedPaise
            ? `Bill ${claim.billNumber ?? claim.reference} is already claimed.`
            : `Bill ${claim.billNumber ?? claim.reference} is already claimed, for ₹${Math.round(other.claimedPaise / 100)} rather than ₹${Math.round(claim.claimedPaise / 100)}.`,
      });
      continue;
    }

    const sameDay = claim.expenseDate === other.expenseDate;
    const sameVendor =
      !!claim.vendorName &&
      !!other.vendorName &&
      claim.vendorName.trim().toLowerCase() === other.vendorName.trim().toLowerCase();

    if (sameVendor && sameDay && claim.claimedPaise === other.claimedPaise) {
      out.push({
        otherId: other.id,
        strength: "likely",
        matchedOn: ["vendor", "date", "amount"],
        reason: `The same amount at ${claim.vendorName} on the same day is already claimed.`,
      });
      continue;
    }

    if (sameDay && claim.kind === other.kind) {
      const bps = nearBps(claim.claimedPaise, other.claimedPaise);
      if (bps <= opts.nearAmountBps) {
        out.push({
          otherId: other.id,
          strength: "possible",
          matchedOn: ["date", "kind", "near amount"],
          reason:
            bps === 0
              ? `Another ${claim.kind.replace(/_/g, " ")} claim of the same amount is already on this day. Two of these on one day is ordinary — is this a second one?`
              : `Another ${claim.kind.replace(/_/g, " ")} claim of about the same amount is already on this day.`,
        });
      }
    }
  }

  const rank: Record<DuplicateStrength, number> = { certain: 0, likely: 1, possible: 2 };
  return out.sort((a, b) => rank[a.strength] - rank[b.strength]);
}

/* -------------------------------------------------------- §I48 abnormal KM */

export type LegHistory = {
  /** Metres per day, the person's own recent days. Used for the median. */
  dailyMetres: readonly number[];
};

export type KmBands = {
  /** A day beyond this many kilometres is questioned outright. */
  dailyKmCeiling: number | null;
  /** Basis points above the person's own median day. */
  aboveOwnMedianBps: number | null;
  /** GPS against odometer, in basis points. */
  varianceFlagBps: number;
};

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

const km = (metres: number) => `${(metres / 1000).toFixed(0)} km`;

/**
 * A day's distance held against the person's own recent days.
 *
 * The MEDIAN rather than the mean, and it matters: one 400 km day in a month
 * drags a mean up far enough to hide the next one, which is exactly backwards.
 *
 * **Too little history means no finding.** Three days is not a pattern, and a
 * flag raised against a person's second week is a flag raised against not
 * having been here long — which nobody can act on and everybody learns to
 * ignore.
 */
export function kmAnomalies(
  day: { totalMetres: number; gpsMetres: number | null; odometerMetres: number | null },
  history: LegHistory,
  bands: KmBands,
  minHistoryDays = 5,
): PolicyException[] {
  const out: PolicyException[] = [];

  if (bands.dailyKmCeiling !== null && day.totalMetres > bands.dailyKmCeiling * 1000) {
    out.push({
      kind: "over_km_ceiling",
      severity: "warn",
      message: `${km(day.totalMetres)} in one day, against a ${bands.dailyKmCeiling} km ceiling.`,
      detail: { totalMetres: day.totalMetres, ceilingKm: bands.dailyKmCeiling },
    });
  }

  const own = median(history.dailyMetres);
  if (
    bands.aboveOwnMedianBps !== null &&
    own !== null &&
    own > 0 &&
    history.dailyMetres.length >= minHistoryDays
  ) {
    const overBps = Math.round(((day.totalMetres - own) / own) * 10_000);
    if (overBps > bands.aboveOwnMedianBps) {
      out.push({
        kind: "over_km_ceiling",
        severity: "warn",
        message: `${km(day.totalMetres)} against his own usual ${km(own)} a day — ${Math.round(overBps / 100)}% more.`,
        detail: {
          totalMetres: day.totalMetres,
          ownMedianMetres: own,
          overBps,
          bandBps: bands.aboveOwnMedianBps,
          daysOfHistory: history.dailyMetres.length,
        },
      });
    }
  }

  if (day.gpsMetres !== null && day.odometerMetres !== null) {
    const top = Math.max(day.gpsMetres, day.odometerMetres);
    if (top > 0) {
      const bps = Math.round((Math.abs(day.gpsMetres - day.odometerMetres) / top) * 10_000);
      if (bps > bands.varianceFlagBps) {
        out.push({
          kind: "gps_odometer_variance",
          severity: "warn",
          message: `The odometer says ${km(day.odometerMetres)} across the day and the track says ${km(day.gpsMetres)}.`,
          detail: { gpsMetres: day.gpsMetres, odometerMetres: day.odometerMetres, varianceBps: bps },
        });
      }
    }
  }

  return out;
}

/* ----------------------------------------------------- §I49 abnormal spend */

export type SpendBands = {
  aboveOwnMedianBps: number | null;
  aboveTeamMedianBps: number | null;
};

/**
 * A day's spending held against the person's own history and the team's.
 *
 * Two comparisons rather than one, because they say different things. Above
 * his own average is "this is not how he usually works" — a question for him.
 * Above the team's is "this is not how the job is usually done" — a question
 * about the territory as much as the person, and the one worth raising for
 * somebody whose own history is short.
 *
 * Neither ever refuses a claim. They route it.
 */
export function spendAnomalies(
  dayClaimedPaise: number,
  ownHistoryPaise: readonly number[],
  teamHistoryPaise: readonly number[],
  bands: SpendBands,
  minHistoryDays = 5,
): PolicyException[] {
  const out: PolicyException[] = [];
  const rupees = (p: number) => `₹${Math.round(p / 100).toLocaleString("en-IN")}`;

  const own = median(ownHistoryPaise);
  if (
    bands.aboveOwnMedianBps !== null &&
    own !== null &&
    own > 0 &&
    ownHistoryPaise.length >= minHistoryDays
  ) {
    const overBps = Math.round(((dayClaimedPaise - own) / own) * 10_000);
    if (overBps > bands.aboveOwnMedianBps) {
      out.push({
        kind: "over_cap",
        severity: "warn",
        message: `${rupees(dayClaimedPaise)} on a day he usually spends ${rupees(own)} — ${Math.round(overBps / 100)}% more.`,
        detail: {
          dayClaimedPaise,
          ownMedianPaise: own,
          overBps,
          bandBps: bands.aboveOwnMedianBps,
          daysOfHistory: ownHistoryPaise.length,
        },
      });
    }
  }

  const team = median(teamHistoryPaise);
  if (
    bands.aboveTeamMedianBps !== null &&
    team !== null &&
    team > 0 &&
    teamHistoryPaise.length >= minHistoryDays
  ) {
    const overBps = Math.round(((dayClaimedPaise - team) / team) * 10_000);
    if (overBps > bands.aboveTeamMedianBps) {
      out.push({
        kind: "over_cap",
        severity: "info",
        message: `${rupees(dayClaimedPaise)} against a team day of ${rupees(team)}.`,
        detail: {
          dayClaimedPaise,
          teamMedianPaise: team,
          overBps,
          bandBps: bands.aboveTeamMedianBps,
          daysOfTeamHistory: teamHistoryPaise.length,
        },
      });
    }
  }

  return out;
}

/**
 * The alerts an owner is shown, worst first and capped.
 *
 * Requirement 69 asks for "only important exceptions requiring attention", and
 * that is a rule about what is LEFT OUT. A dashboard listing every info-level
 * note is a dashboard nobody opens twice, and the one finding that mattered is
 * on page three of it.
 */
export function ownerAlerts(
  exceptions: readonly PolicyException[],
  limit = 20,
): PolicyException[] {
  const order: Record<Severity, number> = { block_route: 0, warn: 1, info: 2 };
  return exceptions
    .filter((e) => e.severity !== "info")
    .sort((a, b) => order[a.severity] - order[b.severity])
    .slice(0, limit);
}
