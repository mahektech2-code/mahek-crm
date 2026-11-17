import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { journeyOf, type ErpOrderFacts, type IntakeFacts, type Journey } from "@/lib/order-journey";

/* ---------------------------------------------------------------------------
 * THE FACTS BEHIND AN ORDER'S JOURNEY, read once for a page of orders. The
 * words are `lib/order-journey.ts`'s; this only fetches. An `orders` row is the
 * unit (it is what the Call Log, the record and the handset already list):
 * its TO is the intake that names it (`origin_order_id`), or — for a TO taken
 * in the ERP — the intake whose order number the book row is (`ERP-<n>`).
 * ------------------------------------------------------------------------- */

export type OrderRow = {
  id: string;
  customerId: string;
  customerName: string;
  userId: string | null;
  takenBy: string | null;
  status: string;
  orderedAt: string;
  /** When it was really taken: the TO's own stamp where there is one (a CRM order's `orderedAt` is 09:00 filler). */
  takenAt: string;
  approvedAt: string | null;
  declineReason: string | null;
  totalPaise: number;
  /** "Nano Thinner - 20 Liter (Loose) × 6", one per line. */
  lines: { product: string; cans: number }[];
  litres: number | null;
  source: string;
  intakeId: string | null;
  journey: Journey;
};

/** `in (…)`: a bare array interpolated into a template is a row, not an array. */
const list = (xs: (string | number)[]) => sql.join(xs.map((x) => sql`${x}`), sql`, `);

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

type Base = {
  id: string;
  customerId: string;
  customerName: string;
  userId: string | null;
  takenBy: string | null;
  status: string;
  orderedAt: string;
  approvedAt: string | null;
  declineReason: string | null;
  totalPaise: string | number;
  lineItems: { product: string; quantity: number }[] | null;
  source: string;
  externalRef: string | null;
};

async function readBase(where: SQL, limit: number): Promise<Base[]> {
  return (await db.execute(sql`
    select o.id, o.customer_id as "customerId", c.name as "customerName", o.user_id as "userId", u.name as "takenBy",
           o.status::text as status, o.ordered_at as "orderedAt", o.approved_at as "approvedAt", o.decline_reason as "declineReason",
           o.total_amount as "totalPaise", o.line_items as "lineItems", o.source::text as source, o.external_ref as "externalRef"
      from orders o
      join customers c on c.id = o.customer_id
      left join users u on u.id = o.user_id
     where ${where}
     order by o.ordered_at desc, o.id desc
     limit ${limit}`)) as unknown as Base[];
}

