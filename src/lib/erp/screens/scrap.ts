import "server-only";
import { erpLink } from "../registry";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { erpDrumAdjustments, erpGodowns, erpScrapBuyers, erpScrapEntries, erpSuppliers, users } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { APP_TIMEZONE, calendarDate } from "@/lib/business-date";
import { err, fieldErr, okVoid, type Result } from "@/lib/result";
import type { ErpContext } from "../access";
import { refValues } from "../refs";
import { erpAudit, erpId, int, num, paise, stampLine, text, type ScreenModule } from "../server";
import type { ActionSpec, ColSpec, FieldSpec, FormSpec, ListRow } from "../ui";
import { fd, inr, nf } from "../ui";
import { godownIdByName, godownOptions, today } from "./common";
import {
  AGE_BUCKETS,
  DRUM_CATEGORY,
  DRUM_STATUS_LABEL,
  OWNERSHIP_LABEL,
  RETURNABLE_NOT_FOR_SALE,
  RETURN_BUCKETS,
  drumLabel,
  drumReturnLabel,
  ownershipByLabel,
  paymentState,
  receiptLabel,
  receivableBucket,
  returnBucket,
  scrapSaleLabel,
  suggestAllocation,
  tareVariance,
  varianceIsHigh,
  type DrumOwnership,
} from "../engines/drums";
import {
  RECEIPT_MODES,
  allocateReceipt,
  allocationRows,
  availableDrums,
  cancelDrumEntry,
  cancelDrumReturn,
  cancelScrapEntry,
  cancelScrapSale,
  classifyDrum,
  correctDrumWeight,
  decideDrumAdjustment,
  drumHistories,
  drumRows,
  findDrumLot,
  lotRefusal,
  receiptRows,
  recordEmptyDrum,
  recordReceipt,
  recordScrapEntry,
  requestDrumAdjustment,
  returnDrums,
  saleRows,
  scrapStock,
  sellScrap,
  voidAllocation,
  voidReceipt,
  type Actor,
  type DrumHistoryLine,
  type DrumRow,
  type SaleRow,
} from "../drums";

/* ---------------------------------------------------------------------------
 * EMPTY DRUMS AND SCRAP — the ERP screens.
 *
 *   Empty drums            Mahek stock · Vendor returnable · Needs review ·
 *                          Tare variance · Corrections · All drums
 *   Returnable drum outward  Outwards · Pending by supplier
 *   Scrap sales            Sales · Receivables & ageing · Scrap stock ·
 *                          Scrap buyers
 *   Petty Cash/Bank        Receipts (the tab beside Expenses and Funds given)
 *
 * Who may do what is a POWER, checked in each handler: recording an empty
 * drum is the screen's (production staff); selling and returning is
 * `scrapSale` (the Production Head); matching money is `scrapAccounts` (the
 * accountant); corrections are `scrapApprove`, and never by whoever asked.
 * ------------------------------------------------------------------------- */

const actorOf = (ctx: ErpContext): Actor => ({ id: ctx.user.id, name: ctx.user.name, app: "erp", level: ctx.level });
const can = (ctx: ErpContext, p: "scrapSale" | "scrapAccounts" | "scrapApprove") => ctx.powers.has(p);
const why = (ctx: ErpContext, p: "scrapSale" | "scrapAccounts" | "scrapApprove") =>
  can(ctx, p) ? "" : p === "scrapSale" ? "The Production Head does this" : p === "scrapAccounts" ? "The accountant matches money" : "Somebody who approves drum corrections does this";
const refused = (p: "scrapSale" | "scrapAccounts" | "scrapApprove"): Result =>
  err(p === "scrapSale" ? "Only the Production Head sells scrap and returns drums." : p === "scrapAccounts" ? "Only the accountant records and matches Petty Cash/Bank receipts." : "Only somebody who approves drum corrections may do this.", "not_permitted");

const ownLabel = (o: DrumOwnership | null) => (o ? OWNERSHIP_LABEL[o] : "Not recorded");
const kgText = (n: number | null | undefined) => (n == null ? "—" : `${nf(n)} kg`);
const signedKg = (n: number | null | undefined) => (n == null ? "—" : `${n > 0 ? "+" : ""}${nf(n)} kg`);
const reasonField = (l = "Reason"): FieldSpec => ({ k: "reason", l, t: "area", req: true, mic: true, hint: "Kept in the drum's history with your name." });

/** The drawer panel every scrap record draws: figures, then lines of history. */
export type ScrapPanel = {
  figures: { l: string; v: string; tone?: "danger" | "success" | "muted" }[];
  sections: { title: string; empty?: string; lines: { text: string; sub?: string; tone?: "danger" | "success" | "muted" }[] }[];
  note?: string;
};

function drumPanel(d: DrumRow, varianceLimits: { alertKg: number; alertPercent: number }, hist: DrumHistoryLine[]): ScrapPanel {
  const v = tareVariance(d.actualKg, d.declaredTareKg);
  return {
    figures: [
      { l: "Declared tare (GRN)", v: kgText(d.declaredTareKg) },
      { l: "Actual empty", v: kgText(d.actualKg) },
      { l: "Variance", v: v ? `${signedKg(v.kg)}${v.pct != null ? ` (${v.pct > 0 ? "+" : ""}${v.pct}%)` : ""}` : "—", tone: varianceIsHigh(v, varianceLimits) ? "danger" : undefined },
    ],
    sections: [
      {
        title: "History",
        empty: "Nothing recorded yet.",
        lines: hist.map((h) => ({ text: h.text, sub: `${new Date(h.at).toLocaleString("en-IN", { timeZone: APP_TIMEZONE, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}${h.by ? " · " + h.by : ""}${h.note ? " · " + h.note : ""}` })),
      },
    ],
    note: d.source === "opening" ? "Opening stock: this drum was here before MahekOne recorded drums, so it has no GRN behind it." : undefined,
  };
}

async function varianceLimits() {
  const c = await getConfig();
  return { alertKg: c["erp.drums.varianceAlertKg"], alertPercent: c["erp.drums.varianceAlertPercent"] };
}

/* ============================================================ recording an empty drum */

/** Lots still holding drums that are not yet recorded empty, for the scan field's suggestions. */
async function lotOptions(): Promise<string[]> {
  const rows = (await db.execute(sql`
    select p.lot_no as lot from erp_purchases p left join erp_inward i on i.id = p.inward_id
      join erp_raw_materials m on m.id = p.raw_material_id
     where m.material_type = 'Chemical'
       and coalesce(p.drums, i.drums, 0) > (select count(*) from erp_empty_drums d where d.purchase_id = p.id and d.status <> 'cancelled')
     order by p.purchase_date desc limit 400`)) as unknown as { lot: string }[];
  return rows.map((r) => r.lot);
}

async function emptyForm(ctx: ErpContext): Promise<FormSpec> {
  const [lots, gds, c] = await Promise.all([lotOptions(), godownOptions(ctx, { lost: false }), getConfig()]);
  const approver = can(ctx, "scrapApprove");
  return {
    screen: "emptyDrums",
    id: "empty",
    title: "Record an empty drum",
    sub: "Scan the drum's GRN/lot label while it is still readable, and weigh the drum completely empty. The GRN, supplier, material and lot come from the label — nothing else is typed.",
    submit: "Save empty drum",
    init: { godown: ctx.workingGodown?.name ?? "", different: "No" },
    header: [
      { k: "code", l: "Drum label (lot)", t: "scan", req: true, opts: lots, hint: "Scan with the barcode scanner, or type the lot number printed on the label." },
      { k: "kg", l: "Actual empty weight (kg)", t: "num", req: true, min: 0.001, hint: `Expected between ${c["erp.drums.minEmptyKg"]} and ${c["erp.drums.maxEmptyKg"]} kg.` },
      { k: "godown", l: "Where the drum is now", t: "select", opts: gds.map((g) => g.name) },
      { k: "different", l: "A drum of this lot was just recorded — is this a different drum?", t: "select", opts: ["No", "Yes, a different drum"], hint: `Asked only when another drum of the same lot was recorded in the last ${c["erp.drums.sameLotMinutes"]} minutes.` },
      ...(approver
        ? [{ k: "weightException", l: "Approve a weight outside the limits (why it is right)", t: "area" as const, hint: "Only for a weight outside the limits. Leave empty otherwise." }]
        : []),
    ],
  };
}

async function saveEmpty(ctx: ErpContext, h: Record<string, string>): Promise<Result> {
  const godownId = await godownIdByName(text(h.godown));
  const r = await recordEmptyDrum(
    actorOf(ctx),
    { code: text(h.code) ?? "", kg: num(h.kg), source: "desk", godownId, confirmDifferent: (h.different ?? "").startsWith("Yes"), weightException: text(h.weightException) },
    { mayApproveWeight: can(ctx, "scrapApprove") },
  );
  if (!r.ok) {
    if (r.refusal?.kind === "confirm") return fieldErr("different", r.refusal.message);
    if (r.refusal?.kind === "lot" && r.refusal.existing?.length)
      return fieldErr("code", `${r.refusal.message} Already recorded: ${r.refusal.existing.map((e) => `${drumLabel(e.drumNo)} (drum ${e.seq ?? "?"}, ${DRUM_STATUS_LABEL[e.status].toLowerCase()})`).join(", ")}.`);
    if (r.refusal?.kind === "weight") return fieldErr(r.fieldErrors?.[0]?.field ?? "kg", r.refusal.message);
    return r;
  }
  const d = r.data;
  return okVoid(`${d.label} · drum ${d.seq ?? "?"}${d.drums ? ` of ${d.drums}` : ""} of ${d.lotNo} · ${d.statusLabel}${d.varianceKg != null ? ` · variance ${signedKg(d.varianceKg)}` : ""}`);
}

