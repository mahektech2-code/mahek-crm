/**
 * Leads — the rules, with no I/O in sight.
 *
 * Everything here takes what it needs as an argument and returns an answer, so
 * the two rules that actually cost money if they are wrong — a lead that is
 * already somebody's customer, and a stage change nobody has to explain — are
 * pinned by tests that need neither SQLite nor a handset.
 */

/*
 * The ladders are imported rather than restated. This file is the handset's
 * own rules about leads; `engines/funnel/` is MahekOne's, copied byte for
 * byte, and which rungs exist is emphatically theirs — a list typed here would
 * drift the day a twenty-fourth arrives, and the half that drifts is always
 * the half somebody reads.
 */
import {
  DIRECT_LADDER,
  DISTRIBUTOR_LADDER,
  LEGACY_LADDER,
  THIRD_PARTY_LADDER,
  TERMINAL_STAGES,
  bandOf,
  isOnTheBookAt,
  isParked,
  ladderFor,
  type LeadSalesType,
  /* Aliased, because this file's own `LeadStage` is the six capitalised words
     the legacy column holds and the funnel's is the twenty-three rungs. Two
     things called one name in one file is how somebody writes the wrong one. */
  type LeadStage as FunnelRung,
} from './funnel';

export const LEAD_STAGES = ['New', 'Contacted', 'Qualified', 'Negotiation', 'On hold', 'Converted', 'Lost'] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

/* `LEAD_FILTERS` was here — eight words typed into this file that `listLeads`
   selected `leads.stage` on. It is `LEAD_VIEWS` below now, derived from the
   ladders, and it is DELETED rather than left exported: an export nothing
   imports is a feature nobody can reach, and the next reader would have taken
   it for the list in force. Archived is still a FILTER and a lead is still
   never deleted, only kept out of the way. */

/**
 * Where a lead came from.
 *
 * A CODE and a LABEL, and the list is the office's rather than this file's.
 * It was five labels typed here — 'Walked past', 'Market enquiry', 'Office' —
 * which `lib/wire.ts` then translated down to four codes on the way out, three
 * of which `leads.sources` had never heard of. So every lead a salesman raised
 * was filed under a word the one authoritative list does not contain, and the
 * report that answers "which channels actually produce customers" counted them
 * as channels of their own.
 *
 * What is below is the COMPILED FALLBACK, copied from `lib/config/registry.ts`
 * — what a handset offers before it has ever completed a bootstrap, and never
 * policy. `leads.sources` comes down on every pull, so an office that adds an
 * eleventh channel adds it on the phone the same afternoon; a deploy is not
 * available to a manager and an APK is not recallable, which is why the list
 * cannot live in a screen.
 */
export type LeadSource = { code: string; label: string };

export const LEAD_SOURCES: readonly LeadSource[] = [
  { code: 'salesman_prospecting', label: 'Salesman Prospecting' },
  /* A lead SOURCE's label — the channel Mahek names, not the role value that
     no longer exists. The code is `telecalling` for exactly that reason: only
     the half a person reads keeps his word. */
  { code: 'telecalling', label: 'Telecaller' },
  { code: 'customer_reference', label: 'Existing Customer Reference' },
  { code: 'dealer_reference', label: 'Dealer / Distributor Reference' },
  { code: 'website', label: 'Website / Online Enquiry' },
  { code: 'whatsapp', label: 'WhatsApp Enquiry' },
  { code: 'phone', label: 'Phone Enquiry' },
  { code: 'exhibition', label: 'Exhibition / Trade Fair' },
  { code: 'walk_in', label: 'Walk-in' },
  /* The only one that asks a second question. Picking it demands a sentence,
     because "Other" is the easiest answer on any list and a year of it is the
     biggest bar on the chart with nothing behind it. */
  { code: 'other', label: 'Other' },
] as const;

/** The code that asks for a sentence. Named once so the form and anything
    that later checks the answer cannot disagree about which one it is. */
