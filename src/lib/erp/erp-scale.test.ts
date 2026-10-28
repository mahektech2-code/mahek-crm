/**
 * THE ERP AT THE SIZE OF ITS OWN HISTORY.
 *
 * 22,154 order lines took the production server past its 320 MB heap: every
 * list built every row there had ever been to draw twenty-five of them, and
 * the sidebar badges read the whole order book three times a request. Every
 * register is now read through a window in SQL (`window.ts`) and every badge
 * through open work — and this suite is what holds the line. It seeds a book
 * the size of the real one, nearly all of it in months already past, and:
 *
 *  - loads EVERY built screen module as the page would, and fails if any
 *    builds more than `ROW_CAP` rows — a new screen that reads a whole table
 *    fails here, not in production;
 *  - checks the window cuts the register and never the work: an old open line
 *    is still on the working lists, a linked record still opens, a dashboard's
 *    ids still come back whatever their date;
 *  - checks "All time" is refused in words once it is too long to build;
 *  - and holds the page to what it DRAWS: a tab strip counts its own tabs, a
 *    heavy form stays on the server and comes back unchanged, a lot's rate
 *    kept between pages moves the moment a write could have moved it, and
 *    Billing & dispatch reads its orders together rather than one by one.
 *
 *   npm run test:integration
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, customers, erpCustomerProfiles, erpProductPacking, erpRawMaterials, erpSuppliers, finishedGoods, productBrands, productFormulations, products, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { calendarDate } from "@/lib/business-date";
import { erpContext } from "@/lib/erp/access";
import { allScreenModules, screenModule } from "@/lib/erp/screens";
import { erpCountsFor, erpNavCounts, salesCounts } from "@/lib/erp/counts";
import { ROW_CAP, STOCK_ROW_CAP, STOCK_WINDOW, scopeFor } from "@/lib/erp/window";
import { withReadMemo } from "@/lib/erp/read-memo";
import { shiftDays } from "@/lib/erp/period";
import { ERP_SCREENS } from "@/lib/erp/registry";
import { lazyForm, lightRow, lightSpec } from "@/lib/erp/lazy-forms";
import { NEW_FORM_ACTION } from "@/lib/erp/ui";
import { fgLevelAvailable, rmLevelAvailable, sfgRates } from "@/lib/erp/stock";
import { scanGateFor } from "@/lib/erp/dispatch";

const TODAY = calendarDate(new Date());
const HISTORY = 25_000;
const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
/* The catalogue is not truncated between suites, so its rows carry this run's tag. */
const tag = randomUUID().slice(0, 6);
const FRM = `frm_scale_${tag}`;
const BRD = `brd_scale_${tag}`;
const FG = `fg_scale_${tag}`;
const SKU = `sku_scale_${tag}`;

let admin: typeof users.$inferSelect;
const OLD_OPEN = "ord_scale_old_open";
/** A dispatched line from months ago, seeded with the rest of the history. */
const OLD_DONE = "ord_h7";

