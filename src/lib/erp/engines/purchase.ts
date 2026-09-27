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
