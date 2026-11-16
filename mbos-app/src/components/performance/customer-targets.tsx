import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { SecondaryButton } from '../ui/primitives';
import { CountUp, FillBar, Stagger, animateLayoutFor } from '../ui/motion';
import { feedback } from '../ui/feedback';
import { Glyph, type GlyphShape } from '../me/kit';
import { color as C, weight, tabular, type as typeScale } from '../../theme/tokens';
import { inrFromPaise, plural } from '../../lib/format';
import { customerTargetsComputedAt, listCustomerTargets } from '../../data/customer-targets';
import {
  TARGET_FILTERS,
  billGap,
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

/**
 * The card's title, the same in every state. It sits directly under his own
 * revenue target and draws a rupee figure "of" a rupee figure, so it has to
 * say on its face that this is the SUM of his shops' targets — read as
 * "Your customers' targets" it was taken for a second copy of his own.
 */
function CardTitle() {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
      <Text accessibilityRole="header" style={[{ flexShrink: 1, fontSize: 15, lineHeight: 21, color: C.ink }, weight(700)]}>Shop targets</Text>
      <Text style={{ flexShrink: 1, fontSize: 12, lineHeight: 17, color: C.muted }}>sum of each shop&apos;s monthly target</Text>
    </View>
  );
}

const CARD = { marginTop: 10, backgroundColor: C.surface, borderRadius: 20, padding: 16 } as const;
const SHOP: GlyphShape[] = [{ p: 'M3 21V9l9-6 9 6v12z' }];
const CLOUD: GlyphShape[] = [{ p: 'M7 18a5 5 0 1 1 1-9.9A6 6 0 0 1 19 10a4 4 0 0 1-1 8z' }];
const CLOCK: GlyphShape[] = [{ c: [12, 12, 8] }, { p: 'M12 8v4l3 2' }];
const CART: GlyphShape[] = [{ p: 'M4 5h2l2 11h10l2-8H7' }];
const PHONE: GlyphShape[] = [{ r: [7, 3, 10, 18, 2] }];
const PIN: GlyphShape[] = [{ p: 'M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11z' }];
const TICK: GlyphShape[] = [{ p: 'M5 12l5 5 9-10' }];

