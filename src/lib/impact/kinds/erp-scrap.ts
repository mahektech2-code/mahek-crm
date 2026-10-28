import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { allocationRows, scrapStock } from "@/lib/erp/drums";
import {
  DRUM_CATEGORY,
  DRUM_STATUS_LABEL,
  drumLabel,
  drumReturnLabel,
  receiptLabel,
  scrapSaleLabel,
  type DrumStatus,
} from "@/lib/erp/engines/drums";
import { txnRows } from "@/lib/erp/money";
import { inr, readImpactPart } from "@/lib/erp/ui";
import type { ImpactItem } from "../types";
import type { ImpactSource } from "../registry";
import { erpMayDelete, many, present, qty } from "./erp-common";

/* ---------------------------------------------------------------------------
 * EMPTY DRUMS AND SCRAP: nothing here is deleted — every cancel keeps its row,
 * marked, with the reason in the drum's history. What moves is everything the
 * row was holding: a sale holds its drums as "sold" and a buyer's debt; a
 * return to a supplier holds drums as "returned"; a scrap receipt holds the
 * same money as a receipt in Petty Cash. Cancelling lets go of all of it at
 * once, and that is what the person at the button did not see.
 *
 * Who may ask is the act's own power, read off the same context: corrections
 * are `scrapApprove`, the buyers list is `scrapSale`, money is `scrapAccounts`.
 * ------------------------------------------------------------------------- */

type Power = "scrapSale" | "scrapAccounts" | "scrapApprove";
const REFUSAL: Record<Power, string> = {
  scrapSale: "Only the Production Head sells scrap and returns drums.",
  scrapAccounts: "Only the accountant records and matches scrap receipts.",
  scrapApprove: "Only somebody who approves drum corrections may do this.",
};
const holds = (p: Power) => (ctx: { powers: ReadonlySet<string> }) => (ctx.powers.has(p) ? null : REFUSAL[p]);

/** Where a drum stands, said as the list it leaves. */
function stockOf(status: DrumStatus, supplier: string | null): string {
  if (status === "available") return "Mahek's empty drums in stock";
  if (status === "returnable") return `drums waiting to go back to ${supplier ?? "their supplier"}`;
  return "drums in Needs review";
}

/* ======================================================= one drum's entry */

/** Every screen that lists drums with their own Cancel entry. */
const DRUM_SCREENS = ["emptyDrums", "drumReturnable", "drumReview", "drumRegister"];

export const drumEntryImpact: ImpactSource = {
  authorize: async () => {
    await erpMayDelete(DRUM_SCREENS, holds("scrapApprove"));
  },

  async report(id) {
    const [d] = await db.execute<{ no: number; status: DrumStatus; lot: string | null; seq: number | null; drums: number | null; material: string | null; supplier: string | null; godown: string; pending: number }>(sql`
      select d.drum_no as no, d.status, d.lot_no as lot, d.seq, i.drums, rm.name as material, s.name as supplier, g.name as godown,
             (select count(*)::int from erp_drum_adjustments a where a.drum_id = d.id and a.status = 'pending') as pending
        from erp_empty_drums d
        join erp_godowns g on g.id = d.godown_id
        left join erp_inward i on i.id = d.inward_id
        left join erp_raw_materials rm on rm.id = d.raw_material_id
        left join erp_suppliers s on s.id = d.supplier_id
       where d.id = ${id}`);
    if (!d) return null;
    const label = drumLabel(Number(d.no));
    const live = d.status === "available" || d.status === "returnable" || d.status === "review";
    const blockers = live ? [] : [`${label} is ${DRUM_STATUS_LABEL[d.status].toLowerCase()}; cancel the sale or return first.`];
    const pending = Number(d.pending ?? 0);

    const items: ImpactItem[] = [];
    if (live) {
      items.push({
        app: "ERP",
        label: `empty drum comes out of ${stockOf(d.status, d.supplier)} at ${d.godown}`,
        effect: "changed",
        count: 1,
        note: `It is kept, marked cancelled, with your reason in its history${d.lot && d.seq ? ` — and drum ${d.seq}${d.drums ? ` of ${d.drums}` : ""} of lot ${d.lot} can be scanned again` : ""}.`,
      });
    }
    items.push({
      app: "ERP",
      label: `change-of-owner ${many(pending, "request")} on it, waiting for approval`,
      effect: "kept",
      count: pending,
      note: "It stays on Drum adjustments; approving it afterwards is refused, as the drum is no longer in stock.",
    });

    return {
      title: `${label} · ${d.material ?? "Opening stock"}${d.lot ? ` · ${d.lot}` : ""}`,
      verb: "Cancel entry",
      confirmWord: label,
      items: present(items),
      blockers,
    };
  },
};

