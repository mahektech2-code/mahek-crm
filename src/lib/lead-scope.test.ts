/**
 * A LEAD ON YOUR LIST IS A LEAD YOU CAN WORK.
 *
 * The lead lists draw with `leadsVisible(managerScope())`, where a manager with
 * no territory is national. The lead actions used to decide with
 * `assertCustomerInScope`, which reads the CRM's team scope — your book and
 * your direct reports. So a manager saw Poonam's lead, opened it, chose Lost
 * from the bulk bar, and was told "0 leads moved … customer.read requires the
 * associate level of an app you hold". `assertLeadInScope` asks the list's
 * question first; these pin both halves — the manager is let through, and an
 * associate is still kept off a colleague's lead.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, customers, users, type User } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { assertCustomerInScope } from "@/lib/access-control";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { assertLeadInScope } from "@/lib/services/lead-scope";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

async function person(name: string, role: "associate" | "manager", apps: Array<"crm" | "sales">): Promise<User> {
  const [user] = await db
    .insert(users)
    .values({ id: id("usr"), name, email: `${id("p")}@test.local`, passwordHash: "x", role, initials: "XX" })
    .returning();
  for (const app of apps) await db.insert(appAccess).values({ id: id("acc"), userId: user.id, app, role });
  return user;
}

async function leadOwnedBy(owner: User) {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: "India Pharmaceutical",
      city: "Mumbai",
      phone: String(9800000000 + Math.floor(Math.random() * 99_999_999)),
      kind: "lead",
      ownerId: owner.id,
      leadStage: "new",
    })
    .returning();
  return row;
}

const seats = (c: Awaited<ReturnType<typeof leadOwnedBy>>) => ({
  kind: c.kind,
  ownerId: c.ownerId,
  salesAmId: c.salesAmId,
  backOfficeAmId: c.backOfficeAmId,
  leadManagerId: c.leadManagerId,
  salesManagerId: c.salesManagerId,
  deletedAt: c.deletedAt,
});

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/);
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table mbos_user_territories, timeline_events, audit_log, notifications,
      app_access, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("who may work a lead", () => {
  test("a manager with no territory works a lead on their list that is outside their team", async () => {
    const poonam = await person("Poonam Pashte", "associate", ["crm"]);
    const manager = await person("Sales Manager", "manager", ["crm", "sales"]);
    const lead = await leadOwnedBy(poonam);
    setTestUser(manager);

    /* The bug, kept on record: the CRM's team scope refuses it. */
    await assert.rejects(() => assertCustomerInScope(seats(lead)), /customer\.read/);
    /* The fix: it is on their lead list, so they may act on it. */
    await assertLeadInScope(lead.id, seats(lead));
  });

  test("an associate is still kept off a colleague's lead", async () => {
    const poonam = await person("Poonam Pashte", "associate", ["crm"]);
    const rakesh = await person("Rakesh", "associate", ["crm"]);
    const lead = await leadOwnedBy(poonam);
    setTestUser(rakesh);

    await assert.rejects(() => assertLeadInScope(lead.id, seats(lead)), /customer\.read/);
  });

  test("an associate works their own lead", async () => {
    const poonam = await person("Poonam Pashte", "associate", ["crm"]);
    const lead = await leadOwnedBy(poonam);
    setTestUser(poonam);

    await assertLeadInScope(lead.id, seats(lead));
  });

  test("a lead in the trash is refused even to a national manager", async () => {
    const poonam = await person("Poonam Pashte", "associate", ["crm"]);
    const manager = await person("Sales Manager", "manager", ["crm", "sales"]);
    const lead = await leadOwnedBy(poonam);
    await db.execute(sql`update customers set deleted_at = now() where id = ${lead.id}`);
    setTestUser(manager);

    await assert.rejects(
      () => assertLeadInScope(lead.id, { ...seats(lead), deletedAt: new Date() }),
      /customer\.read/,
    );
  });
});
