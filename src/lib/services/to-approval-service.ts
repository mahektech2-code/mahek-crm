import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, products } from "@/db/schema";
import { requireCapability } from "../access-control";
import { err, type Result } from "../result";
import { ACCOUNTS_HOLD_REASONS } from "../erp/engines/order-hub";
import { approveIntake, declineIntake, holdIntake, releaseIntake, sendBackIntake, intakeById, type ApprovalLine } from "../erp/order-hub";

/* ---------------------------------------------------------------------------
 * ACCOUNTS APPROVE TOs (Option A). Every order is a TO until Accounts approve
 * it on Accounts › Order approvals; approving makes the order number and the
 * Production Head's MRP check is next. Accounts may change the LINES while
 * reviewing (product, cans, rate, discount) for this order only; the parties
 * and the godown are not theirs to change — they send it back instead.
 *
 * Reads here, decisions in `lib/erp/order-hub.ts`. Every decision asks
 * `order.approve` (the Accounts manager's) and writes an audit row.
 * ------------------------------------------------------------------------- */

const lineValueSql = (alias: string) =>
  sql.raw(`round(coalesce(${alias}.rate_paise, 0) * ${alias}.qty_cans * (1 - coalesce(${alias}.discount_bp, 0) / 10000.0))`);

export type AccountsToRow = {
  id: string;
  toNo: number;
  status: "open" | "correction" | "hold";
  billingId: string;
  billingName: string;
  deliveryName: string;
  takenBy: string;
  lineCount: number;
  litres: number;
  valuePaise: number;
  noRateLines: number;
  outstandingPaise: number;
  overduePaise: number;
  overdueBills: number;
  creditLimitPaise: number | null;
  pendingCustomer: boolean;
  overCreditLimit: boolean;
  duplicate: { state: "possible" | "different"; toNo: number | null; reason: string | null } | null;
  createdAt: string;
  waitingMinutes: number;
  pastDeadline: boolean;
  correctionNote: string | null;
  holdReason: string | null;
  holdNote: string | null;
};

type Raw = {
  id: string;
  to_no: number;
  status: string;
  origin: string;
  order_source: string | null;
  billing_id: string;
  billing_name: string;
  delivery_name: string;
  taken_by: string | null;
  line_count: number;
  litres: string | null;
  value: string;
  no_rate: number;
  outstanding: string;
  overdue_amount: string;
  overdue_bills: number;
  credit_limit: string | null;
  pending: boolean;
  dup_state: string | null;
  dup_to: number | null;
  dup_reason: string | null;
  created_at: Date | string;
  waiting_min: string;
  past: boolean;
  correction_note: string | null;
  hold_reason: string | null;
  hold_note: string | null;
};

function rowOf(r: Raw): AccountsToRow {
  const value = Number(r.value);
  const outstanding = Number(r.outstanding);
  const limit = r.credit_limit == null ? null : Number(r.credit_limit);
  return {
    id: r.id,
    toNo: Number(r.to_no),
    status: r.status as AccountsToRow["status"],
    billingId: r.billing_id,
    billingName: r.billing_name,
    deliveryName: r.delivery_name,
    takenBy: `${r.taken_by ?? "Someone"} · ${r.origin === "crm" ? "TeleCRM" : r.origin === "mbos" ? "Salesman App" : "ERP"}`,
    lineCount: Number(r.line_count),
    litres: Math.round(Number(r.litres ?? 0)),
    valuePaise: value,
    noRateLines: Number(r.no_rate),
    outstandingPaise: outstanding,
    overduePaise: Number(r.overdue_amount),
    overdueBills: Number(r.overdue_bills),
    creditLimitPaise: limit,
    pendingCustomer: !!r.pending,
    overCreditLimit: limit != null && outstanding + value > limit,
    duplicate: r.dup_state ? { state: r.dup_state as "possible" | "different", toNo: r.dup_to == null ? null : Number(r.dup_to), reason: r.dup_reason } : null,
    createdAt: new Date(r.created_at).toISOString(),
    waitingMinutes: Math.max(0, Math.round(Number(r.waiting_min))),
    pastDeadline: !!r.past,
    correctionNote: r.correction_note,
    holdReason: r.hold_reason,
    holdNote: r.hold_note,
  };
}