export const OTHER_SOURCE = 'other';

/**
 * WHAT THE OLD BUILDS SENT, RETAINED RATHER THAN REMAPPED.
 *
 * There are leads on the book carrying `cold_call`, `manual`, `referral` and
 * `campaign`, and `leads.sources` contains none of them. A stored value that
 * stops resolving to a label is the mistake `product_aliases` exists to
 * prevent, so they keep a label here and are never offered: rewriting them
 * into one of the ten would be guessing on the salesman's behalf — `manual`
 * was BOTH 'Market enquiry' and 'Office', and no migration can recover which —
 * and it would split one lead's history across two codes in a report whose
 * merge tool exists to undo exactly that.
 */
export const LEGACY_LEAD_SOURCES: readonly LeadSource[] = [
  { code: 'cold_call', label: 'Cold call (old)' },
  { code: 'referral', label: 'Referral (old)' },
  { code: 'manual', label: 'Entered by hand (old)' },
  { code: 'campaign', label: 'Campaign (old)' },
] as const;

/**
 * A stored code as words.
 *
 * Takes the pulled list rather than reading configuration, because everything
 * in this file is pure — and falls through to the retained codes above and
 * then to the code itself, which is the honest last answer: a source nobody
 * here recognises is better shown as the word it was stored as than hidden.
 */
export function leadSourceLabel(
  code: string | null | undefined,
  sources: readonly LeadSource[],
): string | null {
  const c = (code ?? '').trim();
  if (!c) return null;
  return (
    sources.find((s) => s.code === c)?.label ??
    LEGACY_LEAD_SOURCES.find((s) => s.code === c)?.label ??
    c
  );
}

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

/* ------------------------------------------------------- the reorder due */

/**
 * Is this customer due to order again?
 *
 * §P asks for a reorder reminder, and the office already answers this question
 * for the telecallers' Call Log. The handset cannot ask it: there is no reorder
 * channel on the pull, and a salesman in a market lane has no connection to ask
 * over. So it is derived here from two columns every customer row already
 * carries — `lastOrderDate` and `cycleDays` — which is what makes it work with
 * the phone in flight mode.
 *
 * It deliberately does NOT restate the Call Log's ranking. That engine weighs a
 * reorder against a promise, a debt and a stock check to decide who to ring
 * FIRST out of four hundred; this answers one question about one shop the
 * salesman is already standing outside. Copying the ranking here would be a
 * second scoring system drifting from the first — and the half that drifts is
 * always the half somebody reads.
 *
 * Null where there is nothing to say: a customer who has never ordered has no
 * cycle to be late against, and saying "due" about them would be an invention.
 */
export type ReorderState = 'due' | 'overdue' | null;

export function reorderState(
  lastOrderDate: string | null,
  cycleDays: number | null,
  today: string,
): ReorderState {
  if (!lastOrderDate || !cycleDays || cycleDays <= 0) return null;
  const since = daysBetween(lastOrderDate, today);
  if (since == null) return null;
  if (since >= cycleDays * 2) return 'overdue';
  if (since >= cycleDays) return 'due';
  return null;
}

/**
 * The one line a customer card carries about it, or none.
 *
 * It says the CYCLE as well as the verdict, because "due" on its own invites
 * the reply "due by whose reckoning" — and the cycle is the customer's own
 * measured rhythm rather than a company default, which is exactly the thing
 * worth saying out loud.
 */
export function reorderLabel(
  lastOrderDate: string | null,
  cycleDays: number | null,
  today: string,
): string | null {
  const state = reorderState(lastOrderDate, cycleDays, today);
  if (!state) return null;
  const since = daysBetween(lastOrderDate, today) ?? 0;
  return state === 'overdue'
    ? 'Overdue to reorder — ' + since + ' days, buys every ' + cycleDays
    : 'Due to reorder — ' + since + ' days, buys every ' + cycleDays;
}

/* ------------------------------------------------- what the book is cut by */

