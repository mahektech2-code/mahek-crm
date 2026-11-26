/* ---------------------------------------------------------------------------
 * WHAT SOMEBODY TYPES INTO TALLY, laid out as the invoice. PURE and client-safe.
 *
 * Ticked order lines become ONE sheet, whichever orders and parties they come
 * from: several orders are routinely clubbed onto one Tally bill, and the
 * office asked for the selection to read as that one bill rather than as an
 * invoice per order. A row lists the order number(s) it came from; lines that
 * differ in nothing but quantity (product, per, GST, rate, discount) are one
 * row, quantities and amount added, and the totals never read the rows. Only lines NOT yet
 * billed are drawn — a billed line already has its invoice, in Tally and in
 * order details — and the sheet says how many it left out. The one split kept
 * is the company: GST decides it, and Mylac and Mahek Marketing India are never
 * one invoice (unbilled lines all carry the usual GST, so in practice it never
 * divides a selection).
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
  /** Which product this is, apart from how it is worded: two lines fold only if it is the same SKU. */
  skuId: string;
  type: OrderType;
  qtyCans: number;
  litresPerCan: number;
  /** Null where the line is loose. */
  boxes: number | null;
  ratePaise: number | null;
  /** What the line weighs, in kg, or null where the SKU carries no weight. */
  weightKg: number | null;
  discountBp: number | null;
  transportCostPaise: number;
  /** Null until the line is billed: order details is where GST is held. */
  gstBp: number | null;
  /** In order details already: it has its invoice, so it is left off this one. */
  billed: boolean;
  transporter: string | null;
  creditDays: number | null;
  /** The same value the order's record shows as "Standing instructions" (`OrderLine.si`). Shown on the consignee only. */
  standingInstructions: string;
};

export type BillingRow = {
  orderNo: BillingValue;
  description: BillingValue;
  cans: BillingValue;
  boxes: BillingValue | null;
  litres: BillingValue;
  weight: BillingValue | null;
  rate: BillingValue | null;
  per: BillingValue;
  discount: BillingValue | null;
  gst: BillingValue;
  amount: BillingValue | null;
};

