import React from 'react';
import { View } from 'react-native';
import { useFocusEffect, router } from 'expo-router';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Card, Divider, Input, Field, PrimaryButton, SecondaryButton, T } from '../src/components/ui/primitives';
import { ConfirmSheet } from '../src/components/ui/overlays';
import { useBoot } from '../src/state/boot';
import { useStore } from '../src/state/store';
import { inr, isoDate } from '../src/lib/format';
import { color as C, weight, tabular } from '../src/theme/tokens';
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
  const back = useCameFrom('day');
  const boot = useBoot();
  const notify = useStore((s) => s.notify);
  const userId = boot.session?.user.id ?? '';
  const day = isoDate(new Date());

  const [priced, setPriced] = React.useState<Awaited<ReturnType<typeof priceDay>> | null>(null);
  const [note, setNote] = React.useState('');
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(() => {
    let live = true;
    void priceDay(userId, day).then((p) => {
      if (live) setPriced(p);
    });
    return () => {
      live = false;
    };
  }, [userId, day]);

  useFocusEffect(load);

  const c = priced?.computation ?? null;
  const locked = priced?.day?.lockedAt != null;
  const noReturn = priced?.day != null && priced.day.returnedAt == null;

  const send = async () => {
    setBusy(true);
    const r = await submitDay(userId, day, note.trim() || null);
    setBusy(false);
    setConfirming(false);
    if (!r.ok) return notify(r.reason ?? 'That could not be sent.');
    notify('Sent to the office.');
    load();
  };

  const line = (label: string, paise: number, sub?: string) => (
    <View key={label} style={{ marginTop: 10 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <T s="small" style={{ color: C.muted }}>{label}</T>
        <T style={[{ fontSize: 16, color: C.ink }, weight(600), tabular]}>{inr(paise / 100)}</T>
      </View>
      {sub ? <T s="caption" style={{ marginTop: 1 }}>{sub}</T> : null}
    </View>
  );

  return (
    <AppFrame title="MBOS" activeTab={null} contentStyle={{ padding: 16, paddingBottom: 32 }}>
      <BackLink label={back.label} onPress={back.go} />
      <T s="h1">Close the day</T>
      <T s="small" style={{ color: C.muted, marginTop: 2, marginBottom: 14 }}>
        Check it, then send it. Once you send it the day is locked and only your manager can reopen
        it.
      </T>

      {!priced?.day ? (
        <Card style={{ paddingVertical: 28 }}>
          <T style={[{ fontSize: 16, color: C.ink, textAlign: 'center' }, weight(600)]}>
            Nothing recorded today
          </T>
          <T s="small" style={{ color: C.muted, textAlign: 'center', marginTop: 4 }}>
            Open your day and add where you went, and this will fill in.
          </T>
          <SecondaryButton label="Your day" style={{ marginTop: 14 }} onPress={() => router.push('/day')} />
        </Card>
      ) : (
        <>
          {priced.reason ? (
            <Card style={{ marginBottom: 12, backgroundColor: C.warnBg }}>
              <T s="small" style={{ color: C.ink }}>{priced.reason}</T>
            </Card>
          ) : null}

          <Card>
            <T style={[{ fontSize: 15, color: C.ink }, weight(600)]}>What today comes to</T>
            {c ? (
              <>
                {line('Travel', c.travelPaise, `${(c.totalMetres / 1000).toFixed(1)} km across ${c.legs.length} ${c.legs.length === 1 ? 'leg' : 'legs'}`)}
                {line(
                  'Food',
                  c.foodPaise,
                  c.dormitoryApplied
                    ? 'The dormitory allowance, instead of the day’s meals'
                    : c.meals.filter((m) => m.earned).map((m) => m.meal).join(', ') || 'nothing earned',
                )}
                {c.lodgingClaimedPaise ? line('Hotel', c.lodgingEligiblePaise) : null}
                {c.otherClaimedPaise ? line('Everything else', c.otherEligiblePaise) : null}

                <Divider style={{ marginVertical: 14 }} />

                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <T s="small" style={{ color: C.muted }}>You claimed</T>
                  <T style={[{ fontSize: 18 }, weight(600), tabular]}>{inr(c.totalClaimedPaise / 100)}</T>
                </View>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 6 }}>
                  <T s="small" style={{ color: C.muted }}>The policy allows</T>
                  <T style={[{ fontSize: 22, color: C.ink }, weight(600), tabular]}>
                    {inr(c.totalEligiblePaise / 100)}
                  </T>
                </View>

                {/* Requirement 41, said here rather than left for month end. */}
                {c.totalExcessPaise > 0 ? (
                  <Card style={{ marginTop: 12, backgroundColor: C.warnBg }}>
                    <T s="small" style={{ color: C.ink }}>
                      {inr(c.totalExcessPaise / 100)} of what you claimed is above what the policy
                      allows. It is still sent — your manager decides it, and can allow it.
                    </T>
                  </Card>
                ) : null}
              </>
            ) : (
              <T s="small" style={{ color: C.muted, marginTop: 8 }}>
                Nothing can be worked out until the office publishes a policy covering today.
                Everything you recorded is kept and will be worked out then.
              </T>
            )}
          </Card>

          {/* The meals he did NOT earn, and why. Silence here is what makes
              somebody think the app lost their breakfast. */}
          {c && c.meals.some((m) => !m.earned) ? (
            <Card style={{ marginTop: 10 }}>
              <T style={[{ fontSize: 14, color: C.ink }, weight(600)]}>Meals not paid today</T>
              {c.meals
                .filter((m) => !m.earned)
                .map((m) => (
                  <T key={m.meal} s="caption" style={{ marginTop: 4 }}>
                    {m.meal[0]!.toUpperCase() + m.meal.slice(1)} — {m.withheldReason}
                  </T>
                ))}
            </Card>
          ) : null}

          {c && c.exceptions.length ? (
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
          ) : null}

          {locked ? (
            <Card style={{ marginTop: 12, backgroundColor: C.warnBg }}>
              <T s="small" style={{ color: C.ink }}>
                Sent. This day is locked — ask your manager if something has to change.
              </T>
            </Card>
          ) : (
            <>
              <Field label="Anything to tell the office">
                <Input value={note} onChangeText={setNote} placeholder="Optional" multiline />
              </Field>
              <PrimaryButton
                label="Send the day in"
                style={{ marginTop: 14 }}
                disabled={busy || noReturn}
                whyDisabled={
                  noReturn
                    ? 'Say what time you got back first — the meal allowance is worked out from it.'
                    : undefined
                }
                onPress={() => setConfirming(true)}
              />
            </>
          )}
        </>
      )}

      <ConfirmSheet
        open={confirming}
        title="Send today in?"
        body={
          c
            ? `You are sending ${inr(c.totalClaimedPaise / 100)}. After this the day is locked and only your manager can reopen it.`
            : 'After this the day is locked and only your manager can reopen it.'
        }
        confirmLabel="Send it"
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