/**
 * THE CHIP ROW IS DERIVED FROM THE LADDERS, AND IT IS BANDS RATHER THAN RUNGS.
 *
 * `LEAD_FILTERS` was eight words typed into this file, and `listLeads`
 * selected on `leads.stage` — the six-word column this app shipped with. The
 * funnel put twenty-three rungs across four ladders on the row beside it, so a
 * salesman could not ask for his sample trials, his negotiations, or anything
 * else the specification actually names. What is below replaces that selection
 * without replacing the words: the chips read the same, and a lead at
 * `sample_review` now answers to Qualified instead of sitting on no chip at
 * all.
 *
 * WHY BANDS AND NOT RUNGS AT THE TOP. A salesman's book holds leads on four
 * different ladders at once, and the rungs do not line up: `sample_received`
 * exists on one of them, `management_review` on another, and the legacy six on
 * none of the three new ones. A chip row built from the union is twenty-three
 * chips of which most are empty for any one person, and a chip named for a rung
 * a lead's own ladder does not carry is a chip that can never match it.
 * `bandOf` is the one reading every ladder maps onto — it is also the reading
 * the console's funnel bar draws and the owner's cohort counts by — so a band
 * means the same thing on this phone and in that report. The rungs are not lost:
 * they are offered UNDERNEATH a picked band, built from what is actually in the
 * book, which is the only list that can never be empty or wrong.
 *
 * `bandOf` answers null for four rungs and for a park, and that is exactly why
 * those get chips of their own rather than being folded into a band: a funnel
 * counts what is still in it, and a lead nobody will ring again is not.
 */

/** Every rung anything can stand on, built from the ladders and never typed. */
export const ALL_RUNGS: readonly FunnelRung[] = Array.from(
  new Set<FunnelRung>([
    ...LEGACY_LADDER,
    ...DIRECT_LADDER,
    ...THIRD_PARTY_LADDER,
    ...DISTRIBUTOR_LADDER,
    ...TERMINAL_STAGES,
    /* Neither is on a ladder. `lost` leaves from any rung and `on_hold`
       displaces one — see `isParked` — and both are somewhere a lead is
       genuinely standing, so both have to be findable. */
    'lost',
    'on_hold',
  ]),
);

/**
 * The top chip row.
 *
 * `all` and `archived` are not stages and never were: one is the whole open
 * book and the other is the filter that keeps a lead out of the way without
 * deleting it. The seven between them are the words this app has always used,
 * and `Converted` is the one that was MISSING — `legacyStageFor` has been able
 * to write it since the funnel landed and no chip selected it, so a lead that
 * had been won was findable on nothing but All.
 */
export const LEAD_VIEWS = [
  { value: 'all', label: 'All' },
  { value: 'new', label: 'New' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'qualified', label: 'Qualified' },
  { value: 'negotiation', label: 'Negotiation' },
  { value: 'on_hold', label: 'On hold' },
  { value: 'converted', label: 'Converted' },
  { value: 'lost', label: 'Lost' },
  { value: 'archived', label: 'Archived' },
] as const;

export type LeadView = (typeof LEAD_VIEWS)[number]['value'];

/**
 * The sales type whose ladder actually carries this rung.
 *
 * `isOnTheBookAt` needs one, and asking it about a rung that is not on the
 * ladder it was handed answers false — so `distributor_approval` judged as a
 * direct lead reads as still being sold to, which is the opposite of what it
 * means. Every rung below the terminals appears on exactly one ladder or on
 * ladders that agree about it, so there is a right answer here rather than a
 * guess: this finds it.
 */
function typeCarrying(stage: FunnelRung): LeadSalesType | null {
  for (const t of ['direct', 'third_party', 'distributor'] as const) {
    if (ladderFor(t).includes(stage)) return t;
  }
  return null;
}

