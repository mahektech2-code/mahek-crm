/* ---------------------------------------------------------------------------
 * WHAT SOMEBODY TYPES INTO TALLY, laid out as the invoice. PURE and client-safe.
 *
 * Ticked order lines become one sheet per invoice: one billing party, one
 * company and one invoice number, because `doBill` refuses anything wider.
 * Every value carries two spellings. `show` is what the eye reads ("₹1,200.50");
 * `copy` is what a Tally field takes ("1200.50"), since a rupee sign or an
 * Indian comma pasted into a number field is one more thing to delete.
 *
 * The figures are `billFigures`, the same arithmetic the order book and order
 * details use, and the total is `roundBill`, so this sheet cannot quote a bill
 * a different amount from the rest of MahekOne.
 *
 * Money somebody may not see is never built, so it never reaches the browser.
 * ------------------------------------------------------------------------- */
import { roundBill } from "@/lib/bill-round";
import { invoiceKey } from "./engines/money";
import { billFigures, type OrderType } from "./engines/sales";
import { fdLong, inr, inrRate, nf, qty } from "./ui";

export type BillingValue = { show: string; copy: string };
export type BillingField = { l: string; v: BillingValue };

export type BillingParty = {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  gstin: string | null;
  phone: string | null;
};

/** One order line, as the reader hands it over. */
export type BillingLine = {
  orderNo: number;
  orderDate: string;
  billing: BillingParty;
  delivery: BillingParty;
  description: string;
  type: OrderType;
  qtyCans: number;
  litresPerCan: number;
  /** Null where the line is loose. */
  boxes: number | null;
  ratePaise: number | null;
  discountBp: number | null;
  transportCostPaise: number;
  /** Null until the line is billed: order details is where GST is held. */
  gstBp: number | null;
  invoiceNo: string | null;
  invoiceDate: string | null;
  transporter: string | null;
  creditDays: number | null;
};

export type BillingRow = {
  orderNo: BillingValue;
  description: BillingValue;
  cans: BillingValue;
  boxes: BillingValue | null;
  litres: BillingValue;
  rate: BillingValue | null;
  per: BillingValue;
  discount: BillingValue | null;
  gst: BillingValue;
  amount: BillingValue | null;
};

export type BillingSheet = {
  key: string;
  /** "Invoice MMI/26-27/900", or "New invoice" before it is billed. */
  title: string;
  orderCount: number;
  head: BillingField[];
  buyer: BillingField[];
  consignees: { key: string; fields: BillingField[] }[];
  rows: BillingRow[];
  totals: BillingField[];
  notes: string[];
};

export type BillingSight = { rates: boolean; amounts: boolean };

/** The GST a line is billed at until somebody changes it: `erp_order_details.gst_bp`'s own default. */
const USUAL_GST_BP = 1800;

const text = (s: string): BillingValue => ({ show: s, copy: s });
const rupees = (paise: number) => (paise / 100).toFixed(2);
const money = (paise: number): BillingValue => ({ show: inr(paise), copy: rupees(paise) });
const percent = (bp: number): BillingValue => ({ show: `${nf(bp / 100)}%`, copy: String(bp / 100) });
/** A row of the party block, or nothing: a blank line has nothing to copy. */
const field = (l: string, v: string | null | undefined): BillingField[] => (v?.trim() ? [{ l, v: text(v.trim()) }] : []);

function partyFields(p: BillingParty): BillingField[] {
  return [...field("Name", p.name), ...field("Address", p.address), ...field("City", p.city), ...field("State", p.state), ...field("GSTIN", p.gstin), ...field("Phone", p.phone)];
}

/** Several orders can sit on one invoice: one spelling for the field, the list for the eye. */
const listed = (values: string[]): string => [...new Set(values)].join(", ");

