import "server-only";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  erpGodowns,
  erpInward,
  erpPurchases,
  erpRawMaterials,
  erpRequisitions,
  erpRmEntries,
  erpSuppliers,
  erpTests,
  products,
  users,
} from "@/db/schema";
import { err, fieldErr, okVoid, type Result } from "@/lib/result";
import type { ErpContext } from "../access";
import type { ErpPower } from "../powers";
import { refValues } from "../refs";
import {
  erpAudit,
  erpId,
  int,
  nextNumber,
  num,
  paise,
  rupeesField,
  stampLine,
  text,
  visibleCols,
  withoutHidden,
  type ScreenModule,
} from "../server";
import type { ActionSpec, ColSpec, FieldSpec, FormSpec, ListRow } from "../ui";
import { fd, inr, nf } from "../ui";
import {
  lotNumber,
  postsToStock,
  prBillLabel,
  purchaseFigures,
  settableStatuses,
  shortLabel,
} from "../engines/purchase";
import { rmItemStockAt, rmLots } from "../stock";
import { bindErpFiles } from "../attachments";

/* ---------------------------------------------------------------------------
 * Purchase (spec §5): requisitions, goods inward, testing, the purchase
 * register and the barcode export — and posting purchases to raw-material
 * stock (§6.2).
 * ------------------------------------------------------------------------- */

type Col = ColSpec & { pw?: ErpPower };
const has = (ctx: ErpContext) => (p: string) => ctx.powers.has(p as ErpPower);

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const REQ_TYPES = ["Chemical", "Can", "Box", "Stationary", "Finish Good"];
const INWARD_TYPES = ["Chemical", "Can", "Box"];
const REQ_STATUS = ["Pending", "Order Placed", "Booked", "Received"];

/** Unit a requisition is counted in, by material type (spec §5.2). */
function reqUnit(type: string): string {
  if (type === "Chemical") return "Liter";
  if (type === "Finish Good") return "Box";
  return "Pcs";
}

/** Godowns a form may offer: active, and Item Lost Record only with the power. */
async function godownOptions(ctx: ErpContext): Promise<{ id: string; name: string }[]> {
  const rows = await db
    .select({ id: erpGodowns.id, name: erpGodowns.name, reserved: erpGodowns.reserved })
    .from(erpGodowns)
    .where(eq(erpGodowns.status, "active"))
    .orderBy(asc(erpGodowns.name));
  return rows.filter((g) => !g.reserved || ctx.powers.has("lostStock"));
}

async function godownIdByName(name: string | null): Promise<string | null> {
  if (!name) return null;
  const [g] = await db.select({ id: erpGodowns.id }).from(erpGodowns).where(eq(erpGodowns.name, name));
  return g?.id ?? null;
}

async function materials() {
  return db.select().from(erpRawMaterials).where(eq(erpRawMaterials.active, true)).orderBy(asc(erpRawMaterials.name));
}

function itemsByType(mats: { name: string; materialType: string }[], types: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const t of types) out[t] = mats.filter((m) => m.materialType === t).map((m) => m.name);
  return out;
}

/* =============================================================== postings */

/**
 * Posts (or re-syncs) a purchase's entry in the raw-material log: one entry
 * per purchase, quantity = its available litres, at its godown under its lot.
 * Only a purchase with a rate above zero posts; once posted, the entry follows
 * the purchase through every edit, because the source reads it as a live
 * formula on the purchase (spec §6.1).
 */
async function syncPurchaseEntry(tx: Tx, purchaseId: string): Promise<boolean> {
  const [p] = await tx.select().from(erpPurchases).where(eq(erpPurchases.id, purchaseId));
  if (!p) return false;
  const [existing] = await tx
    .select({ id: erpRmEntries.id })
    .from(erpRmEntries)
    .where(and(eq(erpRmEntries.sourceType, "purchase"), eq(erpRmEntries.sourceId, purchaseId)));
  if (!existing && !postsToStock(p.ratePaise)) return false;
  const values = {
    entryDate: p.purchaseDate,
    rawMaterialId: p.rawMaterialId,
    lotNo: p.lotNo,
    godownId: p.godownId,
    quantity: p.availableLitres,
  };
  if (existing) {
    await tx.update(erpRmEntries).set(values).where(eq(erpRmEntries.id, existing.id));
  } else {
    await tx.insert(erpRmEntries).values({ id: erpId("rme"), sourceType: "purchase", sourceId: purchaseId, ...values });
  }
  return true;
}

/**
 * Creates a register row (from an inward line, a verified test, or by hand).
 * The lot number must be new: the source's own message says what to do when it
 * is not.
 */
async function createPurchase(
  tx: Tx,
  ctx: ErpContext,
  v: {
    prNumber: number;
    purchaseDate: string;
    supplierId: string;
    rawMaterialId: string;
    quantity: number;
    unit: string;
    godownId: string;
    drums?: number | null;
    weightWithDrum?: number | null;
    density?: number | null;
    remark?: string | null;
    source: "inward" | "test" | "manual";
    inwardId?: string | null;
    testId?: string | null;
    ratePaise?: number | null;
    poNumber?: string | null;
    feedAdjustedLitre?: number;
    feedAdjustedAmountPaise?: number;
    gstBp?: number;
    company?: string;
    billNumber?: string | null;
    notes?: string | null;
  },
): Promise<Result<{ id: string; lotNo: string }>> {
  const [sup] = await tx.select().from(erpSuppliers).where(eq(erpSuppliers.id, v.supplierId));
  const [mat] = await tx.select().from(erpRawMaterials).where(eq(erpRawMaterials.id, v.rawMaterialId));
  if (!sup || !mat) return err("The supplier or the item no longer exists.", "not_found");
  const lotNo = lotNumber(sup.partyCode, mat.code, v.prNumber);
  const [clash] = await tx.select({ id: erpPurchases.id }).from(erpPurchases).where(eq(erpPurchases.lotNo, lotNo));
  if (clash) return fieldErr("prNumber", "! Please Change 4 Digit PR Num Manually or Generate New PR Num!");
  const unit = v.unit === "Kg" || v.unit === "Litre" || v.unit === "Pcs" ? v.unit : mat.unit === "Kg" ? "Kg" : mat.unit === "Litre" ? "Litre" : "Pcs";
  const density = v.density ?? mat.density ?? null;
  const fig = purchaseFigures({
    quantity: v.quantity,
    unit,
    ratePaise: v.ratePaise ?? null,
    density,
    feedAdjustedLitre: v.feedAdjustedLitre ?? 0,
    feedAdjustedAmountPaise: v.feedAdjustedAmountPaise ?? 0,
    gstBp: v.gstBp ?? 1800,
    drums: v.drums ?? null,
  });
  const id = v.source === "inward" && v.inwardId ? v.inwardId : v.source === "test" && v.testId ? v.testId : erpId("prb");
  await tx.insert(erpPurchases).values({
    id,
    prNumber: v.prNumber,
    purchaseDate: v.purchaseDate,
    poNumber: v.poNumber ?? null,
    supplierId: v.supplierId,
    rawMaterialId: v.rawMaterialId,
    lotNo,
    quantity: v.quantity,
    unit,
    ratePaise: v.ratePaise ?? null,
    density,
    drums: v.drums ?? null,
    weightWithDrum: v.weightWithDrum ?? null,
    feedAdjustedLitre: v.feedAdjustedLitre ?? 0,
    feedAdjustedAmountPaise: v.feedAdjustedAmountPaise ?? 0,
    gstBp: v.gstBp ?? 1800,
    availableLitres: fig.availableLitres,
    company: v.company ?? "Mahek Marketing India",
    billNumber: v.billNumber ?? null,
    notes: v.notes ?? null,
    remark: v.remark ?? null,
    godownId: v.godownId,
    testId: v.testId ?? null,
    inwardId: v.inwardId ?? null,
    source: v.source,
    createdById: ctx.user.id,
    updatedById: ctx.user.id,
  });
  await syncPurchaseEntry(tx, id);
  return { ok: true, data: { id, lotNo } };
}

/* ========================================================= requisitions */

async function requisitionForm(ctx: ErpContext, init?: Record<string, string>): Promise<FormSpec> {
  const [mats, gds, skus] = await Promise.all([
    materials(),
    godownOptions(ctx),
    db.select({ name: products.name }).from(products).where(eq(products.active, true)).orderBy(asc(products.name)),
  ]);
  const map = itemsByType(mats, REQ_TYPES);
  map["Finish Good"] = skus.map((s) => s.name);
  return {
    screen: "requisitions",
    id: "new",
    title: "New purchase requisition",
    sub: "Tell purchase what your godown needs.",
    submit: "Raise requisition",
    init: { date: new Date().toISOString().slice(0, 10), godown: ctx.workingGodown?.name ?? "", priority: "Medium", ...init },
    header: [
      { k: "date", l: "Date", t: "date", req: true },
      { k: "godown", l: "Godown", t: "select", req: true, opts: gds.map((g) => g.name) },
      { k: "type", l: "Material type", t: "select", req: true, opts: REQ_TYPES },
      { k: "item", l: "Item", t: "select", req: true, optsBy: { by: "type", map }, when: { k: "type", notEmpty: true } },
      { k: "unit", l: "Unit", t: "derived", calc: "requisitions.unit" },
      { k: "required", l: "Required quantity", t: "num", req: true, min: 0.001 },
      { k: "priority", l: "Priority", t: "select", req: true, opts: ["Urgent", "Medium", "For Stock"] },
      { k: "remarks", l: "Remarks", t: "area", mic: true },
    ],
  };
}

