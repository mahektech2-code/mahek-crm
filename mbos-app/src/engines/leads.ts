/**
 * Leads — the rules, with no I/O in sight.
 *
 * Everything here takes what it needs as an argument and returns an answer, so
 * the two rules that actually cost money if they are wrong — a lead that is
 * already somebody's customer, and a stage change nobody has to explain — are
 * pinned by tests that need neither SQLite nor a handset.
 */

export const LEAD_STAGES = ['New', 'Contacted', 'Qualified', 'Negotiation', 'On hold', 'Converted', 'Lost'] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

/** Archived is a FILTER. A lead is never deleted, only kept out of the way. */
export const LEAD_FILTERS = ['All', 'New', 'Contacted', 'Qualified', 'Negotiation', 'On hold', 'Lost', 'Archived'] as const;
export type LeadFilter = (typeof LEAD_FILTERS)[number];

/**
 * Where a lead came from.
 *
 * Short enough to be a row of chips, because a salesman standing outside the
 * shop will pick one and will not type one. It sits here rather than in a
 * screen so both the form and anything that later counts by source read the
 * same list.
 */
export const LEAD_SOURCES = ['Walked past', 'Referral', 'Market enquiry', 'Exhibition', 'Office'] as const;

/**
 * What the account IS in the trade.
 *
 * The values are the server's `customer_type` enum verbatim, so a converted
 * lead needs no translation on the way through — this is the one field on the
 * lead form that is already a column on `customers` and will still be one
 * after the account is opened. The LABELS are separate because "manufacturer"
 * is a database word and "makes things, buys to use" is what a salesman is
 * actually deciding between outside a shop.
 */
export const CUSTOMER_TYPES = [
  { value: 'dealer', label: 'Dealer' },
  { value: 'retailer', label: 'Retailer' },
  { value: 'distributor', label: 'Distributor' },
  { value: 'manufacturer', label: 'Manufacturer' },
] as const;

/**
 * A mobile number as it will be compared, not as it was typed.
 *
 * The same shop is written `98220 11001`, `+91 9822011001` and `09822011001`
 * by three different people, and a duplicate check that compares the strings
 * finds none of them. Indian mobiles are ten digits and start 6 to 9, so a
 * leading 0 or 91 on a longer string is a prefix rather than part of it.
 */
export function normaliseMobile(raw: string | null | undefined): string {
  let digits = String(raw ?? '').replace(/\D/g, '');
  while (digits.length > 10 && (digits.startsWith('0') || digits.startsWith('91'))) {
    digits = digits.startsWith('0') ? digits.slice(1) : digits.slice(2);
  }
  return digits;
}

export type DuplicateMatch = { kind: 'customer' | 'lead'; id: string; name: string };

/**
 * Whoever already has this number.
 *
 * Customers are checked before leads because being on the book is the stronger
 * fact: a salesman who is told "already a lead" opens the lead, and one who is
 * told "already a customer" stops selling and starts serving. The caller shows
 * the record rather than a bare refusal — "duplicate" with nothing to open is
 * how the number gets typed a second time with a digit changed.
 */
export function matchDuplicate(
  mobile: string,
  customers: { id: string; name: string; phone: string | null }[],
  leads: { id: string; name: string; mobile: string | null }[],
): DuplicateMatch | null {
  const wanted = normaliseMobile(mobile);
  if (wanted.length < 10) return null;

  const customer = customers.find((c) => normaliseMobile(c.phone) === wanted);
  if (customer) return { kind: 'customer', id: customer.id, name: customer.name };

  const lead = leads.find((l) => normaliseMobile(l.mobile) === wanted);
  if (lead) return { kind: 'lead', id: lead.id, name: lead.name };

  return null;
}

/**
 * Why a stage change cannot be saved, or null to allow it.
 *
 * Lost is the only one that asks. Every other move is the ordinary progress of
 * a conversation and making somebody justify it teaches them to type a full
 * stop; a lead marked Lost is a shop nobody will ring again, and the reason is
 * the whole value of the record after that.
 */
export function stageRefusal(stage: string, reason: string | null | undefined): string | null {
  const said = String(reason ?? '').trim();
  if (stage === 'Lost') {
    return said ? null : 'Say why it was lost — nobody rings this shop again after this.';
  }
  /* On hold asks too, and for the opposite reason to Lost. Lost wants the
     reason because nobody will ever look again; this one wants it because
     somebody will — "back after Diwali" is what tells them when. */
  if (stage === 'On hold') {
    return said ? null : 'Say what you are waiting for — that is what tells anybody when to pick it up again.';
  }
  return null;
}