/* ===================================================== a return to a supplier */

export const drumReturnImpact: ImpactSource = {
  authorize: async () => {
    await erpMayDelete(["drumReturns"], holds("scrapApprove"));
  },

  async report(id) {
    const [r] = await db.execute<{ no: number; status: string; quantity: number; supplier: string }>(sql`
      select x.return_no as no, x.status, x.quantity, s.name as supplier
        from erp_drum_returns x join erp_suppliers s on s.id = x.supplier_id
       where x.id = ${id}`);
    if (!r) return null;
    const label = drumReturnLabel(Number(r.no));
    const drums = await db.execute<{ no: number }>(sql`
      select drum_no as no from erp_empty_drums where return_id = ${id} and status = 'returned' order by drum_no`);
    const blockers = r.status === "confirmed" ? [] : ["Already cancelled."];

    return {
      title: `${label} · ${r.quantity} drums to ${r.supplier}`,
      verb: "Cancel outward",
      confirmWord: label,
      items: present([
        {
          app: "ERP",
          label: `${many(drums.length, "drum")} go back to waiting for return to ${r.supplier}`,
          effect: "changed",
          count: drums.length,
          examples: drums.slice(0, 5).map((x) => drumLabel(Number(x.no))),
          note: "They are counted on Drums to return again, and can go out on another return.",
        },
      ]),
      blockers,
    };
  },
};

/* ============================================================ a scrap sale */

export const scrapSaleImpact: ImpactSource = {
  authorize: async () => {
    await erpMayDelete(["scrapSales", "scrapReceivables"], holds("scrapApprove"));
  },

  async report(id) {
    const [s] = await db.execute<{ no: number; status: string; category: string; quantity: number; unit: string; amount: string; buyer: string; godown: string | null; live: number; undone: number }>(sql`
      select s.sale_no as no, s.status, s.category, s.quantity::float8 as quantity, s.unit, s.amount_paise as amount, b.name as buyer, g.name as godown,
             (select count(*)::int from erp_scrap_allocations a where a.sale_id = s.id and a.voided_at is null) as live,
             (select count(*)::int from erp_scrap_allocations a where a.sale_id = s.id and a.voided_at is not null) as undone
        from erp_scrap_sales s
        join erp_scrap_buyers b on b.id = s.buyer_id
        left join erp_godowns g on g.id = s.godown_id
       where s.id = ${id}`);
    if (!s) return null;
    const label = scrapSaleLabel(Number(s.no));
    const amount = Number(s.amount);
    const blockers: string[] = [];
    if (s.status !== "confirmed") blockers.push("Already cancelled.");
    else if (Number(s.live) > 0) blockers.push("Money is matched to this sale. The accountant undoes the match first.");

    const items: ImpactItem[] = [];
    if (s.category === DRUM_CATEGORY) {
      const drums = await db.execute<{ no: number }>(sql`
        select drum_no as no from erp_empty_drums where scrap_sale_id = ${id} and status = 'sold' order by drum_no`);
      items.push({
        app: "ERP",
        label: `sold ${many(drums.length, "drum")} go back into Mahek's empty drums in stock`,
        effect: "changed",
        count: drums.length,
        examples: drums.slice(0, 5).map((x) => drumLabel(Number(x.no))),
        note: "Each drum's history records the sale being cancelled.",
      });
    } else {
      items.push({
        app: "ERP",
        label: `${s.unit} of ${s.category} go back into scrap stock${s.godown ? ` at ${s.godown}` : ""}`,
        effect: "changed",
        count: qty(Number(s.quantity)),
      });
    }
    items.push({
      app: "ERP",
      label: `scrap receivable closed — ${s.buyer} no longer owes it`,
      effect: "changed",
      count: s.status === "confirmed" ? 1 : 0,
      note: `${inr(amount)} leaves Scrap receivables.`,
    });
    items.push({
      app: "ERP",
      label: `undone ${many(Number(s.undone), "match", "matches")} of money to it`,
      effect: "kept",
      count: Number(s.undone),
      note: "They stay on the receipts' history, marked undone.",
    });

    return {
      title: `${label} · ${s.buyer} · ${inr(amount)}`,
      verb: "Cancel sale",
      confirmWord: label,
      items: present(items),
      blockers,
    };
  },
};

