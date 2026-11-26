/**
 * WHAT AN ACCOUNT IS, AND HOW IT IS DOING, in the words a card uses.
 *
 * Pure on purpose, and that is the whole reason this file exists rather than
 * these three staying in `data/customers.ts`: that file imports the database,
 * so nothing in it can be exercised without a handset. These decide the words
 * on every row of the Customers list — the screen a salesman reads a few
 * hundred times a day — and one of them shipped with a branch that could never
 * once fire, because nothing was able to test it.
 *
 * It is the handset's counterpart to MahekOne's own `lib/account-types.ts`,
 * which is pure for the same reason and states the same rule about the mark
 * winning over the kind.
 *
 * The shapes are structural rather than `Pick<Customer, …>`: importing the
 * `Customer` type would point this file back at `data/customers.ts`, which
 * imports this one.
 */
import { stageLabel } from '../engines/funnel';
import { stageOf } from './wire';

/** Only what these rules read. See the note above on why it is not a `Pick`. */
export type AccountFacts = {
  kind?: string | null;
  thirdParty: number;
  /** From `LEAD_FACTS` in `customer-query.ts`. Undefined means nobody asked. */
  isLead?: number;
  /** From `LEAD_FACTS` too — a lead filed away on this phone (`filedLeadClause`). */
  isFiledLead?: number;
  leadFunnelStage?: string | null;
  leadStage?: string | null;
};

/** The words for a lead filed away — lost, trashed or archived — and not converted. */
export const FILED_LEAD_WORD = 'Lost / filed lead';

export type HealthFacts = {
  status: string | null;
  healthBand: string | null;
};

/**
 * What KIND of account this is, in one word.
 *
 * The mark wins over the kind, which is the rule MahekOne's own
 * `lib/account-types.ts` states for the web list and for the same reason:
 * "Lead · Third party" is two facts fighting over one glance, and on a phone
 * there is even less room to lose the argument in. A shop we deliver to and do
 * not bill is a third party whatever its kind says.
 *
 * `null` where the row predates migration v12 and nothing has re-synced it —
 * saying "Customer" on no evidence would be a guess, and this is the one field
 * whose whole job is to stop the salesman guessing.
 */
export function accountType(
  c: AccountFacts,
): string | null {
  if (c.thirdParty) return 'Third party';
  /*
   * THE LEADS TABLE ANSWERS FIRST, and `kind` only after it.
   *
   * This read `kind` alone, which is the one thing `customer-query.ts` says in
   * its own header must not decide this: the office collapsed leads and
   * customers into a single `customers` row long ago, and a lead reaches this
   * handset down its own channel into `leads` keyed on the same id. So a lead
   * whose customer row says `customer`, or whose `kind` was never filled in —
   * every row that has not re-synced since migration v12 — was being labelled
   * wrongly or not at all, on the screen whose whole job is to stop the
   * salesman guessing.
   *
   * `isLead` undefined means the caller did not ask, so `kind` is all there is
   * and it is used exactly as before.
   */
  if (c.isLead) return 'Lead';
  /* Filed away, not converted: neither a live lead nor a customer, and the
     card says so rather than letting it pass for an account we bill. */
  if (c.isFiledLead) return FILED_LEAD_WORD;
  /*
   * AND WHERE `isLead` WAS ASKED, ITS "NO" STANDS. `kind = 'lead'` alone used
   * to answer "Lead" here for a row the chips had put under Customers (an
   * archived lead, a lead row already converted), so the card and the chip
   * said opposite things about one shop. `isLead` is now the whole rule —
   * `leadCustomerClause` in SQL, `isLiveLead` below in JS — and it already
   * reads `kind = 'lead'` where no lead row is held. A `kind` of lead that the
   * rule says is NOT a live lead gets no word rather than a contradiction.
   */
  if (c.isLead === undefined && c.kind === 'lead') return 'Lead';
  if (c.kind === 'customer') return 'Customer';
  return null;
}

/** The lead row's own facts that `isLiveLead` reads. */
export type LeadRowFacts = {
  archived: number;
  thirdParty?: number | null;
  funnelStage: string | null;
  stage: string | null;
};

/**
 * IS THIS SHOP STILL A LEAD — the JavaScript twin of `leadCustomerClause` in
 * `data/lead-query.ts`, for a screen holding one customer and its lead row
 * rather than running the list's SQL. One rule, so the record cannot call a
 * shop a lead that the list filed under Customers, or the other way round.
 *
 * `lead` is the row from `leads` (archived or not), or null where the phone
 * holds none.
 */
export function isLiveLead(c: Pick<AccountFacts, 'kind' | 'thirdParty'>, lead: LeadRowFacts | null): boolean {
  if (c.thirdParty || c.kind === 'customer') return false;
  if (!lead) return c.kind === 'lead';
  if (lead.archived) return false;
  return !leadRowConverted(lead);
}

