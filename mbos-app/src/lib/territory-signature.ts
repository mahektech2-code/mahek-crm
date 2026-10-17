/* ---------------------------------------------------------------------------
 * WHICH ALLOCATION SOMEBODY WAS LOOKING AT, as one string — PURE.
 *
 * A salesman accepts his cities and areas on the handset; the office later
 * changes them. The acceptance must stop counting at that moment rather than
 * vouch for places he never saw, so it is stored with this signature and
 * compared against the allocation as it stands now.
 *
 * MIRRORED, BYTE FOR BYTE, in `mbos-app/src/lib/territory-signature.ts`: the
 * handset writes the signature and the office compares it, and the two
 * projects share no module. `territory-signature.test.ts` fails if the two
 * copies differ by a character.
 *
 * Regions are left out: they are a manager's oversight patch, not where a
 * salesman works, and are never shown to him as his areas.
 * ------------------------------------------------------------------------- */

export type SignedArea = { kind: string; value: string; parent?: string | null };

export function areasSignature(areas: readonly SignedArea[]): string {
  const fold = (v: string | null | undefined) => (v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return areas
    .filter((a) => a.kind !== 'region')
    .map((a) => [fold(a.kind), fold(a.parent), fold(a.value)].join('|'))
    .sort()
    .join('\n');
}
