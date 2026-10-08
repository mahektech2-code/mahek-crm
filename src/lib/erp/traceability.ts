import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { APP_TIMEZONE, calendarDate } from "@/lib/business-date";
import { boxLots, looksLikeUnitId, normaliseCode, packLabel, UNIT_STATUS_LABEL, type UnitStatus } from "./engines/trace";
import { erpLink } from "./registry";
import { erpLabelsHref, erpTraceHref } from "./trace-links";

/* ---------------------------------------------------------------------------
 * TRACE: from any code a person has in hand — a box id off a label, a lot,
 * a packing batch, an order number or a bill — BACK through every document
 * that made it (box → packing batch → FG lot → filling → SFG lot → SFG batch
 * → raw-material lots → purchase, supplier, test) and FORWARD to everywhere it
 * went (SFG lot → FG lots → packing batches → boxes → orders → customers, and
 * what is still in stock).
 *
 * Read-only, and it never guesses: a link that is missing is said to be.
 * ------------------------------------------------------------------------- */

type Row = Record<string, unknown>;
const q = async <T = Row>(s: ReturnType<typeof sql>) => (await db.execute(s)) as unknown as T[];
const uniq = <T>(xs: T[]) => [...new Set(xs)];
const s = (v: unknown) => (v == null ? "" : String(v));
const n = (v: unknown) => (v == null ? 0 : Number(v));
/** A date column (read as text) as it is, or an instant as its day in India. */
const when = (v: unknown) => (v == null ? "" : typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : calendarDate(new Date(v as string)));

export type TraceKind = "unit" | "pack" | "fg" | "sfg" | "rm" | "order" | "bill";

export type Fact = { l: string; v: string; href?: string };

/** One document in the chain back to raw material. */
export type BackStep = { stage: string; title: string; facts: Fact[]; rows: { text: string; href?: string; tone?: "ok" | "warn" | "bad" }[] };

/** Where something went: the lots, boxes and customers it reached. */
export type Destination = { customer: string; customerId: string; orderNo: number; bill: string | null; sku: string; qty: number; unit: string; dispatched: string | null; lots: string[]; href: string };

export type TraceResult = {
  kind: TraceKind;
  code: string;
  title: string;
  sub: string;
  facts: Fact[];
  links: Fact[];
  back: BackStep[];
  forward: { stage: string; rows: { text: string; sub?: string; href?: string; tone?: "ok" | "warn" | "bad" }[] }[];
  customers: Destination[];
  stock: { where: string; qty: string; lot: string }[];
  history: { at: string; text: string; by: string | null }[];
  missing: string[];
};

/* ============================================================ resolve */

export async function resolveTrace(raw: string): Promise<{ kind: TraceKind; code: string; ids?: string[] } | null> {
  const code = normaliseCode(raw);
  if (!code) return null;
  if (looksLikeUnitId(code)) {
    const [u] = await q(sql`select id from erp_units where id = ${code}`);
    return u ? { kind: "unit", code } : null;
  }
  const order = /^(?:ORDER[-\s]?|SO[-\s]?)?(\d{1,9})$/.exec(code);
  if (order) {
    const [o] = await q(sql`select 1 from erp_orders where order_no = ${Number(order[1])} limit 1`);
    if (o) return { kind: "order", code: order[1] };
  }
  const hit = async (s2: ReturnType<typeof sql>) => (await q<{ c: string }>(s2))[0]?.c ?? null;
  const pack = await hit(sql`select batch_no as c from erp_pack_entries where upper(batch_no) = ${code} union select batch_no from erp_pack_lines where upper(batch_no) = ${code} limit 1`);
  if (pack) return { kind: "pack", code: pack };
  const fg = await hit(sql`select lot_code as c from erp_fg_entries where upper(lot_code) = ${code} union select lot_code from erp_fg_fills where upper(lot_code) = ${code} limit 1`);
  if (fg) return { kind: "fg", code: fg };
  const sfg = await hit(sql`select lot_code as c from erp_sfg_entries where upper(lot_code) = ${code} union select lot_code from erp_sfg_lines where upper(lot_code) = ${code} limit 1`);
  if (sfg) return { kind: "sfg", code: sfg };
  const rm = await hit(sql`select lot_no as c from erp_purchases where upper(lot_no) = ${code} limit 1`);
  if (rm) return { kind: "rm", code: rm };
  const bills = await q<{ id: string; bill: string }>(sql`select id, tally_bill_no as bill from erp_orders where upper(tally_bill_no) = ${code}`);
  if (bills.length) return { kind: "bill", code: bills[0].bill, ids: bills.map((b) => b.id) };
  return null;
}

