import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { color as C, HIT, radius, shadow, type, weight, tabular } from '../src/theme/tokens';
import { Icon } from '../src/components/ui/Icon';
import { Card } from '../src/components/ui/primitives';
import { AppFrame } from '../src/components/shell/AppFrame';
import { useStore } from '../src/state/store';
import { useBoot } from '../src/state/boot';
import { compactInr, inr, isoDate, plural } from '../src/lib/format';
import { DASH_CARDS, DAY_AHEAD } from '../src/data/fixtures';
import { checkIn, checkOut, dayState, durationLabel, setOverrideReason, todayRow } from '../src/data/attendance';
import { collectionDue } from '../src/data/customers';
import { getConfig } from '../src/data/config';
import { ordersToday } from '../src/data/orders';
import { cashInHand } from '../src/data/payments';
import { bucketOf, listOpenTasks } from '../src/data/tasks';
import { followUpCounts, visitsToday } from '../src/data/visits';
import { stopCounts } from '../src/data/journey';
import { withinGeofence } from '../src/engines/geo';
import { fixOf, getFix } from '../src/native/location';
import { takePhoto } from '../src/native/capture';

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
  const [starting, setStarting] = React.useState(false);

  /* The clock is read once per mount and ticked, never during render. */
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
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
    ]).then(([stops, due, follow, orders, visits, cash, tasks, attendance, state]) => {
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
      v: day.orderValueUnknown ? 'Not known yet' : inr(day.orderValuePaise / 100),
      s: plural(day.orders, 'order'),
    },
    { v: `${day.visits} of ${day.stops}`, s: day.stops ? 'On the plan' : 'No plan today' },
    { v: inr(day.collectPaise / 100), s: plural(day.collectCustomers, 'customer') },
    { v: inr(day.cashPaise / 100), s: day.cashSentence || 'Nothing to deposit' },
    { v: String(day.tasks), s: day.tasksOverdue ? plural(day.tasksOverdue, 'overdue') : 'None overdue' },
    { v: String(day.followUps), s: `${day.followUpsToday} today` },
  ];

  const dayAheadValues = [
    String(day.stops),
    compactInr(day.collectPaise / 100),
    String(day.followUpsToday),
  ];

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

      const fix = fixOf(await getFix({ accuracyThresholdM: threshold }));
      const selfie = await takePhoto({ parentType: 'attendance', parentId: 'pending', kind: 'selfie' });

      const row = await checkIn({
        userId,
        fix,
        selfieMediaId: selfie.ok ? selfie.mediaId : null,
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
      const fix = fixOf(await getFix({ accuracyThresholdM: threshold }));
      const out = await checkOut(userId, fix);
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
      const fix = fixOf(await getFix({ accuracyThresholdM: threshold }));
      await checkIn({ userId, fix, selfieMediaId: null, homeLocation: null });
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
                Marks attendance, locks GPS, starts the timer
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
                {durationLabel(day.workedMinutes) + ' · ' + day.stopsDone + ' of ' + day.stops + ' done'}
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
            <Icon name={day.running ? 'clock' : 'play'} size={18} color={day.running ? C.body : C.primaryDeep} />
            <Text style={[{ fontSize: 15, color: day.running ? C.body : C.primaryDeep }, weight(500)]}>
              {day.running ? 'End day' : 'Start again'}
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
              onPress={() => notify(d.l + ' — opens the list behind this number')}
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

          The office computes targets and sends none, so this panel used to
          render a fixture: ₹18,42,000 of ₹26,00,000, a progress bar and 71%,
          with "These figures are not live yet" in grey underneath. A number
          with a bar under it is read as fact at a glance and the caption is
          not read at all — and this is the first screen after sign-in. It says
          what it knows instead, which is nothing. */}
      <Card style={{ marginTop: 12, padding: 14 }}>
        <Text style={type.label}>Your target</Text>
        <Text style={{ fontSize: 14, lineHeight: 20, color: C.muted, marginTop: 6 }}>
          The office has not set one. Today&rsquo;s orders, visits and collections are in the six figures above.
        </Text>
      </Card>
    </AppFrame>
  );
}
