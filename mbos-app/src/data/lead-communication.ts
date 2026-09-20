import { all, newId, run } from '../db';
import { enqueue } from '../sync/queue';
import { COMMUNICATION_ACTIONS } from '../engines/funnel';

/**
 * §10.4 — the eleven ways of reaching out, on the phone that is standing in
 * the shop.
 *
 * `COMMUNICATION_ACTIONS` has been on this handset for as long as the funnel
 * has: `engines/funnel/lead-labels.ts` is a byte-for-byte mirror of the
 * server's own file, so the eleven were compiled into every APK. Nothing
 * imported them. That is the exported-with-no-caller shape AGENTS.md names —
 * legal TypeScript, clean lint, every test green, and no screen — and what it
 * cost is precise: a salesman could not send the current price list or log the
 * call against the lead in front of him, so he did both from a desk that
 * evening or not at all, and the record of a lead being WORKED was a record of
 * whatever somebody remembered later.
 *
 * Everything here reads the local store and writes the outbox, which is the
 * only shape that survives a market lane with one bar. The library is already
 * on the phone — `documents` is pulled reference data — so a send resolves its
 * own document with no server involved, and the tap itself is a queue row like
 * every other write.
 */

/**
 * The wire's word for one of these, matching a `case` in the server's
 * `dispatchItem`. It is spelled out at the `enqueue` below rather than passed
 * as this constant, because `src/lib/mbos-wire.test.ts` reads this project as
 * TEXT to check the two halves of the feature against each other — the server's
 * SQL is a string and this project is one its tsconfig excludes, so a literal
 * is the only spelling either side can see. Here it names the queue rows to
 * count, which is a read of our own table and not the contract.
 */
const ENTITY = 'lead_communication';

/** The event type both ends use on the shared timeline. */
const EVENT_TYPE = 'lead_communication';

export type CommunicationAction = (typeof COMMUNICATION_ACTIONS)[number];

export type CommunicationOption = {
  action: CommunicationAction;
  /**
   * What is published in this action's category, newest-first being a thing
   * the phone cannot answer — see `publishedFor` below. Empty on a `send`
   * means the button is disabled and says why.
   */
  documents: { id: string; title: string }[];
  /** How many times this action has gone out against this lead. */
  sent: number;
};

export type CommunicationLog = {
  options: CommunicationOption[];
  /**
   * Communications on this record that name none of the eleven.
   *
   * Rows written before the action code rode in the source id carry a bare id,
   * so they are reaching-out that genuinely happened and cannot be attributed.
   * Folding them into the nearest button would be inventing which; dropping
   * them would make the counts quietly undercount on exactly the oldest leads,
   * where the history matters most.
   */
  unattributed: number;
};

/**
 * WHAT IS PUBLISHED IN A CATEGORY, and why this is a LIST rather than "the
 * current one".
 *
 * The web resolves a send to the newest published document of its category.
 * The handset cannot: `visibleDocuments` sends id, title, category and the
 * attachment reference and no date at all, so "newest" is a question this
 * store has no column to answer. Picking one anyway — by title, by id — would
 * be a guess dressed up as a resolution, and the failure is silent: the shop
 * gets last quarter's price list and the record says the price list went.
 *
 * So where a category holds one document it is chosen for him, and where it
 * holds several he picks. He is the one who knows which brochure he showed.
 */
async function publishedFor(): Promise<Map<string, { id: string; title: string }[]>> {
  const rows = await all<{ id: string; title: string; category: string | null }>(
    `SELECT id, title, category FROM documents
      WHERE category IS NOT NULL
      ORDER BY title COLLATE NOCASE ASC`,
  );
  const byCategory = new Map<string, { id: string; title: string }[]>();
  for (const r of rows) {
    const key = r.category ?? '';
    if (!key) continue;
    const list = byCategory.get(key) ?? [];
    list.push({ id: r.id, title: r.title });
    byCategory.set(key, list);
  }
  return byCategory;
}

/**
 * The eleven, each with its document and what has already gone.
 *
 * **THE COUNT, NEVER A TICK.** "Sent" alone flattens once and five times onto
 * one mark and those are different mornings: one is a job done, the other is a
 * salesman who should be ringing rather than posting a sixth brochure. §16's
 * chase counter exists for the same reason one level up.
 *
 * **THE CODE IS READ OFF THE SOURCE ID**, which is where the server
 * deliberately put it. `timeline_events.summary` says in its own schema
 * comment that it is never parsed, so counting by matching a label inside a
 * sentence would be reading the one column that may not be read — and it would
 * break the first time somebody reworded a button.
 *
 * **THE OUTBOX COUNTS TOO, and that is the offline half.** A tap made with no
 * signal is a communication that happened; waiting for the office to confirm
 * it before the badge moves would mean the screen forgetting what he did five
 * minutes ago, which is exactly the moment he is deciding whether to send it
 * again. The two are deduplicated on the composed source id — the server keeps
 * the id this phone minted — so an item that has synced and come back down the
 * timeline channel is counted once and not twice.
 */