const requisitions: ScreenModule = {
  key: "requisitions",
  async load(ctx) {
    const rows = await db
      .select({
        r: erpRequisitions,
        godown: erpGodowns.name,
        item: sql<string>`coalesce(${erpRawMaterials.name}, ${products.name})`,
        by: users.name,
      })
      .from(erpRequisitions)
      .innerJoin(erpGodowns, eq(erpGodowns.id, erpRequisitions.godownId))
      .leftJoin(erpRawMaterials, eq(erpRawMaterials.id, erpRequisitions.rawMaterialId))
      .leftJoin(products, eq(products.id, erpRequisitions.productId))
      .leftJoin(users, eq(users.id, erpRequisitions.createdById))
      .orderBy(desc(erpRequisitions.reqDate), desc(erpRequisitions.createdAt));
    const levels = await levelsPresent();
    const form = await requisitionForm(ctx);
    const cols: ColSpec[] = [
      { k: "date", l: "Date", t: "d" },
      { k: "godown", l: "Godown", t: "t" },
      { k: "type", l: "Material type", t: "s" },
      { k: "item", l: "Item", t: "b" },
      { k: "present", l: "Present qty", t: "n" },
      { k: "unit", l: "Unit", t: "t" },
      { k: "required", l: "Required", t: "n" },
      { k: "priority", l: "Priority", t: "s" },
      { k: "status", l: "Status", t: "s" },
      { k: "remarks", l: "Remarks", t: "t" },
    ];
    const out: ListRow[] = [];
    for (const x of rows) {
      const present = await presentQuantity(x.r, levels);
      out.push({
        id: x.r.id,
        v: {
          date: x.r.reqDate,
          godown: x.godown,
          type: x.r.materialType,
          item: x.item,
          present,
          unit: x.r.unit,
          required: x.r.requiredQty,
          priority: x.r.priority,
          status: x.r.status,
          remarks: x.r.remarks,
        },
        flags: x.r.status === "Order Placed" ? ["orderPlaced"] : x.r.status === "Booked" ? ["booked"] : [],
        title: x.item,
        header: `${nf(x.r.requiredQty)} ${x.r.unit} · ${x.godown}`,
        actions: [
          {
            id: "status",
            l: "Change status",
            primary: true,
            prompt: {
              title: "Change status",
              sub: `${x.item} · ${nf(x.r.requiredQty)} ${x.r.unit}`,
              submit: "Save status",
              fields: [{ k: "status", l: "Status", t: "select", req: true, opts: REQ_STATUS }],
              init: { status: x.r.status },
            },
          },
        ],
        by: stampLine(x.by, x.r.createdAt),
      });
    }
    return {
      spec: {
        screen: "requisitions",
        cols,
        hidden: [],
        groups: ["status"],
        chips: "priority",
        godownKey: "godown",
        newForm: form,
        newLabel: "New requisition",
        noDataLine: "No purchase requisitions yet.",
      },
      rows: out,
    };
  },
  forms: {
    async new(ctx, h) {
      const godownId = await godownIdByName(text(h.godown));
      if (!godownId) return fieldErr("godown", "Godown is required");
      const type = text(h.type);
      if (!type || !REQ_TYPES.includes(type)) return fieldErr("type", "Material type is required");
      const item = text(h.item);
      if (!item) return fieldErr("item", "Item is required");
      const qty = num(h.required);
      if (qty == null || qty <= 0) return fieldErr("required", qty != null && qty < 0 ? "Minus Quantity Not Allowed" : "Required quantity is required");
      const priority = text(h.priority) ?? "Medium";
      let rawMaterialId: string | null = null;
      let productId: string | null = null;
      if (type === "Finish Good") {
        const [p] = await db.select({ id: products.id }).from(products).where(eq(products.name, item));
        if (!p) return fieldErr("item", "Pick a product from the list");
        productId = p.id;
      } else {
        const [m] = await db
          .select({ id: erpRawMaterials.id })
          .from(erpRawMaterials)
          .where(and(eq(erpRawMaterials.name, item), eq(erpRawMaterials.materialType, type)));
        if (!m) return fieldErr("item", "Pick an item of this material type");
        rawMaterialId = m.id;
      }
      const id = erpId("req");
      await db.insert(erpRequisitions).values({
        id,
        reqDate: text(h.date) ?? new Date().toISOString().slice(0, 10),
        godownId,
        materialType: type,
        rawMaterialId,
        productId,
        unit: reqUnit(type),
        requiredQty: qty,
        priority,
        remarks: text(h.remarks),
        createdById: ctx.user.id,
        updatedById: ctx.user.id,
      });
      await erpAudit(ctx, "erp.requisition.create", "erp_requisition", id, null, { item, qty, priority });
      return okVoid(`Requisition raised · ${item} · ${nf(qty)} ${reqUnit(type)}`);
    },
  },
  actions: {
    async status(ctx, id, values) {
      const status = text(values.status);
      if (!status || !REQ_STATUS.includes(status)) return fieldErr("status", "Status is required");
      const [before] = await db.select({ status: erpRequisitions.status }).from(erpRequisitions).where(eq(erpRequisitions.id, id));
      if (!before) return err("That requisition no longer exists.", "not_found");
      await db.update(erpRequisitions).set({ status, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpRequisitions.id, id));
      await erpAudit(ctx, "erp.requisition.status", "erp_requisition", id, before, { status });
      return okVoid(`Requisition is ${status}`);
    },
  },
};

/** Whether the re-order levels table exists yet (phase 3) — present quantity reads it. */
async function levelsPresent(): Promise<boolean> {
  const r = (await db.execute(sql`select to_regclass('public.erp_rm_levels') is not null as ok`)) as unknown as { ok: boolean }[];
  return !!r[0]?.ok;
}

/**
 * A requisition's present quantity (spec §5.2): the godown's stock of the item,
 * read only where a re-order level is set there — the source reads it off the
 * levels, so a godown with no level says so rather than a figure (§14 A-04).
 */
async function presentQuantity(r: typeof erpRequisitions.$inferSelect, levels: boolean): Promise<string | number> {
  if (!r.rawMaterialId) return "—";
  if (!levels) return "no level set";
  const rows = (await db.execute(
    sql`select 1 from erp_rm_levels where raw_material_id = ${r.rawMaterialId} and godown_id = ${r.godownId} limit 1`,
  )) as unknown as unknown[];
  if (!rows.length) return "no level set";
  return rmItemStockAt(r.rawMaterialId, r.godownId);
}

/* ============================================================== inward */

async function inwardForm(ctx: ErpContext, init?: Record<string, string>): Promise<FormSpec> {
  const [mats, gds, sups] = await Promise.all([
    materials(),
    godownOptions(ctx),
    db.select({ name: erpSuppliers.name }).from(erpSuppliers).where(eq(erpSuppliers.active, true)).orderBy(asc(erpSuppliers.name)),
  ]);
  const unitOf: Record<string, string> = {};
  const testsOf: Record<string, string[]> = {};
  mats.forEach((m) => {
    unitOf[m.name] = m.materialType === "Box" ? "Pcs" : m.unit;
    testsOf[m.name] = m.testingList;
  });
  return {
    screen: "inward",
    id: "new",
    title: "Purchase inward",
    sub: "One PR, one line per item that arrived. Add more copies the PR onto a new line.",
    submit: "Save inward",
    lineLabel: "Item",
    init: {
      date: new Date().toISOString().slice(0, 10),
      godown: ctx.workingGodown?.name ?? "",
      ...init,
    },
    data: { unitOf, testsOf },
    header: [
      { k: "pr", l: "PR number", t: "derived", calc: "inward.pr" },
      { k: "date", l: "Date", t: "date", req: true },
      { k: "supplier", l: "Supplier", t: "select", req: true, opts: sups.map((s) => s.name) },
      { k: "godown", l: "Godown", t: "select", req: true, opts: gds.map((g) => g.name) },
    ],
    line: [
      { k: "type", l: "Material type", t: "select", req: true, opts: INWARD_TYPES },
      { k: "item", l: "Item", t: "select", req: true, optsBy: { by: "type", map: itemsByType(mats, INWARD_TYPES) }, when: { k: "type", notEmpty: true } },
      { k: "drums", l: "Drums", t: "num", req: true, min: 0, when: { k: "type", eq: "Chemical" } },
      { k: "weight", l: "Weight with drum (kg)", t: "num", min: 0, when: { k: "type", eq: "Chemical" } },
      { k: "qty", l: "Quantity", t: "num", req: true, min: 0.001 },
      { k: "unit", l: "Unit", t: "derived", calc: "inward.unit" },
      { k: "testing", l: "Testing required", t: "derived", calc: "inward.testing" },
      { k: "remark", l: "Remark", t: "area", mic: true },
    ],
  };
}

