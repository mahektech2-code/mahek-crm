import "server-only";
import { and, asc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  appAccess,
  customers,
  erpCustomerProfiles,
  erpGodownStaff,
  erpGodowns,
  erpProductPacking,
  erpRawMaterials,
  erpRefValues,
  erpSuppliers,
  finishedGoods,
  priceListRates,
  priceLists,
  priceListDiscountTerms,
  products,
  productFormulations,
  users,
} from "@/db/schema";
import { err, fieldErr, okVoid } from "@/lib/result";
import { APP_TIMEZONE } from "@/lib/business-date";
import type { ErpContext } from "../access";
import type { ErpPower } from "../powers";
import {
  BOX_TYPES,
  DELIVERY_TYPES,
  GRADES,
  PAYMENT_TYPES,
  REF_LISTS,
  REGIONS,
  RM_UNITS,
  WEIGHT_TYPES,
  refValues,
} from "../refs";
import {
  erpAudit,
  erpId,
  int,
  multi,
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
import { inr } from "../ui";
import { rmTotalsByItem } from "../stock";

/* ---------------------------------------------------------------------------
 * Masters (spec §4): raw materials, suppliers, products, customers, godowns,
 * price lists, employees, the ERP powers and the reference lists.
 * ------------------------------------------------------------------------- */

type Col = ColSpec & { pw?: ErpPower };

const has = (ctx: ErpContext) => (p: string) => ctx.powers.has(p as ErpPower);

export function phoneContacts(phone: string | null | undefined, email?: string | null) {
  const out: { l: string; href: string }[] = [];
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length >= 10) {
    out.push({ l: `Call ${phone}`, href: `tel:${digits}` });
    out.push({ l: "WhatsApp", href: `https://wa.me/91${digits.slice(-10)}` });
  }
  if (email) out.push({ l: "Email", href: `mailto:${email}` });
  return out;
}

/* ======================================================== raw materials */

async function rawMaterialForm(ctx: ErpContext, id?: string): Promise<FormSpec> {
  const types = await refValues("materialType");
  const tests = await refValues("testingList");
  let init: Record<string, string> | undefined;
  if (id) {
    const [r] = await db.select().from(erpRawMaterials).where(eq(erpRawMaterials.id, id));
    if (r) {
      init = {
        name: r.name,
        code: r.code ?? "",
        unit: r.unit,
        materialType: r.materialType,
        density: r.density == null ? "" : String(r.density),
        testingList: r.testingList.join("|"),
        price: rupeesField(r.pricePaise),
        remark: r.remark ?? "",
      };
    }
  }
  const money = ctx.powers.has("viewPurchaseMoney");
  return {
    screen: "rawMaterials",
    id: id ? "edit" : "new",
    recordId: id,
    title: id ? "Edit raw material" : "New raw material",
    sub: "Chemicals carry a density and the tests every lot must pass.",
    submit: id ? "Save changes" : "Add raw material",
    init,
    header: [
      { k: "name", l: "Raw item", t: "text", req: true },
      { k: "code", l: "Item code", t: "text", req: true, hint: "Part of every lot number bought of this item." },
      { k: "unit", l: "Item unit", t: "select", req: true, opts: RM_UNITS },
      { k: "materialType", l: "Material type", t: "select", req: true, opts: types },
      { k: "density", l: "Density (kg to litre)", t: "num", req: true, when: { k: "materialType", eq: "Chemical" }, min: 0.1, max: 3 },
      { k: "testingList", l: "Testing list", t: "multi", req: true, opts: tests, when: { k: "materialType", eq: "Chemical" } },
      ...(money ? [{ k: "price", l: "Price (₹)", t: "num" as const, min: 0, hint: "Used as the packing rate for cans and drums." }] : []),
      { k: "remark", l: "Remark", t: "area", mic: true },
    ],
  };
}

const rawMaterials: ScreenModule = {
  key: "rawMaterials",
  async load(ctx) {
    const rows = await db.select().from(erpRawMaterials).orderBy(asc(erpRawMaterials.serialNo));
    const totals = await rmTotalsByItem();
    const all: Col[] = [
      { k: "sn", l: "S.no", t: "n" },
      { k: "item", l: "Item", t: "b" },
      { k: "code", l: "Code", t: "t" },
      { k: "unit", l: "Unit", t: "t" },
      { k: "type", l: "Material type", t: "s" },
      { k: "density", l: "Density", t: "n" },
      { k: "tests", l: "Testing list", t: "t" },
      { k: "price", l: "Price", t: "m", pw: "viewPurchaseMoney" },
      { k: "stock", l: "Total stock", t: "n" },
      { k: "status", l: "Status", t: "s" },
    ];
    const { cols, hidden, hiddenKeys } = visibleCols(all, has(ctx));
    const form = await rawMaterialForm(ctx);
    return {
      spec: {
        screen: "rawMaterials",
        cols,
        hidden,
        groups: ["type"],
        chips: "status",
        newForm: form,
        newLabel: "New raw material",
      },
      rows: rows.map((r): ListRow => {
        const v = withoutHidden(
          {
            sn: r.serialNo,
            item: r.name,
            code: r.code,
            unit: r.unit,
            type: r.materialType,
            density: r.density,
            tests: r.testingList.join(", ") || "—",
            price: r.pricePaise,
            stock: totals.get(r.id) ?? 0,
            status: r.active ? "Active" : "Inactive",
          },
          hiddenKeys,
        );
        const actions: ActionSpec[] = [
          { id: "edit", l: "Edit", primary: true, loadsForm: true },
          r.active
            ? { id: "retire", l: "Retire", confirm: `Retire ${r.name}? It stays on every record that already names it, and is no longer offered on new ones.` }
            : { id: "restore", l: "Restore" },
        ];
        return {
          id: r.id,
          v,
          flags: r.active ? [] : ["inactive"],
          title: r.name,
          actions,
          by: stampLine(null, r.createdAt),
        };
      }),
    };
  },
  formLoaders: {
    edit: (ctx, id) => rawMaterialForm(ctx, id),
  },
  forms: {
    async new(ctx, h) {
      return saveRawMaterial(ctx, h);
    },
    async edit(ctx, h, _l, id) {
      return saveRawMaterial(ctx, h, id);
    },
  },
  actions: {
    async retire(ctx, id) {
      await db.update(erpRawMaterials).set({ active: false, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpRawMaterials.id, id));
      await erpAudit(ctx, "erp.rawMaterial.retire", "erp_raw_material", id);
      return okVoid("Retired · no longer offered on new records");
    },
    async restore(ctx, id) {
      await db.update(erpRawMaterials).set({ active: true, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpRawMaterials.id, id));
      await erpAudit(ctx, "erp.rawMaterial.restore", "erp_raw_material", id);
      return okVoid("Restored");
    },
  },
};

