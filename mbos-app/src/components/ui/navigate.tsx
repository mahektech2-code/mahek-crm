import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { color as C, HIT, radius, weight } from '../../theme/tokens';
import { SecondaryButton } from './primitives';
import { Icon } from './Icon';
import { openMaps } from '../../lib/messaging';
import { useStore } from '../../state/store';

/**
 * Take him there.
 *
 * **THE FEATURE ALREADY EXISTED AND WAS DRAWN EVERYWHERE EXCEPT ON THE ROAD.**
 * `openMaps` has handed a shop to Google Maps, Apple Maps or the browser since
 * the journey screen shipped, and the journey screen drew a Navigate button
 * beside "Start visit" — in the branch that renders BEFORE he sets off. The
 * moment a leg opened, that card swapped to "Call it off / Continue" and the
 * button went with it; the On-your-way screen never had one at all. So
 * navigation was offered at every moment except the one where somebody is
 * actually travelling, which is the only moment it is for.
 *
 * It is a DEEP LINK and deliberately not a map. `engines/route.ts` says in its
 * own header that this app is not a routing service: real turn-by-turn needs a
 * road network, a directions API and a connection, and the phone that most
 * needs directions has one bar in a market lane. An in-app map could draw a
 * straight line between two dots and nothing more — it cannot say which road,
 * and it costs tiles and battery on a moving bike to say less than the maps app
 * he already has, which has the roads on the handset, the traffic and a voice.
 *
 * One component and not two call sites, because the two screens showing it are
 * the same journey at two moments and a Navigate on one that behaved
 * differently from the Navigate on the other is exactly the drift this codebase
 * spends its comments avoiding.
 */
export function NavigateButton({
  lat,
  lng,
  name,
  city,
  detail,
  variant = 'row',
  style,
}: {
  lat?: number | null;
  lng?: number | null;
  name?: string | null;
  city?: string | null;
  /** How far there is left to go — `navigationLine`, or nothing to say. */
  detail?: string | null;
  /*
   * `row` is the tinted band that carries a distance under its label, and it
   * is the shape for a card whose subject IS the journey — the On-your-way
   * screen, where nothing else on it competes for the eye. `button` is a plain
   * secondary, for the two places a tinted band would be wrong: beside "Start
   * visit", where Navigate is half of a question rather than the answer to
   * one, and under the journey card's own tinted "On your way to X" strip,
   * where a second band of the same colour reads as one muddy block.
   *
   * The two SHAPES differ; what they do does not, which is the whole reason
   * this takes a variant rather than the second call site keeping its own copy
   * of `openMaps`. That copy is how the failure message on one of them
   * eventually stops matching the other.
   */
  variant?: 'row' | 'button';
  style?: { flex?: number; marginTop?: number };
}) {
  const notify = useStore((s) => s.notify);
  const [busy, setBusy] = React.useState(false);

  /*
   * A failure is REPORTED, never swallowed. `openMaps` already falls all the
   * way to a browser URL and `navigateTo` beside it puts the coordinates on the
   * clipboard, so getting here at all means the handset would open nothing —
   * and a button that acknowledges the tap and then does nothing is the bug
   * this whole component exists to correct, one level down.
   */
  async function go() {
    if (busy) return;
    setBusy(true);
    try {
      const out = await openMaps({ lat, lng, name, city });
      if (out.status !== 'opened') notify(out.reason);
    } finally {
      setBusy(false);
    }
  }

  if (variant === 'button') {
    return (
      <SecondaryButton
        label={busy ? 'Opening maps…' : 'Navigate'}
        onPress={() => void go()}
        style={{ borderRadius: radius.xl, ...style }}
      />
    );
  }

  return (
    <Pressable
      onPress={() => void go()}
      accessibilityRole="button"
      accessibilityLabel={'Navigate to ' + (name ?? 'the shop')}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          backgroundColor: pressed ? C.primaryEdge : C.primaryTint,
          borderRadius: radius.lg,
          paddingHorizontal: 14,
          paddingVertical: 12,
          /* The row is comfortably past the minimum on its own; naming it keeps
             it there if the detail line is ever absent. */
          minHeight: HIT,
        },
        style,
      ]}>
      <Icon name="route" size={18} color={C.primaryDeep} strokeWidth={1.8} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[{ fontSize: 15, color: C.primaryDeep }, weight(600)]}>
          {busy ? 'Opening maps…' : 'Navigate'}
        </Text>
        {/*
          The distance rides UNDER the word rather than beside it. Beside it,
          the two compete on one line at the width of a phone and the label —
          which is what he is looking for — is the half that gets truncated.
        */}
        {detail ? (
          <Text style={{ fontSize: 12, lineHeight: 16, color: C.primaryDeep, marginTop: 1 }}>
            {detail}
          </Text>
        ) : null}
      </View>
      <Icon name="forward" size={16} color={C.primaryDeep} strokeWidth={1.8} />
    </Pressable>
  );
}
