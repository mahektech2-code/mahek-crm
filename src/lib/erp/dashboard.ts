import "server-only";
import { eq, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { customers } from "@/db/schema";
import { calendarDate } from "@/lib/business-date";
import type { ErpContext } from "./access";
import { visibleAlerts } from "./alerts";
import { incompletePackIds } from "./counts";
import { ALERT_LABEL, type AlertKind } from "./engines/alerts";
import { monthId, targetReached } from "./engines/sales";
import { erpLink } from "./registry";
import { today } from "./screens/common";
import { purchaseOrderViews, requirementWork } from "./screens/purchase-flow";
import { poTotals } from "./engines/purchase-flow";
import { requestStatus } from "./screens/complaints";
import { loadCustomers, partyStatus } from "./screens/masters";
import { fgReorderRows, rmReorderRows } from "./screens/movement";
import { detailRows, orderLines, ORDER_STATUSES } from "./screens/sales";
import { fgLots, packLots, rmLots, sfgLots } from "./stock";
import type { Tone } from "./ui";
import { nf } from "./ui";

/* ---------------------------------------------------------------------------
 * The ERP dashboard (PRD §6, spec §13.6): what needs attention now, from data
 * the modules already hold. Every tile names the rows it counted, so opening
 * it lands on exactly those rows; a tile for a screen the person does not
 * hold — or a money figure without its power — is never built at all. "G"
 * tiles follow the working location; the rest are company-wide.
 * ------------------------------------------------------------------------- */

export type Tile = {
  l: string;
  v: string;
  sub?: string;
  tone?: Tone;
  href: string;
};

export type Section = { t: string; tiles: Tile[] };

/** A link to a screen, pre-filtered to the ids a tile counted. */
export function tileHref(screen: string, ids: string[] | null, label: string): string {
  return ids ? erpLink(screen, { f: ids.join(","), fl: label }) : erpLink(screen);
}

type Row = Record<string, unknown>;
const q = async (s: ReturnType<typeof sql>) => (await db.execute(s)) as unknown as Row[];
const rupees = (p: number) => `₹${nf(Math.round(p / 100))}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const asDate = (v: unknown) => (v instanceof Date ? v : new Date(String(v)));

/** Loads each shared reading once, however many tiles read it. */
function memo<T>(fn: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= fn());
}

export async function dashboardSections(ctx: ErpContext, godownName: string | null): Promise<Section[]> {
  const has = (k: string) => ctx.screens.has(k);
  const pw = (p: string) => (ctx.powers as ReadonlySet<string>).has(p);
  const inG = (g: unknown) => !godownName || g === godownName;
  const day = today();
  const month = day.slice(0, 7);
  const out: Section[] = [];
  const push = (t: string, tiles: Tile[]) => {
    if (tiles.length) out.push({ t, tiles });
  };
  const lines = memo(orderLines);
  const details = memo(detailRows);

  /* ============================================================ alerts */
  if (has("alerts")) {
    const alerts = await visibleAlerts(ctx.screens, ctx.powers, "open");
    const by = new Map<string, string[]>();
    alerts.forEach((a) => by.set(a.kind, [...(by.get(a.kind) ?? []), a.id]));
    push(
      "Alerts",
      alerts.length
        ? [...by.entries()]
            .sort((a, b) => b[1].length - a[1].length)
            .map(([kind, ids]) => ({ l: ALERT_LABEL[kind as AlertKind] ?? kind, v: String(ids.length), tone: "danger" as Tone, href: tileHref("alerts", ids, ALERT_LABEL[kind as AlertKind] ?? kind) }))
        : [{ l: "Open alerts", v: "0", sub: "nothing unusual found", href: tileHref("alerts", null, "") }],
    );
  }

  /* ========================================================== purchase */
  const purchase: Tile[] = [];
  /* THE PURCHASE FLOW, one tile per step that is waiting on somebody. */
  if (has("requisitions")) {
    const work = await requirementWork(ctx);
    const ids = (stage: string) => (work[stage] ?? []).filter((r) => inG(r.godown)).map((r) => r.id);
    const tile = (stage: string, l: string, sub: string, tone: Tone | undefined, always = false) => {
      const list = ids(stage);
      if (list.length || always) purchase.push({ l, v: String(list.length), sub, tone: list.length ? tone : undefined, href: tileHref("requisitions", list, stage) });
    };
    tile("Buyer decision", "Requirements · buyer decision", pw("purchaseBuyer") ? "you decide how these are bought" : "the buyer decides how these are bought", "brand");
    tile("Select vendor", "Requirements · select vendor", "direct purchases with no vendor yet", "warn", true);
    tile("Collect quotations", "Requirements · collect quotations", "not enough quotations in yet", "warn");
    tile("Compare quotations", "Requirements · compare quotations", "quotations in — select one", "info");
    tile("Ready for PO", "Requirements · ready for PO", "vendor chosen — raise the PO", "brand", true);
    const open = Object.entries(work)
      .filter(([s]) => !["Received", "Cancelled", "Closed", "Closed short"].includes(s) && !s.endsWith("(before POs)"))
      .flatMap(([, r]) => r);
    const reqRows = (await q(sql`select id, priority, required_by::text as by from erp_requisitions`)) as { id: string; priority: string; by: string | null }[];
    const openIds = new Set(open.filter((r) => inG(r.godown)).map((r) => r.id));
    const urgent = reqRows.filter((r) => openIds.has(r.id) && r.priority === "Urgent").map((r) => r.id);
    purchase.push({ l: "Urgent open requirements", v: String(urgent.length), tone: urgent.length ? "danger" : undefined, href: tileHref("requisitions", urgent, "Urgent") });
    const late = reqRows.filter((r) => openIds.has(r.id) && r.by && r.by < day).map((r) => r.id);
    if (late.length) purchase.push({ l: "Requirements past their date", v: String(late.length), sub: "required by a date already gone", tone: "danger", href: tileHref("requisitions", late, "Past its required date") });
  }
  if (has("purchaseOrders")) {
    const pos = (await purchaseOrderViews({ status: ["Pending approval", "Approved", "Sent", "Partly received"] })).filter((p) => inG(p.godown));
    const by = (st: string) => pos.filter((p) => p.po.status === st).map((p) => p.po.id);
    purchase.push({
      l: "POs awaiting approval",
      v: String(by("Pending approval").length),
      sub: pw("approvePurchaseOrder") ? "you approve these" : "the approver decides",
      tone: by("Pending approval").length ? "warn" : undefined,
      href: tileHref("purchaseOrders", by("Pending approval"), "Pending approval"),
    });
    purchase.push({ l: "POs to send to the vendor", v: String(by("Approved").length), sub: "approved, not sent yet", tone: by("Approved").length ? "brand" : undefined, href: tileHref("purchaseOrders", by("Approved"), "Approved") });
    const waiting = pos.filter((p) => ["Approved", "Sent", "Partly received"].includes(p.po.status)).map((p) => p.po.id);
    purchase.push({ l: "POs awaiting delivery", v: String(waiting.length), href: tileHref("purchaseOrders", waiting, "Awaiting delivery") });
    const overdue = pos.filter((p) => ["Approved", "Sent", "Partly received"].includes(p.po.status) && p.po.deliveryDate < day).map((p) => p.po.id);
    if (overdue.length) purchase.push({ l: "PO deliveries overdue", v: String(overdue.length), tone: "danger", href: tileHref("purchaseOrders", overdue, "Delivery overdue") });
    if (pw("viewPurchaseMoney")) {
      const value = pos.filter((p) => p.po.status !== "Pending approval").reduce((a, p) => a + poTotals(p.lines, p.po.freightPaise).totalPaise, 0);
      purchase.push({ l: "Open PO value", v: rupees(value), sub: "approved, not yet fully received", href: tileHref("purchaseOrders", waiting, "Awaiting delivery") });
    }
  }
  if (has("inward")) {
    const ids = (
      await q(sql`
        select i.id, g.name as godown from erp_inward i join erp_godowns g on g.id = i.godown_id
         where (i.testing_required and not exists (select 1 from erp_tests t where t.inward_id = i.id))
            or (not i.testing_required and not exists (select 1 from erp_purchases p where p.inward_id = i.id))`)
    )
      .filter((r) => inG(r.godown))
      .map((r) => String(r.id));
    purchase.push({ l: "Goods received awaiting routing", v: String(ids.length), sub: "no test, or no register row, yet", tone: ids.length ? "warn" : undefined, href: tileHref("inward", ids, "Awaiting routing") });
  }
  if (has("testing")) {
    const ids = (await q(sql`select t.id, g.name as godown from erp_tests t join erp_godowns g on g.id = t.godown_id where t.status <> 'Verified'`)).filter((r) => inG(r.godown)).map((r) => String(r.id));
    purchase.push({ l: "Tests awaiting verification", v: String(ids.length), sub: pw("verifyTest") ? "you verify these" : "the verifier decides", tone: ids.length ? "warn" : undefined, href: tileHref("testing", ids, "Not verified") });
  }
  if (has("register")) {
    const rows = await q(sql`
      select p.id, p.status, p.bill_received as bill, p.rate_paise::float8 as rate, p.quantity::float8 as qty, p.gst_bp as gst,
             p.feed_adjusted_amount_paise::float8 as feed, p.purchase_date::text as date, g.name as godown
        from erp_purchases p join erp_godowns g on g.id = p.godown_id`);
    const noRate = rows.filter((r) => inG(r.godown) && !(Number(r.rate) > 0)).map((r) => String(r.id));
    purchase.push({ l: "Purchases with missing rate", v: String(noRate.length), sub: "not in stock until rated", tone: noRate.length ? "danger" : undefined, href: tileHref("register", noRate, "Rate missing") });
    if (pw("viewPurchaseMoney")) {
      const billless = rows.filter((r) => r.bill !== "Received").map((r) => String(r.id));
      purchase.push({ l: "Bills not received", v: String(billless.length), href: tileHref("register", billless, "Bill not received") });
      for (const st of ["Pending", "Invoice Received", "Purchase Matched", "Purchase Verified"]) {
        const ids = rows.filter((r) => r.status === st).map((r) => String(r.id));
        if (ids.length) purchase.push({ l: `Purchases · ${st}`, v: String(ids.length), href: tileHref("register", ids, st) });
      }
      const thisMonth = rows.filter((r) => String(r.date).startsWith(month) && Number(r.rate) > 0);
      const value = thisMonth.reduce((a, r) => {
        const sub = Number(r.qty) * Number(r.rate);
        return a + Math.round(sub + (sub * Number(r.gst)) / 10000 - Number(r.feed ?? 0));
      }, 0);
      purchase.push({ l: "Purchase value this month", v: rupees(value), sub: `${plural(thisMonth.length, "purchase")}, with GST`, href: tileHref("register", thisMonth.map((r) => String(r.id)), "This month") });
    }
  }
  push("Purchase", purchase);

  /* ============================================================= stock */
  const stock: Tile[] = [];
  const stages: { key: string; label: string; unit: string; load: () => Promise<{ godown: string; stock: number; value: number | null }[]> }[] = [
    { key: "rmStock", label: "Raw material", unit: "", load: async () => (await rmLots()).map((l) => ({ godown: l.godown, stock: l.stock, value: l.ratePaise == null ? null : l.ratePaise * l.stock })) },
    { key: "sfgStock", label: "SFG", unit: "Ltr", load: async () => (await sfgLots()).map((l) => ({ godown: l.godown, stock: l.stock, value: l.ratePaise == null ? null : l.ratePaise * l.stock })) },
    { key: "fgStock", label: "Loose FG", unit: "cans", load: async () => (await fgLots()).map((l) => ({ godown: l.godown, stock: l.stock, value: l.perCanPaise == null ? null : l.perCanPaise * l.stock })) },
    { key: "packStock", label: "Boxed", unit: "boxes", load: async () => (await packLots()).map((l) => ({ godown: l.godown, stock: l.stock, value: l.perBoxPaise == null ? null : l.perBoxPaise * l.stock })) },
  ];
  for (const st of stages) {
    if (!has(st.key)) continue;
    const lots = (await st.load()).filter((l) => l.stock > 0 && inG(l.godown));
    const total = lots.reduce((a, l) => a + l.stock, 0);
    stock.push({ l: `${st.label} lots`, v: String(lots.length), sub: st.unit ? `${nf(total)} ${st.unit}` : `${nf(total)} in stock`, href: tileHref(st.key, null, "") });
    if (pw("viewCost")) {
      const value = lots.reduce((a, l) => a + (l.value ?? 0), 0);
      const unpriced = lots.filter((l) => l.value == null).length;
      stock.push({ l: `${st.label} stock value`, v: rupees(value), sub: unpriced ? `${plural(unpriced, "lot")} without a cost` : "at cost", href: tileHref(st.key, null, "") });
    }
  }
  if (["rmLog", "sfgLog", "fgLog", "packLog"].some(has)) {
    const [{ n }] = await q(sql`
      select (
        (select count(*) from erp_rm_entries e where e.source_type = 'purchase' and not exists (select 1 from erp_purchases p where p.id = e.source_id)) +
        (select count(*) from erp_sfg_entries e where e.source_type = 'sfg' and not exists (select 1 from erp_sfg_lines l where l.id = e.source_id)) +
        (select count(*) from erp_fg_entries e where e.source_type = 'fill' and not exists (select 1 from erp_fg_fills f where f.id = e.source_id)) +
        (select count(*) from erp_pack_entries e where e.source_type = 'batch' and not exists (select 1 from erp_pack_lines l where l.batch_no = e.source_id))
      )::int as n`);
    if (Number(n)) stock.push({ l: "Orphaned inventory entries", v: String(n), sub: "their source document was deleted", tone: "danger", href: tileHref(has("rmLog") ? "rmLog" : "sfgLog", null, "") });
  }
  push("Stock", stock);

  /* ======================================================== production */
  const prod: Tile[] = [];
  if (has("packBatches")) {
    const ids = await incompletePackIds();
    const mine = ids.length ? (await q(sql`select l.id, g.name as godown from erp_pack_lines l join erp_godowns g on g.id = l.godown_id where l.id in ${ids}`)).filter((r) => inG(r.godown)).map((r) => String(r.id)) : [];
    prod.push({ l: "Incomplete packing batches", v: String(mine.length), sub: "boxes not in stock until the cans match", tone: mine.length ? "warn" : undefined, href: tileHref("packBatches", mine, "Incomplete") });
  }
  if (has("sfgBatches") || has("fgFill") || has("packBatches")) {
    const g = godownName;
    for (const [label, since] of [
      ["today", day],
      ["this month", `${month}-01`],
    ] as const) {
      const [p] = await q(sql`
        select
          (select count(distinct sfg_no) from erp_sfg_lines l join erp_godowns w on w.id = l.godown_id where l.batch_date >= ${since} and (${g}::text is null or w.name = ${g}))::int as sfg,
          (select coalesce(sum(total_use - litres_adjusted), 0) from erp_sfg_lines l join erp_godowns w on w.id = l.godown_id where l.batch_date >= ${since} and (${g}::text is null or w.name = ${g}))::float8 as litres,
          (select count(*) from erp_fg_fills f join erp_godowns w on w.id = f.godown_id where f.fill_date >= ${since} and (${g}::text is null or w.name = ${g}))::int as fills,
          (select coalesce(sum(cans - can_adjusted), 0) from erp_fg_fills f join erp_godowns w on w.id = f.godown_id where f.fill_date >= ${since} and (${g}::text is null or w.name = ${g}))::float8 as cans,
          (select count(*) from erp_pack_entries e join erp_godowns w on w.id = e.godown_id where e.source_type = 'batch' and e.entry_date >= ${since} and (${g}::text is null or w.name = ${g}))::int as packs,
          (select coalesce(sum(boxes), 0) from erp_pack_entries e join erp_godowns w on w.id = e.godown_id where e.source_type = 'batch' and e.entry_date >= ${since} and (${g}::text is null or w.name = ${g}))::float8 as boxes`);
      prod.push({
        l: `Production ${label}`,
        v: `${nf(Number(p.litres))} Ltr`,
        sub: `${plural(Number(p.sfg), "SFG batch", "SFG batches")} · ${plural(Number(p.fills), "filling")}, ${nf(Number(p.cans))} cans · ${plural(Number(p.packs), "packing batch", "packing batches")}, ${nf(Number(p.boxes))} boxes`,
        href: tileHref(has("sfgBatches") ? "sfgBatches" : has("fgFill") ? "fgFill" : "packBatches", null, ""),
      });
    }
  }
  if (has("transfers")) {
    const rows = await q(sql`
      select t.id, t.item_type as type, f.name as "from", w.name as "to", w.reserved, t.transfer_date::text as date
        from erp_transfers t join erp_godowns f on f.id = t.from_godown_id join erp_godowns w on w.id = t.to_godown_id`);
    const todays = rows.filter((r) => r.date === day && (inG(r.from) || inG(r.to))).map((r) => String(r.id));
    prod.push({ l: "Transfers today", v: String(todays.length), href: tileHref("transfers", todays, "Today") });
    if (pw("lostStock")) {
      const lost = rows.filter((r) => r.reserved && String(r.date).startsWith(month));
      const byType = new Map<string, number>();
      lost.forEach((r) => byType.set(String(r.type), (byType.get(String(r.type)) ?? 0) + 1));
      prod.push({ l: "Written off this month", v: String(lost.length), sub: [...byType.entries()].map(([t, n]) => `${n} ${t}`).join(" · ") || "nothing written off", tone: lost.length ? "danger" : undefined, href: tileHref("transfers", lost.map((r) => String(r.id)), "Lost this month") });
    }
  }
  if (has("reorderRm")) {
    const rows = (await rmReorderRows()).filter((r) => inG(r.godown));
    prod.push({ l: "Raw items to re-order", v: String(rows.length), sub: "followed items below their level", tone: rows.length ? "danger" : undefined, href: tileHref("reorderRm", null, "") });
  }
  if (has("reorderFg")) {
    const rows = (await fgReorderRows()).filter((r) => inG(r.godown));
    prod.push({ l: "Finished goods below minimum", v: String(rows.length), tone: rows.length ? "danger" : undefined, href: tileHref("reorderFg", null, "") });
  }
  push("Production and re-order", prod);

  /* ============================================================= sales */
  const sales: Tile[] = [];
  if (["orders", "pendingOrders", "readyOrders", "labels"].some(has)) {
    const ls = await lines();
    const open = ls.filter((l) => !l.inDetails && inG(l.godown));
    if (has("orders"))
      for (const st of ORDER_STATUSES) {
        const ids = open.filter((l) => l.o.status === st).map((l) => l.o.id);
        if (ids.length) sales.push({ l: `Orders · ${st}`, v: String(ids.length), href: tileHref("orders", ids, st) });
      }
    const ready = open.filter((l) => l.o.status === "Ready" && l.o.entryStatus !== "Done");
    const short = ready.filter((l) => l.allocation === "Add More Quantity").map((l) => l.o.id);
    const toBill = ready.filter((l) => l.allocation === "Done").map((l) => l.o.id);
    /* The planned dispatch date, said as today and late — never a status. */
    const dueToday = open.filter((l) => l.due === "today").map((l) => l.o.id);
    const late = open.filter((l) => l.due === "late").map((l) => l.o.id);
    const screen = has("readyOrders") ? "readyOrders" : "orders";
    sales.push({ l: "Allocation short", v: String(short.length), sub: "Ready, lots still to allocate", tone: short.length ? "warn" : undefined, href: tileHref(screen, short, "Allocation short") });
    sales.push({ l: "Ready to bill", v: String(toBill.length), sub: "Ready and allocated — Bill it once the bill no. and rate are in", href: tileHref(screen, toBill, "Ready to bill") });
    sales.push({ l: "Dispatch today", v: String(dueToday.length), sub: "planned for today", href: tileHref("orders", dueToday, "Dispatch today") });
    sales.push({ l: "Dispatch late", v: String(late.length), sub: "planned for a day already past", tone: late.length ? "danger" : undefined, href: tileHref("orders", late, "Dispatch late") });
    const missing = ls.filter((l) => l.o.status !== "Cancel" && (!l.o.tallyBillNo || l.o.ratePaise == null)).map((l) => l.o.id);
    sales.push({ l: "Missing bill no / rate", v: String(missing.length), tone: missing.length ? "warn" : undefined, href: tileHref("orders", missing, "Bill or rate missing") });
    if (pw("approveParty")) {
      const pend = ls.filter((l) => l.o.partyStatus === "Pending").map((l) => l.o.id);
      sales.push({ l: "Pending-customer orders", v: String(pend.length), sub: "approve, or activate the party", tone: pend.length ? "warn" : undefined, href: tileHref("orders", pend, "Pending party") });
    }
    if (has("labels")) {
      const labels = ls.filter((l) => (l.o.status === "Ready" || l.o.status === "Under Process") && l.o.entryStatus !== "Done" && inG(l.godown));
      sales.push({ l: "Labels to print", v: nf(labels.reduce((a, l) => a + l.labels, 0)), sub: plural(labels.length, "line"), href: tileHref("labels", null, "") });
    }
  }
  if (has("orderDetails")) {
    const { rows } = await details();
    const mine = rows.filter((r) => inG(r.l.godown));
    const unverified = mine.filter((r) => !r.d.verification || r.d.verification === "Pending").map((r) => r.l.o.id);
    sales.push({ l: "Awaiting dispatch verification", v: String(unverified.length), sub: "enter the dispatch date once it has left", tone: unverified.length ? "warn" : undefined, href: tileHref("orderDetails", unverified, "Not verified") });
    const dispatched = mine.filter((r) => r.d.verification === "Verified");
    const todayIds = dispatched.filter((r) => r.d.dispatchDate === day).map((r) => r.l.o.id);
    const monthRows = dispatched.filter((r) => (r.d.dispatchDate ?? "").startsWith(month));
    sales.push({ l: "Dispatched today", v: String(todayIds.length), href: tileHref("orderDetails", todayIds, "Dispatched today") });
    sales.push({ l: "Dispatched this month", v: String(monthRows.length), href: tileHref("orderDetails", monthRows.map((r) => r.l.o.id), "Dispatched this month") });
    if (pw("viewSalesAmounts")) {
      const amount = monthRows.reduce((a, r) => a + (r.amount ?? 0), 0);
      const final = monthRows.reduce((a, r) => a + (r.final ?? 0), 0);
      sales.push({ l: "Sales value this month", v: rupees(amount), sub: `${rupees(final)} with GST and freight`, href: tileHref("orderDetails", monthRows.map((r) => r.l.o.id), "Sales this month") });
    }
    if (pw("viewCost")) {
      const known = monthRows.filter((r) => r.margin != null);
      const m = known.reduce((a, r) => a + (r.margin ?? 0), 0);
      sales.push({ l: "Margin this month", v: rupees(m), sub: known.length < monthRows.length ? `${plural(monthRows.length - known.length, "line")} without a cost` : "after lot costing and credit notes", tone: m < 0 ? "danger" : undefined, href: tileHref("orderDetails", monthRows.map((r) => r.l.o.id), "Margin this month") });
    }
  }
  push("Sales", sales);

  /* ========================================================= logistics */
  const logistics: Tile[] = [];
  if (has("paidFreight")) {
    const { rows } = await details();
    const n = rows.filter((r) => r.l.billing.freightTerm === "Paid" && r.d.extraExpensesPaise == null).length;
    logistics.push({ l: "Paid freight without extra expense", v: String(n), href: tileHref("paidFreight", null, "") });
  }
  if (["pendingLr", "trackLr", "transport"].some(has)) {
    const rows = await q(sql`select id, lr_no as lr, track_status as track, material_stage as stage, reminder_date::text as reminder from erp_transports`);
    if (has("pendingLr")) {
      const n = rows.filter((r) => !r.lr).length;
      logistics.push({ l: "Pending LR", v: String(n), tone: n ? "warn" : undefined, href: tileHref("pendingLr", null, "") });
    }
    if (has("trackLr")) {
      const by = new Map<string, string[]>();
      rows.filter((r) => r.lr && r.stage !== "Close - Received to Party").forEach((r) => by.set(String(r.stage), [...(by.get(String(r.stage)) ?? []), String(r.id)]));
      for (const [stage, ids] of by) logistics.push({ l: `Tracking · ${stage}`, v: String(ids.length), href: tileHref("trackLr", ids, stage) });
    }
    if (has("transport")) {
      const due = rows.filter((r) => r.reminder && String(r.reminder) <= day && r.stage !== "Close - Received to Party").map((r) => String(r.id));
      logistics.push({ l: "Reminder calls due", v: String(due.length), tone: due.length ? "warn" : undefined, href: tileHref("transport", due, "Reminder due") });
    }
  }
  push("Logistics", logistics);

  /* ========================================================== requests */
  const req: Tile[] = [];
  if (["requests", "issueCn"].some(has)) {
    /* The CRM's complaints — one record, whichever app raised it. */
    const rows = (await q(sql`select id, status, cn_status as "cnStatus", request_cn as cn, created_at as raised, resolved_at as resolved from complaints`)).map((r) => ({ id: r.id, cn: r.cn, raised: r.raised, resolved: r.resolved, word: requestStatus({ status: String(r.status), cnStatus: (r.cnStatus as string | null) ?? null }) }));
    if (has("requests"))
      for (const st of ["Requested", "Accepted", "Rejected"] as const) {
        const ids = rows.filter((r) => r.word === st).map((r) => String(r.id));
        req.push({ l: `Complaints · ${st}`, v: String(ids.length), tone: st === "Requested" && ids.length ? "warn" : undefined, href: tileHref("requests", ids, st) });
      }
    if (has("issueCn")) {
      const ids = rows.filter((r) => r.word === "Accepted" && r.cn).map((r) => String(r.id));
      req.push({ l: "Credit notes to issue", v: String(ids.length), tone: ids.length ? "warn" : undefined, href: tileHref("issueCn", ids, "To issue") });
    }
    if (has("requests")) {
      const resolved = rows.filter((r) => r.resolved && calendarDate(asDate(r.resolved)).startsWith(month));
      const hours = resolved.map((r) => (asDate(r.resolved).getTime() - asDate(r.raised).getTime()) / 3600000);
      const avg = hours.length ? hours.reduce((a, h) => a + h, 0) / hours.length : null;
      req.push({ l: "Average response time", v: avg == null ? "—" : avg < 48 ? `${Math.round(avg)} h` : `${Math.round(avg / 24)} days`, sub: `${plural(resolved.length, "request")} resolved this month`, href: tileHref("requests", resolved.map((r) => String(r.id)), "Resolved this month") });
    }
  }
  push("Requests and credit notes", req);

  /* ======================================================== petty cash */
  if (has("expenses") || has("credits")) {
    const [credits, expenses] = await Promise.all([
      q(sql`select c.employee_name as who, g.name as godown, c.mode, c.amount_paise::float8 as amount from erp_credits c join erp_godowns g on g.id = c.godown_id`),
      q(sql`select e.id, e.expense_by as who, g.name as godown, e.mode, e.amount_paise::float8 as amount, e.status from erp_expenses e join erp_godowns g on g.id = e.godown_id`),
    ]);
    /* Everyone's with the Expenses screen; otherwise the person's own (spec §13.6). */
    const everyone = has("expenses");
    const mine = (who: unknown) => everyone || String(who).trim().toLowerCase() === ctx.user.name.trim().toLowerCase();
    const place = new Map<string, number>();
    for (const c of credits) if (mine(c.who) && inG(c.godown)) place.set(`${c.godown} · ${c.mode}`, (place.get(`${c.godown} · ${c.mode}`) ?? 0) + Number(c.amount));
    for (const e of expenses) if (mine(e.who) && inG(e.godown)) place.set(`${e.godown} · ${e.mode}`, (place.get(`${e.godown} · ${e.mode}`) ?? 0) - Number(e.amount));
    const tiles: Tile[] = [...place.entries()].map(([k, v]) => ({ l: `Petty cash · ${k}`, v: rupees(v), sub: everyone ? "everyone's balance" : "your balance", tone: v < 0 ? "danger" : undefined, href: tileHref(has("expenses") ? "expenses" : "credits", null, "") }));
    if (has("expenses")) {
      const pend = expenses.filter((e) => e.status === "Pending").map((e) => String(e.id));
      tiles.push({ l: "Expenses pending verification", v: String(pend.length), href: tileHref("expenses", pend, "Pending") });
    }
    push("Petty cash", tiles);
  }

  /* ========================================================= customers */
  const cust: Tile[] = [];
  if (has("customers") && pw("customerStatus")) {
    const pending = (await loadCustomers()).filter((c) => partyStatus(c) === "Pending");
    cust.push({ l: "Customers pending activation", v: String(pending.length), sub: "an admin activates them", tone: pending.length ? "warn" : undefined, href: tileHref("customers", pending.map((c) => c.id), "Pending") });
  }
  if (has("myCustomers")) {
    const mine = await loadCustomers(or(eq(customers.salesAmId, ctx.user.id), sql`lower(${customers.salesPersonName}) = lower(${ctx.user.name})`));
    const { rows } = await details();
    const mid = monthId(day);
    const withTarget = mine.filter((c) => (c.monthlyTargetPaise ?? 0) > 0);
    const reached = withTarget.filter((c) =>
      targetReached(
        rows.filter((r) => r.l.o.billingCustomerId === c.id && r.monthId === mid).reduce((a, r) => a + (r.amount ?? 0), 0),
        c.monthlyTargetPaise,
      ),
    );
    cust.push({ l: "My customers at target", v: `${reached.length} of ${withTarget.length}`, sub: `this month · ${plural(mine.length, "customer")} tagged to you`, href: tileHref("myCustomers", null, "") });
  }
  push("Customers", cust);

  return out;
}

/** The owner's paragraph for yesterday, if the nightly pass has written it. */
export async function latestDigest(): Promise<{ day: string; text: string; servedBy: string | null } | null> {
  const rows = await q(sql`select day::text as day, text, served_by as "servedBy" from erp_digests order by day desc limit 1`);
  return rows[0] ? { day: String(rows[0].day), text: String(rows[0].text), servedBy: (rows[0].servedBy as string) ?? null } : null;
}
