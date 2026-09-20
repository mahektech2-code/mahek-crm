import { all, getKv, newId, one, run, setKv } from '../db';
import { getConfig } from './config';
import { getLead, notesOf, type Lead, type LeadResult } from './leads';
import { updateAndQueue } from './write';
import { isoDate, plural } from '../lib/format';
import { legacyStageFor, stageOf, wireFunnelStage, wireNotes } from '../lib/wire';
import type { FieldCheck } from '../engines/field-check';
import {
  gateForNext,
  gateTo,
  labelOf,
  mustDecideSuspect,
  ORDER_BLOCKERS,
  REASON_CODE_NEEDING_REMARKS,
  type CodedOption,
  type GateVerdict,
  type LeadGateInput,
  type LeadSalesType,
  type LeadStage,
  stageLabel,
} from '../engines/funnel';

/**
 * The funnel, on the phone.
 *
 * Everything a salesman does to a lead beyond typing a sentence is here, and
 * all of it is offline: the gate that says whether he may move a lead is the
 * SAME pure function the server action refuses on, compiled into this app, so
 * a shop with no signal is told which condition is still missing rather than
 * being told to try again later. That is the whole reason `engines/funnel`
 * exists as a copy of the server's engines.
 *
 * Every write goes through `updateAndQueue`, so it is in the local store
 * before the outbox has looked at it, and the position it was done at is
 * attached by `enqueue` rather than by anything here — see the note at the top
 * of `sync/queue.ts`.
 *
 * THE WIRE IS FLAT, and it is `leadSchema` in `src/lib/actions/mbos.ts` that
 * says so. `salesType`, `customerType`, `monthlyLitres`, `competitor`,
 * `requiredProductId`, `contactPerson`, `decisionMaker`, `creditDaysWanted`,
 * `application`, `gstin`, `qualification`, `nextAction` and `suspectDecidedAt`
 * are fields on the ordinary `lead` update, and the local column names match
 * them one for one — which is why most of what goes out below is simply the
 * patch, with `payloadExtras` naming only the handful where the two words
 * differ. `stage` is always one of those: the local column holds this app's
 * six words and the wire carries the specification's rung.
 *
 * TODO(integration): what this file records and the office cannot yet hear.
 * `distributorProfile` (§11's thirty) and the third-party link (§23) are
 * workstream B's; `expectedOrderDate`/`expectedOrderValuePaise` have since
 * landed on `leadSchema` and are struck off. What remains is §5.5's other two
 * halves of a commitment — the QUANTITY and the BLOCKER — which have no
 * column on this phone and no field on that schema, and which are therefore
 * kept in `kv` and deliberately NOT sent: see `rememberCommitmentExtras` below
 * for why a field the office has not promised to hold must not be put on the
 * wire on the chance that it one day will. Until they land the handset's own
 * record is complete and the office hears nothing about them — nothing is
 * refused, which is the safe direction and the silent one.
 */

/* ------------------------------------------------------------- the config */

export type FunnelConfig = {
  suspectMaxVisits: number;
  requireNextAction: boolean;
  prospectReasons: CodedOption[];
  sampleReasons: CodedOption[];
  lostReasons: CodedOption[];
  /* Why a lead stopped. Published by the office since the funnel shipped and
     read by nothing here — see the note in `data/config.ts`. */
  holdReasons: CodedOption[];
  /* §5.5 — what is stopping the first order. Configured for the same reason
     every other list here is: a manager rewords one without a deploy, and on
     this app without an APK nobody can recall. */
  orderBlockers: CodedOption[];
};

/**
 * The coded lists and the suspect window, fetched together.
 *
 * Together rather than one await at a time, because every screen in the funnel
 * needs at least two of them and a form that renders its options one await at
 * a time flickers its way onto the screen while somebody is standing in a
 * shop.
 */
export async function funnelConfig(): Promise<FunnelConfig> {
  const [
    suspectMaxVisits,
    requireNextAction,
    prospectReasons,
    sampleReasons,
    lostReasons,
    holdReasons,
    orderBlockers,
  ] = await Promise.all([
    getConfig<number>('leads.suspectMaxVisits'),
    getConfig<boolean>('leads.requireNextAction'),
    getConfig<CodedOption[]>('leads.prospectReasons'),
    getConfig<CodedOption[]>('leads.sampleReasons'),
    getConfig<CodedOption[]>('leads.lostReasons'),
    getConfig<CodedOption[]>('leads.holdReasons'),
    /* THE FALLBACK IS SPELLED OUT HERE because `data/config.ts`'s DEFAULTS
       table does not carry this key yet, and `getConfig` answers `undefined`
       for one it does not know. Undefined here is a picker with nothing in it,
       which reads as a broken screen rather than as a key nobody published —
       and a commitment could then not be recorded at all. `ORDER_BLOCKERS` is
       the registry's own default, so the two cannot differ; the table should
       grow the key and this argument should go with it. */
    getConfig<CodedOption[]>('leads.orderBlockers', ORDER_BLOCKERS.map((r) => ({ ...r }))),
  ]);
  return {
    suspectMaxVisits,
    requireNextAction,
    prospectReasons,
    sampleReasons,
    lostReasons,
    holdReasons,
    orderBlockers,
  };
}

/* ------------------------------------------------------------------ reads */

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

export function qualificationOf(lead: Lead): Record<string, boolean | string> {
  return parseJson<Record<string, boolean | string>>(lead.qualification, {});
}

export function distributorProfileOf(lead: Lead): Record<string, unknown> {
  return parseJson<Record<string, unknown>>(lead.distributorProfile, {});
}

export function salesTypeOf(lead: Lead): LeadSalesType | null {
  const t = lead.salesType;
  return t === 'direct' || t === 'distributor' || t === 'third_party' ? t : null;
}

/*
 * `stageOf` MOVED TO `lib/wire.ts`, and is re-exported here so its callers did
 * not have to. It is a pure translation of two stored columns into the
 * engine's vocabulary, which is that file's whole job — and it had to leave
 * this one because this one imports the database, so nothing that lives here
 * can be tested without a handset. The card on the Customers list reads it
 * now, and a rule that decides what four hundred rows SAY is a rule that needs
 * a test more than most.
 */
export { stageOf };

/**
 * How many times somebody has been to this shop.
 *
 * Counted from the visits table rather than kept as a number on the lead, for
 * the reason the server states about its own column: a count drifts the first
 * time a visit arrives late from another handset or is recorded against the
 * shop from the customer list instead. `visits.customerId` holds the LEAD's id
 * for a lead, because one lead is one `customers` row on the office side and
 * the id a visit names is the same id either way.
 */
