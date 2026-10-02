import { all } from '../db';
import { territoryState } from '../sync/pull';
import type { TerritoryState } from '../sync/api';
import { areasSignature } from '../lib/territory-signature';
import { insertAndQueue, stamp } from './write';
import { raiseApproval } from './requests';

/**
 * WHERE HE WORKS, and what he has said about it.
 *
 * The office allocates his cities and areas; they arrive on every pull as the
 * territory state. From the Journeys screen he either accepts them as they
 * stand or asks for different ones. An acceptance needs nobody's answer; a
 * change request is decided on the office's Approvals queue, exactly like a
 * tour, and the verdict comes back down.
 *
 * Both are paperwork done wherever he is sitting, so neither records a
 * location — the same reasoning `requestTour` gives.
 */

export type Area = { kind: string; value: string; parent: string | null };

export type MyAreas = {
  /** Null where the office has never sent a territory state at all. */
  state: TerritoryState | null;
  /** The working areas, regions left out — those are a manager's patch, not his. */
  areas: Area[];
  /** The allocation as one string — see `lib/territory-signature.ts`. */
  signature: string;
};

export async function myAreas(): Promise<MyAreas> {
  const state = await territoryState();
  const areas = (state?.areas ?? []).filter((a) => a.kind !== 'region');
  return { state, areas, signature: areasSignature(areas) };
}

/** How an area reads on a chip: "Pune, Maharashtra" for a city, "Goa" for a state. */
export function areaLabel(a: Area): string {
  return a.parent ? a.value + ', ' + a.parent : a.value;
}

export type TerritoryRequest = {
  id: string;
  kind: 'accept' | 'change';
  currentPlaces: string[];
  requestedPlaces: string[];
  reason: string | null;
  signature: string;
  /** `accepted`, or for a change: `pending`, `approved`, `rejected`. */
  state: string;
  decisionNote: string | null;
  decidedAt: number | null;
  clientCreatedAt: number;
  syncState: string;
};

function parseList(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Newest first. */
export async function territoryRequests(): Promise<TerritoryRequest[]> {
  const rows = await all<Record<string, unknown>>(
    `SELECT * FROM territory_requests ORDER BY clientCreatedAt DESC LIMIT 20`,
  );
  return rows.map((r) => ({
    id: String(r.id),
    kind: r.kind === 'change' ? 'change' : 'accept',
    currentPlaces: parseList(r.currentPlaces),
    requestedPlaces: parseList(r.requestedPlaces),
    reason: (r.reason as string | null) ?? null,
    signature: String(r.signature ?? ''),
    state: String(r.state ?? 'pending'),
    decisionNote: (r.decisionNote as string | null) ?? null,
    decidedAt: (r.decidedAt as number | null) ?? null,
    clientCreatedAt: Number(r.clientCreatedAt ?? 0),
    syncState: String(r.syncState ?? 'synced'),
  }));
}

/**
 * Whether he has accepted the allocation he is looking at NOW. An acceptance
 * of an earlier allocation does not count — the office has moved him since.
 */
export function acceptedNow(requests: TerritoryRequest[], signature: string): TerritoryRequest | null {
  return requests.find((r) => r.kind === 'accept' && r.signature === signature) ?? null;
}

/** The change request still waiting on the office, if there is one. */
export function pendingChange(requests: TerritoryRequest[]): TerritoryRequest | null {
  return requests.find((r) => r.kind === 'change' && r.state === 'pending') ?? null;
}

export async function acceptAreas(): Promise<{ ok: true } | { ok: false; message: string }> {
  const mine = await myAreas();
  if (!mine.areas.length) {
    return { ok: false, message: 'Nothing has been allocated to you yet, so there is nothing to accept.' };
  }
  const base = await stamp('territory');
  await insertAndQueue({
    table: 'territory_requests',
    entityType: 'territory_request',
    location: false,
    row: {
      ...base,
      kind: 'accept',
      currentPlaces: mine.areas.map(areaLabel),
      requestedPlaces: [],
      reason: null,
      signature: mine.signature,
      state: 'accepted',
    },
  });
  return { ok: true };
}

/**
 * Ask for different cities. Both the cities and the reason are required —
 * a manager cannot act on "somewhere else", and the server refuses it too.
 */
export async function askForDifferentAreas(args: {
  places: string[];
  reason: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const places = [...new Set(args.places.map((p) => p.trim()).filter(Boolean))];
  const reason = args.reason.trim();
  if (!places.length) return { ok: false, message: 'Name at least one city or area you would rather work.' };
  if (reason.length < 3) return { ok: false, message: 'Say why — your manager decides on the reason as much as the cities.' };

  const mine = await myAreas();
  const base = await stamp('territory');
  const id = await insertAndQueue({
    table: 'territory_requests',
    entityType: 'territory_request',
    location: false,
    row: {
      ...base,
      kind: 'change',
      currentPlaces: mine.areas.map(areaLabel),
      requestedPlaces: places,
      reason,
      signature: mine.signature,
      state: 'pending',
    },
  });
  await raiseApproval({
    type: 'territory',
    subjectType: 'territory_request',
    subjectId: id,
    reason,
    deviceId: base.deviceId,
  });
  return { ok: true };
}