/* ------------------------------------------------------- the visit cap */

/**
 * How many visits a Suspect has had, and what the handset should do about it.
 *
 * §B asks for a maximum "enforced". Enforced as a REFUSAL is the one shape
 * this app must not use — `engines/geo.ts` states the principle the whole
 * field product rests on, that a reading is evidence and never a gate, because
 * a salesman whose visit is refused stops recording visits and the company
 * loses the GPS, the competitor note and the reason to stop a number reaching
 * four. What §B actually wants is that nobody keeps visiting a shop nobody has
 * decided about, and that is bought by demanding an ANSWER.
 *
 * So there are three states and none of them blocks anything:
 *   `ok`      nothing to say.
 *   `warn`    the next visit will need a decision. Said early, so the answer
 *             is not sprung on somebody standing in a shop.
 *   `decide`  this visit needs one before it can be closed.
 *
 * The thresholds are configuration and arrive from the office — the server
 * enforces `decide` against the same two numbers, which is what keeps the two
 * runtimes agreeing without a shared module they cannot have.
 */
export type VisitCapState = 'ok' | 'warn' | 'decide';

export type VisitCapThresholds = { visitsBeforeDecision: number; maxSuspectVisits: number };

/** Only these two are a Suspect. A qualified prospect being visited again is a
 *  negotiation, not a stall, and must never be asked to justify itself. */
const SUSPECT_STAGES = ['New', 'Contacted'];

export function visitCapState(
  stage: string,
  /** Visits already recorded. The one being made is this plus one. */
  visitsSoFar: number,
  cfg: VisitCapThresholds,
): VisitCapState {
  if (!SUSPECT_STAGES.includes(stage)) return 'ok';
  const thisVisit = visitsSoFar + 1;
  if (thisVisit >= cfg.maxSuspectVisits) return 'decide';
  if (thisVisit >= cfg.visitsBeforeDecision) return 'warn';
  return 'ok';
}

/**
 * "Visit 2 / 3" — what the lead card prints.
 *
 * Null where there is nothing to say, so a qualified prospect's card carries no
 * counter at all rather than one that has stopped meaning anything.
 */
export function visitCapLabel(
  stage: string,
  visitsSoFar: number,
  cfg: VisitCapThresholds,
): string | null {
  if (!SUSPECT_STAGES.includes(stage)) return null;
  /* Past the cap it keeps counting rather than sticking at "3 / 3": a fourth
     visit happened, the manager has been told, and a counter that lies about
     it is worse than one that reads oddly. */
  return 'Visit ' + visitsSoFar + ' / ' + cfg.maxSuspectVisits;
}

/** A follow-up in the past is a follow-up nobody will be reminded about. */
export function followUpRefusal(iso: string | null | undefined, today: string): string | null {
  if (!iso) return null;
  return iso < today ? 'That day has gone. Pick today or later.' : null;
}

export type LeadTiming = {
  stage: string;
  archived: number;
  nextFollowUpDate: string | null;
  lastActivityDate: string | null;
};

export type LeadThresholds = { staleDays: number; archiveDays: number; escalateAfterDays: number };

/** Whole days between two calendar dates, never negative. */
export function daysBetween(from: string | null, to: string): number | null {
  if (!from) return null;
  const a = new Date(from + 'T00:00:00').getTime();
  const b = new Date(to + 'T00:00:00').getTime();
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/**
 * The one sentence a lead card carries about time, or none.
 *
 * Ordered by what the salesman should do about it first: a follow-up he
 * promised and missed outranks a lead that has merely gone quiet, and a
 * settled lead — converted, lost, archived — says nothing at all, because
 * there is nothing left to do about it.
 */
export function leadAlert(lead: LeadTiming, today: string, cfg: LeadThresholds): string | null {
  if (lead.archived || lead.stage === 'Converted' || lead.stage === 'Lost') return null;

  if (lead.nextFollowUpDate && lead.nextFollowUpDate < today) {
    const late = daysBetween(lead.nextFollowUpDate, today) ?? 0;
    return late === 1 ? 'Follow-up was yesterday' : 'Follow-up was ' + late + ' days ago';
  }

  const quiet = daysBetween(lead.lastActivityDate, today);
  if (quiet == null) return null;
  if (quiet >= cfg.archiveDays) return 'Nothing for ' + quiet + ' days — archive it or ring it';
  if (quiet >= cfg.staleDays) return 'Gone quiet — ' + quiet + ' days since anything happened';
  if (lead.stage === 'New' && quiet >= cfg.escalateAfterDays) {
    return 'Untouched for ' + quiet + ' days — your manager sees this one';
  }
  return null;
}
