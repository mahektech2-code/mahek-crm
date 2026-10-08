import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { attachments, auditLog, vendorPayoutInvoices, vendorPayouts } from "@/db/schema";
import { canOpenModule } from "@/lib/access";
import { requireCapability, resolveScope } from "@/lib/access-control";
import type { Capability } from "@/lib/capability-matrix";
import { getConfig } from "@/lib/config/store";
import {
  dueDateFor,
  groupPurchaseLots,
  moveRefusal,
  paymentWeekdays,
  plannedPayOn,
  type PayoutStatus,
  type RegisterLot,
} from "@/lib/engines/vendor-payouts";
import { today } from "@/lib/recompute";
import { err, fieldErr, ok, okVoid, type Err, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * VENDOR PAYOUTS — what Mahek owes its suppliers, read and written.
 *
 * Two kinds of payout share one table. A PURCHASE payout is rebuilt from the
 * ERP purchase register by `syncPurchasePayouts` — one per supplier per PR
 * number, worth the register's own figure — so the register stays the only
 * place a purchase is typed. A MANUAL payout is anything else accounts pay:
 * an advance against a proforma, a transporter, a service bill.
 *
 * The register sync rewrites a purchase payout's amount, bill numbers, PO and
 * due date while it is unpaid, and never touches a payment day a person chose
 * (`pay_on_decided_at`) or a payout already paid.
 *
 * Who may: holding Accounts → Vendor payouts opens the screen; planning,
 * holding and adding invoices or payouts is `payment.record`; marking one paid,
 * undoing that and cancelling one move money and are `payment.confirm` — the
 * Accounts manager's, as confirming a receipt is.
 * ------------------------------------------------------------------------- */

const MODULE = "accounts.payouts";
const GONE = "No longer in the purchase register.";
const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

export type PayoutInvoiceView = {
  id: string;
  kind: string;
  invoiceNo: string | null;
  invoiceDate: string | null;
  amountPaise: number | null;
  attachmentId: string | null;
  filename: string | null;
  isImage: boolean;
  note: string | null;
  createdAt: string;
  createdByName: string | null;
};

export type PayoutView = {
  id: string;
  source: "purchase" | "manual";
  prNumber: number | null;
  supplierId: string | null;
  payeeName: string;
  description: string | null;
  reference: string | null;
  poId: string | null;
  poNumber: number | null;
  poStatus: string | null;
  poDate: string | null;
  purchaseDate: string | null;
  amountPaise: number;
  dueDate: string;
  payOn: string;
  payOnDecided: boolean;
  status: PayoutStatus;
  holdReason: string | null;
  paidOn: string | null;
  paidAmountPaise: number | null;
  paymentMode: string | null;
  paymentReference: string | null;
  paidByName: string | null;
  cancelReason: string | null;
  notes: string | null;
  creditDays: number | null;
  /** How many register lots the purchase carries, and their register statuses. */
  lots: number;
  registerStatuses: string[];
  invoices: PayoutInvoiceView[];
};

export type PayoutSupplier = { id: string; name: string; creditDays: number | null };
export type PayoutPo = { id: string; poNumber: number; supplierId: string; poDate: string; status: string; valuePaise: number };

/* ----------------------------------------------------------------- access */

async function deskUser() {
  const ctx = await resolveScope();
  return { ctx, open: await canOpenModule(ctx.user.id, MODULE) };
}

type DeskCtx = Awaited<ReturnType<typeof requireCapability>>;

/** Opens the screen AND holds the capability, or says which is missing. */
async function requireDesk(
  capability: Capability,
): Promise<{ refused: Err; ctx?: undefined } | { refused?: undefined; ctx: DeskCtx }> {
  const { open } = await deskUser();
  if (!open) return { refused: err("Vendor payouts is not on your account.", "not_permitted") };
  try {
    return { ctx: await requireCapability(capability) };
  } catch {
    return {
      refused: err(
        capability === "payment.confirm"
          ? "Marking a payout paid, undoing it and cancelling one are the Accounts manager's."
          : "You cannot change vendor payouts.",
        "not_permitted",
      ),
    };
  }
}

async function audit(
  ctx: DeskCtx,
  action: string,
  entityId: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
  tx: Pick<typeof db, "insert"> = db,
) {
  await tx.insert(auditLog).values({
    id: id("aud"),
    actorId: ctx.user.id,
    actorRole: ctx.authorisedBy,
    actorApp: ctx.authorisedIn,
    action,
    entityType: "vendor_payout",
    entityId,
    beforeState: before as never,
    afterState: after as never,
  });
}

async function settings() {
  const config = await getConfig();
  return {
    days: paymentWeekdays(config["payments.vendorPayoutDays"]),
    defaultCreditDays: config["payments.vendorDefaultCreditDays"],
  };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/* ------------------------------------------------------------- the sync */

/**
 * Brings the purchase payouts into line with the register. Idempotent: a
 * register that has not changed writes nothing. Run when the screen opens, so
 * a lot rated in the ERP five minutes ago is a payout here now.
 */
export async function syncPurchasePayouts(): Promise<{ created: number; updated: number; removed: number }> {
  const [{ days, defaultCreditDays }, day] = await Promise.all([settings(), today()]);

  const lots = await db.execute<{
    id: string;
    pr_number: number;
    purchase_date: string;
    supplier_id: string;
    supplier_name: string;
    credit_days: number | null;
    po_id: string | null;
    bill_number: string | null;
    status: string;
    quantity: string;
    unit: string;
    rate_paise: string | null;
    density: string | null;
    feed_adjusted_litre: string;
    feed_adjusted_amount_paise: string;
    gst_bp: number;
    drums: number | null;
  }>(sql`
    select p.id, p.pr_number, p.purchase_date::text as purchase_date, p.supplier_id,
           s.name as supplier_name, s.credit_days, p.po_id, p.bill_number, p.status,
           p.quantity, p.unit, p.rate_paise, p.density, p.feed_adjusted_litre,
           p.feed_adjusted_amount_paise, p.gst_bp, p.drums
      from erp_purchases p
      join erp_suppliers s on s.id = p.supplier_id
  `);

  const groups = groupPurchaseLots(
    lots.map(
      (r): RegisterLot => ({
        id: r.id,
        prNumber: Number(r.pr_number),
        purchaseDate: r.purchase_date,
        supplierId: r.supplier_id,
        supplierName: r.supplier_name,
        supplierCreditDays: r.credit_days == null ? null : Number(r.credit_days),
        poId: r.po_id,
        billNumber: r.bill_number,
        status: r.status,
        quantity: Number(r.quantity),
        unit: r.unit,
        ratePaise: r.rate_paise == null ? null : Number(r.rate_paise),
        density: r.density == null ? null : Number(r.density),
        feedAdjustedLitre: Number(r.feed_adjusted_litre),
        feedAdjustedAmountPaise: Number(r.feed_adjusted_amount_paise),
        gstBp: Number(r.gst_bp),
        drums: r.drums == null ? null : Number(r.drums),
      }),
    ),
  );

  const existing = await db
    .select()
    .from(vendorPayouts)
    .where(eq(vendorPayouts.source, "purchase"));
  const byKey = new Map(existing.map((e) => [e.purchaseKey!, e]));

  let created = 0;
  let updated = 0;
  let removed = 0;
  const now = new Date();

  for (const g of groups) {
    const due = dueDateFor(g.purchaseDate, g.supplierCreditDays, defaultCreditDays);
    const row = byKey.get(g.key);
    byKey.delete(g.key);

    if (!row) {
      await db
        .insert(vendorPayouts)
        .values({
          id: id("vpo"),
          source: "purchase",
          purchaseKey: g.key,
          prNumber: g.prNumber,
          supplierId: g.supplierId,
          payeeName: g.supplierName,
          reference: g.reference,
          poId: g.poId,
          purchaseDate: g.purchaseDate,
          amountPaise: g.amountPaise,
          dueDate: due,
          payOn: plannedPayOn(due, day, days),
        })
        .onConflictDoNothing();
      created++;
      continue;
    }

    // A payout somebody paid is a record of what was paid. A register lot
    // edited afterwards does not rewrite it.
    if (row.status === "paid") continue;

    const reopen = row.status === "cancelled" && row.cancelReason === GONE;
    if (row.status === "cancelled" && !reopen) continue;

    const dueMoved = row.dueDate !== due;
    const next = {
      prNumber: g.prNumber,
      supplierId: g.supplierId,
      payeeName: g.supplierName,
      reference: g.reference,
      poId: g.poId,
      purchaseDate: g.purchaseDate,
      amountPaise: g.amountPaise,
      dueDate: due,
      // A day a person chose stays chosen. Otherwise only a moved due date
      // re-plans it: an overdue payout nobody paid stays overdue rather than
      // quietly rolling forward to today.
      payOn: row.payOnDecidedAt || !dueMoved ? row.payOn : plannedPayOn(due, day, days),
      ...(reopen ? { status: "open", cancelReason: null } : {}),
    };
    const changed =
      reopen ||
      row.prNumber !== next.prNumber ||
      row.supplierId !== next.supplierId ||
      row.payeeName !== next.payeeName ||
      (row.reference ?? null) !== next.reference ||
      (row.poId ?? null) !== next.poId ||
      row.purchaseDate !== next.purchaseDate ||
      Number(row.amountPaise) !== next.amountPaise ||
      dueMoved ||
      row.payOn !== next.payOn;
    if (!changed) continue;
    await db.update(vendorPayouts).set({ ...next, updatedAt: now }).where(eq(vendorPayouts.id, row.id));
    updated++;
  }

  // What is left was in the register and is not any more: every lot of it was
  // deleted, or lost its rate. Unpaid, it is no longer owed; paid, it stays.
  for (const row of byKey.values()) {
    if (row.status !== "open" && row.status !== "on_hold") continue;
    await db
      .update(vendorPayouts)
      .set({ status: "cancelled", cancelReason: GONE, updatedAt: now })
      .where(eq(vendorPayouts.id, row.id));
    removed++;
  }

  return { created, updated, removed };
}

/* ---------------------------------------------------------------- reads */

/**
 * Every payout still to pay, wherever it is planned, and everything paid or
 * cancelled in the last six months — enough to scroll the calendar back over
 * and to answer "did we pay them".
 */
export async function listPayouts(): Promise<PayoutView[]> {
  const day = await today();
  const rows = await db.execute<{
    id: string;
    source: "purchase" | "manual";
    pr_number: number | null;
    supplier_id: string | null;
    payee_name: string;
    description: string | null;
    reference: string | null;
    po_id: string | null;
    po_number: number | null;
    po_status: string | null;
    po_date: string | null;
    purchase_date: string | null;
    amount_paise: string;
    due_date: string;
    pay_on: string;
    pay_on_decided: boolean;
    status: PayoutStatus;
    hold_reason: string | null;
    paid_on: string | null;
    paid_amount_paise: string | null;
    payment_mode: string | null;
    payment_reference: string | null;
    paid_by_name: string | null;
    cancel_reason: string | null;
    notes: string | null;
    credit_days: number | null;
    lots: number;
    register_statuses: string[] | null;
  }>(sql`
    select v.id, v.source, v.pr_number, v.supplier_id, v.payee_name, v.description,
           v.reference, v.po_id, po.po_number, po.status as po_status,
           po.po_date::text as po_date, v.purchase_date::text as purchase_date,
           v.amount_paise, v.due_date::text as due_date, v.pay_on::text as pay_on,
           v.pay_on_decided_at is not null as pay_on_decided, v.status, v.hold_reason,
           v.paid_on::text as paid_on, v.paid_amount_paise, v.payment_mode,
           v.payment_reference, u.name as paid_by_name, v.cancel_reason, v.notes,
           s.credit_days,
           coalesce(reg.lots, 0)::int as lots, reg.statuses as register_statuses
      from vendor_payouts v
      left join erp_purchase_orders po on po.id = v.po_id
      left join erp_suppliers s on s.id = v.supplier_id
      left join users u on u.id = v.paid_by_id
      left join lateral (
        select count(*) as lots, array_agg(distinct p.status) as statuses
          from erp_purchases p
         where v.source = 'purchase'
           and p.supplier_id = v.supplier_id
           and p.pr_number = v.pr_number
      ) reg on true
     where v.status in ('open', 'on_hold')
        or coalesce(v.paid_on, v.pay_on) >= ${day}::date - 183
     order by v.pay_on, v.payee_name
  `);

  const ids = rows.map((r) => r.id);
  const invoices = ids.length
    ? await db.execute<{
        id: string;
        payout_id: string;
        kind: string;
        invoice_no: string | null;
        invoice_date: string | null;
        amount_paise: string | null;
        attachment_id: string | null;
        filename: string | null;
        content_type: string | null;
        note: string | null;
        created_at: Date;
        created_by: string | null;
      }>(sql`
        select i.id, i.payout_id, i.kind, i.invoice_no, i.invoice_date::text as invoice_date,
               i.amount_paise, a.id as attachment_id, a.filename, a.content_type, i.note,
               i.created_at, u.name as created_by
          from vendor_payout_invoices i
          left join attachments a on a.id = i.attachment_id and a.status = 'available'
          left join users u on u.id = i.created_by_id
         where i.payout_id in (${sql.join(ids.map((x) => sql`${x}`), sql`, `)})
         order by i.created_at, i.id
      `)
    : [];
  const byPayout = new Map<string, PayoutInvoiceView[]>();
  for (const i of invoices) {
    const list = byPayout.get(i.payout_id) ?? [];
    list.push({
      id: i.id,
      kind: i.kind,
      invoiceNo: i.invoice_no,
      invoiceDate: i.invoice_date,
      amountPaise: i.amount_paise == null ? null : Number(i.amount_paise),
      attachmentId: i.attachment_id,
      filename: i.filename,
      isImage: (i.content_type ?? "").startsWith("image/"),
      note: i.note,
      createdAt: new Date(i.created_at).toISOString(),
      createdByName: i.created_by,
    });
    byPayout.set(i.payout_id, list);
  }

  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    prNumber: r.pr_number == null ? null : Number(r.pr_number),
    supplierId: r.supplier_id,
    payeeName: r.payee_name,
    description: r.description,
    reference: r.reference,
    poId: r.po_id,
    poNumber: r.po_number == null ? null : Number(r.po_number),
    poStatus: r.po_status,
    poDate: r.po_date,
    purchaseDate: r.purchase_date,
    amountPaise: Number(r.amount_paise),
    dueDate: r.due_date,
    payOn: r.pay_on,
    payOnDecided: Boolean(r.pay_on_decided),
    status: r.status,
    holdReason: r.hold_reason,
    paidOn: r.paid_on,
    paidAmountPaise: r.paid_amount_paise == null ? null : Number(r.paid_amount_paise),
    paymentMode: r.payment_mode,
    paymentReference: r.payment_reference,
    paidByName: r.paid_by_name,
    cancelReason: r.cancel_reason,
    notes: r.notes,
    creditDays: r.credit_days == null ? null : Number(r.credit_days),
    lots: Number(r.lots),
    registerStatuses: r.register_statuses ?? [],
    invoices: byPayout.get(r.id) ?? [],
  }));
}