/**
 * Which chip a rung answers to.
 *
 * It is the SAME reading `lib/wire.ts`'s `legacyStageFor` takes — parked
 * first, then on the book, then the band — because that function is what
 * writes the six-word column this list used to filter on, and a chip that
 * disagreed with the badge beside it would be one lead wearing two words on
 * one screen. `isOnTheBookAt` rather than the band is what puts `second_order`
 * under Converted: it is in the funnel's Negotiation band and it is plainly an
 * account we have sold to, and the two questions have different answers on
 * exactly those rungs.
 */
export function viewOfRung(
  stage: FunnelRung,
  salesType: LeadSalesType | null | undefined = undefined,
): LeadView {
  if (stage === 'lost') return 'lost';
  if (isParked(stage)) return 'on_hold';
  const t = salesType === undefined ? typeCarrying(stage) : salesType;
  if (isOnTheBookAt(stage, t)) return 'converted';
  switch (bandOf(stage)) {
    case 'new':
      return 'new';
    case 'contacted':
      return 'contacted';
    case 'qualified':
      return 'qualified';
    case 'negotiation':
      return 'negotiation';
    default:
      /* A rung in no band that is neither parked, lost nor on the book is a
         rung this build has never heard of — a server one release ahead. New
         is where a lead nobody has moved sits, and it is the one answer that
         keeps the row findable rather than filing it under a verdict. */
      return 'new';
  }
}

/**
 * The six-word column read as a rung.
 *
 * A lead raised on this handset before the funnel — and every row pulled by a
 * build older than the funnel columns — carries `funnelStage` null and one of
 * the seven words in `LEAD_STAGES`. They are the legacy ladder's own rungs
 * under capitals, with `Converted` standing for `won`, so the mapping is
 * mechanical rather than a table somebody has to maintain.
 */
