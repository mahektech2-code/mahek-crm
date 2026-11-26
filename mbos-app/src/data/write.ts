import { newId, one, run, tx } from '../db';
import { enqueue } from '../sync/queue';
import * as api from '../sync/api';
import { whereNow, type Where } from '../native/where';

/**
 * The write path. Every write in this app goes through here, without exception.
 *
 *   1. Validate locally against cached reference data
 *   2. Assign a client identifier
 *   3. Write to the local store
 *   4. Enqueue a sync item
 *   5. Return success immediately
 *
 * Step 5 is the one that matters. The UI never blocks on the network, so a
 * saved visit is saved — full stop, whatever the signal is doing. Sync happens
 * afterwards and out of sight.
 */

export type Owned = {
  id: string;
  clientCreatedAt: number;
  deviceId: string;
  syncState: string;
};

/** The four columns every owned record carries, filled once, here. */
export async function stamp(entity: string): Promise<Owned> {
  return {
    id: newId(entity),
    clientCreatedAt: Date.now(),
    deviceId: await api.deviceId(),
    syncState: 'queued',
  };
}

type Value = string | number | null;

function toColumns(row: Record<string, unknown>): { cols: string[]; values: Value[] } {
  const cols: string[] = [];
  const values: Value[] = [];
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    cols.push(k);
    values.push(
      v === null ? null
        : typeof v === 'boolean' ? (v ? 1 : 0)
          : typeof v === 'object' ? JSON.stringify(v)
            : typeof v === 'number' ? v
              : String(v),
    );
  }
  return { cols, values };
}

/**
 * THE ROW AND ITS OUTBOX ITEM COMMIT TOGETHER, or neither does.
 *
 * They were two awaits, so a phone reaped between them — and this app is
 * reaped on the road all day — kept a record that drew as "Not sent yet" for
 * ever with nothing in the outbox to send. The location is read BEFORE the
 * transaction opens, so the transaction holds the connection for two writes
 * and nothing else.
 *
 * `inTransaction` is for a caller already inside one (a visit's follow-up
 * task): `tx()` does not nest, and opening one there would wait on itself.
 */
async function together<T>(inTransaction: boolean | undefined, body: () => Promise<T>): Promise<T> {
  return inTransaction ? body() : tx(body);
}

async function whereFirst(location: boolean | undefined): Promise<Where | undefined> {
  if (location === false) return undefined;
  return whereNow().catch(() => undefined);
}

/**
 * Insert a record and queue it in one go.
 *
 * `dependsOn` is what keeps a payment from reaching the server before the
 * order it was collected against. The ids in it are client ids, which already
 * exist and already resolve — that is the whole reason identity is minted on
 * the device rather than by a server sequence.
 */
export async function insertAndQueue(args: {
  table: string;
  entityType: string;
  row: Record<string, unknown>;
  dependsOn?: string[];
  /** Extra fields the server needs that are not columns here — the customer's
   *  name on an order, so a rejection can say whose order it was. */
  payloadExtras?: Record<string, unknown>;
  /** False for paperwork rather than field work — see `native/where.ts`. */
  location?: boolean;
  /** Already inside a `tx()` — see `together`. */
  inTransaction?: boolean;
}): Promise<string> {
  const { cols, values } = toColumns(args.row);
  const marks = cols.map(() => '?').join(',');
  const where = await whereFirst(args.location);

  await together(args.inTransaction, async () => {
    await run(`INSERT INTO ${args.table} (${cols.join(',')}) VALUES (${marks})`, values);
    await enqueue({
      entityType: args.entityType,
      entityId: args.row.id as string,
      op: 'create',
      payload: { ...args.row, ...(args.payloadExtras ?? {}) },
      dependsOn: args.dependsOn,
      location: args.location,
      where,
    });
  });

  return args.row.id as string;
}

/**
 * An edit to a record that already exists. Mutable records only.
 *
 * An update payload is PARTIAL by design — it names the id and the fields that
 * changed, and nothing else. The server has a partial schema for each entity
 * that reads it that way; sending the whole record instead would make every
 * edit a chance to overwrite a column somebody else had corrected.
 */
export async function updateAndQueue(args: {
  table: string;
  entityType: string;
  id: string;
  patch: Record<string, unknown>;
  /** False for paperwork rather than field work — see `native/where.ts`. */
  location?: boolean;
  dependsOn?: string[];
  /** Where a column's name or vocabulary is not the wire's — see PROTOCOL §4.1. */
  payloadExtras?: Record<string, unknown>;
  /** Already inside a `tx()` — see `together`. */
  inTransaction?: boolean;
}): Promise<void> {
  const { cols, values } = toColumns(args.patch);
  const sets = cols.map((c) => `${c} = ?`).join(', ');
  const where = await whereFirst(args.location);

  await together(args.inTransaction, async () => {
    /* What the edit changes, as it was — put back if the office refuses it
       (`restoreBeforeEdit`). Read inside the transaction, so it is the value
       this edit replaced and not one another write slipped in between. */
    const prevRow = cols.length
      ? await one<Record<string, Value>>(`SELECT ${cols.join(', ')} FROM ${args.table} WHERE id = ?`, [args.id]).catch(() => null)
      : null;
    /* BEHIND ITS OWN CREATE, while that is still in the outbox. An edit that
       overtook its create was answered "retry" by the office (nothing to edit
       yet) — and one made after the create was REFUSED was retried for ever,
       because nothing tied it to the refusal. A create with no row left in
       the outbox has landed (`presumedLanded`), so this costs nothing then. */
    const createWaiting = await one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sync_queue WHERE entityId = ? AND op = 'create' AND state <> 'synced'`,
      [args.id],
    );
    const dependsOn = [...(args.dependsOn ?? [])];
    if ((createWaiting?.n ?? 0) > 0 && !dependsOn.includes(args.id)) dependsOn.push(args.id);

    await run(`UPDATE ${args.table} SET ${sets}, syncState = 'queued' WHERE id = ?`, [...values, args.id]);
    await enqueue({
      entityType: args.entityType,
      entityId: args.id,
      op: 'update',
      payload: { id: args.id, ...args.patch, ...(args.payloadExtras ?? {}) },
      dependsOn: dependsOn.length ? dependsOn : undefined,
      location: args.location,
      where,
      snapshot: prevRow
        ? {
            table: args.table,
            prev: Object.fromEntries(cols.map((c) => [c, prevRow[c] ?? null])),
            next: Object.fromEntries(cols.map((c, i) => [c, values[i]])),
          }
        : undefined,
    });
  });
}

/**
 * A write with no server counterpart yet — used for rows the app derives and
 * the server will recompute anyway. It still goes to the local store, because
 * the UI reads the local store and nothing else.
 */
export async function insertLocal(table: string, row: Record<string, unknown>): Promise<string> {
  const { cols, values } = toColumns(row);
  const marks = cols.map(() => '?').join(',');
  await run(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${marks})`, values);
  return row.id as string;
}
