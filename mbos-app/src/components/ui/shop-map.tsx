import React from 'react';
import { ActivityIndicator, View, Text, Pressable } from 'react-native';
import { router, usePathname } from 'expo-router';
import {
  Camera,
  Map,
  Marker,
  type CameraRef,
  type LngLatBounds,
  type MapRef,
} from '@maplibre/maplibre-react-native';
import { color as C, radius, shadow, weight } from '../../theme/tokens';
import { MAP_STYLE, mapKey, mapSettings, savedBounds } from '../../data/offline-maps';
import { coverageOf, type Bounds, type Coverage } from '../../engines/tiles';
import { plural } from '../../lib/format';
import { fixOf, getFix, type Fix } from '../../native/location';
import { Icon } from './Icon';
import { useReduceMotion } from './motion';

/**
 * The book on a map, on the handset.
 *
 * THE SAME SUPPLIER THE CONSOLE USES. Ola Maps, through MapLibre, with the same
 * style URL and the same key — because two map suppliers is two bills, two
 * outages and two answers to "why does this shop sit in the wrong lane". The
 * web's own note in `sales/ola-maps.tsx` explains the style quirks; the key
 * arrives in the sync payload and `lib/secrets.ts` records what that costs.
 *
 * **A pin is only drawn where there is a fix.** Half this book has never been
 * pinned, and spacing those shops out to fill the screen would be the one thing
 * a map of where things are must not do. The count of what could not be drawn
 * is returned to the caller so the screen can say it in words instead.
 *
 * **NO MAP IS AN ANSWER, and the screen has to look like it.** With no key, no
 * pins, or no way to fetch tiles, this says which of those it is rather than
 * drawing a grey rectangle with dots floating on it. A map that fails when
 * opened is worse than one never offered, which is the rule the microphone
 * already follows.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * **AND "NO SIGNAL" IS NO LONGER ONE OF THOSE ANSWERS, where the area has
 * been saved.** This is the screen the whole offline-maps feature exists for:
 * a salesman in a market lane with two bars of nothing, holding the one device
 * that could tell him which lane. MapLibre serves a tile out of a downloaded
 * pack without being asked to, so the drawing needs no code here at all — what
 * needs code is knowing WHETHER it will, before the map is drawn, so the
 * alternative can be a sentence instead of a grey box.
 *
 * Three answers, and they are genuinely different:
 *
 *   Covered — draw the map. It makes no difference whether there is signal.
 *   Partly covered — draw it, and say how many shops fall outside what was
 *     saved. Their pins are on a blank patch and the salesman should know why
 *     rather than conclude the map is broken.
 *   Not covered, and offline — do NOT draw. Say so, and offer the screen that
 *     fixes it. A map drawn here is a grey rectangle, and the thing it is
 *     hiding is that fifteen minutes on the hotel Wi-Fi would have prevented
 *     it.
 *
 * Coverage is asked of the PINS rather than of the viewport, because the
 * viewport is not known until the map has drawn and this decision has to be
 * made before it does.
 * ─────────────────────────────────────────────────────────────────────────
 * **AND IT IS DRIVEN BY HAND AS WELL AS BY THE FIT.** The map opened on the
 * box round the book and there was nothing on it to press: a pinch is the
 * only zoom a salesman had, one-handed, on a phone he is holding above a
 * counter while somebody talks to him. Three controls, and they are in TWO
 * PLACES on purpose — zoom is a pair and belongs under the thumb; where you
 * are standing is a different question and sits away from them, because a
 * stack of three identical squares is three chances to press the wrong one.
 *
 * **WHERE YOU ARE IS NEVER ASKED FOR UNPROMPTED.** Opening a map of the book
 * is not a reason to turn the GPS radio on, and this component is drawn on
 * two screens somebody may sit with for a while. It is one button, pressed
 * deliberately, and it takes the fix `getFix` gives everybody else.
 *
 * A refused permission and no fix are two different sentences with two
 * different ways out, and neither is the sentence `getFix` returns: those are
 * written for a visit being saved without one ("flagged for your manager"),
 * and nothing is being saved here.
 * ───────────────────────────────────────────────────────────────────────── */

