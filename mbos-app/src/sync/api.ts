import { deleteSecret, getSecret, setSecret } from '../native/secure';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import * as Application from 'expo-application';
import { Platform } from 'react-native';
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

/**
 * A refusal MahekOne answered, with the reason it gave.
 *
 * `step` is the server's own vocabulary — `unknown_user`, `bad_password`,
 * `inactive`, `no_app_access`, `device_bound`, `bootstrap_failed` — and null
 * where the body carried none. An ordinary `Error` still means the request
 * never got an answer, which is the distinction the sign-in screen turns on:
 * one of them may fall back to the offline cache and the other may not.
 */
export class ApiError extends Error {
  status = 0;
  step: string | null = null;
}

const ACCESS_KEY = 'mbos.accessToken';
const REFRESH_KEY = 'mbos.refreshToken';
const DEVICE_KEY = 'mbos.deviceId';

/* --------------------------------------------------------------- identity */

/**
 * One identifier per install, kept in the keychain rather than the database,
 * so wiping the local store on sign-out does not make this handset look like a
 * new device to the server's session binding.
 *
 * **A random UUID does not survive an UNinstall, and that is a different
 * question from sign-out.** The keychain entry above is scoped to the app's
 * own storage, and Android deletes an app's storage — keychain-backed or
 * not — the moment it is uninstalled. A salesman who uninstalls and
 * reinstalls the same app on the same phone gets a brand-new random id on
 * first launch, which the server has never seen: `checkDeviceBinding` reads
 * that, correctly, as a DIFFERENT handset, and refuses the sign-in until an
 * admin releases the old one — exactly the rule the one-device-per-person
 * binding is supposed to enforce, firing on a case it was never meant to
 * catch. `Application.getAndroidId()` is the fix on Android: a value tied to
 * the device, the signing key and the user, which survives a plain
 * uninstall/reinstall precisely because it lives outside any app's own
 * storage — an actually different phone, or a different signing key, still
 * changes it. The stable release keystore this app now signs with is what
 * makes that hold across a rebuilt APK rather than only within one install.
 * iOS gets the equivalent, `getIosIdForVendorAsync` — weaker (Apple resets it
 * once every app from this vendor is gone) but still better than a value
 * guaranteed to reset on the exact action being fixed for. Either one is
 * read only on first launch, same as before; an id already saved is never
 * replaced, so an existing install's binding cannot shift under it.
 */
export async function deviceId(): Promise<string> {
  const existing = await getSecret(DEVICE_KEY);
  if (existing) return existing;

  let id: string | null = null;
  try {
    if (Platform.OS === 'android') {
      id = Application.getAndroidId();
    } else if (Platform.OS === 'ios') {
      id = await Application.getIosIdForVendorAsync();
    }
  } catch {
    /* Neither platform API is guaranteed — a simulator, a locked-down ROM,
       a future OS change. The random id below is the same floor this
       always had. */
  }

  const resolved = id ?? Crypto.randomUUID();
  await setSecret(DEVICE_KEY, resolved);
  return resolved;
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
    /*
     * A REFUSAL KEEPS ITS SHAPE.
     *
     * This used to `throw new Error(body.slice(0, 200))` — the whole JSON
     * document flattened into a string — and the sign-in screen was left to
     * work out what had happened by running a regex over the English inside
     * it. MahekOne names the reason in `step`, one of six, each of which sends
     * the person somewhere different; none of that survived the trip, so every
     * refusal the regex did not recognise was treated as "no answer at all"
     * and reported as a ten-digit mobile number not having ten digits.
     *
     * The status and the server's own words are carried on the error instead.
     * Anything unparseable still throws, because a body we cannot read is a
     * different thing from a refusal we can.
     */
    const body = await res.text().catch(() => '');
    let parsed: { step?: string; code?: string; error?: string } | null = null;
    try {
      parsed = JSON.parse(body) as { step?: string; code?: string; error?: string };
    } catch {
      parsed = null;
    }
    const err = new ApiError(
      parsed?.error || body.slice(0, 200) || `MahekOne answered ${res.status}`,
    );
    err.status = res.status;
    err.step = parsed?.step ?? parsed?.code ?? null;
    throw err;
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
  /** The office's order and receipt history, ten of each per customer. */
  customerOrders?: unknown[];
  customerPayments?: unknown[];
  leads?: unknown[];
  notifications?: unknown[];
  documents?: unknown[];
  courses?: unknown[];
  leaveBalances?: unknown[];
  /** Today's attendance, sent only by bootstrap. See `restoreAttendance`. */
  attendanceToday?: {
    id: string;
    userId: string;
    day: string;
    checkInAt: number | null;
    checkInLat: number | null;
    checkInLng: number | null;
    checkInAccuracyM: number | null;
    checkOutAt: number | null;
    status: string | null;
  } | null;
  /**
   * `{ id, onDate, name, scope, universal }`. Only `universal` rows bind the
   * attendance engine automatically — see `data/attendance.ts`.
   */
  holidays?: unknown[];
  approvals?: unknown[];
  /** His own month, scored by the office. Reference only — nothing here writes it. */
  performance?: unknown[];
  /** His own pay, current month and last. Reference only, same as performance. */
  salary?: unknown[];
  /** The modes a leg may name. Upserted by key. */
  travelModes?: unknown[];
  /**
   * The expense policy in force, narrowed to this salesman, as the rules his
   * own copy of the engine reads. REPLACED wholesale — see `replaceExpensePolicy`.
   * Null means the office has published nothing covering today.
   */
  expensePolicy?: unknown | null;
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

/** Where Expo should push to, for this device. `null` clears it — see push.ts. */
export async function registerPushToken(pushToken: string | null): Promise<{ ok: boolean }> {
  return request('/api/mbos/push-token', {
    method: 'POST',
    body: JSON.stringify({ pushToken }),
  });
}

/**
 * Whether this handset actually got the OS's background location
 * permission — the office cannot know this any other way, since the OS's
 * answer to that prompt never reaches a server on its own. Called once per
 * `start()`, from `trail.ts`, right after the answer is known.
 */
export async function reportLocationPermission(backgroundGranted: boolean): Promise<{ ok: boolean }> {
  return request('/api/mbos/location-permission', {
    method: 'POST',
    body: JSON.stringify({ backgroundGranted }),
  });
}
