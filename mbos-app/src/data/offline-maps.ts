import {
  OfflineManager,
  TransformRequestManager,
  type OfflinePack,
  type OfflinePackStatus,
} from '@maplibre/maplibre-react-native';

import { all, getKv, setKv } from '../db';
import { getConfig } from './config';
import {
  bestPackFor,
  boundsWithin,
  clusterAreas,
  estimateBytes,
  padBounds,
  tileCount,
  type AreaPin,
  type Bounds,
  type Coverage,
  type MapArea,
} from '../engines/tiles';

/**
 * Maps that keep working when the signal does not.
 *
 * MapLibre serves a tile from a downloaded pack without being asked to, so the
 * hard part of "a map that works offline" is not the drawing — it is deciding
 * what is worth several hundred megabytes of somebody's phone, saying what it
 * will cost before he starts, and being able to tell him afterwards whether
 * where he is standing is inside it. `engines/tiles.ts` is the arithmetic,
 * pure; this is where it meets the book and the native pack store.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE KEY IS NO LONGER IN THE STYLE URL, and that is the whole reason any of
 * this can work.
 *
 * The map used to be asked for as `…/style.json?api_key=XYZ`. Two things
 * followed, and both are fatal to an offline pack:
 *
 *   MapLibre files every downloaded resource under the URL it asked for. With
 *   the key in that URL, the pack is stored under `?api_key=XYZ` — so the day
 *   the office rotates the key, several hundred megabytes on the phone become
 *   unreachable, and nothing on any screen can say why the map went blank. The
 *   transform below is an OkHttp interceptor: it runs AFTER the database has
 *   been consulted, so the pack is stored key-less and found key-less, and a
 *   rotated key costs one request and no tiles.
 *
 *   And a key on the style URL authenticates the style file ALONE. The tile
 *   sources, the glyphs and the sprite sheet are named by that file with URLs
 *   of Ola's own, carrying no key — which is exactly why Ola's own web SDK
 *   signs every request rather than the first one. The web has done this since
 *   Territory's map shipped (`sales/ola-maps.tsx`); the handset never got the
 *   equivalent, so the pack download would have authenticated its style and
 *   been refused every tile in it.
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * Ola Maps' default vector style, WITHOUT a key. The pack and the live map
 * must ask for the same string or the pack answers for nothing, so there is
 * exactly one of these and both read it.
 */
export const MAP_STYLE =
  'https://api.olamaps.io/tiles/vector/v1/styles/default-light-standard/style.json';

/** Stable, so a rotated key updates the transform in place rather than stacking. */
const KEY_TRANSFORM_ID = 'olamaps-api-key';

let appliedKey: string | null = null;

/**
 * The key, applied, and handed back so a screen can tell "not set up yet" from
 * "set up and offline".
 *
 * ONE function rather than a getter and a setter, because every caller that
 * wants to know whether there is a key is a caller about to spend it, and the
 * two that were split — the map screens read the key, the download did not —
 * is exactly the shape of bug this replaces: a pack download signs its style
 * request and is then refused every tile in it, with nothing on either end
 * saying which of the two failed.
 *
 * Idempotent and cheap: the transform manager updates one of the same id in
 * place, so a rotated key replaces rather than stacks. Matched to Ola's host,
 * so the key is never appended to somebody else's URL. Deliberately not named
 * `use…` — it is a process-wide registration, not a hook.
 */
export async function mapKey(): Promise<string | null> {
  const key = await getConfig<string | null>('maps.olaKey', null).catch(() => null);
  if (!key) return null;

  if (appliedKey !== key) {
    TransformRequestManager.addUrlSearchParam({
      id: KEY_TRANSFORM_ID,
      match: 'api\\.olamaps\\.io',
      name: 'api_key',
      value: key,
    });
    appliedKey = key;
  }
  return key;
}

/* ------------------------------------------------------------ the settings */

export type MapSettings = {
  enabled: boolean;
  minZoom: number;
  maxZoom: number;
  separationKm: number;
  paddingMetres: number;
  bytesPerTile: number;
  maxPackBytes: number;
  tileCountLimit: number;
  wifiOnly: boolean;
  refreshAfterDays: number;
};

