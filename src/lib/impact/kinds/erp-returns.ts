import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { scrapStock } from "@/lib/erp/drums";
import {
  CHEMICAL_SCRAP,
  customerReturnLabel,
  debitNoteLabel,
  dispositionLabel,
  purchaseReturnLabel,
  returnOutwardLabel,
  reworkLabel,
  wasteLabel,
} from "@/lib/erp/engines/returns";
import { customerRows, decisionLine, decisionRows, vendorRows } from "@/lib/erp/screens/returns";
import { fgLotStock, packLotStock } from "@/lib/erp/stock";
import { inr, nf, readImpactPart } from "@/lib/erp/ui";
import type { ImpactItem } from "../types";
import type { ImpactSource } from "../registry";
import { erpMayDelete, many, present, qty } from "./erp-common";

/* ---------------------------------------------------------------------------
 * A RETURN IS THREE DOCUMENTS DEEP, and cancelling one end reaches the other
 * two. A vendor return carries a debit note — which Accounts already take off
 * what is paid to the supplier — and a goods outward that moved stock out of
 * the lot. A customer return carries a credit-note request on the customer's
 * complaint in the CRM, the labelled cans held in quarantine, and every QC
 * decision that put material back in stock, into scrap, rework or waste.
 *
 * The acts keep every document, marked cancelled or reversed; what the report
 * names is what stops counting because of it.
 * ------------------------------------------------------------------------- */

const approves = (ctx: { administrator: boolean; powers: ReadonlySet<string> }) => ctx.administrator || ctx.powers.has("returnApprove");
const VENDOR = ["vendorReturns", "returnOutwards"];
const CUSTOMER = ["customerReturns", "returnQc"];

/** Labelled cans or boxes that would move from one state to another, as the act moves them: the first `n` by sequence. */
async function unitsMoving(orderId: string, lotFrom: string, lotCode: string, status: string, n: number): Promise<number> {
  const want = Math.floor(n + 1e-9);
  if (want <= 0) return 0;
  const [r] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from erp_units where lot_from = ${lotFrom} and lot_code = ${lotCode} and order_id = ${orderId} and status = ${status}`);
  return Math.min(want, Number(r?.n ?? 0));
}

/* ======================================================== vendor: outwards */

export const returnOutwardCancelImpact: ImpactSource = {
  authorize: async () => {
    await erpMayDelete(VENDOR, (ctx) => (approves(ctx) || ctx.level === "manager" ? null : "A manager or somebody who approves returns cancels it."));
  },

  async report(id) {
    const [r] = await vendorRows(sql`r.id = ${id}`);
    if (!r) return null;
    const draft = r.outStatus === "draft";
    return {
      title: `${r.outNo ? returnOutwardLabel(r.outNo) : "Outward"} for ${purchaseReturnLabel(r.no)} · ${r.item} lot ${r.lot} to ${r.supplier}`,
      verb: "Cancel outward",
      confirmWord: r.outNo ? returnOutwardLabel(r.outNo) : "CANCEL",
      items: present([
        {
          app: "ERP",
          label: `${purchaseReturnLabel(r.no)} goes back to waiting for its goods to be dispatched`,
          effect: "changed",
          count: draft ? 1 : 0,
          note: "The outward was never confirmed, so no stock moves. It is kept, marked cancelled.",
        },
        {
          app: "Accounts",
          label: `debit note ${r.dnNo ? debitNoteLabel(r.dnNo) : ""} stays issued to ${r.supplier}`,
          effect: "kept",
          count: draft && r.dnId ? 1 : 0,
          note: "It is still taken off what is paid for this purchase. Cancel the return to cancel it.",
        },
      ]),
      blockers: draft ? [] : ["There is no unconfirmed outward on this return."],
    };
  },
};

export const returnOutwardReverseImpact: ImpactSource = {
  authorize: async () => {
    await erpMayDelete(VENDOR, (ctx) => (approves(ctx) ? null : "Reversing a confirmed dispatch needs the returns power."));
  },

  async report(id) {
    const [r] = await vendorRows(sql`r.id = ${id}`);
    if (!r) return null;
    const confirmed = r.outStatus === "confirmed";
    const unit = r.unit === "Pcs" ? "Pcs" : "L";
    return {
      title: `${r.outNo ? returnOutwardLabel(r.outNo) : "Outward"} for ${purchaseReturnLabel(r.no)} · ${r.item} lot ${r.lot} to ${r.supplier}`,
      verb: "Reverse",
      confirmWord: r.outNo ? returnOutwardLabel(r.outNo) : "REVERSE",
      items: present([
        {
          app: "ERP",
          label: `${unit} of ${r.item} come back into lot ${r.lot}${r.outGodown ? ` at ${r.outGodown}` : ""}`,
          effect: "changed",
          count: confirmed ? qty(r.stockQty) : 0,
          note: `The outward is kept, marked cancelled, and ${purchaseReturnLabel(r.no)} waits to be dispatched again.`,
        },
        {
          app: "Accounts",
          label: `debit note ${r.dnNo ? debitNoteLabel(r.dnNo) : ""} stays issued to ${r.supplier}`,
          effect: "kept",
          count: confirmed && r.dnId ? 1 : 0,
          note: "Reversing the dispatch does not cancel it: Accounts still take it off what is paid for this purchase. Cancel the return to cancel the note.",
        },
      ]),
      blockers: confirmed ? [] : ["There is no confirmed outward on this return."],
    };
  },
};

/* ===================================================== vendor: the return */

export const vendorReturnImpact: ImpactSource = {
  async authorize(id) {
    const [r] = await vendorRows(sql`r.id = ${id}`);
    await erpMayDelete(VENDOR, (ctx) =>
      approves(ctx) || (r && r.requesterId === ctx.user.id && r.status === "pending") ? null : "Cancelling an approved return needs the returns power.",
    );
  },

  async report(id) {
    const [r] = await vendorRows(sql`r.id = ${id}`);
    if (!r) return null;
    const blockers: string[] = [];
    if (r.status === "cancelled" || r.status === "rejected") blockers.push("That return is already closed.");
    else if (r.outStatus === "confirmed") blockers.push("Its goods have left — reverse the dispatch first, then cancel the return.");
    const [dn] = r.dnId ? await db.execute<{ status: string }>(sql`select status from erp_debit_notes where id = ${r.dnId}`) : [];
    const dnLive = dn?.status === "issued";

    const items: ImpactItem[] = [
      {
        app: "Accounts",
        label: `debit note ${r.dnNo ? debitNoteLabel(r.dnNo) : ""} cancelled — ${r.supplier}'s payable for PR ${r.pr} goes back up`,
        effect: "changed",
        count: dnLive ? 1 : 0,
        note: r.dnTotal != null ? `${inr(r.dnTotal)} is no longer taken off what is paid for this purchase. The note is kept, marked cancelled.` : undefined,
      },
      {
        app: "ERP",
        label: `goods return outward ${r.outNo ? returnOutwardLabel(r.outNo) : ""} (never confirmed) cancelled`,
        effect: "changed",
        count: r.outStatus === "draft" ? 1 : 0,
        note: "No stock had moved.",
      },
    ];
    return {
      title: `${purchaseReturnLabel(r.no)} · ${nf(r.qty)} ${r.unit} of ${r.item} lot ${r.lot} to ${r.supplier}`,
      verb: "Cancel return",
      confirmWord: purchaseReturnLabel(r.no),
      items: present(items),
      blockers,
    };
  },
};

