import React from 'react';
import { Pressable, View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Card, Choice, PrimaryButton, SecondaryButton, T } from '../src/components/ui/primitives';
import { VoiceField } from '../src/components/ui/dictate';
import { BottomSheet, Calendar } from '../src/components/ui/overlays';
import { applyForLeave, listLeave, withdrawLeave, type LeaveRequest } from '../src/data/requests';
import { dmy, isoDate, plural } from '../src/lib/format';
import { useStore } from '../src/state/store';
import { useBoot } from '../src/state/boot';
import { color as C, radius, weight, type BadgeTone } from '../src/theme/tokens';

/**
 * Leave: ask for it, and follow what happened to every request.
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

  const [rows, setRows] = React.useState<LeaveRequest[] | null>(null);
  const [open, setOpen] = React.useState(false);
  const [lv, setLv] = React.useState<Draft>(EMPTY);
  const [err, setErr] = React.useState<'dates' | 'reason' | null>(null);
  /** Which end of the range the calendar is picking, or null for closed. */
  const [pick, setPick] = React.useState<'from' | 'to' | null>(null);
  /* One request per press: the overlap guard reads the table before the first
     insert commits, so it does not catch a double tap. */
  const [sending, setSending] = React.useState(false);

  const load = React.useCallback(() => {
    let live = true;
    void listLeave()
      .then((l) => live && setRows(l))
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

  const dayCount = (() => {
    if (!lv.from) return 0;
    if (lv.span === 'half') return 0.5;
    if (lv.span === 'one') return 1;
    if (!lv.to) return 0;
    const d1 = new Date(lv.from);
    const d2 = new Date(lv.to);
    return Math.max(0, Math.round((d2.getTime() - d1.getTime()) / 86400000) + 1);
  })();

  /* A range cannot end before it starts; the calendar refuses it. */
  const refuseTo = (iso: string) =>
    pick === 'to' && !!lv.from && iso < lv.from ? 'Leave cannot end before it starts' : null;

  const send = async () => {
    if (sending) return;
    if (!lv.from || (lv.span === 'many' && (!lv.to || dayCount < 1))) return setErr('dates');
    if (!lv.reason.trim()) return setErr('reason');

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
      if (!outcome.ok) return notify(outcome.message);

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
      title: 'Withdraw this request?',
      body: l.kind + ' · ' + whenOf(l),
      confirmLabel: 'Withdraw',
      run: () => {
        void withdrawLeave(l.id).then(() => {
          load();
          notify('Request withdrawn');
        });
      },
    });

  const waiting = (rows ?? []).filter((r) => r.state === 'Pending');
  const history = (rows ?? []).filter((r) => r.state !== 'Pending');

  const dateBtn = (active: boolean) => ({
    minHeight: 52,
    justifyContent: 'center' as const,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: active ? C.primary : err === 'dates' ? C.danger : C.border,
    borderRadius: radius.lg,
    backgroundColor: C.surface,
  });

  return (
    <AppFrame title="Leave" activeTab={null} onBack={back.go} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />

      <PrimaryButton
        label="Apply for leave"
        style={{ borderRadius: radius.xl }}
        onPress={() => {
          setLv(EMPTY);
          setErr(null);
          setOpen(true);
        }}
      />

      {rows === null ? null : rows.length === 0 ? (
        <T style={{ fontSize: 15, color: C.muted, textAlign: 'center', marginTop: 32 }}>
          You have not applied for leave yet.
        </T>
      ) : (
        <>
          {waiting.length ? (
            <View style={{ marginTop: 20 }}>
              <T s="label" style={{ marginBottom: 8 }}>
                Waiting for approval
              </T>
              <View style={{ gap: 10 }}>
                {waiting.map((l) => (
                  <RequestCard key={l.id} l={l} onWithdraw={() => withdraw(l)} />
                ))}
              </View>
            </View>
          ) : null}

          {history.length ? (
            <View style={{ marginTop: 20 }}>
              <T s="label" style={{ marginBottom: 8 }}>
                History
              </T>
              <View style={{ gap: 10 }}>
                {history.map((l) => (
                  <RequestCard key={l.id} l={l} />
                ))}
              </View>
            </View>
          ) : null}
        </>
      )}

      {/* ------------------------------------------------------ apply sheet */}
      <BottomSheet open={open} onClose={() => setOpen(false)} scroll>
        <T s="h2">Apply for leave</T>

        <T s="label" style={{ marginTop: 16, marginBottom: 8 }}>
          Type
        </T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {TYPES.map((k) => (
            <Choice key={k} label={k} selected={lv.type === k} onPress={() => patch({ type: k })} />
          ))}
        </View>

        <T s="label" style={{ marginTop: 16, marginBottom: 8 }}>
          How long
        </T>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {SPANS.map(([k, label]) => (
            <Choice
              key={k}
              label={label}
              selected={lv.span === k}
              onPress={() => patch({ span: k, to: k === 'many' ? lv.to : '' })}
              style={{ flex: 1 }}
            />
          ))}
        </View>

        {lv.span === 'half' ? (
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
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
        ) : null}

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T s="label" style={{ marginBottom: 6 }}>
              {lv.span === 'many' ? 'From' : 'Date'}
            </T>
            <Pressable accessibilityRole="button" onPress={() => setPick('from')} style={dateBtn(pick === 'from')}>
              <T style={{ fontSize: 16, color: lv.from ? C.ink : C.muted }}>{lv.from ? dmy(lv.from) : 'Pick a date'}</T>
            </Pressable>
          </View>
          {lv.span === 'many' ? (
            <View style={{ flex: 1, minWidth: 0 }}>
              <T s="label" style={{ marginBottom: 6 }}>
                To
              </T>
              <Pressable accessibilityRole="button" onPress={() => setPick('to')} style={dateBtn(pick === 'to')}>
                <T style={{ fontSize: 16, color: lv.to ? C.ink : C.muted }}>{lv.to ? dmy(lv.to) : 'Pick a date'}</T>
              </Pressable>
            </View>
          ) : null}
        </View>
        {err === 'dates' ? (
          <T style={{ fontSize: 13, color: C.danger, marginTop: 6 }}>
            {lv.span === 'many' ? 'Pick both dates.' : 'Pick the date.'}
          </T>
        ) : dayCount > 0 && lv.span === 'many' ? (
          <T s="caption" style={{ marginTop: 6 }}>
            {lengthOf(dayCount)}
          </T>
        ) : null}

        <T s="label" style={{ marginTop: 16, marginBottom: 6 }}>
          Reason
        </T>
        <VoiceField
          value={lv.reason}
          onChangeText={(v) => patch({ reason: v })}
          invalid={err === 'reason'}
          placeholder="Sister's wedding in Amravati"
        />
        {err === 'reason' ? (
          <T style={{ fontSize: 13, color: C.danger, marginTop: 6 }}>Add a reason.</T>
        ) : null}

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
          <SecondaryButton label="Cancel" onPress={() => setOpen(false)} style={{ flex: 1 }} />
          <PrimaryButton
            label={sending ? 'Sending…' : 'Send'}
            onPress={send}
            disabled={sending}
            whyDisabled="Sending your request."
            style={{ flex: 1 }}
          />
        </View>
      </BottomSheet>

      {/* --------------------------------------------------- date calendar */}
      <BottomSheet open={!!pick} onClose={() => setPick(null)}>
        <T s="h3" style={{ marginBottom: 10 }}>
          {pick === 'to' ? 'Last day' : lv.span === 'many' ? 'First day' : 'Date'}
        </T>
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
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 8 }}>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              const iso = isoDate(new Date());
              const refusal = refuseTo(iso);
              if (refusal) return notify(refusal + '.');
              if (pick === 'to') patch({ to: iso });
              else patch({ from: iso, to: lv.to && iso > lv.to ? iso : lv.to });
              setPick(null);
            }}
            style={{ minHeight: 48, justifyContent: 'center', paddingHorizontal: 10 }}>
            <T style={[{ fontSize: 14, color: C.primary }, weight(600)]}>Today</T>
          </Pressable>
        </View>
      </BottomSheet>
    </AppFrame>
  );
}

