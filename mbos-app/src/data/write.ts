import { newId, run } from '../db';
import { enqueue } from '../sync/queue';
import * as api from '../sync/api';

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
}): Promise<string> {
  const { cols, values } = toColumns(args.row);
  const marks = cols.map(() => '?').join(',');
  await run(`INSERT INTO ${args.table} (${cols.join(',')}) VALUES (${marks})`, values);

  await enqueue({
    entityType: args.entityType,
    entityId: args.row.id as string,
    op: 'create',
    payload: { ...args.row, ...(args.payloadExtras ?? {}) },
    dependsOn: args.dependsOn,
  });

  return args.row.id as string;
}

/** An edit to a record that already exists. Mutable records only. */
export async function updateAndQueue(args: {
  table: string;
  entityType: string;
  id: string;
  patch: Record<string, unknown>;
  dependsOn?: string[];
}): Promise<void> {
  const { cols, values } = toColumns(args.patch);
  const sets = cols.map((c) => `${c} = ?`).join(', ');
  await run(`UPDATE ${args.table} SET ${sets}, syncState = 'queued' WHERE id = ?`, [...values, args.id]);

  await enqueue({
    entityType: args.entityType,
    entityId: args.id,
    op: 'update',
    payload: { id: args.id, ...args.patch },
    dependsOn: args.dependsOn,
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
