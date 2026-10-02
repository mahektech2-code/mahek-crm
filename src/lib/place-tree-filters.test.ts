/**
 * THE REVIEWED LOCATION TREE, IMPORTED AND FILTERED ON.
 *
 *   npm run test:integration
 *
 * `place-tree.test.ts` pins the matching rules and is pure. This pins the SQL:
 * the import writing `places` and the four columns idempotently, the typed
 * matcher placing a shop the review never saw, and the one clause the customer
 * list and the lead list both narrow by.
 *
 * Needs mahekone_test; `npm run test:db` creates it.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, customers, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { listCustomersPage, listPlaceFilterOptions } from "@/lib/queries";
import { leadPlaceOptions, leadsPage } from "@/lib/services/sales-service";
import { importPlaceTree, resolveTypedPlaces } from "@/lib/services/place-tree-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const TODAY = "2026-10-02";

let admin: typeof users.$inferSelect;

async function shop(name: string, over: Partial<typeof customers.$inferInsert> = {}) {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name,
      phone: String(9000000000 + Math.floor(Math.random() * 999999999)),
      city: "whatever the sheet typed",
      kind: "customer",
      ...over,
    })
    .returning();
  return row;
}

async function placeId(kind: string, name: string): Promise<string> {
  const [row] = (await db.execute<{ id: string }>(sql`
    select places.id from places where places.kind = ${kind} and places.name = ${name} limit 1
  `)) as unknown as Array<{ id: string }>;
  assert.ok(row, `${kind} ${name} exists`);
  return row.id;
}

function csv(rows: Array<[string, string, string, string, string]>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "places-"));
  const file = path.join(dir, "customer-places.csv");
  writeFileSync(
    file,
    ["customer_id,state,district,city,area,how_sure", ...rows.map((r) => [...r, "test"].join(","))].join("\n"),
  );
  return file;
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
    truncate table app_access, customers, places, users, app_settings restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name: "Place Admin",
      email: `place-admin-${randomUUID().slice(0, 4)}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role: "admin",
      initials: "PA",
    })
    .returning();
  admin = row;
  for (const app of ["crm", "sales"] as const) {
    await db.insert(appAccess).values({ id: id("aca"), userId: admin.id, app, role: "admin" });
  }
  setTestUser(admin);
});

after(async () => {
  setTestUser(null);
  /* Leave no shop pointing at a place: the next suite (`place-master`) clears
     `places` with a plain delete, and a foreign key from here would fail it. */
  await db.execute(sql`truncate table app_access, customers, places, users restart identity cascade`);
  await db.$client.end();
});

test("the import writes the tree once, places each shop, and marks it decided", async () => {
  const kandivali = await shop("Kandivali Paints");
  const bhiwandi = await shop("Bhiwandi Hardware");
  const file = csv([
    [kandivali.id, "Maharashtra", "Mumbai", "Mumbai", "Kandivali West"],
    [bhiwandi.id, "Maharashtra", "Thane", "Bhiwandi", ""],
    ["cus_not-here-000", "Goa", "North Goa", "Mapusa", ""],
  ]);

  const first = await importPlaceTree({ file });
  assert.equal(first.customersSet, 2);
  assert.equal(first.customersMissing, 1, "a row for a shop this database lacks is counted, not thrown");
  assert.equal(first.placesCreated, 9);

  const again = await importPlaceTree({ file });
  assert.equal(again.placesCreated, 0, "a second run reuses every node");

  const [row] = (await db.execute<{
    source: string;
    decided: boolean;
    area: string | null;
  }>(sql`
    select c.place_source as source, c.place_decided_at is not null as decided,
           (select p.name from places p where p.id = c.resolved_area_id) as area
      from customers c where c.id = ${kandivali.id}
  `)) as unknown as Array<{ source: string; decided: boolean; area: string | null }>;
  assert.equal(row.source, "review");
  assert.equal(row.decided, true);
  assert.equal(row.area, "Kandivali West");
});

test("a shop the review never saw is placed from its typed text, and only that one", async () => {
  const reviewed = await shop("Reviewed", { region: "Maharashtra", city: "Bhandup" });
  await importPlaceTree({
    file: csv([
      [reviewed.id, "Maharashtra", "Thane", "Thane", ""],
      ["cus_seed-0000000", "Maharashtra", "Mumbai", "Mumbai", "Bhandup"],
    ]),
  });
  const fresh = await shop("New lead", { region: null, city: "bhandup", kind: "lead", leadStage: "new" });

  const run = await resolveTypedPlaces();
  assert.equal(run.toArea, 1);

  const placed = (await db.execute<{ id: string; area: string | null; city: string | null }>(sql`
    select c.id,
           (select p.name from places p where p.id = c.resolved_area_id) as area,
           (select p.name from places p where p.id = c.resolved_city_id) as city
      from customers c
  `)) as unknown as Array<{ id: string; area: string | null; city: string | null }>;
  const byId = new Map(placed.map((p) => [p.id, p]));
  assert.equal(byId.get(fresh.id)?.area, "Bhandup", "typed as the city, found as the area");
  assert.equal(byId.get(reviewed.id)?.city, "Thane", "a reviewed shop is never re-read from its text");
});

test("the customer list and the lead list narrow by the same four, and the options cascade", async () => {
  const mumbai = await shop("Mumbai Shop");
  const thane = await shop("Thane Shop");
  const goa = await shop("Goa Shop");
  const lead = await shop("Mumbai Lead", { kind: "lead", leadStage: "new", leadSource: "manual" });
  await importPlaceTree({
    file: csv([
      [mumbai.id, "Maharashtra", "Mumbai", "Mumbai", "Andheri East"],
      [thane.id, "Maharashtra", "Thane", "Thane", ""],
      [goa.id, "Goa", "North Goa", "Mapusa", ""],
      [lead.id, "Maharashtra", "Mumbai", "Mumbai", "Bhandup"],
    ]),
  });
  const mh = await placeId("state", "Maharashtra");
  const thaneDistrict = await placeId("district", "Thane");
  const mumbaiCity = await placeId("city", "Mumbai");

  const inState = await listCustomersPage({ places: { state: mh } });
  assert.deepEqual(inState.rows.map((r) => r.name).sort(), ["Mumbai Shop", "Thane Shop"]);

  const inDistrict = await listCustomersPage({ places: { district: thaneDistrict } });
  assert.deepEqual(inDistrict.rows.map((r) => r.name), ["Thane Shop"]);
  assert.equal(inDistrict.rows[0].place?.state, "Maharashtra", "the row carries its place by name");

  const options = await listPlaceFilterOptions({ state: mh });
  assert.deepEqual(options.state.length, 2, "the state list is never narrowed by its own pick");
  assert.deepEqual(
    options.district.map((o) => o.label).sort(),
    ["Mumbai — Maharashtra (1)", "Thane — Maharashtra (1)"],
    "districts are Maharashtra's alone, counted over the customer book (the lead is not in it)",
  );

  const leads = await leadsPage(TODAY, { filters: { city: mumbaiCity } });
  assert.deepEqual(leads.rows.map((r) => r.name), ["Mumbai Lead"]);
  assert.equal(leads.rows[0].area, "Bhandup", "the lead row shows the tree's area");

  const leadOptions = await leadPlaceOptions(false);
  assert.deepEqual(
    leadOptions.area.map((o) => o.label),
    ["Bhandup — Mumbai (1)"],
    "the lead list's options are counted over leads, not customers",
  );
});
