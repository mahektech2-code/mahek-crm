import React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, Choice, PrimaryButton, T } from '../src/components/ui/primitives';
import { BottomSheet, Calendar } from '../src/components/ui/overlays';
import { Appear, CountUp, FillBar, Swap } from '../src/components/ui/motion';
import { color as C, radius, weight, tabular, type as typeScale } from '../src/theme/tokens';
import { dmy, inrFromPaise, isoDate, plural } from '../src/lib/format';
import { activitySub, collectionLine } from '../src/engines/performance-labels';
import {
  PRESETS,
  customPeriod,
  periodFor,
  rangeWords,
  wholeMonth,
  type Period,
  type PeriodKey,
} from '../src/engines/periods';
import {
  collectionShareBp,
  fetchPerformance,
  listPerformance,
  litres,
  priceNotVolume,
  shortfalls,
  untargetedLine,
  type PerformanceMonth,
} from '../src/data/performance';
import { CustomerTargetsCard, useCustomerTargets } from '../src/components/performance/customer-targets';
import { useStore } from '../src/state/store';

/**
 * Performance — his month, against what was actually asked for.
 *
 * This screen used to be fixtures with "these figures are not live yet"
 * underneath. They are live now: the office publishes a target per person and
 * scores the month against it, and the whole thing comes down the sync as one
 * row per month.
 *
 * THE TWO NUMBERS THAT MATTER TOGETHER are revenue and volume. A price
 * revision moves the first and cannot move the second, so a month at target on
 * rupees and short on litres is a month that sold less and billed more — and
 * it is exactly the month somebody would otherwise be congratulated for. That
 * is why they sit side by side rather than in a list of six.
 *
 * NOTHING HERE WRITES. There is no edit, no override and no local
 * recalculation of the score: the number a man is appraised on is the office's
 * and a second implementation of it on a phone is how the two come to
 * disagree.
 *
 * ANY PERIOD, NOT ONLY THIS MONTH. This month, last month, either quarter,
 * either financial year, or two days he picks. The two months the sync
 * carries draw at once and with no signal; anything else is asked of the
 * office, which reads it off the ledger with the SAME scoring the monthly
 * cache uses — so September picked as a range and September off the sync are
 * one figure. Whose figures is the device token's answer, never a choice on
 * this screen: it is his, and only his.
 *
 * AND THE SHOPS BEHIND IT. Below his own figures sit his customers' monthly
 * targets — which shops are short, by how much, and what he has taken that
 * accounts have not approved yet. That is the half that tells him where the
 * rest of the month comes from; the half above only tells him how much is
 * left. They are kept for this month and last, like the score.
 */

type Live =
  | { key: string; ok: true; month: PerformanceMonth }
  | { key: string; ok: false; error: string };

