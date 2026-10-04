import { deleteSecret, getSecret, setSecret } from '../native/secure';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import * as Application from 'expo-application';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { File } from 'expo-file-system';
import { getKv, setKv } from '../db';
import { buildLabel } from '../native/updates';
import { readDeviceState } from './device-state';
import {
  authLostReasonFor,
  authLostSentence,
  noAnswerSentence,
  unreadableAnswerSentence,
  type AuthLostReason,
} from '../engines/sign-in';

/**
 * The one place a request leaves this app.
 *
 * Everything here can fail, and failing is ordinary rather than exceptional —
 * the handset spends most of its day without usable signal. So nothing in this
 * file retries or reports; it throws, and the sync engine decides what a
 * failure means for the item that caused it.
 */

export const BASE =
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
  /** On a 429: how long the server asked us to wait. */
  retryInSeconds: number | null = null;
}

/**
 * NO ANSWER AT ALL — and which kind.
 *
 * It used to be one plain `Error` for both, and the sign-in screen read every
 * plain error as "no signal" and went down the offline path. A request that
 * timed out reached a server that was busy building a large book, so saying
 * "no internet" to him was wrong and sent him looking for signal he already
 * had. `kind` keeps the two apart for every caller that needs to know.
 */
export class NoAnswerError extends Error {
  constructor(public kind: 'offline' | 'timeout') {
    super(noAnswerSentence(kind));
  }
}

/**
 * THIS SESSION IS OVER, which is different from "this request was refused".
 *
 * Raised for a refresh token the server will not renew, and for the three 403s
 * that stay true until a person acts: a released handset, a closed account, a
 * field app taken away. It is an `ApiError` — the server DID answer, so the
 * sign-in screen must never read it as offline — and it leaves a mark in `kv`
 * the moment it is raised, so the banner that sends him back to sign in does
 * not depend on any one screen having caught it.
 *
 * THE ENGINE'S HALF: an item that fails with this should not have its attempt
 * counted, because nothing about the item was wrong. `isAuthLost(e)` is what
 * the sync loop asks.
 */
export class AuthLostError extends ApiError {
  constructor(public reason: AuthLostReason, message: string) {
    super(message);
  }
}

export function isAuthLost(e: unknown): e is AuthLostError {
  return e instanceof AuthLostError;
}

const AUTH_LOST_KEY = 'mbos.authLost';

async function markAuthLost(reason: AuthLostReason): Promise<void> {
  try {
    await setKv(AUTH_LOST_KEY, JSON.stringify({ reason, at: Date.now() }));
    authLostListener?.();
  } catch {
    /* The banner is a courtesy; the refusal itself still reaches the caller. */
  }
}

/** Why this phone can no longer send, or null where it can. */
export async function authLost(): Promise<{ reason: AuthLostReason; at: number } | null> {
  try {
    const raw = await getKv(AUTH_LOST_KEY);
    return raw ? (JSON.parse(raw) as { reason: AuthLostReason; at: number }) : null;
  } catch {
    return null;
  }
}

export async function clearAuthLost(): Promise<void> {
  await setKv(AUTH_LOST_KEY, '');
  authLostListener?.();
}

