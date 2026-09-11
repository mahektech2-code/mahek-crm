import React from 'react';
import { View, Text, Pressable, TextInput } from 'react-native';
import { router, useNavigation } from 'expo-router';
import { color as C, HIT, radius, shadow, type, weight } from '../src/theme/tokens';
import { Icon } from '../src/components/ui/Icon';
import { Card, Choice, PrimaryButton, SecondaryButton } from '../src/components/ui/primitives';
import { BottomSheet, Calendar } from '../src/components/ui/overlays';
import { AppFrame } from '../src/components/shell/AppFrame';
import { OdometerCamera, type OdometerResult } from '../src/components/ui/odometer-camera';
import {
  abandonLeg,
  arriveForVisit,
  arrivedLegFor,
  attachTicketToLeg,
  bindLegToVisit,
  openLegOf,
  travelModes,
  type TravelLeg,
  type TravelMode,
} from '../src/data/travel';
import { arrivalPrompt, checkFare, legLine, navigationLine, travellingFor } from '../src/lib/travel-leg';
import { suspectFor, visitCapThresholds } from '../src/data/leads';
import { visitCapLabel, visitCapState, type VisitCapThresholds } from '../src/engines/leads';
import { useCustomer, useStore } from '../src/state/store';
import { useBoot } from '../src/state/boot';
import { isoDate, pretty } from '../src/lib/format';
import { elapsedLabel, FOLLOW_ON, visitChecks, visitVerdict } from '../src/lib/visit';
import { COMPLAINT_CATEGORIES, OUTCOMES } from '../src/data/fixtures';
import { getConfig } from '../src/data/config';
import { previousVisitNote, saveVisit, type PreviousNote } from '../src/data/visits';
import { logComplaint, requestSample } from '../src/data/requests';
import { starterProducts } from '../src/data/customers';
import { todayStops } from '../src/data/journey';
import {
  checkInVerdict,
  haversineMetres,
  visitLocationVerdict,
  type CheckInVerdict,
} from '../src/engines/geo';
import { fixOf, getFix, type Fix } from '../src/native/location';
import { queueOdometerPhoto, queueRecording, takePhoto } from '../src/native/capture';
import { discardQueuedMedia } from '../src/sync/media';
import { VoiceField } from '../src/components/ui/dictate';
import { NavigateButton } from '../src/components/ui/navigate';

/**
 * Capturing a visit.
 *
 * The rule that shapes this screen: the save is never refused outright. The
 * checklist says what is missing and why the rule exists, and the dashed
 * button under it saves anyway — unverified, with a reason, and the manager
 * told. A salesman who cannot log a visit stops logging visits, and then the
 * office knows nothing at all.
 *
 * The GPS follows the same rule one level down, at the SAVE. A fix is evidence
 * there, never a gate: no fix, a fix accurate to half a kilometre, or a shop
 * whose recorded coordinates are simply wrong all let the visit through and
 * are recorded as what they are.
 *
 * **THE ARRIVAL IS THE EXCEPTION, and it is the one thing on this screen that
 * refuses.** Mahek asked for a check-in measurably outside the radius to be
 * turned down rather than flagged, and the arrival is the only place that can
 * honestly happen: nothing has been typed yet, so a refusal costs a walk to
 * the right door instead of a day's work, and he can press the button again.
 * `checkInVerdict` decides it and refuses only what a reading can prove — no
 * fix, a fix too wide to trust and a shop with no pin all still go through.
 * The way past a refusal is a typed sentence, which saves the visit unverified
 * and goes to his manager: the pin in this book is very often the wrong one,
 * and a salesman who cannot record being where he actually is stops recording.
 */

type Product = { id: string; name: string; packSize: string | null };

/*
 * How often the On-your-way screen asks the radio where he is, and the range at
 * which that question changes character.
 *
 * NEITHER IS A BUSINESS RULE, which is why neither is in the registry. Nothing
 * is priced, refused or paid on these: the cadence is how often one line of
 * text is refreshed while a screen that only exists mid-journey is open, and
 * the range is where a distance stops meaning "is it worth going" and starts
 * meaning "which doorway". What IS configuration is the age at which a reading
 * is called stale — `mbos.location.activityFixMaxAgeSeconds`, read below —
 * because that decides what a screen ASSERTS about a fix.
 */
const ROAD_FIX_EVERY_MS = 20_000;
const APPROACHING_M = 1_000;