export async function visitCount(leadId: string): Promise<number> {
  const row = await one<{ n: number }>('SELECT COUNT(*) AS n FROM visits WHERE customerId = ?', [leadId]);
  return row?.n ?? 0;
}

/**
 * Everything the gates read about one lead, and nothing they do not.
 *
 * Assembled here rather than in a screen so the record page, the sample form
 * and the qualification checklist all ask the same question of the same data —
 * three readings of "may this move" is how two of them come to disagree.
 */
export async function leadGateInput(lead: Lead): Promise<LeadGateInput> {
  const [visits, sample, figuresFreshDays] = await Promise.all([
    visitCount(lead.id),
    one<{ state: string; trialOutcome: string | null; feedback: number }>(
      `SELECT s.state, s.trialOutcome,
              (SELECT COUNT(*) FROM sample_feedback f WHERE f.sampleId = s.id) AS feedback
         FROM samples s
        WHERE s.customerId = ? AND s.state <> 'Cancelled'
        ORDER BY s.requestedAt DESC
        LIMIT 1`,
      [lead.id],
    ),
    /* §5.3 — the window, off the same `leads.*` keys the suspect cap reads.
       It reaches this phone on every pull, so the staleness verdict is made
       here against this phone's clock rather than sent as somebody else's. */
    getConfig<number>('leads.figuresFreshDays'),
  ]);

  return {
    salesType: salesTypeOf(lead),
    stage: stageOf(lead),

    customerType: lead.customerType,
    /* TWO COLUMNS, ONE FACT — see `monthlyLitres` on the `Lead` type for why
       both pairs exist. The capture form writes what he was told standing in
       the shop into `monthlyVolumeLitres`/`competitorName`; the office writes
       the same two facts into `monthlyLitres`/`competitor`, and the gate only
       ever read the office's pair. So a salesman who had just answered "how
       much a month" and "who they buy from now" on the New lead form was asked
       for both again ten minutes later, out of the shop, with the boxes empty
       and the outstanding list naming them as still to answer.
       The funnel's own column wins where it has been filled in, because
       Prospect details is where somebody corrects the first reading. */
    monthlyLitres: lead.monthlyLitres ?? lead.monthlyVolumeLitres,
    potentialPaise: lead.estimatedPotentialPaise,
    competitor: lead.competitor ?? lead.competitorName,
    requiredProductId: lead.requiredProductId,
    contactPerson: lead.contactPerson,
    decisionMaker: lead.decisionMaker,
    creditDaysWanted: lead.creditDaysWanted,
    application: lead.application,
    gstin: lead.gstin,
    /* §11.6 — the OFFICE's verdict, pulled down and settable by nothing here.
       The gate reads the number AND this, so while it was on no wire it was
       undefined on every handset and no shop lead ever reached Sample/Trial. */
    gstVerified: lead.gstVerified === 1,

    nextAction: lead.nextAction,
    nextActionDate: lead.nextActionDate,
    nextActionOwnerId: lead.nextActionOwnerId,

    qualification: qualificationOf(lead),

    suspectVisitCount: visits,
    suspectDecidedAt: lead.suspectDecidedAt ? new Date(lead.suspectDecidedAt) : null,
    prospectReasonRecorded: Boolean(lead.prospectReasonCode),
    verifiedAt: lead.verifiedAt ? new Date(lead.verifiedAt) : null,

    thirdParty: Boolean(lead.thirdParty),
    /* THE OFFICE'S COUNT, and it used to be an id this phone never received.
       `distributorCustomerId` reached no handset, so a third-party lead the
       office had already given a distributor answered zero here and was refused
       its sample in the words "Say which distributor invoices this shop" — over
       an arrangement that was on the record. The id comes down now too, and the
       count is still the count, because a shop on a territory boundary has two
       and one column could only ever name one of them. */
    distributorCount: lead.distributorCount ?? (lead.distributorCustomerId ? 1 : 0),
    /* §4.2 — who PLACES the order. The eighth qualification condition takes
       this OR a confirmed decision maker, so the ordinary shop where one man
       does both is never asked for a second name. */
    buyer: lead.buyer,

    /* The state words differ on the two sides — this app keeps the design's
       `Awaiting feedback` and MahekOne keeps `dispatched`/`received`. The gate
       reads MahekOne's, so the mapping happens here rather than in the engine,
       which must stay the same file on both ends. */
    sample: sample
      ? {
          state: wireSampleState(sample.state),
          trialOutcome: sample.trialOutcome ?? 'pending',
          feedbackRecorded: (sample.feedback ?? 0) > 0,
        }
      : null,

    distributorProfile: distributorProfileOf(lead),
    /* §12 — the two approval steps, the commercial terms and the signed
       agreement. None of the four is this phone's to assert and nothing here
       writes one; they arrive so a salesman on the distributor ladder is told
       which of them he is waiting on instead of being shown a disabled button
       over a list with nothing on it he can do. 1 is the office's yes; 0 and
       null both leave the rung shut, which is what the gate already does. */
    managementReviewApproved: lead.managementReviewApproved === 1,
    distributorApprovalApproved: lead.distributorApprovalApproved === 1,
    commercialTermsAgreed: lead.commercialTermsAgreed === 1,
    agreementOnFile: lead.agreementOnFile === 1,

    /* §18–§22 — what the LEDGER says, counted by the office over the whole
       account. Deliberately not counted from this phone's own orders table: the
       handset holds what it has been sent and what is still in its outbox, and
       a count that included the outbox would tell a salesman a rung was open
       and let the server refuse the move a minute later. */
    countingOrderCount: lead.countingOrderCount ?? undefined,
    deliveredOrderCount: lead.deliveredOrderCount ?? undefined,
    confirmedPaymentCount: lead.confirmedPaymentCount ?? undefined,
    /* §21 — the initial stock order a distributor committed to IS an order on
       their account. There is no separate flag on either side and there should
       not be one: a boolean somebody ticks beside an order book that disagrees
       with it is how the two come apart. Derived from the count rather than
       sent, for the same reason — one fact, one number. */
    initialStockOrderPlaced: (lead.countingOrderCount ?? 0) >= 1,

    /*
     * §5.3 — THE FIGURES, JUDGED HERE against this phone's own clock.
     *
     * The office sends the DAY somebody last confirmed them and this works out
     * whether that is stale, rather than the office sending the verdict. A
     * verdict is about the moment of the pull, which is right for a phone
     * syncing through the day and a week out of date on one that has been in a
     * district with no signal — which is exactly the handset a gate answered
     * offline is for. `leads.figuresFreshDays` rides down with the rest of the
     * `leads.*` keys; a threshold of zero switches the check off, and never
     * having confirmed them is stale, which is `figuresAreStale` on the server
     * said in the same order.
     */
    figuresStale: figuresAreStale(lead.figuresConfirmedAt, figuresFreshDays),
    /* §5.3 — and a manager who said the checklist was not finished is listened
       to. Only `incomplete` and `clarification` hold it; an unreviewed
       checklist passes, which is what let the rule ship without stopping the
       whole book on the day it landed. */
    qualificationReview:
      lead.qualificationReview === 'incomplete' ||
      lead.qualificationReview === 'clarification' ||
      lead.qualificationReview === 'verified'
        ? lead.qualificationReview
        : null,

    expectedOrderDate: lead.expectedOrderDate,
  };
}

