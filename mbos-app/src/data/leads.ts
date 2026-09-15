import { all, newId, one, run, tx } from '../db';
import { enqueue } from '../sync/queue';
import { insertAndQueue, insertLocal, stamp, updateAndQueue } from './write';
import { getConfig } from './config';
import { isoDate } from '../lib/format';
import { wireNotes, wireSource, wireStage } from '../lib/wire';
import {
  matchDuplicate,
  normaliseMobile,
  stageRefusal,
  followUpRefusal,
  type DuplicateMatch,
  type LeadFilter,
  type LeadThresholds,
  type VisitCapThresholds,
} from '../engines/leads';

/**
 * Leads — a shop that is not yet on the book.
 *
 * Two things make this module more than a list. The first is that a lead is
 * never deleted: Lost and Archived are both states it keeps sitting in, because
 * a shop that said no in March is exactly who somebody wants to find in
 * September. The second is the duplicate check, which reads customers as well
 * as leads — the number a salesman is about to type is quite often already
 * somebody's account, and the answer to that is to open the record rather than
 * refuse the save and leave him with nowhere to go.
 */

export type Lead = {
  id: string;
  name: string;
  company: string | null;
  mobile: string | null;
  city: string | null;
  source: string | null;
  estimatedPotentialPaise: number | null;
  assigneeId: string | null;
  stage: string;
  nextFollowUpDate: string | null;
  /** A JSON array of `{ at, text }`, oldest first. Appended, never replaced. */
  notes: string | null;
  convertedCustomerId: string | null;
  lostReason: string | null;
  archived: number;
  lastActivityDate: string | null;
  /**
   * Where the shop is. The server has sent these on every pull since leads
   * existed; this table had no columns for them until v13, so `upsert` dropped
   * both on arrival and every lead on every handset had a null place.
   */
  gpsLat: number | null;
  gpsLng: number | null;
  /**
   * Who runs the conversion once the lead is qualified. Information, not
   * ownership — the lead is still this salesman's to visit. The name is sent
   * with the id because the handset holds no user table to resolve one.
   */
  leadManagerId: string | null;
  leadManagerName: string | null;
  /* §A and §C — what he learns in the shop. See the v14 migration for why
     consumption is in litres and not in cans. */
  address: string | null;
  customerType: string | null;
  gstin: string | null;
  requirement: string | null;
  monthlyVolumeLitres: number | null;
  decisionMaker: string | null;
  shopPhotoId: string | null;
  competitorName: string | null;
  /** As the office counts it. `visitsHere()` adds what has not synced yet. */
  visitCount: number;
  /** Why it is not moving. Set for On hold, and for a Suspect kept past the cap. */
  holdReason: string | null;
  clientCreatedAt: number;
  syncState: string;

  /* ---------------------------------------------------------- the funnel
   *
   * Every one of these is a column on the row this app already had, so a lead
   * raised before the funnel existed reads back with them null — and null on
   * `salesType` is what `ladderFor()` calls the LEGACY ladder, which is the
   * six rungs this app shipped with. That is the whole reason the funnel could
   * land without a migration that moves rows: an old lead goes on climbing
   * exactly what it was climbing.
   *
   * `stage` above and `funnelStage` here are kept in step by `legacyStageFor`.
   * See the v13 migration for why there are two.
   */
  salesType: string | null;
  funnelStage: string | null;
  stageSince: string | null;

  /* `customerType`, `decisionMaker` and `gstin` are the same three facts the
     capture form above already declares, under exactly those names — one
     column each, not two. `monthlyLitres` and `competitor` are NOT: they are
     the wire's own words for what the office holds, and `openLeads` sends
     them under these names while the capture form writes the two beside them.
     See the funnel migration for why both pairs of columns are on the row. */
  monthlyLitres: number | null;
  competitor: string | null;
  requiredProductId: string | null;
  requiredProductName: string | null;
  contactPerson: string | null;
  creditDaysWanted: number | null;
  application: string | null;
  prospectReasonCode: string | null;

  /** JSON, keyed by condition id. Read as a whole by the gate engine. */
  qualification: string | null;
  distributorProfile: string | null;

  nextAction: string | null;
  nextActionDate: string | null;
  nextActionOwnerId: string | null;
  nextActionOutcome: string | null;

  suspectDecidedAt: number | null;
  suspectIsProspect: number | null;
  suspectReasonCode: string | null;

  verifiedAt: number | null;

  thirdParty: number;
  distributorCustomerId: string | null;
  distributorName: string | null;
  distributorSalesmanId: string | null;
  distributorSalesmanName: string | null;

  expectedOrderDate: string | null;
  expectedOrderValuePaise: number | null;
  lostReasonCode: string | null;
};