/** Suppliers a manual payout can be to, and the POs it can name. */
export async function payoutPickers(): Promise<{ suppliers: PayoutSupplier[]; pos: PayoutPo[] }> {
  const [suppliers, pos] = await Promise.all([
    db.execute<{ id: string; name: string; credit_days: number | null }>(sql`
      select id, name, credit_days from erp_suppliers where active order by name
    `),
    db.execute<{ id: string; po_number: number; supplier_id: string; po_date: string; status: string; value: string }>(sql`
      select po.id, po.po_number, po.supplier_id, po.po_date::text as po_date, po.status,
             (po.freight_paise + coalesce(sum(round(l.quantity * l.rate_paise * (10000 + l.gst_bp) / 10000.0)), 0))::bigint as value
        from erp_purchase_orders po
        left join erp_po_lines l on l.po_id = po.id
       where po.status not in ('Cancelled', 'Rejected')
       group by po.id
       order by po.po_number desc
       limit 500
    `),
  ]);
  return {
    suppliers: suppliers.map((s) => ({ id: s.id, name: s.name, creditDays: s.credit_days == null ? null : Number(s.credit_days) })),
    pos: pos.map((p) => ({
      id: p.id,
      poNumber: Number(p.po_number),
      supplierId: p.supplier_id,
      poDate: p.po_date,
      status: p.status,
      valuePaise: Number(p.value),
    })),
  };
}