export default function PerformanceScreen() {
  const back = useCameFrom('more');
  const [today] = React.useState(() => isoDate(new Date()));
  const [months, setMonths] = React.useState<PerformanceMonth[] | null>(null);
  const [key, setKey] = React.useState<PeriodKey>('this-month');
  const [custom, setCustom] = React.useState<Period | null>(null);
  const [picking, setPicking] = React.useState(false);
  const [live, setLive] = React.useState<Live | null>(null);
  /* Bumped on every focus, so coming back to the screen reads again. */
  const [visit, setVisit] = React.useState(0);

  const load = React.useCallback(() => {
    let alive = true;
    void listPerformance().then((rows) => {
      if (!alive) return;
      setMonths(rows);
      setVisit((v) => v + 1);
    });
    return () => {
      alive = false;
    };
  }, []);

  useFocusEffect(load);

  const period: Period =
    key === 'custom' && custom ? custom : periodFor(key === 'custom' ? 'this-month' : key, today);
  const rangeKey = `${period.from}..${period.to}`;
  const monthKey = wholeMonth(period);
  const synced = monthKey ? (months?.find((m) => m.period === monthKey) ?? null) : null;

  /*
   * Ask the office for the range, every time it changes and every visit.
   *
   * Even a month the sync carries is asked again: the cache is rebuilt hourly
   * and this answers as of now. If it cannot answer, the synced month stands
   * and nothing is said — that copy is already labelled with when it was
   * worked out. A range the sync does not carry has no such fallback, and the
   * screen says why rather than drawing an empty period.
   */
  React.useEffect(() => {
    if (!visit) return;
    let alive = true;
    void fetchPerformance(period.from, period.to).then((out) => {
      if (!alive) return;
      setLive(out.ok ? { key: rangeKey, ok: true, month: out.month } : { key: rangeKey, ok: false, error: out.error });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rangeKey IS the period
  }, [rangeKey, visit]);

  const answered = live?.key === rangeKey ? live : null;
  const current = answered?.ok ? answered.month : synced;
  const waiting = !current && !answered && months !== null;
  const failed = !current && answered && !answered.ok ? answered.error : null;

  /* "August was 72" is only a comparison where the period IS a month. */
  const previous =
    monthKey && months
      ? (months.find((m) => m.period === previousMonth(monthKey)) ?? null)
      : null;
  const dropped = current ? untargetedLine(current) : null;
  const setStore = useStore((s) => s.set);
  const shops = useCustomerTargets(monthKey, visit);
  const openShop = (customerId: string) => {
    setStore({ custId: customerId });
    router.push('/customer?from=performance');
  };
  const collectedBp = current ? collectionShareBp(current) : null;

  return (
    <AppFrame title="MBOS" activeTab={null} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />
      <T s="h1">Performance</T>

      {/* The periods. A row that scrolls sideways rather than a menu: which
          window he is looking at is the first thing on the screen, and a
          choice hidden behind a tap is one people forget they made. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ marginTop: 10, marginHorizontal: -16 }}
        contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}>
        {PRESETS.map((p) => (
          <Choice
            key={p.key}
            label={p.label}
            selected={key === p.key}
            onPress={() => setKey(p.key)}
            style={{ minHeight: 40 }}
          />
        ))}
        <Choice
          label={key === 'custom' && custom ? rangeWords(custom) : 'Pick dates'}
          selected={key === 'custom'}
          onPress={() => setPicking(true)}
          style={{ minHeight: 40 }}
        />
      </ScrollView>

      <T s="small" style={{ color: C.muted, marginTop: 8 }}>
        {rangeWords(period)}
        {current?.computedAt
          ? ` · ${current.source === 'live' ? 'worked out' : 'synced'} ${asAt(current.computedAt)}`
          : ''}
      </T>

      {months === null || waiting ? (
        <T s="small" style={{ color: C.muted, marginTop: 12 }}>
          Loading…
        </T>
      ) : failed ? (
        <Card style={{ marginTop: 12 }}>
          <T style={{ fontSize: 14, lineHeight: 20, color: C.ink }}>
            This period is worked out by the office, and it could not be reached.
          </T>
          <T s="small" style={{ color: C.muted, marginTop: 6 }}>
            {failed}. This month and last month are kept on the phone and open without
            signal — any other period needs a connection.
          </T>
        </Card>
      ) : !current ? (
        <Card style={{ marginTop: 12 }}>
          <T style={{ fontSize: 14, lineHeight: 20, color: C.ink }}>
            Nothing to show yet.
          </T>
          <T s="small" style={{ color: C.muted, marginTop: 6 }}>
            The office sets your target. It will come to this phone after that.
            Until then there is nothing to measure against, so no percentage is shown.
          </T>
        </Card>
      ) : (
        /* ONE PERIOD REPLACING ANOTHER. Keyed on the range, so picking a new
           period settles the figures in afresh — and the score, which counts
           up from nought on arrival, counts again: the number for the new
           window is news in exactly the way the first one was. The chip
           itself already ticks `select`, so nothing here buzzes. */
        <Swap id={rangeKey}>

          {current.hasTarget && current.totalScoreBp !== null ? (
            <Card style={{ marginTop: 12, alignItems: 'flex-start' }}>
              <T s="label">Overall</T>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                {/* The score is what this screen is for, so it counts up from
                    nought rather than simply being there — and when the office's
                    live answer replaces the synced one, it runs from the old
                    figure to the new, which is the only way somebody sees that
                    it moved. */}
                <CountUp
                  value={current.totalScoreBp / 100}
                  format={(n) => n.toFixed(0)}
                  fromZero
                  duration={800}
                  style={[
                    typeScale.body,
                    { fontSize: 34, lineHeight: 40, color: toneFor(current.totalScoreBp) },
                    weight(600),
                    tabular,
                  ]}
                />
                <T s="small" style={{ color: C.muted }}>
                  out of 100
                </T>
              </View>
              {current.rating ? (
                <T style={{ fontSize: 14, lineHeight: 20, color: C.ink }}>
                  {current.rating}
                </T>
              ) : null}
              {previous?.period && previous.totalScoreBp != null ? (
                <T s="micro" style={{ marginTop: 4 }}>
                  {monthName(previous.period)} was {(previous.totalScoreBp / 100).toFixed(0)}
                </T>
              ) : null}
              {/* A range over several months is scored against the targets
                  those months carried, added up — and it has to say how many
                  that was. A year scored on three targeted months out of
                  twelve is a different statement from one scored on twelve. */}
              {current.monthsInRange > 1 || current.prorated ? (
                <T s="micro" style={{ marginTop: 6 }}>
                  {rangeTargetLine(current)}
                </T>
              ) : null}
              {/* WHAT WAS LEFT OUT IS PART OF THE NUMBER, not a footnote to it.
                  An 84 earned across six components and an 84 earned across
                  three are different months, and the office's own screen has
                  always said which — this one drew the 34-point figure and
                  stopped. */}
              {dropped ? (
                <T s="micro" style={{ marginTop: 6 }}>
                  {dropped}
                </T>
              ) : null}
            </Card>
          ) : (
            <Card style={{ marginTop: 12 }}>
              <T style={{ fontSize: 14, lineHeight: 20, color: C.ink }}>
                No target has been set for you {monthKey ? 'this month' : 'in this period'}.
              </T>
              <T s="small" style={{ color: C.muted, marginTop: 6 }}>
                Below is what you have done. There is no score, because no target
                was set.
              </T>
            </Card>
          )}

          {/* Revenue and volume, side by side and in that order. See the note
              at the top of the file — this pairing is the point of the screen.

              `inr()` TAKES RUPEES. Every money column on this row is paise, and
              these five call sites passed the column straight in — so a month
              of ₹8,50,000 was drawn as ₹8,50,00,000, against a target printed
              100× too big as well. The "What is short" card at the foot of the
              same screen has its own correct helper, so the two disagreed by
              two decimal places with nothing saying which half to believe. */}
          <Card padded={false} style={{ marginTop: 12, flexDirection: 'row', overflow: 'hidden' }}>
            <Figure
              label="Revenue excl. GST"
              value={inrFromPaise(current.revenueActualPaise)}
              count={{ n: current.revenueActualPaise, format: (n) => inrFromPaise(Math.round(n)) }}
              target={current.revenueTargetPaise ? inrFromPaise(current.revenueTargetPaise) : null}
              bp={current.revenueAchievementBp}
            />
            <Figure
              label="Volume"
              value={litres(current.volumeActualMl)}
              count={{ n: current.volumeActualMl, format: litres }}
              target={current.volumeTargetMl ? litres(current.volumeTargetMl) : null}
              bp={current.volumeAchievementBp}
            />
          </Card>

          {/* The warning arrives a beat after the two figures it is about, so
              it reads as a conclusion drawn from them rather than as part of
              the furniture of the screen. */}
          {priceNotVolume(current) ? (
            <Appear
              delay={360}
              style={{
                backgroundColor: C.warnBg,
                borderWidth: 1,
                borderColor: C.warnEdge,
                borderRadius: radius.card,
                paddingHorizontal: 16,
                paddingVertical: 14,
                marginTop: 12,
              }}>
              <T style={{ fontSize: 14, lineHeight: 20, color: C.warnInk }}>
                You reached your rupee target but not your litres target. Prices went up,
                but you sold less quantity. So this month is not as good as it looks.
              </T>
            </Appear>
          ) : null}

          {/* WHAT HE TOOK AND NOBODY HAS DECIDED YET. Revenue counts accepted
              orders only, so on a busy morning the figure above lags what he
              actually sold — and with nothing saying so it reads as a slow
              day. Shown beside the revenue, never added to it. */}
          {shops && shops.summary.waitingPaise ? (
            <T s="small" style={{ color: C.warnInk, marginTop: 8 }}>
              {inrFromPaise(shops.summary.waitingPaise)} more is waiting for the office to accept.
              It is not in the revenue above yet.
            </T>
          ) : null}

          <Card padded={false} style={{ marginTop: 12, flexDirection: 'row', flexWrap: 'wrap', overflow: 'hidden' }}>
            <Figure
              half
              label="New customers"
              value={String(current.newCustomerActual)}
              target={current.newCustomerTarget ? String(current.newCustomerTarget) : null}
              bp={null}
            />
            {/* COLLECTION IS A PERCENTAGE, because that is what is asked of
                him: the office sets "collect half of what was overdue", not a
                rupee figure, and the rupees drawn here used to make the target
                look like an amount somebody had picked. The share leads; the
                money it is a share of sits underneath. No overdue book is a
                dash and a sentence, never 0% — nothing owed is nothing to fail
                at, and the score leaves it out for exactly that reason. */}
            <Figure
              half
              label="Collected"
              value={collectedBp === null ? '—' : pct(collectedBp)}
              target={current.collectionTargetBp ? pct(current.collectionTargetBp) : null}
              base={collectionLine(
                { done: current.collectionActualPaise, base: current.collectionBasePaise },
                inrFromPaise,
              )}
              bp={null}
            />
            <Figure
              half
              label="Visits and calls"
              value={String(current.activityActual)}
              target={current.activityTarget ? String(current.activityTarget) : null}
              base={activityBaseLine(current)}
              bp={null}
            />
            <Figure
              half
              label="Product mix"
              value={
                current.mixAchievementBp === null
                  ? '—'
                  : `${(current.mixAchievementBp / 100).toFixed(0)}%`
              }
              /* NOT `null`, which `Figure` prints as "nothing asked" — directly
                 above the card listing this component's per-category targets,
                 and in the same words the dropped-component sentence uses for a
                 component nobody set a target for at all. The mix target is a
                 set of bands rather than one figure, so the honest summary is
                 how many were asked.

                 FORMULATION is the word the office screen uses, and the two
                 must not have two vocabularies for one month — the same rule
                 `COMPONENT_LABELS` follows. A target set before the mix moved
                 off the three categories reads the same word for bands that
                 are still categories underneath; that is a handful of old
                 targets, against every new one being named wrongly. */
              target={
                current.categories.length
                  ? `${plural(current.categories.length, 'formulation', 'formulations')} set`
                  : null
              }
              bp={null}
            />
          </Card>

          {current.categories.length ? (
            <Card style={{ marginTop: 12 }}>
              <T s="label">Product mix</T>
              {current.revenueActualPaise === 0 ? (
                /* An empty month is said in words rather than drawn as four
                   empty tracks. Bars at 0.0% under "share of what you sold"
                   read as a salesman selling none of what was asked, on the
                   2nd of the month, when the truth is nothing has been
                   approved yet. The target is what is worth reading then. */
                <T s="small" style={{ marginTop: 6, color: C.body }}>
                  {'Nothing sold yet this month.' +
                    (current.categories.some((c) => c.targetBp > 0)
                      ? ' Your target: ' +
                        current.categories
                          .filter((c) => c.targetBp > 0)
                          .map((c) => (c.targetBp / 100).toFixed(0) + '% ' + c.name)
                          .join(', ') +
                        '.'
                      : '')}
                </T>
              ) : (
                <T s="micro" style={{ marginTop: 2 }}>
                  Share of your sales, by value.
                </T>
              )}
              {(current.revenueActualPaise === 0
                ? []
                : /* A share nobody asked for and nothing has landed in is a
                     row with nothing to say — "Other 0.0% of 0%" with a
                     tick at the edge looked like a stray mark. It comes
                     back the moment something sells into it. */
                  current.categories.filter((c) => c.targetBp > 0 || c.actualBp > 0)
              ).map((c, i) => (
                <View key={c.name} style={{ marginTop: 14 }}>
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'baseline',
                      justifyContent: 'space-between',
                      gap: 12,
                    }}>
                    <T style={{ fontSize: 14, lineHeight: 20, color: C.ink }}>{c.name}</T>
                    <T s="caption" style={tabular}>
                      {(c.actualBp / 100).toFixed(1) + '% of ' + (c.targetBp / 100).toFixed(0) + '%'}
                      {c.actualMl ? ' · ' + litres(c.actualMl) : ''}
                    </T>
                  </View>
                  <View
                    style={{
                      position: 'relative',
                      height: 8,
                      marginTop: 6,
                    }}>
                    {/* Filled one after another, 60 ms apart, so the eye reads
                        the shares down the card in order rather than all at
                        once. The track is FillBar's own; this View only holds
                        the target rule over it. */}
                    <FillBar
                      pct={c.actualBp / 100}
                      height={8}
                      delay={i * 60}
                      track={C.hairline}
                      fill={
                        c.status === 'below-minimum'
                          ? C.warn
                          : c.status === 'below-target'
                            ? C.warn
                            : C.success
                      }
                    />
                    {/* The target share as a rule across the track, not a second
                        bar: the question is which side of it he is on. No rule
                        where nothing was asked — a tick pinned to the left
                        edge is a target of nought drawn as a mark. */}
                    {c.targetBp > 0 ? (
                    <View
                      style={{
                        position: 'absolute',
                        left: `${Math.min(100, c.targetBp / 100)}%`,
                        top: -3,
                        width: 2,
                        height: 14,
                        backgroundColor: C.ink,
                      }}
                    />
                    ) : null}
                  </View>
                </View>
              ))}
              {current.unmatchedRevenuePaise ? (
                <T s="micro" style={{ marginTop: 12 }}>
                  {inrFromPaise(current.unmatchedRevenuePaise)} this month is for products not in the
                  product list. It counts as revenue, but adds no litres.
                </T>
              ) : null}
            </Card>
          ) : null}

          {shortfalls(current).length || shops?.summary.openPaise ? (
            <Card style={{ marginTop: 12 }}>
              <T s="label">Still to reach</T>
              {shortfalls(current).map((line) => (
                <T
                  key={line}
                  style={{ fontSize: 14, lineHeight: 20, color: C.ink, marginTop: 8 }}>
                  {line}
                </T>
              ))}
              {shops?.summary.openPaise ? (
                <T style={{ fontSize: 14, lineHeight: 20, color: C.ink, marginTop: 8 }}>
                  {inrFromPaise(shops.summary.openPaise)} still open across{' '}
                  {shops.summary.counts.open === 1
                    ? 'one of your customers'
                    : `${shops.summary.counts.open} of your customers`}
                  {' '}— the list is below.
                </T>
              ) : null}
            </Card>
          ) : null}


        </Swap>
      )}

      {/* Outside the branch above on purpose: a man with no score this month
          can still carry customer targets, and "nothing to show yet" over a
          list of his own shops would be the screen hiding the half that is
          there. */}
      {months !== null && !waiting && !failed ? (
        <CustomerTargetsCard
          key={monthKey ?? 'range'}
          period={monthKey}
          monthWords={monthKey ? monthName(monthKey) : ''}
          data={shops}
          today={today}
          onOpen={openShop}
        />
      ) : null}

      {current ? (
        <T s="caption" style={{ marginTop: 12 }}>
          Revenue counts only orders the office has accepted. Collection counts only money
          found in the bank. So both go up some time after you add them. Collection is the share
          of what was already overdue at the start of the period that has since been paid.
        </T>
      ) : null}

      <RangeSheet
        key={picking ? 'open' : 'shut'}
        open={picking}
        today={today}
        initial={custom}
        onClose={() => setPicking(false)}
        onPick={(p) => {
          setCustom(p);
          setKey('custom');
          setPicking(false);
        }}
      />
    </AppFrame>
  );
}

