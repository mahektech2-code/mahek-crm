import { all } from '../db';
import { getConfig } from './config';
import { isoDate } from '../lib/format';
import { nearby, nextBestVisit, type NearbyInput, type NearbyResult } from '../engines/nearby';
import { whereNow } from '../native/where';

/**
 * §E, §F and §G of the mapping brief — without the map.
 *
 * Everything these three sections actually need is already on the handset: a
 * coordinate per shop, the cycle, the outstanding, the open tasks. The MAP is
 * blocked on a native dependency and a new APK; the ANSWER is not, and it is
 * the answer a salesman standing in a lane wants — "who else is near me, and
 * which one first".
 *
 * All of it offline, which is the point. The moment somebody asks this question
 * is the moment they have one bar.
 */

export type NearbyShop = NearbyResult<NearbyInput & { phone: string | null }>;

export type NearbyAnswer = {
  /** Null where the phone has no fix — the screen says so rather than guessing. */
  from: { lat: number; lng: number } | null;
  reason: string | null;
  radiusMetres: number;
  options: number[];
  shops: NearbyShop[];
  best: NearbyShop | null;
};

/** The radii the office offers, and the default. */
export async function nearbyRadii(): Promise<number[]> {
  const cfg = await getConfig<{ metres: number[] }>('mbos.location.nearbyRadiusOptions');
  const list = cfg?.metres?.filter((m) => m > 0) ?? [];
  return list.length ? list : [1000, 3000, 5000, 10000, 25000];
}

export async function whatIsNearby(radiusMetres?: number): Promise<NearbyAnswer> {
  const [options, perKm, fix] = await Promise.all([
    nearbyRadii(),
    getConfig<number>('mbos.location.nearbyPerKilometreCost'),
    whereNow().catch(() => undefined),
  ]);
  const radius = radiusMetres ?? options[1] ?? options[0] ?? 3000;

  if (fix?.lat == null || fix?.lng == null) {
    /* No fix is a recorded fact, not an empty list. The screen says which of
       the three it is — refused, unavailable, or off — rather than showing
       "nothing nearby", which would read as a book with no shops in it. */
    return {
      from: null,
      reason: fix?.reason ?? 'unavailable',
      radiusMetres: radius,
      options,
      shops: [],
      best: null,
    };
  }

  const rows = await all<{
    id: string;
    name: string;
    phone: string | null;
    gpsLat: number | null;
    gpsLng: number | null;
    outstandingPaise: number;
    lastOrderDate: string | null;
    cycleDays: number | null;
    lastVisitDate: string | null;
    leadStage: string | null;
    openTasks: number;
  }>(
    `SELECT c.id, c.name, c.phone, c.gpsLat, c.gpsLng,
            c.outstandingPaise, c.lastOrderDate, c.cycleDays, c.lastVisitDate,
            l.stage AS leadStage,
            (SELECT COUNT(*) FROM tasks t
              WHERE t.customerId = c.id AND t.status = 'open') AS openTasks
       FROM customers c
       LEFT JOIN leads l ON l.id = c.id AND l.archived = 0
      WHERE c.gpsLat IS NOT NULL AND c.gpsLng IS NOT NULL`,
  );

  const shops = rows.map((r) => ({
    id: r.id,
    name: r.name,
    phone: r.phone,
    coords: r.gpsLat != null && r.gpsLng != null ? { lat: r.gpsLat, lng: r.gpsLng } : null,
    outstandingPaise: r.outstandingPaise ?? 0,
    lastOrderDate: r.lastOrderDate,
    cycleDays: r.cycleDays,
    lastVisitDate: r.lastVisitDate,
    leadStage: r.leadStage,
    hasOpenTask: Number(r.openTasks ?? 0) > 0,
  }));

  const from = { lat: fix.lat, lng: fix.lng };
  const opts = { radiusMetres: radius, today: isoDate(new Date()), perKilometreCost: perKm };

  return {
    from,
    reason: null,
    radiusMetres: radius,
    options,
    shops: nearby(from, shops, opts),
    /* The head of the same list rather than a second sum — see the engine. */
    best: nextBestVisit(from, shops, opts),
  };
}
