import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { router, useFocusEffect } from 'expo-router';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { PrimaryButton, T } from '../src/components/ui/primitives';
import { feedback } from '../src/components/ui/feedback';
import { Glyph, type GlyphShape } from '../src/components/me/kit';
import { BottomSheet, Calendar } from '../src/components/ui/overlays';
import { Appear, CountUp, FillBar, Swap } from '../src/components/ui/motion';
import { color as C, weight, tabular, type as typeScale } from '../src/theme/tokens';
import { dmy, inrFromPaise, plural, todayIst } from '../src/lib/format';
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
  /* The office's day, re-read on every focus below: a screen left open
     overnight into the 1st must move to the new month, not go on scoring the
     old one under "This month". */
  const [today, setToday] = React.useState(todayIst);
  const [months, setMonths] = React.useState<PerformanceMonth[] | null>(null);
  const [key, setKey] = React.useState<PeriodKey>('this-month');
  const [custom, setCustom] = React.useState<Period | null>(null);
  const [picking, setPicking] = React.useState(false);
  const [live, setLive] = React.useState<Live | null>(null);
  /* Bumped on every focus, so coming back to the screen reads again. */
  const [visit, setVisit] = React.useState(0);

  const load = React.useCallback(() => {
    let alive = true;
    /* A string, so an unchanged day is no re-render. */
    setToday(todayIst());
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
  const showsScore = Boolean(current && current.hasTarget && current.totalScoreBp !== null);

  return (
    <AppFrame
      tone="canvas"
      title="Performance"
      activeTab={null}
      onBack={back.go}
      contentStyle={{ paddingHorizontal: 14, paddingTop: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />

      {/* The periods. A row that scrolls sideways rather than a menu: which
          window he is looking at is the first thing on the screen, and a
          choice hidden behind a tap is one people forget they made. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ marginHorizontal: -14 }}
        contentContainerStyle={{ gap: 8, paddingHorizontal: 20 }}>
        {PRESETS.map((p) => (
          <PeriodChip key={p.key} label={p.label} selected={key === p.key} onPress={() => setKey(p.key)} />
        ))}
        {/* Until a range is picked this is only the calendar mark; once one
            is, the chip carries the dates, so the window on screen is named
            where it was chosen. */}
        <PeriodChip
          label={key === 'custom' && custom ? rangeWords(custom) : undefined}
          a11y={key === 'custom' && custom ? rangeWords(custom) : 'Pick dates'}
          glyph={CAL}
          selected={key === 'custom'}
          onPress={() => setPicking(true)}
        />
      </ScrollView>

      {/* The window and when the office worked it out. Inside the navy score
          card where there is a score; here, under the chips, where there is
          not — the range is said on every state of the screen. */}
      {showsScore ? null : (
        <T style={{ fontSize: 12, color: C.muted, marginTop: 10, paddingHorizontal: 6 }}>
          {rangeWords(period)}
          {current?.computedAt
            ? ` · ${current.source === 'live' ? 'worked out' : 'synced'} ${asAt(current.computedAt)}`
            : ''}
        </T>
      )}

      {months === null || waiting ? (
        <View style={{ marginTop: 14, minHeight: 44, paddingVertical: 6, borderRadius: 22, backgroundColor: C.surface, alignItems: 'center', justifyContent: 'center' }}>
          <T style={{ fontSize: 13, color: C.muted }}>Loading…</T>
        </View>
      ) : failed ? (
        <View
          accessible
          accessibilityLabel={`This period is worked out by the office, and it could not be reached. ${failed}. This month and last month are kept on the phone and open without signal — any other period needs a connection.`}
          style={[note, { backgroundColor: C.dangerBg, alignItems: 'flex-start' }]}>
          <Glyph shapes={NO_CLOUD} size={20} color={C.danger} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[{ fontSize: 14, lineHeight: 20, color: C.danger }, weight(700)]}>The office could not be reached for this period</Text>
            <T style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
              {failed}. This and last month open offline — any other period needs a connection.
            </T>
          </View>
        </View>
      ) : !current ? (
        <View
          accessible
          accessibilityLabel="Nothing to show yet. The office sets your target. It will come to this phone after that. Until then there is nothing to measure against, so no percentage is shown."
          style={[note, { alignItems: 'flex-start' }]}>
          <Glyph shapes={CLOCK} size={20} color={C.muted} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[{ fontSize: 14, lineHeight: 20, color: C.ink }, weight(700)]}>Nothing to show yet</Text>
            <T style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
              The office sets your target; it reaches this phone after that. No percentage until then.
            </T>
          </View>
        </View>
      ) : (
        /* ONE PERIOD REPLACING ANOTHER. Keyed on the range, so picking a new
           period settles the figures in afresh — and the score, which counts
           up from nought on arrival, counts again: the number for the new
           window is news in exactly the way the first one was. The chip
           itself already ticks `select`, so nothing here buzzes. */
        <Swap id={rangeKey}>

          {current.hasTarget && current.totalScoreBp !== null ? (
            <View style={{ marginTop: 14, backgroundColor: C.navy, borderRadius: 24, padding: 18 }}>
              <RangeLine period={period} current={current} />
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 14 }}>
                <ScoreRing bp={current.totalScoreBp} />
                <View style={{ flex: 1, minWidth: 0, alignItems: 'flex-start' }}>
                  {current.rating ? (
                    <Text style={[{ fontSize: 22, lineHeight: 28, letterSpacing: -0.44, color: '#FFFFFF' }, weight(800)]}>
                      {current.rating}
                    </Text>
                  ) : null}
                  {previous?.period && previous.totalScoreBp != null ? (
                    <NavyTag glyph={TREND} text={`${monthName(previous.period)} was ${(previous.totalScoreBp / 100).toFixed(1)}`} />
                  ) : current.monthsInRange > 1 ? (
                    <NavyTag text={`${current.monthsTargeted} of ${plural(current.monthsInRange, 'month')} targeted`} />
                  ) : null}
                </View>
              </View>
              {/* A range over several months is scored against the targets
                  those months carried, added up — and it has to say how many
                  that was. A year scored on three targeted months out of
                  twelve is a different statement from one scored on twelve. */}
              {current.monthsInRange > 1 || current.prorated ? (
                <Text style={{ fontSize: 12, lineHeight: 17, color: C.onNavyMuted, marginTop: 10 }}>
                  {rangeTargetLine(current)}
                </Text>
              ) : null}
              {/* WHAT WAS LEFT OUT IS PART OF THE NUMBER, not a footnote to it.
                  An 84 earned across six components and an 84 earned across
                  three are different months, and the office's own screen has
                  always said which — this one drew the 34-point figure and
                  stopped. */}
              {dropped ? (
                <Text style={{ fontSize: 12, lineHeight: 17, color: C.onNavyMuted, marginTop: 10 }}>{dropped}</Text>
              ) : null}
            </View>
          ) : (
            <View>
              <View style={note}>
                <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: C.canvas, alignItems: 'center', justifyContent: 'center' }}>
                  <Glyph shapes={NO_TARGET} size={18} color={C.muted} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[{ fontSize: 14, lineHeight: 20, color: C.ink }, weight(700)]}>
                    No target set {monthKey ? 'this month' : 'in this period'}
                  </Text>
                  <T style={{ fontSize: 12, color: C.muted }}>What you did is below. No score without a target.</T>
                </View>
              </View>
            </View>
          )}

          {/* Revenue and volume, side by side and in that order. See the note
              at the top of the file — this pairing is the point of the screen.

              `inr()` TAKES RUPEES. Every money column on this row is paise, and
              these five call sites passed the column straight in — so a month
              of ₹8,50,000 was drawn as ₹8,50,00,000, against a target printed
              100× too big as well. The "What is short" card at the foot of the
              same screen has its own correct helper, so the two disagreed by
              two decimal places with nothing saying which half to believe. */}
          <View style={grid2}>
            <Figure
              glyph={RUPEE}
              label="Revenue excl. GST"
              value={inrFromPaise(current.revenueActualPaise)}
              count={{ n: current.revenueActualPaise, format: (n) => inrFromPaise(Math.round(n)) }}
              target={current.revenueTargetPaise ? inrFromPaise(current.revenueTargetPaise) : null}
              bp={current.revenueAchievementBp}
            />
            <Figure
              glyph={DROP}
              label="Volume"
              value={litres(current.volumeActualMl)}
              count={{ n: current.volumeActualMl, format: litres }}
              target={current.volumeTargetMl ? litres(current.volumeTargetMl) : null}
              bp={current.volumeAchievementBp}
            />
          </View>

          {/* The warning arrives a beat after the two figures it is about, so
              it reads as a conclusion drawn from them rather than as part of
              the furniture of the screen. */}
          {priceNotVolume(current) ? (
            <Appear
              delay={360}
              style={{
                backgroundColor: C.warnBg,
                borderRadius: 18,
                paddingHorizontal: 14,
                paddingVertical: 12,
                marginTop: 10,
                flexDirection: 'row',
                gap: 10,
                alignItems: 'flex-start',
              }}>
              <Glyph shapes={WARN} size={18} color={C.warnInk} />
              <T style={{ flex: 1, fontSize: 13, lineHeight: 18, color: C.warnInk }}>
                Rupee target reached, litres not. Prices went up but you sold less quantity — this month
                is not as good as it looks.
              </T>
            </Appear>
          ) : null}

          {/* WHAT HE TOOK AND NOBODY HAS DECIDED YET. Revenue counts accepted
              orders only, so on a busy morning the figure above lags what he
              actually sold — and with nothing saying so it reads as a slow
              day. Shown beside the revenue, never added to it. */}
          {shops && shops.summary.waitingPaise ? (
            <View
              accessible
              accessibilityLabel={`${inrFromPaise(shops.summary.waitingPaise)} more is waiting for the office to accept. It is not in the revenue above yet.`}
              style={{ marginTop: 8, minHeight: 36, borderRadius: 18, backgroundColor: C.surface, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8 }}>
              <Glyph shapes={CLOCK} size={16} color={C.warnInk} />
              <Text style={[{ flex: 1, fontSize: 13, lineHeight: 18, color: C.warnInk }, weight(600)]}>
                {inrFromPaise(shops.summary.waitingPaise)} waiting for the office · not in revenue yet
              </Text>
            </View>
          ) : null}

          <View style={grid2}>
            <Figure
              glyph={NEW_PERSON}
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
              glyph={CARD}
              label="Collected"
              value={collectedBp === null ? '—' : pct(collectedBp)}
              target={current.collectionTargetBp ? pct(current.collectionTargetBp) : null}
              base={collectionLine(
                { done: current.collectionActualPaise, base: current.collectionBasePaise },
                inrFromPaise,
              )}
              bp={null}
            />
          </View>
          <View style={grid2}>
            <Figure
              glyph={PIN}
              label="Visits and calls"
              value={String(current.activityActual)}
              target={current.activityTarget ? String(current.activityTarget) : null}
              base={activityBaseLine(current)}
              bp={null}
            />
            <Figure
              glyph={PIE}
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
              bare
              bp={null}
            />
          </View>

          {current.categories.length ? (
            <View style={[card, { marginTop: 10 }]}>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
                <Text accessibilityRole="header" style={[{ fontSize: 15, lineHeight: 21, color: C.ink }, weight(700)]}>Product mix</Text>
                {current.revenueActualPaise === 0 ? null : (
                  <Text style={{ fontSize: 12, lineHeight: 17, color: C.muted }}>share of sales, by value · | = target</Text>
                )}
              </View>
              {current.revenueActualPaise === 0 ? (
                /* An empty month is said in words rather than drawn as four
                   empty tracks. Bars at 0.0% under "share of what you sold"
                   read as a salesman selling none of what was asked, on the
                   2nd of the month, when the truth is nothing has been
                   approved yet. The target is what is worth reading then. */
                <T style={{ marginTop: 8, fontSize: 13, color: C.body }}>
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
              ) : null}
              {(current.revenueActualPaise === 0
                ? []
                : /* A share nobody asked for and nothing has landed in is a
                     row with nothing to say — "Other 0.0% of 0%" with a
                     tick at the edge looked like a stray mark. It comes
                     back the moment something sells into it. */
                  current.categories.filter((c) => c.targetBp > 0 || c.actualBp > 0)
              ).map((c, i) => (
                <View
                  key={c.name}
                  accessible
                  accessibilityLabel={`${c.name}: ${(c.actualBp / 100).toFixed(1)}% of ${(c.targetBp / 100).toFixed(0)}%${c.actualMl ? ', ' + litres(c.actualMl) : ''}`}
                  style={{ marginTop: 12 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
                    <Text style={[{ flexShrink: 1, fontSize: 14, lineHeight: 20, color: C.ink }, weight(600)]}>{c.name}</Text>
                    <Text style={[{ fontSize: 12, lineHeight: 17, color: C.muted }, tabular]}>
                      {(c.actualBp / 100).toFixed(1) + '% / ' + (c.targetBp / 100).toFixed(0) + '%'}
                      {c.actualMl ? ' · ' + litres(c.actualMl) : ''}
                    </Text>
                  </View>
                  <View style={{ position: 'relative', height: 10, marginTop: 6 }}>
                    {/* Filled one after another, 60 ms apart, so the eye reads
                        the shares down the card in order rather than all at
                        once. The track is FillBar's own; this View only holds
                        the target rule over it. */}
                    <FillBar
                      pct={c.actualBp / 100}
                      height={10}
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
                        width: 3,
                        height: 16,
                        borderRadius: 2,
                        backgroundColor: C.ink,
                      }}
                    />
                    ) : null}
                  </View>
                </View>
              ))}
              {current.unmatchedRevenuePaise ? (
                <View style={{ flexDirection: 'row', gap: 6, marginTop: 12 }}>
                  <Glyph shapes={INFO} size={14} color={C.muted} />
                  <T style={{ flex: 1, fontSize: 12, color: C.muted }}>
                    {inrFromPaise(current.unmatchedRevenuePaise)} for products not in the product list —
                    counts as revenue, adds no litres.
                  </T>
                </View>
              ) : null}
            </View>
          ) : null}

          {shortfalls(current).length || shops?.summary.openPaise ? (
            <View style={[card, { marginTop: 10 }]}>
              <Text accessibilityRole="header" style={[{ fontSize: 15, lineHeight: 21, color: C.ink }, weight(700)]}>Still to reach</Text>
              {shortfalls(current).map((line) => (
                <View key={line} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start', marginTop: 10 }}>
                  <Glyph shapes={shortfallGlyph(line)} size={18} color={C.muted} />
                  <T style={{ flex: 1, fontSize: 14, lineHeight: 20, color: C.ink }}>{line}</T>
                </View>
              ))}
              {shops?.summary.openPaise ? (
                <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start', marginTop: 10 }}>
                  <Glyph shapes={SHOP} size={18} color={C.muted} />
                  <T style={{ flex: 1, fontSize: 14, lineHeight: 20, color: C.ink }}>
                    {inrFromPaise(shops.summary.openPaise)} still open across{' '}
                    {shops.summary.counts.open === 1
                      ? 'one of your customers'
                      : `${shops.summary.counts.open} of your customers`}
                    {' '}— the list is below.
                  </T>
                </View>
              ) : null}
            </View>
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
        <View
          accessible
          accessibilityLabel="Revenue counts only orders the office has accepted. Collection counts only money found in the bank. So both go up some time after you add them. Collection is the share of what was already overdue at the start of the period that has since been paid."
          style={{ flexDirection: 'row', gap: 8, marginTop: 12, paddingHorizontal: 6 }}>
          <Glyph shapes={INFO} size={14} color={C.muted} />
          <T style={{ flex: 1, fontSize: 12, lineHeight: 17, color: C.muted }}>
            Revenue counts accepted orders only; collection counts money found in the bank — both rise
            some time after you add them. Collection = share of what was overdue at the start that has
            since been paid.
          </T>
        </View>
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

/* ---------------------------------------------------------- Version 3 bits */

const card = { backgroundColor: C.surface, borderRadius: 20, padding: 16 } as const;
const note = {
  marginTop: 14,
  backgroundColor: C.surface,
  borderRadius: 20,
  paddingVertical: 14,
  paddingHorizontal: 16,
  flexDirection: 'row',
  alignItems: 'center',
  gap: 10,
} as const;
const grid2 = { flexDirection: 'row', gap: 10, marginTop: 10 } as const;

const CAL: GlyphShape[] = [{ r: [4, 5, 16, 15, 2] }, { p: 'M4 10h16M9 3v4M15 3v4' }];
const CAL_SMALL: GlyphShape[] = [{ r: [4, 5, 16, 15, 2] }, { p: 'M4 10h16' }];
const SYNCED: GlyphShape[] = [{ p: 'M7 18a5 5 0 1 1 1-9.9A6 6 0 0 1 19 10a4 4 0 0 1-1 8z' }, { p: 'M9.5 13.5l2 2 3.5-3.5' }];
const NO_CLOUD: GlyphShape[] = [{ p: 'M7 18a5 5 0 1 1 1-9.9A6 6 0 0 1 19 10a4 4 0 0 1-1 8z' }, { p: 'M4 4l16 16' }];
const CLOCK: GlyphShape[] = [{ c: [12, 12, 8] }, { p: 'M12 8v4l3 2' }];
const TREND: GlyphShape[] = [{ p: 'M3 17l6-6 4 4 8-8' }];
const RUPEE: GlyphShape[] = [{ p: 'M7 5h10M7 9h10M10 5c3 0 4 2 4 4s-2 4-5 4h-2l7 7' }];
const DROP: GlyphShape[] = [{ p: 'M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z' }];
const WARN: GlyphShape[] = [{ p: 'M12 4l9 16H3z' }, { p: 'M12 10v4M12 17h.01' }];
const NEW_PERSON: GlyphShape[] = [{ c: [10, 8, 4] }, { p: 'M2 21c0-4 4-6 8-6M18 14v6M15 17h6' }];
const CARD: GlyphShape[] = [{ r: [3, 6, 18, 13, 2] }, { p: 'M3 10h18' }];
const PIN: GlyphShape[] = [{ p: 'M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11z' }, { c: [12, 10, 2.5] }];
const PIE: GlyphShape[] = [{ p: 'M12 3v9l7 5M21 12a9 9 0 1 1-9-9' }];
const INFO: GlyphShape[] = [{ c: [12, 12, 8] }, { p: 'M12 8v5M12 16h.01' }];
const SHOP: GlyphShape[] = [{ p: 'M3 21V9l9-6 9 6v12z' }];
const NO_TARGET: GlyphShape[] = [{ c: [12, 12, 8] }, { c: [12, 12, 3] }, { p: 'M5 19L19 5' }];
const PERSON: GlyphShape[] = [{ c: [12, 8, 4] }, { p: 'M4 21c0-4 4-6 8-6s8 2 8 6' }];
const MIX: GlyphShape[] = [{ p: 'M4 20V10M10 20V4M16 20v-7' }];

/** The mark beside a "still to reach" line, read off what the line is about. */
function shortfallGlyph(line: string): GlyphShape[] {
  const l = line.toLowerCase();
  if (l.includes('revenue')) return RUPEE;
  if (l.includes('volume')) return DROP;
  if (l.includes('collect')) return CARD;
  if (l.includes('customer')) return PERSON;
  if (l.includes('visit') || l.includes('task')) return PIN;
  return MIX;
}

/** A 36 period pill: navy when it is the window on screen, white otherwise. */
function PeriodChip({
  label,
  a11y,
  glyph,
  selected,
  onPress,
}: {
  label?: string;
  a11y?: string;
  glyph?: GlyphShape[];
  selected: boolean;
  onPress: () => void;
}) {
  const fg = selected ? '#FFFFFF' : C.ink;
  return (
    <Pressable
      onPress={() => {
        if (!selected) feedback('select');
        onPress();
      }}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={a11y ?? label}
      hitSlop={{ top: 6, bottom: 6 }}
      style={({ pressed }) => ({
        minHeight: 36,
        paddingVertical: 6,
        minWidth: 36,
        paddingHorizontal: label ? (glyph ? 12 : 14) : 0,
        borderRadius: 18,
        backgroundColor: selected ? C.navy : C.surface,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        opacity: pressed ? 0.85 : 1,
      })}>
      {glyph ? <Glyph shapes={label ? CAL_SMALL : glyph} size={label ? 14 : 16} color={fg} /> : null}
      {label ? <Text style={[{ flexShrink: 1, fontSize: 13, lineHeight: 18, color: fg }, weight(selected ? 700 : 600)]}>{label}</Text> : null}
    </Pressable>
  );
}

/** The range and when the office worked it out, in the score card. */
function RangeLine({ period, current }: { period: Period; current: PerformanceMonth }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <Glyph shapes={CAL_SMALL} size={12} color={C.onNavyMuted} />
      <Text style={{ flexShrink: 1, fontSize: 12, lineHeight: 17, color: C.onNavyMuted }}>{rangeWords(period)}</Text>
      <View style={{ flex: 1 }} />
      {current.computedAt ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Glyph shapes={SYNCED} size={12} color={C.onNavyMuted} />
          <Text style={{ flexShrink: 1, fontSize: 12, lineHeight: 17, color: C.onNavyMuted }}>
            {(current.source === 'live' ? 'worked out ' : 'synced ') + asAt(current.computedAt)}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** A 28 pill on the navy score card. */
function NavyTag({ text, glyph }: { text: string; glyph?: GlyphShape[] }) {
  return (
    <View
      style={{
        marginTop: 6,
        minHeight: 28,
        paddingVertical: 4,
        paddingHorizontal: 10,
        borderRadius: 14,
        backgroundColor: 'rgba(255,255,255,0.08)',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
      }}>
      {glyph ? <Glyph shapes={glyph} size={12} color={C.border} /> : null}
      <Text numberOfLines={1} style={[{ flexShrink: 1, fontSize: 12, color: C.border }, weight(700)]}>{text}</Text>
    </View>
  );
}

/**
 * The score as a ring on the navy card, coloured by band: lime from 80, amber
 * from 60, red under it — the same bands `toneFor` draws in words.
 */
function ScoreRing({ bp }: { bp: number }) {
  const score = bp / 100;
  const r = 38;
  const circ = 2 * Math.PI * r;
  const arc = Math.max(0, Math.min(1, score / 100)) * circ;
  const ring = score >= 80 ? C.lime : score >= 60 ? '#F5B83D' : '#FF6B5E';
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={`Overall ${score.toFixed(1)} out of 100`} style={{ width: 96, height: 96 }}>
      <Svg width={96} height={96} viewBox="0 0 92 92">
        <Circle cx={46} cy={46} r={r} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth={9} />
        {arc > 0 ? (
          <Circle
            cx={46}
            cy={46}
            r={r}
            fill="none"
            stroke={ring}
            strokeWidth={9}
            strokeLinecap="round"
            strokeDasharray={[arc, circ]}
            transform="rotate(-90 46 46)"
          />
        ) : null}
      </Svg>
      <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
        {/* The score is what this screen is for, so it counts up from nought
            rather than simply being there — and when the office's live answer
            replaces the synced one, it runs from the old figure to the new,
            which is the only way somebody sees that it moved. */}
        <CountUp
          value={score}
          format={(n) => n.toFixed(1)}
          fromZero
          duration={800}
          style={[typeScale.body, { fontSize: 22, lineHeight: 26, color: '#FFFFFF' }, weight(800), tabular]}
        />
        <Text style={{ fontSize: 10, color: C.onNavyMuted }}>of 100</Text>
      </View>
    </View>
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

  const dateBtn = (which: 'from' | 'to', value: string) => {
    const on = end === which;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: on }}
        accessibilityLabel={`${which === 'from' ? 'From' : 'To'}: ${value ? dmy(value) : 'pick a date'}`}
        onPress={() => setEnd(which)}
        style={{
          flex: 1,
          minHeight: 56,
          paddingVertical: 6,
          justifyContent: 'center',
          paddingHorizontal: 14,
          borderRadius: 18,
          borderWidth: on ? 2 : 1,
          borderColor: on ? C.primary : C.border,
          backgroundColor: on ? C.primaryTint : C.surface,
        }}>
        <Text style={[{ fontSize: 11, color: on ? C.primaryDeep : C.muted }, weight(700)]}>{which === 'from' ? 'From' : 'To'}</Text>
        <Text style={[{ fontSize: 15, lineHeight: 21, color: value ? C.ink : C.muted }, weight(value ? 700 : 600)]}>
          {value ? dmy(value) : 'Pick a date'}
        </Text>
      </Pressable>
    );
  };

  return (
    <BottomSheet open={open} onClose={onClose}>
      <Text accessibilityRole="header" style={[{ fontSize: 20, lineHeight: 26, color: C.ink }, weight(800)]}>
        Pick the dates
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, marginBottom: 8 }}>
        {dateBtn('from', from)}
        <Glyph shapes={[{ p: 'M5 12h14M13 6l6 6-6 6' }]} size={18} color={C.faint} />
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
      <View style={{ flexDirection: 'row', gap: 6, marginTop: 6 }}>
        <Glyph shapes={INFO} size={14} color={C.muted} />
        <T style={{ flex: 1, fontSize: 12, color: C.muted }}>Faded days: no figures yet, or before the start date.</T>
      </View>
      <PrimaryButton
        label="Show this period"
        disabled={!from || !to}
        whyDisabled="Pick both dates."
        onPress={() => onPick(customPeriod(from, to))}
        style={{ marginTop: 14 }}
      />
      {!from || !to ? (
        <T style={{ fontSize: 12, color: C.muted, marginTop: 4, textAlign: 'center' }}>Pick both dates.</T>
      ) : null}
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
 * the number on its own hides that it was missed. Version 3 draws each as its
 * own white card, two to a row, with the achievement as a tag.
 */
function Figure({
  label,
  glyph,
  value,
  target,
  base,
  bp,
  count,
  bare = false,
}: {
  label: string;
  glyph: GlyphShape[];
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
  /** The target is a sentence of its own ("3 formulations set"), not "of" a figure. */
  bare?: boolean;
}) {
  const valueStyle = [typeScale.body, { fontSize: 24, lineHeight: 30, letterSpacing: -0.48, color: C.ink, marginTop: 6 }, weight(800), tabular];
  const met = bp !== null && bp >= 10_000;
  return (
    <View style={{ flex: 1, minWidth: 0, backgroundColor: C.surface, borderRadius: 20, padding: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Glyph shapes={glyph} size={14} color={C.muted} />
        <Text numberOfLines={1} style={[{ flexShrink: 1, fontSize: 12, color: C.muted }, weight(700)]}>{label}</Text>
      </View>
      {count ? (
        <CountUp value={count.n} format={count.format} style={valueStyle} />
      ) : (
        <Text style={valueStyle}>{value}</Text>
      )}
      <Text style={{ fontSize: 12, lineHeight: 17, color: target ? C.muted : C.faint }}>
        {target ? (bare ? target : `of ${target}`) : 'no target'}
      </Text>
      {base ? <Text style={{ fontSize: 12, lineHeight: 17, color: C.muted }}>{base}</Text> : null}
      {bp === null ? null : (
        <View
          style={{
            marginTop: 8,
            alignSelf: 'flex-start',
            minHeight: 26,
            paddingVertical: 3,
            paddingHorizontal: 9,
            borderRadius: 13,
            backgroundColor: met ? C.successBg : C.warnBg,
            justifyContent: 'center',
          }}>
          <Text style={[{ fontSize: 12, lineHeight: 17, color: met ? C.success : C.warnInk }, weight(800), tabular]}>
            {(bp / 100).toFixed(0)}%
          </Text>
        </View>
      )}
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