before(async () => {
  await db.execute(sql`
    truncate users, customers, erp_customer_profiles, erp_raw_materials, erp_suppliers, erp_inward, erp_tests, erp_purchases, erp_rm_entries,
             erp_sfg_lines, erp_sfg_entries, erp_fg_fills, erp_fg_entries, erp_pack_lines, erp_pack_entries, erp_transfers,
             erp_orders, erp_order_details, erp_batch_codes, erp_transports, erp_sfg_qc, erp_units, erp_unit_events,
             erp_user_powers, erp_godown_staff, erp_user_settings, audit_log restart identity cascade`);
  await db.execute(sql`update erp_series set last = 0`);
  const [u] = await db
    .insert(users)
    .values({ id: id("usr"), name: "Scale Admin", email: "scale.admin@erp.test", phone: "9820099999", passwordHash: "x", role: "admin", initials: "SA" })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app: "erp", role: "admin" });
  admin = u;

  await db.insert(customers).values({ id: "cus_scale", name: "Scale Paints", city: "Pune", phone: "9876599999", kind: "customer" });
  await db.insert(erpCustomerProfiles).values({ customerId: "cus_scale" });
  await db.insert(erpSuppliers).values({ id: "sup_scale", name: "Scale Solvents", partyCode: "SS" });
  await db.insert(erpRawMaterials).values({ id: "rm_scale", serialNo: 1, name: "Scale Toluene", code: "ST", unit: "Litre", materialType: "Chemical", density: 0.87, testingList: [] });
  await db.insert(productFormulations).values({ id: FRM, name: `Scale Thinner ${tag}`, slug: `scale-thinner-${tag}` });
  await db.insert(productBrands).values({ id: BRD, name: `Scale ${tag}`, slug: `scale-${tag}`, formulationId: FRM });
  await db.insert(finishedGoods).values({ id: FG, name: `Scale Thinner 1 L ${tag}`, slug: `scale-fg-${tag}`, brandId: BRD, formulationId: FRM, millilitres: 1000 });
  await db.insert(products).values({ id: SKU, name: `Scale Thinner 1 L ${tag} (Loose)`, finishedGoodId: FG, brandId: BRD, formulationId: FRM, millilitresPerCan: 1000, cansPerBox: 1 });
  await db.insert(erpProductPacking).values({ productId: SKU, emptyBoxesRequired: 0 });

  /* HISTORY: every row at least 40 days old, so none of it is in "this month" —
     spread over two years, as the real book is. `g` is the row number. */
  const old = (n: string) => sql.raw(`('${TODAY}'::date - (40 + (${n} % 760)))`);
  await db.execute(sql`
    insert into erp_orders (id, order_no, order_date, godown_id, billing_customer_id, delivery_customer_id, sku_id, qty_cans, status, entry_status, rate_paise, tally_bill_no, source, source_ref)
    select 'ord_h' || g, g, ${old("g")}, 'erpg_bhiwandi', 'cus_scale', 'cus_scale', ${SKU}, 6, 'Ready', 'Done', 10000, 'B' || g, 'sheet', 'L' || g
      from generate_series(1, ${HISTORY}) g`);
  await db.execute(sql`
    insert into erp_order_details (order_id, gst_bp, dispatch_status, dispatch_date, verification)
    select 'ord_h' || g, 1800, 'Dispatched', ${old("g")}, 'Verified' from generate_series(1, ${HISTORY}) g`);
  await db.execute(sql`
    insert into erp_sfg_lines (id, sfg_no, batch_date, godown_id, formulation_id, batches, raw_material_id, rm_lot_no, qty_per_batch, total_use, lot_code)
    select 'sfl_h' || g, g, ${old("g")}, 'erpg_bhiwandi', ${FRM}, 1, 'rm_scale', 'SSST' || (g % 3000), 10, 10, g || 'SSST' from generate_series(1, 12000) g`);
  await db.execute(sql`
    insert into erp_sfg_entries (id, source_type, source_id, entry_date, formulation_id, lot_code, godown_id, quantity)
    select 'sfe_h' || g, 'sfg', 'sfl_h' || g, ${old("g")}, ${FRM}, g || 'SSST', 'erpg_bhiwandi', 10 from generate_series(1, 12000) g`);
  await db.execute(sql`
    insert into erp_fg_fills (id, fg_num, fill_date, godown_id, formulation_id, sfg_lot_code, finished_good_id, can_size, packing_type, cans, lot_code)
    select 'fin_h' || g, g, ${old("g")}, 'erpg_bhiwandi', ${FRM}, g || 'SSST', ${FG}, 1, 'Can', 10, 'FG' || g from generate_series(1, 10000) g`);
  await db.execute(sql`
    insert into erp_fg_entries (id, source_type, source_id, entry_date, finished_good_id, lot_code, godown_id, quantity, sku_id)
    select 'fge_h' || g, 'fill', 'fin_h' || g, ${old("g")}, ${FG}, 'FG' || g, 'erpg_bhiwandi', 10, ${SKU} from generate_series(1, 10000) g`);
  await db.execute(sql`
    insert into erp_pack_lines (id, batch_serial, batch_no, pack_date, godown_id, finished_good_id, sku_id, boxes, fg_lot_code, cans)
    select 'fgp_h' || g, g, 'FP' || g, ${old("g")}, 'erpg_bhiwandi', ${FG}, ${SKU}, 1, 'FG' || g, 1 from generate_series(1, 10000) g`);
  await db.execute(sql`
    insert into erp_pack_entries (id, source_type, source_id, entry_date, sku_id, batch_no, godown_id, boxes)
    select 'pke_h' || g, 'batch', 'FP' || g, ${old("g")}, ${SKU}, 'FP' || g, 'erpg_bhiwandi', 1 from generate_series(1, 10000) g`);
  await db.execute(sql`
    insert into erp_purchases (id, pr_number, purchase_date, supplier_id, raw_material_id, lot_no, quantity, unit, rate_paise, available_litres, godown_id, source, status)
    select 'prb_h' || g, g, ${old("g")}, 'sup_scale', 'rm_scale', 'SSST' || g, 100, 'Litre', 9000, 100, 'erpg_bhiwandi', 'manual', 'Purchase Verified' from generate_series(1, 4000) g`);
  await db.execute(sql`
    insert into erp_rm_entries (id, source_type, source_id, entry_date, raw_material_id, lot_no, godown_id, quantity)
    select 'rme_h' || g, 'purchase', 'prb_h' || g, ${old("g")}, 'rm_scale', 'SSST' || g, 'erpg_bhiwandi', 100 from generate_series(1, 4000) g`);

  /* TODAY'S WORK: a handful of lines this month, and one open line from long
     ago — still Under Process — that no window may hide. */
  await db.execute(sql`
    insert into erp_orders (id, order_no, order_date, godown_id, billing_customer_id, delivery_customer_id, sku_id, qty_cans, status, entry_status)
    select 'ord_t' || g, ${HISTORY} + g, ${TODAY}::date, 'erpg_bhiwandi', 'cus_scale', 'cus_scale', ${SKU}, 6, 'Under Process', 'Not Done' from generate_series(1, 30) g`);
  await db.execute(sql`
    insert into erp_orders (id, order_no, order_date, godown_id, billing_customer_id, delivery_customer_id, sku_id, qty_cans, status, entry_status)
    values (${OLD_OPEN}, ${HISTORY + 100}, ${shiftDays(TODAY, -400)}::date, 'erpg_bhiwandi', 'cus_scale', 'cus_scale', ${SKU}, 6, 'Under Process', 'Not Done')`);
  await db.execute(sql`analyze`);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

