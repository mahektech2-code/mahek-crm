/* ---------------------------------------------------------------------------
 * The purchase register's arithmetic (spec §5.5), PURE: the same function
 * computes the figure on the form before saving, on the server when saving,
 * and wherever a report reads it — so the three can never disagree.
 *
 * Money is paise; quantities are numbers in the purchase unit.
 * ------------------------------------------------------------------------- */

export type PurchaseInput = {
  quantity: number;
  /** Kg | Litre | Pcs. */
  unit: string;
  ratePaise: number | null;
  density: number | null;
  feedAdjustedLitre: number;
  feedAdjustedAmountPaise: number;
  /** 1800 = 18%. */
  gstBp: number;
  drums: number | null;
};

export type PurchaseFigures = {
  /** kg ÷ density, or the quantity itself — rounded, as the source's ROUND does. */
  inLitre: number;
  /** The rate per litre: rate × density for kg, else the rate. */
  literRatePaise: number | null;
  /** In litre − feed-adjusted litre, rounded. What the ledger posts. */
  availableLitres: number;
  subTotalPaise: number | null;
  gstPaise: number | null;
  amountWithGstPaise: number | null;
  finalPaise: number | null;
  /** Available litres ÷ drums, where there are drums. */
  litresPerDrum: number | null;
};

export function purchaseFigures(p: PurchaseInput): PurchaseFigures {
  const kg = p.unit === "Kg";
  const inLitre = Math.round(kg ? (p.density && p.density > 0 ? p.quantity / p.density : 0) : p.quantity);
  const availableLitres = Math.round(inLitre - (p.feedAdjustedLitre || 0));
  const rate = p.ratePaise;
  const literRatePaise = rate == null ? null : kg ? Math.round(rate * (p.density ?? 0)) : rate;
  const subTotalPaise = rate == null ? null : Math.round(p.quantity * rate);
  const gstPaise = subTotalPaise == null ? null : Math.round((subTotalPaise * p.gstBp) / 10000);
  const amountWithGstPaise = subTotalPaise == null || gstPaise == null ? null : subTotalPaise + gstPaise;
  const finalPaise = amountWithGstPaise == null ? null : Math.round(amountWithGstPaise - (p.feedAdjustedAmountPaise || 0));
  const litresPerDrum = p.drums && p.drums > 0 ? Math.round((availableLitres / p.drums) * 100) / 100 : null;
  return { inLitre, literRatePaise, availableLitres, subTotalPaise, gstPaise, amountWithGstPaise, finalPaise, litresPerDrum };
}

/** The raw-material lot number: party code & item code & PR number, no separators. */
export function lotNumber(partyCode: string | null, itemCode: string | null, prNumber: number): string {
  return `${(partyCode ?? "").trim()}${(itemCode ?? "").trim()}${prNumber}`;
}

/**
 * The short name printed on a drum label (spec §5.5 "Item Name"). The mapping
 * is a reference list of "Item=Label" pairs so it can grow without a deploy.
 */
export function shortLabel(item: string, pairs: string[]): string {
  for (const p of pairs) {
    const [from, to] = p.split("=").map((x) => x.trim());
    if (from && to && from.toLowerCase() === item.trim().toLowerCase()) return to;
  }
  return item;
}

/** "1228 RS/2210 12-Sep-26": PR number, bill number and date, the source's label. */
export function prBillLabel(prNumber: number, billNumber: string | null, isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1];
  return `${prNumber} ${billNumber ?? ""} ${d}-${mon}-${y.slice(2)}`.replace(/\s+/g, " ").trim();
}

/** Only rows with a rate above zero post to stock (spec §5.5, "Purchase to inventory"). */
export function postsToStock(ratePaise: number | null): boolean {
  return ratePaise != null && ratePaise > 0;
}

/**
 * The statuses a person may set on the register (spec §5.5): the verifier
 * sets only "Purchase Verified"; everybody else the two before it.
 */
export function settableStatuses(verifier: boolean): string[] {
  return verifier ? ["Purchase Verified"] : ["Invoice Received", "Purchase Matched"];
}

