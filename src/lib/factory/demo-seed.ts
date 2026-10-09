import "server-only";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  appAccess,
  customers,
  erpBatchCodes,
  erpGodownStaff,
  erpOrderDetails,
  erpOrders,
  erpProductPacking,
  erpRawMaterials,
  erpRecipes,
  erpSfgLines,
  erpSuppliers,
  finishedGoods,
  productBrands,
  productFormulations,
  products,
  users,
  type User,
} from "@/db/schema";
import { hashPassword } from "@/lib/auth";
import { calendarDate } from "@/lib/business-date";
import type { ErpContext } from "@/lib/erp/access";
import { ERP_POWERS } from "@/lib/erp/powers";
import { approvedPoLine } from "@/lib/erp/po-fixture";
import { screenModule } from "@/lib/erp/screens";
import { rmLots } from "@/lib/erp/stock";
import { nextTaskId, teamDefaults, writeTeam } from "./server";

/* ---------------------------------------------------------------------------
 * A factory floor to look at: the design's people, products and orders, made
 * through the ERP's own handlers — purchases into lots, a mixing batch passed
 * by QC, fills, a complete packing batch and an open one — so what the app
 * shows is real stock, not rows typed into a stock table.
 *
 * For a local database and the integration test only. It refuses to run
 * twice: the second run would buy the drums again.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const GODOWN = "Bhiwandi";
const GODOWN_ID = "erpg_bhiwandi";

/** [key, name, phone, area, role label, badge, HR confirmed, app level] — the design's roster. */
export const FLOOR: [string, string, string, string, string, string | null, boolean, "associate" | "manager"][] = [
  ["vijay", "Vijay Deshmukh", "9822014142", "head", "Production Head", "EMP-0142", true, "manager"],
  ["rakesh", "Rakesh", "9850220207", "mixing", "Responsible", null, false, "associate"],
  ["anil", "Anil", "9850220231", "mixing", "Machine operator", "EMP-0231", false, "associate"],
  ["gangaram", "Gangaram", "9850220233", "mixing", "Helper", null, false, "associate"],
  ["sujit", "Sujit", "9850220240", "filling", "Responsible", null, false, "associate"],
  ["kamalkant", "Kamalkant", "9850220244", "filling", "Machine operator", "EMP-0244", false, "associate"],
  ["ramtih", "Ramtih", "9850220246", "filling", "Helper", null, false, "associate"],
  ["sunita", "Sunita Pawar", "9850220258", "packing", "Responsible", null, true, "associate"],
  ["ganesh", "Ganesh Shinde", "9850220262", "packing", "Operator", "EMP-0262", true, "associate"],
  ["lata", "Lata More", "9850220265", "packing", "Helper", null, true, "associate"],
  ["mahesh", "Mahesh Kale", "9850220270", "dispatch", "Responsible", null, true, "associate"],
  ["imran", "Imran Shaikh", "9850220275", "dispatch", "Lead loader", "EMP-0275", true, "associate"],
  ["bablu", "Bablu Yadav", "9850220278", "dispatch", "Helper", null, true, "associate"],
  ["pooja", "Pooja Nair", "9822010190", "qc", "Verifier", null, true, "associate"],
];

const TEAMS: Record<string, [string, string][]> = {
  mixing: [["rakesh", "owner"], ["anil", "operator"], ["gangaram", "helper"]],
  filling: [["sujit", "owner"], ["kamalkant", "operator"], ["ramtih", "helper"]],
  packing: [["sunita", "owner"], ["ganesh", "operator"], ["lata", "helper"]],
  dispatch: [["mahesh", "owner"], ["imran", "operator"], ["bablu", "helper"]],
};

function adminCtx(u: User): ErpContext {
  const g = { id: GODOWN_ID, name: GODOWN, reserved: false };
  return {
    user: u, actor: u, viewingAs: null, level: "admin", administrator: true, powers: new Set(ERP_POWERS),
    screens: new Set(["register", "sfgBatches", "fgFill", "packBatches"]), assignedGodowns: [g], workingGodown: g, designation: null, department: null,
  };
}

const must = (r: { ok: boolean; error?: string }, what: string) => {
  if (!r.ok) throw new Error(what + ": " + JSON.stringify(r));
};

