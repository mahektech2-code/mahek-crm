import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { color as C, HIT, radius, shadow, type, weight } from '../../theme/tokens';
import { Icon, type IconName } from './Icon';
import { grouped } from '../../lib/format';
import { feedback } from './feedback';

/**
 * The controls the two halves of the book share — the Customers list and the
 * Leads list.
 *
 * They were two copies of one search box, two chip rows drawn with `Choice`
 * (a 48-point radio button built for forms, so two rows of them took a third
 * of the screen before the first shop), and two different ways of saying "more
 * below". On a book of ten thousand the controls are the part he looks at most,
 * and two lists that answer the same gesture differently are two lists he has
 * to learn.
 *
 * These sit ABOVE the list and never inside its header. A header scrolls away
 * with the first four rows, so a salesman three hundred shops down could not
 * see what the list was narrowed to, or reach the box to search it.
 */

/** The search box. The clear button is the way out of a search, and always drawn when there is one. */
export function SearchBox({
  value,
  onChange,
  onClear,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onClear: () => void;
  placeholder: string;
}) {
  return (
    <View style={{ flex: 1, minWidth: 0, position: 'relative', justifyContent: 'center' }}>
      <View style={{ position: 'absolute', left: 12, zIndex: 1 }}>
        <Icon name="search" size={18} color={C.muted} strokeWidth={1.5} />
      </View>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={C.faint}
        returnKeyType="search"
        autoCorrect={false}
        style={{
          height: 46,
          paddingLeft: 38,
          paddingRight: value ? 44 : 12,
          borderWidth: 1,
          borderColor: C.border,
          borderRadius: radius.md,
          fontSize: 15,
          color: C.ink,
          backgroundColor: C.surface,
        }}
      />
      {value ? (
        <Pressable
          onPress={onClear}
          accessibilityRole="button"
          accessibilityLabel="Clear the search"
          hitSlop={4}
          style={{ position: 'absolute', right: 0, width: 44, height: 46, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="close" size={18} color={C.muted} strokeWidth={1.5} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** A square button beside the search box — the map, the sort, a new lead. */
export function ToolButton({
  icon,
  label,
  onPress,
  on = false,
  tone = 'plain',
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  on?: boolean;
  tone?: 'plain' | 'primary';
}) {
  const filled = tone === 'primary';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: on }}
      style={({ pressed }) => ({
        width: 46,
        height: 46,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: filled ? C.primary : on ? C.primaryEdge : C.border,
        backgroundColor: filled ? C.primary : on ? C.primaryTint : pressed ? C.wash : C.surface,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed && filled ? 0.85 : 1,
      })}>
      <Icon name={icon} size={20} color={filled ? C.surface : on ? C.primaryDeep : C.body} />
    </Pressable>
  );
}

/**
 * One horizontal row of chips, each carrying how many it would show.
 *
 * The count is the point. "Owes money 214" is a map of where the morning's
 * work is before anything is pressed; "Owes money" alone is a guess somebody
 * has to tap to check. A null count draws the word alone — not yet counted is
 * not the same fact as none — and a zero is drawn quiet rather than hidden, so
 * the row does not rearrange itself under his thumb as he types.
 */
export function ChipRow<K extends string>({
  chips,
  value,
  onChange,
  counts,
}: {
  chips: readonly { value: K; label: string }[];
  value: K;
  onChange: (v: K) => void;
  counts?: Partial<Record<K, number>> | null;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      style={{ marginHorizontal: -16, flexGrow: 0 }}
      contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingVertical: 2 }}>
      {chips.map((c) => {
        const on = c.value === value;
        const n = counts?.[c.value];
        const quiet = n === 0 && !on;
        /* The tick is here, once, rather than at each screen that renders a
           row — the same place `Choice` keeps its own. Only a MOVE ticks:
           re-tapping the chip already chosen changes nothing, and a buzz for
           nothing teaches the hand that the buzz means nothing. */
        return (
          <Pressable
            key={c.value}
            onPress={() => {
              if (!on) feedback('select');
              onChange(c.value);
            }}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            accessibilityLabel={n != null ? `${c.label}, ${n}` : c.label}
            hitSlop={{ top: 4, bottom: 4 }}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              height: 36,
              paddingHorizontal: 12,
              borderRadius: radius.pill,
              borderWidth: 1,
              borderColor: on ? C.ink : C.border,
              backgroundColor: on ? C.ink : C.surface,
            }}>
            <Text style={[{ fontSize: 13, color: on ? C.surface : quiet ? C.faint : C.body }, weight(on ? 600 : 500)]}>
              {c.label}
            </Text>
            {n != null ? (
              <Text style={[{ fontSize: 12, color: on ? C.surface : C.muted, opacity: on ? 0.8 : 1 }, weight(500)]}>
                {grouped(n)}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/**
 * Two joined halves that pick WHICH list — never a filter on one.
 *
 * Drawn in the geometry of a switch rather than a chip, because the chips
 * underneath narrow a list and this decides which list it is; keeping the two
 * shapes apart is what lets somebody tell them apart without reading.
 */
export function Segmented<K extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { key: K; label: string; badge?: number | null }[];
  value: K;
  onChange: (k: K) => void;
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        padding: 3,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: C.border,
        backgroundColor: C.wash,
      }}>
      {options.map((seg) => {
        const on = value === seg.key;
        return (
          <Pressable
            key={seg.key}
            onPress={() => {
              if (!on) feedback('select');
              onChange(seg.key);
            }}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={seg.badge != null ? `${seg.label}, ${seg.badge}` : seg.label}
            style={{
              flex: 1,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 7,
              minHeight: 40,
              paddingHorizontal: 12,
              borderRadius: radius.sm,
              backgroundColor: on ? C.surface : 'transparent',
              boxShadow: on ? shadow.soft : undefined,
            }}>
            <Text style={[{ fontSize: 14, color: on ? C.ink : C.muted }, weight(on ? 600 : 500)]}>{seg.label}</Text>
            {seg.badge != null ? (
              <Text style={[{ fontSize: 12, color: on ? C.body : C.muted }, weight(500)]}>{grouped(seg.badge)}</Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * The bottom of a paged list, in its four states.
 *
 * Fetching, failed, finished and nothing to say. "Finished" says the number,
 * because the end of a list of ten thousand is a place somebody reaches by
 * scrolling and wonders whether it is the end or the app giving up.
 */
export function PageFooter({
  loading,
  failed,
  done,
  total,
  noun,
  onRetry,
}: {
  loading: boolean;
  failed: boolean;
  done: boolean;
  total: number;
  noun: string;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <View style={{ paddingVertical: 20, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8 }}>
        <ActivityIndicator size="small" color={C.muted} />
        <Text style={type.caption}>Loading more…</Text>
      </View>
    );
  }
  if (failed) {
    return (
      <Pressable onPress={onRetry} accessibilityRole="button" style={{ paddingVertical: 20, alignItems: 'center' }}>
        <Text style={[{ fontSize: 14, color: C.ink }, weight(500)]}>Could not load more. Tap to try again.</Text>
      </Pressable>
    );
  }
  if (done && total > 0) {
    return (
      <Text style={[type.caption, { textAlign: 'center', paddingVertical: 20 }]}>
        {total === 1 ? `That is the only ${noun}` : `That is all ${grouped(total)} ${noun}s`}
      </Text>
    );
  }
  return <View style={{ height: 16 }} />;
}

/** A row in an action sheet: an icon, a verb, and what it does. */
export function SheetAction({
  icon,
  label,
  sub,
  onPress,
}: {
  icon: IconName;
  label: string;
  sub?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [
        { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 56, borderRadius: radius.sm },
        pressed && { backgroundColor: C.wash },
      ]}>
      <View
        style={{
          width: HIT - 8,
          height: HIT - 8,
          borderRadius: radius.sm,
          backgroundColor: C.primaryTint,
          alignItems: 'center',
          justifyContent: 'center',
        }}>
        <Icon name={icon} size={18} color={C.primaryDeep} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[{ fontSize: 15, color: C.ink }, weight(500)]}>{label}</Text>
        {sub ? <Text style={type.caption}>{sub}</Text> : null}
      </View>
    </Pressable>
  );
}
