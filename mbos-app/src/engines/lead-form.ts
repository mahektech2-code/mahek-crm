/**
 * WHAT THE NEW LEAD FORM ASKS AT THE DOOR, and what it keeps behind one tap.
 *
 * The form asked seventeen things in one sheet, and a salesman standing
 * outside a shop with the owner waiting answered the first five and pressed
 * Add — or did not add the lead at all. So the first screen is what the
 * office cannot do without and what he can say at the door: the kind of sale,
 * who, the shop, the mobile, where it is, how he found them and what they want
 * in a sentence. Everything he SAW in the shop — the GST number, the potential,
 * the business type, the litres, the competitor, the photograph — sits under
 * "What you found in the shop", one disclosure.
 *
 * NOTHING THAT IS FILLED MAY BE HIDDEN WITHOUT SAYING SO. A closed section
 * holding three answers reads "3 more answered — show", and a voice or card
 * fill that lands in any of these opens it by itself: the fill asked him to
 * check each value, and a value he cannot see is one he cannot check.
 *
 * Only the layout changed. Every field is still on the form and still sent.
 * PURE, so the rule for when the section opens is testable without a phone.
 */

/** The answers kept behind the disclosure, in the order they are drawn. */
export const SHOP_DETAIL_FIELDS = [
  'gstin',
  'potential',
  'followUp',
  'address',
  'custType',
  'litres',
  'decisionMaker',
  'competitor',
  'shopPhotoId',
] as const;

export type ShopDetailField = (typeof SHOP_DETAIL_FIELDS)[number];

export type ShopDetails = Partial<Record<ShopDetailField, string | null | undefined>>;

function answered(v: string | null | undefined): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

/** How many of the behind-the-tap answers carry something. */
export function answeredDetails(values: ShopDetails): number {
  return SHOP_DETAIL_FIELDS.filter((f) => answered(values[f])).length;
}

/**
 * Whether a voice or card fill put anything behind the disclosure — and so
 * whether the section must open for him to check it.
 */
export function fillTouchesDetails(fill: ShopDetails): boolean {
  return answeredDetails(fill) > 0;
}

/** The line under the closed section's heading. */
export function detailsSummary(count: number): string {
  if (count <= 0) return 'Optional. Tap to add what you saw.';
  return `${count} more answered — show`;
}