let authLostListener: (() => void) | null = null;
/** One listener — the banner — told the moment the mark moves. */
export function onAuthLostChange(fn: (() => void) | null): void {
  authLostListener = fn;
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

/**
 * The build label as a header value, percent-encoded.
 *
 * The label carries a middle dot ("1.15.1 (22) · embedded"), and since SDK 57
 * the global `fetch` is `expo/fetch`, which refuses a header value that is not
 * ASCII — the whole request fails as "NativeRequest.start has been rejected",
 * before a byte leaves the phone, and every sign-in and sync read as "No
 * internet". React Native's own fetch stripped the character, which is why
 * builds before SDK 57 never showed it. The body of a sign-in still carries
 * the label as written; `reportedVersion` decodes this one.
 */
export function versionHeader(): string {
  return encodeURIComponent(buildLabel());
}

export async function deviceLabel(): Promise<string> {
  return [Device.manufacturer, Device.modelName].filter(Boolean).join(' ') || 'Unknown handset';
}

/**
 * THE ONE PLACE A TOKEN IS WRITTEN, which is why the mirror is written here.
 *
 * MBOS's own location service posts positions for itself — that is the whole
 * point of it, because the moment it matters is the moment this JavaScript is
 * not running — and it cannot read the keychain these live in. So the pair is
 * MIRRORED into the service's own preferences, and it is done HERE rather than
 * at the three call sites that mint tokens, because a mirror updated at two of
 * three places is a service posting with an expired token and nobody able to
 * say why.
 *
 * It never fails a sign-in: `setServiceCredentials` swallows everything, and a
 * mirror that did not land costs the service its ability to send, which hands
 * the queue back to `flush()` — the behaviour this app had before the uploader
 * existed.
 */
export async function setTokens(access: string, refresh: string): Promise<void> {
  await setSecret(ACCESS_KEY, access);
  await setSecret(REFRESH_KEY, refresh);
  /*
   * READ BACK, because the keychain can say yes and keep nothing.
   *
   * Android invalidates its keystore when the lock screen changes, and
   * `setSecret` swallows the failure so the app can still open. Unchecked, a
   * sign-in "succeeded" with no token stored: the session was persisted, every
   * request went out unauthenticated, and every sync read "signed out" with
   * nothing anywhere naming the cause. Saying it at the sign-in is the one
   * moment somebody can do something about it.
   */
  if ((await getSecret(ACCESS_KEY)) !== access || (await getSecret(REFRESH_KEY)) !== refresh) {
    throw new Error(
      'This phone could not store your sign-in. Restart the phone and try again. If it keeps happening, tell your manager.',
    );
  }
  await mirrorCredentials(access, refresh);
}

export async function clearTokens(): Promise<void> {
  await deleteSecret(ACCESS_KEY);
  await deleteSecret(REFRESH_KEY);
  /* ALL FOUR EMPTY IS THE SIGN-OUT, and it clears rather than storing blanks.
     A released handset holding a refresh token is a handset that could still
     post for somebody who has left. */
  await mirrorCredentials('', '');
}

async function mirrorCredentials(access: string, refresh: string): Promise<void> {
  try {
    const { setServiceCredentials } = await import('../native/location-service');
    await setServiceCredentials({
      baseUrl: access ? BASE : '',
      deviceId: access ? await deviceId() : '',
      accessToken: access,
      refreshToken: refresh,
    });
  } catch {
    /* A build with no such module, or a bridge that would not answer. The
       service then cannot send and the app drains the buffer instead, which is
       exactly what it did before the service could send at all. */
  }
}

export async function accessToken(): Promise<string | null> {
  return getSecret(ACCESS_KEY);
}

/**
 * The refresh token, for the ONE caller that is not `tryRefresh`.
 *
 * The service holds its own copy so it can refresh with no JavaScript in the
 * process. Both copies go on working: the server's refresh is a stateless JWT
 * with no denylist, so rotating one does not invalidate the other, and each
 * side carries its own until it expires.
 */
export async function refreshToken(): Promise<string | null> {
  return getSecret(REFRESH_KEY);
}

/* ---------------------------------------------------------------- request */

async function request<T>(
  path: string,
  init: RequestInit & { auth?: boolean; timeoutMs?: number } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-mbos-device': await deviceId(),
    /* The build on every request, so the office sees an upgrade on the first
       sync after it rather than at the next sign-in, which nobody does. */
    'x-mbos-app-version': versionHeader(),
    ...(init.headers as Record<string, string> | undefined),
  };

  if (init.auth !== false) {
    const token = await accessToken();
    if (token) headers.authorization = `Bearer ${token}`;
  }

  /* A hung socket is worse than a refused one: it holds a queue item in
     `syncing` until the app is killed. Twenty seconds, then give up — unless
     the caller is waiting on a language model, which is slower by nature.

     THE CLOCK RUNS UNTIL THE BODY IS READ, not until the headers arrive. It
     used to be cleared the moment `fetch` resolved, and on 2G the body is the
     slow half — a stalled one held `syncNow` at "Already sending" for the
     life of the process. */
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? 20_000);

  try {
    let res: Response;
    try {
      const { timeoutMs: _t, auth: _a, ...rest } = init;
      res = await fetch(`${BASE}${path}`, { ...rest, headers, signal: controller.signal });
    } catch {
      /* `expo/fetch` reports an abort as a FetchError, never an AbortError, so
         ask the signal whether it was us that gave up. */
      throw new NoAnswerError(controller.signal.aborted ? 'timeout' : 'offline');
    }

    if (res.status === 401 && init.auth !== false) {
      const refreshed = await tryRefresh();
      if (refreshed === 'ok') return await request<T>(path, init);
      /* A refresh that never got an answer is a dead tower, not a sign-out:
         reporting it as one wrote "You have been signed out" onto every queued
         item whenever the token lapsed in a lane with no signal. */
      if (refreshed === 'unreachable') throw new NoAnswerError('offline');
      throw await lost('expired');
    }

    if (!res.ok) {
      return await refusal(res, init.auth !== false);
    }

    try {
      return (await res.json()) as T;
    } catch {
      throw new NoAnswerError(controller.signal.aborted ? 'timeout' : 'offline');
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function lost(reason: AuthLostReason, message?: string): Promise<AuthLostError> {
  await markAuthLost(reason);
  const err = new AuthLostError(reason, message || authLostSentence(reason));
  err.status = reason === 'expired' ? 401 : 403;
  err.step = reason;
  return err;
}

/**
 * A server answer that is not a success, turned into the error it means.
 *
 * Shared by `request` and the three form uploads, which used to carry their
 * own copies — and the 1.16.0 header fix had to be made in four places
 * because of it.
 */
async function refusal(res: Response, authed: boolean): Promise<never> {
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
  type Refusal = { step?: string; code?: string; error?: string; retryInSeconds?: number | null };
  let parsed: Refusal | null = null;
  try {
    parsed = JSON.parse(body) as Refusal;
  } catch {
    parsed = null;
  }
  const step = parsed?.step ?? parsed?.code ?? null;

  if (authed) {
    const reason = authLostReasonFor(res.status, step);
    if (reason) throw await lost(reason, parsed?.error);
  }

  /* ONLY THE SERVER'S OWN SENTENCE, never the raw body. A proxy answering
     during a deploy sends an HTML page, and the first 200 characters of
     `<html><head><title>502 Bad Gateway` used to be printed under the
     mobile number as though it were advice. */
  const err = new ApiError(parsed?.error || unreadableAnswerSentence(res.status));
  err.status = res.status;
  err.step = step ?? (res.status >= 500 ? 'server_down' : null);
  err.retryInSeconds = typeof parsed?.retryInSeconds === 'number' ? parsed.retryInSeconds : null;
  throw err;
}

/**
 * Renew the access token, and say which of three things happened.
 *
 * It answered a boolean, and `false` covered both "the server refused" and
 * "the server could not be reached" — so a lapsed token in a lane with no
 * signal was reported to the salesman, and written onto every queued item,
 * as being signed out.
 *
 * ONE AT A TIME. A sync, a media upload and a dictation can all hit their 401
 * in the same second, and three refreshes racing each other rotate the pair
 * three times with the last writer winning a token the other two do not hold.
 */
let refreshing: Promise<'ok' | 'refused' | 'unreachable'> | null = null;

async function tryRefresh(): Promise<'ok' | 'refused' | 'unreachable'> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const refresh = await getSecret(REFRESH_KEY);
    if (!refresh) return 'refused' as const;
    try {
      const out = await request<{ accessToken: string; refreshToken: string; user?: SessionUser }>(
        '/api/mbos/auth/refresh',
        {
          method: 'POST',
          auth: false,
          body: JSON.stringify({ refreshToken: refresh }),
        },
      );
      await setTokens(out.accessToken, out.refreshToken);
      if (out.user) userRefreshListener?.(out.user);
      return 'ok' as const;
    } catch (e) {
      if (e instanceof NoAnswerError) return 'unreachable' as const;
      return 'refused' as const;
    }
  })();
  try {
    return await refreshing;
  } finally {
    refreshing = null;
  }
}

