import React from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';

import { BottomSheet } from '../ui/overlays';
import { SecondaryButton, T } from '../ui/primitives';
import { OdometerCamera, type OdometerResult } from '../ui/odometer-camera';
import { Icon } from '../ui/Icon';
import { color as C, HIT, radius, weight } from '../../theme/tokens';
import { useStore } from '../../state/store';
import { useBoot } from '../../state/boot';
import { departForVisit, travelModes, type TravelMode } from '../../data/travel';
import { getConfig } from '../../data/config';
import { isoDate } from '../../lib/format';
import { fixOf, getFix } from '../../native/location';
import { queueOdometerPhoto } from '../../native/capture';

/**
 * The question that comes before every visit: how are you getting there.
 *
 * **IT IS MOUNTED ONCE, IN `AppFrame`.** Four places in this app start a visit
 * — the route screen's Next stop card, a customer's record, the customer list
 * and the home screen's quick actions — and every one of them has to ask, or
 * the answer becomes optional by accident on whichever screen somebody
 * forgets. So they all do the same thing, which is set `travelTo` on the
 * store, and this is the one place that reads it. A gate each screen wired up
 * for itself would be four gates, and three of them would be right.
 *
 * **THE MODES ARE ROWS, NOT A LIST IN THIS FILE.** `travel_modes` is pulled
 * from MahekOne and an admin edits it, `requiresOdometer` is what decides
 * whether the camera opens, and "Auto/Local Transport" is plainly the start of
 * a list rather than the end of one. A mode typed into this screen would be a
 * second answer to a question the office already answers.
 *
 * **NOTHING IS WRITTEN UNTIL THE CAMERA CLOSES.** Backing out at any point
 * leaves no half-open journey behind — which is why the order is question,
 * then photograph, then write, and not the other way round. It is the same
 * order `startDay` uses for the attendance selfie and for the same reason.
 *
 * **The GPS is asked for ALONGSIDE the camera, never before it.** Awaiting a
 * fix first would make him watch a spinner and then take a photograph; asked
 * together, the radio has the whole length of the photograph to settle, which
 * costs nothing and makes the fix better. A leg is never refused for want of
 * one: where he set off from is evidence, and the meter is the record.
 */