async function readRows(where: ReturnType<typeof sql>): Promise<AccountsToRow[]> {
  const rows = (await db.execute(sql`
    select i.id, i.to_no, i.status, i.origin, i.order_source, i.billing_customer_id as billing_id,
           b.name as billing_name, coalesce(d.name, b.name) as delivery_name, u.name as taken_by,
           (select count(*)::int from erp_order_intake_lines l where l.intake_id = i.id) as line_count,
           (select sum(l.qty_cans * coalesce(p.millilitres_per_can, 0)) / 1000.0 from erp_order_intake_lines l join products p on p.id = l.sku_id where l.intake_id = i.id)::text as litres,
           (select coalesce(sum(${lineValueSql("l")}), 0)::bigint from erp_order_intake_lines l where l.intake_id = i.id)::text as value,
           (select count(*)::int from erp_order_intake_lines l where l.intake_id = i.id and l.rate_paise is null) as no_rate,
           b.outstanding::text as outstanding,
           (select coalesce(sum(bl.amount - bl.paid_amount), 0)::bigint from bills bl
             where bl.customer_id = b.id and bl.payment_position = 'stated' and bl.amount > bl.paid_amount and bl.due_date < current_date)::text as overdue_amount,
           (select count(*)::int from bills bl
             where bl.customer_id = b.id and bl.payment_position = 'stated' and bl.amount > bl.paid_amount and bl.due_date < current_date) as overdue_bills,
           b.credit_limit_paise::text as credit_limit,
           coalesce(pr.pending_activation, false) as pending,
           i.duplicate_state as dup_state, di.to_no as dup_to, i.duplicate_reason as dup_reason,
           i.created_at, extract(epoch from (now() - i.created_at)) / 60 as waiting_min,
           exists (select 1 from accounts_sla_breaches s where s.kind = 'to' and s.record_id = i.id and s.resolved_at is null) as past,
           i.correction_note, i.hold_reason, i.hold_note
      from erp_order_intakes i
      join customers b on b.id = i.billing_customer_id
      left join customers d on d.id = i.delivery_customer_id
      left join users u on u.id = i.taken_by_id
      left join erp_customer_profiles pr on pr.customer_id = b.id
      left join erp_order_intakes di on di.id = i.duplicate_of_id
     where ${where}
     order by i.created_at asc
     limit 500
  `)) as unknown as Raw[];
  return rows.map(rowOf);
}

/** The TOs Accounts work: waiting, sent back to the taker, and on hold with Accounts. */
export async function accountsTos(): Promise<{ waiting: AccountsToRow[]; sentBack: AccountsToRow[]; held: AccountsToRow[] }> {
  const rows = await readRows(sql`i.status in ('open', 'correction', 'hold')`);
  return {
    waiting: rows.filter((r) => r.status === "open"),
    sentBack: rows.filter((r) => r.status === "correction"),
    held: rows.filter((r) => r.status === "hold"),
  };
}

export async function accountsToCount(): Promise<number> {
  const [r] = (await db.execute(sql`select count(*)::int as n from erp_order_intakes where status = 'open'`)) as unknown as { n: number }[];
  return Number(r?.n ?? 0);
}

export type ToReviewLine = { skuId: string; name: string; qtyCans: number; ratePaise: number | null; discountBp: number | null };
export type ToHistoryEntry = { at: string; text: string; tone: "info" | "warn" | "danger" };
export type ToReview = {
  row: AccountsToRow;
  godown: string | null;
  orderDate: string;
  remark: string | null;
  lines: ToReviewLine[];
  customer: { creditDays: number | null; status: string; slowPayer: boolean; overdueList: { billNo: string; dueDate: string; balancePaise: number }[] };
  history: ToHistoryEntry[];
};

