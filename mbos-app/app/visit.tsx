import React from 'react';
import { View, Text, Pressable, TextInput } from 'react-native';
import { router } from 'expo-router';
import { color as C, HIT, radius, shadow, type, weight } from '../src/theme/tokens';
import { Icon } from '../src/components/ui/Icon';
import { Card, Choice, PrimaryButton, SecondaryButton } from '../src/components/ui/primitives';
import { BottomSheet, Calendar } from '../src/components/ui/overlays';
import { AppFrame } from '../src/components/shell/AppFrame';
import { useCustomer, useStore } from '../src/state/store';
import { useBoot } from '../src/state/boot';
import { inr, isoDate, pretty } from '../src/lib/format';
import { elapsedLabel, FOLLOW_ON, visitChecks, visitVerdict } from '../src/lib/visit';
import { COMPLAINT_CATEGORIES, OUTCOMES } from '../src/data/fixtures';
import { getConfig } from '../src/data/config';
import { previousVisitNote, saveVisit, type PreviousNote } from '../src/data/visits';
import { logComplaint, requestSample } from '../src/data/requests';
import { starterProducts } from '../src/data/customers';
import { todayStops } from '../src/data/journey';
import { visitLocationVerdict } from '../src/engines/geo';
import { fixOf, getFix, type Fix } from '../src/native/location';
import { queueOdometerPhoto, queueRecording, takePhoto, useVoiceRecorder } from '../src/native/capture';
import { OdometerCamera, type OdometerResult } from '../src/components/ui/odometer-camera';
import {
  abandonLeg,
  arrive,
  arrivedLegFor,
  attachTicket,
  bindVisit,
  openLeg,
  travelRules,
  type TravelLeg,
} from '../src/data/travel';
import { arrivalPrompt, checkFare, legLine, needsOdometer, offersTicket, travellingFor, type TravelMode } from '../src/lib/travel';

/**
 * Capturing a visit.
 *
 * The rule that shapes this screen: the save is never refused outright. The
 * checklist says what is missing and why the rule exists, and the dashed
 * button under it saves anyway — unverified, with a reason, and the manager
 * told. A salesman who cannot log a visit stops logging visits, and then the
 * office knows nothing at all.
 *
 * The GPS follows the same rule one level down. A fix is EVIDENCE, never a
 * gate: no fix, a fix accurate to half a kilometre, or a shop whose recorded
 * coordinates are simply wrong all let the visit through and are recorded as
 * what they are.
 */

type Product = { id: string; name: string; packSize: string | null };