export type SeededFloor = { users: Record<string, User>; skus: Record<string, string>; formulations: Record<string, string>; pin: string };

export async function seedFactoryFloor(opts: { pin?: string; date?: string } = {}): Promise<SeededFloor> {
  const pin = opts.pin ?? "1234";
  const today = opts.date ?? calendarDate(new Date());
  const [already] = (await db.execute(sql`select 1 from factory_staff limit 1`)) as unknown as unknown[];
  if (already) throw new Error("The factory floor is already seeded here.");

  /* ------------------------------------------------------------ people */
  const pinHash = await hashPassword(pin);
  const people: Record<string, User> = {};
  for (const [key, name, phone, area, label, badge, confirmed, level] of FLOOR) {
    const [u] = await db
      .insert(users)
      .values({ id: id("usr"), name, email: `${key}@factory.mahek.test`, phone, passwordHash: pinHash, role: level, initials: name.slice(0, 2).toUpperCase() })
      .returning();
    people[key] = u;
    await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app: "factory", role: level });
    await db.insert(erpGodownStaff).values({ godownId: GODOWN_ID, userId: u.id }).onConflictDoNothing();
    await db.execute(sql`
      insert into factory_staff (user_id, area, role_label, badge_code, pin_hash, hr_confirmed)
      values (${u.id}, ${area}, ${label}, ${badge}, ${pinHash}, ${confirmed})`);
  }
  for (const [proc, rows] of Object.entries(TEAMS))
    for (const [k, role] of rows)
      await db.execute(sql`insert into factory_team_defaults (proc, role, user_id) values (${proc}, ${role}, ${people[k].id}) on conflict do nothing`);
  const vijay = people.vijay;
  const ctx = adminCtx(vijay);

  /* ------------------------------------------------------------ masters */
  await db.insert(erpSuppliers).values({ id: "sup_fac", name: "Asian Solvents", partyCode: "AS" }).onConflictDoNothing();
  const RM: [string, string, string, string, string][] = [
    ["rm_tol", "Toluene", "TOL", "Litre", "Chemical"],
    ["rm_bac", "Butyl acetate", "BAC", "Litre", "Chemical"],
    ["rm_ipa", "Isopropyl alcohol", "IPA", "Litre", "Chemical"],
    ["rm_mto", "Mineral turpentine", "MTO", "Litre", "Chemical"],
    ["rm_xyl", "Xylene", "XYL", "Litre", "Chemical"],
    ["rm_mek", "MEK", "MEK", "Litre", "Chemical"],
    ["rm_can500", "Empty 500 ml can", "C500", "Unit", "Can"],
    ["rm_can1", "Empty 1 L can", "C1", "Unit", "Can"],
    ["rm_can5", "Empty 5 L can", "C5", "Unit", "Can"],
    ["rm_drum20", "Empty 20 L drum", "D20", "Unit", "Drum"],
    ["rm_boxa", "5-ply carton A", "BXA", "Unit", "Box"],
    ["rm_boxb", "5-ply carton B", "BXB", "Unit", "Box"],
    ["rm_box7", "7-ply carton", "BX7", "Unit", "Box"],
  ];
  const [{ n: serial0 }] = (await db.execute(sql`select coalesce(max(serial_no), 0)::int as n from erp_raw_materials`)) as unknown as { n: number }[];
  await db.insert(erpRawMaterials).values(RM.map(([rid, name, code, unit, type], i) => ({ id: rid, serialNo: serial0 + i + 1, name, code, unit, materialType: type, testingList: [] as string[], density: type === "Chemical" ? 0.87 : null })));

  const F: Record<string, { name: string; recipe: [string, number][] }> = {
    nc: { name: "NC Thinner base", recipe: [["rm_tol", 450], ["rm_bac", 200], ["rm_ipa", 150], ["rm_mto", 200]] },
    nano: { name: "Nano Thinner base", recipe: [["rm_tol", 320], ["rm_xyl", 280], ["rm_mek", 200]] },
    pu: { name: "PU Thinner base", recipe: [] },
  };
  const formulations: Record<string, string> = {};
  for (const [k, f] of Object.entries(F)) {
    const fid = id("form");
    formulations[k] = fid;
    await db.insert(productFormulations).values({ id: fid, name: f.name, slug: `fac-${k}-${fid.slice(-6)}` });
    for (const [rm, qty] of f.recipe) await db.insert(erpRecipes).values({ id: id("rec"), formulationId: fid, rawMaterialId: rm, qtyPerBatch: qty });
  }
  const brand: Record<string, string> = {};
  for (const [k, name] of [["nc", "Mahek NC Thinner"], ["nano", "Nano Thinner"], ["pu", "PU Thinner"]] as const) {
    brand[k] = id("brand");
    await db.insert(productBrands).values({ id: brand[k], name, slug: `fac-b-${k}-${brand[k].slice(-6)}`, formulationId: formulations[k] });
  }
  /* [key, base, ml, can, boxed: [cpb, carton] | null] */
  const FG: [string, "nc" | "nano" | "pu", number, string, [number, string] | null][] = [
    ["nc500", "nc", 500, "rm_can500", [24, "5-ply carton B"]],
    ["nc1", "nc", 1000, "rm_can1", [12, "5-ply carton A"]],
    ["nc5", "nc", 5000, "rm_can5", [4, "7-ply carton"]],
    ["nano20", "nano", 20000, "rm_drum20", null],
    ["pu1", "pu", 1000, "rm_can1", null],
  ];
  const skus: Record<string, string> = {};
  const fgIds: Record<string, string> = {};
  for (const [k, base, ml, can, boxed] of FG) {
    const fgId = id("fg");
    fgIds[k] = fgId;
    const label = ml < 1000 ? ml + " ml" : ml / 1000 + " L";
    await db.insert(finishedGoods).values({ id: fgId, name: `${base === "nc" ? "Mahek NC Thinner" : base === "nano" ? "Nano Thinner" : "PU Thinner"} ${label}`, slug: `fac-fg-${k}-${fgId.slice(-6)}`, brandId: brand[base], formulationId: formulations[base], millilitres: ml });
    const loose = id("sku");
    await db.insert(products).values({ id: loose, name: `${k.toUpperCase()} (Loose)`, finishedGoodId: fgId, brandId: brand[base], formulationId: formulations[base], millilitresPerCan: ml, cansPerBox: 1 });
    await db.insert(erpProductPacking).values({ productId: loose, canUseMaterialId: can, emptyBoxesRequired: 0 });
    skus[k] = loose;
    if (boxed) {
      const b = id("sku");
      await db.insert(products).values({ id: b, name: `${k.toUpperCase()} (${boxed[0]} Can/Box)`, finishedGoodId: fgId, brandId: brand[base], formulationId: formulations[base], millilitresPerCan: ml, cansPerBox: boxed[0] });
      await db.insert(erpProductPacking).values({ productId: b, canUseMaterialId: can, emptyBoxesRequired: 1, boxType: boxed[1] });
      skus[k + "Box"] = b;
    }
  }

  /* ------------------------------------------------------------ stock in */
  const buy = async (item: string, qty: number, unit: string) => {
    const po = await approvedPoLine("Asian Solvents", item, qty, { godown: GODOWN });
    must(await screenModule("register")!.forms!.new(ctx, { date: today, po: po.po, poLine: po.poLine, qty: String(qty), unit, rate: "100", gst: "18", company: "Mahek Marketing India", godown: GODOWN }, []), "buy " + item);
  };
  for (const [item, qty, unit] of [
    ["Toluene", 2400, "Litre"], ["Toluene", 1500, "Litre"], ["Butyl acetate", 1600, "Litre"], ["Isopropyl alcohol", 1200, "Litre"],
    ["Mineral turpentine", 2400, "Litre"], ["Xylene", 900, "Litre"], ["MEK", 900, "Litre"],
    ["Empty 500 ml can", 1900, "Pcs"], ["Empty 1 L can", 3400, "Pcs"], ["Empty 5 L can", 260, "Pcs"], ["Empty 20 L drum", 48, "Pcs"],
    ["5-ply carton A", 200, "Pcs"], ["5-ply carton B", 200, "Pcs"], ["7-ply carton", 100, "Pcs"],
  ] as [string, number, string][])
    await buy(item, qty, unit);

  /* Empty drums are counted company-wide from the drums chemicals arrive in
     (ERP spec A-16), not from a lot: say the toluene came in 48 of them. */
  await db.execute(sql`update erp_purchases set drums = 48 where lot_no = (select lot_no from erp_purchases order by created_at limit 1)`);

  /* The first lot of each material bought here — the drum a batch is poured from. */
  const lotOf = async (rmId: string) => (await rmLots()).filter((l) => l.rawMaterialId === rmId && l.godownId === GODOWN_ID).sort((x, y) => x.lotNo.localeCompare(y.lotNo))[0]?.lotNo;

  /* ------------------------------------------------------------ made already today */
  const mix = async (k: "nc" | "nano", batches: number, lossLitres: number) => {
    const lines = [];
    let loss = lossLitres;
    for (const [rm, qty] of F[k].recipe) {
      const [m] = await db.select().from(erpRawMaterials).where(eq(erpRawMaterials.id, rm));
      const adj = Math.min(loss, qty * batches);
      loss -= adj;
      lines.push({ item: m.name, lot: (await lotOf(rm))!, qty: String(qty), adjusted: String(adj) });
    }
    must(await screenModule("sfgBatches")!.forms!.new(ctx, { date: today, godown: GODOWN, product: F[k].name, batches: String(batches) }, lines), "mix " + k);
    const [line] = await db.select().from(erpSfgLines).where(eq(erpSfgLines.formulationId, formulations[k])).limit(1);
    must(await screenModule("sfgBatches")!.actions!.qcApprove(ctx, line.id, { note: "Seeded · passed" }), "qc " + k);
    return line.lotCode;
  };
  const ncLot = await mix("nc", 2, 160);
  const nanoLot = await mix("nano", 1, 20);

  const fill = async (k: string, sfgKey: "nc" | "nano", lot: string, cans: number, rej: number) => {
    const [f] = await db.select().from(finishedGoods).where(eq(finishedGoods.id, fgIds[k]));
    const can = FG.find((x) => x[0] === k)![3];
    const [m] = await db.select().from(erpRawMaterials).where(eq(erpRawMaterials.id, can));
    must(await screenModule("fgFill")!.forms!.new(ctx, { date: today, godown: GODOWN, sfg: F[sfgKey].name, sfgLot: lot, fg: f.name, size: String(f.millilitres / 1000), canUse: m.name, cans: String(cans), adjusted: String(rej) }, []), "fill " + k);
    const [row] = (await db.execute(sql`select lot_code as lot from erp_fg_fills order by created_at desc limit 1`)) as unknown as { lot: string }[];
    return row.lot;
  };
  const nc1a = await fill("nc1", "nc", ncLot, 604, 4);
  const nc1b = await fill("nc1", "nc", ncLot, 400, 0);
  const nc500 = await fill("nc500", "nc", ncLot, 600, 0);
  const nano = await fill("nano20", "nano", nanoLot, 18, 0);

  const pack = async (box: string, fgName: string, lot: string, boxes: number, cans: number, serial?: number) => {
    const [p] = await db.select().from(products).where(eq(products.id, skus[box]));
    must(await screenModule("packBatches")!.forms!.new(ctx, { date: today, godown: GODOWN, fg: fgName, sku: p.name, boxes: String(boxes), lot, cans: String(cans), ...(serial ? { serialFixed: String(serial) } : {}) }, []), "pack " + box);
    const [row] = (await db.execute(sql`select batch_no as no, batch_serial as serial from erp_pack_lines order by created_at desc limit 1`)) as unknown as { no: string; serial: number }[];
    return row;
  };
  const fgName = async (k: string) => (await db.select().from(finishedGoods).where(eq(finishedGoods.id, fgIds[k])))[0].name;
  const full = await pack("nc1Box", await fgName("nc1"), nc1a, 50, 600);
  await pack("nc500Box", await fgName("nc500"), nc500, 50, 18 * 24);

  /* ------------------------------------------------------------ orders */
  const cust = async (name: string, city: string, phone: string) => {
    const cid = id("cus");
    await db.insert(customers).values({ id: cid, name, city, phone, kind: "customer" });
    return cid;
  };
  const shree = await cust("Shree Paints & Hardware", "Pune", "9876500101");
  const balaji = await cust("Balaji Traders", "Nashik", "9876500102");
  const omsai = await cust("Om Sai Enterprises", "Indore", "9876500103");
  const [{ n: maxNo }] = (await db.execute(sql`select coalesce(max(order_no), 4020)::int as n from erp_orders`)) as unknown as { n: number }[];
  const order = async (no: number, c: string, sku: string, cans: number, status: string, transporter: string) => {
    const oid = id("ord");
    await db.insert(erpOrders).values({ id: oid, orderNo: no, orderDate: today, godownId: GODOWN_ID, billingCustomerId: c, deliveryCustomerId: c, skuId: sku, qtyCans: cans, status, dispatchOn: today, transporter });
    await db.insert(erpOrderDetails).values({ orderId: oid, dispatchStatus: "Pending", verification: "Pending" }).onConflictDoNothing();
    return oid;
  };
  const o1 = maxNo + 1, o2 = maxNo + 2, o3 = maxNo + 3;
  const l1 = await order(o1, shree, skus.nc1Box, 30 * 12, "Ready", "Sai Roadlines");
  const l2 = await order(o1, shree, skus.nano20, 6, "Ready", "Sai Roadlines");
  await db.insert(erpBatchCodes).values([
    { id: id("bc"), orderId: l1, lotFrom: "pack", lotCode: full.no, finishedGoodId: fgIds.nc1, godownId: GODOWN_ID, quantity: 30 },
    { id: id("bc"), orderId: l2, lotFrom: "fg", lotCode: nano, finishedGoodId: fgIds.nano20, godownId: GODOWN_ID, quantity: 6 },
  ]);
  await order(o2, balaji, skus.nc500Box, 12 * 24, "Hold From Office", "Om Logistics");
  await order(o3, omsai, skus.nc5Box, 15 * 4, "Under Process", "—");

  /* ------------------------------------------------------------ the day's work */
  const teams = await teamDefaults();
  const task = async (t: { proc: string; due: string; item?: string; batches?: number; target?: number; sfgLot?: string; out?: Record<string, unknown> }) => {
    const tid = await nextTaskId();
    await db.execute(sql`
      insert into factory_tasks (id, proc, godown_id, work_date, due, status, item, batches, target, sfg_lot, out, done_at, created_by_id)
      values (${tid}, ${t.proc}, ${GODOWN_ID}, ${today}::date, ${t.due}, ${t.out ? "done" : "ready"}, ${t.item ?? null}, ${t.batches ?? null}, ${t.target ?? null},
              ${t.sfgLot ?? null}, ${t.out ? JSON.stringify(t.out) : null}::jsonb, ${t.out ? sql`now()` : null}, ${vijay.id})`);
    await writeTeam(db, tid, teams[t.proc as "mixing"], vijay.id);
    return tid;
  };
  const nc1Key = fgIds.nc1 + ":1", nano20Key = fgIds.nano20 + ":20", nc5Key = fgIds.nc5 + ":5";
  await task({ proc: "mixing", due: "08:30", item: formulations.nc, batches: 2, out: { good: 1840, unit: "L", lot: ncLot, at: "08:42" } });
  await task({ proc: "mixing", due: "11:00", item: formulations.nc, batches: 1 });
  await task({ proc: "mixing", due: "15:00", item: formulations.nano, batches: 1 });
  await task({ proc: "filling", due: "09:30", item: nc1Key, target: 600, sfgLot: ncLot, out: { good: 600, rej: 4, unit: "cans", lot: nc1a, at: "09:20" } });
  await task({ proc: "filling", due: "13:00", item: nc1Key, target: 400, sfgLot: ncLot });
  await task({ proc: "filling", due: "16:00", item: nano20Key, target: 15, sfgLot: nanoLot });
  await task({ proc: "filling", due: "17:00", item: nc5Key, target: 20, sfgLot: ncLot });
  await task({ proc: "packing", due: "09:00", item: skus.nc1Box, target: 50, out: { good: 50, unit: "boxes", lot: full.no, at: "09:20" } });
  await task({ proc: "packing", due: "14:00", item: skus.nc1Box, target: 30 });
  await task({ proc: "packing", due: "17:00", item: skus.nc500Box, target: 50 });
  void nc1b;
  return { users: people, skus, formulations, pin };
}
