/**
 * Leads — the rules, with no I/O in sight.
 *
 * Everything here takes what it needs as an argument and returns an answer, so
 * the two rules that actually cost money if they are wrong — a lead that is
 * already somebody's customer, and a stage change nobody has to explain — are
 * pinned by tests that need neither SQLite nor a handset.
 */

export const LEAD_STAGES = ['New', 'Contacted', 'Qualified', 'Negotiation', 'Converted', 'Lost'] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

/** Archived is a FILTER. A lead is never deleted, only kept out of the way. */
export const LEAD_FILTERS = ['All', 'New', 'Contacted', 'Qualified', 'Negotiation', 'Lost', 'Archived'] as const;
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
  if (stage !== 'Lost') return null;
  return String(reason ?? '').trim() ? null : 'Say why it was lost — nobody rings this shop again after this.';
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