export type LeadNote = { at: number; text: string };

export type LeadResult<T> = { ok: true; value: T } | { ok: false; message: string; duplicate?: DuplicateMatch };

/* ------------------------------------------------------------------ reads */

/**
 * The list, in the order the work should be done.
 *
 * A promised follow-up comes first and the ones with no date sit under them —
 * a lead nobody has promised anything is still a lead, and sorting it off the
 * bottom of the screen is how it stops existing.
 */
export async function listLeads(filter: LeadFilter = 'All', query = ''): Promise<Lead[]> {
  const order = `ORDER BY nextFollowUpDate IS NULL, nextFollowUpDate ASC, lastActivityDate ASC, name`;

  /*
   * The search runs in SQLite rather than over the rows already on the screen,
   * for the reason the customers list gives: eight stage chips are the only
   * narrowing this screen had, and finding one named shop in a few hundred
   * leads meant scrolling past all of them. It reaches the shop name, the
   * person, the number and the town, because that is whichever one he has been
   * given. The number is matched as typed AND stripped, so a lead stored as
   * `9822011001` is still found by somebody who types `98220 11001`.
   */
  const q = query.trim();
  const like = `%${q}%`;
  const digits = normaliseMobile(q);
  const search = q
    ? ` AND (name LIKE ? OR company LIKE ? OR city LIKE ? OR mobile LIKE ?${digits.length >= 4 ? ' OR mobile LIKE ?' : ''})`
    : '';
  const args = q
    ? digits.length >= 4
      ? [like, like, like, like, `%${digits}%`]
      : [like, like, like, like]
    : [];

  if (filter === 'Archived') {
    return all<Lead>(`SELECT * FROM leads WHERE archived = 1${search} ${order}`, args);
  }
  if (filter === 'All') {
    return all<Lead>(`SELECT * FROM leads WHERE archived = 0${search} ${order}`, args);
  }
  return all<Lead>(`SELECT * FROM leads WHERE archived = 0 AND stage = ?${search} ${order}`, [filter, ...args]);
}

export async function getLead(id: string): Promise<Lead | null> {
  return one<Lead>('SELECT * FROM leads WHERE id = ?', [id]);
}