export async function communicationLog(customerId: string): Promise<CommunicationLog> {
  const byCategory = await publishedFor();

  const history = await all<{ sourceRecordId: string | null }>(
    `SELECT sourceRecordId FROM timeline_events WHERE customerId = ? AND eventType = ?`,
    [customerId, EVENT_TYPE],
  );

  const byCode = new Map<string, number>();
  const known = new Set<string>();
  let unattributed = 0;
  for (const row of history) {
    const source = row.sourceRecordId ?? '';
    known.add(source);
    const at = source.indexOf(':');
    const code = at >= 0 ? source.slice(at + 1) : '';
    if (!code) {
      unattributed += 1;
      continue;
    }
    byCode.set(code, (byCode.get(code) ?? 0) + 1);
  }

  const queued = await all<{ entityId: string; payload: string }>(
    `SELECT entityId, payload FROM sync_queue WHERE entityType = ?`,
    [ENTITY],
  );
  for (const item of queued) {
    let code = '';
    let against = '';
    try {
      const payload = JSON.parse(item.payload) as { customerId?: string; actionCode?: string };
      against = payload.customerId ?? '';
      code = payload.actionCode ?? '';
    } catch {
      /* A queue row this build cannot read is one an older build wrote. It
         still syncs — the server reads the payload, not this function — so
         the honest answer here is to leave it out of the count rather than
         to guess what it was. */
      continue;
    }
    if (against !== customerId || !code) continue;
    if (known.has(`${item.entityId}:${code}`)) continue;
    byCode.set(code, (byCode.get(code) ?? 0) + 1);
  }

  const options = COMMUNICATION_ACTIONS.map((action) => ({
    action,
    documents: action.document ? (byCategory.get(action.document) ?? []) : [],
    sent: byCode.get(action.code) ?? 0,
  }));

  return { options, unattributed };
}

export type CommunicationResult = { ok: true } | { ok: false; message: string };

/**
 * Record that somebody reached out, and send it.
 *
 * The rules refused here are the SAME three the server refuses on — an unknown
 * code, a send naming no document, a document that has left the library — and
 * they are checked at both ends deliberately. `handleLeadCommunication` is the
 * authority, because an outbox posts from a device somebody owns and a form is
 * not a rule; this copy exists so a salesman with no signal is told at the tap
 * rather than three hours later in the rejections list, where the thing he was
 * going to do about it has long since passed.
 *
 * A withdrawn document needs no check of its own: the pull carries only the
 * active library and tombstones the rest, so a document that has gone is a
 * document this phone no longer has — and a send naming an id nothing matched
 * would fail the lookup above and never be offered.
 *
 * The id is minted HERE and the server keeps it, which is what makes a retry
 * safe: the timeline's natural key is (app, kind, source row), so the same
 * communication arriving twice writes one row. It is also what lets the count
 * above deduplicate the outbox against the office's own answer.
 */
export async function recordCommunication(args: {
  customerId: string;
  actionCode: string;
  documentId?: string | null;
  note?: string | null;
}): Promise<CommunicationResult> {
  const action = COMMUNICATION_ACTIONS.find((a) => a.code === args.actionCode);
  if (!action) {
    return { ok: false, message: 'This phone does not know that way of reaching out.' };
  }
  if (action.kind === 'send' && !args.documentId) {
    return {
      ok: false,
      message:
        `"${action.label}" has to name the document that went, or the record ` +
        'cannot say which one a month from now.',
    };
  }

  const id = newId('lcm');
  const note = args.note?.trim() || null;

  await enqueue({
    entityType: 'lead_communication',
    entityId: id,
    op: 'create',
    payload: {
      customerId: args.customerId,
      actionCode: action.code,
      documentId: args.documentId ?? null,
      note,
    },
  });

  /*
   * The record's own history, written locally so it is there before the office
   * has heard of it.
   *
   * `lead_events` is this phone's trail and nothing in a pull touches it, so a
   * call logged in a basement shows on the record immediately and stays there.
   * The office's copy arrives later on `timeline_events`, which is a different
   * table and a different question — what MahekOne holds — and the two are
   * counted together above rather than being allowed to disagree.
   */
  await run(
    `INSERT INTO lead_events (id, leadId, kind, summary, detail, fromStage, toStage, actor, occurredAt)
     VALUES (?, ?, 'communication', ?, ?, NULL, NULL, 'You', ?)`,
    [newId('le'), args.customerId, action.label, note, Date.now()],
  );

  return { ok: true };
}
