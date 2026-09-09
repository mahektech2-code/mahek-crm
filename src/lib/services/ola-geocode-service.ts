import "server-only";
import { readSecret } from "@/lib/secrets";

/* ---------------------------------------------------------------------------
 * Ola Maps' geocoder — an address turned into a coordinate.
 *
 * 503 shops on this book carry an address and no pin. They are invisible on
 * the territory map, they cannot be put on a route, and a salesman planning a
 * day never sees them. That is what this is for and it is the whole of what it
 * is for.
 *
 * IT IS NOT AS GOOD AS STANDING IN THE SHOP, and the difference is not
 * marginal. Asked for a real Nagpur address the API answered with the
 * LOCALITY centre — `types: ["locality"]`, `location_type: "geometric_center"`
 * — which is a point somewhere in the neighbourhood and could be several
 * hundred metres from the door. Indian address geocoding outside the metros is
 * like this generally, and the field-captured pin is nearly always the better
 * record.
 *
 * So this NEVER writes `customers.gps_lat`. That column is documented as
 * "where the shop actually is, captured by standing in it", and visit
 * verification reads it before deciding whether a salesman was really
 * somewhere. A geocode landing there would turn a guess into evidence on the
 * one screen where that matters most. It writes `geocoded_lat` instead, beside
 * it, and carries Ola's own precision word so a screen can draw the two
 * differently.
 *
 * ONE REQUEST PER SHOP, once. 503 of a free tier of 100,000, and the result is
 * stored — a shop is geocoded again only if somebody changes its address.
 * ------------------------------------------------------------------------- */

const GEOCODE_URL = "https://api.olamaps.io/places/v1/geocode";
const REQUEST_TIMEOUT_MS = 8_000;

export type Geocode = {
  lat: number;
  lng: number;
  /**
   * Ola's own word for how exact this is, stored rather than interpreted.
   *
   * `rooftop` is the door. `geometric_center` is the middle of something
   * larger — a locality, a road — and is what an ordinary Indian address
   * outside a metro actually returns. Kept verbatim so a screen can say which,
   * and so a later reader can tell a precise answer from a vague one without
   * this file having had to decide in advance which words matter.
   */
  precision: string;
  /** What Ola thinks it found, for a person checking a doubtful pin. */
  formattedAddress: string;
};

type GeocodeResponse = {
  geocodingResults?: {
    formatted_address?: string;
    types?: string[];
    geometry?: {
      location?: { lat?: number; lng?: number };
      location_type?: string;
    };
  }[];
};

/**
 * One address to one coordinate, or null.
 *
 * Null covers every way this fails to help: no key, an empty address, a
 * network error, a non-200, no result, a result with no usable location. The
 * caller's fallback is always the same — the shop keeps no geocoded pin and
 * stays exactly as it was, which is what it has always been.
 *
 * THE FIRST RESULT IS THE ONLY ONE CONSIDERED. Ola returns candidates ranked,
 * and choosing among them would mean this file deciding which of two places
 * with similar names is the shop — which it cannot know and a person can. A
 * second candidate that was nearly as good is exactly the case where a pin
 * should not be invented at all.
 */
export async function geocodeAddress(address: string): Promise<Geocode | null> {
  const query = address.trim().replace(/\s+/g, " ");
  if (query.length < 4) return null;

  const apiKey = await readSecret("olamaps.apiKey");
  if (!apiKey) return null;

  const params = new URLSearchParams({ address: query, api_key: apiKey });

  let body: GeocodeResponse;
  try {
    const response = await fetch(`${GEOCODE_URL}?${params}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    body = (await response.json()) as GeocodeResponse;
  } catch {
    return null;
  }

  const first = body.geocodingResults?.[0];
  const location = first?.geometry?.location;
  if (typeof location?.lat !== "number" || typeof location?.lng !== "number") return null;

  /* A coordinate outside India is not this shop. The geocoder answers for the
     whole world and an address that names no place in it can land anywhere;
     a pin in the Atlantic on a territory map is worse than no pin, because it
     drags every map's bounds out to contain it. */
  if (location.lat < 6 || location.lat > 38 || location.lng < 67 || location.lng > 98) {
    return null;
  }

  return {
    lat: location.lat,
    lng: location.lng,
    precision: first?.geometry?.location_type ?? first?.types?.[0] ?? "unknown",
    formattedAddress: first?.formatted_address ?? "",
  };
}
