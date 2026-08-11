import React from 'react';
import {
  Animated,
  View,
  Text,
  Pressable,
  TextInput,
  StyleSheet,
  type ViewStyle,
  type TextStyle,
  type StyleProp,
} from 'react-native';
import { BADGE, color as C, HIT, radius, shadow, type, weight, tabular, type BadgeTone } from '../../theme/tokens';
import { usePressScale } from './motion';

/**
 * A pressable that scales has two boxes: the wrapper that carries the
 * transform, and the button inside it. Layout has to go on the OUTER one and
 * appearance on the inner, or the two fight.
 *
 * This is not theoretical. `style={{ flex: 1 }}` on a Cancel/Save pair landed
 * on the inner button while the wrapper sized to its content, so thirteen
 * paired buttons across the app stopped dividing their row — the symptom being
 * two buttons huddled at one end of a sheet instead of filling it.
 *
 * Splitting here means every call site keeps writing the obvious thing and it
 * simply works.
 */
const LAYOUT_KEYS = [
  'flex', 'flexGrow', 'flexShrink', 'flexBasis', 'alignSelf',
  'width', 'minWidth', 'maxWidth',
  'margin', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight',
  'marginHorizontal', 'marginVertical', 'marginStart', 'marginEnd',
  'position', 'top', 'bottom', 'left', 'right', 'zIndex',
] as const;

function splitStyle(style: StyleProp<ViewStyle>): { outer: ViewStyle; inner: ViewStyle } {
  const flat = (StyleSheet.flatten(style) ?? {}) as Record<string, unknown>;
  const outer: Record<string, unknown> = {};
  const inner: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(flat)) {
    if ((LAYOUT_KEYS as readonly string[]).includes(k)) outer[k] = v;
    else inner[k] = v;
  }
  return { outer: outer as ViewStyle, inner: inner as ViewStyle };
}

/**
 * The pieces the design repeats on nearly every screen.
 *
 * Each one is the design's own recipe, not a generic component library: the
 * card really is 16px radius with that exact two-layer shadow, and the section
 * label really is 12px 600 uppercase at 0.04em. Keeping them here is what stops
 * twenty screens from each getting one of those values slightly wrong.
 */

/* ------------------------------------------------------------------ text */

export function T({
  s,
  style,
  children,
  numberOfLines,
}: {
  s?: keyof typeof type;
  style?: StyleProp<TextStyle>;
  children: React.ReactNode;
  numberOfLines?: number;
}) {
  return (
    <Text style={[s ? type[s] : type.body, style]} numberOfLines={numberOfLines}>
      {children}
    </Text>
  );
}

/** The uppercase caption that sits above almost every card in the design. */
export function SectionLabel({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[type.label, style]}>{children}</Text>;
}

/* ------------------------------------------------------------------ card */

export function Card({
  children,
  style,
  padded = true,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  padded?: boolean;
}) {
  return <View style={[s.card, padded && { padding: 16 }, style]}>{children}</View>;
}

/** A card that clips its children — used wherever rows sit flush to the edge. */
export function ListCard({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[s.card, { overflow: 'hidden' }, style]}>{children}</View>;
}

/* ----------------------------------------------------------------- badge */