const inward: ScreenModule = {
  key: "inward",
  async load(ctx) {
    const rows = await db
      .select({ r: erpInward, supplier: erpSuppliers.name, item: erpRawMaterials.name, godown: erpGodowns.name, by: users.name })
      .from(erpInward)
      .innerJoin(erpSuppliers, eq(erpSuppliers.id, erpInward.supplierId))
      .innerJoin(erpRawMaterials, eq(erpRawMaterials.id, erpInward.rawMaterialId))
      .innerJoin(erpGodowns, eq(erpGodowns.id, erpInward.godownId))
      .leftJoin(users, eq(users.id, erpInward.createdById))
      .orderBy(desc(erpInward.prNumber), asc(erpInward.createdAt));
    const form = await inwardForm(ctx);
    const cols: ColSpec[] = [
      { k: "pr", l: "PR no", t: "mono" },
      { k: "date", l: "Date", t: "d" },
      { k: "supplier", l: "Supplier", t: "t" },
      { k: "type", l: "Material type", t: "s" },
      { k: "item", l: "Item", t: "b" },
      { k: "drums", l: "Drums", t: "n" },
      { k: "weight", l: "Weight with drum", t: "n" },
      { k: "qty", l: "Quantity", t: "n" },
      { k: "unit", l: "Unit", t: "t" },
      { k: "godown", l: "Godown", t: "t" },
      { k: "testing", l: "Testing required", t: "s" },
      { k: "routed", l: "Sent to", t: "s" },
      { k: "f", l: "Flags", t: "f" },
    ];
    return {
      spec: {
        screen: "inward",
        cols,
        hidden: [],
        groups: ["pr"],
        groupSel: true,
        agg: { k: "qty", l: "total quantity" },
        godownKey: "godown",
        newForm: form,
        newLabel: "New inward",
        noDataLine: "No goods inward yet.",
      },
      rows: rows.map((x) => {
        const actions: ActionSpec[] = [];
        if (!x.r.routed && x.r.testingRequired)
          actions.push({ id: "toTesting", l: "Send to Testing", primary: true });
        if (!x.r.routed && !x.r.testingRequired)
          actions.push({ id: "toPurchase", l: "Send to Purchase", primary: true });
        actions.push({
          id: "addMore",
          l: "Add more",
          form: { ...form, init: { ...form.init, pr: String(x.r.prNumber), prFixed: String(x.r.prNumber), date: x.r.receivedDate, supplier: x.supplier, godown: x.godown } },
        });
        return {
          id: x.r.id,
          v: {
            pr: String(x.r.prNumber),
            date: x.r.receivedDate,
            supplier: x.supplier,
            type: x.r.materialType,
            item: x.item,
            drums: x.r.drums,
            weight: x.r.weightWithDrum,
            qty: x.r.quantity,
            unit: x.r.unit,
            godown: x.godown,
            testing: x.r.testingRequired ? "Yes" : "No",
            routed: x.r.routed,
          },
          flags: x.r.routed ? [] : ["awaitingRoute"],
          title: x.item,
          header: [x.r.drums ? `${x.r.drums} drums` : "", x.item, `${nf(x.r.quantity)} ${x.r.unit}`].filter(Boolean).join(" · "),
          fields: [{ l: "Remark", v: x.r.remark || "—" }],
          actions,
          by: stampLine(x.by, x.r.createdAt),
        };
      }),
    };
  },
  forms: {
    async new(ctx, h, lines) {
      const supplier = text(h.supplier);
      const [sup] = supplier ? await db.select().from(erpSuppliers).where(eq(erpSuppliers.name, supplier)) : [];
      if (!sup) return fieldErr("supplier", "Supplier is required");
      const godownId = await godownIdByName(text(h.godown));
      if (!godownId) return fieldErr("godown", "Godown is required");
      if (!lines.length) return err("Add at least one item.");
      const mats = await materials();
      const parsed: { l: Record<string, string>; m: (typeof mats)[number]; qty: number }[] = [];
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        const m = mats.find((x) => x.name === l.item && x.materialType === l.type);
        if (!m) return fieldErr(`l${i}.item`, "Pick an item of this material type");
        const qty = num(l.qty);
        if (qty == null || qty <= 0) return fieldErr(`l${i}.qty`, qty != null && qty < 0 ? "Minus Quantity Not Allowed" : "Quantity is required");
        if (l.type === "Chemical" && (int(l.drums) == null || int(l.drums)! < 0)) return fieldErr(`l${i}.drums`, "Drums is required");
        parsed.push({ l, m, qty });
      }
      /* "Add more" on a PR keeps its number; a new inward draws the next one. */
      const fixed = int(h.prFixed);
      let pr = 0;
      await db.transaction(async (tx) => {
        pr = fixed ?? (await nextNumber(tx, "pr"));
        for (const { l, m, qty } of parsed) {
          await tx.insert(erpInward).values({
            id: erpId("pin"),
            prNumber: pr,
            receivedDate: text(h.date) ?? new Date().toISOString().slice(0, 10),
            supplierId: sup.id,
            godownId,
            materialType: m.materialType,
            rawMaterialId: m.id,
            drums: m.materialType === "Chemical" ? int(l.drums) : null,
            weightWithDrum: m.materialType === "Chemical" ? num(l.weight) : null,
            quantity: qty,
            unit: m.materialType === "Box" ? "Pcs" : m.unit,
            remark: text(l.remark),
            testingRequired: m.testingList.length > 0,
            createdById: ctx.user.id,
            updatedById: ctx.user.id,
          });
        }
      });
      await erpAudit(ctx, "erp.inward.create", "erp_inward", String(pr), null, { lines: parsed.length, supplier });
      return okVoid(`PR ${pr} · ${parsed.length} line${parsed.length > 1 ? "s" : ""} saved. Route each to testing or the register.`);
    },
  },
  actions: {
    /* Routing a line is claimed in the same statement that checks it has not
       been routed, so two people pressing at once route it once. */
    async toTesting(ctx, id) {
      const res = await db.transaction(async (tx) => {
        const claimed = await tx
          .update(erpInward)
          .set({ routed: "Testing", routedAt: new Date(), routedById: ctx.user.id })
          .where(and(eq(erpInward.id, id), isNull(erpInward.routed), eq(erpInward.testingRequired, true)))
          .returning();
        if (!claimed.length) return err("This line has already been sent, or does not need testing.", "conflict");
        return okVoid(`PR ${claimed[0].prNumber} sent to testing`);
      });
      if (res.ok) await erpAudit(ctx, "erp.inward.toTesting", "erp_inward", id);
      return res;
    },
    async toPurchase(ctx, id) {
      const res = await db.transaction(async (tx): Promise<Result<unknown>> => {
        const claimed = await tx
          .update(erpInward)
          .set({ routed: "Purchase", routedAt: new Date(), routedById: ctx.user.id })
          .where(and(eq(erpInward.id, id), isNull(erpInward.routed), eq(erpInward.testingRequired, false)))
          .returning();
        if (!claimed.length) return err("This line has already been sent, or needs testing first.", "conflict");
        const r = claimed[0];
        const made = await createPurchase(tx, ctx, {
          prNumber: r.prNumber,
          purchaseDate: r.receivedDate,
          supplierId: r.supplierId,
          rawMaterialId: r.rawMaterialId,
          quantity: r.quantity,
          unit: r.unit === "Unit" ? "Pcs" : r.unit,
          godownId: r.godownId,
          drums: r.drums,
          remark: r.remark,
          source: "inward",
          inwardId: r.id,
        });
        if (!made.ok) {
          tx.rollback();
          return made;
        }
        return okVoid("Sent to the purchase register · it posts to stock once a rate is entered");
      }).catch((e: unknown) => (e instanceof Error && e.message === "Rollback" ? null : Promise.reject(e)));
      if (!res) return err("! Please Change 4 Digit PR Num Manually or Generate New PR Num!", "conflict");
      if (res.ok) await erpAudit(ctx, "erp.inward.toPurchase", "erp_inward", id);
      return res;
    },
  },
};

/* ============================================================== testing */

const TEST_FIELDS: { test: string; field: FieldSpec }[] = [
  { test: "PH", field: { k: "ph", l: "pH photo", t: "photo", req: true } },
  { test: "PH", field: { k: "phValue", l: "PH Value", t: "num", hint: "Read from the pH photo when AI is on — confirm it." } },
  { test: "Smell", field: { k: "smell", l: "Smell", t: "select", req: true, opts: ["Good", "Moderate", "Bad"] } },
  { test: "Color", field: { k: "color", l: "Colour photo", t: "photo", req: true } },
  { test: "Oil Paint", field: { k: "oil", l: "Oil-paint photo", t: "photo", req: true } },
  { test: "Fast Paints", field: { k: "fast", l: "Fast-paint photo", t: "photo", req: true } },
  { test: "Nc Paints", field: { k: "nc", l: "NC-paint photo", t: "photo", req: true } },
  { test: "Primer", field: { k: "primer", l: "Primer photo", t: "photo", req: true } },
  { test: "Density", field: { k: "density", l: "Density value", t: "num", req: true, min: 0.5, max: 1.5 } },
  { test: "Density", field: { k: "densityPhoto", l: "Density photo", t: "photo", req: true } },
  { test: "Tharmakol Pass", field: { k: "thermocol", l: "Thermocol-pass photo", t: "photo", req: true } },
];

