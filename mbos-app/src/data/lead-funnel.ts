import { all, newId, one, run } from '../db';
import { getConfig } from './config';
import { getLead, notesOf, type Lead, type LeadResult } from './leads';
import { updateAndQueue } from './write';
import { isoDate } from '../lib/format';
import { legacyStageFor, stageOf, wireFunnelStage, wireNotes } from '../lib/wire';
import {
  gateForNext,
  gateTo,
  mustDecideSuspect,
  nextStage,
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
 * TODO(integration): four things this file records have no home on that schema
 * yet and are stripped by zod on arrival — `distributorProfile` (§11's thirty),
 * `thirdParty` with its distributor and that distributor's own salesman (§23),
 * and `expectedOrderDate`/`expectedOrderValuePaise` (§18). Workstream A owns
 * `leadSchema`; workstream B owns `saveDistributorProfile` and the third-party
 * link. Until they land the handset's own record is complete and the office
 * hears nothing about them — nothing is refused, which is the safe direction
 * and the silent one.
 */

/* ------------------------------------------------------------- the config */

export type FunnelConfig = {
  suspectMaxVisits: number;
  requireNextAction: boolean;
  prospectReasons: CodedOption[];
  sampleReasons: CodedOption[];
  lostReasons: CodedOption[];
};

/**
 * The four coded lists and the suspect window, fetched together.
 *
 * Together rather than five deep, because every screen in the funnel needs at
 * least two of them and a form that renders its options one await at a time
 * flickers its way onto the screen while somebody is standing in a shop.
 */
export async function funnelConfig(): Promise<FunnelConfig> {
  const [suspectMaxVisits, requireNextAction, prospectReasons, sampleReasons, lostReasons] =
    await Promise.all([
      getConfig<number>('leads.suspectMaxVisits'),
      getConfig<boolean>('leads.requireNextAction'),
      getConfig<CodedOption[]>('leads.prospectReasons'),
      getConfig<CodedOption[]>('leads.sampleReasons'),
      getConfig<CodedOption[]>('leads.lostReasons'),
    ]);
  return { suspectMaxVisits, requireNextAction, prospectReasons, sampleReasons, lostReasons };
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
  const [visits, sample] = await Promise.all([
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
  ]);

  return {
    salesType: salesTypeOf(lead),
    stage: stageOf(lead),

    customerType: lead.customerType,
    monthlyLitres: lead.monthlyLitres,
    potentialPaise: lead.estimatedPotentialPaise,
    competitor: lead.competitor,
    requiredProductId: lead.requiredProductId,
    contactPerson: lead.contactPerson,
    decisionMaker: lead.decisionMaker,
    creditDaysWanted: lead.creditDaysWanted,
    application: lead.application,
    gstin: lead.gstin,

    nextAction: lead.nextAction,
    nextActionDate: lead.nextActionDate,
    nextActionOwnerId: lead.nextActionOwnerId,

    qualification: qualificationOf(lead),

    suspectVisitCount: visits,
    suspectDecidedAt: lead.suspectDecidedAt ? new Date(lead.suspectDecidedAt) : null,
    prospectReasonRecorded: Boolean(lead.prospectReasonCode),
    verifiedAt: lead.verifiedAt ? new Date(lead.verifiedAt) : null,

    thirdParty: Boolean(lead.thirdParty),
    distributorCount: lead.distributorCustomerId ? 1 : 0,

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

    expectedOrderDate: lead.expectedOrderDate,
  };
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
  return {
    lead,
    input,
    salesType,
    stage,
    next: nextStage(stage, salesType),
    gate: gateForNext(input),
    mustDecide: mustDecideSuspect(input, config.suspectMaxVisits),
    visits,
    config,
  };
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
  if (!decision.reasonCode) {
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
      suspectReasonCode: decision.reasonCode,
      prospectReasonCode: decision.prospect ? decision.reasonCode : lead.prospectReasonCode,
      lostReasonCode: decision.prospect ? lead.lostReasonCode : decision.reasonCode,
      lostReason: decision.prospect ? lead.lostReason : (decision.note?.trim() || decision.reasonCode),
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
      lostReason: decision.prospect ? undefined : (decision.note?.trim() || decision.reasonCode),
      /* The CODE, whichever way the answer went — why it is worth pursuing,
         or why it is not. One field, because the schema keeps one: what it
         means is read off the stage that arrived with it. */
      reasonCode: decision.reasonCode,
    },
  });

  await addEvent({
    leadId: id,
    kind: 'suspect_decision',
    summary: decision.prospect ? 'Worth pursuing — now a Prospect' : 'Not a prospect',
    detail: decision.note?.trim() || decision.reasonCode,
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
  if (!reasonCode) {
    return { ok: false, message: 'Pick a reason — nobody rings this shop again after this.' };
  }
  const lead = await getLead(id);
  if (!lead) return { ok: false, message: 'That lead is no longer on this phone.' };

  const today = isoDate(new Date());
  const said = note?.trim() || null;
  const notes = notesOf(lead);
  notes.push({ at: Date.now(), text: 'Lost — ' + reasonCode + (said ? ' · ' + said : '') });

  await updateAndQueue({
    table: 'leads',
    entityType: 'lead',
    id,
    patch: {
      funnelStage: 'lost',
      stage: 'Lost',
      stageSince: today,
      lostReasonCode: reasonCode,
      lostReason: said ?? reasonCode,
      notes,
      lastActivityDate: today,
    },
    payloadExtras: {
      stage: 'lost',
      lostReason: said ?? reasonCode,
      notes: wireNotes(notes),
      reasonCode,
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
export async function recordExpectedOrder(
  id: string,
  args: { expectedDate: string; expectedValuePaise?: number | null },
): Promise<LeadResult<null>> {
  if (!args.expectedDate) return { ok: false, message: 'Ask when they will place it.' };
  const today = isoDate(new Date());

  await updateAndQueue({
    table: 'leads',
    entityType: 'lead',
    id,
    patch: {
      expectedOrderDate: args.expectedDate,
      expectedOrderValuePaise: args.expectedValuePaise ?? null,
      lastActivityDate: today,
    },
    /* TODO(integration): §18's two columns are not on `leadSchema` yet. The
       gate in front of `first_order` reads `expectedOrderDate`, so until they
       land a lead can pass that rung on the phone and be refused at the
       office — which is the right way round, and it is written down here so
       nobody is surprised by it. */
  });

  await addEvent({
    leadId: id,
    kind: 'expected_order',
    summary: 'Order expected ' + args.expectedDate,
  });
  return ok;
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
