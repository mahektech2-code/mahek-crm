import React from 'react';
import { View } from 'react-native';
import { useFocusEffect, router } from 'expo-router';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Card, ListCard, PrimaryButton, SecondaryButton, T } from '../src/components/ui/primitives';
import { useBoot } from '../src/state/boot';
import { hhmm, inrFromPaise, isoDate } from '../src/lib/format';
import { CountUp, Stagger } from '../src/components/ui/motion';
import { color as C, weight, tabular, type as typeScale } from '../src/theme/tokens';
import { priceDay, travelModes, type TravelMode } from '../src/data/travel';

/**
 * Where you went today, and what it is worth. A RECORD, not a form.
 *
 * Mahek's decision is that travel is asked twice a day and nowhere else: how he
 * travels at punch-in, the meter at punch-out, and every fare or cost through
 * Expenses. This screen predated that and kept an "Add a leg" sheet of its own
 * — mode, from and to, both meter readings, a photograph, a ticket and its PNR
 * — which made it a third door for exactly the questions the other two were
 * built to be the only ones asking. A fare typed here and the same fare claimed
 * in Expenses were two claims for one ticket, and nothing on either screen
 * could see the other.
 *
 * So it reads. The legs the day recorded on its own — the session's meter
 * pair and each visit's journey — are listed with what each is worth, and the
 * one thing a salesman still has to SAY about money is one tap away, on the
 * screen that asks it.
 *
 * **The reimbursement is never typed and never worked out by the salesman.**
 * The policy engine runs on this phone so the amount appears beside the leg; a
 * figure he calculates himself is a figure he argues about at month end.
 */
const PURPOSES: Record<string, string> = {
  visit: 'Visit',
  collection: 'Collection',
  complaint: 'Complaint',
  new_customer: 'New customer',
  delivery: 'Delivery',
  other: 'Other',
};

const km = (metres: number | null) => (metres == null ? '—' : `${(metres / 1000).toFixed(1)} km`);

