import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { color as C, HIT, radius, shadow, type, weight, tabular } from '../src/theme/tokens';
import { Icon } from '../src/components/ui/Icon';
import { Card, PrimaryButton, SecondaryButton, T } from '../src/components/ui/primitives';
import { promptsForExpenses } from '../src/lib/travel-leg';
import { AppFrame } from '../src/components/shell/AppFrame';
import { useStore } from '../src/state/store';
import { useBoot } from '../src/state/boot';
import { compactInrFromPaise, inrFromPaise, isoDate, plural } from '../src/lib/format';
import { DASH_CARDS, DAY_AHEAD } from '../src/data/fixtures';
import {
  checkIn,
  checkOut,
  dayState,
  durationLabel,
  setOverrideReason,
  todayRow,
  workedLabel,
  workedMs,
  type Session,
} from '../src/data/attendance';
import { useTicker } from '../src/components/ui/use-ticker';
import { collectionDue } from '../src/data/customers';
import { listPerformance, shortfalls, type PerformanceMonth } from '../src/data/performance';
import { getConfig } from '../src/data/config';
import { mayOpenDay } from '../src/data/day-gate';
import { ordersToday } from '../src/data/orders';
import { cashInHand } from '../src/data/payments';
import { bucketOf, listOpenTasks } from '../src/data/tasks';
import { listLeads, type Lead } from '../src/data/leads';
import { LeadActionCard } from '../src/components/leads/lead-action-card';
import {
  countLeads,
  rowsFor,
  type LeadActionCounts,
} from '../src/engines/lead-worklist';
import { followUpCounts, visitsToday } from '../src/data/visits';
import { stopCounts } from '../src/data/journey';
import { lastPullAt } from '../src/sync/api';
import { stalledAt } from '../src/sync/trail';
import { lastAskedAt } from '../src/native/keepalive';
import { shouldOfferSetup } from '../src/engines/oem-keepalive';
import { withinGeofence } from '../src/engines/geo';
import { fixOf, getFix } from '../src/native/location';
import { ensureLocationPermission } from '../src/native/permissions';
import { walkthroughDue } from '../src/data/setup-walkthrough';
import { queueOdometerPhoto, queueSelfie } from '../src/native/capture';
import { SelfieCamera, type SelfieResult } from '../src/components/ui/selfie-camera';
import { OdometerCamera, type OdometerResult } from '../src/components/ui/odometer-camera';
import { BottomSheet } from '../src/components/ui/overlays';
import { TravelModeList } from '../src/components/ui/travel-mode-list';
import {
  endSession,
  openSessionLeg,
  startSession,
  travelModesFor,
  type TravelMode,
} from '../src/data/travel';

/**
 * Home is the first thing on screen at 9am and the thing returned to between
 * shops. It answers, in order: has the day started, what is worth doing next,
 * and how the month is going.
 *
 * Every figure on it is a query against the local store. Nothing here waits on
 * the network, so it renders the same in a basement as it does on Wi-Fi.
 */

type Day = {
  stops: number;
  stopsDone: number;
  collectPaise: number;
  collectCustomers: number;
  followUps: number;
  followUpsToday: number;
  orders: number;
  orderValuePaise: number;
  orderValueUnknown: boolean;
  visits: number;
  cashPaise: number;
  cashSentence: string;
  tasks: number;
  tasksOverdue: number;
  checkedInAt: number | null;
  /** The day is running — a session is open. */
  running: boolean;
  workedMinutes: number;
  sessionCount: number;
  /** Held so the duration can keep counting without another read. */
  sessions: Session[];
};

