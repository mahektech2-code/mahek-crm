import { all, newId, one, run } from '../db';
import { getConfig } from './config';
import { raiseApproval } from './requests';
import { insertAndQueue, stamp, updateAndQueue } from './write';
import { isoDate } from '../lib/format';
import { FEEDBACK_FIELDS, type CodedOption } from '../engines/funnel';

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
 * TODO(integration): the dispatch, delivery and review marks travel as
 * `sampleState` on the ordinary `sample` update. Workstream B owns
 * `src/lib/actions/lead-samples.ts`, and its `dispatchSample`,
 * `confirmSampleReceived` and `recordSampleFeedback` are where these land;
 * workstream A owns the dispatcher that has to route them. Until both are in,
 * zod strips the extra fields and the handset's own record stands alone.
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
  trialOutcome: string | null;
  followUpDate: string | null;
  convertedOrderId: string | null;
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
 * `customerId` is sent on every one of these and it is not decoration:
 * `handleSample` in `src/lib/actions/mbos.ts` parses an update with the FULL
 * `sampleSchema`, which requires it, so a state mark posted without one is
 * rejected outright and the salesman is told a courier docket was invalid.
 * The insert behind it is `onConflictDoNothing`, so restating it changes
 * nothing that is already there.
 *
 * TODO(integration): `sampleState` is not on `sampleSchema` yet and is
 * stripped, so the office currently learns nothing from these four marks —
 * and each one writes a second "sample handed to X" line on the customer
 * timeline, because that handler has no `item.op === 'update'` branch.
 * Workstream A owns the dispatcher and workstream B owns `dispatchSample`,
 * `confirmSampleReceived` and `recordSampleFeedback`; the shape below is what
 * they should read.
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
    payloadExtras: { customerId, sampleState: wire },
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
 * `receivedConfirmedAt` is deliberately separate from `deliveredAt`: one is
 * what the docket claims and the other is the customer or the salesman
 * confirming it, and a trial chased on the strength of a scan that was wrong
 * is a call that annoys somebody who never got anything.
 */
export async function confirmReceived(id: string, photoId?: string | null): Promise<SampleResult<null>> {
  const at = Date.now();
  await moveSample(
    id,
    await customerOf(id),
    {
      state: 'Awaiting feedback',
      deliveredAt: at,
      receivedConfirmedAt: at,
      deliveryPhotoId: photoId ?? null,
    },
    { state: 'received', receivedAt: new Date(at).toISOString(), deliveryPhotoId: photoId ?? undefined },
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
    trialCompletedAt: new Date(at).toISOString(),
  });
  return { ok: true, value: null };
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
      reviewedAt: new Date(at).toISOString(),
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
 */
export async function cancelSample(id: string, reason: string): Promise<SampleResult<null>> {
  const said = reason.trim();
  if (!said) return { ok: false, message: 'Say why it is being cancelled.' };
  const at = Date.now();
  await moveSample(
    id,
    await customerOf(id),
    { state: 'Cancelled', cancelledAt: at, cancelReason: said },
    { state: 'cancelled', cancelReason: said },
  );
  return { ok: true, value: null };
}