export async function mapSettings(): Promise<MapSettings> {
  const [
    enabled,
    minZoom,
    maxZoom,
    separationKm,
    paddingMetres,
    bytesPerTile,
    maxPackMegabytes,
    tileCountLimit,
    wifiOnly,
    refreshAfterDays,
  ] = await Promise.all([
    getConfig<boolean>('mbos.maps.offlineEnabled'),
    getConfig<number>('mbos.maps.minZoom'),
    getConfig<number>('mbos.maps.maxZoom'),
    getConfig<number>('mbos.maps.areaSeparationKm'),
    getConfig<number>('mbos.maps.paddingMetres'),
    getConfig<number>('mbos.maps.bytesPerTileEstimate'),
    getConfig<number>('mbos.maps.maxPackMegabytes'),
    getConfig<number>('mbos.maps.tileCountLimit'),
    getConfig<boolean>('mbos.maps.downloadOnWifiOnly'),
    getConfig<number>('mbos.maps.refreshAfterDays'),
  ]);

  return {
    enabled: Boolean(enabled),
    minZoom,
    maxZoom,
    separationKm,
    paddingMetres,
    bytesPerTile,
    maxPackBytes: maxPackMegabytes * 1_000_000,
    tileCountLimit,
    wifiOnly: Boolean(wifiOnly),
    refreshAfterDays,
  };
}

/* -------------------------------------------------------------- the packs */

/** What one saved map is, in the words the screen needs. */
export type SavedMap = {
  id: string;
  label: string;
  bounds: Bounds;
  /** Epoch ms it was started. Null on a pack from a build before this existed. */
  savedAt: number | null;
  status: OfflinePackStatus | null;
};

type PackMetadata = {
  label?: string;
  savedAt?: number;
  shops?: number;
  minZoom?: number;
  maxZoom?: number;
};

/**
 * The native ceiling, which ABORTS a download rather than trimming it.
 *
 * MapLibre ships it at 6,000 tiles — a few square kilometres, inherited from
 * Mapbox's own terms and meaningless against a tile server we pay for
 * ourselves. It has to be raised before the FIRST pack is created, so every
 * entry point that starts or resumes a download goes through here — which is
 * also where the key is applied, for the same reason.
 */
let limitSet = false;
async function ensureReady(settings: MapSettings): Promise<void> {
  /* Nothing that touches the network may skip this: a download signs its
     requests with the same transform the live map does, and there is exactly
     one place that gets set. */
  await mapKey();
  if (limitSet) return;
  OfflineManager.setTileCountLimit(settings.tileCountLimit);
  limitSet = true;
}

/** Everything saved on this phone, newest first. */
export async function savedMaps(): Promise<SavedMap[]> {
  const packs = await OfflineManager.getPacks().catch(() => [] as OfflinePack[]);

  const rows = await Promise.all(
    packs.map(async (pack) => {
      const meta = (pack.metadata ?? {}) as PackMetadata;
      /* A pack whose status cannot be read is still a pack. It is listed with
         no figures rather than dropped — a download that has quietly gone
         wrong is exactly the row somebody needs to be able to delete. */
      const status = await pack.status().catch(() => null);
      return {
        id: pack.id,
        label: meta.label ?? 'Saved map',
        bounds: pack.bounds as Bounds,
        savedAt: typeof meta.savedAt === 'number' ? meta.savedAt : null,
        status,
      };
    }),
  );

  return rows.sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
}

/** Just the boxes, for asking whether somewhere is covered. */
export async function savedBounds(): Promise<Bounds[]> {
  const packs = await OfflineManager.getPacks().catch(() => [] as OfflinePack[]);
  return packs.map((p) => p.bounds as Bounds);
}

/* -------------------------------------------------------------- the areas */

/** A place the salesman works, with what saving it would cost. */
export type OfflineArea = MapArea & {
  shops: number;
  /** The padded box a pack would be created for — never the tight one. */
  packBounds: Bounds;
  tiles: number;
  estimatedBytes: number;
  /** True where the estimate is over the configured ceiling. */
  tooBig: boolean;
  /** The pack already covering some of it, if one has been downloaded. */
  saved: SavedMap | null;
  coverage: Coverage;
};

