import React from 'react';
import { Pressable, View } from 'react-native';

import { T } from './primitives';
import { feedback } from './feedback';
import { color as C, tabular, weight } from '../../theme/tokens';

/**
 * The small pieces the two Customer accounts screens share — a filter chip, a
 * figure, a label-and-value line and the tab strip. Here rather than inside a
 * route file, because a route file exports its screen and nothing else.
 */

export function Chip({
  label,
  on,
  onPress,
  count,
  ink,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  count?: number;
  /** V3 colours a few filters by what they mean — Overdue red, Settled green. */
  ink?: string;
}) {
  /* A filter moving ticks, here and not at the callers, so it is felt once.
     Re-tapping the chip already chosen moves nothing and says nothing. */
  const fg = on ? '#FFFFFF' : count === 0 ? C.faint : ink ?? C.ink;
  return (
    <Pressable
      onPress={() => {
        if (!on) feedback('select');
        onPress();
      }}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      accessibilityLabel={count != null ? `${label}, ${count}` : label}
      /* 36 drawn, 48 to the thumb. */
      hitSlop={{ top: 6, bottom: 6 }}
      style={{
        minHeight: 36,
        paddingHorizontal: on ? 14 : 12,
        borderRadius: 18,
        backgroundColor: on ? C.navy : C.surface,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
      }}>
      <T style={[{ fontSize: 13, color: fg }, weight(700)]}>{label}</T>
      {count != null ? (
        <T style={[{ fontSize: 13, color: on ? C.lime : fg }, weight(700), tabular]}>{count}</T>
      ) : null}
    </Pressable>
  );
}

/** A row of chips. V3 wraps them onto a second line rather than scrolling sideways. */
export function ChipRow({ children }: { children: React.ReactNode }) {
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{children}</View>;
}

/**
 * A figure with its label above and an optional line under it.
 *
 * `tile` draws it as V3's white figure card (radius 18); without it the
 * figure sits bare inside whatever card holds it.
 */
export function Figure({
  label,
  value,
  sub,
  tone,
  tile = false,
}: {
  label: string;
  value: string;
  sub?: string | null;
  tone?: string;
  tile?: boolean;
}) {
  return (
    <View
      accessible
      accessibilityLabel={[label, value, sub].filter(Boolean).join(', ')}
      style={[
        { flex: 1, minWidth: 0 },
        tile && { backgroundColor: C.surface, borderRadius: 18, paddingVertical: 12, paddingHorizontal: 14 },
      ]}>
      <T numberOfLines={1} style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>
        {label}
      </T>
      <T
        style={[{ fontSize: 19, lineHeight: 25, letterSpacing: -0.3, color: tone ?? C.ink, marginTop: 1 }, weight(800), tabular]}
        numberOfLines={1}>
        {value}
      </T>
      {sub ? (
        <T numberOfLines={2} style={{ fontSize: 11, lineHeight: 15, color: C.muted }}>
          {sub}
        </T>
      ) : null}
    </View>
  );
}

/** "Label ........ value", for the detail lines inside an opened card. */
export function Line({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 3 }}>
      <T s="caption" style={{ flexShrink: 0 }}>
        {label}
      </T>
      <T style={[{ fontSize: 13, lineHeight: 19, color: tone ?? C.ink, flexShrink: 1, textAlign: 'right' }, tabular]}>
        {value}
      </T>
    </View>
  );
}

/**
 * The tab strip under the account header — V3 draws it as pills, the chosen
 * one navy, each carrying its count. Kept apart from the filter chips under
 * it by sitting on its own row above the tab body.
 */
export function Tabs({
  tabs,
  active,
  onPick,
}: {
  tabs: { label: string; count?: number | null }[];
  active: number;
  onPick: (i: number) => void;
}) {
  return (
    <View accessibilityRole="tablist" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {tabs.map((t, i) => {
        const on = i === active;
        return (
          <Pressable
            key={t.label}
            onPress={() => {
              if (!on) feedback('select');
              onPick(i);
            }}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={t.count != null ? `${t.label}, ${t.count}` : t.label}
            hitSlop={{ top: 6, bottom: 6 }}
            style={{
              minHeight: 36,
              paddingHorizontal: on ? 14 : 12,
              borderRadius: 18,
              backgroundColor: on ? C.navy : C.surface,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
            }}>
            <T style={[{ fontSize: 13, color: on ? '#FFFFFF' : C.ink }, weight(700)]}>{t.label}</T>
            {t.count != null ? (
              <T style={[{ fontSize: 13, color: on ? C.lime : C.ink }, weight(700), tabular]}>{t.count}</T>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}