async function saveRawMaterial(ctx: ErpContext, h: Record<string, string>, id?: string) {
  const name = text(h.name);
  if (!name) return fieldErr("name", "Raw item is required");
  const unit = text(h.unit);
  if (!unit || !RM_UNITS.includes(unit)) return fieldErr("unit", "Item unit is required");
  const materialType = text(h.materialType);
  if (!materialType) return fieldErr("materialType", "Material type is required");
  const chemical = materialType === "Chemical";
  const density = num(h.density);
  const tests = multi(h.testingList);
  if (chemical && (density == null || density <= 0)) return fieldErr("density", "Density is required for a chemical");
  if (chemical && tests.length === 0) return fieldErr("testingList", "Testing list is required for a chemical");

  const dup = await db
    .select({ id: erpRawMaterials.id })
    .from(erpRawMaterials)
    .where(sql`lower(${erpRawMaterials.name}) = lower(${name})`);
  if (dup.some((d) => d.id !== id)) return fieldErr("name", "Duplicate Entry!");

  const values = {
    name,
    code: text(h.code),
    unit,
    materialType,
    density: chemical ? density : null,
    testingList: chemical ? tests : [],
    remark: text(h.remark),
    updatedAt: new Date(),
    updatedById: ctx.user.id,
    ...(ctx.powers.has("viewPurchaseMoney") ? { pricePaise: paise(h.price) } : {}),
  };
  if (id) {
    const [before] = await db.select().from(erpRawMaterials).where(eq(erpRawMaterials.id, id));
    if (!before) return err("That raw material no longer exists.", "not_found");
    await db.update(erpRawMaterials).set(values).where(eq(erpRawMaterials.id, id));
    await erpAudit(ctx, "erp.rawMaterial.edit", "erp_raw_material", id, before, values);
    return okVoid(`${name} saved`);
  }
  const newId = erpId("erprm");
  /* The serial is the next one under a row lock — "max + 1" read twice at once
     is how two items end up with one serial. */
  await db.transaction(async (tx) => {
    await tx.execute(sql`lock table erp_raw_materials in share row exclusive mode`);
    const [{ next }] = (await tx.execute(
      sql`select coalesce(max(serial_no), 0) + 1 as next from erp_raw_materials`,
    )) as unknown as { next: number }[];
    await tx.insert(erpRawMaterials).values({ id: newId, serialNo: Number(next), createdById: ctx.user.id, ...values });
  });
  await erpAudit(ctx, "erp.rawMaterial.create", "erp_raw_material", newId, null, values);
  return okVoid(`${name} added`);
}

/* =========================================================== suppliers */

async function supplierForm(id?: string): Promise<FormSpec> {
  const [areas, states] = await Promise.all([refValues("area"), refValues("state")]);
  let init: Record<string, string> | undefined;
  if (id) {
    const [r] = await db.select().from(erpSuppliers).where(eq(erpSuppliers.id, id));
    if (r) {
      init = {
        name: r.name,
        partyCode: r.partyCode ?? "",
        area: r.area ?? "",
        location: r.location ?? "",
        state: r.state ?? "",
        creditDays: r.creditDays == null ? "" : String(r.creditDays),
        mobile: r.mobile ?? "",
        whatsapp: r.whatsapp ?? "",
        broker: r.broker ?? "",
        grade: r.grade ?? "",
        email: r.email ?? "",
        gstin: r.gstin ?? "",
      };
    }
  }
  return {
    screen: "suppliers",
    id: id ? "edit" : "new",
    recordId: id,
    title: id ? "Edit purchase party" : "New purchase party",
    sub: "The party code is part of every lot number bought from them, so keep it stable.",
    submit: id ? "Save changes" : "Add purchase party",
    init,
    header: [
      { k: "name", l: "Party name", t: "text", req: true },
      { k: "partyCode", l: "Own party code", t: "text", req: true },
      { k: "area", l: "Area", t: "select", opts: areas },
      { k: "location", l: "Location", t: "text" },
      { k: "state", l: "State", t: "select", opts: states },
      { k: "creditDays", l: "Credit days", t: "num", min: 0 },
      { k: "mobile", l: "Mobile no.", t: "text" },
      { k: "whatsapp", l: "WhatsApp contact", t: "text" },
      { k: "broker", l: "Broker name", t: "text" },
      { k: "grade", l: "Grade", t: "text" },
      { k: "email", l: "Party email", t: "text" },
      { k: "gstin", l: "GSTIN", t: "text" },
    ],
  };
}

const suppliers: ScreenModule = {
  key: "suppliers",
  async load() {
    const rows = await db.select().from(erpSuppliers).orderBy(asc(erpSuppliers.name));
    const purchases = await purchaseCountsBySupplier();
    const form = await supplierForm();
    const cols: ColSpec[] = [
      { k: "name", l: "Party", t: "b" },
      { k: "code", l: "Party code", t: "mono" },
      { k: "area", l: "Area", t: "t" },
      { k: "state", l: "State", t: "t" },
      { k: "credit", l: "Credit days", t: "n" },
      { k: "mobile", l: "Mobile", t: "ph" },
      { k: "broker", l: "Broker", t: "t" },
      { k: "grade", l: "Grade", t: "s" },
      { k: "email", l: "Email", t: "em" },
    ];
    return {
      spec: { screen: "suppliers", cols, hidden: [], groups: ["state"], newForm: form, newLabel: "New purchase party" },
      rows: rows.map((r) => ({
        id: r.id,
        v: {
          name: r.name,
          code: r.partyCode,
          area: r.area,
          state: r.state,
          credit: r.creditDays,
          mobile: r.mobile,
          broker: r.broker,
          grade: r.grade,
          email: r.email,
        },
        flags: r.active ? [] : ["inactive"],
        title: r.name,
        fields: [
          { l: "WhatsApp", v: r.whatsapp || "—" },
          { l: "Location", v: r.location || "—" },
          { l: "GSTIN", v: r.gstin || "—" },
          { l: "Purchases", v: `${purchases.get(r.id) ?? 0} purchases`, der: true },
        ],
        contacts: phoneContacts(r.mobile, r.email),
        actions: [
          { id: "edit", l: "Edit", primary: true, loadsForm: true },
          r.active
            ? { id: "retire", l: "Retire", confirm: `Retire ${r.name}? Existing purchases keep the name; new inward lines stop offering it.` }
            : { id: "restore", l: "Restore" },
        ],
        by: stampLine(null, r.createdAt),
      })),
    };
  },
  formLoaders: {
    edit: (_ctx, id) => supplierForm(id),
  },
  forms: {
    async new(ctx, h) {
      return saveSupplier(ctx, h);
    },
    async edit(ctx, h, _l, id) {
      return saveSupplier(ctx, h, id);
    },
  },
  actions: {
    async retire(ctx, id) {
      await db.update(erpSuppliers).set({ active: false, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpSuppliers.id, id));
      await erpAudit(ctx, "erp.supplier.retire", "erp_supplier", id);
      return okVoid("Retired");
    },
    async restore(ctx, id) {
      await db.update(erpSuppliers).set({ active: true, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpSuppliers.id, id));
      await erpAudit(ctx, "erp.supplier.restore", "erp_supplier", id);
      return okVoid("Restored");
    },
  },
};