type BookPin = AreaPin & { lat: number; lng: number };

/** The pinned book. Half of it has no coordinate and cannot be on a map at all. */
async function pinnedBook(): Promise<{ pins: BookPin[]; unpinned: number }> {
  const rows = await all<{ id: string; area: string | null; city: string | null; lat: number; lng: number }>(
    `SELECT id, area, city, gpsLat AS lat, gpsLng AS lng
       FROM customers
      WHERE gpsLat IS NOT NULL AND gpsLng IS NOT NULL`,
  );
  const total = await all<{ n: number }>('SELECT COUNT(*) AS n FROM customers');
  return {
    pins: rows.filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng)),
    unpinned: Math.max(0, (total[0]?.n ?? 0) - rows.length),
  };
}

export type AreaListing = {
  settings: MapSettings;
  areas: OfflineArea[];
  /** Shops with no coordinate, which no map can help with. Said, never hidden. */
  unpinned: number;
  /**
   * Packs that answer for no area in the book any more — a salesman moved to
   * another territory, or the shops behind one were reassigned. They are
   * listed so the storage can be got back; nothing deletes one on its own.
   */
  orphans: SavedMap[];
};

/**
 * Every place worth saving, and what each would cost.
 *
 * The areas come from the book rather than from any list of districts, and the
 * packs are matched to them by GEOMETRY rather than by a stored id — see
 * `bestPackFor` for why an id would orphan a pack the first time somebody
 * added a shop.
 */
export async function listAreas(): Promise<AreaListing> {
  const settings = await mapSettings();
  const [{ pins, unpinned }, saved] = await Promise.all([pinnedBook(), savedMaps()]);

  const clusters = clusterAreas(pins, { separationKm: settings.separationKm });
  const byId = new Map(pins.map((p) => [p.id, p]));
  const claimed = new Set<string>();

  const areas: OfflineArea[] = clusters.map((cluster) => {
    const shops = cluster.shopIds
      .map((id) => byId.get(id))
      .filter((p): p is BookPin => Boolean(p));

    const packBounds = padBounds(cluster.bounds, settings.paddingMetres);
    const tiles = tileCount(packBounds, settings.minZoom, settings.maxZoom);
    const bytes = estimateBytes(tiles, settings.bytesPerTile);

    const match = bestPackFor(shops, saved);
    if (match) claimed.add(match.pack.id);

    return {
      ...cluster,
      shops: cluster.shopIds.length,
      packBounds,
      tiles,
      estimatedBytes: bytes,
      tooBig: bytes > settings.maxPackBytes,
      saved: match?.pack ?? null,
      coverage: match?.coverage ?? { state: 'none', inside: 0, outside: shops.length },
    };
  });

  return {
    settings,
    areas,
    unpinned,
    orphans: saved.filter((p) => !claimed.has(p.id)),
  };
}

/* ----------------------------------------------------------- downloading */

/** Whether a download may start right now, and the sentence if it may not. */
export async function downloadBlockedBecause(settings: MapSettings): Promise<string | null> {
  if (!settings.enabled) {
    return 'The office has switched off saving maps to this phone.';
  }
  /* No key is not a network problem and must not be reported as one. Nothing
     can be downloaded and nobody in the field can fix it — the sentence names
     who can. */
  if (!(await mapKey())) {
    return 'No map is set up yet. The office adds a maps key in the Admin Console, and this starts working on the next sync.';
  }
  if (!settings.wifiOnly) return null;

  const NetInfo = (await import('@react-native-community/netinfo')).default;
  const state = await NetInfo.fetch().catch(() => null);
  /* An unknown connection is treated as Wi-Fi rather than refused. A salesman
     stopped from downloading because the phone would not say what it was on is
     a dead end he cannot get out of; the worst case is a download he can see
     the size of and can cancel. */
  if (state && state.isConnected && state.type !== 'wifi') {
    return 'Map downloads are set to Wi-Fi only, and this phone is on mobile data.';
  }
  if (state && state.isConnected === false) {
    return 'No connection. A map can only be saved while you have one.';
  }
  return null;
}