async function ctx() {
  setTestUser(admin);
  return erpContext();
}
const page = (key: string, pd = "", extra: { ids?: string[]; open?: string } = {}) => {
  const mod = screenModule(key)!;
  return withReadMemo(async () => mod.load(await ctx(), scopeFor(mod.window, { pd, ids: extra.ids ?? null }, extra.open ?? null)));
};

describe("every screen, at the size of the real book", () => {
  test("no screen builds more than ROW_CAP rows on the page it opens on", async () => {
    const c = await ctx();
    const over: string[] = [];
    for (const mod of allScreenModules()) {
      const res = await withReadMemo(() => mod.load(c, scopeFor(mod.window, { pd: "", ids: null }, null)));
      // A stock screen's lots are summed in SQL first; it has its own, higher ceiling.
      if (res.rows.length > (mod.window === STOCK_WINDOW ? STOCK_ROW_CAP : ROW_CAP)) over.push(`${mod.key}: ${res.rows.length} rows`);
    }
    assert.deepEqual(over, [], "a screen read a whole history table — give it a window (window.ts) or read only open work");
  });

  test("the badges read open work, never the book", async () => {
    setTestUser(admin);
    const c = await withReadMemo(() => salesCounts());
    assert.equal(c.lines.length, 31, "today's thirty lines and the one old open line — none of the 25,000 dispatched");
  });
});

