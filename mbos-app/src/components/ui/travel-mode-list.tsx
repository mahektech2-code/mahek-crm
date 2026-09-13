import React from 'react';
import { Pressable, View } from 'react-native';

import { T } from './primitives';
import { Icon } from './Icon';
import { color as C, HIT, radius, weight } from '../../theme/tokens';
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
      ? 'Photograph the meter now and again when you punch out'
      : 'Photograph the meter now and again when you get there';
  }
  if (m.requiresTicket) return 'Add the ticket when you save the visit, if you keep it';
  /* Public transport is the one day-level answer that leaves a question open,
     and saying so here is what stops the journey's own sheet reading as the
     app having forgotten what he already told it. */
  if (m.key === 'public_transport') return 'You will be asked bus, train or auto at each shop';
  return 'Nothing to record';
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
    <View style={{ marginTop: 14, gap: 8 }}>
      {modes.map((mode) => (
        <Pressable
          key={mode.key}
          accessibilityRole="button"
          accessibilityLabel={`${mode.label} — ${modeHint(mode, where)}`}
          disabled={busy}
          onPress={() => onPick(mode)}
          style={{
            minHeight: HIT,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            borderWidth: 1,
            borderColor: C.border,
            borderRadius: radius.md,
            paddingHorizontal: 14,
            paddingVertical: 10,
            opacity: busy ? 0.5 : 1,
          }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T style={[{ fontSize: 15, color: C.ink }, weight(600)]}>{mode.label}</T>
            <T style={{ fontSize: 12, lineHeight: 16, color: C.muted, marginTop: 1 }}>
              {modeHint(mode, where)}
            </T>
          </View>
          <Icon name="forward" size={18} color={C.muted} strokeWidth={1.6} />
        </Pressable>
      ))}
    </View>
  );
}
