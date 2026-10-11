import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { erpDrumReturns, erpScrapAllocations, erpScrapBuyers, erpScrapCollections, erpScrapReceipts, erpScrapSales } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { calendarDate } from "@/lib/business-date";
import { err, fieldErr, okVoid, type Result } from "@/lib/result";
import type { ErpContext } from "../access";
import { powerRefusal } from "../access";
import {
  AGEING_BUCKETS,
  CATEGORY_LABEL,
  CATEGORY_UNITS,
  DRUM_STATUS_LABEL,
  OWNERSHIP_LABEL,
  VENDOR_DRUM_REFUSAL,
  ageingBucket,
  allocationRefusal,
  categoryByLabel,
  daysBetween,
  drumMoveRefusal,
  fifoPick,
  highVariance,
  invoiceRefusal,
  otherScrapBalance,
  outstanding,
  routeDrum,
  saleAmount,
  salePayState,
  spreadOldestFirst,
  tareVariance,
  type AgeingBucket,
  type DrumOwnership,
  type DrumStatus,
  type ScrapCategory,
} from "../engines/scrap";
import { erpLink } from "../registry";
import { drumNoLabel, receiptNoLabel, returnNoLabel, saleNoLabel } from "../scrap";
import { erpAudit, erpId, int, nextNumber, num, paise, stampLine, text, type ScreenModule } from "../server";
import type { ActionSpec, ColSpec, FieldSpec, FormSpec, ListRow, ToolSpec } from "../ui";
import { inr, nf } from "../ui";
import { godownIdByName, godownOptions, inTx, refuse, type Tx } from "./common";

/* ---------------------------------------------------------------------------
 * SCRAP & EMPTY DRUMS — one screen, nine tabs:
 *
 *   Empty drums · Mahek stock · Vendor drums · Returns · Scrap sales ·
 *   Other scrap · Buyers · Receipts · Tare variance
 *
 * A drum is registered at the scale (`/erp/empty-drums`) against its GRN lot.
 * Every balance here — drums available, drums pending return, what a buyer
 * owes — is read off the transactions and never typed.
 * ------------------------------------------------------------------------- */

const today = () => calendarDate(new Date());
const kg = (x: number | null) => (x == null ? null : Math.round(x * 1000) / 1000);
const signedKg = (x: number | null) => (x == null ? "—" : `${x > 0 ? "+" : ""}${nf(x)} kg`);
const plural = (n: number, one: string, many = `${one}s`) => `${nf(n)} ${n === 1 ? one : many}`;

const sells = (ctx: ErpContext) => ctx.powers.has("scrapSell");
const controls = (ctx: ErpContext) => ctx.powers.has("scrapControl");
const matches = (ctx: ErpContext) => ctx.powers.has("scrapReceipts");

const RECORD_TOOL: ToolSpec = { id: "record", l: "Record empty drum", primary: true, href: "/erp/empty-drums" };

/* ============================================================ the drums */

type DrumRow = {
  id: string;
  drumNo: number;
  seq: number;
  lot: string;
  pr: number;
  status: DrumStatus;
  ownership: DrumOwnership | null;
  declared: number | null;
  weight: number;
  first: number;
  weightNote: string | null;
  statusNote: string | null;
  supplier: string;
  supplierId: string;
  item: string;
  godown: string;
  lotDrums: number | null;
  grnDate: string;
  purchaseId: string;
  emptiedAt: Date;
  updatedAt: Date;
  by: string | null;
  saleNo: number | null;
  saleDate: string | null;
  buyer: string | null;
  returnNo: number | null;
  returnDate: string | null;
};

async function drumRows(where = sql`true`): Promise<DrumRow[]> {
  const rows = (await db.execute(sql`
    select d.id, d.drum_no as "drumNo", d.seq, d.lot_no as lot, d.pr_number as pr, d.status, d.ownership,
           d.declared_tare_kg::float8 as declared, d.weight_kg::float8 as weight, d.first_weight_kg::float8 as first,
           d.weight_note as "weightNote", d.status_note as "statusNote",
           s.name as supplier, s.id as "supplierId", m.name as item, g.name as godown,
           coalesce(p.drums, i.drums) as "lotDrums", p.purchase_date::text as "grnDate", d.purchase_id as "purchaseId",
           d.emptied_at as "emptiedAt", d.updated_at as "updatedAt", u.name as by,
           ss.sale_no as "saleNo", ss.sale_date::text as "saleDate", b.name as buyer,
           rr.return_no as "returnNo", rr.return_date::text as "returnDate"
      from erp_empty_drums d
      join erp_suppliers s on s.id = d.supplier_id
      join erp_raw_materials m on m.id = d.raw_material_id
      join erp_godowns g on g.id = d.godown_id
      join erp_purchases p on p.id = d.purchase_id
      left join erp_inward i on i.id = p.inward_id
      left join users u on u.id = d.emptied_by_id
      left join erp_scrap_sales ss on ss.id = d.sale_id
      left join erp_scrap_buyers b on b.id = ss.buyer_id
      left join erp_drum_returns rr on rr.id = d.return_id
     where ${where}
     order by d.emptied_at desc, d.drum_no desc
     limit 10000
  `)) as unknown as DrumRow[];
  return rows.map((r) => ({
    ...r,
    drumNo: Number(r.drumNo),
    seq: Number(r.seq),
    pr: Number(r.pr),
    declared: r.declared == null ? null : Number(r.declared),
    weight: Number(r.weight),
    first: Number(r.first),
    lotDrums: r.lotDrums == null ? null : Number(r.lotDrums),
    saleNo: r.saleNo == null ? null : Number(r.saleNo),
    returnNo: r.returnNo == null ? null : Number(r.returnNo),
  }));
}

const OWNERSHIP_PROMPT = (r: DrumRow, sub: string): ActionSpec["prompt"] => ({
  title: `Who owns the drums of lot ${r.lot}?`,
  sub,
  submit: "Save",
  fields: [
    { k: "ownership", l: "Owner", t: "select", req: true, opts: [OWNERSHIP_LABEL.mahek, OWNERSHIP_LABEL.vendor], def: r.ownership ? OWNERSHIP_LABEL[r.ownership] : "" },
    { k: "reason", l: r.ownership ? "Why it is changing" : "How you know (optional)", t: "area", req: !!r.ownership },
  ],
});

