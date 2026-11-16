import React from 'react';
import { View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, ListCard, T } from '../src/components/ui/primitives';
import { GLYPH, Glyph, type GlyphShape } from '../src/components/me/kit';
import {
  openSession,
  recentDays,
  requestRegularisation,
  sessionsOf,
  today as todayIso,
  todayRow,
  workedLabel,
  workedMs,
  type AttendanceDay,
} from '../src/data/attendance';
import { useTicker } from '../src/components/ui/use-ticker';
import { PressableScale, Pulse, Stagger, Swap } from '../src/components/ui/motion';
import { missedPunchOuts } from '../src/engines/punch-out';
import { getConfig } from '../src/data/config';
import { useStore } from '../src/state/store';
import { useBoot } from '../src/state/boot';
import { dmy, hhmm, monthName } from '../src/lib/format';
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
  const [windowDays, setWindowDays] = React.useState(30);

  const load = React.useCallback(() => {
    if (!userId) return;
    void getConfig<number>('mbos.attendance.missedPunchOutWindowDays', 30)
      /* One more row than the window, so a window longer than the old fixed
         thirty is not silently cut short by the read under it. */
      .then((w) => Promise.all([w, recentDays(userId, Math.max(30, w + 1)), todayRow(userId)]))
      .then(([w, rows, t]) => {
        setWindowDays(w);
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
      notify('You already asked your manager to fix ' + dmy(d.day) + '. Wait for their answer.', 'info');
      return;
    }
    askConfirm({
      title: 'Ask about ' + dmy(d.day) + '?',
      body:
        'Your manager sees ' +
        dmy(d.day) +
        ', what the app saved, and your reason. Nothing changes until they approve it.',
      reasonLabel: 'What happened · needed',
      confirmLabel: 'Send to manager',
      tone: 'navy',
      placeholder: 'What happened that day',
      lead: { top: String(Number(d.day.slice(8, 10))), bottom: monthName(Number(d.day.slice(5, 7)) - 1).slice(0, 3) },
      subtitle:
        (d.checkInAt != null ? hhmm(d.checkInAt) : 'No punch-in') +
        ' – ' +
        (d.checkOutAt != null ? hhmm(d.checkOutAt) : 'no punch-out'),
      run: async (r) => {
        await requestRegularisation(d.id, r);
        load();
        notify('Sent to your manager · ' + dmy(d.day) + ' · nothing changes until they approve');
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
  const overrides = days.filter((d) => d.fieldVisitOverride === 1).length;
  /* His own count of the habit his manager now sees as a column. Told to him
     first, on his own screen, because a man who does not know the button is
     there should find out from the app before he finds out from a review. */
  const missed = missedPunchOuts(days, todayIso(), windowDays);

  /* "of N working days" was a count of the days this phone happens to hold a
     row for, so the ratio read N of N by construction and a fresh handset read
     0 of 0. What these three actually describe is the phone's own memory, and
     they say so. */
  const stats: { l: string; v: string; s: string; long: string; icon: GlyphShape[]; tone?: 'amber' }[] = [
    {
      l: 'Present',
      v: String(present),
      s: 'Present · of ' + days.length + ' days on this phone',
      long: 'Present, of ' + days.length + ' days on this phone',
      icon: TICK,
    },
    { l: 'Away from base', v: String(overrides), s: 'Away from base · field visit', long: 'Away from base, field visit', icon: GLYPH.pin, tone: 'amber' },
    {
      l: 'No punch-out',
      v: String(missed.missed),
      s: missed.punched ? 'No punch-out · of ' + missed.punched + ', last ' + windowDays + ' d' : 'No punch-out · last ' + windowDays + ' d',
      long: missed.punched
        ? 'No punch-out, of ' + missed.punched + ' days, last ' + windowDays
        : 'No punch-out, last ' + windowDays + ' days',
      icon: CROSS,
      tone: missed.missed ? 'amber' : undefined,
    },
  ];

  return (
    <AppFrame title="Attendance" activeTab={null} contentStyle={{ padding: 14, paddingBottom: 24, gap: 12 }}>
      <BackLink label={back.label} onPress={back.go} />

      <View style={{ backgroundColor: C.navy, borderRadius: 24, padding: 18 }}>
        {/* Punched in, on a break, or not yet — three states of one day, and
            the screen is often open on Home's way back from changing it. Keyed
            on the state, never on the ticking figure, so the clock counting
            does not re-settle the card every second. */}
        <Swap id={today?.checkInAt == null ? 'out' : running ? 'on' : 'break'}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <T style={[{ flex: 1, fontSize: 13, color: C.onNavyMuted }, weight(700)]}>Today</T>
            <View
              style={{
                minHeight: 28,
                paddingVertical: 4,
                paddingHorizontal: 10,
                borderRadius: 14,
                backgroundColor: today?.checkInAt != null ? C.limeOnNavy : C.navySoft,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 5,
              }}>
              {today?.checkInAt != null ? <Glyph shapes={TICK} size={13} color={C.lime} strokeWidth={2.2} /> : null}
              <T style={[{ flexShrink: 1, fontSize: 12, color: today?.checkInAt != null ? C.lime : C.onNavyMuted }, weight(700)]}>
                {today?.checkInAt != null ? 'Punched in ' + hhmm(today.checkInAt) : 'Not punched in'}
              </T>
            </View>
          </View>
          {workedSoFar != null ? (
            <>
              <T style={[{ fontSize: 34, lineHeight: 40, letterSpacing: -1, color: C.onNavy, marginTop: 8 }, weight(800), tabular]}>
                {workedLabel(workedSoFar, running)}
              </T>
              <T style={{ marginTop: 4, fontSize: 12, color: C.onNavyMuted }}>so far</T>
            </>
          ) : (
            <T style={{ fontSize: 15, lineHeight: 22, color: C.onNavyMuted, marginTop: 8 }}>Punch in from Home.</T>
          )}
        </Swap>

        {/*
          Each stretch of work, named. A day is not one check-in and one
          check-out — there is lunch, and there are evening calls — and the
          hours are the SUM of these, never the last time minus the first.
        */}
        {todaySessions.length > 0 ? (
          <View style={{ marginTop: 14, gap: 8 }}>
            {todaySessions.map((x, i) => {
              const open = x.outAt == null;
              return (
                <Stagger key={i} index={i}>
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 10,
                      minHeight: 36,
                      paddingHorizontal: 12,
                      borderRadius: 18,
                      backgroundColor: open ? 'rgba(198,255,52,0.12)' : 'rgba(255,255,255,0.06)',
                    }}>
                    <View
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: 11,
                        backgroundColor: open ? C.lime : 'rgba(255,255,255,0.12)',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}>
                      <T style={[{ fontSize: 11, color: open ? C.navy : C.onNavy }, weight(800)]}>{i + 1}</T>
                    </View>
                    <T style={{ flex: 1, fontSize: 12, color: open ? C.lime : C.onNavyMuted }}>{'Check-in ' + (i + 1)}</T>
                    {/* The open stretch breathes: it is the one line on this
                        screen that is still being written. */}
                    <Pulse active={open}>
                      <T style={[{ fontSize: 14, color: open ? C.lime : C.onNavy }, weight(700), tabular]}>
                        {hhmm(x.inAt) + ' – ' + (open ? 'still on' : hhmm(x.outAt))}
                      </T>
                    </Pulse>
                  </View>
                </Stagger>
              );
            })}
          </View>
        ) : null}
      </View>

      <View style={{ flexDirection: 'row', gap: 8 }}>
        {stats.map((x) => (
          <View
            key={x.l}
            accessible
            accessibilityLabel={x.v + ' ' + x.long}
            style={{ flex: 1, minWidth: 0, backgroundColor: C.surface, borderRadius: 18, padding: 12 }}>
            <Glyph shapes={x.icon} size={18} color={x.l === 'Present' ? C.success : C.warnInk} />
            <T
              style={[
                { fontSize: 22, lineHeight: 28, marginTop: 6, color: x.tone === 'amber' ? C.warnInk : C.ink },
                weight(800),
                tabular,
              ]}>
              {x.v}
            </T>
            <T style={{ marginTop: 4, fontSize: 11, lineHeight: 15, color: C.muted }}>{x.s}</T>
          </View>
        ))}
      </View>

      {missed.missed ? (
        <View
          accessible
          accessibilityLabel={
            (missed.missed === 1 ? 'One day was' : missed.missed + ' days were') +
            ' closed by the system because you did not punch out. Your manager has to fix each one. Punch out from Home at the end of the day.'
          }
          style={{ backgroundColor: C.warnBg, borderRadius: 18, paddingVertical: 12, paddingHorizontal: 14, flexDirection: 'row', gap: 10 }}>
          <Glyph shapes={GLYPH.alert} size={18} color={C.warnInk} />
          <T style={{ flex: 1, fontSize: 13, lineHeight: 18, color: C.warnInk }}>
            {(missed.missed === 1 ? '1 day' : missed.missed + ' days') +
              ' closed by the system — no punch-out. Your manager must fix each. Punch out from Today at day end.'}
          </T>
        </View>
      ) : null}

      <T style={[{ fontSize: 17, lineHeight: 22, color: C.ink, paddingTop: 6, paddingHorizontal: 6 }, weight(800)]}>
        Days saved on this phone
      </T>

      <ListCard style={{ borderRadius: 22 }}>
        {!loaded ? (
          <View style={{ paddingHorizontal: 16, paddingVertical: 20 }}>
            <T s="small" style={{ color: C.muted }}>
              Loading…
            </T>
          </View>
        ) : readFailed ? (
          <View style={{ paddingHorizontal: 16, paddingVertical: 20 }}>
            <T s="small" style={{ color: C.ink }}>
              Could not load. Open this screen again.
            </T>
          </View>
        ) : days.length === 0 ? (
          /* A bordered box with nothing in it was the whole of this case, on
             the screen a salesman opens to check his own pay. */
          <View style={{ paddingHorizontal: 16, paddingVertical: 20 }}>
            <T style={[{ fontSize: 16, lineHeight: 22, color: C.ink }, weight(600)]}>
              Nothing saved on this phone yet
            </T>
            <T s="small" style={{ color: C.muted, marginTop: 4 }}>
              This list shows only what this phone saved. A new or reset phone starts empty. This is
              not your full attendance. The office keeps that, and your pay is based on it. Ask your
              manager if a day is missing.
            </T>
          </View>
        ) : null}
        {days.map((d, i) => {
          /* A day punched in to and never out of has NO status — the verdict
             is written by the punch-out, and there was none — so it fell
             through to "Absent" on a day he plainly worked. It is its own
             answer, and today's open session is not one of them. */
          const noPunchOut = d.checkInAt != null && d.checkOutAt == null && d.day < todayIso();
          const state = d.status ?? (noPunchOut ? 'No punch-out' : 'Absent');
          const isPresent = state === 'Present' || state === 'Half Day' || noPunchOut;
          /* An override is not lateness — it is a day that started away from
             base, which is what a field salesman's day usually is. */
          const flagged = d.fieldVisitOverride === 1;
          const tone: BadgeTone = noPunchOut
            ? 'amber'
            : isPresent
            ? flagged
              ? 'amber'
              : 'success'
            : state === 'On Leave'
              ? 'teal'
              : 'neutral';
          const asked = d.regularizationId != null;
          const badgeWord = noPunchOut ? 'No punch-out' : flagged && isPresent ? 'Field' : state;
          const [, mm, dd] = d.day.split('-').map(Number);
          const sessions = sessionsOf(d).length;
          return (
            /* The ASK is on the row, because the row is the only thing that
               knows which day it is. */
            <Stagger key={d.id} index={i}>
              <PressableScale
                scaleTo={0.99}
                accessibilityRole="button"
                accessibilityLabel={'Ask about ' + dmy(d.day) + ', ' + badgeWord}
                accessibilityHint={
                  asked ? 'You already asked your manager to fix this day' : 'Ask your manager to fix this day'
                }
                onPress={() => askCorrection(d)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  minHeight: 60,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                  borderTopWidth: i ? 1 : 0,
                  borderTopColor: C.hairline,
                }}>
                <View style={{ width: 44, alignItems: 'center' }}>
                  <T style={[{ fontSize: 17, lineHeight: 21, color: C.ink }, weight(800), tabular]}>{dd}</T>
                  <T style={{ marginTop: 4, fontSize: 11, lineHeight: 14, color: C.muted }}>
                    {MONTH_SHORT[mm - 1] + ' · ' + DAY_NAMES[new Date(d.day + 'T00:00:00').getDay()]}
                  </T>
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T style={[{ fontSize: 15, lineHeight: 20, color: isPresent ? C.ink : C.faint }, weight(600), tabular]}>
                    {isPresent ? hhmm(d.checkInAt) + ' – ' + (noPunchOut ? 'no punch-out' : hhmm(d.checkOutAt)) : '—'}
                  </T>
                  {/* No hours on a day nobody closed: there is no end to count to,
                      and the line below says why. */}
                  {noPunchOut ? null : (
                    <T style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>
                      {isPresent
                        ? hoursLabel(d.workedMinutes) + (sessions > 1 ? ` · punched in ${sessions} times` : '')
                        : state}
                    </T>
                  )}
                  {/* Said in words rather than left as "09:12 – —", which reads as
                      a time nobody filled in rather than a punch-out that never
                      happened. Not today's open session: that is still running.
                      Once a fix is asked the line says so instead. */}
                  {noPunchOut && !asked ? (
                    <T style={{ fontSize: 12, lineHeight: 16, color: C.warnInk, marginTop: 1 }}>
                      Closed by the system · tap to ask a fix
                    </T>
                  ) : null}
                  {asked ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 1 }}>
                      <Glyph shapes={GLYPH.clock} size={12} color={C.warnInk} strokeWidth={2.2} />
                      <T style={{ flex: 1, fontSize: 12, lineHeight: 16, color: C.warnInk }}>
                        {noPunchOut ? 'Closed by system · fix asked, waiting for manager' : 'Fix asked. Waiting for your manager.'}
                      </T>
                    </View>
                  ) : null}
                </View>
                {tone === 'amber' && badgeWord === 'Field' ? (
                  <View style={{ minHeight: 28, paddingHorizontal: 10, borderRadius: 14, backgroundColor: C.warnBg, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <Glyph shapes={[GLYPH.pin[0]]} size={12} color={C.warnInk} strokeWidth={2.4} />
                    <T style={[{ flexShrink: 1, fontSize: 12, color: C.warnInk }, weight(700)]}>Field</T>
                  </View>
                ) : (
                  <Badge tone={tone}>{badgeWord}</Badge>
                )}
              </PressableScale>
            </Stagger>
          );
        })}
      </ListCard>

      <View
        accessible
        accessibilityLabel="A day recorded wrong? Tap it and ask your manager to correct that day. Nothing here can be edited — the record is only worth something because the person it describes cannot change it."
        style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 6 }}>
        <Glyph shapes={LOCK} size={16} color={C.muted} />
        <T style={{ flex: 1, fontSize: 12, lineHeight: 17, color: C.muted }}>
          Wrong day? Tap it to ask your manager. Nothing here can be edited — the record counts because you cannot change it.
        </T>
      </View>
    </AppFrame>
  );
}

const TICK: GlyphShape[] = [{ p: 'M5 12l5 5 9-10' }];
const CROSS: GlyphShape[] = [{ c: [12, 12, 8] }, { p: 'M9 9l6 6M15 9l-6 6' }];
const LOCK: GlyphShape[] = [{ r: [5, 11, 14, 10, 2] }, { p: 'M8 11V8a4 4 0 0 1 8 0v3' }];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