/**
 * §5.3 — are the four conversion figures older than we are willing to send a
 * sample on?
 *
 * The SERVER's copy is `figuresAreStale` in `lib/services/lead-service.ts`,
 * which is `server-only` and cannot be imported here — so this is four lines
 * saying the same thing rather than a mirror file, and they are written in the
 * same order so the two can be read side by side. Never confirmed is STALE:
 * the question is whether anybody has said the figures still hold, and nobody
 * having said so is the answer the rule exists for. A threshold of zero
 * switches the check off, which is how a team that does not want it turns it
 * off from the Settings screen rather than from a deploy.
 */
function figuresAreStale(confirmedAtMs: number | null, freshDays: number): boolean {
  if (!freshDays || freshDays <= 0) return false;
  if (!confirmedAtMs) return true;
  return Date.now() - confirmedAtMs > freshDays * 24 * 60 * 60 * 1000;
}

/**
 * The design's word for where a sample has got to, in MahekOne's.
 *
 * `localSampleState` in `lib/wire.ts` goes the other way, for a sample the
 * office sent down. This is the return leg, and it exists because the GATE is
 * a shared file: `lead-gates.ts` asks whether a sample is `dispatched` or
 * `received`, and a handset answering `Awaiting feedback` would leave every
 * sample rung shut with a condition the salesman had already satisfied.
 */
function wireSampleState(state: string): string {
  switch (state) {
    case 'Requested': return 'requested';
    case 'Approved': return 'approved';
    case 'Rejected': return 'rejected';
    case 'Dispatched': return 'dispatched';
    case 'Awaiting feedback': return 'received';
    case 'Tried': return 'trial_done';
    case 'Reviewed': return 'reviewed';
    case 'Converted': return 'reviewed';
    case 'Cancelled': return 'cancelled';
    default: return state.toLowerCase();
  }
}

export type LeadFunnelView = {
  lead: Lead;
  input: LeadGateInput;
  salesType: LeadSalesType | null;
  stage: LeadStage;
  next: LeadStage | null;
  gate: GateVerdict;
  mustDecide: boolean;
  visits: number;
  config: FunnelConfig;
};

/** One read for the whole record page — the lead, the gate and the window. */
export async function leadFunnelView(id: string): Promise<LeadFunnelView | null> {
  const lead = await getLead(id);
  if (!lead) return null;
  const [input, config, visits] = await Promise.all([
    leadGateInput(lead),
    funnelConfig(),
    visitCount(id),
  ]);
  const salesType = salesTypeOf(lead);
  const stage = stageOf(lead);
  const gate = gateForNext(input);
  return {
    lead,
    input,
    salesType,
    stage,
    /*
     * THE NEXT RUNG COMES OFF THE GATE, and it used to come off `nextStage`.
     *
     * `gateForNext` deliberately refuses to answer for a stage that is on no
     * ladder — terminal, or PARKED — and says so with `noNextRung`. Asking
     * `nextStage` the same question separately got the other answer: it
     * replies with the FOOT of the ladder for a rung it cannot find, which is
     * right for a lead whose sales type somebody has just changed and wrong
     * for one on hold. So an On-hold lead half way up its ladder drew "Move up
     * to Suspect", disabled, over a list of what was still to do with nothing
     * in it — the gate had already said there was nothing to say.
     *
     * One reading now, and it is the gate's. `gate.to` is the destination
     * where there is one and the lead's own stage where there is not, which is
     * exactly what the flag is for.
     */
    next: gate.noNextRung ? null : gate.to,
    gate,
    mustDecide: mustDecideSuspect(input, config.suspectMaxVisits),
    visits,
    config,
  };
}

/**
 * The shop front, and whether the picture is still on this phone.
 *
 * He stood in the street to take it and no screen here ever showed it back to
 * him. What CAN be shown depends on where the file is: `runMediaQueue` deletes
 * the local copy once the bytes are safely with the office, so a `synced` row
 * names a path that no longer exists — and an `<Image>` pointed at one is a
 * grey rectangle with nothing to say for itself, which is worse than a
 * sentence. Null means no photograph was taken at all; `{ uri: null }` means
 * one was and it is not here any more, and those are different facts.
 */
export async function shopPhoto(leadId: string): Promise<{ uri: string | null } | null> {
  const row = await one<{ localUri: string; state: string }>(
    `SELECT localUri, state FROM media_queue
      WHERE parentId = ? AND kind = 'shop_photo'
      ORDER BY createdAt DESC LIMIT 1`,
    [leadId],
  );
  if (!row) return null;
  return { uri: row.state === 'synced' ? null : row.localUri };
}

/* -------------------------------------------------------------- the trail */

export type LeadEvent = {
  id: string;
  leadId: string;
  kind: string;
  summary: string;
  detail: string | null;
  fromStage: string | null;
  toStage: string | null;
  actor: string | null;
  occurredAt: number;
};

/**
 * §25 — a lead's history, newest first.
 *
 * Local and appended. It is not sent as a record of its own: every line of it
 * is written BY something that is sent — a stage change, a saved form, a
 * sample — so the office reconstructs the same story from the writes it
 * receives, and a line here with nothing behind it would be a claim about work
 * with no work under it.
 */
export async function leadEvents(leadId: string, limit = 50): Promise<LeadEvent[]> {
  return all<LeadEvent>(
    'SELECT * FROM lead_events WHERE leadId = ? ORDER BY occurredAt DESC, id DESC LIMIT ?',
    [leadId, limit],
  );
}

async function addEvent(args: {
  leadId: string;
  kind: string;
  summary: string;
  detail?: string | null;
  fromStage?: string | null;
  toStage?: string | null;
}): Promise<void> {
  await run(
    `INSERT INTO lead_events (id, leadId, kind, summary, detail, fromStage, toStage, actor, occurredAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'You', ?)`,
    [
      newId('le'),
      args.leadId,
      args.kind,
      args.summary,
      args.detail ?? null,
      args.fromStage ?? null,
      args.toStage ?? null,
      Date.now(),
    ],
  );
}

