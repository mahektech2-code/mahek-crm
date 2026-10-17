import Link from "next/link";
import { redirect } from "next/navigation";
import { getConfig } from "@/lib/config/store";
import { erpContext } from "@/lib/erp/access";
import { copiesOf, LABEL_MM, MAX_COPIES, type LabelKind } from "@/lib/erp/engines/labels";
import { boxLabels, dispatchLabels, purchaseLabel, sfgLabel } from "@/lib/erp/label-data";
import type { PrinterSetup } from "@/lib/erp/engines/tspl";
import { Page } from "../_ui/page-head";
import { LABEL_CSS } from "./label-css";
import { BoxLabelView, DispatchLabelView, PurchaseLabelView, SfgLabelView } from "./labels";
import { LabelPrinter } from "./printer";

/**
 * EVERY LABEL THE ERP PRINTS, drawn from the record rather than typed: the
 * label printer never receives free text.
 *
 *   ?batch=FP40NA     box labels, 50 × 50 mm — every box of a packing batch
 *   ?lot=FG12NA       box labels for the labelled loose units of an FG lot
 *   ?ids=BX-…,BX-…    box labels for a selection
 *   ?sfg=12ASTOL1     the SFG lot's label, 80 × 80 mm (&godown= picks the godown)
 *   ?purchase=<id>    the purchased lot's label, 80 × 80 mm, one per drum
 *   ?order=1256       dispatch labels, 80 × 80 mm — one per box or can on
 *                     every line of the order
 *   &copies=3         how many of an SFG or purchase label
 *
 * The page draws the labels; `LabelPrinter` sends them to the label printer
 * as printer commands, saves those commands as a file, or opens the print
 * dialog. All three print what is drawn here.
 */
export const dynamic = "force-dynamic";

/* Who prints which label: whoever holds the screen its record is listed on. */
const SCREENS: Record<LabelKind, string[]> = {
  box: ["units", "dispatch", "packBatches", "stock", "orders"],
  sfg: ["sfgBatches", "stock"],
  purchase: ["barcode", "register", "stock"],
  dispatch: ["orders", "dispatch"],
};

