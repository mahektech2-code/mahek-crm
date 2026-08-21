import { deleteSecret, getSecret, setSecret } from '../native/secure';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { getKv, setKv } from '../db';

/**
 * The one place a request leaves this app.
 *
 * Everything here can fail, and failing is ordinary rather than exceptional —
 * the handset spends most of its day without usable signal. So nothing in this
 * file retries or reports; it throws, and the sync engine decides what a
 * failure means for the item that caused it.
 */

const BASE =
  (Constants.expoConfig?.extra as { apiBase?: string } | undefined)?.apiBase ??
  process.env.EXPO_PUBLIC_API_BASE ??
  'http://localhost:3000';

const ACCESS_KEY = 'mbos.accessToken';
const REFRESH_KEY = 'mbos.refreshToken';
const DEVICE_KEY = 'mbos.deviceId';

/* --------------------------------------------------------------- identity */

/**
 * One identifier per install, kept in the keychain rather than the database,
 * so wiping the local store on sign-out does not make this handset look like a
 * new device to the server's session binding.
 */
export async function deviceId(): Promise<string> {
  let id = await getSecret(DEVICE_KEY);
  if (!id) {
    id = Crypto.randomUUID();
    await setSecret(DEVICE_KEY, id);
  }
  return id;
}

export async function deviceLabel(): Promise<string> {
  return [Device.manufacturer, Device.modelName].filter(Boolean).join(' ') || 'Unknown handset';
}

export async function setTokens(access: string, refresh: string): Promise<void> {
  await setSecret(ACCESS_KEY, access);
  await setSecret(REFRESH_KEY, refresh);
}

export async function clearTokens(): Promise<void> {
  await deleteSecret(ACCESS_KEY);
  await deleteSecret(REFRESH_KEY);
}

export async function accessToken(): Promise<string | null> {
  return getSecret(ACCESS_KEY);
}

/* ---------------------------------------------------------------- request */

async function request<T>(path: string, init: RequestInit & { auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-mbos-device': await deviceId(),
    ...(init.headers as Record<string, string> | undefined),
  };

  if (init.auth !== false) {
    const token = await accessToken();
    if (token) headers.authorization = `Bearer ${token}`;
  }

  /* A hung socket is worse than a refused one: it holds a queue item in
     `syncing` until the app is killed. Twenty seconds, then give up. */
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers, signal: controller.signal });
  } catch (e) {
    throw new Error(e instanceof Error && e.name === 'AbortError' ? 'MahekOne did not answer in time' : 'No connection to MahekOne');
  } finally {
    clearTimeout(timeout);
  }

  if (res.status === 401 && init.auth !== false) {
    const refreshed = await tryRefresh();
    if (refreshed) return request<T>(path, init);
    throw new Error('Your session has ended. Sign in again.');
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(body.slice(0, 200) || `MahekOne answered ${res.status}`);
  }

  return res.json() as Promise<T>;
}

