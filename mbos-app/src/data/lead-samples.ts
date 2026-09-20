import { all, newId, one, run } from '../db';
import { getConfig } from './config';
import { raiseApproval } from './requests';
import { insertAndQueue, stamp, updateAndQueue } from './write';
import { isoDate } from '../lib/format';
import { chaseSchedule, type ChaseCount, type ChaseSchedule } from '../lib/sample-chase';
import {
  FEEDBACK_FIELDS,
  REASON_CODE_NEEDING_REMARKS,
  SAMPLE_CANCEL_REASONS,
  type CodedOption,
} from '../engines/funnel';

/**
 * §15 §16 — a sample, from asked for to reviewed.
 *
 * The state machine is the point of this file. A sample used to be one row
 * with a derived word on it and two timestamps behind that; the specification
 * has eight states and chases three of the gaps between them separately,
 * because they are three different failures with three different people to
 * ring. A sample dispatched and not received is a courier problem; one
 * received and not tried is a customer who has not got round to it; one tried
 * and not reviewed is a call nobody made. Collapsing them loses which of the
 * three is happening, which is the whole of what a sample desk is for.
 *
 * The review itself is seven answers rather than a paragraph — see
 * `sample_feedback` in the schema for why.
 *
 * The dispatch, the confirmation, the trial dates and the review all travel as
 * an ordinary `sample` update and are read by `handleSampleUpdate`. What they
 * must carry is MahekOne's own vocabulary, at the top level of the payload —
 * see `moveSample`, which is where that went wrong for the whole lifecycle.
 */

export type FunnelSample = {
  id: string;
  customerId: string;
  leadId: string | null;
  productId: string | null;
  productName: string | null;
  cans: number | null;
  reason: string | null;
  reasonCode: string | null;
  application: string | null;
  requestedAt: number;
  state: string;
  approvalId: string | null;
  approvedAt: number | null;
  dispatchedAt: number | null;
  courierName: string | null;
  courierDocket: string | null;
  expectedDeliveryDate: string | null;
  deliveredAt: number | null;
  deliveryPhotoId: string | null;
  receivedConfirmedAt: number | null;
  /**
   * THE SHOP'S OWN WORD, under the name the office writes it by. The pull fills
   * this column and nothing else; `receivedConfirmedAt` is what a confirmation
   * made on THIS handset writes, and the record page read only the second — so
   * a sample the shop had confirmed to the office showed nothing at all. Both
   * are the same fact asserted by the same party and either one is the answer.
   */
  receivedAt: number | null;
  /**
   * STARTED and COMPLETED are two columns, and the gap between them is the
   * point. A trial opened three weeks ago and never finished is the commonest
   * way a sample goes quiet, and with only an outcome column it is
   * indistinguishable from a can nobody has touched. The column has been on
   * this table and on the pull since the funnel shipped; nothing read it.
   */
  trialStartedAt: number | null;
  trialCompletedAt: number | null;
  reviewedAt: number | null;
  cancelledAt: number | null;
  cancelReason: string | null;
  /**
   * WHY THE OFFICE REFUSED IT. §K demands the reason precisely so the next
   * sample does not go out identical, and the one person who would change what
   * goes out is the salesman — who was the one person never shown it. The
   * column has been on this table and filled by the pull since the lifecycle
   * shipped; no type declared it and no screen read it, so a refused sample was
   * a red badge and nothing else.
   */
  rejectionReason: string | null;
  /** What the shop made of it in their own words, and what else they asked for
   *  while we had their attention. Written by the office, read here. */
  satisfaction: string | null;
  additionalRequirement: string | null;
  trialOutcome: string | null;
  followUpDate: string | null;
  convertedOrderId: string | null;
  /**
   * §16 — HOW MANY TIMES THE OFFICE HAS ASKED, and why it is optional.
   *
   * `mbos_samples.review_chase_count` is a real server column, raised by the
   * hourly pass, and it is what lets a screen say "asked three times" — the
   * number that tells somebody to stop waiting and ring the shop themselves.
   * It crossed no wire for the life of the module — `openSamples` did not name
   * it, so `SELECT *` here did not produce the key and this read `undefined`
   * on every handset — and it does now, in the same change that gave the
   * `samples` table a column for it to land in.
   *
   * It stays OPTIONAL rather than `number | null` deliberately, and not merely
   * because an APK cannot be recalled while a server can move first. Zero
   * chases and "this phone has not been told" are different facts, and the
   * moment one is defaulted to the other on the way to a screen the difference
   * is gone and a salesman is quietly reassured that nothing has been chased on
   * a sample the office has rung about three times. `chaseCountOf` is the one
   * place the states are read, and it answers null rather than zero.
   */
  reviewChaseCount?: number | null;
  /** The day of the last ask, an instant like every other on this wire. The
      same story and the same nullability as the count above it. */
  lastReviewChaseAt?: number | null;
  syncState: string;
};

