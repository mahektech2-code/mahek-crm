import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { AndroidImportance } from 'expo-notifications';
import Constants from 'expo-constants';
import { registerPushToken } from '../sync/api';
import { getConfig } from '../data/config';

/**
 * Reaching a handset that is not open.
 *
 * Everything MahekOne decides — an order approved, an order refused, a target
 * published, a task escalated, a book moved — is written as a notification the
 * app reads on its next pull. That is the record. This is the part that gets
 * it in front of somebody who is not looking at the app, which for a decision
 * made at four in the afternoon is the difference between acting on it today
 * and reading it tomorrow morning.
 */

export type PushReadiness =
  | { ok: true }
  /** Every way it can fail, named, because a screen has to say which. */
  | { ok: false; reason: 'permission' | 'not-configured' | 'unsupported'; why: string };

/**
 * The Expo project the token is minted against.
 *
 * Read from the SYNCED CONFIGURATION first and from `app.json` only as a
 * fallback. That order is the point: a value baked into the bundle needs a new
 * APK on every handset to change, and this app has already learned how
 * expensive that is — the API base is inlined at build time and a build made
 * against the wrong one is a broken binary rather than a wrong setting.
 * Putting the project id in configuration means push can be switched on for
 * the whole field team from a screen, and only the Firebase half of the setup
 * — which is genuinely native — still needs a build.
 */
async function projectId(): Promise<string> {
  const fromConfig = (await getConfig<string>('mbos.push.expoProjectId', '')) ?? '';
  if (fromConfig.trim()) return fromConfig.trim();

  const fromBundle = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)
    ?.eas?.projectId;
  return (fromBundle ?? '').trim();
}

/**
 * Android takes its importance from the CHANNEL and from nowhere else.
 *
 * A message naming no channel lands in a default one created by the OS at low
 * importance, where it makes no sound, shows no heads-up banner, and is
 * indistinguishable from a push that never arrived — however high the
 * `priority` on the message claims to be. This is the single most common
 * reason Android push "does not work", and it is invisible: the send succeeds,
 * the receipt says delivered, and the phone stays silent.
 *
 * Two channels, because the server sends on two. The quiet one exists so a
 * push inside quiet hours can arrive without waking anybody — it is delivered
 * immediately and shown silently, rather than held back until morning.
 *
 * Safe to call repeatedly: creating a channel that exists updates it.
 */
async function ensureChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('default', {
    name: 'Decisions and tasks',
    importance: AndroidImportance.HIGH,
    sound: 'default',
    vibrationPattern: [0, 250, 250, 250],
  });
  await Notifications.setNotificationChannelAsync('quiet', {
    name: 'Overnight',
    /* Shown, listed, never sounded. `LOW` is what keeps it out of a heads-up
       banner at two in the morning while still putting it on the phone. */
    importance: AndroidImportance.LOW,
    sound: null,
    vibrationPattern: null,
  });
}

/**
 * Where push stands, WITHOUT asking for anything.
 *
 * Separate from `registerForPush` because that one prompts, and a screen that
 * raises the OS permission dialog merely by being opened is a screen people
 * learn to avoid. This only reads: it is safe to call on every render of the
 * profile.
 */
export async function pushStatus(): Promise<PushReadiness> {
  try {
    if (!Constants.isDevice) {
      return { ok: false, reason: 'unsupported', why: 'A simulator has no push service.' };
    }
    if (!(await projectId())) {
      return {
        ok: false,
        reason: 'not-configured',
        why: 'The office has not finished setting push up. Nothing is lost — messages wait in the app.',
      };
    }
    type PermissionState = { granted: boolean };
    const existing = (await Notifications.getPermissionsAsync()) as unknown as PermissionState;
    if (!existing.granted) {
      return {
        ok: false,
        reason: 'permission',
        why: 'Notifications are off for MBOS on this phone.',
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'unsupported', why: 'This handset cannot be registered for push.' };
  }
}

/**
 * Asking for a place to push to.
 *
 * Called on every sign-in and on every open with a session already there —
 * idempotent, because Expo hands back the same token most of the time and
 * asking again costs nothing.
 *
 * It returns WHY it could not, rather than only failing quietly. The silence
 * was the problem: nine handsets registered zero tokens between them and
 * nothing on any screen, on the phone or in the office, could say whether that
 * was a refused permission, a missing project id, or a push service that had
 * never been asked. `Profile` prints this now.
 */
export async function registerForPush(): Promise<PushReadiness> {
  try {
    await ensureChannels();

    if (!Constants.isDevice) {
      return {
        ok: false,
        reason: 'unsupported',
        why: 'A simulator has no push service to register with.',
      };
    }

    /* `NotificationPermissionsStatus` extends a `PermissionResponse` its own
       package re-exports in a way `skipLibCheck` cannot fully resolve here —
       `granted` is real on the object at runtime, just not on the inferred
       type, so this reads it past that rather than fighting the library's
       own types. */
    type PermissionState = { granted: boolean };
    const existing = (await Notifications.getPermissionsAsync()) as unknown as PermissionState;
    let granted = existing.granted;
    if (!granted) {
      const asked = (await Notifications.requestPermissionsAsync()) as unknown as PermissionState;
      granted = asked.granted;
    }
    if (!granted) {
      return {
        ok: false,
        reason: 'permission',
        why: 'Notifications are switched off for MBOS. Turn them on in your phone’s Settings.',
      };
    }

    const id = await projectId();
    if (!id) {
      return {
        ok: false,
        reason: 'not-configured',
        why: 'The office has not finished setting push up yet. Nothing is lost — messages are waiting in the app.',
      };
    }

    const { data } = await Notifications.getExpoPushTokenAsync({ projectId: id });
    await registerPushToken(data);
    return { ok: true };
  } catch {
    /* A push service that will not answer is not the salesman's problem and
       must never stop the app opening. The in-app notification still lands on
       the next sync; only the buzz is missed. */
    return {
      ok: false,
      reason: 'unsupported',
      why: 'This handset could not be registered for push. Messages still arrive in the app.',
    };
  }
}

/** Called on sign-out, so a released handset stops being pushed to. */
export async function clearPushToken(): Promise<void> {
  try {
    await registerPushToken(null);
  } catch {
    /* The device row keeps a stale token until the next registration
       overwrites it — and the server clears it by itself the first time Expo
       answers `DeviceNotRegistered`. Not worth failing sign-out over. */
  }
}

/**
 * Where a tap should land.
 *
 * The server sends an MBOS route in `data.href` where it knows one — `/tasks`
 * for a task, `/rejections` for a refused order — and null where it does not.
 * Null is the honest answer rather than a guess: a wrong deep link drops
 * somebody on a screen that has nothing to do with what they tapped, which is
 * worse than the notifications list, where the message is definitely there.
 */
export function routeForNotification(data: unknown): string {
  const href = (data as { href?: unknown } | undefined)?.href;
  return typeof href === 'string' && href.startsWith('/') ? href : '/notifications';
}

/**
 * How a push is shown while the app is open in the foreground.
 *
 * Expo's default is to say nothing on iOS unless a handler says otherwise —
 * a salesman looking at the screen when a decision lands should still see it.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});