/** Still being worked — what the More screen counts on its row. */
export async function openLeadCount(): Promise<number> {
  const row = await one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM leads WHERE archived = 0 AND stage NOT IN ('Converted','Lost')`,
  );
  return row?.n ?? 0;
}

export function notesOf(lead: Pick<Lead, 'notes'>): LeadNote[] {
  if (!lead.notes) return [];
  try {
    const parsed: unknown = JSON.parse(lead.notes);
    return Array.isArray(parsed) ? (parsed as LeadNote[]) : [];
  } catch {
    /* A lead written before notes were a list still has its sentence, and a
       note nobody can read back is a note that was never taken. */
    return [{ at: 0, text: lead.notes }];
  }
}

/** The three thresholds the screens read, fetched together rather than three deep. */
export async function leadThresholds(): Promise<LeadThresholds> {
  const [staleDays, archiveDays, escalateAfterDays] = await Promise.all([
    getConfig<number>('mbos.leads.staleDays'),
    getConfig<number>('mbos.leads.archiveDays'),
    getConfig<number>('mbos.leads.escalateAfterDays'),
  ]);
  return { staleDays, archiveDays, escalateAfterDays };
}

/**
 * The two numbers the visit cap is measured in.
 *
 * Configuration, and the SAME two the server checks `decide` against — which
 * is what lets the rule live in two runtimes without a shared module. They
 * arrive on every pull with the rest of the `mbos.*` keys, so an office that
 * changes them changes both ends at once.
 */
export async function visitCapThresholds(): Promise<VisitCapThresholds> {
  const [visitsBeforeDecision, maxSuspectVisits] = await Promise.all([
    getConfig<number>('mbos.leads.visitsBeforeDecision'),
    getConfig<number>('mbos.leads.maxSuspectVisits'),
  ]);
  return { visitsBeforeDecision, maxSuspectVisits };
}

/**
 * Visits to this shop, counting the ones still in the outbox.
 *
 * The server's count plus anything this handset has recorded and not yet sent.
 * Without the second half a salesman who made visit two offline would be shown
 * "Visit 1 / 3" and asked for no decision on visit three — the cap would fire
 * one visit late, every time the phone was out of signal, which is exactly when
 * he is in the field.
 */
export async function visitsHere(leadId: string, serverCount: number): Promise<number> {
  const rows = await all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM visits WHERE customerId = ? AND syncState <> 'synced'`,
    [leadId],
  );
  return serverCount + Number(rows[0]?.n ?? 0);
}

/**
 * Is this shop still a Suspect, and how many times have we been?
 *
 * Null for anything that is not a lead — which is most of the book, and the
 * answer the visit screen wants: a real customer is never asked to justify a
 * visit. A lead IS a `customers` row, so the visit screen holds the customer
 * and has to come here for the half that lives on the lead.
 *
 * The count is the office's plus whatever this handset has not managed to send,
 * because a salesman who made visit two in a market with no signal must still
 * be asked for a decision on visit three.
 */
export async function suspectFor(
  customerId: string,
): Promise<{ stage: string; visits: number } | null> {
  const row = await one<{ stage: string; visitCount: number }>(
    'SELECT stage, visitCount FROM leads WHERE id = ? AND archived = 0',
    [customerId],
  );
  if (!row) return null;
  return { stage: row.stage, visits: await visitsHere(customerId, row.visitCount ?? 0) };
}

/* ------------------------------------------------------------- duplicates */

/**
 * Whoever already has this number, customer or lead.
 *
 * Both books are read here rather than in the screen, so the answer is the
 * same whether it was asked before a save or by somebody checking. The
 * comparison is on the normalised number, because the same shop is written
 * three ways by three people and none of the strings match.
 */
export async function findDuplicate(mobile: string, exceptLeadId?: string): Promise<DuplicateMatch | null> {
  const wanted = normaliseMobile(mobile);
  if (wanted.length < 10) return null;

  const [customers, leads] = await Promise.all([
    all<{ id: string; name: string; phone: string | null }>(
      'SELECT id, name, phone FROM customers WHERE phone IS NOT NULL',
    ),
    all<{ id: string; name: string; mobile: string | null }>(
      'SELECT id, name, mobile FROM leads WHERE mobile IS NOT NULL',
    ),
  ]);

  return matchDuplicate(wanted, customers, leads.filter((l) => l.id !== exceptLeadId));
}

/* ----------------------------------------------------------------- writes */

