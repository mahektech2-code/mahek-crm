/**
 * THE LEDGER AND THE OUTSTANDING LIST, A PAGE AT A TIME.
 *
 * Both screens used to be handed a whole financial year — or, for outstanding,
 * every open bill in the book — and filter, sort and slice it in the browser.
 * Moving that into Postgres is the sort of change that looks right on every
 * screenshot and is wrong in exactly one way: a row that appears on two pages
 * while another appears on none, because a sort over thousands of rows sharing
 * a handful of values leaves the rest of the order to the planner.
 *
 * So the load-bearing test here is the dullest one: page the whole book and
 * assert every bill was seen exactly once. The book is 55 bills at SEVEN a
 * day, and the page size is 20 — chosen so that no page ends on a date
 * boundary, which is the lesson the customer timeline's own paging test
 * records. At twenty a day with pages of twenty, every page ends where the
 * next value begins and a broken cursor passes.
 *
 *   DATABASE_URL=...mahekone_test npx tsx --conditions=react-server \
 *     --test src/lib/bill-paging.test.ts
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, bills, customers, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { getConfig } from "@/lib/config/store";
import { addDays } from "@/lib/business-date";
import { effectiveDueDate } from "@/lib/engines/escalation";
import { today, recomputeOutstanding } from "@/lib/recompute";
import {
  billLedgerPage,
  billLedgerTotals,
  listBills,
  listOutstandingByCustomer,
  openBillAges,
  outstandingPage,
  type BillSortKey,
} from "@/lib/services/payment-service";
import { outstandingTotals } from "@/lib/engines/outstanding";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let TODAY: string;
let deepa: typeof users.$inferSelect;

async function makeUser(name: string) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase()}_${randomUUID().slice(0, 6)}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role: "manager",
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  /* The ledger desk is an APP GRANT and not a role: a level with no app is a
     manager of nothing, which is what production looks like too. */
  await db.insert(appAccess).values({
    id: id("aca"),
    userId: row.id,
    app: "accounts",
    role: "manager",
  });
  return row;
}

async function makeCustomer(name: string) {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name,
      contactPerson: "Contact Person",
      phone: String(9000000000 + Math.floor(Math.random() * 999999999)),
      city: "Nagpur",
      ownerId: deepa.id,
      salesAmId: deepa.id,
      customerSince: addDays(TODAY, -400),
    })
    .returning();
  return row;
}

async function makeBill(
  customerId: string,
  amount: number,
  over: Partial<typeof bills.$inferInsert> = {},
) {
  const [row] = await db
    .insert(bills)
    .values({
      id: id("bil"),
      customerId,
      billNo: over.billNo ?? `MMI/26-27/${randomUUID().slice(0, 8)}`,
      billDate: over.billDate ?? addDays(TODAY, -40),
      dueDate: over.dueDate ?? addDays(TODAY, -10),
      amount,
      ...over,
    })
    .returning();
  return row;
}

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
      audit_log, job_runs, notifications, complaint_status_history, complaints,
      attachments, follow_up_attempts, follow_up_states, payments, bills,
      orders, calls, app_access, sessions, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  deepa = await makeUser("Deepa");
  setTestUser(deepa);
  TODAY = await today();
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

/* ------------------------------------------------------------ the ledger */

/**
 * 55 bills, seven to a day, every one of them inside one financial year.
 *
 * Seven and 55 are both chosen against the page size of 20: no page boundary
 * lands on a change of date, so a sort with no tiebreaker has room to shuffle
 * rows across the seam rather than being accidentally saved by one.
 */
async function aBookOf55() {
  const customer = await makeCustomer("Nagpur Paint House");
  /* Inside FY 26-27 and clear of its edges, so `financialYear` is not what is
     being tested by accident. */
  for (let i = 0; i < 55; i++) {
    await makeBill(customer.id, 1_000_00 + i * 100, {
      billNo: `MMI/26-27/${String(1000 + i)}`,
      billDate: addDays("2026-06-01", Math.floor(i / 7)),
      dueDate: null,
      /* Three of every five settled, so the status column has a handful of
         values across 55 rows — the degenerate sort the tiebreaker exists
         for. */
      paidAmount: i % 5 < 3 ? 1_000_00 + i * 100 : 0,
      status: i % 5 < 3 ? "paid" : "unpaid",
    });
  }
  await recomputeOutstanding(customer.id);
  return customer;
}

