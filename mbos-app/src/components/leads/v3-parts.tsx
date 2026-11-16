import React from 'react';
import { Pressable, Text, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native';
import { Glyph, type GlyphShape } from '../me/kit';
import { Icon, type IconName } from '../ui/Icon';
import { color as C, weight, type BadgeTone } from '../../theme/tokens';

/**
 * The pieces the Version 3 lead screens draw again and again — the stage pill
 * in the artboards' own colours, the arrow and flag glyphs the icon set does
 * not carry, the "label over value" rows the forms are made of, and the white
 * card they sit in. Only the lead screens use them, so they live here rather
 * than in the shared kit.
 */

/** The arrow in front of every §7 action line, the flag beside a priority. */
export const LEAD_GLYPH = {
  arrow: [{ p: 'M5 12h14M13 6l6 6-6 6' }] as GlyphShape[],
  flag: [{ p: 'M5 21V4h11l-2 4 2 4H5' }] as GlyphShape[],
  pause: [{ p: 'M9 6v12M15 6v12' }] as GlyphShape[],
  rupee: [{ p: 'M7 5h10M7 9h10M9 5c4 0 6 2 6 4s-2 4-6 4H8l7 7' }] as GlyphShape[],
  drop: [{ p: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z' }] as GlyphShape[],
  board: [{ r: [4, 4, 16, 16, 3] }, { p: 'M8 9h8M8 13h8M8 17h5' }] as GlyphShape[],
};

export function LeadGlyph({ name, size = 16, color = C.muted, strokeWidth = 2.2 }: { name: keyof typeof LEAD_GLYPH; size?: number; color?: string; strokeWidth?: number }) {
  return <Glyph shapes={LEAD_GLYPH[name]} size={size} color={color} strokeWidth={strokeWidth} />;
}

/** The stage pill's colours, as the V3 artboards paint them. */
export const STAGE_PILL: Record<BadgeTone, { bg: string; fg: string }> = {
  info: { bg: '#E8EFFB', fg: '#2B5CBF' },
  teal: { bg: '#E3F4F2', fg: '#0F6B63' },
  amber: { bg: C.warnBg, fg: C.warnInk },
  neutral: { bg: C.canvas, fg: C.muted },
  success: { bg: C.successBg, fg: C.success },
  danger: { bg: C.dangerBg, fg: C.danger },
};

/** A 26-high stage pill — "Prospect", "On hold". */
export function StagePill({ tone, text, icon }: { tone: BadgeTone; text: string; icon?: IconName }) {
  const t = STAGE_PILL[tone];
  return (
    <View
      style={{
        height: 26,
        paddingHorizontal: 10,
        borderRadius: 13,
        backgroundColor: t.bg,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        flexShrink: 0,
      }}>
      {icon ? <Icon name={icon} size={12} color={t.fg} strokeWidth={2.4} /> : null}
      <Text numberOfLines={1} style={[{ fontSize: 12, color: t.fg }, weight(700)]}>
        {text}
      </Text>
    </View>
  );
}

/** The warning pill under a card: 32 high, warn or danger. */
export function WarnPill({ text, tone = 'warn', style }: { text: string; tone?: 'warn' | 'danger' | 'ok'; style?: StyleProp<ViewStyle> }) {
  const bg = tone === 'danger' ? C.dangerBg : tone === 'ok' ? C.successBg : C.warnBg;
  const fg = tone === 'danger' ? C.danger : tone === 'ok' ? C.success : C.warnInk;
  return (
    <View
      style={[
        {
          minHeight: 32,
          paddingHorizontal: 12,
          paddingVertical: 6,
          borderRadius: 16,
          backgroundColor: bg,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          alignSelf: 'flex-start',
          maxWidth: '100%',
        },
        style,
      ]}>
      <Icon name={tone === 'ok' ? 'tick' : 'warn'} size={14} color={fg} strokeWidth={2.2} />
      <Text style={[{ fontSize: 12, lineHeight: 16, color: fg, flexShrink: 1 }, weight(700)]}>{text}</Text>
    </View>
  );
}

/** The white V3 card — radius 20, no border. */
export function LeadCard({ children, style, padded = true }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; padded?: boolean }) {
  return (
    <View
      style={[
        { backgroundColor: C.surface, borderRadius: 20 },
        padded ? { padding: 16 } : { paddingHorizontal: 16, paddingVertical: 6 },
        style,
      ]}>
      {children}
    </View>
  );
}

/** "Kind of sale *" — the 13/700 heading inside a card, the star in red. */
export function CardHead({ children, required = false, style }: { children: React.ReactNode; required?: boolean; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={style}>
      <Text accessibilityRole="header" style={[{ fontSize: 13, lineHeight: 18, color: C.ink }, weight(700)]}>
        {children}
        {required ? <Text style={{ color: C.danger }}>{' *'}</Text> : null}
      </Text>
    </View>
  );
}

/**
 * One row of a form card: an icon, the 11-point label, and the box itself with
 * no edge of its own — the card's hairline is the edge. `last` drops the line.
 */
export function FormRow({
  icon,
  label,
  required = false,
  last = false,
  right,
  ...input
}: {
  icon: IconName;
  label: string;
  required?: boolean;
  last?: boolean;
  right?: React.ReactNode;
} & TextInputProps) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 56,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: C.hairline,
      }}>
      <Icon name={icon} size={20} color={C.muted} strokeWidth={2} />
      <View style={{ flex: 1, minWidth: 0, paddingVertical: 6 }}>
        <Text style={{ fontSize: 11, lineHeight: 15, color: C.faint }}>
          {label}
          {required ? <Text style={{ color: C.danger }}>{' *'}</Text> : null}
        </Text>
        <TextInput
          accessibilityLabel={label}
          placeholderTextColor={C.faint}
          {...input}
          style={[{ fontSize: 16, lineHeight: 21, color: C.ink, paddingVertical: 2, paddingHorizontal: 0, minHeight: 28 }, input.style]}
        />
      </View>
      {right}
    </View>
  );
}