const emptyDrums: ScreenModule = {
  key: "emptyDrums",
  async load(ctx) {
    const config = await getConfig();
    const alert = config["erp.scrap.varianceAlertKg"];
    const rows = await drumRows();
    const cols: ColSpec[] = [
      { k: "drum", l: "Drum", t: "mono", w: 96 },
      { k: "status", l: "Status", t: "s" },
      { k: "item", l: "Material", t: "b" },
      { k: "supplier", l: "Supplier", t: "t" },
      { k: "lot", l: "GRN lot", t: "mono" },
      { k: "of", l: "Drum of lot", t: "t" },
      { k: "weight", l: "Empty weight", t: "n", u: " kg" },
      { k: "declared", l: "Declared tare", t: "n", u: " kg" },
      { k: "variance", l: "Variance", t: "n", u: " kg" },
      { k: "emptied", l: "Emptied", t: "d" },
      { k: "by", l: "Weighed by", t: "t" },
      { k: "godown", l: "Godown", t: "t" },
      { k: "ownership", l: "Ownership", t: "s" },
      { k: "f", l: "Flags", t: "f" },
    ];
    return {
      spec: {
        screen: "emptyDrums",
        cols,
        hidden: [],
        chips: "status",
        groups: ["supplier", "lot"],
        agg: { k: "weight", l: "kg" },
        godownKey: "godown",
        tools: [RECORD_TOOL],
        download: true,
        sortDefault: ["drum", -1],
        noDataLine: "No drum has been recorded as empty yet. When a drum's material is used up, weigh it and record it — Record empty drum, above.",
      },
      rows: rows.map((r): ListRow => {
        const v = tareVariance(r.weight, r.declared);
        const flags: string[] = [];
        if (r.status === "review") flags.push("ownershipReview");
        if (r.status !== "cancelled" && highVariance(v, alert)) flags.push("tareHigh");
        if (r.weightNote) flags.push("weightException");
        if (r.weight !== r.first) flags.push("corrected");
        const moveWhy = (to: "cancelled" | "decide" | "correct") => drumMoveRefusal(r.status, to) ?? (controls(ctx) ? "" : powerRefusal("scrapControl"));
        const actions: ActionSpec[] = [];
        if (r.status === "review")
          actions.push({ id: "ownership", l: "Decide ownership for this lot", primary: true, why: moveWhy("decide"), prompt: OWNERSHIP_PROMPT(r, "The GRN did not record it. Your answer applies to every drum of this lot — the ones already emptied and the ones still to come.") });
        else if (r.status === "available" || r.status === "returnable")
          actions.push({ id: "ownership", l: "Change ownership for this lot", why: moveWhy("correct"), prompt: OWNERSHIP_PROMPT(r, "Moves every unsold, unreturned drum of this lot to the other stock. The change and its reason are kept.") });
        actions.push(
          {
            id: "correct",
            l: "Correct the weight",
            why: moveWhy("correct"),
            prompt: {
              title: `Correct the weight of ${drumNoLabel(r.drumNo)}`,
              sub: `First recorded as ${nf(r.first)} kg. The first figure is kept; this records the corrected one and why.`,
              submit: "Save correction",
              fields: [
                { k: "weight", l: "Empty weight (kg)", t: "num", req: true, min: 0.1, def: String(r.weight) },
                { k: "reason", l: "Why", t: "area", req: true },
              ],
            },
          },
          {
            id: "cancel",
            l: "Cancel this drum record",
            why: moveWhy("cancelled"),
            prompt: { title: `Cancel ${drumNoLabel(r.drumNo)}`, sub: "Takes it out of stock. The record stays, marked cancelled, with your reason.", submit: "Cancel record", fields: [{ k: "reason", l: "Why", t: "area", req: true }] },
          },
        );
        if (r.saleNo != null) actions.push({ id: "sale", l: `Open ${saleNoLabel(r.saleNo)}`, href: erpLink("scrapSales", { open: `sale:${r.saleNo}` }) });
        if (r.returnNo != null) actions.push({ id: "ret", l: `Open ${returnNoLabel(r.returnNo)}`, href: erpLink("drumReturns", { open: `ret:${r.returnNo}` }) });
        return {
          id: r.id,
          v: {
            drum: drumNoLabel(r.drumNo),
            status: DRUM_STATUS_LABEL[r.status],
            item: r.item,
            supplier: r.supplier,
            lot: r.lot,
            of: r.lotDrums ? `${r.seq} of ${r.lotDrums}` : String(r.seq),
            weight: r.weight,
            declared: r.declared,
            variance: v?.kg ?? null,
            emptied: calendarDate(new Date(r.emptiedAt)),
            by: r.by,
            godown: r.godown,
            ownership: r.ownership ? OWNERSHIP_LABEL[r.ownership] : "Not recorded",
          },
          flags,
          title: `${drumNoLabel(r.drumNo)} · ${r.item}`,
          header: `Drum ${r.seq}${r.lotDrums ? ` of ${r.lotDrums}` : ""} of GRN lot ${r.lot} (PR ${r.pr}, ${r.grnDate}) from ${r.supplier} · ${DRUM_STATUS_LABEL[r.status]}`,
          fields: [
            { l: "Ownership", v: r.ownership ? OWNERSHIP_LABEL[r.ownership] : "Not recorded on the GRN — waiting for the Production Head" },
            { l: "Empty weight", v: `${nf(r.weight)} kg${r.weight !== r.first ? ` (first recorded ${nf(r.first)} kg)` : ""}` },
            { l: "Supplier-declared tare", v: r.declared == null ? "Not on the GRN" : `${nf(r.declared)} kg` },
            { l: "Variance", v: v ? `${signedKg(v.kg)}${v.pct != null ? ` (${v.pct > 0 ? "+" : ""}${v.pct}%)` : ""}` : "—", der: true },
            ...(r.weightNote ? [{ l: "Weight let through because", v: r.weightNote }] : []),
            ...(r.saleNo != null ? [{ l: "Sold on", v: `${saleNoLabel(r.saleNo)} · ${r.saleDate} · ${r.buyer} (allocated oldest first)` }] : []),
            ...(r.returnNo != null ? [{ l: "Returned on", v: `${returnNoLabel(r.returnNo)} · ${r.returnDate} (allocated oldest first)` }] : []),
            ...(r.statusNote ? [{ l: "Note", v: r.statusNote }] : []),
          ],
          actions,
          by: `Weighed ${stampLine(r.by, r.emptiedAt).replace(/^Created /, "")}`,
        };
      }),
    };
  },
  actions: {
    async ownership(ctx, id, values) {
      if (!controls(ctx)) return err(powerRefusal("scrapControl"), "not_permitted");
      const owner: DrumOwnership | null = values.ownership === OWNERSHIP_LABEL.mahek ? "mahek" : values.ownership === OWNERSHIP_LABEL.vendor ? "vendor" : null;
      if (!owner) return fieldErr("ownership", "Choose who owns the drums.");
      const reason = text(values.reason);
      let lot = "";
      let moved = 0;
      let before: DrumOwnership | null = null;
      const res = await inTx(async (tx) => {
        const [d] = (await tx.execute(sql`select purchase_id as "purchaseId", lot_no as lot, status from erp_empty_drums where id = ${id}`)) as unknown as { purchaseId: string; lot: string; status: DrumStatus }[];
        if (!d) return refuse(err("No such drum.", "not_found"));
        const [p] = (await tx.execute(sql`select drum_ownership as ownership from erp_purchases where id = ${d.purchaseId} for update`)) as unknown as { ownership: DrumOwnership | null }[];
        before = p?.ownership ?? null;
        lot = d.lot;
        if (before === owner) return refuse(err(`Lot ${d.lot}'s drums are already ${OWNERSHIP_LABEL[owner].toLowerCase()}.`, "rule_violation"));
        if (before && !reason) return refuse(fieldErr("reason", "Say why the ownership is changing."));
        await tx.execute(sql`update erp_purchases set drum_ownership = ${owner}, drum_ownership_set_by_id = ${ctx.user.id}, drum_ownership_set_at = now(), updated_at = now() where id = ${d.purchaseId}`);
        /* Everything of the lot still in the building moves with the decision; a drum sold or returned stays where it went. */
        const r = (await tx.execute(sql`
          update erp_empty_drums set ownership = ${owner}, status = ${routeDrum(owner)}, status_note = ${reason}, updated_at = now(), updated_by_id = ${ctx.user.id}
           where purchase_id = ${d.purchaseId} and status in ('review', 'available', 'returnable')
          returning id
        `)) as unknown as { id: string }[];
        moved = r.length;
        return okVoid("");
      });
      if (!res.ok) return res;
      await erpAudit(ctx, "erp.emptyDrum.ownership", "erp_purchase", lot, { ownership: before }, { ownership: owner, drumsMoved: moved, reason });
      return okVoid(`Lot ${lot}: drums are ${OWNERSHIP_LABEL[owner].toLowerCase()} · ${plural(moved, "drum")} moved to ${owner === "mahek" ? "Mahek stock" : "vendor-returnable stock"}`);
    },
    async correct(ctx, id, values) {
      if (!controls(ctx)) return err(powerRefusal("scrapControl"), "not_permitted");
      const weight = num(values.weight);
      const reason = text(values.reason);
      if (weight == null || weight <= 0) return fieldErr("weight", "Enter the empty weight in kg.");
      if (!reason) return fieldErr("reason", "Say why the weight is being corrected.");
      let label = "";
      let before = 0;
      const res = await inTx(async (tx) => {
        const [d] = (await tx.execute(sql`select drum_no as "drumNo", status, weight_kg::float8 as weight from erp_empty_drums where id = ${id} for update`)) as unknown as { drumNo: number; status: DrumStatus; weight: number }[];
        if (!d) return refuse(err("No such drum.", "not_found"));
        const why = drumMoveRefusal(d.status, "correct");
        if (why) return refuse(err(why, "rule_violation"));
        label = drumNoLabel(Number(d.drumNo));
        before = Number(d.weight);
        await tx.execute(sql`update erp_empty_drums set weight_kg = ${kg(weight)}, status_note = ${reason}, updated_at = now(), updated_by_id = ${ctx.user.id} where id = ${id}`);
        return okVoid("");
      });
      if (!res.ok) return res;
      await erpAudit(ctx, "erp.emptyDrum.correct", "erp_empty_drum", label, { weightKg: before }, { weightKg: kg(weight), reason });
      return okVoid(`${label}: weight corrected from ${nf(before)} kg to ${nf(weight)} kg`);
    },
    async cancel(ctx, id, values) {
      if (!controls(ctx)) return err(powerRefusal("scrapControl"), "not_permitted");
      const reason = text(values.reason);
      if (!reason) return fieldErr("reason", "Say why the record is being cancelled.");
      let label = "";
      let before: DrumStatus = "available";
      const res = await inTx(async (tx) => {
        const [d] = (await tx.execute(sql`select drum_no as "drumNo", status from erp_empty_drums where id = ${id} for update`)) as unknown as { drumNo: number; status: DrumStatus }[];
        if (!d) return refuse(err("No such drum.", "not_found"));
        const why = drumMoveRefusal(d.status, "cancelled");
        if (why) return refuse(err(why, "rule_violation"));
        label = drumNoLabel(Number(d.drumNo));
        before = d.status;
        await tx.execute(sql`update erp_empty_drums set status = 'cancelled', status_note = ${reason}, updated_at = now(), updated_by_id = ${ctx.user.id} where id = ${id}`);
        return okVoid("");
      });
      if (!res.ok) return res;
      await erpAudit(ctx, "erp.emptyDrum.cancel", "erp_empty_drum", label, { status: before }, { status: "cancelled", reason });
      return okVoid(`${label} cancelled and taken out of stock`);
    },
  },
};

/* ============================================== Mahek drum stock (ledger) */

const drumStock: ScreenModule = {
  key: "drumStock",
  async load(ctx) {
    /* Every movement of a Mahek-owned drum: emptied in (by day), sold out (by sale), cancelled out (by day). */
    const rows = (await db.execute(sql`
      select 'in' as kind, (d.emptied_at at time zone 'Asia/Kolkata')::date::text as day, count(*)::int as qty, null::int as "saleNo", null::text as buyer,
             string_agg(distinct m.name, ', ') as detail, min(d.emptied_at) as at
        from erp_empty_drums d join erp_raw_materials m on m.id = d.raw_material_id
       where d.ownership = 'mahek'
       group by 2
      union all
      select 'cancel', (d.updated_at at time zone 'Asia/Kolkata')::date::text, count(*)::int, null, null, string_agg(distinct d.status_note, '; '), max(d.updated_at)
        from erp_empty_drums d
       where d.ownership = 'mahek' and d.status = 'cancelled'
       group by 2
      union all
      select 'sale', s.sale_date::text, (select count(*) from erp_empty_drums x where x.sale_id = s.id)::int, s.sale_no, b.name, null, s.created_at
        from erp_scrap_sales s join erp_scrap_buyers b on b.id = s.buyer_id
       where s.category = 'drum' and s.status = 'active'
    `)) as unknown as { kind: "in" | "cancel" | "sale"; day: string; qty: number; saleNo: number | null; buyer: string | null; detail: string | null; at: Date }[];
    const ordered = [...rows].sort((a, b) => (a.day === b.day ? new Date(a.at).getTime() - new Date(b.at).getTime() : a.day < b.day ? -1 : 1));
    let balance = 0;
    const lines = ordered.map((r, i) => {
      const delta = r.kind === "in" ? Number(r.qty) : -Number(r.qty);
      balance += delta;
      return { ...r, i, delta, balance };
    });
    const cols: ColSpec[] = [
      { k: "date", l: "Date", t: "d" },
      { k: "type", l: "Transaction", t: "s" },
      { k: "qty", l: "Quantity", t: "n" },
      { k: "balance", l: "Balance", t: "n" },
      { k: "ref", l: "Reference", t: "mono" },
      { k: "detail", l: "Detail", t: "t", w: 220 },
    ];
    return {
      spec: {
        screen: "drumStock",
        cols,
        hidden: [],
        chips: "type",
        readOnly: true,
        download: true,
        tools: [RECORD_TOOL, ...(sells(ctx) ? [{ id: "sell", l: "Sell drums", href: erpLink("scrapSales", { new: "1", category: CATEGORY_LABEL.drum }) } as ToolSpec] : [])],
        sortDefault: ["date", -1],
        scopedLine: `${plural(balance, "Mahek-owned empty drum")} available now · read off the transactions below, never typed. Vendor-returnable drums are never in this stock.`,
        noDataLine: "No Mahek-owned drum has been emptied yet.",
      },
      rows: lines.reverse().map((r) => ({
        id: `${r.kind}:${r.day}:${r.saleNo ?? r.i}`,
        v: {
          date: r.day,
          type: r.kind === "in" ? "Emptied" : r.kind === "sale" ? "Scrap sale" : "Cancelled",
          qty: r.delta,
          balance: r.balance,
          ref: r.saleNo != null ? saleNoLabel(r.saleNo) : null,
          detail: r.kind === "sale" ? r.buyer : r.detail,
        },
        flags: [],
        title: r.kind === "sale" ? `${saleNoLabel(r.saleNo!)} · ${r.buyer}` : `${r.kind === "in" ? "Emptied" : "Cancelled"} on ${r.day}`,
        actions: r.kind === "sale" ? [{ id: "open", l: `Open ${saleNoLabel(r.saleNo!)}`, primary: true, href: erpLink("scrapSales", { open: `sale:${r.saleNo}` }) }] : [{ id: "open", l: "See the drums", primary: true, href: erpLink("emptyDrums") }],
      })),
    };
  },
};