/* =================================================== customer: the return */

export const customerReturnImpact: ImpactSource = {
  async authorize(id) {
    const [r] = await customerRows(sql`r.id = ${id}`);
    await erpMayDelete(CUSTOMER, (ctx) =>
      approves(ctx) || (r && r.requesterId === ctx.user.id && r.received == null) ? null : "Cancelling a received return needs the returns power.",
    );
  },

  async report(id) {
    const [r] = await customerRows(sql`r.id = ${id}`);
    if (!r) return null;
    const active = await decisionRows(sql`d.customer_return_id = ${id} and d.status = 'active'`);
    const blockers: string[] = [];
    if (r.status !== "open") blockers.push("That return is not open.");
    else if (active.length) blockers.push("QC has decided part of it — reverse those decisions first.");
    else if (r.cnStatus === "issued") blockers.push("Its credit note has been issued — Accounts reverse it before the return can be cancelled.");

    const unit = r.lotFrom === "pack" ? "boxes" : "cans";
    const units = r.received != null ? await unitsMoving(r.orderId, r.lotFrom, r.lot, "returned", r.received) : 0;
    const items: ImpactItem[] = [
      {
        app: "CRM",
        label: `credit-note request on ${r.customer}'s complaint refused`,
        effect: "changed",
        count: r.complaintId ? 1 : 0,
        note: "It leaves the credit notes Accounts have waiting. The complaint itself stays as it is.",
      },
      {
        app: "ERP",
        label: `${unit} received into quarantine leave it — they count as with ${r.customer} again`,
        effect: "changed",
        count: qty(r.received ?? 0),
        note: units ? `${units} labelled ${many(units, unit === "boxes" ? "box" : "can", unit)} of lot ${r.lot} go back to dispatched on order ${r.orderNo}.` : undefined,
      },
    ];
    return {
      title: `${customerReturnLabel(r.no)} · ${nf(r.qty)} ${unit} of ${r.sku} from ${r.customer}`,
      verb: "Cancel return",
      confirmWord: customerReturnLabel(r.no),
      items: present(items),
      blockers,
    };
  },
};

