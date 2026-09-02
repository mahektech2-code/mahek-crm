/**
 * Distance between two fixes, on a spherical Earth.
 *
 * Enough precision for "is this the same street" — nothing here is surveying
 * a boundary. Shared because two different callers need the same number:
 * `handleVisit` uses it to decide whether a check-in matches a shop's own
 * pin, and the Journey planning screens use it to sequence a route and sum a
 * day's travel from the GPS trail. Two copies of this formula is how they
 * quietly drift.
 */
export function metresBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