const EMPTY: Day = {
  stops: 0,
  stopsDone: 0,
  collectPaise: 0,
  collectCustomers: 0,
  followUps: 0,
  followUpsToday: 0,
  orders: 0,
  orderValuePaise: 0,
  orderValueUnknown: false,
  visits: 0,
  cashPaise: 0,
  cashSentence: '',
  tasks: 0,
  tasksOverdue: 0,
  checkedInAt: null,
  running: false,
  workedMinutes: 0,
  sessionCount: 0,
  sessions: [],
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function greetingFor(hour: number): string {
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

/** `September 2026` from the row's own `2026-09`, off the list already here. */
function monthLabel(period: string): string {
  const [y, m] = period.split('-').map(Number);
  const name = MONTHS[m - 1];
  return y && name ? name + ' ' + y : period;
}

/**
 * When the office last worked the score out.
 *
 * Asia/Kolkata by name, like everything else that turns a stored instant into
 * a wall clock here: the phone's own zone is whatever the handset is set to,
 * and a figure a salesman is appraised on must not read differently because he
 * crossed a border. The same shape `/performance` prints.
 */
function asAt(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'unknown';
  return new Intl.DateTimeFormat('en-GB', {
    hour: 'numeric',
    minute: '2-digit',
    day: 'numeric',
    month: 'short',
    timeZone: 'Asia/Kolkata',
  }).format(at);
}

export default function Home() {
  const boot = useBoot();
  const userId = boot.session?.user.id ?? null;
  const set = useStore((s) => s.set);
  const notify = useStore((s) => s.notify);
  const askConfirm = useStore((s) => s.askConfirm);

  /*
   * `undefined` IS STILL READING, and every figure on this screen now says so.
   *
   * The reasoning three lines below was written for `month` and applied to that
   * card alone. `day` started at `EMPTY` — every figure a literal zero — and
   * was rendered immediately while ten SQLite reads were still in flight, so
   * the first screen after sign-in read "₹0 · 0 orders", "0 of 0 · No plan
   * today", "₹0 · Nothing to deposit". On a handset whose pull has never landed
   * those zeros were not a frame, they were permanent, and the status strip
   * said "All sent" over them because that pip counts the outbox and not the
   * inbox. He opens the app at 9am and reads a screen saying he has no work,
   * which is the one failure nobody reports: it looks like having nothing to
   * do.
   *
   * `EMPTY` survives as the stand-in for the mechanical reads below — the
   * ticker interval and the worked-time sum need a shape, not a sentence — and
   * nothing DISPLAYED comes from it.
   */
  const [day, setDay] = React.useState<Day | undefined>(undefined);
  /* `undefined` is still reading, `null` is read and there is nothing. Two
     different sentences, and collapsing them shows "no target" for a frame to
     somebody who has one. */
  const [month, setMonth] = React.useState<PerformanceMonth | null | undefined>(undefined);
  /*
   * Nothing has ever come down from the office onto this handset.
   *
   * Answered by the pull's own marker rather than guessed at from the figures:
   * a salesman with no plan and no orders at 9am has honest zeros, and a
   * handset that has never synced has no book at all. Drawing those two the
   * same way is what made a broken install indistinguishable from a quiet
   * morning.
   */
  const [neverPulled, setNeverPulled] = React.useState(false);
  /*
   * §12.1 — the leads half of the morning.
   *
   * `undefined` is still reading, exactly as `day` above is and for exactly
   * the same reason: three noughts under "My leads · Overdue · Due today" on a
   * handset whose pull has never landed is a screen telling a salesman he has
   * no prospects, which is the one failure nobody reports because it looks
   * like having nothing to do.
   *
   * The counts and the rows are held TOGETHER and are derived from one read of
   * the book, so the stat saying four and the list under it drawing three is
   * not a state this screen can reach.
   */
  const [leads, setLeads] = React.useState<
    { counts: LeadActionCounts; dueToday: Lead[] } | undefined
  >(undefined);
  /*
   * A READ THAT FAILED IS NOT A READ STILL RUNNING. `load` had no `catch` at
   * all, so one rejected promise among the eleven left this screen reading
   * "Reading…" for the rest of the session — which is a spinner that never
   * resolves, and reads as a dead handset with nothing saying what to do.
   */
  const [readErr, setReadErr] = React.useState<string | null>(null);
  const [starting, setStarting] = React.useState(false);
  /* The day's mode, held while the after-punch-out prompt is up. Null is no
     prompt. See `promptsForExpenses`. */
  const [claimPrompt, setClaimPrompt] = React.useState<{ modeLabel: string | null } | null>(null);

  /*
   * The clock, as state and ticked — never read during render.
   *
   * Once a second while a session is open, and no timer at all once the day is
   * closed. It replaces a flat thirty-second interval, but that interval was
   * not why this screen's duration stood still: `workedMinutes` was a figure
   * taken by `load()` when the screen came into focus, and then rendered
   * unchanged for as long as somebody looked at it. The tick moved `now` and
   * nothing on the card read it. A day being recorded and a day whose
   * recording has stopped looked identical, which is the one thing an
   * attendance screen must never do.
   *
   * The duration is derived from the sessions and this clock now, so it moves
   * because the day is running rather than because something re-fetched.
   */
  /* The shape the clock and the worked-time sum need, before the read lands.
     Nothing on the screen is drawn from it — see the note on `day` above. */
  const dayOrEmpty = day ?? EMPTY;
  const now = useTicker(dayOrEmpty.running ? 1000 : 60_000);
  const workedSoFarMs = workedMs(dayOrEmpty.sessions, now);

  /*
   * Location is asked for HERE, on the first open, and not at the check-in.
   *
   * The check-in is the worst moment to ask: he is outside a shop with the day
   * waiting on him, and a system dialog lands on the button he just pressed.
   * Tap the wrong one under that pressure and Android never asks again — the
   * check-in records `denied` and nothing on the phone says why the office
   * cannot see him. Asked once here, when nothing is riding on the answer.
   * `ensureLocationPermission` is a no-op after the first time either way.
   */
  /*
   * UNLESS THE SETUP WALKTHROUGH IS DUE, which asks for it itself along with
   * everything else the phone needs. A fresh install, and an update that left
   * something missing, goes there first — once per build, see
   * `shouldOpenWalkthrough` — and firing the location dialog here as well
   * would put a popup over the screen that is about to ask for it properly.
   */
  React.useEffect(() => {
    void walkthroughDue().then((due) => {
      if (due) router.push('/setup');
      else void ensureLocationPermission();
    });
  }, []);


  /*
   * WHETHER TO PUT THE TRACKING SETUP IN FRONT OF HIM, which nothing ever did.
   *
   * `shouldOfferSetup` was written with the engine, tested, and never called by
   * anything — so the only door to the screen that walks somebody through the
   * two OEM switches was a card on the Sync screen, which people open when they
   * think their WORK is stuck rather than when their location has gone quiet.
   * The switches decide whether a route is recorded at all, they cannot be read
   * by any Android API, and the man they are about never saw the screen.
   *
   * Home is where it belongs because home is the screen he opens in the
   * morning, before the day that will or will not be recorded.
   */
  const [offerSetup, setOfferSetup] = React.useState(false);

  const load = React.useCallback(() => {
    if (!userId) return;
    const iso = isoDate(new Date());

    /*
     * Its own read, deliberately not in the `Promise.all` below: that one
     * settles the whole day card together and a failure of it blanks the
     * screen with a sentence. Whether to offer a settings screen is not worth
     * that, so it fails to `false` — no row — and the Sync card is still there.
     */
    void (async () => {
      const [stalled, asked, days] = await Promise.all([
        stalledAt(),
        lastAskedAt(),
        getConfig<number>('mbos.location.trackingSetupRemindDays', 14),
      ]);
      setOfferSetup(
        shouldOfferSetup({
          askedAt: asked,
          trailStalled: stalled !== null,
          now: Date.now(),
          remindAfterMs: Math.max(1, days) * 24 * 60 * 60 * 1000,
        }),
      );
    })().catch(() => setOfferSetup(false));
    void Promise.all([
      stopCounts(),
      collectionDue(),
      followUpCounts(userId, iso),
      ordersToday(userId),
      visitsToday(userId),
      cashInHand(userId),
      listOpenTasks(),
      todayRow(userId),
      dayState(userId),
      /* Two months come down; the first is the current one. Read here rather
         than on a focus of its own so the card and the six figures above it
         describe the same moment. */
      listPerformance(),
      /* Whether anything has EVER arrived on this phone. Read beside the
         figures rather than on its own, so the sentence under them and the
         figures themselves describe the same moment. */
      lastPullAt(),
      /* The whole lead book, once. Every figure and every card in the leads
         section below is a filter over these rows — see `lead-worklist.ts` —
         so four counts and a list cost one query and can never disagree. */
      listLeads({}),
    ]).then(([stops, due, follow, orders, visits, cash, tasks, attendance, state, months, pulledAt, leadRows]) => {
      setReadErr(null);
      setNeverPulled(pulledAt === 0);
      setMonth(months[0] ?? null);
      setLeads({
        counts: countLeads(leadRows, iso),
        /* Six, because §12.1 says six: a list somebody scrolls on the first
           screen of the morning is a list that has stopped being a summary.
           The count above it says what it is a slice of, and the whole of it
           is one tap away. */
        dueToday: rowsFor(leadRows, 'today', iso).slice(0, 6),
      });
      setDay({
        stops: stops.total,
        stopsDone: stops.done,
        collectPaise: due.totalPaise,
        collectCustomers: due.customers,
        followUps: follow.open,
        followUpsToday: follow.dueToday,
        orders: orders.count,
        orderValuePaise: orders.valuePaise,
        orderValueUnknown: orders.valueUnavailable,
        visits,
        cashPaise: cash.totalPaise,
        cashSentence: cash.sentence,
        tasks: tasks.length,
        tasksOverdue: tasks.filter((t) => bucketOf(t.dueDate, iso) === 'Overdue').length,
        checkedInAt: attendance?.checkInAt ?? null,
        running: state.running,
        workedMinutes: state.workedMinutes,
        sessionCount: state.sessionCount,
        sessions: state.sessions,
      });
    }).catch(() => {
      /* Left `undefined` on purpose: the screen below draws the sentence rather
         than a grid of zeros or a spinner that will never stop. `month` is
         settled too, or its card would read "Reading…" for ever beside it. */
      setMonth(null);
      /* Settled to nothing rather than left holding the last good read: a
         stale list of leads under a sentence saying the read failed is the
         screen arguing with itself. */
      setLeads(undefined);
      setReadErr('Your day could not be read on this phone. Close MBOS and open it again.');
    });
  }, [userId]);

  useFocusEffect(load);

  const checkedIn = !!day && day.sessionCount > 0;

  const today = new Date(now);
  const dateLine = `${WEEKDAYS[today.getDay()]}, ${today.getDate()} ${MONTHS[today.getMonth()]}`;

  /* See the chip below for why the designation wins over the role. */
  const roleChip = boot.session?.user.designation?.trim() || boot.session?.user.role?.trim() || null;

  /*
   * The six figures — or, until there are six figures, six dashes.
   *
   * Three states and they are three different sentences. Still reading is a
   * moment; a read that failed is a handset to restart; and a handset nothing
   * has ever reached is one to find signal for. A zero is none of those, and a
   * zero is what all three used to print.
   */
  const figuresPending = !day || neverPulled;
  /* The same rule one section down: a handset nothing has reached has no lead
     book either, so its three figures are empty rather than nought. */
  const leadsPending = !leads || neverPulled;
  const dashValues: { v: string; s: string; small?: boolean }[] = !day
    ? DASH_CARDS.map(() => ({ v: '—', s: readErr ? 'Not read' : 'Reading…' }))
    : neverPulled
      ? DASH_CARDS.map(() => ({ v: '—', s: 'Nothing here yet' }))
      : [
    {
      /* "Not known yet" is a SENTENCE in a slot sized for ₹1,24,500 — one line,
         tabular, in half of a 328-point card — so at Android's larger font
         settings it truncated to "Not known y…". It is the honest answer this
         tile exists to give, so it is drawn smaller rather than cut off. */
      v: day.orderValueUnknown ? 'Not known yet' : inrFromPaise(day.orderValuePaise),
      s: plural(day.orders, 'order'),
      small: day.orderValueUnknown,
    },
    {
      /* THE NUMERATOR IS STOPS DONE, not visits. `visitsToday` counts every
         visit logged today, off-plan walk-ins included, and it was printed
         against a denominator of today's PLANNED stops — so after two calls
         nobody planned the tile legitimately read "5 of 3", while the day card
         four lines above said "3 of 3 done" about the same morning. One
         question, two numerators, both on one screen. The visits are still
         here; they are the subtitle now. With no plan at all there is no
         denominator to print, so the count stands on its own. */
      v: day.stops ? `${day.stopsDone} of ${day.stops}` : String(day.visits),
      s: day.stops ? plural(day.visits, 'visit') + ' logged' : 'No plan today',
    },
    { v: inrFromPaise(day.collectPaise), s: plural(day.collectCustomers, 'customer') },
    { v: inrFromPaise(day.cashPaise), s: day.cashSentence || 'Nothing to deposit' },
    { v: String(day.tasks), s: day.tasksOverdue ? plural(day.tasksOverdue, 'overdue') : 'None overdue' },
    { v: String(day.followUps), s: `${day.followUpsToday} today` },
  ];

  /* Same rule, on the strip under the Start day button: a dash where there is
     no answer yet, never a nought. */
  const dayAheadValues =
    !day || neverPulled
      ? DAY_AHEAD.map(() => '—')
      : [String(day.stops), compactInrFromPaise(day.collectPaise), String(day.followUpsToday)];

  /*
   * The selfie camera is a COMPONENT, and `startDay` needs a value from it, so
   * the two are joined by a promise the modal resolves. It is the same shape
   * as `askConfirm` — the flow raises an overlay and waits for the person —
   * and it is why the camera is rendered at the bottom of this screen rather
   * than pushed as a route: a route would take `startDay` off the stack
   * half-way through, and the check-in it is in the middle of with it.
   */
  const [selfieOpen, setSelfieOpen] = React.useState(false);
  const [selfieWords, setSelfieWords] = React.useState({
    title: 'Punch in',
    subtitle: 'A photo of you goes with the punch-in.',
    cancelLabel: 'Cancel the punch-in',
  });
  const answerSelfie = React.useRef<((r: SelfieResult) => void) | null>(null);

  const askSelfie = (words: typeof selfieWords) =>
    new Promise<SelfieResult>((resolve) => {
      setSelfieWords(words);
      answerSelfie.current = resolve;
      setSelfieOpen(true);
    });

  /*
   * ───────────────────────────── how he is travelling today
   *
   * THE VEHICLE IS A FACT ABOUT THE SESSION, asked once at the punch-in.
   *
   * It used to be asked at every stop and got the same answer all day: a man
   * on his own bike said "own bike" eleven times and photographed the meter
   * twenty-two times for one ride he never got off. He punches in on a vehicle
   * and punches out on it, so this is where it belongs — and only public
   * transport leaves a question open for the journey, because the bus, the
   * auto and the taxi genuinely change from one shop to the next.
   *
   * Both overlays are promise-answered like the selfie beside them, and for
   * the same reason: this is one flow with three captures in it, and pushing a
   * route for any of them would take the flow off the stack half-way through.
   */
  const [modeOpen, setModeOpen] = React.useState(false);
  const [dayModes, setDayModes] = React.useState<TravelMode[]>([]);
  const answerMode = React.useRef<((m: TravelMode | null) => void) | null>(null);

  const [metering, setMetering] = React.useState(false);
  const [meterWords, setMeterWords] = React.useState({ title: '', subtitle: '', cancelLabel: '' });
  const [meterFrom, setMeterFrom] = React.useState<number | null>(null);
  const [maxLegKm, setMaxLegKm] = React.useState(400);
  const answerMeter = React.useRef<((r: OdometerResult) => void) | null>(null);

  /**
   * Three answers, and two of them look alike from a distance.
   *
   * `{ ok: false }` is him dismissing the sheet — nothing is written and the
   * punch-in is abandoned. `{ ok: true, mode: null }` is there being nothing
   * to ask, which is a handset whose office has not published the day-scoped
   * rows yet: the punch-in goes through and the journey asks per stop, exactly
   * as every build before this one did. Collapsing the two onto a bare null
   * would either refuse a punch-in nobody meant to refuse, or open a day on a
   * vehicle nobody named.
   */
  const askMode = async (): Promise<{ ok: true; mode: TravelMode | null } | { ok: false }> => {
    const [rows, km] = await Promise.all([
      travelModesFor('day'),
      getConfig<number>('mbos.travel.maxLegKilometres', 400),
    ]);
    setMaxLegKm(km);
    setDayModes(rows);
    /*
     * NOTHING TO ASK IS NOT A QUESTION. A handset that has not pulled since
     * this shipped has no day-scoped rows, and a sheet with nothing under the
     * heading is a dead end at the one moment a salesman cannot afford one —
     * he is at the gate at half past eight. The punch-in goes through and the
     * journey asks per stop exactly as it did before, which is the behaviour
     * every build before this one had.
     */
    if (!rows.length) return { ok: true, mode: null };
    const picked = await new Promise<TravelMode | null>((resolve) => {
      answerMode.current = resolve;
      setModeOpen(true);
    });
    return picked ? { ok: true, mode: picked } : { ok: false };
  };

  const askMeter = (words: typeof meterWords, previousKm: number | null) =>
    new Promise<OdometerResult>((resolve) => {
      setMeterWords(words);
      setMeterFrom(previousKm);
      answerMeter.current = resolve;
      setMetering(true);
    });

  /**
   * The reading and its photograph, or null if this mode has no meter.
   *
   * `false` is the third answer and it is not the same as null: it means he
   * backed out of the camera, and the caller has to abandon rather than carry
   * on with no reading. A cancelled camera that read as "no meter on this
   * mode" would open a per-km session with nothing to price it on.
   */
  const meterFor = async (
    mode: TravelMode,
    words: typeof meterWords,
    previousKm: number | null,
  ): Promise<{ km: number; photoId: string } | null | false> => {
    if (!mode.requiresOdometer) return null;
    const shot = await askMeter(words, previousKm);
    if (!shot) return false;
    try {
      return { km: shot.km, photoId: await queueOdometerPhoto(shot.uri, 'pending') };
    } catch {
      notify('The photo could not be saved on this phone, so nothing was recorded. Try again.');
      return false;
    }
  };

  /**
   * The session as a journey, opened at the punch-in.
   *
   * It never fails the punch-in. The attendance mark is what somebody is paid
   * on and it is already written by the time this runs; losing it because a
   * travel leg would not write would be exactly the wrong way round. A session
   * that did not open costs the day's mileage, which the `/travel` screen can
   * still be typed up on — a mark that did not open costs the day.
   */
  const openSessionFor = async (
    mode: TravelMode,
    fix: { lat: number; lng: number } | null,
    meter: { km: number; photoId: string } | null,
  ): Promise<void> => {
    /* The callers all guard on it, so this is a type narrowing rather than a
       check — but it is a real one: `startSession` writes a row keyed on the
       person, and there is no such thing as a session belonging to nobody. */
    if (!userId) return;
    try {
      await startSession({
        userId,
        day: isoDate(new Date()),
        modeKey: mode.key,
        fix: fix ? { lat: fix.lat, lng: fix.lng } : null,
        odometer: meter,
      });
    } catch {
      notify('Punched in. The travel for this session could not be started — add it on Travel.');
    }
  };

  /**
   * The photograph, queued, or null if there is no photograph.
   *
   * Both failures come back the same way and MUST: a cancelled camera and a
   * compression that would not write are different causes with one
   * consequence, which is that there is no evidence — and the mark is not
   * written without evidence. What differs is what the person is told, which
   * is why the caller gets the reason rather than a bare null.
   */
  const captureSelfie = async (
    words: typeof selfieWords,
  ): Promise<{ ok: true; id: string } | { ok: false; why: string | null }> => {
    const picked = await askSelfie(words);
    /* Cancelled. No message: they just pressed the thing that says what it
       abandons, and a toast repeating it back is noise. */
    if (!picked) return { ok: false, why: null };
    try {
      return { ok: true, id: await queueSelfie(picked.uri, 'pending') };
    } catch {
      return {
        ok: false,
        why: 'The photo could not be saved on this phone, so nothing was recorded. Try again.',
      };
    }
  };

  /**
   * Starting the day: GPS, then attendance with a selfie, then the timer.
   *
   * Check-in is never blocked BY A LOCATION, which is not the same sentence it
   * used to be: a phone that cannot run the tracking service is stopped at the
   * gate below, because the cost there is the whole day's record rather than
   * one coordinate. Outside the radius the day starts all the same
   * and the override reason is asked for afterwards — asking first and losing
   * the check-in to a dismissed dialog is exactly the failure this module
   * exists to avoid. A refused camera or a missing fix is recorded as what it
   * is and the day still starts.
   */
  const startDay = async () => {
    if (!userId || starting) return;
    setStarting(true);
    try {
      const threshold = await getConfig<number>('mbos.location.gpsAccuracyThresholdM', 100);
      const radius = await getConfig<number>('mbos.attendance.geofenceRadiusM', 200);
      const base = await getConfig<{ lat: number; lng: number } | null>('mbos.attendance.baseLocation', null);

      /* THE GATE COMES BEFORE THE CAMERA, and before anything is written.
         A phone that cannot run the tracking service loses the whole record of
         where the day was spent, and a man finds that out in the evening — so
         the day does not open at all until it can. Asked first because nothing
         else has happened yet: no photograph taken for a day that will not
         start, no half-written row, nothing to undo. `mayOpenDay` is the only
         thing that can produce what `checkIn` requires, so this is not a check
         this screen could forget to make — leaving it out does not compile. */
      const gate = await mayOpenDay(userId);
      if (!gate.ok) {
        router.push('/phone-setup');
        return;
      }

      /* Started, not awaited: it settles while the photograph is being taken.
         `void` on the promise would drop the value, so it is held. */
      const fixing = getFix({ accuracyThresholdM: threshold });

      /* THE SELFIE COMES FIRST AND THE DAY DOES NOT START WITHOUT IT. Every
         other thing this function can fail to get — a fix, a base location, an
         accurate enough fix — is recorded as missing and the day starts
         anyway, because a salesman who cannot mark attendance cannot work. The
         photograph is the exception: it is not an attachment to the mark, it
         is the evidence the mark is made of. See `src/data/attendance.ts`.

         Nothing is written before the camera closes, so cancelling leaves no
         half-started day behind — which is why the order is photograph, then
         write, and not the other way round. */
      const selfie = await captureSelfie({
        title: 'Punch in',
        subtitle: 'A photo of you goes with the punch-in.',
        cancelLabel: 'Cancel the punch-in',
      });
      if (!selfie.ok) {
        /* Nothing has been written, so there is nothing to undo. The fix is
           abandoned with it — a location for a check-in that did not happen is
           a record of somewhere somebody stood while nothing happened. */
        if (selfie.why) notify(selfie.why);
        return;
      }

      /*
       * AND THEN: WHAT IS HE ON TODAY.
       *
       * Asked after the photograph and before anything is written, so backing
       * out of either leaves no half-started day behind — the same order the
       * selfie itself follows. A metered vehicle opens the camera here and
       * nowhere else all day: this reading and the one at the punch-out are
       * the whole of the day's mileage.
       */
      const answer = await askMode();
      if (!answer.ok) return;
      const mode = answer.mode;
      const meter = mode ? await meterFor(mode, {
        title: 'Photograph the meter',
        subtitle: 'Before you set off — this is where the day is measured from.',
        cancelLabel: 'Cancel the punch-in',
      }, null) : null;
      if (meter === false) return;

      const fix = fixOf(await fixing);

      const row = await checkIn({
        userId,
        fix,
        selfieMediaId: selfie.id,
        mayOpen: gate.gate,
        homeLocation: base,
      });

      /* AFTER the punch-in, never before: the session is a journey belonging
         to a day that is now open, and a leg written first would have to guess
         at a day id or open a second one. It cannot fail the punch-in — the
         mark is the thing a salesman is paid on, and losing it over a travel
         leg would be the wrong way round. */
      if (mode) await openSessionFor(mode, fix, meter);

      set({ gps: fix ? 'locked' : 'off' });
      load();

      const geo = base && fix ? withinGeofence(fix, base, radius) : null;
      if (geo && !geo.inside) {
        askConfirm({
          title: 'You are not at base',
          body: 'The day has started. Your manager sees the reason you give.',
          reasonLabel: 'Why · required',
          confirmLabel: 'Send the reason',
          run: (reason) => {
            void setOverrideReason(row.id, reason);
            notify('Sent to your manager');
          },
        });
      } else {
        notify('Day started' + (fix ? ' · GPS locked' : ' · saved without a location'));
      }
    } finally {
      setStarting(false);
    }
  };

  /**
   * Closing the day — the counterpart to starting it, and the reason the hours
   * are worth anything. Without it every day is auto-shut overnight and
   * flagged for a correction somebody has to type, for every salesman, every
   * night.
   *
   * A location is taken but never required, the same rule as check-in.
   */
  const endDay = async () => {
    if (!userId || starting) return;
    setStarting(true);
    try {
      const threshold = await getConfig<number>('mbos.location.gpsAccuracyThresholdM', 100);
      const fixing = getFix({ accuracyThresholdM: threshold });

      /* A photograph at THIS end too, and there was none before — so a day
         proved that somebody arrived and proved nothing whatever about when
         they stopped, which is the half that decides the hours. */
      const selfie = await captureSelfie({
        title: 'Punch out',
        subtitle: 'A photo of you goes with the punch-out.',
        cancelLabel: 'Stay on the clock',
      });
      if (!selfie.ok) {
        if (selfie.why) notify(selfie.why);
        return;
      }

      /*
       * THE CLOSING METER, and the other half of the pair taken at the
       * punch-in. Read BEFORE the punch-out is written, like the photograph
       * above it: backing out of the camera has to leave him on the clock
       * rather than punched out with a session nothing can close.
       *
       * Only where the session actually carries an opening reading. A day
       * spent on buses has no meter to read and never had one, and opening a
       * camera on it would be the app asking about a vehicle he told it this
       * morning he was not on.
       */
      const session = await openSessionLeg(userId);
      const sessionMode = session
        ? (await travelModesFor('day')).find((m) => m.key === session.modeKey) ?? null
        : null;
      const closing =
        session && sessionMode && session.odometerStartKm != null
          ? await meterFor(
              sessionMode,
              {
                title: 'Photograph the meter',
                subtitle: 'Before you punch out — this is where the day is measured to.',
                cancelLabel: 'Stay on the clock',
              },
              session.odometerStartKm,
            )
          : null;
      if (closing === false) return;

      const fix = fixOf(await fixing);
      const out = await checkOut(userId, fix, selfie.id);
      /* After the mark, and unable to undo it. Same order, same reason as the
         punch-in: the session is a journey belonging to a day. */
      if (session) {
        try {
          await endSession({
            legId: session.id,
            fix: fix ? { lat: fix.lat, lng: fix.lng } : null,
            odometer: closing,
          });
        } catch {
          notify('Punched out. The travel for this session could not be closed — check Travel.');
        }
      }
      load();
      notify(
        out.ok
          ? `Punched out · ${durationLabel(out.workedMinutes)} worked`
          : (out.reason ?? 'The day was already closed.'),
      );
      /* Not on a meter day — the readings are the claim. On every other day
         the fares only reach the office if he raises them, so he is asked
         now, while he still remembers the auto from the station. */
      if (
        out.ok &&
        promptsForExpenses(
          session ? { modeKey: session.modeKey, odometerStartKm: session.odometerStartKm } : null,
        )
      ) {
        setClaimPrompt({ modeLabel: sessionMode?.label ?? null });
      }
    } finally {
      setStarting(false);
    }
  };

  /**
   * Back out after closing. Ordinary, not exceptional: lunch, or an evening
   * call after going home. It opens a SECOND session rather than reopening the
   * first, so the gap between them is not counted as worked time.
   */
  const resumeDay = async () => {
    if (!userId || starting) return;
    setStarting(true);
    try {
      /* THE SAME GATE, on the same terms. Coming back after lunch opens a
         session that is tracked exactly like the morning's, so a phone that
         has stopped being able to record must not be able to open one — and a
         rule enforced at one of two doors is a rule salesmen learn to walk
         round. Nothing here is a second copy of it: both doors call the one
         function, and `checkIn` takes what only that function can make. */
      const gate = await mayOpenDay(userId);
      if (!gate.ok) {
        router.push('/phone-setup');
        return;
      }

      const threshold = await getConfig<number>('mbos.location.gpsAccuracyThresholdM', 100);
      const fixing = getFix({ accuracyThresholdM: threshold });

      /* This passed `selfieMediaId: null`, so the second and third check-ins
         of a day went unphotographed — a hole exactly where the record is
         least verifiable, since nobody watches an afternoon session begin. It
         is the same mandatory photograph as the morning's, because they are
         the same act. */
      const selfie = await captureSelfie({
        title: 'Punch in again',
        subtitle: 'A photo of you goes with every punch-in.',
        cancelLabel: 'Stay off the clock',
      });
      if (!selfie.ok) {
        if (selfie.why) notify(selfie.why);
        return;
      }

      /*
       * AND THEN: WHAT IS HE ON TODAY.
       *
       * Asked after the photograph and before anything is written, so backing
       * out of either leaves no half-started day behind — the same order the
       * selfie itself follows. A metered vehicle opens the camera here and
       * nowhere else all day: this reading and the one at the punch-out are
       * the whole of the day's mileage.
       */
      const answer = await askMode();
      if (!answer.ok) return;
      const mode = answer.mode;
      const meter = mode ? await meterFor(mode, {
        title: 'Photograph the meter',
        subtitle: 'Before you set off — this is where the day is measured from.',
        cancelLabel: 'Cancel the punch-in',
      }, null) : null;
      if (meter === false) return;

      const fix = fixOf(await fixing);
      await checkIn({ userId, fix, selfieMediaId: selfie.id, mayOpen: gate.gate, homeLocation: null });
      /* ASKED AGAIN, and that is deliberate: he can bike in the morning and
         take the bus after lunch, and a session that inherited the morning's
         vehicle would quietly claim per-km on a day he spent on buses. */
      if (mode) await openSessionFor(mode, fix, meter);
      set({ gps: fix ? 'locked' : 'off' });
      load();
      notify('Punched back in');
    } finally {
      setStarting(false);
    }
  };

  return (
    <AppFrame title="Home" activeTab="home" contentStyle={{ paddingHorizontal: 16, paddingTop: 14, paddingBottom: 92 }}>
      {/* ---- who and when ---- */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ width: 48, height: 48, borderRadius: radius.xl, backgroundColor: C.primaryTint, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={[{ fontSize: 15, color: C.primaryDeep }, weight(600)]}>
            {boot.session?.user.initials ?? '··'}
          </Text>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={type.h2}>
            {greetingFor(today.getHours()) + ', ' + (boot.session?.user.name.split(' ')[0] ?? '')}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 1 }}>
            <Text style={{ fontSize: 13, color: C.muted }}>{dateLine}</Text>
            {/*
              WHAT HE IS HERE AS — §12.1's role chip.

              The DESIGNATION and not the role. `role` is a LEVEL — associate,
              manager, admin — and AGENTS.md is emphatic that a level is not a
              job: "associate" on a handset says nothing a salesman recognises
              about himself, and it is the same word for the telecaller on the
              phones. What HR publishes in the employee master is what he is
              called at work, so that is what is drawn, and the level is the
              fallback for an account that has none rather than the answer.
              Nothing is drawn where there is neither: an empty chip is a
              rectangle that says less than the space it takes.
            */}
            {roleChip ? (
              <View
                style={{
                  backgroundColor: C.primaryTint,
                  borderRadius: radius.md,
                  paddingHorizontal: 8,
                  paddingVertical: 2,
                }}>
                <Text numberOfLines={1} style={[{ fontSize: 12, color: C.primaryDeep }, weight(600)]}>
                  {roleChip}
                </Text>
              </View>
            ) : null}
          </View>
        </View>
      </View>

      {/* ---- start the day, or what is left of it ----

          THE MOST CONSEQUENTIAL ZERO WAS THIS ONE. `checkedIn` is
          `sessionCount > 0`, and before the read landed that was false — so a
          salesman who had marked his attendance an hour earlier was shown
          "Start day", and pressing it in that window opens a SECOND session
          against his own record. Neither of the two answers is drawn until
          there is one. */}
      {!day ? (
        <Card style={{ marginTop: 14, padding: 14 }}>
          <Text style={type.label}>Your day</Text>
          <Text style={{ fontSize: 14, lineHeight: 20, color: C.muted, marginTop: 4 }}>
            {readErr ?? 'Reading…'}
          </Text>
        </Card>
      ) : !checkedIn ? (
        <View style={{ marginTop: 14 }}>
          <Pressable
            onPress={startDay}
            disabled={starting}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, backgroundColor: C.primary, borderRadius: radius.card, boxShadow: shadow.primaryDeep, opacity: starting ? 0.7 : 1 }}>
            <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.16)', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="play" size={22} color="#FFFFFF" strokeWidth={2} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[{ fontSize: 18, color: '#FFFFFF' }, weight(600)]}>
                {starting ? 'Punching in…' : 'Punch in'}
              </Text>
              <Text style={{ fontSize: 13, lineHeight: 18, color: 'rgba(255,255,255,0.82)', marginTop: 2 }}>
                Takes your photo, marks attendance, starts the timer
              </Text>
            </View>
            <Text style={{ fontSize: 20, color: 'rgba(255,255,255,0.6)' }}>›</Text>
          </Pressable>

          <View style={{ flexDirection: 'row', backgroundColor: C.surface, borderWidth: 1, borderColor: C.hairline, borderRadius: radius.xl, marginTop: 10, overflow: 'hidden' }}>
            {DAY_AHEAD.map((d, i) => (
              <View key={d.l} style={{ flex: 1, paddingVertical: 12, paddingHorizontal: 8, alignItems: 'center', borderLeftWidth: i ? 1 : 0, borderLeftColor: C.hairline }}>
                <Text style={[{ fontSize: 19, lineHeight: 24, color: C.ink }, weight(600), tabular]}>
                  {dayAheadValues[i]}
                </Text>
                <Text style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{d.l}</Text>
              </View>
            ))}
          </View>
        </View>
      ) : (
        <Card style={{ marginTop: 14, padding: 14 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <View style={{ minWidth: 0, flex: 1 }}>
              <Text style={type.label}>{day.running ? 'On the road' : 'Day closed'}</Text>
              <Text style={[{ fontSize: 15, color: C.ink }, weight(500)]}>
                {workedLabel(workedSoFarMs, day.running) + ' · ' + day.stopsDone + ' of ' + day.stops + ' done'}
              </Text>
              {/* Two stretches of work is a fact about the day, and this is the
                  only place it is visible before payroll asks about it. */}
              {day.sessionCount > 1 ? (
                <Text style={[type.caption, { marginTop: 2 }]}>{plural(day.sessionCount, 'session')} today</Text>
              ) : null}
            </View>
            {/* NAMED FOR WHERE IT GOES. It read "Navigate", which is the word
                `NavigateButton` uses two taps away on the journey and visit
                screens — and that one launches turn-by-turn in Google Maps.
                One word, two things, pressed on a bike. This opens the list,
                so it is called what the list is called. */}
            <Pressable
              onPress={() => router.push('/journey')}
              accessibilityRole="button"
              style={{ height: HIT, paddingHorizontal: 16, borderRadius: radius.xl, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center' }}>
              <Text numberOfLines={1} style={[{ fontSize: 15, color: '#FFFFFF' }, weight(500)]}>
                Today’s route
              </Text>
            </Pressable>
          </View>

          {/*
            Ending the day is the other half of starting it, and it was missing
            from the design entirely. It is not destructive: a day can be
            started again afterwards, and the second stretch is ADDED to the
            first rather than replacing it.
          */}
          <Pressable
            onPress={day.running ? endDay : resumeDay}
            disabled={starting}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              height: HIT,
              marginTop: 12,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: day.running ? C.border : C.primary,
              backgroundColor: pressed ? C.wash : day.running ? C.surface : C.primaryTint,
              opacity: starting ? 0.6 : 1,
            })}>
            {/* `camera`, not the clock: what happens when this is pressed is
                that the camera opens, and the icon that says so is worth more
                here than the one restating the label. */}
            <Icon name="camera" size={18} color={day.running ? C.body : C.primaryDeep} />
            <Text style={[{ fontSize: 15, color: day.running ? C.body : C.primaryDeep }, weight(500)]}>
              {day.running ? 'Punch out · photo' : 'Punch in again · photo'}
            </Text>
          </Pressable>
        </Card>
      )}

      {/* ---- whether this phone will record the day at all ----

          THE SWITCHES NOBODY WAS EVER SHOWN. Autostart and the OEM battery
          manager decide whether a route is recorded once the phone goes in a
          pocket, no Android API can read either, and the screen that walks
          somebody through them was reachable from exactly one place: a card on
          the Sync screen, which is opened when somebody thinks his WORK is
          stuck. `shouldOfferSetup` had been written to answer when to put it in
          front of him and nothing called it.

          It sits UNDER the day card rather than above it, because starting the
          day is what he opened this screen to do and a settings prompt in front
          of that is a prompt he learns to swipe past. It is drawn quietly for
          the same reason — the danger colour belongs to the tracker having
          actually stopped, which is the Sync card's sentence, not this one's. */}
      {offerSetup ? (
        <Pressable
          onPress={() => router.push('/tracking-setup?from=home')}
          accessibilityRole="button"
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            minHeight: 56,
            paddingHorizontal: 16,
            marginTop: 12,
            borderWidth: 1,
            borderColor: C.border,
            backgroundColor: C.surface,
            borderRadius: radius.card,
          }}>
          {/* `pin` and not `location`: `Icon` takes `IconName | string` and
              falls back silently on a name it does not have, so a typo here is
              a blank square rather than a compile error. */}
          <Icon name="pin" size={20} color={C.primaryDeep} strokeWidth={1.5} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[{ fontSize: 15, color: C.ink }, weight(600)]}>Keep tracking on</Text>
            <T s="caption" style={{ color: C.muted }}>
              Two settings on your phone decide whether your route is recorded. Takes a minute.
            </T>
          </View>
          <Icon name="forward" size={20} color={C.muted} strokeWidth={1.5} />
        </Pressable>
      ) : null}


      {/* ---- the six numbers ---- */}
      <Card padded={false} style={{ marginTop: 22, overflow: 'hidden' }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          {DASH_CARDS.map((d, i) => (
            <Pressable
              key={d.l}
              disabled={!d.route}
              onPress={() => d.route && router.push(`/${d.route}?from=home`)}
              style={{
                width: '50%',
                padding: 14,
                minHeight: 84,
                borderTopWidth: i > 1 ? 1 : 0,
                borderTopColor: C.wash,
                borderLeftWidth: i % 2 ? 1 : 0,
                borderLeftColor: C.wash,
              }}>
              <Text numberOfLines={1} style={type.label}>{d.l}</Text>
              <Text
                numberOfLines={1}
                style={[
                  /* The line height does not move with the size, so a tile
                     saying a sentence is exactly as tall as one saying a
                     number and the grid cannot jump. */
                  /* A tile's tone belongs to its FIGURE. Left on, the em-dash
                     standing in for a figure nobody has yet read drew in red
                     under "Collection due" — an alarm about a number that does
                     not exist. */
                  {
                    fontSize: dashValues[i].small ? 15 : 20,
                    lineHeight: 26,
                    marginVertical: 2,
                    color: figuresPending
                      ? C.muted
                      : d.tone === 'danger'
                        ? C.danger
                        : d.tone === 'amber'
                          ? C.warnInk
                          : C.ink,
                  },
                  weight(600),
                  tabular,
                ]}>
                {dashValues[i].v}
              </Text>
              <Text numberOfLines={1} style={{ fontSize: 12, color: C.muted }}>{dashValues[i].s}</Text>
            </Pressable>
          ))}
        </View>
      </Card>

      {/*
        NOTHING HAS COME DOWN FROM THE OFFICE YET, SAID IN WORDS.

        This is the state the zeros hid, and it is permanent rather than a
        frame: a handset whose pull has never landed has no customers, no plan
        and no tasks, so every tile answered nought and the status strip said
        "All sent" over the top of them — because that pip counts the outbox and
        has nothing to say about the inbox. A salesman reads that as a day with
        no work in it and gets on with something else.
      */}
      {day && neverPulled ? (
        <Card style={{ marginTop: 12, padding: 14 }}>
          <Text style={[{ fontSize: 15, color: C.ink }, weight(600)]}>Your book has not arrived</Text>
          <Text style={{ fontSize: 14, lineHeight: 20, color: C.body, marginTop: 4 }}>
            Nothing has come down from the office onto this phone yet, so these figures are empty
            rather than nought. Find some signal and leave MBOS open for a minute — your customers,
            today&rsquo;s plan and your tasks all arrive together.
          </Text>
        </Card>
      ) : null}

      {/* ---- the leads half of the morning ----

          §12.1, AND IT SITS HERE RATHER THAN AT THE TOP.

          Everything above this line was already on the screen and answers the
          DAY: has it started, what is the route, what has been sold, collected
          and banked. Leads are the other half of a morning and not a louder
          half, so they go under it — nothing that was above the fold has been
          pushed below it, which was the first rule of adding anything here.

          §12.4 is why there is no distributor term, no commercial table and no
          approval queue anywhere in it: the mobile view is not a shrunk
          desktop. A field salesman never needs those, so they are absent from
          the data path rather than hidden by a style — `listLeads` reads his
          own book off this phone and there is nothing else on the wire to
          leak.

          WHAT IT DELIBERATELY DOES NOT DRAW is a second "Today's visits" list.
          The specification's mobile Home names one, and this screen already
          has the day's route three cards up — a planned journey through shops
          somebody chose. A second list under almost the same words would be
          two different questions wearing one name on one screen, and the
          salesman would have to work out which was which. What is drawn is
          what the route cannot answer: the leads that are owed something
          today. */}
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 22 }}>
        <Text style={[type.label, { flex: 1 }]}>Your leads</Text>
        <Pressable onPress={() => router.push('/lead-actions?from=home')} accessibilityRole="button">
          <Text style={[{ fontSize: 13, color: C.primaryDeep }, weight(600)]}>What is owed ›</Text>
        </Pressable>
      </View>

      {/*
        THREE FIGURES, AND EACH ONE OPENS THE LIST IT COUNTS.

        A headline nobody can get behind is a number somebody has to take on
        trust, and on a phone the tap is the only way behind it. Each carries
        its own view in the URL, so the list that opens is the one whose number
        was pressed rather than the first of four with another tap to go.

        Overdue is red where it is not nought and plain where it is, because a
        red nought is an alarm about nothing and teaches people to stop reading
        the colour. The dash rule is the one the six figures above already
        follow: a figure nobody has read yet is a dash, never a nought.
      */}
      <View
        style={{
          flexDirection: 'row',
          backgroundColor: C.surface,
          borderWidth: 1,
          borderColor: C.hairline,
          borderRadius: radius.xl,
          marginTop: 8,
          overflow: 'hidden',
        }}>
        {([
          /* My leads is the BOOK and not a cut of it, so it opens the book —
             the same list the Customers tab and the More screen already show.
             Pointing it at a view of the worklist would have been tidier and
             would answer a different question to the one its own label asks. */
          { l: 'My leads', v: leads?.counts.working, href: '/leads?from=home', tone: C.ink },
          { l: 'Overdue', v: leads?.counts.overdue, href: '/lead-actions?view=overdue&from=home', tone: C.danger },
          { l: 'Due today', v: leads?.counts.today, href: '/lead-actions?view=today&from=home', tone: C.ink },
        ] as const).map((stat, i) => (
          <Pressable
            key={stat.l}
            onPress={() => router.push(stat.href)}
            accessibilityRole="button"
            style={{
              flex: 1,
              paddingVertical: 12,
              paddingHorizontal: 8,
              alignItems: 'center',
              borderLeftWidth: i ? 1 : 0,
              borderLeftColor: C.hairline,
            }}>
            <Text
              style={[
                {
                  fontSize: 19,
                  lineHeight: 24,
                  color:
                    leadsPending || stat.v === undefined
                      ? C.muted
                      : stat.v > 0
                        ? stat.tone
                        : C.ink,
                },
                weight(600),
                tabular,
              ]}>
              {leadsPending || stat.v === undefined ? '—' : String(stat.v)}
            </Text>
            <Text style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{stat.l}</Text>
          </Pressable>
        ))}
      </View>

      {/*
        AND THE SIX CARDS UNDER THEM.

        An empty list here says WHICH emptiness it is. "Nothing owed today" is
        a good morning; "your book has not arrived" is a support call; and a
        read that failed is a phone to restart. Drawn alike they are the state
        nobody debugs, because two of the three look like having no work.
      */}
      {readErr ? (
        <Card style={{ marginTop: 10, padding: 14 }}>
          <Text style={{ fontSize: 14, lineHeight: 20, color: C.muted }}>Not read on this phone.</Text>
        </Card>
      ) : !leads ? (
        <Card style={{ marginTop: 10, padding: 14 }}>
          <Text style={{ fontSize: 14, lineHeight: 20, color: C.muted }}>Reading…</Text>
        </Card>
      ) : neverPulled ? null /* the card above already says it, in full */ : leads.counts.working === 0 ? (
        <Card style={{ marginTop: 10, padding: 14 }}>
          <Text style={{ fontSize: 14, lineHeight: 20, color: C.muted }}>
            No leads being worked. A shop you walk past is how a new one starts.
          </Text>
        </Card>
      ) : leads.dueToday.length === 0 ? (
        <Card style={{ marginTop: 10, padding: 14 }}>
          <Text style={{ fontSize: 14, lineHeight: 20, color: C.muted }}>
            {leads.counts.overdue
              ? 'Nothing owed today — but ' + plural(leads.counts.overdue, 'lead') + ' past its day.'
              : 'Nothing owed on a lead today.'}
          </Text>
        </Card>
      ) : (
        <View style={{ gap: 10, marginTop: 10 }}>
          {leads.dueToday.map((lead) => (
            <LeadActionCard key={lead.id} lead={lead} meId={userId} from="home" />
          ))}
          {/* A capped list says what it is a slice of. Six cards over a due
              count of nineteen with nothing saying so is a screen quietly
              losing thirteen shops. */}
          {leads.counts.today > leads.dueToday.length ? (
            <Pressable
              onPress={() => router.push('/lead-actions?view=today&from=home')}
              accessibilityRole="button">
              <Text style={[type.caption, { textAlign: 'center' }]}>
                {'Showing ' + leads.dueToday.length + ' of ' + leads.counts.today + ' — tap for the rest'}
              </Text>
            </Pressable>
          ) : null}
        </View>
      )}

      {/* ---- how the period is going ----

          This panel used to render a fixture — ₹18,42,000 of ₹26,00,000, a
          progress bar and 71%, with "These figures are not live yet" in grey
          underneath. A number with a bar under it is read as fact at a glance
          and the caption is not read at all, and this is the first screen
          after sign-in. So it was replaced with the truth as it stood: the
          office computes targets and sends none.

          IT SENDS THEM NOW, and this card went on saying it did not. The
          office publishes a target per person, scores the month against it,
          and the whole thing comes down the sync as a row per month —
          `app/performance.tsx` has rendered it for as long as it has existed.
          A sentence that was honest when it was written became the one place
          in the app that contradicted the rest of it, on the screen a salesman
          sees first. It reads the same cache that screen does. */}
      <Pressable
        onPress={() => router.push('/performance?from=home')}
        style={{ marginTop: 12 }}>
        <Card style={{ padding: 14 }}>
          <Text style={type.label}>Your target</Text>
          {readErr ? (
            /* The read failed, and "the office has not set one" would be a
               claim about the office rather than about this phone. */
            <Text style={{ fontSize: 14, lineHeight: 20, color: C.muted, marginTop: 6 }}>
              Not read on this phone.
            </Text>
          ) : month === undefined ? (
            <Text style={{ fontSize: 14, lineHeight: 20, color: C.muted, marginTop: 6 }}>Reading…</Text>
          ) : month === null || !month.hasTarget ? (
            <Text style={{ fontSize: 14, lineHeight: 20, color: C.muted, marginTop: 6 }}>
              The office has not set one. Today&rsquo;s orders, visits and collections are in the six
              figures above.
            </Text>
          ) : (
            <>
              {/* Revenue and volume together, never revenue alone. A price
                  revision moves the first and cannot move the second, so a
                  month at target on rupees and short on litres is a month that
                  sold LESS and billed more — and it is exactly the month
                  somebody would otherwise be congratulated for. The score is
                  the office's and is printed, never recomputed here. */}
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 2 }}>
                <Text style={[{ fontSize: 22, lineHeight: 28, color: C.ink }, weight(600), tabular]}>
                  {month.totalScoreBp == null ? '—' : (month.totalScoreBp / 100).toFixed(0)}
                </Text>
                <Text style={{ fontSize: 13, color: C.muted }}>out of 100</Text>
                {month.rating ? (
                  <Text style={{ fontSize: 13, color: C.muted }}>{'· ' + month.rating}</Text>
                ) : null}
              </View>
              <Text style={{ fontSize: 14, lineHeight: 20, color: C.body, marginTop: 4 }}>
                {shortfalls(month)[0] ?? 'You are at or above every target set for you.'}
              </Text>
              {/*
                WHICH MONTH, AND WHEN IT WAS WORKED OUT.

                `load` takes the newest row the handset holds, which on the 3rd
                is still last month's — and this card printed a score at 22
                points with neither the period nor the as-at on it, so a big
                number read as this month's live standing. `computedAt` was
                here all along and was used as a BOOLEAN, to decide whether to
                append "tap for the rest", and never printed. AGENTS.md states
                the rule in as many words: the handset is sent the cache with
                its `computed_at` and prints it, because a screen that implied
                it was live would be believed. `/performance`, one tap away,
                has done both since it shipped.
              */}
              <Text style={[type.caption, { marginTop: 4 }]}>
                {monthLabel(month.period) +
                  (month.computedAt ? ' · as at ' + asAt(month.computedAt) : '') +
                  ' · tap for the rest'}
              </Text>
            </>
          )}
        </Card>
      </Pressable>

      <SelfieCamera
        open={selfieOpen}
        title={selfieWords.title}
        subtitle={selfieWords.subtitle}
        cancelLabel={selfieWords.cancelLabel}
        onDone={(result) => {
          setSelfieOpen(false);
          answerSelfie.current?.(result);
          answerSelfie.current = null;
        }}
      />

      {/*
        WHAT IS HE ON TODAY. Between the photograph and the mark.

        There is no "skip": the vehicle is what the day's travel is paid on,
        and a session with no mode would be a day of movement nobody can
        price. Backing out abandons the punch-in instead, which costs him one
        tap and leaves nothing written — the same bargain the selfie strikes
        one step earlier.
      */}
      <BottomSheet
        open={modeOpen}
        onClose={() => {
          setModeOpen(false);
          answerMode.current?.(null);
          answerMode.current = null;
        }}>
        <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 20 }}>
          <T style={[{ fontSize: 17, lineHeight: 22, color: C.ink }, weight(600)]}>
            How are you travelling today?
          </T>
          <T s="small" style={{ marginTop: 4 }}>
            Asked once, for this session. You are not asked again at each shop.
          </T>

          <TravelModeList
            modes={dayModes}
            where="day"
            onPick={(m) => {
              setModeOpen(false);
              answerMode.current?.(m);
              answerMode.current = null;
            }}
          />

          <View style={{ marginTop: 12 }}>
            <SecondaryButton
              label="Not punching in yet"
              onPress={() => {
                setModeOpen(false);
                answerMode.current?.(null);
                answerMode.current = null;
              }}
            />
          </View>
        </View>
      </BottomSheet>

      {/* ─────────────────────────── after the punch-out: raise the day's costs */}
      <BottomSheet open={!!claimPrompt} onClose={() => setClaimPrompt(null)}>
        <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 20 }}>
          <T style={[{ fontSize: 17, lineHeight: 22, color: C.ink }, weight(600)]}>
            Add today&apos;s expenses
          </T>
          <T s="small" style={{ marginTop: 6 }}>
            {(claimPrompt?.modeLabel
              ? `You travelled by ${claimPrompt.modeLabel.toLowerCase()} today. `
              : '') +
              'Fares, food and anything else you spent reach the office only if you add them — with a photo or PDF of each bill. It takes a minute now.'}
          </T>
          <View style={{ marginTop: 14 }}>
            <PrimaryButton
              label="Add expenses"
              onPress={() => {
                setClaimPrompt(null);
                router.push({ pathname: '/expenses', params: { add: '1' } });
              }}
            />
          </View>
          <View style={{ marginTop: 10 }}>
            <SecondaryButton label="Later" onPress={() => setClaimPrompt(null)} />
          </View>
        </View>
      </BottomSheet>

      <OdometerCamera
        open={metering}
        title={meterWords.title}
        subtitle={meterWords.subtitle}
        cancelLabel={meterWords.cancelLabel}
        previousKm={meterFrom}
        maxLegKilometres={maxLegKm}
        onDone={(result) => {
          setMetering(false);
          answerMeter.current?.(result);
          answerMeter.current = null;
        }}
      />
    </AppFrame>
  );
}