describe("the window cuts the register, never the work", () => {
  test("the orders register opens on this month", async () => {
    const res = await page("orders");
    assert.equal(res.rows.length, 30);
    assert.equal(res.tooWide ?? null, null);
  });

  test("an open line from a year ago is still on the working list", async () => {
    const res = await page("readyOrders");
    assert.ok(res.rows.some((r) => r.id === OLD_OPEN), "work is read by state, not by date");
  });

  test("a link to an old record opens it, outside the window", async () => {
    const res = await page("orders", "", { open: OLD_DONE });
    assert.ok(res.rows.some((r) => r.id === OLD_DONE));
    assert.equal(res.rows.length, 31);
  });

  test("a dashboard's ids come back whatever their dates", async () => {
    const res = await page("orders", "", { ids: [OLD_DONE, OLD_OPEN] });
    assert.deepEqual(res.rows.map((r) => r.id).sort(), [OLD_DONE, OLD_OPEN].sort());
  });

  test("all time on a register this long is refused in words, and builds nothing", async () => {
    const res = await page("orders", "all");
    assert.deepEqual(res.rows, []);
    assert.ok(res.tooWide && res.tooWide.n > ROW_CAP, JSON.stringify(res.tooWide));
  });

  test("a period that fits is read in full", async () => {
    const from = shiftDays(TODAY, -60);
    const to = shiftDays(TODAY, -40);
    const res = await page("orders", `c:${from}:${to}`);
    const [{ n }] = (await db.execute(sql`select count(*)::int as n from erp_orders where order_date between ${from}::date and ${to}::date`)) as unknown as { n: number }[];
    assert.equal(res.rows.length, Number(n));
    assert.ok(Number(n) > 0 && Number(n) <= ROW_CAP);
  });
});

