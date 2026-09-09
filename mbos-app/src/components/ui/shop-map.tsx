import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { router, usePathname } from 'expo-router';
import { Camera, Map, Marker, type LngLatBounds } from '@maplibre/maplibre-react-native';
import { color as C, radius, weight } from '../../theme/tokens';
import { MAP_STYLE, mapKey, savedBounds } from '../../data/offline-maps';
import { coverageOf, type Bounds, type Coverage } from '../../engines/tiles';
import { plural } from '../../lib/format';

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

/** Fit, never fill — one pin gets a street, not a rooftop. */
const MAX_FIT_ZOOM = 15;

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
  const [online, setOnline] = React.useState(true);

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

  /* West, south, east, north — the order MapLibre's own LngLatBounds declares,
     which is GeoJSON's and NOT the ne/sw pair the web's MapLibre GL takes. Two
     libraries, two orders, and getting it wrong opens the map on the wrong
     hemisphere rather than failing. */
  const bounds = React.useMemo<LngLatBounds | null>(() => {
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
       than on its rooftop. `maxZoomLevel` is the belt for the same thing. */
    const pad = 0.0027;
    if (n - s < pad) { n += pad; s -= pad; }
    if (e - w < pad) { e += pad; w -= pad; }
    return [w, s, e, n];
  }, [placed]);

  const coverage: Coverage = React.useMemo(
    () => coverageOf(placed, packs ?? []),
    [placed, packs],
  );

  const missing = pins.length - placed.length;

  if (key === undefined || packs === null) {
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
        <Map style={{ flex: 1 }} mapStyle={MAP_STYLE}>
          {bounds ? (
            <Camera
              bounds={bounds}
              maxZoom={MAX_FIT_ZOOM}
              padding={{ top: 40, bottom: 40, left: 40, right: 40 }}
            />
          ) : null}

          {placed.map((p) => (
            <Marker key={p.id} id={p.id} lngLat={[p.lng, p.lat]} onPress={() => onPress(p)}>
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
            </Marker>
          ))}
        </Map>
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
