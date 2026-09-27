import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";

/* ---------------------------------------------------------------------------
 * AI-6 batch trace, DETERMINISTIC: from a bill and the goods on it, back
 * through every document that made them —
 *
 *   bill → order-details line → batch codes (lots dispatched)
 *        → packing batch → FG lots → FG filling → SFG lot → SFG batch lines
 *        → raw-material lots → purchase, supplier and purchase test
 *
 * Every step names the records it came from, so the chain can be opened link
 * by link. Nothing here guesses: a link that is missing is said to be missing.
 * ------------------------------------------------------------------------- */

export type TraceStep = { stage: string; label: string; detail: string; screen: string; ids: string[] };

export type Trace = {
  steps: TraceStep[];
  /** Every lot the chain passes through, as "fg:<lot>", "sfg:<lot>", "rm:<lot>", "pack:<batch>". */
  lots: string[];
  /** People who made or dispatched what was traced, for a suggested responsible employee. */
  people: string[];
  missing: string[];
};

type Row = Record<string, unknown>;
const q = async (s: ReturnType<typeof sql>) => (await db.execute(s)) as unknown as Row[];
const uniq = <T>(xs: T[]) => [...new Set(xs)];

/** Traces what a customer received on a bill: the order lines for that bill and SKU, and everything upstream. */
export async function traceBill(customerId: string, billNo: string, skuName: string | null): Promise<Trace> {
  const lines = await q(sql`
    select o.id, o.order_no as "orderNo", p.name as sku, d.dispatch_date::text as dispatched, coalesce(u.name, '') as by
      from erp_orders o join products p on p.id = o.sku_id
      join erp_order_details d on d.order_id = o.id
      left join users u on u.id = o.created_by_id
     where o.billing_customer_id = ${customerId} and o.tally_bill_no = ${billNo}
       ${skuName ? sql`and p.name = ${skuName}` : sql``}
  `);
  if (!lines.length) return { steps: [], lots: [], people: [], missing: ["No dispatched line carries this bill and goods."] };
  return traceFromOrders(lines.map((l) => String(l.id)), [
    {
      stage: "Bill",
      label: `Bill ${billNo}`,
      detail: lines.map((l) => `Order ${l.orderNo} · ${l.sku}${l.dispatched ? ` · dispatched ${l.dispatched}` : ""}`).join("; "),
      screen: "orderDetails",
      ids: lines.map((l) => String(l.id)),
    },
  ], lines.map((l) => String(l.by)).filter(Boolean));
}

