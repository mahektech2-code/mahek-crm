import type { AreaChoice, AreaRule } from './lead-areas';

/**
 * WHAT A SCANNED CARD PUTS IN THE NEW LEAD FORM — pure, so it is tested here
 * rather than on a phone.
 *
 * The office reads the photographs (`/api/mbos/lead-scan`) and sends back what
 * it found; this decides which form field each finding lands in. The one part
 * with any judgement in it is the LOCATION: the form does not take a free town
 * where the salesman has allocated areas — a lead is raised inside his own
 * area — so a scanned town is matched against his areas, and where it matches
 * none it is SAID rather than quietly typed into a box the save will refuse.
 */

export type ScanField = 'company' | 'name' | 'mobile' | 'location' | 'address' | 'gstin';

export const SCAN_FIELD_LABEL: Record<ScanField, string> = {
  company: 'Shop name',
  name: 'Contact person',
  mobile: 'Mobile',
  location: 'Location',
  address: 'Address',
  gstin: 'GST number',
};

/** The order the review lists them in — the order the form asks them. */
export const SCAN_FIELDS: ScanField[] = ['company', 'name', 'mobile', 'location', 'address', 'gstin'];

const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

export type LocationMatch =
  /* One of his areas, and the town it implies where the area does not. */
  | { kind: 'area'; area: AreaChoice; city: string | null }
  /* No areas to pick from: the town goes in the City box as typed. */
  | { kind: 'free'; city: string }
  /* He has areas and this town is in none of them. */
  | { kind: 'outside'; city: string };

/**
 * Which of his areas a scanned town is in. A town-level area matches on the
 * town or the locality; a state-level one (city null) matches on the state,
 * and then the scanned town fills the City box it leaves open.
 */
export function matchLocation(
  rule: AreaRule,
  city: string | null,
  state: string | null,
): LocationMatch | null {
  const town = city?.trim() || null;
  if (rule.kind !== 'pick') return town ? { kind: rule.kind === 'none' ? 'outside' : 'free', city: town } : null;

  const byTown = town
    ? rule.choices.find((a) => same(a.city, town) || same(a.area, town) || same(a.label, town))
    : undefined;
  if (byTown) return { kind: 'area', area: byTown, city: byTown.city ? null : town };

  const byState = rule.choices.find((a) => !a.city && same(a.state ?? a.label, state));
  if (byState && town) return { kind: 'area', area: byState, city: town };

  return town ? { kind: 'outside', city: town } : null;
}

/** "Nagpur, Maharashtra" — what the review shows for a location. */
export function locationLine(city: string | null, state: string | null): string | null {
  const parts = [city?.trim(), state?.trim()].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}
