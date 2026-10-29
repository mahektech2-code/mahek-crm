/* ---------------------------------------------------------------------------
 * WHAT A SCAN SOUNDED LIKE is read off what the scan DID, not off each of the
 * dozen places a scan can end. Camera, gun and typed code all go through one
 * door; the screen is looked at before and after, and the difference is the
 * verdict. A new kind of scan that sets a card, a band or a refusal sounds
 * right without anybody remembering to call a beep from it.
 *
 * Pure, so it has tests: factory-app.tsx imports React Native at module scope
 * and nothing in it can be exercised off a phone.
 * ------------------------------------------------------------------------- */

export type Tone = "ok" | "warn" | "bad";

/** The few things on the scan screen a scan can change. */
export type ScanMoment = {
  open: boolean;
  route: string;
  res: { ok: boolean } | null | undefined;
  feed: { tone: "ok" | "warn"; at: number } | null | undefined;
  lorryRes: object | null | undefined;
  half: object | null | undefined;
};

export function scanTone(before: ScanMoment, after: ScanMoment): Tone | null {
  /* A refusal outranks everything: it is the one the loader must not miss. */
  if (after.lorryRes && after.lorryRes !== before.lorryRes) return "bad";
  if (after.res && after.res !== before.res) return after.res.ok ? "ok" : "bad";
  if (after.feed && after.feed.at !== before.feed?.at) return after.feed.tone;
  /* The first half of a box-and-sticker pair went on: counted, waiting for its other half. */
  if (after.half && after.half !== before.half) return "ok";
  /* The scan was taken and moved on — a drum opened, a lorry found, an LR number read. */
  if (before.open && (!after.open || after.route !== before.route)) return "ok";
  return null;
}
