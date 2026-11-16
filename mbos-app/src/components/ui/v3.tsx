import React from 'react';
import { Animated, Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { Icon, type IconName } from './Icon';
import { feedback } from './feedback';
import { usePressScale } from './motion';
import { color as C, weight } from '../../theme/tokens';
import { BADGE_FONT_CAP, BAR_FONT_CAP } from './font-scale';

/**
 * The Version 3 kit: the pill tags, pill buttons, switch tabs, round discs,
 * progress ring, group cards, dashed add button, field box and sheet footer
 * that the V3 artboards draw on screen after screen. One place, so every
 * screen draws them the same. Every value is lifted from the V3 artboards.
 */

/** The state colours the week strip, the calendar and the day lists share. */
export const DAY_TONE = {
  planned: C.primary,
  proposed: '#E0A320',
  agreed: '#2F6FDB',
  refused: C.danger,
  none: '#DCE3EE',
} as const;

/** The pale fills behind those colours, for discs and badges. */
export const DAY_FILL = {
  planned: C.primaryTint,
  proposed: C.warnBg,
  agreed: '#E6EEFC',
  refused: C.dangerBg,
  none: C.wash,
} as const;

/* ------------------------------------------------------------------ tabs */

/**
 * The segmented control. `hero` is the one inside the navy block (lime
 * selection), `canvas` the white pill that sits on the page (navy selection).
 */
export function SwitchTabs<K extends string>({
  options,
  value,
  onChange,
  tone = 'canvas',
  style,
}: {
  options: readonly { key: K; label: string; badge?: number | null; icon?: IconName; a11y?: string }[];
  value: K;
  onChange: (k: K) => void;
  tone?: 'hero' | 'canvas';
  style?: StyleProp<ViewStyle>;
}) {
  const hero = tone === 'hero';
  return (
    <View
      accessibilityRole="tablist"
      style={[
        {
          flexDirection: 'row',
          gap: 6,
          padding: 4,
          borderRadius: hero ? 22 : 24,
          backgroundColor: hero ? C.navySoft : C.surface,
        },
        style,
      ]}>
      {options.map((o) => {
        const on = o.key === value;
        const ink = on ? (hero ? C.navy : '#FFFFFF') : hero ? (o.badge ? C.onNavy : C.onNavyMuted) : C.muted;
        return (
          <Pressable
            key={o.key}
            onPress={() => {
              if (!on) feedback('select');
              onChange(o.key);
            }}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={(o.a11y ?? o.label) + (o.badge ? ', ' + o.badge : '')}
            style={{
              flex: 1,
              minHeight: hero ? 36 : 40,
              paddingVertical: 4,
              borderRadius: hero ? 18 : 20,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              backgroundColor: on ? (hero ? C.lime : C.navy) : 'transparent',
            }}>
            {o.icon ? <Icon name={o.icon} size={16} color={on && !hero ? C.lime : ink} strokeWidth={2} /> : null}
            <Text style={[{ flexShrink: 1, fontSize: 14, lineHeight: 19, textAlign: 'center', color: ink }, weight(on || !hero ? 700 : 600)]}>{o.label}</Text>
            {o.badge ? (
              <View
                style={{
                  minWidth: 20,
                  minHeight: 20,
                  borderRadius: 10,
                  paddingHorizontal: 5,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: on ? C.navy : C.primary,
                }}>
                <Text maxFontSizeMultiplier={BADGE_FONT_CAP} style={[{ fontSize: 11, color: on ? C.lime : '#FFFFFF' }, weight(700)]}>{o.badge}</Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/* ----------------------------------------------------------------- pills */

/** A rounded tag: a time, a figure, a state. */
export function Pill({
  text,
  icon,
  bg = C.wash,
  fg = C.body,
  height = 30,
  a11y,
  style,
}: {
  text: string;
  icon?: IconName;
  bg?: string;
  fg?: string;
  height?: number;
  a11y?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      accessible={!!a11y}
      accessibilityLabel={a11y}
      style={[
        {
          minHeight: height,
          paddingVertical: 3,
          paddingHorizontal: height <= 26 ? 10 : 12,
          borderRadius: height / 2,
          backgroundColor: bg,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 5,
          alignSelf: 'flex-start',
        },
        style,
      ]}>
      {icon ? <Icon name={icon} size={height <= 26 ? 12 : 14} color={fg} strokeWidth={2.2} /> : null}
      <Text numberOfLines={1} style={[{ flexShrink: 1, fontSize: height <= 26 ? 12 : 13, color: fg }, weight(700)]}>
        {text}
      </Text>
    </View>
  );
}

/* --------------------------------------------------------------- buttons */

export type PillVariant = 'lime' | 'navy' | 'navyLime' | 'outline' | 'white' | 'danger' | 'primary';

const VARIANT: Record<PillVariant, { bg: string; fg: string; border?: string }> = {
  lime: { bg: C.lime, fg: C.navy },
  navy: { bg: C.navy, fg: '#FFFFFF' },
  navyLime: { bg: C.navy, fg: C.lime },
  outline: { bg: C.surface, fg: C.ink, border: C.line },
  white: { bg: C.surface, fg: C.ink },
  danger: { bg: C.danger, fg: '#FFFFFF' },
  primary: { bg: C.primary, fg: '#FFFFFF' },
};

/**
 * The V3 button: a full pill (or the 18-corner block the hero cards use).
 * `whyDisabled` keeps the press alive and hands the sentence back through
 * `onRefused`, the way `PrimaryButton` does, so a locked control answers.
 */
export function PillButton({
  label,
  onPress,
  variant = 'navyLime',
  height = 52,
  block = false,
  disabled = false,
  whyDisabled,
  onRefused,
  icon,
  a11y,
  style,
}: {
  label: string;
  onPress?: () => void;
  variant?: PillVariant;
  height?: number;
  /** 18-corner block rather than a full pill — the hero cards' Start visit. */
  block?: boolean;
  disabled?: boolean;
  whyDisabled?: string;
  onRefused?: (why: string) => void;
  icon?: IconName;
  a11y?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const v = VARIANT[variant];
  const press = usePressScale();
  const bg = disabled ? C.hairline : v.bg;
  const fg = disabled ? C.faint : v.fg;
  return (
    <Animated.View style={[{ transform: disabled ? [] : press.style.transform }, style]}>
      <Pressable
        onPress={
          disabled
            ? whyDisabled
              ? () => {
                  feedback('warning');
                  onRefused?.(whyDisabled);
                }
              : undefined
            : onPress
        }
        onPressIn={disabled ? undefined : press.onPressIn}
        onPressOut={disabled ? undefined : press.onPressOut}
        disabled={disabled && !whyDisabled}
        accessibilityRole="button"
        accessibilityLabel={a11y ?? label}
        accessibilityState={{ disabled }}
        accessibilityHint={disabled ? whyDisabled : undefined}
        style={({ pressed }) => ({
          minHeight: height,
          paddingVertical: 6,
          borderRadius: block ? 18 : height / 2,
          backgroundColor: bg,
          borderWidth: v.border && !disabled ? 1 : 0,
          borderColor: v.border,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          paddingHorizontal: 16,
          opacity: pressed ? 0.88 : 1,
        })}>
        {icon ? <Icon name={icon} size={18} color={fg} strokeWidth={2.2} /> : null}
        <Text numberOfLines={2} style={[{ flexShrink: 1, textAlign: 'center', fontSize: height >= 56 ? 17 : height >= 52 ? 15 : 14, lineHeight: height >= 56 ? 22 : height >= 52 ? 20 : 19, color: fg }, weight(700)]}>
          {label}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

/** A 56 square icon button with a hairline edge — Cancel trip. */
export function SquareButton({
  icon,
  label,
  onPress,
  ink = C.ink,
  edge = C.line,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  ink?: string;
  edge?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        width: 56,
        height: 56,
        borderRadius: 18,
        borderWidth: 1,
        borderColor: edge,
        backgroundColor: pressed ? C.wash : C.surface,
        alignItems: 'center',
        justifyContent: 'center',
      })}>
      <Icon name={icon} size={22} color={ink} strokeWidth={2} />
    </Pressable>
  );
}

/** The dashed add-something control: + icon and a short verb. */
export function DashedAdd({
  label,
  onPress,
  a11y,
  style,
}: {
  label: string;
  onPress: () => void;
  a11y?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={a11y ?? label}
      style={({ pressed }) => [
        {
          minHeight: 52,
          paddingVertical: 8,
          borderRadius: 26,
          borderWidth: 2,
          borderStyle: 'dashed',
          borderColor: '#B9A3FD',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          opacity: pressed ? 0.7 : 1,
        },
        style,
      ]}>
      <Icon name="add" size={18} color={C.primaryDeep} strokeWidth={2.2} />
      <Text style={[{ flexShrink: 1, textAlign: 'center', fontSize: 15, lineHeight: 20, color: C.primaryDeep }, weight(700)]}>{label}</Text>
    </Pressable>
  );
}

/* ------------------------------------------------------------- structure */

/** The 15/700 heading above a group of rows. */
export function GroupTitle({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ paddingHorizontal: 6 }, style]}>
      <Text accessibilityRole="header" style={[{ fontSize: 15, lineHeight: 20, color: C.ink }, weight(700)]}>
        {children}
      </Text>
    </View>
  );
}

/** A white card of rows separated by hairlines. Pass rows as children. */
export function GroupCard({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const rows = React.Children.toArray(children).filter(Boolean);
  return (
    <View style={[{ backgroundColor: C.surface, borderRadius: 22, paddingHorizontal: 14, paddingVertical: 4 }, style]}>
      {rows.map((r, i) => (
        <View key={i} style={i ? { borderTopWidth: 1, borderTopColor: C.hairline } : null}>
          {r}
        </View>
      ))}
    </View>
  );
}

/** A round icon on a tinted disc. */
export function Disc({
  icon,
  size = 40,
  bg = C.wash,
  ink = C.muted,
  text,
  a11y,
}: {
  icon?: IconName;
  size?: number;
  bg?: string;
  ink?: string;
  text?: string;
  a11y?: string;
}) {
  return (
    <View
      accessible={!!a11y}
      accessibilityRole={a11y ? 'image' : undefined}
      accessibilityLabel={a11y}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: bg,
        alignItems: 'center',
        justifyContent: 'center',
      }}>
      {text != null ? (
        <Text maxFontSizeMultiplier={BADGE_FONT_CAP} style={[{ fontSize: 12, lineHeight: 17, color: ink }, weight(800)]}>{text}</Text>
      ) : icon ? (
        <Icon name={icon} size={size >= 40 ? 18 : 16} color={ink} strokeWidth={2} />
      ) : null}
    </View>
  );
}

/** The progress ring the hero draws: lime arc on a faint track, the count inside. */
export function Ring({ done, total, size = 84, label }: { done: number; total: number; size?: number; label: string }) {
  const r = 38;
  const circ = 2 * Math.PI * r;
  const arc = total > 0 ? Math.min(1, done / total) * circ : 0;
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label} style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox="0 0 92 92">
        <Circle cx={46} cy={46} r={r} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth={9} />
        {arc > 0 ? (
          <Circle
            cx={46}
            cy={46}
            r={r}
            fill="none"
            stroke={C.lime}
            strokeWidth={9}
            strokeLinecap="round"
            strokeDasharray={[arc, circ]}
            transform="rotate(-90 46 46)"
          />
        ) : null}
      </Svg>
      <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
        <Text maxFontSizeMultiplier={BAR_FONT_CAP} style={[{ fontSize: size >= 80 ? 24 : 20, color: '#FFFFFF', letterSpacing: -0.5 }, weight(800)]}>
          {done + '/' + total}
        </Text>
      </View>
    </View>
  );
}

/** The sheet footer every V3 form ends on: a 120-wide Cancel and the action. */
export function SheetActions({
  onCancel,
  label,
  onPress,
  busy = false,
  cancelLabel = 'Cancel',
}: {
  onCancel: () => void;
  label: string;
  onPress: () => void;
  busy?: boolean;
  cancelLabel?: string;
}) {
  return (
    <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
      <PillButton label={cancelLabel} variant="outline" height={56} onPress={onCancel} style={{ width: 120 }} />
      <PillButton label={label} variant="navyLime" height={56} onPress={onPress} disabled={busy} style={{ flex: 1 }} />
    </View>
  );
}

/** A form box with an icon inside it — the date button, the city box. */
export function FieldBox({
  icon,
  children,
  focused = false,
  style,
}: {
  icon?: IconName;
  children: React.ReactNode;
  focused?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      style={[
        {
          minHeight: 56,
          borderRadius: 18,
          borderWidth: focused ? 2 : 1,
          borderColor: focused ? C.primary : C.border,
          backgroundColor: C.surface,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingHorizontal: 14,
        },
        style,
      ]}>
      {icon ? <Icon name={icon} size={18} color={C.primaryDeep} strokeWidth={2} /> : null}
      <View style={{ flex: 1, minWidth: 0 }}>{children}</View>
    </View>
  );
}
