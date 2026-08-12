/**
 * Undo scripts/tally-receipts.ts, for one customer or for all of them.
 *
 *   npx tsx scripts/tally-receipts-revert.ts --customer="COLOUR CAMP" --dry-run
 *   npx tsx scripts/tally-receipts-revert.ts --customer="COLOUR CAMP" --apply
 *   npx tsx scripts/tally-receipts-revert.ts --all --apply
 *
 * A migration that rewrites the payment ledger has to have an undo written
 * before it is trusted, not after something looks wrong. This is that undo, and
 * it is exact rather than approximate: the import's own writes are identifiable
 * without guessing, so nothing else has to be touched to reverse them.
 *
 *   - receipts it created carry `source = 'tally_receipts'`
 *   - reversals it performed carry `updated_by_id = 'system:tally-records'`
 *
 * That second mark is what keeps this safe. Eighteen `sheet_import` receipts
 * were ALREADY reversed by a person before any of this ran, and re-confirming
 * those would put money back on the books that somebody had deliberately taken
 * off. They are left exactly where they are, because they do not carry the mark.
 *
 * Deleting the created receipts is not the deletion this project warns about:
 * they are rows this import wrote minutes ago, never seen by anybody, and no
 * decision of anybody's is recorded in them. The rows this migration must never
 * destroy are the assumed ones, and those are only ever reversed.
 */
import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "../src/db";
import { auditLog, bills, customers, paymentReceipts } from "../src/db/schema";
import {
  recomputeBillPaid,
  recomputeFollowUpState,
  recomputeOutstanding,
} from "../src/lib/recompute";

const SYSTEM_ACTOR = "system:tally-records";

async function main() {
  const args = process.argv.slice(2);
  const flag = (n: string) =>
    args.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");
  const apply = args.includes("--apply");
  const all = args.includes("--all");
  const only = flag("customer");
  if (!all && !only) throw new Error("pass --customer=<name> or --all");

  const targets = all
    ? await db
        .selectDistinct({ id: paymentReceipts.customerId })
        .from(paymentReceipts)
        .where(eq(paymentReceipts.source, "tally_receipts"))
    : await db
        .select({ id: customers.id })
        .from(customers)
        .where(eq(customers.name, only!));
  if (!targets.length) throw new Error("no matching customer");

  for (const { id: customerId } of targets) {
    const created = await db
      .select({ id: paymentReceipts.id })
      .from(paymentReceipts)
      .where(
        and(
          eq(paymentReceipts.customerId, customerId),
          eq(paymentReceipts.source, "tally_receipts"),
        ),
      );
    const reversed = await db
      .select({ id: paymentReceipts.id })
      .from(paymentReceipts)
      .where(
        and(
          eq(paymentReceipts.customerId, customerId),
          eq(paymentReceipts.source, "sheet_import"),
          eq(paymentReceipts.status, "reversed"),
          eq(paymentReceipts.updatedById, SYSTEM_ACTOR),
        ),
      );

    console.log(
      `${customerId}: remove ${created.length} imported receipts, restore ${reversed.length} reversals`,
    );
    if (!apply) continue;

    await db.transaction(async (tx) => {
      if (created.length) {
        // `payments` rows go with them: the foreign key is ON DELETE CASCADE.
        await tx.delete(auditLog).where(
          and(
            eq(auditLog.entityType, "payment_receipt"),
            inArray(auditLog.entityId, created.map((r) => r.id)),
          ),
        );
        await tx
          .delete(paymentReceipts)
          .where(inArray(paymentReceipts.id, created.map((r) => r.id)));
      }
      if (reversed.length) {
        await tx
          .update(paymentReceipts)
          .set({ status: "confirmed", rejectReason: null, updatedById: null })
          .where(inArray(paymentReceipts.id, reversed.map((r) => r.id)));
        await tx.delete(auditLog).where(
          and(
            eq(auditLog.action, "payment.reverse"),
            inArray(auditLog.entityId, reversed.map((r) => r.id)),
          ),
        );
      }
    });

    await recomputeBillPaid(customerId);
    await db.execute(sql`
      update bills set status = case
        when paid_amount >= amount then 'paid'::bill_status
        when paid_amount > 0 then 'partially_paid'::bill_status
        else 'unpaid'::bill_status
      end, updated_at = now()
      where customer_id = ${customerId}
    `);
    await recomputeOutstanding(customerId);
    await recomputeFollowUpState(customerId);
  }

  console.log(apply ? "reverted." : "dry run — nothing written");
  void bills;
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
