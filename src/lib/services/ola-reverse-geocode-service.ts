import "server-only";
import { olaGet, olaKeysHeld } from "./ola-key-service";
import type { ReverseGeocodeResult } from "@/lib/place-parse";

/* ---------------------------------------------------------------------------
 * Ola Maps' reverse geocoder — a coordinate turned into the tree it sits in.
 *
 * The twin of `ola-geocode-service.ts` beside it and the opposite direction:
 * that one turns an address into a pin for the shops nobody has stood in, and
 * this one turns a pin into a state, a district, a city and an area for the
 * 4,930 shops somebody HAS stood in.
 *
 * WHY THIS IS THE CHEAP DIRECTION. Forward geocoding an Indian address outside
 * a metro is a guess — that file says so in its own header, and the answer it
 * gets back is routinely the centre of a locality. Reverse geocoding is not
 * the same problem: the coordinate is exact and the only question is which
 * administrative polygons contain it, which is a lookup rather than a
 * judgement. So the answer here is worth trusting in a way the forward one is
 * not, and it is why the place master is built from pins and not from the
 * address text the sheet already holds.
 *
 * IT WRITES NOTHING AND DECIDES NOTHING. It returns the raw result; the parse
 * is `place-parse.ts`, pure and tested, and the storage is
 * `customer_place_lookups`, which keeps this answer verbatim so a changed
 * READING never costs a second request. Same three-way split the sheet jobs
 * keep: fetch, store, reparse.
 *
 * IT GOES THROUGH `olaGet`, LIKE EVERY OTHER OLA CALL, and here that matters
 * more than anywhere else in the codebase. `ola-key-service.ts` is the one
 * place a key is chosen and spent: it fails over when Ola refuses one for
 * quota, records the refusal, and tells an administrator the day an account
 * runs out. This job makes 4,930 requests in one sitting, which is far and
 * away the largest single spend MahekOne has ever asked of that pool — going
 * round it with a bare `readSecret` would mean a run that dies half-way with
 * four unused accounts configured, and nothing anywhere recording why.
 * ------------------------------------------------------------------------- */

const REVERSE_URL = "https://api.olamaps.io/places/v1/reverse-geocode";
const REQUEST_TIMEOUT_MS = 8_000;

type ReverseResponse = { results?: ReverseGeocodeResult[] };

/**
 * One coordinate to one raw answer, or null.
 *
 * Null covers every way this fails to help: no key, a coordinate outside
 * India, a network error, a non-200, no result. The caller's fallback is
 * always the same — the shop keeps no resolved place and is counted as
 * unresolved, which is a thing the screens can say.
 *
 * THE FIRST RESULT IS THE ONLY ONE CONSIDERED, the same rule the forward
 * geocoder keeps. Ola returns candidates ranked and they describe the same
 * point at different granularities; choosing among them would mean this file
 * deciding which reading of one coordinate is the shop.
 */
export async function reverseGeocode(
  lat: number,
  lng: number,
): Promise<ReverseGeocodeResult | null> {
  /* A coordinate outside India cannot be one of these shops, and asking about
     it spends a request to be told so. The same bounds the forward geocoder
     rejects an ANSWER on, applied to the question instead — which is the
     cheaper end to apply them at when there are thousands of questions. */
  if (!(lat >= 6 && lat <= 38 && lng >= 67 && lng <= 98)) return null;

  const body = await olaGet<ReverseResponse>(
    (apiKey) =>
      `${REVERSE_URL}?${new URLSearchParams({ latlng: `${lat},${lng}`, api_key: apiKey })}`,
    REQUEST_TIMEOUT_MS,
  );

  return body?.results?.[0] ?? null;
}

/**
 * Whether any key is held at all — so a job can say WHY it did nothing.
 *
 * `olaKeysHeld` and not a read inside the loop, for the reason that function
 * already carries: a deployment with no key would otherwise do 4,930 lookups
 * to make no requests at all, and the run would report "0 answered" as though
 * it had asked.
 */
export async function reverseGeocodeReady(): Promise<boolean> {
  return (await olaKeysHeld()) > 0;
}