export type Progress = (status: OfflinePackStatus) => void;

/**
 * Start saving an area.
 *
 * The pack is created against the KEY-LESS style URL, which is the same string
 * `ShopMap` hands its `Map` — see the note at the top of this file. Its
 * metadata carries what the screen needs to name it afterwards and nothing
 * else: the shop ids are deliberately not stored, because a pack is matched to
 * an area by geometry and a list of five thousand ids in a metadata blob would
 * be a second, staler answer to the same question.
 *
 * WHERE THE AREA HAS OUTGROWN A PACK, the old one is replaced rather than
 * added to — and the replacement is deleted AFTER the new pack finishes, never
 * before. Two things make that safe rather than wasteful. The grown area is a
 * superset of the old one, so nothing is lost by dropping it; and MapLibre
 * shares resources between packs and frees a tile only when no pack still
 * wants it, so an overlapping download costs the new tiles and not the old
 * ones again. Deleting first would be the version that loses a salesman his
 * working map for the twenty minutes the new download takes — on the day he is
 * standing in the market it covers.
 *
 * "Superset" is CHECKED rather than assumed. One wide pack can be the best
 * answer for two areas at once, and re-saving the smaller of them draws a box
 * that does not contain the wide one — deleting it there would take the other
 * area's streets away as a side effect of saving this one. Where it is not
 * contained, both are kept and the screen lists the second; storage is the
 * lesser fault.
 */
export async function saveArea(
  area: OfflineArea,
  onProgress: Progress,
  onError: (message: string) => void,
): Promise<string> {
  const settings = await mapSettings();
  await ensureReady(settings);

  const superseded =
    area.saved && boundsWithin(area.saved.bounds, area.packBounds) ? area.saved.id : null;
  let replaced = false;

  const pack = await OfflineManager.createPack(
    {
      mapStyle: MAP_STYLE,
      bounds: area.packBounds,
      minZoom: settings.minZoom,
      maxZoom: settings.maxZoom,
      metadata: {
        label: area.label,
        savedAt: Date.now(),
        shops: area.shops,
        minZoom: settings.minZoom,
        maxZoom: settings.maxZoom,
      } satisfies PackMetadata,
    },
    (_pack, status) => {
      onProgress(status);
      if (superseded && !replaced && (status.state === 'complete' || status.percentage >= 100)) {
        replaced = true;
        void OfflineManager.deletePack(superseded).catch(() => undefined);
      }
    },
    (_pack, error) => onError(error.message),
  );

  return pack.id;
}

/** Follow a download that is already running. Returns the way to stop following. */
export async function watchMap(
  id: string,
  onProgress: Progress,
  onError: (message: string) => void,
): Promise<() => void> {
  await OfflineManager.addListener(
    id,
    (_pack, status) => onProgress(status),
    (_pack, error) => onError(error.message),
  );
  return () => OfflineManager.removeListener(id);
}

/* ------------------------------------------------- packs somebody stopped */

/**
 * THE PACKS THE SALESMAN STOPPED HIMSELF, and why they have to be written down.
 *
 * MapLibre reports a download the process was killed part-way through and one
 * somebody deliberately paused identically: `inactive`, short of 100%. So
 * `resumeUnfinished` could not tell them apart and restarted the second within
 * a second of the pause — and the maps screen re-runs it on every visit, so
 * pressing Pause made the bar stop for about as long as it took to look at it.
 * The only control that abandons a download draws while it is paused, so
 * undoing the pause took that away too: several hundred megabytes of his own
 * data and his own storage, with no reachable way to stop it.
 *
 * It is STORED rather than held in memory because the decision has to outlive
 * the process the same way the download does. A handset reaped on the road and
 * reopened at the office would otherwise read a deliberate stop as an
 * interrupted one and carry on spending.
 *
 * An automatic pause — the Wi-Fi rule walking out of the office onto mobile
 * data — is deliberately NOT recorded here. That one is meant to pick up again
 * the moment there is Wi-Fi, which is exactly what `resumeUnfinished` is for.
 */
const PAUSED_KEY = 'maps.pausedPacks';

