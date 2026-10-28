import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { customerReturnLabel } from "@/lib/erp/engines/returns";
import { manualMove, UNIT_STATUS_LABEL, type UnitStatus } from "@/lib/erp/engines/trace";
import { isErpManager } from "@/lib/erp/screens/common";
import { countLabel } from "@/lib/erp/stock-check";
import type { ImpactItem } from "../types";
import type { ImpactSource } from "../registry";
import { erpMayDelete, many, present } from "./erp-common";

/* ---------------------------------------------------------------------------
 * STOCK ACCURACY AND BOX IDS. A count is not only a row on the office's list:
 * it is a task on the factory phone, it may be the recount a red flag is
 * waiting on, and it may be the blind count a requisition is held behind
 * before anybody may buy. Cancelling one lets go of each of those, and the
 * requisition is the surprise — a cancelled count holds the purchase again
 * until somebody counts.
 *
 * A box released from hold, or put back after a customer returned it, is
 * scannable at the dispatch desk again; a returned one also leaves the order
 * it came back from. Neither moves stock — the ledger never counted the hold.
 * ------------------------------------------------------------------------- */

const runsCounts = (word: "count" | "check") => (ctx: Parameters<typeof isErpManager>[0] & { powers: ReadonlySet<string> }) =>
  isErpManager(ctx) || ctx.powers.has("stockControl") ? null : `A manager or somebody who controls stock accuracy cancels a ${word}.`;

type Count = { no: number; status: string; item: string; godown: string; parent: string | null; parentNo: number | null; parentStatus: string | null; req: string | null; reqNo: number | null };

async function countOf(id: string): Promise<Count | null> {
  const [c] = await db.execute<Count>(sql`
    select c.count_no as no, c.status, m.name as item, g.name as godown, c.recount_of_id as parent, p.count_no as "parentNo", p.status as "parentStatus",
           c.requisition_id as req, r.req_no as "reqNo"
      from erp_stock_counts c
      join erp_raw_materials m on m.id = c.raw_material_id
      join erp_godowns g on g.id = c.godown_id
      left join erp_stock_counts p on p.id = c.recount_of_id
      left join erp_requisitions r on r.id = c.requisition_id
     where c.id = ${id}`);
  return c ?? null;
}

/** A requisition held behind this count: it waits for a new one once this is cancelled. */
function heldAgain(c: Count, still: boolean): ImpactItem {
  return {
    app: "ERP",
    label: `requisition ${c.reqNo ?? ""} ${still ? "stays" : "is"} held at Blind count until the stock is counted again`,
    effect: still ? "kept" : "changed",
    count: c.req ? 1 : 0,
    note: "A cancelled count does not let the purchase through: open a new count, or have the stock exception approved.",
  };
}

/* ============================================================ one count */

export const stockCountImpact: ImpactSource = {
  authorize: async () => {
    await erpMayDelete(["countTasks", "stockCounts"], runsCounts("count"));
  },

  async report(id) {
    const c = await countOf(id);
    if (!c) return null;
    const open = c.status === "open";
    const items: ImpactItem[] = [
      {
        app: "Factory",
        label: `counting task leaves the factory phone's list`,
        effect: "changed",
        count: open ? 1 : 0,
        note: `${c.item} at ${c.godown}. The count is kept, marked cancelled, with your reason.`,
      },
      {
        app: "ERP",
        label: `red flag ${c.parentNo ? countLabel(c.parentNo) : ""} goes back to Red flags, to be recounted again`,
        effect: "changed",
        count: open && c.parent && c.parentStatus === "recount" ? 1 : 0,
      },
    ];
    if (!c.parent) items.push(heldAgain(c, true));
    return {
      title: `${countLabel(c.no)} · ${c.item} at ${c.godown}`,
      verb: "Cancel count",
      confirmWord: countLabel(c.no),
      items: present(items),
      blockers: open ? [] : ["That count is no longer open."],
    };
  },
};

/* ===================================================== a whole check (red flag) */

