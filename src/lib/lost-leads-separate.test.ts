import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, customers, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { leadFilterOptions, leadIdsMatching, leadsPage } from "@/lib/services/sales-service";
import { leadTileCounts } from "@/lib/services/lead-views-service";
import { lostLeadsPage } from "@/lib/services/lead-lost-service";

/* ---------------------------------------------------------------------------
 * LOST LEADS ARE IN THE LOST SECTION AND NOT IN THE MAIN LIST — for the page of
 * rows, its total, its search, the select-everything ids, the dropdown options
 * and the tile counts alike, whoever is asking. The one view that exists to
 * show what closed this month (`lost30`) keeps them on purpose.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const TODAY = "2026-09-13";
const tag = randomUUID().slice(0, 6);
const created: string[] = [];
let admin: typeof users.$inferSelect;
const lead: Record<string, string> = {};

async function mk(key: string, stage: "new" | "suspect" | "lost" | "won") {
  const [c] = await db.insert(customers).values({
    id: id("cus"), name: `${key} ${tag}`, kind: "lead", leadStage: stage, leadSalesType: "direct", leadSource: "manual",
    city: "Nashik", contactPerson: "T", phone: String(9100000000 + Math.floor(Math.random() * 99999999)),
    leadStageSince: TODAY, leadLastActivityDate: TODAY, leadLostReason: stage === "lost" ? "price" : null,
  }).returning();
  lead[key] = c.id; created.push(c.id);
}

before(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run against the test database only.");
  await seedConfig(); invalidateConfig();
  const [u] = await db.insert(users).values({ id: id("usr"), name: `Admin ${tag}`, email: `admin-${tag}@test.local`, phone: String(9840000000 + Math.floor(Math.random() * 99999)), passwordHash: "x", role: "admin", initials: "AD" }).returning();
  admin = u;
  await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app: "sales", role: "admin" });
  setTestUser(admin);
  await mk("liveNew", "new"); await mk("liveSuspect", "suspect"); await mk("lostOne", "lost");
  /* The live and the lost lead are both the admin's, so the "mine" tile WOULD count the lost one if lost leads were not left out. */
  for (const k of ["liveNew", "lostOne"]) await db.update(customers).set({ ownerId: admin.id }).where(eq(customers.id, lead[k]));
  /* Both the live and the lost lead are the admin's, so the "mine" tile WOULD count the lost one if lost leads were not left out. */
  for (const k of ["liveNew", "lostOne"]) await db.update(customers).set({ ownerId: admin.id }).where(eq(customers.id, lead[k]));
});

after(async () => {
  setTestUser(null);
  await db.delete(customers).where(inArray(customers.id, created));
  await db.$client.end();
});

const names = (rows: { name: string }[]) => rows.map((r) => r.name);

describe("the main list", () => {
  test("rows, total and search leave lost leads out; live ones stay", async () => {
    const all = await leadsPage(TODAY, { perPage: 200, filters: { search: tag } });
    assert.deepEqual(names(all.rows).sort(), [`liveNew ${tag}`, `liveSuspect ${tag}`]);
    assert.equal(all.total, 2, "the count beside the list agrees with the list");
    const byName = await leadsPage(TODAY, { filters: { search: `lostOne ${tag}` } });
    assert.equal(byName.total, 0, "a lost lead is not found from the main list");
  });

  test("a stage filter for lost finds nothing here, and the stage options no longer offer it", async () => {
    assert.equal((await leadsPage(TODAY, { filters: { search: tag, stage: "lost" } })).total, 0);
    assert.ok(!(await leadFilterOptions()).stages.some((s) => s.value === "lost"));
  });

  test("select-everything ids and the tile counts agree with the list", async () => {
    const ids = (await leadIdsMatching(TODAY, { filters: { search: tag } })).ids;
    assert.ok(ids.includes(lead.liveNew) && ids.includes(lead.liveSuspect) && !ids.includes(lead.lostOne));
    const tiles = await leadTileCounts(TODAY, { filters: { search: tag } });
    assert.equal(tiles.mine, 1, "the lost lead the admin owns is not counted");
    assert.equal(tiles.suspects, 2, "Suspect and New fold into one tile; neither is the lost lead");
    assert.equal(tiles.lost30, 1, "the lost-this-month tile still counts what closed");
  });

  test("the lost30 view keeps the lost population on purpose", async () => {
    const v = await leadsPage(TODAY, { view: "lost30", filters: { search: tag } });
    assert.ok(names(v.rows).includes(`lostOne ${tag}`));
  });
});

describe("the Lost leads section", () => {
  test("still finds, lists and counts the lost lead", async () => {
    const page = await lostLeadsPage({ filters: { search: tag } });
    assert.deepEqual(names(page.rows), [`lostOne ${tag}`]);
  });
});