/* ============================================================ drum rows */

function drumCols(extra: ColSpec[] = []): ColSpec[] {
  /* Order is priority: a narrow screen keeps the first columns and folds the rest into the drawer. */
  return [
    { k: "drum", l: "Drum", t: "mono" },
    { k: "material", l: "Material", t: "b" },
    ...extra,
    { k: "kg", l: "Actual empty", t: "n", u: " kg" },
    { k: "variance", l: "Variance", t: "n", u: " kg" },
    { k: "lot", l: "Lot", t: "mono" },
    { k: "supplier", l: "Supplier", t: "t" },
    { k: "emptied", l: "Emptied", t: "d" },
    { k: "godown", l: "Godown", t: "t" },
    { k: "grn", l: "GRN (PR)", t: "mono" },
    { k: "by", l: "Recorded by", t: "t" },
    { k: "f", l: "Flags", t: "f" },
  ];
}

function drumValues(d: DrumRow) {
  const v = tareVariance(d.actualKg, d.declaredTareKg);
  return {
    drum: drumLabel(d.drumNo),
    material: d.material ?? (d.source === "opening" ? "Opening stock" : "—"),
    supplier: d.supplier,
    lot: d.lotNo,
    kg: d.actualKg,
    variance: v?.kg ?? null,
    emptied: d.emptiedOn,
    godown: d.godown,
    grn: d.prNumber == null ? null : `PR ${d.prNumber}`,
    by: d.by,
    ownership: ownLabel(d.ownership),
    status: DRUM_STATUS_LABEL[d.status],
    drumOf: d.seq ? `${d.seq}${d.drums ? ` of ${d.drums}` : ""}` : null,
  };
}

function drumRow(ctx: ErpContext, d: DrumRow, limits: { alertKg: number; alertPercent: number }, hist: Map<string, DrumHistoryLine[]>, extraActions: ActionSpec[] = []): ListRow {
  const v = tareVariance(d.actualKg, d.declaredTareKg);
  const live = d.status === "available" || d.status === "returnable" || d.status === "review";
  const flags: string[] = [];
  if (varianceIsHigh(v, limits)) flags.push("drumVariance");
  if (d.status === "review") flags.push("drumReview");
  if (d.weightException) flags.push("drumWeightException");
  if (d.source === "opening") flags.push("drumOpening");
  const actions: ActionSpec[] = [...extraActions];
  if (live) {
    actions.push(
      {
        id: "owner",
        l: "Change owner",
        why: d.status === "review" ? "Classify it on Needs review" : "",
        prompt: {
          title: `Change who owns ${drumLabel(d.drumNo)}`,
          sub: "Asked for here, approved by somebody else. Until then the drum stays as it is.",
          submit: "Ask for approval",
          fields: [{ k: "ownership", l: "It belongs to", t: "select", req: true, opts: [OWNERSHIP_LABEL.mahek, OWNERSHIP_LABEL.returnable] }, reasonField()],
        },
      },
      ...(d.source !== "opening"
        ? [
            {
              id: "weight",
              l: "Correct weight",
              why: why(ctx, "scrapApprove"),
              prompt: { title: `Correct ${drumLabel(d.drumNo)}'s weight`, sub: `Recorded at ${kgText(d.actualKg)}. The original stays in its history.`, submit: "Correct", fields: [{ k: "kg", l: "Correct weight (kg)", t: "num" as const, req: true, min: 0.001 }, reasonField()] },
            },
          ]
        : []),
      {
        id: "cancel",
        l: "Cancel entry",
        why: why(ctx, "scrapApprove"),
        prompt: { title: `Cancel ${drumLabel(d.drumNo)}?`, sub: "For an entry made in error — the wrong lot scanned, or one drum scanned twice. Kept, marked cancelled, and its drum number freed.", submit: "Cancel entry", fields: [reasonField()] },
      },
    );
  }
  return {
    id: d.id,
    v: { ...drumValues(d), f: null },
    flags,
    title: `${drumLabel(d.drumNo)} · ${d.material ?? "Opening stock"}${d.lotNo ? ` · ${d.lotNo}` : ""}`,
    header: `${DRUM_STATUS_LABEL[d.status]} · ${ownLabel(d.ownership)}`,
    fields: [
      { l: "Drum of the lot", v: d.seq ? `${d.seq}${d.drums ? ` of ${d.drums}` : " (the GRN records no drum count)"}` : "—" },
      { l: "Ownership", v: ownLabel(d.ownership) },
      { l: "Status", v: DRUM_STATUS_LABEL[d.status] },
      ...(d.reviewReason ? [{ l: "Why it needs review", v: d.reviewReason }] : []),
      ...(d.weightException ? [{ l: "Weight outside limits", v: d.weightException }] : []),
      ...(d.saleNo ? [{ l: "Sold on", v: scrapSaleLabel(d.saleNo) }] : []),
      ...(d.returnNo ? [{ l: "Returned on", v: drumReturnLabel(d.returnNo) }] : []),
      { l: "How it was recorded", v: d.source === "scan" ? "Scanned on the factory phone" : d.source === "desk" ? "Entered in the ERP" : "Opening stock" },
    ],
    actions,
    by: stampLine(d.by, d.recordedAt),
    panel: { kind: "scrap", data: drumPanel(d, limits, hist.get(d.id) ?? []) },
  };
}

const drumActions: ScreenModule["actions"] = {
  async owner(ctx, id, v) {
    const own = ownershipByLabel(v.ownership);
    if (!own) return fieldErr("ownership", "Choose who the drum belongs to.");
    return requestDrumAdjustment(actorOf(ctx), { kind: "ownership", drumId: id, newOwnership: own, reason: v.reason ?? "" });
  },
  async weight(ctx, id, v) {
    if (!can(ctx, "scrapApprove")) return refused("scrapApprove");
    return correctDrumWeight(actorOf(ctx), id, num(v.kg) ?? 0, v.reason ?? "");
  },
  async cancel(ctx, id, v) {
    if (!can(ctx, "scrapApprove")) return refused("scrapApprove");
    return cancelDrumEntry(actorOf(ctx), id, v.reason ?? "");
  },
  async classify(ctx, id, v) {
    if (!can(ctx, "scrapSale") && !can(ctx, "scrapApprove")) return refused("scrapSale");
    const own = ownershipByLabel(v.ownership);
    if (!own) return fieldErr("ownership", "Choose who the drum belongs to.");
    return classifyDrum(actorOf(ctx), id, own, v.note ?? "");
  },
  /** Test 7: a returnable drum is never sold, whatever button was pressed. */
  async sellReturnable() {
    return err(RETURNABLE_NOT_FOR_SALE, "rule_violation");
  },
};

/* ============================================================ selling scrap */

const REF_KIND = { invoice: "External invoice", challan: "Challan / other genuine reference", none: "No external invoice" } as const;
const refKindByLabel = (l: string | undefined) => (Object.entries(REF_KIND).find(([, v]) => v === l)?.[0] ?? null) as keyof typeof REF_KIND | null;

async function buyerOptions(): Promise<{ id: string; name: string }[]> {
  return db.select({ id: erpScrapBuyers.id, name: erpScrapBuyers.name }).from(erpScrapBuyers).where(eq(erpScrapBuyers.active, true)).orderBy(asc(erpScrapBuyers.name));
}

async function saleForm(ctx: ErpContext): Promise<FormSpec> {
  const [buyers, cats, gds, have] = await Promise.all([buyerOptions(), refValues("scrapCategory"), godownOptions(ctx, { lost: false }), availableDrums()]);
  return {
    screen: "scrapSales",
    id: "new",
    title: "New scrap sale",
    sub: `Enter how many were sold — empty drums are allocated oldest first (${have} Mahek-owned empty drum${have === 1 ? "" : "s"} available). Vendor-returnable drums are never offered.`,
    submit: "Save sale",
    init: { date: today(), category: "", quantity: "", refKind: REF_KIND.invoice, unit: "Kg" },
    header: [
      { k: "date", l: "Sale date", t: "date", req: true },
      { k: "buyer", l: "Scrap buyer", t: "select", req: true, opts: buyers.map((b) => b.name), hint: buyers.length ? undefined : "Add the buyer on Scrap buyers first." },
      { k: "category", l: "Scrap category", t: "select", req: true, opts: [DRUM_CATEGORY, ...cats] },
      { k: "godown", l: "From godown (optional)", t: "select", opts: gds.map((g) => g.name), hint: "Empty it to take drums or scrap from any godown." },
      { k: "quantity", l: "Quantity sold", t: "num", req: true, min: 0.001 },
      { k: "unit", l: "Unit", t: "select", opts: ["Kg", "Pcs"], when: { k: "category", in: cats } },
      { k: "rate", l: "Rate (₹ per drum, kg or piece)", t: "num", req: true, min: 0 },
      { k: "refKind", l: "Invoice / external reference", t: "select", req: true, opts: Object.values(REF_KIND), hint: "A sale with no external invoice is recorded by its own sale number. No invoice number is made up for it." },
      { k: "externalRef", l: "Invoice / external reference no.", t: "text", when: { k: "refKind", in: [REF_KIND.invoice, REF_KIND.challan] }, reqWhen: { k: "refKind", in: [REF_KIND.invoice, REF_KIND.challan] } },
      { k: "dueDate", l: "Payment due by (optional)", t: "date" },
      { k: "remark", l: "Remarks", t: "area", mic: true },
    ],
  };
}

