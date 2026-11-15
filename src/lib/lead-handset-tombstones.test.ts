/**
 * A LEAD THAT LEAVES THE LEADS CHANNEL LEAVES THE PHONE — and comes back.
 *
 *   npm run test:integration   (or: node --env-file=.env.local --import tsx
 *     --conditions=react-server --test src/lib/lead-handset-tombstones.test.ts)
 *
 * Read back through the real bootstrap and delta, because "it is tombstoned"
 * means nothing until the pull carries it, and "it came back" means nothing
 * unless the same pull does not archive what it just sent.
 *
 * Needs mahekone_test; `npm run test:db` creates it.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, customers, mbosApprovals, mbosDeletions, users } from "@/db/schema";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import {
  buildBootstrap,
  buildPull,
  encodeCursor,
  type MbosPrincipal,
} from "@/lib/services/mbos-service";
import { applyLeadStageMove, leadRow } from "@/lib/services/lead-service";
import { leadSeatHolders, syncLeadHolders } from "@/lib/services/lead-tombstone";
import { testPhone } from "@/lib/test-phone";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const TODAY = new Date().toISOString().slice(0, 10);

let rahul: typeof users.$inferSelect;
let suresh: typeof users.$inferSelect;
let other: typeof users.$inferSelect;

async function makeUser(name: string) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase()}-${randomUUID().slice(0, 4)}@test.local`,
      phone: testPhone(),
      passwordHash: "x",
      role: "associate",
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  await db.insert(appAccess).values({ id: id("acc"), userId: row.id, app: "field", role: "associate" });
  return row;
}

/** A manager-level principal: territory does not narrow him, so his book is
 *  exactly his seats — which is what these tests are about. */
function principalFor(user: typeof users.$inferSelect): MbosPrincipal {
  return {
    user,
    deviceId: `device-${user.id}`,
    role: "manager",
    scope: { kind: "own", userIds: [user.id] },
  } as MbosPrincipal;
}

async function makeLead(over: Partial<typeof customers.$inferInsert> = {}) {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: `Lead ${randomUUID().slice(0, 6)}`,
      phone: testPhone(),
      city: "Nashik",
      kind: "lead",
      leadStage: "suspect",
      leadSalesType: "direct",
      ownerId: rahul.id,
      ...over,
    })
    .returning();
  return row;
}

async function deltaFor(
  user: typeof users.$inferSelect,
  opts: { since?: Date; missingIds?: string[] } = {},
) {
  const pull = await buildPull(
    principalFor(user),
    encodeCursor(opts.since ?? new Date(Date.now() - 60_000)),
    { missingIds: opts.missingIds },
  );
  const leads = (pull.leads as { id: string; stage?: string }[]).map((l) => l.id);
  const gone = (pull.deletions as { entity: string; ids: string[] }[])
    .filter((d) => d.entity === "leads")
    .flatMap((d) => d.ids);
  return { leads, gone };
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
      mbos_approvals, mbos_deletions, lead_stage_transitions, timeline_events,
      notifications, audit_log, app_access, sessions, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  rahul = await makeUser("Rahul");
  suresh = await makeUser("Suresh");
  other = await makeUser("Other");
});

after(async () => {
  await db.$client.end();
});

test("a lead closed lost is tombstoned for every handset, and reopening lifts it", async () => {
  const lead = await makeLead();
  const boot = await buildBootstrap(principalFor(rahul));
  assert.ok((boot.leads as { id: string }[]).some((l) => l.id === lead.id));

  const row = await leadRow(lead.id);
  await applyLeadStageMove({ userId: rahul.id, hat: null, sourceApp: "crm" }, row!, "lost", {
    decision: { ok: true, kind: "passed", overriddenConditions: [] },
    reasonCode: "price",
    day: TODAY,
  });

  const d = await deltaFor(rahul);
  assert.ok(!d.leads.includes(lead.id), "the leads channel stops sending it");
  assert.ok(d.gone.includes(lead.id), "and the pull says so");
  const [tomb] = await db.select().from(mbosDeletions).where(eq(mbosDeletions.entityId, lead.id));
  assert.equal(tomb.userId, null, "a fact about the lead, for everybody");
  assert.equal(tomb.reason, "lead_lost");

  const lost = await leadRow(lead.id);
  await applyLeadStageMove({ userId: rahul.id, hat: null, sourceApp: "crm" }, lost!, "suspect", {
    decision: { ok: true, kind: "passed", overriddenConditions: [] },
    day: TODAY,
  });
  const back = await deltaFor(rahul);
  assert.ok(back.leads.includes(lead.id), "sent again");
  assert.ok(!back.gone.includes(lead.id), "and not archived by the same pull");
  const standing = await db.select().from(mbosDeletions).where(eq(mbosDeletions.entityId, lead.id));
  assert.equal(standing.length, 0, "the standing tombstone is withdrawn");
});

