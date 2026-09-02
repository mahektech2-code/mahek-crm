import React from 'react';
import { View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, T } from '../src/components/ui/primitives';
import { color as C, weight, tabular } from '../src/theme/tokens';
import { inr, plural } from '../src/lib/format';
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
        What you actually did — read from this phone, not a claim about what will be paid.
      </T>

      {!current ? null : (
        <>
          <ReportCard title={monthName(current.from) + ' — so far'} r={current} />
          {previous ? (
            <View style={{ marginTop: 10 }}>
              <ReportCard title={monthName(previous.from)} r={previous} muted />
            </View>
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
        <Stat label="Visits" value={String(r.visits)} />
        <Stat label="Orders" value={String(r.ordersTaken)} />
        <Stat label="Litres" value={String(r.litres)} />
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
                ? `${plural(r.ordersUnvalued, 'order')} not priced yet`
                : '—'
              : inr(r.valuePaise / 100)
          }
        />
        <Row label="Collected, reported" value={inr(r.collectedPaise / 100) + ' · ' + plural(r.collectedCount, 'receipt')} />
        {r.ordersRejected > 0 ? (
          <Row label="Rejected" value={plural(r.ordersRejected, 'order')} tone={C.danger} />
        ) : null}
      </View>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View>
      <T style={[{ fontSize: 20, color: C.ink }, weight(600), tabular]}>{value}</T>
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