/** The sale form for one particular drum, built from the general one so a list of drums asks the database once. */
function oneDrumSale(base: FormSpec, d: DrumRow): FormSpec {
  return {
    ...base,
    screen: "emptyDrums",
    id: "sell",
    recordId: d.id,
    title: `Sell ${drumLabel(d.drumNo)} as scrap`,
    sub: "This one drum is sold. Its GRN, supplier and lot stay linked to the sale.",
    init: { ...base.init, category: DRUM_CATEGORY, quantity: "1" },
    header: base.header.map((f) => (f.k === "category" || f.k === "quantity" ? { ...f, readOnly: true } : f)),
  };
}

async function saveSale(ctx: ErpContext, h: Record<string, string>, drumId?: string): Promise<Result> {
  if (!can(ctx, "scrapSale")) return refused("scrapSale");
  const buyers = await buyerOptions();
  const buyer = buyers.find((b) => b.name === h.buyer);
  if (!buyer) return fieldErr("buyer", "Choose the scrap buyer.");
  const category = drumId ? DRUM_CATEGORY : (text(h.category) ?? "");
  const cats = await refValues("scrapCategory");
  if (category !== DRUM_CATEGORY && !cats.includes(category)) return fieldErr("category", "Choose a scrap category.");
  const kind = refKindByLabel(h.refKind);
  if (!kind) return fieldErr("refKind", "Say whether an external invoice was issued.");
  const ratePaise = paise(h.rate);
  if (ratePaise == null) return fieldErr("rate", "Enter the rate.");
  const godownId = await godownIdByName(text(h.godown));
  const r = await sellScrap(actorOf(ctx), {
    date: text(h.date) ?? today(),
    buyerId: buyer.id,
    category,
    quantity: drumId ? 1 : (num(h.quantity) ?? 0),
    unit: category === DRUM_CATEGORY ? "Pcs" : h.unit === "Pcs" ? "Pcs" : "Kg",
    ratePaise,
    refKind: kind,
    externalRef: kind === "none" ? null : text(h.externalRef),
    dueDate: text(h.dueDate),
    remark: text(h.remark),
    godownId,
    drumIds: drumId ? [drumId] : undefined,
  });
  return r.ok ? okVoid(r.message) : r;
}

/* ============================================================ the modules */

const emptyDrums: ScreenModule = {
  key: "emptyDrums",
  async load(ctx) {
    const [all, limits, form, base] = await Promise.all([drumRows(), varianceLimits(), emptyForm(ctx), saleForm(ctx)]);
    const rows = all.filter((d) => d.status === "available");
    const hist = await drumHistories(rows.map((d) => d.id));
    const sellWhy = why(ctx, "scrapSale");
    return {
      spec: {
        screen: "emptyDrums",
        cols: drumCols(),
        hidden: [],
        groups: ["material", "supplier", "godown"],
        godownKey: "godown",
        sortDefault: ["emptied", 1],
        newForm: form,
        newLabel: "Record empty drum",
        tools: [{ id: "sell", l: "Sell drums", href: erpLink("scrapSales"), why: sellWhy }],
        noDataLine: "No Mahek-owned empty drums in stock. Drums appear here once they are scanned empty and weighed.",
      },
      rows: rows.map((d) => drumRow(ctx, d, limits, hist, [{ id: "sell", l: "Sell as scrap", primary: true, why: sellWhy, form: oneDrumSale(base, d) }])),
    };
  },
  forms: {
    empty: saveEmpty,
    async sell(ctx, h, _l, id) {
      if (!id) return err("Pick the drum to sell.");
      return saveSale(ctx, h, id);
    },
  },
  actions: drumActions,
};

const drumReturnable: ScreenModule = {
  key: "drumReturnable",
  async load(ctx) {
    const [all, limits] = await Promise.all([drumRows(), varianceLimits()]);
    const rows = all.filter((d) => d.status === "returnable");
    const hist = await drumHistories(rows.map((d) => d.id));
    const day = today();
    return {
      spec: {
        screen: "drumReturnable",
        cols: drumCols([{ k: "age", l: "Waiting", t: "s" }]),
        hidden: [],
        groups: ["supplier", "material"],
        chips: "age",
        godownKey: "godown",
        sortDefault: ["emptied", 1],
        tools: [{ id: "return", l: "Return drums", href: erpLink("drumReturns"), primary: true, why: why(ctx, "scrapSale") }],
        noDataLine: "No supplier-owned drums waiting to be returned.",
      },
      rows: rows.map((d) => {
        const row = drumRow(ctx, d, limits, hist, [{ id: "sellReturnable", l: "Sell as scrap", why: RETURNABLE_NOT_FOR_SALE }]);
        row.v.age = returnBucket(d.emptiedOn, day);
        return row;
      }),
    };
  },
  actions: drumActions,
};

const drumReview: ScreenModule = {
  key: "drumReview",
  async load(ctx) {
    const [all, limits] = await Promise.all([drumRows(), varianceLimits()]);
    const rows = all.filter((d) => d.status === "review");
    const hist = await drumHistories(rows.map((d) => d.id));
    const w = can(ctx, "scrapSale") || can(ctx, "scrapApprove") ? "" : "The Production Head decides";
    return {
      spec: {
        screen: "drumReview",
        cols: drumCols([{ k: "reason", l: "Why", t: "t" }]),
        hidden: [],
        groups: ["supplier"],
        noDataLine: "Nothing waiting. A drum lands here when its GRN and its supplier say nothing about who owns it, or the GRN has no drum count.",
      },
      rows: rows.map((d) => {
          const row = drumRow(ctx, d, limits, hist, [
            {
              id: "classify",
              l: "Classify",
              primary: true,
              why: w,
              prompt: {
                title: `Whose is ${drumLabel(d.drumNo)}?`,
                sub: `${d.supplier ?? "No supplier"} · ${d.lotNo ?? ""}. Decide from the purchase terms or the supplier — never by guess.`,
                submit: "Save",
                fields: [{ k: "ownership", l: "It belongs to", t: "select", req: true, opts: [OWNERSHIP_LABEL.mahek, OWNERSHIP_LABEL.returnable] }, { k: "note", l: "How you know", t: "area", req: true, mic: true }],
              },
            },
          ]);
          row.v.reason = d.reviewReason;
          return row;
        }),
    };
  },
  actions: drumActions,
};

const drumVariance: ScreenModule = {
  key: "drumVariance",
  async load() {
    const [all, limits] = await Promise.all([drumRows(), varianceLimits()]);
    const rows = all.filter((d) => d.actualKg != null && d.status !== "cancelled");
    const cols: ColSpec[] = [
      { k: "drum", l: "Drum", t: "mono" },
      { k: "supplier", l: "Supplier", t: "b" },
      { k: "material", l: "Material", t: "t" },
      { k: "grn", l: "GRN (PR)", t: "mono" },
      { k: "lot", l: "Lot", t: "mono" },
      { k: "declared", l: "Declared tare", t: "n", u: " kg" },
      { k: "kg", l: "Actual empty", t: "n", u: " kg" },
      { k: "variance", l: "Variance", t: "n", u: " kg" },
      { k: "pct", l: "Variance %", t: "n", u: "%" },
      { k: "verdict", l: "Verdict", t: "s" },
      { k: "emptied", l: "Emptied", t: "d" },
    ];
    return {
      spec: {
        screen: "drumVariance",
        cols,
        hidden: [],
        groups: ["supplier", "material", "grn", "lot"],
        agg: { k: "variance", l: "kg average variance", t: "avg" },
        chips: "verdict",
        readOnly: true,
        download: true,
        sortDefault: ["variance", -1],
        noDataLine: "No weighed empty drums yet.",
      },
      rows: rows.map((d) => {
        const v = tareVariance(d.actualKg, d.declaredTareKg);
        const high = varianceIsHigh(v, limits);
        return {
          id: d.id,
          v: {
            drum: drumLabel(d.drumNo),
            supplier: d.supplier,
            material: d.material,
            grn: d.prNumber == null ? null : `PR ${d.prNumber}`,
            lot: d.lotNo,
            declared: d.declaredTareKg,
            kg: d.actualKg,
            variance: v?.kg ?? null,
            pct: v?.pct ?? null,
            verdict: !v ? "No declared tare" : high ? "Above limit" : "Within limit",
            emptied: d.emptiedOn,
          },
          flags: high ? ["drumVariance"] : [],
          title: `${drumLabel(d.drumNo)} · ${d.supplier ?? ""}`,
          header: v ? `${signedKg(v.kg)} against ${kgText(d.declaredTareKg)} declared` : "The GRN declared no empty-drum weight",
          fields: [{ l: "Limits", v: `${limits.alertKg} kg or ${limits.alertPercent}% either way` }],
        };
      }),
    };
  },
};

const drumRegister: ScreenModule = {
  key: "drumRegister",
  async load(ctx) {
    const [all, limits] = await Promise.all([drumRows(), varianceLimits()]);
    const hist = await drumHistories(all.map((d) => d.id));
    return {
      spec: {
        screen: "drumRegister",
        cols: drumCols([{ k: "ownership", l: "Ownership", t: "s" }, { k: "status", l: "Status", t: "s" }]),
        hidden: [],
        groups: ["status", "ownership", "supplier", "material"],
        chips: "status",
        godownKey: "godown",
        download: true,
        noDataLine: "No drums recorded empty yet.",
      },
      rows: all.map((d) => drumRow(ctx, d, limits, hist)),
    };
  },
  actions: drumActions,
};