export function rungOfLegacyWord(word: string | null | undefined): FunnelRung | null {
  const s = String(word ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  if (!s) return null;
  if (s === 'converted') return 'won';
  return (ALL_RUNGS as readonly string[]).includes(s) ? (s as FunnelRung) : null;
}

/**
 * What a lead's own chip is, whichever of the two columns it is carrying.
 *
 * Read by the row's badge and by nothing else — the LIST is narrowed in SQLite
 * by `viewMatch` below, because a few hundred rows filtered in JavaScript is
 * the thing the customers list next door was rebuilt to stop doing.
 */
export function viewOfLead(lead: {
  funnelStage: string | null;
  stage: string;
  salesType: string | null;
}): LeadView {
  const rung = (lead.funnelStage as FunnelRung | null) ?? rungOfLegacyWord(lead.stage);
  if (!rung) return 'new';
  return viewOfRung(rung, lead.funnelStage ? (lead.salesType as LeadSalesType | null) : null);
}

/**
 * What a view narrows to, in the two vocabularies the row can be speaking.
 *
 * Null means no narrowing at all — `all` and `archived` are answered by the
 * archive flag alone, and cutting them by stage as well would hide the leads
 * a salesman opens All to find.
 *
 * The two lists are not alternatives: a row carries `funnelStage` OR, where
 * nothing has ever sent one, the six-word column. Both arms are needed or the
 * old book vanishes from every chip the day this ships, which is the one
 * outcome this change must not have.
 */
export type ViewMatch = { rungs: FunnelRung[]; legacy: string[] };

export function viewMatch(view: LeadView): ViewMatch | null {
  if (view === 'all' || view === 'archived') return null;
  return {
    rungs: ALL_RUNGS.filter((s) => viewOfRung(s) === view),
    legacy: LEAD_STAGES.filter((w) => {
      const rung = rungOfLegacyWord(w);
      /* Judged on the LEGACY ladder, which is what `salesType` null means —
         a row with no `funnelStage` has never had a sales type either. */
      return rung ? viewOfRung(rung, null) === view : false;
    }),
  };
}

/* --------------------------------------------------------------- the when */

/**
 * WHAT IS OWED, AND IT IS THE FILTER THIS SCREEN NEVER HAD.
 *
 * Eight stage chips answer "where is this lead in the process", which is a
 * question a manager asks. The question a man planning a Tuesday morning asks
 * is "what did I promise and when", and nothing on this screen could put it —
 * the date was drawn on every row and could not be selected on.
 *
 * The buckets are MahekOne's own `NEXT_BUCKETS` in `lib/lead-filters.ts`, to
 * the day, so a salesman and his manager reading the word "overdue" about one
 * shop mean the same thing. `later` is deliberately left out rather than
 * renamed: it is the residue, it is reachable on All, and a chip row a salesman
 * has to read five words of before finding the two he wants is a chip row he
 * stops reading.
 *
 * IT IS THE EARLIEST OF THREE DAYS AND NOT ONE COLUMN, which is the whole of
 * the reasoning worth keeping.
 *
 * `nextFollowUpDate` is the salesman's own diary — the day he said he would go
 * back. `nextActionDate` is §24's, which is a different and stricter thing: an
 * action, a day, a person and what that person is expected to come back with,
 * demanded on every upward move and EXEMPT for the legacy book. `holdResumeDate`
 * is the day a parked lead was promised a second look, which is as much a thing
 * owed as either — nobody has to record an outcome for a park to still be
 * waiting.
 *
 * Keying on any ONE of them is wrong in a way that is invisible on the screen.
 * The action alone empties the chip for most of an old book, because §24 never
 * applied to it. The follow-up alone hides every lead whose only commitment is
 * §24's, which is every lead anybody has moved up a rung since the funnel
 * landed. And the park is on neither. So the chip answers the same way the CRM
 * already answers the same question about a customer — the EARLIEST day they
 * come back, with the other named beside it — because answering with one date
 * while two are true is wrong about when the name reappears.
 *
 * WHAT PAYS FOR THAT WIDTH IS THAT THE ROW SAYS WHICH. "Late — you said you
 * would ring on the 14th" and "Late — back off hold since the 14th" are
 * different mornings, and a chip that caught both while the line underneath
 * named neither would be a count nobody could act on. See `leadOwed`.
 *
 * `/lead-actions` is deliberately NARROWER and stays so: `engines/lead-worklist.ts`
 * is §24's own worklist, it answers about the action and the park alone, and it
 * is right to — the two screens ask different questions and the wider one is the
 * book. What they must not do is use one word for two populations without
 * saying so, which is why each names the other.
 *
 * AND NEITHER READS `nextActionOutcome`. That column is §24's FOURTH ANSWER —
 * what the responsible person is expected to come back with, written in the
 * same breath as the action — and not a record of what happened.
 * `advanceLeadStage` refuses a move without one, so `outcome is null` excludes
 * every lead that followed the rule and admits only the ones that did not.
 * MahekOne's own `overdueWindow` carried exactly that clause and it emptied
 * Overdue; do not reproduce it here.
 */
export const LEAD_WHENS = [
  { value: 'any', label: 'Any day' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'Next 7 days' },
  { value: 'none', label: 'Nothing promised' },
] as const;

export type LeadWhen = (typeof LEAD_WHENS)[number]['value'];

/** Which of the three days a lead's earliest one came from. */
export type OwedSource = 'action' | 'promise' | 'hold';

export type LeadOwed = { date: string; source: OwedSource; daysLate: number };

/** A parked lead, whichever of the two columns it is carrying the park in. */
export function leadIsParked(lead: { funnelStage: string | null; stage: string }): boolean {
  return lead.funnelStage
    ? lead.funnelStage === 'on_hold'
    : rungOfLegacyWord(lead.stage) === 'on_hold';
}

/**
 * The earliest day this lead next wants him, and which day it is.
 *
 * The SAME three columns `listLeads` cuts and sorts by — said here rather than
 * re-derived on the card, so the chip that caught the row, the place the sort
 * put it and the sentence under its name are one answer. A park counts only on
 * a lead that is actually parked: `holdResumeDate` outlives the resume, and a
 * lead somebody brought back in March would otherwise go on being owed for
 * ever on the strength of a day it already honoured.
 *
 * Ties go to the ACTION. Where both fall on one day the two are the same
 * morning, and §24's is the one with a person and an expected answer attached
 * — it is the more useful of two true sentences.
 */
export function leadOwed(
  lead: {
    nextActionDate: string | null;
    nextFollowUpDate: string | null;
    holdResumeDate: string | null;
    funnelStage: string | null;
    stage: string;
  },
  today: string,
): LeadOwed | null {
  const candidates: LeadOwed[] = [];
  const add = (date: string | null, source: OwedSource) => {
    if (date) candidates.push({ date, source, daysLate: date < today ? (daysBetween(date, today) ?? 0) : 0 });
  };
  add(lead.nextActionDate, 'action');
  add(lead.nextFollowUpDate, 'promise');
  if (leadIsParked(lead)) add(lead.holdResumeDate, 'hold');
  if (!candidates.length) return null;
  /* ISO dates sort as text, which is the whole reason nothing here parses
     one: a comparison between two days needs no midnight and therefore no
     zone. The order below is the tie-break, and `sort` is stable. */
  return candidates.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))[0];
}

