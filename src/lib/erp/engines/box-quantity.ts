/*
 * IN A FILE OF ITS OWN BECAUSE A BROWSER NEEDS IT.
 *
 * The order form's box count (`calcs/sales.ts`) runs in the browser. It used to
 * import this from `./sales`, which imports `./logistics` — 29 KB of LR, party
 * and transporter matching — so every screen drawn with the ERP's form kit
 * (all of the ERP, and HRMS, which uses the same kit) shipped the logistics
 * engine to draw one division. `./sales` re-exports it, so the server side is
 * unchanged.
 */

/**
 * Boxes on a line: a loose SKU is 0, otherwise cans ÷ cans per box — which
 * must come out whole ("INVALID" otherwise).
 */
export function boxQuantity(qtyCans: number, cansPerBox: number, loose: boolean): { boxes: number; valid: boolean } {
  if (loose || cansPerBox <= 1) return { boxes: 0, valid: true };
  const boxes = qtyCans / cansPerBox;
  return { boxes, valid: Number.isInteger(boxes) };
}
