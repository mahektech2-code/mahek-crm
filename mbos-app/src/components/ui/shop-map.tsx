import React from 'react';
import { View, Text } from 'react-native';
import { Camera, Map, Marker, type LngLatBounds } from '@maplibre/maplibre-react-native';
import { color as C, radius, weight } from '../../theme/tokens';
import { getConfig } from '../../data/config';

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
 * **NO MAP IS AN ANSWER, and the screen has to look like it.** With no key, or
 * no connection, the tiles never arrive — so rather than a grey rectangle with
 * pins floating on it, this says which of the two it is. A map that fails when
 * opened is worse than one never offered, which is the rule the microphone
 * already follows. Offline, the pins still draw over a plain ground: their
 * relative positions are real and useful even with no streets behind them.
 */

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

const OLA_STYLE =
  'https://api.olamaps.io/tiles/vector/v1/styles/default-light-standard/style.json';

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

  React.useEffect(() => {
    let live = true;
    void getConfig<string>('maps.olaKey')
      .then((k) => live && setKey(k ?? null))
      .catch(() => live && setKey(null));
    return () => {
      live = false;
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

  const missing = pins.length - placed.length;

  if (key === undefined) {
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

  return (
    <View>
      <View style={{ height, borderRadius: radius.card, overflow: 'hidden' }}>
        <Map
          style={{ flex: 1 }}
          mapStyle={`${OLA_STYLE}?api_key=${encodeURIComponent(key)}`}
        >
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

      {/* What could NOT be drawn, said in words. A map that silently omits a
          third of the book is a map somebody plans a day from and is wrong. */}
      {missing > 0 ? (
        <Text style={[{ fontSize: 13, lineHeight: 19, marginTop: 8, color: C.muted }]}>
          {missing === 1
            ? 'One shop has no location yet, so it is not on the map.'
            : `${missing} shops have no location yet, so they are not on the map.`}
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