export default function Visit() {
  const c = useCustomer();
  const boot = useBoot();
  const gps = useStore((s) => s.gps);
  const shots = useStore((s) => s.shots);
  const rec = useStore((s) => s.rec);
  const note = useStore((s) => s.note);
  const outcome = useStore((s) => s.outcome);
  const nextDate = useStore((s) => s.nextDate);
  const visitStart = useStore((s) => s.visitStart);
  const visitDone = useStore((s) => s.visitDone);
  const set = useStore((s) => s.set);
  /* Set on the route screen, before the shop was chosen. See `deviationReason`
     in the save below. */
  const offPlanReason = useStore((s) => s.offPlanReason);
  const notify = useStore((s) => s.notify);
  const markVisitDone = useStore((s) => s.markVisitDone);
  const askConfirm = useStore((s) => s.askConfirm);
  const arrivedAt = useStore((s) => s.arrivedAt);

  const [form, setForm] = React.useState<'complaint' | 'sample' | null>(null);
  const [draft, setDraft] = React.useState<Record<string, string>>({});
  const [formErr, setFormErr] = React.useState<string | null>(null);
  const [calOpen, setCalOpen] = React.useState<'next' | 'trial' | null>(null);

  /* Everything captured here that is not yet a visit: the fix, the recording,
     the records punched from inside it. `saveVisit` binds the lot in one
     transaction — a half-saved visit describes something that never happened. */
  const [fix, setFix] = React.useState<Fix | null>(null);
  const [fixReason, setFixReason] = React.useState<string | null>(null);
  const [voiceNoteId, setVoiceNoteId] = React.useState<string | null>(null);
  const [linked, setLinked] = React.useState<{ complaintId?: string; sampleId?: string }>({});
  const [products, setProducts] = React.useState<Product[]>([]);
  const [stopId, setStopId] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [lastTime, setLastTime] = React.useState<PreviousNote | null>(null);

  /* Thresholds, never constants: the dwell floor and the distance that counts
     as a mismatch are both a manager's to move. */
  const [minDwell, setMinDwell] = React.useState(120);
  const [maxMetres, setMaxMetres] = React.useState(150);

  /* ---- the journey that got him here ----
     `leg` is read from SQLite rather than from the store, because the app is
     routinely killed on the road and a leg held in memory would be gone by
     the time he walked in. `null` after `legLoaded` means the visit was
     started before travel legs existed, or by a screen that does not ask —
     and that visit still saves exactly as it always did. */
  const [leg, setLeg] = React.useState<TravelLeg | null>(null);
  const [legLoaded, setLegLoaded] = React.useState(false);
  const [rules, setRules] = React.useState<{ odometerModes: string[]; ticketModes: string[]; maxLegKilometres: number } | null>(null);
  const [arriving, setArriving] = React.useState(false);
  const answerOdometer = React.useRef<((r: OdometerResult) => void) | null>(null);
  const [metering, setMetering] = React.useState(false);

  /* ---- the ticket, asked once on the way out ---- */
  const [ticketOpen, setTicketOpen] = React.useState(false);
  const [ticketShot, setTicketShot] = React.useState<string | null>(null);
  const [fare, setFare] = React.useState('');
  const [fareErr, setFareErr] = React.useState<string | null>(null);
  const [ticketBusy, setTicketBusy] = React.useState(false);
  /* The reason carried across the ticket question, so an unverified save that
     detours through a ticket still saves as unverified. Losing it here would
     silently upgrade a flagged visit to a clean one. */
  const [pendingUnverified, setPendingUnverified] = React.useState<string | null>(null);

  const recorder = useVoiceRecorder();

  /**
   * The dwell clock has to tick, because one of the save conditions is time.
   * It is held in state and advanced by the interval rather than read during
   * render — a render that reads the clock gives a different answer every time
   * React happens to re-run it, and here that answer decides whether the save
   * button is live.
   */
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const custId = c?.id ?? null;

  React.useEffect(() => {
    let live = true;
    void Promise.all([
      getConfig<number>('mbos.visits.minimumDwellSeconds', 120),
      getConfig<number>('mbos.location.visitMismatchM', 150),
      starterProducts(5),
      todayStops(),
    ]).then(([dwell, metres, skus, stops]) => {
      if (!live) return;
      setMinDwell(dwell);
      setMaxMetres(metres);
      setProducts(skus);
      /* A stop on today's plan makes this a planned visit and gets marked
         visited when the save lands. */
      setStopId(stops.find((s) => s.customerId === custId && s.status === 'planned')?.id ?? null);
    });
    return () => {
      live = false;
    };
  }, [custId]);

  /*
   * The leg he is on, or the one he closed to get here.
   *
   * Both, in one read, because they are the same journey at two moments and
   * the screen has to be able to tell them apart: an OPEN leg means he is
   * still travelling and the visit has not begun, and a CLOSED one is the
   * evidence that goes onto the visit when it saves.
   *
   * `userId` and `custId` both, because a leg belongs to a person and to a
   * shop — reading only by person would hand him a journey to a different
   * shop the moment he opened somebody else's record while on the road.
   */
  const userId = boot.session?.user.id ?? '';
  const loadLeg = React.useCallback(() => {
    let live = true;
    if (!custId || !userId) return;
    void Promise.all([openLeg(userId), arrivedLegFor(userId, custId), travelRules()]).then(
      ([running, arrived, r]) => {
        if (!live) return;
        setRules(r);
        /* An open leg to THIS shop locks the screen; an open leg to a
           different one is not this visit's business and is left alone — the
           journey screen is where that is answered. */
        setLeg(running && running.customerId === custId ? running : arrived);
        setLegLoaded(true);
      },
    );
    return () => {
      live = false;
    };
  }, [custId, userId]);
  React.useEffect(loadLeg, [loadLeg]);

  /* What he said last time, read back before this call rather than found
     afterwards on the timeline. See `data/visits.ts`. */
  React.useEffect(() => {
    let live = true;
    if (!custId) return;
    void previousVisitNote(custId).then((row) => {
      if (live) setLastTime(row);
    });
    return () => {
      live = false;
    };
  }, [custId]);

  /* The suggested return day comes from the customer's own measured cycle, so
     a shop that reorders every three weeks is not offered the same date as one
     that reorders every three months. He can change it; they often say. */
  React.useEffect(() => {
    if (nextDate || !c) return;
    const gap = c.cycleDays ?? c.visitFrequencyDays ?? 7;
    set({ nextDate: isoDate(new Date(Date.now() + gap * 86_400_000)) });
  }, [nextDate, c, set]);

  /* One attempt at a fix on arrival, ten seconds at most. The salesman is
     standing in a shop with the owner waiting; a spinner is not an option. */
  React.useEffect(() => {
    let live = true;
    if (gps !== 'acquiring') return;
    void (async () => {
      const threshold = await getConfig<number>('mbos.location.gpsAccuracyThresholdM', 100);
      const result = await getFix({ accuracyThresholdM: threshold });
      if (!live) return;
      const got = fixOf(result);
      setFix(got);
      setFixReason(result.status === 'ok' ? null : result.reason);
      set({ gps: got ? 'locked' : 'off' });
    })();
    return () => {
      live = false;
    };
  }, [gps, set]);

  /* ────────────────────────────────────────────────────────── arriving */

  const askOdometer = () =>
    new Promise<OdometerResult>((resolve) => {
      answerOdometer.current = resolve;
      setMetering(true);
    });

  /**
   * He is here. This is where the visit actually begins.
   *
   * On a metered mode the camera comes FIRST and nothing is written if it is
   * cancelled — the arrival reading is half of the distance claim, and a leg
   * closed without it would be a journey the company owes for with no evidence
   * of how far it was. Same order, same argument, as the departure.
   *
   * The fix is asked for alongside it rather than before, so the radio settles
   * while the photograph is being taken; a fix is never a gate here, exactly as
   * it is never a gate on the visit itself.
   */
  const arriveHere = async () => {
    if (!leg || arriving || !rules) return;
    setArriving(true);
    try {
      const threshold = await getConfig<number>('mbos.location.gpsAccuracyThresholdM', 100);
      /* Started, not awaited — it settles while the photograph is taken. */
      const fixing = getFix({ accuracyThresholdM: threshold });

      let odometer: { km: number; photoId: string } | null = null;
      if (needsOdometer(leg.mode as TravelMode, rules.odometerModes)) {
        const shot = await askOdometer();
        /* Cancelled. Nothing written, nothing to undo, and no toast: he has
           just pressed a button whose words say what it abandons. */
        if (!shot) return;
        try {
          odometer = { km: shot.km, photoId: await queueOdometerPhoto(shot.uri, leg.id) };
        } catch {
          notify('The photo could not be saved on this phone, so the trip is still open. Try again.');
          return;
        }
      }

      /*
       * ONE FIX, TWO RECORDS. It closes the leg and it checks the visit in,
       * and they must be the same reading — two acquisitions a few seconds
       * apart would let the arrival and the check-in disagree about where the
       * shop is, and a manager reading a mismatch would have no way to tell
       * which of the two was the one being questioned.
       */
      const result = await fixing;
      const got = fixOf(result);
      setFix(got);
      setFixReason(result.status === 'ok' ? null : result.reason);
      set({ gps: got ? 'locked' : 'off' });

      const at = Date.now();
      const closed = await arrive({ legId: leg.id, fix: got, odometer });

      /* The dwell clock starts on the instant written onto the leg, not on a
         second reading of the clock — see `arrivedAt` in the store. */
      arrivedAt(at);
      loadLeg();

      if (closed.distanceKm != null) notify(`${closed.distanceKm} km recorded for this trip`);
    } catch {
      notify('That arrival could not be recorded on this phone. Nothing has been lost — try again.');
    } finally {
      setArriving(false);
    }
  };

  const startRecording = async () => {
    try {
      await recorder.prepareToRecordAsync();
      recorder.record();
      set({ rec: 'rec' });
    } catch {
      notify('The microphone could not start. Type the note instead.');
    }
  };

  const stopRecording = async () => {
    set({ rec: 'busy' });
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) {
        set({ rec: 'failed' });
        return;
      }
      /* Queued as it is. Re-encoding speech to save bytes loses the words, and
         the audio is the only copy of what the customer actually said. */
      const mediaId = await queueRecording(uri, 'visit', 'pending');
      setVoiceNoteId(mediaId);
      set({ rec: 'failed' });
    } catch {
      set({ rec: 'failed' });
    }
  };

  const shoot = async (which: 'shop' | 'cust') => {
    const shot = await takePhoto({
      parentType: 'visit',
      parentId: 'pending',
      kind: which === 'shop' ? 'shop_photo' : 'customer_photo',
    });
    if (!shot.ok) {
      if (shot.reason !== 'cancelled') notify(shot.reason);
      return;
    }
    set({ shots: { ...shots, [which]: shot.mediaId } });
  };

  const dwellSeconds = visitStart ? Math.max(0, Math.floor((now - visitStart) / 1000)) : 0;
  const gpsLocked = gps === 'locked';

  /* The disagreement between the phone and the book, as a disagreement — one
     of the two is wrong and nothing here claims to know which. */
  const verdictGeo = visitLocationVerdict(
    fix ? { lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracyM } : null,
    c && c.gpsLat != null && c.gpsLng != null ? { lat: c.gpsLat, lng: c.gpsLng } : null,
    maxMetres,
  );
  const metresAway = verdictGeo.metresAway == null ? null : Math.round(verdictGeo.metresAway);

  const checks = visitChecks({
    gpsLocked,
    metresAway,
    dwellSeconds,
    minimumDwellSeconds: minDwell,
    maxMetresFromShop: maxMetres,
    hasShopPhoto: !!shots.shop,
    outcome,
    followOnCaptured: !!(outcome && visitDone[outcome]),
  });
  const verdict = visitVerdict(checks);
  const followOn = outcome ? FOLLOW_ON[outcome] : undefined;
  const doneLine = outcome ? visitDone[outcome] : undefined;

  /**
   * The ticket, asked once, on the way out.
   *
   * IT IS A QUESTION AND NEVER A GATE. Skipping is offered in words — the fare
   * can still be claimed on the Expenses screen, which is where the unclaimed
   * ones are listed — so nobody skips it believing the money is gone. A bus
   * ticket is a scrap of paper that gets lost between the seat and the shop
   * door, and refusing the visit over one would mean refusing to record a
   * visit that happened, which is the rule this whole screen is built on.
   *
   * Asked once and not again: a leg that already carries a claim goes straight
   * through, because one trip is one fare and being asked a second time is how
   * somebody ends up claiming it twice.
   */
  function askTicketThenSave(unverifiedReason: string | null = null) {
    const wants =
      leg && rules && offersTicket(leg.mode as TravelMode, rules.ticketModes) && !leg.ticketExpenseId;
    if (!wants) {
      void saveAndGo(elapsedLabel(dwellSeconds), unverifiedReason);
      return;
    }
    setTicketShot(null);
    setFare('');
    setFareErr(null);
    setPendingUnverified(unverifiedReason);
    setTicketOpen(true);
  }

  const shootTicket = async () => {
    if (!leg) return;
    /* The SYSTEM camera here, unlike the odometer. This one really is a
       photograph OF something — a printed ticket he is holding — with no
       number to be typed against the image while it is on screen, so the
       argument in `odometer-camera.tsx` does not carry across and the flash
       and tap-to-focus people already know are worth more. */
    const shot = await takePhoto({ parentType: 'travel_leg', parentId: leg.id, kind: 'ticket_photo' });
    if (!shot.ok) {
      if (shot.reason !== 'cancelled') notify(shot.reason);
      return;
    }
    setTicketShot(shot.mediaId);
  };

  const claimTicket = async () => {
    if (!leg || ticketBusy || !ticketShot) return;
    const verdict = checkFare(fare);
    if (!verdict.ok) {
      setFareErr(verdict.why);
      return;
    }
    setTicketBusy(true);
    try {
      const claimed = await attachTicket({
        legId: leg.id,
        userId,
        customerName: c?.name ?? leg.customerName ?? 'the shop',
        photoId: ticketShot,
        farePaise: verdict.paise,
      });
      setTicketOpen(false);
      /* Over the cap is FLAGGED, never refused — the money is spent, and
         refusing to record it does not unspend it. Same rule, same words, as
         the Expenses screen. */
      notify(
        claimed.overCap
          ? `${inr(verdict.paise / 100)} claimed — over your travel cap, so your manager decides it`
          : `${inr(verdict.paise / 100)} claimed for the ticket`,
      );
      loadLeg();
    } catch {
      /* THE VISIT IS NOT LOST TO A FAILED CLAIM. He goes on to save it and the
         fare stays claimable on the Expenses screen, which is exactly what
         skipping would have left him with. */
      notify('The ticket could not be claimed just now — save the visit and claim it from Expenses.');
      setTicketOpen(false);
    } finally {
      setTicketBusy(false);
      void saveAndGo(elapsedLabel(dwellSeconds), pendingUnverified);
    }
  };

  async function saveAndGo(spent: string, unverifiedReason: string | null) {
    if (!c || saving) return;
    setSaving(true);
    const checkOut: Fix | null = fix ? { ...fix, at: now } : null;
    try {
      const visitId = await saveVisit({
        customerId: c.id,
        customerName: c.name,
        userId: boot.session?.user.id ?? '',
        checkIn: fix,
        checkOut,
        outcome: outcome ?? 'visited',
        notes: note.trim() || null,
        transcript: null,
        transcriptIsAi: false,
        shopPhotoId: shots.shop ?? null,
        custPhotoId: shots.cust ?? null,
        voiceNoteId,
        nextFollowUpDate: nextDate || null,
        journeyStopId: stopId,
        wasPlanned: !!stopId,
        /*
         * Why this shop, when it is not on the plan.
         *
         * Hardcoded null since this screen was written, while the route screen
         * asked for the reason and threw it away in a toast — so `visits`
         * carried the column, the manager screens read it, and no visit in the
         * history has ever had one. It is taken on the route screen and spent
         * here.
         *
         * Dropped where the shop turns OUT to be on today's plan: a stop he
         * was always going to make is not a deviation, whatever he typed
         * before he chose it.
         */
        deviationReason: stopId ? null : offPlanReason,
        /* The journey that ended here. MahekOne stamps the link back onto the
           leg inside the same transaction that writes the visit — see
           `handleVisit` — so this one field carries both directions. */
        travelLegId: leg?.id ?? null,
        locationMismatch: verdictGeo.mismatch,
        metresFromShop: metresAway,
        verified: unverifiedReason == null,
        unverifiedReason,
        linkedComplaintId: linked.complaintId ?? null,
        linkedSampleId: linked.sampleId ?? null,
      });
      /* The journey is spent on this visit, locally, so the record reads
         correctly on this handset without waiting for a pull — and so the
         next visit to this shop does not pick the same leg up again. It is
         deliberately AFTER the save: a leg bound to a visit that failed to
         write would be a journey pointing at nothing. */
      if (leg) await bindVisit(leg.id, visitId);

      /* Spent, whether or not it was used — a reason typed for one shop must
         not attach itself to the next unrelated visit hours later. */
      set({ visitSpent: spent, offPlanReason: null });
      router.replace('/saved');
    } catch {
      setSaving(false);
      notify('The visit could not be saved on this phone. Nothing has been lost — try again.');
    }
  }

  /*
   * ─────────────────────────────────────────── still on the road
   *
   * THE VISIT SCREEN IS LOCKED UNTIL HE SAYS HE IS HERE, and that is the point
   * of asking how he travels at all. "Start visit" now means "I am setting
   * off", so opening the whole form at that moment would start the dwell
   * clock, ask for a GPS fix and offer a shop photograph while he is still on
   * the bike — and the dwell figure, which exists to say how long he spent
   * with the customer, would quietly become how long the ride took.
   *
   * It is rendered instead of the form rather than over it, deliberately. A
   * modal on top of a working screen invites somebody to dismiss it and carry
   * on, and there is nothing underneath to carry on with.
   */
  const travelling = legLoaded && leg != null && leg.arrivedAt == null;
  if (travelling && leg) {
    const prompt = arrivalPrompt({
      mode: leg.mode as TravelMode,
      departedAt: leg.departedAt,
      startOdometerKm: leg.startOdometerKm,
      needsOdometer: !!rules && needsOdometer(leg.mode as TravelMode, rules.odometerModes),
    });
    return (
      <AppFrame
        title="On your way"
        activeTab="customers"
        onBack={() => router.back()}
        contentStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 24 }}>
        <Card style={{ padding: 16 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Icon name="nav" size={20} color={C.primaryDeep} strokeWidth={1.8} />
            <Text style={[type.h2, { flex: 1, minWidth: 0 }]}>{c?.name ?? leg.customerName ?? ''}</Text>
          </View>
          <Text style={[type.caption, { marginTop: 8 }]}>
            {legLine({ mode: leg.mode as TravelMode, distanceKm: null, ticketFarePaise: null }) +
              ' · travelling ' +
              travellingFor(leg.departedAt, now)}
          </Text>
          {leg.startOdometerKm != null ? (
            <Text style={[type.caption, { marginTop: 2 }]}>
              {'Set off on ' + leg.startOdometerKm.toLocaleString('en-IN') + ' km'}
            </Text>
          ) : null}
          <Text style={{ fontSize: 14, lineHeight: 20, color: C.body, marginTop: 12 }}>{prompt.line}</Text>
          <View style={{ marginTop: 14 }}>
            <PrimaryButton
              label={arriving ? 'One moment…' : prompt.button}
              onPress={() => void arriveHere()}
              disabled={arriving || !rules}
              whyDisabled="Reading how this trip is measured."
            />
          </View>
          {/*
            CALLING IT OFF IS THE ONLY OTHER WAY OUT, and it is not a skip.
            The meter has already moved, so there is no version of this where
            nothing happened — what he chooses is whether the kilometres are
            recorded against a shop he reached or against a trip he abandoned,
            and the second still needs a sentence or the next departure's
            reading will not add up.
          */}
          <View style={{ marginTop: 10 }}>
            <SecondaryButton
              label="I am not going after all"
              onPress={() =>
                askConfirm({
                  title: 'Call off this trip?',
                  body:
                    'It stays on your record with the reason you give — the meter has already moved, and the next trip will not add up without it.',
                  reasonLabel: 'Why · required',
                  confirmLabel: 'Call off the trip',
                  run: (reason) => {
                    void abandonLeg(leg.id, reason).then(() => {
                      notify('Trip called off');
                      router.replace('/journey');
                    });
                  },
                })
              }
            />
          </View>
        </Card>

        <OdometerCamera
          open={metering}
          title="Photograph the meter"
          subtitle="You have arrived — this is where the trip is measured to."
          cancelLabel="Cancel — I have not arrived yet"
          previousKm={leg.startOdometerKm}
          maxLegKilometres={rules?.maxLegKilometres ?? 400}
          onDone={(result) => {
            setMetering(false);
            answerOdometer.current?.(result);
            answerOdometer.current = null;
          }}
        />
      </AppFrame>
    );
  }

  return (
    <AppFrame
      title="Visit"
      activeTab="customers"
      onBack={() => router.back()}
      contentStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 24 }}
      footer={
        <View style={{ backgroundColor: C.surface, borderTopWidth: 1, borderTopColor: C.hairline, paddingHorizontal: 16, paddingVertical: 12, boxShadow: shadow.saveBar }}>
          {!verdict.verified ? (
            <Text style={{ fontSize: 13, lineHeight: 18, color: C.warnInk, marginBottom: 8 }}>{verdict.firstFailure}</Text>
          ) : null}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={type.label}>In the shop</Text>
              <Text style={[{ fontSize: 15, color: C.ink }, weight(500)]}>{elapsedLabel(dwellSeconds)}</Text>
            </View>
            <Pressable
              onPress={() => (verdict.verified ? askTicketThenSave() : notify(verdict.firstFailure))}
              accessibilityLabel={verdict.verified ? 'Save visit' : verdict.firstFailure}
              style={[
                { height: 52, paddingHorizontal: 24, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center', backgroundColor: verdict.verified ? C.primary : C.hairline },
                verdict.verified && { boxShadow: shadow.primary },
              ]}>
              <Text style={[{ fontSize: 16, color: verdict.verified ? '#FFFFFF' : C.faint }, weight(600)]}>Save visit</Text>
            </Pressable>
          </View>
        </View>
      }>
      {/* ---- what was said last time ----
          Shown before the call, not found after it on the timeline. "Will
          pay" typed in a hurry three weeks ago reads exactly like a
          sentence that never named a date — the whole reason a note is
          worth reading back rather than trusted from memory. */}
      {lastTime ? (
        <View
          style={{
            borderWidth: 1,
            borderColor: C.hairline,
            backgroundColor: C.wash,
            borderRadius: radius.xl,
            paddingVertical: 12,
            paddingHorizontal: 16,
            marginBottom: 12,
          }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
            <Text style={type.label}>Last time — {pretty(isoDate(new Date(lastTime.checkInAt)))}</Text>
            {lastTime.outcome ? (
              <Text style={[type.caption, { color: C.body }]}>{lastTime.outcome}</Text>
            ) : null}
          </View>
          <Text style={{ fontSize: 14, lineHeight: 20, color: C.ink, marginTop: 4 }} numberOfLines={3}>
            {lastTime.note}
          </Text>
        </View>
      ) : null}

      {/* ---- where you are ---- */}
      <View
        style={{
          borderWidth: 1,
          borderColor: gpsLocked ? C.primaryEdge : gps === 'off' ? C.warnEdge : C.hairline,
          backgroundColor: gpsLocked ? C.primaryTint : gps === 'off' ? C.warnBg : C.surface,
          borderRadius: radius.xl,
          paddingVertical: 14,
          paddingHorizontal: 16,
        }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View
            style={{
              width: 10,
              height: 10,
              borderRadius: 5,
              backgroundColor: gpsLocked ? C.success : gps === 'off' ? C.warn : C.faint,
            }}
          />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[{ fontSize: 15, color: C.ink }, weight(500)]}>
              {gpsLocked ? 'Checked in here' : gps === 'off' ? 'No GPS fix' : 'Finding you…'}
            </Text>
            <Text style={[type.caption, { color: C.body }]}>
              {gpsLocked
                ? fixReason ?? verdictGeo.sentence
                : gps === 'off'
                  ? fixReason ?? 'The visit will be saved and flagged for your manager to confirm.'
                  : 'This takes a second indoors.'}
            </Text>
          </View>
          {gps === 'off' ? (
            <Pressable
              onPress={() => notify('Saved without a location · flagged for your manager')}
              style={{ height: HIT, paddingHorizontal: 12, borderRadius: radius.sm, borderWidth: 1, borderColor: C.faint, backgroundColor: C.surface, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={[{ fontSize: 15, color: C.body }, weight(500)]}>Carry on</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      <Text style={[type.h2, { marginTop: 16 }]}>{c?.name ?? ''}</Text>
      <Text style={[type.caption, { marginTop: 2 }]}>
        {[c?.contactPerson, c?.city].filter(Boolean).join(' · ')}
      </Text>

      {/* ---- photos ---- */}
      <Card style={{ marginTop: 16 }}>
        <Text style={type.label}>Photos</Text>
        <View style={{ flexDirection: 'row', gap: 12, marginTop: 12 }}>
          {[
            { k: 'shop' as const, ic: 'shop', on: 'Shop ✓', off: 'Shop photo' },
            { k: 'cust' as const, ic: 'person', on: 'Owner ✓', off: 'Owner (optional)' },
          ].map((b) => {
            const has = !!shots[b.k];
            return (
              <Pressable
                key={b.k}
                onPress={() => shoot(b.k)}
                style={{
                  flex: 1,
                  height: 86,
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: has ? C.primary : C.border,
                  backgroundColor: has ? C.primaryTint : C.surface,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                <Icon name={b.ic} size={24} color={has ? C.primaryDeep : C.body} strokeWidth={1.5} />
                <Text style={[{ fontSize: 14, marginTop: 6, color: has ? C.primaryDeep : C.body }, weight(500)]}>
                  {has ? b.on : b.off}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {shots.shop || shots.cust ? (
          <Text style={[type.caption, { marginTop: 10 }]}>Compressed and queued — they upload when you have signal.</Text>
        ) : null}
      </Card>

      {/* ---- what was said ---- */}
      <Card style={{ marginTop: 12 }}>
        <Text style={type.label}>What was said</Text>

        {rec === 'idle' ? (
          <Pressable
            onPress={startRecording}
            style={{ width: '100%', height: 64, marginTop: 12, borderRadius: radius.sm, borderWidth: 1, borderColor: C.primary, backgroundColor: C.primaryTint, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
            <Icon name="mic" size={24} color={C.primaryDeep} strokeWidth={1.5} />
            <Text style={[{ fontSize: 15, color: C.primaryDeep }, weight(600)]}>Hold to talk</Text>
          </Pressable>
        ) : null}

        {rec === 'rec' ? (
          <View style={{ marginTop: 12, borderWidth: 1, borderColor: C.primary, backgroundColor: C.primaryTint, borderRadius: radius.sm, padding: 14 }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', gap: 4, height: 36 }}>
              {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
                <View key={i} style={{ width: 5, height: 12 + (i % 4) * 8, borderRadius: 3, backgroundColor: C.primary }} />
              ))}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 12 }}>
              <Text style={[{ fontSize: 15, color: C.primaryDeep }, weight(500)]}>
                {'Recording · ' + elapsedLabel(Math.round(recorder.currentTime))}
              </Text>
              <Pressable
                onPress={stopRecording}
                style={{ height: HIT, paddingHorizontal: 16, borderRadius: radius.sm, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={[{ fontSize: 15, color: '#FFFFFF' }, weight(500)]}>Done</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {rec === 'busy' ? (
          <View style={{ marginTop: 12, borderWidth: 1, borderColor: C.border, backgroundColor: C.wash, borderRadius: radius.sm, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ width: 18, height: 18, borderWidth: 2, borderColor: C.primaryEdge, borderTopColor: C.primary, borderRadius: 9 }} />
            <Text style={{ fontSize: 15, color: C.body }}>Turning that into text…</Text>
          </View>
        ) : null}

        {rec === 'failed' ? (
          <View style={{ marginTop: 12, borderWidth: 1, borderColor: C.warnEdge, backgroundColor: C.warnBg, borderRadius: radius.sm, padding: 14 }}>
            <Text style={{ fontSize: 13, lineHeight: 19, color: C.warnInk }}>
              No signal to transcribe. The recording is saved and will be turned into text when you are back on.
            </Text>
          </View>
        ) : null}

        {/* The note itself. The transcript is written server-side once the
            recording lands, so what he types here is his own and is never
            overwritten by it. */}
        {rec !== 'rec' && rec !== 'busy' ? (
          <View style={{ marginTop: 12 }}>
            {rec === 'done' ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <View style={{ backgroundColor: C.infoBg, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 }}>
                  <Text style={[{ fontSize: 12, color: C.info, textTransform: 'uppercase', letterSpacing: 0.36 }, weight(500)]}>
                    AI transcribed
                  </Text>
                </View>
                <Text style={type.caption}>Edit before saving</Text>
              </View>
            ) : null}
            <TextInput
              value={note}
              onChangeText={(v) => set({ note: v })}
              multiline
              style={{ width: '100%', minHeight: 96, padding: 12, borderWidth: 1, borderColor: C.border, borderRadius: radius.sm, fontSize: 14, lineHeight: 20, color: C.ink, backgroundColor: C.surface, textAlignVertical: 'top' }}
            />
          </View>
        ) : null}
      </Card>

      {/* ---- how it went ---- */}
      <View style={{ marginTop: 16 }}>
        <Text style={[type.label, { marginBottom: 10 }]}>How did it go</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          {OUTCOMES.map((o) => {
            const on = outcome === o.k;
            return (
              <Pressable
                key={o.k}
                onPress={() => set({ outcome: o.k })}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                style={{
                  /* Two columns, and the odd seventh stays in its own cell —
                     a lone full-width chip reads as a different kind of choice. */
                  width: '48.5%',
                  minHeight: 58,
                  padding: 10,
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: on ? C.primary : C.border,
                  backgroundColor: on ? C.primaryTint : C.surface,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                <Text style={[{ fontSize: 15, lineHeight: 20, textAlign: 'center', color: on ? C.primaryDeep : C.ink }, weight(on ? 600 : 400)]}>
                  {o.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* ---- the follow-on the outcome implies ---- */}
      {followOn ? (
        <View style={{ backgroundColor: C.primaryTint, borderWidth: 1, borderColor: C.primaryEdge, borderRadius: radius.card, paddingVertical: 14, paddingHorizontal: 16, marginTop: 14 }}>
          {doneLine ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: C.successBg, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="task" size={13} color={C.success} strokeWidth={2.4} />
              </View>
              <Text style={[{ fontSize: 15, color: C.ink, flex: 1 }, weight(500)]}>{doneLine}</Text>
            </View>
          ) : (
            <View>
              <Text style={[type.body, { color: C.ink }]}>{followOn.line}</Text>
              <Pressable
                onPress={() => {
                  if (outcome === 'order') return router.push('/order?from=visit');
                  if (outcome === 'payment') return router.push('/pay?from=visit');
                  setDraft({});
                  setFormErr(null);
                  setForm(outcome === 'complaint' ? 'complaint' : 'sample');
                }}
                style={{ width: '100%', height: 52, marginTop: 12, borderRadius: radius.xl, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center', boxShadow: shadow.primaryLift }}>
                <Text style={[{ fontSize: 16, color: '#FFFFFF' }, weight(600)]}>{followOn.cta}</Text>
              </Pressable>
            </View>
          )}
        </View>
      ) : null}

      {/* ---- come back on ---- */}
      <Card style={{ marginTop: 12 }}>
        <Text style={[type.label, { marginBottom: 6 }]}>Come back on</Text>
        <Pressable
          onPress={() => setCalOpen('next')}
          style={{ width: '100%', height: 52, borderWidth: 1, borderColor: C.border, borderRadius: radius.sm, paddingHorizontal: 12, justifyContent: 'center', backgroundColor: C.surface }}>
          <Text style={{ fontSize: 15, color: C.ink }}>{pretty(nextDate)}</Text>
        </Pressable>
        <Text style={[type.caption, { marginTop: 8 }]}>
          {c?.cycleDays
            ? 'Suggested from their ' + c.cycleDays + '-day buying pattern. Change it if they said otherwise.'
            : 'Change it if they said otherwise.'}
        </Text>
      </Card>

      {/* ---- what is missing, and why the rule exists ---- */}
      <View
        style={{
          borderWidth: 1,
          borderColor: verdict.verified ? C.hairline : C.warnEdge,
          backgroundColor: verdict.verified ? C.surface : C.warnBg,
          borderRadius: radius.xl,
          paddingVertical: 14,
          paddingHorizontal: 16,
          marginTop: 16,
          boxShadow: shadow.soft,
        }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
          <Text style={[{ fontSize: 15, color: C.ink }, weight(600)]}>{verdict.title}</Text>
          {verdict.verified ? <Text style={[{ fontSize: 13, color: C.success }, weight(500)]}>Ready</Text> : null}
        </View>

        <View style={{ marginTop: 6 }}>
          {checks.map((k, i) => (
            <View key={k.key} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start', paddingVertical: 10, borderTopWidth: i ? 1 : 0, borderTopColor: C.wash }}>
              <View style={{ width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: k.ok ? C.successBg : C.dangerBg }}>
                {k.ok ? (
                  <Icon name="task" size={12} color={C.success} strokeWidth={2.4} />
                ) : (
                  <Text style={[{ fontSize: 12, color: C.danger }, weight(600)]}>!</Text>
                )}
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[{ fontSize: 14, color: k.ok ? C.ink : C.danger }, weight(k.ok ? 400 : 500)]}>{k.line}</Text>
                {!k.ok ? <Text style={[type.caption, { marginTop: 2 }]}>{k.why}</Text> : null}
              </View>
            </View>
          ))}
        </View>

        {/* The override is logged, not hidden. Nobody parks outside and fakes it. */}
        <Pressable
          onPress={() =>
            askConfirm({
              title: 'Save anyway?',
              body: verdict.overrideBody,
              reasonLabel: 'Why · required',
              confirmLabel: 'Save unverified',
              run: (reason) => {
                set({ overrodeReason: reason });
                /* The ticket is asked for on BOTH save paths. A fare offered
                   only on the clean one would be a fare quietly lost on
                   exactly the visits that already went wrong. */
                askTicketThenSave(reason);
              },
            })
          }
          style={{ width: '100%', minHeight: HIT, marginTop: 10, borderWidth: 1, borderStyle: 'dashed', borderColor: C.faint, borderRadius: radius.md, paddingVertical: 8, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: 13, lineHeight: 18, color: C.muted, textAlign: 'center' }}>
            Cannot meet these? Save it unverified — your manager sees the reason.
          </Text>
        </Pressable>
      </View>

      <View style={{ height: 96 }} />

      {/* ---- complaint, logged without leaving the visit ---- */}
      <BottomSheet open={form === 'complaint'} onClose={() => setForm(null)} scroll>
        <Text style={[type.h2, { letterSpacing: -0.285 }]}>Log a complaint</Text>
        <Text style={[type.small, { color: C.muted, marginTop: 2 }]}>{(c?.name ?? '') + ' · goes to the desk team today'}</Text>

        <Text style={[type.label, { marginTop: 16, marginBottom: 8 }]}>What is it about</Text>
        {COMPLAINT_CATEGORIES.map((x) => (
          <Choice
            key={x}
            label={x}
            selected={draft.cat === x}
            onPress={() => { setDraft({ ...draft, cat: x }); setFormErr(null); }}
            style={{ width: '100%', alignItems: 'flex-start', marginBottom: 8, paddingHorizontal: 14 }}
          />
        ))}
        {formErr === 'cat' ? <Text style={{ fontSize: 13, color: C.danger }}>Pick what it is about.</Text> : null}

        <Text style={[type.label, { marginTop: 14, marginBottom: 6 }]}>In their words</Text>
        <TextInput
          value={draft.what ?? ''}
          onChangeText={(v) => { setDraft({ ...draft, what: v }); setFormErr(null); }}
          multiline
          placeholder="Two drums arrived dented and he refused them"
          placeholderTextColor={C.faint}
          style={{ width: '100%', minHeight: 90, padding: 12, borderWidth: 1, borderColor: formErr === 'what' ? C.danger : C.border, borderRadius: radius.lg, fontSize: 15, color: C.ink, textAlignVertical: 'top' }}
        />
        {formErr === 'what' ? (
          <Text style={{ fontSize: 13, color: C.danger, marginTop: 6 }}>Write what the customer actually said.</Text>
        ) : null}

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
          <Pressable onPress={() => setForm(null)} style={{ flex: 1, height: 52, borderWidth: 1, borderColor: C.border, borderRadius: radius.xl, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={[{ fontSize: 16, color: C.body }, weight(500)]}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={async () => {
              if (!draft.cat) return setFormErr('cat');
              if (!(draft.what ?? '').trim()) return setFormErr('what');
              if (!c) return;
              const id = await logComplaint({
                customerId: c.id,
                category: draft.cat,
                description: draft.what.trim(),
              });
              setLinked((l) => ({ ...l, complaintId: id }));
              markVisitDone('complaint', draft.cat + ' · with the desk team');
              setForm(null);
              setDraft({});
              notify('Complaint logged · the desk team sees it today');
            }}
            style={{ flex: 1, height: 52, borderRadius: radius.xl, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center', boxShadow: shadow.primaryLift }}>
            <Text style={[{ fontSize: 16, color: '#FFFFFF' }, weight(600)]}>Log it</Text>
          </Pressable>
        </View>
      </BottomSheet>

      {/* ---- sample request ---- */}
      <BottomSheet open={form === 'sample'} onClose={() => setForm(null)} scroll>
        <Text style={[type.h2, { letterSpacing: -0.285 }]}>Request a sample</Text>
        <Text style={[type.small, { color: C.muted, marginTop: 2 }]}>{c?.name ?? ''}</Text>

        <Text style={[type.label, { marginTop: 16, marginBottom: 8 }]}>Which product</Text>
        {products.map((x) => (
          <Choice
            key={x.id}
            label={x.name}
            selected={draft.sku === x.id}
            onPress={() => { setDraft({ ...draft, sku: x.id, skuName: x.name }); setFormErr(null); }}
            style={{ width: '100%', alignItems: 'flex-start', marginBottom: 8, paddingHorizontal: 14 }}
          />
        ))}
        {formErr === 'sku' ? <Text style={{ fontSize: 13, color: C.danger }}>Pick the product he wants to try.</Text> : null}

        <Text style={[type.label, { marginTop: 14, marginBottom: 6 }]}>Why he wants it</Text>
        <TextInput
          value={draft.why ?? ''}
          onChangeText={(v) => { setDraft({ ...draft, why: v }); setFormErr(null); }}
          multiline
          placeholder="Comparing against what he buys from Asian"
          placeholderTextColor={C.faint}
          style={{ width: '100%', minHeight: 80, padding: 12, borderWidth: 1, borderColor: formErr === 'why' ? C.danger : C.border, borderRadius: radius.lg, fontSize: 15, color: C.ink, textAlignVertical: 'top' }}
        />
        {formErr === 'why' ? (
          <Text style={{ fontSize: 13, color: C.danger, marginTop: 6 }}>Your manager approves on this reason.</Text>
        ) : null}

        <Text style={[type.label, { marginTop: 14, marginBottom: 6 }]}>Come back on</Text>
        <Pressable
          onPress={() => setCalOpen('trial')}
          style={{ width: '100%', height: 52, borderWidth: 1, borderColor: C.border, borderRadius: radius.lg, paddingHorizontal: 14, justifyContent: 'center', backgroundColor: C.surface }}>
          <Text style={{ fontSize: 16, color: C.ink }}>{pretty(draft.trial ?? defaultTrial())}</Text>
        </Pressable>

        <Text style={[type.caption, { marginTop: 10 }]}>
          Samples need your manager’s approval. The trial follow-up is set for you.
        </Text>

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
          <Pressable onPress={() => setForm(null)} style={{ flex: 1, height: 52, borderWidth: 1, borderColor: C.border, borderRadius: radius.xl, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={[{ fontSize: 16, color: C.body }, weight(500)]}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={async () => {
              if (!draft.sku) return setFormErr('sku');
              if (!(draft.why ?? '').trim()) return setFormErr('why');
              if (!c) return;
              const trial = draft.trial ?? defaultTrial();
              const id = await requestSample({
                customerId: c.id,
                productId: draft.sku,
                productName: draft.skuName ?? '',
                cans: 1,
                reason: draft.why.trim(),
                followUpDate: trial,
              });
              setLinked((l) => ({ ...l, sampleId: id }));
              markVisitDone('sample', (draft.skuName ?? '') + ' · sent for approval');
              setForm(null);
              notify('Sample requested · follow-up set for ' + pretty(trial));
              setDraft({});
            }}
            style={{ flex: 1, height: 52, borderRadius: radius.xl, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center', boxShadow: shadow.primaryLift }}>
            <Text style={[{ fontSize: 16, color: '#FFFFFF' }, weight(600)]}>Request it</Text>
          </Pressable>
        </View>
      </BottomSheet>

      {/* ---- the date picker both of the above share ---- */}
      <BottomSheet open={!!calOpen} onClose={() => setCalOpen(null)}>
        <Text style={[{ fontSize: 17, color: C.ink, marginBottom: 10 }, weight(600)]}>
          {calOpen === 'trial' ? 'Trial follow-up' : 'Come back on'}
        </Text>
        <Calendar
          selected={calOpen === 'trial' ? draft.trial ?? defaultTrial() : nextDate}
          onPick={(iso) => {
            if (calOpen === 'trial') setDraft({ ...draft, trial: iso });
            else set({ nextDate: iso });
            setCalOpen(null);
          }}
        />
      </BottomSheet>

      {/* ────────────────────────────────────── the ticket, on the way out */}
      <BottomSheet
        open={ticketOpen}
        /*
          BACKING OUT IS SKIPPING, and it saves the visit rather than
          cancelling it. A sheet that swallowed the save when dismissed would
          make the ticket a gate by accident — he would press Save, tap
          outside, and find nothing had happened.
        */
        onClose={() => {
          setTicketOpen(false);
          void saveAndGo(elapsedLabel(dwellSeconds), pendingUnverified);
        }}>
        <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 20 }}>
          <Text style={[{ fontSize: 17, lineHeight: 22, color: C.ink }, weight(600)]}>
            {leg?.mode === 'train' ? 'Your train ticket' : 'Your bus ticket'}
          </Text>
          <Text style={{ fontSize: 14, lineHeight: 20, color: C.body, marginTop: 6 }}>
            Photograph it and it becomes a travel claim straight away. If you have not got
            it on you, skip — you can still claim the fare from Expenses.
          </Text>

          <Pressable
            onPress={() => void shootTicket()}
            style={{
              height: 86,
              marginTop: 14,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: ticketShot ? C.primary : C.border,
              backgroundColor: ticketShot ? C.primaryTint : C.surface,
              alignItems: 'center',
              justifyContent: 'center',
            }}>
            <Icon name="camera" size={24} color={ticketShot ? C.primaryDeep : C.body} strokeWidth={1.5} />
            <Text style={[{ fontSize: 14, marginTop: 6, color: ticketShot ? C.primaryDeep : C.body }, weight(500)]}>
              {ticketShot ? 'Ticket photographed ✓ — tap to retake' : 'Photograph the ticket'}
            </Text>
          </Pressable>

          {/* The fare is asked for only once there IS a ticket. A figure with
              no photograph behind it is a claim this screen has no business
              taking — that is what the Expenses screen is for, where the bill
              rule is stated. */}
          {ticketShot ? (
            <View style={{ marginTop: 12 }}>
              <Text style={type.label}>What did it cost?</Text>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                  marginTop: 6,
                  borderWidth: 1,
                  borderColor: fareErr ? C.danger : C.border,
                  borderRadius: radius.md,
                  paddingHorizontal: 14,
                }}>
                <Text style={[{ fontSize: 17, color: C.body }, weight(500)]}>₹</Text>
                <TextInput
                  value={fare}
                  onChangeText={(v) => {
                    setFare(v);
                    if (fareErr) setFareErr(null);
                  }}
                  keyboardType="decimal-pad"
                  placeholder="40"
                  placeholderTextColor={C.faint}
                  autoFocus
                  accessibilityLabel="Ticket fare in rupees"
                  style={{ flex: 1, height: 52, fontSize: 18, color: C.ink }}
                />
              </View>
              {fareErr ? (
                <Text style={{ fontSize: 13, lineHeight: 18, color: C.danger, marginTop: 6 }}>{fareErr}</Text>
              ) : null}
            </View>
          ) : null}

          <View style={{ marginTop: 16, gap: 10 }}>
            <PrimaryButton
              label={ticketBusy ? 'Claiming…' : 'Claim it and save the visit'}
              onPress={() => void claimTicket()}
              disabled={!ticketShot || ticketBusy}
              whyDisabled="Photograph the ticket first."
            />
            <SecondaryButton
              label="Skip — I will claim it later"
              onPress={() => {
                setTicketOpen(false);
                void saveAndGo(elapsedLabel(dwellSeconds), pendingUnverified);
              }}
            />
          </View>
        </View>
      </BottomSheet>
    </AppFrame>
  );
}

/** A week out — long enough to have tried it, short enough to still remember. */
function defaultTrial(): string {
  return isoDate(new Date(Date.now() + 7 * 86_400_000));
}
