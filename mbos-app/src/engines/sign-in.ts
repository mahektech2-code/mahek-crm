/**
 * The decisions behind signing in and out, with no I/O in them.
 *
 * `data/session.ts` imports the keychain, SQLite and the network at module
 * scope, so nothing in it can be exercised without a handset — which is how
 * every one of these rules came to be wrong for months with a green test run.
 * The doing stays there; the deciding is here, where it can be pinned.
 */

/** The answer a sign-in can land on — which part of the screen says it. */
export type LoginStep = 'mobile' | 'credential' | 'status' | 'territory' | 'payload' | 'network';

/**
 * WHERE A REFUSAL IS SHOWN, from the server's own `step`.
 *
 * Only two answers are about the mobile number he typed: no such account,
 * and a request the server could not read. Everything else used to fall
 * through onto the mobile field too — a wrong WhatsApp code drew a red border
 * round a correct number, and "this handset can't be used" read as a typo.
 * A code is a credential; a handset, a closed account or a server that is
 * not set up is a fact no field can answer, so it gets the full-width banner.
 */
export function loginStepFor(serverStep: string | null | undefined): LoginStep {
  switch (serverStep) {
    case 'bad_password':
    case 'bad_otp':
      return 'credential';
    case 'no_app_access':
      return 'territory';
    case 'unknown_user':
    case 'validation':
      return 'mobile';
    case 'server_down':
      return 'network';
    default:
      /* inactive, device_bound, device_released, not_configured,
         bootstrap_failed, and any word this build has not heard of yet. */
      return 'status';
  }
}

/**
 * Which server answers mean THIS SESSION IS OVER, as opposed to "this one
 * request was refused".
 *
 * Each of these is permanent until a person does something: the refresh token
 * expired, an admin released the handset, the account was closed, or the
 * field app was taken away. Every sync after one of them is refused the same
 * way, so carrying on means a queue that burns its retries and a day of work
 * nobody can send — with Home looking perfectly normal the whole time.
 */
export type AuthLostReason = 'expired' | 'device_released' | 'inactive' | 'no_app_access' | 'unknown_user';

export function authLostReasonFor(status: number, code: string | null | undefined): AuthLostReason | null {
  if (status === 403 && (code === 'device_released' || code === 'inactive' || code === 'no_app_access')) {
    return code;
  }
  if (status === 401 && code === 'unknown_user') return 'unknown_user';
  return null;
}

/** What the banner says, by reason. One sentence, and what to do about it. */
export function authLostSentence(reason: AuthLostReason): string {
  switch (reason) {
    case 'expired':
      return 'You have been signed out because this phone was away for too long. Sign in again to send your work.';
    case 'device_released':
      return 'The office has released this phone from your account. Sign in again to send your work.';
    case 'inactive':
      return 'Your account has been closed. Ask your manager. Your work stays on this phone.';
    case 'no_app_access':
      return 'Mahek MBOS has been taken off your account. Ask your manager. Your work stays on this phone.';
    case 'unknown_user':
      return 'This sign-in is no longer valid. Sign in again to send your work.';
  }
}

/**
 * Whether a person may sign in on a phone somebody else used last.
 *
 * Everything a salesman queued goes up under whoever is signed in when it
 * sends, and the office files it against THAT person — so a phone handed to
 * a colleague with yesterday's orders still in it would hand those orders to
 * the colleague. The rule is: a different person may sign in only once the
 * last person's work has reached the office. Refused BEFORE the server is
 * asked, because asking it re-binds the handset to the new person and then
 * the last one could not get back in to send anything.
 */
export type HandoverVerdict =
  | { kind: 'same-person' }
  | { kind: 'first-sign-in' }
  | { kind: 'new-person-clean' }
  | { kind: 'refuse'; unsent: number; lastName: string };

export function handoverVerdict(args: {
  last: { userId: string; mobile: string; name: string } | null;
  /** The mobile typed now, digits only. Null where the identity is known by id. */
  mobile?: string | null;
  /** The account the server just named, where it has. */
  userId?: string | null;
  unsent: number;
}): HandoverVerdict {
  const { last } = args;
  if (!last) return { kind: 'first-sign-in' };
  const same = args.userId != null ? args.userId === last.userId : digits(args.mobile ?? '') === digits(last.mobile);
  if (same) return { kind: 'same-person' };
  if (args.unsent > 0) return { kind: 'refuse', unsent: args.unsent, lastName: last.name };
  return { kind: 'new-person-clean' };
}

export function handoverRefusal(unsent: number, lastName: string): string {
  const what = unsent === 1 ? '1 entry' : `${unsent} entries`;
  return (
    `This phone still has ${what} from ${lastName || 'the last person who signed in'} that ` +
    `${unsent === 1 ? 'has' : 'have'} not reached the office. They must sign in here once, with signal, ` +
    `to send ${unsent === 1 ? 'it' : 'them'} before anyone else can use this phone. If they cannot, ask your manager.`
  );
}

/**
 * The keys that belong to the HANDSET rather than to the person on it — kept
 * when a different person signs in. Everything else in `kv` (the pull cursor,
 * the territory, yesterday's arrival, the last trail mark) is about the last
 * person's day and goes.
 */
export const DEVICE_KV_KEYS: readonly string[] = [
  'mbos.feedback.haptics',
  'mbos.feedback.sounds',
  'mbos.lock.on',
  'setup-walkthrough.shownFor',
  'setup-walkthrough.autostartConfirmedAt',
  'keepalive.askedAt',
  'mbos.permissions.locationAsked',
  'phone-setup.acknowledged',
  'maps.pausedPacks',
  'push.registered',
  'mbos.lastUser',
];

/** Offline sign-in: how long the last online sign-in stays good for. */
export function offlineWindow(args: { lastOnlineAt: number; now: number; validityDays: number }):
  | { ok: true }
  | { ok: false; ageDays: number } {
  const ageDays = (args.now - args.lastOnlineAt) / 86_400_000;
  if (!args.lastOnlineAt || ageDays > args.validityDays) return { ok: false, ageDays: Math.floor(Math.max(ageDays, 0)) };
  return { ok: true };
}

/**
 * How a request that got no answer is described.
 *
 * Today's 1.16.0 outage was this sentence being wrong: every failure that was
 * not a server refusal was called "No internet", including a request the
 * phone itself refused to send and a server that was merely slow. A timeout is
 * MahekOne being slow, not the phone being offline — and saying "no internet"
 * to a salesman with four bars sends him walking round the market for signal.
 */
export function noAnswerSentence(kind: 'offline' | 'timeout'): string {
  return kind === 'timeout'
    ? 'MahekOne is taking too long to answer. Try again in a minute, or where the signal is stronger.'
    : 'No internet. Could not reach MahekOne.';
}

/** A server answer with no sentence of its own, said in words. */
export function unreadableAnswerSentence(status: number): string {
  if (status >= 500) return 'MahekOne is not answering properly right now. Try again in a few minutes.';
  return `MahekOne could not take that (error ${status}). Try again, and tell your manager if it keeps happening.`;
}

function digits(s: string): string {
  return s.replace(/\D/g, '').slice(-10);
}