describe("Paging the bill ledger", () => {
  const PER_PAGE = 20;

  test("every bill is seen exactly once, on every sort the head offers", async () => {
    await aBookOf55();

    const keys: BillSortKey[] = [
      "billDate",
      "dueDate",
      "billNo",
      "customerName",
      "amount",
      "paid",
      "balance",
      "overdueDays",
    ];

    for (const key of keys) {
      for (const dir of ["asc", "desc"] as const) {
        const seen: string[] = [];
        let total = 0;
        for (let page = 1; page <= 4; page++) {
          const got = await billLedgerPage(
            { financialYear: "26-27" },
            { page, perPage: PER_PAGE, sort: { key, dir } },
          );
          total = got.total;
          seen.push(...got.rows.map((r) => r.id));
        }

        assert.equal(total, 55, `${key} ${dir}: the count is the whole year`);
        assert.equal(seen.length, 55, `${key} ${dir}: 55 rows came back`);
        assert.equal(
          new Set(seen).size,
          55,
          `${key} ${dir}: a row appeared on two pages while another appeared on none`,
        );
      }
    }
  });

  test("the totals describe the whole filtered year, never the page", async () => {
    await aBookOf55();

    const page = await billLedgerPage(
      { financialYear: "26-27" },
      { page: 1, perPage: PER_PAGE },
    );
    const totals = await billLedgerTotals({ financialYear: "26-27" });
    const all = await listBills({ financialYear: "26-27" });

    assert.equal(page.rows.length, PER_PAGE);
    assert.equal(totals.count, 55);
    assert.equal(
      totals.billed,
      all.reduce((a, r) => a + r.amount, 0),
      "billed is the year, not the twenty rows on screen",
    );
    assert.equal(totals.received, all.reduce((a, r) => a + r.paid, 0));
    assert.equal(totals.open, all.reduce((a, r) => a + Math.max(0, r.balance), 0));
  });

  test("the status filter is applied by the query, so the count follows it", async () => {
    await aBookOf55();

    const unpaid = await billLedgerTotals({ financialYear: "26-27", status: "unpaid" });
    const paid = await billLedgerTotals({ financialYear: "26-27", status: "paid" });
    assert.equal(unpaid.count + paid.count, 55);
    assert.ok(unpaid.count > 0 && paid.count > 0);

    const page = await billLedgerPage(
      { financialYear: "26-27", status: "unpaid" },
      { page: 1, perPage: PER_PAGE },
    );
    assert.equal(page.total, unpaid.count);
    assert.ok(page.rows.every((r) => r.status === "unpaid"));
  });

  test("an empty set of bill ids is no bills, never every bill", async () => {
    await aBookOf55();
    const page = await billLedgerPage(
      { financialYear: "26-27", billIds: [] },
      { page: 1, perPage: PER_PAGE },
    );
    assert.equal(page.total, 0);
    assert.equal(page.rows.length, 0);
  });

  test("the bucket a band offers is the bucket the rows carry", async () => {
    await aBookOf55();
    const ages = await openBillAges({ financialYear: "26-27" });
    const band = ages.find((a) => a.overdueDays > 0)?.bucket;
    assert.ok(band, "some bill in this book is past its due date");

    const ids = ages.filter((a) => a.bucket === band).map((a) => a.id);
    const page = await billLedgerPage(
      { financialYear: "26-27", billIds: ids },
      { page: 1, perPage: 200 },
    );
    assert.equal(page.total, ids.length);
    assert.ok(
      page.rows.every((r) => r.bucket === band),
      "the rows in a band all read as that band",
    );
  });

  /**
   * THE ONE PLACE A RULE IS SPELLED TWICE, held to its promise.
   *
   * `effectiveDueDateSql` exists because a ledger sorted by due date and paged
   * in Postgres has to sort by a due date Postgres can see. Its note says the
   * duplication fails visibly — wrong ORDER, never a wrong figure — and that
   * a test rather than a promise is what keeps the two spellings together.
   * This is that test.
   */
  test("sorting by due date agrees with the engine's own due date", async () => {
    const customer = await makeCustomer("Terms Everywhere");
    // A bill that states its own date, one that inherits the customer's term,
    // and one that falls all the way through to the configured default.
    await db
      .update(customers)
      .set({ creditDays: 45 })
      .where(sql`customers.id = ${customer.id}`);
    await makeBill(customer.id, 1_00, {
      billNo: "MMI/26-27/D1",
      billDate: "2026-06-10",
      dueDate: "2026-06-11",
    });
    await makeBill(customer.id, 1_00, {
      billNo: "MMI/26-27/D2",
      billDate: "2026-06-10",
      dueDate: null,
    });
    const other = await makeCustomer("No Term At All");
    await makeBill(other.id, 1_00, {
      billNo: "MMI/26-27/D3",
      billDate: "2026-06-10",
      dueDate: null,
    });

    const config = await getConfig();
    const page = await billLedgerPage(
      { financialYear: "26-27" },
      { page: 1, perPage: 50, sort: { key: "dueDate", dir: "asc" } },
    );

    const engineOrder = [...page.rows]
      .map((r) => ({ id: r.id, due: r.dueDate }))
      .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0))
      .map((r) => r.id);

    assert.deepEqual(
      page.rows.map((r) => r.id),
      engineOrder,
      "Postgres ordered these by a different due date than `effectiveDueDate` did",
    );
    // And the figure on the row is still the engine's, never the query's.
    const d2 = page.rows.find((r) => r.billNo === "MMI/26-27/D2");
    assert.ok(d2);
    assert.equal(
      d2.dueDate,
      effectiveDueDate(
        { id: d2.id, billNo: d2.billNo, billDate: d2.billDate, dueDate: null, creditDays: 45, amount: d2.amount, paid: d2.paid, disputed: false },
        config,
      ),
    );
  });
});

