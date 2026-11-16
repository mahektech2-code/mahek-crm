import React from 'react';
import { View } from 'react-native';
import { useFocusEffect, router } from 'expo-router';

import { AppFrame } from '../src/components/shell/AppFrame';
import { T } from '../src/components/ui/primitives';
import { Icon } from '../src/components/ui/Icon';
import { Disc, GroupCard, Pill, PillButton } from '../src/components/ui/v3';
import { useBoot } from '../src/state/boot';
import { hhmm, inrFromPaise, isoDate } from '../src/lib/format';
import { CountUp, Stagger } from '../src/components/ui/motion';
import { color as C, weight, tabular } from '../src/theme/tokens';
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
  const boot = useBoot();
  const userId = boot.session?.user.id ?? '';
  const day = isoDate(new Date());

  const [priced, setPriced] = React.useState<Awaited<ReturnType<typeof priceDay>> | null>(null);
  const [modes, setModes] = React.useState<TravelMode[]>([]);

  const [readFailed, setReadFailed] = React.useState(false);

  const load = React.useCallback(() => {
    let live = true;
    setReadFailed(false);
    void Promise.all([priceDay(userId, day), travelModes()])
      .then(([p, m]) => {
        if (!live) return;
        setPriced(p);
        setModes(m);
      })
      /* A read that failed used to leave the screen blank for good, which
         reads as no travel at all rather than as a read that went wrong. */
      .catch(() => live && setReadFailed(true));
    return () => {
      live = false;
    };
  }, [userId, day]);

  useFocusEffect(load);

  const computation = priced?.computation ?? null;
  const legs = priced?.legs ?? [];

  const hero = (
    <View>
      <T style={[{ fontSize: 14, color: C.onNavyMuted, marginTop: 16 }, weight(600)]}>Today’s travel · km allowance</T>
      {/* Counts only when a revisit re-prices the day — a visit's leg landing
          since he last looked shows as the figure rising. */}
      {computation ? (
        <CountUp
          value={computation.travelPaise}
          format={(n) => inrFromPaise(Math.round(n))}
          style={[{ fontSize: 40, lineHeight: 46, letterSpacing: -1.2, color: C.lime }, weight(800), tabular]}
        />
      ) : (
        <T style={[{ fontSize: 40, lineHeight: 46, letterSpacing: -1.2, color: C.lime }, weight(800)]}>—</T>
      )}
      {computation ? (
        <View style={{ flexDirection: 'row', gap: 16, marginTop: 4 }}>
          <T style={[{ fontSize: 14, color: C.onNavy }, weight(700), tabular]}>{km(computation.totalMetres)}</T>
          <T style={[{ fontSize: 14, color: C.onNavy }, weight(700)]}>
            {computation.legs.length + ' ' + (computation.legs.length === 1 ? 'trip' : 'trips')}
          </T>
        </View>
      ) : null}
      <T style={{ fontSize: 12, lineHeight: 16, color: C.onNavyMuted, marginTop: 10 }}>
        From punch-in, punch-out and visits. Own bike or car earns km on its own, from the office policy. Nothing to send.
      </T>
    </View>
  );

  return (
    <AppFrame
      title="Today’s travel"
      activeTab={null}
      tone="navy"
      showTitle={false}
      hero={hero}
      contentStyle={{ paddingHorizontal: 14, paddingTop: 16, paddingBottom: 32, gap: 10 }}>
      {readFailed ? <Warn text="Could not read today’s travel on this phone. Go back and open it again." /> : null}
      {priced?.reason ? <Warn text={priced.reason} /> : null}

      {/* Said rather than drawn as an empty list: before the first punch-in
          there is nothing to record, and a blank screen reads as a broken one. */}
      {priced && !legs.length ? (
        <View style={{ backgroundColor: C.surface, borderRadius: 22, padding: 14 }}>
          <T style={[{ fontSize: 13, color: C.ink }, weight(700)]}>No travel recorded today yet.</T>
          <T style={{ fontSize: 13, lineHeight: 18, color: C.muted, marginTop: 2 }}>
            Starts at punch-in with your vehicle; each visit adds its journey.
          </T>
        </View>
      ) : null}

      {legs.length ? (
        <GroupCard>
          {legs.map((leg, i) => {
            const c = computation?.legs.find((l) => l.legId === leg.id) ?? null;
            const zero = c != null && c.eligiblePaise === 0 && c.chosenMetres != null;
            const pays = c != null && c.eligiblePaise > 0;
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
            const note = leg.claimExcluded === 1 && leg.claimExcludedReason ? leg.claimExcludedReason : null;
            return (
              <Stagger key={leg.id} index={i}>
                <View style={{ paddingVertical: 12 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <Disc icon="route" bg={pays ? C.successBg : C.wash} ink={pays ? C.success : C.muted} a11y={modeLabel} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <T style={[{ fontSize: 15, color: C.ink }, weight(700)]} numberOfLines={2}>
                        {title}
                      </T>
                      {caption ? <T style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>{caption}</T> : null}
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <T style={[{ fontSize: 16, color: pays ? C.ink : C.faint }, weight(800), tabular]}>
                        {c ? inrFromPaise(c.eligiblePaise) : '—'}
                      </T>
                      <T style={[{ fontSize: 12, color: C.muted }, tabular]}>{km(c?.chosenMetres ?? null)}</T>
                    </View>
                  </View>
                  {zero ? (
                    <View style={{ marginLeft: 52, marginTop: 8 }}>
                      <Pill text="Saved, pays nothing" height={26} />
                    </View>
                  ) : null}
                  {/* A visit's journey inside a metered day is movement, not a
                      second claim on the same kilometres — and it says so, or
                      the ₹0 beside it reads as money withheld. */}
                  {note ? (
                    <T style={{ fontSize: 12, lineHeight: 16, color: C.muted, marginLeft: 52, marginTop: 6 }}>{note}</T>
                  ) : null}
                  {c?.unpricedReason ? (
                    <T style={[{ fontSize: 12, lineHeight: 16, color: C.warnInk, marginLeft: 52, marginTop: 6 }, weight(600)]}>
                      {c.unpricedReason}
                    </T>
                  ) : null}
                </View>
              </Stagger>
            );
          })}
        </GroupCard>
      ) : null}

      <View style={{ backgroundColor: C.surface, borderRadius: 22, padding: 16 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Disc icon="doc" bg={C.primaryTint} ink={C.primaryDeep} />
          <View style={{ flex: 1 }}>
            <T style={[{ fontSize: 15, color: C.ink }, weight(700)]}>Fare, toll or parking?</T>
            <T style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>
              Log it with a bill photo in Expenses — it goes to your manager straight away. Wrong trip: your manager corrects it.
            </T>
          </View>
        </View>
        <PillButton
          label="Add a fare or cost"
          variant="navyLime"
          height={56}
          style={{ marginTop: 12 }}
          onPress={() => router.push({ pathname: '/expenses', params: { add: '1', from: 'travel' } })}
        />
      </View>
    </AppFrame>
  );
}

function Warn({ text }: { text: string }) {
  return (
    <View style={{ backgroundColor: C.warnBg, borderRadius: 18, paddingVertical: 12, paddingHorizontal: 14, flexDirection: 'row', gap: 10 }}>
      <Icon name="warn" size={18} color={C.warnInk} strokeWidth={2} />
      <T style={{ flex: 1, fontSize: 13, lineHeight: 18, color: C.warnInk }}>{text}</T>
    </View>
  );
}