export type BillingSheet = {
  key: string;
  title: string;
  orderCount: number;
  head: BillingField[];
  /** One per billing party: clubbed orders can name more than one. */
  buyers: { key: string; fields: BillingField[] }[];
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
const kg = (v: number): BillingValue => ({ show: `${qty(v)} kg`, copy: String(v) });
const percent = (bp: number): BillingValue => ({ show: `${nf(bp / 100)}%`, copy: String(bp / 100) });
/** A row of the party block, or nothing: a blank line has nothing to copy. */
const field = (l: string, v: string | null | undefined): BillingField[] => (v?.trim() ? [{ l, v: text(v.trim()) }] : []);

function partyFields(p: BillingParty): BillingField[] {
  return [...field("Name", p.name), ...field("Address", p.address), ...field("City", p.city), ...field("State", p.state), ...field("GSTIN", p.gstin), ...field("Phone", p.phone)];
}

/** Several orders can sit on one invoice: one spelling for the field, the list for the eye. */
const listed = (values: string[]): string => [...new Set(values)].join(", ");

export function billingSheets(all: BillingLine[], sight: BillingSight): BillingSheet[] {
  const lines = all.filter((l) => !l.billed);
  const billedOut = all.length - lines.length;
  const figured = lines.map((l) => {
    const gstBp = l.gstBp ?? USUAL_GST_BP;
    return { l, gstBp, bill: billFigures({ type: l.type, qtyCans: l.qtyCans, litresPerCan: l.litresPerCan, ratePaise: l.ratePaise, discountBp: l.discountBp, transportCostPaise: l.transportCostPaise, gstBp }) };
  });
  const groups = new Map<string, typeof figured>();
  for (const f of figured) {
    /* `company` is decided by the GST, and two companies are never one invoice. */
    const key = f.bill.company;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }

  return [...groups.entries()]
    .map(([key, unordered]): BillingSheet => {
      const notes: string[] = [];
      const group = [...unordered].sort((a, b) => a.l.orderNo - b.l.orderNo);
      const first = group[0];
      const orderNos = group.map((f) => String(f.l.orderNo));
      const buyers = new Map(group.map((f) => [f.l.billing.id, f.l.billing]));
      const consignees = new Map(group.map((f) => [f.l.delivery.id, f.l.delivery]));
      const instructionsOf = new Map(group.map((f) => [f.l.delivery.id, f.l.standingInstructions]));
      const transporters = group.map((f) => f.l.transporter?.trim() ?? "").filter((t) => t && t !== "—");

      /* Lines that differ in nothing but quantity fold into one row. Display only: the totals
         below are read from `group`, never from these rows. The key is the REAL figures, not what
         the viewer may see, so two lines at different hidden rates never share a row; a null and
         a zero discount both mean none. */
      const folded = new Map<string, typeof group>();
      for (const f of group) {
        /* Product and pack, wherever they are held apart from the wording: the SKU, the litres in a
           can, and loose versus boxed (a box is a different pack). Then per, GST, rate, discount. */
        const key = JSON.stringify([f.l.skuId, f.l.description, f.l.litresPerCan, f.l.boxes != null, f.l.type, f.gstBp, f.l.ratePaise, f.l.discountBp ?? 0]);
        folded.set(key, [...(folded.get(key) ?? []), f]);
      }

      const rows = [...folded.values()].map((members): BillingRow => {
        const { l, gstBp } = members[0];
        /* Whole numbers (paise, grams, millilitres), so a folded figure is exactly the sum of the lines it replaces. */
        const cans = members.reduce((n, f) => n + f.l.qtyCans, 0);
        const litres = Math.round(members.reduce((n, f) => n + f.bill.litres * 1000, 0)) / 1000;
        const boxes = members.every((f) => f.l.boxes != null) ? members.reduce((n, f) => n + f.l.boxes!, 0) : null;
        const grams = members.every((f) => f.l.weightKg != null) ? members.reduce((n, f) => n + Math.round(f.l.weightKg! * 1000), 0) : null;
        const nets = members.map((f) => (f.bill.amountPaise == null ? null : f.bill.amountPaise - (f.bill.discountedPaise ?? 0)));
        const net = nets.every((n) => n != null) ? nets.reduce<number>((n, v) => n + v!, 0) : null;
        return {
          orderNo: text(listed(members.map((f) => String(f.l.orderNo)))),
          description: text(l.description),
          cans: { show: nf(cans), copy: String(cans) },
          boxes: boxes == null ? null : { show: nf(boxes), copy: String(boxes) },
          litres: { show: qty(litres), copy: String(litres) },
          weight: grams == null ? null : kg(grams / 1000),
          rate: sight.rates && l.ratePaise != null ? { show: inrRate(l.ratePaise), copy: rupees(l.ratePaise) } : null,
          per: text(l.type === "Drum" ? "Litre" : "Can"),
          discount: sight.amounts && l.discountBp ? percent(l.discountBp) : null,
          gst: percent(gstBp),
          amount: sight.amounts && net != null ? money(net) : null,
        };
      });

      const totals: BillingField[] = [];
      /* Loose cans only: a boxed line is counted in boxes, so its cans are not added here too. */
      const canTotal = group.reduce((n, f) => n + (f.l.boxes == null ? f.l.qtyCans : 0), 0);
      totals.push({ l: "Total can qty", v: { show: nf(canTotal), copy: String(canTotal) } });
      /* Boxes only exist on a boxed SKU; a loose line contributes none, so it reads "—" on its row and adds nothing here. */
      const boxTotal = group.reduce((n, f) => n + (f.l.boxes ?? 0), 0);
      totals.push({ l: "Total box qty", v: { show: nf(boxTotal), copy: String(boxTotal) } });
      const weighed = group.filter((f) => f.l.weightKg != null);
      /* Summed in grams: kilograms to three places do not add exactly as floats. */
      if (weighed.length) totals.push({ l: "Total weight", v: kg(weighed.reduce((n, f) => n + Math.round(f.l.weightKg! * 1000), 0) / 1000) });
      const unweighed = group.length - weighed.length;
      if (unweighed) notes.push(`${unweighed} ${unweighed === 1 ? "line has" : "lines have"} no weight in the catalogue, so the total weight leaves ${unweighed === 1 ? "it" : "them"} out.`);
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
      if (billedOut) notes.push(`${billedOut} ${billedOut === 1 ? "line is" : "lines are"} already billed, so ${billedOut === 1 ? "it is" : "they are"} left off.`);

      return {
        key,
        title: "New invoice",
        orderCount: new Set(orderNos).size,
        head: [
          ...field("Company", first.bill.company),
          ...field("Order no", listed(orderNos)),
          ...field("Order date", listed(group.map((f) => fdLong(f.l.orderDate)))),
          ...field("Dispatch through", listed(transporters)),
          ...field("Terms of payment", listed(group.flatMap((f) => (f.l.creditDays == null ? [] : [`${f.l.creditDays} days`])))),
        ],
        buyers: [...buyers.values()].map((p) => ({ key: p.id, fields: partyFields(p) })),
        consignees: [...consignees.values()].map((p) => ({ key: p.id, fields: [...partyFields(p), ...field("Standing instructions", instructionsOf.get(p.id))] })),
        rows,
        totals,
        notes,
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}