export async function traceCode(raw: string): Promise<TraceResult | null> {
  const r = await resolveTrace(raw);
  if (!r) return null;
  switch (r.kind) {
    case "unit":
      return traceUnit(r.code);
    case "pack":
      return tracePack(r.code);
    case "fg":
      return traceFg(r.code);
    case "sfg":
      return traceSfg(r.code);
    case "rm":
      return traceRm(r.code);
    case "order":
      return traceOrders(sql`o.order_no = ${Number(r.code)}`, "order", r.code);
    case "bill":
      return traceOrders(sql`o.id in ${r.ids!}`, "bill", r.code);
  }
}

/* =========================================================== backward */

async function backFromPack(batches: string[], out: BackStep[], missing: string[]): Promise<string[]> {
  if (!batches.length) return [];
  const lines = await q(sql`
    select l.batch_no as batch, l.pack_date::text as date, p.name as sku, l.boxes, l.fg_lot_code as lot, l.cans, g.name as godown, u.name as by
      from erp_pack_lines l join products p on p.id = l.sku_id join erp_godowns g on g.id = l.godown_id left join users u on u.id = l.created_by_id
     where l.batch_no in ${batches} order by l.batch_no, l.created_at
  `);
  if (!lines.length) {
    missing.push(`No packing lines for ${batches.join(", ")} here — moved in by transfer from another godown's batch, or from before the ERP.`);
    return [];
  }
  out.push({
    stage: "Packing",
    title: uniq(lines.map((l) => s(l.batch))).join(", "),
    facts: [
      { l: "SKU", v: uniq(lines.map((l) => s(l.sku))).join(", ") },
      { l: "Boxes", v: uniq(lines.map((l) => `${s(l.batch)}: ${n(l.boxes)}`)).join(", ") },
      { l: "Packed", v: uniq(lines.map((l) => `${when(l.date)} at ${s(l.godown)}`)).join(", ") },
      { l: "Packed by", v: uniq(lines.map((l) => s(l.by)).filter(Boolean)).join(", ") || "—" },
    ],
    rows: lines.map((l) => ({ text: `${n(l.cans)} cans from FG lot ${s(l.lot)}`, href: erpTraceHref(s(l.lot)) })),
  });
  return uniq(lines.map((l) => s(l.lot)));
}

async function backFromFg(lots: string[], out: BackStep[], missing: string[]): Promise<string[]> {
  if (!lots.length) return [];
  const fills = await q(sql`
    select f.lot_code as lot, f.fill_date::text as date, fg.name as fg, f.can_size::float8 as size, f.cans, f.can_adjusted as adj, f.sfg_lot_code as sfg,
           f.packing_type as packing, g.name as godown, u.name as by
      from erp_fg_fills f join finished_goods fg on fg.id = f.finished_good_id join erp_godowns g on g.id = f.godown_id left join users u on u.id = f.created_by_id
     where f.lot_code in ${lots} order by f.fill_date, f.lot_code
  `);
  const found = new Set(fills.map((f) => s(f.lot)));
  const lost = lots.filter((l) => !found.has(l));
  if (lost.length) missing.push(`No filling record for FG lot ${lost.join(", ")} — moved in by transfer, or from before the ERP.`);
  if (!fills.length) return [];
  out.push({
    stage: "Refill (FG filling)",
    title: uniq(fills.map((f) => s(f.lot))).join(", "),
    facts: [
      { l: "Product", v: uniq(fills.map((f) => `${s(f.fg)} · ${packLabel(n(f.size))}`)).join(", ") },
      { l: "Filled", v: uniq(fills.map((f) => `${when(f.date)} at ${s(f.godown)}`)).join(", ") },
      { l: "Refilled by", v: uniq(fills.map((f) => s(f.by)).filter(Boolean)).join(", ") || "—" },
    ],
    rows: fills.map((f) => ({ text: `${s(f.lot)}: ${n(f.cans)} × ${packLabel(n(f.size))} (${s(f.packing)})${n(f.adj) ? `, ${n(f.adj)} lost` : ""} from SFG lot ${s(f.sfg)}`, href: erpTraceHref(s(f.sfg)) })),
  });
  return uniq(fills.map((f) => s(f.sfg)));
}