/** `leadRowConverted` in `lead-query.ts`, in JavaScript. */
export function leadRowConverted(lead: LeadRowFacts): boolean {
  return (
    !!lead.thirdParty ||
    lead.funnelStage === 'won' ||
    lead.funnelStage === 'customer' ||
    lead.funnelStage === 'active_distributor' ||
    lead.stage === 'Converted'
  );
}

/**
 * WHETHER A TAP OPENS `/lead`. Only a live lead whose lead row is on this
 * phone: `/lead` draws the ladder from that row, and a shop the office calls a
 * lead whose row never reached the phone would open on "not on this phone".
 * Such a shop opens `/customer`, which says "Nothing billed to a lead" — true,
 * because it is one. `leadStage` is NOT NULL on every lead row, so its being
 * present is the proof the row exists.
 */
export function opensLeadRecord(c: Pick<AccountFacts, 'isLead' | 'leadStage' | 'isFiledLead'>): boolean {
  /* A filed lead's row IS on this phone (that is what makes it filed), and
     its record is where its history is and where it can be brought back. */
  if (c.isFiledLead) return true;
  return !!c.isLead && c.leadStage != null;
}

/**
 * `filedLeadClause` in JavaScript, for a screen holding one customer and its
 * lead row: archived, not converted, and the customer row not settled.
 */
export function isFiledLead(c: Pick<AccountFacts, 'kind' | 'thirdParty'>, lead: LeadRowFacts | null): boolean {
  if (!lead || c.thirdParty || c.kind === 'customer') return false;
  return !!lead.archived && !leadRowConverted(lead);
}

/**
 * What this account is AND where it stands, in one line for a card.
 *
 * "Lead" on its own is the answer to a question nobody was asking. A salesman
 * reading this list is deciding between a Suspect he has visited twice, a
 * Prospect that owes him a qualification and a shop already in Negotiation —
 * and those three want completely different mornings. The rung is the whole
 * point, and it was not on the card at all.
 *
 * The rung is resolved by `stageOf`, the same function `/lead` draws its own
 * ladder from, so the word on the card and the word on the record cannot
 * disagree. Only a LEAD gets one: a customer has no rung, and "Customer ·
 * Won" would be reading a funnel position back onto an account that has left
 * the funnel.
 */
export function accountLine(
  c: AccountFacts,
): string | null {
  const type = accountType(c);
  if (!type) return null;
  if (!c.isLead) return type;
  /* No lead row on this phone, no rung to name: "Lead · Suspect" invented from
     nothing would be a statement nobody made. */
  if (c.leadFunnelStage == null && c.leadStage == null) return type;
  const rung = stageLabel(stageOf({ funnelStage: c.leadFunnelStage ?? null, stage: c.leadStage ?? null }));
  return rung ? `${type} · ${rung}` : type;
}

/**
 * The word on the card.
 *
 * IT USED TO DERIVE ONE FROM THE SCORE, and that was the fifth and worst of
 * the renderings B3-16 was raised about: `< 40 ? 'Overdue' : < 60 ? 'At risk'`
 * — a third pair of thresholds, neither of them configuration, producing the
 * phrase "At risk" from a question that is not the one that phrase answers.
 * The owner's report calls a customer at risk when they are 1.25 of their own
 * cycles overdue; this called one at risk for owing money while ordering every
 * week. Worse, an unscored customer fell through to 'Active' — a verdict about
 * somebody nothing had measured.
 *
 * The band is the answer now, and it arrives from the server already computed
 * by the one engine `customers.status`, the Call Log and the owner's retention
 * report all read. `status` still wins where MahekOne has stated one, because
 * that is a decision somebody made and this is a derivation.
 *
 * **AND THAT LAST SENTENCE WAS NOT TRUE OF THE CODE.** The status branch
 * compared against `'Overdue'`, `'At risk'` and `'Active'`, while
 * `customer_status` is an enum of exactly `active`, `inactive` and
 * `deactivated` — lower case, and two of those three literals name nothing
 * that exists anywhere in MahekOne. They were left behind by the score-derived
 * wording this function replaced. So the branch could never once fire, every
 * account fell through to the band, and a shop that somebody had deliberately
 * DEACTIVATED read as whatever its buying cycle happened to say.
 *
 * `deactivated` is the one that has to win, and for the reason the comment
 * always claimed: `recomputeInactivity` derives every other value and pointedly
 * never writes that one, because it is a person's decision. `inactive` is NOT
 * given a word of its own — it is the same fact the `dormant` band states, from
 * the same threshold (`inactive.cycleMultiplier`), and two words for it on one
 * card is how a list comes to disagree with itself.
 *
 * Null where there is nothing to say — the caller draws no verdict rather than
 * inventing one.
 */
export function customerStage(
  c: HealthFacts,
): 'Active' | 'At risk' | 'Dormant' | 'Lost' | 'Closed' | null {
  if (c.status === 'deactivated') return 'Closed';
  switch (c.healthBand) {
    case 'active':
      return 'Active';
    case 'at-risk':
      return 'At risk';
    case 'dormant':
      return 'Dormant';
    case 'lost':
      return 'Lost';
    default:
      return null;
  }
}