/** Every journey fact for a set of `orders` rows. */
async function assemble(base: Base[]): Promise<OrderRow[]> {
  if (!base.length) return [];
  const ids = base.map((b) => b.id);
  const bookNos = base.map((b) => (b.externalRef?.startsWith("ERP-") ? Number(b.externalRef.slice(4)) : null)).filter((n): n is number => n != null && Number.isFinite(n));
  const intakes = (await db.execute(sql`
    select i.id, i.to_no as "toNo", i.status, i.origin_order_id as "originOrderId", i.order_no as "orderNo",
           i.created_at as "takenAt", tk.name as "takenBy",
           i.back_office_at as "backOfficeAt", bo.name as "backOfficeBy",
           i.production_at as "productionAt", pr.name as "productionBy",
           i.correction_at as "correctionAt", i.correction_note as "correctionNote",
           i.held_at as "heldAt", i.hold_reason as "holdReason",
           i.cancelled_at as "cancelledAt", i.cancel_reason as "cancelReason",
           i.declined_at as "declinedAt", i.decline_reason as "declineReason", dc.name as "declinedBy",
           i.duplicate_state as "duplicateState", dup.to_no as "duplicateOfToNo", i.duplicate_reason as "duplicateReason",
           i.origin,
           (select json_agg(json_build_object('product', p.name, 'cans', l.qty_cans,
                    'litres', l.qty_cans * coalesce(p.millilitres_per_can, fg.millilitres)::float8 / 1000) order by l.position)
              from erp_order_intake_lines l join products p on p.id = l.sku_id
              left join finished_goods fg on fg.id = p.finished_good_id where l.intake_id = i.id) as lines
      from erp_order_intakes i
      left join users tk on tk.id = i.taken_by_id
      left join users bo on bo.id = i.back_office_by_id
      left join users pr on pr.id = i.production_by_id
      left join users dc on dc.id = i.declined_by_id
      left join erp_order_intakes dup on dup.id = i.duplicate_of_id
     where i.origin_order_id in (${list(ids)})
        ${bookNos.length ? sql`or i.order_no in (${list(bookNos)})` : sql``}`)) as unknown as Record<string, unknown>[];
  const intakeFor = new Map<string, Record<string, unknown>>();
  for (const i of intakes) {
    if (i.originOrderId) intakeFor.set(`o:${i.originOrderId}`, i);
    if (i.orderNo != null) intakeFor.set(`n:${i.orderNo}`, i);
  }
  const orderNoOf = (b: Base): number | null => {
    const i = intakeFor.get(`o:${b.id}`) ?? null;
    if (i?.orderNo != null) return Number(i.orderNo);
    return b.externalRef?.startsWith("ERP-") ? Number(b.externalRef.slice(4)) : null;
  };
  const nos = [...new Set(base.map(orderNoOf).filter((n): n is number => n != null && Number.isFinite(n)))];
  const erp = new Map<number, ErpOrderFacts>();
  if (nos.length) {
    const agg = (await db.execute(sql`
      select o.order_no as "orderNo",
             case when bool_or(o.accounts_check = 'Declined') then 'Declined' when bool_or(o.accounts_check = 'Hold') then 'Hold'
                  when bool_or(o.accounts_check = 'Pending') then 'Pending' else 'Approved' end as "accountsCheck",
             max(o.accounts_checked_at) as "accountsAt", max(au.name) as "accountsBy",
             case when bool_or(o.production_check = 'Hold') then 'Hold' when bool_or(o.production_check = 'Pending') then 'Pending' else 'Cleared' end as "productionCheck",
             max(o.production_checked_at) as "productionAt", max(pu.name) as "productionBy",
             bool_and(o.status = 'Cancel') as cancelled
        from erp_orders o
        left join users au on au.id = o.accounts_checked_by_id
        left join users pu on pu.id = o.production_checked_by_id
       where o.order_no in (${list(nos)}) and o.source = 'erp'
       group by o.order_no`)) as unknown as Record<string, unknown>[];
    for (const a of agg)
      erp.set(Number(a.orderNo), {
        orderNo: Number(a.orderNo),
        accountsCheck: String(a.accountsCheck),
        accountsAt: iso(a.accountsAt),
        accountsBy: (a.accountsBy as string) ?? null,
        productionCheck: String(a.productionCheck),
        productionAt: iso(a.productionAt),
        productionBy: (a.productionBy as string) ?? null,
        cancelled: !!a.cancelled,
        holds: [],
        milestones: [],
      });
    const holds = (await db.execute(sql`
      select order_no as "orderNo", department, reason, customer_text as text, raised_at as at, resolved_at as "resolvedAt"
        from erp_order_holds where order_no in (${list(nos)}) and kind = 'hold' order by raised_at`)) as unknown as Record<string, unknown>[];
    for (const h of holds) erp.get(Number(h.orderNo))?.holds.push({ department: String(h.department), reason: String(h.reason), text: String(h.text), at: iso(h.at)!, resolvedAt: iso(h.resolvedAt) });
    const ms = (await db.execute(sql`
      select order_no as "orderNo", step, at, note from erp_order_milestones
       where order_no in (${list(nos)}) and withdrawn_at is null order by at`)) as unknown as Record<string, unknown>[];
    for (const m of ms) erp.get(Number(m.orderNo))?.milestones.push({ step: String(m.step), at: iso(m.at)!, note: (m.note as string) ?? null });
  }

  return base.map((b) => {
    const no = orderNoOf(b);
    const raw = intakeFor.get(`o:${b.id}`) ?? (no != null ? intakeFor.get(`n:${no}`) : undefined) ?? null;
    const intake: IntakeFacts | null = raw
      ? {
          toNo: Number(raw.toNo),
          status: String(raw.status),
          takenAt: iso(raw.takenAt)!,
          takenBy: (raw.takenBy as string) ?? null,
          backOfficeAt: iso(raw.backOfficeAt),
          backOfficeBy: (raw.backOfficeBy as string) ?? null,
          productionAt: iso(raw.productionAt),
          productionBy: (raw.productionBy as string) ?? null,
          correctionAt: iso(raw.correctionAt),
          correctionNote: (raw.correctionNote as string) ?? null,
          heldAt: iso(raw.heldAt),
          holdReason: (raw.holdReason as string) ?? null,
          cancelledAt: iso(raw.cancelledAt),
          cancelReason: (raw.cancelReason as string) ?? null,
          declinedAt: iso(raw.declinedAt),
          declineReason: (raw.declineReason as string) ?? null,
          declinedBy: (raw.declinedBy as string) ?? null,
          duplicateState: (raw.duplicateState as string) ?? null,
          duplicateOfToNo: raw.duplicateOfToNo == null ? null : Number(raw.duplicateOfToNo),
          duplicateReason: (raw.duplicateReason as string) ?? null,
          origin: (raw.origin as string) ?? null,
          orderNo: raw.orderNo == null ? null : Number(raw.orderNo),
        }
      : null;
    const journey = journeyOf({
      intake,
      order: no != null ? (erp.get(no) ?? null) : null,
      book: { status: b.status, at: iso(b.orderedAt)!, approvedAt: iso(b.approvedAt), declineReason: b.declineReason },
    });
    const intakeLines = (raw?.lines as { product: string; cans: number; litres: number | null }[] | null) ?? null;
    const lines = intakeLines?.length ? intakeLines.map((l) => ({ product: l.product, cans: Number(l.cans) })) : (b.lineItems ?? []).map((l) => ({ product: l.product, cans: Number(l.quantity) }));
    const litres = intakeLines?.length && intakeLines.every((l) => l.litres != null) ? Math.round(intakeLines.reduce((n, l) => n + Number(l.litres), 0)) : null;
    return {
      id: b.id,
      customerId: b.customerId,
      customerName: b.customerName,
      userId: b.userId,
      takenBy: b.takenBy,
      status: b.status,
      orderedAt: iso(b.orderedAt)!,
      takenAt: intake?.takenAt ?? iso(b.orderedAt)!,
      approvedAt: iso(b.approvedAt),
      declineReason: b.declineReason,
      totalPaise: Number(b.totalPaise),
      lines,
      litres,
      source: b.source,
      intakeId: raw ? String(raw.id) : null,
      journey,
    };
  });
}

/** The orders a person took, newest first — TeleCRM's My orders. */
export async function ordersTakenBy(userId: string, limit = 300): Promise<OrderRow[]> {
  return assemble(await readBase(sql`o.user_id = ${userId} and o.ordered_at > now() - interval '120 days'`, limit));
}

/** A customer's orders, newest first — the order thread on the customer record. */
export async function customerOrderThreads(customerId: string, limit = 30): Promise<OrderRow[]> {
  return assemble(await readBase(sql`o.customer_id = ${customerId}`, limit));
}

/** The journey of each of a salesman's own orders, for the handset's sync. */
export async function journeysForOrders(orderIds: string[]): Promise<Map<string, OrderRow>> {
  if (!orderIds.length) return new Map();
  const rows = await assemble(await readBase(sql`o.id in (${list(orderIds)})`, orderIds.length));
  return new Map(rows.map((r) => [r.id, r]));
}
