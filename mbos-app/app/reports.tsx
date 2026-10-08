import React from 'react';
import { View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, T } from '../src/components/ui/primitives';
import { CountUp, Stagger } from '../src/components/ui/motion';
import { color as C, weight, tabular, type as typeScale } from '../src/theme/tokens';
import { inrFromPaise, plural } from '../src/lib/format';
import { monthReport, type MonthReport } from '../src/data/reports';
import { useBoot } from '../src/state/boot';

/**
 * His own numbers, this month and last.
 *
 * This used to be a stub card admitting nothing was built — which was the
 * right thing to show rather than fixtures, but it was also never true that
 * nothing existed to build it from: visits, orders and payments are all
 * already on the phone, owned data the salesman wrote himself. This reads
 * straight off them; see `data/reports.ts` for why that is a different,
 * plainer question than the one `performance` answers.
 */

const monthName = (iso: string) =>
  new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

export default function ReportsScreen() {
  const back = useCameFrom('more');
  const boot = useBoot();
  const [current, setCurrent] = React.useState<MonthReport | null>(null);
  const [previous, setPrevious] = React.useState<MonthReport | null>(null);

  const load = React.useCallback(() => {
    let live = true;
    const userId = boot.session?.user.id;
    if (!userId) return;
    void Promise.all([monthReport(userId, 0), monthReport(userId, 1)]).then(([cur, prev]) => {
      if (!live) return;
      setCurrent(cur);
      setPrevious(prev);
    });
    return () => {
      live = false;
    };
  }, [boot.session?.user.id]);

  useFocusEffect(load);

  return (
    <AppFrame title="Reports" activeTab={null} onBack={back.go} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />
      <T s="h1">Reports</T>
      <T s="small" style={{ color: C.muted, marginTop: 2, marginBottom: 16 }}>
        What you did this month and last, as saved on this phone.
      </T>

      {!current ? (
        <T s="small" style={{ color: C.muted, textAlign: 'center', marginTop: 24 }}>
          {boot.session ? 'Loading…' : 'Sign in to see your reports.'}
        </T>
      ) : (
        <>
          <Stagger index={0}>
            <ReportCard title={monthName(current.from) + ' · so far'} r={current} />
          </Stagger>
          {previous ? (
            <Stagger index={1} style={{ marginTop: 10 }}>
              <ReportCard title={monthName(previous.from)} r={previous} muted />
            </Stagger>
          ) : null}
        </>
      )}
    </AppFrame>
  );
}

function ReportCard({ title, r, muted }: { title: string; r: MonthReport; muted?: boolean }) {
  return (
    <Card style={muted ? { opacity: 0.75 } : undefined}>
      <T style={[{ fontSize: 15, color: C.ink }, weight(600)]}>{title}</T>

      <View style={{ flexDirection: 'row', marginTop: 14, gap: 18 }}>
        {/* This month's three counts run up from nought — they are what the
            screen is opened to read. Last month's are settled history and are
            simply there. */}
        <Stat label="Visits" value={r.visits} count={!muted} />
        <Stat label="Orders" value={r.ordersTaken} count={!muted} />
        <Stat label="Litres" value={r.litres} count={!muted} tenths />
      </View>

      <View
        style={{
          marginTop: 14,
          paddingTop: 14,
          borderTopWidth: 1,
          borderTopColor: C.hairline,
          gap: 8,
        }}>
        <Row
          label="Order value"
          value={
            r.valuePaise == null
              ? r.ordersTaken > 0
                ? `${plural(r.ordersUnvalued, 'order')} without price yet`
                : '—'
              : inrFromPaise(r.valuePaise)
          }
        />
        <Row label="Collected (as you reported)" value={inrFromPaise(r.collectedPaise) + ' · ' + plural(r.collectedCount, 'receipt')} />
        {r.ordersRejected > 0 ? (
          <Row label="Not accepted" value={plural(r.ordersRejected, 'order')} tone={C.danger} />
        ) : null}
      </View>
    </Card>
  );
}

function Stat({ label, value, count, tenths }: { label: string; value: number; count: boolean; tenths?: boolean }) {
  return (
    <View>
      <CountUp
        value={value}
        /* Litres carry one decimal; the counts are whole and must not pass
           through 3.4 visits on their way to 7. */
        format={(n) => String(tenths ? Math.round(n * 10) / 10 : Math.round(n))}
        fromZero={count}
        style={[typeScale.body, { fontSize: 20, color: C.ink }, weight(600), tabular]}
      />
      <T s="caption" style={{ marginTop: 2 }}>{label}</T>
    </View>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
      <T s="small" style={{ color: C.muted }}>{label}</T>
      <T s="small" style={[{ color: tone ?? C.ink }, weight(500)]}>{value}</T>
    </View>
  );
}