async function tryRefresh(): Promise<boolean> {
  const refresh = await getSecret(REFRESH_KEY);
  if (!refresh) return false;
  try {
    const out = await request<{ accessToken: string; refreshToken: string }>('/api/mbos/auth/refresh', {
      method: 'POST',
      auth: false,
      body: JSON.stringify({ refreshToken: refresh }),
    });
    await setTokens(out.accessToken, out.refreshToken);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------- auth */

export type SessionUser = {
  id: string;
  name: string;
  initials: string;
  email: string | null;
  phone: string | null;
  role: string;
  employeeCode: string | null;
  designation: string | null;
  territory: string | null;
  reportsToName: string | null;
};

/**
 * The login response carries the bootstrap with it.
 *
 * One round trip, not two. A salesman signing in at the edge of coverage gets
 * his whole book from the same request that authenticated him, rather than
 * authenticating and then failing to fetch anything.
 */
export async function login(args: { mobile: string; password?: string; otp?: string }): Promise<{
  accessToken: string;
  refreshToken: string;
  bootstrap: PullPayload & { user: SessionUser };
}> {
  return request('/api/mbos/auth/login', {
    method: 'POST',
    auth: false,
    body: JSON.stringify({ ...args, deviceId: await deviceId(), deviceLabel: await deviceLabel() }),
  });
}

export async function requestOtp(mobile: string): Promise<{ sent: boolean }> {
  return request('/api/mbos/auth/otp', { method: 'POST', auth: false, body: JSON.stringify({ mobile }) });
}

/* -------------------------------------------------------------- bootstrap */

export type PullPayload = {
  cursor?: string;
  config?: Record<string, unknown>;
  customers?: unknown[];
  products?: unknown[];
  priceList?: unknown[];
  schemes?: unknown[];
  timeline?: unknown[];
  journeyStops?: unknown[];
  tasks?: unknown[];
  samples?: unknown[];
  leads?: unknown[];
  notifications?: unknown[];
  documents?: unknown[];
  courses?: unknown[];
  leaveBalances?: unknown[];
  approvals?: unknown[];
  /**
   * `{ mediaId, transcript }` per voice note the office has written out. It is
   * what releases the recording here — see `sync/media.ts`.
   */
  transcripts?: { mediaId: string; transcript: string }[];
  /**
   * The days themselves, and how far each has got in being agreed. A stop only
   * exists once a day is PLANNED, so without this a month laid out in advance
   * is invisible here and the first anybody knows of a day is a route they
   * were never asked about.
   */
  planDays?: unknown[];
  deletions?: { entity: string; ids: string[] }[];
};

export async function bootstrap(): Promise<PullPayload> {
  return request('/api/mbos/bootstrap', { method: 'GET' });
}

/* ------------------------------------------------------------------- sync */

export type WireItem = {
  queueId: string;
  entityType: string;
  entityId: string;
  op: 'create' | 'update';
  idempotencyKey: string;
  clientCreatedAt: number;
  dependsOn: string[];
  payload: unknown;
  /**
   * Where the salesman was when he did this.
   *
   * A sibling of the payload, never a field inside it: `idempotencyKey` is a
   * hash of the payload, and the same order enqueued twice from two spots on
   * a street has to stay one order.
   */
  location?: unknown;
};

export type SyncResult = {
  queueId: string;
  status: 'accepted' | 'rejected' | 'retry' | 'conflict';
  serverId?: string;
  serverNumber?: string;
  serverReceivedAt?: number;
  code?: string;
  message?: string;
  blocks?: string[];
  serverVersion?: unknown;
};

export type SyncResponse = { results: SyncResult[]; pull?: PullPayload };

export async function postSync(body: { cursor: string; items: WireItem[] }): Promise<SyncResponse> {
  return request('/api/mbos/sync', {
    method: 'POST',
    body: JSON.stringify({ ...body, deviceId: await deviceId() }),
  });
}

/* ------------------------------------------------------------------ media */

export async function uploadMedia(args: {
  clientId: string;
  parentType: string;
  parentId: string;
  kind: string;
  uri: string;
  mimeType: string;
}): Promise<{ remoteRef: string }> {
  const form = new FormData();
  form.append('clientId', args.clientId);
  form.append('parentType', args.parentType);
  form.append('parentId', args.parentId);
  form.append('kind', args.kind);
  /* React Native's FormData takes this shape for a file; it is not a Blob. */
  form.append('file', {
    uri: args.uri,
    name: `${args.clientId}.${args.mimeType.split('/')[1] ?? 'bin'}`,
    type: args.mimeType,
  } as unknown as Blob);

  const token = await accessToken();
  const res = await fetch(`${BASE}/api/mbos/media`, {
    method: 'POST',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'x-mbos-device': await deviceId(),
    },
    body: form,
  });
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);
  return res.json() as Promise<{ remoteRef: string }>;
}

/* --------------------------------------------------------------- last seen */

export async function lastPullAt(): Promise<number> {
  const v = await getKv('lastPullAt');
  return v ? Number(v) : 0;
}

export async function markPulled(at = Date.now()): Promise<void> {
  await setKv('lastPullAt', String(at));
}

/**
 * The trail, in batches.
 *
 * Its own call rather than a sync entity type: a position is one of a hundred
 * and worth nothing on its own, so it must never sit in a dependency-ordered
 * outbox in front of the visit behind it. `tracking: 'off'` is the office
 * saying stop, which is an answer rather than a failure.
 */
export async function postPositions(
  positions: { id: string; at: number; lat: number; lng: number; accuracyM: number | null }[],
): Promise<{ ok: boolean; stored: number; tracking?: string }> {
  return request('/api/mbos/positions', {
    method: 'POST',
    body: JSON.stringify({ positions, deviceId: await deviceId() }),
  });
}