const PHOTO_COL: Record<string, keyof typeof erpTests.$inferInsert> = {
  ph: "phPhotoId",
  color: "colorPhotoId",
  oil: "oilPhotoId",
  fast: "fastPhotoId",
  nc: "ncPhotoId",
  primer: "primerPhotoId",
  densityPhoto: "densityPhotoId",
  thermocol: "thermocolPhotoId",
  video: "videoId",
};

async function testForm(ctx: ErpContext, testId?: string): Promise<FormSpec | null> {
  const testers = await db.select({ name: users.name }).from(users).where(eq(users.active, true)).orderBy(asc(users.name));
  const gds = await godownOptions(ctx);
  const evidence = (on: string) =>
    TEST_FIELDS.map(({ test, field }) => ({ ...field, when: { k: on, map: "testsOf", has: test } }) as FieldSpec);

  if (testId) {
    const [t] = await db
      .select({ t: erpTests, item: erpRawMaterials.name, tester: users.name })
      .from(erpTests)
      .innerJoin(erpRawMaterials, eq(erpRawMaterials.id, erpTests.rawMaterialId))
      .leftJoin(users, eq(users.id, erpTests.testerId))
      .where(eq(erpTests.id, testId));
    if (!t) return null;
    const line = `PR ${t.t.prNumber} · ${t.item}`;
    return {
      screen: "testing",
      id: "edit",
      recordId: testId,
      title: "Record test evidence",
      sub: `${line} · only the evidence this item's tests need is asked for.`,
      submit: "Save test",
      data: { testsOf: { [line]: t.t.tests } },
      init: {
        line,
        smell: t.t.smell ?? "",
        density: t.t.density == null ? "" : String(t.t.density),
        phValue: t.t.phValue == null ? "" : String(t.t.phValue),
        ph: t.t.phPhotoId ?? "",
        color: t.t.colorPhotoId ?? "",
        oil: t.t.oilPhotoId ?? "",
        fast: t.t.fastPhotoId ?? "",
        nc: t.t.ncPhotoId ?? "",
        primer: t.t.primerPhotoId ?? "",
        densityPhoto: t.t.densityPhotoId ?? "",
        thermocol: t.t.thermocolPhotoId ?? "",
        video: t.t.videoId ?? "",
        tester: t.tester ?? ctx.user.name,
        date: t.t.testingDate,
        remark: t.t.remark ?? "",
      },
      header: [
        { k: "line", l: "Inward line", t: "text", readOnly: true },
        { k: "tests", l: "Tests required", t: "derived", calc: "testing.tests" },
        ...evidence("line"),
        { k: "video", l: "Test video", t: "video" },
        { k: "tester", l: "Tester", t: "select", req: true, opts: testers.map((u) => u.name) },
        { k: "date", l: "Testing date", t: "date", req: true },
        { k: "remark", l: "Remark", t: "area", mic: true },
      ],
    };
  }

  /* A new test is for an inward line sent to testing and not yet tested. */
  const lines = await db
    .select({ id: erpInward.id, pr: erpInward.prNumber, item: erpRawMaterials.name, tests: erpRawMaterials.testingList })
    .from(erpInward)
    .innerJoin(erpRawMaterials, eq(erpRawMaterials.id, erpInward.rawMaterialId))
    .where(and(eq(erpInward.routed, "Testing"), sql`not exists (select 1 from erp_tests t where t.inward_id = ${erpInward.id})`))
    .orderBy(desc(erpInward.prNumber));
  const testsOf: Record<string, string[]> = {};
  const lineId: Record<string, string> = {};
  lines.forEach((l) => {
    const label = `PR ${l.pr} · ${l.item}`;
    testsOf[label] = l.tests;
    lineId[label] = l.id;
  });
  return {
    screen: "testing",
    id: "new",
    title: "Record a purchase test",
    sub: "Only the evidence the item's tests need is asked for.",
    submit: "Save test",
    data: { testsOf, lineId },
    init: { tester: ctx.user.name, date: new Date().toISOString().slice(0, 10), godown: ctx.workingGodown?.name ?? "" },
    header: [
      { k: "line", l: "Inward line", t: "select", req: true, opts: Object.keys(testsOf), hint: lines.length ? undefined : "No inward line is waiting for a test. Send one to testing from Purchase inward." },
      { k: "tests", l: "Tests required", t: "derived", calc: "testing.tests" },
      ...evidence("line"),
      { k: "video", l: "Test video", t: "video", when: { k: "line", notEmpty: true } },
      { k: "tester", l: "Tester", t: "select", req: true, opts: testers.map((u) => u.name) },
      { k: "date", l: "Testing date", t: "date", req: true },
      { k: "godown", l: "Godown", t: "select", req: true, opts: gds.map((g) => g.name) },
      { k: "remark", l: "Remark", t: "area", mic: true },
    ],
  };
}

/** Evidence a test still lacks for the tests its item needs. */
function missingEvidence(t: typeof erpTests.$inferSelect): string[] {
  const miss: string[] = [];
  for (const test of t.tests) {
    if (test === "PH" && !t.phPhotoId) miss.push("pH photo");
    if (test === "Smell" && !t.smell) miss.push("smell");
    if (test === "Color" && !t.colorPhotoId) miss.push("colour photo");
    if (test === "Oil Paint" && !t.oilPhotoId) miss.push("oil-paint photo");
    if (test === "Fast Paints" && !t.fastPhotoId) miss.push("fast-paint photo");
    if (test === "Nc Paints" && !t.ncPhotoId) miss.push("NC-paint photo");
    if (test === "Primer" && !t.primerPhotoId) miss.push("primer photo");
    if (test === "Density" && (t.density == null || !t.densityPhotoId)) miss.push("density and its photo");
    if (test === "Tharmakol Pass" && !t.thermocolPhotoId) miss.push("thermocol-pass photo");
  }
  return miss;
}

