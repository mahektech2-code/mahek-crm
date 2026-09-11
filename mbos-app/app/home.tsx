import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { color as C, HIT, radius, shadow, type, weight, tabular } from '../src/theme/tokens';
import { Icon } from '../src/components/ui/Icon';
import { Card } from '../src/components/ui/primitives';
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
import { ordersToday } from '../src/data/orders';
import { cashInHand } from '../src/data/payments';
import { bucketOf, listOpenTasks } from '../src/data/tasks';
import { followUpCounts, visitsToday } from '../src/data/visits';
import { stopCounts } from '../src/data/journey';
import { withinGeofence } from '../src/engines/geo';
import { fixOf, getFix } from '../src/native/location';
import { ensureLocationPermission } from '../src/native/permissions';
import { queueSelfie } from '../src/native/capture';
import { SelfieCamera, type SelfieResult } from '../src/components/ui/selfie-camera';

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

export default function Home() {
  const boot = useBoot();
  const userId = boot.session?.user.id ?? null;
  const set = useStore((s) => s.set);
  const notify = useStore((s) => s.notify);
  const askConfirm = useStore((s) => s.askConfirm);

  const [day, setDay] = React.useState<Day>(EMPTY);
  /* `undefined` is still reading, `null` is read and there is nothing. Two
     different sentences, and collapsing them shows "no target" for a frame to
     somebody who has one. */
  const [month, setMonth] = React.useState<PerformanceMonth | null | undefined>(undefined);
  const [starting, setStarting] = React.useState(false);

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
  const now = useTicker(day.running ? 1000 : 60_000);
  const workedSoFarMs = workedMs(day.sessions, now);

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
  React.useEffect(() => {
    void ensureLocationPermission();
  }, []);


  const load = React.useCallback(() => {
    if (!userId) return;
    const iso = isoDate(new Date());
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
    ]).then(([stops, due, follow, orders, visits, cash, tasks, attendance, state, months]) => {
      setMonth(months[0] ?? null);
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
    });
  }, [userId]);

  useFocusEffect(load);

  const checkedIn = day.sessionCount > 0;

  const today = new Date(now);
  const dateLine = `${WEEKDAYS[today.getDay()]}, ${today.getDate()} ${MONTHS[today.getMonth()]}`;

  /* The six figures, labelled by the design and valued by the store. */
  const dashValues: { v: string; s: string }[] = [
    {
      v: day.orderValueUnknown ? 'Not known yet' : inrFromPaise(day.orderValuePaise),
      s: plural(day.orders, 'order'),
    },
    { v: `${day.visits} of ${day.stops}`, s: day.stops ? 'On the plan' : 'No plan today' },
    { v: inrFromPaise(day.collectPaise), s: plural(day.collectCustomers, 'customer') },
    { v: inrFromPaise(day.cashPaise), s: day.cashSentence || 'Nothing to deposit' },
    { v: String(day.tasks), s: day.tasksOverdue ? plural(day.tasksOverdue, 'overdue') : 'None overdue' },
    { v: String(day.followUps), s: `${day.followUpsToday} today` },
  ];

  const dayAheadValues = [
    String(day.stops),
    compactInrFromPaise(day.collectPaise),
    String(day.followUpsToday),
  ];

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
    title: 'Start your day',
    subtitle: 'A photo of you goes with the check-in.',
    cancelLabel: 'Cancel the check-in',
  });
  const answerSelfie = React.useRef<((r: SelfieResult) => void) | null>(null);

  const askSelfie = (words: typeof selfieWords) =>
    new Promise<SelfieResult>((resolve) => {
      setSelfieWords(words);
      answerSelfie.current = resolve;
      setSelfieOpen(true);
    });

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
   * Check-in is NEVER blocked. Outside the radius the day starts all the same
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
        title: 'Start your day',
        subtitle: 'A photo of you goes with the check-in.',
        cancelLabel: 'Cancel the check-in',
      });
      if (!selfie.ok) {
        /* Nothing has been written, so there is nothing to undo. The fix is
           abandoned with it — a location for a check-in that did not happen is
           a record of somewhere somebody stood while nothing happened. */
        if (selfie.why) notify(selfie.why);
        return;
      }

      const fix = fixOf(await fixing);

      const row = await checkIn({
        userId,
        fix,
        selfieMediaId: selfie.id,
        homeLocation: base,
      });

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
        title: 'Close your day',
        subtitle: 'A photo of you goes with the check-out.',
        cancelLabel: 'Stay on the clock',
      });
      if (!selfie.ok) {
        if (selfie.why) notify(selfie.why);
        return;
      }

      const fix = fixOf(await fixing);
      const out = await checkOut(userId, fix, selfie.id);
      load();
      notify(
        out.ok
          ? `Day closed · ${durationLabel(out.workedMinutes)} worked`
          : (out.reason ?? 'The day was already closed.'),
      );
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
      const threshold = await getConfig<number>('mbos.location.gpsAccuracyThresholdM', 100);
      const fixing = getFix({ accuracyThresholdM: threshold });

      /* This passed `selfieMediaId: null`, so the second and third check-ins
         of a day went unphotographed — a hole exactly where the record is
         least verifiable, since nobody watches an afternoon session begin. It
         is the same mandatory photograph as the morning's, because they are
         the same act. */
      const selfie = await captureSelfie({
        title: 'Back on the clock',
        subtitle: 'A photo of you goes with every check-in.',
        cancelLabel: 'Stay off the clock',
      });
      if (!selfie.ok) {
        if (selfie.why) notify(selfie.why);
        return;
      }

      const fix = fixOf(await fixing);
      await checkIn({ userId, fix, selfieMediaId: selfie.id, homeLocation: null });
      set({ gps: fix ? 'locked' : 'off' });
      load();
      notify('Back on the clock');
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
          <Text style={{ fontSize: 13, color: C.muted }}>{dateLine}</Text>
        </View>
      </View>

      {/* ---- start the day, or what is left of it ---- */}
      {!checkedIn ? (
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
                {starting ? 'Starting…' : 'Start day'}
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
            <Pressable
              onPress={() => router.push('/journey')}
              style={{ height: HIT, paddingHorizontal: 16, borderRadius: radius.xl, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={[{ fontSize: 15, color: '#FFFFFF' }, weight(500)]}>Navigate</Text>
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
              {day.running ? 'End day · photo' : 'Start again · photo'}
            </Text>
          </Pressable>
        </Card>
      )}

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
                  { fontSize: 20, lineHeight: 26, marginVertical: 2, color: d.tone === 'danger' ? C.danger : d.tone === 'amber' ? C.warnInk : C.ink },
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
          {month === undefined ? (
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
              <Text style={[type.caption, { marginTop: 4 }]}>
                {'As the office scored it' + (month.computedAt ? ' · tap for the rest' : '')}
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
    </AppFrame>
  );
}
