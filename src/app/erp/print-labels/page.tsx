import Link from "next/link";
import { redirect } from "next/navigation";
import QRCode from "qrcode";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { erpContext } from "@/lib/erp/access";
import { packLabel } from "@/lib/erp/engines/trace";
import { Page } from "../_ui/page-head";
import { PrintButton } from "./print-button";

/**
 * LABELS AND DISPATCH STICKERS, drawn from the record rather than typed: the
 * label machine never receives free text. A product label carries the box's
 * own id in its QR and, in words, only what a picker reads at arm's length —
 * the pack size, the product and how many cans are inside. The lot and the
 * batch are not printed: they are linked to the box id, and Trace answers with
 * them from a scan. A dispatch sticker carries the customer, the order and the
 * same box id, so the scan at the lorry reads one code whichever sticker it
 * hits.
 *
 *   ?batch=FP40NA   every box of a packing batch
 *   ?lot=FG12NA     every labelled loose unit of an FG lot still on the shelf
 *   ?ids=BX-…,BX-…  a selection
 *   ?order=1256     dispatch stickers for an order's scanned boxes
 */
export const dynamic = "force-dynamic";

type U = {
  id: string;
  kind: string;
  sku: string;
  product: string | null;
  litres: number | null;
  cpb: number;
  cans: number;
  lotFrom: string;
  lotCode: string;
  seq: number;
  godown: string;
  status: string;
  orderNo: number | null;
  customer: string | null;
  area: string | null;
  transporter: string | null;
  bill: string | null;
  printed: boolean;
};

const LABEL_SCREENS = ["units", "dispatch", "packBatches", "stock", "orders"];

/**
 * The pack size is the largest thing on a box label, and it is anything from
 * "1 L" to "500 ml": the type steps down with the length of the words so the
 * longest still fits beside the QR and the shortest fills the space.
 */
function sizePt(label: string): number {
  if (label.length <= 3) return 36;
  if (label.length === 4) return 29;
  if (label.length === 5) return 24;
  return 20;
}

async function unitsFor(where: ReturnType<typeof sql>): Promise<U[]> {
  return (await db.execute(sql`
    select u.id, u.kind, p.name as sku, b.name as product, coalesce(p.millilitres_per_can, fg.millilitres)::float8 / 1000 as litres,
           p.cans_per_box as cpb, u.cans, u.lot_from as "lotFrom", u.lot_code as "lotCode", u.seq, g.name as godown, u.status,
           o.order_no as "orderNo", coalesce(dc.name, bc.name) as customer, coalesce(dc.area, dc.city, bc.area, bc.city) as area,
           o.transporter, o.tally_bill_no as bill, u.label_printed_at is not null as printed
      from erp_units u
      join products p on p.id = u.sku_id
      left join finished_goods fg on fg.id = p.finished_good_id
      left join product_brands b on b.id = fg.brand_id
      join erp_godowns g on g.id = u.godown_id
      left join erp_orders o on o.id = u.order_id
      left join customers bc on bc.id = o.billing_customer_id
      left join customers dc on dc.id = o.delivery_customer_id
     where ${where}
     order by u.lot_code, u.seq
     limit 2000
  `)) as unknown as U[];
}

