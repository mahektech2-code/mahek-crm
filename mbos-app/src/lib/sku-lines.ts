/**
 * A SKU AS A SALESMAN PICKS IT — PURE.
 *
 * The SKU's own name leads: "Nano Thinner - 5 Liter (6 Can/Box)". It is the
 * thing being ordered, the name on the invoice, and the only thing that tells
 * two packs of one liquid apart. The formulation goes on the line under it,
 * and only where it adds something the name does not already say — "M5x4"
 * under a Nano Thinner, "Melody N C" under a Mahek N C Thinner, nothing under
 * "Enamel Thinner 20 Liter" whose name already carries it.
 *
 * `product-lines.ts` beside this is the other way round — the formulation
 * first — and stays that way: it is mirrored from MahekOne for the product-mix
 * screens, where the liquid IS the question. On a screen that puts a product
 * on an order, a sample or a lead, leading with the liquid drew every pack of
 * it under one identical bold title, and the SKU was the small print.
 */
export function skuLines(p: {
  name: string;
  formulation?: string | null;
}): { lead: string; detail: string | null } {
  const lead = p.name.trim();
  const formulation = (p.formulation ?? '').trim();
  if (!formulation) return { lead, detail: null };
  const fold = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return fold(lead).includes(fold(formulation)) ? { lead, detail: null } : { lead, detail: formulation };
}
