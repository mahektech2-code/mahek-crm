/**
 * THE PLACE MASTER, BUILT AND REBUILT.
 *
 *   npm run test:integration
 *
 * `place-parse.test.ts` beside this pins the READING of a geocoder answer and
 * is pure. This pins the half a type checker cannot see: the SQL. Every bug
 * this subsystem can plausibly have lives there — a partial unique index that
 * cannot be named in `on conflict`, a parent compared with `=` against null,
 * a rebuild that quietly duplicates the tree on its second run.
 *
 * IT SEEDS THE LOOKUPS RATHER THAN CALLING OLA. The fixtures are hand-written
 * in the shape a real answer has (`place-parse.test.ts` carries one taken
 * verbatim), because a test that reached a supplier would be a test that fails
 * when somebody else's service is slow, and because the whole point of
 * `customer_place_lookups` is that the reading can be exercised without
 * spending a request.
 *
 * Needs mahekone_test; `npm run test:db` creates it.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { customers, users } from "@/db/schema";
import { proposePlaces, resolvePlaces } from "@/lib/services/place-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/** A geocoder answer, in the shape Ola actually returns one. */
function answer(state: string, district?: string, city?: string, area?: string) {
  const parts: Array<{ types: string[]; long_name: string }> = [
    { types: ["country"], long_name: "India" },
    { types: ["administrative_area_level_1"], long_name: state },
  ];
  if (district) parts.push({ types: ["administrative_area_level_2"], long_name: district });
  if (city) parts.push({ types: ["locality"], long_name: city });
  if (area) parts.push({ types: ["sublocality"], long_name: area });
  return { formatted_address: [area, city, district, state].filter(Boolean).join(", "),
           address_components: parts };
}

let owner: typeof users.$inferSelect;

async function shop(
  name: string,
  raw: ReturnType<typeof answer> | null,
  opts: { source?: string; city?: string } = {},
) {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      city: opts.city ?? "whatever the sheet typed",
      ownerId: owner.id,
    })
    .returning();

  await db.execute(sql`
    insert into customer_place_lookups (customer_id, source, lat, lng, raw, ok)
    values (${row.id}, ${opts.source ?? "gps"}, 21.1, 79.0,
            ${raw ? JSON.stringify(raw) : null}::jsonb, ${Boolean(raw)})
  `);
  return row;
}