/** A bordered 52-high box with an icon or a short word in front — the shop details. */
export function BoxInput({
  icon,
  tag,
  suffix,
  ...input
}: { icon?: IconName; tag?: string; suffix?: string } & TextInputProps) {
  return (
    <View
      style={{
        minHeight: 52,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: C.border,
        backgroundColor: C.surface,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
      }}>
      {icon ? <Icon name={icon} size={18} color={C.muted} strokeWidth={2} /> : null}
      {tag ? <Text style={[{ fontSize: 12, color: C.muted, width: 32 }, weight(800)]}>{tag}</Text> : null}
      <TextInput
        placeholderTextColor={C.faint}
        {...input}
        style={[{ flex: 1, minWidth: 0, fontSize: 15, color: C.ink, paddingVertical: 10, paddingHorizontal: 0 }, input.style]}
      />
      {suffix ? <Text style={{ fontSize: 11, color: C.faint }}>{suffix}</Text> : null}
    </View>
  );
}

/** A 36-high choice chip on wash — the sources, the kinds of business. */
export function WashChip({ label, on, onPress, a11y }: { label: string; on: boolean; onPress: () => void; a11y?: string }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      accessibilityLabel={a11y ?? label}
      hitSlop={{ top: 6, bottom: 6 }}
      style={({ pressed }) => ({
        minHeight: 36,
        paddingHorizontal: 14,
        borderRadius: 18,
        backgroundColor: on ? C.navy : pressed ? C.hairline : C.canvas,
        alignItems: 'center',
        justifyContent: 'center',
      })}>
      <Text style={[{ fontSize: 13, color: on ? '#FFFFFF' : C.ink }, weight(on ? 700 : 600)]}>{label}</Text>
    </Pressable>
  );
}

/** The "tick = goes into the form" disc of the scan and voice reviews. */
export function TickDisc({ on }: { on: boolean }) {
  return (
    <View
      style={{
        width: 28,
        height: 28,
        borderRadius: 14,
        backgroundColor: on ? C.primary : 'transparent',
        borderWidth: on ? 0 : 2,
        borderColor: C.border,
        alignItems: 'center',
        justifyContent: 'center',
      }}>
      {on ? <Icon name="tick" size={16} color="#FFFFFF" strokeWidth={2.6} /> : null}
    </View>
  );
}

/* ------------------------------------------------------------ V3 sheets */