async function saveSupplier(ctx: ErpContext, h: Record<string, string>, id?: string) {
  const name = text(h.name);
  if (!name) return fieldErr("name", "Party name is required");
  const code = text(h.partyCode);
  if (!code) return fieldErr("partyCode", "Own party code is required");
  const dup = await db
    .select({ id: erpSuppliers.id })
    .from(erpSuppliers)
    .where(sql`lower(${erpSuppliers.name}) = lower(${name})`);
  if (dup.some((d) => d.id !== id)) return fieldErr("name", "Duplicate Entry!");
  const values = {
    name,
    partyCode: code,
    area: text(h.area),
    location: text(h.location),
    state: text(h.state),
    creditDays: int(h.creditDays),
    mobile: text(h.mobile),
    whatsapp: text(h.whatsapp),
    broker: text(h.broker),
    grade: text(h.grade),
    email: text(h.email),
    gstin: text(h.gstin),
    updatedAt: new Date(),
    updatedById: ctx.user.id,
  };
  if (id) {
    const [before] = await db.select().from(erpSuppliers).where(eq(erpSuppliers.id, id));
    if (!before) return err("That party no longer exists.", "not_found");
    await db.update(erpSuppliers).set(values).where(eq(erpSuppliers.id, id));
    await erpAudit(ctx, "erp.supplier.edit", "erp_supplier", id, before, values);
    return okVoid(`${name} saved`);
  }
  const newId = erpId("erpsp");
  await db.insert(erpSuppliers).values({ id: newId, createdById: ctx.user.id, ...values });
  await erpAudit(ctx, "erp.supplier.create", "erp_supplier", newId, null, values);
  return okVoid(`${name} added`);
}

/** Purchases per supplier, once the purchase register exists (Phase 2). */
async function purchaseCountsBySupplier(): Promise<Map<string, number>> {
  const exists = (await db.execute(sql`select to_regclass('public.erp_purchases') is not null as ok`)) as unknown as { ok: boolean }[];
  if (!exists[0]?.ok) return new Map();
  const rows = (await db.execute(
    sql`select supplier_id as id, count(*)::int as n from erp_purchases group by supplier_id`,
  )) as unknown as { id: string; n: number }[];
  return new Map(rows.map((r) => [r.id, Number(r.n)]));
}

/* ============================================================ products */

async function packingForm(productId: string): Promise<FormSpec | null> {
  const [p] = await db
    .select({ name: products.name, pk: erpProductPacking })
    .from(products)
    .leftJoin(erpProductPacking, eq(erpProductPacking.productId, products.id))
    .where(eq(products.id, productId));
  if (!p) return null;
  const packItems = await db
    .select({ name: erpRawMaterials.name })
    .from(erpRawMaterials)
    .where(and(eq(erpRawMaterials.active, true), inArray(erpRawMaterials.materialType, ["Can", "Drum"])))
    .orderBy(asc(erpRawMaterials.name));
  let canUse = "";
  if (p.pk?.canUseMaterialId) {
    const [m] = await db.select({ name: erpRawMaterials.name }).from(erpRawMaterials).where(eq(erpRawMaterials.id, p.pk.canUseMaterialId));
    canUse = m?.name ?? "";
  }
  return {
    screen: "products",
    id: "packing",
    recordId: productId,
    title: "Packing for this SKU",
    sub: p.name,
    submit: "Save packing",
    init: {
      canUse,
      emptyBoxes: String(p.pk?.emptyBoxesRequired ?? 0),
      boxType: p.pk?.boxType ?? "",
      boxRate: rupeesField(p.pk?.boxRatePaise),
    },
    header: [
      { k: "canUse", l: "Can use (packing item)", t: "select", opts: packItems.map((x) => x.name), hint: "A raw material of type Can or Drum." },
      { k: "emptyBoxes", l: "No. of empty boxes required", t: "num", min: 0, hint: "0 with 1 can per box makes this a loose SKU." },
      { k: "boxType", l: "Box type", t: "select", opts: BOX_TYPES },
      { k: "boxRate", l: "Box rate (₹)", t: "num", min: 0, hint: "Used in packing costing." },
    ],
  };
}

const productsScreen: ScreenModule = {
  key: "products",
  async load(ctx) {
    const rows = await db
      .select({
        id: products.id,
        pid: products.externalCode,
        sku: products.name,
        lpcMl: products.millilitresPerCan,
        cpb: products.cansPerBox,
        weightGrams: products.weightGrams,
        active: products.active,
        sfg: productFormulations.name,
        fg: finishedGoods.name,
        emptyBoxes: erpProductPacking.emptyBoxesRequired,
        boxType: erpProductPacking.boxType,
        boxRate: erpProductPacking.boxRatePaise,
        canUseId: erpProductPacking.canUseMaterialId,
      })
      .from(products)
      .leftJoin(productFormulations, eq(productFormulations.id, products.formulationId))
      .leftJoin(finishedGoods, eq(finishedGoods.id, products.finishedGoodId))
      .leftJoin(erpProductPacking, eq(erpProductPacking.productId, products.id))
      .where(eq(products.active, true))
      .orderBy(asc(productFormulations.name), asc(products.name));
    const packNames = new Map(
      (await db.select({ id: erpRawMaterials.id, name: erpRawMaterials.name }).from(erpRawMaterials)).map((m) => [m.id, m.name]),
    );
    const all: Col[] = [
      { k: "pid", l: "Product id", t: "mono" },
      { k: "sfg", l: "SFG (liquid)", t: "t" },
      { k: "fg", l: "FG product", t: "b" },
      { k: "pack", l: "Packing item", t: "t" },
      { k: "lpc", l: "L per can", t: "n" },
      { k: "sku", l: "Description of goods (SKU)", t: "t", w: 260 },
      { k: "cpb", l: "Cans per box", t: "n" },
      { k: "boxes", l: "Empty boxes req.", t: "n" },
      { k: "boxType", l: "Box type", t: "t" },
      { k: "rate", l: "Box rate", t: "m", pw: "viewCost" },
      { k: "weight", l: "Weight kg", t: "n" },
      { k: "kind", l: "Sold as", t: "s" },
    ];
    const { cols, hidden, hiddenKeys } = visibleCols(all, has(ctx));
    return {
      spec: {
        screen: "products",
        cols,
        hidden,
        groups: ["sfg"],
        chips: "kind",
        noDataLine: "No products yet. The catalogue is maintained in the Admin Console → Catalogue.",
      },
      rows: rows.map((r) => {
        const cpb = r.cpb ?? 1;
        const empty = r.emptyBoxes ?? 0;
        const loose = cpb === 1 && empty === 0;
        return {
          id: r.id,
          v: withoutHidden(
            {
              pid: r.pid,
              sfg: r.sfg ?? "Unclassified",
              fg: r.fg ?? r.sku,
              pack: r.canUseId ? packNames.get(r.canUseId) ?? null : null,
              lpc: r.lpcMl == null ? null : r.lpcMl / 1000,
              sku: r.sku,
              cpb,
              boxes: empty,
              boxType: r.boxType,
              rate: r.boxRate,
              weight: r.weightGrams == null ? null : r.weightGrams / 1000,
              kind: loose ? "Loose" : "Boxed",
            },
            hiddenKeys,
          ),
          flags: [],
          title: r.sku,
          header: loose ? "Loose SKU · sold as cans from FG stock" : "Boxed SKU · sold as boxes from packing stock",
          actions: [{ id: "packing", l: "Edit packing", primary: true, loadsForm: true }],
        };
      }),
    };
  },
  formLoaders: {
    packing: (_ctx, id) => packingForm(id),
  },
  forms: {
    async packing(ctx, h, _l, id) {
      if (!id) return err("No product named.", "not_found");
      const canUse = text(h.canUse);
      let canUseId: string | null = null;
      if (canUse) {
        const [m] = await db
          .select({ id: erpRawMaterials.id })
          .from(erpRawMaterials)
          .where(and(eq(erpRawMaterials.name, canUse), inArray(erpRawMaterials.materialType, ["Can", "Drum"])));
        if (!m) return fieldErr("canUse", "Pick a raw material of type Can or Drum");
        canUseId = m.id;
      }
      const emptyBoxes = int(h.emptyBoxes) ?? 0;
      if (emptyBoxes < 0) return fieldErr("emptyBoxes", "Minus Quantity Not Allowed");
      const boxType = text(h.boxType);
      if (boxType && !BOX_TYPES.includes(boxType)) return fieldErr("boxType", "INVALID");
      const values = {
        canUseMaterialId: canUseId,
        emptyBoxesRequired: emptyBoxes,
        boxType,
        ...(ctx.powers.has("viewCost") ? { boxRatePaise: paise(h.boxRate) } : {}),
        updatedAt: new Date(),
        updatedById: ctx.user.id,
      };
      await db
        .insert(erpProductPacking)
        .values({ productId: id, ...values })
        .onConflictDoUpdate({ target: erpProductPacking.productId, set: values });
      await erpAudit(ctx, "erp.product.packing", "product", id, null, values);
      return okVoid("Packing saved");
    },
  },
};

