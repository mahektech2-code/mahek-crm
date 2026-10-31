import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { invoiceFileFor, invoiceFilesFor } from "./order-tracking";

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

/** One order of a selection, for the Print invoices pop-up. */
export type InvoicePrintItem = { orderNo: number; party: string; invoiceNo: string | null; hasPdf: boolean; fileId: string | null };

/** The orders a selection of order lines belongs to, in order, each with whether its invoice PDF is there. */
export async function invoicePrintList(lineIds: string[]): Promise<InvoicePrintItem[]> {
  const ids = [...new Set(lineIds)].slice(0, 2000);
  if (!ids.length) return [];
  const rows = (await db.execute(sql`
    select o.order_no as no, min(c.name) as party, min(o.tally_bill_no) as inv, min(o.order_date) as d
      from erp_orders o left join customers c on c.id = o.billing_customer_id
     where o.order_no in (select order_no from erp_orders where id in ${ids})
       and o.status <> 'Cancel'
     group by o.order_no
     order by min(o.order_date) desc, o.order_no desc
  `)) as unknown as Row[];
  const nos = rows.map((r) => Number(r.no));
  const files = await invoiceFilesFor(nos);
  return rows.map((r) => {
    const f = files.get(Number(r.no));
    return { orderNo: Number(r.no), party: str(r.party) ?? "—", invoiceNo: str(r.inv), hasPdf: !!f, fileId: f?.id ?? null };
  });
}
