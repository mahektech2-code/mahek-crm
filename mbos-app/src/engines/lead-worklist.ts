import { isParked, isTerminal, type LeadStage } from './funnel';

/**
 * §24 on the phone — what is owed on a lead, and by when.
 *
 * The rule is that an active lead may not sit with nothing owed by anybody:
 * the ACTION, the DAY, the PERSON and what that person is expected to come
 * back with. A date alone is how a lead sits for six weeks with everybody
 * assuming somebody else is holding it, so the four answers are carried
 * separately here and nowhere folded into one sentence — the screen draws the
 * missing ones as missing.
 *
 * ---------------------------------------------------------------------------
 * IT IS THE SERVER'S TWO WINDOWS, RE-STATED IN JAVASCRIPT AND NOT RE-DECIDED.
 * `src/lib/lead-action-window.ts` is where they live on the office side, as
 * two SQL fragments; a fragment cannot be shipped to a handset and a handset
 * cannot ask a server for them, because the salesman reading this list is in a
 * market lane with one bar. What is copied is the SHAPE of the two windows,
 * and it is copied deliberately rather than approximated:
 *
 *   due today  — the day falls today, OR a park reads back today
 *   overdue    — the day has gone, OR a park's day has gone
 *
 * The park half of each is the load-bearing bit. A lead parked until the 25th
 * comes back into the salesman's own list on the 25th BY ITSELF — nobody
 * promises it, a date arrives — and a window that only read `nextActionDate`
 * would leave every parked lead invisible on the morning it was supposed to
 * return.
 *
 * ONE CLAUSE OF THE SERVER'S OVERDUE WINDOW IS DELIBERATELY NOT COPIED, and
 * copying it would have emptied this screen. The office adds
 * `lead_next_action_outcome is null`, reading that column as whether anybody
 * has written down what happened. On THIS phone that column holds the
 * opposite: `next-action-sheet.tsx` asks "what you expect to come back with"
 * and writes it in the same breath as the action and the day. So a salesman
 * who did the thorough job — action, day, person AND what he is after — would
 * have had that lead silently excluded from Overdue for ever, while the
 * half-filled ones showed up. The two ends mean different things by one word,
 * which is worth knowing about and is not this file's to settle; what this
 * file can do is not act on the word it does not own.
 *
 * ---------------------------------------------------------------------------
 * EVERY COMPARISON IS STRING-TO-STRING, and that is not laziness. These are
 * `YYYY-MM-DD` columns, which sort lexicographically in exactly date order, so
 * comparing them as written needs no parse — and a parse is where this goes
 * wrong, because `Date.parse('2026-09-25')` is specified to read a date-only
 * string as UTC and lands five and a half hours before the day it names. The
 * only place a day is turned into an instant here is `daysSince`, which spells
 * its own local midnight.
 *
 * Pure, like every engine in this app, and for the reason all of them are: the
 * man this list is for has no signal, and a rule that only exists on the
 * server is a rule he finds out about on the drive home. It takes the columns
 * it reads rather than the `Lead` row, which is what keeps it out of `data/`
 * and what lets a test state a case in five lines instead of sixty.
 */

/**
 * What these rules read off a lead, and nothing else.
 *
 * Every caller passes a whole `Lead` and the generics below hand the same rows
 * back, so nothing is copied or narrowed on the way through — this is the
 * contract rather than a projection.
 */
export type WorklistLead = {
  name: string;
  /** SQLite's boolean. Truthy is archived. */
  archived: number;
  /** The six-word column this app shipped with. */
  stage: string;
  /** The specification's rung, or null on a lead raised before the funnel. */
  funnelStage: string | null;
  nextAction: string | null;
  nextActionDate: string | null;
  nextActionOwnerId: string | null;
  nextActionOutcome: string | null;
  holdResumeDate: string | null;
  lastActivityDate: string | null;
};