/** How many unpaid payouts are planned for a day that has gone — the sidebar's badge. */
export async function overduePayoutCount(): Promise<number> {
  const day = await today();
  const [row] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from vendor_payouts where status = 'open' and pay_on < ${day}::date
  `);
  return Number(row?.n ?? 0);
}

/* --------------------------------------------------------------- writes */

export type InvoiceInput = {
  kind: string;
  invoiceNo?: string | null;
  invoiceDate?: string | null;
  amountPaise?: number | null;
  attachmentId?: string | null;
  note?: string | null;
};

function invoiceFault(inv: InvoiceInput, field: string): Err | null {
  if (!inv.kind?.trim()) return fieldErr(`${field}.kind`, "Say what kind of invoice this is.");
  if (inv.kind.trim().length > 60) return fieldErr(`${field}.kind`, "Keep the kind under 60 characters.");
  if (inv.invoiceDate && !ISO.test(inv.invoiceDate)) return fieldErr(`${field}.invoiceDate`, "That is not a date.");
  if (inv.amountPaise != null && (!Number.isFinite(inv.amountPaise) || inv.amountPaise < 0))
    return fieldErr(`${field}.amountPaise`, "An amount cannot be negative.");
  if (!inv.attachmentId && !inv.invoiceNo?.trim()) return fieldErr(`${field}.invoiceNo`, "Attach the file or give the invoice number.");
  return null;
}

/** Writes one invoice row and binds its file — only a file this person uploaded and nothing has claimed. */
async function insertInvoice(
  tx: Pick<typeof db, "insert" | "update">,
  payoutId: string,
  inv: InvoiceInput,
  userId: string,
  /** Several invoices saved together keep the order they were entered in. */
  at: Date = new Date(),
): Promise<string> {
  const invoiceId = id("vpi");
  let attachmentId: string | null = null;
  if (inv.attachmentId) {
    const bound = await tx
      .update(attachments)
      .set({ parentType: "vendor_payout_invoice", parentId: invoiceId, updatedAt: new Date() })
      .where(
        and(
          eq(attachments.id, inv.attachmentId),
          isNull(attachments.parentId),
          eq(attachments.uploadedById, userId),
          eq(attachments.status, "available"),
        ),
      )
      .returning({ id: attachments.id });
    attachmentId = bound[0]?.id ?? null;
  }
  await tx.insert(vendorPayoutInvoices).values({
    id: invoiceId,
    payoutId,
    kind: inv.kind.trim(),
    invoiceNo: inv.invoiceNo?.trim() || null,
    invoiceDate: inv.invoiceDate || null,
    amountPaise: inv.amountPaise ?? null,
    attachmentId,
    note: inv.note?.trim() || null,
    createdAt: at,
    createdById: userId,
  });
  return invoiceId;
}

export type ManualPayoutInput = {
  supplierId?: string | null;
  payeeName?: string | null;
  description: string;
  reference?: string | null;
  amountPaise: number;
  billDate?: string | null;
  dueDate: string;
  payOn?: string | null;
  poId?: string | null;
  notes?: string | null;
  invoices?: InvoiceInput[];
};

export async function createManualPayout(input: ManualPayoutInput): Promise<Result<{ id: string }>> {
  const desk = await requireDesk("payment.record");
  if (desk.refused) return desk.refused;
  const { ctx } = desk;
  const [{ days }, day] = await Promise.all([settings(), today()]);

  let payee = input.payeeName?.trim() ?? "";
  let supplierId: string | null = null;
  if (input.supplierId) {
    const [s] = await db.execute<{ id: string; name: string }>(sql`select id, name from erp_suppliers where id = ${input.supplierId}`);
    if (!s) return fieldErr("supplierId", "That supplier no longer exists.");
    supplierId = s.id;
    payee = s.name;
  }
  if (!payee) return fieldErr("payeeName", "Say who is being paid.");
  if (payee.length > 120) return fieldErr("payeeName", "Keep the name under 120 characters.");
  if (!input.description?.trim()) return fieldErr("description", "Say what the payment is for.");
  if (!Number.isFinite(input.amountPaise) || input.amountPaise <= 0) return fieldErr("amountPaise", "Enter the amount to pay.");
  if (input.billDate && !ISO.test(input.billDate)) return fieldErr("billDate", "That is not a date.");
  if (!ISO.test(input.dueDate ?? "")) return fieldErr("dueDate", "Say when the payment is due.");

  const payOn = input.payOn || plannedPayOn(input.dueDate, day, days);
  if (!ISO.test(payOn)) return fieldErr("payOn", "That is not a date.");
  if (input.payOn) {
    const why = moveRefusal(payOn, day, days, "open");
    if (why) return fieldErr("payOn", why);
  }

  if (input.poId) {
    const [po] = await db.execute<{ supplier_id: string }>(sql`select supplier_id from erp_purchase_orders where id = ${input.poId}`);
    if (!po) return fieldErr("poId", "That PO no longer exists.");
    if (supplierId && po.supplier_id !== supplierId) return fieldErr("poId", "That PO is to a different supplier.");
  }

  const invoices = input.invoices ?? [];
  for (const [i, inv] of invoices.entries()) {
    const fault = invoiceFault(inv, `invoices.${i}`);
    if (fault) return fault;
  }

  const payoutId = id("vpo");
  await db.transaction(async (tx) => {
    await tx.insert(vendorPayouts).values({
      id: payoutId,
      source: "manual",
      supplierId,
      payeeName: payee,
      description: input.description.trim(),
      reference: input.reference?.trim() || null,
      poId: input.poId || null,
      purchaseDate: input.billDate || null,
      amountPaise: Math.round(input.amountPaise),
      dueDate: input.dueDate,
      payOn,
      payOnDecidedAt: input.payOn ? new Date() : null,
      notes: input.notes?.trim() || null,
      createdById: ctx.user.id,
      updatedById: ctx.user.id,
    });
    const base = Date.now();
    for (const [i, inv] of invoices.entries()) await insertInvoice(tx, payoutId, inv, ctx.user.id, new Date(base + i));
    await audit(ctx, "payout.create", payoutId, null, {
      payee,
      amount: Math.round(input.amountPaise),
      dueDate: input.dueDate,
      payOn,
      invoices: invoices.length,
    }, tx);
  });
  return ok({ id: payoutId }, `Payout to ${payee} added`);
}

async function loadPayout(payoutId: string) {
  const [row] = await db.select().from(vendorPayouts).where(eq(vendorPayouts.id, payoutId));
  return row ?? null;
}

/** Plans a payout for another payment day — the calendar's drag and drop. */
export async function reschedulePayout(payoutId: string, payOn: string): Promise<Result> {
  const desk = await requireDesk("payment.record");
  if (desk.refused) return desk.refused;
  const row = await loadPayout(payoutId);
  if (!row) return err("That payout no longer exists.", "not_found");
  if (!ISO.test(payOn)) return fieldErr("payOn", "That is not a date.");
  const [{ days }, day] = await Promise.all([settings(), today()]);
  const why = moveRefusal(payOn, day, days, row.status as PayoutStatus);
  if (why) return err(why, "rule_violation");
  if (row.payOn === payOn) return okVoid();
  await db
    .update(vendorPayouts)
    .set({ payOn, payOnDecidedAt: new Date(), updatedAt: new Date(), updatedById: desk.ctx.user.id })
    .where(eq(vendorPayouts.id, payoutId));
  await audit(desk.ctx, "payout.reschedule", payoutId, { payOn: row.payOn }, { payOn, payee: row.payeeName });
  return okVoid(`${row.payeeName} moved to ${payOn}`);
}

export async function holdPayout(payoutId: string, reason: string): Promise<Result> {
  const desk = await requireDesk("payment.record");
  if (desk.refused) return desk.refused;
  const row = await loadPayout(payoutId);
  if (!row) return err("That payout no longer exists.", "not_found");
  if (row.status !== "open") return err("Only a payout still to pay can be held.", "rule_violation");
  if (!reason.trim()) return fieldErr("reason", "Say why it is held — whoever picks it up next will ask.");
  await db
    .update(vendorPayouts)
    .set({ status: "on_hold", holdReason: reason.trim(), updatedAt: new Date(), updatedById: desk.ctx.user.id })
    .where(eq(vendorPayouts.id, payoutId));
  await audit(desk.ctx, "payout.hold", payoutId, { status: row.status }, { status: "on_hold", reason: reason.trim(), payee: row.payeeName });
  return okVoid(`${row.payeeName} held`);
}

export async function releasePayout(payoutId: string): Promise<Result> {
  const desk = await requireDesk("payment.record");
  if (desk.refused) return desk.refused;
  const row = await loadPayout(payoutId);
  if (!row) return err("That payout no longer exists.", "not_found");
  if (row.status !== "on_hold") return err("That payout is not on hold.", "rule_violation");
  await db
    .update(vendorPayouts)
    .set({ status: "open", holdReason: null, updatedAt: new Date(), updatedById: desk.ctx.user.id })
    .where(eq(vendorPayouts.id, payoutId));
  await audit(desk.ctx, "payout.release", payoutId, { status: "on_hold" }, { status: "open", payee: row.payeeName });
  return okVoid(`${row.payeeName} released`);
}

export async function markPayoutPaid(
  payoutId: string,
  input: { paidOn: string; amountPaise: number; mode: string; reference?: string | null },
): Promise<Result> {
  const desk = await requireDesk("payment.confirm");
  if (desk.refused) return desk.refused;
  const row = await loadPayout(payoutId);
  if (!row) return err("That payout no longer exists.", "not_found");
  if (row.status === "paid") return err("That payout is already marked paid.", "conflict");
  if (row.status === "cancelled") return err("A cancelled payout cannot be paid.", "rule_violation");
  const day = await today();
  if (!ISO.test(input.paidOn ?? "")) return fieldErr("paidOn", "Say the day it was paid.");
  if (input.paidOn > day) return fieldErr("paidOn", "It cannot have been paid on a day that has not come yet.");
  if (!Number.isFinite(input.amountPaise) || input.amountPaise <= 0) return fieldErr("amountPaise", "Enter the amount paid.");
  if (!input.mode?.trim()) return fieldErr("mode", "Say how it was paid.");
  await db
    .update(vendorPayouts)
    .set({
      status: "paid",
      holdReason: null,
      paidOn: input.paidOn,
      paidAmountPaise: Math.round(input.amountPaise),
      paymentMode: input.mode.trim(),
      paymentReference: input.reference?.trim() || null,
      paidById: desk.ctx.user.id,
      updatedAt: new Date(),
      updatedById: desk.ctx.user.id,
    })
    .where(eq(vendorPayouts.id, payoutId));
  await audit(desk.ctx, "payout.paid", payoutId, { status: row.status }, {
    payee: row.payeeName,
    amount: Math.round(input.amountPaise),
    paidOn: input.paidOn,
    mode: input.mode.trim(),
    reference: input.reference?.trim() || null,
  });
  return okVoid(`${row.payeeName} marked paid`);
}

/** Undoes "paid" — the bank sent it back, or it was marked on the wrong payout. */
export async function reopenPayout(payoutId: string, reason: string): Promise<Result> {
  const desk = await requireDesk("payment.confirm");
  if (desk.refused) return desk.refused;
  const row = await loadPayout(payoutId);
  if (!row) return err("That payout no longer exists.", "not_found");
  if (row.status !== "paid") return err("Only a paid payout can be reopened.", "rule_violation");
  if (!reason.trim()) return fieldErr("reason", "Say why it is being reopened.");
  const [{ days }, day] = await Promise.all([settings(), today()]);
  const payOn = row.payOn < day ? plannedPayOn(day, day, days) : row.payOn;
  await db
    .update(vendorPayouts)
    .set({
      status: "open",
      payOn,
      paidOn: null,
      paidAmountPaise: null,
      paymentMode: null,
      paymentReference: null,
      paidById: null,
      updatedAt: new Date(),
      updatedById: desk.ctx.user.id,
    })
    .where(eq(vendorPayouts.id, payoutId));
  await audit(
    desk.ctx,
    "payout.reopen",
    payoutId,
    { status: "paid", paidOn: row.paidOn, amount: row.paidAmountPaise },
    { status: "open", payOn, reason: reason.trim(), payee: row.payeeName },
  );
  return okVoid(`${row.payeeName} reopened`);
}

/** A manual payout that is not owed after all. A purchase payout leaves with its register lots. */
export async function cancelPayout(payoutId: string, reason: string): Promise<Result> {
  const desk = await requireDesk("payment.confirm");
  if (desk.refused) return desk.refused;
  const row = await loadPayout(payoutId);
  if (!row) return err("That payout no longer exists.", "not_found");
  if (row.source !== "manual")
    return err("A purchase payout follows the purchase register — correct or delete the purchase in the ERP instead.", "rule_violation");
  if (row.status === "paid" || row.status === "cancelled") return err("Only a payout still to pay can be cancelled.", "rule_violation");
  if (!reason.trim()) return fieldErr("reason", "Say why it is cancelled.");
  await db
    .update(vendorPayouts)
    .set({ status: "cancelled", cancelReason: reason.trim(), updatedAt: new Date(), updatedById: desk.ctx.user.id })
    .where(eq(vendorPayouts.id, payoutId));
  await audit(desk.ctx, "payout.cancel", payoutId, { status: row.status }, { status: "cancelled", reason: reason.trim(), payee: row.payeeName });
  return okVoid(`Payout to ${row.payeeName} cancelled`);
}

export async function updatePayoutNotes(payoutId: string, notes: string): Promise<Result> {
  const desk = await requireDesk("payment.record");
  if (desk.refused) return desk.refused;
  const row = await loadPayout(payoutId);
  if (!row) return err("That payout no longer exists.", "not_found");
  const next = notes.trim() || null;
  if ((row.notes ?? null) === next) return okVoid();
  await db
    .update(vendorPayouts)
    .set({ notes: next, updatedAt: new Date(), updatedById: desk.ctx.user.id })
    .where(eq(vendorPayouts.id, payoutId));
  await audit(desk.ctx, "payout.note", payoutId, { notes: row.notes }, { notes: next, payee: row.payeeName });
  return okVoid("Note saved");
}

export async function addPayoutInvoice(payoutId: string, inv: InvoiceInput): Promise<Result<{ id: string }>> {
  const desk = await requireDesk("payment.record");
  if (desk.refused) return desk.refused;
  const row = await loadPayout(payoutId);
  if (!row) return err("That payout no longer exists.", "not_found");
  const fault = invoiceFault(inv, "invoice");
  if (fault) return fault;
  let invoiceId = "";
  await db.transaction(async (tx) => {
    invoiceId = await insertInvoice(tx, payoutId, inv, desk.ctx.user.id);
    await audit(desk.ctx, "payout.invoice.add", payoutId, null, {
      kind: inv.kind.trim(),
      invoiceNo: inv.invoiceNo?.trim() || null,
      payee: row.payeeName,
    }, tx);
  });
  return ok({ id: invoiceId }, `${inv.kind.trim()} added`);
}

/** Takes an invoice off a payout. The file is marked removed, never destroyed. */
export async function removePayoutInvoice(invoiceId: string): Promise<Result> {
  const desk = await requireDesk("payment.record");
  if (desk.refused) return desk.refused;
  const [inv] = await db.select().from(vendorPayoutInvoices).where(eq(vendorPayoutInvoices.id, invoiceId));
  if (!inv) return err("That invoice is already gone.", "not_found");
  await db.transaction(async (tx) => {
    await tx.delete(vendorPayoutInvoices).where(eq(vendorPayoutInvoices.id, invoiceId));
    if (inv.attachmentId) {
      await tx
        .update(attachments)
        .set({ status: "removed", parentType: null, parentId: null, removedAt: new Date(), updatedAt: new Date() })
        .where(inArray(attachments.id, [inv.attachmentId]));
    }
    await audit(desk.ctx, "payout.invoice.remove", inv.payoutId, { kind: inv.kind, invoiceNo: inv.invoiceNo }, { removed: true }, tx);
  });
  return okVoid(`${inv.kind} removed`);
}

/** Whether this person may open a payout invoice's file — whoever holds the screen. */
export async function canReadPayoutInvoice(userId: string): Promise<boolean> {
  return canOpenModule(userId, MODULE);
}