/**
 * A sentence somebody typed, on the trail as well as in the note list.
 *
 * `addNote` in `data/leads.ts` keeps the note list, which is what goes out on
 * the wire and what the office reads. This puts the same sentence on the local
 * timeline beside the stage changes and the samples, because a history that
 * holds every mechanical event and none of the things a person actually said
 * is the half nobody wants.
 */
export async function addLeadNote(id: string, text: string): Promise<LeadResult<null>> {
  const { addNote } = await import('./leads');
  const r = await addNote(id, text);
  if (!r.ok) return r;
  await addEvent({ leadId: id, kind: 'note', summary: text.trim() });
  return r;
}

/* ----------------------------------------------------------------- writes */

const ok: LeadResult<null> = { ok: true, value: null };

/**
 * §2 — which ladder this lead is on.
 *
 * Changing it is its own act with its own reason, and it is deliberately not
 * offered as a chip beside the stage: a lead half way up the distributor
 * ladder does not become a shop because somebody tapped a different word. The
 * stage comes back to the FOOT when the ladder changes, because the rung it
 * was standing on may not exist on the new one — `nextStage` answers with the
 * foot for exactly this case, and leaving a lead on a rung that is not on its
 * ladder is how a record ends up with no button and no explanation.
 */
export async function setSalesType(
  id: string,
  salesType: LeadSalesType,
  reason?: string | null,
): Promise<LeadResult<null>> {
  const lead = await getLead(id);
  if (!lead) return { ok: false, message: 'That lead is no longer on this phone.' };
  if (salesTypeOf(lead) === salesType) return ok;

  const today = isoDate(new Date());
  const was = stageOf(lead);
  const settled = was === 'lost' || was === 'won';
  const stage: LeadStage = settled ? was : 'suspect';

  await updateAndQueue({
    table: 'leads',
    entityType: 'lead',
    id,
    patch: {
      salesType,
      funnelStage: stage,
      stage: legacyStageFor(stage, salesType),
      stageSince: today,
      lastActivityDate: today,
    },
    payloadExtras: {
      stage: wireFunnelStage(stage),
      salesType,
      /* The reason is kept on the local trail rather than sent: the wire has
         nowhere for it, and inventing a field the server strips would read
         like it had been recorded. */
    },
  });

  await addEvent({
    leadId: id,
    kind: 'sales_type',
    summary: 'Sales type set — ' + salesType.replace('_', ' '),
    detail: reason?.trim() || null,
    fromStage: was,
    toStage: stage,
  });
  return ok;
}

/**
 * §5 §6 — the eight answers, and why this is worth pursuing.
 *
 * ONE save for the whole form, because it is one screen: a salesman standing
 * outside a shop will not come back to a second one, and eight fields saved in
 * three pieces is three chances to leave the record half-answered. What the
 * gate then reads is real values, so there is no state where the form is
 * complete and the rung is still shut.
 */
export async function saveProspectFields(
  id: string,
  fields: {
    customerType?: string | null;
    monthlyLitres?: number | null;
    estimatedPotentialPaise?: number | null;
    competitor?: string | null;
    requiredProductId?: string | null;
    requiredProductName?: string | null;
    contactPerson?: string | null;
    decisionMaker?: string | null;
    creditDaysWanted?: number | null;
    application?: string | null;
    gstin?: string | null;
    prospectReasonCode?: string | null;
  },
  /*
   * §9 — CONFIRM § CORRECT § UNABLE TO VERIFY, as rows rather than as columns.
   *
   * They ride with the save and are NOT part of the patch, which is the whole
   * distinction: the lead's own columns hold what the shop says TODAY, and
   * these hold who asked, what the record said at the time and why the two
   * differ. Folding them into the patch would try to write six columns that do
   * not exist; folding them into the note would make them a sentence nobody
   * can count, which is the argument `verify-field-row.tsx` already sets out.
   *
   * `payloadExtras` and not `patch` for exactly that reason.
   */
  fieldChecks?: FieldCheck[],
): Promise<LeadResult<null>> {
  const lead = await getLead(id);
  if (!lead) return { ok: false, message: 'That lead is no longer on this phone.' };

  const today = isoDate(new Date());
  const patch: Record<string, unknown> = { lastActivityDate: today };
  for (const [k, v] of Object.entries(fields)) {
    /* Undefined is "not asked on this screen" and null is "cleared". Sending
       the whole form back with the untouched half as null is how a saved
       prospect form empties the four fields the qualification screen filled. */
    if (v !== undefined) patch[k] = v;
  }

  await updateAndQueue({
    table: 'leads',
    entityType: 'lead',
    id,
    patch,
    /* The eight are already in the patch under the names the wire uses — the
       local columns and `leadSchema` agree word for word. Only the reason
       differs: it is `prospectReasonCode` here and the schema's one
       `reasonCode`, which carries whichever code a move was made under. */
    payloadExtras: {
      reasonCode: fields.prospectReasonCode ?? undefined,
      requiredProductName: undefined,
      /* Omitted rather than sent empty: an absent field is a screen that asked
         nothing, and `[]` on the wire would read at the office as six questions
         somebody declined to answer. */
      fieldChecks: fieldChecks?.length ? fieldChecks : undefined,
    },
  });

  await addEvent({ leadId: id, kind: 'prospect_form', summary: 'Prospect details saved' });
  return ok;
}

/**
 * §9 §11 — the checklist, saved a GROUP at a time.
 *
 * A shop answers twelve and a distributor answers thirty in five groups, and
 * thirty is four screens filled over several visits — so each group saves on
 * its own rather than the lot at the end. A form that only commits when it is
 * complete loses everything a salesman managed before the shop got busy, which
 * on this checklist is most of the times it is opened.
 *
 * The answers are MERGED into what is stored, never replaced, for the same
 * reason: a group screen knows about its own questions and nothing about the
 * other four, and writing the whole object back would blank them.
 */
export async function saveQualification(
  id: string,
  answers: Record<string, boolean | string>,
  groupName?: string,
): Promise<LeadResult<null>> {
  const lead = await getLead(id);
  if (!lead) return { ok: false, message: 'That lead is no longer on this phone.' };

  const merged = { ...qualificationOf(lead), ...answers };
  const today = isoDate(new Date());

  await updateAndQueue({
    table: 'leads',
    entityType: 'lead',
    id,
    patch: { qualification: merged, lastActivityDate: today },
    /* The whole object goes out — it is already in the patch as
       `qualification`, which is the wire's own word for it. The server MERGES
       what arrives into what it holds rather than replacing, so two handsets
       and an office screen answering different questions all survive. */
  });

  await addEvent({
    leadId: id,
    kind: 'qualification',
    summary: groupName ? 'Qualification saved — ' + groupName : 'Qualification saved',
    detail: Object.keys(answers).length + ' answered',
  });
  return ok;
}

