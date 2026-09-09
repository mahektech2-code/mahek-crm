/**
 * The arithmetic behind a map that works with no signal.
 *
 * MapLibre will serve a tile from a downloaded pack without being asked to —
 * that part needs no code. What needs code is everything around it: WHICH
 * piece of the earth is worth several hundred megabytes of a salesman's
 * phone, how big that will actually be before he presses the button, and
 * whether the map he is looking at right now is inside something he already
 * has.
 *
 * Pure, like every other engine here. No `@maplibre/maplibre-react-native`,
 * no store, no clock — a bounds and a list of points go in, tiles and areas
 * come out, and every threshold arrives as an argument. `data/offline-maps.ts`
 * is where this is wired to the book and to the native pack store.
 *
 * **A DISTRICT IS NOT THE UNIT, and that is the one decision here worth
 * arguing with.** An administrative boundary was drawn for revenue collection,
 * not for this book: most of one is fields with no shop in it, and a salesman
 * whose beat straddles two of them would need both. What he actually needs is
 * the streets around the shops he calls on — so the areas offered are
 * CLUSTERED FROM HIS OWN BOOK, and named with the office's own word for where
 * they are. The pack is then a padded box round that cluster, which is a
 * smaller download and a better map than any district would be.
 */

import { haversineMetres, type Coords } from './geo';

/**
 * West, south, east, north — the order MapLibre's `LngLatBounds` declares,
 * which is GeoJSON's. It is deliberately the same tuple `ShopMap` already
 * passes to its `Camera`, so a bounds never changes shape between the map and
 * the pack that has to cover it.
 */
export type Bounds = [west: number, south: number, east: number, north: number];

/**
 * Web Mercator stops at ±85.0511°, and a latitude past it produces an infinite
 * tile row rather than an error. No shop in this book is anywhere near it; the
 * clamp is here because a single corrupt coordinate must not turn a size
 * estimate into `Infinity` and a download into one that never ends.
 */
const MERCATOR_LIMIT = 85.05112878;

/** Metres in one degree of latitude. Constant enough for anything here. */
const METRES_PER_DEGREE_LAT = 110_574;

const toRadians = (deg: number): number => (deg * Math.PI) / 180;

const clampLat = (lat: number): number =>
  Math.min(MERCATOR_LIMIT, Math.max(-MERCATOR_LIMIT, lat));

/* ------------------------------------------------------------------ boxes */

/** The smallest box holding every point, or null where there are none. */
export function boundsOf(points: Coords[]): Bounds | null {
  const usable = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (!usable.length) return null;

  let west = 180;
  let south = 90;
  let east = -180;
  let north = -90;
  for (const p of usable) {
    west = Math.min(west, p.lng);
    east = Math.max(east, p.lng);
    south = Math.min(south, p.lat);
    north = Math.max(north, p.lat);
  }
  return [west, south, east, north];
}

/**
 * The box grown by a margin on every side.
 *
 * A pack drawn tight to the shops is a map that ends at the shop's own
 * doorstep — the salesman needs the road he arrives on, the junction he turns
 * at and the lane behind. It is also what makes a pack survive the book
 * changing: a shop added next month a few hundred metres outside the old
 * cluster is still inside the pack that was downloaded for it.
 */
export function padBounds(bounds: Bounds, metres: number): Bounds {
  const [west, south, east, north] = bounds;
  const dLat = metres / METRES_PER_DEGREE_LAT;

  /* Longitude degrees are shorter the further from the equator, and the
     narrowest edge of the box is the one that must clear the margin — so the
     conversion uses whichever of the two latitudes is further from it. */
  const worstLat = Math.max(Math.abs(north), Math.abs(south));
  const metresPerDegreeLng = METRES_PER_DEGREE_LAT * Math.max(0.05, Math.cos(toRadians(worstLat)));
  const dLng = metres / metresPerDegreeLng;

  return [
    Math.max(-180, west - dLng),
    Math.max(-90, south - dLat),
    Math.min(180, east + dLng),
    Math.min(90, north + dLat),
  ];
}

