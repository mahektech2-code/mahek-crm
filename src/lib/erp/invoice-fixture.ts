import "server-only";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { attachments, erpOrders } from "@/db/schema";

/**
 * FOR TESTS: an invoice PDF on the order a line belongs to, placed directly.
 * An invoice is approved only with its PDF, so a test whose subject is what
 * happens after the check needs one; attaching it through Bill it is tested
 * in erp-order-tracking.test.ts.
 */
export async function attachInvoicePdf(lineId: string, uploadedById: string): Promise<string> {
  const [o] = await db.select({ no: erpOrders.orderNo }).from(erpOrders).where(eq(erpOrders.id, lineId));
  if (!o) throw new Error(`No order line ${lineId}`);
  const id = `att_${randomUUID()}`;
  await db.insert(attachments).values({
    id,
    filename: `invoice-${o.no}.pdf`,
    storedRef: `pg:test-${id}`,
    contentType: "application/pdf",
    sizeBytes: 10,
    status: "available",
    uploadedById,
    parentType: "erp_invoice",
    parentId: String(o.no),
  });
  return id;
}