export type SampleFeedback = {
  id: string;
  sampleId: string;
  customerId: string;
  quality: string | null;
  performance: string | null;
  application: string | null;
  drying: string | null;
  competitorComparison: string | null;
  priceFeedback: string | null;
  otherComments: string | null;
  trialOutcome: string | null;
  photoId: string | null;
  recordedAt: number;
};

export type SampleResult<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * What the shop made of the trial — the server's own four, spelled its way.
 *
 * `more_testing` is a third real verdict rather than a shrug, which is why it
 * is not folded into `pending`: pending means nobody has answered, and this
 * means they answered "again, on something else".
 */
export type TrialVerdict = 'pending' | 'approved' | 'rejected' | 'more_testing';

/* ------------------------------------------------------------------ reads */

export async function getSample(id: string): Promise<FunnelSample | null> {
  return one<FunnelSample>('SELECT * FROM samples WHERE id = ?', [id]);
}

export async function listFunnelSamples(): Promise<FunnelSample[]> {
  return all<FunnelSample>('SELECT * FROM samples ORDER BY requestedAt DESC');
}

export async function samplesFor(customerId: string): Promise<FunnelSample[]> {
  return all<FunnelSample>('SELECT * FROM samples WHERE customerId = ? ORDER BY requestedAt DESC', [customerId]);
}

export async function feedbackFor(sampleId: string): Promise<SampleFeedback | null> {
  return one<SampleFeedback>('SELECT * FROM sample_feedback WHERE sampleId = ?', [sampleId]);
}

/**
 * Feedback that is late.
 *
 * The finished states are excluded rather than the open ones listed — a state
 * added later is far more likely to be another rung of the ladder than another
 * way of being done, and an unrecognised state going UNCHASED is the failure
 * this exists to prevent.
 *
 * It is HERE rather than in `app/samples.tsx`, which is where it was written,
 * because the screen is no longer the only thing that asks: the More menu
 * needs the same question answered to decide whether to draw a badge, and the
 * copy that drifts is always the one somebody reads.
 */
export function isSampleOverdue(s: FunnelSample, today: string): boolean {
  if (!s.followUpDate || s.followUpDate >= today) return false;
  return !['Reviewed', 'Converted', 'Rejected', 'Cancelled'].includes(s.state);
}

/**
 * Trials nobody has chased, oldest first.
 *
 * `requestLeadSample` has set a follow-up date on every sample since it was
 * written — a week out where the salesman does not choose one — and its own
 * comment calls that date "what the overdue strip reads". The strip existed on
 * the samples screen; nothing anywhere else read the date, so the only way to
 * discover a trial had gone cold was to open that screen and look. A sample
 * given away and never chased is a sample given away.
 *
 * Filtered in JavaScript against `isSampleOverdue` rather than repeated as a
 * WHERE clause: one rule, and samples are tens of rows rather than thousands.
 */