export function billingSheets(lines: BillingLine[], sight: BillingSight): BillingSheet[] {
  const figured = lines.map((l) => {
    const gstBp = l.gstBp ?? USUAL_GST_BP;
    return { l, gstBp, bill: billFigures({ type: l.type, qtyCans: l.qtyCans, litresPerCan: l.litresPerCan, ratePaise: l.ratePaise, discountBp: l.discountBp, transportCostPaise: l.transportCostPaise, gstBp }) };
  });
  const groups = new Map<string, typeof figured>();
  for (const f of figured) {
    /* `company` is decided by the GST, and two companies are never one invoice. */
    const key = [f.l.billing.id, invoiceKey(f.l.invoiceNo), f.bill.company].join("|");
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }

  return [...groups.entries()]
    .map(([key, unordered]): BillingSheet => {
      const group = [...unordered].sort((a, b) => a.l.orderNo - b.l.orderNo);
      const first = group[0];
      const invoiceNo = group.find((f) => f.l.invoiceNo)?.l.invoiceNo ?? null;
      const invoiceDate = group.find((f) => f.l.invoiceDate)?.l.invoiceDate ?? null;
      const orderNos = group.map((f) => String(f.l.orderNo));
      const consignees = new Map(group.map((f) => [f.l.delivery.id, f.l.delivery]));
      const transporters = group.map((f) => f.l.transporter?.trim() ?? "").filter((t) => t && t !== "—");

      const rows = group.map(({ l, gstBp, bill }): BillingRow => {
        const net = bill.amountPaise == null ? null : bill.amountPaise - (bill.discountedPaise ?? 0);
        return {
          orderNo: text(String(l.orderNo)),
          description: text(l.description),
          cans: { show: nf(l.qtyCans), copy: String(l.qtyCans) },
          boxes: l.boxes == null ? null : { show: nf(l.boxes), copy: String(l.boxes) },
          litres: { show: qty(bill.litres), copy: String(bill.litres) },
          rate: sight.rates && l.ratePaise != null ? { show: inrRate(l.ratePaise), copy: rupees(l.ratePaise) } : null,
          per: text(l.type === "Drum" ? "Litre" : "Can"),
          discount: sight.amounts && l.discountBp ? percent(l.discountBp) : null,
          gst: percent(gstBp),
          amount: sight.amounts && net != null ? money(net) : null,
        };
      });

      const notes: string[] = [];
      const totals: BillingField[] = [];
      if (sight.amounts) {
        const priced = group.filter((f) => f.bill.finalPaise != null);
        const gross = priced.reduce((n, f) => n + (f.bill.amountPaise ?? 0), 0);
        const discount = priced.reduce((n, f) => n + (f.bill.discountedPaise ?? 0), 0);
        const freight = priced.reduce((n, f) => n + (f.l.transportCostPaise || 0), 0);
        const final = priced.reduce((n, f) => n + (f.bill.finalPaise ?? 0), 0);
        const taxable = gross - discount + freight;
        const rounded = roundBill(final);
        const rates = [...new Set(priced.map((f) => f.gstBp))];
        totals.push({ l: "Value of goods", v: money(gross) });
        if (discount) totals.push({ l: "Discount", v: money(discount) });
        if (freight) totals.push({ l: "Freight", v: money(freight) });
        totals.push({ l: "Taxable value", v: money(taxable) });
        totals.push({ l: rates.length === 1 ? `GST ${nf(rates[0] / 100)}%` : "GST", v: money(final - taxable) });
        totals.push({ l: "Round off", v: money(rounded.roundOffPaise) });
        totals.push({ l: "Invoice total", v: money(rounded.totalPaise) });
        const unpriced = group.length - priced.length;
        if (unpriced) notes.push(`${unpriced} ${unpriced === 1 ? "line has" : "lines have"} no rate, so the total leaves ${unpriced === 1 ? "it" : "them"} out.`);
      }
      if (group.some((f) => f.l.gstBp == null)) notes.push("Not billed yet, so GST shows the usual 18%.");

      return {
        key,
        title: invoiceNo ? `Invoice ${invoiceNo}` : "New invoice",
        orderCount: new Set(orderNos).size,
        head: [
          ...field("Company", first.bill.company),
          ...field("Invoice no", invoiceNo),
          ...(invoiceDate ? [{ l: "Invoice date", v: { show: fdLong(invoiceDate), copy: fdLong(invoiceDate) } }] : []),
          ...field("Order no", listed(orderNos)),
          ...field("Order date", listed(group.map((f) => fdLong(f.l.orderDate)))),
          ...field("Dispatch through", listed(transporters)),
          ...field("Terms of payment", first.l.creditDays == null ? null : `${first.l.creditDays} days`),
        ],
        buyer: partyFields(first.l.billing),
        consignees: [...consignees.values()].map((p) => ({ key: p.id, fields: partyFields(p) })),
        rows,
        totals,
        notes,
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}
