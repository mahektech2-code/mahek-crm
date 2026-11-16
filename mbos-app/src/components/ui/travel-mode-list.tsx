import React from 'react';
import { View } from 'react-native';

import { T } from './primitives';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { PressableScale } from './motion';
import { color as C, weight } from '../../theme/tokens';
import type { TravelMode } from '../../data/travel';

/**
 * The list of ways to travel, drawn once for the two places that ask.
 *
 * The punch-in asks which vehicle the SESSION is on; the journey asks which
 * fare this leg is, and only on a day spent on public transport. They are
 * different questions with different lists, and they were about to be two
 * copies of the same rows, the same hint and the same three-line layout —
 * which is how one of them ends up explaining what a mode does and the other
 * does not.
 */

/**
 * What this option is about to DO, on the option itself.
 *
 * Read once by somebody who is already late, and three words each gives him no
 * reason to expect that two of them open a camera. Said here, the camera reads
 * as the thing he chose; unsaid, it reads as the app misbehaving. It is
 * derived from the mode's own flags rather than written per mode, so a mode an
 * admin adds tomorrow explains itself.
 *
 * The sentence differs by WHERE it is asked, because the same flag means two
 * different amounts of work: a meter at the punch-in is two photographs for
 * the whole day, and a meter at a stop is two for every shop.
 */
export function modeHint(m: TravelMode, where: 'day' | 'leg'): string {
  if (m.requiresOdometer) {
    return where === 'day'
      ? 'Take a meter photo now, and again when you punch out'
      : 'Take a meter photo now, and again when you reach the shop';
  }
  if (m.requiresTicket) return 'Add the ticket photo when you save the visit, if you have it';
  /* Public transport is the one day-level answer that leaves a question open,
     and saying so here is what stops the journey's own sheet reading as the
     app having forgotten what he already told it. */
  if (m.key === 'public_transport') return 'At each shop, you will pick bus, train or auto';
  return 'Nothing to record';
}

/**
 * The same sentence, short enough for a tile in Version 3's two-column grid.
 * The full one from `modeHint` stays on the tile's accessibility label.
 */
export function modeHintShort(m: TravelMode, where: 'day' | 'leg'): string {
  if (m.requiresOdometer) return where === 'day' ? 'Meter now + at punch-out' : 'Meter now + at the shop';
  if (m.requiresTicket) return 'Ticket photo, if you have it';
  if (m.key === 'public_transport') return 'Bus, train or auto at each shop';
  return 'Nothing to record';
}

type Glyph = { p?: string; c?: [number, number, number]; r?: [number, number, number, number, number] }[];

/** A picture of the mode, read off its key or name; a mode nobody drew gets a route mark. */
function modeGlyph(m: TravelMode): Glyph {
  const t = (m.key + ' ' + m.label).toLowerCase();
  if (/walk/.test(t)) return [{ c: [13, 4, 2] }, { p: 'M9 21l3-7 3 3v4M10 10l3-3 3 4 3 1M12 14l-1-4-4 2' }];
  if (/public|bus|train|auto|taxi/.test(t))
    return [{ r: [5, 3, 14, 15, 2] }, { p: 'M5 11h14M8 21l1-3M16 21l-1-3' }, { c: [9, 14.5, 1] }, { c: [15, 14.5, 1] }];
  if (/customer/.test(t)) return [{ p: 'M4 10l2-5h12l2 5M4 10v10h16V10M4 10h16' }];
  if (/company|van|truck/.test(t)) return [{ p: 'M2 16V7h12v9M14 10h4l3 3v3h-7' }, { c: [6, 17, 2] }, { c: [17, 17, 2] }];
  if (/bike|scooter|two/.test(t))
    return [{ c: [5.5, 17, 3.5] }, { c: [18.5, 17, 3.5] }, { p: 'M5.5 17l4-7h5l4 7M9.5 10L8 6H5M14 6h3l1.5 4' }];
  if (/car/.test(t)) return [{ p: 'M3 16v-4l2-5h14l2 5v4H3zM3 12h18' }, { c: [7, 17, 2] }, { c: [17, 17, 2] }];
  return [{ p: 'M4 19c4 0 4-14 8-14s4 14 8 14' }];
}

function ModeGlyph({ shapes, color, size = 24 }: { shapes: Glyph; color: string; size?: number }) {
  const stroke = { stroke: color, strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' as const };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {shapes.map((g, i) =>
        g.p ? (
          <Path key={i} d={g.p} {...stroke} />
        ) : g.c ? (
          <Circle key={i} cx={g.c[0]} cy={g.c[1]} r={g.c[2]} {...stroke} />
        ) : g.r ? (
          <Rect key={i} x={g.r[0]} y={g.r[1]} width={g.r[2]} height={g.r[3]} rx={g.r[4]} {...stroke} />
        ) : null,
      )}
    </Svg>
  );
}

export function TravelModeList({
  modes,
  where,
  busy,
  onPick,
}: {
  modes: TravelMode[];
  where: 'day' | 'leg';
  busy?: boolean;
  onPick: (mode: TravelMode) => void;
}) {
  return (
    <View style={{ marginTop: 16, flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
      {/* A pick is a choice that moved, so it ticks `select` — and for the
          two modes that open a camera, the tick is the moment he can feel
          that the tap landed before the camera takes over the screen. */}
      {modes.map((mode) => (
        <PressableScale
          key={mode.key}
          feedbackKind="select"
          accessibilityRole="button"
          accessibilityLabel={`${mode.label} — ${modeHint(mode, where)}`}
          disabled={busy}
          onPress={() => onPick(mode)}
          outerStyle={{ width: '48%', flexGrow: 1 }}
          style={{
            minHeight: 112,
            justifyContent: 'space-between',
            gap: 8,
            borderRadius: 20,
            backgroundColor: C.canvas,
            padding: 12,
            opacity: busy ? 0.5 : 1,
          }}>
          <ModeGlyph shapes={modeGlyph(mode)} color={C.ink} />
          <View>
            <T style={[{ fontSize: 15, lineHeight: 20, color: C.ink }, weight(800)]}>{mode.label}</T>
            <T
              style={[
                { fontSize: 11, lineHeight: 15, color: mode.requiresOdometer ? C.primaryDeep : C.muted, marginTop: 1 },
                weight(mode.requiresOdometer ? 600 : 400),
              ]}>
              {modeHintShort(mode, where)}
            </T>
          </View>
        </PressableScale>
      ))}
    </View>
  );
}