export async function overdueSamples(today: string): Promise<FunnelSample[]> {
  const rows = await listFunnelSamples();
  return rows
    .filter((s) => isSampleOverdue(s, today))
    .sort((a, b) => (a.followUpDate ?? '').localeCompare(b.followUpDate ?? ''));
}

/** §10 — the ten answers to "why does this customer want a trial?" */
export async function sampleReasons(): Promise<CodedOption[]> {
  return getConfig<CodedOption[]>('leads.sampleReasons');
}

/**
 * WHY A TRIAL WAS CALLED OFF — Mahek's eight, read from configuration.
 *
 * The eight exist to separate THREE different problems one free-text box could
 * not tell apart: a product we could not source is a supply problem, a shop
 * that stopped answering is a customer problem, a price objection is a sales
 * problem. All three read as "trial cancelled" until somebody can count them,
 * and each one is somebody else's to fix.
 *
 * Configuration rather than the literal, like every other coded list here: an
 * office may reword these without a deploy, and a phone offering the words it
 * was compiled with is a phone whose answers stop matching the report they are
 * counted in. `SAMPLE_CANCEL_REASONS` is the fallback and nothing more — the
 * `leads.*` keys DO reach a handset — `mbosConfigPayload` sends every key
 * beginning `mbos.` or `leads.` — so this is what a phone draws only until its
 * first pull lands, and it is the same list `lib/config/registry.ts` takes its
 * own default from. (The sentence here used to say the opposite, written before
 * that prefix test existed; a stale comment about which keys travel is how the
 * next person concludes a configured list cannot be trusted.)
 */
export async function cancelReasons(): Promise<CodedOption[]> {
  return getConfig<CodedOption[]>(
    'leads.sampleCancelReasons',
    SAMPLE_CANCEL_REASONS.map((r) => ({ ...r })),
  );
}

/**
 * The next thing that has to happen to this sample, in words.
 *
 * One sentence per state rather than a colour, because the row is read at
 * arm's length in a market and "Sent" beside an amber dot says nothing about
 * whose problem it is. Null where nothing is owed — a reviewed sample is
 * finished and a cancelled one is not coming back.
 */
export function whatIsOwed(s: FunnelSample): string | null {
  switch (s.state) {
    case 'Requested': return 'Waiting on the office to approve it';
    case 'Approved': return 'Approved — waiting for it to go out';
    case 'Dispatched': return 'Sent. Check they have it';
    /* Started and not finished is a different call from not started at all:
       one asks how it is going, the other asks whether the can was even
       opened. Both are chased, and saying which is what makes the chase land. */
    case 'Awaiting feedback':
      return s.trialStartedAt
        ? 'They have started the trial. Ask how it is going'
        : 'They have it. Ask whether they have tried it yet';
    case 'Tried': return 'They have tried it — write down what they said';
    case 'Rejected': return null;
    /* A reviewed sample is finished EXCEPT on the third verdict: "they want to
       try it again on a different substrate" is a live trial with a next step,
       and filing it as done is how it goes quiet. */
    case 'Reviewed':
      return s.trialOutcome === 'more_testing' ? 'They want to try it again — another sample is the next step' : null;
    case 'Converted': return null;
    case 'Cancelled': return null;
    default: return null;
  }
}

/* --------------------------------------------------- §16 the chase ladder */

/**
 * The ladder the office chases a review on — day 2, then 4, then 6, and the
 * last interval for ever after that.
 *
 * Configuration rather than three numbers typed into a screen, for the reason
 * every coded list here is: a cadence compiled into an APK is a business rule
 * living where the one person who would change it cannot see it, and an APK
 * cannot be recalled. `leads.*` keys reach the handset with the rest of the
 * pull, so the office rewording the ladder reaches a phone on the next sync.
 *
 * The fallback is the registry's own default and nothing more — what a handset
 * that has never completed a bootstrap draws, so a salesman signing in on a bad
 * connection still sees a rhythm rather than an empty panel.
 */
