/**
 * The Leads list: what it shows, what it hides, and what it can be narrowed by.
 *
 *   npm run test:integration
 *
 * Three things are pinned here and every one of them was broken on production
 * the day this was written:
 *
 *   A LEAD NOBODY OWNS WAS INVISIBLE TO EVERY REGIONAL MANAGER. `onlyMine`
 *   renders `owner_id in (…)` and `in` never matches NULL — 3,265 of 3,776
 *   leads, on the one screen that exists to get leads assigned, under a desk
 *   card counting the very rows the table was not showing.
 *
 *   THE LIST WAS THE WHOLE BOOK. Four hundred rows, every one rendered, no
 *   filter over any column. Paging it is only safe if the counts around the
 *   table describe the FILTERED SET rather than the page — a "12 stale" that
 *   secretly means "12 on this page" is worse than no number.
 *
 *   A BUCKET THAT MATCHES NOTHING IS SILENT. Potential, next, age and health
 *   are ranges rather than values, so a typo in one of their option values
 *   produces a filter that returns an empty table and no error. The last test
 *   walks every option the dropdowns offer and asserts the server has a
 *   predicate for it.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, customers, mbosUserTerritories, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import {
  leadFilterOptions,
  LEADS_PER_PAGE,
  leadsPage,
} from "@/lib/services/sales-service";
import { BUCKET_LISTS, UNASSIGNED, type LeadFilters } from "@/lib/lead-filters";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const TODAY = "2026-09-13";

let manager: typeof users.$inferSelect;
let salesman: typeof users.$inferSelect;

async function makeUser(name: string, role: "associate" | "manager" | "admin", app: "sales" | "field") {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 4)}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app, role });
  return row;
}

async function makeLead(over: Partial<typeof customers.$inferInsert> = {}) {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: over.name ?? `Lead ${randomUUID().slice(0, 6)}`,
      contactPerson: "Contact",
      phone: String(9000000000 + Math.floor(Math.random() * 999999999)),
      city: "Nagpur",
      kind: "lead",
      leadStage: "new",
      leadSource: "manual",
      createdAt: new Date(`${TODAY}T04:00:00Z`),
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
    truncate table mbos_user_territories, app_access, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  manager = await makeUser("Regional Manager", "manager", "sales");
  salesman = await makeUser("Field Salesman", "associate", "field");
  setTestUser(manager);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("a lead nobody owns", () => {
  test("is on a REGIONAL manager's list, beside the ones his own salesman holds", async () => {
    // What makes him regional rather than national — `managerScope` reads
    // `kind = 'region'` and narrows to the salesmen working that patch.
    await db.insert(mbosUserTerritories).values({
      id: id("ter"),
      userId: manager.id,
      kind: "region",
      region: "Maharashtra",
    });
    await makeLead({ name: "His man's lead", ownerId: salesman.id, territoryRegion: "Maharashtra" });
    const orphan = await makeLead({ name: "Nobody's lead", ownerId: null });

    const page = await leadsPage(TODAY);
    const names = page.rows.map((r) => r.name);
    assert.ok(
      names.includes("Nobody's lead"),
      "an unowned lead is nobody's to hide — this is the production bug",
    );
    assert.ok(names.includes("His man's lead"), "and his own team's lead is still there");
    assert.equal(page.total, 2);

    // And it can be found on its own, which is what the desk card promises.
    const onlyOrphans = await leadsPage(TODAY, { filters: { owner: UNASSIGNED } });
    assert.deepEqual(onlyOrphans.rows.map((r) => r.id), [orphan.id]);
  });

  test("does not drag in another salesman's leads", async () => {
    await db.insert(mbosUserTerritories).values({
      id: id("ter"),
      userId: manager.id,
      kind: "region",
      region: "Maharashtra",
    });
    const stranger = await makeUser("Somebody Else's Man", "associate", "field");
    await makeLead({ name: "Gujarat lead", ownerId: stranger.id, territoryRegion: "Gujarat" });

    const page = await leadsPage(TODAY);
    assert.equal(page.total, 0, "the widening is about ownership, not about everybody");
  });
});

/*
 * THE PAGE SIZE IS READ, NOT TYPED.
 *
 * These pinned a literal ten, which is a number that has already moved twice —
 * four hundred to ten when the paging landed, and ten to fifteen when the
 * screen turned out to leave half a panel empty under its own filter bar. A
 * test that fails on that is a test asserting a product decision it does not
 * own, and the failure says nothing about whether paging works.
 *
 * What these DO own is the behaviour: every lead appears exactly once across
 * the pages, a page past the end clamps rather than showing an empty table,
 * and the totals describe the filtered set rather than the page. The seed is
 * sized off the constant so there are always three pages with a partial last
 * one, whatever the constant says.
 */