/**
 * The person as the office now has them, delivered with every refresh.
 *
 * The session user was written once at sign-in and never again, and a session
 * never expires — so a promotion, a new area or a new manager reached the
 * Profile screen only if he signed out, which nobody does. `data/session.ts`
 * listens and rewrites the stored session.
 */
let userRefreshListener: ((user: SessionUser) => void) | null = null;
export function onUserRefreshed(fn: ((user: SessionUser) => void) | null): void {
  userRefreshListener = fn;
}

/**
 * A multipart request with the same manners as `request`: the device and
 * build headers, the bearer token, a deadline that covers the body, and ONE
 * refresh-and-retry on a lapsed token. The form is rebuilt for the retry
 * rather than resent, because a stream that has been read cannot be.
 *
 * Media upload, dictation and the card scan each carried their own copy of
 * this, and none of the copies agreed: two had no refresh (a dictation after
 * an idle hour was answered "This sign-in has expired. The app will refresh
 * it" and nothing did), and the media upload had no deadline at all, so one
 * hung socket stalled every photograph behind it.
 */
async function authedForm<T>(
  path: string,
  build: () => FormData,
  timeoutMs: number,
  retried = false,
): Promise<T> {
  const token = await accessToken();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          'x-mbos-device': await deviceId(),
          'x-mbos-app-version': versionHeader(),
        },
        body: build(),
        signal: controller.signal,
      });
    } catch {
      throw new NoAnswerError(controller.signal.aborted ? 'timeout' : 'offline');
    }
    if (res.status === 401 && !retried) {
      const refreshed = await tryRefresh();
      if (refreshed === 'ok') return await authedForm<T>(path, build, timeoutMs, true);
      if (refreshed === 'unreachable') throw new NoAnswerError('offline');
      throw await lost('expired');
    }
    if (!res.ok) return await refusal(res, true);
    try {
      return (await res.json()) as T;
    } catch {
      throw new NoAnswerError(controller.signal.aborted ? 'timeout' : 'offline');
    }
  } finally {
    clearTimeout(timeout);
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
    /* The server builds the whole book before it sends a byte, so the time to
       the first byte IS the time to build a large book — routinely past the
       twenty seconds a record gets. At twenty, a big territory could never
       sign in at all, and the timeout was reported as "no internet". */
    timeoutMs: 120_000,
    /* `platform` and `appVersion` have been accepted by the login since MBOS
       shipped and were never sent, so `mbos_devices` recorded neither for any
       handset — and those are the two columns somebody reaches for the moment
       something is wrong in the field. See `buildLabel`. */
    body: JSON.stringify({
      ...args,
      deviceId: await deviceId(),
      deviceLabel: await deviceLabel(),
      platform: Platform.OS,
      appVersion: buildLabel(),
    }),
  });
}