const testing: ScreenModule = {
  key: "testing",
  async load(ctx) {
    const rows = await db
      .select({ t: erpTests, item: erpRawMaterials.name, godown: erpGodowns.name, tester: users.name, supplier: erpSuppliers.name })
      .from(erpTests)
      .innerJoin(erpRawMaterials, eq(erpRawMaterials.id, erpTests.rawMaterialId))
      .innerJoin(erpGodowns, eq(erpGodowns.id, erpTests.godownId))
      .leftJoin(users, eq(users.id, erpTests.testerId))
      .leftJoin(erpSuppliers, eq(erpSuppliers.id, erpTests.supplierId))
      .orderBy(desc(erpTests.testingDate), desc(erpTests.prNumber));
    const withRegister = new Set(
      (await db.select({ testId: erpPurchases.testId }).from(erpPurchases).where(sql`${erpPurchases.testId} is not null`)).map((x) => x.testId!),
    );
    const newForm = await testForm(ctx);
    const verifier = ctx.powers.has("verifyTest");
    const why = verifier ? "" : "Only the verifier decides a purchase test";
    const cols: ColSpec[] = [
      { k: "status", l: "Verification", t: "s" },
      { k: "date", l: "Date", t: "d" },
      { k: "pr", l: "PR no", t: "mono" },
      { k: "item", l: "Item", t: "b" },
      { k: "tests", l: "Tests required", t: "t" },
      { k: "smell", l: "Smell", t: "s" },
      { k: "density", l: "Density", t: "n" },
      { k: "tester", l: "Tester", t: "t" },
      { k: "godown", l: "Godown", t: "t" },
    ];
    return {
      spec: {
        screen: "testing",
        cols,
        hidden: [],
        groups: ["status"],
        chips: "status",
        godownKey: "godown",
        newForm: newForm ?? undefined,
        newLabel: "Record a test",
        noDataLine: "No purchase tests yet. Send a chemical's inward line to testing first.",
      },
      rows: rows.map((x) => {
        const reg = withRegister.has(x.t.id);
        const miss = missingEvidence(x.t);
        /* Stored "Not Verified" is also the default before anybody decides;
           an undecided test reads as waiting, never as rejected. */
        const shown = x.t.decidedAt ? x.t.status : "Pending";
        const actions: ActionSpec[] = [];
        if (x.t.status !== "Verified")
          actions.push({
            id: "verify",
            l: "Do Verify",
            primary: true,
            why: why || (miss.length ? `Evidence missing: ${miss.join(", ")}` : ""),
          });
        if (shown !== "Not Verified" || reg)
          actions.push({
            id: "unverify",
            l: "Do Not Verified",
            why,
            confirm: reg
              ? `A purchase register row already exists for this lot. Marking it Not Verified leaves that row in place — remove it from the register separately.`
              : `Mark ${x.item} (PR ${x.t.prNumber}) Not Verified?`,
          });
        if (x.t.status !== "Verified") actions.push({ id: "edit", l: "Record evidence", loadsForm: true });
        actions.push({ id: "addLot", l: "ADD More Lot", loadsForm: true });
        return {
          id: x.t.id,
          v: {
            status: shown,
            date: x.t.testingDate,
            pr: String(x.t.prNumber),
            item: x.item,
            tests: x.t.tests.join(", ") || "—",
            smell: x.t.smell,
            density: x.t.density,
            tester: x.tester,
            godown: x.godown,
          },
          flags: [],
          title: x.item,
          header: `PR ${x.t.prNumber}${x.supplier ? ` · ${x.supplier}` : ""}${x.t.quantity ? ` · ${nf(x.t.quantity)} ${x.t.unit ?? ""}` : ""}`,
          fields: [{ l: "Remark", v: x.t.remark || "—" }],
          actions,
          panel: {
            kind: "testEvidence",
            data: {
              status: shown,
              tests: x.t.tests,
              smell: x.t.smell,
              density: x.t.density,
              phValue: x.t.phValue,
              photos: {
                PH: x.t.phPhotoId,
                Color: x.t.colorPhotoId,
                "Oil Paint": x.t.oilPhotoId,
                "Fast Paints": x.t.fastPhotoId,
                "Nc Paints": x.t.ncPhotoId,
                Primer: x.t.primerPhotoId,
                Density: x.t.densityPhotoId,
                "Tharmakol Pass": x.t.thermocolPhotoId,
              },
              video: x.t.videoId,
              registerExists: reg,
            },
          },
          by: stampLine(x.tester, x.t.createdAt),
        };
      }),
    };
  },
  formLoaders: {
    edit: (ctx, id) => testForm(ctx, id),
    /* ADD More Lot: a new test for the same inward line's PR and item. */
    addLot: async (ctx, id) => {
      const [t] = await db.select({ inward: erpTests.inwardId }).from(erpTests).where(eq(erpTests.id, id));
      const f = await testForm(ctx);
      if (!f || !t) return f;
      return { ...f, id: "copy", recordId: id, title: "Add another lot to this test", init: { ...f.init } };
    },
  },
  forms: {
    async new(ctx, h) {
      const f = await testForm(ctx);
      const lineId = ((f?.data?.lineId ?? {}) as Record<string, string>)[h.line ?? ""];
      if (!lineId) return fieldErr("line", "Pick an inward line waiting for a test");
      const [inw] = await db.select().from(erpInward).where(eq(erpInward.id, lineId));
      if (!inw) return fieldErr("line", "That inward line no longer exists");
      return saveTest(ctx, h, { inward: inw });
    },
    async copy(ctx, h, _l, sourceId) {
      const [src] = sourceId ? await db.select().from(erpTests).where(eq(erpTests.id, sourceId)) : [];
      if (!src) return err("The test being copied no longer exists.", "not_found");
      return saveTest(ctx, h, { copyOf: src });
    },
    async edit(ctx, h, _l, id) {
      if (!id) return err("No test named.", "not_found");
      const [t] = await db.select().from(erpTests).where(eq(erpTests.id, id));
      if (!t) return err("That test no longer exists.", "not_found");
      if (t.status === "Verified") return err("A verified test is closed. Mark it Not Verified first to change its evidence.", "rule_violation");
      return saveTest(ctx, h, { existing: t });
    },
  },
  actions: {
    async verify(ctx, id) {
      if (!ctx.powers.has("verifyTest")) return err("Only the verifier decides a purchase test.", "not_permitted");
      const [t] = await db.select().from(erpTests).where(eq(erpTests.id, id));
      if (!t) return err("That test no longer exists.", "not_found");
      if (t.status === "Verified") return err("Already verified.", "conflict");
      const miss = missingEvidence(t);
      if (miss.length) return err(`Evidence missing: ${miss.join(", ")}`, "rule_violation");
      let lot = "";
      const res = await db
        .transaction(async (tx): Promise<Result<unknown>> => {
          await tx
            .update(erpTests)
            .set({ status: "Verified", decidedById: ctx.user.id, decidedAt: new Date(), updatedAt: new Date() })
            .where(eq(erpTests.id, id));
          /* Test To Purchase: once only (spec §5.4). */
          const [exists] = await tx.select({ id: erpPurchases.id }).from(erpPurchases).where(eq(erpPurchases.testId, id));
          if (exists) return okVoid("Verified · a register row already existed for this lot");
          const inw = t.inwardId ? (await tx.select().from(erpInward).where(eq(erpInward.id, t.inwardId)))[0] : null;
          if (!t.supplierId) {
            tx.rollback();
          }
          const made = await createPurchase(tx, ctx, {
            prNumber: t.prNumber,
            purchaseDate: t.testingDate,
            supplierId: t.supplierId!,
            rawMaterialId: t.rawMaterialId,
            quantity: t.quantity ?? inw?.quantity ?? 0,
            unit: t.unit === "Unit" ? "Pcs" : (t.unit ?? "Litre"),
            godownId: t.godownId,
            drums: t.drums,
            weightWithDrum: t.weightWithDrum,
            density: t.density,
            remark: t.remark,
            source: "test",
            testId: t.id,
          });
          if (!made.ok) {
            tx.rollback();
          } else lot = made.data.lotNo;
          return okVoid(`Verified · a purchase register row was created for lot ${lot}`);
        })
        .catch((e: unknown) => (e instanceof Error && e.message === "Rollback" ? null : Promise.reject(e)));
      if (!res) return err("! Please Change 4 Digit PR Num Manually or Generate New PR Num!", "conflict");
      await erpAudit(ctx, "erp.test.verify", "erp_test", id);
      return res;
    },
    async unverify(ctx, id) {
      if (!ctx.powers.has("verifyTest")) return err("Only the verifier decides a purchase test.", "not_permitted");
      await db
        .update(erpTests)
        .set({ status: "Not Verified", decidedById: ctx.user.id, decidedAt: new Date(), updatedAt: new Date() })
        .where(eq(erpTests.id, id));
      await erpAudit(ctx, "erp.test.unverify", "erp_test", id);
      return okVoid("Marked Not Verified");
    },
  },
};

async function saveTest(
  ctx: ErpContext,
  h: Record<string, string>,
  from: { inward?: typeof erpInward.$inferSelect; copyOf?: typeof erpTests.$inferSelect; existing?: typeof erpTests.$inferSelect },
) {
  const src = from.inward ?? null;
  const base = from.existing ?? from.copyOf ?? null;
  const rawMaterialId = src?.rawMaterialId ?? base!.rawMaterialId;
  const [mat] = await db.select().from(erpRawMaterials).where(eq(erpRawMaterials.id, rawMaterialId));
  if (!mat) return err("The item no longer exists.", "not_found");
  const tests = from.existing?.tests ?? mat.testingList;
  const [tester] = await db.select({ id: users.id }).from(users).where(eq(users.name, text(h.tester) ?? ctx.user.name));
  const density = num(h.density);
  if (tests.includes("Density") && density != null && (density < 0.5 || density > 1.5)) return fieldErr("density", "INVALID");
  const photoIds: Record<string, string | null> = {};
  for (const [k, col] of Object.entries(PHOTO_COL)) photoIds[col as string] = text(h[k]);
  const values = {
    smell: tests.includes("Smell") ? text(h.smell) : null,
    density: tests.includes("Density") ? density : null,
    phValue: tests.includes("PH") ? num(h.phValue) : null,
    ...photoIds,
    testerId: tester?.id ?? ctx.user.id,
    testingDate: text(h.date) ?? new Date().toISOString().slice(0, 10),
    remark: text(h.remark),
    updatedAt: new Date(),
    updatedById: ctx.user.id,
  };
  const id = from.existing?.id ?? erpId("tst");
  const godownId = (await godownIdByName(text(h.godown))) ?? src?.godownId ?? base?.godownId;
  if (!godownId) return fieldErr("godown", "Godown is required");
  await db.transaction(async (tx) => {
    if (from.existing) {
      await tx.update(erpTests).set(values).where(eq(erpTests.id, id));
    } else {
      await tx.insert(erpTests).values({
        id,
        inwardId: src?.id ?? base?.inwardId ?? null,
        prNumber: src?.prNumber ?? base!.prNumber,
        rawMaterialId,
        supplierId: src?.supplierId ?? base?.supplierId ?? null,
        godownId,
        unit: src?.unit ?? base?.unit ?? mat.unit,
        quantity: src?.quantity ?? base?.quantity ?? null,
        drums: src?.drums ?? base?.drums ?? null,
        weightWithDrum: src?.weightWithDrum ?? base?.weightWithDrum ?? null,
        tests,
        createdById: ctx.user.id,
        ...values,
      });
    }
    await bindErpFiles(tx as unknown as typeof db, Object.values(photoIds), "erp_test", id, ctx.user.id);
  });
  await erpAudit(ctx, from.existing ? "erp.test.edit" : "erp.test.create", "erp_test", id, null, { tests });
  return okVoid(`Test saved for ${mat.name} · waiting for the verifier`);
}

