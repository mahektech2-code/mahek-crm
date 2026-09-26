import React from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';

import { BottomSheet } from '../ui/overlays';
import { SecondaryButton, T } from '../ui/primitives';
import { color as C, weight } from '../../theme/tokens';
import { useStore } from '../../state/store';
import { useBoot } from '../../state/boot';
import { departForVisit, openSessionLeg } from '../../data/travel';
import { visitLegPlan } from '../../lib/travel-leg';
import { getConfig } from '../../data/config';
import { isoDate } from '../../lib/format';
import { fixOf, getFix } from '../../native/location';

/**
 * What happens between "Visit" and the visit — and it is no longer a question.
 *
 * **IT IS MOUNTED ONCE, IN `AppFrame`.** Four places start a visit — the route
 * screen's Next stop card, a customer's record, the customer list and the home
 * screen's quick actions — and every one of them sets `travelTo` on the store,
 * so this is still the one place the start of a journey is decided.
 *
 * **NOTHING IS ASKED HERE ANY MORE.** It used to ask how he was getting to each
 * shop, open a meter camera, and ask for the fare on the way out; the field
 * would not answer it. Travel is now asked twice a day — the vehicle at the
 * punch-in, the meter at the punch-out where there is one — and every fare is
 * claimed in Expenses. `visitLegPlan` (pure, in `lib/travel-leg.ts`) decides
 * how the journey is recorded instead: silently, under the day's own mode, so
 * the arrival geofence and the dwell clock still work; or not at all, where he
 * never punched in, rather than under a vehicle nobody named.
 *
 * **The GPS is asked for, never waited on beyond its own timeout.** Where he
 * set off from is evidence; a leg is never refused for want of it.
 */
export function TravelGate() {
  const to = useStore((s) => s.travelTo);
  const set = useStore((s) => s.set);
  const notify = useStore((s) => s.notify);
  const beginVisit = useStore((s) => s.beginVisit);
  const arrival = useStore((s) => s.arrival);
  const boot = useBoot();
  const userId = boot.session?.user.id ?? '';
  const starting = React.useRef(false);

  const close = () => set({ travelTo: null });

  /*
   * A JOURNEY CANNOT BEGIN WHILE HE IS STANDING AT A SHOP.
   *
   * Arriving closes the leg, so nothing further down would refuse this — and
   * the journey screen happily draws "Start visit" again for the very shop he
   * has just reached, because the only thing that knows otherwise is the
   * arrival on disk. Setting off from here would leave that arrival with
   * nothing left that could ever close it.
   */
  const outstanding = arrival && arrival.checkedInAt == null ? arrival : null;

  const goCheckIn = () => {
    if (!outstanding) return;
    set({ travelTo: null, custId: outstanding.customerId });
    router.push('/visit');
  };

  React.useEffect(() => {
    if (!to || !userId || outstanding || starting.current) return;
    starting.current = true;
    void (async () => {
      try {
        const plan = visitLegPlan(await openSessionLeg(userId).then((s) =>
          s ? { modeKey: s.modeKey, odometerStartKm: s.odometerStartKm } : null,
        ));
        let gps: 'locked' | 'off' | 'acquiring' = 'acquiring';
        if (plan.record) {
          const threshold = await getConfig<number>('mbos.location.gpsAccuracyThresholdM', 100);
          const fix = fixOf(await getFix({ accuracyThresholdM: threshold }));
          gps = fix ? 'locked' : 'off';
          const out = await departForVisit({
            userId,
            day: isoDate(new Date()),
            customerId: to.customerId,
            customerName: to.customerName,
            modeKey: plan.modeKey,
            purpose: 'visit',
            fix: fix ? { lat: fix.lat, lng: fix.lng } : null,
            odometer: null,
            claimExcluded: plan.claimExcluded,
            claimExcludedReason: plan.reason,
          });
          /* A journey that could not be written must not cost the visit: he
             is going to that shop either way. The form opens as it did before
             journeys existed, and the office flags the check-in distance. */
          if (!out.ok) notify(out.reason);
        }
        beginVisit(to.customerId);
        set({ travelTo: null, gps });
        router.push('/visit');
      } catch {
        set({ travelTo: null });
        notify('That visit could not be started on this phone. Nothing has been lost — try again.');
      } finally {
        starting.current = false;
      }
    })();
    /* `beginVisit`, `set` and `notify` are stable store actions. */
  }, [to, userId, outstanding, beginVisit, set, notify]);

  if (to && outstanding) {
    const same = outstanding.customerId === to.customerId;
    return (
      <BottomSheet open onClose={close}>
        <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 20 }}>
          <T style={[{ fontSize: 17, lineHeight: 22, color: C.ink }, weight(600)]}>
            {same ? 'You are already there' : `You have not checked in at ${outstanding.customerName}`}
          </T>
          <T s="small" style={{ marginTop: 6 }}>
            {same
              ? 'You have arrived. All that is left is to check in when you go inside.'
              : 'One shop at a time — check in there, or save the visit, before setting off again.'}
          </T>
          <View style={{ marginTop: 14 }}>
            <SecondaryButton label={`Check in at ${outstanding.customerName}`} onPress={goCheckIn} />
          </View>
          <View style={{ marginTop: 10 }}>
            <SecondaryButton label="Not now" onPress={close} />
          </View>
        </View>
      </BottomSheet>
    );
  }

  return null;
}