/** §11 — the thirty a distributor answers live on their own profile object. */
export async function saveDistributorProfile(
  id: string,
  patch: Record<string, unknown>,
  groupName?: string,
): Promise<LeadResult<null>> {
  const lead = await getLead(id);
  if (!lead) return { ok: false, message: 'That lead is no longer on this phone.' };

  const merged = { ...distributorProfileOf(lead), ...patch };
  const today = isoDate(new Date());

  await updateAndQueue({
    table: 'leads',
    entityType: 'lead',
    id,
    /* TODO(integration): `distributorProfile` is not on `leadSchema` yet, so
       this reaches the office and is stripped. It is complete on the phone. */
    patch: { distributorProfile: merged, lastActivityDate: today },
  });

  await addEvent({
    leadId: id,
    kind: 'distributor_profile',
    summary: groupName ? 'Distributor details saved — ' + groupName : 'Distributor details saved',
  });
  return ok;
}

/**
 * §24 — what happens next, on what day, and who is doing it.
 *
 * All three or none. A next action with no owner is the state the rule exists
 * to stop: a lead sitting for six weeks with everybody assuming somebody else
 * has it, and a date on the screen that made it look attended to.
 */
export async function setNextAction(
  id: string,
  next: { action: string; date: string; ownerId: string; outcome?: string | null },
): Promise<LeadResult<null>> {
  if (!next.action.trim()) return { ok: false, message: 'Say what happens next.' };
  if (!next.date) return { ok: false, message: 'Pick the day it happens on.' };
  if (!next.ownerId) return { ok: false, message: 'Say who is doing it.' };

  const today = isoDate(new Date());
  await updateAndQueue({
    table: 'leads',
    entityType: 'lead',
    id,
    patch: {
      nextAction: next.action.trim(),
      nextActionDate: next.date,
      nextActionOwnerId: next.ownerId,
      nextActionOutcome: next.outcome?.trim() || null,
      /* The salesman's own diary follows the action's day. They were two
         dates that meant almost the same thing and disagreed on every lead
         where somebody set one and not the other. */
      nextFollowUpDate: next.date,
      lastActivityDate: today,
    },
    payloadExtras: {
      /* THREE LOCAL COLUMNS, ONE WIRE FIELD, and this override is what stops
         the whole payload being refused. `nextAction` is a string here and an
         OBJECT on `leadSchema`; sending the string would fail validation and
         take the follow-up date and the activity stamp down with it. */
      nextAction: {
        action: next.action.trim(),
        date: next.date,
        ownerId: next.ownerId,
        outcome: next.outcome?.trim() || undefined,
      },
    },
  });

  await addEvent({
    leadId: id,
    kind: 'next_action',
    summary: 'Next: ' + next.action.trim(),
    detail: next.date,
  });
  return ok;
}

/**
 * §4 — Prospect or Not Prospect, and there is no third answer.
 *
 * Past the window the specification FORCES this, which is why the record page
 * turns into one question rather than refusing a button: nothing is being
 * refused, something is being demanded. Not Prospect is a loss with its own
 * reason, so it goes down the same road §26 does and the lead keeps its
 * history.
 */
export async function decideSuspect(
  id: string,
  decision: { prospect: boolean; reasonCode: string; note?: string | null },
): Promise<LeadResult<null>> {
  const lead = await getLead(id);
  if (!lead) return { ok: false, message: 'That lead is no longer on this phone.' };
  /*
   * A CODE OR A SENTENCE, and it used to be a code or nothing.
   *
   * The four reason lists are configuration and an office can empty one. Past
   * the cap this decision is the whole record, so a code demanded against a
   * list with nothing in it left the lead permanently unanswerable — see the
   * note in `reason-sheet.tsx`. Either answer is accepted here and on the
   * server, which refuses only when both are missing.
   *
   * What a sentence alone does NOT satisfy is the `prospect_reason` gate one
   * rung up, which reads the code. That is the honest consequence: the record
   * comes back and the gate says in words what it still wants, rather than the
   * lead being stuck with no screen at all.
   */
  const said = decision.note?.trim() || null;
  if (!decision.reasonCode && !said) {
    return {
      ok: false,
      message: decision.prospect
        ? 'Say why this is worth pursuing.'
        : 'Say why it is not — nobody comes back to this shop after this.',
    };
  }

  const today = isoDate(new Date());
  const salesType = salesTypeOf(lead);
  const stage: LeadStage = decision.prospect ? 'prospect' : 'lost';
  const now = Date.now();

  await updateAndQueue({
    table: 'leads',
    entityType: 'lead',
    id,
    patch: {
      suspectDecidedAt: now,
      suspectIsProspect: decision.prospect,
      /* An empty code keeps whatever was already on the row rather than
         blanking it — the answer came as a sentence, which is not a reason to
         forget a code somebody recorded earlier. */
      suspectReasonCode: decision.reasonCode || lead.suspectReasonCode,
      prospectReasonCode: decision.prospect
        ? decision.reasonCode || lead.prospectReasonCode
        : lead.prospectReasonCode,
      lostReasonCode: decision.prospect ? lead.lostReasonCode : decision.reasonCode || lead.lostReasonCode,
      lostReason: decision.prospect ? lead.lostReason : (said || decision.reasonCode),
      funnelStage: stage,
      stage: legacyStageFor(stage, salesType),
      stageSince: today,
      lastActivityDate: today,
    },
    payloadExtras: {
      stage: wireFunnelStage(stage),
      /* `handleLeadUpdate` refuses a loss with no reason, and rightly — the
         code is what gets counted and the sentence is what gets read, so both
         travel. */
      lostReason: decision.prospect ? undefined : (said || decision.reasonCode),
      /* The CODE, whichever way the answer went — why it is worth pursuing,
         or why it is not. One field, because the schema keeps one: what it
         means is read off the stage that arrived with it. Omitted rather than
         sent empty where there was nothing to pick, so the server reads the
         sentence instead of an empty string. */
      reasonCode: decision.reasonCode || undefined,
    },
  });

  await addEvent({
    leadId: id,
    kind: 'suspect_decision',
    summary: decision.prospect ? 'Worth pursuing — now a Prospect' : 'Not a prospect',
    detail: said || decision.reasonCode,
    fromStage: 'suspect',
    toStage: stage,
  });
  return ok;
}