export default async function ErpLabels({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await erpContext();
  if (!LABEL_SCREENS.some((s) => ctx.screens.has(s))) redirect("/erp");
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string).trim() : "");
  const batch = one("batch");
  const lot = one("lot");
  const ids = one("ids").split(",").map((x) => x.trim()).filter(Boolean);
  const order = /^\d+$/.test(one("order")) ? Number(one("order")) : null;

  const mode: "label" | "sticker" = order != null ? "sticker" : "label";
  const units = batch
    ? await unitsFor(sql`u.lot_from = 'pack' and u.lot_code = ${batch} and u.status <> 'cancelled'`)
    : lot
      ? await unitsFor(sql`u.lot_from = 'fg' and u.lot_code = ${lot} and u.status in ('available', 'hold')`)
      : ids.length
        ? await unitsFor(sql`u.id in ${ids}`)
        : order != null
          ? await unitsFor(sql`o.order_no = ${order} and u.status in ('scanned', 'dispatched')`)
          : [];

  /* When each packing batch was packed — the first line of the batch, as it always was. */
  const batches = [...new Set(units.filter((u) => u.lotFrom === "pack").map((u) => u.lotCode))];
  const packLines = batches.length
    ? ((await db.execute(sql`select batch_no as batch, pack_date::text as date from erp_pack_lines where batch_no in ${batches} order by created_at`)) as unknown as { batch: string; date: string }[])
    : [];
  const packedOn = (u: U) => packLines.find((l) => l.batch === u.lotCode)?.date ?? null;

  const qrs = new Map<string, string>();
  for (const u of units) qrs.set(u.id, await QRCode.toString(u.id, { type: "svg", margin: 0, errorCorrectionLevel: "M" }));

  const title = mode === "sticker" ? `Dispatch stickers · order ${order}` : batch ? `Box labels · batch ${batch}` : lot ? `Loose labels · lot ${lot}` : "Labels";
  const what = mode === "sticker" ? "sticker" : "label";

  return (
    <Page
      title={title}
      sub={
        units.length
          ? `${units.length} ${what}${units.length === 1 ? "" : "s"}. Each QR carries the box's own id; scan it in Trace for the lot and the batch.`
          : mode === "sticker"
            ? "No box is scanned onto this order yet. Scan them at the Dispatch desk; a sticker is printed per scanned box."
            : "Nothing to print here."
      }
      actions={
        <div className="flex items-center gap-3 no-print">
          {order != null ? <Link href={`/erp/dispatch?order=${order}`}>Dispatch desk</Link> : null}
          {units.length ? <PrintButton ids={mode === "label" ? units.map((u) => u.id) : []} label={`Print ${units.length} ${what}${units.length === 1 ? "" : "s"}`} /> : null}
        </div>
      }
    >
      <style>{`
        .label-sheet { display: grid; grid-template-columns: repeat(auto-fill, 100mm); gap: 4mm; }
        .label-sheet.square { grid-template-columns: repeat(auto-fill, 50mm); gap: 3mm; }

        /* The dispatch sticker: 100 x 62 mm, unchanged. */
        .label { width: 100mm; height: 62mm; box-sizing: border-box; border: 1px solid #c9ced8; border-radius: 2mm; padding: 3mm 4mm; background: #fff; color: #111; display: flex; gap: 3mm; break-inside: avoid; page-break-inside: avoid; }
        .label .qr { width: 30mm; flex: none; display: flex; flex-direction: column; align-items: center; gap: 1mm; }
        .label .qr svg { width: 30mm; height: 30mm; }
        .label .body { min-width: 0; flex: 1; display: flex; flex-direction: column; font-family: Arial, Helvetica, sans-serif; line-height: 1.15; }
        .label .k { font-size: 6.5pt; color: #555; text-transform: uppercase; margin-top: 1mm; }
        .label .v { font-size: 9pt; font-family: "Courier New", monospace; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .label .id { font-family: "Courier New", monospace; font-size: 8pt; font-weight: 700; text-align: center; }
        .label .cust { font-weight: 800; font-size: 12pt; }

        /*
         * THE BOX LABEL: 50 x 50 mm.
         *
         * Four things, each said once and each large enough to read from
         * across a godown: the pack size, the product, how many cans are in
         * the box, and the QR. The lot and batch lines are gone — they are a
         * scan away in Trace, and at this size they were what crowded out
         * everything a picker reads.
         *
         * A 3 mm margin all round, because a die-cut label drifts a millimetre
         * or two in the printer and type set to the edge is type that gets cut.
         * The four blocks are spread over the height with equal space between
         * them — never less than about 2 mm — so a one-line product name and a
         * two-line one both fill the label. The QR is 17 mm — a box id is a
         * 21-module code at error level M, so about 0.8 mm a module, which is
         * what the old 20 mm code was drawn for and comfortably scannable.
         */
        .sq { width: 50mm; height: 50mm; box-sizing: border-box; border: 1px solid #c9ced8; border-radius: 1.5mm; padding: 3mm; background: #fff; color: #000; display: flex; flex-direction: column; justify-content: space-between; font-family: Arial, Helvetica, sans-serif; overflow: hidden; break-inside: avoid; page-break-inside: avoid; }
        .sq .top { display: flex; gap: 3mm; }
        .sq .qr { width: 17mm; flex: none; display: flex; flex-direction: column; align-items: center; gap: 0.9mm; }
        .sq .qr svg { width: 17mm; height: 17mm; display: block; }
        .sq .id { font-family: "Courier New", monospace; font-size: 5pt; line-height: 1; font-weight: 700; white-space: nowrap; }
        .sq .head { min-width: 0; flex: 1; height: 17mm; display: flex; flex-direction: column; justify-content: space-between; }
        .sq .brand { font-weight: 800; letter-spacing: 1.2px; font-size: 7.5pt; line-height: 1; }
        .sq .size { font-weight: 800; line-height: 0.74; white-space: nowrap; letter-spacing: -0.3px; }
        .sq .product { font-weight: 800; font-size: 11pt; line-height: 1.12; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .sq .pack { border-top: 0.45mm solid #000; padding-top: 1.6mm; font-weight: 700; font-size: 11pt; line-height: 1; white-space: nowrap; display: flex; align-items: baseline; gap: 1.3mm; }
        .sq .pack b { font-weight: 800; font-size: 18pt; line-height: 0.8; }
        .sq .foot { font-size: 5.5pt; line-height: 1; color: #000; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

        @media print {
          body * { visibility: hidden !important; }
          .label-sheet, .label-sheet * { visibility: visible !important; }
          .label-sheet { position: absolute; left: 0; top: 0; }
          .label { border-color: #999; }
          .no-print { display: none !important; }
        }
        ${
          mode === "sticker"
            ? `@media print { @page { margin: 6mm; } }`
            : /* One label per 50 x 50 page, no margin — what a label printer
                 loaded with 50 x 50 stock feeds, one label at a time. The
                 border is dropped on paper: the die-cut is the edge. */
              `@media print {
                 @page { size: 50mm 50mm; margin: 0; }
                 .label-sheet.square { display: block; }
                 .sq { border: none; border-radius: 0; break-after: page; page-break-after: always; }
                 .sq:last-child { break-after: auto; page-break-after: auto; }
               }`
        }
      `}</style>
      <div className={mode === "sticker" ? "label-sheet" : "label-sheet square"}>
        {units.map((u) =>
          mode === "sticker" ? (
            <div key={u.id} className="label">
              <div className="body">
                <span className="k">Customer</span>
                <span className="cust">{u.customer ?? "—"}</span>
                {u.area ? <span style={{ fontSize: "9pt" }}>{u.area}</span> : null}
                <span className="k">Order{u.bill ? " · bill" : ""}</span>
                <span className="v">
                  {u.orderNo}
                  {u.bill ? ` · ${u.bill}` : ""}
                </span>
                <span className="k">Product</span>
                <span className="v" style={{ fontFamily: "Arial", whiteSpace: "normal" }}>
                  {u.product ?? u.sku} · {packLabel(u.litres)} · {u.cans} {u.cans === 1 ? "unit" : "cans"}
                </span>
                {u.transporter ? (
                  <>
                    <span className="k">Transporter</span>
                    <span className="v" style={{ fontFamily: "Arial" }}>
                      {u.transporter}
                    </span>
                  </>
                ) : null}
              </div>
              <div className="qr">
                <span dangerouslySetInnerHTML={{ __html: qrs.get(u.id) ?? "" }} />
                <span className="id">{u.id}</span>
              </div>
            </div>
          ) : (
            <div key={u.id} className="sq">
              <div className="top">
                <div className="qr">
                  <span dangerouslySetInnerHTML={{ __html: qrs.get(u.id) ?? "" }} />
                  <span className="id">{u.id}</span>
                </div>
                <div className="head">
                  <span className="brand">MAHEK</span>
                  <span className="size" style={{ fontSize: `${sizePt(packLabel(u.litres))}pt` }}>
                    {packLabel(u.litres)}
                  </span>
                </div>
              </div>
              <span className="product">{u.product ?? u.sku}</span>
              <span className="pack">
                {u.kind === "box" ? (
                  <>
                    <b>{u.cans}</b> cans per box
                  </>
                ) : (
                  "Loose unit"
                )}
              </span>
              {packedOn(u) ? (
                <span className="foot">
                  Packed {packedOn(u)} · {u.godown}
                </span>
              ) : null}
            </div>
          ),
        )}
      </div>
    </Page>
  );
}