/** One TO, as the review dialog draws it. */
export async function toReview(id: string): Promise<ToReview | null> {
  const [row] = await readRows(sql`i.id = ${id}`);
  if (!row) return null;
  const got = await intakeById(id);
  if (!got) return null;
  const { intake } = got;
  const lines = (await db.execute(sql`
    select l.sku_id as "skuId", p.name, l.qty_cans as "qtyCans", l.rate_paise as "ratePaise", l.discount_bp as "discountBp"
      from erp_order_intake_lines l join products p on p.id = l.sku_id
     where l.intake_id = ${id} order by l.position asc
  `)) as unknown as { skuId: string; name: string; qtyCans: number; ratePaise: string | number | null; discountBp: number | null }[];
  const [c] = (await db.execute(sql`
    select c.credit_days as "creditDays", c.status::text as status, c.slow_payer as "slowPayer", g.name as godown
      from customers c left join erp_godowns g on g.id = ${intake.godownId}
     where c.id = ${intake.billingCustomerId}
  `)) as unknown as { creditDays: number | null; status: string; slowPayer: boolean; godown: string | null }[];
  const overdue = (await db.execute(sql`
    select bl.bill_no as "billNo", bl.due_date::text as "dueDate", (bl.amount - bl.paid_amount)::bigint::text as balance
      from bills bl
     where bl.customer_id = ${intake.billingCustomerId} and bl.payment_position = 'stated' and bl.amount > bl.paid_amount and bl.due_date < current_date
     order by bl.due_date asc limit 20
  `)) as unknown as { billNo: string; dueDate: string; balance: string }[];
  const names = (await db.execute(sql`
    select id, name from users where id in (${sql.join([intake.takenById, intake.correctionById, intake.heldById, intake.duplicateDecidedById, intake.createdById].filter((x): x is string => !!x).map((x) => sql`${x}`).concat(sql`''`), sql`, `)})
  `)) as unknown as { id: string; name: string }[];
  const who = new Map(names.map((n) => [n.id, n.name]));
  const history: ToHistoryEntry[] = [
    { at: intake.createdAt.toISOString(), text: `TO-${intake.toNo} taken by ${row.takenBy}`, tone: "info" },
  ];
  if (intake.duplicateState === "different")
    history.push({ at: (intake.duplicateDecidedAt ?? intake.createdAt).toISOString(), text: `Marked a different order from TO-${row.duplicate?.toNo ?? "?"} by ${who.get(intake.duplicateDecidedById ?? "") ?? "the taker"}: ${intake.duplicateReason ?? ""}`, tone: "warn" });
  if (intake.duplicateState === "possible") history.push({ at: intake.createdAt.toISOString(), text: `Possible duplicate of TO-${row.duplicate?.toNo ?? "?"} (sent with no signal, checked when it synced)`, tone: "warn" });
  if (intake.correctionAt) history.push({ at: intake.correctionAt.toISOString(), text: `Sent back by ${who.get(intake.correctionById ?? "") ?? "Accounts"}: ${intake.correctionNote ?? ""}`, tone: "warn" });
  if (intake.heldAt) history.push({ at: intake.heldAt.toISOString(), text: `Held by ${who.get(intake.heldById ?? "") ?? "Accounts"}: ${intake.holdReason ?? ""}${intake.holdNote ? ` - ${intake.holdNote}` : ""}`, tone: "warn" });
  if (intake.updatedAt.getTime() - intake.createdAt.getTime() > 60_000) history.push({ at: intake.updatedAt.toISOString(), text: "Last changed", tone: "info" });
  history.sort((a, b) => a.at.localeCompare(b.at));
  return {
    row,
    godown: c?.godown ?? null,
    orderDate: intake.orderDate,
    remark: intake.remark,
    lines: lines.map((l) => ({ skuId: l.skuId, name: l.name, qtyCans: Number(l.qtyCans), ratePaise: l.ratePaise == null ? null : Number(l.ratePaise), discountBp: l.discountBp == null ? null : Number(l.discountBp) })),
    customer: {
      creditDays: c?.creditDays ?? null,
      status: c?.status ?? "active",
      slowPayer: !!c?.slowPayer,
      overdueList: overdue.map((o) => ({ billNo: o.billNo, dueDate: o.dueDate, balancePaise: Number(o.balance) })),
    },
    history,
  };
}

/** The products a line may be changed to: every active SKU, by name. */
export async function approvableProducts(): Promise<{ id: string; name: string }[]> {
  return db.select({ id: products.id, name: products.name }).from(products).where(and(eq(products.active, true))).orderBy(asc(products.name));
}

/* --------------------------------------------------------------- decisions */

async function audit(id: string, action: string, after: Record<string, unknown>) {
  const ctx = await requireCapability("order.approve");
  await db.insert(auditLog).values({
    id: `aud_${randomUUID().slice(0, 12)}`,
    actorId: ctx.user.id,
    actorRole: ctx.authorisedBy,
    actorApp: ctx.authorisedIn,
    action,
    entityType: "erp_order_intake",
    entityId: id,
    afterState: after as never,
  });
  return ctx;
}

export async function approveTo(id: string, lines: ApprovalLine[] | null): Promise<Result<{ orderNo: number; toNo: number }>> {
  const ctx = await requireCapability("order.approve");
  const r = await approveIntake(ctx.user.id, id, lines);
  if (r.ok) await audit(id, "order.to.approve", { orderNo: r.data.orderNo, toNo: r.data.toNo, edited: !!lines });
  return r;
}

export async function sendBackTo(id: string, note: string): Promise<Result<unknown>> {
  const ctx = await requireCapability("order.approve");
  if (!note.trim()) return err("Say what needs correcting.", "validation", [{ field: "note", message: "Say what needs correcting" }]);
  const r = await sendBackIntake(ctx.user.id, id, note);
  if (r.ok) await audit(id, "order.to.sendBack", { note: note.trim(), toNo: (await intakeById(id))?.intake.toNo ?? null });
  return r;
}

export async function holdTo(id: string, reasonCode: string, note: string): Promise<Result<unknown>> {
  const ctx = await requireCapability("order.approve");
  const reason = ACCOUNTS_HOLD_REASONS.find((x) => x.code === reasonCode);
  if (!reason) return err("Pick the reason.", "validation", [{ field: "reason", message: "Pick the reason" }]);
  const r = await holdIntake(ctx.user.id, id, reason.label, note.trim() || null);
  if (r.ok) await audit(id, "order.to.hold", { reason: reason.code, note: note.trim() || null });
  return r;
}

export async function releaseTo(id: string, note: string): Promise<Result<unknown>> {
  const ctx = await requireCapability("order.approve");
  const r = await releaseIntake(ctx.user.id, id, note.trim() || null);
  if (r.ok) await audit(id, "order.to.release", { note: note.trim() || null });
  return r;
}

export async function declineTo(id: string, reason: string): Promise<Result<unknown>> {
  const ctx = await requireCapability("order.approve");
  const r = await declineIntake(ctx.user.id, id, reason);
  if (r.ok) await audit(id, "order.to.decline", { reason: reason.trim() });
  return r;
}
