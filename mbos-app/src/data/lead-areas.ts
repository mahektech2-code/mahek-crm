import { all, getKv, setKv } from '../db';
import { NEAR_M, rememberArea, type BookPlace } from '../engines/area-picker';

/**
 * What the lead form's area picker reads off the phone: where his shops are,
 * and which areas he picked last. See `engines/area-picker.ts` for what is
 * done with them.
 */

const RECENT_KEY = 'lead.recentAreas';

/**
 * His shops counted by place — one row per town, area and beat rather than one
 * per shop, so a book of thousands arrives as a few hundred. The cap is a
 * guard, not a slice anybody sees: past it the least-populated places simply
 * count as none, which only moves them down a list he searches anyway.
 */
export async function bookPlaceCounts(): Promise<BookPlace[]> {
  return all<BookPlace>(
    `SELECT city, area, beat, NULL AS lat, NULL AS lng, COUNT(*) AS n FROM customers
      WHERE city IS NOT NULL OR area IS NOT NULL OR beat IS NOT NULL
      GROUP BY city, area, beat
      ORDER BY n DESC
      LIMIT 5000`,
  );
}

/**
 * His pinned shops inside a box around where he stands — the box a little
 * wider than `NEAR_M` in every direction, so the exact distance is the
 * engine's to measure and the database only has to rule out the rest.
 */
export async function bookPlacesNear(fix: { lat: number; lng: number }): Promise<BookPlace[]> {
  const dLat = (NEAR_M * 1.2) / 111_000;
  const dLng = dLat / Math.max(0.2, Math.cos((fix.lat * Math.PI) / 180));
  return all<BookPlace>(
    `SELECT city, area, beat, gpsLat AS lat, gpsLng AS lng FROM customers
      WHERE gpsLat BETWEEN ? AND ? AND gpsLng BETWEEN ? AND ?
      LIMIT 500`,
    [fix.lat - dLat, fix.lat + dLat, fix.lng - dLng, fix.lng + dLng],
  );
}

export async function recentAreaKeys(): Promise<string[]> {
  try {
    const parsed = JSON.parse((await getKv(RECENT_KEY)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

/** Called when a lead is SAVED in an area — a pick he backed out of is not a habit. */
export async function rememberPickedArea(key: string): Promise<void> {
  await setKv(RECENT_KEY, JSON.stringify(rememberArea(await recentAreaKeys(), key)));
}