/* ============================================================ register */

type RegRow = {
  p: typeof erpPurchases.$inferSelect;
  supplier: string;
  partyCode: string | null;
  item: string;
  itemCode: string | null;
  type: string;
  godown: string;
  by: string | null;
};

async function registerRows(): Promise<RegRow[]> {
  return (await db
    .select({
      p: erpPurchases,
      supplier: erpSuppliers.name,
      partyCode: erpSuppliers.partyCode,
      item: erpRawMaterials.name,
      itemCode: erpRawMaterials.code,
      type: erpRawMaterials.materialType,
      godown: erpGodowns.name,
      by: users.name,
    })
    .from(erpPurchases)
    .innerJoin(erpSuppliers, eq(erpSuppliers.id, erpPurchases.supplierId))
    .innerJoin(erpRawMaterials, eq(erpRawMaterials.id, erpPurchases.rawMaterialId))
    .innerJoin(erpGodowns, eq(erpGodowns.id, erpPurchases.godownId))
    .leftJoin(users, eq(users.id, erpPurchases.createdById))
    .orderBy(desc(erpPurchases.purchaseDate), desc(erpPurchases.prNumber))) as RegRow[];
}

async function purchaseForm(ctx: ErpContext, id?: string): Promise<FormSpec | null> {
  const [mats, gds, sups] = await Promise.all([
    materials(),
    godownOptions(ctx),
    db.select().from(erpSuppliers).where(eq(erpSuppliers.active, true)).orderBy(asc(erpSuppliers.name)),
  ]);
  const money = ctx.powers.has("viewPurchaseMoney");
  const partyCode: Record<string, string> = {};
  sups.forEach((s) => (partyCode[s.name] = s.partyCode ?? ""));
  const itemCode: Record<string, string> = {};
  const densityOf: Record<string, number | null> = {};
  mats.forEach((m) => {
    itemCode[m.name] = m.code ?? "";
    densityOf[m.name] = m.density;
  });
  let init: Record<string, string> = { date: new Date().toISOString().slice(0, 10), godown: ctx.workingGodown?.name ?? "", gst: "18", company: "Mahek Marketing India" };
  let editing: RegRow | undefined;
  if (id) {
    editing = (await registerRows()).find((r) => r.p.id === id);
    if (!editing) return null;
    const p = editing.p;
    init = {
      pr: String(p.prNumber),
      date: p.purchaseDate,
      po: p.poNumber ?? "",
      supplier: editing.supplier,
      item: editing.item,
      qty: String(p.quantity),
      unit: p.unit,
      rate: rupeesField(p.ratePaise),
      density: p.density == null ? "" : String(p.density),
      drums: p.drums == null ? "" : String(p.drums),
      weight: p.weightWithDrum == null ? "" : String(p.weightWithDrum),
      feedLitre: String(p.feedAdjustedLitre ?? 0),
      feedAmount: rupeesField(p.feedAdjustedAmountPaise),
      gst: String(p.gstBp / 100),
      company: p.company,
      billNumber: p.billNumber ?? "",
      notes: p.notes ?? "",
      remark: p.remark ?? "",
      godown: editing.godown,
    };
  }
  const header: FieldSpec[] = [
    { k: "pr", l: "PR number", t: id ? "text" : "num", readOnly: !!id, hint: id ? undefined : "Blank draws the next PR number." },
    { k: "date", l: "Purchase date", t: "date", req: true },
    { k: "po", l: "P.O. number", t: "text" },
    { k: "supplier", l: "Party", t: "select", req: true, opts: sups.map((s) => s.name), readOnly: !!id },
    { k: "item", l: "Raw item", t: "select", req: true, opts: mats.map((m) => m.name), readOnly: !!id },
    { k: "lot", l: "Raw-material lot no", t: "derived", calc: "register.lot" },
    { k: "qty", l: "Quantity", t: "num", req: true, min: 0.001 },
    { k: "unit", l: "Unit", t: "select", req: true, opts: ["Kg", "Litre", "Pcs"] },
    { k: "density", l: "Density", t: "num", min: 0 },
    { k: "drums", l: "No. of drum", t: "num", min: 0 },
    { k: "weight", l: "Weight with drum", t: "num", min: 0 },
    { k: "litres", l: "In litre", t: "derived", calc: "register.litres" },
    { k: "feedLitre", l: "Feed-adjusted litre", t: "num", min: 0 },
    { k: "avail", l: "Available litres", t: "derived", calc: "register.available" },
    ...(money
      ? ([
          { k: "rate", l: "Rate (₹)", t: "num", min: 0, hint: "Stock posts once a rate above zero is entered." },
          { k: "gst", l: "GST %", t: "num", min: 0, max: 100 },
          { k: "feedAmount", l: "Feed-adjusted amount (₹)", t: "num", min: 0 },
          { k: "final", l: "Final amount", t: "derived", calc: "register.final" },
          { k: "company", l: "Company", t: "select", req: true, opts: ["Mahek Marketing India", "MYLAC"] },
        ] as FieldSpec[])
      : []),
    { k: "billNumber", l: "Bill number", t: "text" },
    { k: "godown", l: "Godown", t: "select", req: true, opts: gds.map((g) => g.name) },
    { k: "notes", l: "Notes", t: "area", mic: true },
    { k: "remark", l: "Remark", t: "area", mic: true },
  ];
  return {
    screen: "register",
    id: id ? "edit" : "new",
    recordId: id,
    title: id ? "Edit purchase" : "New purchase",
    sub: id ? `${editing!.item} · lot ${editing!.p.lotNo}` : "A purchase entered by hand. Most arrive from inward or a verified test.",
    submit: id ? "Save purchase" : "Add purchase",
    init,
    data: { partyCode, itemCode, densityOf },
    header,
  };
}

