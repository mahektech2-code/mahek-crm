/**
 * The owner's five, end to end.
 *
 *   npm run test:owner
 *
 * The engine tests next door pin the arithmetic. What these pin is the half
 * that cannot be unit tested: that "a lead" means the same thing in both
 * tables it lives in, that a cohort follows the right customers forward, that
 * a credit note lands where a credit note belongs, and that a band read off
 * the database agrees with the flag the Call Log already uses.
 *
 * They need mahekone_test, which `npm run test:db` creates from the committed
 * migrations. The harness truncates between tests.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { complaints, customers, orders, paymentReceipts, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { conversionFor } from "@/lib/engines/owner-kpis";
import { getConfig } from "@/lib/config/store";
import {
  bandedCustomers,
  leadsCreatedIn,
  movementSince,
  ownerDashboard,
  salesFigures,
  snapshotCustomerHealth,
} from "@/lib/services/owner-dashboard-service";

/* ------------------------------------------------------------------ harness */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let TODAY: string;
let admin: typeof users.$inferSelect;
let rahul: typeof users.$inferSelect;

/** A window wide enough that "created today" always lands inside it. */
const thisMonth = () => ({ from: `${TODAY.slice(0, 7)}-01`, to: TODAY });

async function makeUser(name: string, role: "telecaller" | "admin") {
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
      region: "Maharashtra",
      ownerId: rahul.id,
      salesAmId: rahul.id,
      ...over,
    })
    .returning();
  return row;
}

async function makeOrder(
  customerId: string,
  amountPaise: number,
  orderedAt: Date,
  over: Partial<typeof orders.$inferInsert> = {},
) {
  const [row] = await db
    .insert(orders)
    .values({
      id: id("ord"),
      customerId,
      source: "external",
      status: "dispatched",
      orderedAt,
      totalAmount: amountPaise,
      ...over,
    })
    .returning();
  return row;
}

/** A day inside the current month, as an instant in IST. */
const at = (day: number, time = "09:00:00") =>
  new Date(`${TODAY.slice(0, 7)}-${String(day).padStart(2, "0")}T${time}+05:30`);

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
      customer_health_snapshots,
      sales_performance_categories, sales_performance, sales_target_revisions,
      sales_target_categories, sales_targets,
      audit_log, job_runs, notifications, payments, payment_receipts, bills,
      complaints, mbos_leads, interaction_product_lines, orders, calls,
      app_access, sessions, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  admin = await makeUser("Owner", "admin");
  rahul = await makeUser("Rahul", "telecaller");
  // An admin, so scope resolves to the whole book — this is the owner's app.
  setTestUser(admin);
  TODAY = await today();
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

/* ================================================== KPI 1: what is a lead */

describe("new leads", () => {
  test("counts leads from BOTH places this product keeps one", async () => {
    await makeCustomer({ kind: "lead", leadSource: "website" });
    await db.execute(sql`
      insert into mbos_leads (id, server_created_at, created_by_id, name, mobile, source, stage)
      values (${id("mbos_lead")}, now(), ${rahul.id}, 'Met at expo', '9000000001', 'exhibition', 'new')
    `);

    const leads = await leadsCreatedIn(thisMonth(), {});
    assert.equal(leads.length, 2);
    assert.deepEqual(
      leads.map((l) => l.origin).sort(),
      ["crm", "field"],
      "a business opportunity is one whichever table it landed in",
    );
  });

  test("a field lead and the customer it became are ONE opportunity", async () => {
    // Otherwise converting a lead inflates the very KPI that measures whether
    // leads are being generated.
    const converted = await makeCustomer({ kind: "lead" });
    await db.execute(sql`
      insert into mbos_leads (id, server_created_at, created_by_id, name, mobile,
                              source, stage, converted_customer_id, converted_at)
      values (${id("mbos_lead")}, now(), ${rahul.id}, 'Became a customer', '9000000002',
              'referral', 'won', ${converted.id}, now())
    `);

    const leads = await leadsCreatedIn(thisMonth(), {});
    assert.equal(leads.length, 1, "the customer row must not be counted again");
    assert.equal(leads[0].origin, "field");
  });

  test("a customer that is not a lead is not counted", async () => {
    await makeCustomer({ kind: "customer" });
    assert.equal((await leadsCreatedIn(thisMonth(), {})).length, 0);
  });

  test("a lead created before the window is not this window's", async () => {
    const old = await makeCustomer({ kind: "lead" });
    await db.execute(
      sql`update customers set created_at = created_at - interval '90 days' where id = ${old.id}`,
    );
    assert.equal((await leadsCreatedIn(thisMonth(), {})).length, 0);
  });
});