export async function createLead(args: {
  name: string;
  company?: string | null;
  mobile: string;
  city?: string | null;
  source?: string | null;
  estimatedPotentialPaise?: number | null;
  assigneeId?: string | null;
  nextFollowUpDate?: string | null;
  note?: string | null;
  /* §A. All optional: a salesman who has a name and a number outside a closed
     shop must still be able to write the lead down. What he could not do
     before was come back and add the rest. */
  address?: string | null;
  customerType?: string | null;
  requirement?: string | null;
  monthlyVolumeLitres?: number | null;
  decisionMaker?: string | null;
  shopPhotoId?: string | null;
  competitorName?: string | null;
  today?: string;
  /**
   * §2 — which of the three ladders this lead climbs.
   *
   * Asked FIRST on the form, before a name is typed, because it decides what
   * the rest of the funnel asks: a distributor answers thirty questions and a
   * shop answers twelve, and finding that out after the fact means going round
   * again. Optional here and nowhere else — a lead raised by the office, or by
   * a build of this app older than the funnel, has none, and `ladderFor(null)`
   * is the six rungs that has always meant.
   */
  salesType?: string | null;
}): Promise<LeadResult<string>> {
  const today = args.today ?? isoDate(new Date());

  const late = followUpRefusal(args.nextFollowUpDate ?? null, today);
  if (late) return { ok: false, message: late };

  const mobile = normaliseMobile(args.mobile);
  const duplicate = await findDuplicate(mobile);
  if (duplicate) {
    return {
      ok: false,
      duplicate,
      message:
        duplicate.kind === 'customer'
          ? duplicate.name + ' already has this number — they are on your book.'
          : duplicate.name + ' is already a lead on this number.',
    };
  }

  const base = await stamp('lead');
  /*
   * The freshest fix already known, which is almost always one the day's trail
   * took minutes ago — so this costs no battery and, more importantly, no
   * TIME. `whereNow()` never waits on the radio: a salesman outside a shop with
   * the customer waiting must not watch a spinner while the GPS settles, and a
   * lead with no pin is far better than a lead nobody wrote down.
   */
  const { whereNow } = await import('../native/where');
  const fix = await whereNow().catch(() => null);
  const notes: LeadNote[] = args.note?.trim() ? [{ at: Date.now(), text: args.note.trim() }] : [];

  /* Bound the way a visit binds its photographs: the shop front is shot while
     the shop is in front of you, so it begins life under the parent `pending`
     and is claimed the moment the record it belongs to exists. The server
     binds its own copy too (`bindMbosMedia`) — this is what makes the UPLOAD
     carry the right parent rather than relying on the fix-up afterwards. */
  const id = await insertAndQueue({
    table: 'leads',
    entityType: 'lead',
    /* This table's columns and the wire's fields are not the same words —
       PROTOCOL.md §4.1. `company`, a capitalised stage and notes as a list are
       ours; MahekOne reads `companyName`, a lower-case stage and one string.
       Every lead a salesman created was refused on all three at once — and
       then went on being refused on the fourth, the source, which this pass
       missed. */
    payloadExtras: {
      companyName: args.company?.trim() || undefined,
      /* A lead on a ladder is raised onto its FOOT, which is `suspect` on all
         three of them; one with no sales type is raised onto `new`, which is
         the foot of the legacy ladder and what this app has always sent. */
      stage: args.salesType ? 'suspect' : 'new',
      notes: wireNotes(notes),
      /* §2 — which ladder, sent FLAT rather than nested. `leadCreateSchema`
         names `salesType` at the top level and `safeParse` strips whatever it
         does not name, without a word: wrapped in a `funnel` object this
         arrived as nothing at all, and the lead was raised on the legacy
         ladder with the salesman's answer lost between the two ends. */
      salesType: args.salesType ?? undefined,
      /* WHERE HE IS STANDING, which is the whole of the lead map.
         `enqueue` already attaches a position to the sync ITEM — that records
         where the act happened. This is different and both are wanted: this is
         where the SHOP is, and it goes on the customer row, where a pin is
         read from. A lead captured at the shop door has them equal; one typed
         up in the evening has an activity location and no shop pin, which is
         the honest answer rather than a guess. */
      gpsLat: fix?.lat ?? undefined,
      gpsLng: fix?.lng ?? undefined,
      address: args.address?.trim() || undefined,
      customerType: args.customerType ?? undefined,
      requirement: args.requirement?.trim() || undefined,
      monthlyVolumeLitres: args.monthlyVolumeLitres ?? undefined,
      decisionMaker: args.decisionMaker?.trim() || undefined,
      /* The fourth of the four, and the one that outlived the fix above: the
         source went out as the salesman's own word against an enum that only
         ever held codes, so every lead was still refused after the other three
         were mended. See `wireSource`. */
      source: wireSource(args.source),
    },
    row: {
      ...base,
      name: args.name.trim(),
      company: args.company?.trim() || null,
      mobile: mobile || null,
      city: args.city?.trim() || null,
      source: args.source ?? null,
      estimatedPotentialPaise: args.estimatedPotentialPaise ?? null,
      assigneeId: args.assigneeId ?? null,
      salesType: args.salesType ?? null,
      funnelStage: args.salesType ? 'suspect' : null,
      stageSince: today,
      /* The six-word column the chips and `leadAlert` read. A suspect is a
         lead nobody has been to see yet, which is what New has always meant
         here — `legacyStageFor` is what keeps the two in step from now on. */
      stage: 'New',
      nextFollowUpDate: args.nextFollowUpDate ?? null,
      notes,
      archived: 0,
      address: args.address?.trim() || null,
      customerType: args.customerType ?? null,
      gstin: null,
      requirement: args.requirement?.trim() || null,
      monthlyVolumeLitres: args.monthlyVolumeLitres ?? null,
      decisionMaker: args.decisionMaker?.trim() || null,
      shopPhotoId: args.shopPhotoId ?? null,
      competitorName: args.competitorName?.trim() || null,
      visitCount: 0,
      holdReason: null,
      gpsLat: fix?.lat ?? null,
      gpsLng: fix?.lng ?? null,
      leadManagerId: null,
      leadManagerName: null,
      /* Staleness is measured from here, so it starts today rather than null —
         a lead created this morning has not gone quiet. */
      lastActivityDate: today,
    },
  });

  if (args.shopPhotoId) {
    await run('UPDATE media_queue SET parentId = ? WHERE id = ?', [id, args.shopPhotoId]);
  }

  return { ok: true, value: id };
}