/* ===================================================== vendor returnable */

type Pending = { supplierId: string; supplier: string; pending: number; returned: number; oldest: Date | null; lots: string | null; mobile: string | null };

async function pendingBySupplier(): Promise<Pending[]> {
  const rows = (await db.execute(sql`
    select s.id as "supplierId", s.name as supplier, s.mobile,
           count(*) filter (where d.status = 'returnable')::int as pending,
           count(*) filter (where d.status = 'returned')::int as returned,
           min(d.emptied_at) filter (where d.status = 'returnable') as oldest,
           string_agg(distinct d.lot_no, ', ') filter (where d.status = 'returnable') as lots
      from erp_empty_drums d join erp_suppliers s on s.id = d.supplier_id
     where d.ownership = 'vendor' and d.status in ('returnable', 'returned')
     group by s.id, s.name, s.mobile
     order by min(d.emptied_at) filter (where d.status = 'returnable') nulls last
  `)) as unknown as Pending[];
  return rows.map((r) => ({ ...r, pending: Number(r.pending), returned: Number(r.returned) }));
}

const returnFields = (supplierOpts: string[], fixed?: string): FieldSpec[] => [
  ...(fixed ? [] : [{ k: "supplier", l: "Supplier", t: "select" as const, req: true, opts: supplierOpts }]),
  { k: "quantity", l: "Drums returned", t: "num", req: true, min: 1 },
  { k: "date", l: "Return date", t: "date", req: true, def: today() },
  { k: "challan", l: "Challan / return reference", t: "text", hint: "The supplier's challan or our gate pass number, if there is one." },
  { k: "remark", l: "Remark", t: "area" },
];

const returnableDrums: ScreenModule = {
  key: "returnableDrums",
  async load(ctx) {
    const now = today();
    const rows = await pendingBySupplier();
    const open = rows.filter((r) => r.pending > 0);
    const cols: ColSpec[] = [
      { k: "supplier", l: "Supplier", t: "b" },
      { k: "pending", l: "Pending return", t: "n" },
      { k: "oldest", l: "Oldest pending", t: "d" },
      { k: "age", l: "Days waiting", t: "n" },
      { k: "ageing", l: "Ageing", t: "s" },
      { k: "returned", l: "Returned so far", t: "n" },
      { k: "lots", l: "Lots pending", t: "t", w: 200 },
      { k: "mobile", l: "Phone", t: "ph" },
    ];
    return {
      spec: {
        screen: "returnableDrums",
        cols,
        hidden: [],
        chips: "ageing",
        agg: { k: "pending", l: "drums" },
        download: true,
        sortDefault: ["age", -1],
        tools: [RECORD_TOOL],
        newForm:
          sells(ctx) && open.length
            ? {
                screen: "returnableDrums",
                id: "return",
                title: "Return drums to a vendor",
                sub: "Enter how many went back. The oldest of that supplier's pending drums are marked returned — nobody has to pick out each drum.",
                submit: "Record return",
                header: returnFields(open.map((r) => r.supplier)),
              }
            : undefined,
        newLabel: "Return drums",
        noDataLine: "No vendor-returnable drum is waiting. A drum whose lot is vendor-owned lands here the moment it is weighed empty.",
      },
      rows: rows
        .filter((r) => r.pending > 0)
        .map((r): ListRow => {
          const since = r.oldest ? calendarDate(new Date(r.oldest)) : null;
          const age = since ? daysBetween(since, now) : 0;
          return {
            id: r.supplierId,
            v: { supplier: r.supplier, pending: r.pending, oldest: since, age, ageing: ageingBucket(age) === "Current" ? "Today" : `${ageingBucket(age)} days`, returned: r.returned, lots: r.lots, mobile: r.mobile },
            flags: age > 30 ? ["returnOverdue"] : [],
            title: r.supplier,
            header: `${plural(r.pending, "drum")} waiting to go back · oldest since ${since}`,
            fields: [
              { l: "Lots pending", v: r.lots ?? "—" },
              { l: "Returned so far", v: plural(r.returned, "drum") },
            ],
            contacts: r.mobile ? [{ l: "Call", href: `tel:${r.mobile}` }] : [],
            actions: [
              {
                id: "return",
                l: "Return drums",
                primary: true,
                why: sells(ctx) ? "" : powerRefusal("scrapSell"),
                prompt: { title: `Return drums to ${r.supplier}`, sub: `${plural(r.pending, "drum")} pending. The oldest are marked returned first.`, submit: "Record return", fields: returnFields([], r.supplier), init: { quantity: String(r.pending) } },
              },
              { id: "drums", l: "See the drums", href: erpLink("emptyDrums") },
            ],
          };
        }),
    };
  },
  actions: {
    return: (ctx, id, values) => recordReturn(ctx, id, values),
  },
  forms: {
    async return(ctx, header) {
      const [s] = (await db.execute(sql`select id from erp_suppliers where name = ${header.supplier ?? ""}`)) as unknown as { id: string }[];
      if (!s) return fieldErr("supplier", "Choose the supplier.");
      return recordReturn(ctx, s.id, header);
    },
  },
};

async function recordReturn(ctx: ErpContext, supplierId: string, values: Record<string, string>): Promise<Result<unknown>> {
  if (!sells(ctx)) return err(powerRefusal("scrapSell"), "not_permitted");
  const qty = int(values.quantity);
  const date = text(values.date) ?? today();
  if (qty == null || qty <= 0 || String(qty) !== String(num(values.quantity))) return fieldErr("quantity", "Enter a whole number of drums.");
  if (date > today()) return fieldErr("date", "A return cannot be dated in the future.");
  let no = 0;
  let supplier = "";
  const res = await inTx(async (tx) => {
    const pending = (await tx.execute(sql`
      select d.id, d.drum_no as "drumNo", d.emptied_at as "emptiedAt", s.name as supplier
        from erp_empty_drums d join erp_suppliers s on s.id = d.supplier_id
       where d.supplier_id = ${supplierId} and d.status = 'returnable'
       for update of d
    `)) as unknown as { id: string; drumNo: number; emptiedAt: Date; supplier: string }[];
    supplier = pending[0]?.supplier ?? "";
    if (!pending.length) return refuse(err("This supplier has no drums waiting to be returned.", "rule_violation"));
    const pick = fifoPick(
      pending.map((p) => ({ ...p, drumNo: Number(p.drumNo) })),
      qty,
    );
    if ("refusal" in pick) return refuse(fieldErr("quantity", `${pick.refusal.replace("available", "pending return")} for ${supplier}.`));
    no = await nextNumber(tx, "drumReturn");
    const id = erpId("erpdrt");
    await tx.insert(erpDrumReturns).values({ id, returnNo: no, returnDate: date, supplierId, quantity: qty, challan: text(values.challan), remark: text(values.remark), createdById: ctx.user.id });
    const ids = pick.picked.map((p) => p.id);
    await tx.execute(sql`update erp_empty_drums set status = 'returned', return_id = ${id}, updated_at = now(), updated_by_id = ${ctx.user.id} where id in ${ids} and status = 'returnable'`);
    return okVoid("");
  });
  if (!res.ok) return res;
  await erpAudit(ctx, "erp.drumReturn.create", "erp_drum_return", returnNoLabel(no), null, { supplier, quantity: qty, date, challan: text(values.challan) });
  return okVoid(`${returnNoLabel(no)}: ${plural(qty, "drum")} returned to ${supplier}`);
}

const drumReturns: ScreenModule = {
  key: "drumReturns",
  async load() {
    const rows = (await db.execute(sql`
      select r.id, r.return_no as no, r.return_date::text as date, s.name as supplier, r.quantity, r.challan, r.remark, r.created_at as "createdAt", u.name as by,
             (select string_agg(x.lot_no || ' (' || x.n || ')', ', ' order by x.lot_no) from (select lot_no, count(*) as n from erp_empty_drums where return_id = r.id group by lot_no) x) as lots,
             (select string_agg('ED-' || drum_no, ', ' order by drum_no) from erp_empty_drums where return_id = r.id) as drums
        from erp_drum_returns r join erp_suppliers s on s.id = r.supplier_id left join users u on u.id = r.created_by_id
       order by r.return_date desc, r.return_no desc
    `)) as unknown as { id: string; no: number; date: string; supplier: string; quantity: number; challan: string | null; remark: string | null; createdAt: Date; by: string | null; lots: string | null; drums: string | null }[];
    const cols: ColSpec[] = [
      { k: "no", l: "Return", t: "mono", w: 96 },
      { k: "date", l: "Date", t: "d" },
      { k: "supplier", l: "Supplier", t: "b" },
      { k: "qty", l: "Drums", t: "n" },
      { k: "challan", l: "Challan / reference", t: "mono" },
      { k: "lots", l: "From lots", t: "t", w: 200 },
      { k: "by", l: "Recorded by", t: "t" },
    ];
    return {
      spec: { screen: "drumReturns", cols, hidden: [], readOnly: true, download: true, groups: ["supplier"], agg: { k: "qty", l: "drums" }, sortDefault: ["date", -1], noDataLine: "No drums have been returned to a vendor yet." },
      rows: rows.map((r) => ({
        id: `ret:${r.no}`,
        v: { no: returnNoLabel(Number(r.no)), date: r.date, supplier: r.supplier, qty: Number(r.quantity), challan: r.challan, lots: r.lots, by: r.by },
        flags: [],
        title: `${returnNoLabel(Number(r.no))} · ${r.supplier}`,
        header: `${plural(Number(r.quantity), "drum")} returned on ${r.date}`,
        fields: [
          { l: "Drums (allocated oldest first)", v: r.drums ?? "—" },
          { l: "From lots", v: r.lots ?? "—" },
          ...(r.remark ? [{ l: "Remark", v: r.remark }] : []),
        ],
        by: stampLine(r.by, r.createdAt),
      })),
    };
  },
};