/**
 * The four questions a salesman's morning is made of.
 *
 * `parked` OVERLAPS the first two on purpose and the overlap is the honest
 * shape rather than a bug to tidy. A lead parked until today is owed today AND
 * is parked; the first two are the work, and this one is the register — what
 * is put away and when it is coming back. Reading the register is how somebody
 * finds out that eleven leads all return next Monday, which neither of the
 * dated cuts can say.
 */
export type LeadActionView = 'today' | 'overdue' | 'parked' | 'none';

export const LEAD_ACTION_VIEWS = ['today', 'overdue', 'parked', 'none'] as const;

/** What each view calls itself, and what it is showing, said in words. */
export const VIEW_TEXT: Record<LeadActionView, { chip: string; title: string; sub: string }> = {
  today: {
    chip: 'Due today',
    title: 'Owed today',
    sub: 'A next action falling due, and a lead whose hold ends today.',
  },
  overdue: {
    chip: 'Overdue',
    title: 'Past its day',
    sub: 'The day has gone and nobody has written down what happened.',
  },
  parked: {
    chip: 'On hold',
    title: 'Parked, not lost',
    sub: 'Put away until a day somebody named. They come back here by themselves.',
  },
  none: {
    chip: 'Nothing owed',
    title: 'Nobody owes anything',
    sub: 'Live leads with no next action on them at all. Each one needs a day and a person.',
  },
};

/**
 * The rung this lead is standing on, or null where it is not on a ladder.
 *
 * `funnelStage` is the specification's rung and `stage` is the six-word column
 * this app shipped with — see the funnel migration for why the row carries
 * both. A lead raised before the funnel existed has only the second, and
 * pretending it has a rung would hand `roleAction` a stage it cannot switch
 * on. Null is the honest answer and every caller below reads it as one.
 */
export function rungOf(lead: Pick<WorklistLead, 'funnelStage'>): LeadStage | null {
  return (lead.funnelStage as LeadStage | null) ?? null;
}

/**
 * Still the funnel's work.
 *
 * Both vocabularies are read, because both are live on this phone: a lead with
 * a rung is finished when the ladder says so, and a legacy lead is finished
 * when its own column says Converted or Lost. Reading only the first would put
 * every legacy lead on every worklist for ever — they have no rung, so nothing
 * would ever call them terminal.
 */
export function stillWorking(lead: Pick<WorklistLead, 'funnelStage' | 'stage' | 'archived'>): boolean {
  if (lead.archived) return false;
  const rung = rungOf(lead);
  if (rung) return !isTerminal(rung);
  return lead.stage !== 'Converted' && lead.stage !== 'Lost';
}

/** Put away until a day. Parked displaces the rung rather than ending the climb. */
export function parked(lead: Pick<WorklistLead, 'funnelStage' | 'stage'>): boolean {
  const rung = rungOf(lead);
  return rung ? isParked(rung) : lead.stage === 'On hold';
}

/** Owed today: a promise falling due, or a park whose day has come. */
export function dueToday(lead: WorklistLead, today: string): boolean {
  if (!stillWorking(lead)) return false;
  if (parked(lead)) return lead.holdResumeDate === today;
  return lead.nextActionDate === today;
}

/** Past its day. See the header for the clause this does not carry. */
export function overdue(lead: WorklistLead, today: string): boolean {
  if (!stillWorking(lead)) return false;
  if (parked(lead)) return !!lead.holdResumeDate && lead.holdResumeDate < today;
  return !!lead.nextActionDate && lead.nextActionDate < today;
}

/**
 * §24's violation: a live lead with nothing owed by anybody.
 *
 * A park is deliberately not one of these. Somebody DID decide something about
 * it — they decided to stop, and named the day it comes back — which is the
 * opposite of a lead nobody is holding.
 */
export function nothingOwed(lead: WorklistLead): boolean {
  return stillWorking(lead) && !parked(lead) && !lead.nextActionDate;
}

/** Every parked lead, whether its day has come or not. The register. */
export function onHold(lead: WorklistLead): boolean {
  return stillWorking(lead) && parked(lead);
}

