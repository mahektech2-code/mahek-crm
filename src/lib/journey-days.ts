/* ---------------------------------------------------------------------------
 * WHAT A PLANNED DAY CAME TO — PURE.
 *
 * Journeys & visits reads one salesman's days four ways — the team table, the
 * calendar, the list and the day drawer — and every one of them asks the same
 * questions about a day: how many shops were allocated, how many he walked
 * into, how many he skipped with a reason, how many simply never happened, and
 * whose move it is now. Four screens deriving that four times is four answers
 * the day the rule changes, so it lives here, takes the business date as an
 * argument like every engine, and reads nothing.
 *
 * Client-safe on purpose: the calendar and the drawer are client components.
 * ------------------------------------------------------------------------- */

import { addDays, isoWeekday } from "./business-date";
import { areasSignature, type SignedArea } from "./territory-signature";

export type DayState = "proposed" | "refused" | "agreed" | "planned";

/**
 * What became of one allocated shop.
 *
 * `missed` is the one the stored status cannot say: a stop still `planned`
 * on a day that has gone was neither walked nor skipped — nobody gave a
 * reason, it just did not happen. Calling it `planned` on a day in March reads
 * as a route still to come, which is the most reassuring word available on
 * the row that has earned it least. Today's planned stops are `pending`: the
 * day is still being worked.
 */
export type StopFate = "visited" | "skipped" | "missed" | "pending";

export function stopFate(status: string, planDate: string, today: string): StopFate {
  if (status === "visited") return "visited";
  if (status === "skipped") return "skipped";
  return planDate < today ? "missed" : "pending";
}

export type DayTally = {
  /** Shops on the day's route — what the plan promised. */
  allocated: number;
  visited: number;
  skipped: number;
  missed: number;
  pending: number;
  /** Visits to shops that were not on the route. Ordinary, and counted. */
  offPlan: number;
  /** Every visit logged that day, on the route or off it. */
  visits: number;
  /**
   * Visited over allocated, as a whole percentage. Null where nothing was
   * allocated — a day with no route has no adherence to speak of, and 0%
   * would read as a salesman who ignored one.
   */
  adherencePct: number | null;
};

export function tallyDay(
  day: { planDate: string; stops: ReadonlyArray<{ status: string }> },
  visits: ReadonlyArray<{ wasPlanned: boolean }>,
  today: string,
): DayTally {
  const t: DayTally = {
    allocated: day.stops.length,
    visited: 0,
    skipped: 0,
    missed: 0,
    pending: 0,
    offPlan: visits.filter((v) => !v.wasPlanned).length,
    visits: visits.length,
    adherencePct: null,
  };
  for (const s of day.stops) t[stopFate(s.status, day.planDate, today)] += 1;
  t.adherencePct = t.allocated ? Math.round((t.visited / t.allocated) * 100) : null;
  return t;
}

/** Several days' tallies added up. Adherence is recomputed, never averaged. */
export function sumTallies(tallies: ReadonlyArray<DayTally>): DayTally {
  const t = tallies.reduce(
    (a, b) => ({
      allocated: a.allocated + b.allocated,
      visited: a.visited + b.visited,
      skipped: a.skipped + b.skipped,
      missed: a.missed + b.missed,
      pending: a.pending + b.pending,
      offPlan: a.offPlan + b.offPlan,
      visits: a.visits + b.visits,
      adherencePct: null as number | null,
    }),
    {
      allocated: 0,
      visited: 0,
      skipped: 0,
      missed: 0,
      pending: 0,
      offPlan: 0,
      visits: 0,
      adherencePct: null as number | null,
    },
  );
  t.adherencePct = t.allocated ? Math.round((t.visited / t.allocated) * 100) : null;
  return t;
}

/**
 * WHOSE MOVE IT IS, in words.
 *
 * A day in the negotiation always owes somebody something until it is walked,
 * and the screen's whole job is to make that visible: a refused day is waiting
 * on the office, a proposed one on him, an agreed one on him to pick shops. A
 * day that went past still unanswered is `lapsed` — nobody will act on it any
 * more, and it is drawn as the gap it was rather than as something to do.
 */
export type DayOwed = {
  owner: "manager" | "salesman" | null;
  tone: "danger" | "warn" | "success" | "brand" | "neutral";
  text: string;
};