/**
 * §28 — up one rung, and only where the gate is open.
 *
 * The gate is asked here as well as drawn on the screen, because a disabled
 * button is not a rule. It is the same `gateTo` the server action refuses on,
 * so a move this allows is a move the office allows, in the same words.
 */
export async function advanceStage(
  id: string,
  to: LeadStage,
  args?: { note?: string | null },
): Promise<LeadResult<null>> {
  const lead = await getLead(id);
  if (!lead) return { ok: false, message: 'That lead is no longer on this phone.' };

  const input = await leadGateInput(lead);
  const verdict = gateTo(input, to);
  if (!verdict.open) {
    return {
      ok: false,
      message:
        'Not yet — ' + verdict.missing.map((c) => c.says.toLowerCase()).join('; ') + '.',
    };
  }

  const today = isoDate(new Date());
  const salesType = salesTypeOf(lead);
  const notes = notesOf(lead);
  const said = args?.note?.trim();
  if (said) notes.push({ at: Date.now(), text: stageLabel(to) + ' — ' + said });

  await updateAndQueue({
    table: 'leads',
    entityType: 'lead',
    id,
    patch: {
      funnelStage: to,
      stage: legacyStageFor(to, salesType),
      stageSince: today,
      notes,
      lastActivityDate: today,
    },
    payloadExtras: {
      stage: wireFunnelStage(to),
      notes: wireNotes(notes),
    },
  });

  await addEvent({
    leadId: id,
    kind: 'stage',
    summary: 'Moved to ' + stageLabel(to),
    detail: said || null,
    fromStage: input.stage,
    toStage: to,
  });
  return ok;
}

/**
 * §26 — lost, with a code rather than a sentence.
 *
 * The sentence stays and is optional; what is required is the code, because
 * "how many did we lose on credit terms this quarter" is a question the free
 * text could never answer and everybody typed "not interested" into anyway.
 */
export async function markLost(
  id: string,
  reasonCode: string,
  note?: string | null,
): Promise<LeadResult<null>> {
  const said = note?.trim() || null;
  /* A code OR a sentence — see `decideSuspect` above for why both are accepted
     and why neither is. The code is still what gets counted; the sentence is
     what a lost lead is left with where the office has configured no codes. */
  if (!reasonCode && !said) {
    return { ok: false, message: 'Say why — nobody rings this shop again after this.' };
  }
  const lead = await getLead(id);
  if (!lead) return { ok: false, message: 'That lead is no longer on this phone.' };

  const today = isoDate(new Date());
  const notes = notesOf(lead);
  notes.push({ at: Date.now(), text: 'Lost — ' + [reasonCode, said].filter(Boolean).join(' · ') });

  await updateAndQueue({
    table: 'leads',
    entityType: 'lead',
    id,
    patch: {
      funnelStage: 'lost',
      stage: 'Lost',
      stageSince: today,
      lostReasonCode: reasonCode || lead.lostReasonCode,
      lostReason: said ?? reasonCode,
      notes,
      lastActivityDate: today,
    },
    payloadExtras: {
      stage: 'lost',
      lostReason: said ?? reasonCode,
      notes: wireNotes(notes),
      reasonCode: reasonCode || undefined,
    },
  });

  await addEvent({
    leadId: id,
    kind: 'lost',
    summary: 'Lost',
    detail: said ?? reasonCode,
    fromStage: stageOf(lead),
    toStage: 'lost',
  });
  return ok;
}

/**
 * §— ON HOLD IS A PAUSE, AND THE PHONE COULD NOT EVEN ASK FOR ONE.
 *
 * `on_hold` has been on the wire, in the gate engine and on the record's own
 * badge since the funnel shipped, and every route into it went through a desk
 * or through a visit's suspect decision: a salesman standing in a shop being
 * told the plant is shut for two months could mark the lead LOST, which is
 * wrong and irreversible in the reader's mind, or leave it alone and let the
 * staleness sweep archive a live prospect. The record screen could READ a park
 * and offer to end one. Nothing on it could start one.
 *
 * So this asks the three things Mahek asked for, and all three are required
 * for the same reason §24 demands a next action: a park with no end date is
 * the exact state it exists to prevent — "back after Diwali" is a sentence
 * nobody is watching, and a lead carrying one sits until somebody happens to
 * scroll past it.
 *
 *   - the CODE, from `leads.holdReasons`, because four of the six are the
 *     customer's doing and two are ours to chase, and that split is the whole
 *     value of counting them. `other` costs a sentence: a code meaning
 *     "something else" with nothing behind it is the one row nobody can act on.
 *   - the DAY it comes back, which is the difference between a pause and a
 *     quiet death.
 *   - WHAT HAPPENS when it does, and who is doing it — because a lead that
 *     comes back to nobody has not come back.
 *
 * It writes `funnelStage` and not only `stage`. `stageOf` reads `funnelStage`
 * first for any lead carrying a sales type, so a park written into the legacy
 * column alone would leave the record reading Negotiation, the gate offering
 * the next rung, and the parked card never drawn — the lead would be on hold
 * in the office and nowhere on the phone. The legacy column takes `On hold`
 * rather than `legacyStageFor('on_hold', …)`, which answers `New`: a park
 * DISPLACES the rung rather than lowering it, `bandOf` returns null for
 * exactly that reason, and filing a parked Negotiation lead under New would be
 * a guess printed on a chip. `On hold` is a chip the list already has.
 *
 * TODO(schema): the handset's `leads` table has `holdReason` and no
 * `holdReasonCode` or `holdResumeDate` — both exist on the office side
 * (`0151`) and neither has a column here or a place on the pull. So the CODE
 * travels up and is not kept down here, and the local sentence carries the
 * picked reason's LABEL where the salesman wrote no remark of his own. That is
 * a sentence in a sentence column and not a label where a code belongs — the
 * countable answer goes to `lead_hold_reason_code` — but it does mean a park
 * made on this phone reads back in the words the list used ON THE DAY, and a
 * park made at a desk arrives with no code the phone can resolve at all. The
 * resume date rides `nextFollowUpDate`, which is the honest half of the trade:
 * see below.
 */
