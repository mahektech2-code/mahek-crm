import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { AndroidImportance, SchedulableTriggerInputTypes } from 'expo-notifications';

import { dayState } from '../data/attendance';
import { getConfig } from '../data/config';
import { punchOutReminderTimes } from '../engines/punch-out';
import { hasPushToken } from './push';

/**
 * The buzz at the end of the day, for somebody still punched in.
 *
 * The bar and the main button on Home only work on a salesman who opens the
 * app, and the commonest way a punch-out is missed is that he does not: the
 * last shop is done, the phone goes in a pocket, and the day is closed by the
 * system overnight with no closing photo. A notification is the one thing on
 * this phone that can reach him then.
 *
 * A STOPGAP FOR PUSH, AND IT KNOWS IT. Every notification in MBOS is the
 * office's — a row on the bell and a push — and the punch-out reminder is too:
 * `sendPunchOutReminders` on the server. But push reached no phone when this
 * was written (no Firebase in the APK, so no handset could get a token), so a
 * reminder that only the server sent would buzz nobody. This one is scheduled
 * on the phone and fires with no signal, and it stands down by itself the
 * moment the phone holds a push token (`hasPushToken`), so nobody hears it
 * twice. Delete this file once every phone in the field is on an APK with
 * Firebase. The rule for WHEN is `punchOutReminderTimes`, pure and tested.
 *
 * RECONCILED, NOT TRACKED. Every caller asks the same question — is a session
 * open, and what should be scheduled for the rest of today — and the answer
 * overwrites whatever was there, under fixed identifiers. So a punch-in, a
 * punch-out, an app open after a reboot and a changed setting all land on the
 * same state, and there is no record of "what I scheduled earlier" that could
 * drift from what the day actually is.
 *
 * It never throws. A reminder that could not be scheduled must cost nothing
 * but the reminder — never a punch-in.
 */

export const DAY_REMINDER_CHANNEL = 'day-reminders';

/** Fixed, so scheduling again replaces rather than stacks. */
const IDS = ['punch-out-reminder-1', 'punch-out-reminder-2'] as const;

async function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(DAY_REMINDER_CHANNEL, {
    name: 'Punch-out reminders',
    importance: AndroidImportance.HIGH,
    sound: 'default',
    vibrationPattern: [0, 300, 200, 300],
    enableVibrate: true,
  });
}

/** Takes every punch-out reminder off the phone. Signing out, punching out. */
export async function cancelPunchOutReminders(): Promise<void> {
  for (const id of IDS) {
    try {
      await Notifications.cancelScheduledNotificationAsync(id);
    } catch {
      /* Nothing scheduled under that id is the ordinary case. */
    }
  }
}

/**
 * Make the phone's reminders match the day as it stands now.
 *
 * Does NOT ask for the notification permission. That is asked once, by push
 * registration, at a moment chosen for it; a dialog fired from inside a
 * punch-in lands on the selfie camera. Without the permission the schedule
 * simply never shows, and the bar and Home's button still do their part.
 */
export async function syncPunchOutReminders(userId: string): Promise<void> {
  try {
    await cancelPunchOutReminders();
    /* The office sends the same reminder as a notification. Once this phone
       can receive it, this one stands down — see `hasPushToken`. */
    if (await hasPushToken()) return;
    const day = await dayState(userId);
    if (!day.running) return;

    const [promptHour, secondAfterMinutes] = await Promise.all([
      getConfig<number>('mbos.attendance.punchOutPromptHour', 18),
      getConfig<number>('mbos.attendance.punchOutSecondReminderMinutes', 90),
    ]);
    const times = punchOutReminderTimes({ nowMs: Date.now(), promptHour, secondAfterMinutes });
    if (times.length === 0) return;

    await ensureChannel();
    for (const { at, nth } of times) {
      await Notifications.scheduleNotificationAsync({
        identifier: IDS[nth - 1],
        content: {
          title: nth === 1 ? 'Still punched in' : 'You have not punched out yet',
          body:
            nth === 1
              ? 'Done for the day? Punch out so your hours stop here. Tap to take the photo.'
              : 'If you are done, punch out now. Otherwise the system closes your day tonight and your manager has to fix it.',
          sound: 'default',
          /* Through Home's own punch-out, so the photo and the meter reading
             are asked for exactly as they are from the button. */
          data: { href: '/home?punchOut=1', kind: 'punch-out' },
        },
        trigger: { type: SchedulableTriggerInputTypes.DATE, date: at, channelId: DAY_REMINDER_CHANNEL },
      });
    }
  } catch {
    /* See the header. */
  }
}