/**
 * Moving a lead along, or ending it.
 *
 * Lost asks why and everything else does not, which is the whole rule. The
 * activity date moves with it either way — a stage change is contact, and
 * staleness is measured from the last thing that happened.
 */
export async function setStage(
  id: string,
  stage: string,
  reason?: string | null,
  today = isoDate(new Date()),
): Promise<LeadResult<null>> {
  const refusal = stageRefusal(stage, reason);
  if (refusal) return { ok: false, message: refusal };

  const lead = await getLead(id);
  if (!lead) return { ok: false, message: 'That lead is no longer on this phone.' };

  const notes = notesOf(lead);
  const said = reason?.trim();
  if (said) notes.push({ at: Date.now(), text: stage + ' — ' + said });

  await updateAndQueue({
    table: 'leads',
    entityType: 'lead',
    id,
    patch: {
      stage,
      lostReason: stage === 'Lost' ? (said ?? null) : lead.lostReason,
      notes,
      lastActivityDate: today,
    },
    payloadExtras: { stage: wireStage(stage), notes: wireNotes(notes) },
  });

  return { ok: true, value: null };
}

/** A sentence somebody typed about this shop. Appended; nothing overwrites. */
export async function addNote(id: string, text: string, today = isoDate(new Date())): Promise<LeadResult<null>> {
  const said = text.trim();
  if (!said) return { ok: false, message: 'Nothing to save yet.' };

  const lead = await getLead(id);
  if (!lead) return { ok: false, message: 'That lead is no longer on this phone.' };

  const notes = notesOf(lead);
  notes.push({ at: Date.now(), text: said });

  await updateAndQueue({
    table: 'leads',
    entityType: 'lead',
    id,
    patch: { notes, lastActivityDate: today },
    payloadExtras: { notes: wireNotes(notes) },
  });
  return { ok: true, value: null };
}

export async function setFollowUp(
  id: string,
  date: string,
  today = isoDate(new Date()),
): Promise<LeadResult<null>> {
  const late = followUpRefusal(date, today);
  if (late) return { ok: false, message: late };

  await updateAndQueue({
    table: 'leads',
    entityType: 'lead',
    id,
    patch: { nextFollowUpDate: date, lastActivityDate: today },
  });
  return { ok: true, value: null };
}