/** Is this point inside the box? Edges count as inside. */
export function boundsContain(bounds: Bounds, point: Coords): boolean {
  const [west, south, east, north] = bounds;
  return (
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lng) &&
    point.lng >= west &&
    point.lng <= east &&
    point.lat >= south &&
    point.lat <= north
  );
}

/**
 * Is the whole of one box inside another?
 *
 * Asked before a saved map is replaced by a bigger one. Containment is the
 * only condition under which "replace" loses nothing, and it is not always
 * true: one wide pack can be the best answer for two areas at once, and
 * re-saving the smaller of them with a tight box would take the other area's
 * streets away as a side effect.
 */
export function boundsWithin(inner: Bounds, outer: Bounds): boolean {
  return (
    inner[0] >= outer[0] &&
    inner[1] >= outer[1] &&
    inner[2] <= outer[2] &&
    inner[3] <= outer[3]
  );
}

/** The middle of a box, for naming it and for opening a map on it. */
export function boundsCentre(bounds: Bounds): Coords {
  const [west, south, east, north] = bounds;
  return { lat: (south + north) / 2, lng: (west + east) / 2 };
}

/** How far across the box is, corner to corner, in metres. */
export function boundsSpanMetres(bounds: Bounds): number {
  const [west, south, east, north] = bounds;
  return haversineMetres({ lat: south, lng: west }, { lat: north, lng: east });
}

/* ------------------------------------------------------------------ tiles */

/** The XYZ tile column a longitude falls in at this zoom. */
export function tileX(lng: number, zoom: number): number {
  return Math.floor(((lng + 180) / 360) * 2 ** zoom);
}

/** The XYZ tile row a latitude falls in at this zoom. */
export function tileY(lat: number, zoom: number): number {
  const phi = toRadians(clampLat(lat));
  return Math.floor(
    ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * 2 ** zoom,
  );
}

/**
 * How many tiles a box needs across every zoom in the range.
 *
 * Four times as many at each step down, which is the whole reason the maximum
 * zoom is the setting that decides whether a pack is 60 MB or 900 MB. Counted
 * rather than approximated from area, because the answer is a count of whole
 * tiles and a box straddling a tile boundary genuinely needs both.
 */
export function tileCount(bounds: Bounds, minZoom: number, maxZoom: number): number {
  const [west, south, east, north] = bounds;
  let total = 0;
  for (let z = Math.max(0, Math.floor(minZoom)); z <= Math.floor(maxZoom); z++) {
    const x1 = tileX(west, z);
    const x2 = tileX(east, z);
    const y1 = tileY(north, z);
    const y2 = tileY(south, z);
    total += (Math.abs(x2 - x1) + 1) * (Math.abs(y2 - y1) + 1);
  }
  return total;
}

/**
 * What that will cost on the phone, in bytes.
 *
 * An ESTIMATE and never presented as anything else — a vector tile over a
 * paint market is several times the size of one over farmland, and the pack
 * carries fonts and a sprite sheet on top. It is worth having anyway: the
 * decision it informs is "is this tens of megabytes or hundreds", and it is
 * right about that. `mbos.maps.bytesPerTileEstimate` is what tunes it once
 * somebody has watched a few real downloads finish.
 */
export function estimateBytes(tiles: number, bytesPerTile: number): number {
  return Math.round(tiles * bytesPerTile);
}

/* --------------------------------------------------------------- clusters */

/** A place worth downloading: the shops that make it, and the box round them. */
export type MapArea = {
  /**
   * Stable for as long as the cluster is in roughly the same place. It is a
   * coarse grid reference rather than a hash of the members, deliberately —
   * adding one shop to a town must not produce a new id and orphan a pack
   * somebody spent 300 MB downloading.
   */
  id: string;
  /** What the office calls it. The area, falling back to the city. */
  label: string;
  bounds: Bounds;
  centre: Coords;
  /** The shops inside it, ids only — the screen has the rest. */
  shopIds: string[];
};