test("reassigning tombstones the old holder only, and giving it back brings it back", async () => {
  const lead = await makeLead();

  const move = (to: string) =>
    db.transaction(async (tx) => {
      const before = await leadSeatHolders(tx, lead.id);
      await tx.update(customers).set({ ownerId: to, updatedAt: new Date() }).where(eq(customers.id, lead.id));
      await syncLeadHolders(tx, lead.id, before);
    });

  await move(suresh.id);
  const r = await deltaFor(rahul);
  assert.ok(r.gone.includes(lead.id), "off Rahul's phone");
  assert.ok(!r.leads.includes(lead.id));
  const s = await deltaFor(suresh);
  assert.ok(s.leads.includes(lead.id), "onto Suresh's");
  assert.ok(!s.gone.includes(lead.id));
  const o = await deltaFor(other);
  assert.ok(!o.gone.includes(lead.id), "nobody else is told anything");

  await move(rahul.id);
  const back = await deltaFor(rahul);
  assert.ok(back.leads.includes(lead.id), "back on Rahul's phone");
  assert.ok(!back.gone.includes(lead.id), "a pull never tombstones a lead it is sending");
  const rahulTombs = await db
    .select()
    .from(mbosDeletions)
    .where(sql`${mbosDeletions.entityId} = ${lead.id} and ${mbosDeletions.userId} = ${rahul.id}`);
  assert.equal(rahulTombs.length, 0, "his standing tombstone is withdrawn");
  assert.ok((await deltaFor(suresh)).gone.includes(lead.id), "and Suresh is told it left");
});

test("a former holder still in another seat is not told to drop it", async () => {
  const lead = await makeLead({ backOfficeAmId: rahul.id });
  await db.transaction(async (tx) => {
    const before = await leadSeatHolders(tx, lead.id);
    await tx.update(customers).set({ ownerId: suresh.id, updatedAt: new Date() }).where(eq(customers.id, lead.id));
    await syncLeadHolders(tx, lead.id, before);
  });
  const r = await deltaFor(rahul);
  assert.ok(!r.gone.includes(lead.id));
  assert.ok(r.leads.includes(lead.id), "still in his book through the back office seat, so still a lead");
});

test("an open lead in his customer book arrives as a lead, on the delta and the missing path", async () => {
  const lead = await makeLead({ ownerId: other.id, backOfficeAmId: rahul.id });
  const boot = await buildBootstrap(principalFor(rahul));
  assert.ok((boot.customers as { id: string }[]).some((c) => c.id === lead.id), "in his customer book");
  assert.ok((boot.leads as { id: string }[]).some((l) => l.id === lead.id), "and in his leads");

  // Unchanged since long before the cursor: only the missing path can carry it.
  await db
    .update(customers)
    .set({ updatedAt: new Date(Date.now() - 3 * 86_400_000) })
    .where(eq(customers.id, lead.id));
  assert.ok(!(await deltaFor(rahul)).leads.includes(lead.id));
  assert.ok((await deltaFor(rahul, { missingIds: [lead.id] })).leads.includes(lead.id));
});

test("a distributor approval decided on a lead re-sends the lead", async () => {
  const lead = await makeLead({ leadSalesType: "distributor" });
  await db
    .update(customers)
    .set({ updatedAt: new Date(Date.now() - 3 * 86_400_000) })
    .where(eq(customers.id, lead.id));
  assert.ok(!(await deltaFor(rahul)).leads.includes(lead.id));

  await db.insert(mbosApprovals).values({
    id: id("apr"),
    type: "distributor_appointment",
    requestedByUserId: rahul.id,
    subjectType: "customers",
    subjectId: lead.id,
    approverUserId: suresh.id,
    state: "approved",
    stepIndex: 0,
    decidedAt: new Date(),
  } as never);
  assert.ok((await deltaFor(rahul)).leads.includes(lead.id), "the gate fact moved, so the lead is sent");
});