/* =========================================================== customers */

export type CustomerRow = {
  id: string;
  name: string;
  city: string | null;
  area: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  gstin: string | null;
  creditDays: number | null;
  salesPerson: string | null;
  salesAmId: string | null;
  priceTag: string | null;
  freightTerm: string | null;
  deliveryType: string | null;
  companyName: string | null;
  status: string;
  kind: string;
  createdAt: Date;
  /**
   * This month's target, from the CRM's monthly targets — the one customer
   * target in MahekOne, set from the CRM's or Accounts' Monthly Targets. The
   * ERP kept a standing target of its own on the profile; two targets for one
   * customer is how a salesman and his manager argue about the same shop, so
   * 0183 carried it across and the ERP reads this one.
   */
  monthlyTargetPaise: number | null;
  p: typeof erpCustomerProfiles.$inferSelect | null;
};

export async function loadCustomers(where?: ReturnType<typeof and>): Promise<CustomerRow[]> {
  const base = or(eq(customers.kind, "customer"), isNotNull(erpCustomerProfiles.customerId));
  return (await db
    .select({
      id: customers.id,
      name: customers.name,
      city: customers.city,
      area: customers.area,
      phone: customers.phone,
      whatsapp: customers.whatsappPhone,
      email: customers.email,
      gstin: customers.gstin,
      creditDays: customers.creditDays,
      salesPerson: customers.salesPersonName,
      salesAmId: customers.salesAmId,
      priceTag: customers.priceTag,
      freightTerm: customers.freightTerm,
      deliveryType: customers.deliveryType,
      companyName: customers.companyName,
      status: customers.status,
      kind: customers.kind,
      createdAt: customers.createdAt,
      monthlyTargetPaise: sql<number | null>`(
        select t.target_amount from monthly_targets t
         where t.customer_id = customers.id
           and t.year = extract(year from now() at time zone ${APP_TIMEZONE})::int
           and t.month = extract(month from now() at time zone ${APP_TIMEZONE})::int
      )`.mapWith((v) => (v == null ? null : Number(v))),
      p: erpCustomerProfiles,
    })
    .from(customers)
    .leftJoin(erpCustomerProfiles, eq(erpCustomerProfiles.customerId, customers.id))
    .where(where ? and(base, where) : base)
    .orderBy(asc(customers.name))) as CustomerRow[];
}

/** The source's three party statuses, read off MahekOne's own columns. */
export function partyStatus(r: { status: string; p: { pendingActivation: boolean } | null }): "Active" | "Deactive" | "Pending" {
  if (r.status === "deactivated") return "Deactive";
  if (r.p?.pendingActivation) return "Pending";
  return "Active";
}

async function customerEditForm(id: string, mine = false): Promise<FormSpec | null> {
  const [r] = await loadCustomers(eq(customers.id, id));
  if (!r) return null;
  const [areas, states, transporters, counters, segments] = await Promise.all([
    refValues("area"),
    refValues("state"),
    refValues("transporter"),
    refValues("counterType"),
    refValues("segment"),
  ]);
  return {
    screen: mine ? "myCustomers" : "customers",
    id: "edit",
    recordId: id,
    title: `Edit ${r.name}`,
    sub: "Changes here are the ERP's. The name, the tagged sales person and the price list are set where the account is managed.",
    submit: "Save changes",
    init: {
      grade: r.p?.grade ?? "",
      area: r.area ?? "",
      city: r.city ?? "",
      state: r.p?.state ?? "",
      transporter: r.p?.transporter ?? "",
      pay: r.freightTerm ?? "",
      delivery: r.deliveryType ?? "",
      weight: r.p?.weightType ?? "",
      mobile: r.phone ?? "",
      whatsapp: r.whatsapp ?? "",
      email: r.email ?? "",
      counter: (r.p?.counterTypes ?? []).join("|"),
      credit: r.creditDays == null ? "" : String(r.creditDays),
      ...(mine
        ? {}
        : {
            segment: r.p?.segment ?? "",
            instr: r.p?.standingInstructions ?? "",
            gstin: r.gstin ?? "",
            company: r.companyName ?? "",
            allocate: r.p?.allocateEmail ?? "",
          }),
    },
    header: [
      { k: "grade", l: "Grade", t: "select", opts: GRADES },
      { k: "area", l: "Area", t: "select", opts: areas },
      { k: "city", l: "Location", t: "text" },
      { k: "state", l: "State", t: "select", opts: states },
      { k: "transporter", l: "Transport detail", t: "select", opts: transporters },
      { k: "pay", l: "Payment type", t: "select", opts: PAYMENT_TYPES },
      { k: "delivery", l: "Delivery type", t: "select", opts: DELIVERY_TYPES },
      { k: "weight", l: "Weight type", t: "select", opts: WEIGHT_TYPES },
      { k: "mobile", l: "Mobile no.", t: "text" },
      { k: "whatsapp", l: "WhatsApp contact", t: "text" },
      { k: "email", l: "Party email", t: "text" },
      { k: "counter", l: "Counter type", t: "multi", opts: counters },
      { k: "credit", l: "Credit days", t: "num", min: 0 },
      ...(mine
        ? []
        : ([
            { k: "segment", l: "Segment", t: "select", opts: segments },
            { k: "instr", l: "Standing instructions", t: "area", mic: true },
            { k: "gstin", l: "GST number", t: "text" },
            { k: "company", l: "Company name", t: "text" },
            { k: "allocate", l: "Allocate (email)", t: "text" },
          ] as FieldSpec[])),
    ],
  };
}

