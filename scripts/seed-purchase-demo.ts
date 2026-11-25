/**
 * A purchase desk to look at locally: suppliers, items, requirements, POs,
 * receipts, tests and register lots — made through the ERP's own handlers, so
 * every stage, flag and count on the purchase screens is the real thing.
 *
 *   npx tsx --conditions=react-server --env-file=.env.local scripts/seed-purchase-demo.ts
 *
 * DEV ONLY. Refuses production and a database that already has requirements.
 */
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { appSettings, erpGodowns, erpQuoteCells, erpQuoteColumns, erpQuoteRows, erpRawMaterials, erpRequisitions, erpSuppliers, users } from "@/db/schema";
import type { ErpContext } from "@/lib/erp/access";
import { ERP_POWERS } from "@/lib/erp/powers";
import { screenModule } from "@/lib/erp/screens";
import { applyQuoteOps } from "@/lib/erp/quotes";
import { approvedPo } from "@/lib/erp/po-fixture";
import { invalidateConfig } from "@/lib/config/store";
import { calendarDate } from "@/lib/business-date";
import { moduleKeysForApp } from "@/lib/modules";

const mod = (k: string) => {
  const m = screenModule(k);
  if (!m) throw new Error(`no module ${k}`);
  return m;
};
const must = <T extends { ok: boolean }>(r: T, what: string): T => {
  if (!r.ok) throw new Error(`${what}: ${JSON.stringify(r)}`);
  return r;
};
const day = (offset: number) => calendarDate(new Date(Date.now() + offset * 86400000));

