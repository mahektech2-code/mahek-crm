import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { erpQuoteRows } from "@/db/schema";
import { LIVE_PO, requirementLabel } from "@/lib/erp/engines/purchase-flow";
import { QM_RAISED_REMARK } from "@/lib/erp/screens/requirement-po";
import { nf } from "@/lib/erp/ui";
import type { ImpactItem } from "../types";
import type { ImpactSource } from "../registry";
import { erpMayDelete, many, present } from "./erp-common";

/* ---------------------------------------------------------------------------
 * THE QUOTATION MANAGER IS A SPREADSHEET, AND TWO OF ITS GESTURES ARE NOT.
 * Typing, pasting and colouring are undone with Ctrl+Z and touch nothing but
 * the sheet. Undoing a purchase reaches the ERP: Purchase it wrote a purchase
 * order line, possibly a whole PO, and a requirement it was put against — all
 * three move back when the rate stops being bought. And deleting a row that
 * holds a bought rate leaves that PO standing while the sheet stops showing
 * where it came from, so a requirement can no longer link its number.
 *
 * Those are the two the grid asks about before it saves, and the save refuses
 * without the confirmation (`applyQuoteOps`).
 * ------------------------------------------------------------------------- */

const onTheSheet = async () => {
  await erpMayDelete(["quoteManager"]);
};

/** A cell's id on the modal: `rowId:columnId` — neither id carries a colon. */
export const quoteCellKey = (rowId: string, columnId: string) => `${rowId}:${columnId}`;

type CellRow = { columnId: string; material: string; value: string; status: string | null; poNo: string | null; drums: number | null };

const cellsOf = (rowId: string) =>
  db.execute(sql`
    select c.column_id as "columnId", concat_ws(' · ', nullif(col.name, ''), nullif(col.pack, ''), nullif(col.brand, '')) as material,
           c.value, c.status, c.po_no as "poNo", c.drums
      from erp_quote_cells c join erp_quote_columns col on col.id = c.column_id
     where c.row_id = ${rowId} and (c.value <> '' or c.status is not null)
     order by col.position
  `) as unknown as Promise<CellRow[]>;

/* ================================================================= a row */

export const quoteRowImpact: ImpactSource = {
  authorize: onTheSheet,

  async report(id) {
    const [row] = await db.select().from(erpQuoteRows).where(and(eq(erpQuoteRows.id, id), isNull(erpQuoteRows.deletedAt)));
    if (!row) return null;
    const cells = await cellsOf(id);
    const bought = cells.filter((c) => c.status === "po" || c.status === "pickup");
    const rates = cells.filter((c) => !bought.includes(c));
    const items: ImpactItem[] = [
      {
        app: "ERP",
        label: `${many(rates.length, "rate")} on the row come off the sheet`,
        effect: "deleted",
        count: rates.length,
        examples: rates.slice(0, 5).map((c) => `${c.material || "Untitled"} · ${c.value || "—"}`),
        note: "Ctrl+Z on the sheet brings the row back while the page is open. Once it is closed, no screen shows the row again.",
      },
      {
        app: "ERP",
        label: `bought ${many(bought.length, "rate")} on the row — their purchase orders stay`,
        effect: "kept",
        count: bought.length,
        examples: bought.slice(0, 5).map((c) => `${c.material || "Untitled"} · ${c.poNo ?? "no PO number"}`),
        note: "The POs stay in Purchase orders and go on receiving, but the sheet stops showing where they were bought, and a requirement can no longer link these PO numbers. Undo the purchase first if it should go too.",
      },
    ];
    const party = row.party.trim();
    return {
      title: `${party || "the untitled row"} · ${row.quoteDate}`,
      verb: "Delete",
      confirmWord: party && party.length <= 40 ? party : "DELETE",
      items: present(items),
      blockers: [],
    };
  },
};

/* ========================================================= undo a purchase */

