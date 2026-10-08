import Link from "next/link";
import { redirect } from "next/navigation";
import QRCode from "qrcode";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { erpContext } from "@/lib/erp/access";
import { boxLots, packLabel } from "@/lib/erp/engines/trace";
import { Page } from "../_ui/page-head";
import { PrintButton } from "./print-button";

/**
 * LABELS AND DISPATCH STICKERS, drawn from the record rather than typed: the
 * label machine never receives free text. A product label carries the box's
 * own id in its QR and the lot it came from as linked data printed beside it;
 * a dispatch sticker carries the customer, the order and the same box id, so
 * the scan at the lorry reads one code whichever sticker it hits.
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

  /* Which refill (FG) lots each box's cans came from: boxes fill in the order the batch drew its cans. */
  const batches = [...new Set(units.filter((u) => u.lotFrom === "pack").map((u) => u.lotCode))];
  const packLines = batches.length
    ? ((await db.execute(sql`select batch_no as batch, fg_lot_code as lot, cans, pack_date::text as date from erp_pack_lines where batch_no in ${batches} order by created_at`)) as unknown as { batch: string; lot: string; cans: number; date: string }[])
    : [];
  const refillOf = (u: U) =>
    u.lotFrom === "fg"
      ? [u.lotCode]
      : boxLots(
          Number(u.seq),
          Number(u.cpb) || Number(u.cans),
          packLines.filter((l) => l.batch === u.lotCode).map((l) => ({ lot: l.lot, cans: Number(l.cans) })),
        ).map((x) => x.lot);
  const refillLots = [...new Set(units.flatMap((u) => refillOf(u)))];
  const sfgOf = new Map(
    refillLots.length
      ? ((await db.execute(sql`select lot_code as lot, sfg_lot_code as sfg from erp_fg_fills where lot_code in ${refillLots}`)) as unknown as { lot: string; sfg: string }[]).map((r) => [r.lot, r.sfg])
      : [],
  );
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
          ? `${units.length} ${what}${units.length === 1 ? "" : "s"}. Each QR carries the box's own id; the lot is printed beside it and linked in the ERP.`
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
        .label { width: 100mm; height: 62mm; box-sizing: border-box; border: 1px solid #c9ced8; border-radius: 2mm; padding: 3mm 4mm; background: #fff; color: #111; display: flex; gap: 3mm; break-inside: avoid; page-break-inside: avoid; }
        .label .qr { width: 30mm; flex: none; display: flex; flex-direction: column; align-items: center; gap: 1mm; }
        .label .qr svg { width: 30mm; height: 30mm; }
        .label .body { min-width: 0; flex: 1; display: flex; flex-direction: column; font-family: Arial, Helvetica, sans-serif; line-height: 1.15; }
        .label .brand { font-weight: 800; letter-spacing: 1px; font-size: 10pt; }
        .label .product { font-weight: 700; font-size: 13pt; margin-top: 0.5mm; }
        .label .size { font-weight: 800; font-size: 20pt; }
        .label .k { font-size: 6.5pt; color: #555; text-transform: uppercase; margin-top: 1mm; }
        .label .v { font-size: 9pt; font-family: "Courier New", monospace; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .label .id { font-family: "Courier New", monospace; font-size: 8pt; font-weight: 700; text-align: center; }
        .label .cust { font-weight: 800; font-size: 12pt; }
        @media print {
          @page { margin: 6mm; }
          body * { visibility: hidden !important; }
          .label-sheet, .label-sheet * { visibility: visible !important; }
          .label-sheet { position: absolute; left: 0; top: 0; }
          .label { border-color: #999; }
          .no-print { display: none !important; }
        }
      `}</style>
      <div className="label-sheet">
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
            <div key={u.id} className="label">
              <div className="qr">
                <span dangerouslySetInnerHTML={{ __html: qrs.get(u.id) ?? "" }} />
                <span className="id">{u.id}</span>
              </div>
              <div className="body">
                <span className="brand">MAHEK</span>
                <span className="product">{u.product ?? u.sku}</span>
                <span className="size">{packLabel(u.litres)}</span>
                <span style={{ fontSize: "8pt" }}>
                  {u.kind === "box" ? `${u.cans} cans per box` : "Loose"} · {u.sku}
                </span>
                <span className="k">Lot no</span>
                <span className="v">{refillOf(u).join(" / ")}</span>
                <span className="k">{u.kind === "box" ? "Batch · box" : "FG lot · unit"}</span>
                <span className="v">
                  {u.lotCode} · {u.seq}
                  {refillOf(u).length === 1 && sfgOf.get(refillOf(u)[0]) ? ` · SFG ${sfgOf.get(refillOf(u)[0])}` : ""}
                </span>
                {packedOn(u) ? <span style={{ fontSize: "7pt", marginTop: "auto" }}>Packed {packedOn(u)} · {u.godown}</span> : null}
              </div>
            </div>
          ),
        )}
      </div>
    </Page>
  );
}