/**
 * Sends a sign-in code on WhatsApp to the work number on this account. The
 * code is then posted to `login` as `otp` in place of the password.
 */
export async function requestOtp(mobile: string): Promise<{ ok: boolean; sentTo: string; expiresInMinutes: number }> {
  return request('/api/mbos/auth/otp', { method: 'POST', auth: false, body: JSON.stringify({ mobile }) });
}

/** Whether the server can send codes at all — the sign-in screen asks before drawing the option. */
export async function otpAvailable(): Promise<boolean> {
  const r = await request<{ available: boolean }>('/api/mbos/auth/otp', { method: 'GET', auth: false });
  return Boolean(r?.available);
}

/* -------------------------------------------------------------- bootstrap */

/**
 * WHY THE BOOK IS THE SIZE IT IS.
 *
 * Optional like every channel — an older server does not send it, and the app
 * has to go on working against one. Absent is read as "the office has not told
 * us", which draws the ordinary empty state rather than accusing anybody of
 * forgetting a territory.
 */
export type TerritoryState = {
  allocated: boolean;
  exempt: boolean;
  places: string[];
  /**
   * Where a lead may be raised — see `src/lib/mbos/types.ts`. Absent from an
   * older server, which the lead form reads as "no rule to apply here" rather
   * than as "nowhere": refusing every lead because a field did not arrive is
   * the wire failing silently in the worst direction.
   */
  areas?: { kind: string; value: string; parent: string | null }[];
};