/* ============================================ KPI 2: the cohort converts */

describe("lead-to-order conversion", () => {
  test("a lead that ordered inside its window has converted", async () => {
    const config = await getConfig();
    const lead = await makeCustomer({ kind: "lead" });
    await makeOrder(lead.id, 50_000_00, at(5));

    const cohort = await leadsCreatedIn(thisMonth(), {});
    assert.equal(cohort.length, 1);
    assert.equal(cohort[0].firstOrderOn, `${TODAY.slice(0, 7)}-05`);

    const c = conversionFor(cohort, TODAY, config);
    assert.equal(c.converted, 1);
    assert.equal(c.ratePercent, 100);
  });

  test("a PENDING first order is not a conversion", async () => {
    // A lead has become a customer when the business accepted an order, not
    // when somebody typed one in — the same rule every other money screen uses.
    const config = await getConfig();
    const lead = await makeCustomer({ kind: "lead" });
    await makeOrder(lead.id, 50_000_00, at(5), { status: "pending_approval" });

    const c = conversionFor(await leadsCreatedIn(thisMonth(), {}), TODAY, config);
    assert.equal(c.converted, 0);
  });

  test("the FIRST order is the one that counts, not the latest", async () => {
    const lead = await makeCustomer({ kind: "lead" });
    await makeOrder(lead.id, 10_000_00, at(3));
    await makeOrder(lead.id, 90_000_00, at(20));

    const cohort = await leadsCreatedIn(thisMonth(), {});
    assert.equal(cohort[0].firstOrderOn, `${TODAY.slice(0, 7)}-03`);
  });
});

/* ================================================ KPI 3 & 4: what it is worth */

describe("bill size and frequency", () => {
  test("a transaction is an order the business accepted", async () => {
    const c = await makeCustomer();
    await makeOrder(c.id, 30_000_00, at(4));
    await makeOrder(c.id, 20_000_00, at(6));
    await makeOrder(c.id, 99_000_00, at(7), { status: "pending_approval" });
    await makeOrder(c.id, 99_000_00, at(8), { status: "declined" });

    const f = await salesFigures(thisMonth(), {});
    assert.equal(f.transactions, 2);
    assert.equal(f.grossValuePaise, 50_000_00);
  });

  test("orders per customer counts customers who ORDERED, not the whole book", async () => {
    const a = await makeCustomer();
    const b = await makeCustomer();
    await makeCustomer(); // on the book, ordered nothing
    await makeOrder(a.id, 10_000_00, at(4));
    await makeOrder(a.id, 10_000_00, at(5));
    await makeOrder(b.id, 10_000_00, at(6));

    const f = await salesFigures(thisMonth(), {});
    assert.equal(f.ordersPerCustomer.length, 2, "two customers ordered");
    assert.deepEqual(f.ordersPerCustomer.sort(), [1, 2]);
  });

  test("a credit note reduces the value and leaves the count alone", async () => {
    const c = await makeCustomer();
    await makeOrder(c.id, 1_00_000_00, at(4));

    const [complaint] = await db
      .insert(complaints)
      .values({
        id: id("cmp"),
        customerId: c.id,
        category: "packaging_damage",
        description: "Two drums arrived with the seals broken.",
        loggedByUserId: rahul.id,
        slaDueAt: new Date(),
        requestCn: true,
        cnStatus: "issued",
        cnAmount: 10_000_00,
      })
      .returning();

    // Exactly what `issueCreditNote` writes: a confirmed receipt keyed
    // `creditnote:<complaint>`, which is the only mark that dates it.
    await db.insert(paymentReceipts).values({
      id: id("rcp"),
      customerId: c.id,
      amount: 10_000_00,
      mode: "Adjustment",
      status: "confirmed",
      receivedAt: `${TODAY.slice(0, 7)}-05`,
      reportedById: rahul.id,
      idempotencyKey: `creditnote:${complaint.id}`,
    });

    const f = await salesFigures(thisMonth(), {});
    assert.equal(f.creditNotePaise, 10_000_00);
    assert.equal(f.transactions, 1, "a credit note is not a sale that un-happened");
  });

  test("an ordinary confirmed receipt is NOT a credit note", async () => {
    const c = await makeCustomer();
    await db.insert(paymentReceipts).values({
      id: id("rcp"),
      customerId: c.id,
      amount: 25_000_00,
      mode: "neft",
      status: "confirmed",
      receivedAt: `${TODAY.slice(0, 7)}-05`,
      reportedById: rahul.id,
      idempotencyKey: id("idem"),
    });
    const f = await salesFigures(thisMonth(), {});
    assert.equal(f.creditNotePaise, 0);
  });
});

