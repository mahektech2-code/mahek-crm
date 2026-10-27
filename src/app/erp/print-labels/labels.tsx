import {
  boxFoot,
  boxNameFit,
  labelDate,
  labelNumber,
  orderQty,
  packSizePt,
  partyPt,
  purchaseLotPt,
  purchaseNamePt,
  sfgLotPt,
  sfgNamePt,
  skuPt,
  transporterPt,
  type BoxLabel,
  type DispatchLabel,
  type PurchaseLabel,
  type Qr,
  type SfgLabel,
} from "@/lib/erp/engines/labels";

/*
 * THE FOUR LABELS, drawn. No state and no effects: a label is a function of
 * the record it was read from, so the server draws it and the same markup is
 * what the print dialog prints and what the label printer is sent a picture
 * of. `data-key` says which labels are the same label, so three of one are
 * sent to the printer as one picture, three times.
 */

const pt = (n: number) => ({ fontSize: `${n}pt` });

/**
 * A QR code as an SVG, one stroke per run of dark modules. It also carries its
 * modules as data: on screen and paper the SVG is the code, and for the label
 * printer the code is redrawn from the modules on the printer's own dot grid.
 */
function QrCode({ qr, mm, label }: { qr: Qr; mm: number; label: string }) {
  let d = "";
  for (let y = 0; y < qr.n; y++) {
    let x = 0;
    while (x < qr.n) {
      if (qr.bits[y * qr.n + x] !== "1") {
        x += 1;
        continue;
      }
      const from = x;
      while (x < qr.n && qr.bits[y * qr.n + x] === "1") x += 1;
      d += `M${from} ${y + 0.5}h${x - from}`;
    }
  }
  return (
    <svg className="qr" data-qr={`${qr.n}:${qr.bits}`} viewBox={`0 0 ${qr.n} ${qr.n}`} shapeRendering="crispEdges" role="img" aria-label={label} style={{ width: `${mm}mm`, height: `${mm}mm` }}>
      <path stroke="#000" d={d} />
    </svg>
  );
}

function Cell({ k, v }: { k: string; v: string }) {
  return (
    <div className="cell">
      <div className="k">{k}</div>
      <div className="v cut">{v}</div>
    </div>
  );
}

/**
 * THE BOX LABEL, 50 × 50 mm. What a picker reads at arm's length is large: the
 * pack size, how many cans are inside, and the product. The QR carries the
 * box's own id and is as big as the label allows — 24 mm, more than a
 * millimetre a module. The lot is not printed: it is a scan away in Trace.
 */
export function BoxLabelView({ l, qr }: { l: BoxLabel; qr: Qr }) {
  const name = boxNameFit(l.name);
  const foot = boxFoot(l);
  return (
    <div className="lb lb-50 lb-box" data-key={l.id}>
      <div className="top">
        <div className="code">
          <QrCode qr={qr} mm={24} label={`QR code for ${l.id}`} />
          <div className="mono">{l.id}</div>
        </div>
        <div className="head">
          <div className="brand">MAHEK</div>
          <div className="size" style={pt(packSizePt(l.size))}>
            {l.size}
          </div>
          <div className="count">
            {l.cans != null ? (
              <>
                <div className="n">{l.cans}</div>
                <div className="w">cans per box</div>
              </>
            ) : (
              <div className="w">Loose unit</div>
            )}
          </div>
        </div>
      </div>
      <div className={name.lines === 2 ? "name two" : "name"} style={pt(name.pt)}>
        <div className={name.lines === 2 ? "clamp2" : "cut"}>{l.name}</div>
      </div>
      <div className="foot">
        {l.date ? <div className="t">Packing Date</div> : null}
        <div className="r" style={pt(foot.pt)}>
          <div className="cut">
            {l.lotWord} <b>{l.lot}</b> · <b>{foot.position}</b>
          </div>
          {l.date ? <div>{labelDate(l.date)}</div> : null}
        </div>
      </div>
    </div>
  );
}