async function backFromSfg(lots: string[], out: BackStep[], missing: string[]): Promise<string[]> {
  if (!lots.length) return [];
  const [lines, qc] = await Promise.all([
    q(sql`
      select l.sfg_no as "sfgNo", l.lot_code as lot, l.batch_date::text as date, f.name as product, l.batches::float8 as batches, m.name as item, l.rm_lot_no as rm,
             l.total_use::float8 as used, l.litres_adjusted::float8 as adj, g.name as godown, u.name as by
        from erp_sfg_lines l join product_formulations f on f.id = l.formulation_id join erp_raw_materials m on m.id = l.raw_material_id
        join erp_godowns g on g.id = l.godown_id left join users u on u.id = l.created_by_id
       where l.lot_code in ${lots} order by l.sfg_no, l.created_at
    `),
    q(sql`select q.lot_code as lot, q.status, q.note, u.name as by, q.decided_at as at from erp_sfg_qc q left join users u on u.id = q.decided_by_id where q.lot_code in ${lots}`),
  ]);
  const found = new Set(lines.map((l) => s(l.lot)));
  const lost = lots.filter((l) => !found.has(l));
  if (lost.length) missing.push(`No SFG batch for lot ${lost.join(", ")} — moved in by transfer, or from before the ERP.`);
  const qcOf = new Map(qc.map((x) => [s(x.lot), x]));
  for (const lot of lots) {
    const v = qcOf.get(lot);
    out.push({
      stage: "SFG QC",
      title: lot,
      facts: [
        { l: "Verdict", v: v ? s(v.status) : "Pending" },
        ...(v?.by ? [{ l: "Decided by", v: `${s(v.by)} · ${when(v.at)}` }] : []),
        ...(v?.note ? [{ l: "Note", v: s(v.note) }] : []),
      ],
      rows: [],
    });
  }
  if (!lines.length) return [];
  out.push({
    stage: "SFG batch",
    title: uniq(lines.map((l) => `SFG ${s(l.sfgNo)} · lot ${s(l.lot)}`)).join(", "),
    facts: [
      { l: "Product", v: uniq(lines.map((l) => s(l.product))).join(", ") },
      { l: "Made", v: uniq(lines.map((l) => `${when(l.date)} at ${s(l.godown)}, ${n(l.batches)} batch${n(l.batches) === 1 ? "" : "es"}`)).join(", ") },
      { l: "Litres made", v: String(Math.round(lines.reduce((a, l) => a + n(l.used) - n(l.adj), 0) * 100) / 100) },
      { l: "Made by", v: uniq(lines.map((l) => s(l.by)).filter(Boolean)).join(", ") || "—" },
    ],
    rows: lines.map((l) => ({ text: `${n(l.used)} L of ${s(l.item)} from lot ${s(l.rm)}`, href: erpTraceHref(s(l.rm)) })),
  });
  return uniq(lines.map((l) => s(l.rm)));
}

async function backFromRm(lots: string[], out: BackStep[], missing: string[]): Promise<void> {
  if (!lots.length) return;
  const rows = await q(sql`
    select p.lot_no as lot, p.purchase_date::text as date, s.name as supplier, m.name as item, p.pr_number as pr, t.status as test, t.decided_at as decided
      from erp_purchases p join erp_suppliers s on s.id = p.supplier_id left join erp_raw_materials m on m.id = p.raw_material_id left join erp_tests t on t.id = p.test_id
     where p.lot_no in ${lots}
  `);
  const found = new Set(rows.map((r) => s(r.lot)));
  const lost = lots.filter((l) => !found.has(l));
  if (lost.length) missing.push(`No purchase for raw-material lot ${lost.join(", ")}.`);
  if (!rows.length) return;
  out.push({
    stage: "Raw material",
    title: `${rows.length} lot${rows.length === 1 ? "" : "s"}`,
    facts: [],
    rows: rows.map((r) => ({
      text: `${s(r.lot)} · ${s(r.item)} from ${s(r.supplier)} on ${when(r.date)} (PR ${s(r.pr)}) · test: ${r.test ? (r.decided ? s(r.test) : "not decided") : "not tested"}`,
      href: erpLink("register", { open: undefined }),
      tone: r.test && !r.decided ? "warn" : undefined,
    })),
  });
}

/** Everything upstream of a set of packing batches / FG lots / SFG lots. */
async function backward(start: { pack?: string[]; fg?: string[]; sfg?: string[]; rm?: string[] }): Promise<{ back: BackStep[]; missing: string[] }> {
  const back: BackStep[] = [];
  const missing: string[] = [];
  const fg = uniq([...(start.fg ?? []), ...(await backFromPack(start.pack ?? [], back, missing))]);
  const sfg = uniq([...(start.sfg ?? []), ...(await backFromFg(fg, back, missing))]);
  const rm = uniq([...(start.rm ?? []), ...(await backFromSfg(sfg, back, missing))]);
  await backFromRm(rm, back, missing);
  return { back, missing };
}

/* ============================================================ forward */

