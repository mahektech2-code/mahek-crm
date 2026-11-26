import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Card, T } from '../src/components/ui/primitives';
import { GLYPH, Glyph, HeroPill, type GlyphShape } from '../src/components/me/kit';
import { VoiceField } from '../src/components/ui/dictate';
import { BottomSheet, Calendar } from '../src/components/ui/overlays';
import { Stagger, animateLayout, animateLayoutFor } from '../src/components/ui/motion';
import { feedback } from '../src/components/ui/feedback';
import { applyForLeave, leaveCalendar, listLeave, withdrawLeave, type LeaveRequest } from '../src/data/requests';
import { leaveDays, type LeaveCalendar } from '../src/engines/leave';
import { dmy, isoDate, plural, todayIst } from '../src/lib/format';
import { useStore } from '../src/state/store';
import { useBoot } from '../src/state/boot';
import { color as C, weight, tabular, type BadgeTone } from '../src/theme/tokens';

/**
 * Leave: ask for it, follow what happened to every request, and see how many
 * days have been taken this year.
 *
 * TAKEN, NEVER LEFT. The top card counts approved days this year, by kind,
 * off his own requests — what happened, which he can check against his own
 * memory. Allowances are kept in HRMS, and the office decides every request.
 *
 * NO BALANCE IS SHOWN, ANYWHERE. Mahek does not show a salesman how many days
 * of leave he has; whether a request is paid is the office's decision. The
 * phone still holds `leave_balances` because `applyForLeave` records the
 * snapshot the office reads, but no screen draws a number from it.
 *
 * The types are the four the server records (`leaveTypeOf`), not the rows of
 * that table — so a phone the balances have not reached can still ask for
 * sick leave on the morning it is needed.
 */

const TYPES = ['Casual', 'Sick', 'Earned', 'Loss of pay'] as const;

/** What each kind is FOR, in the words a salesman would use. */
const TYPE_HELP: Record<(typeof TYPES)[number], string> = {
  Casual: 'Personal work, a function, a family matter. Ask a few days before.',
  Sick: 'You or your family are unwell. Ask on the day if you have to.',
  Earned: 'Planned time off — a trip, a festival at home. Ask well before.',
  'Loss of pay': 'Time off without pay, when you want it recorded that way.',
};

const SPANS: [Draft['span'], string][] = [
  ['half', 'Half day'],
  ['one', 'One day'],
  ['many', 'More than a day'],
];

const HALVES: [string, string, string][] = [
  ['Morning', 'First half', '9:30 am – 1:30 pm'],
  ['Afternoon', 'Second half', '1:30 pm – 6:00 pm'],
];

type Draft = { type: string; span: 'half' | 'one' | 'many'; half: string; from: string; to: string; reason: string };

const EMPTY: Draft = { type: 'Casual', span: 'one', half: 'Morning', from: '', to: '', reason: '' };

type RetakeParams = { retake?: string; kind?: string; fromDate?: string; toDate?: string; half?: string; reason?: string };

/**
 * A REFUSED REQUEST ASKED AGAIN, from Not accepted: the form opens with what he
 * asked for the first time. Read once into the initial state — no effect — so
 * the form is his to change from there.
 */
function draftFrom(p: RetakeParams): Draft | null {
  if (p.retake !== '1' || !p.fromDate) return null;
  const many = !!p.toDate && p.toDate !== p.fromDate;
  return {
    type: p.kind || EMPTY.type,
    span: p.half ? 'half' : many ? 'many' : 'one',
    half: p.half || EMPTY.half,
    from: p.fromDate,
    to: many ? p.toDate! : '',
    reason: p.reason ?? '',
  };
}

const TONE: Record<string, BadgeTone> = {
  Pending: 'amber',
  Approved: 'success',
  Rejected: 'danger',
  Withdrawn: 'neutral',
};

const STATE_LABEL: Record<string, string> = {
  Pending: 'Waiting',
  Approved: 'Approved',
  Rejected: 'Rejected',
  Withdrawn: 'Withdrawn',
};

/** "18 Aug – 19 Aug", or the single day with its half. */
function whenOf(l: { fromDate: string; toDate: string; halfDay: string | null }): string {
  if (l.fromDate !== l.toDate) return dmy(l.fromDate) + ' – ' + dmy(l.toDate);
  const half = l.halfDay ? HALVES.find((h) => h[0] === l.halfDay) : null;
  return dmy(l.fromDate) + (half ? ' · ' + half[1] : '');
}