/** THE SFG LABEL, 80 × 80 mm: the lot code is the thing, so it runs the width of the label and is what the QR carries. */
export function SfgLabelView({ l, qr, copy }: { l: SfgLabel; qr: Qr; copy?: number }) {
  return (
    <div className="lb lb-80 lb-sfg" data-key={`sfg:${l.lot}`} data-copy={copy}>
      <div className="top">
        <div className="title">
          <div className="tag">{l.type}</div>
          <div className="name clamp2" style={pt(sfgNamePt(l.product))}>
            {l.product}
          </div>
        </div>
        <QrCode qr={qr} mm={24} label={`QR code for SFG lot ${l.lot}`} />
      </div>
      <div className="band">
        <div className="k">Lot code</div>
        <div className="lot" style={pt(sfgLotPt(l.lot))}>
          {l.lot}
        </div>
      </div>
      <div className="grid">
        <Cell k="No. of batches" v={labelNumber(l.batches)} />
        <Cell k="Batch size" v={l.batchSizeLitres == null ? "—" : `${labelNumber(l.batchSizeLitres)} L`} />
        <Cell k="Date" v={labelDate(l.date)} />
        <Cell k="Location" v={l.location} />
      </div>
      <div className="foot">
        <div className="cut">
          Inventory ID <span className="mono">{l.inventoryId}</span>
        </div>
        <div className="brand">MAHEK</div>
      </div>
    </div>
  );
}

/** THE PURCHASE LABEL, 80 × 80 mm, for the drum a raw material arrived in. The QR carries the lot number. */
export function PurchaseLabelView({ l, qr, copy }: { l: PurchaseLabel; qr: Qr; copy?: number }) {
  return (
    <div className="lb lb-80 lb-pur" data-key={`purchase:${l.lot}`} data-copy={copy}>
      <div className="top">
        <div className="title">
          <div className="tag">Raw material</div>
          <div className="name clamp2" style={pt(purchaseNamePt(l.item))}>
            {l.item}
          </div>
        </div>
        <QrCode qr={qr} mm={22} label={`QR code for purchase lot ${l.lot}`} />
      </div>
      <div className="band">
        <div className="l">
          <div className="k">Lot</div>
          <div className="lot" style={pt(purchaseLotPt(l.lot))}>
            {l.lot}
          </div>
        </div>
        <div className="r">
          <div className="k">Purchase date</div>
          <div className="v">{labelDate(l.date)}</div>
        </div>
      </div>
      <div className="grid">
        <Cell k="Quantity" v={`${labelNumber(l.quantity)} ${l.unit}`} />
        <Cell k="In litre" v={`${labelNumber(l.inLitre)} L`} />
        <Cell k="Density" v={labelNumber(l.density)} />
        <Cell k="Drums" v={labelNumber(l.drums)} />
        <Cell k="Litres per drum" v={labelNumber(l.litresPerDrum)} />
        <Cell k="PR number" v={String(l.prNumber)} />
      </div>
      <div className="ids">
        <div>
          PR bill no <span className="mono">{l.prBillNo}</span>
        </div>
        <div>
          Testing ID <span className="mono">{l.testingId ?? "—"}</span>
        </div>
      </div>
      {l.remark ? (
        <div className="remark clamp2">
          <b>Remark:</b> {l.remark}
        </div>
      ) : null}
    </div>
  );
}

/**
 * THE DISPATCH LABEL, 80 × 80 mm: who it goes to, what it is, and who carries
 * it — each read from across a loading bay. One is printed for every box or
 * can on the line, and every one of them carries the lot size: the pieces on
 * the whole order.
 */
export function DispatchLabelView({ l, lineId, copy }: { l: DispatchLabel; lineId: string; copy?: number }) {
  const transporter = l.transporter ?? "—";
  return (
    <div className="lb lb-80 lb-dis" data-key={`dispatch:${lineId}`} data-copy={copy}>
      <div className="to">
        <div className="meta">
          <div>Deliver to</div>
          <div>
            Order <b>{l.orderNo}</b> · {labelDate(l.date)} · <span className="mono">{l.lineRef}</span>
          </div>
        </div>
        <div className="party clamp2" style={pt(partyPt(l.delivery))}>
          {l.delivery}
        </div>
        {l.area ? <div className="area cut">{l.area}</div> : null}
        <div className="billed cut">
          Billed to <b>{l.billing}</b>
        </div>
      </div>
      <div className="goods">
        <div className="sku clamp2" style={pt(skuPt(l.sku))}>
          {l.sku}
        </div>
        <div className="facts">
          <Cell k="Order qty" v={orderQty(l.type, l.qty)} />
          <Cell k="Type" v={l.type} />
          <Cell k="Weight" v={l.weightKg == null ? "—" : `${labelNumber(l.weightKg)} kg`} />
          <Cell k="Lot size" v={String(l.lotSize)} />
        </div>
        {l.remark ? (
          <div className="remark clamp2">
            <b>Remark:</b> {l.remark}
          </div>
        ) : null}
      </div>
      <div className="carrier">
        <div className="k">Transporter</div>
        <div className="v clamp2" style={pt(transporterPt(transporter))}>
          {transporter}
        </div>
      </div>
    </div>
  );
}