export async function customerForm(id: string, mine = false) {
  return customerEditForm(id, mine);
}

async function customerNewForm(ctx: ErpContext): Promise<FormSpec> {
  const [areas, states, salesPeople] = await Promise.all([refValues("area"), refValues("state"), salesPeopleNames()]);
  const tags = await priceTags();
  return {
    screen: "customers",
    id: "new",
    title: "New customer",
    sub: "Created as Pending. An admin activates it before its orders can move.",
    submit: "Create customer",
    header: [
      { k: "name", l: "Business name", t: "text", req: true },
      { k: "city", l: "City", t: "text", req: true },
      { k: "area", l: "Area", t: "select", opts: areas },
      { k: "state", l: "State", t: "select", opts: states },
      { k: "mobile", l: "Mobile", t: "text", req: true },
      { k: "sales", l: "Tagged sales person", t: "select", opts: salesPeople },
      { k: "priceList", l: "Price list", t: "select", opts: tags },
      { k: "credit", l: "Credit days", t: "num", def: "30", min: 0 },
    ],
    data: { self: ctx.user.name },
  };
}

async function salesPeopleNames(): Promise<string[]> {
  const rows = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.active, true))
    .orderBy(asc(users.name));
  return rows.map((r) => r.name);
}

async function priceTags(): Promise<string[]> {
  const rows = (await db.execute(
    sql`select distinct price_tag as t from customers where price_tag is not null order by 1`,
  )) as unknown as { t: string }[];
  return rows.map((r) => r.t);
}

function customerFields(r: CustomerRow, canSeeTarget: boolean): { l: string; v: string; der?: boolean }[] {
  return [
    { l: "State", v: r.p?.state || "—" },
    { l: "WhatsApp", v: r.whatsapp || "—" },
    { l: "Email", v: r.email || "—" },
    { l: "Transporter", v: r.p?.transporter || "—" },
    { l: "Payment type", v: r.freightTerm || "—" },
    { l: "Delivery type", v: r.deliveryType || "—" },
    { l: "Weight type", v: r.p?.weightType || "—" },
    { l: "Standing instructions", v: r.p?.standingInstructions || "—" },
    ...(canSeeTarget ? [{ l: "Monthly target", v: r.monthlyTargetPaise ? `${inr(r.monthlyTargetPaise)} this month · set in Monthly Targets` : "Not set · Monthly Targets in the CRM or Accounts" }] : []),
    { l: "Counter type", v: (r.p?.counterTypes ?? []).join(", ") || "—" },
    { l: "Segment", v: r.p?.segment || "—" },
    { l: "GST number", v: r.gstin || "—" },
    { l: "Company name", v: r.companyName || "—" },
    { l: "Allocate", v: r.p?.allocateEmail || "—" },
  ];
}

const customersScreen: ScreenModule = {
  key: "customers",
  async load(ctx) {
    const rows = await loadCustomers();
    const newForm = await customerNewForm(ctx);
    const canStatus = ctx.powers.has("customerStatus");
    const cols: ColSpec[] = [
      { k: "name", l: "Customer", t: "b" },
      { k: "status", l: "Status", t: "s" },
      { k: "city", l: "City", t: "t" },
      { k: "area", l: "Area", t: "t" },
      { k: "sales", l: "Sales person", t: "t" },
      { k: "priceList", l: "Price list", t: "t" },
      { k: "credit", l: "Credit days", t: "n" },
      { k: "mobile", l: "Mobile", t: "ph" },
      { k: "grade", l: "Grade", t: "s" },
      { k: "f", l: "Flags", t: "f" },
    ];
    const why = canStatus ? "" : "Only an admin or the office changes a customer's status";
    return {
      spec: { screen: "customers", cols, hidden: [], groups: ["status"], chips: "status", newForm, newLabel: "New customer" },
      rows: rows.map((r) => {
        const st = partyStatus(r);
        const actions: ActionSpec[] = [];
        if (st !== "Active")
          actions.push({ id: "activate", l: "Activate", primary: true, why, confirm: "Are You Sure! This Party Is Verified By Admin" });
        if (st !== "Deactive")
          actions.push({ id: "deactivate", l: "Deactivate", why, confirm: `Deactivate ${r.name}? New orders will not be accepted.` });
        if (st === "Active")
          actions.push({ id: "pend", l: "Mark Pending", why, confirm: "Are You Sure!" });
        actions.push({ id: "edit", l: "Edit details", loadsForm: true });
        return {
          id: r.id,
          v: {
            name: r.name,
            status: st,
            city: r.city,
            area: r.area,
            sales: r.salesPerson,
            priceList: r.priceTag,
            credit: r.creditDays,
            mobile: r.phone,
            grade: r.p?.grade ?? null,
          },
          flags: st === "Pending" ? ["pendingParty"] : [],
          title: r.name,
          fields: customerFields(r, ctx.powers.has("viewSalesAmounts")),
          contacts: phoneContacts(r.phone, r.email),
          actions,
          by: stampLine(null, r.createdAt),
        };
      }),
    };
  },
  formLoaders: {
    edit: (_ctx, id) => customerEditForm(id),
  },
  forms: {
    async new(ctx, h) {
      const name = text(h.name);
      if (!name) return fieldErr("name", "Business name is required");
      const city = text(h.city);
      if (!city) return fieldErr("city", "City is required");
      const mobile = (h.mobile ?? "").replace(/\D/g, "");
      if (mobile.length !== 10) return fieldErr("mobile", "INVALID");
      const dup = await db.select({ id: customers.id }).from(customers).where(sql`lower(${customers.name}) = lower(${name})`);
      if (dup.length) return fieldErr("name", "Duplicate Entry!");
      let salesAmId: string | null = null;
      const salesName = text(h.sales);
      if (salesName) {
        const [u] = await db.select({ id: users.id }).from(users).where(eq(users.name, salesName));
        salesAmId = u?.id ?? null;
      }
      const id = erpId("cust");
      /*
       * A NEW PARTY IS A LEAD until its first order, which is what `kind`
       * means everywhere in MahekOne; the ERP profile is what puts it on this
       * list before then, and `pending_activation` is the source's "Pending".
       */
      await db.transaction(async (tx) => {
        await tx.insert(customers).values({
          id,
          name,
          city,
          area: text(h.area),
          phone: mobile,
          kind: "lead",
          status: "active",
          creditDays: int(h.credit) ?? 30,
          priceTag: text(h.priceList),
          salesAmId,
          salesPersonName: salesName,
          ownerId: ctx.user.id,
          leadSource: "erp",
          createdById: ctx.user.id,
          updatedById: ctx.user.id,
        } as typeof customers.$inferInsert);
        await tx.insert(erpCustomerProfiles).values({
          customerId: id,
          state: text(h.state),
          pendingActivation: true,
          updatedById: ctx.user.id,
        });
      });
      await erpAudit(ctx, "erp.customer.create", "customer", id, null, { name, city });
      return okVoid(`${name} created as Pending · an admin activates it`);
    },
    async edit(ctx, h, _l, id) {
      if (!id) return err("No customer named.", "not_found");
      return saveCustomerDetails(ctx, id, h, false);
    },
  },
  actions: {
    async activate(ctx, id) {
      if (!ctx.powers.has("customerStatus")) return err("Only an admin or the office changes a customer's status.", "not_permitted");
      const [c] = await db.select({ status: customers.status, name: customers.name }).from(customers).where(eq(customers.id, id));
      if (!c) return err("That customer no longer exists.", "not_found");
      await db.transaction(async (tx) => {
        await tx
          .insert(erpCustomerProfiles)
          .values({ customerId: id, pendingActivation: false, activatedAt: new Date(), activatedById: ctx.user.id })
          .onConflictDoUpdate({
            target: erpCustomerProfiles.customerId,
            set: { pendingActivation: false, activatedAt: new Date(), activatedById: ctx.user.id, updatedAt: new Date() },
          });
        if (c.status === "deactivated") {
          await tx
            .update(customers)
            .set({ status: "active", statusDecidedAt: new Date(), updatedAt: new Date(), updatedById: ctx.user.id })
            .where(eq(customers.id, id));
        }
      });
      await erpAudit(ctx, "erp.customer.activate", "customer", id);
      return okVoid(`${c.name} is Active · its orders can move`);
    },
    async deactivate(ctx, id) {
      if (!ctx.powers.has("customerStatus")) return err("Only an admin or the office changes a customer's status.", "not_permitted");
      const [c] = await db.select({ name: customers.name }).from(customers).where(eq(customers.id, id));
      if (!c) return err("That customer no longer exists.", "not_found");
      await db
        .update(customers)
        .set({
          status: "deactivated",
          deactivatedAt: new Date(),
          deactivatedById: ctx.user.id,
          deactivationReason: "Deactivated in the ERP",
          statusDecidedAt: new Date(),
          updatedAt: new Date(),
          updatedById: ctx.user.id,
        })
        .where(eq(customers.id, id));
      await erpAudit(ctx, "erp.customer.deactivate", "customer", id);
      return okVoid(`${c.name} deactivated`);
    },
    async pend(ctx, id) {
      if (!ctx.powers.has("customerStatus")) return err("Only an admin or the office changes a customer's status.", "not_permitted");
      await db
        .insert(erpCustomerProfiles)
        .values({ customerId: id, pendingActivation: true, updatedById: ctx.user.id })
        .onConflictDoUpdate({ target: erpCustomerProfiles.customerId, set: { pendingActivation: true, updatedAt: new Date() } });
      await erpAudit(ctx, "erp.customer.pending", "customer", id);
      return okVoid("Marked Pending · an admin activates it");
    },
  },
};