/** A 28 tag on a shop row or the summary — a figure, a state, a note. */
function Tag({
  text,
  tone = 'grey',
  glyph,
  a11y,
}: {
  text: string;
  tone?: 'grey' | 'purple' | 'warn' | 'ok' | 'ink';
  glyph?: GlyphShape[];
  a11y?: string;
}) {
  const t = {
    grey: { bg: C.canvas, fg: C.muted },
    ink: { bg: C.canvas, fg: C.ink },
    purple: { bg: C.primaryTint, fg: C.primaryDeep },
    warn: { bg: C.warnBg, fg: C.warnInk },
    ok: { bg: C.successBg, fg: C.success },
  }[tone];
  return (
    <View
      accessible={!!a11y}
      accessibilityLabel={a11y}
      style={{ minHeight: 28, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 14, backgroundColor: t.bg, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      {glyph ? <Glyph shapes={glyph} size={12} color={t.fg} strokeWidth={2.2} /> : null}
      <Text style={[{ fontSize: 12, lineHeight: 17, color: t.fg }, weight(700), tabular]}>{text}</Text>
    </View>
  );
}

/** A note card: a mark and a sentence, for the states with nothing to list. */
function Note({ glyph, title, children }: { glyph: GlyphShape[]; title?: string; children: React.ReactNode }) {
  return (
    <View style={[CARD, { paddingVertical: 14, flexDirection: 'row', gap: 10, alignItems: 'center' }]}>
      <Glyph shapes={glyph} size={20} color={C.muted} />
      <View style={{ flex: 1, minWidth: 0 }}>
        {title ? <Text style={[{ fontSize: 14, lineHeight: 20, color: C.ink }, weight(700)]}>{title}</Text> : null}
        <Text style={{ fontSize: title ? 12 : 13, lineHeight: title ? 17 : 18, marginTop: title ? 2 : 0, color: title ? C.muted : C.body }}>{children}</Text>
      </View>
    </View>
  );
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
      <Note glyph={SHOP} title="Shop targets">
        Set month by month — pick This or Last month to see each shop.
      </Note>
    );
  }

  if (!data) {
    return (
      <View style={CARD}>
        <CardTitle />
        <Text style={{ fontSize: 13, lineHeight: 18, color: C.muted, marginTop: 6 }}>Loading…</Text>
      </View>
    );
  }

  if (!data.rows.length) {
    return (
      <Note glyph={data.computedAt ? SHOP : CLOUD}>
        {data.computedAt
          ? `None of your shops carries a target for ${monthWords}, and none has bought or has an order waiting.`
          : `Shop targets for ${monthWords} not on this phone — only this month and last are kept; they arrive with the next sync.`}
      </Note>
    );
  }

  const { summary } = data;
  const visible = sortForWork(data.rows.filter((r) => matches(r, filter)));
  const pctDone = summary.targetPaise ? (summary.achievedPaise / summary.targetPaise) * 100 : 0;

  return (
    <>
      <View style={CARD}>
        <CardTitle />
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <CountUp
            value={summary.achievedPaise}
            format={(n) => inrFromPaise(Math.round(n))}
            style={[typeScale.body, { fontSize: 26, lineHeight: 32, letterSpacing: -0.52, color: C.ink }, weight(800), tabular]}
          />
          <Text style={{ flexShrink: 1, fontSize: 13, lineHeight: 18, color: C.muted }}>
            {summary.targetPaise ? `billed of ${inrFromPaise(summary.targetPaise)}` : 'billed · no targets set'}
          </Text>
        </View>
        {summary.targetPaise ? (
          <FillBar
            pct={pctDone}
            fill={pctDone >= 100 ? C.success : C.primary}
            track={C.hairline}
            height={10}
            style={{ flex: 0, alignSelf: 'stretch', marginTop: 8 }}
          />
        ) : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
          <Tag tone="ink" text={`${summary.targeted} with a target`} a11y={`${plural(summary.targeted, 'customer')} with a target`} />
          <Tag
            tone="ink"
            text={
              summary.openPaise
                ? `${inrFromPaise(summary.openPaise)} open`
                : summary.counts.open
                  ? `${plural(summary.counts.open, 'shop')} still open`
                  : 'All met'
            }
          />
          {summary.billTargeted ? (
            <Tag
              tone="ink"
              text={`${summary.billsAchieved}/${summary.billTarget} bills · ${plural(summary.billTargeted, 'shop')}`}
              a11y={`${summary.billsAchieved} of ${plural(summary.billTarget, 'bill')} raised across ${plural(summary.billTargeted, 'customer')} with a bill target`}
            />
          ) : null}
          {summary.waitingPaise ? (
            <Tag
              tone="warn"
              glyph={CLOCK}
              text={`${inrFromPaise(summary.waitingPaise)} not yet accepted`}
              a11y={`${inrFromPaise(summary.waitingPaise)} more taken and not yet accepted — it counts once the office approves it.`}
            />
          ) : null}
        </View>
        {/* The two targets are different grains AND different measures: a
            shop's target is met by what was BILLED to it, his own revenue
            target by orders the office accepted. Said once, plainly, so the
            two rupee figures are never read as one number twice. */}
        <Text style={{ fontSize: 12, lineHeight: 17, color: C.muted, marginTop: 8 }}>
          Measured on bills, not orders — not your own target above.
        </Text>
      </View>

      {/* The filters scroll sideways like the period row above them: which
          slice he is looking at is part of what the list says. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ marginTop: 12, marginHorizontal: -14 }}
        contentContainerStyle={{ gap: 8, paddingHorizontal: 14 }}>
        {TARGET_FILTERS.map((f) => {
          const on = filter === f.key;
          return (
            <Pressable
              key={f.key}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`${f.label}, ${summary.counts[f.key]}`}
              hitSlop={{ top: 6, bottom: 6 }}
              onPress={() => {
                if (!on) feedback('select');
                /* The slice changes in place: rows that stay slide to their new
                   places and rows that leave fade, so the list reads as narrowed
                   rather than replaced. At most a page is on screen. */
                animateLayoutFor(Math.min(PAGE, data.rows.length));
                setFilter(f.key);
                setShown(PAGE);
              }}
              style={({ pressed }) => ({
                minHeight: 36,
                paddingVertical: 6,
                paddingHorizontal: 12,
                borderRadius: 18,
                backgroundColor: on ? C.navy : C.surface,
                justifyContent: 'center',
                opacity: pressed ? 0.85 : 1,
              })}>
              <Text style={[{ fontSize: 13, lineHeight: 18, color: on ? '#FFFFFF' : C.ink }, weight(on ? 700 : 600)]}>
                {`${f.label} ${summary.counts[f.key]}`}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {visible.length ? (
        <View style={{ marginTop: 10, backgroundColor: C.surface, borderRadius: 20, paddingHorizontal: 14 }}>
          {visible.slice(0, shown).map((r, i) => (
            <Stagger key={r.customerId} index={i}>
              <TargetRow
                row={r}
                first={i === 0}
                today={today}
                onPress={r.onPhone === false ? undefined : () => onOpen(r.customerId)}
              />
            </Stagger>
          ))}
        </View>
      ) : (
        <View style={[CARD, { paddingVertical: 14 }]}>
          <Text style={{ fontSize: 13, lineHeight: 18, color: C.body }}>
            {filter === 'met'
              ? 'No shop has reached its target yet.'
              : filter === 'open'
                ? 'Every shop with a target has met it.'
                : filter === 'not-started'
                  ? 'Every shop with a target has bought something this month.'
                  : 'Nothing to show.'}
          </Text>
        </View>
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
  /** Absent for a shop whose record is not on this phone — there is nothing to open. */
  onPress?: () => void;
}) {
  const state = stateOf(row);
  const gap = gapPaise(row);
  const bills = billGap(row);
  const waiting = row.pendingPaise + row.unsentPaise;
  // A bills-only target is drawn by its count, never as a bar of ₹0.
  const pct = row.targetPaise
    ? (row.achievedPaise / row.targetPaise) * 100
    : row.billTarget
      ? ((row.billsAchieved ?? 0) / row.billTarget) * 100
      : 0;

  const offPhone = row.onPhone === false;
  const body = (
    <View style={{ paddingVertical: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <Text numberOfLines={1} style={[{ flex: 1, fontSize: 15, lineHeight: 20, color: offPhone ? C.muted : C.ink }, weight(700)]}>
          {row.name}
        </Text>
        <Text style={[{ fontSize: 13, lineHeight: 18, color: state === 'met' ? C.success : C.ink }, weight(700), tabular]}>
          {inrFromPaise(row.achievedPaise)}
          {row.targetPaise ? (
            <Text style={[{ color: state === 'met' ? C.success : C.faint }, weight(state === 'met' ? 700 : 500)]}>
              {' / ' + inrFromPaise(row.targetPaise)}
            </Text>
          ) : null}
        </Text>
      </View>
      {row.city ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Glyph shapes={PIN} size={12} color={C.muted} />
          <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 12, color: C.muted }}>{row.city}</Text>
        </View>
      ) : null}

      {row.targetPaise || row.billTarget ? (
        <FillBar
          pct={pct}
          fill={state === 'met' ? C.success : state === 'not-started' ? C.warn : C.primary}
          track={C.hairline}
          height={8}
          style={{ flex: 0, alignSelf: 'stretch', marginTop: 8 }}
        />
      ) : null}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
        {state === 'met' ? (
          <Tag tone="ok" glyph={TICK} text="Target met" />
        ) : state === 'untargeted' ? (
          <Tag text="No target this month" />
        ) : gap || bills ? (
          <Tag
            tone="purple"
            text={[gap ? `${inrFromPaise(gap)}` : null, bills ? `${plural(bills, 'bill')}` : null].filter(Boolean).join(' · ') + ' to go'}
          />
        ) : null}
        {row.billTarget ? (
          <Tag text={`${row.billsAchieved ?? 0}/${row.billTarget} bills`} a11y={`${row.billsAchieved ?? 0} of ${plural(row.billTarget, 'bill')} this month`} />
        ) : null}
        {waiting ? (
          <Tag tone="warn" glyph={CLOCK} text={`${inrFromPaise(waiting)} for approval`} a11y={`${inrFromPaise(waiting)} waiting for approval`} />
        ) : null}
        {row.unsentPaise ? (
          <Tag
            tone="warn"
            glyph={PHONE}
            text={`${inrFromPaise(row.unsentPaise)} still on phone`}
            a11y={`${inrFromPaise(row.unsentPaise)} of it is still on this phone, not yet sent.`}
          />
        ) : null}
        {/* Its last order is read off the customer row, which is not here — so
            for a shop off the phone this would say "never ordered" about a shop
            with sales against it. Said nothing rather than said wrong. */}
        {offPhone ? null : <Tag glyph={CART} text={lastOrderShort(row.lastOrderDate, today)} a11y={lastOrderWords(row.lastOrderDate, today)} />}
        {offPhone ? <Tag text="Outside your area" /> : null}
        {row.carriedForward ? <Tag text="Last month’s figure" /> : null}
        {row.isDefault && !row.carriedForward && row.targetPaise > 0 ? <Tag text="Default" /> : null}
      </View>

      {offPhone ? (
        <Text style={{ fontSize: 12, lineHeight: 17, color: C.muted, marginTop: 6 }}>
          Not on this phone — outside your area. Ask your manager if it should be added.
        </Text>
      ) : null}
    </View>
  );

  return (
    <View style={first ? null : { borderTopWidth: 1, borderTopColor: C.hairline }}>
      {onPress ? (
        <Pressable
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={`${row.name}, ${inrFromPaise(row.achievedPaise)}${row.targetPaise ? ' of ' + inrFromPaise(row.targetPaise) : ''}`}
          style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
          {body}
        </Pressable>
      ) : (
        body
      )}
    </View>
  );
}

/** "6 d ago" for the tag; the full sentence rides on its label. */
function lastOrderShort(iso: string | null, today: string): string {
  const words = lastOrderWords(iso, today);
  const m = /^Last order (\d+) days ago$/.exec(words);
  if (m) return `${m[1]} d ago`;
  if (words === 'Last order yesterday') return '1 d ago';
  return words;
}