export default async function ErpLabels({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await erpContext();
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string).trim() : "");
  const batch = one("batch");
  const lot = one("lot");
  const ids = one("ids").split(",").map((x) => x.trim()).filter(Boolean);
  const sfg = one("sfg");
  const purchase = one("purchase");
  const order = /^\d+$/.test(one("order")) ? Number(one("order")) : null;

  const kind: LabelKind = order != null ? "dispatch" : sfg ? "sfg" : purchase ? "purchase" : "box";
  if (!SCREENS[kind].some((s) => ctx.screens.has(s))) redirect("/erp");

  const config = await getConfig();
  const setup: PrinterSetup = {
    dotsPerMm: config["erp.labels.dotsPerMm"],
    gapMm: config["erp.labels.gapMm"],
    shiftMm: config["erp.labels.shiftMm"],
    direction: config["erp.labels.direction"] === 0 ? 0 : 1,
  };
  const mm = LABEL_MM[kind];

  let title = "Labels";
  let empty = "Nothing to print here.";
  let fileName = "labels.prn";
  let unitIds: string[] = [];
  let copiesShown: number | null = null;
  const views: React.ReactNode[] = [];

  if (kind === "dispatch" && order != null) {
    title = `Dispatch labels · order ${order}`;
    empty = "This order has no line to label. A cancelled line gets none.";
    fileName = `dispatch-order-${order}.prn`;
    for (const r of await dispatchLabels(order))
      for (let i = 0; i < r.copies; i++) views.push(<DispatchLabelView key={`${r.lineId}:${i}`} l={r.label} lineId={r.lineId} copy={i + 1} />);
  } else if (kind === "sfg") {
    title = `SFG label · lot ${sfg}`;
    empty = `No SFG lot ${sfg} was found. Open it from Stock → Semi-finished.`;
    fileName = `sfg-${sfg}.prn`;
    const r = await sfgLabel(sfg, one("godown") || null);
    if (r) {
      copiesShown = copiesOf(one("copies"), 1);
      for (let i = 0; i < copiesShown; i++) views.push(<SfgLabelView key={i} l={r.label} qr={r.qr} copy={i + 1} />);
    }
  } else if (kind === "purchase") {
    title = "Purchase label";
    empty = "That purchase was not found. Open it from the Purchase barcode list.";
    const r = await purchaseLabel(purchase);
    if (r) {
      title = `Purchase label · lot ${r.label.lot}`;
      fileName = `purchase-${r.label.lot}.prn`;
      /* A label goes on a drum, so a lot of four drums starts at four. */
      copiesShown = copiesOf(one("copies"), r.label.drums ?? 1);
      for (let i = 0; i < copiesShown; i++) views.push(<PurchaseLabelView key={i} l={r.label} qr={r.qr} copy={i + 1} />);
    }
  } else {
    const rows = batch ? await boxLabels({ batch }) : lot ? await boxLabels({ lot }) : ids.length ? await boxLabels({ ids }) : [];
    title = batch ? `Box labels · batch ${batch}` : lot ? `Loose labels · lot ${lot}` : "Box labels";
    fileName = `box-labels-${batch || lot || "selection"}.prn`;
    unitIds = rows.map((r) => r.label.id);
    for (const r of rows) views.push(<BoxLabelView key={r.label.id} l={r.label} qr={r.qr} />);
  }

  const n = views.length;
  const what = "label";
  const sub = !n
    ? empty
    : kind === "box"
      ? `${n} ${what}${n === 1 ? "" : "s"}, ${mm} × ${mm} mm. Each QR carries the box's own id; scan it in Trace for the lot and the batch.`
      : kind === "dispatch"
        ? `${n} ${what}${n === 1 ? "" : "s"}, ${mm} × ${mm} mm: one for every box or can on the order. The lot size on each is the pieces on the whole order.`
        : `${n} ${what}${n === 1 ? "" : "s"}, ${mm} × ${mm} mm. The QR carries the lot; scan it in Trace.`;

  return (
    <Page
      title={title}
      sub={sub}
      actions={
        <div className="flex flex-wrap items-center justify-end gap-3 no-print">
          {order != null ? <Link href={`/erp/dispatch?order=${order}`}>Dispatch desk</Link> : null}
          {copiesShown != null ? (
            <form method="get" className="flex items-center gap-2 text-meta">
              {sfg ? <input type="hidden" name="sfg" value={sfg} /> : null}
              {one("godown") ? <input type="hidden" name="godown" value={one("godown")} /> : null}
              {purchase ? <input type="hidden" name="purchase" value={purchase} /> : null}
              <label htmlFor="copies">Copies</label>
              <input id="copies" name="copies" type="number" min={1} max={MAX_COPIES} defaultValue={copiesShown} className="h-9 w-[72px] rounded-control border border-line-strong bg-surface px-2 text-sm" />
              <button type="submit" className="h-9 cursor-pointer rounded-control border border-line-strong bg-surface px-3 text-sm hover:bg-canvas">
                Set
              </button>
            </form>
          ) : null}
          {n ? <LabelPrinter ids={unitIds} count={n} what={what} mm={mm} setup={setup} fileName={fileName} /> : null}
        </div>
      }
    >
      <style>{`
        ${LABEL_CSS}
        .label-sheet { display: grid; grid-template-columns: repeat(auto-fill, ${mm}mm); gap: 4mm; }
        /* On screen each label gets an edge so it reads as a label; on paper the die-cut is the edge. */
        .label-sheet .lb { outline: 1px solid #c9ced8; border-radius: 1.5mm; break-inside: avoid; page-break-inside: avoid; }
        @media print {
          /* One label a page, the size of the label, no margin: what a label
             printer loaded with this stock feeds, one at a time. */
          @page { size: ${mm}mm ${mm}mm; margin: 0; }
          body * { visibility: hidden !important; }
          .label-sheet, .label-sheet * { visibility: visible !important; }
          .label-sheet { position: absolute; left: 0; top: 0; display: block; }
          .label-sheet .lb { outline: none; border-radius: 0; break-after: page; page-break-after: always; }
          .label-sheet .lb:last-child { break-after: auto; page-break-after: auto; }
          .no-print { display: none !important; }
        }
      `}</style>
      <div className="label-sheet">{views}</div>
    </Page>
  );
}