export function TravelGate() {
  const to = useStore((s) => s.travelTo);
  const set = useStore((s) => s.set);
  const notify = useStore((s) => s.notify);
  const beginVisit = useStore((s) => s.beginVisit);
  const boot = useBoot();
  const userId = boot.session?.user.id ?? '';

  const [modes, setModes] = React.useState<TravelMode[]>([]);
  const [maxKm, setMaxKm] = React.useState(400);
  const [busy, setBusy] = React.useState(false);

  /* The camera and the mode that opened it, held together: the mode is what
     decides whether the reading is required at all, and a camera open with no
     mode behind it would have nothing to write its answer onto. */
  const [metering, setMetering] = React.useState(false);
  const answerOdometer = React.useRef<((r: OdometerResult) => void) | null>(null);

  React.useEffect(() => {
    let live = true;
    void Promise.all([
      travelModes(),
      getConfig<number>('mbos.travel.maxLegKilometres', 400),
    ]).then(([rows, km]) => {
      if (!live) return;
      setModes(rows);
      setMaxKm(km);
    });
    return () => {
      live = false;
    };
  }, []);

  const close = () => set({ travelTo: null });

  const askOdometer = () =>
    new Promise<OdometerResult>((resolve) => {
      answerOdometer.current = resolve;
      setMetering(true);
    });

  const choose = async (mode: TravelMode) => {
    if (!to || busy || !userId) return;
    setBusy(true);
    try {
      const threshold = await getConfig<number>('mbos.location.gpsAccuracyThresholdM', 100);
      /* Started, not awaited. See the note at the top of the file. */
      const fixing = getFix({ accuracyThresholdM: threshold });

      let odometer: { km: number; photoId: string } | null = null;
      if (mode.requiresOdometer) {
        const shot = await askOdometer();
        /*
         * Cancelled. NOTHING has been written, so there is nothing to undo —
         * and no toast either: he has just pressed a button whose words say
         * what it abandons, and repeating that back is noise. The fix is
         * abandoned with it, because a location for a journey that did not
         * happen is a record of somewhere somebody stood while nothing did.
         */
        if (!shot) return;
        try {
          odometer = { km: shot.km, photoId: await queueOdometerPhoto(shot.uri, 'pending') };
        } catch {
          /* The photograph could not be written to this phone, so there is no
             evidence and therefore no leg. It fails LOUDLY rather than opening
             an unevidenced one — which is the whole point of the hard gate. */
          notify('The photo could not be saved on this phone, so nothing was recorded. Try again.');
          return;
        }
      }

      const fix = fixOf(await fixing);

      const out = await departForVisit({
        userId,
        day: isoDate(new Date()),
        customerId: to.customerId,
        customerName: to.customerName,
        modeKey: mode.key,
        purpose: 'visit',
        fix: fix ? { lat: fix.lat, lng: fix.lng } : null,
        odometer,
      });
      if (!out.ok) {
        notify(out.reason);
        return;
      }

      /* The visit is prepared but its clock does NOT start — that happens at
         the arrival, on the visit screen. See `beginVisit` in the store. */
      beginVisit(to.customerId);
      set({ travelTo: null, gps: fix ? 'locked' : 'off' });
      router.push('/visit');
    } catch {
      notify('That journey could not be started on this phone. Nothing has been lost — try again.');
    } finally {
      setBusy(false);
    }
  };

  /**
   * What this option is about to DO, on the option itself.
   *
   * The list is read once by somebody who is already late, and three words
   * each gives him no reason to expect that two of them open a camera. Said
   * here, the camera reads as the thing he chose; unsaid, it reads as the app
   * misbehaving. It is derived from the mode's own flags rather than written
   * per mode, so a mode an admin adds tomorrow explains itself.
   */
  const hint = (m: TravelMode) =>
    m.requiresOdometer
      ? 'Photograph the meter now and again when you get there'
      : m.requiresTicket
        ? 'Add the ticket when you save the visit, if you keep it'
        : 'Nothing to record';

  return (
    <>
      <BottomSheet open={!!to && !metering} onClose={close}>
        <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 20 }}>
          <T style={[{ fontSize: 17, lineHeight: 22, color: C.ink }, weight(600)]}>
            How are you getting there?
          </T>
          <T s="small" style={{ marginTop: 4 }}>
            {to?.customerName ?? ''}
          </T>

          <View style={{ marginTop: 14, gap: 8 }}>
            {modes.map((mode) => (
              <Pressable
                key={mode.key}
                accessibilityRole="button"
                accessibilityLabel={`${mode.label} — ${hint(mode)}`}
                disabled={busy}
                onPress={() => void choose(mode)}
                style={{
                  minHeight: HIT,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  borderWidth: 1,
                  borderColor: C.border,
                  borderRadius: radius.md,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                  opacity: busy ? 0.5 : 1,
                }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T style={[{ fontSize: 15, color: C.ink }, weight(600)]}>{mode.label}</T>
                  <T style={{ fontSize: 12, lineHeight: 16, color: C.muted, marginTop: 1 }}>
                    {hint(mode)}
                  </T>
                </View>
                <Icon name="forward" size={18} color={C.muted} strokeWidth={1.6} />
              </Pressable>
            ))}
          </View>

          {/* An empty list is not a broken screen and must not look like one.
              `travel_modes` is reference data, so a handset that has not
              bootstrapped has none — and the honest answer is to say so rather
              than draw nothing under a question. */}
          {modes.length === 0 ? (
            <T style={{ fontSize: 13, lineHeight: 18, color: C.muted, marginTop: 10 }}>
              The travel modes have not reached this phone yet. Sync, then start the visit again.
            </T>
          ) : (
            <T style={{ fontSize: 12, lineHeight: 16, color: C.muted, marginTop: 14 }}>
              The visit starts when you tell it you have arrived, so the ride is not
              counted as time in the shop.
            </T>
          )}

          <View style={{ marginTop: 12 }}>
            <SecondaryButton label="Not going yet" onPress={close} />
          </View>
        </View>
      </BottomSheet>

      <OdometerCamera
        open={metering}
        title="Photograph the meter"
        subtitle="Before you set off — this is where the trip is measured from."
        cancelLabel="Cancel — do not start this journey"
        previousKm={null}
        maxLegKilometres={maxKm}
        onDone={(result) => {
          setMetering(false);
          answerOdometer.current?.(result);
          answerOdometer.current = null;
        }}
      />
    </>
  );
}