export async function putOnHold(
  id: string,
  hold: {
    reasonCode: string;
    note?: string | null;
    resumeDate: string;
    next: { action: string; date: string; ownerId: string; outcome?: string | null };
  },
): Promise<LeadResult<null>> {
  const lead = await getLead(id);
  if (!lead) return { ok: false, message: 'That lead is no longer on this phone.' };

  const said = hold.note?.trim() || null;
  const code = hold.reasonCode.trim();
  const { holdReasons } = await funnelConfig();

  /* Checked here as well as in the sheet, because a sheet is a screen and this
     is the function every caller reaches — the same reason the server checks
     it again after both of them. */
  if (!code) return { ok: false, message: 'Pick why it is stopping — it is what gets counted afterwards.' };
  if (code === REASON_CODE_NEEDING_REMARKS && !said) {
    return { ok: false, message: 'You picked Other — say in words what it actually is.' };
  }
  if (!hold.resumeDate) return { ok: false, message: 'Name the day it comes back.' };
  if (!hold.next.action.trim() || !hold.next.date || !hold.next.ownerId) {
    return { ok: false, message: 'Say what happens when it comes back, on what day, and who is doing it.' };
  }

  const today = isoDate(new Date());
  const from = stageOf(lead);
  /* The sentence the record reads back. The remark where he wrote one, and the
     list's own words where he did not — see the TODO above for why this column
     carries words rather than the code. */
  const sentence = said ?? labelOf(holdReasons, code);
  const notes = notesOf(lead);
  notes.push({ at: Date.now(), text: 'On hold until ' + hold.resumeDate + ' — ' + sentence });

  await updateAndQueue({
    table: 'leads',
    entityType: 'lead',
    id,
    patch: {
      funnelStage: 'on_hold',
      /* Not `legacyStageFor` — see the header. */
      stage: 'On hold',
      stageSince: today,
      holdReason: sentence,
      notes,
      nextAction: hold.next.action.trim(),
      nextActionDate: hold.next.date,
      nextActionOwnerId: hold.next.ownerId,
      nextActionOutcome: hold.next.outcome?.trim() || null,
      /*
       * THE RESUME DATE IS THE DIARY DATE, and that is deliberate rather than
       * a shortcut around the missing column.
       *
       * `setNextAction` already makes these one date and says why: two dates
       * meaning almost the same thing disagreed on every lead where somebody
       * set one and not the other. A park is the case where the distinction
       * would bite hardest — a lead parked until the 20th whose diary still
       * says the 3rd is a lead the list surfaces for a fortnight of mornings
       * on which nothing can be done about it, which is how a salesman learns
       * to ignore the list.
       *
       * It is the RESUME date and not the action's, where the salesman moved
       * the action later: `listLeads` orders on this column and `leadAlert`
       * measures lateness from it, so this is the one thing that brings a
       * parked lead back to him on the day the park ends. The office's own
       * resume worklist is fed by `lead_hold_resume_date`, sent below.
       */
      nextFollowUpDate: hold.resumeDate,
      lastActivityDate: today,
    },
    payloadExtras: {
      stage: wireFunnelStage('on_hold'),
      /* The code is what gets counted; the sentence is what gets read. The
         server writes the first to `lead_hold_reason_code` and the second to
         `lead_hold_reason`, and accepts the park on either — an older build
         sends no code at all and a park refused for want of one would be a
         plant shutdown lost to an argument about a word. */
      reasonCode: code,
      holdReason: sentence,
      holdResumeDate: hold.resumeDate,
      notes: wireNotes(notes),
      /* THREE LOCAL COLUMNS, ONE WIRE FIELD — `nextAction` is a string here
         and an object on `leadSchema`, and sending the string would fail
         validation and take the park down with it. */
      nextAction: {
        action: hold.next.action.trim(),
        date: hold.next.date,
        ownerId: hold.next.ownerId,
        outcome: hold.next.outcome?.trim() || undefined,
      },
    },
  });

  await addEvent({
    leadId: id,
    kind: 'hold',
    summary: 'On hold — ' + labelOf(holdReasons, code),
    detail: [said, 'Back on ' + hold.resumeDate].filter(Boolean).join(' · '),
    fromStage: from,
    toStage: 'on_hold',
  });
  return ok;
}

/**
 * §23 — who invoices this shop, and who at the distributor calls on it.
 *
 * The mark and the distributor are written TOGETHER, exactly as
 * `convertToThirdParty` does in the CRM: a shop marked as somebody else's to
 * bill with nobody named is a record taken off every list with nobody left to
 * ask about it. The distributor's own salesman has no MahekOne login and never
 * will, so a name is a real answer here and an id is only sometimes available.
 */
export async function setLeadParties(
  id: string,
  parties: {
    thirdParty: boolean;
    distributorCustomerId?: string | null;
    distributorName?: string | null;
    distributorSalesmanId?: string | null;
    distributorSalesmanName?: string | null;
  },
): Promise<LeadResult<null>> {
  if (parties.thirdParty && !parties.distributorCustomerId) {
    return { ok: false, message: 'Say which distributor invoices this shop.' };
  }

  const today = isoDate(new Date());
  await updateAndQueue({
    table: 'leads',
    entityType: 'lead',
    id,
    patch: {
      thirdParty: parties.thirdParty,
      distributorCustomerId: parties.distributorCustomerId ?? null,
      distributorName: parties.distributorName ?? null,
      distributorSalesmanId: parties.distributorSalesmanId ?? null,
      distributorSalesmanName: parties.distributorSalesmanName ?? null,
      lastActivityDate: today,
    },
    /* TODO(integration): none of the four is on `leadSchema`, so they travel
       and are stripped. The name is sent beside the id deliberately for when
       it does land — most of these people have no row anywhere yet, and
       `createDistributorSalesman` is the office's to run. */
  });

  await addEvent({
    leadId: id,
    kind: 'parties',
    summary: parties.thirdParty
      ? 'Billed by ' + (parties.distributorName ?? 'a distributor')
      : 'We invoice this shop ourselves',
    detail: parties.distributorSalesmanName ?? null,
  });
  return ok;
}

/**
 * §18 — what they said when somebody asked for the order.
 *
 * A date and, where they gave one, a figure. "Interested" is not an answer and
 * there is nowhere on this form to type it.
 */
