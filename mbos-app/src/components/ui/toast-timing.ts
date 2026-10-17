/**
 * HOW LONG A NOTICE STAYS UP, by what it is telling him.
 *
 * Every toast used to leave after three seconds, whatever it said. "Saved" is
 * read in one glance; "Sai Paints is billed to Om Traders, who is not in your
 * list. Ask the office to move the account, or bill the shop direct." is not,
 * and it is exactly the kind of sentence that arrives while somebody is
 * standing at a counter with the shopkeeper talking to them. Three seconds
 * took the refusal away before it had been read, and a refusal half-read is
 * one that gets made again.
 *
 * A confirmation keeps the old three seconds. A warning or an error gets six
 * at the least and about a reading pace beyond that (60 ms a character, which
 * is slow on purpose — this is read on a phone, in a shop, in a second
 * language), and never more than twelve: past that it is no longer a notice,
 * it is furniture over the bottom of the screen. The × still closes any of
 * them sooner.
 */
export type DwellTone = 'success' | 'info' | 'warn' | 'error';

export const DWELL_SHORT_MS = 3_000;
export const DWELL_REFUSAL_MIN_MS = 6_000;
export const DWELL_MAX_MS = 12_000;
const MS_PER_CHAR = 60;

export function toastDwellMs(tone: DwellTone, message: string): number {
  const reading = message.length * MS_PER_CHAR;
  if (tone === 'warn' || tone === 'error') {
    return Math.min(DWELL_MAX_MS, Math.max(DWELL_REFUSAL_MIN_MS, reading));
  }
  /* A long note still gets time to be read; a short one is not held. */
  return Math.min(DWELL_MAX_MS, Math.max(DWELL_SHORT_MS, reading));
}

/**
 * Whether a notice that is drawn AGAIN should buzz again.
 *
 * The toast is drawn by whichever window is on top — a sheet carries its own
 * (see `sheet-stack.ts`) — so a notice raised inside a sheet is redrawn by the
 * screen when the sheet closes over it. That is the same notice, not a second
 * one, and buzzing twice for it says something happened twice.
 */
export function makeFeltOnce(windowMs: number) {
  let last: { message: string; at: number } | null = null;
  return (message: string, now: number): boolean => {
    if (last && last.message === message && now - last.at < windowMs) return false;
    last = { message, at: now };
    return true;
  };
}