describe("paging", () => {
  /** Two full pages and a partial third, at any page size. */
  const SEEDED = LEADS_PER_PAGE * 2 + 5;

  beforeEach(async () => {
    for (let i = 0; i < SEEDED; i++) {
      await makeLead({ name: `Lead ${String(i).padStart(2, "0")}`, ownerId: salesman.id });
    }
  });

  test("a page holds what the screen asked for, and every lead appears exactly once", async () => {
    const first = await leadsPage(TODAY);
    assert.equal(first.rows.length, LEADS_PER_PAGE, "a full first page");
    assert.equal(first.total, SEEDED);
    assert.equal(first.pageCount, 3);

    const seen = new Set<string>();
    for (let p = 1; p <= first.pageCount; p++) {
      const page = await leadsPage(TODAY, { page: p });
      for (const r of page.rows) {
        assert.equal(seen.has(r.id), false, `${r.name} appeared on two pages`);
        seen.add(r.id);
      }
    }
    assert.equal(seen.size, SEEDED, "and none fell between two pages");
  });

  test("a page past the end lands on the last one rather than on an empty table", async () => {
    const page = await leadsPage(TODAY, { page: 99 });
    assert.equal(page.page, 3);
    assert.equal(page.rows.length, 5, "the partial last page");
  });

  test("the totals describe the FILTERED set and the list, never the page", async () => {
    await makeLead({ name: "Indiamart one", ownerId: salesman.id, leadSource: "indiamart" });
    const page = await leadsPage(TODAY, { filters: { source: "indiamart" } });
    assert.equal(page.total, 1, "what the filter found");
    assert.equal(page.listTotal, SEEDED + 1, "and what there is to find");
  });
});

/*
 * THE SEARCH BOX, which is the one question seven dropdowns cannot put.
 */
describe("the search", () => {
  test("it matches the shop, and every word has to appear somewhere", async () => {
    await makeLead({ name: "Orange City Chemicals", ownerId: salesman.id, city: "Nagpur" });
    await makeLead({ name: "Sagar Coatings", ownerId: salesman.id, city: "Nashik" });

    assert.equal((await leadsPage(TODAY, { filters: { search: "orange" } })).total, 1);
    assert.equal(
      (await leadsPage(TODAY, { filters: { search: "nashik coatings" } })).total,
      1,
      "two words are two facts about one shop, and both have to land",
    );
    assert.equal(
      (await leadsPage(TODAY, { filters: { search: "nagpur coatings" } })).total,
      0,
      "the two words are AND rather than OR",
    );
  });

  test("IT REACHES THE OWNER'S NAME, which is the half nobody would guess at", async () => {
    await makeLead({ name: "Om Sai Paints", ownerId: salesman.id });
    await makeLead({ name: "Om Sai Paints Two", ownerId: null });

    const mine = await leadsPage(TODAY, { filters: { search: "field salesman" } });
    assert.equal(mine.total, 1, "everything Field Salesman has");
    assert.equal(mine.rows[0]?.name, "Om Sai Paints");
  });

  test("a wildcard typed into the box is a character, not a wildcard", async () => {
    await makeLead({ name: "50 litre drum", ownerId: salesman.id });
    await makeLead({ name: "50_litre drum", ownerId: salesman.id });

    assert.equal(
      (await leadsPage(TODAY, { filters: { search: "50_litre" } })).total,
      1,
      "an underscore matches an underscore, never any character",
    );
    assert.equal(
      (await leadsPage(TODAY, { filters: { search: "%" } })).total,
      0,
      "and a percent matches nothing rather than everything",
    );
  });

  test("it narrows the same set the totals and the stale strip describe", async () => {
    await makeLead({ name: "Findable", ownerId: salesman.id });
    await makeLead({ name: "Other", ownerId: salesman.id });

    const page = await leadsPage(TODAY, { filters: { search: "findable" } });
    assert.equal(page.total, 1, "what the search found");
    assert.equal(page.listTotal, 2, "and what there was to find");
  });
});

/*
 * A LEAD NOBODY HAS EVER TOUCHED IS THE QUIETEST THERE IS.
 *
 * `lead_last_activity_date` is nullable, and `coalesce(day - it, 0)` answered
 * NOUGHT for one — which is never at or past the stale threshold. So the one
 * list somebody opens to find abandoned leads was the list hiding the most
 * abandoned ones.
 */