/**
 * Out of the way, not gone.
 *
 * Archiving is a filter on every read in this module, so the record keeps its
 * notes, its stage and its reason and comes back the moment somebody looks for
 * it. Nothing here deletes a row.
 */
export async function setArchived(id: string, archived: boolean, today = isoDate(new Date())): Promise<void> {
  await updateAndQueue({
    table: 'leads',
    entityType: 'lead',
    id,
    patch: { archived, lastActivityDate: today },
  });
}

/**
 * Bump the clock on a lead.
 *
 * Staleness, the archive prompt and the untouched-lead escalation are all
 * measured from `lastActivityDate`, so anything that counts as working the
 * lead has to move it. The stage and note paths call this for themselves;
 * this is for everything else — a call placed, a visit made.
 */
export async function touchLead(id: string, today = isoDate(new Date())): Promise<void> {
  await updateAndQueue({
    table: 'leads',
    entityType: 'lead',
    id,
    patch: { lastActivityDate: today },
  });
}

/* ---------------------------------------------------------------- convert */

/**
 * The lead becomes a customer, and stays a lead.
 *
 * The customer is written locally with a client id, which is what lets the
 * salesman punch an order against a shop that exists on nothing but this
 * handset. Its notes and its whole activity trail move onto the shared
 * timeline, because the story of how the account was won is worth more to
 * whoever inherits it than the lead row it was kept in.
 *
 * The lead is NOT deleted. It goes to `Converted`, keeps its history and
 * carries `convertedCustomerId` permanently — that link is the only thing that
 * can answer "where did this account come from" a year from now.
 *
 * Order matters on the way out: the customer depends on nothing, the lead's
 * update depends on the customer, so the office never sees a lead pointing at
 * an account that has not arrived.
 */
export async function convertToCustomer(
  lead: Lead,
  today = isoDate(new Date()),
): Promise<LeadResult<string>> {
  if (lead.convertedCustomerId) {
    return { ok: false, message: lead.name + ' was already converted. Open the customer instead.' };
  }

  const customerId = newId('customer');
  const notes = notesOf(lead);
  const now = Date.now();

  const customerRow = {
    id: customerId,
    name: lead.company?.trim() || lead.name,
    contactPerson: lead.name,
    phone: lead.mobile,
    city: lead.city,
    /* Health, credit and outstanding are the office's to decide. A new account
       arrives with none of them rather than with a confident zero. */
    lastSyncedAt: 0,
  };

  await tx(async () => {
    await insertLocal('customers', customerRow);

    await insertLocal('timeline_events', {
      id: newId('tl'),
      customerId,
      eventType: 'lead',
      sourceApp: 'mbos',
      sourceRecordId: lead.id,
      occurredAt: now,
      actor: 'You',
      summary:
        'Converted from a lead' + (lead.source ? ' · ' + lead.source : '') + (lead.city ? ' · ' + lead.city : ''),
    });

    /* The activity, oldest first, so the account opens on the conversation
       that won it rather than on an empty timeline. */
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      await insertLocal('timeline_events', {
        id: newId('tl'),
        customerId,
        eventType: 'lead',
        sourceApp: 'mbos',
        sourceRecordId: lead.id,
        occurredAt: n.at || now - (notes.length - i),
        actor: 'You',
        summary: n.text,
      });
    }

    await run(
      `UPDATE leads SET stage = 'Converted', convertedCustomerId = ?, lastActivityDate = ?, syncState = 'queued' WHERE id = ?`,
      [customerId, today, lead.id],
    );
  });

  await enqueue({
    entityType: 'customer',
    entityId: customerId,
    op: 'create',
    payload: { ...customerRow, fromLeadId: lead.id, estimatedPotentialPaise: lead.estimatedPotentialPaise },
  });

  await enqueue({
    entityType: 'lead',
    entityId: lead.id,
    op: 'update',
    payload: {
      id: lead.id,
      stage: wireStage('Converted'),
      convertedCustomerId: customerId,
      lastActivityDate: today,
    },
    dependsOn: [customerId],
  });

  return { ok: true, value: customerId };
}
