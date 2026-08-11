import React from 'react';
import { View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Card, DashedButton, ListCard, T } from '../src/components/ui/primitives';
import { recentDays, sessionsOf, todayRow, workedMinutes, type AttendanceDay } from '../src/data/attendance';
import { useStore } from '../src/state/store';
import { useBoot } from '../src/state/boot';
import { dmy } from '../src/lib/format';
import { color as C, radius, weight, tabular, type BadgeTone } from '../src/theme/tokens';

/**
 * Attendance — what the app recorded, and the one way to argue with it.
 *
 * The list is deliberately read-only. A day recorded wrong is a request to a
 * manager with a reason attached, never an edit made here: the whole point of
 * the record is that the person it describes cannot quietly change it.
 */

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function hhmm(ms: number | null): string {
  if (ms == null) return '—';
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/** 5h 48m. Minutes are what the row stores; hours are what a person reads. */
function hoursLabel(minutes: number | null): string {
  if (minutes == null) return '';
  return Math.floor(minutes / 60) + 'h ' + String(minutes % 60).padStart(2, '0') + 'm';
}

export default function AttendanceScreen() {
  const back = useCameFrom('more');
  const askConfirm = useStore((s) => s.askConfirm);
  const notify = useStore((s) => s.notify);
  const boot = useBoot();
  const userId = boot.session?.user.id ?? null;

  const [days, setDays] = React.useState<AttendanceDay[]>([]);
  const [today, setToday] = React.useState<AttendanceDay | null>(null);
  /* Read in an interval rather than during render — a render that reads the
     clock answers differently every time React happens to re-run it. */
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  useFocusEffect(
    React.useCallback(() => {
      let live = true;
      if (!userId) return;
      void Promise.all([recentDays(userId), todayRow(userId)]).then(([rows, t]) => {
        if (!live) return;
        setDays(rows);
        setToday(t);
      });
      return () => {
        live = false;
      };
    }, [userId]),
  );

  /* The clock ticks while he is on the road, so "so far" counts against now
     rather than the last write — and it SUMS the sessions, because the day may
     be two or three stretches with gaps that are not work. */
  const todaySessions = sessionsOf(today);
  const workedSoFar = todaySessions.length ? workedMinutes(todaySessions, now) : null;

  const present = days.filter((d) => d.status === 'Present').length;
  const onLeave = days.filter((d) => d.status === 'On Leave').length;
  const overrides = days.filter((d) => d.fieldVisitOverride === 1).length;

  const stats: { l: string; v: string; s: string; tone?: 'amber' }[] = [
    { l: 'Present', v: String(present), s: 'of ' + days.length + ' working days' },
    { l: 'Away from base', v: String(overrides), s: 'Field visit', tone: 'amber' },
    { l: 'On leave', v: String(onLeave), s: 'Approved' },
  ];

  return (
    <AppFrame title="MBOS" activeTab={null} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />
      <T s="h1">Attendance</T>

      <Card style={{ marginTop: 12 }}>
        <T s="label">Today</T>
        <T s="h3" style={{ marginTop: 4 }}>
          {today?.checkInAt != null ? 'Checked in ' + hhmm(today.checkInAt) : 'Not checked in'}
        </T>
        <T s="small" style={{ color: C.muted, marginTop: 2 }}>
          {workedSoFar != null ? hoursLabel(workedSoFar) + ' so far' : 'Start the day from Home.'}
        </T>

        {/*
          Each stretch of work, named. A day is not one check-in and one
          check-out — there is lunch, and there are evening calls — and the
          hours are the SUM of these, never the last time minus the first.
        */}
        {todaySessions.length > 0 ? (
          <View style={{ marginTop: 10, borderTopWidth: 1, borderTopColor: C.wash, paddingTop: 8 }}>
            {todaySessions.map((x, i) => (
              <View key={i} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4 }}>
                <T s="caption">{'Session ' + (i + 1)}</T>
                <T style={[{ fontSize: 14, color: x.outAt == null ? C.primaryDeep : C.body }, tabular]}>
                  {hhmm(x.inAt) + ' – ' + (x.outAt == null ? 'running' : hhmm(x.outAt))}
                </T>
              </View>
            ))}
          </View>
        ) : null}
      </Card>

      <Card padded={false} style={{ marginTop: 12, flexDirection: 'row' }}>
        {stats.map((x) => (
          <View key={x.l} style={{ flex: 1, minWidth: 0, padding: 14 }}>
            <T s="label">{x.l}</T>
            <T
              style={[
                { fontSize: 22, lineHeight: 28, marginVertical: 2, color: x.tone === 'amber' ? C.warnInk : C.ink },
                weight(600),
                tabular,
              ]}>
              {x.v}
            </T>
            <T s="micro">{x.s}</T>
          </View>
        ))}
      </Card>

      <ListCard style={{ marginTop: 12 }}>
        {days.map((d, i) => {
          const state = d.status ?? 'Absent';
          const isPresent = state === 'Present' || state === 'Half Day';
          /* An override is not lateness — it is a day that started away from
             base, which is what a field salesman's day usually is. */
          const flagged = d.fieldVisitOverride === 1;
          const tone: BadgeTone = isPresent
            ? flagged
              ? 'amber'
              : 'success'
            : state === 'On Leave'
              ? 'info'
              : 'neutral';
          return (
            <View
              key={d.id}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                paddingHorizontal: 16,
                paddingVertical: 12,
                borderTopWidth: i ? 1 : 0,
                borderTopColor: C.wash,
              }}>
              <View style={{ width: 58 }}>
                <T style={[{ fontSize: 15, lineHeight: 20, color: C.ink }, weight(500)]}>{dmy(d.day)}</T>
                <T s="micro">{DAY_NAMES[new Date(d.day + 'T00:00:00').getDay()]}</T>
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <T style={[{ fontSize: 15, lineHeight: 20, color: C.ink }, tabular]}>
                  {isPresent ? hhmm(d.checkInAt) + ' – ' + hhmm(d.checkOutAt) : '—'}
                </T>
                <T s="caption">
                  {isPresent
                    ? hoursLabel(d.workedMinutes) + (sessionsOf(d).length > 1 ? ` · ${sessionsOf(d).length} sessions` : '')
                    : state}
                </T>
              </View>
              <Badge tone={tone}>{flagged && isPresent ? 'Field' : state}</Badge>
            </View>
          );
        })}
      </ListCard>

      <DashedButton
        label="A day recorded wrong? Ask your manager to correct it."
        style={{ marginTop: 12, borderRadius: radius.xl }}
        onPress={() =>
          askConfirm({
            title: 'Ask for a correction?',
            body: 'Your manager sees the day, what the app recorded, and your reason. Nothing changes until they approve it.',
            reasonLabel: 'What happened · required',
            confirmLabel: 'Send to manager',
            run: (r) => notify('Correction sent · ' + r),
          })
        }
      />
    </AppFrame>
  );
}
