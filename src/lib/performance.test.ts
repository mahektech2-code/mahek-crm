/**
 * Salesman targets and the score, end to end.
 *
 *   npm run test:performance
 *
 * The engine tests next door pin the arithmetic. What these pin is everything
 * between the ledger and that arithmetic — which is where this module can go
 * wrong without anybody noticing, because a wrong attribution and a right one
 * produce equally plausible numbers.
 *
 * They need mahekone_test, which `npm run test:db` creates from the committed
 * migrations. The harness truncates between tests.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import {
  customers,
  finishedGoods,
  orders,
  paymentReceipts,
  productBrands,
  productFormulations,
  products,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { creditedTo } from "@/lib/sales-attribution";
import {
  actualsForPeriod,
  readingsForPeriod,
  recomputeSalesPerformance,
  unattributedForPeriod,
} from "@/lib/services/performance-service";

/* ------------------------------------------------------------------ harness */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let TODAY: string;
let PERIOD: string;
let manager: typeof users.$inferSelect;
let rahul: typeof users.$inferSelect; // a field salesman
let poonam: typeof users.$inferSelect; // back office / telecaller

/** Mid-month, so a window that is wrong by a day is still inside the month. */
const dayIn = (n: number) => `${PERIOD}-${String(n).padStart(2, "0")}`;
const at = (n: number, time = "09:00:00") =>
  new Date(`${dayIn(n)}T${time}+05:30`);

async function makeUser(name: string, role: "telecaller" | "manager") {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase()}-${randomUUID().slice(0, 4)}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  return row;
}

async function makeCustomer(over: Partial<typeof customers.$inferInsert> = {}) {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: over.name ?? `Shop ${randomUUID().slice(0, 6)}`,
      contactPerson: "Contact",
      phone: String(9000000000 + Math.floor(Math.random() * 999999999)),
      city: "Mumbai",
      ownerId: manager.id,
      ...over,
    })
    .returning();
  return row;
}

/**
 * An order the way the sheet projects one: lines carrying the product NAME,
 * cans, and the money. That is the shape almost all real data is in.
 */
async function makeOrder(
  customerId: string,
  lines: { product: string; cans: number; amountPaise: number }[],
  over: Partial<typeof orders.$inferInsert> = {},
) {
  const total = lines.reduce((s, l) => s + l.amountPaise, 0);
  const [row] = await db
    .insert(orders)
    .values({
      id: id("ord"),
      customerId,
      source: "external",
      status: "dispatched", // a purchase status
      orderedAt: over.orderedAt ?? at(10),
      totalAmount: total,
      lineItems: lines.map((l) => ({
        product: l.product,
        quantity: l.cans,
        unitPrice: l.cans ? Math.round(l.amountPaise / l.cans) : 0,
        amount: l.amountPaise,
      })),
      ...over,
    })
    .returning();
  return row;
}

/** Enough of a catalogue for the mix to have something to classify. */
async function seedCatalogue() {
  const formulations = [
    { slug: "mahekuniversal", name: "Mahek Universal", category: "pcat_universal" },
    { slug: "m5x4", name: "M5x4", category: "pcat_nano" },
    { slug: "puthinnerm16", name: "PU Thinner M16", category: "pcat_pu" },
    { slug: "enamelthinner", name: "Enamel Thinner", category: null },
  ];
  for (const f of formulations) {
    const fid = id("frm");
    await db.insert(productFormulations).values({
      id: fid,
      name: f.name,
      slug: f.slug,
      categoryId: f.category,
    });
    const bid = id("brd");
    await db
      .insert(productBrands)
      .values({ id: bid, name: `${f.name} Thinner`, slug: `${f.slug}b`, formulationId: fid });
    const gid = id("fgd");
    await db.insert(finishedGoods).values({
      id: gid,
      name: `${f.name} 20 Liter`,
      slug: `${f.slug}g`,
      brandId: bid,
      formulationId: fid,
      millilitres: 20000,
    });
    // 20 litres a can, loose — so cans and litres are easy to read in a test.
    await db.insert(products).values({
      id: id("prd"),
      name: `${f.name} Thinner - 20 Liter (Loose)`,
      finishedGoodId: gid,
      brandId: bid,
      formulationId: fid,
      millilitresPerCan: 20000,
      cansPerBox: 1,
    });
  }
}