export function Badge({ tone, children, style }: { tone: BadgeTone; children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = BADGE[tone];
  return (
    <View style={[s.badge, { backgroundColor: t.bg }, style]}>
      <Text style={[s.badgeText, { color: t.fg }]}>{children}</Text>
    </View>
  );
}

/* ---------------------------------------------------------------- health */

/**
 * The health score, coloured by band. It is the most-looked-at number on a
 * customer card, so it carries its own verdict rather than making the reader
 * remember where 70 and 50 sit.
 */
export function HealthPill({ value, large = false }: { value: number; large?: boolean }) {
  const bg = value >= 70 ? C.successBg : value >= 50 ? C.warnBg : C.dangerBg;
  const fg = value >= 70 ? C.success : value >= 50 ? C.warnInk : C.danger;
  return (
    <View
      style={{
        minWidth: large ? 52 : 44,
        height: large ? 32 : 28,
        paddingHorizontal: 8,
        borderRadius: 14,
        backgroundColor: bg,
        alignItems: 'center',
        justifyContent: 'center',
      }}>
      <Text style={[{ fontSize: large ? 14 : 13, color: fg }, weight(600), tabular]}>{'● ' + value}</Text>
    </View>
  );
}

/* --------------------------------------------------------------- buttons */

export function PrimaryButton({
  label,
  onPress,
  disabled,
  tone = 'primary',
  /**
   * Off for a button that should be only as wide as its label — the one in an
   * empty state, say, where a full-width bar would read as the main action of
   * the screen rather than a way out of a dead end.
   */
  fullWidth = true,
  /**
   * Why the button is off, in a sentence.
   *
   * A greyed-out "Submit order" with nothing saying why leaves somebody
   * tapping it and guessing. It reaches a screen reader, and pressing the
   * disabled button surfaces it as a toast rather than doing nothing at all.
   */
  whyDisabled,
  style,
}: {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  tone?: 'primary' | 'warn';
  fullWidth?: boolean;
  whyDisabled?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const bg = disabled ? C.hairline : tone === 'warn' ? C.warn : C.primary;
  const fg = disabled ? C.faint : '#FFFFFF';
  const press = usePressScale();
  const { outer, inner } = splitStyle(style);

  return (
    <Animated.View
      style={[
        !disabled && press.style,
        { alignSelf: fullWidth ? 'stretch' : 'center' },
        outer,
      ]}>
      <Pressable
        /* When a reason exists the button stays PRESSABLE and the press runs
           the handler, which already refuses with that reason in words — see
           `collect()` in pay.tsx. A button that swallows the tap teaches
           people it is broken; one that answers teaches them what is missing. */
        onPress={disabled && !whyDisabled ? undefined : onPress}
        onPressIn={disabled ? undefined : press.onPressIn}
        onPressOut={disabled ? undefined : press.onPressOut}
        disabled={disabled && !whyDisabled}
        accessibilityRole="button"
        accessibilityState={{ disabled: Boolean(disabled) }}
        accessibilityHint={disabled ? whyDisabled : undefined}
        style={[
          s.primaryBtn,
          !fullWidth && s.autoWidthBtn,
          { backgroundColor: bg },
          !disabled && { boxShadow: shadow.primary },
          inner,
        ]}>
        <Text style={[{ fontSize: 16, color: fg }, weight(600)]}>{label}</Text>
      </Pressable>
    </Animated.View>
  );
}

export function SecondaryButton({
  label,
  onPress,
  fullWidth = true,
  style,
}: {
  label: string;
  onPress?: () => void;
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const press = usePressScale();
  const { outer, inner } = splitStyle(style);
  return (
    <Animated.View
      style={[press.style, { alignSelf: fullWidth ? 'stretch' : 'center' }, outer]}>
      <Pressable
        onPress={onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        accessibilityRole="button"
        style={({ pressed }) => [
          s.secondaryBtn,
          !fullWidth && s.autoWidthBtn,
          pressed && { backgroundColor: C.wash },
          inner,
        ]}>
        <Text style={[{ fontSize: 16, color: C.body }, weight(500)]}>{label}</Text>
      </Pressable>
    </Animated.View>
  );
}

/** The dashed "add / explain yourself" affordance the design uses in six places. */
export function DashedButton({
  label,
  onPress,
  tone = 'muted',
  style,
}: {
  label: string;
  onPress?: () => void;
  tone?: 'muted' | 'primary';
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [
        {
          width: '100%',
          minHeight: 52,
          borderRadius: radius.xl,
          borderWidth: 1,
          borderStyle: 'dashed',
          borderColor: C.faint,
          backgroundColor: tone === 'primary' ? C.surface : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: 14,
          paddingVertical: 10,
          opacity: pressed ? 0.7 : 1,
        },
        style,
      ]}>
      <Text
        style={[
          { fontSize: tone === 'primary' ? 15 : 14, lineHeight: 19, textAlign: 'center', color: tone === 'primary' ? C.primaryDeep : C.muted },
          weight(tone === 'primary' ? 500 : 400),
        ]}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * A choice chip. `selected` is the only thing that changes, and it changes
 * three properties at once — border, fill and weight — because one of them
 * alone does not read as chosen on a sunlit phone in a market.
 */
export function Choice({
  label,
  sub,
  selected,
  onPress,
  style,
}: {
  label: string;
  sub?: string;
  selected: boolean;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      style={[
        {
          minHeight: sub ? 56 : 48,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: selected ? C.primary : C.border,
          backgroundColor: selected ? C.primaryTint : C.surface,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: 12,
          paddingVertical: 6,
        },
        style,
      ]}>
      <Text style={[{ fontSize: 14, color: selected ? C.primaryDeep : C.body }, weight(selected ? 600 : 500)]}>
        {label}
      </Text>
      {sub ? (
        <Text style={[{ fontSize: 12, marginTop: 1, color: selected ? C.primaryDeep : C.muted }]}>{sub}</Text>
      ) : null}
    </Pressable>
  );
}

/* ----------------------------------------------------------------- input */

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label?: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <View>
      {label ? <SectionLabel style={{ marginBottom: 6 }}>{label}</SectionLabel> : null}
      {children}
      {error ? <Text style={{ fontSize: 13, color: C.danger, marginTop: 6 }}>{error}</Text> : null}
      {!error && hint ? <Text style={[type.caption, { marginTop: 6 }]}>{hint}</Text> : null}
    </View>
  );
}

export function Input({
  value,
  onChangeText,
  placeholder,
  invalid,
  keyboardType,
  secureTextEntry,
  multiline,
  style,
  ...rest
}: React.ComponentProps<typeof TextInput> & { invalid?: boolean }) {
  const [focused, setFocused] = React.useState(false);
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={C.faint}
      keyboardType={keyboardType}
      secureTextEntry={secureTextEntry}
      multiline={multiline}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={[
        {
          width: '100%',
          minHeight: multiline ? 88 : 52,
          borderWidth: 1,
          borderColor: invalid ? C.danger : focused ? C.primary : C.border,
          borderRadius: radius.lg,
          paddingHorizontal: 14,
          paddingVertical: multiline ? 12 : 0,
          fontSize: 16,
          color: C.ink,
          backgroundColor: C.surface,
          textAlignVertical: multiline ? 'top' : 'center',
        },
        style,
      ]}
      {...rest}
    />
  );
}

/* --------------------------------------------------------------- toggle */

/**
 * The design draws two sizes of this: 52×32 on the login screen and 48×28 in
 * the profile preferences. Both keep the full 48px hit area around the track,
 * which is the part that matters — the switch is small, the target is not.
 */
export function Toggle({
  on,
  onPress,
  size = 'lg',
}: {
  on: boolean;
  onPress?: () => void;
  size?: 'lg' | 'sm';
}) {
  const w = size === 'lg' ? 52 : 48;
  const h = size === 'lg' ? 32 : 28;
  const knob = h - 6;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      style={{ width: Math.max(w, HIT), height: HIT, justifyContent: 'center' }}>
      <View style={{ width: w, height: h, borderRadius: h / 2, backgroundColor: on ? C.primary : C.border }}>
        <View
          style={{
            position: 'absolute',
            top: 3,
            left: on ? w - knob - 3 : 3,
            width: knob,
            height: knob,
            borderRadius: knob / 2,
            backgroundColor: '#FFFFFF',
          }}
        />
      </View>
    </Pressable>
  );
}

/* ------------------------------------------------------------------ misc */

/** The thin progress track used by targets, credit and the period card. */
export function Bar({ pct, fill }: { pct: number; fill: string }) {
  return (
    <View style={{ flex: 1, height: 8, borderRadius: 4, backgroundColor: C.hairline, overflow: 'hidden' }}>
      <View style={{ width: `${Math.min(100, Math.max(0, pct))}%`, height: '100%', borderRadius: 4, backgroundColor: fill }} />
    </View>
  );
}

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  return <View style={[{ height: 1, backgroundColor: C.hairline }, style]} />;
}

/** A row in a list card. `first` suppresses the hairline so the card edge is clean. */
export function Row({
  children,
  onPress,
  first,
  style,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  first?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const body = (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          paddingHorizontal: 16,
          paddingVertical: 14,
          borderTopWidth: first ? 0 : 1,
          borderTopColor: C.wash,
        },
        style,
      ]}>
      {children}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => (pressed ? { backgroundColor: C.wash } : null)}>
      {body}
    </Pressable>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.hairline,
    borderRadius: radius.card,
    boxShadow: shadow.card,
  },
  badge: {
    alignSelf: 'flex-start',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  badgeText: {
    fontSize: 12,
    letterSpacing: 0.36,
    textTransform: 'uppercase',
    ...weight(500),
  },
  primaryBtn: {
    width: '100%',
    height: 52,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /* Wide enough to look deliberate, never edge-to-edge. The 52 height stays,
     because the touch target should not shrink just because the label is short. */
  autoWidthBtn: {
    width: 'auto',
    minWidth: 140,
    paddingHorizontal: 24,
  },
  secondaryBtn: {
    width: '100%',
    height: 52,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
