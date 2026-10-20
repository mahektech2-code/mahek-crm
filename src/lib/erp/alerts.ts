import "server-only";
import { inArray, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { erpAlerts } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { erpId } from "./server";
import { purchaseFigures } from "./engines/purchase";
import { batchState } from "./engines/production";
import {
  belowLevel,
  drumVariances,
  cashNegative,
  cnsNotIssued,
  duplicateExpenses,
  fillLosses,
  lrsMissing,
  packsStuck,
  rateJumps,
  ratesMissing,
  readyUnbilled,
  sfgLosses,
  slowFulfilment,
  testsStuck,
  thinMargins,
  writeOffs,
  type Candidate,
  type Thresholds,
} from "./engines/alerts";
import { today } from "./screens/common";
import { fgReorderRows, rmReorderRows } from "./screens/movement";
import { detailRows, orderLines } from "./screens/sales";
import { shiftDays } from "./period";
import type { LoadScope } from "./window";

/* ---------------------------------------------------------------------------
 * AI-4, the running half: read the facts, apply the rules in
 * `engines/alerts.ts`, raise what is new and resolve what has cleared.
 *
 * An alert is resolved AUTOMATICALLY when its condition no longer holds — a
 * rate entered, an LR recorded — and never re-raised while it is open or
 * acknowledged, which the partial unique index on (kind, subject) enforces.
 * ------------------------------------------------------------------------- */

type Row = Record<string, unknown>;
const q = async <T = Row>(s: ReturnType<typeof sql>) => (await db.execute(s)) as unknown as T[];
const asDate = (v: unknown) => (v instanceof Date ? v : new Date(String(v)));

export async function thresholds(): Promise<Thresholds & { enabled: boolean }> {
  const c = await getConfig();
  return {
    enabled: c["erp.ai.alerts.enabled"],
    rateJumpPct: c["erp.ai.alerts.rateJumpPct"],
    rateLookback: c["erp.ai.alerts.rateLookback"],
    rateMissingDays: c["erp.ai.alerts.rateMissingDays"],
    sfgLossPct: c["erp.ai.alerts.sfgLossPct"],
    fillLossPct: c["erp.ai.alerts.fillLossPct"],
    writeOffCount: c["erp.ai.alerts.writeOffCount"],
    writeOffDays: c["erp.ai.alerts.writeOffDays"],
    marginPct: c["erp.ai.alerts.marginPct"],
    fulfilDays: c["erp.ai.alerts.fulfilDays"],
    readyUnbilledHours: c["erp.ai.alerts.readyUnbilledHours"],
    stuckTestHours: c["erp.ai.alerts.stuckTestHours"],
    stuckLrDays: c["erp.ai.alerts.stuckLrDays"],
    stuckCnDays: c["erp.ai.alerts.stuckCnDays"],
    stuckPackDays: c["erp.ai.alerts.stuckPackDays"],
    duplicateExpenseDays: c["erp.ai.alerts.duplicateExpenseDays"],
  };
}

/**
 * Every alert condition that holds right now — read through the lookback.
 *
 * An alert is news: a rate that just jumped, a batch that just lost too much,
 * an order that took too long to go. So the pass reads what happened inside
 * `erp.ai.alerts.lookbackDays` and nothing older; it used to read every
 * purchase, SFG line, fill and billed line there has ever been, which on the
 * imported history raised 237 "rate jumps" from 2024 and held the whole of it
 * in memory once an hour. What is STILL STUCK is read by state instead, however
 * old: an undecided test, a bill without its LR, an incomplete packing batch, a
 * credit note not issued. An alert whose subject falls out of the lookback
 * resolves on the next pass, because it is no longer a candidate.
 */
export async function currentCandidates(t: Thresholds, now = new Date()): Promise<Candidate[]> {
  const day = today();
  const lookback = (await getConfig())["erp.ai.alerts.lookbackDays"];
  const since = shiftDays(day, -lookback);
  const recentScope: LoadScope = { pd: `c:${since}:${day}`, window: { from: since, to: day }, ids: null, open: null };
  const [purchases, sfg, fills, lost, packs, tests, details, lines, transports, reqs, moneyAccts, expenses, rmRe, fgRe] = await Promise.all([
    /* This lookback's purchases, the rateless ones whatever their age, and — so a
       jump has something to be measured against — the `rateLookback` purchases
       of the same item from the same supplier before the lookback began. */
    q(sql`
      with p as (
        select p.*, row_number() over (partition by p.raw_material_id, p.supplier_id order by p.purchase_date desc, p.created_at desc) as rn
          from erp_purchases p where p.purchase_date < ${since}::date
      )
      select x.id, m.name as item, x.raw_material_id as "itemId", s.name as supplier, x.supplier_id as "supplierId", x.lot_no as lot,
             x.purchase_date::text as date, x.created_at as "createdAt", x.rate_paise::float8 as rate, x.unit, x.density::float8 as density, x.quantity::float8 as qty,
             x.recent
        from (
          select id, raw_material_id, supplier_id, lot_no, purchase_date, created_at, rate_paise, unit, density, quantity, true as recent
            from erp_purchases where purchase_date >= ${since}::date or rate_paise is null or rate_paise <= 0
          union all
          select id, raw_material_id, supplier_id, lot_no, purchase_date, created_at, rate_paise, unit, density, quantity, false
            from p where rn <= ${t.rateLookback} and rate_paise > 0
        ) x
        join erp_raw_materials m on m.id = x.raw_material_id join erp_suppliers s on s.id = x.supplier_id`),
    q(sql`select l.id, l.sfg_no as "sfgNo", f.name as product, l.total_use::float8 as "totalUse", l.litres_adjusted::float8 as adjusted
            from erp_sfg_lines l join product_formulations f on f.id = l.formulation_id where l.batch_date >= ${since}::date`),
    q(sql`select f.id, f.lot_code as lot, fg.name as product, f.cans, f.can_adjusted as adjusted
            from erp_fg_fills f join finished_goods fg on fg.id = f.finished_good_id where f.fill_date >= ${since}::date`),
    q(sql`
      select t.id, t.transfer_date::text as date, coalesce(u.name, 'Unknown') as by, g.name as "fromGodown"
        from erp_transfers t join erp_godowns r on r.id = t.to_godown_id and r.reserved
        join erp_godowns g on g.id = t.from_godown_id left join users u on u.id = t.created_by_id
       where t.transfer_date >= ${shiftDays(day, -Math.max(lookback, t.writeOffDays))}::date`),
    /* Only the batches that are not complete: a complete batch can never be stuck. */
    q(sql`
      select l.id, l.batch_no as "batchNo", l.pack_date::text as date, l.boxes, l.cans, p.cans_per_box as cpb
        from erp_pack_lines l join products p on p.id = l.sku_id
       where l.batch_no in (
         select l2.batch_no from erp_pack_lines l2 join products p2 on p2.id = l2.sku_id
          group by l2.batch_no having sum(l2.cans) <> max(l2.boxes) * max(p2.cans_per_box))`),
    q(sql`select t.id, t.pr_number as pr, m.name as item, t.created_at as "createdAt", t.decided_at is not null as decided
            from erp_tests t join erp_raw_materials m on m.id = t.raw_material_id where t.decided_at is null`),
    detailRows({ window: { scope: recentScope, on: "dispatch" } }),
    orderLines({ openWork: true }),
    q(sql`select t.id, t.bill_no as "billNo", c.name as party, t.bill_date::text as "billDate", t.lr_no as lr
            from erp_transports t join customers c on c.id = t.billing_customer_id where coalesce(t.lr_no, '') = ''`),
    /* Accepted = the complaint moved to in_progress; when is its status history. */
    q(sql`select r.id, c.name as party,
                 (select min(h.at) from complaint_status_history h where h.complaint_id = r.id and h.to_status = 'in_progress') as "approvedAt",
                 r.cn_status = 'issued' as issued, r.status = 'in_progress' as accepted, r.request_cn as cn
            from complaints r join customers c on c.id = r.customer_id
           where r.category = 'product_quality' and r.request_cn and r.status = 'in_progress' and r.cn_status is distinct from 'issued'`),
    /* Petty Cash: each account's balance is summed in SQL, the opening plus every live leg. */
    q(sql`select a.id, a.name, a.kind, (a.opening_paise + coalesce((select sum(case when t.to_account_id = a.id then t.amount_paise else -t.amount_paise end) from erp_money_txns t
              where t.status = 'active' and (t.from_account_id = a.id or t.to_account_id = a.id)), 0))::float8 as balance
            from erp_money_accounts a where a.active`),
    q(sql`select t.id, coalesce(t.payee, '') as by, t.amount_paise::float8 as amount, t.category as particular, t.txn_date::text as date
            from erp_money_txns t where t.kind = 'expense' and t.status = 'active' and not t.duplicate_override and t.txn_date >= ${since}::date`),
    rmReorderRows(),
    fgReorderRows(),
  ]);
  const drumConfig = await getConfig();
  const drums = await q(sql`
    select d.id, d.drum_no as no, s.name as supplier, d.lot_no as lot, d.declared_tare_kg::float8 as declared, d.actual_kg::float8 as actual
      from erp_empty_drums d left join erp_suppliers s on s.id = d.supplier_id
     where d.status <> 'cancelled' and d.declared_tare_kg is not null and d.actual_kg is not null`);

  const purchaseFacts = purchases.map((p) => ({
    id: String(p.id),
    item: String(p.item),
    itemId: String(p.itemId),
    supplier: String(p.supplier),
    supplierId: String(p.supplierId),
    date: String(p.date),
    createdAt: asDate(p.createdAt),
    litreRatePaise: purchaseFigures({ quantity: Number(p.qty), unit: String(p.unit), ratePaise: p.rate == null ? null : Number(p.rate), density: p.density == null ? null : Number(p.density), feedAdjustedLitre: 0, feedAdjustedAmountPaise: 0, gstBp: 0, drums: null }).literRatePaise,
  }));

  const recentIds = new Set(purchases.filter((p) => p.recent && String(p.date) >= since).map((p) => String(p.id)));

  const batches = new Map<string, { batchNo: string; ids: string[]; date: string; boxes: number; cpb: number; cans: { id: string; cans: number }[] }>();
  for (const p of packs) {
    const k = String(p.batchNo);
    const b = batches.get(k) ?? { batchNo: k, ids: [], date: String(p.date), boxes: Number(p.boxes), cpb: Number(p.cpb), cans: [] };
    b.ids.push(String(p.id));
    b.cans.push({ id: String(p.id), cans: Number(p.cans) });
    batches.set(k, b);
  }

  return [
    /* Measured against the older purchases, raised only on this lookback's. */
    ...rateJumps(purchaseFacts, t).filter((c) => recentIds.has(c.subject)),
    ...ratesMissing(purchases.filter((p) => p.recent).map((p) => ({ id: String(p.id), item: String(p.item), lot: String(p.lot), date: String(p.date), ratePaise: p.rate == null ? null : Number(p.rate) })), day, t),
    ...sfgLosses(sfg.map((l) => ({ id: String(l.id), sfgNo: Number(l.sfgNo), product: String(l.product), totalUse: Number(l.totalUse), adjusted: Number(l.adjusted) })), t),
    ...fillLosses(fills.map((f) => ({ id: String(f.id), lot: String(f.lot), product: String(f.product), cans: Number(f.cans), adjusted: Number(f.adjusted) })), t),
    ...writeOffs(lost.map((x) => ({ id: String(x.id), date: String(x.date), by: String(x.by), fromGodown: String(x.fromGodown) })), day, t),
    ...packsStuck([...batches.values()].map((b) => ({ batchNo: b.batchNo, ids: b.ids, date: b.date, remaining: batchState(b.boxes, b.cpb, b.cans).remaining })), day, t),
    ...testsStuck(tests.map((x) => ({ id: String(x.id), pr: Number(x.pr), item: String(x.item), createdAt: asDate(x.createdAt), decided: Boolean(x.decided) })), now, t),
    ...thinMargins(details.rows.map((r) => ({ id: r.l.o.id, orderNo: r.l.o.orderNo, party: r.l.billing.name, orderDate: r.l.o.orderDate, dispatchDate: r.d.dispatchDate, amountPaise: r.amount, marginPaise: r.margin })), t),
    ...slowFulfilment(details.rows.map((r) => ({ id: r.l.o.id, orderNo: r.l.o.orderNo, party: r.l.billing.name, orderDate: r.l.o.orderDate, dispatchDate: r.d.dispatchDate, amountPaise: r.amount, marginPaise: r.margin })), t),
    /* "Ready since" is the line's last change: the ERP does not stamp the move to Ready on its own. */
    ...readyUnbilled(lines.map((l) => ({ id: l.o.id, orderNo: l.o.orderNo, party: l.billing.name, readySince: l.o.updatedAt, allocatedInFull: l.allocation === "Done", billed: !!l.o.tallyBillNo, ready: l.o.status === "Ready" && !l.inDetails })), now, t),
    ...lrsMissing(transports.map((x) => ({ id: String(x.id), billNo: (x.billNo as string) ?? null, party: String(x.party), billDate: (x.billDate as string) ?? null, lr: (x.lr as string) ?? null })), day, t),
    ...cnsNotIssued(reqs.map((r) => ({ id: String(r.id), party: String(r.party), approvedAt: r.approvedAt ? asDate(r.approvedAt) : null, issued: Boolean(r.issued), accepted: Boolean(r.accepted), cn: Boolean(r.cn) })), now, t),
    ...duplicateExpenses(expenses.filter((e) => String(e.by)).map((e) => ({ id: String(e.id), by: String(e.by), amountPaise: Number(e.amount), particular: (e.particular as string) ?? null, date: String(e.date) })), t),
    ...cashNegative(moneyAccts.filter((a) => a.kind !== "bank").map((a) => ({ id: String(a.id), name: String(a.name), balancePaise: Number(a.balance) }))),
    ...drumVariances(
      drums.map((d) => ({ id: String(d.id), label: `DRM-${d.no}`, supplier: String(d.supplier ?? "the supplier"), lot: String(d.lot ?? ""), declaredKg: Number(d.declared), actualKg: Number(d.actual) })),
      { alertKg: drumConfig["erp.drums.varianceAlertKg"], alertPercent: drumConfig["erp.drums.varianceAlertPercent"] },
    ),
    ...belowLevel([
      ...rmRe.map((r) => ({ id: r.id, screen: "reorderRm" as const, item: r.item, godown: r.godown, available: r.available ?? 0, min: r.min })),
      ...fgRe.map((r) => ({ id: r.id, screen: "reorderFg" as const, item: r.sku, godown: r.godown, available: r.available, min: r.min })),
    ]),
  ];
}

/** Raises what is new, resolves what has cleared. Returns how many of each. */
export async function runErpAlerts(now = new Date()): Promise<{ raised: number; resolved: number; open: number; skipped?: string }> {
  const t = await thresholds();
  if (!t.enabled) return { raised: 0, resolved: 0, open: 0, skipped: "alerts are switched off" };
  const candidates = await currentCandidates(t, now);
  const live = new Set(candidates.map((c) => `${c.kind}|${c.subject}`));
  let raised = 0;
  let resolved = 0;
  const newlyLow: Candidate[] = [];
  await db.transaction(async (tx) => {
    const open = await tx.select({ id: erpAlerts.id, kind: erpAlerts.kind, subject: erpAlerts.subject }).from(erpAlerts).where(ne(erpAlerts.status, "Resolved"));
    const openKeys = new Set(open.map((a) => `${a.kind}|${a.subject}`));
    const cleared = open.filter((a) => !live.has(`${a.kind}|${a.subject}`)).map((a) => a.id);
    if (cleared.length) {
      await tx.update(erpAlerts).set({ status: "Resolved", resolvedAt: now, resolveReason: "Condition cleared" }).where(inArray(erpAlerts.id, cleared));
      resolved = cleared.length;
    }
    for (const c of candidates) {
      if (openKeys.has(`${c.kind}|${c.subject}`)) continue;
      const ins = await tx
        .insert(erpAlerts)
        .values({ id: erpId("alert"), kind: c.kind, subject: c.subject, screen: c.screen, recordIds: c.recordIds, power: c.power ?? null, values: c.values, explanation: c.explanation, raisedAt: now })
        .onConflictDoNothing()
        .returning({ id: erpAlerts.id });
      raised += ins.length;
      if (ins.length && c.kind === "belowLevel") newlyLow.push(c);
    }
  });
  await tellRequisitioners(newlyLow);
  const [{ n }] = await q<{ n: number }>(sql`select count(*)::int as n from erp_alerts where status <> 'Resolved'`);
  return { raised, resolved, open: Number(n) };
}

/**
 * A NEW LOW-STOCK ALERT REACHES THE PEOPLE WHO WOULD RAISE THE REQUISITION.
 * The alert sits on the Alerts screen either way; waiting for somebody to open
 * it is how an item runs out. So whoever works at that godown and can raise a
 * requisition is told once, when the alert is raised — not on every run while
 * it stays open. Nobody assigned to the godown means nobody is told, and the
 * alert is still there to be found.
 */
async function tellRequisitioners(alerts: Candidate[]): Promise<void> {
  if (!alerts.length) return;
  const people = await q<{ userId: string; godown: string }>(sql`
    select s.user_id as "userId", g.name as godown
      from erp_godown_staff s
      join erp_godowns g on g.id = s.godown_id
      join app_access a on a.user_id = s.user_id and a.app::text = 'erp'
      join users u on u.id = s.user_id and u.active
     where not exists (select 1 from app_module_access m where m.user_id = s.user_id and m.app::text = 'erp')
        or exists (select 1 from app_module_access m where m.user_id = s.user_id and m.module = 'erp.requisitions')
  `);
  const { notifyUsers } = await import("@/lib/notify");
  const { erpLink } = await import("./registry");
  const entries = alerts.flatMap((a) =>
    people
      .filter((p) => p.godown === a.values.godown)
      .map((p) => ({
        userId: p.userId,
        title: `Below re-order level: ${String(a.values.item)}`,
        body: `${a.explanation} Raise a requisition from the levels list.`,
        kind: "warn" as const,
        href: erpLink(a.screen, { f: a.recordIds.join(","), fl: "Below minimum" }),
      })),
  );
  await notifyUsers(entries);
}

/** Open alerts a person may see: they hold the alert's screen, and its power where it has one. */
export async function visibleAlerts(screens: ReadonlySet<string>, powers: ReadonlySet<string>, status?: "open") {
  const rows = await db
    .select()
    .from(erpAlerts)
    .where(status === "open" ? ne(erpAlerts.status, "Resolved") : undefined)
    .orderBy(sql`${erpAlerts.raisedAt} desc`);
  return rows.filter((a) => screens.has(a.screen) && (!a.power || powers.has(a.power)));
}