/** The orders lots reached through allocations, with the boxes that actually went where boxes were scanned. */
async function destinations(lotFrom: "pack" | "fg", lots: string[]): Promise<Destination[]> {
  if (!lots.length) return [];
  const rows = await q(sql`
    select o.id, o.order_no as "orderNo", o.tally_bill_no as bill, c.id as "customerId", coalesce(dc.name, c.name) as customer, p.name as sku,
           b.lot_code as lot, b.quantity::float8 as qty, d.verification, d.dispatch_date::text as dispatched
      from erp_batch_codes b join erp_orders o on o.id = b.order_id join products p on p.id = o.sku_id
      join customers c on c.id = o.billing_customer_id left join customers dc on dc.id = o.delivery_customer_id
      left join erp_order_details d on d.order_id = o.id
     where b.lot_from = ${lotFrom} and b.lot_code in ${lots}
     order by o.order_no desc
  `);
  const by = new Map<string, Destination>();
  for (const r of rows) {
    const k = s(r.id);
    const d = by.get(k) ?? {
      customer: s(r.customer),
      customerId: s(r.customerId),
      orderNo: n(r.orderNo),
      bill: r.bill == null ? null : s(r.bill),
      sku: s(r.sku),
      qty: 0,
      unit: lotFrom === "pack" ? "boxes" : "cans",
      dispatched: r.verification === "Verified" ? (r.dispatched ? String(r.dispatched).slice(0, 10) : "yes") : null,
      lots: [],
      href: erpTraceHref(`ORDER-${n(r.orderNo)}`),
    };
    d.qty += n(r.qty);
    if (!d.lots.includes(s(r.lot))) d.lots.push(s(r.lot));
    by.set(k, d);
  }
  return [...by.values()];
}

async function stockOf(kind: "sfg" | "fg" | "pack", lots: string[]): Promise<{ where: string; qty: string; lot: string }[]> {
  if (!lots.length) return [];
  const { sfgLots, fgLots, packLots } = await import("./stock");
  if (kind === "sfg") return (await sfgLots()).filter((l) => lots.includes(l.lotCode) && l.stock > 0).map((l) => ({ where: l.godown, qty: `${l.stock} L`, lot: l.lotCode }));
  if (kind === "fg") return (await fgLots()).filter((l) => lots.includes(l.lotCode) && l.stock > 0).map((l) => ({ where: l.godown, qty: `${l.stock} cans`, lot: l.lotCode }));
  return (await packLots()).filter((l) => lots.includes(l.batchNo) && l.stock > 0).map((l) => ({ where: l.godown, qty: `${l.stock} boxes`, lot: l.batchNo }));
}

/** FG lots → the packing batches and loose orders they reached. */
async function forwardFromFg(fgLots: string[]): Promise<{ steps: TraceResult["forward"]; customers: Destination[]; stock: TraceResult["stock"]; batches: string[] }> {
  const packs = fgLots.length
    ? await q(sql`select l.batch_no as batch, l.fg_lot_code as lot, l.cans, p.name as sku, l.pack_date::text as date from erp_pack_lines l join products p on p.id = l.sku_id where l.fg_lot_code in ${fgLots} order by l.pack_date`)
    : [];
  const batches = uniq(packs.map((p) => s(p.batch)));
  const [loose, boxed, fgStock, packStock] = await Promise.all([destinations("fg", fgLots), destinations("pack", batches), stockOf("fg", fgLots), stockOf("pack", batches)]);
  const steps: TraceResult["forward"] = [];
  if (packs.length)
    steps.push({ stage: "Packed into", rows: packs.map((p) => ({ text: `${s(p.batch)} · ${s(p.sku)}`, sub: `${n(p.cans)} cans of ${s(p.lot)} on ${when(p.date)}`, href: erpTraceHref(s(p.batch)) })) });
  return { steps, customers: [...boxed, ...loose], stock: [...fgStock, ...packStock], batches };
}

/* ============================================================== traces */

async function unitHistory(ids: string[]): Promise<TraceResult["history"]> {
  if (!ids.length) return [];
  const rows = await q(sql`
    select e.at, e.unit_id as unit, e.event, e.note, u.name as by from erp_unit_events e left join users u on u.id = e.by_id
     where e.unit_id in ${ids} order by e.at desc limit 200
  `);
  return rows.map((r) => ({ at: new Date(r.at as string).toISOString(), text: `${ids.length > 1 ? `${s(r.unit)} · ` : ""}${s(r.event)}${r.note ? ` — ${s(r.note)}` : ""}`, by: r.by == null ? null : s(r.by) }));
}