async function main() {
  if (/one\.mahekindia|prod/i.test(process.env.DATABASE_URL ?? "")) throw new Error("Not on production.");
  const [already] = (await db.execute(sql`select 1 from erp_requisitions limit 1`)) as unknown as unknown[];
  if (already) throw new Error("This database already has purchase requirements.");

  await db
    .insert(appSettings)
    .values({ key: "erp.stockCheck.onRequirement", value: false, valueType: "boolean", category: "erp", label: "Count stock before every purchase requirement" })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: false } });
  invalidateConfig();

  const [u] = await db.select().from(users).where(eq(users.email, "vikram@mahek.in"));
  const [g] = await db.select().from(erpGodowns).where(eq(erpGodowns.name, "Bhiwandi"));
  const erpScreens = moduleKeysForApp("erp").map((k) => k.replace(/^erp\./, ""));
  const ctx: ErpContext = {
    user: u, actor: u, viewingAs: null, level: "admin", administrator: true, powers: new Set(ERP_POWERS),
    screens: new Set(erpScreens), assignedGodowns: [{ id: g.id, name: g.name, reserved: false }], workingGodown: { id: g.id, name: g.name, reserved: false }, designation: null, department: null,
  } as ErpContext;

  await db.insert(erpSuppliers).values([
    { id: "sup_shree", name: "Shree Chemicals", partyCode: "SC", whatsapp: "9820012345", creditDays: 30 },
    { id: "sup_guj", name: "Gujarat Petro", partyCode: "GP", whatsapp: "9820012346", creditDays: 45 },
    { id: "sup_amb", name: "Ambica Packaging", partyCode: "AP", whatsapp: "9820012347", creditDays: 15 },
    { id: "sup_asian", name: "Asian Solvents", partyCode: "AS", creditDays: 30 },
  ]).onConflictDoNothing();
  const base = (await db.execute(sql`select coalesce(max(serial_no),0)::int as n from erp_raw_materials`)) as unknown as { n: number }[];
  let sn = base[0]?.n ?? 0;
  const rm = (id: string, name: string, code: string, unit: string, materialType: string, extra: Partial<typeof erpRawMaterials.$inferInsert>) => ({ id, serialNo: ++sn, name, code, unit, materialType, ...extra });
  await db.insert(erpRawMaterials).values([
    rm("rm_tol", "Toluene", "TOL", "Litre", "Chemical", { density: 0.87, testingList: ["Smell", "Density"], purchaseMethod: "quotation" }),
    rm("rm_xyl", "Xylene", "XYL", "Litre", "Chemical", { density: 0.86, testingList: ["Smell", "Density"], purchaseMethod: "quotation" }),
    rm("rm_mto", "Mineral turpentine oil", "MTO", "Litre", "Chemical", { density: 0.79, testingList: ["Smell"], purchaseMethod: "quotation" }),
    rm("rm_base", "Base oil SN-150", "BO150", "Litre", "Chemical", { density: 0.86, testingList: ["Density"], purchaseMethod: "quotation" }),
    rm("rm_resin", "Resin R-40", "R40", "Kg", "Chemical", { density: 1.1, testingList: [], purchaseMethod: "quotation" }),
    rm("rm_can", "1 L HDPE can", "CAN1", "Unit", "Can", { testingList: [], purchaseMethod: "direct", preferredSupplierId: "sup_amb", pricePaise: 640 }),
    rm("rm_label", "Label roll 50x80", "LBL", "Unit", "Stationary", { testingList: [], purchaseMethod: "direct", preferredSupplierId: "sup_amb", pricePaise: 31000 }),
    rm("rm_box", "5-ply carton", "BOX5", "Unit", "Box", { testingList: [], purchaseMethod: "direct", preferredSupplierId: "sup_amb", pricePaise: 2400 }),
    rm("rm_seal", "200 L MS drum", "DRM200", "Unit", "Drum", { testingList: [], purchaseMethod: "buyer" }),
  ]).onConflictDoNothing();

  const raise = async (department: string, items: [string, string, string][], requiredBy: string, priority = "Medium", date = day(-3)) =>
    must(
      await mod("requisitions").forms!.new(ctx, { date, requiredBy, department, godown: "Bhiwandi" }, items.map(([type, item, required]) => ({ type, item, required, priority }))),
      `raise ${department}`,
    );
  await raise("Mixing & Blending", [["Chemical", "Toluene", "3200"], ["Chemical", "Xylene", "1600"], ["Chemical", "Base oil SN-150", "12000"]], day(-1), "Urgent", day(-5));
  await raise("Packing", [["Stationary", "Label roll 50x80", "40"], ["Box", "5-ply carton", "2000"]], day(3), "Medium", day(-2));
  await raise("Refilling", [["Can", "1 L HDPE can", "5000"], ["Drum", "200 L MS drum", "40"]], day(-6), "High", day(-9));
  await raise("Mixing & Blending", [["Chemical", "Mineral turpentine oil", "2000"], ["Chemical", "Resin R-40", "600"]], day(5), "Medium", day(-1));

  const req = async (rawMaterialId: string) => (await db.select().from(erpRequisitions).where(eq(erpRequisitions.rawMaterialId, rawMaterialId)))[0];

  /* Quotation manager: rates, and Base oil bought there (PO minted), then linked. */
  await db.insert(erpQuoteColumns).values([
    { id: "eqc_toluene", position: 1, pack: "Drum", name: "Toluene", brand: "Reliance", rawMaterialId: "rm_tol" },
    { id: "eqc_xylene", position: 2, pack: "Drum", name: "Xylene", brand: "", rawMaterialId: "rm_xyl" },
    { id: "eqc_baseoil", position: 3, pack: "Tanker", name: "Base oil SN-150", brand: "", rawMaterialId: "rm_base" },
    { id: "eqc_mtooil", position: 4, pack: "Drum", name: "MTO", brand: "", rawMaterialId: "rm_mto" },
  ]);
  await db.insert(erpQuoteRows).values([
    { id: "eqr_guj001", quoteDate: day(-4), party: "Gujarat Petro", supplierId: "sup_guj" },
    { id: "eqr_shree01", quoteDate: day(-3), party: "Shree Chemicals", supplierId: "sup_shree" },
    { id: "eqr_asian01", quoteDate: day(-2), party: "Asian Solvents", supplierId: "sup_asian" },
  ]);
  await db.insert(erpQuoteCells).values([
    { rowId: "eqr_guj001", columnId: "eqc_baseoil", value: "92", status: "ready" },
    { rowId: "eqr_guj001", columnId: "eqc_toluene", value: "104" },
    { rowId: "eqr_shree01", columnId: "eqc_toluene", value: "101", status: "ready" },
    { rowId: "eqr_shree01", columnId: "eqc_xylene", value: "96" },
    { rowId: "eqr_asian01", columnId: "eqc_toluene", value: "103" },
    { rowId: "eqr_asian01", columnId: "eqc_xylene", value: "94" },
    { rowId: "eqr_asian01", columnId: "eqc_mtooil", value: "71" },
  ]);
  const bought = must(await applyQuoteOps(ctx, [{ op: "cell", rowId: "eqr_guj001", columnId: "eqc_baseoil", status: "po", drums: 60 } as never]), "buy base oil");
  const basePo = (bought as unknown as { data: { minted: { poNo: string }[] } }).data.minted[0].poNo;
  must(await mod("requisitions").actions!.linkPo(ctx, (await req("rm_base")).id, { poNo: basePo }), "link base oil");
  /* Toluene bought too, but not yet linked — "stuck between steps". */
  must(await applyQuoteOps(ctx, [{ op: "cell", rowId: "eqr_shree01", columnId: "eqc_toluene", status: "po", drums: 16 } as never]), "buy toluene");

  /* Direct purchase: cartons get a PO, cans and labels wait. */
  must(await mod("requisitions").actions!.createPo(ctx, (await req("rm_box")).id, { vendor: "Ambica Packaging", qty: "2000", deliverTo: "Bhiwandi", deliveryDate: day(0), terms: "15 days credit" }), "carton PO");

  /* Older POs for the receipt side. */
  const older = await approvedPo("Shree Chemicals", [{ item: "Toluene", quantity: 1800, ratePaise: 10100 }, { item: "Resin R-40", quantity: 800, ratePaise: 21000 }]);
  const asian = await approvedPo("Asian Solvents", [{ item: "Xylene", quantity: 1000, ratePaise: 9400 }]);
  await approvedPo("Asian Solvents", [{ item: "Mineral turpentine oil", quantity: 1200, ratePaise: 7100 }]);

  const NONE = "No Transport Charges";
  /* Base oil partly in. */
  const baseForm = await mod("purchaseOrders").load(ctx);
  void baseForm;
  must(await mod("inward").forms!.new(ctx, { date: day(-1), po: basePo, godown: "Bhiwandi", transportMode: NONE }, [{ poLine: "1. Base oil SN-150", drums: "40", qty: "8000" }]), "receive base oil");
  must(await mod("inward").forms!.new(ctx, { date: day(-2), po: older.po, godown: "Bhiwandi", transportMode: NONE }, [
    { poLine: older.lines["Toluene"], drums: "10", qty: "1800" },
    { poLine: older.lines["Resin R-40"], drums: "4", weight: "820", emptyDrum: "5" },
  ]), "receive toluene + resin");
  must(await mod("inward").forms!.new(ctx, { date: day(0), po: asian.po, godown: "Bhiwandi", transportMode: NONE }, [{ poLine: asian.lines["Xylene"], drums: "5", qty: "1000" }]), "receive xylene");

  /* One test recorded, others waiting. */
  const t = await mod("testing").load(ctx);
  const line = (t.spec.newForm?.header.find((f) => f.k === "line")?.opts ?? [])[0];
  if (line) await mod("testing").forms!.new(ctx, { line, tester: u.id, date: day(-1), godown: "Bhiwandi", smell: "Good", density: "0.87" }, []);

  /* A bill number on one lot, so the register shows every stage. */
  const reg = await mod("register").load(ctx);
  const resin = reg.rows.find((r) => r.v.item === "Resin R-40");
  if (resin) await mod("register").actions!.billReceived(ctx, resin.id, { billNo: "SC/2611" });

  console.log("Seeded the purchase desk. Sign in as vikram@mahek.in and open /erp/requisitions.");
  await db.$client.end();
}

main().catch(async (e) => {
  console.error(e);
  await db.$client.end();
  process.exit(1);
});
