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
 *
 * Only LOOSE gives 0 (02 §11). A boxed SKU of one can a box is one box a can:
 * it used to give 0 as well, so its allocation target was 0, the line read
 * "Done" with nothing on the shelf and was verified with no stock leaving the
 * ledger. A boxed SKU with no cans-per-box recorded still gives 0 — that is a
 * gap in the catalogue, and guessing a box size would be worse.
 */
export function boxQuantity(qtyCans: number, cansPerBox: number, loose: boolean): { boxes: number; valid: boolean } {
  if (loose || !(cansPerBox >= 1)) return { boxes: 0, valid: true };
  const boxes = qtyCans / cansPerBox;
  return { boxes, valid: Number.isInteger(boxes) };
}
