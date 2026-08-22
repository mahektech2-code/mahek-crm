import { getSecret, setSecret } from '../native/secure';
import * as Crypto from 'expo-crypto';
import { getKv, setKv } from '../db';
import * as api from '../sync/api';
import { ApiError } from '../sync/api';
import { applyPull } from '../sync/pull';

/**
 * Signing in.
 *
 * The five checks the design shows are real, and they happen server-side in
 * this order: the mobile exists, the credential is right, **the employee is
 * Active**, a territory is assigned, and the day's payload loads. Each is a
 * different answer for the person holding the phone, which is why the screen
 * names the step rather than showing one spinner and one eventual failure.
 */

const SESSION_KEY = 'mbos.session';
const OFFLINE_HASH_KEY = 'mbos.offlineHash';
const LAST_ONLINE_KEY = 'mbos.lastOnlineAuthAt';

export type Session = {
  user: api.SessionUser;
  signedInAt: number;
};

export type LoginStep = 'mobile' | 'credential' | 'status' | 'territory' | 'payload';

export type LoginOutcome =
  | { ok: true; session: Session; offline: boolean }
  | { ok: false; step: LoginStep; message: string };

export async function currentSession(): Promise<Session | null> {
  const raw = await getKv(SESSION_KEY);
  return raw ? (JSON.parse(raw) as Session) : null;
}

async function persist(session: Session): Promise<void> {
  await setKv(SESSION_KEY, JSON.stringify(session));
}

/* ------------------------------------------------------------ online path */

export async function signIn(args: {
  mobile: string;
  password?: string;
  otp?: string;
  onStep?: (step: LoginStep) => void;
}): Promise<LoginOutcome> {
  args.onStep?.('mobile');

  try {
    const out = await api.login({ mobile: args.mobile, password: args.password, otp: args.otp });
    args.onStep?.('credential');

    await api.setTokens(out.accessToken, out.refreshToken);

    args.onStep?.('status');
    args.onStep?.('territory');

    const session: Session = { user: out.bootstrap.user, signedInAt: Date.now() };
    await persist(session);

    /* What makes the NEXT sign-in possible without signal. Only the hash is
       kept, and only after the server has actually accepted the password —
       so the offline path can never be a way in that the online path refuses. */
    if (args.password) await rememberForOffline(args.mobile, args.password);
    await setKv(LAST_ONLINE_KEY, String(Date.now()));

    /* The payload came back with the token — applying it here is what makes
       the book, the catalogue and the configuration real before the first
       screen renders. */
    args.onStep?.('payload');
    await applyPull(out.bootstrap);

    return { ok: true, session, offline: false };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Could not sign in';

    /*
     * A server that answered and refused is a real refusal — do not fall back
     * to the cache and let somebody in that MahekOne just turned away.
     *
     * That rule was written here and then defeated by how it was tested for.
     * The check was a regex over the refusal's English, so it recognised only
     * the sentences containing "inactive" or "territory"; `unknown_user`,
     * `device_bound` and `bootstrap_failed` all fell past it into the offline
     * path, where a cached password inside the seven-day window signs the
     * person in. An `ApiError` is by definition an answer, so ANY of them
     * stops here now, and the server's own `step` says which field to put it
     * against rather than being guessed at from prose.
     */
    if (e instanceof ApiError) {
      const step: LoginStep =
        e.step === 'inactive' || e.step === 'bootstrap_failed' || e.step === 'not_configured'
          ? 'status'
          : e.step === 'no_app_access'
            ? 'territory'
            : e.step === 'bad_password'
              ? 'credential'
              : 'mobile';
      return { ok: false, step, message };
    }

    /* No answer at all — try the offline path. */
    if (args.password) return signInOffline(args.mobile, args.password);
    return { ok: false, step: 'mobile', message };
  }
}

/* ----------------------------------------------------------- offline path */

async function rememberForOffline(mobile: string, password: string): Promise<void> {
  const salt = Crypto.randomUUID();
  const hash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, salt + mobile + password);
  await setSecret(OFFLINE_HASH_KEY, JSON.stringify({ salt, hash, mobile }));
}

/**
 * Signing in with no signal, against the credential cached last time.
 *
 * Bounded on purpose. Without a window, an employee terminated on Monday keeps
 * working out of the cache indefinitely — and the whole point of the status
 * check is that it is checked. Seven days by default, and it is configuration,
 * because the trade between convenience and exposure is a business decision.
 */
async function signInOffline(mobile: string, password: string): Promise<LoginOutcome> {
  const raw = await getSecret(OFFLINE_HASH_KEY);
  const session = await currentSession();

  if (!raw || !session) {
    return { ok: false, step: 'mobile', message: 'No connection, and this phone has not signed in before.' };
  }

  const stored = JSON.parse(raw) as { salt: string; hash: string; mobile: string };
  if (stored.mobile !== mobile.trim()) {
    return { ok: false, step: 'mobile', message: 'No connection. Only the last person to sign in on this phone can sign in offline.' };
  }

  const attempt = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, stored.salt + mobile + password);
  if (attempt !== stored.hash) {
    return { ok: false, step: 'credential', message: 'That password does not match the one used last time on this phone.' };
  }

  const lastOnline = Number((await getKv(LAST_ONLINE_KEY)) ?? 0);
  const validityDays = await offlineValidityDays();
  const ageDays = (Date.now() - lastOnline) / 86_400_000;

  if (ageDays > validityDays) {
    return {
      ok: false,
      step: 'status',
      message: `This phone has been offline for ${Math.floor(ageDays)} days. Find signal once to sign in again.`,
    };
  }

  const refreshed: Session = { ...session, signedInAt: Date.now() };
  await persist(refreshed);
  return { ok: true, session: refreshed, offline: true };
}

async function offlineValidityDays(): Promise<number> {
  const { getConfig } = await import('./config');
  return getConfig<number>('mbos.sync.offlineLoginValidityDays', 7);
}

/* ---------------------------------------------------------------- signing out */

/**
 * Signing out keeps the outbox.
 *
 * The design says four records have not been sent yet and that they stay on
 * this phone — clearing the store here would make that sentence a lie, and the
 * work is genuinely unrecoverable once gone.
 */
export async function signOut(): Promise<void> {
  await api.clearTokens();
  await setKv(SESSION_KEY, '');
}

export async function isSignedIn(): Promise<boolean> {
  const raw = await getKv(SESSION_KEY);
  return !!raw && raw !== '';
}
