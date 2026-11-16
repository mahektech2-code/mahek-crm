import React from 'react';
import { Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { T } from '../src/components/ui/primitives';
import { Glyph, type GlyphShape } from '../src/components/me/kit';
import { CountUp, Stagger } from '../src/components/ui/motion';
import { color as C, weight, tabular, type as typeScale } from '../src/theme/tokens';
import { grouped, inrFromPaise, plural } from '../src/lib/format';
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
    <AppFrame
      tone="canvas"
      title="Reports"
      activeTab={null}
      onBack={back.go}
      contentStyle={{ paddingHorizontal: 14, paddingTop: 14, paddingBottom: 24 }}
      hero={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}>
          <Glyph shapes={[{ r: [7, 3, 10, 18, 2] }]} size={12} color={C.lavenderMuted} />
          <T style={{ fontSize: 12, color: C.lavenderMuted }}>This month and last, as saved on this phone</T>
        </View>
      }>
      <BackLink label={back.label} onPress={back.go} />

      {!current ? (
        <T s="small" style={{ color: C.muted, textAlign: 'center', marginTop: 24 }}>
          {boot.session ? 'Loading…' : 'Sign in to see your reports.'}
        </T>
      ) : (
        <>
          <Stagger index={0}>
            <ReportCard title={monthName(current.from)} r={current} />
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

/* The artboard's three stat marks: a pin, a cart, a drop. */
const STAT_GLYPH: Record<'visits' | 'orders' | 'litres', GlyphShape[]> = {
  visits: [{ p: 'M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11z' }, { c: [12, 10, 2.5] }],
  orders: [{ p: 'M4 5h2l2 11h10l2-8H7' }, { c: [10, 20, 1] }, { c: [17, 20, 1] }],
  litres: [{ p: 'M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z' }],
};
const CART: GlyphShape[] = [{ p: 'M4 5h2l2 11h10l2-8H7' }];
const CARD_GLYPH: GlyphShape[] = [{ r: [3, 6, 18, 13, 2] }, { p: 'M3 10h18' }];
const REFUSED: GlyphShape[] = [{ c: [12, 12, 8] }, { p: 'M6.5 6.5l11 11' }];

/**
 * THIS MONTH IS THE NAVY CARD, LAST MONTH THE WHITE ONE. Version 3 draws the
 * month being worked as the hero of the page and the settled month beneath it
 * quieter, which is what `muted` already meant here.
 */
function ReportCard({ title, r, muted }: { title: string; r: MonthReport; muted?: boolean }) {
  const onNavy = !muted;
  const value =
    r.valuePaise == null
      ? r.ordersTaken > 0
        ? `${plural(r.ordersUnvalued, 'order')} without price yet`
        : '—'
      : inrFromPaise(r.valuePaise);
  const unpriced = r.valuePaise == null && r.ordersTaken > 0;
  const collected = inrFromPaise(r.collectedPaise) + ' · ' + plural(r.collectedCount, 'receipt');
  const chipBg = onNavy ? 'rgba(255,255,255,0.08)' : C.canvas;
  const chipFg = onNavy ? '#FFFFFF' : C.body;
  const chipIcon = onNavy ? C.onNavyMuted : C.body;
  return (
    <View style={{ backgroundColor: onNavy ? C.navy : C.surface, borderRadius: 24, padding: 18 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text accessibilityRole="header" style={[{ flexShrink: 1, fontSize: 15, lineHeight: 21, color: onNavy ? '#FFFFFF' : C.muted }, weight(700)]}>
          {title}
        </Text>
        {onNavy ? (
          <View style={{ minHeight: 24, paddingVertical: 3, paddingHorizontal: 10, borderRadius: 12, backgroundColor: 'rgba(198,255,52,0.14)', justifyContent: 'center' }}>
            <T style={[{ fontSize: 12, color: C.lime }, weight(700)]}>so far</T>
          </View>
        ) : null}
      </View>

      <View style={{ flexDirection: 'row', marginTop: onNavy ? 14 : 10, gap: 10 }}>
        {/* This month's three counts run up from nought — they are what the
            screen is opened to read. Last month's are settled history and are
            simply there. */}
        <Stat label="Visits" glyph={onNavy ? STAT_GLYPH.visits : undefined} value={r.visits} count={!muted} big={onNavy} />
        <Stat label="Orders" glyph={onNavy ? STAT_GLYPH.orders : undefined} value={r.ordersTaken} count={!muted} big={onNavy} />
        <Stat label="Litres" glyph={onNavy ? STAT_GLYPH.litres : undefined} value={r.litres} count={!muted} tenths big={onNavy} />
      </View>

      <View
        style={[
          { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: onNavy ? 14 : 12 },
          onNavy ? { paddingTop: 12, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.12)' } : null,
        ]}>
        <Chip
          glyph={CART}
          text={value}
          a11y={'Order value: ' + value}
          bg={unpriced ? C.warnBg : chipBg}
          fg={unpriced ? C.warnInk : chipFg}
          icon={unpriced ? C.warnInk : chipIcon}
        />
        <Chip glyph={CARD_GLYPH} text={collected} a11y={'Collected, as you reported: ' + collected} bg={chipBg} fg={chipFg} icon={chipIcon} />
        {r.ordersRejected > 0 ? (
          <Chip
            glyph={REFUSED}
            text={plural(r.ordersRejected, 'order') + ' not accepted'}
            a11y={'Not accepted: ' + plural(r.ordersRejected, 'order')}
            bg={C.dangerBg}
            fg={C.danger}
            icon={C.danger}
          />
        ) : null}
      </View>
      {onNavy ? <T style={{ fontSize: 11, color: C.onNavyMuted, marginTop: 8 }}>Collected = as you reported</T> : null}
    </View>
  );
}

/** Litres to one decimal, grouped the Indian way: 1,842.5. */
function tenthsGrouped(n: number): string {
  const t = Math.round(n * 10);
  const whole = Math.trunc(t / 10);
  const tenth = Math.abs(t % 10);
  return grouped(whole) + (tenth ? '.' + tenth : '');
}

function Stat({
  label,
  value,
  count,
  tenths,
  big,
  glyph,
}: {
  label: string;
  value: number;
  count: boolean;
  tenths?: boolean;
  big: boolean;
  glyph?: GlyphShape[];
}) {
  return (
    <View style={{ flex: 1, minWidth: 0 }}>
      {glyph ? <Glyph shapes={glyph} size={18} color={C.onNavyMuted} /> : null}
      <CountUp
        value={value}
        /* Litres carry one decimal; the counts are whole and must not pass
           through 3.4 visits on their way to 7. */
        format={(n) => (tenths ? tenthsGrouped(n) : grouped(Math.round(n)))}
        fromZero={count}
        style={[
          typeScale.body,
          { fontSize: big ? 28 : 22, lineHeight: big ? 34 : 28, letterSpacing: big ? -0.56 : 0, color: big ? '#FFFFFF' : C.body },
          weight(800),
          tabular,
        ]}
      />
      <T style={{ marginTop: 4, fontSize: 12, color: big ? C.onNavyMuted : C.muted }}>{label}</T>
    </View>
  );
}

function Chip({ glyph, text, a11y, bg, fg, icon }: { glyph: GlyphShape[]; text: string; a11y: string; bg: string; fg: string; icon: string }) {
  return (
    <View
      accessible
      accessibilityLabel={a11y}
      style={{ minHeight: 32, paddingHorizontal: 12, borderRadius: 16, backgroundColor: bg, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <Glyph shapes={glyph} size={14} color={icon} />
      <T style={[{ fontSize: 13, color: fg }, weight(700), tabular]}>{text}</T>
    </View>
  );
}