/**
 * Two days, picked one after the other on one calendar.
 *
 * The leave screen's calendar, with the future refused: there are no figures
 * in it, and a range ending next week reads as a period half failed.
 */
function RangeSheet({
  open,
  today,
  initial,
  onClose,
  onPick,
}: {
  open: boolean;
  today: string;
  initial: Period | null;
  onClose: () => void;
  onPick: (p: Period) => void;
}) {
  const [from, setFrom] = React.useState(initial?.from ?? '');
  const [to, setTo] = React.useState(initial?.to ?? '');
  const [end, setEnd] = React.useState<'from' | 'to'>('from');

  const dateBtn = (which: 'from' | 'to', value: string) => (
    <Pressable
      accessibilityRole="button"
      onPress={() => setEnd(which)}
      style={{
        flex: 1,
        minHeight: 48,
        justifyContent: 'center',
        paddingHorizontal: 12,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: end === which ? C.primary : C.border,
        backgroundColor: end === which ? C.primaryTint : C.surface,
      }}>
      <T s="micro">{which === 'from' ? 'From' : 'To'}</T>
      <T style={{ fontSize: 15, color: value ? C.ink : C.muted }}>{value ? dmy(value) : 'Pick a date'}</T>
    </Pressable>
  );

  return (
    <BottomSheet open={open} onClose={onClose}>
      <T s="h3" style={{ marginBottom: 10 }}>
        Pick the dates
      </T>
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
        {dateBtn('from', from)}
        {dateBtn('to', to)}
      </View>
      <Calendar
        key={end}
        selected={end === 'from' ? from : to}
        rangeFrom={from}
        rangeTo={to}
        disabledReason={(iso) =>
          iso > today
            ? 'There are no figures for days that have not happened.'
            : end === 'to' && from && iso < from
              ? 'Pick an end date after the start.'
              : null
        }
        onPick={(iso) => {
          if (end === 'from') {
            setFrom(iso);
            /* A start after the end is not a range — carry the end with it. */
            if (to && iso > to) setTo(iso);
            setEnd('to');
          } else {
            setTo(iso);
          }
        }}
      />
      <PrimaryButton
        label="Show this period"
        disabled={!from || !to}
        whyDisabled="Pick both dates."
        onPress={() => onPick(customPeriod(from, to))}
        style={{ marginTop: 12 }}
      />
    </BottomSheet>
  );
}

