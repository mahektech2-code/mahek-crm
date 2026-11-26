import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { color as C, radius, weight, tabular } from '../src/theme/tokens';
import { Icon } from '../src/components/ui/Icon';
import { CountUp, PressableScale, Stagger, Swap } from '../src/components/ui/motion';
import { Badge, Card, T } from '../src/components/ui/primitives';
import { Glyph, type GlyphShape } from '../src/components/me/kit';
import Svg, { Circle as SvgCircle } from 'react-native-svg';
import { promptsForExpenses } from '../src/lib/travel-leg';
import { AppFrame } from '../src/components/shell/AppFrame';
import { RemoteBanners } from '../src/components/remote/RemoteBanners';
import { copy, useRemote } from '../src/data/remote';
import { useStore } from '../src/state/store';
import { readArrival } from '../src/data/arrival';
import { useBoot } from '../src/state/boot';
import { compactInrFromPaise, dmy, hhmm, inrFromPaise, isoDate, plural } from '../src/lib/format';
import { DASH_CARDS, DAY_AHEAD } from '../src/data/fixtures';
import {
  checkIn,
  checkOut,
  dayState,
  durationLabel,
  runningSince,
  setOverrideReason,
  todayRow,
  workedLabel,
  workedMs,
  type Session,
} from '../src/data/attendance';
import { useTicker } from '../src/components/ui/use-ticker';
import { collectionDue, followUpsOwed } from '../src/data/customers';
import { listPerformance, shortfalls, type SyncedMonth } from '../src/data/performance';
import { getConfig } from '../src/data/config';
import { mayOpenDay } from '../src/data/day-gate';
import { punchOutDue } from '../src/engines/punch-out';
import { syncPunchOutReminders } from '../src/native/punch-out-reminder';
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
import { visitsToday } from '../src/data/visits';
import { stopCounts } from '../src/data/journey';
import { lastPullAt } from '../src/sync/api';
import { stalledAt } from '../src/sync/trail';
import { lastAskedAt } from '../src/native/keepalive';
import { shouldOfferSetup } from '../src/engines/oem-keepalive';
import { withinGeofence } from '../src/engines/geo';
import { fixOf, getFix, type Fix } from '../src/native/location';
import { ensureLocationPermission } from '../src/native/permissions';
import { walkthroughDue } from '../src/data/setup-walkthrough';
import { NotificationsPrompt } from '../src/components/setup/NotificationsPrompt';
import { queueOdometerPhoto, queueSelfie } from '../src/native/capture';
import { discardQueuedMedia } from '../src/sync/media';
import { SelfieCamera, type SelfieResult } from '../src/components/ui/selfie-camera';
import { OdometerCamera, type OdometerResult } from '../src/components/ui/odometer-camera';
import { BottomSheet } from '../src/components/ui/overlays';
import { TravelModeList } from '../src/components/ui/travel-mode-list';
import {
  abandonLeg,
  addLateClosingReading,
  dismissUnpaidMeterDay,
  endSession,
  openLegOf,
  openSessionLeg,
  todayOpeningKm,
  unpaidMeterDay,
  startSession,
  travelModesFor,
  type TravelMode,
  type UnpaidMeter,
} from '../src/data/travel';

/**
 * Home is the first thing on screen at 9am and the thing returned to between
 * shops. It answers, in order: has the day started, what is worth doing next,
 * and how the month is going.
 *
 * Every figure on it is a query against the local store. Nothing here waits on
 * the network, so it renders the same in a basement as it does on Wi-Fi.
 */

/**
 * One of the day card's two buttons. Same height, corners and type whether it
 * is the filled one or not, so the pair reads as a pair; `tint` is a closed
 * day's "Punch in again", which is an offer rather than the main action.
 */
function DayAction({
  icon,
  label,
  filled,
  tint = false,
  disabled = false,
  onPress,
}: {
  icon: 'route' | 'camera';
  label: string;
  filled: boolean;
  tint?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  /* Version 3 draws the pair inside the navy hero: the filled one lime, the
     other an outline on the navy, and a closed day's offer a soft lilac. */
  const fg = filled ? C.navy : tint ? C.primaryEdge : C.onNavy;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: 56,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        paddingHorizontal: 12,
        borderRadius: 28,
        borderWidth: filled || tint ? 0 : 1,
        borderColor: 'rgba(255,255,255,0.22)',
        backgroundColor: filled ? C.lime : tint ? 'rgba(220,209,252,0.18)' : 'transparent',
        opacity: disabled ? 0.6 : pressed ? 0.85 : 1,
      })}>
      <Icon name={icon} size={18} color={fg} strokeWidth={2} />
      <Text numberOfLines={1} style={[{ fontSize: 15, color: fg }, weight(filled ? 800 : 700)]}>
        {label}
      </Text>
    </Pressable>
  );
}