async function traceUnit(id: string): Promise<TraceResult> {
  const [u] = await q(sql`
    select u.*, p.name as sku, p.cans_per_box as cpb, coalesce(p.millilitres_per_can, fg.millilitres)::float8 / 1000 as litres, g.name as godown,
           o.order_no as "orderNo", o.tally_bill_no as bill, coalesce(dc.name, bc.name) as customer, d.dispatch_date::text as "dispatchDate", sc.name as "scannedBy"
      from erp_units u join products p on p.id = u.sku_id left join finished_goods fg on fg.id = p.finished_good_id
      join erp_godowns g on g.id = u.godown_id left join erp_orders o on o.id = u.order_id
      left join customers bc on bc.id = o.billing_customer_id left join customers dc on dc.id = o.delivery_customer_id
      left join erp_order_details d on d.order_id = o.id left join users sc on sc.id = u.scanned_by_id
     where u.id = ${id}
  `);
  const status = s(u.status) as UnitStatus;
  let lots: { lot: string; cans: number }[] = [];
  let back: { back: BackStep[]; missing: string[] };
  if (u.lot_from === "pack") {
    const lines = await q<{ lot: string; cans: number }>(sql`select fg_lot_code as lot, cans from erp_pack_lines where batch_no = ${s(u.lot_code)} order by created_at`);
    lots = boxLots(n(u.seq), n(u.cpb) || n(u.cans), lines.map((l) => ({ lot: l.lot, cans: n(l.cans) })));
    back = await backward({ pack: [s(u.lot_code)] });
  } else {
    lots = [{ lot: s(u.lot_code), cans: 1 }];
    back = await backward({ fg: [s(u.lot_code)] });
  }
  const sfg = back.back.filter((b) => b.stage === "SFG batch").map((b) => b.title).join(", ");
  const customers: Destination[] = u.order_id
    ? [{ customer: s(u.customer), customerId: "", orderNo: n(u.orderNo), bill: u.bill == null ? null : s(u.bill), sku: s(u.sku), qty: 1, unit: u.kind === "box" ? "box" : "unit", dispatched: status === "dispatched" ? (u.dispatchDate ? String(u.dispatchDate).slice(0, 10) : "yes") : null, lots: lots.map((l) => l.lot), href: erpTraceHref(`ORDER-${n(u.orderNo)}`) }]
    : [];
  return {
    kind: "unit",
    code: id,
    title: id,
    sub: `${s(u.sku)} · ${packLabel(n(u.litres))} · ${n(u.cans)} can${n(u.cans) === 1 ? "" : "s"} · ${UNIT_STATUS_LABEL[status]}`,
    facts: [
      { l: "Status", v: UNIT_STATUS_LABEL[status] + (u.status_note ? ` — ${s(u.status_note)}` : "") },
      { l: "Where", v: s(u.godown) },
      { l: u.kind === "box" ? "Packing batch" : "FG lot", v: `${s(u.lot_code)} · ${u.kind === "box" ? "box" : "unit"} ${n(u.seq)}`, href: erpTraceHref(s(u.lot_code)) },
      { l: "Refill lot", v: lots.map((l) => (lots.length > 1 ? `${l.lot} (${l.cans} cans)` : l.lot)).join(", ") || "—" },
      ...(sfg ? [{ l: "SFG", v: sfg }] : []),
      ...(u.order_id ? [{ l: status === "dispatched" ? "Dispatched to" : "Scanned onto", v: `${s(u.customer)} · order ${n(u.orderNo)}${u.bill ? ` · bill ${s(u.bill)}` : ""}`, href: erpTraceHref(`ORDER-${n(u.orderNo)}`) }] : []),
      ...(u.scannedBy ? [{ l: "Scanned by", v: s(u.scannedBy) }] : []),
      { l: "Label", v: u.label_printed_at ? `Printed ${n(u.label_prints)}×` : "Not printed" },
    ],
    links: [{ l: "Print label", v: "Print", href: erpLabelsHref({ ids: [id] }) }, { l: "Box register", v: "Open", href: erpLink("allUnits") }],
    back: back.back,
    forward: [],
    customers,
    stock: [],
    history: await unitHistory([id]),
    missing: back.missing,
  };
}

async function unitSummary(lotFrom: "pack" | "fg", lots: string[]): Promise<Fact[]> {
  if (!lots.length) return [];
  const rows = await q<{ status: string; n: number }>(sql`select status, count(*)::int as n from erp_units where lot_from = ${lotFrom} and lot_code in ${lots} group by 1`);
  if (!rows.length) return [{ l: lotFrom === "pack" ? "Box ids" : "Loose labels", v: lotFrom === "pack" ? "None — packed before box ids existed" : "None labelled" }];
  return [{ l: lotFrom === "pack" ? "Box ids" : "Loose labels", v: rows.map((r) => `${n(r.n)} ${UNIT_STATUS_LABEL[r.status as UnitStatus]?.toLowerCase() ?? r.status}`).join(" · ") }];
}