export type AreaPin = Coords & {
  id: string;
  area?: string | null;
  city?: string | null;
};

/**
 * The book, cut into places.
 *
 * SINGLE-LINK ON A GRID rather than a proper clustering. Every pin is dropped
 * into a square cell `separationKm` across and neighbouring occupied cells are
 * joined, so two shops on the same street are always together and two towns an
 * hour apart are never. It is approximate at the seam — two shops in
 * diagonally touching cells are linked at up to about 2.8 times the
 * separation — and that is the right trade: it is one pass over the book
 * rather than the twenty-five million distance calculations a true single-link
 * pass over five thousand shops would be, on a phone, on the screen somebody
 * is waiting on.
 *
 * The grid is squared using ONE latitude for the whole book. Per-point cosine
 * would make the cells uneven and the linkage asymmetric — a pair that joins
 * read north-to-south and does not read south-to-north.
 */
export function clusterAreas(
  pins: AreaPin[],
  opts: { separationKm: number },
): MapArea[] {
  const usable = pins.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (!usable.length) return [];

  const separation = Math.max(0.5, opts.separationKm);
  const meanLat = usable.reduce((a, p) => a + p.lat, 0) / usable.length;
  const cellLat = (separation * 1000) / METRES_PER_DEGREE_LAT;
  const cellLng =
    (separation * 1000) /
    (METRES_PER_DEGREE_LAT * Math.max(0.05, Math.cos(toRadians(meanLat))));

  /* ---- which cell each pin is in, and which cells are occupied ---- */

  const cellOf = new Map<string, AreaPin[]>();
  for (const p of usable) {
    const cx = Math.floor(p.lng / cellLng);
    const cy = Math.floor(p.lat / cellLat);
    const key = `${cx}:${cy}`;
    const held = cellOf.get(key);
    if (held) held.push(p);
    else cellOf.set(key, [p]);
  }

  /* ---- join touching cells ---- */

  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let root = k;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    /* Path compression, so a long chain of cells down a highway stays cheap. */
    let walk = k;
    while (parent.get(walk) !== root) {
      const next = parent.get(walk) ?? root;
      parent.set(walk, root);
      walk = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const key of cellOf.keys()) parent.set(key, key);
  for (const key of cellOf.keys()) {
    const [cx, cy] = key.split(':').map(Number);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const neighbour = `${cx + dx}:${cy + dy}`;
        if (cellOf.has(neighbour)) union(key, neighbour);
      }
    }
  }

  /* ---- gather each component ---- */

  const groups = new Map<string, AreaPin[]>();
  for (const [key, members] of cellOf) {
    const root = find(key);
    const held = groups.get(root);
    if (held) held.push(...members);
    else groups.set(root, [...members]);
  }

  const areas = [...groups.values()]
    .map((members) => {
      const bounds = boundsOf(members) as Bounds;
      const centre = boundsCentre(bounds);
      return {
        /* Rounded to about a kilometre. Fine enough that two towns never
           collide, coarse enough that one new shop does not move it. */
        id: `${centre.lat.toFixed(2)},${centre.lng.toFixed(2)}`,
        ...nameOf(members),
        bounds,
        centre,
        shopIds: members.map((m) => m.id),
      };
    })
    .sort((a, b) => b.shopIds.length - a.shopIds.length || a.label.localeCompare(b.label));

  return disambiguate(areas);
}

/**
 * What to call a cluster.
 *
 * The most common area name among its shops, falling back to the city, because
 * those are the words the office already uses and the salesman already knows.
 * A cluster where nobody filled either in is named for what it is rather than
 * left blank — a row with no label reads as a broken screen.
 */