/* ------------------------------------------------------------ corrections */

const ADJ_KIND = { opening: "Opening stock (drums already here)", write_off: "Write off (drums gone or damaged)", ownership: "Change of owner" } as const;

async function supplierNames(): Promise<{ id: string; name: string }[]> {
  return db.select({ id: erpSuppliers.id, name: erpSuppliers.name }).from(erpSuppliers).orderBy(asc(erpSuppliers.name));
}

const drumAdjustments: ScreenModule = {
  key: "drumAdjustments",
  async load(ctx) {
    const [rows, sups, gds] = await Promise.all([
      db
        .select({ a: erpDrumAdjustments, supplier: erpSuppliers.name, godown: erpGodowns.name, by: users.name })
        .from(erpDrumAdjustments)
        .leftJoin(erpSuppliers, eq(erpSuppliers.id, erpDrumAdjustments.supplierId))
        .leftJoin(erpGodowns, eq(erpGodowns.id, erpDrumAdjustments.godownId))
        .leftJoin(users, eq(users.id, erpDrumAdjustments.requestedById))
        .orderBy(sql`${erpDrumAdjustments.requestedAt} desc`),
      supplierNames(),
      godownOptions(ctx, { lost: false }),
    ]);
    const deciders = await db.select({ id: users.id, name: users.name }).from(users).where(sql`${users.id} in (select decided_by_id from erp_drum_adjustments where decided_by_id is not null)`);
    const nameOf = new Map(deciders.map((u) => [u.id, u.name]));
    const drumNos = new Map(
      ((await db.execute(sql`select id, drum_no as n from erp_empty_drums where id in (select drum_id from erp_drum_adjustments where drum_id is not null)`)) as unknown as { id: string; n: number }[]).map((r) => [r.id, Number(r.n)]),
    );
    const form: FormSpec = {
      screen: "drumAdjustments",
      id: "new",
      title: "Ask for a drum correction",
      sub: "Opening stock adds drums that were here before MahekOne recorded them; a write-off takes away drums that are gone, oldest first. Somebody else approves it before any drum moves.",
      submit: "Ask for approval",
      header: [
        { k: "kind", l: "What", t: "select", req: true, opts: [ADJ_KIND.opening, ADJ_KIND.write_off] },
        { k: "ownership", l: "Whose drums", t: "select", req: true, opts: [OWNERSHIP_LABEL.mahek, OWNERSHIP_LABEL.returnable] },
        { k: "supplier", l: "Supplier they belong to", t: "select", opts: sups.map((s) => s.name), when: { k: "ownership", eq: OWNERSHIP_LABEL.returnable }, reqWhen: { k: "ownership", eq: OWNERSHIP_LABEL.returnable } },
        { k: "godown", l: "Godown", t: "select", opts: gds.map((g) => g.name), reqWhen: { k: "kind", eq: ADJ_KIND.opening }, hint: "For a write-off, empty takes the oldest drums anywhere." },
        { k: "quantity", l: "How many drums", t: "num", req: true, min: 1 },
        reasonField("Why"),
      ],
    };
    return {
      spec: {
        screen: "drumAdjustments",
        cols: [
          { k: "asked", l: "Asked", t: "d" },
          { k: "kind", l: "What", t: "b" },
          { k: "detail", l: "Detail", t: "t" },
          { k: "reason", l: "Why", t: "t" },
          { k: "status", l: "Status", t: "s" },
          { k: "by", l: "Asked by", t: "t" },
          { k: "decidedBy", l: "Decided by", t: "t" },
        ],
        hidden: [],
        chips: "status",
        newForm: form,
        newLabel: "Ask for a correction",
        noDataLine: "No corrections asked for.",
      },
      rows: rows.map((r) => {
        const a = r.a;
        const mine = a.requestedById === ctx.user.id && !ctx.administrator;
        const decideWhy = a.status !== "pending" ? "Already decided" : !can(ctx, "scrapApprove") ? why(ctx, "scrapApprove") : mine ? "Somebody other than you approves your own request" : "";
        const detail =
          a.kind === "ownership"
            ? `${drumNos.has(a.drumId!) ? drumLabel(drumNos.get(a.drumId!)!) : "Drum"} → ${OWNERSHIP_LABEL[a.newOwnership as DrumOwnership]}`
            : `${a.quantity} drum${a.quantity === 1 ? "" : "s"} · ${OWNERSHIP_LABEL[a.ownership as DrumOwnership]}${r.supplier ? ` · ${r.supplier}` : ""}${r.godown ? ` · ${r.godown}` : ""}`;
        return {
          id: a.id,
          v: {
            asked: calendarDate(a.requestedAt),
            kind: ADJ_KIND[a.kind as keyof typeof ADJ_KIND],
            detail,
            reason: a.reason,
            status: a.status === "pending" ? "Pending approval" : a.status === "approved" ? "Approved" : "Rejected",
            by: r.by,
            decidedBy: a.decidedById ? (nameOf.get(a.decidedById) ?? null) : null,
          },
          flags: a.status === "pending" ? ["awaitingApproval"] : [],
          title: `${ADJ_KIND[a.kind as keyof typeof ADJ_KIND]} · ${detail}`,
          fields: [{ l: "Why", v: a.reason }, ...(a.decisionNote ? [{ l: "Decision note", v: a.decisionNote }] : []), ...(a.posted?.drums?.length ? [{ l: "Drums it moved", v: String(a.posted.drums.length) }] : [])],
          actions: [
            { id: "approve", l: "Approve", primary: true, why: decideWhy, prompt: { title: "Approve this correction?", sub: detail, submit: "Approve", fields: [{ k: "note", l: "Note (optional)", t: "text" }] } },
            { id: "reject", l: "Reject", why: decideWhy, prompt: { title: "Reject this correction?", submit: "Reject", fields: [{ k: "note", l: "Why it is rejected", t: "area", req: true }] } },
          ],
          by: stampLine(r.by, a.requestedAt),
        };
      }),
    };
  },
  forms: {
    async new(ctx, h) {
      const kind = h.kind === ADJ_KIND.opening ? "opening" : h.kind === ADJ_KIND.write_off ? "write_off" : null;
      if (!kind) return fieldErr("kind", "Choose what this is.");
      const own = ownershipByLabel(h.ownership);
      if (!own) return fieldErr("ownership", "Choose whose drums.");
      const sup = (await supplierNames()).find((s) => s.name === h.supplier);
      const qty = int(h.quantity);
      return requestDrumAdjustment(actorOf(ctx), { kind, ownership: own, supplierId: sup?.id ?? null, godownId: await godownIdByName(text(h.godown)), quantity: qty ?? 0, reason: h.reason ?? "" });
    },
  },
  actions: {
    async approve(ctx, id, v) {
      if (!can(ctx, "scrapApprove")) return refused("scrapApprove");
      return decideDrumAdjustment(actorOf(ctx), id, true, v.note ?? "", { administrator: ctx.administrator });
    },
    async reject(ctx, id, v) {
      if (!can(ctx, "scrapApprove")) return refused("scrapApprove");
      return decideDrumAdjustment(actorOf(ctx), id, false, v.note ?? "", { administrator: ctx.administrator });
    },
  },
};

/* ------------------------------------------------------------ vendor returns */

async function pendingBySupplier(): Promise<{ id: string; name: string; pending: number; oldest: string | null; buckets: Record<string, number>; returned: number }[]> {
  const day = today();
  const drums = (await drumRows()).filter((d) => d.supplierId && (d.status === "returnable" || d.status === "returned"));
  const sups = new Map<string, { id: string; name: string; pending: number; oldest: string | null; buckets: Record<string, number>; returned: number }>();
  for (const d of drums) {
    const s = sups.get(d.supplierId!) ?? { id: d.supplierId!, name: d.supplier ?? "", pending: 0, oldest: null, buckets: Object.fromEntries(RETURN_BUCKETS.map((b) => [b, 0])), returned: 0 };
    if (d.status === "returned") s.returned++;
    else {
      s.pending++;
      const on = d.emptiedOn;
      if (!s.oldest || on < s.oldest) s.oldest = on;
      s.buckets[returnBucket(on, day)]++;
    }
    sups.set(s.id, s);
  }
  return [...sups.values()];
}

async function returnForm(ctx: ErpContext, supplier?: string): Promise<FormSpec> {
  const pend = (await pendingBySupplier()).filter((s) => s.pending > 0);
  return {
    screen: "drumReturns",
    id: "new",
    title: "Returnable drum outward",
    sub: "Enter how many drums went back. The oldest of that supplier's waiting drums are allocated — nobody has to find each drum.",
    submit: "Save outward",
    init: { date: today(), supplier: supplier ?? "" },
    header: [
      { k: "supplier", l: "Supplier", t: "select", req: true, opts: pend.map((s) => s.name), hint: pend.length ? pend.map((s) => `${s.name}: ${s.pending} waiting`).join(" · ") : "No supplier has drums waiting to be returned." },
      { k: "date", l: "Return date", t: "date", req: true },
      { k: "quantity", l: "Drums returned", t: "num", req: true, min: 1 },
      { k: "challan", l: "Challan / return reference no.", t: "text" },
      { k: "remark", l: "Remarks", t: "area", mic: true },
    ],
  };
}