export type PullPayload = {
  cursor?: string;
  territory?: TerritoryState;
  config?: Record<string, unknown>;
  customers?: unknown[];
  products?: unknown[];
  priceList?: unknown[];
  schemes?: unknown[];
  timeline?: unknown[];
  journeyStops?: unknown[];
  tasks?: unknown[];
  samples?: unknown[];
  /** The office's order history, ten per customer. */
  customerOrders?: unknown[];
  /** Every receipt inside the statement window — see `statementFrom`. */
  customerPayments?: unknown[];
  /** Every bill inside the statement window, settled ones included, each
      carrying what was on it. Optional like every other channel: an older
      server simply does not send it. */
  customerBills?: unknown[];
  /**
   * The oldest day the two channels above reach back to, `YYYY-MM-DD`.
   *
   * The handset prunes on it, so it has to be the SERVER's boundary and not a
   * second calculation of one: the office decides the window
   * (`mbos.sync.statementMonths`), and a phone working it out for itself would
   * delete rows the office had just sent or keep rows it had stopped sending,
   * with nothing on either side looking wrong. Absent from an older server,
   * which prunes nothing.
   */
  statementFrom?: string;
  /**
   * THE WHOLE BOOK AS IDS — what this handset is allowed to hold.
   *
   * `applyPull` drops every local customer that is not in here. See
   * `reconcileBook`, which is where the difference between ABSENT and EMPTY
   * is enforced: undefined is an older server that does not speak this and
   * must change nothing, `[]` is this server saying the book is empty.
   */
  bookIds?: string[];
  leads?: unknown[];
  /**
   * §8 and §5.2 — the office's own call to the shop, and every check anybody
   * has made on one of the nine findings.
   *
   * Optional like every channel here: an older server sends neither and the
   * screens draw what this phone happens to hold. Both are applied AFTER
   * `leads`, so a call or a check can never land against a lead the same pull
   * was in the middle of introducing.
   */
  leadValidations?: unknown[];
  leadFieldChecks?: unknown[];
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
  /** His own field orders as the office stands on them — status, reason, lines. */
  myOrders?: unknown[];
  /** Changes he asked for on approved orders, and their answers. */
  orderChanges?: unknown[];
  /** What he said about his allocated areas, and the office's answer. */
  territoryRequests?: unknown[];
  /** His own month, scored by the office. Reference only — nothing here writes it. */
  performance?: unknown[];
  /**
   * His customers' monthly targets, this month and last — target, achieved,
   * and what is waiting for approval. Replaced wholesale; ABSENT changes
   * nothing, which is how an older server and the cursorless reply look.
   */
  customerTargets?: unknown[];
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

/**
 * The whole book again, on the token the phone already holds — taken by the
 * sync loop when the installed build differs from the one that last took it
 * (`engines/rebootstrap.ts`). It runs behind the screen on whatever signal
 * there is, so it gets far longer than the twenty seconds a request the
 * salesman is waiting on is allowed; the route itself allows 120.
 */
export async function bootstrap(): Promise<PullPayload> {
  return request('/api/mbos/bootstrap', { method: 'GET', timeoutMs: 90_000 });
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
    /* The route is allowed five minutes, and its own comment says a fifty-item
       batch is not a ten-second job. Giving up at twenty abandoned batches the
       server went on to save, and the resend then came back "duplicate". */
    timeoutMs: 120_000,
  });
}

/* ------------------------------------------------------------------ media */

/**
 * A file on the phone, as a FormData part `expo/fetch` can send.
 *
 * SDK 57 replaced the global `fetch` with `expo/fetch`, and that one cannot
 * send React Native's `{ uri, name, type }` file literal — `convertFormData`
 * throws "Unsupported FormDataPart implementation" on it, which is what every
 * photo and every dictation hit after the upgrade. It accepts any part with a
 * `bytes()` and keeps its `name` and `type` as the filename and content type,
 * so the server receives exactly what it did before. The bytes are read when
 * the request is built, not when the form is.
 */
function filePart(uri: string, name: string, type: string): Blob {
  return {
    name,
    type,
    bytes: async () => new Uint8Array(await new File(uri).arrayBuffer()),
  } as unknown as Blob;
}

export async function uploadMedia(args: {
  clientId: string;
  parentType: string;
  parentId: string;
  kind: string;
  uri: string;
  mimeType: string;
}): Promise<{ remoteRef: string }> {
  const out = await authedForm<{ remoteRef?: string; attachmentId?: string }>(
    '/api/mbos/media',
    () => {
      const form = new FormData();
      form.append('clientId', args.clientId);
      form.append('parentType', args.parentType);
      form.append('parentId', args.parentId);
      form.append('kind', args.kind);
      form.append('file', filePart(args.uri, `${args.clientId}.${args.mimeType.split('/')[1] ?? 'bin'}`, args.mimeType));
      return form;
    },
    /* A photograph up a 2G link takes a while; a socket that never answers
       must not hold the whole media queue for ever. */
    120_000,
  );
  /* The server names the stored file `attachmentId`; `remoteRef` was read
     here and never sent, so every queue row recorded `undefined`. */
  return { remoteRef: out.remoteRef ?? out.attachmentId ?? args.clientId };
}