/* =========================================================== a scrap entry */

export const scrapEntryImpact: ImpactSource = {
  authorize: async () => {
    await erpMayDelete(["scrapEntries"], holds("scrapApprove"));
  },

  async report(id) {
    const [e] = await db.execute<{ status: string; category: string; unit: string; quantity: number; godownId: string; godown: string; date: string }>(sql`
      select e.status, e.category, e.unit, e.quantity::float8 as quantity, e.godown_id as "godownId", g.name as godown, e.entry_date::text as date
        from erp_scrap_entries e join erp_godowns g on g.id = e.godown_id
       where e.id = ${id}`);
    if (!e) return null;
    const blockers: string[] = [];
    let left = 0;
    if (e.status !== "active") blockers.push("Already cancelled.");
    else {
      /* The same reading of stock the act takes, less this entry. */
      const now = (await scrapStock(db)).find((s) => s.category === e.category && s.unit === e.unit && s.godownId === e.godownId)?.available ?? 0;
      left = qty(now - Number(e.quantity));
      if (left < 0) blockers.push(`Cancelling this would leave ${left} ${e.unit} of ${e.category} — more has been sold than was recorded without it.`);
    }

    return {
      title: `${qty(Number(e.quantity))} ${e.unit} of ${e.category} at ${e.godown}, recorded ${e.date}`,
      verb: "Cancel entry",
      confirmWord: "CANCEL",
      items: present([
        {
          app: "ERP",
          label: `${e.unit} of ${e.category} leave scrap stock at ${e.godown}`,
          effect: "changed",
          count: e.status === "active" ? qty(Number(e.quantity)) : 0,
          note: blockers.length ? undefined : `${left.toLocaleString("en-IN")} ${e.unit} remains to sell. The entry is kept, marked cancelled.`,
        },
      ]),
      blockers,
    };
  },
};

/* ============================================================ a scrap buyer */

export const scrapBuyerImpact: ImpactSource = {
  authorize: async () => {
    await erpMayDelete(["scrapBuyers"], holds("scrapSale"));
  },

  async report(id) {
    const [b] = await db.execute<{ name: string; active: boolean; sales: number; open: number; owed: string; unmatched: number }>(sql`
      select b.name, b.active,
             (select count(*)::int from erp_scrap_sales s where s.buyer_id = b.id and s.status = 'confirmed') as sales,
             (select count(*)::int from erp_scrap_sales s where s.buyer_id = b.id and s.status = 'confirmed'
                 and s.amount_paise > coalesce((select sum(a.amount_paise) from erp_scrap_allocations a where a.sale_id = s.id and a.voided_at is null), 0)) as open,
             (select coalesce(sum(s.amount_paise - coalesce((select sum(a.amount_paise) from erp_scrap_allocations a where a.sale_id = s.id and a.voided_at is null), 0)), 0)
                from erp_scrap_sales s where s.buyer_id = b.id and s.status = 'confirmed') as owed,
             (select count(*)::int from erp_cash_receipts r where r.buyer_id = b.id and r.status = 'active'
                 and r.amount_paise > coalesce((select sum(a.amount_paise) from erp_scrap_allocations a where a.receipt_id = r.id and a.voided_at is null), 0)) as unmatched
        from erp_scrap_buyers b
       where b.id = ${id}`);
    if (!b) return null;
    const open = Number(b.open);
    const sales = Number(b.sales);
    const unmatched = Number(b.unmatched);
    const confirmWord = b.name.length <= 40 ? b.name : "RETIRE";

    return {
      title: b.name,
      verb: "Retire",
      confirmWord,
      items: present([
        {
          app: "ERP",
          label: "scrap buyer stops being offered on new sales",
          effect: "changed",
          count: b.active ? 1 : 0,
          note: "Restore brings them back.",
        },
        {
          app: "ERP",
          label: `open ${many(open, "receivable")} — ${inr(Number(b.owed))} still owed`,
          effect: "kept",
          count: open,
          note: "They stay on Scrap receivables, and money can still be matched to them.",
        },
        {
          app: "ERP",
          label: `${many(unmatched, "receipt")} from them with money not yet matched`,
          effect: "kept",
          count: unmatched,
          note: `Every one of their ${sales} ${many(sales, "sale")} keeps the buyer's name.`,
        },
      ]),
      blockers: [],
    };
  },
};

