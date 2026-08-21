import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  attachments,
  auditLog,
  bills,
  complaints,
  customers,
  paymentReceipts,
  payments,
} from "@/db/schema";
import { requireCapability } from "../access-control";
import { categoryLabel } from "../complaint-labels";
import {
  recomputeBillPaid,
  recomputeBillStatuses,
  recomputeFollowUpState,
  recomputeOutstanding,
  today,
} from "../recompute";
import { err, ok, okVoid, type Result } from "../result";

/* ---------------------------------------------------------------------------
 * Credit notes.
 *
 * A telecaller on a complaint answers one question: did the customer ask for a
 * credit note. Which bill it comes off and what it is worth is accounts' work,
 * because they hold the ledger — asking mid-call produced either the wrong
 * bill or no request at all.
 *
 * Until this screen existed the requests surfaced on a manager's pending list,
 * which is where things go when the app that should own them has not been
 * built. It has now.
 *
 * ISSUING one is money leaving what the customer owes, so it is recorded the
 * way money is recorded everywhere else: a confirmed receipt in mode
 * `Adjustment`, with an allocation line against the named bill or, where none
 * is named, on account. That is not a workaround — it is what keeps a credit
 * note visible on the statement, inside `recomputeBillPaid`, and reversible by
 * the same rejection path as any other receipt. A credit note that quietly
 * decremented `bills.amount` would be a hand-edited derived value.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

const rupees = (paise: number) =>
  `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;

export type CreditNoteRequest = {
  complaintId: string;
  customerId: string;
  customerName: string;
  /** What the customer owes in total, so the amount can be read against it. */
  outstanding: number;
  /** Paise. Null where the telecaller recorded no figure — accounts decide it. */
  amount: number | null;
  category: string;
  categoryLabel: string;
  description: string;
  goodsDescription: string | null;
  raisedByName: string | null;
  raisedAt: Date;
  waitingHours: number;
  /** Null when the request names no bill, which is ordinary and allowed. */
  billId: string | null;
  billNo: string | null;
  billBalance: number | null;
  /** Photographs on the complaint. Ids only — bytes come from the endpoint. */
  photos: Array<{ id: string; filename: string }>;
  status: string;
};

/** Everything asked for and not yet decided, longest wait first. */
export async function pendingCreditNotes(): Promise<CreditNoteRequest[]> {
  await requireCapability("payment.record");

  const rows = await db
    .select({
      complaint: complaints,
      customerName: customers.name,
      outstanding: customers.outstanding,
      billNo: bills.billNo,
      billBalance: sql<number | null>`(bills.amount - bills.paid_amount)::bigint`,
      raisedBy: sql<string | null>`(
        select u.name from users u where u.id = complaints.logged_by_user_id
      )`,
      waitingHours: sql<number>`
        round(extract(epoch from (now() - complaints.created_at)) / 3600)::int`,
    })
    .from(complaints)
    .innerJoin(customers, eq(customers.id, complaints.customerId))
    .leftJoin(bills, eq(bills.id, complaints.billId))
    .where(
      and(
        eq(complaints.requestCn, true),
        sql`coalesce(${complaints.cnStatus}, 'requested') in ('requested', 'under_review')`,
      ),
    )
    .orderBy(sql`complaints.created_at asc`);

  if (!rows.length) return [];

  const photos = await db
    .select({
      id: attachments.id,
      parentId: attachments.parentId,
      filename: attachments.filename,
    })
    .from(attachments)
    .where(
      and(
        eq(attachments.parentType, "complaint"),
        eq(attachments.status, "available"),
        inArray(
          attachments.parentId,
          rows.map((r) => r.complaint.id),
        ),
      ),
    );

  const byComplaint = new Map<string, Array<{ id: string; filename: string }>>();
  for (const p of photos) {
    if (!p.parentId) continue;
    const list = byComplaint.get(p.parentId) ?? [];
    list.push({ id: p.id, filename: p.filename });
    byComplaint.set(p.parentId, list);
  }

  return rows.map(({ complaint: c, ...rest }) => ({
    complaintId: c.id,
    customerId: c.customerId,
    customerName: rest.customerName,
    outstanding: Number(rest.outstanding ?? 0),
    amount: c.cnAmount === null ? null : Number(c.cnAmount),
    category: c.category,
    categoryLabel: categoryLabel(c.category),
    description: c.description,
    goodsDescription: c.goodsDescription,
    raisedByName: rest.raisedBy,
    raisedAt: c.createdAt,
    waitingHours: Number(rest.waitingHours ?? 0),
    billId: c.billId,
    billNo: rest.billNo,
    billBalance: rest.billBalance === null ? null : Number(rest.billBalance),
    photos: byComplaint.get(c.id) ?? [],
    status: c.cnStatus ?? "requested",
  }));
}