/**
 * The one line the card carries about it, naming which day it is.
 *
 * Null where nothing is owed, so the caller says "No follow-up set" in its own
 * words rather than this file inventing a sentence about an absence.
 */
export function owedLabel(owed: LeadOwed | null, pretty: (iso: string) => string): string | null {
  if (!owed) return null;
  const when = pretty(owed.date);
  if (owed.daysLate > 0) {
    switch (owed.source) {
      case 'action':
        return 'Late \u2014 this was due on ' + when;
      case 'promise':
        return 'Late \u2014 you said you would go back on ' + when;
      case 'hold':
        return 'Late \u2014 back off hold since ' + when;
    }
  }
  switch (owed.source) {
    case 'action':
      return 'Next action ' + when;
    case 'promise':
      return 'You said you would go back ' + when;
    case 'hold':
      return 'Comes back off hold ' + when;
  }
}

/**
 * A day shifted, with no zone anywhere in it.
 *
 * `Date.UTC` and `toISOString` are exact inverses on a date-only value, which
 * is the one case the rule about `toISOString().slice(0, 10)` does not bite:
 * nothing local went in, so nothing local can come out. Reading the parts back
 * with `getDate()` would answer in the machine's zone and be wrong by a day
 * either side of midnight — the same trap, one spelling along.
 */
export function shiftDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** How many days out "Next 7 days" reaches. The web's `week` bucket, exactly. */
export const WHEN_WEEK_DAYS = 7;

/* ---------------------------------------------------------- the manager's */

/**
 * §4.1 — THE MANAGER'S OWN MARK, AND NULL IS THE FOURTH ANSWER.
 *
 * Mirrors MahekOne's `lib/lead-priority.ts`, which is a frozen three-value
 * list rather than configuration. Null is not `low`: nobody has judged this
 * lead, and that is a different fact from a manager having looked at it and
 * said it can wait. Every lead carries null on the day the column ships and
 * nothing backfills one.
 *
 * The handset READS it and never writes one — a salesman does not set his own
 * priorities — so there is no picker here and no list to publish.
 */
export function leadPriorityLabel(priority: string | null | undefined): string | null {
  switch ((priority ?? '').trim().toLowerCase()) {
    case 'high':
      return 'High priority';
    case 'medium':
      return 'Medium priority';
    case 'low':
      return 'Low priority';
    default:
      /* Null on the ROW draws nothing at all, unlike the web's table, which
         prints "Not set" because a blank cell in a column of words reads as
         missing data. A card has no column: a line saying nobody has judged
         this lead would be on most of the book, saying the same nothing on
         each of them. */
      return null;
  }
}