/**
 * §5.5 §9 — THE COMMITMENT: a day, a size, and what is stopping it.
 *
 * IT IS A FORECAST AND NOT A SALE, and that is the whole shape of it: nothing
 * here moves the lead a rung. §9 says so in as many words and it is the right
 * rule — a salesman writing down what a shopkeeper said over a counter has not
 * been given an order, and a screen that advanced the ladder on his say-so
 * would put "First order" against a shop that has bought nothing. What the
 * date DOES do is open the gate in front of `first_order`, which still wants an
 * actual order behind it before it will let the lead through. The card and this
 * function both say that in words rather than leaving it to be discovered.
 *
 * A COMMITMENT NEEDS A DATE AND A QUANTITY, which is Mahek's own answer and
 * overrules §9 where the two differ. "They will order some time next week" is
 * not a commitment anybody can plan a godown around, and a promise with no size
 * on it cannot be compared against the order that eventually answers it.
 *
 * THE QUANTITY IS IN CANS, and this is the one place §L's argument for litres
 * does NOT apply. That argument is about CAPTURE: a prospect says "about two
 * hundred litres a month" long before anybody knows what pack they will buy it
 * in, so cans would be a unit nobody had agreed the size of. By the time a lead
 * is being asked for a first order it has been through qualification, which
 * demands `requiredProductId` — there IS a SKU, and the pack size with it. Cans
 * are what the customer says when ordering and what every order in MahekOne is
 * stored in, so a commitment in litres could not be held against the order that
 * answers it without a conversion nobody performed. The screen shows the SKU
 * beside the box so the unit is never ambiguous.
 *
 * THE VALUE IS OPTIONAL and the quantity is not. `products.priceSource` is
 * still `unset`, so nothing here can derive what a number of cans is worth; a
 * rupee figure on this record is somebody's estimate and a figure nobody
 * estimated must read as absent rather than as zero.
 *
 * THE BLOCKER IS A CODE, from the configured list — the same rule as a lost
 * lead, a park and a prospect. It defaults to `no_blocker` at the screen, and
 * that is a real answer rather than an empty field: a commitment nobody was
 * asked about and one somebody said was clear are different facts.
 */
export async function recordExpectedOrder(
  id: string,
  args: {
    expectedDate: string;
    expectedQuantityCans: number;
    expectedValuePaise?: number | null;
    blockerCode?: string | null;
  },
): Promise<LeadResult<null>> {
  if (!args.expectedDate) return { ok: false, message: 'Ask when they will place it.' };
  if (!args.expectedQuantityCans || args.expectedQuantityCans <= 0) {
    return { ok: false, message: 'Ask how many cans. A promise with no size on it cannot be planned around.' };
  }
  const today = isoDate(new Date());
  const blocker = args.blockerCode?.trim() || 'no_blocker';

  /* The two the office can hold go in the patch; the two it cannot are
     remembered first, so a commitment is never half-recorded on this phone if
     the write below throws. */
  await rememberCommitmentExtras(id, { quantityCans: args.expectedQuantityCans, blockerCode: blocker });

  await updateAndQueue({
    table: 'leads',
    entityType: 'lead',
    id,
    patch: {
      expectedOrderDate: args.expectedDate,
      expectedOrderValuePaise: args.expectedValuePaise ?? null,
      lastActivityDate: today,
    },
    /* AND THE OTHER TWO ARE DELIBERATELY NOT SENT.
       The obvious move is to put them on the payload anyway, on the reasoning
       that an unnamed field is stripped and costs nothing until the schema
       grows one. `mbos-payload-contract.test.ts` refuses exactly that, and it
       is right: a field zod strips leaves no refusal, no log and no rejection
       row, so the salesman types the size in, the app says saved, and the
       column stays null for ever. A field this app sends is a field the office
       has promised to hold. Until `leadSchema` names these two, the honest
       answer is that the phone holds them and says so, and the sentence in the
       header above is what makes the gap findable. */
  });

  await addEvent({
    leadId: id,
    kind: 'expected_order',
    summary: plural(args.expectedQuantityCans, 'can') + ' expected ' + args.expectedDate,
    detail: blocker === 'no_blocker' ? null : 'Blocked on ' + labelOf(ORDER_BLOCKERS, blocker),
  });
  return ok;
}

/* ------------------------------------------- the half with nowhere to land
 *
 * `expectedOrderQuantityCans` and `expectedOrderBlockerCode` have no column on
 * this phone and no field on `leadSchema`, and the two absences want opposite
 * treatment. The wire's is easy and the answer is to say NOTHING: a field
 * `leadSchema` does not declare is stripped by zod in silence, and
 * `mbos-payload-contract.test.ts` refuses one for exactly that reason — there
 * is no refusal, no log and no rejection row, so a salesman types the size in,
 * the app says saved, and the column stays null for ever. A field this app
 * sends is one the office has promised to hold.
 *
 * The local one is harder. A column would be the honest home; what must not
 * happen meanwhile is the
 * quantity being folded into the lead's note to make it visible today, because
 * a number inside a sentence is a number nobody can count and one that cannot
 * be deduplicated against the real column when it lands — the office would end
 * up holding one commitment twice. So it waits in `kv`, which no sync touches,
 * exactly as `rememberFieldChecks` does one screen along and for the same
 * reason. The day the column lands, this reads from the row instead and the
 * key is dropped — there is nothing to migrate, because a commitment is
 * restated rather than accumulated and the office already holds the date.
 *
 * REPLACED RATHER THAN APPENDED, unlike the field checks: a commitment is
 * RESTATED when the customer changes his mind, and the previous answer is not a
 * second commitment. The timeline above is where the history of it lives.
 */

export type CommitmentExtras = { quantityCans: number; blockerCode: string };

const COMMITMENT_KEY = (leadId: string) => `lead.commitment.${leadId}`;

export async function commitmentExtras(leadId: string): Promise<CommitmentExtras | null> {
  const raw = await getKv(COMMITMENT_KEY(leadId));
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const row = parsed as Partial<CommitmentExtras>;
    return typeof row.quantityCans === 'number'
      ? { quantityCans: row.quantityCans, blockerCode: row.blockerCode ?? 'no_blocker' }
      : null;
  } catch {
    /* A string that will not parse is a row nobody can act on. Answering with
       nothing lets the next save write a good one; throwing here would take the
       record page down over a cache. */
    return null;
  }
}

/**
 * Written before the lead is queued, and it can never fail the commitment.
 *
 * A save on this app is never refused for want of signal and it must not be
 * refused for want of a local write either — a swallowed failure here costs
 * the size and the blocker, and never the date, which is the half the gate
 * actually reads.
 */
async function rememberCommitmentExtras(leadId: string, extras: CommitmentExtras): Promise<void> {
  try {
    await setKv(COMMITMENT_KEY(leadId), JSON.stringify(extras));
  } catch {
    /* Deliberately swallowed — see above. */
  }
}

/* -------------------------------------------------------- the shops we bill
 *
 * A distributor is an unmarked account we invoice — the CRM's own rule, and
 * the picker obeys it rather than offering the whole book. The handset's
 * `customers` table holds only accounts, so everything in it qualifies; what
 * it cannot do is offer a lead, which is exactly right.
 */
export async function distributorCandidates(query: string): Promise<{ id: string; name: string; city: string | null }[]> {
  const q = `%${query.trim()}%`;
  return all<{ id: string; name: string; city: string | null }>(
    `SELECT id, name, city FROM customers
      WHERE (? = '%%' OR name LIKE ? OR city LIKE ?)
      ORDER BY name LIMIT 30`,
    [q, q, q],
  );
}
