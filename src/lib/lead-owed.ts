/* ---------------------------------------------------------------------------
 * WHEN A LEAD NEXT WANTS SOMEBODY, AND WHICH OF THREE DAYS THAT IS.
 *
 * A lead can be carrying three different promises at once and they were never
 * the same promise:
 *
 *   `lead_next_follow_up_date`  the salesman's own diary — "I will go back on
 *                               the 14th". It predates the funnel and is most
 *                               of what an old book has.
 *   `lead_next_action_date`     §24's rule — an active lead may not sit with
 *                               nothing owed by anybody, so the action, the
 *                               day, the person and the expected answer are
 *                               written together. It is what every upward move
 *                               since the funnel landed has demanded.
 *   `lead_hold_resume_date`     a park somebody deliberately set — "back after
 *                               Diwali". Nothing chases it; the day arriving
 *                               IS the event.
 *
 * KEYING ON ANY ONE OF THEM IS WRONG IN A WAY NOTHING ON THE SCREEN SHOWS. The
 * action alone is null across a book §24 never applied to. The follow-up alone
 * hides every lead anybody has moved up a rung since. And the park is on
 * neither, so a lead sitting parked past its own resume day reads as owing
 * nobody anything — which is exactly the lead the park was set to make sure
 * somebody looked at again.
 *
 * So the answer is the EARLIEST of the three, with the one it came from named
 * beside it. That is what the CRM already answers about a customer's next step
 * and what the handset settled on for the same question about a lead
 * (`mbos-app/src/engines/leads.ts`, `leadOwed`) — this is that rule in the
 * office's runtime. The two cannot import each other, one being an Expo
 * package, so what is shared is the reasoning and the tie-break; keep them in
 * step by hand, as every other mirrored rule here is.
 *
 * WHAT PAYS FOR THE WIDTH IS THAT THE CALLER SAYS WHICH. "Late — you said you
 * would go back on the 14th" and "Late — back off hold since the 14th" are two
 * different mornings, and a date that caught both while naming neither is a
 * cell nobody can act on.
 *
 * PURE AND CLIENT-SAFE, like `lead-priority` and `customer-health` beside it,
 * because the table that draws this is a client component and the service that
 * sorts on it is `server-only`. A second copy typed into the screen would
 * drift inside a release, and the half that drifts is always the half somebody
 * reads.
 *
 * NOTHING HERE PARSES A DATE. ISO days sort as text, so every comparison below
 * is string-to-string — a comparison between two calendar days needs no
 * midnight and therefore names no zone. `day` is the business date the CALLER
 * resolved on the server; reading the clock here would be both impure under
 * the React Compiler rules and wrong by five and a half hours on a server in
 * UTC.
 * ------------------------------------------------------------------------- */

import { daysBetween } from "./format";

/** Which of the three days the answer came from. */
export type OwedSource = "action" | "promise" | "hold";

export type LeadOwed = {
  /** The day itself, ISO. */
  date: string;
  source: OwedSource;
  /** 0 unless the day has gone. Never negative — see `owedTone`. */
  daysLate: number;
  /** Whether the day is the business date the caller passed in. */
  isToday: boolean;
};

/** The three columns and the rung, and nothing else about the lead. */
export type OwedFacts = {
  nextActionDate: string | null;
  nextFollowUpDate: string | null;
  holdResumeDate: string | null;
  stage: string;
};

/**
 * A park counts only on a lead that is actually parked.
 *
 * `lead_hold_resume_date` OUTLIVES the resume — nothing clears it when the
 * lead comes back — so a lead somebody unparked in March would otherwise go on
 * being owed for ever on the strength of a day it already honoured.
 */
function parkedResumeDate(facts: OwedFacts): string | null {
  return facts.stage === "on_hold" ? facts.holdResumeDate : null;
}

/**
 * The earliest of the three, and which one it is.
 *
 * Null where nothing is owed at all, so the caller says so in its own words
 * rather than this file inventing a sentence about an absence.
 *
 * TIES GO TO THE ACTION, then to the promise. Where two fall on one day they
 * are the same morning, and §24's is the more useful of two true sentences: it
 * is the only one of the three with a person and an expected answer attached.
 */
export function leadOwed(facts: OwedFacts, day: string): LeadOwed | null {
  const candidates: Array<{ date: string; source: OwedSource }> = [];
  const add = (date: string | null, source: OwedSource) => {
    if (date) candidates.push({ date: date.slice(0, 10), source });
  };
  add(facts.nextActionDate, "action");
  add(facts.nextFollowUpDate, "promise");
  add(parkedResumeDate(facts), "hold");
  if (!candidates.length) return null;

  /* Stable sort, so the push order above is the tie-break. */
  const first = [...candidates].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  )[0];

  return {
    date: first.date,
    source: first.source,
    daysLate: first.date < day ? daysBetween(first.date, day) : 0,
    isToday: first.date === day,
  };
}

/**
 * WHAT TONE A DUE DATE IS DRAWN IN, and it is the one place that is decided.
 *
 * §8.4 asks for red on an overdue day and amber on one falling today, and the
 * reason it asks is scale: on four hundred rows a promise somebody broke a
 * fortnight ago is drawn exactly like one due next month, so the list sorts
 * the urgent work to the top and then says nothing whatever about it.
 *
 * `null` is the third answer and means DRAW IT PLAIN — a day still ahead is
 * not a problem, and a column where every cell is coloured is a column where
 * no cell is. It is also what a lead owing nothing gets: that absence is said
 * in words in the cell, and colouring it would claim it is the same size of
 * failure as a missed promise. It is not — §24's exception desk is where a
 * lead with nothing owed is chased, and it is a link on this very screen.
 *
 * `danger` and `warn` and never `warning`: several callers in this codebase
 * write the third and are silently drawn as ordinary.
 */
export function owedTone(owed: LeadOwed | null): "danger" | "warn" | null {
  if (!owed) return null;
  if (owed.daysLate > 0) return "danger";
  return owed.isToday ? "warn" : null;
}

/**
 * The half-dozen words under the date saying which promise it is.
 *
 * Short deliberately: this is a 130px cell on a table of four hundred rows,
 * not the record's own full-width band, so it names the SOURCE and leaves the
 * sentence to the hover. What it must not do is stay silent — a bare date that
 * is sometimes §24's action, sometimes the salesman's diary and sometimes a
 * park coming back is one figure standing for three facts.
 */
export function owedWord(owed: LeadOwed): string {
  switch (owed.source) {
    case "action":
      return "Next action";
    case "promise":
      return "Promised";
    case "hold":
      return "Off hold";
  }
}

/** The whole sentence, for the cell's hover. */
export function owedSentence(owed: LeadOwed, pretty: (iso: string) => string): string {
  const when = pretty(owed.date);
  if (owed.daysLate > 0) {
    const late = `${owed.daysLate} ${owed.daysLate === 1 ? "day" : "days"} overdue`;
    switch (owed.source) {
      case "action":
        return `${late} — the next action on this lead was due on ${when}.`;
      case "promise":
        return `${late} — the salesman said he would go back on ${when}.`;
      case "hold":
        return `${late} — this lead came back off hold on ${when} and nobody has picked it up.`;
    }
  }
  const day = owed.isToday ? `today, ${when}` : when;
  switch (owed.source) {
    case "action":
      return `The next action on this lead falls ${day}.`;
    case "promise":
      return `The salesman said he would go back ${day}.`;
    case "hold":
      return `This lead comes back off hold ${day}.`;
  }
}
