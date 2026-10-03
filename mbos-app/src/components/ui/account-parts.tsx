import React from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { T } from './primitives';
import { feedback } from './feedback';
import { color as C, radius, tabular, weight } from '../../theme/tokens';

/**
 * The small pieces the two Customer accounts screens share — a filter chip, a
 * figure, a label-and-value line and the tab strip. Here rather than inside a
 * route file, because a route file exports its screen and nothing else.
 */

export function Chip({ label, on, onPress, count }: { label: string; on: boolean; onPress: () => void; count?: number }) {
  /* A filter moving ticks, here and not at the callers, so it is felt once.
     Re-tapping the chip already chosen moves nothing and says nothing. */
  return (
    <Pressable
      onPress={() => {
        if (!on) feedback('select');
        onPress();
      }}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      style={{
        height: 34,
        paddingHorizontal: 14,
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: on ? C.primary : C.border,
        backgroundColor: on ? C.primaryTint : C.surface,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
      }}>
      <T style={[{ fontSize: 14, color: on ? C.primaryDeep : C.body }, weight(on ? 500 : 400)]}>{label}</T>
      {count != null ? (
        <T style={[{ fontSize: 12, color: on ? C.primaryDeep : C.muted }, tabular]}>{count}</T>
      ) : null}
    </Pressable>
  );
}

/** A row of chips that scrolls sideways past the screen edge. */
export function ChipRow({ children }: { children: React.ReactNode }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 8, paddingRight: 16 }}
      style={{ flexGrow: 0, marginHorizontal: -16, paddingHorizontal: 16 }}>
      {children}
    </ScrollView>
  );
}

/** A figure with its label above and an optional line under it. */
export function Figure({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string | null;
  tone?: string;
}) {
  return (
    <View style={{ flex: 1, minWidth: 0 }}>
      <T s="micro" numberOfLines={1}>
        {label}
      </T>
      <T style={[{ fontSize: 17, lineHeight: 23, color: tone ?? C.ink, marginTop: 1 }, weight(600), tabular]} numberOfLines={1}>
        {value}
      </T>
      {sub ? (
        <T s="micro" numberOfLines={2}>
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
 * The tab strip under the account header. Underlined rather than pilled, so it
 * reads as WHERE you are in the account and the chips under it read as what
 * you are filtering — two controls that looked alike would be read as one.
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
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ flexGrow: 0, marginHorizontal: -16, borderBottomWidth: 1, borderBottomColor: C.hairline }}
      contentContainerStyle={{ paddingHorizontal: 12 }}>
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
            style={{
              minHeight: 48,
              paddingHorizontal: 12,
              justifyContent: 'center',
              borderBottomWidth: 2,
              borderBottomColor: on ? C.primary : 'transparent',
            }}>
            <T style={[{ fontSize: 15, color: on ? C.primaryDeep : C.muted }, weight(on ? 600 : 400)]}>
              {t.label}
              {t.count != null ? <T style={[{ fontSize: 13, color: C.muted }, tabular]}>{'  ' + t.count}</T> : null}
            </T>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