async function tracePack(batch: string): Promise<TraceResult> {
  const [head] = await q(sql`select p.name as sku, l.boxes, g.name as godown, l.pack_date::text as date from erp_pack_lines l join products p on p.id = l.sku_id join erp_godowns g on g.id = l.godown_id where l.batch_no = ${batch} limit 1`);
  const back = await backward({ pack: [batch] });
  const [customers, stock, units] = await Promise.all([destinations("pack", [batch]), stockOf("pack", [batch]), unitSummary("pack", [batch])]);
  return {
    kind: "pack",
    code: batch,
    title: `Packing batch ${batch}`,
    sub: head ? `${s(head.sku)} · ${n(head.boxes)} boxes · packed ${when(head.date)} at ${s(head.godown)}` : "Transferred in; its packing lines are at another godown or from before the ERP.",
    facts: units,
    links: [{ l: "Box labels", v: "Print all", href: erpLabelsHref({ batch }) }],
    back: back.back,
    forward: [],
    customers,
    stock,
    history: [],
    missing: back.missing,
  };
}

async function traceFg(lot: string): Promise<TraceResult> {
  const [head] = await q(sql`select fg.name as fg, f.can_size::float8 as size, f.cans, f.fill_date::text as date, g.name as godown from erp_fg_fills f join finished_goods fg on fg.id = f.finished_good_id join erp_godowns g on g.id = f.godown_id where f.lot_code = ${lot} limit 1`);
  const back = await backward({ fg: [lot] });
  const fwd = await forwardFromFg([lot]);
  return {
    kind: "fg",
    code: lot,
    title: `Refill lot ${lot}`,
    sub: head ? `${s(head.fg)} · ${n(head.cans)} × ${packLabel(n(head.size))} · filled ${when(head.date)} at ${s(head.godown)}` : "Transferred in.",
    facts: await unitSummary("fg", [lot]),
    links: [{ l: "Loose labels", v: "Print", href: erpLabelsHref({ lot }) }],
    back: back.back,
    forward: fwd.steps,
    customers: fwd.customers,
    stock: fwd.stock,
    history: [],
    missing: back.missing,
  };
}

async function traceSfg(lot: string): Promise<TraceResult> {
  const back = await backward({ sfg: [lot] });
  const fills = await q(sql`select f.lot_code as lot, fg.name as fg, f.can_size::float8 as size, f.cans, f.fill_date::text as date, g.name as godown from erp_fg_fills f join finished_goods fg on fg.id = f.finished_good_id join erp_godowns g on g.id = f.godown_id where f.sfg_lot_code = ${lot} order by f.fill_date`);
  const fgLots = uniq(fills.map((f) => s(f.lot)));
  const fwd = await forwardFromFg(fgLots);
  const sfgStock = await stockOf("sfg", [lot]);
  const forward: TraceResult["forward"] = [];
  if (fills.length) forward.push({ stage: "Refilled into", rows: fills.map((f) => ({ text: `${s(f.lot)} · ${s(f.fg)} ${packLabel(n(f.size))}`, sub: `${n(f.cans)} filled on ${when(f.date)} at ${s(f.godown)}`, href: erpTraceHref(s(f.lot)) })) });
  forward.push(...fwd.steps);
  const qc = back.back.find((b) => b.stage === "SFG QC");
  return {
    kind: "sfg",
    code: lot,
    title: `SFG lot ${lot}`,
    sub: back.back.find((b) => b.stage === "SFG batch")?.facts.map((f) => f.v).slice(0, 2).join(" · ") ?? "",
    facts: qc ? qc.facts : [],
    links: [],
    back: back.back,
    forward,
    customers: fwd.customers,
    stock: [...sfgStock, ...fwd.stock],
    history: [],
    missing: back.missing,
  };
}

async function traceRm(lot: string): Promise<TraceResult> {
  const back = await backward({ rm: [lot] });
  const sfgLines = await q(sql`select distinct lot_code as lot, sfg_no as no, batch_date::text as date from erp_sfg_lines where rm_lot_no = ${lot} order by batch_date`);
  const sfgLots = uniq(sfgLines.map((l) => s(l.lot)));
  const fills = sfgLots.length ? await q(sql`select distinct lot_code as lot from erp_fg_fills where sfg_lot_code in ${sfgLots}`) : [];
  const fwd = await forwardFromFg(uniq(fills.map((f) => s(f.lot))));
  const forward: TraceResult["forward"] = [];
  if (sfgLines.length) forward.push({ stage: "Used in SFG", rows: sfgLines.map((l) => ({ text: `SFG ${s(l.no)} · lot ${s(l.lot)}`, sub: when(l.date), href: erpTraceHref(s(l.lot)) })) });
  if (fills.length) forward.push({ stage: "Refilled into", rows: fills.map((f) => ({ text: s(f.lot), href: erpTraceHref(s(f.lot)) })) });
  forward.push(...fwd.steps);
  return { kind: "rm", code: lot, title: `Raw-material lot ${lot}`, sub: "", facts: [], links: [], back: back.back, forward, customers: fwd.customers, stock: fwd.stock, history: [], missing: back.missing };
}