export type MapPin = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  /** Drawn differently: a lead is somebody we have not sold to yet. */
  isLead?: boolean;
  /** Ticked on the journey screen. Ignored elsewhere. */
  picked?: boolean;
};

/**
 * How far out the zoom-out button will go. The map itself is not floored —
 * a book spread over a state has to be able to fit on the screen, and a floor
 * set to the packs' own furthest zoom would refuse exactly that.
 */
const FURTHEST_ZOOM = 3;

/** What the map falls back to as its closest zoom if the settings cannot be read. */
const DEFAULT_CLOSEST_ZOOM = 16;

/** Where the map goes when somebody asks where they are: a lane, not a town. */
const ME_ZOOM = 16;

/** Anything worse than this is a fix that is roughly right rather than right. */
const GOOD_FIX_M = 100;

/** One zoom step, and the slack that lets a second press land on top of it. */
const ZOOM_MS = 220;

/** Held out of the render so the camera's props never change identity. */
const FIT_PADDING = { top: 40, bottom: 40, left: 40, right: 40 } as const;

const SQUARE = {
  width: 44,
  height: 44,
  alignItems: 'center',
  justifyContent: 'center',
} as const;

/**
 * What a shop pin is actually PRESSED on, as against what it is drawn as.
 *
 * Transparent and centred, so the dot inside keeps its 16 points and the target
 * reaches a thumb. It is 44 rather than the design's `HIT` of 48 for the reason
 * the zoom pair below carries in its own note — 44 is what a map can spare —
 * and here that reason is sharper: every extra point is a point of the map that
 * stops panning and a point of overlap with the shop next door.
 */
const TARGET = { ...SQUARE, backgroundColor: 'transparent' } as const;

/** A control that stands on its own, rather than one half of the zoom pair. */
const CONTROL = {
  ...SQUARE,
  borderRadius: radius.md,
  borderWidth: 1,
  borderColor: C.border,
  backgroundColor: C.surface,
  boxShadow: shadow.soft,
} as const;