/* =============================================== KPI 5: bands and movement */

describe("customer health", () => {
  test("a band is measured against the customer's own cycle", async () => {
    const fortnightly = await makeCustomer({
      name: "Fortnightly",
      cycleDays: 14,
      cycleConfidence: 80,
      lastOrderDate: daysAgo(20),
    });
    const halfYearly = await makeCustomer({
      name: "Half yearly",
      cycleDays: 180,
      cycleConfidence: 80,
      lastOrderDate: daysAgo(20),
    });

    const { banded } = await bandedCustomers(TODAY, {});
    const by = (id: string) => banded.find((b) => b.customerId === id)!;
    assert.equal(by(fortnightly.id).band, "at-risk");
    assert.equal(by(halfYearly.id).band, "active");
  });

  test("a customer who never ordered is in NO band, and is counted apart", async () => {
    await makeCustomer({ lastOrderDate: null });
    const { banded, neverOrdered } = await bandedCustomers(TODAY, {});
    assert.equal(banded.length, 0);
    assert.equal(neverOrdered, 1);
  });

  test("a deactivated account is out of the reckoning entirely", async () => {
    // Somebody closed it deliberately; counting it as lost turns a business
    // decision into a retention failure.
    await makeCustomer({
      status: "deactivated",
      cycleDays: 30,
      lastOrderDate: daysAgo(400),
    });
    const { banded } = await bandedCustomers(TODAY, {});
    assert.equal(banded.length, 0);
  });

  test("an unmeasured cycle still bands, and is reported as unmeasured", async () => {
    await makeCustomer({ cycleConfidence: null, lastOrderDate: daysAgo(10) });
    const { banded, defaultCycle } = await bandedCustomers(TODAY, {});
    assert.equal(banded.length, 1);
    assert.equal(banded[0].cycleIsMeasured, false);
    assert.equal(defaultCycle, 1);
  });

  test("the drill-down carries what somebody needs to work the list", async () => {
    const c = await makeCustomer({
      cycleDays: 30,
      cycleConfidence: 90,
      lastOrderDate: daysAgo(50),
      outstanding: 75_000_00,
    });
    const { banded } = await bandedCustomers(TODAY, {});
    const row = banded.find((b) => b.customerId === c.id)!;
    assert.equal(row.band, "at-risk");
    assert.equal(row.outstandingPaise, 75_000_00);
    assert.equal(row.daysOverdue, 20);
    assert.ok(row.expectedOn, "the day their own cycle said they were due");
    assert.equal(row.ownerName, "Rahul");
  });
});