async function traceFromOrders(orderIds: string[], steps: TraceStep[], people: string[]): Promise<Trace> {
  const missing: string[] = [];
  const lots: string[] = [];
  const codes = await q(sql`select id, lot_from as "from", lot_code as lot, finished_good_id as fg, godown_id as godown, quantity::float8 as qty from erp_batch_codes where order_id in ${orderIds}`);
  if (!codes.length) {
    missing.push("No lot was allocated to these lines.");
    return { steps, lots, people: uniq(people), missing };
  }
  steps.push({ stage: "Lots dispatched", label: `${codes.length} batch code${codes.length === 1 ? "" : "s"}`, detail: codes.map((c) => `${c.lot} × ${c.qty}`).join(", "), screen: "batchCodes", ids: codes.map((c) => String(c.id)) });

  /* Packing batches resolve to the FG lots their cans came from. */
  const packBatches = uniq(codes.filter((c) => c.from === "pack").map((c) => String(c.lot)));
  const fgLots: { lot: string; fg: string }[] = codes.filter((c) => c.from === "fg").map((c) => ({ lot: String(c.lot), fg: String(c.fg) }));
  if (packBatches.length) {
    lots.push(...packBatches.map((b) => `pack:${b}`));
    const packLines = await q(sql`select l.id, l.batch_no as batch, l.fg_lot_code as lot, l.finished_good_id as fg, l.cans, coalesce(u.name, '') as by from erp_pack_lines l left join users u on u.id = l.created_by_id where l.batch_no in ${packBatches}`);
    steps.push({ stage: "Packing", label: packBatches.join(", "), detail: packLines.map((p) => `${p.cans} cans from ${p.lot}`).join(", ") || "Transferred in, no packing lines here", screen: "packBatches", ids: packLines.map((p) => String(p.id)) });
    packLines.forEach((p) => fgLots.push({ lot: String(p.lot), fg: String(p.fg) }));
    people.push(...packLines.map((p) => String(p.by)).filter(Boolean));
  }

  const fgLotCodes = uniq(fgLots.map((l) => l.lot));
  if (!fgLotCodes.length) {
    missing.push("The lots could not be followed back to FG filling.");
    return { steps, lots: uniq(lots), people: uniq(people), missing };
  }
  lots.push(...fgLotCodes.map((l) => `fg:${l}`));
  const fills = await q(sql`select f.id, f.lot_code as lot, f.sfg_lot_code as sfg, f.fill_date::text as date, f.cans, f.can_size::float8 as size, coalesce(u.name, '') as by from erp_fg_fills f left join users u on u.id = f.created_by_id where f.lot_code in ${fgLotCodes}`);
  if (!fills.length) missing.push(`No filling record for ${fgLotCodes.join(", ")} (moved in by transfer, or migrated).`);
  else steps.push({ stage: "FG filling", label: fgLotCodes.join(", "), detail: fills.map((f) => `${f.lot}: ${f.cans} × ${f.size} L on ${f.date} from SFG ${f.sfg}`).join("; "), screen: "fgFill", ids: fills.map((f) => String(f.id)) });
  people.push(...fills.map((f) => String(f.by)).filter(Boolean));

  const sfgLots = uniq(fills.map((f) => String(f.sfg)));
  if (!sfgLots.length) return { steps, lots: uniq(lots), people: uniq(people), missing };
  lots.push(...sfgLots.map((l) => `sfg:${l}`));
  const sfgLines = await q(sql`select l.id, l.sfg_no as "sfgNo", l.lot_code as lot, l.rm_lot_no as rm, m.name as item, l.total_use::float8 as used, l.batch_date::text as date, coalesce(u.name, '') as by from erp_sfg_lines l join erp_raw_materials m on m.id = l.raw_material_id left join users u on u.id = l.created_by_id where l.lot_code in ${sfgLots}`);
  if (!sfgLines.length) missing.push(`No SFG batch for ${sfgLots.join(", ")} (moved in by transfer, or migrated).`);
  else steps.push({ stage: "SFG batch", label: uniq(sfgLines.map((l) => `SFG ${l.sfgNo}`)).join(", "), detail: sfgLines.map((l) => `${l.used} L of ${l.item} (${l.rm}) on ${l.date}`).join("; "), screen: "sfgBatches", ids: sfgLines.map((l) => String(l.id)) });
  people.push(...sfgLines.map((l) => String(l.by)).filter(Boolean));

  const rmLots = uniq(sfgLines.map((l) => String(l.rm)));
  if (!rmLots.length) return { steps, lots: uniq(lots), people: uniq(people), missing };
  lots.push(...rmLots.map((l) => `rm:${l}`));
  const purchases = await q(sql`
    select p.id, p.lot_no as lot, s.name as supplier, p.purchase_date::text as date, t.id as test, t.status as "testStatus", t.decided_at is not null as decided
      from erp_purchases p join erp_suppliers s on s.id = p.supplier_id left join erp_tests t on t.id = p.test_id
     where p.lot_no in ${rmLots}
  `);
  if (!purchases.length) missing.push(`No purchase for ${rmLots.join(", ")}.`);
  else {
    steps.push({ stage: "Raw material", label: rmLots.join(", "), detail: purchases.map((p) => `${p.lot} from ${p.supplier} on ${p.date}`).join("; "), screen: "register", ids: purchases.map((p) => String(p.id)) });
    const tests = purchases.filter((p) => p.test);
    steps.push({
      stage: "Purchase test",
      label: tests.length ? `${tests.length} test${tests.length === 1 ? "" : "s"}` : "Not tested",
      detail: tests.length ? tests.map((p) => `${p.lot}: ${p.decided ? p.testStatus : "not decided"}`).join("; ") : "These lots went to the register without a test.",
      screen: "testing",
      ids: tests.map((p) => String(p.test)),
    });
  }
  return { steps, lots: uniq(lots), people: uniq(people), missing };
}
