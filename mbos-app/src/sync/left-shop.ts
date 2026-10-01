import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { one } from '../db';
import { getConfig } from '../data/config';
import { markLeftShop, readArrival } from '../data/arrival';
import { leftShopVerdict } from '../engines/left-shop';
import { ensureVisitReminderChannel, VISIT_REMINDER_CHANNEL } from '../native/push';
import { useStore } from '../state/store';

/**
 * Notices that he walked out of a visit without checking out, and asks him to.
 *
 * Called from every place a reading reaches JavaScript: the background location
 * task on each delivery, and the sync tick with the phone's last known
 * position — the second is what covers a handset whose native service uploads
 * fixes on its own and never hands them to this side. The rule itself is
 * `leftShopVerdict`, pure and tested; this is only the wiring.
 *
 * It never throws. It runs inside the trail and the sync loop, and a reminder
 * that could not be worked out must cost nothing but the reminder.
 */

type Reading = { lat: number; lng: number; accuracyM: number | null; at: number };

/* Two hooks can fire within the same second; the second must not ask twice. */
let busy = false;

export async function watchForLeftShop(fix: Reading): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const arrival = await readArrival();
    if (!arrival || arrival.checkedInAt == null || arrival.leftShopAt != null) return;

    let anchor = arrival.checkInFix ? { lat: arrival.checkInFix.lat, lng: arrival.checkInFix.lng } : null;
    if (!anchor) {
      const pin = await one<{ gpsLat: number | null; gpsLng: number | null }>(
        'SELECT gpsLat, gpsLng FROM customers WHERE id = ?',
        [arrival.customerId],
      );
      if (pin?.gpsLat != null && pin.gpsLng != null) anchor = { lat: pin.gpsLat, lng: pin.gpsLng };
    }

    const thresholdM = await getConfig<number>('mbos.visit.forgotCheckoutMetres', 500);
    const verdict = leftShopVerdict({
      checkedInAt: arrival.checkedInAt,
      alreadyAsked: false,
      anchor,
      fix,
      thresholdM,
    });
    if (!verdict.left) return;

    /* Written BEFORE the notification, so a second hook racing this one finds
       it already marked and stays quiet. */
    const marked = await markLeftShop(fix.at, verdict.metres);
    if (!marked) return;
    /* The same JS context as the screens when the app is alive in the
       background; a headless run has no screens and hydrates from disk. */
    useStore.setState({ arrival: marked });

    await ensureVisitReminderChannel();
    await Notifications.scheduleNotificationAsync({
      content: {
        title: `Did you forget to check out of ${arrival.customerName}?`,
        body: `You are about ${distanceWords(verdict.metres)} away. Tap to check out — no need to go back.`,
        sound: 'default',
        priority: Notifications.AndroidNotificationPriority.MAX,
        data: { href: '/visit', customerId: arrival.customerId, kind: 'forgot-checkout' },
      },
      trigger: { channelId: VISIT_REMINDER_CHANNEL },
    });
  } catch {
    /* See the header: a reminder is never worth breaking the trail over. */
  } finally {
    busy = false;
  }
}

/**
 * The same question asked of the phone's last known position. Costs no radio:
 * it reads what the OS already has, which on a handset whose own service is
 * taking fixes every few seconds is minutes old at most.
 */
export async function checkLeftShopFromLastKnown(): Promise<void> {
  try {
    const arrival = await readArrival();
    if (!arrival || arrival.checkedInAt == null || arrival.leftShopAt != null) return;
    const last = await Location.getLastKnownPositionAsync({ maxAge: 5 * 60_000 });
    if (!last) return;
    await watchForLeftShop({
      lat: last.coords.latitude,
      lng: last.coords.longitude,
      accuracyM: last.coords.accuracy ?? null,
      at: last.timestamp,
    });
  } catch {
    /* No permission, no provider, no reading — nothing to ask about. */
  }
}

function distanceWords(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`;
}