const UNIVERSAL = "Mahek Universal Thinner - 20 Liter (Loose)";
const NANO = "M5x4 Thinner - 20 Liter (Loose)";
const PU = "PU Thinner M16 Thinner - 20 Liter (Loose)";

before(async () => {
  assert.match(
    process.env.DATABASE_URL ?? "",
    /mahekone_test/,
    "Integration tests must run against mahekone_test. Run `npm run test:db` first.",
  );
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table
      sales_performance_categories, sales_performance, sales_target_revisions,
      sales_target_categories, sales_targets,
      audit_log, job_runs, notifications, payments, payment_receipts, bills,
      interaction_product_lines, orders, calls, app_access, sessions, customers,
      product_aliases, products, finished_goods, product_brands,
      product_formulations, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  manager = await makeUser("Vikram", "manager");
  rahul = await makeUser("Rahul", "telecaller");
  poonam = await makeUser("Poonam", "telecaller");
  setTestUser(manager);

  TODAY = await today();
  PERIOD = TODAY.slice(0, 7);
  await seedCatalogue();
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

/* ====================================================== whose number is it */

describe("attribution", () => {
  test("a customer with a salesman counts to the salesman", async () => {
    const c = await makeCustomer({ salesAmId: rahul.id, backOfficeAmId: poonam.id });
    await makeOrder(c.id, [{ product: UNIVERSAL, cans: 10, amountPaise: 100_000_00 }]);

    const actuals = await actualsForPeriod(PERIOD);
    assert.equal(actuals.get(rahul.id)?.revenuePaise, 100_000_00);
    assert.equal(actuals.get(poonam.id), undefined);
  });

  test("NO salesman falls through to the back office person", async () => {
    // Mahek's own rule, and the one thing that had to be right: an account
    // nobody sells to in person is worked by the back office, and it is their
    // number.
    const c = await makeCustomer({ salesAmId: null, backOfficeAmId: poonam.id });
    await makeOrder(c.id, [{ product: UNIVERSAL, cans: 10, amountPaise: 100_000_00 }]);

    const actuals = await actualsForPeriod(PERIOD);
    assert.equal(actuals.get(poonam.id)?.revenuePaise, 100_000_00);
    assert.equal(actuals.get(rahul.id), undefined);
  });

  test("the same rupee is never counted for two people", async () => {
    // A split or a both-count reading would make the team add up to more than
    // the company, and every comparison between two salesmen would be drawn
    // from a total that does not exist.
    const both = await makeCustomer({ salesAmId: rahul.id, backOfficeAmId: poonam.id });
    const backOnly = await makeCustomer({ salesAmId: null, backOfficeAmId: poonam.id });
    await makeOrder(both.id, [{ product: UNIVERSAL, cans: 5, amountPaise: 60_000_00 }]);
    await makeOrder(backOnly.id, [{ product: NANO, cans: 5, amountPaise: 40_000_00 }]);

    const actuals = await actualsForPeriod(PERIOD);
    const team = [...actuals.values()].reduce((s, a) => s + a.revenuePaise, 0);
    assert.equal(team, 100_000_00);
    assert.equal(actuals.get(rahul.id)?.revenuePaise, 60_000_00);
    assert.equal(actuals.get(poonam.id)?.revenuePaise, 40_000_00);
  });

  test("`owner_id` is NOT the fallback, and the money is reported as unattributed", async () => {
    // `owner_id` on an imported book is whoever ran the import — one person on
    // a thousand rows. Falling through to it would hand them the revenue of
    // the entire company.
    const orphan = await makeCustomer({ salesAmId: null, backOfficeAmId: null });
    await makeOrder(orphan.id, [{ product: UNIVERSAL, cans: 5, amountPaise: 55_000_00 }]);

    const actuals = await actualsForPeriod(PERIOD);
    assert.equal(actuals.get(manager.id), undefined, "the importer must not be credited");

    const orphaned = await unattributedForPeriod(PERIOD);
    assert.equal(orphaned.revenuePaise, 55_000_00);
    assert.equal(orphaned.customers, 1);
  });

  test("the TypeScript and SQL renderings of the rule agree", async () => {
    const c = await makeCustomer({ salesAmId: null, backOfficeAmId: poonam.id });
    const seat = creditedTo({
      kind: c.kind,
      salesAmId: c.salesAmId,
      backOfficeAmId: c.backOfficeAmId,
      ownerId: c.ownerId,
    });
    assert.equal(seat.userId, poonam.id);
    assert.equal(seat.seat, "back-office");

    await makeOrder(c.id, [{ product: NANO, cans: 1, amountPaise: 1_000_00 }]);
    const actuals = await actualsForPeriod(PERIOD);
    assert.ok(actuals.has(seat.userId!));
  });
});

/* ============================================================ what counts */

describe("what counts as a sale", () => {
  test("a pending or declined order is not revenue", async () => {
    const c = await makeCustomer({ salesAmId: rahul.id });
    await makeOrder(c.id, [{ product: UNIVERSAL, cans: 5, amountPaise: 50_000_00 }]);
    await makeOrder(c.id, [{ product: UNIVERSAL, cans: 5, amountPaise: 90_000_00 }], {
      status: "pending_approval",
    });
    await makeOrder(c.id, [{ product: UNIVERSAL, cans: 5, amountPaise: 70_000_00 }], {
      status: "declined",
    });

    const actuals = await actualsForPeriod(PERIOD);
    assert.equal(actuals.get(rahul.id)?.revenuePaise, 50_000_00);
  });

  test("an order in another month is not this month's", async () => {
    const c = await makeCustomer({ salesAmId: rahul.id });
    await makeOrder(c.id, [{ product: UNIVERSAL, cans: 5, amountPaise: 50_000_00 }]);
    await makeOrder(c.id, [{ product: UNIVERSAL, cans: 5, amountPaise: 99_000_00 }], {
      orderedAt: new Date(`${PERIOD}-01T09:00:00+05:30`),
    });

    const actuals = await actualsForPeriod(PERIOD);
    // Both are in the month; the first day must be INSIDE it.
    assert.equal(actuals.get(rahul.id)?.revenuePaise, 149_000_00);
  });

  test("an order at 1am on the first still belongs to this month", async () => {
    // The window carries +05:30. Read in UTC, a 1am IST order on the 1st falls
    // into the previous month — invisible on a laptop set to IST.
    const c = await makeCustomer({ salesAmId: rahul.id });
    await makeOrder(c.id, [{ product: UNIVERSAL, cans: 1, amountPaise: 10_000_00 }], {
      orderedAt: new Date(`${PERIOD}-01T01:00:00+05:30`),
    });
    const actuals = await actualsForPeriod(PERIOD);
    assert.equal(actuals.get(rahul.id)?.revenuePaise, 10_000_00);
  });
});

/* ================================================= volume and product mix */

describe("volume and mix", () => {
  test("litres come off the SKU's packing, not off the money", async () => {
    const c = await makeCustomer({ salesAmId: rahul.id });
    // 10 cans of a 20-litre SKU is 200 litres, whatever it was sold for.
    await makeOrder(c.id, [{ product: UNIVERSAL, cans: 10, amountPaise: 100_000_00 }]);

    const actuals = await actualsForPeriod(PERIOD);
    assert.equal(actuals.get(rahul.id)?.millilitres, 200_000);
  });

  test("a PRICE RISE moves revenue and leaves volume exactly where it was", async () => {
    // The whole reason the module exists, proved on the data rather than in
    // the engine: same cans, more money.
    const before = await makeCustomer({ salesAmId: rahul.id });
    await makeOrder(before.id, [{ product: UNIVERSAL, cans: 10, amountPaise: 100_000_00 }]);
    const cheap = await actualsForPeriod(PERIOD);

    await db.execute(sql`truncate table orders cascade`);
    await makeOrder(before.id, [{ product: UNIVERSAL, cans: 10, amountPaise: 130_000_00 }]);
    const dear = await actualsForPeriod(PERIOD);

    assert.equal(cheap.get(rahul.id)!.millilitres, dear.get(rahul.id)!.millilitres);
    assert.ok(dear.get(rahul.id)!.revenuePaise > cheap.get(rahul.id)!.revenuePaise);
  });

  test("each line lands in its formulation's category", async () => {
    const c = await makeCustomer({ salesAmId: rahul.id });
    await makeOrder(c.id, [
      { product: UNIVERSAL, cans: 3, amountPaise: 30_000_00 },
      { product: PU, cans: 2, amountPaise: 20_000_00 },
      { product: NANO, cans: 5, amountPaise: 50_000_00 },
    ]);

    const a = (await actualsForPeriod(PERIOD)).get(rahul.id)!;
    assert.equal(a.byCategory.get("pcat_universal")?.valuePaise, 30_000_00);
    assert.equal(a.byCategory.get("pcat_pu")?.valuePaise, 20_000_00);
    assert.equal(a.byCategory.get("pcat_nano")?.valuePaise, 50_000_00);
  });

  test("an unclassified formulation falls to the residual, not out of the total", async () => {
    const c = await makeCustomer({ salesAmId: rahul.id });
    await makeOrder(c.id, [
      { product: UNIVERSAL, cans: 5, amountPaise: 50_000_00 },
      { product: "Enamel Thinner Thinner - 20 Liter (Loose)", cans: 5, amountPaise: 50_000_00 },
    ]);

    const a = (await actualsForPeriod(PERIOD)).get(rahul.id)!;
    assert.equal(a.byCategory.get("pcat_other")?.valuePaise, 50_000_00);
    const total = [...a.byCategory.values()].reduce((s, v) => s + v.valuePaise, 0);
    assert.equal(total, 100_000_00, "every rupee has to be in some category");
  });

  test("a product name matching nothing is revenue, no litres, and is REPORTED", async () => {
    // Four of the sheet's own names match nothing. That money is real and must
    // count; what it cannot do is claim to be litres of a known product.
    const c = await makeCustomer({ salesAmId: rahul.id });
    await makeOrder(c.id, [
      { product: UNIVERSAL, cans: 5, amountPaise: 50_000_00 },
      { product: "Some Thinner Nobody Catalogued", cans: 9, amountPaise: 50_000_00 },
    ]);

    const a = (await actualsForPeriod(PERIOD)).get(rahul.id)!;
    assert.equal(a.revenuePaise, 100_000_00, "unmatched money is still revenue");
    assert.equal(a.millilitres, 100_000, "only the matched line contributes litres");
    assert.equal(a.unmatchedPaise, 50_000_00, "and the screen is told how much");
    // It sits in the residual so the denominator stays whole.
    assert.equal(a.byCategory.get("pcat_other")?.valuePaise, 50_000_00);
    assert.equal(a.byCategory.get("pcat_other")?.millilitres, 0);
  });
});

/* ============================================================== the others */

describe("new customers", () => {
  test("a customer's FIRST counting order wins them, once", async () => {
    const c = await makeCustomer({ salesAmId: rahul.id });
    await makeOrder(c.id, [{ product: NANO, cans: 1, amountPaise: 10_000_00 }], {
      orderedAt: at(5),
    });
    await makeOrder(c.id, [{ product: NANO, cans: 1, amountPaise: 10_000_00 }], {
      orderedAt: at(20),
    });

    const a = (await actualsForPeriod(PERIOD)).get(rahul.id)!;
    assert.equal(a.newCustomers, 1);
  });

  test("a customer who ordered before this month is not new", async () => {
    const c = await makeCustomer({ salesAmId: rahul.id });
    await makeOrder(c.id, [{ product: NANO, cans: 1, amountPaise: 10_000_00 }], {
      orderedAt: new Date(`${PERIOD}-01T09:00:00+05:30`),
    });
    // Backdate that first order out of the month.
    await db.execute(
      sql`update orders set ordered_at = ordered_at - interval '90 days'`,
    );
    await makeOrder(c.id, [{ product: NANO, cans: 1, amountPaise: 10_000_00 }], {
      orderedAt: at(15),
    });

    const a = (await actualsForPeriod(PERIOD)).get(rahul.id)!;
    assert.equal(a.newCustomers, 0);
  });

  test("a lead with no order is not an acquisition", async () => {
    // Otherwise the acquisition target is reachable from a desk.
    await makeCustomer({ kind: "lead", salesAmId: null, ownerId: rahul.id });
    const actuals = await actualsForPeriod(PERIOD);
    assert.equal(actuals.get(rahul.id)?.newCustomers ?? 0, 0);
  });
});

describe("collection", () => {
  test("only money accounts have CONFIRMED counts", async () => {
    const c = await makeCustomer({ salesAmId: rahul.id });
    const receipt = (status: "confirmed" | "reported" | "held", amount: number) =>
      db.insert(paymentReceipts).values({
        id: id("rcp"),
        customerId: c.id,
        amount,
        mode: "neft",
        status,
        receivedAt: dayIn(12),
        reportedById: rahul.id,
        // Not null on the table: every route to a receipt is idempotent, so a
        // retried sync writes the same row rather than a second payment.
        idempotencyKey: id("idem"),
      });
    await receipt("confirmed", 90_000_00);
    await receipt("reported", 50_000_00);
    await receipt("held", 30_000_00);

    const a = (await actualsForPeriod(PERIOD)).get(rahul.id)!;
    assert.equal(
      a.collectionPaise,
      90_000_00,
      "a claim is not money the business has seen",
    );
  });
});

/* ================================================== the reading, and cache */

describe("the reading", () => {
  async function publishTarget(
    userId: string,
    over: Partial<{
      revenue: number;
      volumeMl: number;
      newCustomers: number;
      collection: number;
      activity: number;
    }> = {},
  ) {
    const targetId = id("stg");
    await db.execute(sql`
      insert into sales_targets (id, user_id, period, revenue_target_paise,
        volume_target_ml, new_customer_target, collection_target_paise,
        activity_target, status, published_at)
      values (${targetId}, ${userId}, ${PERIOD},
        ${over.revenue ?? 1_300_000_00}, ${over.volumeMl ?? 10_000_000},
        ${over.newCustomers ?? 3}, ${over.collection ?? 1_000_000_00},
        ${over.activity ?? 100}, 'published', now())
    `);
    for (const [cat, min, tgt, str] of [
      ["pcat_universal", 2500, 3000, 3500],
      ["pcat_pu", 1500, 2000, 2500],
      ["pcat_nano", 1000, 2000, 2500],
      ["pcat_other", 3000, 3000, 3000],
    ] as const) {
      await db.execute(sql`
        insert into sales_target_categories (id, target_id, category_id,
          minimum_bp, target_bp, stretch_bp)
        values (${id("stc")}, ${targetId}, ${cat}, ${min}, ${tgt}, ${str})
      `);
    }
    return targetId;
  }

  test("revenue at target with volume far below it raises the price-rise alert", async () => {
    await publishTarget(rahul.id, { revenue: 100_000_00, volumeMl: 400_000 });
    const c = await makeCustomer({ salesAmId: rahul.id });
    // 10 cans = 200 litres against a 400-litre target (50%), sold for the full
    // revenue target. Exactly the month prices went up and nothing else did.
    await makeOrder(c.id, [{ product: UNIVERSAL, cans: 10, amountPaise: 105_000_00 }]);

    const [reading] = await readingsForPeriod(PERIOD, TODAY, { userIds: [rahul.id] });
    assert.ok(reading, "expected a reading for a person holding a target");
    assert.ok(
      reading.alerts.some((a) => a.key === "price-not-volume"),
      `expected the price alert, got ${reading.alerts.map((a) => a.key).join(", ")}`,
    );
  });

  test("a DRAFT target is not read — nothing reaches anybody until it is published", async () => {
    await db.execute(sql`
      insert into sales_targets (id, user_id, period, revenue_target_paise, status)
      values (${id("stg")}, ${rahul.id}, ${PERIOD}, 500_00, 'draft')
    `);
    const [reading] = await readingsForPeriod(PERIOD, TODAY, { userIds: [rahul.id] });
    assert.equal(reading, undefined, "a draft must not be scored against anybody");
  });

  test("somebody selling with no target published is still shown", async () => {
    // A target somebody forgot to publish is exactly what a manager needs to
    // see, and a dashboard that hides them describes a smaller company.
    const c = await makeCustomer({ salesAmId: rahul.id });
    await makeOrder(c.id, [{ product: NANO, cans: 4, amountPaise: 40_000_00 }]);

    const [reading] = await readingsForPeriod(PERIOD, TODAY, { userIds: [rahul.id] });
    assert.ok(reading);
    assert.equal(reading.hasTarget, false);
    assert.equal(reading.actuals.revenuePaise, 40_000_00);
    // Nothing was asked, so nothing is scored — rather than a zero that reads
    // as a judgement.
    assert.equal(reading.score.untargeted.length, 6);
  });

  test("the cache is rebuilt, not adjusted — running it twice lands on one answer", async () => {
    await publishTarget(rahul.id);
    const c = await makeCustomer({ salesAmId: rahul.id });
    await makeOrder(c.id, [{ product: UNIVERSAL, cans: 10, amountPaise: 100_000_00 }]);

    await recomputeSalesPerformance(PERIOD, TODAY);
    const first = await db.execute<{ n: number; revenue: string; cats: number }>(sql`
      select (select count(*)::int from sales_performance) as n,
             (select revenue_actual_paise from sales_performance limit 1) as revenue,
             (select count(*)::int from sales_performance_categories) as cats
    `);
    await recomputeSalesPerformance(PERIOD, TODAY);
    const second = await db.execute<{ n: number; revenue: string; cats: number }>(sql`
      select (select count(*)::int from sales_performance) as n,
             (select revenue_actual_paise from sales_performance limit 1) as revenue,
             (select count(*)::int from sales_performance_categories) as cats
    `);

    assert.deepEqual(second[0], first[0], "a second run must not double anything");
    assert.equal(Number(first[0].revenue), 100_000_00);
    assert.equal(first[0].cats, 4, "one row per category on the target");
  });

  test("a corrected order changes the cache on the next rebuild", async () => {
    await publishTarget(rahul.id);
    const c = await makeCustomer({ salesAmId: rahul.id });
    const order = await makeOrder(c.id, [
      { product: UNIVERSAL, cans: 10, amountPaise: 100_000_00 },
    ]);
    await recomputeSalesPerformance(PERIOD, TODAY);

    await db.execute(
      sql`update orders set total_amount = 250_000_00 where id = ${order.id}`,
    );
    await recomputeSalesPerformance(PERIOD, TODAY);

    const rows = await db.execute<{ revenue: string }>(
      sql`select revenue_actual_paise as revenue from sales_performance where user_id = ${rahul.id}`,
    );
    assert.equal(Number(rows[0].revenue), 250_000_00);
  });
});