function nameOf(members: AreaPin[]): { label: string; town: string | null } {
  const commonest = (values: (string | null | undefined)[]): string | null => {
    const counts = new Map<string, number>();
    for (const v of values) {
      const t = (v ?? '').trim();
      if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestN = 0;
    for (const [value, n] of counts) {
      if (n > bestN || (n === bestN && best !== null && value.localeCompare(best) < 0)) {
        best = value;
        bestN = n;
      }
    }
    return best;
  };

  const area = commonest(members.map((m) => m.area));
  const city = commonest(members.map((m) => m.city));

  /* The town is carried alongside for `disambiguate` and is dropped where it
     would only repeat the label. */
  return {
    label: area ?? city ?? 'Unnamed area',
    town: city && city !== area ? city : null,
  };
}

/**
 * Two clusters called "Sadar" are two rows nobody can tell apart, and the one
 * with the wrong 300 MB in it is the one they will pick.
 *
 * The town separates them where there is one — "Sadar · Amravati" is a place
 * somebody recognises. Where there is not, a number does, which is ugly and
 * unambiguous, and ugly is the lesser fault on a screen where picking the
 * wrong row costs a phone's worth of storage. Only a label that actually
 * repeats is touched: qualifying every row would put a town on the one area
 * nobody could have confused.
 */
function disambiguate(areas: (MapArea & { town: string | null })[]): MapArea[] {
  const repeated = new Set<string>();
  const met = new Set<string>();
  for (const a of areas) {
    if (met.has(a.label)) repeated.add(a.label);
    met.add(a.label);
  }

  const used = new Set<string>();
  return areas.map((a) => {
    let label = a.label;
    if (repeated.has(a.label) && a.town) label = `${a.label} · ${a.town}`;
    if (used.has(label)) {
      let n = 2;
      while (used.has(`${label} ${n}`)) n++;
      label = `${label} ${n}`;
    }
    used.add(label);
    return { id: a.id, label, bounds: a.bounds, centre: a.centre, shopIds: a.shopIds };
  });
}

/* -------------------------------------------------------------- coverage */

export type Coverage = {
  /** `full` only when every point asked about is inside something downloaded. */
  state: 'full' | 'partial' | 'none';
  inside: number;
  outside: number;
};

/**
 * Is what is on the screen inside something already on the phone?
 *
 * Counted in SHOPS rather than in area, because that is the sentence worth
 * saying: "9 of these 62 shops are outside the map you saved" is something a
 * salesman can act on, and "83% of the bounding box is covered" is not.
 *
 * Partial is a real and common answer — a book grows, a pack does not — and it
 * is deliberately not rounded up to `full` or down to `none`. Rounding up
 * draws a map with a blank corner and no explanation; rounding down hides a
 * map that would have worked for most of what he needs.
 */
export function coverageOf(points: Coords[], packs: Bounds[]): Coverage {
  const usable = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (!usable.length || !packs.length) {
    return { state: 'none', inside: 0, outside: usable.length };
  }

  let inside = 0;
  for (const p of usable) {
    if (packs.some((b) => boundsContain(b, p))) inside++;
  }
  const outside = usable.length - inside;

  return {
    state: outside === 0 ? 'full' : inside === 0 ? 'none' : 'partial',
    inside,
    outside,
  };
}

/**
 * The pack that best answers for an area, if any has been downloaded.
 *
 * Matched by GEOMETRY and never by a stored id. An id would have to be written
 * into the pack's metadata at download time and would then be wrong the first
 * time the book moved the cluster — the pack would be orphaned, the area would
 * offer to download itself again, and the salesman would be looking at two
 * copies of the same 300 MB with nothing on the screen able to say so.
 */
export function bestPackFor<T extends { bounds: Bounds }>(
  shops: Coords[],
  packs: T[],
): { pack: T; coverage: Coverage } | null {
  let best: { pack: T; coverage: Coverage } | null = null;
  for (const pack of packs) {
    const coverage = coverageOf(shops, [pack.bounds]);
    if (coverage.inside === 0) continue;
    if (!best || coverage.inside > best.coverage.inside) best = { pack, coverage };
  }
  return best;
}
