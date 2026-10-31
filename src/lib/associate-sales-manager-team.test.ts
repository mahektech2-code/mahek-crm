import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, appModuleAccess, customers, employeeReporting, employees, users } from "@/db/schema";
import { associateTeamBook } from "@/lib/services/crm-sales-manager-scope";
import { leadsVisible, type ManagerScope } from "@/lib/services/sales-service";
import { testPhone } from "@/lib/test-phone";

/* ---------------------------------------------------------------------------
 * AN ASSOCIATE WHO HOLDS THE SALES MANAGER MODULE sees her own book PLUS her
 * seat and her reporting team — on the Leads tab and the unified lead record,
 * which both narrow through `leadsVisible`. Nobody else's scope moves.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
let seema: typeof users.$inferSelect;
let pritesh: typeof users.$inferSelect;
let prashant: typeof users.$inferSelect;
let outsider: typeof users.$inferSelect; // reports to nobody Seema manages
let plain: typeof users.$inferSelect; // an ordinary associate, no Sales Manager module
const lead: Record<string, string> = {};
/* Names are matched against the Org Chart BY NAME, so they must not repeat across runs. */
const sfx = randomUUID().slice(0, 6);

async function user(name: string, role: "associate" | "manager", modules: string[] = []) {
  const [u] = await db.insert(users).values({
    id: id("usr"), name, email: `${name.replace(/\W+/g, "").toLowerCase()}-${randomUUID().slice(0, 4)}@test.local`,
    phone: testPhone(), passwordHash: "x", role, initials: name.slice(0, 2).toUpperCase(),
  }).returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app: "crm", role });
  for (const m of modules) await db.insert(appModuleAccess).values({ id: id("ama"), userId: u.id, app: "crm", module: m });
  return u;
}
async function mk(key: string, owner: string | null, seat: string | null, stage: "new" | "suspect" | "lost" = "new") {
  const [c] = await db.insert(customers).values({
    id: id("cus"), name: `${key} ${randomUUID().slice(0, 4)}`, kind: "lead", leadStage: stage, leadSalesType: "direct",
    leadSource: "manual", city: "Nashik", contactPerson: "T", ownerId: owner, salesManagerId: seat, phone: testPhone(),
  }).returning();
  lead[key] = c.id;
}
const visible = async (scope: ManagerScope) =>
  new Set((await db.execute<{ id: string }>(sql`select c.id from customers c where c.lead_stage is not null ${leadsVisible(scope)}`)).map((r) => r.id));

before(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run against the test database only.");
  seema = await user(`Seema ${sfx}`, "associate", ["crm.leads", "crm.sales-manager"]);
  pritesh = await user(`Pritesh ${sfx}`, "manager");
  prashant = await user(`Prashant ${sfx}`, "associate");
  outsider = await user(`Outsider ${sfx}`, "associate");
  plain = await user(`Plain ${sfx}`, "associate", ["crm.leads"]);
  const emp = async (u: typeof users.$inferSelect, n: number) =>
    (await db.insert(employees).values({ id: id("emp"), rowNumber: n, employeeCode: `X${n}${randomUUID().slice(0, 4)}`, name: u.name, status: "active", raw: {}, rowHash: id("h") }).returning())[0];
  const [eS, eP, eO] = [await emp(seema, 9001), await emp(prashant, 9002), await emp(outsider, 9003)];
  const ePr = await emp(pritesh, 9004);
  await db.insert(employeeReporting).values([
    { id: id("rep"), employeeId: eP.id, managerId: eS.id },
    { id: id("rep"), employeeId: eS.id, managerId: ePr.id },
    { id: id("rep"), employeeId: eO.id, managerId: ePr.id },
  ]);
  await mk("prashantNew", prashant.id, seema.id, "new");
  await mk("prashantLost", prashant.id, seema.id, "lost");
  await mk("seemaOwnPritesh", seema.id, pritesh.id, "new"); // MATAJI's shape
  await mk("seemaOwnSelf", seema.id, seema.id, "suspect"); // Niranjan's shape
  await mk("seatNoOwner", null, seema.id, "suspect");
  await mk("outside", outsider.id, pritesh.id, "new");
});

after(async () => {
  await db.delete(customers).where(inArray(customers.id, Object.values(lead)));
  await db.$client.end();
});

describe("associateTeamBook", () => {
  test("the module is the grant: Seema gets her seat and her team, an ordinary associate gets nothing", async () => {
    const book = await associateTeamBook(seema);
    assert.ok(book);
    assert.equal(book.seatId, seema.id);
    assert.ok(book.ownerIds.includes(seema.id) && book.ownerIds.includes(prashant.id), "herself and her report");
    assert.ok(!book.ownerIds.includes(outsider.id), "somebody who reports to Pritesh is not hers");
    assert.equal(await associateTeamBook(plain), null, "a reporting line alone grants no view");
    assert.equal(await associateTeamBook({ ...seema, role: "admin" }), null, "an administrator is never narrowed by a seat");
  });
});

describe("leadsVisible for an Associate", () => {
  const own = (u: typeof users.$inferSelect): ManagerScope => ({ national: false, regions: [], salesmanIds: [u.id], own: true });

  test("WITHOUT the module: her own book only — the team is invisible", async () => {
    const v = await visible(own(seema));
    assert.ok(v.has(lead.seemaOwnPritesh) && v.has(lead.seemaOwnSelf), "her own leads, whoever the Sales Manager is");
    assert.ok(!v.has(lead.prashantNew) && !v.has(lead.prashantLost) && !v.has(lead.outside));
  });

  test("WITH the team book: own + seat + reporting team, once each, and nobody else's", async () => {
    const book = await associateTeamBook(seema);
    const scope = { ...own(seema), teamBook: book! };
    const v = await visible(scope);
    for (const k of ["prashantNew", "prashantLost", "seemaOwnPritesh", "seemaOwnSelf", "seatNoOwner"]) assert.ok(v.has(lead[k]), `${k} is visible`);
    assert.ok(!v.has(lead.outside), "a lead outside her seat and team stays hidden");
    const rows = await db.execute<{ id: string }>(sql`select c.id from customers c where c.lead_stage is not null ${leadsVisible(scope)}`);
    assert.equal(rows.length, new Set(rows.map((r) => r.id)).size, "no duplicates when a lead qualifies twice");
  });

  test("a plain associate with the same reporting data still sees only their own", async () => {
    const v = await visible(own(plain));
    assert.ok(![...Object.values(lead)].some((l) => v.has(l)));
  });
});