export async function saveCustomerDetails(ctx: ErpContext, id: string, h: Record<string, string>, mine: boolean) {
  const [before] = await loadCustomers(eq(customers.id, id));
  if (!before) return err("That customer no longer exists.", "not_found");
  const grade = text(h.grade);
  if (grade && !GRADES.includes(grade)) return fieldErr("grade", "INVALID");
  const mobileDigits = (h.mobile ?? "").replace(/\D/g, "");
  if (mobileDigits && mobileDigits.length !== 10) return fieldErr("mobile", "INVALID");
  /* City and phone are required on every MahekOne customer, so an emptied
     field keeps what was there rather than blanking a column the CRM relies on. */
  const custValues = {
    area: text(h.area),
    city: text(h.city) ?? before.city ?? "",
    phone: mobileDigits || before.phone || "",
    whatsappPhone: text(h.whatsapp),
    email: text(h.email),
    creditDays: int(h.credit),
    freightTerm: text(h.pay),
    deliveryType: text(h.delivery),
    ...(mine ? {} : { gstin: text(h.gstin), companyName: text(h.company) }),
    updatedAt: new Date(),
    updatedById: ctx.user.id,
  };
  const profileValues = {
    grade,
    state: text(h.state),
    transporter: text(h.transporter),
    weightType: text(h.weight),
    counterTypes: multi(h.counter),
    ...(mine
      ? {}
      : { segment: text(h.segment), standingInstructions: text(h.instr), allocateEmail: text(h.allocate) }),
    updatedAt: new Date(),
    updatedById: ctx.user.id,
  };
  await db.transaction(async (tx) => {
    await tx.update(customers).set(custValues).where(eq(customers.id, id));
    await tx
      .insert(erpCustomerProfiles)
      .values({ customerId: id, ...profileValues })
      .onConflictDoUpdate({ target: erpCustomerProfiles.customerId, set: profileValues });
  });
  await erpAudit(ctx, mine ? "erp.myCustomer.edit" : "erp.customer.edit", "customer", id, before, { ...custValues, ...profileValues });
  return okVoid(`${before.name} updated`);
}

/* ============================================================= godowns */

async function godownForm(id?: string): Promise<FormSpec> {
  const cities = await refValues("godownCity");
  const states = await refValues("state");
  let init: Record<string, string> | undefined;
  if (id) {
    const [g] = await db.select().from(erpGodowns).where(eq(erpGodowns.id, id));
    if (g)
      init = {
        name: g.name,
        city: g.city ?? "",
        state: g.state ?? "",
        region: g.region ?? "",
        address: g.address ?? "",
        phone: g.phone ?? "",
        gstin: g.gstin ?? "",
        email: g.email ?? "",
        remark: g.remark ?? "",
        lat: g.lat == null ? "" : String(g.lat),
        lng: g.lng == null ? "" : String(g.lng),
      };
  }
  return {
    screen: "godowns",
    id: id ? "edit" : "new",
    recordId: id,
    title: id ? "Edit godown" : "Register a godown",
    sub: "The map pin is what lets a form default to the godown somebody is standing in (within 5 km).",
    submit: id ? "Save changes" : "Register godown",
    init,
    header: [
      { k: "name", l: "Godown name", t: "text", req: true },
      { k: "city", l: "Location (city)", t: "select", opts: cities.length ? cities : undefined },
      { k: "state", l: "State", t: "select", opts: states },
      { k: "region", l: "Region", t: "select", opts: REGIONS },
      { k: "address", l: "Address", t: "area" },
      { k: "phone", l: "Phone number", t: "text" },
      { k: "gstin", l: "GSTIN number", t: "text" },
      { k: "email", l: "Email ID", t: "text" },
      { k: "lat", l: "Latitude", t: "num", min: -90, max: 90 },
      { k: "lng", l: "Longitude", t: "num", min: -180, max: 180 },
      { k: "remark", l: "Remark", t: "area", mic: true },
    ],
  };
}