/** The sheet's 20/800 title, with its one line under it. */
export function SheetTitle({ title, sub, subTone, lead }: { title: string; sub?: string; subTone?: 'danger'; lead?: React.ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      {lead}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text accessibilityRole="header" style={[{ fontSize: 20, lineHeight: 26, color: C.ink }, weight(800)]}>
          {title}
        </Text>
        {sub ? (
          <Text style={[{ fontSize: 12, lineHeight: 17, color: subTone === 'danger' ? C.danger : C.muted, marginTop: 2 }, weight(subTone ? 600 : 400)]}>
            {sub}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** The wash-filled 52 box the V3 sheets type into. */
export function WashInput({
  icon,
  style,
  ...input
}: { icon?: IconName; style?: StyleProp<ViewStyle> } & Omit<TextInputProps, 'style'>) {
  return (
    <View
      style={[
        { minHeight: 52, borderRadius: 18, backgroundColor: C.canvas, flexDirection: 'row', alignItems: input.multiline ? 'flex-start' : 'center', gap: 8, paddingHorizontal: 14 },
        style,
      ]}>
      {icon ? (
        <View style={{ paddingTop: input.multiline ? 15 : 0 }}>
          <Icon name={icon} size={18} color={C.muted} strokeWidth={2} />
        </View>
      ) : null}
      <TextInput
        placeholderTextColor={C.faint}
        accessibilityLabel={typeof input.placeholder === 'string' ? input.placeholder : undefined}
        {...input}
        style={[
          { flex: 1, minWidth: 0, fontSize: 15, lineHeight: 20, color: C.ink, paddingVertical: 14, paddingHorizontal: 0 },
          input.multiline ? { textAlignVertical: 'top' } : null,
          weight(400),
        ]}
      />
    </View>
  );
}

/** A 40 choice pill in a sheet — navy when picked. */
export function SheetChip({ label, a11y, on, onPress, icon }: { label: string; a11y?: string; on: boolean; onPress: () => void; icon?: IconName }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      accessibilityLabel={a11y ?? label}
      hitSlop={{ top: 4, bottom: 4 }}
      style={({ pressed }) => ({
        minHeight: 44,
        paddingHorizontal: 16,
        borderRadius: 22,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        backgroundColor: on ? C.navy : pressed ? C.hairline : C.canvas,
      })}>
      {icon ? <Icon name={icon} size={15} color={on ? C.lime : C.muted} strokeWidth={2.2} /> : null}
      <Text style={[{ fontSize: 14, color: on ? '#FFFFFF' : C.ink }, weight(on ? 700 : 600)]}>{label}</Text>
    </Pressable>
  );
}

/** The refusal line inside a sheet — red pill, short sentence. */
export function SheetError({ text }: { text: string }) {
  return (
    <View style={{ minHeight: 36, borderRadius: 18, backgroundColor: C.dangerBg, paddingHorizontal: 12, paddingVertical: 8, justifyContent: 'center' }}>
      <Text style={[{ fontSize: 12, lineHeight: 17, color: C.danger }, weight(600)]}>{text}</Text>
    </View>
  );
}

/** Cancel (110, wash) and the navy action — every V3 sheet ends on it. */
export function SheetFooter({
  onCancel,
  cancelLabel = 'Cancel',
  label,
  onPress,
  disabled = false,
  a11y,
}: {
  onCancel: () => void;
  cancelLabel?: string;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  a11y?: string;
}) {
  return (
    <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
      <Pressable
        onPress={onCancel}
        accessibilityRole="button"
        accessibilityLabel={cancelLabel}
        style={({ pressed }) => ({ width: 110, height: 56, borderRadius: 28, backgroundColor: pressed ? C.hairline : C.canvas, alignItems: 'center', justifyContent: 'center' })}>
        <Text style={[{ fontSize: 14, color: C.ink }, weight(700)]}>{cancelLabel}</Text>
      </Pressable>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={a11y ?? label}
        accessibilityState={{ disabled }}
        style={({ pressed }) => ({
          flex: 1,
          height: 56,
          borderRadius: 28,
          backgroundColor: disabled ? C.primaryEdge : pressed ? C.navySoft : C.navy,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: 12,
        })}>
        <Text numberOfLines={1} style={[{ fontSize: 15, color: '#FFFFFF' }, weight(700)]}>
          {label}
        </Text>
      </Pressable>
    </View>
  );
}