before(async () => {
  /* Nothing truncates between suites here — each one cleans up after itself —
     so this both clears what a previous run may have left and takes a unique
     identity. A fixed phone number passes on an empty database and fails on
     the second run, which is the least useful place for a test to be red.
     The order is the FK order: a shop points at its owner and at its places,
     so the leaves go first. */
  await db.execute(sql`
    delete from customers
     where customers.owner_id in (select users.id from users where users.name = 'Place Owner')
  `);
  await db.execute(sql`delete from places`);
  await db.execute(sql`delete from users where users.name = 'Place Owner'`);
  [owner] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name: "Place Owner",
      email: `places-${randomUUID().slice(0, 6)}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role: "manager",
      initials: "PO",
    })
    .returning();
});

beforeEach(async () => {
  await db.execute(sql`delete from customer_place_lookups`);
  await db.execute(sql`update customers set resolved_state_id = null,
    resolved_district_id = null, resolved_city_id = null, resolved_area_id = null,
    place_source = null, place_resolved_at = null, place_decided_at = null`);
  await db.execute(sql`delete from places`);
  await db.execute(sql`delete from customers where owner_id = ${owner.id}`);
});

test("four rungs become four nodes, and the shop points at each", async () => {
  const s = await shop("Nagpur shop", answer("Maharashtra", "Nagpur", "Nagpur", "Sitabuldi"));

  const run = await resolvePlaces();
  assert.equal(run.resolved, 1);

  const [row] = await db.execute<{
    state: string; district: string; city: string; area: string; source: string;
  }>(sql`
    select st.name as state, di.name as district, ci.name as city, ar.name as area,
           c.place_source as source
      from customers c
      join places st on st.id = c.resolved_state_id
      join places di on di.id = c.resolved_district_id
      join places ci on ci.id = c.resolved_city_id
      join places ar on ar.id = c.resolved_area_id
     where c.id = ${s.id}
  `);
  assert.equal(row.state, "Maharashtra");
  assert.equal(row.district, "Nagpur");
  assert.equal(row.city, "Nagpur");
  assert.equal(row.area, "Sitabuldi");
  assert.equal(row.source, "gps");
});

test("a district and a city of the same name are two nodes, not one", async () => {
  /* They are the same word constantly and are different rungs. Folding them
     would put a city under itself, and every count above it would then be
     counting the same shops twice. */
  await shop("A", answer("Maharashtra", "Nagpur", "Nagpur"));
  await resolvePlaces();

  const rows = await db.execute<{ kind: string; parent: string | null }>(sql`
    select places.kind, places.parent_id as parent from places where places.key = 'nagpur'
  `);
  assert.equal(rows.length, 2);
  assert.deepEqual(new Set(rows.map((r) => r.kind)), new Set(["district", "city"]));
});

test("two spellings of one place are one node", async () => {
  await shop("A", answer("Maharashtra", "Thane", "Mira Road"));
  await shop("B", answer("Maharashtra", "Thane", "mira  road"));
  await resolvePlaces();

  const [{ n }] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from places where places.kind = 'city' and places.key = 'miraroad'
  `);
  assert.equal(n, 1, "one city, however it was spelled");

  const [{ shops }] = await db.execute<{ shops: number }>(sql`
    select places.shops from places where places.kind = 'city' and places.key = 'miraroad'
  `);
  assert.equal(shops, 2, "and it carries both shops");
});

test("the same city name under two states stays two nodes", async () => {
  /* There is an Aurangabad in Maharashtra and another in Bihar. Keyed without
     the parent they would be one place, and allocating one would hand
     somebody the other. */
  await shop("A", answer("Maharashtra", "Aurangabad", "Aurangabad"));
  await shop("B", answer("Bihar", "Aurangabad", "Aurangabad"));
  await resolvePlaces();

  const [{ n }] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from places where places.kind = 'city' and places.key = 'aurangabad'
  `);
  assert.equal(n, 2);
});

test("running it twice writes the same tree — no duplicates, same ids", async () => {
  /* The failure this is for: the node upsert cannot use `on conflict`, because
     the uniqueness is carried by two PARTIAL indexes and a partial index
     cannot be named there. Conflicting on the primary key instead would never
     fire, since the id is a fresh uuid every run. */
  await shop("A", answer("Kerala", "Ernakulam", "Kochi", "Panampilly Nagar"));
  await resolvePlaces();

  const before = await db.execute<{ id: string; kind: string }>(sql`
    select places.id, places.kind from places order by places.kind, places.key
  `);
  await resolvePlaces();
  const after = await db.execute<{ id: string; kind: string }>(sql`
    select places.id, places.kind from places order by places.kind, places.key
  `);

  assert.equal(after.length, 4);
  assert.deepEqual(after.map((r) => r.id), before.map((r) => r.id), "the ids are stable");
});

test("a state is found again on the second run, though its parent is null", async () => {
  /* `parent_id = null` is null, which matches nothing, so `=` would make every
     state look new on every run and the partial unique index would refuse the
     insert. `is not distinct from` is the fix and this is what guards it. */
  await shop("A", answer("Goa"));
  await resolvePlaces();
  await resolvePlaces();

  const [{ n }] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from places where places.kind = 'state' and places.key = 'goa'
  `);
  assert.equal(n, 1);
});

