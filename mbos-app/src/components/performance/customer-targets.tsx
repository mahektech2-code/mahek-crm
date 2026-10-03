import React from 'react';
import { ScrollView, View } from 'react-native';

import { Badge, Bar, Card, Choice, ListCard, Row, SecondaryButton, T } from '../ui/primitives';
import { CountUp, Stagger, animateLayoutFor } from '../ui/motion';
import { color as C, weight, tabular, type as typeScale } from '../../theme/tokens';
import { inrFromPaise, plural } from '../../lib/format';
import { customerTargetsComputedAt, listCustomerTargets } from '../../data/customer-targets';
import {
  TARGET_FILTERS,
  gapPaise,
  lastOrderWords,
  matches,
  sortForWork,
  stateOf,
  summarise,
  type CustomerTargetRow,
  type TargetFilter,
  type TargetSummary,
} from '../../engines/customer-targets';

/**
 * His customers' targets on the Performance screen — the shops behind his
 * number, and how much of the month is still open in each.
 *
 * READ-ONLY, like the rest of that screen. A target is the office's decision
 * and what a shop achieved is the office's ledger; this draws both and adds
 * nothing to either. What he took and nobody has approved yet is shown BESIDE
 * achievement, never inside it, because "counts once accounts accept it" is
 * the rule every other figure on the screen already follows.
 */

export type CustomerTargets = {
  rows: CustomerTargetRow[];
  summary: TargetSummary;
  computedAt: string | null;
};

/**
 * One month's rows, re-read whenever the screen is visited again — the same
 * `visit` counter the person figures reload on, so the two halves of the
 * screen can never be from different pulls. Null period is a range that is
 * not one whole month: customer targets exist only by the month.
 */
export function useCustomerTargets(period: string | null, visit: number): CustomerTargets | null {
  const [read, setRead] = React.useState<{ key: string; value: CustomerTargets } | null>(null);
  React.useEffect(() => {
    if (!period || !visit) return;
    let alive = true;
    void Promise.all([listCustomerTargets(period), customerTargetsComputedAt(period)]).then(
      ([rows, computedAt]) => {
        if (!alive) return;
        setRead({ key: `${period}#${visit}`, value: { rows, summary: summarise(rows), computedAt } });
      },
    );
    return () => {
      alive = false;
    };
  }, [period, visit]);
  /* A month switched to and not read yet is "not known", never the previous
     month's rows under the new month's name. */
  return period && read?.key.startsWith(`${period}#`) ? read.value : null;
}

/** Rows drawn before "Show more" — a book can carry hundreds of shops. */
const PAGE = 20;