async function saveReturn(ctx: ErpContext, h: Record<string, string>): Promise<Result> {
  if (!can(ctx, "scrapSale")) return refused("scrapSale");
  const sup = (await supplierNames()).find((s) => s.name === h.supplier);
  if (!sup) return fieldErr("supplier", "Choose the supplier.");
  const r = await returnDrums(actorOf(ctx), { supplierId: sup.id, date: text(h.date) ?? today(), quantity: int(h.quantity) ?? 0, challanRef: text(h.challan), remark: text(h.remark) });
  return r.ok ? okVoid(r.message) : r;
}

const drumReturns: ScreenModule = {
  key: "drumReturns",
  async load(ctx) {
    const rows = (await db.execute(sql`
      select r.id, r.return_no as no, r.return_date::text as date, s.name as supplier, r.quantity, r.challan_ref as challan, r.remark, r.status,
             r.cancel_reason as "cancelReason", u.name as by, r.created_at::text as at
        from erp_drum_returns r join erp_suppliers s on s.id = r.supplier_id left join users u on u.id = r.created_by_id
       order by r.return_date desc, r.return_no desc`)) as unknown as { id: string; no: number; date: string; supplier: string; quantity: number; challan: string | null; remark: string | null; status: string; cancelReason: string | null; by: string | null; at: string }[];
    const drums = await drumRows();
    return {
      spec: {
        screen: "drumReturns",
        cols: [
          { k: "no", l: "Outward", t: "mono" },
          { k: "date", l: "Return date", t: "d" },
          { k: "supplier", l: "Supplier", t: "b" },
          { k: "qty", l: "Drums", t: "n" },
          { k: "challan", l: "Challan / reference", t: "mono" },
          { k: "status", l: "Status", t: "s" },
          { k: "by", l: "Recorded by", t: "t" },
        ],
        hidden: [],
        groups: ["supplier"],
        agg: { k: "qty", l: "drums" },
        newForm: can(ctx, "scrapSale") ? await returnForm(ctx) : undefined,
        newLabel: "Return drums",
        noDataLine: "No drums returned to suppliers yet.",
      },
      rows: rows.map((r) => {
        const mine = drums.filter((d) => d.returnId === r.id);
        return {
          id: r.id,
          v: { no: drumReturnLabel(Number(r.no)), date: r.date, supplier: r.supplier, qty: Number(r.quantity), challan: r.challan, status: r.status === "confirmed" ? "Returned" : "Cancelled", by: r.by },
          flags: [],
          title: `${drumReturnLabel(Number(r.no))} · ${r.quantity} drums to ${r.supplier}`,
          fields: [{ l: "Remarks", v: r.remark ?? "—" }, ...(r.cancelReason ? [{ l: "Cancelled because", v: r.cancelReason }] : [])],
          actions: [
            { id: "cancel", l: "Cancel outward", why: r.status !== "confirmed" ? "Already cancelled" : why(ctx, "scrapApprove"), prompt: { title: `Cancel ${drumReturnLabel(Number(r.no))}?`, sub: "Its drums go back to waiting for return.", submit: "Cancel outward", fields: [reasonField()] } },
          ],
          by: stampLine(r.by, r.at),
          panel: {
            kind: "scrap",
            data: {
              figures: [{ l: "Drums", v: String(r.quantity) }],
              sections: [{ title: "Drums allocated (oldest first)", empty: "None — the outward is cancelled.", lines: mine.map((d) => ({ text: `${drumLabel(d.drumNo)} · ${d.material ?? ""}`, sub: `${d.lotNo ?? ""} · PR ${d.prNumber ?? "—"} · emptied ${fd(d.emptiedOn)}` })) }],
              note: "Allocated by the system, oldest first, for traceability — not a record that each drum was checked at the gate.",
            } satisfies ScrapPanel,
          },
        };
      }),
    };
  },
  forms: { new: saveReturn },
  actions: {
    async cancel(ctx, id, v) {
      if (!can(ctx, "scrapApprove")) return refused("scrapApprove");
      return cancelDrumReturn(actorOf(ctx), id, v.reason ?? "");
    },
  },
};

const drumPending: ScreenModule = {
  key: "drumPending",
  async load(ctx) {
    const sups = await pendingBySupplier();
    return {
      spec: {
        screen: "drumPending",
        cols: [
          { k: "supplier", l: "Supplier", t: "b" },
          { k: "pending", l: "Waiting to return", t: "n" },
          { k: "oldest", l: "Oldest waiting since", t: "d" },
          ...RETURN_BUCKETS.map((b, i) => ({ k: `b${i}`, l: b, t: "n" as const })),
          { k: "returned", l: "Returned so far", t: "n" },
        ],
        hidden: [],
        agg: { k: "pending", l: "waiting" },
        readOnly: true,
        sortDefault: ["oldest", 1],
        noDataLine: "No supplier-owned drums recorded empty yet.",
      },
      rows: await Promise.all(
        sups.map(async (s) => ({
          id: s.id,
          v: { supplier: s.name, pending: s.pending, oldest: s.oldest, ...Object.fromEntries(RETURN_BUCKETS.map((b, i) => [`b${i}`, s.buckets[b]])), returned: s.returned },
          flags: s.buckets["90+ days"] > 0 ? ["late"] : [],
          title: `${s.name} · ${s.pending} drums waiting`,
          actions: [{ id: "return", l: "Return drums", primary: true, why: s.pending ? why(ctx, "scrapSale") : "Nothing waiting", form: await returnForm(ctx, s.name) }],
        })),
      ),
    };
  },
  forms: { new: saveReturn },
};

/* ------------------------------------------------------------ scrap sales */

function salePanel(s: SaleRow, allocs: Awaited<ReturnType<typeof allocationRows>>, drums: DrumRow[]): ScrapPanel {
  const live = allocs.filter((a) => !a.voidedAt);
  return {
    figures: [
      { l: "Sale value", v: inr(s.amountPaise) },
      { l: "Received", v: inr(s.matchedPaise), tone: s.matchedPaise > 0 ? "success" : undefined },
      { l: "Outstanding", v: inr(s.outstandingPaise), tone: s.outstandingPaise > 0 ? "danger" : "success" },
    ],
    sections: [
      {
        title: "Petty Cash/Bank receipts matched",
        empty: "Nothing matched yet. Money is matched by the accountant from Petty Cash/Bank → Receipts.",
        lines: allocs.map((a) => ({
          text: `${inr(a.amountPaise)} from ${receiptLabel(a.receiptNo)} (${a.mode}, ${fd(a.receiptDate)})`,
          sub: a.voidedAt ? `Undone — ${a.voidReason}` : `Matched by ${a.by ?? "—"}`,
          tone: a.voidedAt ? ("muted" as const) : undefined,
        })),
      },
      ...(drums.length
        ? [{ title: `Drums allocated (${drums.length}, oldest first)`, lines: drums.map((d) => ({ text: `${drumLabel(d.drumNo)} · ${d.material ?? "Opening stock"} · ${d.supplier ?? ""}`, sub: `${d.lotNo ?? "no lot"} · PR ${d.prNumber ?? "—"} · ${kgText(d.actualKg)}` })) }]
        : []),
    ],
    note: live.length ? undefined : drums.length ? "Drums are allocated by the system, oldest first, for traceability — not a record that each drum was checked at dispatch." : undefined,
  };
}

/* Order is priority: what a sale is worth and what is still owed stay on screen at any width. */
const saleCols: ColSpec[] = [
  { k: "no", l: "Sale", t: "mono" },
  { k: "buyer", l: "Scrap buyer", t: "b" },
  { k: "amount", l: "Sale amount", t: "m" },
  { k: "outstanding", l: "Outstanding", t: "m" },
  { k: "state", l: "Payment", t: "s" },
  { k: "date", l: "Date", t: "d" },
  { k: "category", l: "Category", t: "t" },
  { k: "qty", l: "Quantity", t: "n" },
  { k: "received", l: "Received", t: "m" },
  { k: "rate", l: "Rate", t: "m" },
  { k: "ref", l: "Invoice / reference", t: "mono" },
  { k: "due", l: "Due", t: "d" },
];

function saleValues(s: SaleRow) {
  return {
    no: scrapSaleLabel(s.saleNo),
    date: s.date,
    buyer: s.buyer,
    category: s.category,
    qty: `${nf(s.quantity)} ${s.category === DRUM_CATEGORY ? "drums" : s.unit}`,
    rate: s.ratePaise,
    amount: s.amountPaise,
    received: s.matchedPaise,
    outstanding: s.outstandingPaise,
    state: s.status === "cancelled" ? "Cancelled" : paymentState(s.amountPaise, s.matchedPaise),
    ref: s.refKind === "none" ? "No external invoice" : s.externalRef,
    due: s.dueDate,
  };
}

async function openReceiptsFor(buyerId: string) {
  return (await receiptRows()).filter((r) => r.status === "active" && r.leftPaise > 0 && (!r.buyerId || r.buyerId === buyerId));
}
const receiptOption = (r: { receiptNo: number; date: string; mode: string; leftPaise: number; payer: string | null; buyer: string | null }) =>
  `${receiptLabel(r.receiptNo)} · ${fd(r.date)} · ${r.mode} · ${inr(r.leftPaise)} unmatched${r.buyer || r.payer ? ` · ${r.buyer ?? r.payer}` : ""}`;