describe("a page costs what it draws", () => {
  test("a tab strip counts its own tabs, the sidebar's way, and a strip with no badges counts nothing", async () => {
    /* Three bills waiting for dispatch verification, so the comparison is not of zeros. */
    await db.execute(sql`update erp_order_details set verification = 'Pending' where order_id in ('ord_h1', 'ord_h2', 'ord_h3')`);
    try {
      const c = await ctx();
      const all = await withReadMemo(() => erpNavCounts(c));
      for (const screen of ERP_SCREENS.filter((s) => (s.views?.length ?? 0) > 1 && c.screens.has(s.key))) {
        const keys = screen.views!.map((v) => v.key);
        const strip = await withReadMemo(() => erpCountsFor(c, keys.join(",")));
        for (const k of keys) assert.equal(strip[k] ?? 0, all[k] ?? 0, `${screen.key} · ${k}`);
      }
      assert.equal((await withReadMemo(() => erpCountsFor(c, "orderDetails"))).orderDetails, 3);
      assert.deepEqual(await withReadMemo(() => erpCountsFor(c, "rmStock,sfgStock,fgStock,packStock")), {});
    } finally {
      await db.execute(sql`update erp_order_details set verification = 'Verified' where order_id in ('ord_h1', 'ord_h2', 'ord_h3')`);
    }
  });

  test("a heavy form stays on the server, and what comes back is the form the list would have sent", async () => {
    const c = await ctx();
    let heavy = 0;
    for (const mod of allScreenModules()) {
      const built = await withReadMemo(() => mod.load(c, scopeFor(mod.window, { pd: "", ids: null }, null)));
      const deferred = await withReadMemo(() => mod.load(c, { ...scopeFor(mod.window, { pd: "", ids: null }, null), forms: "defer" }));
      /* A deferred New button never promises a form that would not exist, and a form that is not deferred is unchanged. */
      if (deferred.spec.newFormLazy) assert.ok(built.spec.newForm, `${mod.key} says it has a New form it does not build`);
      else assert.deepEqual(deferred.spec.newForm, built.spec.newForm, mod.key);
      if (lightSpec(built.spec).newFormLazy) {
        heavy++;
        assert.deepEqual(await lazyForm(c, mod, NEW_FORM_ACTION, ""), built.spec.newForm, mod.key);
      }
      for (const r of built.rows.slice(0, 3)) {
        const light = lightRow(mod, r);
        for (const a of light.actions ?? []) {
          const was = r.actions!.find((x) => x.id === a.id)!;
          if (a.loadsForm && was.form) assert.deepEqual(await lazyForm(c, mod, a.id, r.id), was.form, `${mod.key} ${a.id}`);
        }
      }
    }
    assert.ok(heavy > 0, "at the size of the real book some New form is heavy, or this test proves nothing");
  });

  test("a lot's rate kept between pages moves the moment a write could have moved it", async () => {
    setTestUser(admin);
    const before = (await sfgRates(["1SSST"])).get("1SSST");
    assert.ok(before != null, "the seeded batch has a rate");
    await db.execute(sql`update erp_purchases set rate_paise = rate_paise * 2 where lot_no = 'SSST1'`);
    try {
      const after = (await sfgRates(["1SSST"])).get("1SSST");
      assert.notEqual(after, before, "the raw material's new rate reaches the batch made from it");
    } finally {
      await db.execute(sql`update erp_purchases set rate_paise = rate_paise / 2 where lot_no = 'SSST1'`);
    }
  });

  test("an order write keeps the stock ledgers, and the reads that name orders still move with it", async () => {
    setTestUser(admin);
    const client = db.$client as unknown as { unsafe: (...a: unknown[]) => unknown };
    const unsafe = client.unsafe;
    const seen: string[] = [];
    client.unsafe = (...a: unknown[]) => {
      seen.push(String(a[0]));
      return unsafe.apply(db.$client, a);
    };
    const ledgerReads = async (fn: () => Promise<unknown>) => {
      seen.length = 0;
      await withReadMemo(fn);
      return seen.filter((q) => !q.includes("erp_ledger_ticks"));
    };
    try {
      const stock = async () => {
        await fgLevelAvailable();
        await sfgRates(["1SSST"]);
      };
      await ledgerReads(stock);
      assert.deepEqual(await ledgerReads(stock), [], "nothing moved, so nothing is read again");
      /* Ready, verify, bill, stickers: a status click is a write to erp_orders and nothing else. */
      await db.execute(sql`update erp_orders set updated_at = updated_at where id = ${OLD_OPEN}`);
      assert.deepEqual(await ledgerReads(stock), [], "an order write moves no stock, so no ledger is read again");
      await db.execute(sql`update erp_purchases set rate_paise = rate_paise where lot_no = 'SSST1'`);
      assert.ok((await ledgerReads(stock)).length > 0, "a raw-material write does move the costing");

      /* Drums sold reads the order book, so an order write has to reach it. */
      await ledgerReads(() => rmLevelAvailable());
      await db.execute(sql`update erp_orders set updated_at = updated_at where id = ${OLD_OPEN}`);
      const again = await ledgerReads(() => rmLevelAvailable());
      assert.equal(again.length, 1, "only the read that names orders is asked again");
      assert.match(again[0], /erp_orders/);
    } finally {
      client.unsafe = unsafe;
    }
  });

  test("Billing & dispatch reads its orders together, so thirty cost what five do", async () => {
    const lines = (await db.execute(sql`select id from erp_orders where id like 'ord_t%' order by order_no`)) as unknown as { id: string }[];
    const client = db.$client as unknown as { unsafe: (...a: unknown[]) => unknown };
    const unsafe = client.unsafe;
    let n = 0;
    client.unsafe = (...a: unknown[]) => {
      n++;
      return unsafe.apply(db.$client, a);
    };
    try {
      /* Configuration is kept for thirty seconds: read it before counting, so neither count carries it. */
      await scanGateFor(db, lines.slice(0, 1).map((l) => l.id));
      const statements = async (ids: string[]) => {
        n = 0;
        const gate = await scanGateFor(db, ids);
        assert.equal(gate.size, ids.length);
        return n;
      };
      const five = await statements(lines.slice(0, 5).map((l) => l.id));
      const thirty = await statements(lines.map((l) => l.id));
      assert.equal(lines.length, 30);
      assert.ok(five > 0, "the statements are being counted");
      assert.equal(thirty, five, "one more order is not three more statements");
    } finally {
      client.unsafe = unsafe;
    }
  });
});