/* ============================================================ scrap sales */

type SaleRow = {
  id: string;
  no: number;
  date: string;
  buyerId: string;
  buyer: string;
  category: ScrapCategory;
  categoryNote: string | null;
  quantity: number;
  unit: string;
  rate: number;
  amount: number;
  invoiceKind: "invoice" | "none";
  ref: string | null;
  due: string | null;
  remark: string | null;
  status: "active" | "cancelled";
  cancelReason: string | null;
  received: number;
  createdAt: Date;
  by: string | null;
};

async function saleRows(where = sql`true`): Promise<SaleRow[]> {
  const rows = (await db.execute(sql`
    select s.id, s.sale_no as no, s.sale_date::text as date, s.buyer_id as "buyerId", b.name as buyer, s.category, s.category_note as "categoryNote",
           s.quantity::float8 as quantity, s.unit, s.rate_paise::float8 as rate, s.amount_paise::float8 as amount, s.invoice_kind as "invoiceKind",
           s.external_ref as ref, s.due_date::text as due, s.remark, s.status, s.cancel_reason as "cancelReason",
           coalesce((select sum(a.amount_paise) from erp_scrap_allocations a where a.sale_id = s.id and a.voided_at is null), 0)::float8 as received,
           s.created_at as "createdAt", u.name as by
      from erp_scrap_sales s join erp_scrap_buyers b on b.id = s.buyer_id left join users u on u.id = s.created_by_id
     where ${where}
     order by s.sale_date desc, s.sale_no desc
  `)) as unknown as SaleRow[];
  return rows.map((r) => ({ ...r, no: Number(r.no), quantity: Number(r.quantity), rate: Number(r.rate), amount: Number(r.amount), received: Number(r.received) }));
}

const categoryText = (c: ScrapCategory, note: string | null) => (c === "other" && note ? `Other: ${note}` : CATEGORY_LABEL[c]);
const INVOICE_YES = "External invoice issued";
const INVOICE_NO = "No external invoice";

async function buyerNames(): Promise<string[]> {
  const rows = (await db.execute(sql`select name from erp_scrap_buyers where active order by name`)) as unknown as { name: string }[];
  return rows.map((r) => r.name);
}

async function saleForm(ctx: ErpContext): Promise<FormSpec> {
  const [buyers, avail, other] = await Promise.all([
    buyerNames(),
    db.execute(sql`select count(*)::int as n from erp_empty_drums where status = 'available'`) as unknown as Promise<{ n: number }[]>,
    otherBalances(),
  ]);
  const drums = Number(avail[0]?.n ?? 0);
  const otherLine = [...other.entries()]
    .filter(([, q]) => q > 0)
    .map(([k, q]) => {
      const [c, u] = k.split("|");
      return `${CATEGORY_LABEL[c as ScrapCategory]} ${nf(q)} ${u}`;
    })
    .join(" · ");
  const unitMap: Record<string, string[]> = Object.fromEntries((Object.keys(CATEGORY_UNITS) as ScrapCategory[]).map((c) => [CATEGORY_LABEL[c], CATEGORY_UNITS[c]]));
  return {
    screen: "scrapSales",
    id: "new",
    title: "New scrap sale",
    sub: `Mahek-owned empty drums available: ${nf(drums)}. ${otherLine ? `Other scrap in hand: ${otherLine}.` : "No other scrap recorded as collected."} Drums are allocated oldest first; vendor-returnable drums are never offered.`,
    submit: "Save sale",
    header: [
      { k: "date", l: "Sale date", t: "date", req: true, def: today() },
      { k: "buyer", l: "Scrap buyer", t: "pick", req: true, opts: buyers, hint: "Pick one, or type a new buyer's name to add them." },
      { k: "category", l: "Scrap category", t: "select", req: true, opts: Object.values(CATEGORY_LABEL), def: CATEGORY_LABEL.drum },
      { k: "categoryNote", l: "What is it", t: "text", when: { k: "category", eq: CATEGORY_LABEL.other }, reqWhen: { k: "category", eq: CATEGORY_LABEL.other } },
      { k: "quantity", l: "Quantity", t: "num", req: true, min: 0.001 },
      { k: "unit", l: "Unit", t: "select", req: true, optsBy: { by: "category", map: unitMap } },
      { k: "rate", l: "Rate (₹ per unit)", t: "num", req: true, min: 0 },
      { k: "invoice", l: "Invoice", t: "select", req: true, opts: [INVOICE_YES, INVOICE_NO], def: INVOICE_NO, sec: "Invoice and payment" },
      {
        k: "ref",
        l: "Invoice / External Reference No.",
        t: "text",
        reqWhen: { k: "invoice", eq: INVOICE_YES },
        hint: "The external invoice number, or a genuine challan or reference if no invoice was issued. Leave it empty rather than make one up — the SS number identifies the sale.",
      },
      { k: "due", l: "Payment due", t: "date", hint: "Leave empty where it is due on the day." },
      { k: "remark", l: "Remark", t: "area" },
    ],
    init: { category: CATEGORY_LABEL.drum, unit: "Drums" },
    confirm: "Save a sale of {quantity} {unit} of {category} to {buyer} at ₹{rate} each?",
    data: { by: ctx.user.id },
  };
}

async function otherBalances(tx?: Tx): Promise<Map<string, number>> {
  const ex = tx ?? db;
  const [collected, sold] = await Promise.all([
    ex.execute(sql`select category, unit, quantity::float8 as quantity from erp_scrap_collections`) as unknown as Promise<{ category: string; unit: string; quantity: number }[]>,
    ex.execute(sql`select category, unit, quantity::float8 as quantity from erp_scrap_sales where status = 'active' and category <> 'drum'`) as unknown as Promise<{ category: string; unit: string; quantity: number }[]>,
  ]);
  return otherScrapBalance(
    collected.map((r) => ({ ...r, quantity: Number(r.quantity) })),
    sold.map((r) => ({ ...r, quantity: Number(r.quantity) })),
  );
}

/** A buyer by name, made on the spot when somebody types a new one. */
async function buyerFor(tx: Tx, name: string, ctx: ErpContext): Promise<{ id: string; name: string; created: boolean }> {
  const [b] = (await tx.execute(sql`select id, name from erp_scrap_buyers where lower(name) = lower(${name})`)) as unknown as { id: string; name: string }[];
  if (b) return { ...b, created: false };
  const id = erpId("erpsbu");
  await tx.insert(erpScrapBuyers).values({ id, name, createdById: ctx.user.id });
  return { id, name, created: true };
}

