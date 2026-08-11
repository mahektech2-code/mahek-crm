import React from 'react';
import Svg, { Path, Circle, Rect } from 'react-native-svg';
import { color as C } from '../../theme/tokens';

/**
 * The design's whole icon vocabulary, path for path.
 *
 * In the browser these were one string of markup handed to `innerHTML`. React
 * Native has no such door, so each glyph is a list of shapes instead — the
 * geometry is identical, and every icon is still one 24×24 box drawn with a
 * 1.6 stroke, which is what makes them look like a set rather than a
 * collection.
 */

type Shape =
  | { p: string }
  | { c: [number, number, number] }
  | { r: [number, number, number, number, number] };

const ICONS: Record<string, Shape[]> = {
  visit: [
    { p: 'M12 21s7-6.4 7-11.5A7 7 0 0 0 5 9.5C5 14.6 12 21 12 21z' },
    { c: [12, 9.5, 2.5] },
  ],
  pin: [
    { p: 'M12 21s7-6.4 7-11.5A7 7 0 0 0 5 9.5C5 14.6 12 21 12 21z' },
    { c: [12, 9.5, 2.5] },
  ],
  order: [
    { p: 'M4 5h2l2.2 10.4a1.6 1.6 0 0 0 1.6 1.3h7.6a1.6 1.6 0 0 0 1.6-1.3L20.5 8H7' },
    { c: [10, 20, 1.2] },
    { c: [18, 20, 1.2] },
  ],
  money: [
    { r: [3, 6, 18, 12, 2] },
    { c: [12, 12, 2.6] },
    { p: 'M6.5 12h.01M17.5 12h.01' },
  ],
  add: [{ p: 'M12 5v14M5 12h14' }],
  camera: [
    { p: 'M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z' },
    { c: [12, 13.5, 3.2] },
  ],
  task: [{ p: 'm4 12.5 3.5 3.5L20 6' }],
  sample: [{ p: 'M9 3h6M10.5 3v7.5L6.5 18a2 2 0 0 0 1.7 3h7.6a2 2 0 0 0 1.7-3l-4-7.5V3' }],
  call: [{ p: 'M5 4h3l1.6 4-2 1.4a11 11 0 0 0 5 5L14 12.4 18 14v3a2 2 0 0 1-2.2 2A15 15 0 0 1 3 6.2 2 2 0 0 1 5 4z' }],
  chat: [{ p: 'M21 11.5a8.4 8.4 0 0 1-12.3 7.5L3 20.5l1.6-5.4A8.4 8.4 0 1 1 21 11.5z' }],
  nav: [{ c: [12, 12, 9] }, { p: 'm15.5 8.5-2.1 5.4-5.4 2.1 2.1-5.4z' }],
  route: [
    { c: [6, 6, 2.2] },
    { c: [18, 18, 2.2] },
    { p: 'M8 6h6a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h7' },
  ],
  share: [
    { p: 'M12 16V4M8 8l4-4 4 4' },
    { p: 'M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3' },
  ],
  clock: [{ c: [12, 12, 9] }, { p: 'M12 7.5V12l3 2' }],
  spark: [{ p: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z' }],
  note: [
    { p: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' },
    { p: 'M14 3v5h5M9 13h6M9 17h4' },
  ],
  doc: [
    { p: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' },
    { p: 'M14 3v5h5' },
  ],
  clip: [{ p: 'M20 11.5 12 19.5a4.5 4.5 0 0 1-6.4-6.4l7.6-7.6a3 3 0 0 1 4.3 4.3l-7.6 7.6a1.5 1.5 0 0 1-2.2-2.2l6.9-6.9' }],
  close: [{ p: 'M6 6l12 12M18 6 6 18' }],
  dots: [{ c: [5, 12, 1.4] }, { c: [12, 12, 1.4] }, { c: [19, 12, 1.4] }],
  /* The design declares `home` twice; the second wins, and this is it. */
  home: [
    { p: 'M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z' },
    { p: 'M9.5 21v-6h5v6' },
  ],
  people: [
    { c: [9, 8, 3.2] },
    { p: 'M3.5 20v-1.5A4.5 4.5 0 0 1 8 14h2a4.5 4.5 0 0 1 4.5 4.5V20' },
    { p: 'M16.5 5.2a3.2 3.2 0 0 1 0 5.6M17 14a4.5 4.5 0 0 1 3.5 4.4V20' },
  ],
  grid: [
    { r: [4, 4, 6.5, 6.5, 1.6] },
    { r: [13.5, 4, 6.5, 6.5, 1.6] },
    { r: [4, 13.5, 6.5, 6.5, 1.6] },
    { r: [13.5, 13.5, 6.5, 6.5, 1.6] },
  ],

  /* Glyphs the design writes inline in the markup rather than through icon(). */
  back: [{ p: 'M15 6 9 12l6 6' }],
  forward: [{ p: 'm9 6 6 6-6 6' }],
  bell: [
    { p: 'M18 8A6 6 0 1 0 6 8c0 7-3 9-3 9h18s-3-2-3-9' },
    { p: 'M13.7 21a2 2 0 0 1-3.4 0' },
  ],
  play: [{ p: 'M5 3l14 9-14 9V3z' }],
  tick: [{ p: 'm5 13 4 4L19 7' }],
  search: [{ c: [11, 11, 7] }, { p: 'm20 20-3.2-3.2' }],
  filter: [{ p: 'M3 6h18M6 12h12M10 18h4' }],
  shop: [{ p: 'M3 8h3l2-3h8l2 3h3v11H3z' }, { c: [12, 13, 3.5] }],
  person: [{ c: [12, 8, 3.5] }, { p: 'M5 20a7 7 0 0 1 14 0' }],
  mic: [{ r: [9, 3, 6, 11, 3] }, { p: 'M5 11a7 7 0 0 0 14 0M12 18v3' }],
  finger: [
    { p: 'M12 11v3a5 5 0 0 1-.7 2.5' },
    { p: 'M8 10a4 4 0 0 1 8 0v4' },
    { p: 'M5 12a7 7 0 0 1 12-5' },
    { p: 'M16 14v1a8 8 0 0 1-.5 2.8' },
  ],
  lock: [{ r: [4, 11, 16, 10, 2] }, { p: 'M8 11V8a4 4 0 0 1 8 0v3' }],
};

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size = 20,
  color = C.body,
  strokeWidth = 1.6,
}: {
  name: IconName | string;
  size?: number;
  color?: string;
  strokeWidth?: number;
}) {
  const shapes = ICONS[name] ?? ICONS.dots;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {shapes.map((s, i) => {
        const stroke = {
          stroke: color,
          strokeWidth,
          strokeLinecap: 'round' as const,
          strokeLinejoin: 'round' as const,
          fill: 'none' as const,
        };
        if ('p' in s) return <Path key={i} d={s.p} {...stroke} />;
        if ('c' in s) return <Circle key={i} cx={s.c[0]} cy={s.c[1]} r={s.c[2]} {...stroke} />;
        return <Rect key={i} x={s.r[0]} y={s.r[1]} width={s.r[2]} height={s.r[3]} rx={s.r[4]} {...stroke} />;
      })}
    </Svg>
  );
}