async function traceOrders(where: ReturnType<typeof sql>, kind: "order" | "bill", code: string): Promise<TraceResult> {
  const lines = await q(sql`
    select o.id, o.order_no as "orderNo", o.tally_bill_no as bill, p.name as sku, o.qty_cans as qty, coalesce(dc.name, c.name) as customer, d.verification, d.dispatch_date::text as dispatched
      from erp_orders o join products p on p.id = o.sku_id join customers c on c.id = o.billing_customer_id left join customers dc on dc.id = o.delivery_customer_id
      left join erp_order_details d on d.order_id = o.id
     where ${where} order by p.name
  `);
  const ids = lines.map((l) => s(l.id));
  const [codes, units] = await Promise.all([
    ids.length ? q(sql`select order_id as "order", lot_from as "from", lot_code as lot, quantity::float8 as qty from erp_batch_codes where order_id in ${ids}`) : Promise.resolve([] as Row[]),
    ids.length ? q(sql`select id, order_id as "order", lot_code as lot, status from erp_units where order_id in ${ids} and status in ('scanned', 'dispatched') order by id`) : Promise.resolve([] as Row[]),
  ]);
  const back = await backward({ pack: uniq(codes.filter((c) => c.from === "pack").map((c) => s(c.lot))), fg: uniq(codes.filter((c) => c.from === "fg").map((c) => s(c.lot))) });
  const first = lines[0];
  const forward: TraceResult["forward"] = [
    {
      stage: "Order lines",
      rows: lines.map((l) => {
        const u = units.filter((x) => x.order === l.id);
        const c = codes.filter((x) => x.order === l.id);
        return {
          text: `${s(l.sku)} · ${n(l.qty)} cans`,
          sub: `${c.length ? `Lots ${c.map((x) => `${s(x.lot)} × ${n(x.qty)}`).join(", ")}` : "No lot allocated"} · ${u.length} box${u.length === 1 ? "" : "es"} scanned · ${l.verification === "Verified" ? `dispatched ${l.dispatched ? String(l.dispatched).slice(0, 10) : ""}` : "not dispatched"}`,
          tone: l.verification === "Verified" ? ("ok" as const) : undefined,
        };
      }),
    },
  ];
  if (units.length) forward.push({ stage: "Boxes", rows: units.map((u) => ({ text: s(u.id), sub: `lot ${s(u.lot)} · ${UNIT_STATUS_LABEL[s(u.status) as UnitStatus]}`, href: erpTraceHref(s(u.id)) })) });
  return {
    kind,
    code,
    title: kind === "order" ? `Order ${code}` : `Bill ${code}`,
    sub: first ? `${s(first.customer)}${first.bill ? ` · bill ${s(first.bill)}` : ""} · order ${n(first.orderNo)}` : "",
    facts: [],
    links: [
      { l: "Dispatch desk", v: "Open", href: `/erp/dispatch?order=${first ? n(first.orderNo) : code}` },
      { l: "Dispatch stickers", v: "Print", href: erpLabelsHref({ order: first ? n(first.orderNo) : code }) },
    ],
    back: back.back,
    forward,
    customers: [],
    stock: [],
    history: await unitHistory(units.map((u) => s(u.id)).slice(0, 50)),
    missing: back.missing,
  };
}

/* ========================================================== dashboard */

export type TraceDashboard = {
  today: { l: string; v: string; sub?: string; href?: string }[];
  exceptions: { l: string; n: number; tone: "bad" | "warn"; href: string; sub: string }[];
  recentScans: { at: string; code: string; orderNo: number | null; result: string; message: string; by: string | null }[];
};

