import React from 'react';
import { Text, View } from 'react-native';

/**
 * MAPLIBRE, FOR EXPO GO ONLY — swapped in by `metro.config.js` when the
 * bundler is started with `EXPO_GO=1`, and never part of a real build.
 *
 * Expo Go carries only Expo's own native modules. MapLibre's JS asks for its
 * native half with `TurboModuleRegistry.getEnforcing` the moment it is
 * imported, so in Expo Go the Customers tab and More — which import the map
 * modules — throw before they draw. This stands in for the handful of exports
 * MBOS actually uses: the map says it needs the full app, and the offline-pack
 * calls answer "nothing saved".
 */

export type CameraRef = { fitBounds: (...a: unknown[]) => void; flyTo: (...a: unknown[]) => void; setStop: (...a: unknown[]) => void };
export type MapRef = Record<string, never>;
export type LngLatBounds = [number, number, number, number];
export type OfflinePack = { metadata: Record<string, unknown>; bounds: LngLatBounds; status: () => Promise<OfflinePackStatus> };
export type OfflinePackStatus = { name: string; state: string; percentage: number; completedResourceCount: number; completedResourceSize: number; requiredResourceCount: number };

export function Map({ style }: { style?: object; children?: React.ReactNode }) {
  return (
    <View style={[{ flex: 1, minHeight: 160, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EEF0F3' }, style]}>
      <Text style={{ fontSize: 13, color: '#5B6472', textAlign: 'center', paddingHorizontal: 24 }}>
        Maps need the full MBOS app. Expo Go does not include MapLibre.
      </Text>
    </View>
  );
}

const noop = () => {};

export const Camera = React.forwardRef<CameraRef, object>(function Camera(_props, ref) {
  React.useImperativeHandle(ref, () => ({ fitBounds: noop, flyTo: noop, setStop: noop }));
  return null;
});

export function Marker() {
  return null;
}

export const OfflineManager = {
  addListener: noop,
  removeListener: noop,
  setTileCountLimit: noop,
  getPacks: async (): Promise<OfflinePack[]> => [],
  getPack: async (): Promise<OfflinePack | undefined> => undefined,
  createPack: async () => {
    throw new Error('Offline maps need the full MBOS app.');
  },
  deletePack: async () => {},
  invalidatePack: async () => {},
};

export const TransformRequestManager = {
  addUrlSearchParam: noop,
};
