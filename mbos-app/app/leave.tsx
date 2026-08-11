import React from 'react';
import { Pressable, View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import {
  Badge,
  Card,
  Choice,
  Input,
  ListCard,
  PrimaryButton,
  SecondaryButton,
  T,
} from '../src/components/ui/primitives';
import { BottomSheet, Calendar } from '../src/components/ui/overlays';
import { applyForLeave, leaveBalances, listLeave, withdrawLeave, type LeaveRequest } from '../src/data/requests';
import { dmy, isoDate, plural } from '../src/lib/format';
import { useStore } from '../src/state/store';
import { useBoot } from '../src/state/boot';
import { color as C, radius, weight, tabular, type BadgeTone } from '../src/theme/tokens';

/**
 * Leave — and the consequence of asking for it, stated before it is sent.
 *
 * The line under the day count is the whole screen: a man with two casual days
 * left asking for four is told that two of them come off his salary while he
 * can still change his mind, rather than a fortnight later on a payslip.
 *
 * The overlap check is the server's rule run locally: a second request for a
 * day already asked for is not a second day off, it is a deduction taken
 * twice, so `applyForLeave` refuses it and the sentence it refuses with is
 * shown as written.
 */

const SPANS: [string, string][] = [
  ['half', 'Half day'],
  ['one', 'One day'],
  ['many', 'More than a day'],
];

const HALVES: [string, string, string][] = [
  ['Morning', 'First half', '9:30 am – 1:30 pm'],
  ['Afternoon', 'Second half', '1:30 pm – 6:00 pm'],
];

const LV_NOTE = 'A day off during the week needs 48 hours notice unless it is sick leave.';

/** Unpaid leave has no balance to spend, so it is never in `leave_balances`. */
const LOSS_OF_PAY = 'Loss of pay';

type Balance = { kind: string; entitled: number; used: number; available: number };
type Draft = { type: string; span: string; half: string; from: string; to: string; reason: string };

const EMPTY: Draft = { type: 'Casual', span: 'one', half: 'Morning', from: '', to: '', reason: '' };

export default function LeaveScreen() {
  const back = useCameFrom('more');
  const askConfirm = useStore((s) => s.askConfirm);
  const notify = useStore((s) => s.notify);
  const boot = useBoot();

  const [rows, setRows] = React.useState<LeaveRequest[]>([]);
  const [balances, setBalances] = React.useState<Balance[]>([]);
  const [open, setOpen] = React.useState(false);
  const [lv, setLv] = React.useState<Draft>(EMPTY);
  const [err, setErr] = React.useState<'dates' | 'reason' | null>(null);
  /** Which end of the range the calendar sheet is picking, or null for closed. */
  const [pick, setPick] = React.useState<'from' | 'to' | null>(null);

  const load = React.useCallback(() => {
    let live = true;
    void Promise.all([listLeave(), leaveBalances()]).then(([l, b]) => {
      if (!live) return;
      setRows(l);
      setBalances(b);
    });
    return () => {
      live = false;
    };
  }, []);

  useFocusEffect(load);

  const patch = (p: Partial<Draft>) => {
    setLv((d) => ({ ...d, ...p }));
    setErr(null);
  };

  const span = lv.span;
  const halfHours = (HALVES.find((h) => h[0] === lv.half) ?? HALVES[0])[2];

  /* Days, and what it leaves — the consequence stated before it is sent, not after. */
  const dayCount = (() => {
    if (!lv.from) return 0;
    if (span === 'half') return 0.5;
    if (span === 'one') return 1;
    if (!lv.to) return 0;
    const d1 = new Date(lv.from);
    const d2 = new Date(lv.to);
    return Math.max(0, Math.round((d2.getTime() - d1.getTime()) / 86400000) + 1);
  })();

  const kinds = [...balances.map((b) => b.kind), LOSS_OF_PAY];
  const chosen = balances.find((b) => b.kind === lv.type) ?? null;
  const left = lv.type === LOSS_OF_PAY ? null : (chosen?.available ?? 0);

  const daysLine = !dayCount
    ? span === 'many'
      ? 'Pick both dates'
      : 'Pick the day'
    : dayCount === 0.5
      ? 'Half a day · ' + halfHours
      : plural(dayCount, 'day');

  const afterLine =
    left == null
      ? 'Unpaid. It comes off this month’s salary.'
      : dayCount
        ? dayCount > left
          ? 'You have ' + left + ' left — ' + plural(dayCount - left, 'day') + ' of this goes unpaid.'
          : left - dayCount + ' would be left after this.'
        : left + ' available.';

  const afterWarn = (left != null && dayCount > left) || left == null;

  const send = async () => {
    if (!lv.from || (span === 'many' && (!lv.to || dayCount < 1))) return setErr('dates');
    if (!lv.reason.trim()) return setErr('reason');

    const outcome = await applyForLeave({
      userId: boot.session?.user.id ?? '',
      kind: lv.type,
      span: span as 'half' | 'one' | 'many',
      fromDate: lv.from,
      toDate: span === 'many' ? lv.to : null,
      half: span === 'half' ? (lv.half as 'Morning' | 'Afternoon') : null,
      reason: lv.reason.trim(),
    });

    /* An overlap is refused with the engine's own sentence — it names the
       request it clashes with, which is the only useful thing to say. */
    if (!outcome.ok) return notify(outcome.message);

    const when =
      span === 'half'
        ? dmy(lv.from) + ' · ' + halfHours
        : span === 'one'
          ? dmy(lv.from)
          : dmy(lv.from) + ' – ' + dmy(lv.to);

    setOpen(false);
    setLv(EMPTY);
    setErr(null);
    load();
    notify(outcome.unpaidSentence ? 'Sent to your manager · ' + outcome.unpaidSentence : 'Sent to your manager · ' + when);
  };

  const dateBtnStyle = (active: boolean) => ({
    width: '100%' as const,
    minHeight: 52,
    justifyContent: 'center' as const,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: active ? C.primary : err === 'dates' ? C.danger : C.border,
    borderRadius: radius.lg,
    backgroundColor: C.surface,
  });

  /** "18–19 Aug", or the single day, from the two stored dates. */
  const whenOf = (l: LeaveRequest) =>
    l.fromDate === l.toDate
      ? dmy(l.fromDate) + (l.halfDay ? ' · ' + (HALVES.find((h) => h[0] === l.halfDay) ?? HALVES[0])[2] : '')
      : dmy(l.fromDate) + ' – ' + dmy(l.toDate);

  return (
    <AppFrame title="MBOS" activeTab={null} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />
      <T s="h1">Leave</T>

      <Card padded={false} style={{ marginTop: 12, flexDirection: 'row' }}>
        {balances.map((b) => (
          <View key={b.kind} style={{ flex: 1, minWidth: 0, padding: 14 }}>
            <T s="label">{b.kind}</T>
            <T
              style={[
                { fontSize: 22, lineHeight: 28, marginVertical: 2, color: b.available <= 2 ? C.warn : C.ink },
                weight(600),
                tabular,
              ]}>
              {String(b.available)}
            </T>
            <T s="micro">{'of ' + b.entitled + ' left'}</T>
          </View>
        ))}
      </Card>

      <PrimaryButton
        label="Apply for leave"
        style={{ marginTop: 12, borderRadius: radius.xl }}
        onPress={() => {
          setLv({ ...EMPTY, type: balances[0]?.kind ?? LOSS_OF_PAY });
          setErr(null);
          setOpen(true);
        }}
      />
      <T s="caption" style={{ marginTop: 10 }}>
        {LV_NOTE}
      </T>

      <ListCard style={{ marginTop: 16 }}>
        {rows.map((l, i) => {
          const tone: BadgeTone = l.state === 'Approved' ? 'success' : l.state === 'Pending' ? 'amber' : 'danger';
          return (
            <View
              key={l.id}
              style={{ paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: i ? 1 : 0, borderTopColor: C.wash }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <T style={[{ flex: 1, minWidth: 0, fontSize: 15, lineHeight: 20, color: C.ink }, weight(500)]}>
                  {l.kind}
                </T>
                <Badge tone={tone}>{l.state}</Badge>
              </View>
              <T s="small" style={{ color: C.ink, marginTop: 4 }}>
                {whenOf(l) + ' · ' + plural(l.days, 'day')}
              </T>
              <T s="caption" style={{ marginTop: 2 }}>
                {l.reason}
              </T>
              {l.state === 'Pending' ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() =>
                    askConfirm({
                      title: 'Withdraw this request?',
                      body: l.kind + ' · ' + whenOf(l) + '. Your manager is told it is no longer needed.',
                      confirmLabel: 'Withdraw it',
                      run: () => {
                        void withdrawLeave(l.id).then(() => {
                          load();
                          notify('Withdrawn · ' + whenOf(l));
                        });
                      },
                    })
                  }
                  style={{ minHeight: 48, justifyContent: 'center', marginTop: 6 }}>
                  <T style={[{ fontSize: 14, color: C.danger }, weight(500)]}>Withdraw</T>
                </Pressable>
              ) : null}
            </View>
          );
        })}
      </ListCard>

      {/* ------------------------------------------------------ apply sheet */}
      <BottomSheet open={open} onClose={() => setOpen(false)} scroll>
        <T s="h2">Apply for leave</T>
        <T s="small" style={{ color: C.muted, marginTop: 2 }}>
          Your manager sees this straight away.
        </T>

        <View style={{ marginTop: 16 }}>
          <T s="label" style={{ marginBottom: 8 }}>
            Which type
          </T>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {kinds.map((k) => {
              const b = balances.find((x) => x.kind === k);
              return (
                <Choice
                  key={k}
                  label={k}
                  sub={b ? b.available + ' left' : 'Unpaid'}
                  selected={lv.type === k}
                  onPress={() => patch({ type: k })}
                  style={{ flex: 1 }}
                />
              );
            })}
          </View>
        </View>

        <View style={{ marginTop: 16 }}>
          <T s="label" style={{ marginBottom: 8 }}>
            How long
          </T>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {SPANS.map(([k, label]) => (
              <Choice
                key={k}
                label={label}
                selected={span === k}
                onPress={() => patch({ span: k, to: k === 'many' ? lv.to : '' })}
                style={{ flex: 1 }}
              />
            ))}
          </View>
        </View>

        {span === 'half' ? (
          <View style={{ marginTop: 14 }}>
            <T s="label" style={{ marginBottom: 8 }}>
              Which half
            </T>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {HALVES.map(([k, label, hours]) => (
                <Choice
                  key={k}
                  label={label}
                  sub={hours}
                  selected={lv.half === k}
                  onPress={() => patch({ half: k })}
                  style={{ flex: 1 }}
                />
              ))}
            </View>
          </View>
        ) : null}

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T s="label" style={{ marginBottom: 6 }}>
              {span === 'many' ? 'From' : 'Which day'}
            </T>
            <Pressable accessibilityRole="button" onPress={() => setPick('from')} style={dateBtnStyle(pick === 'from')}>
              <T style={{ fontSize: 16, color: lv.from ? C.ink : C.muted }}>{lv.from ? dmy(lv.from) : 'Pick a date'}</T>
            </Pressable>
          </View>
          {span === 'many' ? (
            <View style={{ flex: 1, minWidth: 0 }}>
              <T s="label" style={{ marginBottom: 6 }}>
                To
              </T>
              <Pressable accessibilityRole="button" onPress={() => setPick('to')} style={dateBtnStyle(pick === 'to')}>
                <T style={{ fontSize: 16, color: lv.to ? C.ink : C.muted }}>{lv.to ? dmy(lv.to) : 'Pick a date'}</T>
              </Pressable>
            </View>
          ) : null}
        </View>
        {err === 'dates' ? (
          <T style={{ fontSize: 13, color: C.danger, marginTop: 6 }}>Pick the day this leave is for.</T>
        ) : null}

        <View style={{ backgroundColor: C.wash, borderRadius: radius.lg, paddingHorizontal: 14, paddingVertical: 12, marginTop: 14 }}>
          <T style={[{ fontSize: 15, lineHeight: 20, color: C.ink }, weight(600)]}>{daysLine}</T>
          <T style={{ fontSize: 14, lineHeight: 20, marginTop: 8, color: afterWarn ? C.warnInk : C.muted }}>{afterLine}</T>
        </View>

        <View style={{ marginTop: 14 }}>
          <T s="label" style={{ marginBottom: 6 }}>
            Why
          </T>
          <Input
            value={lv.reason}
            onChangeText={(v) => patch({ reason: v })}
            multiline
            invalid={err === 'reason'}
            placeholder="Sister's wedding in Amravati"
          />
          {err === 'reason' ? (
            <T style={{ fontSize: 13, color: C.danger, marginTop: 6 }}>
              Your manager approves on the reason — say what it is.
            </T>
          ) : null}
        </View>

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
          <SecondaryButton label="Cancel" onPress={() => setOpen(false)} style={{ flex: 1 }} />
          <PrimaryButton label="Send request" onPress={send} style={{ flex: 1 }} />
        </View>
      </BottomSheet>

      {/* --------------------------------------------------- date calendar */}
      <BottomSheet open={!!pick} onClose={() => setPick(null)}>
        <T s="h3" style={{ marginBottom: 10 }}>
          {pick === 'to' ? 'Last day of leave' : 'First day of leave'}
        </T>
        <Calendar
          key={pick ?? 'from'}
          selected={pick === 'to' ? lv.to : lv.from}
          rangeFrom={lv.from}
          rangeTo={lv.to}
          onPick={(iso) => {
            if (pick === 'to') patch({ to: iso });
            /* A start after the end is not a range — carry the end with it. */
            else patch({ from: iso, to: lv.to && iso > lv.to ? iso : lv.to });
            setPick(null);
          }}
        />
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            marginTop: 8,
            paddingTop: 10,
            borderTopWidth: 1,
            borderTopColor: C.hairline,
          }}>
          <View style={{ flex: 1 }} />
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              const iso = isoDate(new Date());
              if (pick === 'to') patch({ to: iso });
              else patch({ from: iso, to: lv.to && iso > lv.to ? iso : lv.to });
              setPick(null);
            }}
            style={{ minHeight: 48, justifyContent: 'center', paddingHorizontal: 10 }}>
            <T style={[{ fontSize: 14, color: C.primary }, weight(600)]}>Today</T>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => setPick(null)}
            style={{ minHeight: 48, justifyContent: 'center', paddingHorizontal: 10 }}>
            <T style={{ fontSize: 14, color: C.muted }}>Done</T>
          </Pressable>
        </View>
      </BottomSheet>
    </AppFrame>
  );
}