/* -------------------------------------------------------------- dictation */

export type DictationHeard = {
  ok: true;
  /** The faithful English. Not a summary — that is a button somebody presses. */
  english: string;
  /** What was said, in the language it was said in. */
  spoken: string;
  language: string | null;
};

/**
 * Speech in, an English note back, and NOTHING queued.
 *
 * Every other write in this app goes through the outbox because a record has
 * to survive having no signal. This one deliberately does not: its whole point
 * is that the salesman READS what came back before it reaches a form, and a
 * dictation that arrived tomorrow would be a note nobody checked. So it fails
 * where there is no connection, and the mic says so rather than pretending.
 *
 * A longer ceiling than `request`'s twenty seconds. That one is sized for a
 * record going up; this is a minute of audio going up a village link and two
 * provider calls at the far end, and giving up at twenty seconds would fail
 * the recordings that most needed to be spoken rather than typed.
 */
export async function dictateTranscribe(args: {
  uri: string;
  /** Recorded seconds — PAUSED time excluded. The server routes on it. */
  seconds: number;
}): Promise<DictationHeard | { ok: false; error: string }> {
  try {
    const body = await authedForm<DictationHeard | { ok: false; error?: string }>(
      '/api/mbos/dictate/transcribe',
      () => {
        const form = new FormData();
        /* The name is cosmetic — the server sniffs the bytes. */
        form.append('audio', filePart(args.uri, 'dictation.m4a', 'audio/m4a'));
        form.append('seconds', String(Math.round(args.seconds)));
        return form;
      },
      90_000,
    );
    if (!body || !body.ok) {
      return { ok: false, error: (body as { error?: string } | null)?.error ?? 'No answer came back. Try recording again.' };
    }
    return body;
  } catch (e) {
    /* The server's own sentence, every time it sent one. It knows which of the
       six things went wrong and each one sends the person somewhere different;
       a generic message here would throw all of that away. */
    if (e instanceof NoAnswerError) {
      return {
        ok: false,
        error:
          e.kind === 'timeout'
            ? 'That took too long to send. Your recording is still here. Try again.'
            : 'No internet. Type the note instead.',
      };
    }
    return { ok: false, error: e instanceof Error && e.message ? e.message : 'No answer came back. Try recording again.' };
  }
}

export async function dictateRefine(args: {
  text: string;
  mode: 'tighten' | 'rewrite';
  instruction?: string;
}): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    const out = await request<{ ok: true; text: string }>('/api/mbos/dictate/refine', {
      method: 'POST',
      body: JSON.stringify(args),
    });
    return out;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'No answer came back. Try again.' };
  }
}

/* ---------------------------------------------------------- visit assistant */

/**
 * Read what he said about the visit and propose what it implies.
 *
 * NOT QUEUED, for the reason dictation is not: a proposal is only worth
 * anything while he is still standing in the shop reading it. So it fails
 * without signal, says so, and the visit is filled by hand exactly as before.
 *
 * The analysis is typed on this side in `engines/visit-assist.ts` — the
 * server's shape, restated, because the two cannot import each other.
 */
export async function visitAssist(args: {
  customerId: string;
  spoken: string;
  english: string;
  typedNote: string;
  language: string | null;
  heardBy: 'sarvam' | 'openai' | 'typed' | 'dictated';
}): Promise<
  | { ok: true; draftId: string; analysis: import('../engines/visit-assist').VisitAnalysis }
  | { ok: false; error: string }
> {
  try {
    return await request('/api/mbos/visit-assist', {
      method: 'POST',
      body: JSON.stringify(args),
      /* Two provider calls at the far end, each allowed forty-five seconds. */
      timeoutMs: 60_000,
    });
  } catch (e) {
    return {
      ok: false,
      error:
        e instanceof Error && e.message
          ? e.message
          : 'The assistant did not answer. Fill the visit as usual.',
    };
  }
}

