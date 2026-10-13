/*
 * THE LABELS' OWN STYLESHEET, as a string, because it is used twice: the page
 * draws the labels with it, and the label printer is sent a picture of the
 * very same markup under the very same rules. One stylesheet is what makes
 * "what you see is what the printer gets" a fact rather than a hope.
 *
 * Everything is in millimetres and points — a label is a physical thing — and
 * nothing here reaches outside `.lb`, so the rest of the screen cannot lean on
 * a label and a label cannot be moved by the screen.
 *
 * A 3 mm margin on the 50 mm label and 4 mm on the 80 mm ones: a die-cut label
 * drifts a millimetre or two in the printer, and type set to the edge is type
 * that gets cut. Each label's blocks are spread over its height with equal
 * space between them, so a short value and a long one both fill the label.
 */
export const LABEL_CSS = `
.lb { box-sizing: border-box; background: #fff; color: #000; font-family: Arial, Helvetica, sans-serif; font-weight: 400; display: flex; flex-direction: column; justify-content: space-between; overflow: hidden; text-align: left; }
.lb * { box-sizing: border-box; }
.lb-50 { width: 50mm; height: 50mm; padding: 3mm; }
.lb-80 { width: 80mm; height: 80mm; padding: 4mm; }
.lb b { font-weight: 700; }
.lb .qr { display: block; flex: none; }
.lb .mono { font-family: "Courier New", monospace; font-weight: 700; }
.lb .brand { font-weight: 800; letter-spacing: 1.2px; }
.lb .k { font-size: 7pt; line-height: 1; white-space: nowrap; }
/* One line, cut with an ellipsis. The padding and the equal negative margin
   give descenders room inside the clip without moving anything. */
.lb .cut { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0.15em 0; margin: -0.15em 0; }
.lb .clamp2 { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.lb .cell { display: flex; flex-direction: column; gap: 0.9mm; min-width: 0; }
.lb .cell .v { font-weight: 800; font-size: 13pt; line-height: 1; }
.lb .top { display: flex; flex-direction: row; }
.lb .title { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: space-between; align-items: flex-start; }
.lb .title .name { font-weight: 800; line-height: 1.05; }
.lb .tag { background: #000; color: #fff; font-weight: 800; font-size: 8.5pt; line-height: 1; padding: 1.1mm 2mm; white-space: nowrap; }

/* ---- the box label, 50 x 50 ---- */
.lb-box .top { gap: 3mm; }
.lb-box .code { width: 24mm; flex: none; display: flex; flex-direction: column; align-items: center; gap: 0.9mm; }
.lb-box .code .mono { font-size: 5.5pt; line-height: 1; white-space: nowrap; }
.lb-box .head { flex: 1; min-width: 0; height: 24mm; display: flex; flex-direction: column; justify-content: space-between; }
.lb-box .brand { font-size: 7.5pt; line-height: 1; }
.lb-box .size { font-weight: 800; line-height: 0.8; letter-spacing: -0.3px; white-space: nowrap; }
.lb-box .count { display: flex; flex-direction: column; gap: 0.9mm; }
.lb-box .count .n { font-weight: 800; font-size: 22pt; line-height: 0.8; white-space: nowrap; }
.lb-box .count .w { font-weight: 700; font-size: 7pt; line-height: 1; white-space: nowrap; }
.lb-box .name { border-top: 0.45mm solid #000; padding-top: 1.6mm; font-weight: 800; line-height: 1.1; }
.lb-box .name.two { padding-top: 1.3mm; line-height: 1.08; }
.lb-box .foot { display: flex; flex-direction: column; gap: 1.3mm; }
.lb-box .foot .t { font-weight: 800; font-size: 7.5pt; line-height: 1; text-align: right; }
.lb-box .foot .r { display: flex; flex-direction: row; justify-content: space-between; align-items: baseline; gap: 2mm; font-size: 6pt; line-height: 1; white-space: nowrap; }
.lb-box .foot .r .cut { min-width: 0; }

/* ---- the SFG label, 80 x 80 ---- */
.lb-sfg .top { gap: 4mm; }
.lb-sfg .title { height: 24mm; }
.lb-sfg .band { display: flex; flex-direction: column; gap: 1.2mm; border-top: 0.5mm solid #000; border-bottom: 0.5mm solid #000; padding: 2.2mm 0; }
.lb-sfg .lot { font-weight: 800; line-height: 0.8; letter-spacing: 0.4px; white-space: nowrap; }
.lb-sfg .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 4mm; row-gap: 3mm; }
.lb-sfg .foot { display: flex; flex-direction: row; justify-content: space-between; align-items: baseline; gap: 3mm; font-size: 7pt; line-height: 1; white-space: nowrap; }
.lb-sfg .foot .cut { min-width: 0; }

/* ---- the purchase label, 80 x 80 ---- */
.lb-pur .top { gap: 4mm; }
.lb-pur .title { height: 22mm; }
.lb-pur .band { display: flex; flex-direction: row; justify-content: space-between; align-items: flex-end; gap: 3mm; border-top: 0.5mm solid #000; border-bottom: 0.5mm solid #000; padding: 1.9mm 0; }
.lb-pur .band .l { display: flex; flex-direction: column; gap: 1.1mm; min-width: 0; }
.lb-pur .band .r { display: flex; flex-direction: column; gap: 0.9mm; align-items: flex-end; flex: none; }
.lb-pur .band .r .v { font-weight: 800; font-size: 12pt; line-height: 1; white-space: nowrap; }
.lb-pur .lot { font-weight: 800; line-height: 0.8; letter-spacing: 0.4px; white-space: nowrap; }
.lb-pur .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); column-gap: 3mm; row-gap: 2.5mm; }
.lb-pur .grid .cell { gap: 0.8mm; }
.lb-pur .grid .cell .v { font-size: 12pt; white-space: nowrap; }
.lb-pur .ids { display: flex; flex-direction: column; gap: 0.9mm; font-size: 6.5pt; line-height: 1; white-space: nowrap; }
.lb-pur .remark { font-size: 7.5pt; line-height: 1.2; }

/* ---- the dispatch label, 80 x 80 ---- */
.lb-dis .to { display: flex; flex-direction: column; gap: 1.5mm; }
.lb-dis .meta { display: flex; flex-direction: row; justify-content: space-between; align-items: baseline; gap: 3mm; font-size: 7pt; line-height: 1; white-space: nowrap; }
.lb-dis .party { font-weight: 800; line-height: 1.05; }
.lb-dis .area { font-weight: 700; font-size: 12pt; line-height: 1; }
.lb-dis .billed { font-size: 8pt; line-height: 1; }
.lb-dis .goods { display: flex; flex-direction: column; gap: 2.2mm; border-top: 0.5mm solid #000; padding-top: 2.2mm; }
.lb-dis .sku { font-weight: 800; line-height: 1.1; }
.lb-dis .facts { display: flex; flex-direction: row; justify-content: space-between; align-items: flex-end; gap: 3mm; }
.lb-dis .facts .cell .v { white-space: nowrap; }
.lb-dis .facts .cell:last-child { align-items: flex-end; }
.lb-dis .remark { font-size: 7.5pt; line-height: 1.15; }
.lb-dis .carrier { display: flex; flex-direction: column; gap: 0.9mm; border-top: 0.5mm solid #000; padding-top: 2mm; }
.lb-dis .carrier .v { font-weight: 800; line-height: 1.05; }
`;