/* ============================================ customer: one QC decision */

export const qcDecisionImpact: ImpactSource = {
  authorize: async () => {
    await erpMayDelete(CUSTOMER, (ctx) => (ctx.administrator || ctx.powers.has("returnQc") ? null : "Reversing a QC decision needs the returns QC power."));
  },

  /** The id is `impactPart(returnId, the decision's line as the prompt offered it)` — matched the way the act matches it. */
  async report(id) {
    const part = readImpactPart(id);
    if (!part) return null;
    const [returnId, line] = part;
    const [r] = await customerRows(sql`r.id = ${returnId}`);
    if (!r) return null;
    const unitWord = r.unit.toLowerCase();
    const d = (await decisionRows(sql`d.customer_return_id = ${returnId} and d.status = 'active'`)).find((x) => decisionLine(x, unitWord) === line);
    if (!d) return null;
    const [x] = await db.execute<{ godownId: string | null; scrapEntryId: string | null }>(sql`
      select godown_id as "godownId", scrap_entry_id as "scrapEntryId" from erp_return_dispositions where id = ${d.id}`);
    const n = Number(d.qty);
    const blockers: string[] = [];
    const items: ImpactItem[] = [];

    if (d.kind === "reuse") {
      const have = x?.godownId ? (r.lotFrom === "pack" ? await packLotStock(r.lot, x.godownId) : r.fgId ? await fgLotStock(r.fgId, r.lot, x.godownId) : 0) : 0;
      if (have + 1e-9 < n) blockers.push(`Only ${nf(have)} ${r.lotFrom === "pack" ? "boxes" : "cans"} of ${r.lot} are left at that godown — the rest has been used, so it cannot come back into quarantine.`);
      items.push({
        app: "ERP",
        label: `${r.lotFrom === "pack" ? "boxes" : "cans"} leave ${r.lotFrom === "pack" ? "packing" : "FG"} lot ${r.lot}${d.godown ? ` at ${d.godown}` : ""} — the stock entry this decision made goes with it`,
        effect: "deleted",
        count: qty(n),
      });
      items.push({ app: "ERP", label: `labelled ${r.lotFrom === "pack" ? "boxes" : "cans"} go from saleable back to quarantine`, effect: "changed", count: await unitsMoving(r.orderId, r.lotFrom, r.lot, "available", n) });
    } else {
      if (d.kind === "scrap" && x?.scrapEntryId) {
        const [e] = await db.execute<{ godownId: string; kg: number; status: string }>(sql`
          select godown_id as "godownId", quantity::float8 as kg, status from erp_scrap_entries where id = ${x.scrapEntryId}`);
        if (e?.status === "active") {
          const now = (await scrapStock(db)).find((s) => s.category === CHEMICAL_SCRAP && s.unit === "Kg" && s.godownId === e.godownId)?.available ?? 0;
          if (now - Number(e.kg) < -1e-9) blockers.push("That chemical scrap has been sold since, so the decision cannot be reversed.");
          items.push({ app: "ERP", label: `kg of ${CHEMICAL_SCRAP} leave scrap stock — its scrap entry is cancelled`, effect: "changed", count: qty(Number(e.kg)) });
        }
      }
      if (d.kind === "rework") {
        if (d.reworkStatus !== "open") blockers.push("That rework has been completed — its recovered SFG is in stock, so it cannot be reversed.");
        items.push({ app: "ERP", label: `rework order ${d.reworkNo ? reworkLabel(d.reworkNo) : ""} cancelled`, effect: "changed", count: d.reworkStatus === "open" ? 1 : 0 });
      }
      if (d.kind === "waste") {
        if (d.wasteStatus !== "pending") blockers.push("That waste has been disposed of, so it cannot come back into quarantine.");
        items.push({ app: "ERP", label: `waste disposal ${d.wasteNo ? wasteLabel(d.wasteNo) : ""} cancelled`, effect: "changed", count: d.wasteStatus === "pending" ? 1 : 0 });
      }
      items.push({ app: "ERP", label: `labelled ${r.lotFrom === "pack" ? "boxes" : "cans"} go from rejected back to quarantine`, effect: "changed", count: await unitsMoving(r.orderId, r.lotFrom, r.lot, "rejected", n) });
    }
    items.push({
      app: "ERP",
      label: `${unitWord} of ${customerReturnLabel(r.no)} back in quarantine, waiting for QC to decide again`,
      effect: "changed",
      count: qty(n),
      note: "The decision is kept, marked reversed, with your reason.",
    });

    return {
      title: `${dispositionLabel(d.kind)} on ${customerReturnLabel(r.no)} · ${nf(n)} ${unitWord} of ${r.sku}`,
      verb: "Reverse",
      confirmWord: "REVERSE",
      items: present(items),
      blockers,
    };
  },
};