describe("movement", () => {
  test("no earlier snapshot is 'we cannot say yet', not 'nobody moved'", async () => {
    await makeCustomer({ cycleDays: 30, lastOrderDate: daysAgo(10) });
    const previous = previousMonthKey(TODAY);
    assert.equal(await movementSince(previous, TODAY, {}), null);
  });

  test("a customer who came back reads as recovered", async () => {
    const c = await makeCustomer({
      cycleDays: 30,
      cycleConfidence: 90,
      lastOrderDate: daysAgo(50), // at risk
    });
    const previous = previousMonthKey(TODAY);

    // Stand in for last month's nightly pass.
    await db.execute(sql`
      insert into customer_health_snapshots
        (id, customer_id, period, band, cycle_days, cycles_elapsed_bp, days_overdue)
      values (${id("chs")}, ${c.id}, ${previous}, 'at-risk', 30, 167, 20)
    `);

    // They have since ordered.
    await db.execute(
      sql`update customers set last_order_date = ${daysAgo(2)} where id = ${c.id}`,
    );

    const moved = await movementSince(previous, TODAY, {});
    assert.ok(moved);
    const recovered = moved!.movements.find(
      (m) => m.from === "at-risk" && m.to === "active",
    );
    assert.ok(recovered, "expected an at-risk to active movement");
    assert.equal(recovered!.direction, "recovered");
  });

  test("the snapshot is written over, not stacked", async () => {
    await makeCustomer({ cycleDays: 30, cycleConfidence: 90, lastOrderDate: daysAgo(10) });
    await snapshotCustomerHealth(TODAY);
    await snapshotCustomerHealth(TODAY);

    const rows = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from customer_health_snapshots`,
    );
    assert.equal(Number(rows[0].n), 1, "one reading per customer per month");
  });

  test("a past month is never rewritten", async () => {
    // It is the only surviving record of where somebody stood then, and a
    // rebuild would destroy the thing it exists for.
    const c = await makeCustomer({ cycleDays: 30, cycleConfidence: 90, lastOrderDate: daysAgo(10) });
    const previous = previousMonthKey(TODAY);
    await db.execute(sql`
      insert into customer_health_snapshots
        (id, customer_id, period, band, cycle_days, cycles_elapsed_bp, days_overdue)
      values (${id("chs")}, ${c.id}, ${previous}, 'lost', 30, 900, 800)
    `);

    await snapshotCustomerHealth(TODAY);

    const rows = await db.execute<{ band: string }>(
      sql`select band from customer_health_snapshots where period = ${previous}`,
    );
    assert.equal(rows[0].band, "lost", "last month's reading must stand");
  });
});

/* ============================================================ the five */

describe("the dashboard", () => {
  test("all five come back together, over one window", async () => {
    const lead = await makeCustomer({ kind: "lead" });
    await makeOrder(lead.id, 40_000_00, at(6));
    const buyer = await makeCustomer({
      cycleDays: 30,
      cycleConfidence: 90,
      lastOrderDate: daysAgo(5),
    });
    await makeOrder(buyer.id, 60_000_00, at(7));

    const range = thisMonth();
    const data = await ownerDashboard(
      range,
      { from: prevMonthDay(range.from), to: prevMonthDay(range.to) },
      { from: lastYearDay(range.from), to: lastYearDay(range.to) },
      TODAY,
      {},
    );

    assert.equal(data.newLeads.current, 1);
    assert.equal(data.conversion.current.converted, 1);
    assert.equal(data.billSize.current.transactions, 2);
    assert.equal(data.billSize.current.averagePaise, 50_000_00);
    assert.equal(data.frequency.current.activeCustomers, 2);
    assert.equal(data.retention.counts.active, 1);
    /*
     * A LEAD IS NOT IN THE RETENTION BOOK AT ALL — not banded, and not counted
     * among the never-ordered either.
     *
     * Retention asks whether the customers we have are still buying. A lead is
     * a customer we do not have yet, so putting it in the denominator would
     * make "active customers" fall every time somebody added a prospect, and
     * putting it in the never-ordered figure would drown the customers who
     * genuinely stopped in a list of people who never started.
     */
    assert.equal(data.retention.total, 1, "the buyer, and not the lead");
    assert.equal(data.neverOrdered, 0);
  });

  test("a salesperson filter narrows every one of the five", async () => {
    const other = await makeUser("Priya", "telecaller");
    const mine = await makeCustomer({ salesAmId: rahul.id });
    const theirs = await makeCustomer({ salesAmId: other.id, ownerId: other.id });
    await makeOrder(mine.id, 10_000_00, at(4));
    await makeOrder(theirs.id, 90_000_00, at(4));

    const f = await salesFigures(thisMonth(), { salesmanId: rahul.id });
    assert.equal(f.transactions, 1);
    assert.equal(f.grossValuePaise, 10_000_00);
  });
});

/* ----------------------------------------------------------------- helpers */

function daysAgo(n: number): string {
  const [y, m, d] = TODAY.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1, d - n));
  return at.toISOString().slice(0, 10);
}

function previousMonthKey(day: string): string {
  const [y, m] = day.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 2, 1));
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

function prevMonthDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 2, d));
  return at.toISOString().slice(0, 10);
}

function lastYearDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const at = new Date(Date.UTC(y - 1, m - 1, d));
  return at.toISOString().slice(0, 10);
}