export async function reviewChaseDays(): Promise<number[]> {
  const days = await getConfig<number[]>('leads.sampleReviewChaseDays', [2, 4, 6]);
  return Array.isArray(days) ? days.map((d) => Number(d)).filter((d) => Number.isFinite(d) && d >= 0) : [2, 4, 6];
}

/**
 * How many times the office has asked, or NULL where nobody has told us.
 *
 * Both states are real and stay real now the column travels. The migration
 * that added it is deliberately nullable with NO DEFAULT: `DEFAULT 0` would
 * have backfilled every sample already on the phone with the one value meaning
 * "nobody has asked", which is exactly the fact this function exists not to
 * assert about a sample the office has chased three times and has not yet told
 * this handset about. A row this phone raised and has not synced reads null
 * for the same reason, and one arriving from a server built before the columns
 * existed reads null too.
 *
 * A row this handset raised and has not yet synced answers null too, and that
 * is right rather than merely convenient: the office cannot have chased a
 * sample it has not heard about, but it is also true that nothing has told us
 * so, and the screen that says "nobody has told this phone" is honest about
 * both.
 */
export function chaseCountOf(s: FunnelSample): ChaseCount {
  const n = s.reviewChaseCount;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * The day the SHOP said it was in their hands, which is the only day the review
 * clock may be counted from.
 *
 * Not `dispatchedAt`, which is us saying it went, and not `deliveredAt`, which
 * is the carrier saying it arrived. §J turns on the third assertion precisely
 * because the first two cannot answer it, and a chase dated from dispatch rings
 * a customer still waiting for the parcel — a call that teaches them we do not
 * know where our own stock is.
 *
 * Both column names are read for the same reason the record page reads both:
 * `receivedConfirmedAt` is what a confirmation made on THIS handset writes and
 * `receivedAt` is the name the office writes the same fact under. One party,
 * one fact, two spellings.
 */
export function receiptConfirmedOn(s: FunnelSample): string | null {
  const at = s.receivedAt ?? s.receivedConfirmedAt;
  return at ? isoDate(new Date(at)) : null;
}

/**
 * Is this sample sitting on somebody's word that has not come?
 *
 * The chase exists for exactly this gap and nowhere else: the shop has the can
 * and nobody has written down what they thought of it. A sample still in the
 * godown has nothing to review and a reviewed one has an answer, so drawing a
 * ladder against either would be a checklist for work that does not exist.
 */
export function isAwaitingReview(s: FunnelSample): boolean {
  if (s.trialOutcome && s.trialOutcome !== 'pending') return false;
  return s.state === 'Awaiting feedback' || s.state === 'Tried';
}

/**
 * The whole chase for one sample, wired to the two things it is derived from.
 *
 * The arithmetic is `lib/sample-chase.ts` and stays there — pure, tested and
 * runnable with no signal, which is the state the salesman reading this is
 * actually in. This is the seam: which day it counts from, and what the office
 * has said about it.
 */
export function chaseFor(s: FunnelSample, chaseDays: readonly number[], today: string): ChaseSchedule {
  return chaseSchedule({ receivedOn: receiptConfirmedOn(s), asked: chaseCountOf(s), chaseDays, today });
}

/* ----------------------------------------------------------------- writes */

/**
 * §9 §10 — ask for a sample, with the reason as a code.
 *
 * The gate that decides whether this may be asked for at all is not here: it
 * is `gateTo(input, 'sample_trial')` on the record page, which draws the
 * button disabled with the twelve conditions listed under it. This is what
 * happens once it is open. Asking twice — on the screen and again here —
 * would be two readings of one rule, and it is the screen's that a salesman
 * would be looking at when they disagreed.
 */
export async function requestLeadSample(args: {
  customerId: string;
  leadId?: string | null;
  productId: string | null;
  productName: string;
  cans: number;
  application: string;
  reasonCode: string;
  followUpDate?: string | null;
}): Promise<SampleResult<string>> {
  if (!args.productName.trim()) return { ok: false, message: 'Which product is the trial of?' };
  if (!(args.cans > 0)) return { ok: false, message: 'How many cans?' };
  if (!args.application.trim()) {
    return {
      ok: false,
      message: 'What will they use it on? A trial nobody can judge is a can given away.',
    };
  }
  if (!args.reasonCode) return { ok: false, message: 'Say why they want a trial.' };

  const base = await stamp('sample');
  /* A week out unless somebody says otherwise — the review chase ladder is
     day 2, 4 and 6 from delivery and belongs to the office; this is the
     salesman's own diary date and is what the overdue strip reads. */
  const followUp = args.followUpDate ?? isoDate(new Date(Date.now() + 7 * 86_400_000));

  const id = await insertAndQueue({
    table: 'samples',
    entityType: 'sample',
    row: {
      ...base,
      customerId: args.customerId,
      leadId: args.leadId ?? null,
      productId: args.productId,
      productName: args.productName.trim(),
      cans: args.cans,
      reasonCode: args.reasonCode,
      application: args.application.trim(),
      /* `reason` is what this app has always sent as `feedbackNotes`. It
         carries the application now rather than a sentence somebody typed,
         because the code says why and the application says what it is for. */
      reason: args.application.trim(),
      requestedAt: Date.now(),
      state: 'Requested',
      trialOutcome: 'pending',
      followUpDate: followUp,
    },
    payloadExtras: {
      quantityCans: args.cans,
      requestedDate: isoDate(new Date()),
      feedbackNotes: args.application.trim(),
      reasonCode: args.reasonCode,
      application: args.application.trim(),
      leadId: args.leadId ?? undefined,
    },
  });

  await raiseApproval({
    type: 'sample',
    subjectType: 'sample',
    subjectId: id,
    reason: args.reasonCode,
    deviceId: base.deviceId,
  });

  return { ok: true, value: id };
}

/**
 * One step along, locally and on the wire.
 *
 * THE WIRE WORDS GO AT THE TOP LEVEL, and nesting them was how every one of
 * these marks was thrown away. `updateAndQueue` posts
 * `{ id, ...patch, ...payloadExtras }`, and `sampleUpdateSchema` in
 * `src/lib/actions/mbos.ts` is a plain zod object — so `sampleState: wire`
 * was stripped whole, and the LOCAL Title-Case word left in the patch was what
 * reached the enum: `"Dispatched"` against `dispatched`, `"Tried"` against
 * `trial_done`. `safeParse` failed, `handleSampleUpdate` answered a terminal
 * `validationRejection`, and the courier docket, the confirmation, the
 * seven-part review and the cancellation were all dropped while the screen
 * said "Sent · <docket>" and "Written down". The wire is spread LAST, so its
 * spelling wins over the patch's own for every column they both name.
 *
 * The same schema declares every instant as epoch MILLISECONDS. An ISO string
 * in one of those fields fails the parse exactly as a Title-Case state does,
 * which is why nothing here formats a date on the way out.
 *
 * `customerId` is sent on every one of these and it is not decoration: it is
 * what the create branch requires, and a mark that lands on the create path
 * without one is refused with a message about a docket.
 */
async function moveSample(
  id: string,
  customerId: string,
  patch: Record<string, unknown>,
  wire: Record<string, unknown>,
): Promise<void> {
  await updateAndQueue({
    table: 'samples',
    entityType: 'sample',
    id,
    patch,
    payloadExtras: { customerId, ...wire },
  });
}

/** The shop a sample belongs to, so a state mark can name it on the wire. */
async function customerOf(id: string): Promise<string> {
  const row = await one<{ customerId: string }>('SELECT customerId FROM samples WHERE id = ?', [id]);
  return row?.customerId ?? '';
}

/** §15 — it left the godown. The courier and the docket are how it is traced. */
export async function markDispatched(
  id: string,
  args: { courierName: string; courierDocket: string; expectedDeliveryDate: string },
): Promise<SampleResult<null>> {
  if (!args.courierName.trim()) return { ok: false, message: 'Who is carrying it?' };
  if (!args.courierDocket.trim()) {
    return { ok: false, message: 'The docket number — without it nobody can trace it.' };
  }
  if (!args.expectedDeliveryDate) return { ok: false, message: 'When should it get there?' };

  const at = Date.now();
  await moveSample(
    id,
    await customerOf(id),
    {
      state: 'Dispatched',
      dispatchedAt: at,
      courierName: args.courierName.trim(),
      courierDocket: args.courierDocket.trim(),
      expectedDeliveryDate: args.expectedDeliveryDate,
    },
    {
      state: 'dispatched',
      courierName: args.courierName.trim(),
      courierDocket: args.courierDocket.trim(),
      expectedDeliveryDate: args.expectedDeliveryDate,
    },
  );
  return { ok: true, value: null };
}

/**
 * §15 — they have it, and a courier saying so is not the same as them saying
 * so.
 *
 * ONE TAP, ONE ASSERTION. This wrote `deliveredAt` and `receivedConfirmedAt`
 * from the same `Date.now()`, which manufactured the carrier's word out of the
 * shop's: two columns exist precisely because they are two parties, and §J
 * turns entirely on the second — the review clock is dated from it. AGENTS.md
 * states the rule in as many words, that `received_at` is never defaulted from
 * `delivered_at`, "because a default would quietly assert something nobody
 * asked the customer". What this button asserts is that the shop has it, so
 * that is the only column it writes; `deliveredAt` stays the carrier's and
 * arrives, or does not, off the pull.
 */
export async function confirmReceived(id: string, photoId?: string | null): Promise<SampleResult<null>> {
  const at = Date.now();
  await moveSample(
    id,
    await customerOf(id),
    {
      state: 'Awaiting feedback',
      receivedConfirmedAt: at,
      deliveryPhotoId: photoId ?? null,
    },
    /* `receivedAt` is the office's name for this same column, and epoch
       milliseconds is what its schema declares — an ISO string here failed the
       parse and took the whole confirmation with it. */
    { state: 'received', receivedAt: at, deliveryPhotoId: photoId ?? undefined },
  );
  if (photoId) await run('UPDATE media_queue SET parentId = ? WHERE id = ?', [id, photoId]);
  return { ok: true, value: null };
}

/**
 * §K — they have opened the can.
 *
 * The STATE does not move: a trial under way is still `Awaiting feedback`,
 * because what is owed is still the review. What moves is the date, and the
 * gap between this one and `trialCompletedAt` is the whole reason there are
 * two columns — a trial started and never finished is the commonest way a
 * sample goes quiet, and it is invisible where the only mark is an outcome.
 *
 * The wire carries the date alone and no `state`, which `sampleUpdateSchema`
 * allows: there is no state change to assert, and inventing one here would
 * move the sample forward on the office's record for a mark that is about
 * timing rather than about progress. Epoch milliseconds, which is what that
 * schema declares the two trial columns as.
 */
export async function markTrialStarted(id: string): Promise<SampleResult<null>> {
  const at = Date.now();
  await moveSample(id, await customerOf(id), { trialStartedAt: at }, { trialStartedAt: at });
  return { ok: true, value: null };
}

/** They have used it. What they thought is the next screen, not this one. */
export async function markTried(id: string): Promise<SampleResult<null>> {
  const at = Date.now();
  await moveSample(id, await customerOf(id), { state: 'Tried', trialCompletedAt: at }, {
    state: 'trial_done',
    /* Epoch milliseconds, which is what `sampleUpdateSchema` declares both
       trial columns as. An ISO string here failed the parse outright. */
    trialCompletedAt: at,
  });
  return { ok: true, value: null };
}

/**
 * The three of the seven that can carry a REFUSAL, and the sentence for their
 * absence.
 *
 * Exported so the sheet can grey its own button on the same rule the save
 * refuses on, rather than a second reading of it typed into a screen — the
 * half that drifts is always the half somebody is reading.
 */
export const REJECTION_FEEDBACK_FIELDS = ['otherComments', 'priceFeedback', 'competitorComparison'] as const;

export const REJECTION_NEEDS_WHY =
  'A rejected trial has to say why — the price, the comparison against what they use now, or in your own words. Without it the next sample goes out exactly the same.';

export function rejectionSaidWhy(
  fields: Partial<Record<(typeof FEEDBACK_FIELDS)[number]['id'], string>>,
): boolean {
  return REJECTION_FEEDBACK_FIELDS.some((id) => (fields[id] ?? '').trim().length > 0);
}

/**
 * §16 — the seven-part review.
 *
 * Six named answers and one open one, and the verdict beside them. Every one
 * of the six is a thing the negotiation call needs on its own — "dries slow"
 * and "dearer than Asian" are two different conversations with two different
 * people, and a paragraph holding both can be read back as neither.
 *
 * The photograph is optional and never blocks the save, like every other
 * attachment in this app: a review that failed because a picture of a painted
 * panel would not upload is a review nobody records a second time.
 */
export async function recordFeedback(
  sampleId: string,
  args: {
    customerId: string;
    fields: Partial<Record<(typeof FEEDBACK_FIELDS)[number]['id'], string>>;
    /* FOUR verdicts, not three. `more_testing` is a real answer — "they want
       to try it again on a different substrate" is neither approval nor
       refusal — and recording it as `pending` loses the fact that a trial
       happened at all. The office has accepted all four since the module
       shipped; only the handset offered three. */
    trialOutcome: TrialVerdict;
    photoId?: string | null;
  },
): Promise<SampleResult<null>> {
  const said = FEEDBACK_FIELDS.filter((f) => (args.fields[f.id] ?? '').trim());
  if (!said.length) {
    return { ok: false, message: 'Write down at least one thing they said about it.' };
  }

  /*
   * A REJECTED SAMPLE HAS TO SAY WHY, and this end was not asking.
   *
   * The office refuses a rejection carrying none of these three, and its own
   * comment claimed the handset had enforced it from the day it shipped. It
   * had not: any one of the seven answers satisfied the check above, so a
   * review with "dries in four hours" in the drying box and a No beside it
   * saved perfectly well here and was refused at the far end — or worse, was
   * accepted by an older server and stored a refusal nobody could read back.
   * The next sample then goes out exactly the same, which is the whole reason
   * the rule exists.
   *
   * The SAME three fields the office checks, because the office DERIVES the
   * stored rejection reason from precisely these — a check that passed on a
   * field the derivation ignores would demand an answer and still store
   * nothing. It is not a refusal for want of signal, which this app never
   * makes; it is a refusal for want of an ANSWER, which is a different thing
   * and legitimate on a sofa or in a market lane alike.
   */
  if (args.trialOutcome === 'rejected' && !rejectionSaidWhy(args.fields)) {
    return { ok: false, message: REJECTION_NEEDS_WHY };
  }

  const base = await stamp('samplefb');
  const at = Date.now();
  const existing = await feedbackFor(sampleId);

  const row = {
    id: existing?.id ?? newId('samplefb'),
    sampleId,
    customerId: args.customerId,
    quality: args.fields.quality?.trim() || null,
    performance: args.fields.performance?.trim() || null,
    application: args.fields.application?.trim() || null,
    drying: args.fields.drying?.trim() || null,
    competitorComparison: args.fields.competitorComparison?.trim() || null,
    priceFeedback: args.fields.priceFeedback?.trim() || null,
    otherComments: args.fields.otherComments?.trim() || null,
    trialOutcome: args.trialOutcome,
    photoId: args.photoId ?? null,
    recordedAt: at,
    clientCreatedAt: base.clientCreatedAt,
    deviceId: base.deviceId,
    syncState: 'queued',
  };

  /* One row per sample: a second review of the same trial is a CORRECTION of
     the first and not a second opinion, so it replaces rather than stacking. */
  const cols = Object.keys(row);
  await run(
    `INSERT INTO sample_feedback (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})
     ON CONFLICT(sampleId) DO UPDATE SET ${cols
       .filter((c) => c !== 'id' && c !== 'sampleId')
       .map((c) => `${c} = excluded.${c}`)
       .join(', ')}`,
    cols.map((c) => {
      const v = (row as Record<string, unknown>)[c];
      return v === undefined ? null : (v as string | number | null);
    }),
  );

  /* The sample itself carries the verdict, because that is what the gate in
     front of Negotiation reads — a review recorded with the trial still
     `pending` leaves the rung shut, and rightly. */
  await moveSample(
    sampleId,
    args.customerId,
    { state: 'Reviewed', reviewedAt: at, trialOutcome: args.trialOutcome },
    {
      state: 'reviewed',
      reviewedAt: at,
      trialOutcome: args.trialOutcome,
      feedback: {
        quality: row.quality,
        performance: row.performance,
        application: row.application,
        drying: row.drying,
        competitorComparison: row.competitorComparison,
        priceFeedback: row.priceFeedback,
        otherComments: row.otherComments,
      },
    },
  );

  if (args.photoId) await run('UPDATE media_queue SET parentId = ? WHERE id = ?', [sampleId, args.photoId]);
  return { ok: true, value: null };
}

/**
 * A trial that is not going to happen. The row stays, with the reason on it.
 *
 * `trialOutcome` is deliberately NOT touched. It used to be stamped
 * `rejected`, which said on the customer's record that they had tried the
 * product and turned it down — a sentence about the shop, written because the
 * office withdrew a sample that never left the godown. The state already says
 * it was cancelled, and `cancelReason` already says why.
 *
 * **A REASON IS A CODE, AND THIS PATH SENT ONLY WORDS.** The office has taken
 * `cancelReasonCode` since the module shipped and the handset — the one end
 * where a cancellation is actually decided, standing in the shop that said so
 * — sent a free sentence and nothing else. So every cancellation a salesman
 * made arrived uncountable: "cancelled: 14" is a number that sends nobody
 * anywhere, and the three problems above stayed folded into one.
 *
 * **The sentence stays, and it is not a second copy of the code.** A code says
 * WHICH of the eight and can be counted; the remarks say what actually
 * happened, which no list of eight can, and whoever picks this record up next
 * reads the second. Both, exactly as every other coded reason in this app
 * stores both.
 *
 * **`other` costs a sentence and the other seven do not.** A code meaning
 * "something else" with nothing behind it is the one row nobody can act on,
 * and it is what people reach for when a list does not fit — so it has to be
 * paid for. Refused here as well as on the sheet, because a screen is not a
 * rule and this function is reachable without one.
 */
export async function cancelSample(
  id: string,
  args: { reasonCode: string; remarks?: string | null },
): Promise<SampleResult<null>> {
  const code = (args.reasonCode ?? '').trim();
  const said = (args.remarks ?? '').trim();
  if (!code) return { ok: false, message: 'Pick why the trial is being called off.' };
  if (code === REASON_CODE_NEEDING_REMARKS && !said) {
    return {
      ok: false,
      message: '“Other” with nothing behind it is the one cancellation nobody can act on. A sentence, however short.',
    };
  }
  const at = Date.now();
  await moveSample(
    id,
    await customerOf(id),
    /* The CODE is not written locally: `samples` has no column for it, and the
       state and the sentence are what this screen draws. It goes up the wire
       regardless — the office is where cancellations are counted, and losing
       the code to a missing local column would be the same silent loss this
       whole change is about. */
    { state: 'Cancelled', cancelledAt: at, cancelReason: said || null },
    /* Null rather than an empty string where nobody typed one: an empty string
       reads on a record as a person who was asked and had nothing to say. */
    { state: 'cancelled', cancelReasonCode: code, cancelReason: said || null },
  );
  return { ok: true, value: null };
}
