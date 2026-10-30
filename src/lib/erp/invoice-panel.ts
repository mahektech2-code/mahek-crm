import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { invoiceFileFor } from "./order-tracking";

/* The order record's Invoice tab: the PDF it opens, every upload, and the check. */

export type InvoicePanel = {
  orderNo: number;
  invoiceNo: string | null;
  invoiceDate: string | null;
  file: { id: string; filename: string; contentType: string } | null;
  uploads: { id: string; filename: string; at: string; by: string | null; current: boolean }[];
  check: { state: string; by: string | null; at: string | null; note: string | null } | null;
};

type Row = Record<string, unknown>;
const str = (v: unknown) => (v == null || v === "" ? null : String(v));
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

export async function invoicePanel(orderNo: number): Promise<InvoicePanel> {
  const file = await invoiceFileFor(orderNo);
  const uploads = (await db.execute(sql`
    select a.id, a.filename, a.created_at as at, u.name as by
      from attachments a left join users u on u.id = a.uploaded_by_id
     where a.parent_type = 'erp_invoice' and a.parent_id = ${String(orderNo)}
     order by a.created_at desc limit 20
  `)) as unknown as Row[];
  const [c] = (await db.execute(sql`
    select o.tally_bill_no as no, o.invoice_date as date, d.invoice_check as state, d.invoice_checked_at as at, d.invoice_check_note as note, u.name as by
      from erp_orders o
      join erp_order_details d on d.order_id = o.id
      left join users u on u.id = d.invoice_checked_by_id
     where o.order_no = ${orderNo} and o.status <> 'Cancel'
     order by d.invoice_checked_at desc nulls last
     limit 1
  `)) as unknown as Row[];
  return {
    orderNo,
    invoiceNo: str(c?.no),
    invoiceDate: c?.date ? String(c.date).slice(0, 10) : null,
    file: file ? { id: file.id, filename: file.filename, contentType: (await contentTypeOf(file.id)) ?? "application/pdf" } : null,
    uploads: uploads.map((u) => ({ id: String(u.id), filename: String(u.filename), at: iso(u.at)!, by: str(u.by), current: String(u.id) === file?.id })),
    check: c ? { state: str(c.state) ?? "Pending", by: str(c.by), at: iso(c.at), note: str(c.note) } : null,
  };
}

async function contentTypeOf(id: string): Promise<string | null> {
  const [r] = (await db.execute(sql`select content_type from attachments where id = ${id}`)) as unknown as Row[];
  return str(r?.content_type);
}