type Day = {
  stops: number;
  stopsDone: number;
  collectPaise: number;
  collectCustomers: number;
  followUps: number;
  followUpsToday: number;
  followUpsMissed: number;
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
  followUpsMissed: 0,
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

/* What the tiles count in. Rounded before formatting, because a count passes
   through fractions of a paisa on its way and `inrFromPaise` should only ever
   be handed whole ones. */
const rupees = (x: number) => inrFromPaise(Math.round(x));
const whole = (x: number) => String(Math.round(x));

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
  const [month, setMonth] = React.useState<SyncedMonth | null | undefined>(undefined);
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
  /* The hour punching out becomes the main button. Null until read, and read
     as "not yet" — a prompt that flashes on and off as config lands is worse
     than one that arrives a frame late. */
  const [punchOutHour, setPunchOutHour] = React.useState<number | null>(null);
  /* `?punchOut=1` is the punch-out reminder notification, and the close-the-day
     screen, sending him here to do exactly that. See the effect beside `endDay`. */
  const params = useLocalSearchParams<{ punchOut?: string }>();

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
  /* The office's sentences and banners — `data/remote.ts`. Every one falls
     back to what is written here. */
  const remote = useRemote();
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
  /* A metered day closed by the app with no punch-out — its km are not paid,
     and he hears it here rather than from the claim. See `closeStaleSessions`. */
  const [unpaidMeter, setUnpaidMeter] = React.useState<UnpaidMeter | null>(null);
  const [savingLateMeter, setSavingLateMeter] = React.useState(false);
  useFocusEffect(
    React.useCallback(() => {
      let live = true;
      void unpaidMeterDay()
        .then((d) => live && setUnpaidMeter(d))
        .catch(() => {});
      return () => {
        live = false;
      };
    }, [setUnpaidMeter]),
  );

  const load = React.useCallback(() => {
    if (!userId) return;
    const iso = isoDate(new Date());

    /* The evening reminders follow the day. Every punch-in and punch-out on
       this screen ends in `load()`, and so does every return to Home, so one
       reconcile here keeps them right through all of it — including a setting
       changed in the office since the morning. It never throws. */
    void syncPunchOutReminders(userId);

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
      followUpsOwed(iso),
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
        followUps: follow.owed,
        followUpsToday: follow.dueToday,
        followUpsMissed: follow.missed,
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
      setReadErr('Your day did not load. Close MBOS and open it again.');
    });
  }, [userId]);

  useFocusEffect(load);

  React.useEffect(() => {
    void getConfig<number>('mbos.attendance.punchOutPromptHour', 18)
      .then(setPunchOutHour)
      .catch(() => setPunchOutHour(18));
  }, []);

  const checkedIn = !!day && day.sessionCount > 0;
  /* See `engines/punch-out.ts`: loud only when it is the right thing to press. */
  const punchOutLoud =
    !!day && punchOutHour != null && punchOutDue({ running: day.running, nowMs: now, promptHour: punchOutHour });

  const today = new Date(now);
  const dateLine = `${WEEKDAYS[today.getDay()].slice(0, 3)} ${today.getDate()} ${MONTHS[today.getMonth()].slice(0, 3)}`;

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
  /*
   * `n` is the same figure as a NUMBER, where there is one, so the tile can
   * count to it. `fmt` draws it exactly as `v` would have — the count is how
   * the figure arrives, never a second way of writing it. A tile without `n`
   * (a dash, "Not known yet", "3 of 5") is drawn as text and does not move.
   */
  const dashValues: { v: string; s: string; small?: boolean; n?: number; fmt?: (x: number) => string }[] = !day
    ? DASH_CARDS.map(() => ({ v: '—', s: readErr ? 'Did not load' : 'Loading…' }))
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
      ...(day.orderValueUnknown ? {} : { n: day.orderValuePaise, fmt: rupees }),
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
      /* And the subtitle says what the number IS. It read "0 visits done"
         under "2 of 6" — a second count of a different thing, contradicting
         the first in the same tile. The walk-ins are what the visits add, so
         that is the only part of them worth a line. */
      s: day.stops
        ? 'shops done' + (day.visits > day.stopsDone ? ' · ' + (day.visits - day.stopsDone) + ' off the plan' : '')
        : 'No plan today',
    },
    { v: inrFromPaise(day.collectPaise), s: plural(day.collectCustomers, 'customer'), n: day.collectPaise, fmt: rupees },
    { v: inrFromPaise(day.cashPaise), s: day.cashSentence || 'Nothing to deposit', n: day.cashPaise, fmt: rupees },
    /* "overdue" is not a noun, so it does not take an s: "49 overdue". */
    { v: String(day.tasks), s: day.tasksOverdue ? day.tasksOverdue + ' overdue' : 'None overdue', n: day.tasks, fmt: whole },
    {
      v: String(day.followUps),
      s: day.followUpsMissed ? day.followUpsMissed + ' missed' : day.followUpsToday ? day.followUpsToday + ' today' : 'None due',
      n: day.followUps,
      fmt: whole,
    },
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
    subtitle: 'Take a photo of yourself to punch in.',
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
      notify('Photo not saved. Nothing was recorded. Try again.', 'error');
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
      notify('Punched in. Travel did not start. Add it on Travel.', 'warn');
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
        why: 'Photo not saved. Nothing was recorded. Try again.',
      };
    }
  };

  /**
   * LET GO OF PHOTOGRAPHS FOR A PUNCH THAT DID NOT HAPPEN.
   *
   * The selfie and the meter are queued the moment the camera closes, against
   * `'pending'`, because the row they belong to does not exist yet. Backing out
   * at the vehicle question or the meter left them in the queue all the same,
   * and they went up with no parent: a photograph of an employee held for a
   * punch nobody made, until the orphan sweep found it a day later.
   */
  const dropShots = (...ids: (string | null | undefined)[]) => {
    for (const id of ids) if (id) void discardQueuedMedia(id).catch(() => {});
  };

  /**
   * Away from base: the day is open either way, and the reason is asked after.
   * One function for both doors — the afternoon's punch-in used to pass no base
   * at all, so a session opened anywhere was never asked about.
   */
  const askWhyAwayFromBase = (
    dayId: string,
    fix: Fix | null,
    base: { lat: number; lng: number } | null,
    radiusM: number,
    okWords: string,
  ) => {
    const geo = base && fix ? withinGeofence(fix, base, radiusM) : null;
    if (geo && !geo.inside) {
      askConfirm({
        title: 'You are not at base',
        body: 'Day started · your manager sees the reason',
        reasonLabel: 'Why · needed',
        confirmLabel: 'Send reason',
        run: (reason) => {
          void setOverrideReason(dayId, reason);
          notify('Sent to your manager');
        },
      });
      return;
    }
    notify(okWords + (fix ? ' · GPS found' : ' · saved without location'), fix ? 'success' : 'warn');
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
        subtitle: 'Take a photo of yourself to punch in.',
        cancelLabel: 'Cancel the punch-in',
      });
      if (!selfie.ok) {
        /* Nothing has been written, so there is nothing to undo. The fix is
           abandoned with it — a location for a check-in that did not happen is
           a record of somewhere somebody stood while nothing happened. */
        if (selfie.why) notify(selfie.why, 'error');
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
      if (!answer.ok) {
        dropShots(selfie.id);
        return;
      }
      const mode = answer.mode;
      const meter = mode ? await meterFor(mode, {
        title: 'Photograph the meter',
        subtitle: 'Before you start. Today’s km are counted from this reading.',
        cancelLabel: 'Cancel the punch-in',
      }, null) : null;
      if (meter === false) {
        dropShots(selfie.id);
        return;
      }

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
      /* Already running — a second tap that raced the first. Nothing new was
         opened, so the photographs taken for it belong to nothing. */
      if (row.alreadyRunning) {
        dropShots(selfie.id, meter ? meter.photoId : null);
        load();
        notify('You are already punched in.', 'info');
        return;
      }

      if (mode) await openSessionFor(mode, fix, meter);

      set({ gps: fix ? 'locked' : 'off' });
      load();

      askWhyAwayFromBase(row.id, fix, base, radius, 'Day started');
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
    /*
     * A SHOP HE IS STILL AT IS ASKED ABOUT FIRST, before the camera opens.
     *
     * Punching out used to ignore the visit entirely: the day closed, the
     * tracker stopped, and the visit went on running in his pocket until the
     * day-boundary sweep closed it "no check-out was recorded" — with the
     * ride home counted as time in the shop, and his manager reading a visit
     * that never ended. The arrival is on disk, so it is known here; the way
     * out of it (Check out, or Not going in) is on the visit screen, and that
     * is where he is sent. Nothing is written by the question.
     */
    const there = useStore.getState().arrival ?? (await readArrival().catch(() => null));
    if (there) {
      askConfirm({
        title: there.checkedInAt != null ? `Still in ${there.customerName}` : `Still at ${there.customerName}`,
        body:
          there.checkedInAt != null
            ? 'Your visit is still on. Check out first, then punch out. Otherwise the visit runs until the end of the day.'
            : 'You arrived and did not check in. Check in, or say you are not going in, then punch out.',
        confirmLabel: there.checkedInAt != null ? 'Go to check out' : 'Go to the shop',
        cancelLabel: 'Stay punched in',
        tone: 'navy',
        run: () => {
          set({ custId: there.customerId });
          router.push('/visit');
        },
      });
      return;
    }
    setStarting(true);
    try {
      const threshold = await getConfig<number>('mbos.location.gpsAccuracyThresholdM', 100);
      const fixing = getFix({ accuracyThresholdM: threshold });

      /* A photograph at THIS end too, and there was none before — so a day
         proved that somebody arrived and proved nothing whatever about when
         they stopped, which is the half that decides the hours. */
      const selfie = await captureSelfie({
        title: 'Punch out',
        subtitle: 'Take a photo of yourself to punch out.',
        cancelLabel: 'Stay punched in',
      });
      if (!selfie.ok) {
        if (selfie.why) notify(selfie.why, 'error');
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
      /*
       * THIS STRETCH'S SESSION, not any session ever left open.
       *
       * A bus day opens no session leg, so yesterday's own-bike session — on
       * a phone that has not yet seen a day boundary — was the open one, and
       * punching out of a day spent on buses opened the camera for a bike
       * he was not on, and wrote today's reading onto yesterday's ride. Only
       * a session started inside the punch-in he is ending is his to close
       * here; an older one is `closeStaleSessions`' to close at its own
       * reading, which is what it is for.
       */
      const stretch = await runningSince(userId);
      const session = await openSessionLeg(userId, stretch ?? undefined);
      const sessionMode = session
        ? (await travelModesFor('day')).find((m) => m.key === session.modeKey) ?? null
        : null;
      const closing =
        session && sessionMode && session.odometerStartKm != null
          ? await meterFor(
              sessionMode,
              {
                title: 'Photograph the meter',
                subtitle: 'Before you punch out. Today’s km are counted up to this reading.',
                cancelLabel: 'Stay punched in',
              },
              session.odometerStartKm,
            )
          : null;
      if (closing === false) {
        dropShots(selfie.id);
        return;
      }

      const fix = fixOf(await fixing);
      const out = await checkOut(userId, fix, selfie.id);
      /* NOTHING WAS CLOSED, so nothing else may be. The travel session used
         to be ended here whatever the punch-out said — so a punch-out refused
         after midnight still closed the day's meter at the closing reading,
         and the photographs went up for a mark that was never written. */
      if (!out.ok) dropShots(selfie.id, closing ? closing.photoId : null);
      /* After the mark, and unable to undo it. Same order, same reason as the
         punch-in: the session is a journey belonging to a day. */
      if (session && out.ok) {
        try {
          await endSession({
            legId: session.id,
            fix: fix ? { lat: fix.lat, lng: fix.lng } : null,
            odometer: closing,
          });
        } catch {
          notify('Punched out. Travel did not close. Check Travel.', 'warn');
        }
      }
      /* A TRIP HE NEVER ARRIVED FROM is closed with the punch-out, at its own
         reading, and named. Left open it held `TravelGate` shut against the
         next morning's first journey and claimed a ride nobody finished. */
      if (out.ok) {
        try {
          const trip = await openLegOf(userId);
          if (trip) await abandonLeg(trip.id, 'Punched out before arriving.');
        } catch {
          /* The punch-out has landed; the day boundary closes it anyway. */
        }
      }
      load();
      notify(
        out.ok
          ? `Punched out · ${durationLabel(out.workedMinutes)} worked`
          : (out.reason ?? 'Your day was already closed.'),
        out.ok ? 'success' : 'error',
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
        subtitle: 'Take a photo of yourself to punch in.',
        cancelLabel: 'Stay punched out',
      });
      if (!selfie.ok) {
        if (selfie.why) notify(selfie.why, 'error');
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
      if (!answer.ok) {
        dropShots(selfie.id);
        return;
      }
      const mode = answer.mode;
      const meter = mode ? await meterFor(mode, {
        title: 'Photograph the meter',
        subtitle: 'Before you start. Today’s km are counted from this reading.',
        cancelLabel: 'Cancel the punch-in',
      }, null) : null;
      if (meter === false) {
        dropShots(selfie.id);
        return;
      }

      const radius = await getConfig<number>('mbos.attendance.geofenceRadiusM', 200);
      const base = await getConfig<{ lat: number; lng: number } | null>('mbos.attendance.baseLocation', null);
      const fix = fixOf(await fixing);
      const row = await checkIn({ userId, fix, selfieMediaId: selfie.id, mayOpen: gate.gate, homeLocation: base });
      if (row.alreadyRunning) {
        dropShots(selfie.id, meter ? meter.photoId : null);
        load();
        notify('You are already punched in.', 'info');
        return;
      }
      /* ASKED AGAIN, and that is deliberate: he can bike in the morning and
         take the bus after lunch, and a session that inherited the morning's
         vehicle would quietly claim per-km on a day he spent on buses. */
      if (mode) await openSessionFor(mode, fix, meter);
      set({ gps: fix ? 'locked' : 'off' });
      load();
      askWhyAwayFromBase(row.id, fix, base, radius, 'Punched back in');
    } finally {
      setStarting(false);
    }
  };

  /*
   * THE BAR'S TAP LANDS HERE AND OPENS THE CAMERA. "Punch out" pressed on the
   * visit screen that only moved him to Home would be a second press for the
   * same decision, at the end of a day. Once, and only once the day has been
   * read and is still running — a param left behind must not open a camera
   * on somebody who has already punched out. The param is cleared first, so a
   * back-and-forth to Home cannot fire it twice.
   */
  const punchOutAsked = React.useRef(false);
  React.useEffect(() => {
    /* Re-armed once the param is gone, because Home is a tab root and stays
       mounted: without this a second tap on the bar or the reminder, later
       the same evening, would land here and do nothing. */
    if (params.punchOut !== '1') {
      punchOutAsked.current = false;
      return;
    }
    if (punchOutAsked.current || !day) return;
    punchOutAsked.current = true;
    router.setParams({ punchOut: undefined });
    if (day.running) void endDay();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- endDay is recreated every render; the ref is the guard
  }, [params.punchOut, day]);

  /* ---- the hero: who and when, and the day itself ---- */
  /* ---- who and when ---- drawn FIRST in the hero, beside refresh and the
     bell, as the artboard has it; the status chips sit under it. */
  const heroIdentity = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={[{ fontSize: 14, lineHeight: 20, color: C.onNavy }, weight(700)]}>
          {boot.session?.user.initials ?? '··'}
        </Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text accessibilityRole="header" numberOfLines={1} style={[{ fontSize: 16, lineHeight: 21, color: C.onNavy }, weight(700)]}>
          {copy(remote, 'text.home.greeting', greetingFor(today.getHours())) + ', ' + (boot.session?.user.name.split(' ')[0] ?? '')}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
          <Text style={[{ fontSize: 12, lineHeight: 17, color: C.onNavyMuted }, weight(400)]}>{dateLine}</Text>
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
                flexShrink: 1,
                minHeight: 20,
                paddingVertical: 2,
                justifyContent: 'center',
                backgroundColor: 'rgba(255,255,255,0.10)',
                borderRadius: 10,
                paddingHorizontal: 8,
              }}>
              <Text numberOfLines={1} style={[{ fontSize: 12, color: C.primaryEdge }, weight(700)]}>
                {roleChip}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );

  const hero = (
    <View>
      {/* ---- start the day, or what is left of it ----

          THE MOST CONSEQUENTIAL ZERO WAS THIS ONE. `checkedIn` is
          `sessionCount > 0`, and before the read landed that was false — so a
          salesman who had marked his attendance an hour earlier was shown
          "Start day", and pressing it in that window opens a SECOND session
          against his own record. Neither of the two answers is drawn until
          there is one. */}
      {/* ONE PLACE, FOUR STATES — not read yet, not started, on the road,
          closed — and each replaces the last where it stood. Punching in or
          out is the moment the card changes, so it settles into its new state
          rather than cutting; no buzz of its own, because every punch already
          ends in a toast that carries one. */}
      <Swap id={!day ? 'loading' : !checkedIn ? 'out' : day.running ? 'running' : 'closed'}>
      {!day ? (
        <View style={{ marginTop: 18, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.06)', padding: 14 }}>
          <Text style={[{ fontSize: 13, lineHeight: 18, color: C.onNavyMuted }, weight(700)]}>Your day</Text>
          <Text style={[{ fontSize: 14, lineHeight: 20, color: C.onNavyMuted, marginTop: 4 }, weight(400)]}>
            {readErr ?? 'Loading…'}
          </Text>
        </View>
      ) : !checkedIn ? (
        <View style={{ marginTop: 18 }}>
          <PressableScale
            onPress={startDay}
            disabled={starting}
            accessibilityRole="button"
            accessibilityLabel={starting ? 'Punching in' : 'Punch in'}
            accessibilityHint="Takes your photo, marks attendance, starts timer"
            accessibilityState={{ busy: starting }}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 72, paddingHorizontal: 16, backgroundColor: C.lime, borderRadius: 24, opacity: starting ? 0.6 : 1 }}>
            {starting ? null : (
              <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: C.navy, alignItems: 'center', justifyContent: 'center' }}>
                <Glyph shapes={PLAY} size={20} color={C.lime} fill={C.lime} />
              </View>
            )}
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[{ fontSize: 19, lineHeight: 24, color: C.navy }, weight(800)]}>
                {starting ? 'Punching in…' : 'Punch in'}
              </Text>
              {/* What pressing it does, as three marks: the photograph, the
                  attendance, the timer. Read out whole as the hint. */}
              {starting ? null : (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 3 }}>
                  {([
                    [CAMERA, 'Photo'],
                    [TICK, 'Attendance'],
                    [CLOCK, 'Timer'],
                  ] as const).map(([g, w]) => (
                    <View key={w} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <Glyph shapes={g} size={13} color={C.navy} strokeWidth={2.2} />
                      <Text style={[{ fontSize: 12, lineHeight: 17, color: C.navy }, weight(600)]}>{w}</Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
            {starting ? null : <Glyph shapes={CHEV} size={18} color={C.navy} strokeWidth={2.4} />}
          </PressableScale>

          <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
            {DAY_AHEAD.map((d, i) => {
              const pendingAhead = dayAheadValues[i] === '—';
              return (
                <View
                  key={d.l}
                  accessible
                  accessibilityLabel={dayAheadValues[i] + ' ' + d.l}
                  style={{ flex: 1, minWidth: 0, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.06)', paddingVertical: 10, paddingHorizontal: 12 }}>
                  {pendingAhead ? null : (
                    <Glyph shapes={AHEAD_GLYPH[i]} size={16} color={i === 1 ? '#FF8A80' : C.onNavyMuted} />
                  )}
                  <Text
                    numberOfLines={1}
                    style={[
                      { fontSize: 20, lineHeight: 25, letterSpacing: -0.4, color: pendingAhead ? C.onNavyMuted : C.onNavy, marginTop: pendingAhead ? 0 : 4 },
                      weight(800),
                      tabular,
                    ]}>
                    {dayAheadValues[i]}
                  </Text>
                  <Text numberOfLines={1} style={[{ fontSize: 11, color: C.onNavyMuted }, weight(400)]}>{d.l}</Text>
                </View>
              );
            })}
          </View>
        </View>
      ) : (
        <View style={{ marginTop: 18 }}>
          {/* ---- where the day stands ----

              The worked time is the number this card exists for, so it is the
              large one; the status, the punch-in time and a second stretch of
              work sit beside it rather than competing with it. Two
              stretches of work is a fact about the day, and this is the only
              place it is visible before payroll asks about it. */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 18 }}>
            {/* Shops, and only when there are some. "0 of 0 done" was printed
                on every unplanned day — a fraction of nothing, read as a
                failure. While the day runs the shops are the ring. */}
            {day.running && day.stops > 0 ? (
              <ShopsRing done={day.stopsDone} of={day.stops} />
            ) : null}
            <View style={{ flex: 1, minWidth: 0 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: day.running ? C.lime : C.onNavyMuted }} />
                <Text style={[{ fontSize: 13, lineHeight: 18, color: day.running ? C.lime : C.onNavyMuted }, weight(700)]}>
                  {(day.running ? 'On the road' : 'Day closed') +
                    (day.running && day.checkedInAt ? ' · since ' + hhmm(day.checkedInAt) : '')}
                </Text>
                {!day.running && day.sessionCount > 1 ? <PunchIns n={day.sessionCount} /> : null}
              </View>
              <Text
                style={[
                  { fontSize: 32, lineHeight: 38, letterSpacing: -1, color: C.onNavy, marginTop: 4 },
                  weight(800),
                  tabular,
                ]}>
                {workedLabel(workedSoFarMs, day.running)}
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 2, flexWrap: 'wrap' }}>
                <Text style={[{ fontSize: 12, lineHeight: 17, color: C.onNavyMuted }, weight(400)]}>
                  {day.running
                    ? 'worked today'
                    : 'worked · ' + (day.stops > 0 ? day.stopsDone + ' of ' + plural(day.stops, 'shop') + ' done' : 'no shops planned today')}
                </Text>
                {day.running && day.sessionCount > 1 ? <PunchIns n={day.sessionCount} /> : null}
              </View>
            </View>
          </View>
          {day.running ? (
            day.stops > 0 ? (
              <Text style={[{ fontSize: 12, lineHeight: 17, color: C.onNavyMuted, marginTop: 8 }, weight(400)]}>
                {day.stopsDone + ' of ' + plural(day.stops, 'shop') + ' done'}
              </Text>
            ) : (
              <Text style={[{ fontSize: 12, lineHeight: 17, color: C.onNavyMuted, marginTop: 8 }, weight(400)]}>No shops planned today.</Text>
            )
          ) : null}

          {/*
            TWO ACTIONS, ONE SHAPE, ONE OF THEM FILLED.

            They used to be two different controls — a pill beside the timer and
            a full-width bar below it, with different corners, heights and type
            sizes — so the card read as two cards. Now they are a pair, and the
            only thing that changes between morning and evening is which one is
            filled. From `mbos.attendance.punchOutPromptHour` it is punching
            out: every forgotten punch-out is a regularisation for the office
            and a day with no closing photo, and the grey outline it used to be
            all day was the quietest control on the screen.

            "Today's route" is NAMED FOR WHERE IT GOES — it opens the list, not
            turn-by-turn, which is what `NavigateButton` two taps away does.
            The camera icon says what pressing Punch out does: the camera
            opens. Ending the day is not destructive — a second punch-in adds a
            stretch rather than replacing the first.
          */}
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
            <DayAction
              icon="route"
              label="Today’s route"
              filled={!punchOutLoud}
              onPress={() => router.push('/journey')}
            />
            <DayAction
              icon="camera"
              label={day.running ? 'Punch out' : 'Punch in again'}
              filled={punchOutLoud}
              tint={!day.running}
              disabled={starting}
              onPress={day.running ? endDay : resumeDay}
            />
          </View>
          {punchOutLoud ? (
            <Text style={[{ fontSize: 12, lineHeight: 17, color: C.onNavyMuted, marginTop: 10, textAlign: 'center' }, weight(400)]}>
              Done for the day? Punch out so your hours count. Takes your photo.
            </Text>
          ) : null}
        </View>
      )}
      </Swap>
    </View>
  );

  return (
    <AppFrame
      title="Home"
      activeTab="home"
      tone="navy"
      showTitle={false}
      heroTop={heroIdentity}
      hero={hero}
      contentStyle={{ paddingHorizontal: 14, paddingTop: 14, paddingBottom: 92, gap: 12 }}>
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
      {unpaidMeter ? (
        <View style={{ backgroundColor: C.warnBg, borderRadius: 22, padding: 16 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: C.surface, alignItems: 'center', justifyContent: 'center' }}>
              <Glyph shapes={GAUGE} size={18} color={C.warnInk} />
            </View>
            <Text
              accessibilityLabel={`${dmy(unpaidMeter.day)}: your vehicle km were not counted`}
              style={[{ flex: 1, fontSize: 15, lineHeight: 20, color: C.ink }, weight(800)]}>
              {`${dmy(unpaidMeter.day)} · vehicle km not counted`}
            </Text>
          </View>
          <Text style={[{ fontSize: 13, lineHeight: 19, color: C.body, marginTop: 8 }, weight(400)]}>
            No punch-out, so the day closed at its opening reading. If the vehicle has not moved, photograph the meter now and those km count. Your manager sees it was added this morning.
          </Text>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={savingLateMeter ? 'Saving' : 'Add the closing reading'}
              accessibilityState={{ busy: savingLateMeter }}
              disabled={savingLateMeter}
              style={({ pressed }) => [pill48, { flex: 1.4, backgroundColor: pressed ? C.primaryDeep : C.primary, opacity: savingLateMeter ? 0.7 : 1 }]}
              onPress={() => {
                /* The ride today starts where yesterday ended, so a reading
                   taken after setting off is not yesterday's. Today's opening
                   reading, where there is one, is the ceiling. */
                void (async () => {
                  if (!userId) return;
                  setSavingLateMeter(true);
                  try {
                    const startOfToday = new Date();
                    startOfToday.setHours(0, 0, 0, 0);
                    const ceiling = await todayOpeningKm(userId, startOfToday.getTime());
                    const shot = await askMeter(
                      {
                        title: `Meter for ${dmy(unpaidMeter.day)}`,
                        subtitle: 'Before you ride today. This becomes that day’s closing reading.',
                        cancelLabel: 'Not now',
                      },
                      unpaidMeter.startKm,
                    );
                    if (!shot) return;
                    const photoId = await queueOdometerPhoto(shot.uri, unpaidMeter.legId);
                    const saved = await addLateClosingReading({
                      legId: unpaidMeter.legId,
                      km: shot.km,
                      photoId,
                      todayOpeningKm: ceiling,
                    });
                    if (!saved.ok) {
                      notify(saved.reason, 'error');
                      return;
                    }
                    setUnpaidMeter(null);
                    notify(`Reading saved. ${dmy(unpaidMeter.day)} will be paid on it.`);
                  } catch {
                    notify('The reading was not saved. Try again.', 'error');
                  } finally {
                    setSavingLateMeter(false);
                  }
                })();
              }}>
              {savingLateMeter ? null : <Glyph shapes={CAMERA} size={16} color={C.onNavy} />}
              <Text numberOfLines={1} style={[{ fontSize: 14, color: C.onNavy }, weight(700)]}>
                {savingLateMeter ? 'Saving…' : 'Add closing reading'}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Leave it at 0 km"
              style={({ pressed }) => [pill48, { flex: 1, backgroundColor: C.surface, opacity: pressed ? 0.85 : 1 }]}
              onPress={() => {
                setUnpaidMeter(null);
                void dismissUnpaidMeterDay().catch(() => {});
              }}>
              <Text numberOfLines={1} style={[{ fontSize: 14, color: C.ink }, weight(700)]}>Leave at 0 km</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {offerSetup ? (
        <PressableScale
          onPress={() => router.push('/tracking-setup?from=home')}
          accessibilityRole="button"
          accessibilityLabel="Keep tracking on. Two phone settings decide if your route is saved. Takes a minute."
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            minHeight: 60,
            paddingHorizontal: 16,
            paddingVertical: 10,
            backgroundColor: C.surface,
            borderRadius: radius.card,
          }}>
          {/* `pin` and not `location`: `Icon` takes `IconName | string` and
              falls back silently on a name it does not have, so a typo here is
              a blank square rather than a compile error. */}
          <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: C.primaryTint, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="pin" size={18} color={C.primaryDeep} strokeWidth={2} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[{ fontSize: 15, lineHeight: 21, color: C.ink }, weight(700)]}>Keep tracking on</Text>
            <Text style={[{ marginTop: 2, fontSize: 12, lineHeight: 16, color: C.muted }, weight(400)]}>
              2 phone settings save your route · 1 min
            </Text>
          </View>
          <Icon name="forward" size={18} color={C.faint} strokeWidth={2} />
        </PressableScale>
      ) : null}

      {/*
        NOTHING HAS COME DOWN FROM THE OFFICE YET, SAID IN WORDS.

        This is the state the zeros hid, and it is permanent rather than a
        frame: a handset whose pull has never landed has no customers, no plan
        and no tasks, so every tile answered nought and the status strip said
        "All sent" over the top of them — because that pip counts the outbox and
        has nothing to say about the inbox. A salesman reads that as a day with
        no work in it and gets on with something else.

        Version 3 draws it ABOVE the tiles it explains.
      */}
      {day && neverPulled ? (
        <Card style={{ borderRadius: 22, flexDirection: 'row', gap: 12 }}>
          <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: C.warnBg, alignItems: 'center', justifyContent: 'center' }}>
            <Glyph shapes={CLOUD_ALERT} size={20} color={C.warnInk} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[{ fontSize: 15, lineHeight: 20, color: C.ink }, weight(800)]}>Your customers have not come yet</Text>
            <Text style={[{ fontSize: 13, lineHeight: 19, color: C.body, marginTop: 4 }, weight(400)]}>
              Nothing has come from the office to this phone yet. That is why these boxes are empty.
              Go where there is signal. Keep MBOS open for a minute. Your customers,
              today&rsquo;s plan and your tasks will all come together.
            </Text>
          </View>
        </Card>
      ) : null}

      {/* ---- what the office has put on this screen ----
          Banners from Admin Console → MBOS control. Below everything about
          starting the day, so an announcement never stands between him and
          punching in; self-contained, so it cannot break what is around it. */}
      <RemoteBanners screen="home" nowMs={now} />

      {/* ---- the six numbers ---- */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {DASH_CARDS.map((d, i) => {
          const figureTone = figuresPending
            ? C.faint
            : d.tone === 'danger'
              ? C.danger
              : d.tone === 'amber'
                ? C.warnInk
                : C.ink;
          const figureStyle = [
                /* The line height does not move with the size, so a tile
                   saying a sentence is exactly as tall as one saying a
                   number and the grid cannot jump. */
                /* A tile's tone belongs to its FIGURE. Left on, the em-dash
                   standing in for a figure nobody has yet read drew in red
                   under "Outstanding" — an alarm about a number that does
                   not exist. */
                {
                  fontSize: dashValues[i].small ? 15 : 22,
                  lineHeight: 28,
                  letterSpacing: dashValues[i].small ? 0 : -0.4,
                  marginTop: 6,
                  color: figureTone,
                },
                weight(800),
                tabular,
              ];
          const figure = dashValues[i];
          /* The sub-line is red where it is a count of something late —
             overdue tasks, missed follow-ups — and quiet otherwise. */
          const subLate = !figuresPending && /overdue|missed/.test(figure.s) && !/^None/.test(figure.s);
          return (
          <PressableScale
            key={d.l}
            disabled={!d.route}
            accessibilityRole={d.route ? 'button' : undefined}
            accessibilityLabel={`${d.l}: ${figure.v}, ${figure.s}`}
            onPress={() => d.route && router.push(`/${d.route}${d.route.includes('?') ? '&' : '?'}from=home`)}
            outerStyle={{ width: '48%', flexGrow: 1 }}
            style={{
              padding: 14,
              minHeight: 96,
              borderRadius: radius.card,
              backgroundColor: C.surface,
            }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              {figuresPending ? null : <Glyph shapes={TILE_GLYPH[i]} size={16} color={TILE_INK[i]} />}
              <Text numberOfLines={1} style={[{ flex: 1, fontSize: 12, color: C.muted }, weight(600)]}>{d.l}</Text>
            </View>
            {/* A real figure counts to its new value when it MOVES — an order
                taken, a collection made — and simply stands there the first
                time it is drawn: `CountUp` mounts with the read, not before
                it, and a figure that is not news should not perform. */}
            {figure.n != null && figure.fmt ? (
              <CountUp value={figure.n} format={figure.fmt} numberOfLines={1} style={figureStyle} />
            ) : (
              <Text numberOfLines={1} style={figureStyle}>
                {figure.v}
              </Text>
            )}
            <Text
              numberOfLines={1}
              style={[{ fontSize: 12, color: figuresPending ? C.faint : subLate ? C.danger : C.muted }, weight(subLate ? 600 : 400)]}>
              {figure.s}
            </Text>
          </PressableScale>
          );
        })}
      </View>

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
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 8, paddingHorizontal: 6 }}>
        <Text accessibilityRole="header" accessibilityLabel="Your leads" style={[{ flex: 1, fontSize: 17, lineHeight: 22, color: C.ink }, weight(800)]}>
          Leads
        </Text>
        <Pressable onPress={() => router.push('/lead-actions?from=home')} accessibilityRole="button" hitSlop={12}>
          <Text style={[{ fontSize: 13, lineHeight: 18, color: C.primaryDeep }, weight(600)]}>Pending actions ›</Text>
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
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {([
          /* My leads is the BOOK and not a cut of it, so it opens the book —
             the same list the Customers tab and the More screen already show.
             Pointing it at a view of the worklist would have been tidier and
             would answer a different question to the one its own label asks. */
          { l: 'My leads', v: leads?.counts.working, href: '/leads?from=home', tone: C.ink, glyph: PERSON, glyphInk: C.primaryDeep },
          { l: 'Overdue', v: leads?.counts.overdue, href: '/lead-actions?view=overdue&from=home', tone: C.danger, glyph: WARN, glyphInk: C.danger },
          { l: 'Due today', v: leads?.counts.today, href: '/lead-actions?view=today&from=home', tone: C.ink, glyph: CAL, glyphInk: C.ink },
        ] as const).map((stat) => {
          const known = !leadsPending && stat.v !== undefined;
          const hot = known && stat.v! > 0 && stat.tone === C.danger;
          return (
            <PressableScale
              key={stat.l}
              onPress={() => router.push(stat.href)}
              accessibilityRole="button"
              accessibilityLabel={`${stat.l}: ${known ? stat.v : 'not known yet'}`}
              outerStyle={{ flex: 1 }}
              style={{
                minHeight: 64,
                borderRadius: radius.card,
                backgroundColor: hot ? C.dangerBg : C.surface,
                alignItems: 'center',
                justifyContent: 'center',
                paddingVertical: 8,
              }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {known ? <Glyph shapes={stat.glyph} size={14} color={stat.v! > 0 ? stat.glyphInk : C.faint} strokeWidth={2.2} /> : null}
                {!known ? (
                  <Text style={[{ fontSize: 20, lineHeight: 25, color: C.faint }, weight(800), tabular]}>—</Text>
                ) : (
                  <CountUp
                    value={stat.v!}
                    format={whole}
                    style={[
                      { fontSize: 20, lineHeight: 25, color: stat.v! > 0 ? stat.tone : C.ink },
                      weight(800),
                      tabular,
                    ]}
                  />
                )}
              </View>
              <Text style={[{ fontSize: 12, lineHeight: 17, color: hot ? C.danger : C.muted }, weight(400)]}>{stat.l}</Text>
            </PressableScale>
          );
        })}
      </View>

      {/*
        AND THE SIX CARDS UNDER THEM.

        An empty list here says WHICH emptiness it is. "Nothing owed today" is
        a good morning; "your book has not arrived" is a support call; and a
        read that failed is a phone to restart. Drawn alike they are the state
        nobody debugs, because two of the three look like having no work.
      */}
      {readErr ? (
        <EmptyLine text="Did not load on this phone." />
      ) : !leads ? (
        <EmptyLine text="Loading…" />
      ) : neverPulled ? null /* the card above already says it, in full */ : leads.counts.working === 0 ? (
        <EmptyLine text="No open leads. Add a new shop you see as a lead." />
      ) : leads.dueToday.length === 0 ? (
        <EmptyLine
          good
          text={
            leads.counts.overdue
              ? 'Nothing pending today. ' + plural(leads.counts.overdue, 'lead') + ' overdue.'
              : 'No lead actions pending today.'
          }
        />
      ) : (
        <View style={{ gap: 12 }}>
          {leads.dueToday.map((lead, i) => (
            <Stagger key={lead.id} index={i}>
              <LeadActionCard lead={lead} meId={userId} from="home" />
            </Stagger>
          ))}
          {/* A capped list says what it is a slice of. Six cards over a due
              count of nineteen with nothing saying so is a screen quietly
              losing thirteen shops. */}
          {leads.counts.today > leads.dueToday.length ? (
            <Pressable
              onPress={() => router.push('/lead-actions?view=today&from=home')}
              accessibilityRole="button"
              accessibilityLabel={'Showing ' + leads.dueToday.length + ' of ' + leads.counts.today + '. Tap to see all.'}
              style={({ pressed }) => ({ minHeight: 44, borderRadius: 22, backgroundColor: C.surface, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.85 : 1 })}>
              <Text style={[{ fontSize: 13, lineHeight: 18, color: C.primaryDeep }, weight(700)]}>
                {leads.dueToday.length + ' of ' + leads.counts.today + ' shown · See all ›'}
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
      <PressableScale
        onPress={() => router.push('/performance?from=home')}
        accessibilityRole="button"
        accessibilityLabel="Your target. Tap to see more.">
        {readErr ? (
          /* The read failed, and "the office has not set one" would be a
             claim about the office rather than about this phone. */
          <TargetQuiet title="Your target" sub="Did not load on this phone." />
        ) : month === undefined ? (
          <TargetQuiet title="Your target" sub="Loading…" />
        ) : month === null || !month.hasTarget ? (
          <TargetQuiet
            title="No target set yet"
            sub="Today’s orders, visits and collections are above."
            long="The office has not set a target yet. Today’s orders, visits and collections are in the boxes above."
          />
        ) : (
          <Card style={{ borderRadius: 22 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Glyph shapes={TARGET} size={18} color={C.primaryDeep} />
              <Text style={[{ flex: 1, fontSize: 13, lineHeight: 18, color: C.muted }, weight(700)]}>Your target</Text>
              {month.rating ? <Badge tone="teal">{month.rating}</Badge> : null}
            </View>
            {/* Revenue and volume together, never revenue alone. A price
                revision moves the first and cannot move the second, so a
                month at target on rupees and short on litres is a month that
                sold LESS and billed more — and it is exactly the month
                somebody would otherwise be congratulated for. The score is
                the office's and is printed, never recomputed here. */}
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 8 }}>
              {/* The office recomputes this hourly; when it has moved since
                  the last look it counts there, which is the only way a
                  64 becoming 72 reads as progress rather than as a number. */}
              {month.totalScoreBp == null ? (
                <Text style={[{ fontSize: 34, lineHeight: 40, color: C.ink }, weight(800), tabular]}>—</Text>
              ) : (
                <CountUp
                  value={month.totalScoreBp / 100}
                  format={(x) => x.toFixed(1)}
                  style={[{ fontSize: 34, lineHeight: 40, letterSpacing: -0.7, color: C.ink }, weight(800), tabular]}
                />
              )}
              <Text accessibilityLabel="out of 100" style={[{ fontSize: 14, lineHeight: 20, color: C.muted }, weight(400)]}>/ 100</Text>
            </View>
            {month.totalScoreBp != null ? (
              <View style={{ height: 8, borderRadius: 4, backgroundColor: C.hairline, marginTop: 8, overflow: 'hidden' }}>
                <View
                  style={{
                    width: `${Math.max(0, Math.min(100, month.totalScoreBp / 100))}%`,
                    height: 8,
                    borderRadius: 4,
                    backgroundColor: C.primary,
                  }}
                />
              </View>
            ) : null}
            <Text style={[{ fontSize: 14, lineHeight: 20, color: C.body, marginTop: 10 }, weight(400)]}>
              {shortfalls(month)[0] ?? 'You have reached every target set for you.'}
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
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}>
              <Glyph shapes={CLOCK} size={13} color={C.muted} />
              <Text numberOfLines={1} style={[{ flex: 1, fontSize: 12, color: C.muted }, weight(400)]}>
                {monthLabel(month.period) + (month.computedAt ? ' · as at ' + asAt(month.computedAt) : '')}
              </Text>
              <Text style={[{ fontSize: 12, lineHeight: 17, color: C.muted }, weight(400)]}>More ›</Text>
            </View>
          </Card>
        )}
      </PressableScale>

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
      <NotificationsPrompt />

      <BottomSheet
        open={modeOpen}
        onClose={() => {
          setModeOpen(false);
          answerMode.current?.(null);
          answerMode.current = null;
        }}>
        <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 20 }}>
          <T style={[{ fontSize: 20, lineHeight: 26, color: C.ink }, weight(800)]}>
            How are you travelling today?
          </T>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
            <Glyph shapes={TICK} size={14} color={C.muted} />
            <T style={{ flex: 1, fontSize: 13, lineHeight: 18, color: C.muted }}>
              Asked once for this punch-in, not at each shop
            </T>
          </View>

          <TravelModeList
            modes={dayModes}
            where="day"
            onPick={(m) => {
              setModeOpen(false);
              answerMode.current?.(m);
              answerMode.current = null;
            }}
          />

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Not punching in yet"
            onPress={() => {
              setModeOpen(false);
              answerMode.current?.(null);
              answerMode.current = null;
            }}
            style={({ pressed }) => [pill56, { marginTop: 14, backgroundColor: C.canvas, opacity: pressed ? 0.85 : 1 }]}>
            <T style={[{ fontSize: 15, lineHeight: 21, color: C.ink }, weight(700)]}>Not punching in yet</T>
          </Pressable>
        </View>
      </BottomSheet>

      {/* ─────────────────────────── after the punch-out: raise the day's costs */}
      <BottomSheet open={!!claimPrompt} onClose={() => setClaimPrompt(null)}>
        <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 20 }}>
          <T style={[{ fontSize: 20, lineHeight: 26, color: C.ink }, weight(800)]}>
            Add today&apos;s expenses
          </T>
          <View
            accessible
            accessibilityLabel={
              (claimPrompt?.modeLabel ? `You travelled by ${claimPrompt.modeLabel.toLowerCase()} today. ` : '') +
              'Your meal and kilometre allowances are worked out for you. Fares, hotel, food bills and other costs are paid only if you add them, with a photo or PDF of each bill.'
            }
            style={{ gap: 10, marginTop: 14 }}>
            {claimPrompt?.modeLabel ? (
              <ClaimLine glyph={BUS} bg={C.canvas} ink={C.ink}>
                {`You travelled by ${claimPrompt.modeLabel.toLowerCase()} today`}
              </ClaimLine>
            ) : null}
            <ClaimLine glyph={TICK} bg={C.successBg} ink={C.success}>
              Meal and km allowances are worked out for you
            </ClaimLine>
            <ClaimLine glyph={RECEIPT} bg={C.warnBg} ink={C.warnInk}>
              Fares, hotel, food bills and other costs: paid only if you add them, with a photo or PDF of each bill
            </ClaimLine>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add expenses"
            onPress={() => {
              setClaimPrompt(null);
              router.push({ pathname: '/expenses', params: { add: '1' } });
            }}
            style={({ pressed }) => [pill56, { marginTop: 18, minHeight: 60, borderRadius: 30, backgroundColor: C.navy, flexDirection: 'row', gap: 8, opacity: pressed ? 0.9 : 1 }]}>
            <Glyph shapes={PLUS} size={18} color={C.lime} strokeWidth={2.4} />
            <T style={[{ fontSize: 17, lineHeight: 24, color: C.onNavy }, weight(700)]}>Add expenses</T>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Later"
            onPress={() => setClaimPrompt(null)}
            style={({ pressed }) => [pill56, { marginTop: 10, minHeight: 52, borderRadius: 26, backgroundColor: C.canvas, opacity: pressed ? 0.85 : 1 }]}>
            <T style={[{ fontSize: 15, lineHeight: 21, color: C.ink }, weight(700)]}>Later</T>
          </Pressable>
        </View>
      </BottomSheet>

      <OdometerCamera
        open={metering}
        title={meterWords.title}
        subtitle={meterWords.subtitle}
        cancelLabel={meterWords.cancelLabel}
        previousKm={meterFrom}
        maxLegKilometres={maxLegKm}
        /* Home only ever reads the meter at the two ends of the day. */
        span="day"
        onDone={(result) => {
          setMetering(false);
          answerMeter.current?.(result);
          answerMeter.current = null;
        }}
      />
    </AppFrame>
  );
}