async function erpUsers(): Promise<{ id: string; name: string }[]> {
  return db
    .select({ id: users.id, name: users.name })
    .from(users)
    .innerJoin(appAccess, and(eq(appAccess.userId, users.id), eq(appAccess.app, "erp")))
    .where(eq(users.active, true))
    .orderBy(asc(users.name));
}

const godowns: ScreenModule = {
  key: "godowns",
  async load(ctx) {
    const rows = await db.select().from(erpGodowns).orderBy(asc(erpGodowns.name));
    const staff = await db
      .select({ godownId: erpGodownStaff.godownId, name: users.name })
      .from(erpGodownStaff)
      .innerJoin(users, eq(users.id, erpGodownStaff.userId));
    const people = await erpUsers();
    const byGodown = new Map<string, string[]>();
    staff.forEach((s) => byGodown.set(s.godownId, [...(byGodown.get(s.godownId) ?? []), s.name]));
    const admin = ctx.powers.has("employeeAdmin");
    const why = admin ? "" : "Only an ERP administrator changes a godown's status and staff";
    const newForm = await godownForm();
    const cols: ColSpec[] = [
      { k: "name", l: "Godown", t: "b" },
      { k: "region", l: "Region", t: "t" },
      { k: "state", l: "State", t: "t" },
      { k: "city", l: "City", t: "t" },
      { k: "address", l: "Address", t: "map" },
      { k: "phone", l: "Phone", t: "ph" },
      { k: "gstin", l: "GSTIN", t: "t" },
      { k: "emp", l: "Employees", t: "n" },
      { k: "status", l: "Status", t: "s" },
      { k: "f", l: "Flags", t: "f" },
    ];
    return {
      spec: { screen: "godowns", cols, hidden: [], groups: ["region"], chips: "state", newForm, newLabel: "Register godown" },
      rows: rows.map((g) => {
        const names = byGodown.get(g.id) ?? [];
        const actions: ActionSpec[] = g.reserved
          ? []
          : [
              {
                id: "staff",
                l: "Assign employees",
                primary: true,
                why,
                prompt: {
                  title: `Who works at ${g.name}`,
                  sub: "Only people holding the ERP are listed. A working location is chosen from these.",
                  submit: "Save",
                  fields: [{ k: "people", l: "Assigned employees", t: "multi", opts: people.map((p) => p.name) }],
                  init: { people: names.join("|") },
                },
              },
              { id: "edit", l: "Edit", why, loadsForm: true },
              { id: "toggle", l: g.status === "active" ? "Mark Inactive" : "Mark Active", why },
            ];
        return {
          id: g.id,
          v: {
            name: g.name,
            region: g.region,
            state: g.state,
            city: g.city,
            address: g.address,
            phone: g.phone,
            gstin: g.gstin,
            emp: names.length,
            status: g.status === "active" ? "Active" : "Inactive",
          },
          flags: g.reserved ? ["reserved"] : [],
          title: g.name,
          header: g.reserved ? "Reserved · write-offs only. Stock moved here is recorded as lost." : names.length ? `Assigned: ${names.join(", ")}` : "Nobody assigned yet",
          fields: [
            { l: "Email", v: g.email || "—" },
            { l: "Remark", v: g.remark || "—" },
            { l: "Map pin", v: g.lat != null && g.lng != null ? `${g.lat}, ${g.lng}` : "—" },
          ],
          contacts: [
            ...phoneContacts(g.phone, g.email),
            ...(g.lat != null && g.lng != null
              ? [{ l: "Open map", href: `https://maps.google.com/?q=${g.lat},${g.lng}` }]
              : g.address
                ? [{ l: "Open map", href: `https://maps.google.com/?q=${encodeURIComponent(g.address)}` }]
                : []),
          ],
          actions,
          by: stampLine(null, g.createdAt),
        };
      }),
    };
  },
  formLoaders: {
    edit: (_ctx, id) => godownForm(id),
  },
  forms: {
    async new(ctx, h) {
      return saveGodown(ctx, h);
    },
    async edit(ctx, h, _l, id) {
      return saveGodown(ctx, h, id);
    },
  },
  actions: {
    async toggle(ctx, id) {
      if (!ctx.powers.has("employeeAdmin")) return err("Only an ERP administrator changes a godown's status.", "not_permitted");
      const [g] = await db.select().from(erpGodowns).where(eq(erpGodowns.id, id));
      if (!g || g.reserved) return err("That godown cannot be changed.", "rule_violation");
      const status = g.status === "active" ? "inactive" : "active";
      await db.update(erpGodowns).set({ status, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpGodowns.id, id));
      await erpAudit(ctx, "erp.godown.status", "erp_godown", id, { status: g.status }, { status });
      return okVoid(`${g.name} is ${status === "active" ? "Active" : "Inactive"}`);
    },
    async staff(ctx, id, values) {
      if (!ctx.powers.has("employeeAdmin")) return err("Only an ERP administrator assigns godown staff.", "not_permitted");
      const names = multi(values.people);
      const people = await erpUsers();
      const ids = people.filter((p) => names.includes(p.name)).map((p) => p.id);
      await db.transaction(async (tx) => {
        await tx.delete(erpGodownStaff).where(eq(erpGodownStaff.godownId, id));
        if (ids.length) await tx.insert(erpGodownStaff).values(ids.map((userId) => ({ godownId: id, userId })));
      });
      await erpAudit(ctx, "erp.godown.staff", "erp_godown", id, null, { people: names });
      return okVoid(`${ids.length} employee${ids.length === 1 ? "" : "s"} assigned`);
    },
  },
};

async function saveGodown(ctx: ErpContext, h: Record<string, string>, id?: string) {
  if (!ctx.powers.has("employeeAdmin")) return err("Only an ERP administrator registers or edits godowns.", "not_permitted");
  const name = text(h.name);
  if (!name) return fieldErr("name", "Godown name is required");
  const dup = await db.select({ id: erpGodowns.id }).from(erpGodowns).where(sql`lower(${erpGodowns.name}) = lower(${name})`);
  if (dup.some((d) => d.id !== id)) return fieldErr("name", "Duplicate Entry!");
  const values = {
    name,
    city: text(h.city),
    state: text(h.state),
    region: text(h.region),
    address: text(h.address),
    phone: text(h.phone),
    gstin: text(h.gstin),
    email: text(h.email),
    remark: text(h.remark),
    lat: num(h.lat),
    lng: num(h.lng),
    updatedAt: new Date(),
    updatedById: ctx.user.id,
  };
  if (id) {
    const [before] = await db.select().from(erpGodowns).where(eq(erpGodowns.id, id));
    if (!before) return err("That godown no longer exists.", "not_found");
    if (before.reserved) return err("The reserved godown cannot be edited.", "rule_violation");
    await db.update(erpGodowns).set(values).where(eq(erpGodowns.id, id));
    await erpAudit(ctx, "erp.godown.edit", "erp_godown", id, before, values);
    return okVoid(`${name} saved`);
  }
  const newId = erpId("erpg");
  await db.insert(erpGodowns).values({ id: newId, createdById: ctx.user.id, ...values });
  await erpAudit(ctx, "erp.godown.create", "erp_godown", newId, null, values);
  return okVoid(`${name} registered`);
}

