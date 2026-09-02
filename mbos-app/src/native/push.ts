import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { registerPushToken } from '../sync/api';

/**
 * Asking for a place to push to.
 *
 * Called on every sign-in and every app open with a session already there —
 * idempotent, because Expo hands back the same token most of the time and
 * asking again costs nothing. It is silent about every way it can fail: no
 * permission, no EAS project configured, a simulator with no push service at
 * all. None of that is the salesman's problem, and none of it should stop
 * the app opening.
 *
 * **This needs an EAS project id to work in a real build.** Without one in
 * `app.json` (`extra.eas.projectId`, set by `eas init`), `getExpoPushTokenAsync`
 * has nothing to ask Expo's service for and this function does nothing —
 * which is the safe failure, not a broken one: in-app notifications still
 * work, only the push arrives late, on the next sync.
 */
export async function registerForPush(): Promise<void> {
  try {
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
    if (!granted) return;

    const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)
      ?.eas?.projectId;
    if (!projectId) return;

    const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
    await registerPushToken(data);
  } catch {
    /* See the note above — every failure here is ordinary. */
  }
}

/** Called on sign-out, so a released handset stops being pushed to. */
export async function clearPushToken(): Promise<void> {
  try {
    await registerPushToken(null);
  } catch {
    /* The device row will simply keep a stale token until the next
       registration overwrites it — not worth failing sign-out over. */
  }
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