export function CustomerTargetsCard({
  period,
  monthWords,
  data,
  today,
  onOpen,
}: {
  /** `YYYY-MM`, or null where the period picked is not one whole month. */
  period: string | null;
  monthWords: string;
  data: CustomerTargets | null;
  today: string;
  onOpen: (customerId: string) => void;
}) {
  const [filter, setFilter] = React.useState<TargetFilter>('open');
  const [shown, setShown] = React.useState(PAGE);

  if (!period) {
    return (
      <Card style={{ marginTop: 12 }}>
        <T s="label">Your customers&apos; targets</T>
        <T s="small" style={{ color: C.body, marginTop: 6 }}>
          Each shop&apos;s target is set month by month. Pick This month or Last month to see
          them shop by shop.
        </T>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card style={{ marginTop: 12 }}>
        <T s="label">Your customers&apos; targets</T>
        <T s="small" style={{ color: C.muted, marginTop: 6 }}>
          Loading…
        </T>
      </Card>
    );
  }

  if (!data.rows.length) {
    return (
      <Card style={{ marginTop: 12 }}>
        <T s="label">Your customers&apos; targets</T>
        <T s="small" style={{ color: C.body, marginTop: 6 }}>
          {data.computedAt
            ? `None of your customers carries a target for ${monthWords}, and none has bought or has an order waiting.`
            : `Customer targets for ${monthWords} are not on this phone. Only this month and last month are kept, and they arrive with the next sync.`}
        </T>
      </Card>
    );
  }

  const { summary } = data;
  const visible = sortForWork(data.rows.filter((r) => matches(r, filter)));
  const pctDone = summary.targetPaise ? (summary.achievedPaise / summary.targetPaise) * 100 : 0;

  return (
    <>
      <Card style={{ marginTop: 12 }}>
        <T s="label">Your customers&apos; targets</T>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
          <CountUp
            value={summary.achievedPaise}
            format={(n) => inrFromPaise(Math.round(n))}
            style={[typeScale.body, { fontSize: 22, lineHeight: 28, color: C.ink }, weight(600), tabular]}
          />
          <T s="small" style={{ color: C.muted }}>
            {summary.targetPaise ? `of ${inrFromPaise(summary.targetPaise)}` : 'no targets set'}
          </T>
        </View>
        {summary.targetPaise ? (
          <View style={{ marginTop: 8 }}>
            <Bar pct={pctDone} fill={pctDone >= 100 ? C.success : C.primary} />
          </View>
        ) : null}
        <T s="small" style={{ color: C.body, marginTop: 8 }}>
          {plural(summary.targeted, 'customer')} with a target
          {summary.openPaise ? ` · ${inrFromPaise(summary.openPaise)} still open` : ' · all met'}
        </T>
        {summary.waitingPaise ? (
          <T s="small" style={{ color: C.warnInk, marginTop: 4 }}>
            {inrFromPaise(summary.waitingPaise)} more taken and not yet accepted — it counts once
            the office approves it.
          </T>
        ) : null}
        {/* The two targets are different grains, and the screen must not
            suggest one adds up to the other: a customer target is what one
            account is expected to buy, and his own target is what he is
            appraised on. */}
        <T s="micro" style={{ marginTop: 8 }}>
          Each shop&apos;s own monthly target, set by the office. It is a separate figure from your
          revenue target above — the two are not meant to add up.
        </T>
      </Card>

      {/* The filters scroll sideways like the period row above them: which
          slice he is looking at is part of what the list says. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ marginTop: 12, marginHorizontal: -16 }}
        contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}>
        {TARGET_FILTERS.map((f) => (
          <Choice
            key={f.key}
            label={`${f.label} · ${summary.counts[f.key]}`}
            selected={filter === f.key}
            onPress={() => {
              /* The slice changes in place: rows that stay slide to their new
                 places and rows that leave fade, so the list reads as narrowed
                 rather than replaced. At most a page is on screen. */
              animateLayoutFor(Math.min(PAGE, data.rows.length));
              setFilter(f.key);
              setShown(PAGE);
            }}
            style={{ minHeight: 40 }}
          />
        ))}
      </ScrollView>

      {visible.length ? (
        <ListCard style={{ marginTop: 10 }}>
          {visible.slice(0, shown).map((r, i) => (
            <Stagger key={r.customerId} index={i}>
              <TargetRow row={r} first={i === 0} today={today} onPress={() => onOpen(r.customerId)} />
            </Stagger>
          ))}
        </ListCard>
      ) : (
        <Card style={{ marginTop: 10 }}>
          <T s="small" style={{ color: C.body }}>
            {filter === 'met'
              ? 'No shop has reached its target yet.'
              : filter === 'open'
                ? 'Every shop with a target has met it.'
                : filter === 'not-started'
                  ? 'Every shop with a target has bought something this month.'
                  : 'Nothing to show.'}
          </T>
        </Card>
      )}

      {visible.length > shown ? (
        <SecondaryButton
          label={`Show ${Math.min(PAGE, visible.length - shown)} more of ${visible.length}`}
          onPress={() => setShown((n) => n + PAGE)}
          style={{ marginTop: 10 }}
        />
      ) : null}
    </>
  );
}

function TargetRow({
  row,
  first,
  today,
  onPress,
}: {
  row: CustomerTargetRow;
  first: boolean;
  today: string;
  onPress: () => void;
}) {
  const state = stateOf(row);
  const gap = gapPaise(row);
  const waiting = row.pendingPaise + row.unsentPaise;
  const pct = row.targetPaise ? (row.achievedPaise / row.targetPaise) * 100 : 0;

  return (
    <Row first={first} onPress={onPress} style={{ alignItems: 'flex-start' }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
          <T numberOfLines={1} style={[{ flex: 1, fontSize: 15, lineHeight: 20, color: C.ink }, weight(500)]}>
            {row.name}
          </T>
          <T s="caption" style={tabular}>
            {inrFromPaise(row.achievedPaise)}
            {row.targetPaise ? ` of ${inrFromPaise(row.targetPaise)}` : ''}
          </T>
        </View>
        {row.city ? (
          <T s="micro" numberOfLines={1}>
            {row.city}
          </T>
        ) : null}

        {row.targetPaise ? (
          <View style={{ marginTop: 6 }}>
            <Bar pct={pct} fill={state === 'met' ? C.success : state === 'not-started' ? C.warn : C.primary} />
          </View>
        ) : null}

        <T s="small" style={{ marginTop: 6, color: state === 'met' ? C.success : C.body }}>
          {state === 'met'
            ? 'Target met'
            : state === 'untargeted'
              ? 'No target this month'
              : `${inrFromPaise(gap)} to go`}
          {waiting ? ` · ${inrFromPaise(waiting)} waiting for approval` : ''}
        </T>
        {row.unsentPaise ? (
          <T s="micro">{inrFromPaise(row.unsentPaise)} of it is still on this phone, not yet sent.</T>
        ) : null}
        <T s="micro" style={{ marginTop: 2 }}>
          {lastOrderWords(row.lastOrderDate, today)}
        </T>

        {row.carriedForward || (row.isDefault && row.targetPaise > 0) ? (
          <View style={{ flexDirection: 'row', gap: 6, marginTop: 6 }}>
            {row.carriedForward ? <Badge tone="neutral">Last month&apos;s figure</Badge> : null}
            {row.isDefault && !row.carriedForward && row.targetPaise > 0 ? (
              <Badge tone="neutral">Default</Badge>
            ) : null}
          </View>
        ) : null}
      </View>
    </Row>
  );
}
