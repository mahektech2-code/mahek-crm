/**
 * WHICH LINE LEADS ON A PRODUCT ROW — the handset's copy of the office's rule.
 *
 * A MIRROR of `productLines` in MahekOne's `src/lib/catalogue.ts`, and
 * `src/lib/product-lines-mirror.test.ts` over there reads both files as text and
 * fails when they stop agreeing. It is copied rather than imported for the
 * reason every other mirrored rule in this app is: this is a separate Expo
 * package and cannot reach into the server's `src/`.
 *
 * Mahek sets a mix target on a FORMULATION — nineteen liquids rather than the
 * three categories above them — and asked the screens to match, so a salesman
 * reads the same word on the row he is adding to an order as on the target he is
 * judged against. It was the other way round: the SKU name led and the
 * formulation was a caption underneath it.
 *
 * WHAT IS NOT CHANGING IS WHAT IS ORDERED. Only a SKU can go on an order line,
 * and two SKUs of one formulation differ only by their pack — so the SKU never
 * leaves the row, it moves to the second line. Leading with the formulation
 * ALONE would collapse two hundred orderable rows onto nineteen labels, in a
 * market lane, on a phone.
 *
 * `detail` is null where a second line would say nothing: no formulation filed
 * at all, which is most of an imported book, and a formulation whose name is
 * already the whole of the product's. A row whose second line repeats its first
 * reads as a fault, and a blank headline over a real name is worse.
 */
export function productLines(row: {
  /** The SKU as it is named and packed. */
  displayName: string;
  /** The formulation. Null on a pre-catalogue row, and on an unmatched one. */
  subtitle: string | null | undefined;
}): { lead: string; detail: string | null } {
  const sku = row.displayName.trim();
  const formulation = (row.subtitle ?? '').trim();

  if (!formulation) return { lead: sku, detail: null };
  /* Case-insensitively, because "nano" filed against "Nano Thinner" is the
     same restatement as "Nano" is, and neither is worth a second line. */
  if (!sku || sku.toLowerCase() === formulation.toLowerCase()) {
    return { lead: formulation, detail: null };
  }
  return { lead: formulation, detail: sku };
}
