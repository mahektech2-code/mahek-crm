import React from 'react';
import { Pressable, View } from 'react-native';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, Choice, Input, ListCard, PrimaryButton, SecondaryButton, T } from '../src/components/ui/primitives';
import { BottomSheet } from '../src/components/ui/overlays';
import { MONTHS_PAY, SLABS } from '../src/data/fixtures';
import { inr } from '../src/lib/format';
import { useStore } from '../src/state/store';
import { color as C, radius, weight, tabular } from '../src/theme/tokens';

/**
 * Salary — the payslip, and the slab that says what the next one could be.
 *
 * The incentive line is the reason this screen is not a PDF: a figure he
 * receives tells him nothing, and a figure with the next slab beside it tells
 * him what a fortnight of work is worth.
 */

const Q_LINES = ['Incentive', 'Collection bonus', 'Advance recovered', 'Travel allowance', 'Something else'];

export default function SalaryScreen() {
  const back = useCameFrom('more');
  const notify = useStore((s) => s.notify);
  const slMonth = useStore((s) => s.slMonth);
  const set = useStore((s) => s.set);

  const [qOpen, setQOpen] = React.useState(false);
  const [qLine, setQLine] = React.useState('Incentive');
  const [qText, setQText] = React.useState('');
  const [qErr, setQErr] = React.useState(false);

  const mo = MONTHS_PAY.find((x) => x.m === slMonth) ?? MONTHS_PAY[0];

  const lines: { l: string; v: number; kind: 'add' | 'sub'; q: string }[] = [
    { l: 'Basic', v: mo.basic, kind: 'add', q: 'Something else' },
    { l: 'Travel allowance', v: mo.travel, kind: 'add', q: 'Travel allowance' },
    { l: 'Incentive · ' + mo.pct + '% of target', v: mo.inc, kind: 'add', q: 'Incentive' },
    { l: 'Collection bonus', v: mo.bonus, kind: 'add', q: 'Collection bonus' },
    { l: 'Advance recovered', v: -mo.adv, kind: 'sub', q: 'Advance recovered' },
    { l: 'PF', v: -mo.pf, kind: 'sub', q: 'Something else' },
  ];

  /* Slabs, so the incentive is a thing he can act on rather than a number he receives. */
  const nextSlab = SLABS.find((x) => x[0] > mo.pct);
  const basePaid = (SLABS.filter((x) => x[0] <= mo.pct).slice(-1)[0] ?? [0, 2])[1];
  const incentiveLine = nextSlab
    ? 'Incentive pays ' +
      basePaid +
      '% at ' +
      mo.pct +
      '% of target. Reaching ' +
      nextSlab[0] +
      '% pays ' +
      nextSlab[1] +
      '% — about ' +
      inr(Math.round(mo.inc * (nextSlab[1] / 4))) +
      ' more.'
    : 'You are on the top slab. Incentive pays 12% of order value.';

  const openQuery = (line: string) => {
    setQLine(line);
    setQText('');
    setQErr(false);
    setQOpen(true);
  };

  const sendQuery = () => {
    if (!qText.trim()) return setQErr(true);
    setQOpen(false);
    setQText('');
    notify('Sent to payroll · ' + mo.m + ' ' + qLine.toLowerCase());
  };

  return (
    <AppFrame title="MBOS" activeTab={null} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />
      <T s="h1">Salary</T>

      <Card style={{ marginTop: 12 }}>
        <T s="label">{mo.m + ' · take home'}</T>
        <T s="display" style={[{ marginTop: 4 }, tabular]}>
          {inr(mo.net)}
        </T>
        <SecondaryButton
          label="Download payslip"
          style={{ height: 48, marginTop: 12, borderRadius: radius.xl }}
          onPress={() => notify('Payslip for ' + mo.m + ' downloaded')}
        />
      </Card>

      <ListCard style={{ marginTop: 12 }}>
        {lines.map((x, i) => (
          <Pressable
            key={x.l}
            accessibilityRole="button"
            onPress={() => openQuery(x.q)}
            style={({ pressed }) => [
              {
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                paddingHorizontal: 16,
                paddingVertical: 12,
                borderTopWidth: i ? 1 : 0,
                borderTopColor: C.wash,
              },
              pressed && { backgroundColor: C.wash },
            ]}>
            <T style={{ flex: 1, minWidth: 0, fontSize: 15, lineHeight: 22, color: C.ink }}>{x.l}</T>
            <T style={[{ fontSize: 15, color: x.kind === 'sub' ? C.danger : C.ink }, weight(500), tabular]}>
              {(x.kind === 'sub' ? '−' : '') + inr(Math.abs(x.v))}
            </T>
          </Pressable>
        ))}
      </ListCard>

      <View
        style={{
          backgroundColor: C.primaryTint,
          borderWidth: 1,
          borderColor: C.primaryEdge,
          borderRadius: radius.card,
          paddingHorizontal: 16,
          paddingVertical: 14,
          marginTop: 12,
        }}>
        <T style={{ fontSize: 14, lineHeight: 20, color: C.ink }}>{incentiveLine}</T>
      </View>

      <T s="label" style={{ marginTop: 20, marginBottom: 8 }}>
        Earlier months
      </T>
      <ListCard>
        {MONTHS_PAY.map((x, i) => {
          const on = x.m === mo.m;
          return (
            <Pressable
              key={x.m}
              accessibilityRole="button"
              onPress={() => set({ slMonth: x.m })}
              style={({ pressed }) => [
                {
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  minHeight: 56,
                  paddingHorizontal: 16,
                  paddingVertical: 10,
                  borderTopWidth: i ? 1 : 0,
                  borderTopColor: C.wash,
                  backgroundColor: on ? C.primaryTint : 'transparent',
                },
                pressed && !on && { backgroundColor: C.wash },
              ]}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <T style={[{ fontSize: 15, lineHeight: 20, color: C.ink }, weight(on ? 600 : 500)]}>{x.m}</T>
                <T s="micro">{x.paid}</T>
              </View>
              <T style={[{ fontSize: 15, color: C.ink }, weight(500), tabular]}>{inr(x.net)}</T>
            </Pressable>
          );
        })}
      </ListCard>

      {/* ------------------------------------------------------ query sheet */}
      <BottomSheet open={qOpen} onClose={() => setQOpen(false)} scroll>
        <T s="h2">{'Query on ' + mo.m + ' · ' + qLine}</T>
        <T s="small" style={{ color: C.muted, marginTop: 2 }}>
          Payroll sees the payslip with this.
        </T>

        <View style={{ marginTop: 16 }}>
          <T s="label" style={{ marginBottom: 8 }}>
            Which line
          </T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {Q_LINES.map((l) => (
              <Choice key={l} label={l} selected={qLine === l} onPress={() => setQLine(l)} />
            ))}
          </View>
        </View>

        <View style={{ marginTop: 14 }}>
          <T s="label" style={{ marginBottom: 6 }}>
            What looks wrong
          </T>
          <Input
            value={qText}
            onChangeText={(v) => {
              setQText(v);
              setQErr(false);
            }}
            multiline
            invalid={qErr}
            placeholder="Incentive is short — I closed 88% of target, not 71%"
          />
          {qErr ? (
            <T style={{ fontSize: 13, color: C.danger, marginTop: 6 }}>Say what looks wrong, so payroll can check it.</T>
          ) : null}
        </View>

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
          <SecondaryButton label="Cancel" onPress={() => setQOpen(false)} style={{ flex: 1 }} />
          <PrimaryButton label="Send to payroll" onPress={sendQuery} style={{ flex: 1 }} />
        </View>
      </BottomSheet>
      <T s="caption" style={{ marginTop: 12 }}>These figures are not live yet.</T>
    </AppFrame>
  );
}