async function pausedByHand(): Promise<Set<string>> {
  const raw = await getKv(PAUSED_KEY).catch(() => null);
  if (!raw) return new Set();
  try {
    const ids: unknown = JSON.parse(raw);
    return new Set(
      Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [],
    );
  } catch {
    /* A value that will not parse is one nobody can act on. Read as "nothing
       was paused" rather than thrown: the worst case is a download resuming,
       and refusing to read the store at all would break pausing outright. */
    return new Set();
  }
}

async function rememberPaused(ids: Set<string>): Promise<void> {
  await setKv(PAUSED_KEY, JSON.stringify([...ids])).catch(() => undefined);
}

/**
 * Stop a download.
 *
 * `by` is what separates the salesman's own decision from the Wi-Fi rule's —
 * see the note above. It defaults to his, because a pause with nobody named is
 * a button he pressed.
 */
export async function pauseMap(id: string, by: 'salesman' | 'network' = 'salesman'): Promise<void> {
  const pack = await OfflineManager.getPack(id);
  await pack.pause();
  /* After the pause, never before: a pause that threw is a pack still
     downloading, and marking it stopped would leave it out of every resume. */
  if (by === 'salesman') {
    const ids = await pausedByHand();
    if (!ids.has(id)) {
      ids.add(id);
      await rememberPaused(ids);
    }
  }
}

export async function resumeMap(id: string): Promise<void> {
  const settings = await mapSettings();
  await ensureReady(settings);
  const pack = await OfflineManager.getPack(id);
  await pack.resume();
  await forgetPaused(id);
}

/** Gone from the phone. The storage comes back; nothing else is affected. */
export async function removeMap(id: string): Promise<void> {
  await OfflineManager.deletePack(id);
  await forgetPaused(id);
}

async function forgetPaused(id: string): Promise<void> {
  const ids = await pausedByHand();
  if (!ids.delete(id)) return;
  await rememberPaused(ids);
}

/**
 * Re-check every tile against the server and download only what changed.
 *
 * Far cheaper than saving the area again, which is the whole reason a saved
 * map is marked "worth refreshing" rather than deleted and re-offered.
 */
export async function refreshMap(id: string): Promise<void> {
  const settings = await mapSettings();
  await ensureReady(settings);
  await OfflineManager.invalidatePack(id);
}

/**
 * Pick up downloads the app was killed part-way through.
 *
 * A few hundred megabytes does not finish in one sitting, and MapLibre stops
 * the moment the process goes — so without this a salesman's pack sits at 60%
 * for ever and every visit to the screen shows the same number. It is
 * deliberately NOT automatic at boot: it respects the same Wi-Fi rule a fresh
 * download does, and it runs where somebody has opened the screen and can see
 * it happening rather than in the background on his own data.
 */
export async function resumeUnfinished(): Promise<number> {
  const settings = await mapSettings();
  if (await downloadBlockedBecause(settings)) return 0;

  await ensureReady(settings);
  const packs = await OfflineManager.getPacks().catch(() => [] as OfflinePack[]);
  /* A pack he stopped stays stopped. Without this the screen restarts it the
     moment the listing refreshes — which is what pausing itself triggers. */
  const stopped = await pausedByHand();

  let resumed = 0;
  for (const pack of packs) {
    if (stopped.has(pack.id)) continue;
    const status = await pack.status().catch(() => null);
    if (!status || status.state === 'complete' || status.percentage >= 100) continue;
    await pack.resume().catch(() => undefined);
    resumed++;
  }

  /* Ids of packs that are no longer on the phone — removed, or replaced by a
     wider save — are dropped, so the list cannot grow for ever. Only where the
     pack store actually answered: `getPacks` falls back to an empty list on a
     failure, and reading that as "nothing is saved" would forget every pause
     the salesman had made and start the downloads again. A few dead ids are
     the lesser fault. */
  if (packs.length) {
    const alive = new Set(packs.map((p) => p.id));
    const pruned = new Set([...stopped].filter((id) => alive.has(id)));
    if (pruned.size !== stopped.size) await rememberPaused(pruned);
  }

  return resumed;
}