export const stockCheckImpact: ImpactSource = {
  authorize: async () => {
    await erpMayDelete(["stockFlags"], runsCounts("check"));
  },

  async report(id) {
    const c = await countOf(id);
    if (!c) return null;
    const [[pending], recounts] = await Promise.all([
      db.execute<{ n: number }>(sql`select count(*)::int as n from erp_stock_adjustments where count_id = ${id} and status = 'pending'`),
      db.execute<{ no: number }>(sql`select count_no as no from erp_stock_counts where recount_of_id = ${id} and status = 'open' order by count_no`),
    ]);
    const blockers = Number(pending?.n) > 0 ? ["An adjustment for this check is waiting for a decision — decide it first."] : [];
    /* A flagged check lets the purchase carry on; cancelled, the requisition waits for a count again. */
    const wasLetting = c.status === "flagged" || c.status === "recount" || c.status === "investigating" || c.status === "matched" || c.status === "resolved";
    return {
      title: `${countLabel(c.no)} · ${c.item} at ${c.godown}`,
      verb: "Cancel check",
      confirmWord: countLabel(c.no),
      items: present([
        {
          app: "ERP",
          label: "check leaves Red flags — the difference it found is no longer followed up",
          effect: "changed",
          count: c.status === "cancelled" ? 0 : 1,
          note: "Only for a count opened by mistake. A real difference is resolved, not cancelled.",
        },
        {
          app: "Factory",
          label: `open ${many(recounts.length, "recount")} cancelled with it — off the factory phone's list`,
          effect: "changed",
          count: recounts.length,
          examples: recounts.slice(0, 5).map((r) => countLabel(Number(r.no))),
        },
        heldAgain(c, !wasLetting),
      ]),
      blockers,
    };
  },
};

/* ============================================ boxes back into stock */

export const unitReleaseImpact: ImpactSource = {
  authorize: async () => {
    await erpMayDelete(["units", "allUnits"]);
  },

  /** One box id, or a selection's ids joined by commas. */
  async report(id) {
    const ids = [...new Set(id.split(",").map((s) => s.trim()).filter(Boolean))];
    if (!ids.length) return null;
    const rows = await db.execute<{ id: string; status: UnitStatus; orderNo: number | null; cr: number | null }>(sql`
      select u.id, u.status, o.order_no as "orderNo",
             (select r.return_no from erp_customer_returns r
               where r.order_id = u.order_id and r.lot_code = u.lot_code and r.status = 'open' and r.received_qty is not null
               order by r.created_at desc limit 1) as cr
        from erp_units u left join erp_orders o on o.id = u.order_id
       where u.id in ${ids}`);
    if (!rows.length) return null;
    const go = rows.filter((r) => !manualMove(r.status, "available"));
    const stay = rows.filter((r) => manualMove(r.status, "available"));
    const blockers = go.length ? [] : [`${stay[0].id}: ${manualMove(stay[0].status, "available")}`];
    const held = go.filter((r) => r.status === "hold");
    const returned = go.filter((r) => r.status === "returned");
    const quarantined = returned.filter((r) => r.cr != null);
    const one = rows.length === 1 ? rows[0] : null;

    return {
      title: one ? `${one.id} · ${UNIT_STATUS_LABEL[one.status] ?? one.status}` : `${rows.length} boxes`,
      verb: returned.length && !held.length ? "Back into stock" : "Release hold",
      confirmWord: one ? one.id : "RELEASE",
      items: present([
        {
          app: "ERP",
          label: `${many(held.length, "box", "boxes")} on hold can be scanned for dispatch again`,
          effect: "changed",
          count: held.length,
          examples: held.slice(0, 5).map((r) => r.id),
        },
        {
          app: "ERP",
          label: `returned ${many(returned.length, "box", "boxes")} back in stock — off the order ${returned.length === 1 ? "it" : "they"} came back from`,
          effect: "unlinked",
          count: returned.length,
          examples: returned.slice(0, 5).map((r) => (r.orderNo ? `${r.id} · order ${r.orderNo}` : r.id)),
        },
        {
          app: "ERP",
          label: `open customer ${many(quarantined.length, "return")} still holding ${quarantined.length === 1 ? "this box" : "these boxes"} in quarantine`,
          effect: "kept",
          count: quarantined.length,
          examples: [...new Set(quarantined.map((r) => customerReturnLabel(Number(r.cr))))].slice(0, 5),
          note: "Putting a box back here does not decide the return: QC still counts the material as in quarantine.",
        },
        {
          app: "ERP",
          label: `selected ${many(stay.length, "box", "boxes")} left as ${stay.length === 1 ? "it is" : "they are"} — only a box on hold or returned goes back`,
          effect: "kept",
          count: go.length ? stay.length : 0,
          examples: stay.slice(0, 5).map((r) => `${r.id} · ${UNIT_STATUS_LABEL[r.status] ?? r.status}`),
        },
      ]),
      blockers,
    };
  },
};
