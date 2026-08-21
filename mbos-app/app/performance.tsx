import React from 'react';
import { View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, T } from '../src/components/ui/primitives';
import { color as C, radius, weight, tabular } from '../src/theme/tokens';
import { inr } from '../src/lib/format';
import {
  listPerformance,
  litres,
  priceNotVolume,
  shortfalls,
  type PerformanceMonth,
} from '../src/data/performance';

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
 */

export default function PerformanceScreen() {
  const back = useCameFrom('more');
  const [months, setMonths] = React.useState<PerformanceMonth[] | null>(null);

  const load = React.useCallback(() => {
    let live = true;
    void listPerformance().then((rows) => {
      if (live) setMonths(rows);
    });
    return () => {
      live = false;
    };
  }, []);

  useFocusEffect(load);

  const current = months?.[0] ?? null;
  const previous = months?.[1] ?? null;

  return (
    <AppFrame title="MBOS" activeTab={null} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />
      <T s="h1">Performance</T>

      {months === null ? (
        <T s="small" style={{ color: C.muted, marginTop: 2 }}>
          Reading…
        </T>
      ) : !current ? (
        <Card style={{ marginTop: 12 }}>
          <T style={{ fontSize: 14, lineHeight: 20, color: C.ink }}>
            Nothing to show yet.
          </T>
          <T s="small" style={{ color: C.muted, marginTop: 6 }}>
            Your target is set in the office and arrives on the next sync. Until
            somebody sets one there is nothing to measure against — this screen will
            not invent a percentage.
          </T>
        </Card>
      ) : (
        <>
          <T s="small" style={{ color: C.muted, marginTop: 2 }}>
            {monthName(current.period)}
            {current.computedAt ? ` · as at ${asAt(current.computedAt)}` : ''}
          </T>

          {current.hasTarget && current.totalScoreBp !== null ? (
            <Card style={{ marginTop: 12, alignItems: 'flex-start' }}>
              <T s="label">Overall</T>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                <T
                  style={[
                    { fontSize: 34, lineHeight: 40, color: toneFor(current.totalScoreBp) },
                    weight(600),
                    tabular,
                  ]}>
                  {(current.totalScoreBp / 100).toFixed(0)}
                </T>
                <T s="small" style={{ color: C.muted }}>
                  out of 100
                </T>
              </View>
              {current.rating ? (
                <T style={{ fontSize: 14, lineHeight: 20, color: C.ink }}>
                  {current.rating}
                </T>
              ) : null}
              {previous?.totalScoreBp != null ? (
                <T s="micro" style={{ marginTop: 4 }}>
                  {monthName(previous.period)} was {(previous.totalScoreBp / 100).toFixed(0)}
                </T>
              ) : null}
            </Card>
          ) : (
            <Card style={{ marginTop: 12 }}>
              <T style={{ fontSize: 14, lineHeight: 20, color: C.ink }}>
                No target has been set for you this month.
              </T>
              <T s="small" style={{ color: C.muted, marginTop: 6 }}>
                What is below is what you have actually done. There is no score,
                because a score needs something to have been asked for.
              </T>
            </Card>
          )}

          {/* Revenue and volume, side by side and in that order. See the note
              at the top of the file — this pairing is the point of the screen. */}
          <Card padded={false} style={{ marginTop: 12, flexDirection: 'row', overflow: 'hidden' }}>
            <Figure
              label="Revenue"
              value={inr(current.revenueActualPaise)}
              target={current.revenueTargetPaise ? inr(current.revenueTargetPaise) : null}
              bp={current.revenueAchievementBp}
            />
            <Figure
              label="Volume"
              value={litres(current.volumeActualMl)}
              target={current.volumeTargetMl ? litres(current.volumeTargetMl) : null}
              bp={current.volumeAchievementBp}
            />
          </Card>

          {priceNotVolume(current) ? (
            <View
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
                You are at target on rupees but not on litres. Prices went up more than
                the quantity you sold — worth knowing before this reads as a good month.
              </T>
            </View>
          ) : null}

          <Card padded={false} style={{ marginTop: 12, flexDirection: 'row', flexWrap: 'wrap', overflow: 'hidden' }}>
            <Figure
              half
              label="New customers"
              value={String(current.newCustomerActual)}
              target={current.newCustomerTarget ? String(current.newCustomerTarget) : null}
              bp={null}
            />
            <Figure
              half
              label="Collected"
              value={inr(current.collectionActualPaise)}
              target={
                current.collectionTargetPaise ? inr(current.collectionTargetPaise) : null
              }
              bp={null}
            />
            <Figure
              half
              label="Visits and calls"
              value={String(current.activityActual)}
              target={current.activityTarget ? String(current.activityTarget) : null}
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
              target={null}
              bp={null}
            />
          </Card>

          {current.categories.length ? (
            <Card style={{ marginTop: 12 }}>
              <T s="label">Product mix</T>
              <T s="micro" style={{ marginTop: 2 }}>
                Share of what you sold, by value.
              </T>
              {current.categories.map((c) => (
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
                      borderRadius: 4,
                      backgroundColor: C.hairline,
                      marginTop: 6,
                    }}>
                    <View
                      style={{
                        width: `${Math.min(100, (c.actualBp / 100))}%`,
                        height: '100%',
                        borderRadius: 4,
                        backgroundColor:
                          c.status === 'below-minimum'
                            ? C.warn
                            : c.status === 'below-target'
                              ? C.warn
                              : C.success,
                      }}
                    />
                    {/* The target share as a rule across the track, not a second
                        bar: the question is which side of it he is on. */}
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
                  </View>
                </View>
              ))}
              {current.unmatchedRevenuePaise ? (
                <T s="micro" style={{ marginTop: 12 }}>
                  {inr(current.unmatchedRevenuePaise)} of this month is on products the
                  catalogue does not recognise. It counts as revenue and adds no litres.
                </T>
              ) : null}
            </Card>
          ) : null}

          {shortfalls(current).length ? (
            <Card style={{ marginTop: 12 }}>
              <T s="label">What is short</T>
              {shortfalls(current).map((line) => (
                <T
                  key={line}
                  style={{ fontSize: 14, lineHeight: 20, color: C.ink, marginTop: 8 }}>
                  {line}
                </T>
              ))}
            </Card>
          ) : null}

          <T s="caption" style={{ marginTop: 12 }}>
            Revenue counts orders the office has accepted, and collection counts money
            accounts have found in the bank — so both move after you have logged them,
            not as you log them.
          </T>
        </>
      )}
    </AppFrame>
  );
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
  bp,
  half,
}: {
  label: string;
  value: string;
  target: string | null;
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
      <T
        style={[
          { fontSize: 22, lineHeight: 28, marginVertical: 2, color: C.ink },
          weight(600),
          tabular,
        ]}>
        {value}
      </T>
      <T s="micro">
        {target ? `of ${target}` : 'nothing asked'}
        {bp === null ? '' : ` · ${(bp / 100).toFixed(0)}%`}
      </T>
    </View>
  );
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