/** One request: what, when, and where it has got to. */
function RequestCard({ l, onWithdraw }: { l: LeaveRequest; onWithdraw?: () => void }) {
  /* Written on this phone and not yet with the office — waiting for signal. */
  const unsent = l.state === 'Pending' && l.syncState !== 'synced';
  const decided =
    (l.state === 'Approved' || l.state === 'Rejected') && (l.approverName || l.decidedAt)
      ? [l.approverName ? 'By ' + l.approverName : null, l.decidedAt ? dmy(isoDate(new Date(l.decidedAt))) : null]
          .filter(Boolean)
          .join(' · ')
      : null;

  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <T style={[{ flex: 1, minWidth: 0, fontSize: 15, color: C.ink }, weight(600)]}>{l.kind}</T>
        <Badge tone={TONE[l.state] ?? 'neutral'}>{STATE_LABEL[l.state] ?? l.state}</Badge>
      </View>
      <T style={{ fontSize: 14, color: C.ink, marginTop: 4 }}>{whenOf(l) + ' · ' + lengthOf(l.days)}</T>
      {l.reason ? (
        <T s="caption" numberOfLines={2} style={{ marginTop: 2 }}>
          {l.reason}
        </T>
      ) : null}

      {unsent ? (
        <T s="caption" style={{ marginTop: 8, color: C.warnInk }}>
          Not sent yet — it goes when the phone has signal.
        </T>
      ) : null}
      {decided ? (
        <T s="caption" style={{ marginTop: 8 }}>
          {decided}
        </T>
      ) : null}
      {l.decisionNote ? (
        <T style={{ fontSize: 14, color: C.body, marginTop: 4 }}>{'“' + l.decisionNote + '”'}</T>
      ) : null}

      {onWithdraw ? (
        <Pressable
          accessibilityRole="button"
          onPress={onWithdraw}
          hitSlop={8}
          style={{ minHeight: 44, justifyContent: 'center', marginTop: 4, alignSelf: 'flex-start' }}>
          <T style={[{ fontSize: 14, color: C.danger }, weight(500)]}>Withdraw</T>
        </Pressable>
      ) : null}
    </Card>
  );
}
