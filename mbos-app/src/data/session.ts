import { deleteSecret, getSecret, setSecret } from '../native/secure';
import * as Crypto from 'expo-crypto';
import { all, getKv, one, run, setKv } from '../db';
import * as api from '../sync/api';
import { ApiError, NoAnswerError } from '../sync/api';
import { applyPull } from '../sync/pull';
import { retryItem } from '../sync/queue';
import { cancelPunchOutReminders } from '../native/punch-out-reminder';
import { buildLabel } from '../native/updates';
import {
  DEVICE_KV_KEYS,
  handoverRefusal,
  handoverVerdict,
  loginStepFor,
  offlineWindow,
  type LoginStep,
} from '../engines/sign-in';

export type { LoginStep } from '../engines/sign-in';

/**
 * Signing in, and signing out.
 *
 * The server runs its checks in order — the mobile exists, the credential is
 * right, the employee is Active, the field app is granted, and the day's
 * payload builds — and answers once, at the end. So the screen can honestly
 * say only two things while it waits: MahekOne is checking, and the book is
 * being saved on this phone. A refusal names the check it fell at.
 */

const SESSION_KEY = 'mbos.session';
const OFFLINE_HASH_KEY = 'mbos.offlineHash';
const LAST_ONLINE_KEY = 'mbos.lastOnlineAuthAt';
/**
 * The build that last applied a full snapshot — read by the sync loop, which
 * takes the snapshot again when the installed build differs. See
 * `engines/rebootstrap.ts`.
 */
export const BOOTSTRAPPED_BUILD_KEY = 'mbos.bootstrappedBuild';

/**
 * What a snapshot leaves behind besides its rows, written in ONE place for
 * both doors that apply one — signing in, and the sync loop after an upgrade.
 *
 * THE CURSOR IS THE SNAPSHOT'S OWN. Sign-in used to apply the book and leave
 * `pullCursor` alone, so the first pass after it sent whatever cursor was
 * already there: empty on a first install, which the server answers with
 * nothing and a fresh "now" — losing every change made between the snapshot
 * and that first pass — and on a phone handed from one salesman to another,
 * the LAST person's cursor, so the new one's deltas started from a moment
 * that had nothing to do with his book.
 */
export async function markBootstrapped(cursor: string | undefined): Promise<void> {
  if (cursor) await setKv('pullCursor', cursor);
  await setKv(BOOTSTRAPPED_BUILD_KEY, buildLabel());
}

/**
 * The person as the office now describes him — a name corrected, a manager
 * changed, a role widened — written over the stored session after a snapshot.
 * Only ever the SAME person: a token cannot change hands, and a snapshot that
 * somehow named somebody else is not one to sign the phone over to.
 */
export async function refreshSessionUser(user: api.SessionUser | undefined): Promise<void> {
  const session = await currentSession();
  if (!session || !user || user.id !== session.user.id) return;
  await persist({ ...session, user });
}

/**
 * WHO USED THIS PHONE LAST — kept across a sign-out, deliberately.
 *
 * Two rules need it after the session has gone: a different person may not
 * sign in while the last person's work is still waiting to send (see
 * `handoverVerdict`), and the last person may sign back in without signal.
 */
const LAST_USER_KEY = 'mbos.lastUser';

/** How many times the offline credential is hashed. A keychain copy should
    not be a password a laptop recovers in a second. */
const OFFLINE_ROUNDS = 2000;

export type Session = {
  user: api.SessionUser;
  signedInAt: number;
};

type LastUser = { userId: string; mobile: string; name: string };

export type LoginOutcome =
  | { ok: true; session: Session; offline: boolean }
  | { ok: false; step: LoginStep; message: string };