/* ======================================================= a scrap receipt */

export const scrapReceiptImpact: ImpactSource = {
  authorize: async () => {
    await erpMayDelete(["cashReceipts"], holds("scrapAccounts"));
  },

  async report(id) {
    const [r] = await db.execute<{ no: number; status: string; amount: string; mode: string; buyer: string | null; payer: string | null; live: number; undone: number }>(sql`
      select r.receipt_no as no, r.status, r.amount_paise as amount, r.mode, b.name as buyer, r.payer,
             (select count(*)::int from erp_scrap_allocations a where a.receipt_id = r.id and a.voided_at is null) as live,
             (select count(*)::int from erp_scrap_allocations a where a.receipt_id = r.id and a.voided_at is not null) as undone
        from erp_cash_receipts r left join erp_scrap_buyers b on b.id = r.buyer_id
       where r.id = ${id}`);
    if (!r) return null;
    const label = receiptLabel(Number(r.no));
    const [money] = r.status === "active" ? await txnRows(sql`t.scrap_receipt_id = ${id} and t.status = 'active'`) : [];
    const blockers: string[] = [];
    if (r.status !== "active") blockers.push("Already void.");
    else if (Number(r.live) > 0) blockers.push("This receipt is matched to a sale. Undo the match first.");
    else if (money?.matchedPaise) blockers.push("Its money is matched to a bank line. Undo that match on Petty Cash → Bank statement first.");
    else if (money?.usedPaise) blockers.push("Cash from it has been paid onward. Cancel those first.");

    const items: ImpactItem[] = [];
    if (money) {
      items.push({
        app: "ERP",
        label: `receipt in Petty Cash cancelled — ${money.to ?? "its account"}'s balance drops by ${inr(money.amountPaise)}`,
        effect: "changed",
        count: 1,
        examples: [money.label],
        note: "The same money was entered once, in both places; voiding it here takes it out of every Petty Cash balance and report.",
      });
    }
    items.push({
      app: "ERP",
      label: `undone ${many(Number(r.undone), "match", "matches")} to scrap sales`,
      effect: "kept",
      count: Number(r.undone),
    });

    return {
      title: `${label} · ${inr(Number(r.amount))} by ${r.mode} from ${r.buyer ?? r.payer ?? "a scrap buyer"}`,
      verb: "Void",
      confirmWord: label,
      items: present(items),
      blockers,
    };
  },
};

/* ============================================ one match of a receipt, undone */

/** The match as the prompt offers it — the act finds it by these same words. */
const scrapMatchLine = (saleNo: number, amountPaise: number) => `${scrapSaleLabel(saleNo)} · ${inr(amountPaise)}`;

export const scrapMatchImpact: ImpactSource = {
  authorize: async () => {
    await erpMayDelete(["cashReceipts"], holds("scrapAccounts"));
  },

  /** The id is `impactPart(receiptId, the match's line)` — the prompt picks which match. */
  async report(id) {
    const part = readImpactPart(id);
    if (!part) return null;
    const [receiptId, line] = part;
    const a = (await allocationRows({ receiptId })).find((x) => !x.voidedAt && scrapMatchLine(x.saleNo, x.amountPaise) === line);
    if (!a) return null;
    return {
      title: `${inr(a.amountPaise)} of ${receiptLabel(a.receiptNo)} matched to ${scrapSaleLabel(a.saleNo)}`,
      verb: "Undo",
      confirmWord: "UNDO",
      items: [
        { app: "ERP", label: `scrap sale ${scrapSaleLabel(a.saleNo)} is owed ${inr(a.amountPaise)} again — back on Scrap receivables`, effect: "changed", count: 1 },
        { app: "ERP", label: `receipt ${receiptLabel(a.receiptNo)} has ${inr(a.amountPaise)} unmatched again, free to match elsewhere`, effect: "changed", count: 1 },
        { app: "ERP", label: "match kept on both records, marked undone with your reason", effect: "kept", count: 1 },
      ],
      blockers: [],
    };
  },
};