async function saleRowsFor(ctx: ErpContext, rows: SaleRow[]): Promise<ListRow[]> {
  const [allocs, drums] = await Promise.all([allocationRows(), drumRows()]);
  const day = today();
  return Promise.all(
    rows.map(async (s) => {
      const open = s.status === "confirmed" && s.outstandingPaise > 0;
      const receipts = open && can(ctx, "scrapAccounts") ? await openReceiptsFor(s.buyerId) : [];
      const matchWhy = !open ? (s.status === "cancelled" ? "The sale is cancelled" : "Nothing outstanding") : why(ctx, "scrapAccounts") || (receipts.length ? "" : "No unmatched receipt from this buyer — record it on Petty Cash/Bank → Receipts first");
      const hasMatches = allocs.some((a) => a.saleId === s.id && !a.voidedAt);
      return {
        id: s.id,
        v: { ...saleValues(s), bucket: open ? receivableBucket(s.dueDate, s.date, day) : null },
        flags: open && receivableBucket(s.dueDate, s.date, day) !== "Current" ? ["late"] : [],
        title: `${scrapSaleLabel(s.saleNo)} · ${s.buyer} · ${inr(s.amountPaise)}`,
        header: s.status === "cancelled" ? `Cancelled — ${s.cancelReason}` : `${paymentState(s.amountPaise, s.matchedPaise)} · ${inr(s.outstandingPaise)} outstanding`,
        fields: [
          { l: "Category", v: s.category },
          { l: "Quantity × rate", v: `${nf(s.quantity)} ${s.unit} × ${inr(s.ratePaise)}`, der: true },
          { l: "Invoice / reference", v: s.refKind === "none" ? `No external invoice — traced by ${scrapSaleLabel(s.saleNo)}` : `${s.refKind === "invoice" ? "Invoice" : "Reference"} ${s.externalRef}` },
          { l: "From godown", v: s.godown ?? "Any" },
          { l: "Remarks", v: s.remark ?? "—" },
        ],
        actions: [
          {
            id: "match",
            l: "Match a receipt",
            primary: true,
            why: matchWhy,
            prompt: {
              title: `Match money to ${scrapSaleLabel(s.saleNo)}`,
              sub: `${inr(s.outstandingPaise)} outstanding. Never more than the receipt has left, nor more than is owed.`,
              submit: "Match",
              fields: [
                { k: "receipt", l: "Petty Cash/Bank receipt", t: "select", req: true, opts: receipts.map(receiptOption) },
                { k: "amount", l: "Amount to match (₹)", t: "num", req: true, min: 0.01, max: s.outstandingPaise / 100 },
              ],
            },
          },
          {
            id: "cancel",
            l: "Cancel sale",
            why: s.status !== "confirmed" ? "Already cancelled" : hasMatches ? "Money is matched to it — the accountant undoes the match first" : why(ctx, "scrapApprove"),
            prompt: { title: `Cancel ${scrapSaleLabel(s.saleNo)}?`, sub: s.category === DRUM_CATEGORY ? "Its drums go back to Mahek stock." : "Its quantity goes back to scrap stock.", submit: "Cancel sale", fields: [reasonField()] },
          },
        ],
        by: stampLine(s.by, s.createdAt),
        panel: { kind: "scrap", data: salePanel(s, allocs.filter((a) => a.saleId === s.id), drums.filter((d) => d.saleId === s.id)) },
      };
    }),
  );
}

const saleActions: ScreenModule["actions"] = {
  async match(ctx, id, v) {
    if (!can(ctx, "scrapAccounts")) return refused("scrapAccounts");
    const no = Number(/^RCPT-(\d+)/.exec(v.receipt ?? "")?.[1]);
    const rc = (await receiptRows()).find((r) => r.receiptNo === no);
    if (!rc) return fieldErr("receipt", "Choose the receipt.");
    const amount = paise(v.amount);
    if (amount == null) return fieldErr("amount", "Enter the amount.");
    return allocateReceipt(actorOf(ctx), rc.id, id, amount);
  },
  async cancel(ctx, id, v) {
    if (!can(ctx, "scrapApprove")) return refused("scrapApprove");
    return cancelScrapSale(actorOf(ctx), id, v.reason ?? "");
  },
};

const scrapSales: ScreenModule = {
  key: "scrapSales",
  async load(ctx) {
    const rows = await saleRows();
    return {
      spec: {
        screen: "scrapSales",
        cols: saleCols,
        hidden: [],
        groups: ["buyer", "category", "state"],
        agg: { k: "amount", l: "sold" },
        chips: "state",
        download: true,
        newForm: can(ctx, "scrapSale") ? await saleForm(ctx) : undefined,
        newLabel: "New scrap sale",
        noDataLine: "No scrap sold yet.",
      },
      rows: await saleRowsFor(ctx, rows),
    };
  },
  forms: { new: (ctx, h) => saveSale(ctx, h) },
  actions: saleActions,
};

const scrapReceivables: ScreenModule = {
  key: "scrapReceivables",
  async load(ctx) {
    const rows = (await saleRows()).filter((s) => s.status === "confirmed" && s.outstandingPaise > 0);
    return {
      spec: {
        screen: "scrapReceivables",
        cols: [...saleCols, { k: "bucket", l: "Ageing (days past due)", t: "s" }],
        hidden: [],
        groups: ["buyer", "bucket"],
        agg: { k: "outstanding", l: "outstanding" },
        chips: "bucket",
        download: true,
        sortDefault: ["due", 1],
        noDataLine: "Nothing outstanding on scrap sales.",
      },
      rows: (await saleRowsFor(ctx, rows)).sort((a, b) => AGE_BUCKETS.indexOf(b.v.bucket as never) - AGE_BUCKETS.indexOf(a.v.bucket as never)),
    };
  },
  actions: saleActions,
};

/* ------------------------------------------------------------ scrap stock */

const scrapStockScreen: ScreenModule = {
  key: "scrapStock",
  async load(ctx) {
    const [stock, gds, drumsAt] = await Promise.all([
      scrapStock(),
      db.select({ id: erpGodowns.id, name: erpGodowns.name }).from(erpGodowns),
      db.execute(sql`select g.name as godown, count(*)::int as n from erp_empty_drums d join erp_godowns g on g.id = d.godown_id where d.status = 'available' group by g.name`) as unknown as Promise<{ godown: string; n: number }[]>,
    ]);
    const gName = new Map(gds.map((g) => [g.id, g.name]));
    const cats = await refValues("scrapCategory");
    const gOpts = await godownOptions(ctx, { lost: false });
    const rows: ListRow[] = [
      ...drumsAt.map((d) => ({
        id: `drum:${d.godown}`,
        v: { category: DRUM_CATEGORY, godown: d.godown, onHand: Number(d.n), unit: "Pcs" },
        flags: [],
        title: `${DRUM_CATEGORY} · ${d.godown}`,
        header: "Mahek-owned empty drums only. Vendor-returnable drums are never scrap.",
        actions: [{ id: "open", l: "Open the drums", href: erpLink("emptyDrums") }],
      })),
      ...stock
        .filter((s) => s.available !== 0)
        .map((s) => ({
          id: `${s.category}|${s.unit}|${s.godownId}`,
          v: { category: s.category, godown: s.godownId ? (gName.get(s.godownId) ?? "") : "Any", onHand: s.available, unit: s.unit },
          flags: s.available < 0 ? ["below"] : [],
          title: `${s.category} · ${s.godownId ? gName.get(s.godownId) : "Any"}`,
          header: "Recorded, less what was sold.",
        })),
    ];
    return {
      spec: {
        screen: "scrapStock",
        cols: [
          { k: "category", l: "Category", t: "b" },
          { k: "onHand", l: "On hand", t: "n" },
          { k: "unit", l: "Unit", t: "t" },
          { k: "godown", l: "Godown", t: "t" },
        ],
        hidden: [],
        groups: ["category"],
        godownKey: "godown",
        newForm: {
          screen: "scrapStock",
          id: "new",
          title: "Record scrap",
          sub: "Plastic bags, cardboard and other scrap are recorded by category, a batch at a time — no record per bag or box. Empty drums are recorded from their label on Empty drums.",
          submit: "Save",
          init: { date: today(), godown: ctx.workingGodown?.name ?? "", unit: "Kg" },
          header: [
            { k: "date", l: "Date", t: "date", req: true },
            { k: "category", l: "Category", t: "select", req: true, opts: cats },
            { k: "godown", l: "Godown", t: "select", req: true, opts: gOpts.map((g) => g.name) },
            { k: "quantity", l: "Quantity", t: "num", req: true, min: 0.001 },
            { k: "unit", l: "Unit", t: "select", req: true, opts: ["Kg", "Pcs"] },
            { k: "note", l: "Note", t: "area", mic: true },
          ],
        },
        newLabel: "Record scrap",
        noDataLine: "No scrap on hand.",
      },
      rows,
    };
  },
  forms: {
    async new(ctx, h) {
      const godownId = await godownIdByName(text(h.godown));
      if (!godownId) return fieldErr("godown", "Choose the godown.");
      const cats = await refValues("scrapCategory");
      if (!cats.includes(h.category ?? "")) return fieldErr("category", "Choose a category.");
      return recordScrapEntry(actorOf(ctx), { date: text(h.date) ?? today(), category: h.category!, godownId, quantity: num(h.quantity) ?? 0, unit: h.unit === "Pcs" ? "Pcs" : "Kg", note: text(h.note) });
    },
  },
};