async function createSale(ctx: ErpContext, h: Record<string, string>): Promise<Result<unknown>> {
  if (!sells(ctx)) return err(powerRefusal("scrapSell"), "not_permitted");
  const category = categoryByLabel(h.category ?? "");
  if (!category) return fieldErr("category", "Choose the scrap category.");
  const buyerName = text(h.buyer);
  if (!buyerName) return fieldErr("buyer", "Name the scrap buyer.");
  const date = text(h.date) ?? today();
  if (date > today()) return fieldErr("date", "A sale cannot be dated in the future.");
  const unit = text(h.unit) ?? "";
  if (!(CATEGORY_UNITS[category] as string[]).includes(unit)) return fieldErr("unit", `${CATEGORY_LABEL[category]} is sold in ${CATEGORY_UNITS[category].join(", ")}.`);
  const quantity = num(h.quantity);
  if (quantity == null || quantity <= 0) return fieldErr("quantity", "Enter the quantity sold.");
  if (category === "drum" && !Number.isInteger(quantity)) return fieldErr("quantity", "Drums are sold in whole numbers.");
  const rate = paise(h.rate);
  if (rate == null || rate < 0) return fieldErr("rate", "Enter the rate per unit.");
  const note = category === "other" ? text(h.categoryNote) : null;
  if (category === "other" && !note) return fieldErr("categoryNote", "Say what the scrap is.");
  const invoiceKind = h.invoice === INVOICE_YES ? "invoice" : "none";
  const ref = text(h.ref);
  const invoiceWhy = invoiceRefusal(invoiceKind, ref);
  if (invoiceWhy) return fieldErr("ref", invoiceWhy);
  const due = text(h.due);
  if (due && due < date) return fieldErr("due", "Payment cannot be due before the sale.");
  const amount = saleAmount(quantity, rate);
  let no = 0;
  let buyer = "";
  let drums: string[] = [];
  const res = await inTx(async (tx) => {
    const b = await buyerFor(tx, buyerName, ctx);
    buyer = b.name;
    no = await nextNumber(tx, "scrapSale");
    const id = erpId("erpssl");
    if (category === "drum") {
      const avail = (await tx.execute(sql`
        select id, drum_no as "drumNo", emptied_at as "emptiedAt" from erp_empty_drums where status = 'available' and ownership = 'mahek' for update
      `)) as unknown as { id: string; drumNo: number; emptiedAt: Date }[];
      const pick = fifoPick(
        avail.map((a) => ({ ...a, drumNo: Number(a.drumNo) })),
        quantity,
      );
      if ("refusal" in pick) {
        const returnable = (await tx.execute(sql`select count(*)::int as n from erp_empty_drums where status = 'returnable'`)) as unknown as { n: number }[];
        const more = Number(returnable[0]?.n ?? 0) > 0 && quantity <= avail.length + Number(returnable[0]?.n ?? 0) ? ` ${VENDOR_DRUM_REFUSAL}` : "";
        return refuse(fieldErr("quantity", `${pick.refusal.replace("available", "Mahek-owned and available")}${more}`));
      }
      await tx.insert(erpScrapSales).values({ id, saleNo: no, saleDate: date, buyerId: b.id, category, categoryNote: note, quantity, unit, ratePaise: rate, amountPaise: amount, invoiceKind, externalRef: ref, dueDate: due, remark: text(h.remark), createdById: ctx.user.id });
      drums = pick.picked.map((p) => p.id);
      const done = (await tx.execute(sql`update erp_empty_drums set status = 'sold', sale_id = ${id}, updated_at = now(), updated_by_id = ${ctx.user.id} where id in ${drums} and status = 'available' returning id`)) as unknown as { id: string }[];
      if (done.length !== drums.length) return refuse(err("Some of those drums were taken by another sale a moment ago. Try again.", "conflict"));
    } else {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`scrap:${category}:${unit}`}))`);
      const have = (await otherBalances(tx)).get(`${category}|${unit}`) ?? 0;
      if (quantity > have + 1e-9)
        return refuse(fieldErr("quantity", have > 0 ? `Only ${nf(have)} ${unit} of ${CATEGORY_LABEL[category].toLowerCase()} is recorded as collected.` : `No ${CATEGORY_LABEL[category].toLowerCase()} is recorded as collected in ${unit}. Record it on Other scrap first.`));
      await tx.insert(erpScrapSales).values({ id, saleNo: no, saleDate: date, buyerId: b.id, category, categoryNote: note, quantity, unit, ratePaise: rate, amountPaise: amount, invoiceKind, externalRef: ref, dueDate: due, remark: text(h.remark), createdById: ctx.user.id });
    }
    return okVoid("");
  });
  if (!res.ok) return res;
  await erpAudit(ctx, "erp.scrapSale.create", "erp_scrap_sale", saleNoLabel(no), null, { buyer, category, quantity, unit, ratePaise: rate, amountPaise: amount, invoiceKind, ref, drums: drums.length });
  return okVoid(`${saleNoLabel(no)} saved · ${nf(quantity)} ${unit} to ${buyer} · ${inr(amount)}${category === "drum" ? " · oldest drums allocated" : ""}`);
}

const scrapSales: ScreenModule = {
  key: "scrapSales",
  async load(ctx) {
    const now = today();
    const [rows, form, drumsBySale, allocs] = await Promise.all([
      saleRows(),
      sells(ctx) ? saleForm(ctx) : Promise.resolve(undefined),
      db.execute(sql`
        select sale_id as "saleId", count(*)::int as n,
               string_agg(distinct lot_no, ', ') as lots,
               string_agg(distinct s.name, ', ') as suppliers
          from erp_empty_drums d join erp_suppliers s on s.id = d.supplier_id
         where sale_id is not null group by sale_id
      `) as unknown as Promise<{ saleId: string; n: number; lots: string; suppliers: string }[]>,
      db.execute(sql`
        select a.sale_id as "saleId", a.amount_paise::float8 as amount, r.receipt_no as no, r.receipt_date::text as date, r.mode
          from erp_scrap_allocations a join erp_scrap_receipts r on r.id = a.receipt_id
         where a.voided_at is null order by r.receipt_date
      `) as unknown as Promise<{ saleId: string; amount: number; no: number; date: string; mode: string }[]>,
    ]);
    const drumMap = new Map(drumsBySale.map((d) => [d.saleId, d]));
    const cols: ColSpec[] = [
      { k: "no", l: "Sale", t: "mono", w: 90 },
      { k: "date", l: "Date", t: "d" },
      { k: "buyer", l: "Scrap buyer", t: "b" },
      { k: "status", l: "Payment", t: "s" },
      { k: "amount", l: "Sale amount", t: "m" },
      { k: "owed", l: "Outstanding", t: "m" },
      { k: "category", l: "Category", t: "t" },
      { k: "qty", l: "Quantity", t: "n" },
      { k: "unit", l: "Unit", t: "t" },
      { k: "received", l: "Received", t: "m" },
      { k: "rate", l: "Rate", t: "m" },
      { k: "ref", l: "Invoice / reference", t: "mono" },
      { k: "due", l: "Due", t: "d" },
      { k: "f", l: "Flags", t: "f" },
    ];
    return {
      spec: {
        screen: "scrapSales",
        cols,
        hidden: [],
        chips: "status",
        groups: ["buyer"],
        agg: { k: "owed", l: "outstanding" },
        download: true,
        sortDefault: ["no", -1],
        newForm: form,
        newLabel: "New scrap sale",
        noDataLine: sells(ctx) ? "No scrap sold yet. New scrap sale, above." : "No scrap sold yet.",
      },
      rows: rows.map((r): ListRow => {
        const cancelled = r.status === "cancelled";
        const owed = cancelled ? 0 : outstanding(r.amount, r.received);
        const state = salePayState(r.amount, r.received, cancelled);
        const dueOn = r.due ?? r.date;
        const late = !cancelled && owed > 0 && dueOn < now;
        const d = drumMap.get(r.id);
        const mine = allocs.filter((a) => a.saleId === r.id);
        const actions: ActionSpec[] = [];
        if (!cancelled && owed > 0) actions.push({ id: "pay", l: "Match a receipt", primary: matches(ctx), href: erpLink("scrapReceipts") });
        actions.push({
          id: "cancel",
          l: "Cancel this sale",
          why: cancelled ? "This sale is already cancelled." : r.received > 0 ? "Money has been matched to this sale. Unmatch it on Receipts first." : controls(ctx) ? "" : powerRefusal("scrapControl"),
          prompt: { title: `Cancel ${saleNoLabel(r.no)}`, sub: r.category === "drum" ? "Its drums go back into Mahek stock as available. The sale stays, marked cancelled, with your reason." : "The scrap goes back into the balance in hand. The sale stays, marked cancelled, with your reason.", submit: "Cancel sale", fields: [{ k: "reason", l: "Why", t: "area", req: true }] },
        });
        return {
          id: `sale:${r.no}`,
          v: {
            no: saleNoLabel(r.no),
            date: r.date,
            buyer: r.buyer,
            status: state,
            category: categoryText(r.category, r.categoryNote),
            qty: r.quantity,
            unit: r.unit,
            amount: r.amount,
            received: r.received,
            owed,
            rate: r.rate,
            ref: r.invoiceKind === "invoice" ? r.ref : r.ref ? `No invoice · ${r.ref}` : "No invoice",
            due: r.due,
          },
          flags: late ? ["overdueSale"] : [],
          title: `${saleNoLabel(r.no)} · ${r.buyer}`,
          header: `${nf(r.quantity)} ${r.unit} of ${categoryText(r.category, r.categoryNote).toLowerCase()} at ${inr(r.rate)} on ${r.date} · ${state}`,
          fields: [
            { l: "Sale amount", v: `${inr(r.amount)} (${nf(r.quantity)} × ${inr(r.rate)})`, der: true },
            { l: "Received (matched receipts)", v: inr(r.received), der: true },
            { l: "Outstanding", v: inr(owed), der: true },
            { l: "Invoice", v: r.invoiceKind === "invoice" ? `External invoice ${r.ref}` : `No external invoice — identified by ${saleNoLabel(r.no)}${r.ref ? ` · reference ${r.ref}` : ""}` },
            ...(r.due ? [{ l: "Payment due", v: r.due }] : []),
            ...(d ? [{ l: "Drums allocated (oldest first)", v: `${plural(Number(d.n), "drum")} · lots ${d.lots} · from ${d.suppliers}` }] : []),
            ...mine.map((a) => ({ l: `${receiptNoLabel(Number(a.no))} · ${a.date}`, v: `${inr(a.amount)} by ${a.mode.toLowerCase()}` })),
            ...(r.remark ? [{ l: "Remark", v: r.remark }] : []),
            ...(cancelled && r.cancelReason ? [{ l: "Cancelled because", v: r.cancelReason }] : []),
          ],
          actions,
          by: stampLine(r.by, r.createdAt),
        };
      }),
    };
  },
  forms: {
    new: (ctx, header) => createSale(ctx, header),
  },
  actions: {
    async cancel(ctx, id, values) {
      if (!controls(ctx)) return err(powerRefusal("scrapControl"), "not_permitted");
      const reason = text(values.reason);
      if (!reason) return fieldErr("reason", "Say why the sale is being cancelled.");
      const no = Number(id.replace(/^sale:/, ""));
      let freed = 0;
      const res = await inTx(async (tx) => {
        const [s] = (await tx.execute(sql`select id, status from erp_scrap_sales where sale_no = ${no} for update`)) as unknown as { id: string; status: string }[];
        if (!s) return refuse(err("No such sale.", "not_found"));
        if (s.status === "cancelled") return refuse(err("This sale is already cancelled.", "rule_violation"));
        const [paid] = (await tx.execute(sql`select count(*)::int as n from erp_scrap_allocations where sale_id = ${s.id} and voided_at is null`)) as unknown as { n: number }[];
        if (Number(paid?.n ?? 0) > 0) return refuse(err("Money has been matched to this sale. Unmatch it on Receipts first.", "rule_violation"));
        const back = (await tx.execute(sql`update erp_empty_drums set status = 'available', sale_id = null, updated_at = now(), updated_by_id = ${ctx.user.id} where sale_id = ${s.id} returning id`)) as unknown as { id: string }[];
        freed = back.length;
        await tx.execute(sql`update erp_scrap_sales set status = 'cancelled', cancel_reason = ${reason}, cancelled_at = now(), cancelled_by_id = ${ctx.user.id} where id = ${s.id}`);
        return okVoid("");
      });
      if (!res.ok) return res;
      await erpAudit(ctx, "erp.scrapSale.cancel", "erp_scrap_sale", saleNoLabel(no), { status: "active" }, { status: "cancelled", reason, drumsFreed: freed });
      return okVoid(`${saleNoLabel(no)} cancelled${freed ? ` · ${plural(freed, "drum")} back in Mahek stock` : ""}`);
    },
  },
};

/* ============================================================ other scrap */

const otherScrap: ScreenModule = {
  key: "otherScrap",
  async load(ctx) {
    const [collected, sold, godowns] = await Promise.all([
      db.execute(sql`
        select c.id, c.collected_date::text as date, c.category, c.category_note as note2, c.quantity::float8 as qty, c.unit, g.name as godown, c.note, c.created_at as "createdAt", u.name as by
          from erp_scrap_collections c left join erp_godowns g on g.id = c.godown_id left join users u on u.id = c.created_by_id
      `) as unknown as Promise<{ id: string; date: string; category: ScrapCategory; note2: string | null; qty: number; unit: string; godown: string | null; note: string | null; createdAt: Date; by: string | null }[]>,
      saleRows(sql`s.status = 'active' and s.category <> 'drum'`),
      godownOptions(ctx, { lost: false }),
    ]);
    const balance = otherScrapBalance(
      collected.map((c) => ({ category: c.category, unit: c.unit, quantity: Number(c.qty) })),
      sold.map((s) => ({ category: s.category, unit: s.unit, quantity: s.quantity })),
    );
    const inHand = [...balance.entries()].filter(([, q]) => q !== 0).map(([k, q]) => {
      const [c, u] = k.split("|");
      return `${CATEGORY_LABEL[c as ScrapCategory]}: ${nf(q)} ${u}`;
    });
    const cols: ColSpec[] = [
      { k: "date", l: "Date", t: "d" },
      { k: "type", l: "Transaction", t: "s" },
      { k: "category", l: "Category", t: "b" },
      { k: "qty", l: "Quantity", t: "n" },
      { k: "unit", l: "Unit", t: "t" },
      { k: "group", l: "Stock", t: "t" },
      { k: "ref", l: "Reference", t: "mono" },
      { k: "godown", l: "Godown", t: "t" },
      { k: "note", l: "Note", t: "t" },
    ];
    const rows: ListRow[] = [
      ...collected.map((c) => ({
        id: c.id,
        v: { date: c.date, type: "Collected", category: categoryText(c.category, c.note2), qty: Number(c.qty), unit: c.unit, group: `${CATEGORY_LABEL[c.category]} · ${c.unit}`, ref: null, godown: c.godown, note: c.note },
        flags: [],
        title: `${categoryText(c.category, c.note2)} collected · ${c.date}`,
        by: stampLine(c.by, c.createdAt),
      })),
      ...sold.map((s) => ({
        id: `sale:${s.no}`,
        v: { date: s.date, type: "Sold", category: categoryText(s.category, s.categoryNote), qty: -s.quantity, unit: s.unit, group: `${CATEGORY_LABEL[s.category]} · ${s.unit}`, ref: saleNoLabel(s.no), godown: null, note: s.buyer },
        flags: [],
        title: `${saleNoLabel(s.no)} · ${s.buyer}`,
        actions: [{ id: "open", l: `Open ${saleNoLabel(s.no)}`, primary: true, href: erpLink("scrapSales", { open: `sale:${s.no}` }) }],
      })),
    ];
    return {
      spec: {
        screen: "otherScrap",
        cols,
        hidden: [],
        chips: "type",
        groups: ["group"],
        agg: { k: "qty", l: "in hand" },
        download: true,
        sortDefault: ["date", -1],
        scopedLine: inHand.length ? `In hand: ${inHand.join(" · ")}` : "Nothing in hand. Plastic, cardboard and other scrap is recorded here in batches as it is collected — no bag or box needs a record of its own.",
        newForm: {
          screen: "otherScrap",
          id: "collect",
          title: "Record scrap collected",
          sub: "A batch of plastic, cardboard or other scrap set aside for sale. Drums are not recorded here — they are weighed one by one against their GRN.",
          submit: "Save",
          header: [
            { k: "date", l: "Date", t: "date", req: true, def: today() },
            { k: "category", l: "Category", t: "select", req: true, opts: [CATEGORY_LABEL.plastic, CATEGORY_LABEL.cardboard, CATEGORY_LABEL.other] },
            { k: "categoryNote", l: "What is it", t: "text", when: { k: "category", eq: CATEGORY_LABEL.other }, reqWhen: { k: "category", eq: CATEGORY_LABEL.other } },
            { k: "quantity", l: "Quantity", t: "num", req: true, min: 0.001 },
            { k: "unit", l: "Unit", t: "select", req: true, opts: ["Kg", "Bags", "Pcs"], def: "Kg" },
            { k: "godown", l: "Godown", t: "select", opts: godowns.map((g) => g.name), def: ctx.workingGodown?.name ?? "" },
            { k: "note", l: "Note", t: "area" },
          ],
        },
        newLabel: "Record scrap collected",
        noDataLine: "No plastic, cardboard or other scrap recorded yet.",
      },
      rows,
    };
  },
  forms: {
    async collect(ctx, h) {
      const category = categoryByLabel(h.category ?? "");
      if (!category || category === "drum") return fieldErr("category", "Choose plastic, cardboard or other scrap.");
      const quantity = num(h.quantity);
      if (quantity == null || quantity <= 0) return fieldErr("quantity", "Enter the quantity.");
      const unit = text(h.unit) ?? "";
      if (!["Kg", "Bags", "Pcs"].includes(unit)) return fieldErr("unit", "Choose Kg, Bags or Pcs.");
      const note = category === "other" ? text(h.categoryNote) : null;
      if (category === "other" && !note) return fieldErr("categoryNote", "Say what the scrap is.");
      const date = text(h.date) ?? today();
      if (date > today()) return fieldErr("date", "Cannot be dated in the future.");
      const id = erpId("erpscl");
      await db.insert(erpScrapCollections).values({ id, collectedDate: date, category, categoryNote: note, quantity, unit, godownId: await godownIdByName(text(h.godown)), note: text(h.note), createdById: ctx.user.id });
      await erpAudit(ctx, "erp.scrapStock.create", "erp_scrap_collection", id, null, { category, quantity, unit, date });
      return okVoid(`${nf(quantity)} ${unit} of ${CATEGORY_LABEL[category].toLowerCase()} recorded`);
    },
  },
};

/* ======================================================== buyer ledger */

const scrapBuyers: ScreenModule = {
  key: "scrapBuyers",
  async load(ctx) {
    const now = today();
    const [buyers, sales, receipts] = await Promise.all([
      db.execute(sql`select id, name, mobile, gstin, address, created_at as "createdAt" from erp_scrap_buyers order by name`) as unknown as Promise<{ id: string; name: string; mobile: string | null; gstin: string | null; address: string | null; createdAt: Date }[]>,
      saleRows(sql`s.status = 'active'`),
      db.execute(sql`
        select r.buyer_id as "buyerId", r.receipt_no as no, r.receipt_date::text as date, r.amount_paise::float8 as amount, r.mode,
               coalesce((select sum(a.amount_paise) from erp_scrap_allocations a where a.receipt_id = r.id and a.voided_at is null), 0)::float8 as allocated,
               (select string_agg('SS-' || s.sale_no, ', ') from erp_scrap_allocations a join erp_scrap_sales s on s.id = a.sale_id where a.receipt_id = r.id and a.voided_at is null) as sales
          from erp_scrap_receipts r where r.status = 'active'
      `) as unknown as Promise<{ buyerId: string; no: number; date: string; amount: number; mode: string; allocated: number; sales: string | null }[]>,
    ]);
    const bucketKey: Record<AgeingBucket, string> = { Current: "b0", "1–7": "b1", "8–15": "b2", "16–30": "b3", "31–60": "b4", "60+": "b5" };
    const cols: ColSpec[] = [
      { k: "buyer", l: "Scrap buyer", t: "b" },
      { k: "owed", l: "Outstanding", t: "m" },
      { k: "sold", l: "Sold", t: "m" },
      { k: "received", l: "Received", t: "m" },
      ...AGEING_BUCKETS.map((b): ColSpec => ({ k: bucketKey[b], l: b === "Current" ? "Current" : `${b} days`, t: "m" })),
      { k: "unallocated", l: "Received, not matched", t: "m" },
      { k: "oldest", l: "Oldest due", t: "d" },
      { k: "sales", l: "Sales", t: "n" },
      { k: "mobile", l: "Phone", t: "ph" },
    ];
    return {
      spec: {
        screen: "scrapBuyers",
        cols,
        hidden: [],
        download: true,
        agg: { k: "owed", l: "outstanding" },
        sortDefault: ["owed", -1],
        newForm: sells(ctx) || matches(ctx)
          ? {
              screen: "scrapBuyers",
              id: "new",
              title: "Add a scrap buyer",
              submit: "Add buyer",
              header: [
                { k: "name", l: "Name", t: "text", req: true },
                { k: "mobile", l: "Mobile", t: "text" },
                { k: "gstin", l: "GSTIN", t: "text" },
                { k: "address", l: "Address", t: "area" },
              ],
            }
          : undefined,
        newLabel: "Add buyer",
        noDataLine: "No scrap buyers yet. A buyer is added the first time a sale names them.",
      },
      rows: buyers.map((b): ListRow => {
        const mine = sales.filter((s) => s.buyerId === b.id);
        const mineR = receipts.filter((r) => r.buyerId === b.id);
        const buckets: Record<string, number> = { b0: 0, b1: 0, b2: 0, b3: 0, b4: 0, b5: 0 };
        let owed = 0;
        let oldest: string | null = null;
        for (const s of mine) {
          const o = outstanding(s.amount, s.received);
          if (o <= 0) continue;
          owed += o;
          const due = s.due ?? s.date;
          buckets[bucketKey[ageingBucket(daysBetween(due, now))]] += o;
          if (!oldest || due < oldest) oldest = due;
        }
        const unallocated = mineR.reduce((n, r) => n + Math.max(0, r.amount - r.allocated), 0);
        const ledger = [
          ...mine.map((s) => ({ date: s.date, sort: `${s.date}a${s.no}`, l: `${s.date} · ${saleNoLabel(s.no)}`, v: `Sale ${inr(s.amount)} · ${nf(s.quantity)} ${s.unit} ${categoryText(s.category, s.categoryNote).toLowerCase()}` })),
          ...mineR.map((r) => ({ date: r.date, sort: `${r.date}b${r.no}`, l: `${r.date} · ${receiptNoLabel(Number(r.no))}`, v: `Received ${inr(r.amount)} by ${r.mode.toLowerCase()}${r.sales ? ` · matched to ${r.sales}` : ""}${r.amount - r.allocated > 0 ? ` · ${inr(r.amount - r.allocated)} not matched` : ""}` })),
        ].sort((a, b) => (a.sort < b.sort ? -1 : 1));
        return {
          id: b.id,
          v: {
            buyer: b.name,
            owed,
            sold: mine.reduce((n, s) => n + s.amount, 0),
            received: mine.reduce((n, s) => n + s.received, 0),
            ...buckets,
            unallocated,
            oldest,
            sales: mine.length,
            mobile: b.mobile,
          },
          flags: buckets.b4 + buckets.b5 > 0 ? ["overdueSale"] : [],
          title: b.name,
          header: `Outstanding ${inr(owed)} on ${plural(mine.filter((s) => outstanding(s.amount, s.received) > 0).length, "sale")}`,
          fields: [
            ...(b.gstin ? [{ l: "GSTIN", v: b.gstin }] : []),
            ...(b.address ? [{ l: "Address", v: b.address }] : []),
            ...(ledger.length ? ledger.map((x) => ({ l: x.l, v: x.v })) : [{ l: "Ledger", v: "Nothing sold or received yet." }]),
          ],
          contacts: b.mobile ? [{ l: "Call", href: `tel:${b.mobile}` }] : [],
          actions: [
            { id: "sales", l: "See their sales", primary: true, href: erpLink("scrapSales") },
            { id: "receipts", l: "Record a receipt", href: erpLink("scrapReceipts", { new: matches(ctx) ? "1" : null, buyer: b.name }) },
          ],
          by: stampLine(null, b.createdAt).replace("Created", "Added"),
        };
      }),
    };
  },
  forms: {
    async new(ctx, h) {
      if (!sells(ctx) && !matches(ctx)) return err(powerRefusal("scrapSell"), "not_permitted");
      const name = text(h.name);
      if (!name) return fieldErr("name", "Name the buyer.");
      const [dup] = (await db.execute(sql`select 1 from erp_scrap_buyers where lower(name) = lower(${name})`)) as unknown as unknown[];
      if (dup) return fieldErr("name", "There is already a buyer by that name.");
      const id = erpId("erpsbu");
      await db.insert(erpScrapBuyers).values({ id, name, mobile: text(h.mobile), gstin: text(h.gstin)?.toUpperCase() ?? null, address: text(h.address), createdById: ctx.user.id });
      await erpAudit(ctx, "erp.scrapBuyer.create", "erp_scrap_buyer", id, null, { name });
      return okVoid(`${name} added`);
    },
  },
};

/* ============================================================== receipts */

type ReceiptRow = { id: string; no: number; date: string; buyerId: string; buyer: string; mode: string; amount: number; reference: string | null; note: string | null; status: "active" | "void"; voidReason: string | null; allocated: number; createdAt: Date; by: string | null };

async function receiptRows(): Promise<ReceiptRow[]> {
  const rows = (await db.execute(sql`
    select r.id, r.receipt_no as no, r.receipt_date::text as date, r.buyer_id as "buyerId", b.name as buyer, r.mode, r.amount_paise::float8 as amount,
           r.reference, r.note, r.status, r.void_reason as "voidReason",
           coalesce((select sum(a.amount_paise) from erp_scrap_allocations a where a.receipt_id = r.id and a.voided_at is null), 0)::float8 as allocated,
           r.created_at as "createdAt", u.name as by
      from erp_scrap_receipts r join erp_scrap_buyers b on b.id = r.buyer_id left join users u on u.id = r.created_by_id
     order by r.receipt_date desc, r.receipt_no desc
  `)) as unknown as ReceiptRow[];
  return rows.map((r) => ({ ...r, no: Number(r.no), amount: Number(r.amount), allocated: Number(r.allocated) }));
}

const APPLY_OLDEST = "Match to their oldest sales first";
const APPLY_LATER = "Leave unmatched for now";

const openSaleLabel = (s: SaleRow) => `${saleNoLabel(s.no)} · ${s.date} · ${inr(outstanding(s.amount, s.received))} owed`;

const scrapReceipts: ScreenModule = {
  key: "scrapReceipts",
  async load(ctx) {
    const [rows, buyers, open, allocs] = await Promise.all([
      receiptRows(),
      buyerNames(),
      saleRows(sql`s.status = 'active'`),
      db.execute(sql`
        select a.id, a.receipt_id as "receiptId", a.amount_paise::float8 as amount, s.sale_no as no, a.created_at as at, u.name as by
          from erp_scrap_allocations a join erp_scrap_sales s on s.id = a.sale_id left join users u on u.id = a.created_by_id
         where a.voided_at is null order by a.created_at
      `) as unknown as Promise<{ id: string; receiptId: string; amount: number; no: number; at: Date; by: string | null }[]>,
    ]);
    const cols: ColSpec[] = [
      { k: "no", l: "Receipt", t: "mono", w: 90 },
      { k: "date", l: "Date", t: "d" },
      { k: "buyer", l: "Scrap buyer", t: "b" },
      { k: "status", l: "Matched", t: "s" },
      { k: "amount", l: "Amount", t: "m" },
      { k: "allocated", l: "Matched to sales", t: "m" },
      { k: "left", l: "Not matched", t: "m" },
      { k: "mode", l: "Cash / bank", t: "s" },
      { k: "ref", l: "Reference", t: "mono" },
      { k: "sales", l: "Sales", t: "t" },
    ];
    const can = matches(ctx);
    return {
      spec: {
        screen: "scrapReceipts",
        cols,
        hidden: [],
        chips: "status",
        groups: ["buyer"],
        agg: { k: "left", l: "not matched" },
        download: true,
        sortDefault: ["no", -1],
        newForm: can
          ? {
              screen: "scrapReceipts",
              id: "new",
              title: "Record a scrap receipt",
              sub: "Money a scrap buyer paid, as it reached petty cash or the bank. Matching it to their sales is what reduces what they owe.",
              submit: "Save receipt",
              header: [
                { k: "date", l: "Received on", t: "date", req: true, def: today() },
                { k: "buyer", l: "Scrap buyer", t: "select", req: true, opts: buyers },
                { k: "mode", l: "Cash or bank", t: "select", req: true, opts: ["Bank", "Cash"], def: "Bank" },
                { k: "amount", l: "Amount (₹)", t: "num", req: true, min: 0.01 },
                { k: "reference", l: "UTR / cheque / voucher", t: "text" },
                { k: "apply", l: "Match it", t: "select", req: true, opts: [APPLY_OLDEST, APPLY_LATER], def: APPLY_OLDEST, hint: "Oldest first never puts more on a sale than it owes; anything left stays here to match later." },
                { k: "note", l: "Note", t: "area" },
              ],
            }
          : undefined,
        newLabel: "Record receipt",
        noDataLine: can ? "No scrap receipts yet. Record one when a buyer's money reaches petty cash or the bank." : "No scrap receipts yet. The accountant records them.",
      },
      rows: rows.map((r): ListRow => {
        const left = r.status === "void" ? 0 : r.amount - r.allocated;
        const mine = allocs.filter((a) => a.receiptId === r.id);
        const buyerOpen = open.filter((s) => s.buyerId === r.buyerId && outstanding(s.amount, s.received) > 0);
        const actions: ActionSpec[] =
          r.status === "void"
            ? []
            : [
                {
                  id: "allocate",
                  l: "Match to a sale",
                  primary: left > 0,
                  why: !can ? powerRefusal("scrapReceipts") : left <= 0 ? "Nothing on this receipt is left to match." : !buyerOpen.length ? `${r.buyer} owes nothing on any sale.` : "",
                  prompt: {
                    title: `Match ${receiptNoLabel(r.no)} to a sale`,
                    sub: `${inr(left)} of this receipt is not matched yet.`,
                    submit: "Match",
                    fields: [
                      { k: "sale", l: "Sale", t: "select", req: true, opts: buyerOpen.map(openSaleLabel) },
                      { k: "amount", l: "Amount (₹)", t: "num", req: true, min: 0.01 },
                    ],
                    init: buyerOpen[0] ? { sale: openSaleLabel(buyerOpen[0]), amount: String(Math.min(left, outstanding(buyerOpen[0].amount, buyerOpen[0].received)) / 100) } : {},
                  },
                },
                {
                  id: "unmatch",
                  l: "Unmatch from a sale",
                  why: !can ? powerRefusal("scrapReceipts") : !mine.length ? "Nothing is matched yet." : "",
                  prompt: {
                    title: `Unmatch part of ${receiptNoLabel(r.no)}`,
                    sub: "The match is kept, marked undone, with your reason.",
                    submit: "Unmatch",
                    fields: [
                      { k: "allocation", l: "Match", t: "select", req: true, opts: mine.map((a) => `${saleNoLabel(Number(a.no))} · ${inr(a.amount)}`) },
                      { k: "reason", l: "Why", t: "area", req: true },
                    ],
                  },
                },
                {
                  id: "void",
                  l: "Void this receipt",
                  why: can ? "" : powerRefusal("scrapReceipts"),
                  prompt: { title: `Void ${receiptNoLabel(r.no)}`, sub: "Its matches are undone too, so the sales owe again. The receipt stays, marked void, with your reason.", submit: "Void receipt", fields: [{ k: "reason", l: "Why", t: "area", req: true }] },
                },
              ];
        return {
          id: r.id,
          v: {
            no: receiptNoLabel(r.no),
            date: r.date,
            buyer: r.buyer,
            status: r.status === "void" ? "Void" : left <= 0 ? "Fully matched" : r.allocated > 0 ? "Partly matched" : "Not matched",
            amount: r.amount,
            allocated: r.allocated,
            left,
            mode: r.mode,
            ref: r.reference,
            sales: mine.map((a) => saleNoLabel(Number(a.no))).join(", ") || null,
          },
          flags: r.status === "active" && left > 0 ? ["unallocated"] : [],
          title: `${receiptNoLabel(r.no)} · ${r.buyer}`,
          header: `${inr(r.amount)} by ${r.mode.toLowerCase()} on ${r.date}${r.status === "void" ? " · void" : ""}`,
          fields: [
            ...mine.map((a) => ({ l: `Matched to ${saleNoLabel(Number(a.no))}`, v: `${inr(a.amount)} · ${stampLine(a.by, a.at).replace(/^Created /, "")}` })),
            ...(r.reference ? [{ l: "Reference", v: r.reference }] : []),
            ...(r.note ? [{ l: "Note", v: r.note }] : []),
            ...(r.voidReason ? [{ l: "Voided because", v: r.voidReason }] : []),
          ],
          actions,
          by: stampLine(r.by, r.createdAt),
        };
      }),
    };
  },
  forms: {
    async new(ctx, h) {
      if (!matches(ctx)) return err(powerRefusal("scrapReceipts"), "not_permitted");
      const amount = paise(h.amount);
      if (amount == null || amount <= 0) return fieldErr("amount", "Enter the amount received.");
      const mode = h.mode === "Cash" ? "Cash" : h.mode === "Bank" ? "Bank" : null;
      if (!mode) return fieldErr("mode", "Choose cash or bank.");
      const date = text(h.date) ?? today();
      if (date > today()) return fieldErr("date", "A receipt cannot be dated in the future.");
      let no = 0;
      let buyer = "";
      let matched = 0;
      const res = await inTx(async (tx) => {
        const [b] = (await tx.execute(sql`select id, name from erp_scrap_buyers where name = ${h.buyer ?? ""}`)) as unknown as { id: string; name: string }[];
        if (!b) return refuse(fieldErr("buyer", "Choose the scrap buyer."));
        buyer = b.name;
        no = await nextNumber(tx, "scrapReceipt");
        const id = erpId("erpsrc");
        await tx.insert(erpScrapReceipts).values({ id, receiptNo: no, receiptDate: date, buyerId: b.id, mode, amountPaise: amount, reference: text(h.reference), note: text(h.note), createdById: ctx.user.id });
        if (h.apply !== APPLY_LATER) {
          const open = (await tx.execute(sql`
            select s.id, s.amount_paise::float8 - coalesce((select sum(a.amount_paise) from erp_scrap_allocations a where a.sale_id = s.id and a.voided_at is null), 0)::float8 as owed
              from erp_scrap_sales s where s.buyer_id = ${b.id} and s.status = 'active'
             order by coalesce(s.due_date, s.sale_date), s.sale_no
               for update of s
          `)) as unknown as { id: string; owed: number }[];
          const spread = spreadOldestFirst(
            amount,
            open.map((o) => ({ id: o.id, owedPaise: Math.max(0, Number(o.owed)) })),
          );
          for (const s of spread) {
            await tx.insert(erpScrapAllocations).values({ id: erpId("erpsal"), receiptId: id, saleId: s.saleId, amountPaise: s.amountPaise, createdById: ctx.user.id });
            matched += s.amountPaise;
          }
        }
        return okVoid("");
      });
      if (!res.ok) return res;
      await erpAudit(ctx, "erp.scrapReceipt.create", "erp_scrap_receipt", receiptNoLabel(no), null, { buyer, amountPaise: amount, mode, reference: text(h.reference), matchedPaise: matched });
      return okVoid(`${receiptNoLabel(no)}: ${inr(amount)} from ${buyer}${matched ? ` · ${inr(matched)} matched to their oldest sales` : ""}${amount - matched > 0 && h.apply !== APPLY_LATER ? ` · ${inr(amount - matched)} left to match` : ""}`);
    },
  },
  actions: {
    async allocate(ctx, id, values) {
      if (!matches(ctx)) return err(powerRefusal("scrapReceipts"), "not_permitted");
      const saleNo = Number((values.sale ?? "").match(/^SS-(\d+)/)?.[1] ?? NaN);
      if (!Number.isFinite(saleNo)) return fieldErr("sale", "Choose the sale.");
      const amount = paise(values.amount);
      if (amount == null) return fieldErr("amount", "Enter the amount to match.");
      let label = "";
      const res = await inTx(async (tx) => {
        const [r] = (await tx.execute(sql`
          select r.receipt_no as no, r.buyer_id as "buyerId", r.status, r.amount_paise::float8 - coalesce((select sum(a.amount_paise) from erp_scrap_allocations a where a.receipt_id = r.id and a.voided_at is null), 0)::float8 as left
            from erp_scrap_receipts r where r.id = ${id} for update
        `)) as unknown as { no: number; buyerId: string; status: string; left: number }[];
        if (!r) return refuse(err("No such receipt.", "not_found"));
        if (r.status === "void") return refuse(err("This receipt is void.", "rule_violation"));
        const [s] = (await tx.execute(sql`
          select s.id, s.buyer_id as "buyerId", s.status, s.amount_paise::float8 - coalesce((select sum(a.amount_paise) from erp_scrap_allocations a where a.sale_id = s.id and a.voided_at is null), 0)::float8 as owed
            from erp_scrap_sales s where s.sale_no = ${saleNo} for update
        `)) as unknown as { id: string; buyerId: string; status: string; owed: number }[];
        if (!s || s.status !== "active") return refuse(fieldErr("sale", "That sale is not open."));
        if (s.buyerId !== r.buyerId) return refuse(fieldErr("sale", "That sale is another buyer's."));
        const why = allocationRefusal(amount, Number(r.left), Math.max(0, Number(s.owed)));
        if (why) return refuse(fieldErr("amount", why));
        await tx.insert(erpScrapAllocations).values({ id: erpId("erpsal"), receiptId: id, saleId: s.id, amountPaise: amount, createdById: ctx.user.id });
        label = receiptNoLabel(Number(r.no));
        return okVoid("");
      });
      if (!res.ok) return res;
      await erpAudit(ctx, "erp.scrapReceipt.allocate", "erp_scrap_receipt", label, null, { sale: saleNoLabel(saleNo), amountPaise: amount });
      return okVoid(`${inr(amount)} of ${label} matched to ${saleNoLabel(saleNo)}`);
    },
    async unmatch(ctx, id, values) {
      if (!matches(ctx)) return err(powerRefusal("scrapReceipts"), "not_permitted");
      const reason = text(values.reason);
      if (!reason) return fieldErr("reason", "Say why.");
      const saleNo = Number((values.allocation ?? "").match(/^SS-(\d+)/)?.[1] ?? NaN);
      if (!Number.isFinite(saleNo)) return fieldErr("allocation", "Choose the match to undo.");
      let label = "";
      let amount = 0;
      const res = await inTx(async (tx) => {
        const [a] = (await tx.execute(sql`
          select a.id, a.amount_paise::float8 as amount, r.receipt_no as no
            from erp_scrap_allocations a join erp_scrap_sales s on s.id = a.sale_id join erp_scrap_receipts r on r.id = a.receipt_id
           where a.receipt_id = ${id} and s.sale_no = ${saleNo} and a.voided_at is null
           order by a.created_at desc limit 1 for update of a
        `)) as unknown as { id: string; amount: number; no: number }[];
        if (!a) return refuse(fieldErr("allocation", "That match is not there any more."));
        await tx.execute(sql`update erp_scrap_allocations set voided_at = now(), voided_by_id = ${ctx.user.id}, void_reason = ${reason} where id = ${a.id}`);
        label = receiptNoLabel(Number(a.no));
        amount = Number(a.amount);
        return okVoid("");
      });
      if (!res.ok) return res;
      await erpAudit(ctx, "erp.scrapReceipt.unmatch", "erp_scrap_receipt", label, { sale: saleNoLabel(saleNo), amountPaise: amount }, { reason });
      return okVoid(`${inr(amount)} of ${label} unmatched from ${saleNoLabel(saleNo)}`);
    },
    async void(ctx, id, values) {
      if (!matches(ctx)) return err(powerRefusal("scrapReceipts"), "not_permitted");
      const reason = text(values.reason);
      if (!reason) return fieldErr("reason", "Say why the receipt is being voided.");
      let label = "";
      const res = await inTx(async (tx) => {
        const [r] = (await tx.execute(sql`select receipt_no as no, status from erp_scrap_receipts where id = ${id} for update`)) as unknown as { no: number; status: string }[];
        if (!r) return refuse(err("No such receipt.", "not_found"));
        if (r.status === "void") return refuse(err("This receipt is already void.", "rule_violation"));
        label = receiptNoLabel(Number(r.no));
        await tx.execute(sql`update erp_scrap_allocations set voided_at = now(), voided_by_id = ${ctx.user.id}, void_reason = ${`Receipt voided: ${reason}`} where receipt_id = ${id} and voided_at is null`);
        await tx.execute(sql`update erp_scrap_receipts set status = 'void', void_reason = ${reason}, voided_at = now(), voided_by_id = ${ctx.user.id} where id = ${id}`);
        return okVoid("");
      });
      if (!res.ok) return res;
      await erpAudit(ctx, "erp.scrapReceipt.void", "erp_scrap_receipt", label, null, { reason });
      return okVoid(`${label} voided`);
    },
  },
};

/* ========================================================= tare variance */

const tareVarianceScreen: ScreenModule = {
  key: "tareVariance",
  async load() {
    const config = await getConfig();
    const alert = config["erp.scrap.varianceAlertKg"];
    const rows = await drumRows(sql`d.status <> 'cancelled'`);
    const cols: ColSpec[] = [
      { k: "drum", l: "Drum", t: "mono", w: 96 },
      { k: "supplier", l: "Supplier", t: "b" },
      { k: "item", l: "Material", t: "t" },
      { k: "variance", l: "Variance", t: "n", u: " kg" },
      { k: "pct", l: "Variance %", t: "n", u: "%" },
      { k: "declared", l: "Declared tare", t: "n", u: " kg" },
      { k: "actual", l: "Actual empty", t: "n", u: " kg" },
      { k: "lot", l: "GRN lot", t: "mono" },
      { k: "pr", l: "PR", t: "mono" },
      { k: "emptied", l: "Emptied", t: "d" },
      { k: "f", l: "Flags", t: "f" },
    ];
    return {
      spec: {
        screen: "tareVariance",
        cols,
        hidden: [],
        readOnly: true,
        download: true,
        groups: ["supplier", "item"],
        agg: { k: "variance", l: "kg average", t: "avg" },
        sortDefault: ["variance", -1],
        scopedLine: `Actual empty weight − the supplier's declared tare from the GRN. The GRN's figure is never changed. Flagged at ${nf(alert)} kg or more either way (Settings → ERP).`,
        noDataLine: "No drum with a declared tare has been weighed empty yet.",
      },
      rows: rows
        .filter((r) => r.declared != null)
        .map((r) => {
          const v = tareVariance(r.weight, r.declared)!;
          return {
            id: r.id,
            v: { drum: drumNoLabel(r.drumNo), supplier: r.supplier, item: r.item, variance: v.kg, pct: v.pct, declared: r.declared, actual: r.weight, lot: r.lot, pr: String(r.pr), emptied: calendarDate(new Date(r.emptiedAt)) },
            flags: highVariance(v, alert) ? ["tareHigh"] : [],
            title: `${drumNoLabel(r.drumNo)} · ${r.supplier}`,
            header: `${signedKg(v.kg)} against a declared ${nf(r.declared!)} kg`,
            actions: [{ id: "open", l: "Open the drum", primary: true, href: erpLink("emptyDrums", { open: r.id }) }],
          };
        }),
    };
  },
};

export const SCRAP_SCREENS: ScreenModule[] = [emptyDrums, drumStock, returnableDrums, drumReturns, scrapSales, otherScrap, scrapBuyers, scrapReceipts, tareVarianceScreen];