export default function TravelScreen() {
  const back = useCameFrom('more');
  const boot = useBoot();
  const userId = boot.session?.user.id ?? '';
  const day = isoDate(new Date());

  const [priced, setPriced] = React.useState<Awaited<ReturnType<typeof priceDay>> | null>(null);
  const [modes, setModes] = React.useState<TravelMode[]>([]);

  const load = React.useCallback(() => {
    let live = true;
    void Promise.all([priceDay(userId, day), travelModes()]).then(([p, m]) => {
      if (!live) return;
      setPriced(p);
      setModes(m);
    });
    return () => {
      live = false;
    };
  }, [userId, day]);

  useFocusEffect(load);

  const locked = priced?.day?.lockedAt != null;
  const computation = priced?.computation ?? null;
  const legs = priced?.legs ?? [];

  return (
    <AppFrame title="MBOS" activeTab={null} contentStyle={{ padding: 16, paddingBottom: 32 }}>
      <BackLink label={back.label} onPress={back.go} />
      <T s="h1">Today&apos;s travel</T>
      <T s="small" style={{ color: C.muted, marginTop: 2, marginBottom: 14 }}>
        Filled in from your punch-in, your punch-out and your visits. You do not work out the money.
        It comes from the office policy.
      </T>

      {priced?.reason ? (
        <Card style={{ marginBottom: 12, backgroundColor: C.warnBg }}>
          <T s="small" style={{ color: C.ink }}>{priced.reason}</T>
        </Card>
      ) : null}

      {computation ? (
        <Card style={{ marginBottom: 12 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <T s="small" style={{ color: C.muted }}>Travel today</T>
            {/* Counts only when a revisit re-prices the day — a visit's leg
                landing since he last looked shows as the figure rising. */}
            <CountUp
              value={computation.travelPaise}
              format={(n) => inrFromPaise(Math.round(n))}
              style={[typeScale.body, { fontSize: 22, color: C.ink }, weight(600), tabular]}
            />
          </View>
          <T s="caption" style={{ marginTop: 2 }}>
            {km(computation.totalMetres)} in {computation.legs.length}{' '}
            {computation.legs.length === 1 ? 'trip' : 'trips'}
          </T>
        </Card>
      ) : null}

      {/* Said rather than drawn as an empty list: before the first punch-in
          there is nothing to record, and a blank screen reads as a broken one. */}
      {priced && !legs.length ? (
        <Card style={{ marginBottom: 12 }}>
          <T s="small" style={{ color: C.ink }}>No travel recorded today yet.</T>
          <T s="caption" style={{ marginTop: 4 }}>
            It starts when you punch in and say how you are travelling, and each visit adds its
            journey on its own.
          </T>
        </Card>
      ) : null}

      {legs.map((leg, i) => {
        const c = computation?.legs.find((l) => l.legId === leg.id) ?? null;
        const zero = c != null && c.eligiblePaise === 0 && c.chosenMetres != null;
        const modeLabel = modes.find((m) => m.key === leg.modeKey)?.label ?? leg.modeKey;
        const purposeLabel = leg.purpose ? (PURPOSES[leg.purpose] ?? leg.purpose) : null;
        /* Neither place is guaranteed, so a title of "? → ?" is avoided: the
           mode and the reason are what IS known about a journey with none. */
        const where =
          leg.fromLabel && leg.toLabel
            ? leg.fromLabel + ' → ' + leg.toLabel
            : leg.toLabel
              ? 'To ' + leg.toLabel
              : leg.fromLabel
                ? 'From ' + leg.fromLabel
                : null;
        const title = where ?? [modeLabel, purposeLabel].filter(Boolean).join(' · ');
        const when = leg.startedAt != null ? hhmm(leg.startedAt) : null;
        const caption = [when, where ? modeLabel : null, where ? purposeLabel : null]
          .filter(Boolean)
          .join(' · ');
        return (
          <Stagger key={leg.id} index={i}>
          <ListCard style={{ marginBottom: 8 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <View style={{ flex: 1, minWidth: 0, paddingRight: 10 }}>
                <T style={[{ fontSize: 15, color: C.ink }, weight(600)]} numberOfLines={2}>
                  {title}
                </T>
                {caption ? (
                  <T s="caption" style={{ marginTop: 2 }}>
                    {caption}
                  </T>
                ) : null}
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <T style={[{ fontSize: 15, color: C.ink }, weight(600), tabular]}>
                  {c ? inrFromPaise(c.eligiblePaise) : '—'}
                </T>
                <T s="caption">{km(c?.chosenMetres ?? null)}</T>
              </View>
            </View>
            {zero ? (
              <Badge tone="neutral" style={{ alignSelf: 'flex-start', marginTop: 6 }}>
                Saved, pays nothing
              </Badge>
            ) : null}
            {/* A visit's journey inside a metered day is movement, not a second
                claim on the same kilometres — and it says so, or the ₹0 beside
                it reads as money withheld. */}
            {leg.claimExcluded === 1 && leg.claimExcludedReason ? (
              <T s="caption" style={{ marginTop: 6 }}>{leg.claimExcludedReason}</T>
            ) : null}
            {c?.unpricedReason ? (
              <T s="caption" style={{ marginTop: 6, color: C.warnInk }}>{c.unpricedReason}</T>
            ) : null}
          </ListCard>
          </Stagger>
        );
      })}

      {locked ? (
        <Card style={{ marginTop: 6, backgroundColor: C.warnBg }}>
          <T s="small" style={{ color: C.ink }}>
            This day is already sent. If something is wrong, ask your manager to open it again.
          </T>
        </Card>
      ) : (
        <Card style={{ marginTop: 6 }}>
          <T s="small" style={{ color: C.ink }}>Paid a fare, a toll or parking?</T>
          <T s="caption" style={{ marginTop: 4 }}>
            Every cost goes in Expenses, with a photo of the bill. A journey that looks wrong here
            is your manager&apos;s to correct.
          </T>
          <PrimaryButton
            label="Add a fare or cost"
            style={{ marginTop: 12 }}
            onPress={() => router.push({ pathname: '/expenses', params: { add: '1' } })}
          />
        </Card>
      )}

      <SecondaryButton label="Close the day" style={{ marginTop: 14 }} onPress={() => router.push('/eod?from=travel')} />
    </AppFrame>
  );
}