/** How a range's score was put together, in one sentence. */
function rangeTargetLine(m: PerformanceMonth): string {
  if (!m.hasTarget) return '';
  const months =
    m.monthsInRange === 1
      ? "Scored against that month's target."
      : m.monthsTargeted === m.monthsInRange
      ? `Scored against your targets for all ${plural(m.monthsInRange, 'month')} in this period, added up.`
      : `Only ${m.monthsTargeted} of the ${plural(m.monthsInRange, 'month')} in this period had a target, so the score is against those alone.`;
  return m.prorated
    ? `${months} A month only partly inside the period counts for its days inside it.`
    : months;
}

function pct(bp: number): string {
  return `${(bp / 100).toFixed(0)}%`;
}

function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/**
 * A figure with what it was against.
 *
 * Both, always. The percentage on its own hides that a target was small, and
 * the number on its own hides that it was missed.
 */
function Figure({
  label,
  value,
  target,
  base,
  bp,
  half,
  count,
}: {
  label: string;
  value: string;
  /*
   * The figure as a number, where it is one worth watching move. When the
   * office's live answer replaces the synced copy, revenue and volume run to
   * their new values rather than changing in place — so a morning's orders
   * landing reads as the figure rising. Not from zero: the figure itself is not
   * news on arrival, only its movement is.
   */
  count?: { n: number; format: (n: number) => string };
  target: string | null;
  /*
   * WHAT THE FIGURE IS A SHARE OF, for the two components where it is one.
   *
   * Collection is old debt worked down and activity is tasks completed out of
   * tasks set, and both were drawn as a bare number against an implied target.
   * "₹2.4L of ₹4.86L" told him the target and never what the target was 60% of
   * — so the one figure that explains his own number was on no screen he can
   * open. Null where the office sent none, which an older row legitimately is.
   */
  base?: string | null;
  bp: number | null;
  half?: boolean;
}) {
  return (
    <View
      style={{
        width: half ? '50%' : undefined,
        flex: half ? undefined : 1,
        minWidth: 0,
        padding: 14,
        borderTopWidth: 1,
        borderTopColor: C.wash,
      }}>
      <T s="label">{label}</T>
      {count ? (
        <CountUp
          value={count.n}
          format={count.format}
          style={[
            typeScale.body,
            { fontSize: 22, lineHeight: 28, marginVertical: 2, color: C.ink },
            weight(600),
            tabular,
          ]}
        />
      ) : (
        <T
          style={[
            { fontSize: 22, lineHeight: 28, marginVertical: 2, color: C.ink },
            weight(600),
            tabular,
          ]}>
          {value}
        </T>
      )}
      <T s="micro">
        {target ? `of ${target}` : 'no target'}
        {bp === null ? '' : ` · ${(bp / 100).toFixed(0)}%`}
      </T>
      {base ? <T s="micro">{base}</T> : null}
    </View>
  );
}

/**
 * The base under each of the two share components, in the phone's own words.
 *
 * `performance-labels` is the office's file, mirrored here and compared as text
 * by `mbos-wire.test.ts` — so the sentence a salesman reads on the handset is
 * the one his manager reads on the console, character for character. It renders
 * money through whatever the caller passes, which is why it can be shared at
 * all: `inrFromPaise` here, `money` there.
 */
function activityBaseLine(month: PerformanceMonth): string {
  return activitySub({ done: month.activityActual, base: month.activityAssigned });
}

function toneFor(bp: number): string {
  const score = bp / 100;
  if (score >= 80) return C.success;
  if (score >= 60) return C.warnInk;
  return C.ink;
}

function monthName(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(Date.UTC(y, m - 1, 15)));
}

/**
 * When the office last worked this out.
 *
 * Printed rather than hidden: these figures are a cache rebuilt hourly, and a
 * screen that implied they were live would be believed. The same courtesy the
 * credit limit and the outstanding balance already get here.
 */
function asAt(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'unknown';
  return new Intl.DateTimeFormat('en-GB', {
    hour: 'numeric',
    minute: '2-digit',
    day: 'numeric',
    month: 'short',
    timeZone: 'Asia/Kolkata',
  }).format(at);
}