/* ------------------------------------------------------------ the pieces */

const PLAY: GlyphShape[] = [{ p: 'M8 5l11 7-11 7z' }];
const CAMERA: GlyphShape[] = [{ p: 'M4 8h3l2-3h6l2 3h3v11H4z' }, { c: [12, 13, 3.5] }];
const TICK: GlyphShape[] = [{ p: 'M5 12l5 5 9-10' }];
const CLOCK: GlyphShape[] = [{ c: [12, 12, 8] }, { p: 'M12 8v4l3 2' }];
const CHEV: GlyphShape[] = [{ p: 'M9 5l7 7-7 7' }];
const PLUS: GlyphShape[] = [{ p: 'M12 5v14M5 12h14' }];
const GAUGE: GlyphShape[] = [{ p: 'M4 16a8 8 0 1 1 16 0' }, { p: 'M12 16l4-5' }];
const CLOUD_ALERT: GlyphShape[] = [{ p: 'M7 18a5 5 0 1 1 1-9.9A6 6 0 0 1 19 10a4 4 0 0 1-1 8z' }, { p: 'M12 10v5M12 17h.01' }];
const PERSON: GlyphShape[] = [{ c: [12, 8, 4] }, { p: 'M4 21c0-4 4-6 8-6s8 2 8 6' }];
const WARN: GlyphShape[] = [{ p: 'M12 4l9 16H3z' }, { p: 'M12 10v4M12 17h.01' }];
const CAL: GlyphShape[] = [{ r: [4, 5, 16, 15, 2] }, { p: 'M4 10h16M9 3v4M15 3v4' }];
const TARGET: GlyphShape[] = [{ c: [12, 12, 8] }, { c: [12, 12, 3] }];
const BUS: GlyphShape[] = [{ r: [5, 3, 14, 15, 2] }, { p: 'M5 11h14M8 21l1-3M16 21l-1-3' }];
const RECEIPT: GlyphShape[] = [{ p: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6' }];
const ROUTE: GlyphShape[] = [{ c: [6, 18, 2] }, { c: [18, 6, 2] }, { p: 'M8 18h6a4 4 0 0 0 0-8h-4a4 4 0 0 1 0-8h6' }];
const WALLET: GlyphShape[] = [{ r: [3, 6, 18, 13, 2] }, { p: 'M3 10h18M16 14h2' }];

/** The day-ahead strip's marks, in `DAY_AHEAD` order: stops, outstanding, follow-ups. */
const AHEAD_GLYPH: GlyphShape[][] = [ROUTE, WALLET, CAL];

/** The six tiles' marks and their colours, in `DASH_CARDS` order. */
const TILE_GLYPH: GlyphShape[][] = [
  [{ p: 'M4 5h2l2 11h10l2-8H7' }, { c: [10, 20, 1] }, { c: [17, 20, 1] }],
  [{ p: 'M4 10l2-5h12l2 5M4 10v10h16V10M4 10h16M10 20v-5h4v5' }],
  WALLET,
  [{ r: [3, 7, 18, 11, 2] }, { c: [12, 12.5, 2.5] }],
  [{ r: [4, 4, 16, 17, 2] }, { p: 'M8 10l2 2 4-4M8 16h8' }],
  [{ p: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2' }],
];
const TILE_INK = [C.ink, C.ink, C.danger, C.warnInk, C.warnInk, C.ink];

const pill48 = {
  minHeight: 48,
  borderRadius: 24,
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  gap: 6,
  paddingHorizontal: 10,
};

const pill56 = {
  minHeight: 56,
  borderRadius: 28,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  paddingHorizontal: 12,
};

/** The planned shops as a ring in the hero — done over planned, in lime. */
function ShopsRing({ done, of }: { done: number; of: number }) {
  const r = 38;
  const length = 2 * Math.PI * r;
  const share = of > 0 ? Math.min(1, done / of) : 0;
  return (
    <View accessible accessibilityLabel={`${done} of ${plural(of, 'shop')} done`} style={{ width: 84, height: 84 }}>
      <Svg width={84} height={84} viewBox="0 0 92 92">
        <SvgCircle cx={46} cy={46} r={r} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth={9} />
        <SvgCircle
          cx={46}
          cy={46}
          r={r}
          fill="none"
          stroke={C.lime}
          strokeWidth={9}
          strokeLinecap="round"
          strokeDasharray={`${share * length} ${length}`}
          transform="rotate(-90 46 46)"
        />
      </Svg>
      <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={[{ fontSize: 22, lineHeight: 29, color: C.onNavy }, weight(800), tabular]}>{`${done}/${of}`}</Text>
      </View>
    </View>
  );
}

function PunchIns({ n }: { n: number }) {
  return (
    <View style={{ minHeight: 22, paddingVertical: 3, paddingHorizontal: 8, borderRadius: 11, backgroundColor: 'rgba(255,255,255,0.10)', justifyContent: 'center' }}>
      <Text style={[{ fontSize: 12, lineHeight: 17, color: C.onNavy }, weight(700)]}>{plural(n, 'punch-in')}</Text>
    </View>
  );
}

/** A one-line empty state under the lead figures. `good` is a morning with nothing owed. */
function EmptyLine({ text, good = false }: { text: string; good?: boolean }) {
  return (
    <View style={{ backgroundColor: C.surface, borderRadius: radius.card, paddingVertical: 14, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      {good ? <Glyph shapes={TICK} size={16} color={C.success} strokeWidth={2.2} /> : null}
      <Text style={[{ flex: 1, fontSize: 14, lineHeight: 20, color: C.muted }, weight(400)]}>{text}</Text>
    </View>
  );
}

/** The target card where there is no score to draw. */
function TargetQuiet({ title, sub, long }: { title: string; sub: string; long?: string }) {
  return (
    <View
      accessible
      accessibilityLabel={long ?? `${title}. ${sub}`}
      style={{ backgroundColor: C.surface, borderRadius: 22, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: C.hairline, alignItems: 'center', justifyContent: 'center' }}>
        <Glyph shapes={TARGET} size={18} color={C.faint} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[{ fontSize: 15, lineHeight: 21, color: C.ink }, weight(700)]}>{title}</Text>
        <Text style={[{ marginTop: 2, fontSize: 12, lineHeight: 16, color: C.muted }, weight(400)]}>{sub}</Text>
      </View>
    </View>
  );
}

function ClaimLine({ glyph, bg, ink, children }: { glyph: GlyphShape[]; bg: string; ink: string; children: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
        <Glyph shapes={glyph} size={18} color={ink} />
      </View>
      <T style={{ flex: 1, fontSize: 14, lineHeight: 20, color: C.body }}>{children}</T>
    </View>
  );
}