const scrapEntries: ScreenModule = {
  key: "scrapEntries",
  async load(ctx) {
    const rows = await db
      .select({ e: erpScrapEntries, godown: erpGodowns.name, by: users.name })
      .from(erpScrapEntries)
      .innerJoin(erpGodowns, eq(erpGodowns.id, erpScrapEntries.godownId))
      .leftJoin(users, eq(users.id, erpScrapEntries.createdById))
      .orderBy(sql`${erpScrapEntries.entryDate} desc`);
    return {
      spec: {
        screen: "scrapEntries",
        cols: [
          { k: "date", l: "Date", t: "d" },
          { k: "category", l: "Category", t: "b" },
          { k: "qty", l: "Quantity", t: "n" },
          { k: "unit", l: "Unit", t: "t" },
          { k: "godown", l: "Godown", t: "t" },
          { k: "status", l: "Status", t: "s" },
          { k: "by", l: "Recorded by", t: "t" },
        ],
        hidden: [],
        groups: ["category", "godown"],
        agg: { k: "qty", l: "recorded" },
        godownKey: "godown",
        noDataLine: "No scrap recorded yet.",
      },
      rows: rows.map((r) => ({
        id: r.e.id,
        v: { date: r.e.entryDate, category: r.e.category, qty: r.e.quantity, unit: r.e.unit, godown: r.godown, status: r.e.status === "active" ? "Recorded" : "Cancelled", by: r.by },
        flags: [],
        title: `${nf(r.e.quantity)} ${r.e.unit} of ${r.e.category}`,
        fields: [{ l: "Note", v: r.e.note ?? "—" }, ...(r.e.cancelReason ? [{ l: "Cancelled because", v: r.e.cancelReason }] : [])],
        actions: [{ id: "cancel", l: "Cancel entry", why: r.e.status !== "active" ? "Already cancelled" : why(ctx, "scrapApprove"), prompt: { title: "Cancel this scrap entry?", submit: "Cancel entry", fields: [reasonField()] } }],
        by: stampLine(r.by, r.e.createdAt),
      })),
    };
  },
  actions: {
    async cancel(ctx, id, v) {
      if (!can(ctx, "scrapApprove")) return refused("scrapApprove");
      return cancelScrapEntry(actorOf(ctx), id, v.reason ?? "");
    },
  },
};

/* ------------------------------------------------------------ scrap buyers */

const scrapBuyers: ScreenModule = {
  key: "scrapBuyers",
  async load(ctx) {
    const [buyers, sales, allocs] = await Promise.all([db.select().from(erpScrapBuyers).orderBy(asc(erpScrapBuyers.name)), saleRows(), allocationRows()]);
    const day = today();
    const form: FormSpec = {
      screen: "scrapBuyers",
      id: "new",
      title: "New scrap buyer",
      submit: "Add buyer",
      header: [
        { k: "name", l: "Name", t: "text", req: true },
        { k: "phone", l: "Phone", t: "text" },
        { k: "gstin", l: "GSTIN", t: "text" },
        { k: "address", l: "Address", t: "area" },
      ],
    };
    return {
      spec: {
        screen: "scrapBuyers",
        cols: [
          { k: "name", l: "Scrap buyer", t: "b" },
          { k: "phone", l: "Phone", t: "ph" },
          { k: "sales", l: "Sales", t: "n" },
          { k: "sold", l: "Sold", t: "m" },
          { k: "received", l: "Received", t: "m" },
          { k: "outstanding", l: "Outstanding", t: "m" },
          ...AGE_BUCKETS.map((b, i) => ({ k: `a${i}`, l: b, t: "m" as const })),
        ],
        hidden: [],
        agg: { k: "outstanding", l: "outstanding" },
        newForm: can(ctx, "scrapSale") || can(ctx, "scrapAccounts") ? form : undefined,
        newLabel: "New scrap buyer",
        noDataLine: "No scrap buyers yet.",
      },
      rows: buyers.map((b) => {
        const mine = sales.filter((s) => s.buyerId === b.id && s.status === "confirmed");
        const buckets = Object.fromEntries(AGE_BUCKETS.map((x) => [x, 0])) as Record<string, number>;
        for (const s of mine) if (s.outstandingPaise > 0) buckets[receivableBucket(s.dueDate, s.date, day)] += s.outstandingPaise;
        /* The ledger: each sale a debit, each match a credit, in date order, with the running balance. */
        const entries = [
          ...mine.map((s) => ({ at: s.date, text: `${scrapSaleLabel(s.saleNo)} · ${s.category} · ${nf(s.quantity)} ${s.unit}${s.dueDate ? ` · due ${fd(s.dueDate)}` : ""}`, debit: s.amountPaise, credit: 0 })),
          ...allocs.filter((a) => !a.voidedAt && mine.some((s) => s.id === a.saleId)).map((a) => ({ at: a.receiptDate, text: `${receiptLabel(a.receiptNo)} (${a.mode}) against ${scrapSaleLabel(a.saleNo)}`, debit: 0, credit: a.amountPaise })),
        ].sort((x, y) => x.at.localeCompare(y.at) || y.debit - x.debit);
        let bal = 0;
        const sold = mine.reduce((t, s) => t + s.amountPaise, 0);
        const received = mine.reduce((t, s) => t + s.matchedPaise, 0);
        const outstandingNow = mine.reduce((t, s) => t + s.outstandingPaise, 0);
        return {
          id: b.id,
          v: { name: b.name, phone: b.phone, sales: mine.length, sold, received, outstanding: outstandingNow, ...Object.fromEntries(AGE_BUCKETS.map((x, i) => [`a${i}`, buckets[x] || null])) },
          flags: b.active ? [] : ["inactive"],
          title: b.name,
          fields: [{ l: "GSTIN", v: b.gstin ?? "—" }, { l: "Address", v: b.address ?? "—" }],
          contacts: b.phone ? [{ l: "Call", href: `tel:${b.phone}` }] : [],
          actions: [b.active ? { id: "retire", l: "Retire", why: why(ctx, "scrapSale") } : { id: "restore", l: "Restore", why: why(ctx, "scrapSale") }],
          by: stampLine(null, b.createdAt),
          panel: {
            kind: "scrap",
            data: {
              figures: [
                { l: "Sold", v: inr(sold) },
                { l: "Received", v: inr(received), tone: "success" },
                { l: "Outstanding", v: inr(outstandingNow), tone: outstandingNow > 0 ? "danger" : "success" },
              ],
              sections: [
                {
                  title: "Ledger",
                  empty: "No sales yet.",
                  lines: entries.map((e) => {
                    bal += e.debit - e.credit;
                    return { text: `${e.debit ? "Debit " + inr(e.debit) : "Credit " + inr(e.credit)} · ${e.text}`, sub: `${fd(e.at)} · balance ${inr(bal)}`, tone: e.credit ? ("success" as const) : undefined };
                  }),
                },
              ],
            } satisfies ScrapPanel,
          },
        };
      }),
    };
  },
  forms: {
    async new(ctx, h) {
      if (!can(ctx, "scrapSale") && !can(ctx, "scrapAccounts")) return refused("scrapSale");
      const name = text(h.name);
      if (!name) return fieldErr("name", "Enter the buyer's name.");
      const [dup] = (await db.execute(sql`select id from erp_scrap_buyers where lower(name) = lower(${name})`)) as unknown as { id: string }[];
      if (dup) return fieldErr("name", "A scrap buyer of that name already exists.");
      const id = erpId("sbuy");
      await db.insert(erpScrapBuyers).values({ id, name, phone: text(h.phone), gstin: text(h.gstin)?.toUpperCase() ?? null, address: text(h.address), createdById: ctx.user.id });
      await erpAudit(ctx, "erp.scrapBuyer.create", "erp_scrap_buyer", id, null, { name });
      return okVoid(`${name} added`);
    },
  },
  actions: {
    async retire(ctx, id) {
      if (!can(ctx, "scrapSale")) return refused("scrapSale");
      await db.update(erpScrapBuyers).set({ active: false }).where(eq(erpScrapBuyers.id, id));
      await erpAudit(ctx, "erp.scrapBuyer.retire", "erp_scrap_buyer", id);
      return okVoid("Retired");
    },
    async restore(ctx, id) {
      if (!can(ctx, "scrapSale")) return refused("scrapSale");
      await db.update(erpScrapBuyers).set({ active: true }).where(eq(erpScrapBuyers.id, id));
      await erpAudit(ctx, "erp.scrapBuyer.restore", "erp_scrap_buyer", id);
      return okVoid("Restored");
    },
  },
};

/* ------------------------------------------------------------ Petty Cash/Bank receipts */