export async function traceDashboard(): Promise<TraceDashboard> {
  const day = calendarDate(new Date());
  const since = sql`(${day}::date)::timestamp at time zone ${APP_TIMEZONE}`;
  const [[f], scans] = await Promise.all([
    q(sql`
      select
        (select coalesce(sum(total_use - litres_adjusted), 0)::float8 from erp_sfg_lines where batch_date = ${day}) as sfg,
        (select count(distinct lot_code)::int from erp_sfg_lines where batch_date = ${day}) as "sfgLots",
        (select coalesce(sum(cans - can_adjusted), 0)::int from erp_fg_fills where fill_date = ${day}) as refilled,
        (select coalesce(sum(boxes), 0)::float8 from erp_pack_entries where source_type = 'batch' and entry_date = ${day}) as packed,
        (select count(*)::int from erp_units where created_at >= ${since}) as minted,
        (select count(*)::int from erp_units where label_printed_at >= ${since}) as printed,
        (select count(*)::int from erp_dispatch_scans where at >= ${since} and result = 'ok') as scanned,
        (select count(*)::int from erp_units where dispatched_at >= ${since}) as dispatched,
        (select count(distinct batch_no)::int from erp_pack_lines l where not exists (select 1 from erp_pack_entries e where e.source_type = 'batch' and e.source_id = l.batch_no)) as "packOpen",
        (select count(*)::int from erp_dispatch_scans where at >= ${since} and result = 'mismatch') as mismatches,
        (select count(*)::int from erp_dispatch_scans where at >= ${since} and result = 'duplicate') as duplicates,
        (select count(*)::int from erp_dispatch_scans where at >= ${since} and result in ('blocked', 'unknown')) as blocked,
        (select count(*)::int from erp_dispatch_overrides where status = 'Pending') as overrides,
        (select count(*)::int from erp_units where status = 'scanned') as "awaitingDispatch",
        (select count(*)::int from erp_units where status = 'hold') as held,
        (select count(*)::int from erp_units where status = 'available' and label_printed_at is null) as unlabelled,
        (select count(distinct l.lot_code)::int from erp_sfg_lines l left join erp_sfg_qc q on q.lot_code = l.lot_code where coalesce(q.status, 'Pending') = 'Pending') as "qcPending",
        (select count(*)::int from erp_sfg_qc where status = 'Rejected') as "qcRejected"
    `),
    q(sql`select s.at, s.code, s.order_no as "orderNo", s.result, s.message, u.name as by from erp_dispatch_scans s left join users u on u.id = s.by_id order by s.at desc limit 25`),
  ]);
  const today = [
    { l: "SFG produced", v: `${Math.round(n(f.sfg))} L`, sub: `${n(f.sfgLots)} lot${n(f.sfgLots) === 1 ? "" : "s"}`, href: erpLink("sfgBatches") },
    { l: "Refilled", v: `${n(f.refilled)} cans`, href: erpLink("fgFill") },
    { l: "Packed", v: `${n(f.packed)} boxes`, sub: `${n(f.minted)} box ids minted`, href: erpLink("packBatches") },
    { l: "Labels printed", v: String(n(f.printed)), href: erpLink("units") },
    { l: "Scanned at dispatch", v: String(n(f.scanned)), href: "/erp/dispatch" },
    { l: "Boxes dispatched", v: String(n(f.dispatched)), href: erpLink("allUnits") },
    { l: "Packing batches open", v: String(n(f.packOpen)), sub: "cans still to draw", href: erpLink("packBatches") },
  ];
  const ex: TraceDashboard["exceptions"] = [
    { l: "Pack-size / product mismatches today", n: n(f.mismatches), tone: "bad", href: "/erp/trace#scans", sub: "Scans stopped at the desk" },
    { l: "Duplicate scans today", n: n(f.duplicates), tone: "bad", href: "/erp/trace#scans", sub: "A box already scanned or already gone" },
    { l: "Other refused scans today", n: n(f.blocked), tone: "warn", href: "/erp/trace#scans", sub: "Unknown code, wrong godown, box on hold" },
    { l: "Overrides waiting for approval", n: n(f.overrides), tone: "warn", href: "/erp/dispatch", sub: "A mismatched box somebody asked to send" },
    { l: "Boxes scanned, not yet dispatched", n: n(f.awaitingDispatch), tone: "warn", href: erpLink("units"), sub: "On an order, waiting for Do Verified" },
    { l: "Boxes on hold", n: n(f.held), tone: "warn", href: erpLink("units"), sub: "Cannot be scanned until released" },
    { l: "Boxes in stock without a printed label", n: n(f.unlabelled), tone: "warn", href: erpLink("units"), sub: "Print before they go to the shelf" },
    { l: "SFG lots waiting for QC", n: n(f.qcPending), tone: "warn", href: erpLink("sfgBatches"), sub: "They cannot be refilled until approved" },
    { l: "SFG lots rejected at QC", n: n(f.qcRejected), tone: "bad", href: erpLink("sfgBatches"), sub: "Trace them to see what was filled" },
  ];
  return {
    today,
    exceptions: ex,
    recentScans: scans.map((r) => ({ at: new Date(r.at as string).toISOString(), code: s(r.code), orderNo: r.orderNo == null ? null : n(r.orderNo), result: s(r.result), message: s(r.message), by: r.by == null ? null : s(r.by) })),
  };
}