/* ========================================================= price lists */

const priceListsScreen: ScreenModule = {
  key: "priceLists",
  async load(ctx) {
    const rows = await db
      .select({
        id: priceListRates.id,
        list: priceLists.name,
        status: priceLists.status,
        product: products.name,
        raw: priceListRates.rawProductText,
        incl: priceListRates.rateInclGstPaise,
        excl: priceListRates.rateExGstPaise,
        listId: priceLists.id,
      })
      .from(priceListRates)
      .innerJoin(priceLists, eq(priceLists.id, priceListRates.priceListId))
      .leftJoin(products, eq(products.id, priceListRates.productId))
      .where(eq(priceLists.status, "published"))
      .orderBy(asc(priceLists.name));
    const disc = await db
      .select({ listId: priceListDiscountTerms.priceListId, bp: priceListDiscountTerms.percentBp })
      .from(priceListDiscountTerms);
    const discBy = new Map<string, number>();
    disc.forEach((d) => {
      if (d.bp != null && !discBy.has(d.listId)) discBy.set(d.listId, d.bp / 100);
    });
    const all: Col[] = [
      { k: "list", l: "Price list", t: "t" },
      { k: "product", l: "Product", t: "b" },
      { k: "rateIncl", l: "Rate incl. GST", t: "m", pw: "viewSalesRate" },
      { k: "rateExcl", l: "Rate excl. GST", t: "m", pw: "viewSalesRate" },
      { k: "discount", l: "Discount %", t: "n" },
    ];
    const { cols, hidden, hiddenKeys } = visibleCols(all, has(ctx));
    return {
      spec: {
        screen: "priceLists",
        cols,
        hidden,
        groups: ["list"],
        readOnly: true,
        noDataLine: "No published price list yet. Lists are written and published on the Price Desk.",
      },
      rows: rows.map((r) => ({
        id: r.id,
        v: withoutHidden(
          {
            list: r.list,
            product: r.product ?? r.raw ?? "Unmatched product",
            rateIncl: r.incl ?? (r.excl != null ? Math.round(r.excl * 1.18) : null),
            rateExcl: r.excl ?? (r.incl != null ? Math.round(r.incl / 1.18) : null),
            discount: discBy.get(r.listId) ?? null,
          },
          hiddenKeys,
        ),
        flags: [],
        title: r.product ?? r.raw ?? "Rate",
        header: "Price lists are written and published on the Price Desk. The ERP reads the published rates.",
      })),
    };
  },
};

/* ====================================================== reference lists */

const refListsScreen: ScreenModule = {
  key: "refLists",
  async load() {
    const rows = await db
      .select({ list: erpRefValues.listKey, value: erpRefValues.value, active: erpRefValues.active })
      .from(erpRefValues)
      .orderBy(asc(erpRefValues.listKey), asc(erpRefValues.sortOrder), asc(erpRefValues.value));
    const cols: ColSpec[] = [
      { k: "list", l: "List", t: "b" },
      { k: "count", l: "Values", t: "n" },
      { k: "sample", l: "Values", t: "t", w: 360 },
    ];
    return {
      spec: { screen: "refLists", cols, hidden: [] },
      rows: REF_LISTS.map((l) => {
        const vals = rows.filter((r) => r.list === l.key && r.active).map((r) => r.value);
        const retired = rows.filter((r) => r.list === l.key && !r.active).map((r) => r.value);
        return {
          id: l.key,
          v: {
            list: l.label,
            count: vals.length,
            sample: vals.slice(0, 6).join(", ") + (vals.length > 6 ? " …" : "") || "—",
          },
          flags: [],
          title: l.label,
          fields: [
            { l: "Active values", v: vals.join(", ") || "—" },
            { l: "Retired values", v: retired.join(", ") || "—" },
          ],
          actions: [
            {
              id: "add",
              l: "Add a value",
              primary: true,
              prompt: { title: `Add to ${l.label}`, submit: "Add value", fields: [{ k: "v", l: "Value", t: "text", req: true }] },
            },
            ...(vals.length
              ? [
                  {
                    id: "retire",
                    l: "Retire a value",
                    prompt: {
                      title: `Retire from ${l.label}`,
                      sub: "Records that already carry it keep it; new forms stop offering it.",
                      submit: "Retire",
                      fields: [{ k: "v", l: "Value", t: "select" as const, req: true, opts: vals }],
                    },
                  },
                ]
              : []),
            ...(retired.length
              ? [
                  {
                    id: "restore",
                    l: "Restore a value",
                    prompt: { title: `Restore to ${l.label}`, submit: "Restore", fields: [{ k: "v", l: "Value", t: "select" as const, req: true, opts: retired }] },
                  },
                ]
              : []),
          ],
        };
      }),
    };
  },
  actions: {
    async add(ctx, listKey, values) {
      const v = text(values.v);
      if (!v) return fieldErr("v", "Value is required");
      if (!REF_LISTS.some((l) => l.key === listKey)) return err("Not a list.", "not_found");
      const dup = await db
        .select({ id: erpRefValues.id })
        .from(erpRefValues)
        .where(and(eq(erpRefValues.listKey, listKey), sql`lower(${erpRefValues.value}) = lower(${v})`));
      if (dup.length) return fieldErr("v", "Duplicate Entry!");
      const [{ n }] = (await db.execute(
        sql`select coalesce(max(sort_order), 0) + 1 as n from erp_ref_values where list_key = ${listKey}`,
      )) as unknown as { n: number }[];
      await db.insert(erpRefValues).values({ id: erpId("erprv"), listKey, value: v, sortOrder: Number(n), createdById: ctx.user.id });
      await erpAudit(ctx, "erp.ref.add", "erp_ref_value", listKey, null, { value: v });
      return okVoid(`Added “${v}”`);
    },
    async retire(ctx, listKey, values) {
      const v = text(values.v);
      if (!v) return fieldErr("v", "Value is required");
      await db.update(erpRefValues).set({ active: false }).where(and(eq(erpRefValues.listKey, listKey), eq(erpRefValues.value, v)));
      await erpAudit(ctx, "erp.ref.retire", "erp_ref_value", listKey, null, { value: v });
      return okVoid(`Retired “${v}”`);
    },
    async restore(ctx, listKey, values) {
      const v = text(values.v);
      if (!v) return fieldErr("v", "Value is required");
      await db.update(erpRefValues).set({ active: true }).where(and(eq(erpRefValues.listKey, listKey), eq(erpRefValues.value, v)));
      await erpAudit(ctx, "erp.ref.restore", "erp_ref_value", listKey, null, { value: v });
      return okVoid(`Restored “${v}”`);
    },
  },
};

export const MASTER_SCREENS: ScreenModule[] = [
  rawMaterials,
  suppliers,
  productsScreen,
  customersScreen,
  godowns,
  priceListsScreen,
  refListsScreen,
];

