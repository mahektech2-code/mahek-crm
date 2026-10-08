import React from 'react';
import { View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Card, Divider, Input, Field, PrimaryButton, SecondaryButton, T } from '../src/components/ui/primitives';
import { ConfirmSheet } from '../src/components/ui/overlays';
import { useBoot } from '../src/state/boot';
import { useStore } from '../src/state/store';
import { dmy, inrFromPaise, isoDate } from '../src/lib/format';
import { CountUp, Stagger, Swap } from '../src/components/ui/motion';
import { color as C, weight, tabular, type as typeScale } from '../src/theme/tokens';
import { priceDay, submitDay } from '../src/data/travel';

/**
 * Closing the day.
 *
 * §J — the summary he checks, and the send that locks it. Everything above the
 * button is a total he can recognise; nothing below it is a surprise.
 *
 * **Sending it LOCKS the day**, and the screen says so before he presses
 * rather than after. That is requirement 54, and it is only fair if he is
 * warned: a correction afterwards needs his manager, which is a phone call he
 * would rather not have to make because a screen was coy.
 *
 * **Anything outside policy is shown here, not hidden until the office sees
 * it.** A salesman who finds out at month end that ₹700 of his hotel bill was
 * never going to be paid has been let down by this screen, not by the policy.
 */
export default function EodScreen() {
  const back = useCameFrom('journey');
  const boot = useBoot();
  const notify = useStore((s) => s.notify);
  const userId = boot.session?.user.id ?? '';
  /* ONE reading of the clock for the life of the screen. Read in the component
     body it re-derived on every render, so a day that rolled over while the
     sheet was open silently re-triggered the load against a different date —
     and the React Compiler rules forbid it outright. */
  const today = React.useMemo(() => isoDate(new Date()), []);
  /* An EARLIER day can be closed too. This screen used to close today and
     nothing else, so a claim made for yesterday — or on a day he forgot to
     close — was stored at the office and could never be sent from the phone.
     Expenses links here with `?day=` for each one still open. A malformed or
     future date falls back to today rather than opening a day nobody chose. */
  const asked = useLocalSearchParams<{ day?: string }>().day;
  const day = asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) && asked <= today ? asked : today;
  const isPast = day < today;
  const dayWord = isPast ? dmy(day) : 'today';

  /** Null means the read has not landed. That is NOT "nothing recorded today",
   *  which is what this screen used to say while it was still reading. */
  const [priced, setPriced] = React.useState<Awaited<ReturnType<typeof priceDay>> | null>(null);
  const [readFailed, setReadFailed] = React.useState(false);
  const [note, setNote] = React.useState('');
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(() => {
    let live = true;
    setReadFailed(false);
    void priceDay(userId, day)
      .then((p) => {
        if (live) setPriced(p);
      })
      /* "Reading…" that never resolves reads as a broken handset. */
      .catch(() => {
        if (live) setReadFailed(true);
      });
    return () => {
      live = false;
    };
  }, [userId, day]);

  useFocusEffect(load);

  const c = priced?.computation ?? null;
  const locked = priced?.day?.lockedAt != null;
  const noReturn = priced?.day != null && priced.day.returnedAt == null;
  /* Only TODAY can still be punched out of. A past day with no return time is
     sent without one — see `submitDay` — and says what that costs. */
  const blockedOnReturn = noReturn && !isPast;

  /**
   * The lock is a REF, and the sheet closes before the await rather than after.
   *
   * `ConfirmSheet` draws a plain `PrimaryButton` with no disabled state, and it
   * stayed up, unchanged and still pressable, for the whole of the write —
   * `setConfirming(false)` only ran once `submitDay` had returned. `submitDay`
   * re-reads the day before it checks `lockedAt`, so two overlapping calls both
   * read `lockedAt === null` and both enqueue a claim: two claims for one day
   * reach the office, the day locks, and only his manager can unpick it.
   *
   * A `busy` flag alone would not have held it — two taps inside one frame both
   * read a `busy` React has not re-rendered yet. The ref is set synchronously.
   * `busy` still disables the button underneath, which is what he is looking at
   * once the sheet has gone.
   */
  const sending = React.useRef(false);

  const send = async () => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setConfirming(false);
    try {
      const r = await submitDay(userId, day, note.trim() || null);
      if (!r.ok) return notify(r.reason ?? 'Not sent. Try again.', 'error');
      notify('Sent to the office.');
      load();
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  const line = (label: string, paise: number, sub?: string) => (
    <View key={label} style={{ marginTop: 10 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <T s="small" style={{ color: C.muted }}>{label}</T>
        <T style={[{ fontSize: 16, color: C.ink }, weight(600), tabular]}>{inrFromPaise(paise)}</T>
      </View>
      {sub ? <T s="caption" style={{ marginTop: 1 }}>{sub}</T> : null}
    </View>
  );

  return (
    <AppFrame title="MBOS" activeTab={null} contentStyle={{ padding: 16, paddingBottom: 32 }}>
      <BackLink label={back.label} onPress={back.go} />
      <T s="h1">{isPast ? 'Close ' + dmy(day) : 'Close the day'}</T>
      <T s="small" style={{ color: C.muted, marginTop: 2, marginBottom: 14 }}>
        Check it, then send it. After you send it, the day is locked. Only your manager can open it
        again.
      </T>

      {priced === null ? (
        /* Still reading, which is a different fact from nothing recorded — and
           the two looked identical. He opens this after a full day on the road,
           reads "Nothing recorded today", takes the button underneath it and
           leaves the screen. */
        <Card style={{ paddingVertical: 28 }}>
          <T s="small" style={{ color: C.muted, textAlign: 'center' }}>
            {readFailed
              ? (isPast ? 'This day' : 'Today') + ' did not load. Come back to this screen to try again.'
              : 'Loading…'}
          </T>
        </Card>
      ) : !priced.day ? (
        <Card style={{ paddingVertical: 28 }}>
          <T style={[{ fontSize: 16, color: C.ink, textAlign: 'center' }, weight(600)]}>
            {'Nothing saved for ' + dayWord}
          </T>
          {isPast ? null : (
            <T s="small" style={{ color: C.muted, textAlign: 'center', marginTop: 4 }}>
              Punch in from Home. This will fill in as you travel.
            </T>
          )}
        </Card>
      ) : (
        <>
          {priced.reason ? (
            <Card style={{ marginBottom: 12, backgroundColor: C.warnBg }}>
              <T s="small" style={{ color: C.ink }}>{priced.reason}</T>
            </Card>
          ) : null}

          <Card>
            <T style={[{ fontSize: 15, color: C.ink }, weight(600)]}>
              {isPast ? 'Total for ' + dmy(day) : 'Today’s total'}
            </T>
            {c ? (
              <>
                {line('Travel', c.travelPaise, `${(c.totalMetres / 1000).toFixed(1)} km in ${c.legs.length} ${c.legs.length === 1 ? 'trip' : 'trips'}`)}
                {line(
                  'Food',
                  c.foodPaise,
                  c.dormitoryApplied
                    ? 'Dormitory allowance, in place of meals'
                    : c.meals.filter((m) => m.earned).map((m) => m.meal).join(', ') || 'nothing',
                )}
                {c.lodgingClaimedPaise ? line('Hotel', c.lodgingEligiblePaise) : null}
                {c.otherClaimedPaise ? line('Other costs', c.otherEligiblePaise) : null}

                <Divider style={{ marginVertical: 14 }} />

                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <T s="small" style={{ color: C.muted }}>You claimed</T>
                  <T style={[{ fontSize: 18 }, weight(600), tabular]}>{inrFromPaise(c.totalClaimedPaise)}</T>
                </View>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 6 }}>
                  <T s="small" style={{ color: C.muted }}>The policy allows</T>
                  {/* The figure the whole screen is checked against. It counts
                      up when the day is priced so the total reads as the sum
                      of the lines above it arriving, and counts again if a
                      revisit re-prices it — not from zero, which would make
                      every visit look like a fresh calculation. */}
                  <CountUp
                    value={c.totalEligiblePaise}
                    format={(n) => inrFromPaise(Math.round(n))}
                    style={[typeScale.body, { fontSize: 22, color: C.ink }, weight(600), tabular]}
                  />
                </View>

                {/* Requirement 41, said here rather than left for month end. */}
                {c.totalExcessPaise > 0 ? (
                  <Card style={{ marginTop: 12, backgroundColor: C.warnBg }}>
                    <T s="small" style={{ color: C.ink }}>
                      {inrFromPaise(c.totalExcessPaise)} of your claim is above the policy limit.
                      It is still sent. Your manager will decide, and can allow it.
                    </T>
                  </Card>
                ) : null}
              </>
            ) : (
              <T s="small" style={{ color: C.muted, marginTop: 8 }}>
                {'The office has not set a policy for ' + dayWord + ' yet.'} So nothing can be worked out now.
                Everything you added is saved. It will be worked out later.
              </T>
            )}
          </Card>

          {/* The meals he did NOT earn, and why. Silence here is what makes
              somebody think the app lost their breakfast. */}
          {c && c.meals.some((m) => !m.earned) ? (
            <Stagger index={1}>
            <Card style={{ marginTop: 10 }}>
              <T style={[{ fontSize: 14, color: C.ink }, weight(600)]}>{'Meals not paid ' + (isPast ? 'on ' + dmy(day) : 'today')}</T>
              {c.meals
                .filter((m) => !m.earned)
                .map((m) => (
                  <T key={m.meal} s="caption" style={{ marginTop: 4 }}>
                    {m.meal[0]!.toUpperCase() + m.meal.slice(1)} — {m.withheldReason}
                  </T>
                ))}
            </Card>
            </Stagger>
          ) : null}

          {c && c.exceptions.length ? (
            <Stagger index={2}>
            <Card style={{ marginTop: 10 }}>
              <T style={[{ fontSize: 14, color: C.ink }, weight(600)]}>Your manager will see</T>
              {c.exceptions.map((e, i) => (
                <View key={i} style={{ marginTop: 6, flexDirection: 'row', alignItems: 'flex-start' }}>
                  <Badge tone={e.severity === 'block_route' ? 'danger' : 'amber'} style={{ marginRight: 8 }}>
                    {e.severity === 'block_route' ? 'Needs proof' : 'Question'}
                  </Badge>
                  <T s="caption" style={{ flex: 1 }}>{e.message}</T>
                </View>
              ))}
            </Card>
            </Stagger>
          ) : null}

          {/* Sending turns the form into the locked notice in the same place —
              one state replacing another, so it reads as the day closing
              rather than as the form vanishing. The toast already buzzes. */}
          <Swap id={locked ? 'locked' : 'open'}>
          {locked ? (
            <Card style={{ marginTop: 12, backgroundColor: C.warnBg }}>
              <T s="small" style={{ color: C.ink }}>
                Sent. This day is locked. Ask your manager if something must change.
              </T>
            </Card>
          ) : (
            <>
              <Field label="Anything to tell the office">
                <Input value={note} onChangeText={setNote} placeholder="Optional" multiline />
              </Field>
              {noReturn && isPast ? (
                <Card style={{ marginTop: 12, backgroundColor: C.warnBg }}>
                  <T s="small" style={{ color: C.ink }}>
                    You did not punch out on this day, so no meals can be worked out for it. Your
                    bills and travel are still sent.
                  </T>
                </Card>
              ) : null}
              <PrimaryButton
                label="Send day"
                style={{ marginTop: 14 }}
                disabled={busy || blockedOnReturn}
                whyDisabled={
                  blockedOnReturn
                    ? 'Punch out first. Your food allowance is worked out from the time you punch out.'
                    : undefined
                }
                onPress={() => setConfirming(true)}
              />
              {/* THE ONLY THING THAT WRITES THE TIME HE GOT BACK IS THE
                  PUNCH-OUT, so the way past the disabled button is the
                  punch-out itself — through Home's, which asks for the same
                  photograph wherever it starts. This screen used to ask him to
                  "add the time you got back" with nothing on it that could. */}
              {blockedOnReturn ? (
                <SecondaryButton
                  label="Punch out · photo"
                  style={{ marginTop: 10 }}
                  onPress={() => router.replace('/home?punchOut=1')}
                />
              ) : null}
            </>
          )}
          </Swap>
        </>
      )}

      <ConfirmSheet
        open={confirming}
        title={isPast ? 'Send ' + dmy(day) + '?' : 'Send today?'}
        body={
          c
            ? `You are sending ${inrFromPaise(c.totalClaimedPaise)}. After this the day is locked. Only your manager can open it again.`
            : 'After this the day is locked. Only your manager can open it again.'
        }
        confirmLabel="Send"
        /* The sheet can ask for a reason; sending a day needs none — he is not
           explaining anything, he is finishing. The note above is his to leave
           or not. */
        reason={note}
        onReason={setNote}
        error={false}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void send()}
      />
    </AppFrame>
  );
}
