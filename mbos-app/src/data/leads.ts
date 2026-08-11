import { all, newId, one, run, tx } from '../db';
import { enqueue } from '../sync/queue';
import { insertAndQueue, insertLocal, stamp, updateAndQueue } from './write';
import { getConfig } from './config';
import { isoDate } from '../lib/format';
import {
  matchDuplicate,
  normaliseMobile,
  stageRefusal,
  followUpRefusal,
  type DuplicateMatch,
  type LeadFilter,
  type LeadThresholds,
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
  clientCreatedAt: number;
  syncState: string;
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
export async function listLeads(filter: LeadFilter = 'All'): Promise<Lead[]> {
  const order = `ORDER BY nextFollowUpDate IS NULL, nextFollowUpDate ASC, lastActivityDate ASC, name`;

  if (filter === 'Archived') {
    return all<Lead>(`SELECT * FROM leads WHERE archived = 1 ${order}`);
  }
  if (filter === 'All') {
    return all<Lead>(`SELECT * FROM leads WHERE archived = 0 ${order}`);
  }
  return all<Lead>(`SELECT * FROM leads WHERE archived = 0 AND stage = ? ${order}`, [filter]);
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
  today?: string;
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
  const notes: LeadNote[] = args.note?.trim() ? [{ at: Date.now(), text: args.note.trim() }] : [];

  const id = await insertAndQueue({
    table: 'leads',
    entityType: 'lead',
    row: {
      ...base,
      name: args.name.trim(),
      company: args.company?.trim() || null,
      mobile: mobile || null,
      city: args.city?.trim() || null,
      source: args.source ?? null,
      estimatedPotentialPaise: args.estimatedPotentialPaise ?? null,
      assigneeId: args.assigneeId ?? null,
      stage: 'New',
      nextFollowUpDate: args.nextFollowUpDate ?? null,
      notes,
      archived: 0,
      /* Staleness is measured from here, so it starts today rather than null —
         a lead created this morning has not gone quiet. */
      lastActivityDate: today,
    },
  });

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
    payload: { id: lead.id, stage: 'Converted', convertedCustomerId: customerId, lastActivityDate: today },
    dependsOn: [customerId],
  });

  return { ok: true, value: customerId };
}