/* ------------------------------------------------------------ landing cost */

/**
 * How a PR reached the gate. The label is what the form offers; the key is
 * what is stored, so rewording a label never orphans a row.
 */
export const TRANSPORT_MODES = [
  { key: "supplier", label: "Supplier Transport" },
  { key: "own_vehicle", label: "Mahek Own Vehicle" },
  { key: "third_party", label: "Third-Party Transport" },
  { key: "none", label: "No Transport Charges" },
] as const;
export type TransportMode = (typeof TRANSPORT_MODES)[number]["key"];

export function transportModeByLabel(label: string | null | undefined): TransportMode | null {
  return TRANSPORT_MODES.find((m) => m.label === label)?.key ?? null;
}
export function transportModeLabel(key: string): string {
  return TRANSPORT_MODES.find((m) => m.key === key)?.label ?? key;
}

/**
 * What the transport cost a PR, in paise. Supplier and third-party are the
 * amount somebody read off a bill (freight with its GST, or the transporter's
 * bill); our own vehicle is kilometres × the approved rate, never typed, so
 * nobody prices our own tempo by hand. No transport is zero. Null where the
 * figure cannot be worked out yet — own vehicle with no kilometres or no rate.
 */
export function transportCostPaise(p: { mode: TransportMode; billedPaise: number | null; km: number | null; ratePerKmPaise: number | null }): number | null {
  if (p.mode === "none") return 0;
  if (p.mode === "own_vehicle") {
    if (p.km == null || p.ratePerKmPaise == null || p.ratePerKmPaise <= 0) return null;
    return Math.round(p.km * p.ratePerKmPaise);
  }
  return p.billedPaise;
}

/**
 * A PR's transport and other inward cost, shared across its lots IN
 * PROPORTION TO MATERIAL VALUE. A lot with no rate yet takes no share and its
 * part waits on the lots that have one — splitting by weight instead would
 * load the freight onto cheap bulky items. Largest-remainder rounding, so the
 * shares always add up to the paise that were spent. Nothing is shared where
 * no lot has a value yet: `unallocated` is then the whole overhead.
 */
export function shareInwardCost(lots: { id: string; materialPaise: number | null }[], overheadPaise: number): { shares: Map<string, number>; unallocatedPaise: number } {
  const shares = new Map(lots.map((l) => [l.id, 0]));
  const valued = lots.filter((l) => l.materialPaise != null && l.materialPaise > 0);
  const total = valued.reduce((a, l) => a + (l.materialPaise as number), 0);
  if (overheadPaise <= 0 || total <= 0) return { shares, unallocatedPaise: Math.max(0, overheadPaise) };
  const raw = valued.map((l) => ({ id: l.id, exact: (overheadPaise * (l.materialPaise as number)) / total }));
  let left = overheadPaise;
  for (const r of raw) {
    const floor = Math.floor(r.exact);
    shares.set(r.id, floor);
    left -= floor;
  }
  [...raw].sort((a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)) || a.id.localeCompare(b.id)).slice(0, left).forEach((r) => shares.set(r.id, (shares.get(r.id) ?? 0) + 1));
  return { shares, unallocatedPaise: 0 };
}

/**
 * Landing cost = material cost + its share of transport + other direct inward
 * cost. Material cost is the bill's value before GST — the same basis the stock
 * rate has always been, since GST on a purchase is input credit rather than
 * cost. `landedRatePaise` is per purchase unit, so stock can turn it into a
 * litre rate the way it turns the bill rate.
 */
export function landingFigures(p: { quantity: number; ratePaise: number | null; sharePaise: number }): { materialPaise: number | null; landingPaise: number | null; landedRatePaise: number | null } {
  if (p.ratePaise == null) return { materialPaise: null, landingPaise: null, landedRatePaise: null };
  const materialPaise = Math.round(p.quantity * p.ratePaise);
  const landingPaise = materialPaise + p.sharePaise;
  return { materialPaise, landingPaise, landedRatePaise: p.quantity > 0 ? Math.round(landingPaise / p.quantity) : p.ratePaise };
}