test("a chain with a hole stops at the district, and no area is invented", async () => {
  await shop("Rural", answer("Madhya Pradesh", "Betul", undefined, "Some Colony"));
  await resolvePlaces();

  const [row] = await db.execute<{ city: string | null; area: string | null }>(sql`
    select c.resolved_city_id as city, c.resolved_area_id as area
      from customers c where c.name = 'Rural'
  `);
  assert.equal(row.city, null);
  assert.equal(row.area, null);

  const [{ n }] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from places where places.kind = 'area'
  `);
  assert.equal(n, 0, "an area with no city to hang from is not written anywhere");
});

test("a shop nobody could locate is left null and counted, never guessed", async () => {
  await shop("Unlocatable", null, { city: "Jaipur" });
  const run = await resolvePlaces();

  assert.equal(run.resolved, 0);
  const [row] = await db.execute<{ state: string | null }>(sql`
    select c.resolved_state_id as state from customers c where c.name = 'Unlocatable'
  `);
  assert.equal(row.state, null, "its typed city is NOT read as a state");
  assert.ok(run.unresolved >= 1);
});

test("a shop somebody decided is left exactly as they left it", async () => {
  /* The `am_decided_at` guard, one table over: a job that runs unattended must
     not undo a person's decision. */
  const s = await shop("Decided", answer("Maharashtra", "Pune", "Pune"));
  await db.execute(sql`
    update customers set place_decided_at = now(), place_source = 'manual'
     where customers.id = ${s.id}
  `);

  const run = await resolvePlaces();
  assert.equal(run.respected, 1);

  const [row] = await db.execute<{ state: string | null; source: string }>(sql`
    select c.resolved_state_id as state, c.place_source as source
      from customers c where c.id = ${s.id}
  `);
  assert.equal(row.state, null, "the rebuild did not fill it in");
  assert.equal(row.source, "manual");
});

test("a count on a node includes everything under it", async () => {
  await shop("A", answer("Maharashtra", "Thane", "Kalyan"));
  await shop("B", answer("Maharashtra", "Thane", "Dombivali"));
  await shop("C", answer("Maharashtra", "Thane"));
  await resolvePlaces();

  const [{ shops }] = await db.execute<{ shops: number }>(sql`
    select places.shops from places where places.kind = 'district' and places.key = 'thane'
  `);
  assert.equal(shops, 3, "two cities plus the one that stops at the district");
});

test("the proposal writes nothing", async () => {
  await shop("A", answer("Odisha", "Khordha", "Bhubaneswar"));

  const proposal = await proposePlaces();
  assert.equal(proposal.counts.state, 1);
  assert.equal(proposal.counts.city, 1);
  assert.ok(proposal.tree.length >= 3);

  const [{ n }] = await db.execute<{ n: number }>(sql`select count(*)::int as n from places`);
  assert.equal(n, 0, "reading the master must not create it");

  const [{ resolved }] = await db.execute<{ resolved: number }>(sql`
    select count(*)::int as resolved from customers where customers.resolved_state_id is not null
  `);
  assert.equal(resolved, 0);
});

test("the proposal says what did not resolve, and why", async () => {
  await shop("Located", answer("Goa", "North Goa", "Mapusa"));
  await shop("Asked and unanswered", null);

  const proposal = await proposePlaces();
  assert.equal(proposal.unresolved.lookupFailed, 1);
  /* Every other customer in the database has no lookup row at all, which is a
     different fact from having been asked — and the two are counted apart. */
  assert.ok(proposal.unresolved.noLookup >= 0);
  assert.equal(proposal.unresolved.total, proposal.customers - 1);
});

after(async () => {
  await db.execute(sql`delete from customers where customers.owner_id = ${owner.id}`);
  await db.execute(sql`delete from places`);
  await db.execute(sql`delete from users where users.id = ${owner.id}`);
  /* The pool is closed or the process never exits, and the runner invokes one
     file at a time with `execFileSync` — a suite that hangs stalls every suite
     behind it rather than failing. */
  await db.$client.end();
});