export async function pendingCreditNoteCount(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(complaints)
    .where(
      and(
        eq(complaints.requestCn, true),
        sql`coalesce(${complaints.cnStatus}, 'requested') in ('requested', 'under_review')`,
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * Issue one.
 *
 * The amount is accounts' to set, because the telecaller was never asked for
 * it and a figure typed on a complaint is a request rather than a decision. It
 * is refused above the bill's open balance: a credit note larger than the debt
 * it settles is either a mistake or a refund, and a refund is not this.
 */
export async function issueCreditNote(input: {
  complaintId: string;
  /** Paise. */
  amount: number;
  /** The external system's CN number, where the accountant already has one. */
  reference?: string;
}): Promise<Result<{ receiptId: string }>> {
  const ctx = await requireCapability("creditnote.issue");

  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    return err("Set what the credit note is worth.", "validation", [
      { field: "amount", message: "Enter an amount in rupees." },
    ]);
  }

  const [row] = await db
    .select({
      complaint: complaints,
      billNo: bills.billNo,
      billBalance: sql<number | null>`(bills.amount - bills.paid_amount)::bigint`,
      customerName: customers.name,
    })
    .from(complaints)
    .innerJoin(customers, eq(customers.id, complaints.customerId))
    .leftJoin(bills, eq(bills.id, complaints.billId))
    .where(eq(complaints.id, input.complaintId));

  if (!row) return err("That request no longer exists.", "not_found");
  if (!row.complaint.requestCn) {
    return err("No credit note was asked for on this complaint.", "conflict");
  }
  const status = row.complaint.cnStatus ?? "requested";
  if (status === "issued" || status === "approved") {
    return err("Somebody has already issued this one.", "conflict");
  }
  if (status === "rejected") {
    return err(
      "That request was refused. It cannot be issued without being raised again.",
      "conflict",
    );
  }

  // A credit against a named bill cannot exceed what is open on it. Against no
  // bill it lands on account, where there is nothing to exceed.
  if (row.complaint.billId !== null && row.billBalance !== null) {
    if (input.amount > Number(row.billBalance)) {
      return err(
        `${row.billNo} has only ${rupees(Number(row.billBalance))} open. A credit note cannot be worth more than the bill it comes off.`,
        "validation",
        [{ field: "amount", message: "Lower the amount, or issue it on account." }],
      );
    }
  }

  const receiptId = id("rcp");
  const day = await today();
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx.insert(paymentReceipts).values({
      id: receiptId,
      customerId: row.complaint.customerId,
      amount: input.amount,
      receivedAt: day,
      mode: "Adjustment",
      reference: input.reference?.trim() || null,
      note: `Credit note against complaint ${row.complaint.id}`,
      status: "confirmed",
      source: "accounts",
      reportedById: ctx.user.id,
      confirmedById: ctx.user.id,
      confirmedAt: now,
      idempotencyKey: `creditnote:${row.complaint.id}`,
      createdById: ctx.user.id,
      updatedById: ctx.user.id,
    });

    await tx.insert(payments).values({
      id: id("pay"),
      receiptId,
      billId: row.complaint.billId,
      customerId: row.complaint.customerId,
      amount: input.amount,
      paidAt: day,
      mode: "Adjustment",
      reference: input.reference?.trim() || null,
      externalRef: `creditnote:${row.complaint.id}`,
      recordedById: ctx.user.id,
      createdById: ctx.user.id,
      updatedById: ctx.user.id,
    });

    await tx
      .update(complaints)
      .set({
        cnStatus: "issued",
        cnAmount: input.amount,
        cnReference: input.reference?.trim() || null,
        updatedById: ctx.user.id,
        updatedAt: now,
      })
      .where(eq(complaints.id, input.complaintId));

    await tx.insert(auditLog).values({
      id: id("aud"),
      actorId: ctx.user.id,
      // Which hat allowed it — see `audit_log.actor_role`.
      actorRole: ctx.authorisedBy,
      action: "creditnote.issue",
      entityType: "complaint",
      entityId: input.complaintId,
      beforeState: { cnStatus: status } as never,
      afterState: {
        cnStatus: "issued",
        amount: input.amount,
        billId: row.complaint.billId,
        reference: input.reference?.trim() ?? null,
        receiptId,
      } as never,
    });
  });

  await applyToLedger(row.complaint.customerId);

  return ok(
    { receiptId },
    row.complaint.billId
      ? `${rupees(input.amount)} credited against ${row.billNo}`
      : `${rupees(input.amount)} credited — it sits on account until a bill takes it`,
  );
}

/** Refuse one. The telecaller who raised it has to explain it, so say why. */
export async function refuseCreditNote(
  complaintId: string,
  reason: string,
): Promise<Result> {
  const ctx = await requireCapability("creditnote.issue");

  if (!reason.trim()) {
    return err("Say why the request is being refused.", "validation", [
      { field: "reason", message: "A reason is required." },
    ]);
  }

  const [row] = await db
    .select()
    .from(complaints)
    .where(eq(complaints.id, complaintId));
  if (!row) return err("That request no longer exists.", "not_found");

  const status = row.cnStatus ?? "requested";
  if (status === "issued") {
    return err(
      "That credit note has already been issued. Rejecting the receipt is how it comes back.",
      "conflict",
    );
  }
  if (status === "rejected") return okVoid("Already refused");

  await db.transaction(async (tx) => {
    await tx
      .update(complaints)
      .set({
        cnStatus: "rejected",
        // The refusal belongs on the complaint the telecaller reads, not in a
        // note nobody opens.
        resolutionNotes: [row.resolutionNotes, `Credit note refused: ${reason.trim()}`]
          .filter(Boolean)
          .join("\n"),
        updatedById: ctx.user.id,
        updatedAt: new Date(),
      })
      .where(eq(complaints.id, complaintId));

    await tx.insert(auditLog).values({
      id: id("aud"),
      actorId: ctx.user.id,
      // Which hat allowed it — see `audit_log.actor_role`.
      actorRole: ctx.authorisedBy,
      action: "creditnote.refuse",
      entityType: "complaint",
      entityId: complaintId,
      beforeState: { cnStatus: status } as never,
      afterState: {
        cnStatus: "rejected",
        reason: reason.trim(),
        amount: row.cnAmount ?? 0,
      } as never,
    });
  });

  return okVoid("Request refused");
}

/** The same order the receipt path uses — each step reads what the last wrote. */
async function applyToLedger(customerId: string): Promise<void> {
  await recomputeBillPaid(customerId);
  await recomputeBillStatuses();
  await recomputeOutstanding(customerId);
  await recomputeFollowUpState(customerId);
}