export async function currentSession(): Promise<Session | null> {
  const raw = await getKv(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

async function persist(session: Session): Promise<void> {
  await setKv(SESSION_KEY, JSON.stringify(session));
}

async function lastUser(): Promise<LastUser | null> {
  const raw = await getKv(LAST_USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LastUser;
  } catch {
    return null;
  }
}

/**
 * Work from this phone that has not reached the office: records still to go
 * and photographs behind them. Refused records are NOT counted — the office
 * has already answered them, and counting them would hold the phone hostage to
 * a refusal nobody can clear.
 */
async function unsentWork(): Promise<number> {
  const records = await one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sync_queue WHERE state IN ('queued','syncing','failed','blocked')`,
  );
  const media = await one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM media_queue WHERE state IN ('queued','syncing','failed')`,
  );
  return (records?.n ?? 0) + (media?.n ?? 0);
}

/* ------------------------------------------------------------ online path */

/**
 * ONE SIGN-IN AT A TIME, whatever the screen does.
 *
 * Cancel on the sign-in screen cannot recall a request, and a second attempt
 * started after it used to run alongside the first — two bootstraps into one
 * SQLite database, and whichever finished last persisting its session over
 * the other's tokens. The screen's guard stops it reacting to a stale answer;
 * this stops the stale attempt WRITING anything.
 */
let inFlight: Promise<unknown> | null = null;

export async function signIn(args: {
  mobile: string;
  password?: string;
  otp?: string;
  /**
   * Whether this phone may sign him in again without signal. Absent means
   * yes, which is what every caller before the switch was read meant.
   */
  remember?: boolean;
  onStep?: (step: LoginStep) => void;
  /** True once the person has pressed Cancel: nothing more is written. */
  cancelled?: () => boolean;
}): Promise<LoginOutcome> {
  while (inFlight) {
    await inFlight.catch(() => undefined);
  }
  const attempt = signInOnce(args);
  inFlight = attempt;
  try {
    return await attempt;
  } finally {
    if (inFlight === attempt) inFlight = null;
  }
}

const CANCELLED: LoginOutcome = { ok: false, step: 'mobile', message: '' };

async function signInOnce(args: Parameters<typeof signIn>[0]): Promise<LoginOutcome> {
  const stopped = () => args.cancelled?.() === true;
  args.onStep?.('mobile');

  /*
   * A DIFFERENT PERSON ON THIS PHONE, asked before the server is.
   *
   * Asking the server first re-binds the handset to the new person, and then
   * the last person could not get back in to send what they left behind.
   */
  const previous = await lastUser();
  const before = handoverVerdict({ last: previous, mobile: args.mobile, unsent: await unsentWork() });
  if (before.kind === 'refuse') {
    return { ok: false, step: 'status', message: handoverRefusal(before.unsent, before.lastName) };
  }

  let out: Awaited<ReturnType<typeof api.login>>;
  try {
    out = await api.login({ mobile: args.mobile, password: args.password, otp: args.otp });
  } catch (e) {
    /*
     * A server that answered and refused is a real refusal — do not fall back
     * to the cache and let somebody in that MahekOne just turned away. An
     * `ApiError` is by definition an answer, so ANY of them stops here, and
     * the server's own `step` says where on the screen it belongs.
     */
    if (e instanceof ApiError) {
      return { ok: false, step: loginStepFor(e.step), message: e.message };
    }
    /*
     * A SLOW SERVER IS NOT NO SIGNAL. The request reached MahekOne and it did
     * not finish in time — usually because the book is large — so the offline
     * cache is the wrong answer and "no internet" is the wrong sentence.
     */
    if (e instanceof NoAnswerError && e.kind === 'timeout') {
      return { ok: false, step: 'network', message: e.message };
    }
    /* No answer at all — the offline path, where it applies. */
    if (args.password && !stopped()) return signInOffline(args.mobile, args.password);
    return {
      ok: false,
      step: 'network',
      message: e instanceof Error && e.message ? e.message : 'No internet. Could not reach MahekOne.',
    };
  }
  if (stopped()) return CANCELLED;

  /* The server names the account, which settles a sign-in by email or a
     number written two ways. */
  const after = handoverVerdict({ last: previous, userId: out.bootstrap.user.id, unsent: await unsentWork() });
  if (after.kind === 'refuse') {
    return { ok: false, step: 'status', message: handoverRefusal(after.unsent, after.lastName) };
  }

  args.onStep?.('payload');
  try {
    if (after.kind === 'new-person-clean') await forgetLastPerson();
    await api.setTokens(out.accessToken, out.refreshToken);
    if (stopped()) {
      await api.clearTokens();
      return CANCELLED;
    }

    /* The payload came back with the token — applying it here is what makes
       the book, the catalogue and the configuration real before the first
       screen renders. */
    await applyPull(out.bootstrap);

    /*
     * THE BOOTSTRAP'S CURSOR IS WHERE THE NEXT PULL STARTS.
     *
     * It was never stored, so the first sync after a fresh sign-in sent an
     * empty cursor — whose answer is "nothing changed, here is now" and an
     * expense policy of null, which deleted the policy the bootstrap had just
     * delivered, and skipped everything the office changed in between.
     */
    if (out.bootstrap.cursor) await setKv('pullCursor', out.bootstrap.cursor);
    await api.markPulled();
  } catch (e) {
    /*
     * STORAGE SAID NO, and that is not the same as the network saying
     * nothing. Every step here is the phone's own — the keychain, the
     * database, the kv — so a failure here is reported as one. It used to fall
     * into the offline path, which SUCCEEDED, and signed him in against an
     * empty database with nothing on the screen saying so.
     */
    return {
      ok: false,
      step: 'payload',
      message:
        e instanceof Error && e.message
          ? `Signed in, but your data could not be saved on this phone: ${e.message}`
          : 'Signed in, but your data could not be saved on this phone.',
    };
  }

  /*
   * NOTHING IS WRITTEN DOWN UNTIL THE BOOK IS. A session is the record that a
   * sign-in COMPLETED; written before `applyPull`, a payload that threw left
   * one behind, and the next cold start opened Home on an empty book with no
   * way back to the form.
   */
  const session: Session = { user: out.bootstrap.user, signedInAt: Date.now() };
  try {
    await persist(session);
    await markBootstrapped(out.bootstrap.cursor);
    await setKv(
      LAST_USER_KEY,
      JSON.stringify({ userId: session.user.id, mobile: args.mobile.trim(), name: session.user.name } satisfies LastUser),
    );

    /* What makes the NEXT sign-in possible without signal. Only the hash is
       kept, and only after the server has accepted the credential. Where he
       has asked us not to — or signed in with a code, which leaves no password
       to check later — any hash an earlier sign-in left goes with it. */
    if (args.password && args.remember !== false) {
      await rememberForOffline(session.user.id, args.mobile, args.password);
    } else if (args.remember === false) {
      await deleteSecret(OFFLINE_HASH_KEY);
    }
    await setKv(LAST_ONLINE_KEY, String(Date.now()));
    await api.clearAuthLost();
  } catch (e) {
    return {
      ok: false,
      step: 'payload',
      message:
        e instanceof Error && e.message
          ? `Signed in, but this phone could not remember it: ${e.message}`
          : 'Signed in, but this phone could not remember it.',
    };
  }

  /* Back in after being signed out mid-day: what could not go up for want
     of a sign-in goes up now, rather than waiting three hours for the
     automatic retry. */
  if (after.kind === 'same-person') await requeueAuthFailures().catch(() => undefined);

  return { ok: true, session, offline: false };
}

/**
 * The last person's day, taken off this phone before a different person's is
 * put on it. Every table but `kv` is emptied, and `kv` keeps only what belongs
 * to the handset itself. Only reached when nothing of theirs is waiting to
 * send — `handoverVerdict` refuses otherwise.
 */
async function forgetLastPerson(): Promise<void> {
  const tables = await all<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'kv' AND name NOT LIKE 'sqlite_%'`,
  );
  for (const t of tables) await run(`DELETE FROM "${t.name}"`);
  const keep = DEVICE_KV_KEYS.map(() => '?').join(',');
  await run(`DELETE FROM kv WHERE key NOT IN (${keep})`, [...DEVICE_KV_KEYS]);
  await deleteSecret(OFFLINE_HASH_KEY);
}

/** Records that failed because the session had gone, sent again now that it is back. */
async function requeueAuthFailures(): Promise<void> {
  const stuck = await all<{ id: string }>(`SELECT id FROM sync_queue WHERE state IN ('failed','blocked')`);
  for (const row of stuck) await retryItem(row.id);
}

/* ----------------------------------------------------------- offline path */

type OfflineRecord = { v: 2; userId: string; mobile: string; salt: string; hash: string; user: api.SessionUser };

async function stretch(salt: string, mobile: string, password: string): Promise<string> {
  let h = salt + mobile.trim() + password;
  for (let i = 0; i < OFFLINE_ROUNDS; i++) {
    h = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, salt + h);
  }
  return h;
}

async function rememberForOffline(userId: string, mobile: string, password: string): Promise<void> {
  const session = await currentSession();
  if (!session) return;
  const salt = Crypto.randomUUID();
  const record: OfflineRecord = {
    v: 2,
    userId,
    mobile: mobile.trim(),
    salt,
    hash: await stretch(salt, mobile, password),
    user: session.user,
  };
  await setSecret(OFFLINE_HASH_KEY, JSON.stringify(record));
}

/**
 * Signing in with no signal, against the credential cached last time.
 *
 * IT COULD NEVER BE REACHED. It needed a stored session, the sign-in screen
 * is only drawn when there is none, and signing out deletes it — so "Remember
 * me" did nothing, and somebody who signed out in a lane with no signal was
 * told "this phone has not signed in before" and locked out. The record now
 * carries the person it belongs to, survives sign-out, and is checked against
 * the account it names rather than against whatever session happens to be
 * lying around.
 *
 * Bounded on purpose: an employee terminated on Monday must not keep working
 * out of the cache indefinitely. Seven days by default, and configuration.
 */
async function signInOffline(mobile: string, password: string): Promise<LoginOutcome> {
  const raw = await getSecret(OFFLINE_HASH_KEY);
  let record: OfflineRecord | null = null;
  try {
    const parsed = raw ? (JSON.parse(raw) as Partial<OfflineRecord>) : null;
    if (parsed && parsed.v === 2 && parsed.user && parsed.userId) record = parsed as OfflineRecord;
  } catch {
    record = null;
  }

  if (!record) {
    return {
      ok: false,
      step: 'network',
      message: 'No internet. You need signal to sign in on this phone the first time. Try again where there is signal.',
    };
  }

  if (record.mobile !== mobile.trim()) {
    return {
      ok: false,
      step: 'network',
      message: 'No internet. Without signal, only the last person who signed in on this phone can sign in.',
    };
  }

  if ((await stretch(record.salt, mobile, password)) !== record.hash) {
    return { ok: false, step: 'credential', message: 'That password does not match the one used last time on this phone.' };
  }

  const window = offlineWindow({
    lastOnlineAt: Number((await getKv(LAST_ONLINE_KEY)) ?? 0),
    now: Date.now(),
    validityDays: await offlineValidityDays(),
  });
  if (!window.ok) {
    return {
      ok: false,
      step: 'network',
      message: `This phone has not reached MahekOne for ${window.ageDays} days. Sign in once with signal.`,
    };
  }

  const session: Session = { user: record.user, signedInAt: Date.now() };
  await persist(session);
  return { ok: true, session, offline: true };
}

async function offlineValidityDays(): Promise<number> {
  const { getConfig } = await import('./config');
  return getConfig<number>('mbos.sync.offlineLoginValidityDays', 7);
}

/**
 * The office's current word on who he is, delivered with every token refresh
 * — the stored session was written once at sign-in and never again, so the
 * Profile screen showed last year's area for as long as he stayed signed in.
 */
api.onUserRefreshed((user) => {
  void (async () => {
    const s = await currentSession();
    if (!s || s.user.id !== user.id) return;
    /* Merged, not replaced: the refresh carries the fields the office can
       change from a desk, and the sign-in may have carried more. */
    await persist({ ...s, user: { ...s.user, ...user } });
  })().catch(() => undefined);
});

/**
 * SETTING A NEW PASSWORD hands over to MahekOne's own reset page.
 *
 * It is the careful flow — only the SHA-256 of the token is stored, it works
 * once, it expires in 30 minutes, and spending it deletes every session — and
 * it offers two ways in: a link to the work email, and a code on WhatsApp to
 * the work number where the office has turned codes on. Building a second
 * flow here would be a new way in to the same accounts for nothing the first
 * one lacks.
 */
export async function openPasswordReset(): Promise<boolean> {
  const { BASE } = await import('../sync/api');
  const { Linking } = await import('react-native');
  try {
    await Linking.openURL(`${BASE.replace(/\/+$/, '')}/login/forgot`);
    return true;
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------- signing out */

/**
 * Signing out, and everything it has to stop.
 *
 * It used to clear the tokens and the session and nothing else — so a salesman
 * who signed out while punched in kept being TRACKED (the location service ran
 * on, and every sync pushed its deadline out again), kept being PUSHED to (the
 * token stayed on the server), and the fixes recorded after he left went up
 * under whoever signed in next. AGENTS.md is explicit that tracking runs
 * between the punch-in and the punch-out and not one second either side.
 *
 * WHAT IT KEEPS: the outbox, and who he was. His unsent work stays on this
 * phone and goes up when HE signs in again; nobody else can sign in while it
 * is waiting (see `handoverVerdict`), so it can never go up as somebody else's.
 */
export async function signOut(): Promise<void> {
  /* Stop the trail while the token is still good, so what it recorded up to
     now goes up as his. `trail.stop()` sends what is left. */
  try {
    const trail = await import('../sync/trail');
    await trail.stop();
  } catch {
    /* A trail that would not stop is released below regardless. */
  }
  try {
    const service = await import('../native/location-service');
    await service.releaseService();
    /* Whatever the native recorder still holds is his day after he left it —
       never to be filed against the next person's token. */
    for (let i = 0; i < 20; i++) {
      const rows = await service.drainFixes(500);
      if (!rows.length) break;
      if (!(await service.forgetFixes(rows.map((r) => r.id)))) break;
    }
  } catch {
    /* Nothing further to try. */
  }
  await run(`DELETE FROM positions`).catch(() => undefined);

  /* Before the tokens go: clearing the push token is a request, and it needs
     the token to be allowed. */
  try {
    const { clearPushToken } = await import('../native/push');
    await clearPushToken();
  } catch {
    /* The server clears a dead token itself the first time Expo refuses it. */
  }

  await api.clearTokens();
  await setKv(SESSION_KEY, '');
  /* The next sign-in brings a whole new book with its own cursor; an old one
     would skip what changed while nobody was signed in. */
  await setKv('pullCursor', '');
  await api.clearAuthLost();
  /* A phone handed back must not buzz its next holder about a day that was
     never theirs. */
  await cancelPunchOutReminders();
}

/**
 * Whether anybody is signed in, asked synchronously by code that must not
 * run for nobody — the sync loop's network listener, which outlives a
 * sign-out. Kept in step by `BootProvider`.
 */
let signedInNow = false;
export function setSessionOpen(on: boolean): void {
  signedInNow = on;
}
export function sessionOpen(): boolean {
  return signedInNow;
}