const cashReceipts: ScreenModule = {
  key: "cashReceipts",
  async load(ctx) {
    const [rows, buyers, sales, allocs] = await Promise.all([receiptRows(), buyerOptions(), saleRows(), allocationRows()]);
    const acc = can(ctx, "scrapAccounts");
    const form: FormSpec = {
      screen: "cashReceipts",
      id: "new",
      title: "Record a receipt",
      sub: "Money that came into petty cash or the bank from a scrap buyer. Match it to the sales it pays for once it is recorded.",
      submit: "Save receipt",
      init: { date: today(), mode: "Bank transfer" },
      header: [
        { k: "date", l: "Received on", t: "date", req: true },
        { k: "mode", l: "Mode", t: "select", req: true, opts: RECEIPT_MODES },
        { k: "amount", l: "Amount (₹)", t: "num", req: true, min: 0.01 },
        { k: "buyer", l: "Scrap buyer", t: "select", opts: buyers.map((b) => b.name), hint: "Leave empty if the bank line does not say who — name the payer instead." },
        { k: "payer", l: "Payer as on the bank line", t: "text" },
        { k: "reference", l: "UTR / cheque no. / slip", t: "text" },
        { k: "note", l: "Note", t: "area" },
      ],
    };
    return {
      spec: {
        screen: "cashReceipts",
        cols: [
          { k: "no", l: "Receipt", t: "mono" },
          { k: "date", l: "Received", t: "d" },
          { k: "from", l: "From", t: "b" },
          { k: "mode", l: "Mode", t: "s" },
          { k: "amount", l: "Amount", t: "m" },
          { k: "matched", l: "Matched", t: "m" },
          { k: "left", l: "Unmatched", t: "m" },
          { k: "reference", l: "Reference", t: "mono" },
          { k: "state", l: "State", t: "s" },
        ],
        hidden: [],
        groups: ["from", "mode", "state"],
        chips: "state",
        agg: { k: "left", l: "unmatched" },
        newForm: acc ? form : undefined,
        newLabel: "Record receipt",
        noDataLine: "No receipts recorded. A scrap buyer's payment is recorded here, then matched to the sales it pays for.",
      },
      rows: rows.map((r) => {
        const live = r.status === "active";
        const open = sales.filter((s) => s.status === "confirmed" && s.outstandingPaise > 0 && (!r.buyerId || s.buyerId === r.buyerId));
        const mine = allocs.filter((a) => a.receiptId === r.id);
        const liveMatches = mine.filter((a) => !a.voidedAt);
        const matchWhy = !live ? "This receipt is void" : r.leftPaise <= 0 ? "Fully matched" : !open.length ? "No outstanding scrap sale for this buyer" : why(ctx, "scrapAccounts");
        const plan = suggestAllocation(r.leftPaise, open.map((s) => ({ id: s.id, due: s.dueDate ?? s.date, outstandingPaise: s.outstandingPaise })));
        return {
          id: r.id,
          v: {
            no: receiptLabel(r.receiptNo),
            date: r.date,
            from: r.buyer ?? r.payer ?? "—",
            mode: r.mode,
            amount: r.amountPaise,
            matched: r.matchedPaise,
            left: r.leftPaise,
            reference: r.reference,
            state: !live ? "Void" : r.leftPaise <= 0 ? "Matched" : r.matchedPaise > 0 ? "Part matched" : "Not matched",
          },
          flags: live && r.leftPaise > 0 ? ["unmatched"] : [],
          title: `${receiptLabel(r.receiptNo)} · ${inr(r.amountPaise)} · ${r.buyer ?? r.payer ?? ""}`,
          fields: [{ l: "Note", v: r.note ?? "—" }],
          actions: [
            {
              id: "match",
              l: "Match to a sale",
              primary: true,
              why: matchWhy,
              prompt: {
                title: `Match ${receiptLabel(r.receiptNo)}`,
                sub: `${inr(r.leftPaise)} of it is not yet matched.`,
                submit: "Match",
                fields: [
                  { k: "sale", l: "Scrap sale", t: "select", req: true, opts: open.map((s) => `${scrapSaleLabel(s.saleNo)} · ${s.buyer} · ${inr(s.outstandingPaise)} outstanding`) },
                  { k: "amount", l: "Amount (₹)", t: "num", req: true, min: 0.01, max: r.leftPaise / 100 },
                ],
              },
            },
            {
              id: "auto",
              l: "Match oldest due first",
              why: matchWhy,
              confirm: plan.length ? `Match ${plan.map((p) => `${inr(p.amountPaise)} to ${scrapSaleLabel(open.find((s) => s.id === p.saleId)!.saleNo)}`).join(", ")}?` : undefined,
            },
            {
              id: "unmatch",
              l: "Undo a match",
              why: !liveMatches.length ? "Nothing matched" : why(ctx, "scrapAccounts"),
              prompt: {
                title: "Undo a match",
                sub: "The sale becomes outstanding again by that amount. The match is kept, marked undone.",
                submit: "Undo",
                fields: [{ k: "alloc", l: "Match", t: "select", req: true, opts: liveMatches.map((a) => `${scrapSaleLabel(a.saleNo)} · ${inr(a.amountPaise)}`) }, reasonField()],
              },
            },
            { id: "void", l: "Void receipt", why: !live ? "Already void" : liveMatches.length ? "Undo its matches first" : why(ctx, "scrapAccounts"), prompt: { title: `Void ${receiptLabel(r.receiptNo)}?`, sub: "For a receipt recorded in error. Kept, marked void.", submit: "Void", fields: [reasonField()] } },
          ],
          by: stampLine(r.by, r.createdAt),
          panel: {
            kind: "scrap",
            data: {
              figures: [
                { l: "Received", v: inr(r.amountPaise) },
                { l: "Matched", v: inr(r.matchedPaise), tone: "success" },
                { l: "Unmatched", v: inr(r.leftPaise), tone: r.leftPaise > 0 ? "danger" : undefined },
              ],
              sections: [
                {
                  title: "Matched to",
                  empty: "Not matched to any sale yet.",
                  lines: mine.map((a) => ({ text: `${inr(a.amountPaise)} → ${scrapSaleLabel(a.saleNo)}`, sub: a.voidedAt ? `Undone — ${a.voidReason}` : `by ${a.by ?? "—"} · ${new Date(a.at).toLocaleDateString("en-IN", { timeZone: APP_TIMEZONE })}`, tone: a.voidedAt ? ("muted" as const) : undefined })),
                },
              ],
            } satisfies ScrapPanel,
          },
        };
      }),
    };
  },
  forms: {
    async new(ctx, h) {
      if (!can(ctx, "scrapAccounts")) return refused("scrapAccounts");
      const buyer = (await buyerOptions()).find((b) => b.name === h.buyer);
      const amount = paise(h.amount);
      if (amount == null) return fieldErr("amount", "Enter the amount received.");
      const r = await recordReceipt(actorOf(ctx), { date: text(h.date) ?? today(), mode: h.mode ?? "", amountPaise: amount, buyerId: buyer?.id ?? null, payer: text(h.payer), reference: text(h.reference), note: text(h.note) });
      return r.ok ? okVoid(r.message) : r;
    },
  },
  actions: {
    async match(ctx, id, v) {
      if (!can(ctx, "scrapAccounts")) return refused("scrapAccounts");
      const no = Number(/^SCR-(\d+)/.exec(v.sale ?? "")?.[1]);
      const sale = (await saleRows()).find((s) => s.saleNo === no);
      if (!sale) return fieldErr("sale", "Choose the sale.");
      const amount = paise(v.amount);
      if (amount == null) return fieldErr("amount", "Enter the amount.");
      return allocateReceipt(actorOf(ctx), id, sale.id, amount);
    },
    async auto(ctx, id) {
      if (!can(ctx, "scrapAccounts")) return refused("scrapAccounts");
      const rc = (await receiptRows()).find((r) => r.id === id);
      if (!rc) return err("That receipt is gone.", "not_found");
      const open = (await saleRows()).filter((s) => s.status === "confirmed" && s.outstandingPaise > 0 && (!rc.buyerId || s.buyerId === rc.buyerId));
      const plan = suggestAllocation(rc.leftPaise, open.map((s) => ({ id: s.id, due: s.dueDate ?? s.date, outstandingPaise: s.outstandingPaise })));
      if (!plan.length) return err("Nothing to match.", "rule_violation");
      let n = 0;
      for (const p of plan) {
        const r = await allocateReceipt(actorOf(ctx), id, p.saleId, p.amountPaise);
        if (!r.ok) return n ? okVoid(`${n} matched; then: ${r.error}`) : r;
        n++;
      }
      return okVoid(`Matched to ${n} sale${n === 1 ? "" : "s"}, oldest due first`);
    },
    async unmatch(ctx, id, v) {
      if (!can(ctx, "scrapAccounts")) return refused("scrapAccounts");
      const live = (await allocationRows({ receiptId: id })).filter((a) => !a.voidedAt);
      const a = live.find((x) => `${scrapSaleLabel(x.saleNo)} · ${inr(x.amountPaise)}` === v.alloc);
      if (!a) return fieldErr("alloc", "Choose the match to undo.");
      return voidAllocation(actorOf(ctx), a.id, v.reason ?? "");
    },
    async void(ctx, id, v) {
      if (!can(ctx, "scrapAccounts")) return refused("scrapAccounts");
      return voidReceipt(actorOf(ctx), id, v.reason ?? "");
    },
  },
};

/* The lot behind a typed code, for screens that want to say what it is before saving. */
export async function describeLot(code: string): Promise<string> {
  const lot = await findDrumLot(code);
  if (!lot) return "Not a lot in the purchase register.";
  return lotRefusal(lot) ?? `${lot.material} from ${lot.supplier}, PR ${lot.prNumber} — ${lot.registered.length} of ${lot.drums ?? "?"} drums recorded empty.`;
}

export const SCRAP_SCREENS: ScreenModule[] = [
  emptyDrums,
  drumReturnable,
  drumReview,
  drumVariance,
  drumAdjustments,
  drumRegister,
  drumReturns,
  drumPending,
  scrapSales,
  scrapReceivables,
  scrapStockScreen,
  scrapEntries,
  scrapBuyers,
  cashReceipts,
];