/**
 * What MahekOne read off a visiting card, shop board or bill head — the
 * server's `LeadScanResult`, restated, because the two cannot import each
 * other. Every field may be null; none is a guess.
 */
export type LeadScanFound = {
  businessName: string | null;
  contactPerson: string | null;
  mobile: string | null;
  otherNumbers: string[];
  city: string | null;
  state: string | null;
  address: string | null;
  gstin: string | null;
  gstinCheck: 'valid' | 'corrected' | 'invalid' | null;
  note: string | null;
};

/**
 * Photographs in, the New lead form's details back, and NOTHING queued or
 * kept — the photos are read and dropped at the far end. Not queued for the
 * reason dictation is not: the answer is only worth anything while he is still
 * holding the card, so it fails without signal and he types instead.
 *
 * The uris are files this phone has already resized and compressed.
 */
export async function scanLead(
  uris: string[],
): Promise<({ ok: true } & LeadScanFound) | { ok: false; error: string }> {
  try {
    const body = await authedForm<({ ok: true } & LeadScanFound) | { ok: false; error?: string }>(
      '/api/mbos/lead-scan',
      () => {
        const form = new FormData();
        /* The names are cosmetic — the server sniffs the bytes. */
        uris.forEach((uri, i) => form.append('image', filePart(uri, `scan-${i + 1}.jpg`, 'image/jpeg')));
        return form;
      },
      90_000,
    );
    if (!body || !body.ok) {
      return { ok: false, error: (body as { error?: string } | null)?.error ?? 'No answer came back. Try again, or type the details.' };
    }
    return body;
  } catch (e) {
    if (e instanceof NoAnswerError) {
      return {
        ok: false,
        error:
          e.kind === 'timeout'
            ? 'That took too long to send. Your photos are still here. Try again.'
            : 'No internet. Type the details instead.',
      };
    }
    return { ok: false, error: e instanceof Error && e.message ? e.message : 'No answer came back. Try again, or type the details.' };
  }
}

/**
 * What MahekOne heard in a salesman's description of a shop — every answer on
 * the New lead form it could place, for him to check. See
 * `components/leads/lead-voice.tsx`.
 *
 * NOT QUEUED, for the card scan's reason: the answer is only worth anything
 * while the form is open. The TEXT goes, not the recording — the dictation
 * sheet has already turned his voice into words he has read and corrected.
 */
export async function leadVoice(args: {
  text: string;
  spoken: string;
}): Promise<({ ok: true } & import('../engines/lead-voice').LeadVoiceFound) | { ok: false; error: string }> {
  try {
    return await request('/api/mbos/lead-voice', {
      method: 'POST',
      body: JSON.stringify(args),
      /* One model call at the far end, and a second if the first does not answer. */
      timeoutMs: 100_000,
    });
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error && e.message ? e.message : 'No answer came back. Try again, or type the details.',
    };
  }
}

/**
 * What to offer on the order form: this shop's usual products, from the
 * office's whole order history, and the best sellers to start a new shop from.
 *
 * NOT QUEUED: it is a suggestion, worth something only while the form is open.
 * `data/order-suggestions.ts` keeps the last answer per shop, so a counter this
 * phone has served before is offered the same list with no signal.
 */
export async function orderProducts(customerId: string): Promise<
  | {
      ok: true;
      usual: { productId: string; orderCount: number; lastPurchaseDate: string | null }[];
      starter: string[];
    }
  | { ok: false; error: string }