export const quotePurchaseImpact: ImpactSource = {
  authorize: onTheSheet,

  async report(id) {
    const [rowId, columnId] = id.split(":");
    if (!rowId || !columnId) return null;
    const [cell] = (await db.execute(sql`
      select c.value, c.status, c.po_no as "poNo", c.drums,
             concat_ws(' · ', nullif(col.name, ''), nullif(col.pack, ''), nullif(col.brand, '')) as material, r.party
        from erp_quote_cells c
        join erp_quote_rows r on r.id = c.row_id and r.deleted_at is null
        join erp_quote_columns col on col.id = c.column_id
       where c.row_id = ${rowId} and c.column_id = ${columnId}
    `)) as unknown as (CellRow & { party: string })[];
    if (!cell) return null;
    const title = `${cell.material || "the rate"} from ${cell.party || "an unnamed party"}${cell.poNo ? ` on ${cell.poNo}` : ""}`;
    const confirmWord = cell.poNo && cell.poNo.length <= 40 ? cell.poNo : "UNDO";
    if (cell.status !== "po") return { title, verb: "Undo purchase", confirmWord, items: [], blockers: ["That rate is not bought any more."] };

    /* The ERP PO line Purchase it wrote — the same read `withdrawQuotePo` makes. */
    const [line] = (await db.execute(sql`
      select l.id, l.po_id as "poId", l.requisition_id as "reqId", o.qm_po_no as name, l.quantity::float8 as qty, l.unit,
             q.req_no as "reqNo", q.remarks,
             (select count(*)::int from erp_po_lines x where x.po_id = l.po_id and x.id <> l.id) as others,
             (select coalesce(sum(i.quantity), 0)::float8 from erp_inward i where i.po_line_id = l.id)
               + (select coalesce(sum(p.quantity), 0)::float8 from erp_purchases p where p.po_line_id = l.id and p.source = 'manual') as received
        from erp_po_lines l
        join erp_purchase_orders o on o.id = l.po_id
        join erp_requisitions q on q.id = l.requisition_id
       where l.quote_row_id = ${rowId} and l.quote_column_id = ${columnId}
         and o.source = 'quotation_manager' and o.status in (${sql.join(LIVE_PO.map((x) => sql`${x}`), sql`, `)})
       limit 1
    `)) as unknown as { id: string; poId: string; reqId: string; name: string | null; qty: number; unit: string; reqNo: number | null; remarks: string | null; others: number; received: number }[];

    const blockers: string[] = [];
    const items: ImpactItem[] = [
      {
        app: "ERP",
        label: `rate on the sheet no longer bought${cell.poNo ? ` — PO number ${cell.poNo} comes off it` : ""}`,
        effect: "changed",
        count: 1,
        note: cell.drums ? `${nf(cell.drums)} ${many(Number(cell.drums), "drum")} were bought on it.` : undefined,
      },
    ];
    if (line) {
      const po = line.name ?? "its purchase order";
      if (Number(line.received) > 0) blockers.push(`Goods were received against ${line.name ?? "this PO"} — the purchase cannot be undone. Close the PO short on Purchase orders instead.`);
      const req = line.reqNo ? requirementLabel(Number(line.reqNo)) : "its requirement";
      items.push({ app: "ERP", label: `line on purchase order ${po}`, effect: "deleted", count: 1, note: `${nf(line.qty)} ${line.unit} of ${cell.material || "the material"}.` });
      items.push(
        Number(line.others)
          ? { app: "ERP", label: `purchase order ${po} rewritten without it`, effect: "changed", count: 1, note: `Its ${nf(line.others)} other ${many(Number(line.others), "line")} stay on it.` }
          : { app: "ERP", label: `purchase order ${po} cancelled — this was its only line`, effect: "changed", count: 1 },
      );
      items.push(
        line.remarks === QM_RAISED_REMARK
          ? { app: "ERP", label: `requirement ${req} cancelled — this purchase raised it`, effect: "changed", count: 1 }
          : { app: "ERP", label: `requirement ${req} goes back to waiting for a PO`, effect: "changed", count: 1, note: "Its vendor is cleared, so it can be bought again." },
      );
    }
    return { title, verb: "Undo purchase", confirmWord, items: present(items), blockers };
  },
};
