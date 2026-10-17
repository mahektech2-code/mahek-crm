/* ---------------------------------------------------------------------------
 * PRODUCTION & DISPATCH TRACEABILITY, the rules — PURE, no I/O.
 *
 *   SFG lot (QC approved) → FG fill (the refill lot) → packing batch → BOX
 *     → scanned at dispatch against an order line → dispatched → customer
 *
 * A box's id is what the QR carries; the lot it came from is linked data,
 * never printed into the id, so one lot makes many boxes and one dispatch
 * carries boxes of several lots. Everything here is decided from arguments,
 * so the scan verdict a godown sees is testable without a database.
 * ------------------------------------------------------------------------- */

/* ================================================================== ids */

/** `BX-261008-000125` — a box; `LU-…` — a labelled loose can or drum. The six digits are one series across both. */
export function unitId(kind: "box" | "loose", isoDate: string, serial: number): string {
  const d = isoDate.slice(2, 10).replace(/-/g, "");
  return `${kind === "box" ? "BX" : "LU"}-${d}-${String(serial).padStart(6, "0")}`;
}

/** What a scanner typed, cleaned: case and stray whitespace, and a URL's last segment (a QR may carry a link). */
export function normaliseCode(raw: string): string {
  let s = raw.trim();
  const slash = s.lastIndexOf("/");
  if (/^https?:\/\//i.test(s) && slash >= 0) s = s.slice(slash + 1);
  const q = s.indexOf("?");
  if (q >= 0) s = s.slice(0, q);
  return decodeURIComponent(s).trim().toUpperCase();
}

export function looksLikeUnitId(code: string): boolean {
  return /^(BX|LU)-\d{6}-\d{6}$/.test(code);
}

/* ========================================================= box → lots */

/**
 * WHICH FG LOTS A BOX'S CANS CAME FROM. A packing batch draws its cans from
 * one or more FG lots, line by line; the boxes are filled in that same order,
 * so box n holds cans (n−1)·cpb … n·cpb−1 of the batch. A box that falls on a
 * boundary holds cans of both lots, and says so — inventing a single lot for
 * it would make a recall miss half of it.
 */
export function boxLots(seq: number, cansPerBox: number, lines: { lot: string; cans: number }[]): { lot: string; cans: number }[] {
  const from = (seq - 1) * cansPerBox;
  const to = seq * cansPerBox;
  const out: { lot: string; cans: number }[] = [];
  let at = 0;
  for (const l of lines) {
    const a = Math.max(from, at);
    const b = Math.min(to, at + l.cans);
    if (b > a) {
      const prev = out.find((x) => x.lot === l.lot);
      if (prev) prev.cans += b - a;
      else out.push({ lot: l.lot, cans: b - a });
    }
    at += l.cans;
  }
  return out;
}

/* ======================================================= the lifecycle */

export const UNIT_STATUS = ["available", "scanned", "dispatched", "hold", "rejected", "returned", "lost", "cancelled"] as const;
export type UnitStatus = (typeof UNIT_STATUS)[number];

export const UNIT_STATUS_LABEL: Record<UnitStatus, string> = {
  available: "In stock",
  scanned: "Scanned for dispatch",
  dispatched: "Dispatched",
  hold: "On hold",
  rejected: "Rejected",
  returned: "Returned",
  lost: "Written off",
  cancelled: "Cancelled",
};

/**
 * The hand moves a person may make on a unit's status, and nothing else:
 * scanning and dispatch move it through the dispatch desk, transfers and
 * write-offs through the transfer, minting and cancelling through packing.
 */
export function manualMove(from: UnitStatus, to: "hold" | "available" | "rejected" | "returned"): string | null {
  if (to === "hold") return from === "available" ? null : "Only a box in stock can be put on hold.";
  if (to === "available") return from === "hold" || from === "returned" ? null : "Only a box on hold, or returned, goes back into stock.";
  if (to === "rejected") return from === "available" || from === "hold" || from === "returned" ? null : "Only a box in stock, on hold or returned can be rejected.";
  return from === "dispatched" ? null : "Only a dispatched box can come back as returned.";
}

/* ======================================================== the scan */

export type ScanUnit = {
  id: string;
  status: UnitStatus;
  skuId: string;
  skuName: string;
  /** The FG product (liquid + pack size family) the SKU sells. */
  productId: string | null;
  productName: string;
  packLabel: string;
  lotFrom: "pack" | "fg";
  lotCode: string;
  godownId: string;
  godownName: string;
  /** The order line it is scanned against, while scanned or dispatched. */
  orderId: string | null;
  orderNo: number | null;
};

export type ScanLine = {
  id: string;
  orderNo: number;
  skuId: string;
  skuName: string;
  productId: string | null;
  productName: string;
  packLabel: string;
  godownId: string;
  godownName: string;
  boxed: boolean;
  /** Units the line needs: boxes for a boxed SKU, cans for a loose one. */
  target: number;
  /** Units already scanned (or dispatched) against it. */
  scanned: number;
  /** Its lot allocations, with how many of each are already scanned. */
  alloc: { id: string; lotCode: string; qty: number; scanned: number }[];
  dispatched: boolean;
  cancelled: boolean;
  /** The finished good (brand + pack size) the SKU sells, so a loose line can be matched to an FG lot. */
  finishedGoodId?: string | null;
};

export type ScanVerdict =
  | {
      ok: true;
      lineId: string;
      /** matched: the unit's lot is allocated to the line; allocate: the line was short and takes it; swap: another lot gives one up. */
      allocation: "matched" | "allocate" | "swap";
      batchCodeId: string | null;
      swapFromId: string | null;
      substituted: boolean;
      message: string;
      /** A LOT scan only: how many units the scan allocated (allocate) or the line takes from the lot (matched). */
      qty?: number;
    }
  | {
      ok: false;
      result: "unknown" | "duplicate" | "blocked" | "mismatch";
      message: string;
      /** For a mismatch: which line it was nearest to and what differed, so an override can name both. */
      mismatch?: { lineId: string; kind: "product" | "size" };
    };

/**
 * IS THIS BOX ALLOWED ON THIS ORDER — the whole rule, in the order a godown
 * would ask it. `override` names the line an approved override lets a
 * mismatched unit stand in for.
 */
export function scanVerdict(unit: ScanUnit | null, lines: ScanLine[], override: { lineId: string } | null = null): ScanVerdict {
  if (!unit) return { ok: false, result: "unknown", message: "No box or label carries this code." };
  const orderNo = lines[0]?.orderNo ?? null;
  if (unit.status === "dispatched")
    return { ok: false, result: "duplicate", message: `${unit.id} has already been dispatched${unit.orderNo ? ` on order ${unit.orderNo}` : ""}.` };
  if (unit.status === "scanned") {
    if (unit.orderNo != null && unit.orderNo === orderNo) return { ok: false, result: "duplicate", message: `${unit.id} is already scanned onto this order.` };
    return { ok: false, result: "blocked", message: `${unit.id} is already scanned onto order ${unit.orderNo ?? "another order"}.` };
  }
  if (unit.status !== "available") return { ok: false, result: "blocked", message: `${unit.id} is ${statusWord(unit.status)} and cannot be dispatched.` };

  const open = lines.filter((l) => !l.cancelled && !l.dispatched);
  if (!open.length) return { ok: false, result: "blocked", message: "Nothing on this order is Ready to dispatch: mark its lines Ready first." };

  let line: ScanLine | undefined;
  let substituted = false;
  if (override) {
    line = open.find((l) => l.id === override.lineId);
    substituted = !!line && line.skuId !== unit.skuId;
  }
  if (!line) {
    const same = open.filter((l) => l.skuId === unit.skuId);
    line = same.find((l) => l.scanned < l.target);
    if (!line && same.length)
      return { ok: false, result: "blocked", message: `Every ${same[0].boxed ? "box" : "unit"} of ${unit.skuName} on this order is already scanned (${same.reduce((a, l) => a + l.scanned, 0)} of ${same.reduce((a, l) => a + l.target, 0)}).` };
    if (!line) {
      const sameProduct = open.find((l) => l.productId != null && l.productId === unit.productId && l.scanned < l.target);
      if (sameProduct)
        return {
          ok: false,
          result: "mismatch",
          message: `Pack size mismatch. Ordered: ${sameProduct.productName} – ${sameProduct.packLabel}. Scanned: ${unit.productName} – ${unit.packLabel}.`,
          mismatch: { lineId: sameProduct.id, kind: "size" },
        };
      const nearest = open.find((l) => l.scanned < l.target) ?? open[0];
      return {
        ok: false,
        result: "mismatch",
        message: `Product mismatch. Nothing on this order is ${unit.skuName}. Ordered: ${open.map((l) => l.skuName).join(", ")}.`,
        mismatch: { lineId: nearest.id, kind: "product" },
      };
    }
  }
  if (line.scanned >= line.target) return { ok: false, result: "blocked", message: `${line.skuName} on this order is fully scanned already.` };
  if ((unit.lotFrom === "pack") !== line.boxed)
    return { ok: false, result: "blocked", message: line.boxed ? `${line.skuName} leaves in boxes; ${unit.id} is a loose unit.` : `${line.skuName} leaves loose; ${unit.id} is a box.` };
  if (unit.godownId !== line.godownId)
    return { ok: false, result: "blocked", message: `${unit.id} is at ${unit.godownName}; order ${line.orderNo} leaves from ${line.godownName}. Transfer it first.` };

  const sameLot = line.alloc.find((a) => a.lotCode === unit.lotCode && a.scanned < a.qty);
  const allocated = line.alloc.reduce((a, x) => a + x.qty, 0);
  const sub = substituted ? " (approved override)" : "";
  if (sameLot) return { ok: true, lineId: line.id, allocation: "matched", batchCodeId: sameLot.id, swapFromId: null, substituted, message: `${unit.id} ✓ ${line.skuName} · lot ${unit.lotCode}${sub}` };
  if (allocated < line.target - 1e-9)
    return { ok: true, lineId: line.id, allocation: "allocate", batchCodeId: line.alloc.find((a) => a.lotCode === unit.lotCode)?.id ?? null, swapFromId: null, substituted, message: `${unit.id} ✓ ${line.skuName} · lot ${unit.lotCode} allocated${sub}` };
  const giver = line.alloc.find((a) => a.lotCode !== unit.lotCode && a.scanned < a.qty);
  if (!giver) return { ok: false, result: "blocked", message: `${line.skuName} has no allocation left to scan against.` };
  return {
    ok: true,
    lineId: line.id,
    allocation: "swap",
    batchCodeId: line.alloc.find((a) => a.lotCode === unit.lotCode)?.id ?? null,
    swapFromId: giver.id,
    substituted,
    message: `${unit.id} ✓ ${line.skuName} · lot ${unit.lotCode} instead of ${giver.lotCode}${sub}`,
  };
}

/**
 * A LOT LABEL SCANNED AT THE DESK. Stock packed before box ids existed has no
 * box label: the only QR on it is the lot's own — the packing batch (FP…), or
 * an FG lot (FG…) for loose cans — and refusing it as "no box carries this
 * code" left the dispatch team with a scanner that read every label and
 * accepted none, on lorries carrying exactly the lot the order named. So a lot
 * is judged as a lot: the lot the line was given is a match; a lot of the same
 * SKU on a line still short of its allocation is allocated, as a box scan
 * would allocate; anything else says what differs. A lot whose boxes DO carry
 * their own labels is refused — there the box is what is counted.
 */
export type ScanLot = {
  code: string;
  stage: "pack" | "fg" | "sfg" | "rm";
  /** The packed SKU (pack) or the finished good (fg); null for sfg/rm. */
  skuId: string | null;
  finishedGoodId: string | null;
  name: string;
  godownIds: string[];
  /** Its boxes carry their own BX-/LU- labels. */
  hasUnits: boolean;
};

export function lotScanVerdict(lot: ScanLot | null, lines: ScanLine[], free: number): ScanVerdict {
  if (!lot) return { ok: false, result: "unknown", message: "No box or label carries this code." };
  if (lot.stage === "sfg" || lot.stage === "rm")
    return { ok: false, result: "blocked", message: `${lot.code} is ${lot.stage === "sfg" ? "a base-liquid" : "a raw-material"} lot (${lot.name}), not packed stock. Scan the label on the boxes or cans going on the lorry.` };
  if (lot.hasUnits) return { ok: false, result: "blocked", message: `${lot.code} is the lot label. Its boxes carry their own labels (BX-…): scan each box instead.` };
  const open = lines.filter((l) => !l.cancelled && !l.dispatched);
  if (!open.length) return { ok: false, result: "blocked", message: "Nothing on this order is Ready to dispatch: mark its lines Ready first." };
  const fits = (l: ScanLine) => (lot.stage === "pack" ? l.boxed && l.skuId === lot.skuId : !l.boxed && l.finishedGoodId != null && l.finishedGoodId === lot.finishedGoodId);
  const unit = (l: ScanLine, n: number) => `${n} ${l.boxed ? (n === 1 ? "box" : "boxes") : n === 1 ? "can" : "cans"}`;

  const given = open.find((l) => l.alloc.some((a) => a.lotCode === lot.code));
  if (given) {
    const n = given.alloc.filter((a) => a.lotCode === lot.code).reduce((a, x) => a + x.qty, 0);
    return { ok: true, lineId: given.id, allocation: "matched", batchCodeId: null, swapFromId: null, substituted: false, qty: n, message: `Lot ${lot.code} ✓ ${given.skuName} — load ${unit(given, n)} from this lot.` };
  }
  const same = open.filter(fits);
  if (!same.length) {
    const want = open.map((l) => l.skuName).join(", ");
    return { ok: false, result: "mismatch", message: `Wrong stock. ${lot.code} is ${lot.name}. This order wants ${want}. Do not load it.` };
  }
  const short = same.find((l) => l.alloc.reduce((a, x) => a + x.qty, 0) < l.target - 1e-9);
  if (!short) {
    const lots = [...new Set(same.flatMap((l) => l.alloc.map((a) => a.lotCode)))].join(", ");
    return { ok: false, result: "blocked", message: `${same[0].skuName} on this order is given lot ${lots}, not ${lot.code}. Load from ${lots}, or ask the office to change the lot.` };
  }
  if (!lot.godownIds.includes(short.godownId)) return { ok: false, result: "blocked", message: `${lot.code} is not at ${short.godownName}, where order ${short.orderNo} leaves from. Transfer it first.` };
  const need = short.target - short.alloc.reduce((a, x) => a + x.qty, 0);
  const n = Math.min(need, Math.floor(free + 1e-9));
  if (n < 1) return { ok: false, result: "blocked", message: `${lot.code} has nothing free at ${short.godownName}: its stock is set aside for other orders. Load from a lot given to this order.` };
  return { ok: true, lineId: short.id, allocation: "allocate", batchCodeId: null, swapFromId: null, substituted: false, qty: n, message: `Lot ${lot.code} ✓ ${short.skuName} — ${unit(short, n)} allocated from this lot${n < need ? ` (${unit(short, need - n)} still to find)` : ""}.` };
}

function statusWord(s: UnitStatus): string {
  return UNIT_STATUS_LABEL[s].toLowerCase();
}

/**
 * MUST THIS LINE BE SCANNED BEFORE IT IS DISPATCH-VERIFIED? Yes where any lot
 * allocated to it has units — every packing batch from today mints its boxes
 * — and no where none does: stock packed before box ids existed has no label
 * to scan, and refusing it would stop dispatch on the day this shipped.
 */
export function scanGate(p: { requireScan: boolean; lotsHaveUnits: boolean; target: number; scanned: number }): string | null {
  if (!p.requireScan || !p.lotsHaveUnits) return null;
  if (p.scanned < p.target) return `${p.target - p.scanned} of ${p.target} still to scan`;
  return null;
}

/* ============================================================= QC */

export const SFG_QC = ["Pending", "Approved", "Rejected"] as const;
export type SfgQc = (typeof SFG_QC)[number];

/** Why an SFG lot may not be filled, or null. A lot with no QC row is Pending. */
export function qcRefusal(status: SfgQc | null | undefined, lot: string): string | null {
  const s = status ?? "Pending";
  if (s === "Approved") return null;
  if (s === "Rejected") return `SFG lot ${lot} was rejected at QC and cannot be filled.`;
  return `SFG lot ${lot} is waiting for QC approval.`;
}

/** "1 L", "500 ml", "20 L" — a pack size as people say it. */
export function packLabel(litres: number | null | undefined): string {
  if (litres == null || !Number.isFinite(litres) || litres <= 0) return "—";
  if (litres < 1) return `${Math.round(litres * 1000)} ml`;
  return `${Number(litres.toFixed(3))} L`;
}