describe("how long a lead has been quiet", () => {
  test("with no activity ever, it is counted from the day it was raised", async () => {
    await makeLead({
      name: "Never worked",
      ownerId: salesman.id,
      leadLastActivityDate: null,
      createdAt: new Date("2026-06-13T04:00:00Z"),
    });

    const page = await leadsPage(TODAY);
    assert.equal(page.rows[0]?.quietDays, 92, "three months, not nought");
    assert.equal(page.stale.count, 1, "and the strip counts it");
    assert.deepEqual(page.stale.names, ["Never worked"], "and names it");
  });

  test("with activity, it is counted from that", async () => {
    await makeLead({
      name: "Worked last week",
      ownerId: salesman.id,
      leadLastActivityDate: "2026-09-06",
      createdAt: new Date("2026-01-01T04:00:00Z"),
    });

    const page = await leadsPage(TODAY);
    assert.equal(page.rows[0]?.quietDays, 7, "the activity wins over the age");
    assert.equal(page.stale.count, 0, "and a week is not stale");
  });
});

describe("the filters", () => {
  test("owner, source and stage are read off the book, with their counts", async () => {
    await makeLead({ ownerId: salesman.id, leadSource: "indiamart" });
    await makeLead({ ownerId: salesman.id, leadSource: "indiamart" });
    await makeLead({ ownerId: null, leadSource: "referral" });

    const options = await leadFilterOptions();
    assert.deepEqual(
      options.sources.map((s) => `${s.value}:${s.count}`),
      ["indiamart:2", "referral:1"],
      "biggest first, so the one worth ticking is at the top",
    );
    const nobody = options.owners.find((o) => o.value === UNASSIGNED);
    assert.equal(nobody?.label, "Nobody", "an unheld lead is an option, not a gap");
    assert.equal(nobody?.count, 1);
    assert.deepEqual(options.stages.map((s) => s.value), ["new"]);
  });

  test("each one narrows, and two of them narrow together", async () => {
    await makeLead({
      name: "Wanted",
      ownerId: salesman.id,
      leadSource: "indiamart",
      leadEstimatedPotentialPaise: 30000000, // ₹3,00,000 — over two lakh
      leadNextFollowUpDate: TODAY,
    });
    await makeLead({ name: "Wrong source", ownerId: salesman.id, leadSource: "referral" });
    await makeLead({
      name: "Wrong potential",
      ownerId: salesman.id,
      leadSource: "indiamart",
      leadEstimatedPotentialPaise: 100000,
    });

    const narrow = async (filters: LeadFilters) =>
      (await leadsPage(TODAY, { filters })).rows.map((r) => r.name);

    assert.deepEqual(await narrow({ source: "indiamart", potential: "over2l" }), ["Wanted"]);
    assert.deepEqual(await narrow({ next: "today" }), ["Wanted"]);
    assert.deepEqual((await narrow({ next: "none" })).sort(), ["Wrong potential", "Wrong source"]);
    assert.deepEqual(await narrow({ potential: "none" }), ["Wrong source"]);
    assert.equal((await narrow({ age: "week" })).length, 3, "all three were raised today");
    assert.equal((await narrow({ age: "older" })).length, 0);
    assert.equal((await narrow({ health: "lead" })).length, 3, "none of them has ordered");

    // Nothing ticked is not a filter, which is `MultiSelect`'s own contract.
    assert.equal((await narrow({})).length, 3);
    assert.equal((await narrow({ source: "" })).length, 3);
    assert.deepEqual(
      (await narrow({ source: "indiamart,referral" })).length,
      3,
      "two ticked is an OR, not an AND",
    );
  });

  test("EVERY option the dropdowns offer has a predicate behind it", async () => {
    /*
     * The one that catches a typo. A bucket value the SQL switch does not know
     * falls through to `null`, contributes no clause, and the filter silently
     * returns the whole list — which reads as a filter that does nothing, on a
     * screen where that is indistinguishable from a list that has no matches.
     * Running each one proves the database accepts it; comparing against the
     * unfiltered count proves it is actually narrowing something.
     */
    await makeLead({ ownerId: salesman.id, leadEstimatedPotentialPaise: 30000000 });
    await makeLead({ ownerId: salesman.id, leadNextFollowUpDate: TODAY });
    const all = (await leadsPage(TODAY)).total;
    assert.ok(all > 0);

    for (const [column, buckets] of Object.entries(BUCKET_LISTS)) {
      let matched = 0;
      for (const bucket of buckets) {
        const page = await leadsPage(TODAY, { filters: { [column]: bucket.value } });
        assert.ok(
          page.total <= all,
          `${column}=${bucket.value} matched more than the whole list`,
        );
        matched += page.total;
      }
      assert.equal(
        matched,
        all,
        `every lead should fall in exactly one ${column} bucket — ${matched} against ${all} says the buckets overlap or leave a gap`,
      );
    }
  });
});