const register: ScreenModule = {
  key: "register",
  async load(ctx) {
    const rows = await registerRows();
    const pairs = await refValues("shortLabel");
    const byPr = new Map<number, number>();
    rows.forEach((r) => {
      const f = purchaseFigures(figIn(r.p));
      if (f.finalPaise != null) byPr.set(r.p.prNumber, (byPr.get(r.p.prNumber) ?? 0) + f.finalPaise);
    });
    const newForm = await purchaseForm(ctx);
    const money = ctx.powers.has("viewPurchaseMoney");
    const verifier = ctx.powers.has("verifyPurchase");
    const reopen = ctx.powers.has("reopenPurchase");
    const all: Col[] = [
      { k: "date", l: "Date", t: "d" },
      { k: "pr", l: "PR no", t: "mono" },
      { k: "lot", l: "Lot no", t: "mono" },
      { k: "party", l: "Party", t: "t" },
      { k: "item", l: "Item", t: "b" },
      { k: "qty", l: "Quantity", t: "n" },
      { k: "unit", l: "Unit", t: "t" },
      { k: "rate", l: "Rate", t: "m", pw: "viewPurchaseMoney" },
      { k: "gst", l: "GST %", t: "n", pw: "viewPurchaseMoney" },
      { k: "final", l: "Final amount", t: "m", pw: "viewPurchaseMoney" },
      { k: "bill", l: "Bill", t: "s", pw: "viewPurchaseMoney" },
      { k: "billNo", l: "Bill no", t: "t" },
      { k: "posting", l: "Inventory", t: "s" },
      { k: "f", l: "Flags", t: "f" },
    ];
    const { cols, hidden, hiddenKeys } = visibleCols(all, has(ctx));
    return {
      spec: {
        screen: "register",
        cols,
        hidden,
        groups: ["date", "pr"],
        agg: money ? { k: "final", l: "average bill", t: "avg" } : undefined,
        godownKey: "godown",
        newForm: newForm ?? undefined,
        newLabel: "New purchase",
        bulk: money ? [{ id: "billReceivedMany", l: "Mark bill received", confirm: "Mark every selected purchase's bill as received?" }] : undefined,
        noDataLine: "No purchases yet. Rows arrive from inward lines and verified tests.",
      },
      rows: rows.map((r) => {
        const p = r.p;
        const f = purchaseFigures(figIn(p));
        const posted = postsToStock(p.ratePaise);
        const actions: ActionSpec[] = [];
        if (money && !posted)
          actions.push({
            id: "rate",
            l: "Enter rate",
            primary: true,
            prompt: {
              title: "Enter the purchase rate",
              sub: `${r.item} · ${p.lotNo} · ${nf(p.quantity)} ${p.unit}`,
              submit: "Save rate and post",
              fields: [{ k: "rate", l: `Rate per ${p.unit} (₹)`, t: "num", req: true, min: 0.01 }],
            },
          });
        if (money) {
          if (p.billReceived !== "Received")
            actions.push({
              id: "billReceived",
              l: "Bill Received",
              prompt: { title: "Bill received", submit: "Save", fields: [{ k: "billNo", l: "Bill number", t: "text", req: true }], init: { billNo: p.billNumber ?? "" } },
            });
          else actions.push({ id: "billNotReceived", l: "Bill Not Received" });
          actions.push({
            id: "status",
            l: "Change Status",
            prompt: {
              title: "Purchase status",
              sub: verifier ? "The verifier sets Purchase Verified." : "Purchase Verified is set by the verifier.",
              submit: "Save status",
              fields: [{ k: "status", l: "Status", t: "select", req: true, opts: settableStatuses(verifier) }],
            },
          });
          if (p.status === "Purchase Verified" || p.status === "")
            actions.push({ id: "reopen", l: "Do Pending", why: reopen ? "" : "Only an admin sets a verified purchase back to Pending" });
        }
        actions.push({ id: "edit", l: "Edit", loadsForm: true });
        actions.push({ id: "addMore", l: "Add More", loadsForm: true });
        const moneyFields = money
          ? [
              { l: "Litre rate", v: f.literRatePaise == null ? "—" : inr(f.literRatePaise), der: true },
              { l: "Sub total", v: f.subTotalPaise == null ? "—" : inr(f.subTotalPaise), der: true },
              { l: "GST amount", v: f.gstPaise == null ? "—" : inr(f.gstPaise), der: true },
              { l: "Amount + GST", v: f.amountWithGstPaise == null ? "—" : inr(f.amountWithGstPaise), der: true },
              { l: "Feed-adjusted amount", v: inr(p.feedAdjustedAmountPaise) },
              { l: "This bill final amount", v: byPr.has(p.prNumber) ? inr(byPr.get(p.prNumber)!) : "—", der: true },
              { l: "Company", v: p.company },
              { l: "Status", v: p.status },
            ]
          : [];
        return {
          id: p.id,
          v: withoutHidden(
            {
              date: p.purchaseDate,
              pr: String(p.prNumber),
              lot: p.lotNo,
              party: r.supplier,
              item: r.item,
              qty: p.quantity,
              unit: p.unit,
              rate: p.ratePaise,
              gst: p.gstBp / 100,
              final: f.finalPaise,
              bill: p.billReceived ?? "Not Received",
              billNo: p.billNumber,
              posting: posted ? "Posted" : "Not posted: rate missing",
              godown: r.godown,
            },
            hiddenKeys,
          ),
          flags: [...(p.ratePaise && p.ratePaise > 0 ? [] : ["rateMissing"]), ...(p.aiFilled ? ["aiFilled"] : [])],
          title: r.item,
          header: `Lot ${p.lotNo} · ${r.godown}`,
          fields: [
            { l: "Party code", v: r.partyCode ?? "—" },
            { l: "Item code", v: r.itemCode ?? "—" },
            { l: "Material type", v: r.type },
            { l: "Density", v: p.density == null ? "—" : String(p.density) },
            { l: "Drums", v: p.drums == null ? "—" : nf(p.drums) },
            { l: "In litre", v: nf(f.inLitre), der: true },
            { l: "Feed-adjusted litre", v: nf(p.feedAdjustedLitre) },
            { l: "Available litres", v: nf(f.availableLitres), der: true },
            { l: "Litres per drum", v: f.litresPerDrum == null ? "—" : nf(f.litresPerDrum), der: true },
            { l: "Short label name", v: shortLabel(r.item, pairs), der: true },
            { l: "PR / bill", v: prBillLabel(p.prNumber, p.billNumber, p.purchaseDate), der: true },
            { l: "Godown", v: r.godown },
            { l: "Notes", v: p.notes || "—" },
            { l: "Remark", v: p.remark || "—" },
            ...moneyFields,
          ],
          hiddenFields: money ? 0 : 8,
          actions,
          by: stampLine(r.by, p.createdAt),
        };
      }),
    };
  },
  formLoaders: {
    edit: (ctx, id) => purchaseForm(ctx, id),
    addMore: async (ctx, id) => {
      const f = await purchaseForm(ctx, id);
      if (!f) return null;
      /* Add More: a new lot on the same PR, header carried over. */
      const keep = ["pr", "date", "po", "supplier", "godown", "company", "billNumber"];
      const init: Record<string, string> = {};
      keep.forEach((k) => (init[k] = f.init?.[k] ?? ""));
      const base = await purchaseForm(ctx);
      return base ? { ...base, title: `Add another lot to PR ${init.pr}`, init: { ...base.init, ...init } } : null;
    },
  },
  forms: {
    async new(ctx, h) {
      return savePurchase(ctx, h);
    },
    async edit(ctx, h, _l, id) {
      return savePurchase(ctx, h, id);
    },
  },
  actions: {
    async rate(ctx, id, values) {
      if (!ctx.powers.has("viewPurchaseMoney")) return err("Purchase money is not on your account.", "not_permitted");
      const rate = paise(values.rate);
      if (rate == null || rate <= 0) return fieldErr("rate", "Rate is required");
      let posted = false;
      await db.transaction(async (tx) => {
        await tx.update(erpPurchases).set({ ratePaise: rate, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpPurchases.id, id));
        await refreshCache(tx, id);
        posted = await syncPurchaseEntry(tx, id);
      });
      await erpAudit(ctx, "erp.purchase.rate", "erp_purchase", id, null, { ratePaise: rate });
      const [p] = await db.select().from(erpPurchases).where(eq(erpPurchases.id, id));
      return okVoid(posted ? `Posted · ${nf(p.availableLitres)} of lot ${p.lotNo} now in stock` : "Rate saved");
    },
    async billReceived(ctx, id, values) {
      if (!ctx.powers.has("viewPurchaseMoney")) return err("Purchase money is not on your account.", "not_permitted");
      const billNo = text(values.billNo);
      if (!billNo) return fieldErr("billNo", "Bill number is required");
      await db.update(erpPurchases).set({ billReceived: "Received", billNumber: billNo, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpPurchases.id, id));
      await erpAudit(ctx, "erp.purchase.billReceived", "erp_purchase", id, null, { billNo });
      return okVoid(`Bill ${billNo} recorded`);
    },
    async billNotReceived(ctx, id) {
      if (!ctx.powers.has("viewPurchaseMoney")) return err("Purchase money is not on your account.", "not_permitted");
      await db.update(erpPurchases).set({ billReceived: "Bill Not Received", updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpPurchases.id, id));
      await erpAudit(ctx, "erp.purchase.billNotReceived", "erp_purchase", id);
      return okVoid("Marked bill not received");
    },
    async status(ctx, id, values) {
      if (!ctx.powers.has("viewPurchaseMoney")) return err("Purchase money is not on your account.", "not_permitted");
      const status = text(values.status);
      const allowed = settableStatuses(ctx.powers.has("verifyPurchase"));
      if (!status || !allowed.includes(status)) return fieldErr("status", status === "Purchase Verified" ? "Only the verifier sets Purchase Verified" : "Pick a status");
      await db.update(erpPurchases).set({ status, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpPurchases.id, id));
      await erpAudit(ctx, "erp.purchase.status", "erp_purchase", id, null, { status });
      return okVoid(`Status is ${status}`);
    },
    async reopen(ctx, id) {
      if (!ctx.powers.has("reopenPurchase")) return err("Only an admin sets a verified purchase back to Pending.", "not_permitted");
      await db.update(erpPurchases).set({ status: "Pending", updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpPurchases.id, id));
      await erpAudit(ctx, "erp.purchase.reopen", "erp_purchase", id);
      return okVoid("Set back to Pending");
    },
  },
  bulk: {
    async billReceivedMany(ctx, ids) {
      if (!ctx.powers.has("viewPurchaseMoney")) return err("Purchase money is not on your account.", "not_permitted");
      await db.update(erpPurchases).set({ billReceived: "Received", updatedAt: new Date(), updatedById: ctx.user.id }).where(inArray(erpPurchases.id, ids));
      await erpAudit(ctx, "erp.purchase.billReceived.bulk", "erp_purchase", null, null, { ids });
      return okVoid(`${ids.length} marked bill received`);
    },
  },
};

function figIn(p: typeof erpPurchases.$inferSelect) {
  return {
    quantity: p.quantity,
    unit: p.unit,
    ratePaise: p.ratePaise,
    density: p.density,
    feedAdjustedLitre: p.feedAdjustedLitre,
    feedAdjustedAmountPaise: p.feedAdjustedAmountPaise,
    gstBp: p.gstBp,
    drums: p.drums,
  };
}

/** Rewrites the cached available litres from the row's own figures. */
async function refreshCache(tx: Tx, id: string) {
  const [p] = await tx.select().from(erpPurchases).where(eq(erpPurchases.id, id));
  if (!p) return;
  const f = purchaseFigures(figIn(p));
  await tx.update(erpPurchases).set({ availableLitres: f.availableLitres }).where(eq(erpPurchases.id, id));
}