export function ShopMap({
  pins,
  onPress,
  height = 380,
}: {
  pins: MapPin[];
  onPress: (pin: MapPin) => void;
  height?: number;
}) {
  const [key, setKey] = React.useState<string | null | undefined>(undefined);
  const [packs, setPacks] = React.useState<Bounds[] | null>(null);
  const [closest, setClosest] = React.useState<number | null>(null);
  const [online, setOnline] = React.useState(true);

  /* Where the salesman is standing, once he has pressed the button and not
     before. Null is "he has not asked", which is not the same as "the phone
     could not say" — that one is a sentence, below. */
  const [me, setMe] = React.useState<Fix | null>(null);
  const [locating, setLocating] = React.useState(false);
  const [locateNote, setLocateNote] = React.useState<string | null>(null);

  const mapRef = React.useRef<MapRef>(null);
  const cameraRef = React.useRef<CameraRef>(null);
  /* Where the last press was GOING. A second press inside the first one's
     animation has to count from there rather than from wherever the map
     happens to be half way there — otherwise two quick presses move one step
     and the button reads as broken. */
  const goingTo = React.useRef<{ zoom: number; at: number } | null>(null);
  const reduce = useReduceMotion();

  /* Where the back link on the maps screen should return to. Taken from the
     route rather than passed in, because the two screens that draw this map
     would each have to remember to name themselves and the one that forgot
     would send somebody somewhere they had never been. */
  const here = usePathname().replace(/^\//, '') || 'customers';

  React.useEffect(() => {
    let live = true;
    /* `mapKey` applies the key as well as returning it: it goes on every
       request MapLibre makes — tiles, glyphs and the sprite sheet, not only
       the style file — and is added at the HTTP layer, so a downloaded pack is
       stored and found without it. See `data/offline-maps.ts`. */
    void mapKey()
      .then((k) => live && setKey(k))
      .catch(() => live && setKey(null));
    /* What is on the phone. Read once — a pack cannot appear while this screen
       is open, because saving one happens on a screen of its own. */
    void savedBounds()
      .then((b) => live && setPacks(b))
      .catch(() => live && setPacks([]));
    /* HOW FAR IN THE MAP MAY GO IS THE CLOSEST ZOOM THE DOWNLOADS ARE CUT AT.
       Past it there are no tiles on the phone, and a market lane with no
       signal is exactly where somebody would find that out. It replaces a flat
       ceiling of 15 that sat one step BELOW what the packs hold — the download
       setting promises a lane with its name on it at 16 and the map would
       never draw it, however hard anybody pinched. Read before the map is
       mounted, deliberately: changing it afterwards re-applies the camera, and
       that would throw away wherever the salesman had just zoomed to. */
    void mapSettings()
      .then((m) => live && setClosest(m.maxZoom))
      .catch(() => live && setClosest(DEFAULT_CLOSEST_ZOOM));
    return () => {
      live = false;
    };
  }, []);

  React.useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    void import('@react-native-community/netinfo').then(({ default: NetInfo }) => {
      if (!live) return;
      /* Followed rather than read once: somebody walks out of the market and
         into signal while looking at this, and the screen should stop telling
         him he has none. */
      stop = NetInfo.addEventListener((s) => setOnline(s.isConnected !== false));
      void NetInfo.fetch().then((s) => live && setOnline(s.isConnected !== false));
    });
    return () => {
      live = false;
      stop?.();
    };
  }, []);

  const placed = React.useMemo(
    () => pins.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)),
    [pins],
  );

  const box = React.useMemo(() => {
    if (!placed.length) return null;
    let n = -90, s = 90, e = -180, w = 180;
    for (const p of placed) {
      n = Math.max(n, p.lat);
      s = Math.min(s, p.lat);
      e = Math.max(e, p.lng);
      w = Math.min(w, p.lng);
    }
    /* A single pin has zero span, and a zero-span bounds is a division by
       nothing — padded to roughly 300 m so one shop opens on its street rather
       than on its rooftop. THE PAD is what does that, and not the ceiling
       above: 600 metres across a phone-sized map lands at about zoom 16
       wherever the ceiling happens to be set. */
    const pad = 0.0027;
    if (n - s < pad) { n += pad; s -= pad; }
    if (e - w < pad) { e += pad; w -= pad; }
    return { w, s, e, n };
  }, [placed]);

  /* West, south, east, north — the order MapLibre's own LngLatBounds declares,
     which is GeoJSON's and NOT the ne/sw pair the web's MapLibre GL takes. Two
     libraries, two orders, and getting it wrong opens the map on the wrong
     hemisphere rather than failing.

     AND IT IS HELD BY VALUE, which is the whole reason the box above is four
     numbers rather than this array. A bounds handed to the camera is a camera
     STOP, and MapLibre re-applies a stop whenever the prop is set — not only
     when it changes meaning. Both callers build `pins` inline (`rows.map(…)`),
     so every re-render of the screen above produces a new array, a new
     `placed`, and a new bounds that is numerically identical to the one before
     it. Left as one memo, the map jumped back to the fit whenever anything
     above it re-rendered, and every zoom a salesman had just made went with
     it. Four numbers compare by value, so this array keeps its identity until
     the book on the map actually moves. */
  const { w, s, e, n } = box ?? { w: null, s: null, e: null, n: null };
  const bounds = React.useMemo<LngLatBounds | null>(
    () => (w === null || s === null || e === null || n === null ? null : [w, s, e, n]),
    [w, s, e, n],
  );

  const coverage: Coverage = React.useMemo(
    () => coverageOf(placed, packs ?? []),
    [placed, packs],
  );

  const missing = pins.length - placed.length;

  /**
   * One step in or out.
   *
   * The zoom is READ rather than followed. Tracking it in state would mean a
   * re-render on every pinch, and a re-render is the one thing this component
   * has to be careful with — see the note on `bounds`. `getZoom()` is the
   * authoritative answer and costs one hop across the bridge on a press.
   */
  async function stepZoom(by: 1 | -1): Promise<void> {
    const camera = cameraRef.current;
    if (!camera || closest === null) return;

    const going = goingTo.current;
    const from =
      going && Date.now() - going.at < ZOOM_MS + 150
        ? going.zoom
        : await mapRef.current?.getZoom().catch(() => null);
    if (typeof from !== 'number') return;

    const next = Math.min(closest, Math.max(FURTHEST_ZOOM, from + by));
    if (next === from) return;

    goingTo.current = { zoom: next, at: Date.now() };
    try {
      camera.zoomTo(next, { duration: reduce ? 0 : ZOOM_MS });
    } catch {
      /* The camera is not on the screen yet. Nothing to move, nothing to say. */
    }
  }

  /** Where he is standing, asked for by hand and answered on the map. */
  async function locate(): Promise<void> {
    if (locating) return;
    setLocating(true);
    setLocateNote(null);

    /* Balanced accuracy, which on Android is roughly a city block — and on
       the one question this button is asked, which lane he is standing in,
       that is thin. It is deliberately not widened for this: `getFix` keeps
       the GPS radio on longer at High accuracy, and changing what it does for
       one button is a battery decision taken on behalf of its every other
       caller. What covers the gap is the sentence below — a fix worse than
       `GOOD_FIX_M` is drawn AND said, so nobody reads the dot as more exact
       than it is. */
    const result = await getFix({ accuracyThresholdM: GOOD_FIX_M });
    setLocating(false);

    const fix = fixOf(result);
    if (!fix) {
      /* Deliberately not `result.reason`: those sentences are written for a
         visit being saved without a fix, and nothing is being saved here. Two
         refusals, two ways out. */
      setLocateNote(
        result.status === 'denied'
          ? 'Location is switched off for MBOS. Turn it on in the phone’s settings to see where you are on the map.'
          : 'The phone could not get a location. It usually comes quicker outside, away from a roof.');
      return;
    }

    setMe(fix);
    /* A poor fix is drawn, and said. Dropping it would throw away a perfectly
       good answer to which part of town he is in; drawing it silently would
       put a dot on a lane nobody can stand behind. */
    setLocateNote(
      result.status === 'coarse'
        ? `Only accurate to about ${fix.accuracyM} m, so the blue dot is roughly where you are rather than exactly.`
        : null,
    );

    const at = await mapRef.current?.getZoom().catch(() => null);
    /* Never zooms OUT to reach him. Somebody already looking closely at a lane
       has said what scale he wants. */
    const zoom = Math.min(
      closest ?? DEFAULT_CLOSEST_ZOOM,
      Math.max(typeof at === 'number' ? at : 0, ME_ZOOM),
    );
    goingTo.current = { zoom, at: Date.now() };
    try {
      cameraRef.current?.easeTo({
        center: [fix.lng, fix.lat],
        zoom,
        duration: reduce ? 0 : 600,
      });
    } catch {
      /* Same as above: the map has gone. The dot is still set, so it appears
         where it belongs the moment the camera is back. */
    }
  }

  if (key === undefined || packs === null || closest === null) {
    return <Frame height={height}><Note>Loading the map…</Note></Frame>;
  }

  /* No key configured. Nothing is drawn and the reason is given, rather than a
     grey rectangle somebody reports as a broken map. */
  if (!key) {
    return (
      <Frame height={height}>
        <Note>
          No map is set up yet. The office adds a maps key in the Admin Console,
          and this screen starts working on the next sync.
        </Note>
      </Frame>
    );
  }

  if (!placed.length) {
    return (
      <Frame height={height}>
        <Note>
          {pins.length
            ? `None of these ${pins.length} shops has been pinned yet. Capture a location while you are standing in one and it appears here.`
            : 'No shops to show.'}
        </Note>
      </Frame>
    );
  }

  /* NO SIGNAL AND NOTHING SAVED FOR HERE. The one case where drawing the map
     is worse than not drawing it: the tiles cannot arrive, the pins would sit
     on a blank ground, and the fix — fifteen minutes on Wi-Fi — is a screen
     away and would otherwise never be found. */
  if (!online && coverage.state === 'none') {
    return (
      <Frame height={height}>
        <Note>No signal, and no map saved for here.</Note>
        <Pressable
          onPress={() => router.push(`/maps?from=${here}`)}
          accessibilityRole="button"
          style={{
            marginTop: 12,
            minHeight: 48,
            paddingHorizontal: 16,
            justifyContent: 'center',
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: C.border,
            backgroundColor: C.surface,
          }}>
          <Text style={[{ fontSize: 15, color: C.primary }, weight(600)]}>
            Save maps for offline
          </Text>
        </Pressable>
        <Text style={{ fontSize: 13, lineHeight: 19, marginTop: 10, color: C.muted, textAlign: 'center' }}>
          Do it once on Wi-Fi and the streets are there whether or not you have
          signal.
        </Text>
      </Frame>
    );
  }

  return (
    <View>
      <View style={{ height, borderRadius: radius.card, overflow: 'hidden' }}>
        <Map ref={mapRef} style={{ flex: 1 }} mapStyle={MAP_STYLE}>
          {bounds ? (
            <Camera ref={cameraRef} bounds={bounds} maxZoom={closest} padding={FIT_PADDING} />
          ) : null}

          {placed.map((p) => (
            <Marker key={p.id} id={p.id} lngLat={[p.lng, p.lat]} onPress={() => onPress(p)}>
              {/* THE DOT IS 16dp AND THE TARGET IS NOT.
                  A Marker's touch area is exactly its child, and React Native
                  does not expand one — so the whole of this was 16 points
                  across, against the design's own `HIT` floor of 48, on a
                  control aimed at with a thumb while standing up. In a market
                  lane two shops' dots overlap at that size, and he either
                  misses or opens the neighbour's record; on the journey picker
                  the same miss adds the wrong stop.

                  `hitSlop` is not the fix here — it is a Pressable's property
                  and this is a native annotation — so the target is the
                  transparent square, and the dot is centred inside it. The
                  marker anchors on its CENTRE, so growing the child moves
                  nothing: the dot still sits on the coordinate. */}
              <View style={TARGET}>
                {/* Drawn here rather than as a symbol layer so a lead and a
                    picked stop are told apart at a glance without a legend. */}
                <View
                  style={{
                    width: p.picked ? 22 : 16,
                    height: p.picked ? 22 : 16,
                    borderRadius: 11,
                    borderWidth: 2,
                    borderColor: '#fff',
                    backgroundColor: p.picked
                      ? C.primary
                      : p.isLead
                        ? C.warn
                        : C.ink,
                  }}
                />
              </View>
            </Marker>
          ))}

          {/* WHERE HE IS STANDING, and it is BLUE because no shop pin is. A
              customer is ink, a lead amber, a picked stop purple — mistaking
              this for one of those is how a journey gets a stop nobody chose.
              Drawn last so it sits over a shop he is standing outside. */}
          {me ? (
            <Marker id="me" lngLat={[me.lng, me.lat]}>
              <View
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 9,
                  borderWidth: 3,
                  borderColor: '#fff',
                  backgroundColor: C.info,
                  boxShadow: shadow.soft,
                }}
              />
            </Marker>
          ) : null}
        </Map>

        {/* THE CONTROLS, in two places. Absolutely positioned siblings of the
            map rather than children of one overlay, so each catches presses
            inside its own square and the map keeps every gesture everywhere
            else — no wrapper to remember to make transparent to touch. */}
        <Pressable
          onPress={() => void locate()}
          disabled={locating}
          hitSlop={4}
          accessibilityRole="button"
          accessibilityLabel="Show where I am"
          accessibilityState={{ busy: locating }}
          style={({ pressed }) => [
            CONTROL,
            { position: 'absolute', top: 12, right: 12 },
            pressed && { backgroundColor: C.wash },
          ]}
        >
          {locating ? (
            <ActivityIndicator size="small" color={C.primary} />
          ) : (
            <Icon name="locate" size={20} color={me ? C.info : C.ink} />
          )}
        </Pressable>

        {/* One card, two halves and a hairline between them: the pair reads as
            one control with a direction rather than as two more buttons. */}
        <View
          style={{
            position: 'absolute',
            right: 12,
            bottom: 12,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: C.border,
            backgroundColor: C.surface,
            overflow: 'hidden',
            boxShadow: shadow.soft,
          }}
        >
          <Pressable
            onPress={() => void stepZoom(1)}
            /* 44 is what the map can spare and 48 is what a thumb needs, so
               the difference is taken in slop — away from the seam, so the two
               halves cannot claim the same four points. */
            hitSlop={{ top: 4, left: 4, right: 4 }}
            accessibilityRole="button"
            accessibilityLabel="Zoom in"
            style={({ pressed }) => [SQUARE, pressed && { backgroundColor: C.wash }]}
          >
            <Icon name="zoomIn" size={20} color={C.ink} />
          </Pressable>
          <View style={{ height: 1, backgroundColor: C.hairline }} />
          <Pressable
            onPress={() => void stepZoom(-1)}
            hitSlop={{ bottom: 4, left: 4, right: 4 }}
            accessibilityRole="button"
            accessibilityLabel="Zoom out"
            style={({ pressed }) => [SQUARE, pressed && { backgroundColor: C.wash }]}
          >
            <Icon name="zoomOut" size={20} color={C.ink} />
          </Pressable>
        </View>
      </View>

      {/* WHAT THE MAP CANNOT ANSWER FOR, said in words underneath. Two
          different gaps and they are never merged: a shop with no coordinate
          is missing from the map whatever the signal, and a shop outside what
          was saved is missing only while there is none. */}
      {missing > 0 ? (
        <Text style={[{ fontSize: 13, lineHeight: 19, marginTop: 8, color: C.muted }]}>
          {missing === 1
            ? 'One shop has no location yet, so it is not on the map.'
            : `${missing} shops have no location yet, so they are not on the map.`}
        </Text>
      ) : null}

      {!online && coverage.state === 'partial' ? (
        <Text style={[{ fontSize: 13, lineHeight: 19, marginTop: 8, color: C.warnInk }]}>
          {`No signal. ${plural(coverage.outside, 'shop')} of these are outside the maps saved on this phone, so the streets around them will be blank.`}
        </Text>
      ) : null}

      {/* WHY THE BLUE DOT IS NOT THERE, or why it is only roughly there. Said
          in the same place as the other two gaps, because it is the same kind
          of thing: something the map cannot answer for on its own. */}
      {locateNote ? (
        <Text style={[{ fontSize: 13, lineHeight: 19, marginTop: 8, color: C.warnInk }]}>
          {locateNote}
        </Text>
      ) : null}
    </View>
  );
}

function Frame({ height, children }: { height: number; children: React.ReactNode }) {
  return (
    <View
      style={{
        height,
        borderRadius: radius.card,
        borderWidth: 1,
        borderColor: C.border,
        backgroundColor: C.canvas,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 24,
      }}
    >
      {children}
    </View>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <Text
      style={[
        { fontSize: 14, lineHeight: 20, color: C.muted, textAlign: 'center' },
        weight(500),
      ]}
    >
      {children}
    </Text>
  );
}