export function inView(lead: WorklistLead, view: LeadActionView, today: string): boolean {
  switch (view) {
    case 'today':
      return dueToday(lead, today);
    case 'overdue':
      return overdue(lead, today);
    case 'parked':
      return onHold(lead);
    case 'none':
      return nothingOwed(lead);
  }
}

/**
 * The day this row turns on, whichever kind of row it is.
 *
 * A park's day is its resume date and a promise's is its action date, and the
 * screens sort and count in days from one or the other — so the choice is made
 * once, here, rather than at each of the four call sites that would each get
 * it right for three views and wrong for the fourth.
 */
export function dayOf(lead: WorklistLead): string | null {
  return parked(lead) ? lead.holdResumeDate : lead.nextActionDate;
}

/**
 * The rows for a view, in the order the work should be done.
 *
 * Each view sorts on the thing it is ABOUT: the latest first where the
 * question is lateness, the soonest first where it is a return somebody is
 * waiting on, and the quietest first where the question is which lead has been
 * left alone longest. One sort for all four would put a lead nine days late
 * below one an hour late on three of the screens.
 */
export function rowsFor<T extends WorklistLead>(
  leads: readonly T[],
  view: LeadActionView,
  today: string,
): T[] {
  const rows = leads.filter((l) => inView(l, view, today));
  const day = (l: T) => dayOf(l) ?? '';
  switch (view) {
    case 'overdue':
      /* Oldest day first — the one that has been waiting longest. */
      return rows.sort((a, b) => day(a).localeCompare(day(b)) || a.name.localeCompare(b.name));
    case 'parked':
      /* Soonest back first, so what has already read back sits at the top. */
      return rows.sort((a, b) => day(a).localeCompare(day(b)) || a.name.localeCompare(b.name));
    case 'none':
      /* Quietest first. A lead nobody has touched for a month with nothing
         owed on it is the one this view exists to catch. */
      return rows.sort(
        (a, b) =>
          (a.lastActivityDate ?? '').localeCompare(b.lastActivityDate ?? '') ||
          a.name.localeCompare(b.name),
      );
    default:
      return rows.sort((a, b) => a.name.localeCompare(b.name));
  }
}

export type LeadActionCounts = Record<LeadActionView, number> & { working: number };

/**
 * All five figures off ONE pass of the book.
 *
 * The stat row on Home and the chips on the worklist read the same object, so
 * a tile saying eleven and the screen it opens listing nine is not a state
 * this can reach. Counting each view with its own read is exactly how those
 * two come apart.
 */
export function countLeads(leads: readonly WorklistLead[], today: string): LeadActionCounts {
  const counts: LeadActionCounts = { today: 0, overdue: 0, parked: 0, none: 0, working: 0 };
  for (const lead of leads) {
    if (!stillWorking(lead)) continue;
    counts.working += 1;
    if (dueToday(lead, today)) counts.today += 1;
    if (overdue(lead, today)) counts.overdue += 1;
    if (onHold(lead)) counts.parked += 1;
    if (nothingOwed(lead)) counts.none += 1;
  }
  return counts;
}

/**
 * Which of the four answers §24 wants are missing on this lead.
 *
 * Named rather than counted, because "3 of 4" tells somebody there is a hole
 * and not which hole.
 *
 * The expected outcome is named although the form marks it optional, and that
 * is not this list overruling the form. §24 asks for four answers and the form
 * refuses on three; the fourth — what that person comes back with — is the one
 * that turns a diary entry into something somebody can be held to, and it is
 * the one most often left blank. Saying it is absent costs a salesman nothing
 * and is the only way anybody finds out how often it is.
 */
export function missingAnswers(lead: WorklistLead): string[] {
  const missing: string[] = [];
  if (!lead.nextAction?.trim()) missing.push('what will be done');
  if (!lead.nextActionDate) missing.push('the day');
  if (!lead.nextActionOwnerId) missing.push('who is doing it');
  if (!lead.nextActionOutcome?.trim()) missing.push('what they come back with');
  return missing;
}