export function dayOwed(
  plan: { planDate: string; dayState: DayState; stops: ReadonlyArray<unknown> } | null,
  today: string,
): DayOwed {
  if (!plan) {
    return { owner: null, tone: "neutral", text: "Nothing planned" };
  }
  const past = plan.planDate < today;
  switch (plan.dayState) {
    case "refused":
      return past
        ? { owner: null, tone: "neutral", text: "Refused, never settled" }
        : { owner: "manager", tone: "danger", text: "He refused — waiting on you" };
    case "proposed":
      return past
        ? { owner: null, tone: "neutral", text: "Proposed, never answered" }
        : { owner: "salesman", tone: "warn", text: "Proposed — waiting on him" };
    case "agreed":
      return past
        ? { owner: null, tone: "neutral", text: "Agreed, no shops picked" }
        : { owner: "salesman", tone: "brand", text: "Agreed — he picks the shops" };
    case "planned":
      if (!plan.stops.length) {
        return { owner: null, tone: "neutral", text: "Planned with no stops" };
      }
      return past
        ? { owner: null, tone: "success", text: "Walked" }
        : plan.planDate === today
          ? { owner: null, tone: "success", text: "On the road today" }
          : { owner: null, tone: "success", text: "Route ready" };
  }
}

/** The word on a state pill. One map, so the calendar and the list agree. */
export const DAY_STATE_LABEL: Record<DayState, string> = {
  proposed: "Proposed",
  refused: "Refused",
  agreed: "Agreed",
  planned: "Planned",
};

export const DAY_STATE_TONE: Record<DayState, "warn" | "danger" | "brand" | "success"> = {
  proposed: "warn",
  refused: "danger",
  agreed: "brand",
  planned: "success",
};

/* ------------------------------------------------------------ the calendar */

/** `YYYY-MM` from a URL, falling back to the month `today` is in. */
export function monthParam(raw: string | undefined, today: string): string {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(raw ?? "") ? raw! : today.slice(0, 7);
}

/**
 * A month as whole weeks, Monday first.
 *
 * The grid runs from the Monday on or before the 1st to the Sunday on or after
 * the last day, so every row is a real week and a plan that straddles the
 * month boundary is drawn on its own week rather than cut off.
 */
export function monthGrid(month: string): { from: string; to: string; days: string[] } {
  const first = `${month}-01`;
  const from = addDays(first, 1 - isoWeekday(first));
  const [y, m] = month.split("-").map(Number);
  const last = addDays(`${y + (m === 12 ? 1 : 0)}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01`, -1);
  const to = addDays(last, 7 - isoWeekday(last));
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return { from, to, days };
}

/** Every date from `from` to `to`, both ends. */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/* ------------------------------------------------- what he said about areas */

export type AreaAnswer = {
  kind: "accept" | "change";
  at: string;
  signature: string;
  requested: string[];
  reason: string | null;
  state: string;
} | null;

/**
 * Where he stands on the areas he was allocated.
 *
 * An acceptance counts only for the allocation he was shown — the signature is
 * compared with what stands now, exactly as Territory compares it — so a yes
 * to last month's cities is said as that rather than as a yes to this month's.
 */
export function areaAnswerState(
  territories: ReadonlyArray<SignedArea>,
  answer: AreaAnswer,
): {
  key: "none-allocated" | "unanswered" | "accepted" | "accepted-earlier" | "change-pending" | "change-approved" | "change-declined";
  tone: "danger" | "warn" | "success" | "neutral";
  text: string;
} {
  const areas = territories.filter((t) => t.kind !== "region");
  if (!areas.length && !answer) {
    return { key: "none-allocated", tone: "danger", text: "No area allocated — his handset shows no shops" };
  }
  if (!answer) {
    return { key: "unanswered", tone: "warn", text: "Not yet accepted on the handset" };
  }
  if (answer.kind === "accept") {
    return answer.signature === areasSignature(areas)
      ? { key: "accepted", tone: "success", text: "Accepted" }
      : { key: "accepted-earlier", tone: "warn", text: "Accepted an earlier allocation — not this one" };
  }
  const asked = answer.requested.length ? answer.requested.join(", ") : "different areas";
  if (answer.state === "approved") {
    return { key: "change-approved", tone: "warn", text: `Asked for ${asked} — approved; he has not accepted the result yet` };
  }
  if (answer.state === "rejected") {
    return { key: "change-declined", tone: "neutral", text: `Asked for ${asked} — declined` };
  }
  return { key: "change-pending", tone: "danger", text: `Asked for ${asked} — waiting on Approvals` };
}
