import React from 'react';
import { Pressable, View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Card, ListCard, T } from '../src/components/ui/primitives';
import {
  openSession,
  recentDays,
  requestRegularisation,
  sessionsOf,
  todayRow,
  workedLabel,
  workedMs,
  type AttendanceDay,
} from '../src/data/attendance';
import { useTicker } from '../src/components/ui/use-ticker';
import { useStore } from '../src/state/store';
import { useBoot } from '../src/state/boot';
import { dmy } from '../src/lib/format';
import { color as C, weight, tabular, type BadgeTone } from '../src/theme/tokens';

/**
 * Attendance — what THIS HANDSET recorded, and the one way to argue with it.
 *
 * The list is deliberately read-only. A day recorded wrong is a request to a
 * manager with a reason attached, never an edit made here: the whole point of
 * the record is that the person it describes cannot quietly change it.
 *
 * **IT IS A SLICE, AND THE SCREEN NOW SAYS SO.** `recentDays` is a purely
 * local read and the only attendance row the server ever sends down is
 * today's, so a reinstalled handset — which is what installing a new APK is —
 * rendered "Present 0 · of 0 working days" over an empty box. The record his
 * pay is read against told him he had never been present, with nothing saying
 * it was the phone's memory rather than his attendance. `days.length` is not
 * the working month and is no longer labelled as one; the empty case names
 * the office as the record.
 *
 * **THE CORRECTION IS ASKED ON THE ROW, and that is a fix rather than a
 * rearrangement.** One button at the foot of a thirty-day list raised the
 * request against `today.id` whichever day was wrong — so a man fixing last
 * Thursday typed his sentence and it was filed against today — and where he
 * had not checked in yet `today` was null and the sentence was thrown away
 * after the sheet had closed. A day carries its own id or it carries nothing.
 * `regularizationId` is what says one is already asked for, so the same
 * request cannot be filed five times.
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
  /* Read, or still reading. An empty list and a list nobody has finished
     fetching look identical and mean opposite things, and the terminal
     sentence here is one about somebody's pay. */
  const [loaded, setLoaded] = React.useState(false);
  const [readFailed, setReadFailed] = React.useState(false);

  const load = React.useCallback(() => {
    if (!userId) return;
    void Promise.all([recentDays(userId), todayRow(userId)])
      .then(([rows, t]) => {
        setDays(rows);
        setToday(t);
        setReadFailed(false);
        setLoaded(true);
      })
      .catch(() => {
        /* A spinner that never resolves reads as a broken handset. */
        setReadFailed(true);
        setLoaded(true);
      });
  }, [userId]);

  useFocusEffect(load);

  /**
   * Ask about ONE day, the one he pressed.
   *
   * A day already asked about answers in words rather than opening the sheet
   * again: the approval is with his manager, and a second identical request
   * is noise on the list they have to work through.
   */
  const askCorrection = (d: AttendanceDay) => {
    if (d.regularizationId) {
      notify('Your manager already has a correction for ' + dmy(d.day) + '. Nothing changes until they answer it.');
      return;
    }
    askConfirm({
      title: 'Ask about ' + dmy(d.day) + '?',
      body:
        'Your manager sees ' +
        dmy(d.day) +
        ', what the app recorded, and your reason. Nothing changes until they approve it.',
      reasonLabel: 'What happened · required',
      confirmLabel: 'Send to manager',
      run: async (r) => {
        await requestRegularisation(d.id, r);
        load();
        notify('Sent to your manager · ' + dmy(d.day) + ' · nothing changes until they approve it');
      },
    });
  };

  /* The clock ticks while he is on the road, so "so far" counts against now
     rather than the last write — and it SUMS the sessions, because the day may
     be two or three stretches with gaps that are not work.

     Once a second WHILE A SESSION IS OPEN, and not at all otherwise: a closed
     day is a finished number, and the ticker draws no timer when handed null.
     It was a flat sixty seconds before, which is a counter that looks
     identical to a frozen one for fifty-nine of them. */
  const todaySessions = sessionsOf(today);
  const running = openSession(todaySessions) != null;
  const now = useTicker(running ? 1000 : null);
  const workedSoFar = todaySessions.length ? workedMs(todaySessions, now) : null;

  const present = days.filter((d) => d.status === 'Present').length;
  const onLeave = days.filter((d) => d.status === 'On Leave').length;
  const overrides = days.filter((d) => d.fieldVisitOverride === 1).length;

  /* "of N working days" was a count of the days this phone happens to hold a
     row for, so the ratio read N of N by construction and a fresh handset read
     0 of 0. What these three actually describe is the phone's own memory, and
     they say so. */
  const stats: { l: string; v: string; s: string; tone?: 'amber' }[] = [
    { l: 'Present', v: String(present), s: 'of ' + days.length + ' days on this phone' },
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
          {workedSoFar != null ? workedLabel(workedSoFar, running) + ' so far' : 'Start the day from Home.'}
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

      <T s="label" style={{ marginTop: 18, marginBottom: 8 }}>
        Days recorded on this phone
      </T>

      <ListCard>
        {!loaded ? (
          <View style={{ paddingHorizontal: 16, paddingVertical: 20 }}>
            <T s="small" style={{ color: C.muted }}>
              Reading this phone&apos;s record…
            </T>
          </View>
        ) : readFailed ? (
          <View style={{ paddingHorizontal: 16, paddingVertical: 20 }}>
            <T s="small" style={{ color: C.ink }}>
              This phone&apos;s record could not be read. Open the screen again.
            </T>
          </View>
        ) : days.length === 0 ? (
          /* A bordered box with nothing in it was the whole of this case, on
             the screen a salesman opens to check his own pay. */
          <View style={{ paddingHorizontal: 16, paddingVertical: 20 }}>
            <T style={[{ fontSize: 16, lineHeight: 22, color: C.ink }, weight(600)]}>
              Nothing recorded on this phone yet
            </T>
            <T s="small" style={{ color: C.muted, marginTop: 4 }}>
              This list is only what this handset marked, and a new or reinstalled phone starts empty. It is
              not your attendance — the office holds that, and it is what your pay is read against. Ask your
              manager if a day looks missing there.
            </T>
          </View>
        ) : null}
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
          const asked = d.regularizationId != null;
          return (
            /* The ASK is on the row, because the row is the only thing that
               knows which day it is. */
            <Pressable
              key={d.id}
              accessibilityRole="button"
              accessibilityLabel={'Ask about ' + dmy(d.day)}
              accessibilityHint={
                asked ? 'A correction for this day is already with your manager' : 'Ask your manager to correct this day'
              }
              onPress={() => askCorrection(d)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                minHeight: 48,
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
                {asked ? (
                  <T s="caption" style={{ color: C.warnInk, marginTop: 1 }}>
                    Correction asked — with your manager
                  </T>
                ) : null}
              </View>
              <Badge tone={tone}>{flagged && isPresent ? 'Field' : state}</Badge>
            </Pressable>
          );
        })}
      </ListCard>

      <T s="caption" style={{ marginTop: 10 }}>
        A day recorded wrong? Tap it and ask your manager to correct that day. Nothing here can be edited —
        the record is only worth something because the person it describes cannot change it.
      </T>
    </AppFrame>
  );
}