export default function Visit() {
  const c = useCustomer();
  const boot = useBoot();
  const gps = useStore((s) => s.gps);
  const shots = useStore((s) => s.shots);
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
  /*
   * ONE COMPLAINT PER PRESS, and one sample.
   *
   * Both sheets wrote on a bare async handler with nothing disabled while it
   * ran, and `logComplaint` mints a fresh id on every call — so a second tap
   * on a slow write produced two complaints, of which `setLinked` kept only
   * the second. The first reached the desk team attached to no visit at all.
   *
   * The ref is what actually guards, because it is set synchronously: a
   * `useState` flag is read from the closure of the render that drew the
   * button, which is exactly the render where it was still false. The state
   * beside it is only what the label and the disabled look are drawn from.
   *
   * One pair for both sheets: `form` holds one or the other, never both.
   */
  const formBusy = React.useRef(false);
  const [formSaving, setFormSaving] = React.useState(false);
  /*
   * A week out, worked out ONCE when the screen opens.
   *
   * `defaultTrial()` was called from the render path — a clock read during
   * render, which this app forbids and the compiler lint watches for — and it
   * was called again from the save, so a screen open across midnight could
   * offer one date and store another.
   */
  const [trialDefault] = React.useState(defaultTrial);

  /* Everything captured here that is not yet a visit: the fix, the recording,
     the records punched from inside it. `saveVisit` binds the lot in one
     transaction — a half-saved visit describes something that never happened. */
  const [fix, setFix] = React.useState<Fix | null>(null);
  const [fixReason, setFixReason] = React.useState<string | null>(null);
  const [voiceNoteId, setVoiceNoteId] = React.useState<string | null>(null);
  /*
   * §B — is this shop still a Suspect, and is a decision due?
   *
   * Null for anything that is not a lead, which is most of the book: a real
   * customer is never asked to justify a visit. Loaded rather than derived,
   * because the count includes visits the office knows about and this phone
   * does not.
   */
  const [suspect, setSuspect] = React.useState<{ stage: string; visits: number } | null>(null);
  const [capCfg, setCapCfg] = React.useState<VisitCapThresholds | null>(null);
  const [decision, setDecision] = React.useState<string | null>(null);
  const [decisionWhy, setDecisionWhy] = React.useState('');
  const [decisionErr, setDecisionErr] = React.useState<string | null>(null);
  /* §G — the requirement visit. Shown on a lead only: asking a customer of four
     years what they are looking for is a question they have answered by
     ordering, and a field nobody fills teaches people to scroll past the form. */
  const [reqWhat, setReqWhat] = React.useState('');
  const [reqLitres, setReqLitres] = React.useState('');
  const [reqCans, setReqCans] = React.useState('');

  React.useEffect(() => {
    if (!c?.id) return;
    let live = true;
    void Promise.all([suspectFor(c.id), visitCapThresholds()]).then(([sus, cfg]) => {
      if (!live) return;
      setSuspect(sus);
      setCapCfg(cfg);
    });
    return () => {
      live = false;
    };
  }, [c?.id]);

  /* `ok` | `warn` | `decide`, and nothing here ever blocks the visit being
     MADE — see the note above `visitCapState`. What `decide` blocks is closing
     it without an answer, which is a different thing and the thing §B wants. */
  const capState =
    suspect && capCfg ? visitCapState(suspect.stage, suspect.visits, capCfg) : 'ok';
  /*
   * "Visit 3 / 3" — the visit being MADE, not the ones already made.
   *
   * `suspect.visits` is the count the office holds and `visitCapState` adds
   * this one before it compares, so on the third visit to a Suspect the card
   * demanded the decision under a heading reading "Visit 2 / 3" — a counter
   * saying he still had one in hand. The number and the demand contradicted
   * each other on one card, which reads as a bug and gets the answer picked at
   * random to get past it. Asked of the engine rather than retyped here, so
   * the wording and the rule cannot drift apart.
   */
  const capLabel =
    suspect && capCfg ? visitCapLabel(suspect.stage, suspect.visits + 1, capCfg) : null;
  const [linked, setLinked] = React.useState<{ complaintId?: string; sampleId?: string }>({});
  const [products, setProducts] = React.useState<Product[]>([]);
  const [stopId, setStopId] = React.useState<string | null>(null);
  /*
   * ONE VISIT PER PRESS.
   *
   * Four call sites reach `saveAndGo` — the save bar, the unverified path, the
   * ticket sheet's Skip and its scrim, and `claimTicket`'s own `finally` — and
   * the guard was a `useState` flag, which is read from the closure of the
   * render that drew the control. While the ticket was being attached, a tap on
   * Skip saved the visit and the `finally` then saved it AGAIN from an older
   * closure where `saving` was still false: two rows, two queue items, two
   * timeline events, and the office seeing one shop visited twice in a minute.
   * The ref is set synchronously, so whichever call arrives first shuts the
   * others out; the state beside it is only what the screen is drawn from.
   */
  const savingRef = React.useRef(false);
  const [saving, setSaving] = React.useState(false);
  const [lastTime, setLastTime] = React.useState<PreviousNote | null>(null);

  /* Thresholds, never constants: the dwell floor and the distance that counts
     as a mismatch are both a manager's to move. */
  const [minDwell, setMinDwell] = React.useState(120);
  const [maxLegKm, setMaxLegKm] = React.useState(400);
  const [maxMetres, setMaxMetres] = React.useState(100);

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

  /**
   * LEAVING A VISIT IN PROGRESS IS ASKED ABOUT, because there is no way back
   * into one.
   *
   * The screen draws the full tab bar and a back chevron, and a tab tap is a
   * `replace` — so one mis-tap while standing in the shop took the note, both
   * photographs, the outcome and the dwell clock with it. Nothing anywhere
   * warned, and every route back in goes through `beginVisit`, which blanks all
   * of that and opens a SECOND journey with a second odometer photograph. The
   * journey screen's "Continue" only shows while the leg is still open, so once
   * he has arrived there is no path back at all.
   *
   * It hangs off the navigator's own `beforeRemove` rather than off the back
   * button, because the back button is the one departure that already looks
   * deliberate — the tab bar is the one that does not, and it is the same event.
   * `leavingRef` is what lets the departures this screen itself makes through:
   * the action is re-dispatched unchanged, and it carries the set of routes it
   * has already asked, so it cannot come back round a second time.
   *
   * Only once he has ARRIVED. On the way there the clock has not started and
   * nothing has been typed, and the trip is called off with its own button.
   */
  const navigation = useNavigation();
  const leavingRef = React.useRef(false);
  React.useEffect(() => {
    if (visitStart == null) return;
    return navigation.addListener('beforeRemove', (e) => {
      if (leavingRef.current) return;
      e.preventDefault();
      askConfirm({
        title: 'Leave this visit?',
        body:
          'Your note, your photographs and the time since you arrived are all lost — none of it has been saved yet, and starting the visit again means a fresh journey and another meter reading.',
        confirmLabel: 'Leave and lose it',
        run: () => {
          leavingRef.current = true;
          navigation.dispatch(e.data.action);
        },
      });
    });
  }, [navigation, visitStart, askConfirm]);

  /* ---- the journey that got him here ----
     Read from SQLite, not the store: the app is routinely killed on the road
     and a leg held in memory would be gone by the time he walked in. `null`
     after `legLoaded` means the visit was started before travel legs existed
     or by a path that does not ask — and that visit still saves as it always
     did. */
  const [leg, setLeg] = React.useState<TravelLeg | null>(null);
  const [legLoaded, setLegLoaded] = React.useState(false);
  const [modes, setModes] = React.useState<TravelMode[]>([]);
  const [arriving, setArriving] = React.useState(false);
  const [metering, setMetering] = React.useState(false);
  /*
   * The refusal, held so the card can say the distance rather than raise a
   * toast that is gone before he has read it. Cleared on the next attempt: it
   * describes ONE reading, and he has walked since.
   */
  const [refused, setRefused] = React.useState<CheckInVerdict | null>(null);
  /*
   * The distance he was refused at, kept past the refusal for the pin question
   * that follows an override.
   *
   * That sheet reads `verdictGeo`, which is computed from a SECOND, fresh
   * reading taken when he says he is at the shop — and that one can come back
   * with nothing, leaving the sheet asking him to move a pin "about ? m",
   * which is the one number that makes the question answerable. This reading
   * was measured, seconds earlier, from the same spot.
   *
   * Display only. It is deliberately NOT fed into `metresFromShop`, which has
   * to describe the fix actually stored on the row.
   */
  const [refusedMetres, setRefusedMetres] = React.useState<number | null>(null);
  /*
   * What he said to get past it, and what he was asked next.
   *
   * `overrideReason` rides all the way to the save — it is what makes the
   * visit unverified and what his manager reads — and losing it between the
   * door and the save is how a flagged visit quietly becomes a clean one.
   */
  const [overrideReason, setOverrideReason] = React.useState<string | null>(null);
  const [pinAsk, setPinAsk] = React.useState(false);
  const [pinRequested, setPinRequested] = React.useState(false);
  const answerOdometer = React.useRef<((r: OdometerResult) => void) | null>(null);

  /* ---- the ticket, asked once on the way out ---- */
  const [ticketOpen, setTicketOpen] = React.useState(false);
  const [ticketShot, setTicketShot] = React.useState<string | null>(null);
  const [fare, setFare] = React.useState('');
  const [ticketRef, setTicketRef] = React.useState('');
  const [fareErr, setFareErr] = React.useState<string | null>(null);
  const ticketBusyRef = React.useRef(false);
  const [ticketBusy, setTicketBusy] = React.useState(false);
  /* Carried across the ticket question so an unverified save that detours
     through it still saves as unverified. Losing it here would silently
     upgrade a flagged visit to a clean one. */
  const [pendingUnverified, setPendingUnverified] = React.useState<string | null>(null);

  const custId = c?.id ?? null;
  const userId = boot.session?.user.id ?? '';

  /*
   * The leg he is on, or the one he closed to get here.
   *
   * Both in one read, because they are the same journey at two moments and the
   * screen has to tell them apart: an OPEN leg means he is still travelling
   * and the visit has not begun; a CLOSED one is the journey the visit will be
   * stamped onto when it saves.
   *
   * By person AND by shop. Reading by person alone would hand him a journey to
   * a different shop the moment he opened somebody else's record on the road.
   */
  const loadLeg = React.useCallback(() => {
    let live = true;
    if (!custId || !userId) return;
    void Promise.all([openLegOf(userId), arrivedLegFor(userId, custId), travelModes()])
      .then(([running, arrived, rows]) => {
        if (!live) return;
        setModes(rows);
        setLeg(running && running.customerId === custId ? running : arrived);
        setLegLoaded(true);
      })
      .catch(() => {
        /* A read that FAILED is not a journey still loading, and the screen
           below holds everything until this flag is set. `leg` is left exactly
           as it stands — null on the first pass, which is the "no leg behind
           this visit" case the note above describes, so the form opens as it
           always did rather than the screen reading "Reading…" for ever. */
        if (live) setLegLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [custId, userId]);
  React.useEffect(loadLeg, [loadLeg]);

  const legMode = leg ? modes.find((m) => m.key === leg.modeKey) ?? null : null;
  const needsMeter = !!legMode?.requiresOdometer;

  /* ---- how far there is left to go ----
   *
   * ONLY WHILE HE IS ON THE ROAD. This is the one screen in the app that is
   * open precisely because somebody is travelling, and it closes the moment he
   * says he is here — so a fix taken on a short cadence costs the radio a few
   * minutes of a ride rather than a day, and buys the only number this screen
   * was missing: whether the shop is round the corner or in the wrong town.
   *
   * The reading is BALANCED at range and PRECISE on the approach. Under a
   * kilometre the figure stops being "is it worth going" and becomes "which
   * doorway", and a fix good to a city block cannot answer the second — while
   * paying for that accuracy over a ten-kilometre ride would buy nothing the
   * rounding does not throw away. The check-in at the end is precise for the
   * same reason, one step further along.
   */
  const onTheRoad = legLoaded && !!leg && leg.endedAt == null;
  /* The pin as two numbers rather than as the customer, so the timer below
     restarts when the SHOP moves and not every time the record is re-read. */
  const pinLat = c?.gpsLat ?? null;
  const pinLng = c?.gpsLng ?? null;
  const [roadFix, setRoadFix] = React.useState<Fix | null>(null);
  /* The same reading, reachable from inside the interval without becoming a
     dependency of it: naming the state there would tear the timer down and
     rebuild it on every fix, which is a cadence nobody chose. */
  const roadFixRef = React.useRef<Fix | null>(null);
  const [staleAfterS, setStaleAfterS] = React.useState(900);
  React.useEffect(() => {
    void getConfig<number>('mbos.location.activityFixMaxAgeSeconds', 900).then(setStaleAfterS);
  }, []);
  React.useEffect(() => {
    if (!onTheRoad) return;
    let live = true;
    const shop = pinLat != null && pinLng != null ? { lat: pinLat, lng: pinLng } : null;

    async function read() {
      const near =
        shop && roadFixRef.current
          ? haversineMetres(roadFixRef.current, shop) < APPROACHING_M
          : false;
      const got = fixOf(
        await getFix({ accuracyThresholdM: 100, timeoutMs: 12_000, precise: near }),
      );
      /* A failed reading leaves the previous one standing rather than blanking
         the line — the last known distance with its age on it is worth more
         than nothing at all, which is what `navigationLine` is built to say. */
      if (live && got) {
        roadFixRef.current = got;
        setRoadFix(got);
      }
    }

    void read();
    const t = setInterval(() => void read(), ROAD_FIX_EVERY_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [onTheRoad, pinLat, pinLng]);

  React.useEffect(() => {
    let live = true;
    void Promise.all([
      getConfig<number>('mbos.visits.minimumDwellSeconds', 120),
      getConfig<number>('mbos.location.visitMismatchM', 100),
      starterProducts(5),
      todayStops(),
      getConfig<number>('mbos.travel.maxLegKilometres', 400),
    ]).then(([dwell, metres, skus, stops, maxKm]) => {
      if (!live) return;
      setMinDwell(dwell);
      setMaxMetres(metres);
      setMaxLegKm(maxKm);
      setProducts(skus);
      /* A stop on today's plan makes this a planned visit and gets marked
         visited when the save lands. */
      setStopId(stops.find((s) => s.customerId === custId && s.status === 'planned')?.id ?? null);
    });
    return () => {
      live = false;
    };
  }, [custId]);

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
   * He is here. This is where the visit actually begins — or does not.
   *
   * THE FIX COMES BEFORE THE CAMERA, which reverses the order this function
   * shipped with. The two used to overlap deliberately: the radio settled
   * while the meter was photographed, which cost nothing because nothing could
   * turn the arrival down. Now something can. Photographing the meter first
   * would mean taking a picture, queueing it, and then being told he is three
   * hundred metres away — leaving a photograph of a reading he has to take
   * again, attached to a leg that is still open. So the one thing that can
   * refuse is asked first, and the camera only opens once the arrival is
   * certain to happen.
   *
   * `precise` on the fix for the same reason: this reading now decides
   * something. See `getFix`.
   *
   * `override` is his own sentence, given after a refusal. Passed in rather
   * than read from state because the confirm dialog hands it back and state
   * set a line earlier is not yet readable here.
   */
  const arriveHere = async (override?: string) => {
    if (!leg || arriving) return;
    setArriving(true);
    try {
      const [threshold, radiusM] = await Promise.all([
        getConfig<number>('mbos.location.gpsAccuracyThresholdM', 50),
        getConfig<number>('mbos.location.visitMismatchM', 100),
      ]);
      const result = await getFix({ accuracyThresholdM: threshold, precise: true });
      const got = fixOf(result);

      const gate = checkInVerdict(
        got ? { lat: got.lat, lng: got.lng, accuracyM: got.accuracyM } : null,
        c && c.gpsLat != null && c.gpsLng != null ? { lat: c.gpsLat, lng: c.gpsLng } : null,
        radiusM,
        threshold,
      );
      if (!gate.accepted && !override) {
        /* NOTHING IS WRITTEN. The leg stays open because he is still
           travelling, the dwell clock does not start, and no meter has been
           photographed — so pressing the button again from the right place
           costs him nothing and leaves nothing behind. */
        setRefused(gate);
        /* Kept for the pin question that an override leads to — see
           `refusedMetres`. `too_far` is the only refusal there is, and it
           always carries the distance. */
        if (gate.metresAway != null) setRefusedMetres(Math.round(gate.metresAway));
        return;
      }
      setRefused(null);

      let odometer: { km: number; photoId: string } | null = null;
      if (needsMeter) {
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
       * and they must be the same reading — two acquisitions seconds apart
       * would let the arrival and the check-in disagree about where the shop
       * is, and a manager reading a mismatch would have no way to tell which
       * of the two was being questioned. It is also the reading the gate above
       * was answered on, which is the third thing that must not drift: a
       * salesman let through on one fix and recorded on another would read as
       * having been allowed past a distance nobody measured.
       */
      setFix(got);
      setFixReason(result.status === 'ok' ? null : result.reason);
      set({ gps: got ? 'locked' : 'off' });

      const at = Date.now();
      await arriveForVisit({
        legId: leg.id,
        fix: got ? { lat: got.lat, lng: got.lng } : null,
        odometer,
      });

      if (override) setOverrideReason(override);
      /* The dwell clock starts on the instant written onto the leg, not on a
         second reading of the clock — see `arrivedAt` in the store. */
      arrivedAt(at);
      loadLeg();
      /*
       * ASKED AFTER HE IS IN, never before. It is a second question about a
       * different thing — the book, not him — and putting it in front of the
       * arrival would make getting into the shop depend on answering it.
       * Only where there is a pin to be wrong about: a shop with no pin is
       * being pinned by this check-in already.
       */
      if (override && c?.gpsLat != null && c?.gpsLng != null) setPinAsk(true);
    } catch {
      notify('That arrival could not be recorded on this phone. Nothing has been lost — try again.');
    } finally {
      setArriving(false);
    }
  };

  /**
   * The way past a refusal, and the only one.
   *
   * A required sentence, because this is the whole of what a manager gets: the
   * distance is already on the record and says nothing about which of the two
   * readings is wrong. `askConfirm` refuses to close without it.
   */
  const overrideRefusal = () =>
    askConfirm({
      title: 'Are you at the shop?',
      body:
        'Say so and the visit is recorded from here, marked unverified, with your reason sent to your manager. The shop’s own location in MahekOne may simply be wrong — a lot of them are — and this is how that gets found out.',
      reasonLabel: 'Where you actually are · required',
      confirmLabel: 'I am at the shop',
      run: (reason) => {
        void arriveHere(reason);
      },
    });

  /**
   * The recording, queued for the office.
   *
   * Called by the note's microphone in BOTH of its modes — dictated on signal,
   * kept for later without — because a visit is the one place the audio is
   * worth having either way: it is what the customer actually said, and the
   * words in the box are somebody's reading of it.
   *
   * `pending` as the parent, exactly as a shop photograph is. The visit does
   * not exist yet; `saveVisit` claims the media when it does.
   */
  const keepVoiceNote = async (uri: string, mode: 'dictate' | 'record') => {
    try {
      /* Said again means the last one was not wanted. Dropped before the new
         one is queued, so a visit carries the recording it kept and not every
         attempt at it. */
      if (voiceNoteId) await discardQueuedMedia(voiceNoteId);
      const mediaId = await queueRecording(uri, 'visit', 'pending');
      setVoiceNoteId(mediaId);
      set({ voice: mode === 'dictate' ? 'dictated' : 'queued' });
    } catch {
      /* A save is never blocked by a recording. The note he read and approved
         is already in the box; losing the audio behind it costs the office a
         second copy of something it can already read. */
      notify('That recording could not be kept, but your note is safe.');
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

  /* ---- the two records punched from inside the visit ----
   *
   * Named rather than written inline on the button, because both need the
   * in-flight lock above and a failure has to be SAID: a bottom sheet is a
   * Modal and the app's toast lives underneath it, so a `notify` raised while
   * the sheet is open is a sentence nobody sees. The message goes in the
   * sheet, beside the button that was pressed.
   */
  const submitComplaint = async () => {
    if (formBusy.current) return;
    if (!draft.cat) return setFormErr('cat');
    if (!(draft.what ?? '').trim()) return setFormErr('what');
    if (!c) return;
    formBusy.current = true;
    setFormSaving(true);
    try {
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
    } catch {
      setFormErr('save');
    } finally {
      formBusy.current = false;
      setFormSaving(false);
    }
  };

  const submitSample = async () => {
    if (formBusy.current) return;
    if (!draft.sku) return setFormErr('sku');
    if (!(draft.why ?? '').trim()) return setFormErr('why');
    if (!c) return;
    formBusy.current = true;
    setFormSaving(true);
    const trial = draft.trial ?? trialDefault;
    try {
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
    } catch {
      setFormErr('save');
    } finally {
      formBusy.current = false;
      setFormSaving(false);
    }
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
    checkInOverridden: !!overrideReason,
    hasShopPhoto: !!shots.shop,
    outcome,
    followOnCaptured: !!(outcome && visitDone[outcome]),
  });
  const verdict = visitVerdict(checks, { checkInOverridden: !!overrideReason });
  const followOn = outcome ? FOLLOW_ON[outcome] : undefined;
  const doneLine = outcome ? visitDone[outcome] : undefined;

  /**
   * §B's one refusal, asked BEFORE anything else happens rather than after.
   *
   * It is the only thing that stops a save on this screen, and it stops it to
   * ask rather than to refuse — but the asking was invisible: `saveAndGo` set
   * an error that renders inside the Suspect card, six hundred points above the
   * button he had just pressed, with no toast and no change to the button. He
   * pressed Save, nothing appeared to happen, and the ordinary conclusion is
   * that the handset is broken. Worse down the ticket path, where the fare was
   * attached and toasted "Ticket added" while the visit silently did not save.
   *
   * So it is a function both entry points ask, the sentence goes to the bottom
   * of the screen as well as into the card, and the ticket sheet never opens on
   * a save that cannot go through.
   */
  function missingDecision(): string | null {
    if (capState === 'decide' && !decision) {
      return 'Say which way this one goes before you close the visit.';
    }
    if (decision === 'still_suspect' && !decisionWhy.trim()) {
      return 'Say why we are still going — somebody will ask.';
    }
    return null;
  }

  function refuseForDecision(why: string) {
    setDecisionErr(why);
    /* The card is above the fold; the button is not. Said in both places. */
    notify(why);
  }

  /**
   * The ticket, asked once, on the way out.
   *
   * IT IS A QUESTION AND NEVER A GATE. Skipping is offered in words — the fare
   * can still be added on the Travel screen, where the day is priced — so
   * nobody skips it believing the money is gone. A bus ticket is a scrap of
   * paper that gets lost between the seat and the shop door, and refusing the
   * visit over one would mean refusing to record a visit that happened, which
   * is the rule this whole screen is built on.
   *
   * Asked once and not again: a leg already carrying a fare goes straight
   * through, because one trip is one fare and being asked twice is how
   * somebody claims it twice.
   */
  function askTicketThenSave(unverifiedReason: string | null = null) {
    /* Asked here as well as in the save, so the fare is never collected against
       a visit that is about to be turned back. */
    const missing = missingDecision();
    if (missing) return refuseForDecision(missing);
    const wants = leg && legMode?.requiresTicket && leg.ticketAmountPaise == null;
    if (!wants) {
      void saveAndGo(elapsedLabel(dwellSeconds), unverifiedReason);
      return;
    }
    setTicketShot(null);
    setFare('');
    setTicketRef('');
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
    /* The ref, for the same reason as `savingRef`: `PrimaryButton` keeps a
       button with a `whyDisabled` pressable on purpose, so a second tap runs
       this handler from the render where `ticketBusy` was still false. */
    if (!leg || ticketBusyRef.current) return;
    const verdict = checkFare(fare);
    if (!verdict.ok) {
      setFareErr(verdict.why);
      return;
    }
    ticketBusyRef.current = true;
    setTicketBusy(true);
    try {
      await attachTicketToLeg({
        legId: leg.id,
        amountPaise: verdict.paise,
        photoId: ticketShot,
        reference: ticketRef.trim() || null,
      });
      setTicketOpen(false);
      notify('Ticket added to today’s travel');
      loadLeg();
    } catch {
      /* THE VISIT IS NOT LOST TO A FAILED FARE. He goes on to save it and the
         ticket stays addable on the Travel screen — exactly what skipping
         would have left him with. */
      notify('The ticket could not be added just now — save the visit and add it from Travel.');
      setTicketOpen(false);
    } finally {
      ticketBusyRef.current = false;
      setTicketBusy(false);
      void saveAndGo(elapsedLabel(dwellSeconds), pendingUnverified);
    }
  };

  async function saveAndGo(spent: string, unverifiedReason: string | null) {
    if (!c || savingRef.current) return;

    /*
     * The one thing that stops a save here, and it stops it to ASK rather than
     * to refuse: past the cap the salesman says which way the lead goes before
     * the visit closes. The visit is still recorded — this is a field on the
     * same form, not a rejection — and the server checks the same rule against
     * the same two configured numbers.
     */
    const missing = missingDecision();
    if (missing) return refuseForDecision(missing);

    savingRef.current = true;
    setSaving(true);
    /* The coordinates only. WHEN comes off the dwell clock below — a visit made
       where there is no signal is still a visit that happened at a time. */
    const checkOut: Fix | null = fix ? { ...fix, at: now } : null;
    let visitId: string;
    try {
      visitId = await saveVisit({
        customerId: c.id,
        customerName: c.name,
        userId: boot.session?.user.id ?? '',
        checkIn: fix,
        checkOut,
        /*
         * THE CLOCK, NOT THE FIX.
         *
         * Both instants used to be read off `Fix.at`, so a visit made inside a
         * godown — no fix, which is the case this whole app is designed around
         * — was stored with no check-in instant, no duration and left open for
         * ever: absent from the day's count, never closed by the day-boundary
         * sweep, and printing 1 Jan 1970 on the next visit's "Last time" card.
         * `visitStart` is the moment he said he had arrived, and it exists
         * whether or not the radio answered.
         *
         * Where there was no arrival at all — a visit opened by a path that
         * never asked, which is the only way `visitStart` is null here — the
         * row is stamped at the save and left OPEN rather than claiming a
         * duration of zero that nobody measured.
         */
        checkInAt: visitStart ?? now,
        checkOutAt: visitStart == null ? null : now,
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
        locationMismatch: verdictGeo.mismatch,
        metresFromShop: metresAway,
        /*
         * AN OVERRIDDEN CHECK-IN IS NEVER A CLEAN VISIT, whatever the
         * checklist showed.
         *
         * `visitChecks` lets the gps check read OK on an override so he is not
         * asked for a second sentence at the save — but that is about not
         * asking twice, and it must not become a claim that the visit
         * verified. The server reaches the same answer from the same reason
         * and does not trust this flag; what these two lines keep true is that
         * the record on his OWN phone says what the office's says, and that
         * `saveVisit` raises the "saved unverified" notice it should.
         */
        verified: unverifiedReason == null && !overrideReason,
        unverifiedReason:
          unverifiedReason ??
          (overrideReason ? `Checked in past the ${maxMetres} m radius: ${overrideReason}` : null),
        checkInOverrideReason: overrideReason,
        pinCorrectionRequested: pinRequested,
        linkedComplaintId: linked.complaintId ?? null,
        linkedSampleId: linked.sampleId ?? null,
        suspectDecision: decision,
        suspectReason: decisionWhy.trim() || null,
        requirement: reqWhat.trim() || null,
        monthlyVolumeLitres: Number(reqLitres.replace(/[^\d]/g, '')) || null,
        quantityCans: Number(reqCans.replace(/[^\d]/g, '')) || null,
      });
    } catch {
      savingRef.current = false;
      setSaving(false);
      notify('The visit could not be saved on this phone. Nothing has been lost — try again.');
      return;
    }

    /*
     * PAST HERE THE VISIT IS IN THE LEDGER, and nothing below may claim
     * otherwise.
     *
     * `saveVisit` commits its own transaction and returns an id; everything
     * that follows is tidying up around a record that already exists. All of it
     * used to sit inside the try above, so a failure binding the leg raised
     * "Nothing has been lost — try again" — a sentence that is false in exactly
     * that case, and an instruction that writes the visit a second time.
     */

    /* Spent, whether or not it was used — a reason typed for one shop must
       not attach itself to the next unrelated visit hours later. */
    set({ visitSpent: spent, offPlanReason: null });
    /* The journey is spent on this visit, locally, so the record reads
       correctly on this handset without waiting for a pull — and so the
       next visit to this shop does not pick the same leg up again.
       Deliberately AFTER the save: a leg bound to a visit that failed to
       write would be a journey pointing at nothing. */
    if (leg) {
      try {
        await bindLegToVisit(leg.id, visitId);
      } catch {
        /* Said rather than swallowed, and NOT as a failure of the visit: the
           journey is still on today's travel, it is simply not attached to the
           visit it was made for. */
        notify('The visit is saved. The journey could not be attached to it — check today’s travel.');
      }
    }

    /* This screen asks before it lets a visit in progress be left. The visit is
       saved, so the question no longer applies. */
    leavingRef.current = true;
    router.replace('/saved');
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
   * Rendered INSTEAD of the form rather than over it: a modal on top of a
   * working screen invites somebody to dismiss it and carry on, and there is
   * nothing underneath to carry on with.
   */
  if (legLoaded && leg && leg.endedAt == null) {
    const prompt = arrivalPrompt({
      requiresOdometer: needsMeter,
      odometerStartKm: leg.odometerStartKm,
    });
    const shopPin = pinLat != null && pinLng != null ? { lat: pinLat, lng: pinLng } : null;
    const away = navigationLine({
      hasPin: !!shopPin,
      metresAway: roadFix && shopPin ? haversineMetres(roadFix, shopPin) : null,
      fixAgeSeconds: roadFix ? Math.round((now - roadFix.at) / 1000) : null,
      staleAfterSeconds: staleAfterS,
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
            <Text style={[type.h2, { flex: 1, minWidth: 0 }]}>{c?.name ?? leg.toLabel ?? ''}</Text>
          </View>
          <Text style={[type.caption, { marginTop: 8 }]}>
            {legLine({
              modeLabel: legMode?.label ?? leg.modeKey,
              odometerStartKm: null,
              odometerEndKm: null,
              ticketAmountPaise: null,
            }) +
              ' · travelling ' +
              travellingFor(leg.startedAt ?? Date.now(), now)}
          </Text>
          {leg.odometerStartKm != null ? (
            <Text style={[type.caption, { marginTop: 2 }]}>
              {'Set off on ' + leg.odometerStartKm.toLocaleString('en-IN') + ' km'}
            </Text>
          ) : null}
          {/*
            NAVIGATION SITS WITH THE JOURNEY, above the line about ending it.
            The card is two halves and they are read at two different moments:
            the top is the ride he is on and is read as he sets off, the bottom
            is how the ride stops and is read when he gets there. Dropping the
            button between the prompt and the button that answers it would split
            the only pair on the card that belongs together.
          */}
          <NavigateButton
            lat={c?.gpsLat}
            lng={c?.gpsLng}
            name={c?.name ?? leg.toLabel}
            city={c?.area ?? c?.city}
            detail={away}
            style={{ marginTop: 12 }}
          />

          <Text style={{ fontSize: 14, lineHeight: 20, color: C.body, marginTop: 14 }}>{prompt.line}</Text>

          {/*
            THE REFUSAL, said with its number.
            It sits above the button rather than in a toast because a toast is
            gone before it has been read, and the one thing he needs from this
            screen is how far off he is — which tells him whether to walk
            twenty steps or whether the book has the shop in the wrong town.
          */}
          {refused ? (
            <View
              style={{
                marginTop: 14,
                borderWidth: 1,
                borderColor: C.warnEdge,
                backgroundColor: C.warnBg,
                borderRadius: radius.lg,
                paddingVertical: 12,
                paddingHorizontal: 14,
              }}>
              <Text style={[{ fontSize: 14, lineHeight: 20, color: C.ink }, weight(500)]}>
                {refused.sentence}
              </Text>
              <Text style={[type.caption, { marginTop: 6 }]}>
                Walk to the shop and press again — nothing has been recorded yet.
              </Text>
            </View>
          ) : null}

          <View style={{ marginTop: 14 }}>
            <PrimaryButton
              label={arriving ? 'One moment…' : refused ? 'Check again' : prompt.button}
              onPress={() => void arriveHere()}
              disabled={arriving}
              whyDisabled="Recording where you are."
            />
          </View>
          {/*
            OFFERED ONLY ONCE HE HAS BEEN REFUSED. Drawn from the start it
            would be a way round the radius that nobody had to be refused by
            first, which is a different feature.
          */}
          {refused ? (
            <View style={{ marginTop: 10 }}>
              <SecondaryButton
                label="I am at the shop — its location here is wrong"
                onPress={overrideRefusal}
              />
            </View>
          ) : null}
          {/*
            CALLING IT OFF IS THE WAY OUT THAT IS NOT AN ARRIVAL, and it is
            not a skip. (It was the only other way out before the radius could
            refuse one; the override above is the second, and it ends with him
            in the shop rather than on his way home.)
            The meter has already moved, so there is no version of this where
            nothing happened — what he chooses is whether the journey is
            recorded against a shop he reached or against a trip he abandoned,
            and the second still needs a sentence or the next departure's
            reading follows on from a gap.
          */}
          <View style={{ marginTop: 10 }}>
            <SecondaryButton
              label="I am not going after all"
              onPress={() =>
                askConfirm({
                  title: 'Call off this trip?',
                  body:
                    'It stays on your record with the reason you give, measuring nothing — the meter has already moved, and a journey that vanished would leave the next one following on from a gap.',
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
          previousKm={leg.odometerStartKm}
          maxLegKilometres={maxLegKm}
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
          {/* `warning` rather than `firstFailure`: a visit whose check-in was
              overridden has nothing outstanding and is still not a clean one,
              and that line used to be blank — the bar said nothing while the
              panel above it said "Everything checks out". */}
          {verdict.warning ? (
            <Text style={{ fontSize: 13, lineHeight: 18, color: C.warnInk, marginBottom: 8 }}>{verdict.warning}</Text>
          ) : null}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={type.label}>In the shop</Text>
              <Text style={[{ fontSize: 15, color: C.ink }, weight(500)]}>{elapsedLabel(dwellSeconds)}</Text>
            </View>
            {/* Live on `complete`, never on `verified`. An override is not a
                missing requirement, and greying the button on one would demand
                a second typed reason for a question already answered at the
                door. */}
            <Pressable
              onPress={() => (verdict.complete ? askTicketThenSave() : notify(verdict.firstFailure))}
              accessibilityLabel={verdict.complete ? 'Save visit' : verdict.firstFailure}
              style={[
                { height: 52, paddingHorizontal: 24, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center', backgroundColor: verdict.complete ? C.primary : C.hairline },
                verdict.complete && { boxShadow: shadow.primary },
              ]}>
              <Text style={[{ fontSize: 16, color: verdict.complete ? '#FFFFFF' : C.faint }, weight(600)]}>
                {saving ? 'Saving…' : 'Save visit'}
              </Text>
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
              onPress={() => notify('Carrying on without a location — save the visit as usual and your manager will see it was unpinned.')}
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

      {/* ---- §B · is this one going anywhere? ----
          Drawn only for a Suspect, and only once the count is worth mentioning.
          It is a QUESTION on the visit form, never a refusal of the visit: a
          salesman whose visit is blocked stops recording visits, and the
          company loses the GPS, the competitor note and the reason in order to
          stop a number reaching four. */}
      {capState !== 'ok' && suspect && capCfg ? (
        <Card
          style={{
            marginTop: 12,
            borderLeftWidth: 3,
            borderLeftColor: capState === 'decide' ? C.warnInk : C.hairline,
          }}>
          <Text style={type.label}>
            {'Visit ' + suspect.visits + ' / ' + capCfg.maxSuspectVisits + ' · still a Suspect'}
          </Text>
          <Text style={{ fontSize: 14, lineHeight: 20, marginTop: 6, color: C.body }}>
            {capState === 'decide'
              ? 'Say which way this one goes before you close the visit. The visit is recorded either way.'
              : 'Next time round you will be asked to decide. Worth thinking about now.'}
          </Text>

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
            {[
              { v: 'qualified', label: 'A prospect' },
              { v: 'contacted', label: 'Keep working it' },
              { v: 'on_hold', label: 'On hold' },
              { v: 'still_suspect', label: 'Still a Suspect' },
              { v: 'lost', label: 'Lost' },
            ].map((o) => (
              <Choice
                key={o.v}
                label={o.label}
                selected={decision === o.v}
                onPress={() => {
                  setDecision(decision === o.v ? null : o.v);
                  setDecisionErr(null);
                }}
                style={{ paddingHorizontal: 14 }}
              />
            ))}
          </View>

          {/* On hold and staying a Suspect both ask why, and for the same
              reason: somebody is going to look at this lead again and the
              sentence is what tells them when, or whether. Lost asks too —
              that one because nobody will. */}
          {decision === 'still_suspect' || decision === 'on_hold' || decision === 'lost' ? (
            <TextInput
              value={decisionWhy}
              onChangeText={(v) => {
                setDecisionWhy(v);
                setDecisionErr(null);
              }}
              placeholder={
                decision === 'lost'
                  ? 'Why we are not going back'
                  : 'What we are waiting for'
              }
              placeholderTextColor={C.faint}
              multiline
              style={{
                marginTop: 12,
                minHeight: 64,
                borderWidth: 1,
                borderColor: C.border,
                borderRadius: radius.sm,
                padding: 12,
                fontSize: 15,
                color: C.ink,
                textAlignVertical: 'top',
              }}
            />
          ) : null}

          {decisionErr ? (
            <Text style={[{ fontSize: 14, lineHeight: 20, marginTop: 10, color: C.danger }, weight(500)]}>
              {decisionErr}
            </Text>
          ) : null}
        </Card>
      ) : null}

      {/* ---- §G · what they actually need ----
          On a lead only. These overwrite the lead's own columns deliberately,
          unlike the validation call's answers: this is the same person asking
          the same question better informed, not a second party's account. */}
      {suspect ? (
        <Card style={{ marginTop: 12 }}>
          <Text style={type.label}>What they need</Text>
          <Text style={{ fontSize: 14, lineHeight: 20, marginTop: 6, color: C.body }}>
            Optional. Fill it in when you have taken the price list and asked properly.
          </Text>

          <TextInput
            value={reqWhat}
            onChangeText={setReqWhat}
            placeholder="What they want — thinner for a spray booth"
            placeholderTextColor={C.faint}
            style={{
              marginTop: 12, minHeight: 48, borderWidth: 1, borderColor: C.border,
              borderRadius: radius.sm, paddingHorizontal: 12, fontSize: 15, color: C.ink,
            }}
          />
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
            <View style={{ flex: 1 }}>
              <TextInput
                value={reqLitres}
                onChangeText={setReqLitres}
                placeholder="Litres a month"
                placeholderTextColor={C.faint}
                keyboardType="number-pad"
                style={{
                  minHeight: 48, borderWidth: 1, borderColor: C.border, borderRadius: radius.sm,
                  paddingHorizontal: 12, fontSize: 15, color: C.ink,
                }}
              />
            </View>
            <View style={{ flex: 1 }}>
              {/* Cans, because that is what an ORDER is counted in — the litres
                  beside it are what the shop says its consumption is. Two
                  different questions, and the units say which is which. */}
              <TextInput
                value={reqCans}
                onChangeText={setReqCans}
                placeholder="Cans to start"
                placeholderTextColor={C.faint}
                keyboardType="number-pad"
                style={{
                  minHeight: 48, borderWidth: 1, borderColor: C.border, borderRadius: radius.sm,
                  paddingHorizontal: 12, fontSize: 15, color: C.ink,
                }}
              />
            </View>
          </View>

          {/* §G's business rule, said on the screen where it applies rather
              than only refused at the server. */}
          <Text style={{ fontSize: 13, lineHeight: 19, marginTop: 10, color: C.muted }}>
            No price or delivery promises at this stage. Anything commercial goes to the Lead Manager.
          </Text>
        </Card>
      ) : null}

      {/* ---- what was said ---- */}
      <Card style={{ marginTop: 12 }}>
        <Text style={type.label}>What was said</Text>

        {/*
          ONE MICROPHONE, and what it does depends on the signal.

          It used to be two things on this card: a "Hold to talk" recorder that
          queued the audio for the office to write out later, and a note box
          underneath it. The recorder had never been reachable — nothing on any
          path asked for the RECORD_AUDIO permission, so preparing threw and the
          screen reported a broken microphone — and the card carried a state
          called `done` that nothing ever set, so its "AI transcribed · edit
          before saving" badge could not appear and the salesman had no way to
          see the transcript at all. What he did see, after a recording that had
          uploaded perfectly, was "No signal to transcribe".

          Both halves answer the same question, so they are one control now.
          On signal it dictates: he speaks, reads the English, corrects it and
          it lands in this box before he saves. Off signal it does what the old
          recorder claimed to — the audio is queued and the office writes it out
          — which is the honest fallback rather than an apology, and it is the
          reason `keepAudio` exists at all.

          The audio is kept in BOTH cases, unlike everywhere else this box
          appears. A visit note is the one field where the recording is a record
          of what a customer said rather than a keyboard, and the office keeps
          it either way.
        */}
        <View style={{ marginTop: 12 }}>
          <VoiceField
            value={note}
            onChangeText={(v) => set({ note: v })}
            keepAudio="keep"
            onRecording={(uri, _seconds, mode) => void keepVoiceNote(uri, mode)}
          />
          {voiceNoteId ? (
            <Text style={[type.caption, { marginTop: 6 }]}>
              The recording goes to the office with this visit.
            </Text>
          ) : null}
        </View>
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
                   only on the clean one is a fare quietly lost on exactly the
                   visits that already went wrong. */
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

      {/*
        ---- the shop's own pin, questioned by somebody standing at it ----

        A REQUEST AND NEVER A WRITE. The handset can already move a pin through
        `customer_update`, so letting the override move it directly would mean
        one override put the pin wherever he happened to be and the radius
        never refused him there again. A manager decides, on the visit's own
        row, from the check-in fix already stored on it — which is why nothing
        here sends a coordinate: what he is proposing IS the check-in, and a
        second copy of two numbers already in the record is a copy that can
        disagree with it.

        Backing out is No. It is a question about the book, asked of somebody
        who has a shopkeeper waiting, and a sheet that would not close until it
        was answered would be answered at random.
      */}
      <BottomSheet open={pinAsk} onClose={() => setPinAsk(false)}>
        <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 20 }}>
          <Text style={[{ fontSize: 17, lineHeight: 22, color: C.ink }, weight(600)]}>
            Is this shop in the wrong place?
          </Text>
          <Text style={{ fontSize: 14, lineHeight: 20, color: C.body, marginTop: 6 }}>
            MahekOne has {c?.name ?? 'this shop'} about {metresAway ?? '?'} m from where you
            checked in. If the shop is here and the map is wrong, ask your manager to move
            it — the next visit will not be questioned, and nor will anybody else&rsquo;s.
          </Text>

          <View style={{ marginTop: 16, gap: 8 }}>
            <PrimaryButton
              label="Yes — ask my manager to move it here"
              onPress={() => {
                setPinRequested(true);
                setPinAsk(false);
                notify('Your manager will be asked to move it. It goes with this visit.');
              }}
            />
            <SecondaryButton
              label="No — leave it as it is"
              onPress={() => {
                setPinRequested(false);
                setPinAsk(false);
              }}
            />
          </View>
        </View>
      </BottomSheet>

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
        <VoiceField
          value={draft.what ?? ''}
          onChangeText={(v) => { setDraft({ ...draft, what: v }); setFormErr(null); }}
          invalid={formErr === 'what'}
          placeholder="Two drums arrived dented and he refused them"
          style={{ minHeight: 90 }}
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
        <VoiceField
          value={draft.why ?? ''}
          onChangeText={(v) => { setDraft({ ...draft, why: v }); setFormErr(null); }}
          invalid={formErr === 'why'}
          placeholder="Comparing against what he buys from Asian"
          style={{ minHeight: 80 }}
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
          /* Not while the fare is being written. The scrim and Skip stayed live
             through `attachTicketToLeg`, so a tap here started the save and
             `claimTicket`'s own `finally` started a second one. */
          if (ticketBusy) return;
          setTicketOpen(false);
          void saveAndGo(elapsedLabel(dwellSeconds), pendingUnverified);
        }}>
        <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 20 }}>
          <Text style={[{ fontSize: 17, lineHeight: 22, color: C.ink }, weight(600)]}>
            {'Your ' + (legMode?.label ?? 'travel').toLowerCase() + ' ticket'}
          </Text>
          <Text style={{ fontSize: 14, lineHeight: 20, color: C.body, marginTop: 6 }}>
            Add what it cost and it goes onto today&rsquo;s travel straight away. If you
            have not got it on you, skip — you can still add it on the Travel screen.
          </Text>

          <View style={{ marginTop: 14 }}>
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

          {/* The PNR or ticket number, which is what a duplicate is caught on
              — two people claiming one journey, or the same journey claimed
              twice. Optional, because a local bus ticket has no number and
              refusing the fare over one would lose the claim entirely. */}
          <View style={{ marginTop: 12 }}>
            <Text style={type.label}>Ticket or PNR number · optional</Text>
            <View
              style={{
                marginTop: 6,
                borderWidth: 1,
                borderColor: C.border,
                borderRadius: radius.md,
                paddingHorizontal: 14,
              }}>
              <TextInput
                value={ticketRef}
                onChangeText={setTicketRef}
                autoCapitalize="characters"
                placeholder="If it has one"
                placeholderTextColor={C.faint}
                accessibilityLabel="Ticket or PNR number"
                style={{ height: 52, fontSize: 16, color: C.ink }}
              />
            </View>
          </View>

          <Pressable
            onPress={() => void shootTicket()}
            style={{
              height: 72,
              marginTop: 12,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: ticketShot ? C.primary : C.border,
              backgroundColor: ticketShot ? C.primaryTint : C.surface,
              alignItems: 'center',
              justifyContent: 'center',
            }}>
            <Icon name="camera" size={22} color={ticketShot ? C.primaryDeep : C.body} strokeWidth={1.5} />
            <Text style={[{ fontSize: 14, marginTop: 4, color: ticketShot ? C.primaryDeep : C.body }, weight(500)]}>
              {ticketShot ? 'Ticket photographed ✓ — tap to retake' : 'Photograph the ticket · optional'}
            </Text>
          </Pressable>

          <View style={{ marginTop: 16, gap: 10 }}>
            <PrimaryButton
              label={ticketBusy ? 'Adding…' : 'Add it and save the visit'}
              onPress={() => void claimTicket()}
              disabled={ticketBusy}
              whyDisabled="Adding the ticket."
            />
            <SecondaryButton
              label="Skip — I will add it later"
              onPress={() => {
                if (ticketBusy) return;
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