async function savePurchase(ctx: ErpContext, h: Record<string, string>, id?: string): Promise<Result<unknown>> {
  const money = ctx.powers.has("viewPurchaseMoney");
  const qty = num(h.qty);
  if (qty == null || qty <= 0) return fieldErr("qty", qty != null && qty < 0 ? "Minus Quantity Not Allowed" : "Quantity is required");
  const unit = text(h.unit);
  if (!unit || !["Kg", "Litre", "Pcs"].includes(unit)) return fieldErr("unit", "Unit is required");
  const godownId = await godownIdByName(text(h.godown));
  if (!godownId) return fieldErr("godown", "Godown is required");
  const density = num(h.density);
  if (unit === "Kg" && (density == null || density <= 0)) return fieldErr("density", "A kilogram purchase needs a density to be turned into litres");
  const common = {
    purchaseDate: text(h.date) ?? new Date().toISOString().slice(0, 10),
    poNumber: text(h.po),
    quantity: qty,
    unit,
    density,
    drums: int(h.drums),
    weightWithDrum: num(h.weight),
    feedAdjustedLitre: num(h.feedLitre) ?? 0,
    billNumber: text(h.billNumber),
    notes: text(h.notes),
    remark: text(h.remark),
    godownId,
    ...(money
      ? {
          ratePaise: paise(h.rate),
          gstBp: Math.round((num(h.gst) ?? 18) * 100),
          feedAdjustedAmountPaise: paise(h.feedAmount) ?? 0,
          company: text(h.company) ?? "Mahek Marketing India",
        }
      : {}),
  };
  if (id) {
    const [before] = await db.select().from(erpPurchases).where(eq(erpPurchases.id, id));
    if (!before) return err("That purchase no longer exists.", "not_found");
    await db.transaction(async (tx) => {
      await tx.update(erpPurchases).set({ ...common, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpPurchases.id, id));
      await refreshCache(tx, id);
      await syncPurchaseEntry(tx, id);
    });
    await erpAudit(ctx, "erp.purchase.edit", "erp_purchase", id, before, common);
    return okVoid("Purchase saved");
  }
  const [sup] = await db.select().from(erpSuppliers).where(eq(erpSuppliers.name, text(h.supplier) ?? ""));
  if (!sup) return fieldErr("supplier", "Party is required");
  const [mat] = await db.select().from(erpRawMaterials).where(eq(erpRawMaterials.name, text(h.item) ?? ""));
  if (!mat) return fieldErr("item", "Raw item is required");
  let result: Result<{ id: string; lotNo: string }> | null = null;
  await db
    .transaction(async (tx) => {
      const pr = int(h.pr) ?? (await nextNumber(tx, "pr"));
      result = await createPurchase(tx, ctx, {
        ...common,
        prNumber: pr,
        supplierId: sup.id,
        rawMaterialId: mat.id,
        source: "manual",
      });
      if (!result.ok) tx.rollback();
    })
    .catch((e: unknown) => (e instanceof Error && e.message === "Rollback" ? null : Promise.reject(e)));
  const r = result as Result<{ id: string; lotNo: string }> | null;
  if (!r) return err("Could not save the purchase.");
  if (!r.ok) return r;
  await erpAudit(ctx, "erp.purchase.create", "erp_purchase", r.data.id, null, common);
  return okVoid(`Purchase saved · lot ${r.data.lotNo}`);
}

/* ============================================================= barcode */

const barcode: ScreenModule = {
  key: "barcode",
  async load(ctx) {
    const pairs = await refValues("shortLabel");
    const here = ctx.workingGodown?.id ?? null;
    const rows = (await registerRows()).filter((r) => r.type === "Chemical" && r.p.godownId === here);
    const cols: ColSpec[] = [
      { k: "date", l: "Purchase date", t: "d" },
      { k: "lot", l: "Lot", t: "mono" },
      { k: "item", l: "Item name", t: "b" },
      { k: "litres", l: "In litre", t: "n" },
      { k: "drums", l: "Drums", t: "n" },
      { k: "perDrum", l: "Litres per drum", t: "n" },
      { k: "density", l: "Density", t: "n" },
      { k: "qty", l: "Quantity", t: "n" },
      { k: "unit", l: "Unit", t: "t" },
      { k: "remark", l: "Remark", t: "t" },
      { k: "prBill", l: "PR Bill no", t: "mono" },
      { k: "pr", l: "PR number", t: "mono" },
      { k: "testing", l: "Testing id", t: "mono" },
    ];
    return {
      spec: {
        screen: "barcode",
        cols,
        hidden: [],
        download: true,
        readOnly: true,
        sortDefault: ["date", -1],
        scopedLine: ctx.workingGodown ? `Showing ${ctx.workingGodown.name} only · change your working location in the header` : "No working location set — choose one in the header",
        noDataLine: "No chemical purchases at this godown yet.",
      },
      rows: rows.map((r) => {
        const f = purchaseFigures(figIn(r.p));
        return {
          id: r.p.id,
          v: {
            date: r.p.purchaseDate,
            lot: r.p.lotNo,
            item: shortLabel(r.item, pairs),
            litres: f.inLitre,
            drums: r.p.drums,
            perDrum: f.litresPerDrum,
            density: r.p.density,
            qty: r.p.quantity,
            unit: r.p.unit,
            remark: r.p.remark,
            prBill: r.p.id,
            pr: String(r.p.prNumber),
            testing: r.p.testId,
          },
          flags: [],
          title: `${shortLabel(r.item, pairs)} · ${r.p.lotNo}`,
          by: stampLine(r.by, r.p.createdAt),
        };
      }),
    };
  },
};

/* ======================================================== raw stock */

const rmStock: ScreenModule = {
  key: "rmStock",
  async load(ctx) {
    const lots = (await rmLots()).filter((l) => l.stock > 0);
    const all: Col[] = [
      { k: "item", l: "Item", t: "b" },
      { k: "stock", l: "Current stock", t: "n" },
      { k: "unit", l: "Unit", t: "t" },
      { k: "lot", l: "Lot no", t: "mono" },
      { k: "godown", l: "Godown", t: "t" },
      { k: "entry", l: "Entry id", t: "mono" },
      { k: "rate", l: "Rate", t: "m", pw: "viewCost" },
      { k: "value", l: "Value", t: "m", pw: "viewCost" },
    ];
    const { cols, hidden, hiddenKeys } = visibleCols(all, has(ctx));
    return {
      spec: {
        screen: "rmStock",
        cols,
        hidden,
        groups: ["godown"],
        agg: { k: "stock", l: "total" },
        godownKey: "godown",
        readOnly: true,
        noDataLine: "Nothing in stock yet. Stock appears as purchases are given a rate.",
      },
      rows: lots.map((l) => ({
        id: `${l.lotNo}|${l.godownId}`,
        v: withoutHidden(
          {
            item: l.item,
            stock: l.stock,
            unit: l.unit,
            lot: l.lotNo,
            godown: l.godown,
            entry: l.latestEntryId,
            rate: l.ratePaise,
            value: l.ratePaise == null ? null : Math.round(l.ratePaise * l.stock),
          },
          hiddenKeys,
        ),
        flags: [],
        title: `${l.item} · ${l.lotNo}`,
        header: `${nf(l.stock)} ${l.unit} at ${l.godown} · last entry ${fd(l.latestDate)}`,
      })),
    };
  },
};

const rmLog: ScreenModule = {
  key: "rmLog",
  async load() {
    const rows = (await db.execute(sql`
      select e.id, e.entry_date::text as date, e.source_type as "sourceType", e.source_id as "sourceId",
             m.name as item, e.lot_no as lot, e.quantity::float8 as qty, g.name as godown, e.posted_at as "postedAt",
             (e.source_type = 'purchase' and not exists (select 1 from erp_purchases p where p.id = e.source_id)) as orphan
        from erp_rm_entries e
        join erp_raw_materials m on m.id = e.raw_material_id
        join erp_godowns g on g.id = e.godown_id
       order by e.entry_date desc, e.posted_at desc, e.id desc
    `)) as unknown as { id: string; date: string; sourceType: string; sourceId: string; item: string; lot: string; qty: number; godown: string; postedAt: Date; orphan: boolean }[];
    const cols: ColSpec[] = [
      { k: "date", l: "Date", t: "d" },
      { k: "type", l: "Entry", t: "s" },
      { k: "item", l: "Item", t: "b" },
      { k: "lot", l: "Lot", t: "mono" },
      { k: "qty", l: "Quantity", t: "n" },
      { k: "godown", l: "Godown", t: "t" },
      { k: "source", l: "Source", t: "mono" },
      { k: "f", l: "Flags", t: "f" },
    ];
    return {
      spec: {
        screen: "rmLog",
        cols,
        hidden: [],
        godownKey: "godown",
        readOnly: true,
        sortDefault: ["date", -1],
        noDataLine: "Nothing here yet. Entries appear on their own as purchases and transfers are posted.",
      },
      rows: rows.map((r) => ({
        id: r.id,
        v: { date: r.date, type: r.sourceType === "purchase" ? "Purchase" : "Transfer", item: r.item, lot: r.lot, qty: Number(r.qty), godown: r.godown, source: r.sourceId },
        flags: r.orphan ? ["orphan"] : [],
        title: `${r.item} · ${r.lot}`,
        by: `Posted ${stampLine(null, r.postedAt).replace(/^Created /, "")}`,
      })),
    };
  },
};

export const PURCHASE_SCREENS: ScreenModule[] = [requisitions, inward, testing, register, barcode, rmStock, rmLog];