function lengthOf(days: number): string {
  return days === 0.5 ? 'Half day' : plural(days, 'day');
}

export default function LeaveScreen() {
  const back = useCameFrom('more');
  const askConfirm = useStore((s) => s.askConfirm);
  const notify = useStore((s) => s.notify);
  const boot = useBoot();

  const params = useLocalSearchParams<RetakeParams>();
  const [retaken] = React.useState(() => draftFrom(params));
  const [rows, setRows] = React.useState<LeaveRequest[] | null>(null);
  const [open, setOpen] = React.useState(retaken !== null);
  const [lv, setLv] = React.useState<Draft>(retaken ?? EMPTY);
  const [err, setErr] = React.useState<'dates' | 'reason' | null>(null);
  /** Which end of the range the calendar is picking, or null for closed. */
  const [pick, setPick] = React.useState<'from' | 'to' | null>(null);
  /* One request per press: the overlap guard reads the table before the first
     insert commits, so it does not catch a double tap. */
  const [sending, setSending] = React.useState(false);
  /* The office's working week and holidays, so the count on the form is the
     count the balance is debited by. Null until read, and the form then falls
     back to calendar days rather than showing nothing. */
  const [calendar, setCalendar] = React.useState<LeaveCalendar | null>(null);
  /* The year the "taken" card counts — read when the screen loads rather than
     during render, which must not read the clock. */
  const [year, setYear] = React.useState<string | null>(null);
  const [guide, setGuide] = React.useState(false);

  const load = React.useCallback(() => {
    let live = true;
    setYear(todayIst().slice(0, 4));
    void leaveCalendar()
      .then((c) => live && setCalendar(c))
      .catch(() => {});
    void listLeave()
      .then((l) => {
        if (!live) return;
        /* A request sent or withdrawn moves between the two lists; the cards
           around it ease to their new places rather than jumping. */
        animateLayoutFor(l.length);
        setRows(l);
      })
      .catch(() => live && setRows([]));
    return () => {
      live = false;
    };
  }, []);

  useFocusEffect(load);

  const patch = (p: Partial<Draft>) => {
    setLv((d) => ({ ...d, ...p }));
    setErr(null);
  };

  /* WORKING DAYS, the way the office counts them — Friday to Monday is two,
     not four, and the Sunday in the middle is not leave. */
  const counted =
    lv.from && lv.span === 'many' && lv.to
      ? leaveDays({ span: 'range', from: lv.from, to: lv.to, half: null }, calendar ?? undefined)
      : lv.from && lv.span !== 'many'
        ? leaveDays(
            { span: 'single', from: lv.from, to: lv.from, half: lv.span === 'half' ? 'first_half' : null },
            calendar ?? undefined,
          )
        : null;
  const dayCount = counted?.days ?? 0;

  /* A range cannot end before it starts; the calendar refuses it. */
  const refuseTo = (iso: string) =>
    pick === 'to' && !!lv.from && iso < lv.from ? 'Last day cannot be before the first day' : null;

  const send = async () => {
    /* The second press ANSWERS rather than doing nothing — `whyDisabled` keeps
       the button pressable for exactly this. */
    if (sending) return notify('Sending this request. Please wait.', 'info');
    /* Refused, with the reason under the field it names. */
    if (!lv.from || (lv.span === 'many' && !lv.to) || dayCount <= 0) {
      feedback('warning');
      return setErr('dates');
    }
    if (!lv.reason.trim()) {
      feedback('warning');
      return setErr('reason');
    }

    setSending(true);
    try {
      const outcome = await applyForLeave({
        userId: boot.session?.user.id ?? '',
        kind: lv.type,
        span: lv.span,
        fromDate: lv.from,
        toDate: lv.span === 'many' ? lv.to : null,
        half: lv.span === 'half' ? (lv.half as 'Morning' | 'Afternoon') : null,
        reason: lv.reason.trim(),
      });
      /* An overlap is refused with a sentence naming the request it clashes with. */
      if (!outcome.ok) return notify(outcome.message, 'error');

      setOpen(false);
      setLv(EMPTY);
      load();
      notify('Leave request sent to your manager');
    } finally {
      setSending(false);
    }
  };

  const withdraw = (l: LeaveRequest) =>
    askConfirm({
      title: neverWent(l) ? 'Remove this request?' : 'Withdraw this request?',
      body:
        l.kind + ' · ' + whenOf(l) +
        (neverWent(l) ? '\n\nThe office never took it, so it is removed from this phone.' : ''),
      confirmLabel: 'Withdraw',
      run: () => {
        void withdrawLeave(l.id)
          .then((how) => {
            load();
            notify(how === 'removed' ? 'Removed from this phone. The office never had it.' : 'Request withdrawn');
          })
          .catch(() => notify('Could not withdraw it. Try again.', 'error'));
      },
    });

  /* Approved days this year, by kind — a request is counted in the year it
     starts, the way the office counts it. */
  const takenThisYear = (rows ?? []).filter(
    (r) => r.state === 'Approved' && year !== null && r.fromDate.slice(0, 4) === year,
  );
  const takenByKind = new Map<string, number>();
  for (const r of takenThisYear) takenByKind.set(r.kind, (takenByKind.get(r.kind) ?? 0) + r.days);
  const takenTotal = takenThisYear.reduce((n, r) => n + r.days, 0);

  const waiting = (rows ?? []).filter((r) => r.state === 'Pending');
  const history = (rows ?? []).filter((r) => r.state !== 'Pending');

  const dateBtn = (active: boolean) => ({
    minHeight: 60,
    justifyContent: 'center' as const,
    paddingHorizontal: 14,
    borderWidth: active ? 2 : 1,
    borderColor: active ? C.primary : err === 'dates' ? C.danger : C.border,
    borderRadius: 20,
    backgroundColor: active ? '#F7F4FF' : C.surface,
  });

  const hero = (
    <View>
      <T style={[{ fontSize: 12, color: C.lavenderMuted, marginTop: 16 }, weight(700)]}>
        {year ? 'Taken in ' + year : 'Taken this year'}
      </T>
      <T style={[{ marginTop: 4, fontSize: takenTotal ? 36 : 28, lineHeight: takenTotal ? 42 : 34, letterSpacing: -1, color: C.lavenderInk }, weight(800), tabular]}>
        {takenTotal ? lengthOf(takenTotal) : 'No leave yet'}
      </T>
      {takenByKind.size ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {[...takenByKind].map(([kind, d]) => (
            <HeroPill key={kind} style={{ minHeight: 28 }}>
              {kind + ' · ' + lengthOf(d)}
            </HeroPill>
          ))}
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 }}>
        {waiting.length ? <Glyph shapes={GLYPH.clock} size={14} color={C.warnInk} strokeWidth={2.2} /> : null}
        <Text
          accessibilityLabel={
            waiting.length
              ? plural(waiting.length, 'request') + ' waiting for your manager. Days count here once approved.'
              : 'Only approved leave is counted here.'
          }
          style={[{ flex: 1, fontSize: 12, lineHeight: 17, color: waiting.length ? C.warnInk : C.lavenderMuted }, weight(400)]}>
          {waiting.length
            ? plural(waiting.length, 'request') + ' waiting · counts once approved'
            : 'Only approved leave is counted here.'}
        </Text>
      </View>
    </View>
  );

  return (
    <AppFrame title="Leave" activeTab={null} onBack={back.go} hero={hero} contentStyle={{ padding: 14, paddingBottom: 24, gap: 12 }}>
      <BackLink label={back.label} onPress={back.go} />

      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Apply for leave"
          onPress={() => {
            setLv(EMPTY);
            setErr(null);
            setOpen(true);
          }}
          style={({ pressed }) => [navyBtn, { flex: 1, opacity: pressed ? 0.9 : 1 }]}>
          <Glyph shapes={GLYPH.plus} size={18} color={C.lime} strokeWidth={2.4} />
          <T style={[{ fontSize: 17, color: C.onNavy }, weight(700)]}>Apply for leave</T>
        </Pressable>
        {/* ---------------------------------------------- how leave works */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={guide ? 'Hide how leave works' : 'How leave works'}
          accessibilityState={{ expanded: guide }}
          onPress={() => {
            animateLayout();
            setGuide((g) => !g);
          }}
          style={{ width: 60, height: 60, borderRadius: 30, backgroundColor: C.primaryTint, alignItems: 'center', justifyContent: 'center' }}>
          <Glyph shapes={QUESTION} size={22} color={C.primaryDeep} />
        </Pressable>
      </View>

      {guide ? (
        <Card style={{ borderRadius: 22 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <T style={[{ flex: 1, fontSize: 15, color: C.ink }, weight(800)]}>How leave works</T>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Hide how leave works"
              hitSlop={12}
              onPress={() => {
                animateLayout();
                setGuide(false);
              }}>
              <T style={[{ fontSize: 12, color: C.primaryDeep }, weight(700)]}>Hide</T>
            </Pressable>
          </View>
          <View style={{ gap: 8, marginTop: 10 }}>
            {[
              'Press Apply for leave.',
              'Pick the kind, and half a day, one day or more.',
              'Pick dates and write why — your manager decides on the reason.',
              'Send. It goes when the phone has signal.',
              'The answer comes back here, with who decided.',
            ].map((line, i) => (
              <View key={line} style={{ flexDirection: 'row', gap: 10 }}>
                <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: C.primaryTint, alignItems: 'center', justifyContent: 'center' }}>
                  <T style={[{ fontSize: 11, color: C.primaryDeep }, weight(800)]}>{i + 1}</T>
                </View>
                <T style={{ flex: 1, fontSize: 13, lineHeight: 19, color: C.body }}>{line}</T>
              </View>
            ))}
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
            {TYPES.map((k) => (
              <View key={k} style={{ width: '48.5%', backgroundColor: C.canvas, borderRadius: 16, padding: 10 }}>
                <T style={[{ fontSize: 13, color: C.ink }, weight(800)]}>{k}</T>
                <T style={{ marginTop: 2, fontSize: 11, lineHeight: 15, color: C.muted }}>{TYPE_HELP[k]}</T>
              </View>
            ))}
          </View>
          <T style={{ fontSize: 12, lineHeight: 17, color: C.muted, marginTop: 10 }}>
            {'Weekly days off and holidays inside your dates are not counted. You can withdraw a ' +
              "request while it is still waiting. Whether it is approved is your manager's decision."}
          </T>
        </Card>
      ) : null}

      {rows === null ? null : rows.length === 0 ? (
        <T style={{ fontSize: 15, color: C.muted, textAlign: 'center', marginTop: 20 }}>
          You have not applied for leave yet.
        </T>
      ) : (
        <>
          {waiting.length ? (
            <View style={{ gap: 12 }}>
              <T style={[sectionTitle, weight(800)]}>Waiting for approval</T>
              {waiting.map((l, i) => (
                <Stagger key={l.id} index={i}>
                  <RequestCard l={l} onWithdraw={() => withdraw(l)} />
                </Stagger>
              ))}
            </View>
          ) : null}

          {history.length ? (
            <View style={{ gap: 12 }}>
              <T style={[sectionTitle, weight(800)]}>History</T>
              {history.map((l, i) => (
                <Stagger key={l.id} index={waiting.length + i}>
                  <RequestCard l={l} />
                </Stagger>
              ))}
            </View>
          ) : null}
        </>
      )}

      {/* ------------------------------------------------------ apply sheet */}
      <BottomSheet open={open} onClose={() => setOpen(false)} scroll>
        <T style={[{ fontSize: 20, lineHeight: 26, color: C.ink }, weight(800)]} >Apply for leave</T>

        <View accessibilityRole="radiogroup" accessibilityLabel="Type" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
          {TYPES.map((k) => {
            const on = lv.type === k;
            return (
              <Pressable
                key={k}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                accessibilityLabel={'Type: ' + k}
                hitSlop={{ top: 6, bottom: 6 }}
                onPress={() => patch({ type: k })}
                style={{ minHeight: 36, paddingVertical: 6, paddingHorizontal: 14, borderRadius: 18, backgroundColor: on ? C.navy : C.canvas, justifyContent: 'center' }}>
                <T style={[{ fontSize: 13, color: on ? C.onNavy : C.ink }, weight(700)]}>{k}</T>
              </Pressable>
            );
          })}
        </View>
        <T style={{ fontSize: 12, lineHeight: 17, color: C.muted, marginTop: 6 }}>
          {TYPE_HELP[lv.type as (typeof TYPES)[number]] ?? ''}
        </T>

        <View
          accessibilityRole="radiogroup"
          accessibilityLabel="How long"
          style={{ flexDirection: 'row', minHeight: 48, borderRadius: 24, backgroundColor: C.canvas, padding: 4, marginTop: 14 }}>
          {SPANS.map(([k, label]) => {
            const on = lv.span === k;
            return (
              <Pressable
                key={k}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                accessibilityLabel={'How long: ' + label}
                onPress={() => {
                  /* The span decides which fields exist — the halves row, the
                     second date — so the sheet reshapes with it. */
                  if (lv.span !== k) animateLayout();
                  patch({ span: k, to: k === 'many' ? lv.to : '' });
                }}
                style={{ flex: k === 'many' ? 1.3 : 1, borderRadius: 20, backgroundColor: on ? C.surface : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                <T numberOfLines={1} style={[{ fontSize: 13, color: on ? C.primaryDeep : C.ink }, weight(on ? 800 : 700)]}>{label}</T>
              </Pressable>
            );
          })}
        </View>

        {lv.span === 'half' ? (
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
            {HALVES.map(([k, label, hours]) => {
              const on = lv.half === k;
              return (
                <Pressable
                  key={k}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={label + ', ' + hours}
                  onPress={() => patch({ half: k })}
                  style={{
                    flex: 1,
                    minHeight: 64,
                    borderRadius: 20,
                    borderWidth: on ? 2 : 0,
                    borderColor: C.primary,
                    backgroundColor: on ? '#F7F4FF' : C.canvas,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                    paddingHorizontal: 12,
                  }}>
                  <Glyph shapes={k === 'Morning' ? SUN : SUNSET} size={20} color={on ? C.primary : C.muted} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T style={[{ fontSize: 14, color: C.ink }, weight(800)]}>{label}</T>
                    <T style={{ marginTop: 2, fontSize: 11, lineHeight: 15, color: C.muted }}>{hours}</T>
                  </View>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        <View style={{ flexDirection: 'row', gap: 10, marginTop: lv.span === 'half' ? 12 : 14 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={(lv.span === 'many' ? 'From' : 'Date') + ': ' + (lv.from ? dmy(lv.from) : 'Pick a date')}
            onPress={() => setPick('from')}
            style={[dateBtn(pick === 'from'), { flex: 1, minWidth: 0 }]}>
            <T style={{ fontSize: 11, lineHeight: 14, color: C.muted }}>{lv.span === 'many' ? 'From' : 'Date'}</T>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              {lv.from ? <Glyph shapes={GLYPH.cal} size={14} color={C.primaryDeep} /> : null}
              <T style={[{ flexShrink: 1, fontSize: 16, color: lv.from ? C.ink : C.faint }, weight(lv.from ? 800 : 700)]}>{lv.from ? dmy(lv.from) : 'Pick a date'}</T>
            </View>
          </Pressable>
          {lv.span === 'many' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={'To: ' + (lv.to ? dmy(lv.to) : 'Pick a date')}
              onPress={() => setPick('to')}
              style={[dateBtn(pick === 'to'), { flex: 1, minWidth: 0 }]}>
              <T style={{ fontSize: 11, lineHeight: 14, color: C.muted }}>To</T>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {lv.to ? <Glyph shapes={GLYPH.cal} size={14} color={C.primaryDeep} /> : null}
                <T style={[{ flexShrink: 1, fontSize: 16, color: lv.to ? C.ink : C.faint }, weight(lv.to ? 800 : 700)]}>{lv.to ? dmy(lv.to) : 'Pick a date'}</T>
              </View>
            </Pressable>
          ) : null}
        </View>
        {err === 'dates' ? (
          <T style={{ fontSize: 13, color: C.danger, marginTop: 6 }}>
            {counted && counted.days === 0
              ? counted.sentence
              : lv.span === 'many'
                ? 'Pick both dates.'
                : 'Pick the date.'}
          </T>
        ) : counted && (lv.span === 'many' || counted.days === 0) ? (
          counted.days === 0 ? (
            <T style={{ fontSize: 13, color: C.danger, marginTop: 6 }}>{counted.sentence}</T>
          ) : (
            <View style={{ alignSelf: 'flex-start', minHeight: 28, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 14, backgroundColor: C.primaryTint, marginTop: 8, justifyContent: 'center' }}>
              <T style={[{ fontSize: 12, color: C.primaryDeep }, weight(700)]}>
                {lengthOf(dayCount) + (counted.note ? ` · ${counted.note}` : '')}
              </T>
            </View>
          )
        ) : null}

        <T style={[{ fontSize: 13, color: C.ink, marginTop: 14, marginBottom: 6 }, weight(700)]}>
          Why <T style={{ color: C.danger }}>*</T>
        </T>
        <VoiceField
          value={lv.reason}
          onChangeText={(v) => patch({ reason: v })}
          invalid={err === 'reason'}
          placeholder="Sister's wedding in Amravati"
        />
        {err === 'reason' ? (
          <T style={{ fontSize: 12, color: C.danger, marginTop: 6 }}>
            Your manager approves on the reason. Please write it.
          </T>
        ) : null}

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            onPress={() => setOpen(false)}
            style={({ pressed }) => [pillBtn, { flex: 1, backgroundColor: C.canvas, opacity: pressed ? 0.85 : 1 }]}>
            <T style={[{ fontSize: 15, color: C.ink }, weight(700)]}>Cancel</T>
          </Pressable>
          {/* Stays pressable while sending: the second press ANSWERS in
              `send` rather than doing nothing. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={sending ? 'Sending' : 'Send'}
            accessibilityState={{ busy: sending }}
            onPress={send}
            style={({ pressed }) => [pillBtn, { flex: 1.6, backgroundColor: C.navy, opacity: sending ? 0.7 : pressed ? 0.9 : 1 }]}>
            <T style={[{ fontSize: 17, color: C.onNavy }, weight(700)]}>{sending ? 'Sending…' : 'Send'}</T>
          </Pressable>
        </View>
      </BottomSheet>

      {/* --------------------------------------------------- date calendar */}
      <BottomSheet open={!!pick} onClose={() => setPick(null)}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <T style={[{ flex: 1, fontSize: 20, lineHeight: 26, color: C.ink }, weight(800)]}>
            {pick === 'to' ? 'Last day' : lv.span === 'many' ? 'First day' : 'Date'}
          </T>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Today"
            hitSlop={{ top: 6, bottom: 6 }}
            onPress={() => {
              const iso = todayIst();
              const refusal = refuseTo(iso);
              if (refusal) return notify(refusal + '.', 'error');
              if (pick === 'to') patch({ to: iso });
              else patch({ from: iso, to: lv.to && iso > lv.to ? iso : lv.to });
              setPick(null);
            }}
            style={{ minHeight: 36, paddingVertical: 6, paddingHorizontal: 14, borderRadius: 18, backgroundColor: C.primaryTint, justifyContent: 'center' }}>
            <T style={[{ fontSize: 13, color: C.primaryDeep }, weight(700)]}>Today</T>
          </Pressable>
        </View>
        <Calendar
          key={pick ?? 'from'}
          selected={pick === 'to' ? lv.to : lv.from}
          rangeFrom={lv.from}
          rangeTo={lv.to}
          disabledReason={refuseTo}
          onPick={(iso) => {
            if (pick === 'to') patch({ to: iso });
            /* A start after the end is not a range — carry the end with it. */
            else patch({ from: iso, to: lv.to && iso > lv.to ? iso : lv.to });
            setPick(null);
          }}
        />
      </BottomSheet>
    </AppFrame>
  );
}

const QUESTION: GlyphShape[] = [{ c: [12, 12, 9] }, { p: 'M9.5 9.5a2.5 2.5 0 1 1 3 2.4c-.6.2-.5.8-.5 1.6M12 17h.01' }];
const SUN: GlyphShape[] = [{ c: [12, 12, 4] }, { p: 'M12 3v2M12 19v2M3 12h2M19 12h2' }];
const SUNSET: GlyphShape[] = [{ p: 'M3 18h18M7 18a5 5 0 0 1 10 0' }];
const UNSENT: GlyphShape[] = [{ p: 'M7 18a5 5 0 1 1 1-9.9A6 6 0 0 1 19 10a4 4 0 0 1-1 8z' }, { p: 'M12 11v5M10 13l2-2 2 2' }];
const BY: GlyphShape[] = [{ c: [12, 8, 4] }, { p: 'M4 21c0-4 4-6 8-6s8 2 8 6' }];

const sectionTitle = { fontSize: 17, lineHeight: 22, color: C.ink, paddingTop: 4, paddingHorizontal: 6 };

const pillBtn = {
  minHeight: 60,
  borderRadius: 30,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  paddingHorizontal: 12,
};

const navyBtn = {
  ...pillBtn,
  backgroundColor: C.navy,
  flexDirection: 'row' as const,
  gap: 8,
};

/** The office never took it: refused, or the phone gave up sending it. */
function neverWent(l: LeaveRequest): boolean {
  return l.syncState === 'rejected' || l.syncState === 'failed' || l.syncState === 'blocked';
}

/** One request: what, when, and where it has got to. */
function RequestCard({ l, onWithdraw }: { l: LeaveRequest; onWithdraw?: () => void }) {
  /* Written on this phone and not yet with the office — waiting for signal.
     A REFUSAL IS NOT A WAIT: "goes with signal" over a request the office
     turned down sent him looking for signal that would change nothing. */
  const unsent = l.state === 'Pending' && l.syncState !== 'synced';
  const refused = unsent && neverWent(l);
  const unsentWords = refused
    ? l.syncState === 'rejected'
      ? 'Not accepted by the office'
      : 'Could not send · see Not accepted'
    : 'Not sent yet · goes with signal';
  const decided =
    (l.state === 'Approved' || l.state === 'Rejected') && (l.approverName || l.decidedAt)
      ? [l.approverName ? 'By ' + l.approverName : null, l.decidedAt ? dmy(isoDate(new Date(l.decidedAt))) : null]
          .filter(Boolean)
          .join(' · ')
      : null;

  return (
    <Card style={{ borderRadius: 22 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <T style={[{ flex: 1, minWidth: 0, fontSize: 17, lineHeight: 22, color: C.ink }, weight(800)]}>{l.kind}</T>
        <Badge tone={TONE[l.state] ?? 'neutral'}>{STATE_LABEL[l.state] ?? l.state}</Badge>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}>
        {l.state === 'Pending' ? <Glyph shapes={GLYPH.cal} size={14} color={C.muted} /> : null}
        <T style={{ flex: 1, fontSize: 14, lineHeight: 20, color: C.ink }}>{whenOf(l) + ' · ' + lengthOf(l.days)}</T>
      </View>
      {l.reason ? (
        <T numberOfLines={2} style={{ fontSize: 13, lineHeight: 18, color: C.muted, marginTop: 4 }}>
          {l.reason}
        </T>
      ) : null}

      {decided ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 }}>
          <Glyph shapes={BY} size={14} color={C.muted} />
          <T style={{ flex: 1, fontSize: 12, lineHeight: 16, color: C.muted }}>{decided}</T>
        </View>
      ) : null}
      {l.decisionNote ? (
        <View style={{ marginTop: 6, backgroundColor: C.canvas, borderRadius: 14, paddingVertical: 10, paddingHorizontal: 12 }}>
          <T style={{ fontSize: 14, lineHeight: 20, color: C.body }}>{'“' + l.decisionNote + '”'}</T>
        </View>
      ) : null}

      {unsent || onWithdraw ? (
        <View style={{ marginTop: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {/* Written on this phone and not yet with the office. */}
          {unsent ? (
            <View
              accessible
              accessibilityLabel={refused ? unsentWords + (l.syncMessage ? '. ' + l.syncMessage : '') : 'Not sent yet — it goes when the phone has signal.'}
              style={{ minHeight: 28, paddingHorizontal: 10, borderRadius: 14, backgroundColor: refused ? C.dangerBg : C.warnBg, flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1 }}>
              <Glyph shapes={UNSENT} size={13} color={refused ? C.danger : C.warnInk} strokeWidth={2.2} />
              <T style={[{ fontSize: 12, color: refused ? C.danger : C.warnInk, flexShrink: 1 }, weight(700)]}>{unsentWords}</T>
            </View>
          ) : null}
          <View style={{ flex: 1 }} />
          {onWithdraw ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Withdraw this request"
              onPress={onWithdraw}
              style={({ pressed }) => ({ minHeight: 44, paddingVertical: 6, paddingHorizontal: 16, borderRadius: 22, backgroundColor: C.dangerBg, justifyContent: 'center', opacity: pressed ? 0.85 : 1 })}>
              <T style={[{ fontSize: 13, color: C.danger }, weight(700)]}>Withdraw</T>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}