> {
  try {
    return await request('/api/mbos/order-products', {
      method: 'POST',
      body: JSON.stringify({ customerId }),
      timeoutMs: 15_000,
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.message ? e.message : 'No answer.' };
  }
}

/* -------------------------------------------------------- customer account */

/**
 * One customer's whole account as the Accounts app holds it — statement,
 * bills, receipts and where they went, aging, credit notes.
 *
 * NOT QUEUED: it is a reading. `data/customer-account.ts` keeps the last
 * answer per shop and falls back on the thirteen months the pull carries, so
 * an account opened with no signal still says something true — and says which
 * one it is.
 */
export async function customerAccount(
  customerId: string,
): Promise<{ ok: true; account: unknown } | { ok: false; error: string }> {
  try {
    return await request('/api/mbos/customer-account', {
      method: 'POST',
      body: JSON.stringify({ customerId }),
      /* A long-standing account is a few thousand rows read on the far side. */
      timeoutMs: 30_000,
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.message ? e.message : 'No answer.' };
  }
}

/* ------------------------------------------------------------- performance */

/**
 * His own performance over a range the sync does not carry — a quarter, a
 * financial year, days he picked.
 *
 * NOT QUEUED and not cached: it is a reading, the answer is only wanted while
 * he is looking at it, and the two months the sync does carry are what the
 * screen falls back on without signal. The server decides WHOSE figures from
 * the device token, so there is no user to pass.
 */
export async function performanceForRange(
  from: string,
  to: string,
): Promise<{ ok: true; reading: unknown } | { ok: false; error: string }> {
  try {
    return await request(
      `/api/mbos/performance?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      /* A year of the ledger is read on the far side. */
      { method: 'GET', timeoutMs: 45_000 },
    );
  } catch (e) {
    /* A server from before this route answers 404 with a page, not a sentence. */
    if (e instanceof ApiError && e.status === 404) {
      return { ok: false, error: 'MahekOne has not been updated for this yet.' };
    }
    return {
      ok: false,
      error: e instanceof Error && e.message ? e.message : 'No connection to MahekOne',
    };
  }
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
): Promise<{
  ok: boolean;
  stored: number;
  /**
   * How many of the batch the server could NOT file. Informational: `tracking`
   * is the only field anything branches on, so a count that disagrees with the
   * word cannot change what the handset does with the rows.
   */
  dropped?: number;
  /** `'off' | 'no-session-yet' | 'partial'`, or absent for a clean delivery. */
  tracking?: string;
  /**
   * On `partial` only: the ids THIS CALL IS FINISHED WITH.
   *
   * Not "the ids now in the table" — it deliberately includes rows that can
   * never be stored, a coordinate that is not a number among them, because
   * holding those back would have the handset re-read the same oldest five
   * hundred for ever. The shape is ids-that-landed rather than ids-to-keep so
   * that a server forgetting to name one costs a round trip instead of a fix.
   */
  filed?: string[];
}> {
  /*
   * THE BATTERY RIDES THIS REQUEST, because this request is already going.
   *
   * A flat phone is the commonest reason a trail simply stops mid-beat, and
   * it is the one cause a manager can still do something about while the day
   * is running. Reporting it needs no channel of its own: this batch runs
   * every few minutes while a day is open, is already authenticated and
   * already names the device. A poller would spend the battery to report it.
   *
   * It goes as a SIBLING of the array and never inside a position. A
   * position's id is derived from its own reading (`at|lat|lng`), which is
   * what makes a redelivered batch deduplicate — folding device state into a
   * fix would put a changing value inside a key that must not change.
   *
   * The state can never fail the flush: a caught reading simply sends no such
   * field, and the office reads an absent field as "not reported" rather than
   * as an answer.
   */
  const state = await readDeviceState().catch(() => ({}));
  return request('/api/mbos/positions', {
    method: 'POST',
    body: JSON.stringify({ positions, deviceId: await deviceId(), ...state }),
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
 *
 * IT SENDS MORE THAN THE BOOLEAN NOW, and the boolean is still first.
 *
 * `backgroundGranted` alone could not tell "Allow only while using the app"
 * from "refused outright", nor either of those from the phone's own location
 * switch being off — three different conversations to have with a salesman,
 * drawn identically in the office. The richer fields ride the same request
 * because the server treats a missing one as "not reported" rather than as an
 * answer, so an older handset posting only the boolean goes on working
 * exactly as it did.
 *
 * The boolean is NOT derived from the richer answer at this end. The server
 * still reads it, every handset in the field still sends it, and computing it
 * here from `locationPermission` would make one report two statements that
 * could disagree.
 */
export async function reportLocationPermission(backgroundGranted: boolean): Promise<{ ok: boolean }> {
  /* Never allowed to cost the report: a failed reading omits its field. */
  const state = await readDeviceState().catch(() => ({}));
  return request('/api/mbos/location-permission', {
    method: 'POST',
    body: JSON.stringify({ backgroundGranted, ...state }),
  });
}