/* -------------------------------------------------------- outstanding */

describe("Paging outstanding", () => {
  /** 23 customers with an open bill each, and one whose bill nobody has
      spoken for — which is not debt and must never be added in. */
  async function aBookOfDebtors() {
    for (let i = 0; i < 23; i++) {
      const c = await makeCustomer(`Debtor ${String(i).padStart(2, "0")}`);
      await makeBill(c.id, 10_000_00 + i * 100_00, {
        billDate: addDays(TODAY, -60 - i),
        dueDate: addDays(TODAY, -30 - i),
      });
      await recomputeOutstanding(c.id);
    }
    const quiet = await makeCustomer("Nobody Has Said");
    await makeBill(quiet.id, 90_000_00, {
      billDate: addDays(TODAY, -60),
      dueDate: addDays(TODAY, -30),
      paymentPosition: "unstated",
    });
    await recomputeOutstanding(quiet.id);
    return quiet;
  }

  test("every customer is seen exactly once across the pages", async () => {
    await aBookOfDebtors();

    for (const sort of ["owed", "oldest", "name"] as const) {
      const seen: string[] = [];
      let total = 0;
      for (let page = 1; page <= 4; page++) {
        const got = await outstandingPage({ sort, page, perPage: 7 });
        total = got.total;
        seen.push(...got.rows.map((r) => r.customerId));
      }
      assert.equal(total, 24, `${sort}: 23 debtors and one unstated`);
      assert.equal(seen.length, 24, `${sort}: 24 rows came back`);
      assert.equal(
        new Set(seen).size,
        24,
        `${sort}: a customer appeared on two pages while another appeared on none`,
      );
    }
  });

  test("the page's rows and totals say what the whole-book read says", async () => {
    await aBookOfDebtors();

    const whole = await listOutstandingByCustomer();
    const expected = outstandingTotals(whole);
    const paged = await outstandingPage({ perPage: 7 });

    assert.equal(paged.total, whole.length);
    assert.equal(paged.totals.outstanding, expected.outstanding);
    assert.equal(paged.totals.customers, expected.customers);
    assert.equal(paged.totals.bills, expected.bills);
    assert.equal(paged.totals.overdueCustomers, expected.overdueCustomers);
    assert.equal(paged.totals.overdue, expected.overdue);
    assert.equal(paged.totals.unstatedCustomers, expected.unstatedCustomers);
    assert.equal(paged.totals.unstatedAmount, expected.unstatedAmount);

    // Most owed first, and the figures on a row are the engine's own.
    const top = paged.rows[0];
    const same = whole.find((r) => r.customerId === top.customerId);
    assert.ok(same);
    assert.equal(top.outstanding, same.outstanding);
    assert.equal(top.bills.length, same.bills.length);
  });

  test("a bill nobody has spoken for is shown, counted apart, and never owed", async () => {
    const quiet = await aBookOfDebtors();
    const paged = await outstandingPage({ perPage: 200 });

    const row = paged.rows.find((r) => r.customerId === quiet.id);
    assert.ok(row, "the customer is on the list rather than hidden");
    assert.equal(row.outstanding, 0, "an unstated bill is not debt");
    assert.equal(row.unstatedBills, 1);
    assert.equal(row.unstatedAmount, 90_000_00);
    assert.equal(row.bills.length, 1, "and the bill itself is still shown");

    assert.equal(paged.totals.unstatedAmount, 90_000_00);
    assert.ok(
      paged.totals.outstanding > 0 &&
        paged.totals.outstanding < 90_000_00 * 24,
      "the unstated amount is nowhere inside the outstanding figure",
    );
    const stated = paged.rows
      .filter((r) => r.customerId !== quiet.id)
      .reduce((a, r) => a + r.outstanding, 0);
    assert.equal(paged.totals.outstanding, stated);
  });

  test("past due only and the search narrow the count, not just the page", async () => {
    await aBookOfDebtors();

    const all = await outstandingPage({ perPage: 200 });
    const overdue = await outstandingPage({ overdueOnly: true, perPage: 200 });
    assert.equal(overdue.total, 23, "the unstated one is not past due — it is not debt");
    assert.ok(overdue.total < all.total);

    const found = await outstandingPage({ query: "Debtor 0", perPage: 200 });
    assert.equal(found.total, found.rows.length);
    assert.ok(found.total > 0 && found.total < all.total);
    assert.ok(found.rows.every((r) => r.customerName.includes("Debtor 0")));
  });

  test("a page past the end lands on the last page rather than on nothing", async () => {
    await aBookOfDebtors();
    const got = await outstandingPage({ page: 99, perPage: 7 });
    assert.equal(got.page, 4);
    assert.equal(got.rows.length, 3);
  });
});
