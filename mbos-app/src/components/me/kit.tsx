import React from 'react';
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { color as C, weight } from '../../theme/tokens';
import { HERO, type HeroTone } from '../shell/Chrome';

/**
 * The few pieces Version 3 draws on the Me screens — attendance, profile,
 * salary, holidays, leave, the allowance list — that the shared primitives do
 * not carry. Kept here rather than in `ui/` because nothing outside those
 * screens draws them, and a shared primitive is a promise to every screen.
 */

/** One shape of a glyph: a path, a circle `[cx, cy, r]` or a rect `[x, y, w, h, rx]`. */
export type GlyphShape = { p: string } | { c: [number, number, number] } | { r: [number, number, number, number, number] };

/**
 * A 24×24 stroke glyph the shared `Icon` set does not have — a plate, a bed,
 * a moon, a bus. The artboards draw them inline; so does this.
 */
export function Glyph({
  shapes,
  size = 20,
  color = C.body,
  strokeWidth = 2,
}: {
  shapes: GlyphShape[];
  size?: number;
  color?: string;
  strokeWidth?: number;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {shapes.map((s, i) => {
        const stroke = { stroke: color, strokeWidth, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' as const };
        if ('p' in s) return <Path key={i} d={s.p} {...stroke} />;
        if ('c' in s) return <Circle key={i} cx={s.c[0]} cy={s.c[1]} r={s.c[2]} {...stroke} />;
        return <Rect key={i} x={s.r[0]} y={s.r[1]} width={s.r[2]} height={s.r[3]} rx={s.r[4]} {...stroke} />;
      })}
    </Svg>
  );
}

/** The glyphs those screens use, lifted from the artboards. */
export const GLYPH = {
  receipt: [{ p: 'M6 3h12v18l-3-2-3 2-3-2-3 2z' }],
  breakfast: [{ p: 'M4 11h16a8 8 0 0 1-16 0zM8 7c0-1 1-1 1-2M12 7c0-1 1-1 1-2' }],
  bowl: [{ p: 'M4 11h16a8 8 0 0 1-16 0z' }],
  moon: [{ p: 'M20 14a8 8 0 1 1-10-10 6 6 0 0 0 10 10z' }],
  bed: [{ p: 'M3 18V8M3 14h18v4M21 14v-2a3 3 0 0 0-3-3h-7v5' }, { c: [7, 11, 2] }],
  bunk: [{ p: 'M3 18V8M3 14h18v4M21 14v-2a3 3 0 0 0-3-3h-7v5' }],
  bus: [{ r: [5, 3, 14, 15, 2] }, { p: 'M5 11h14M8 21l1-3M16 21l-1-3' }],
  bike: [{ c: [5.5, 17, 3.5] }, { c: [18.5, 17, 3.5] }, { p: 'M5.5 17l4-7h5l4 7' }],
  shieldTick: [{ p: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z' }, { p: 'M9 12l2 2 4-4' }],
  cal: [{ r: [4, 5, 16, 15, 2] }, { p: 'M4 10h16' }],
  info: [{ c: [12, 12, 9] }, { p: 'M12 11v5M12 8h.01' }],
  clock: [{ c: [12, 12, 9] }, { p: 'M12 7v5l3 2' }],
  plane: [{ p: 'M2 16l20-6-20-6 4 6zM6 10h8' }],
  phone: [{ r: [7, 2, 10, 20, 2] }, { p: 'M11 18h2' }],
  mail: [{ r: [3, 5, 18, 14, 2] }, { p: 'm3 7 9 6 9-6' }],
  pin: [{ p: 'M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z' }, { c: [12, 10, 2.5] }],
  badge: [{ r: [4, 4, 16, 16, 3] }, { c: [12, 10, 2.5] }, { p: 'M8 16c1-2 7-2 8 0' }],
  person: [{ c: [12, 8, 3.5] }, { p: 'M5 20a7 7 0 0 1 14 0' }],
  bell: [{ p: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0' }],
  finger: [{ p: 'M7 11a5 5 0 0 1 10 0v2M12 11v6M9 14v3M15 14v4M5 14v-3' }],
  vibrate: [{ r: [8, 4, 8, 16, 2] }, { p: 'M4 9v6M20 9v6' }],
  sound: [{ p: 'M4 10v4h4l5 4V6l-5 4zM16 9a4 4 0 0 1 0 6M18.5 7a7 7 0 0 1 0 10' }],
  key: [{ c: [8, 15, 4] }, { p: 'M11 12l9-9M17 6l2 2M15 8l2 2' }],
  exit: [{ p: 'M10 4H5v16h5M14 8l4 4-4 4M18 12H9' }],
  chev: [{ p: 'm9 6 6 6-6 6' }],
  chevDown: [{ p: 'm6 9 6 6 6-6' }],
  chevUp: [{ p: 'm6 15 6-6 6 6' }],
  left: [{ p: 'M15 6 9 12l6 6' }],
  rupee: [{ p: 'M7 5h10M7 9h10M9 5c4 0 6 2 6 4s-2 4-6 4H8l7 7' }],
  wallet: [{ r: [3, 6, 18, 13, 2] }, { p: 'M3 10h18M16 14h2' }],
  alert: [{ p: 'M12 4l9 16H3z' }, { p: 'M12 10v4M12 17h.01' }],
  plus: [{ p: 'M12 5v14M5 12h14' }],
} satisfies Record<string, GlyphShape[]>;

/** A pill in a hero block, the way Version 3 draws a fact about the screen. */
export function HeroPill({
  children,
  tone = 'lavender',
  strong = false,
  ink,
  icon,
  style,
}: {
  children: React.ReactNode;
  tone?: HeroTone;
  /** The navy pill — the one fact the screen is mostly about. */
  strong?: boolean;
  ink?: string;
  icon?: GlyphShape[];
  style?: StyleProp<ViewStyle>;
}) {
  const h = HERO[tone];
  const bg = strong ? (tone === 'navy' ? C.lime : C.navy) : tone === 'navy' ? C.navySoft : C.surface;
  const fg = ink ?? (strong ? (tone === 'navy' ? C.navy : C.onNavy) : h.ink);
  return (
    <View
      style={[
        { height: 30, paddingHorizontal: 12, borderRadius: 15, backgroundColor: bg, flexDirection: 'row', alignItems: 'center', gap: 5 },
        style,
      ]}>
      {icon ? <Glyph shapes={icon} size={12} color={fg} strokeWidth={2.2} /> : null}
      <Text numberOfLines={1} style={[{ fontSize: 12, color: fg }, weight(700)]}>
        {children}
      </Text>
    </View>
  );
}

/** A round tinted tile holding a glyph — the leading mark on a V3 row. */
export function GlyphTile({
  shapes,
  bg = C.primaryTint,
  fg = C.primaryDeep,
  size = 40,
}: {
  shapes: GlyphShape[];
  bg?: string;
  fg?: string;
  size?: number;
}) {
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
      <Glyph shapes={shapes} size={Math.round(size / 2)} color={fg} />
    </View>
  );
}
