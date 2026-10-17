import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { count, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, appModuleAccess, customers, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { defaultConfig } from "@/lib/config/registry";
import { captureLead } from "@/lib/actions/lead-intake";
import { sourcesFor } from "@/lib/lead-source-scope";

/* Google Maps is a lead source ONLY the Sales Manager intake offers. */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const CONFIGURED = defaultConfig()["leads.sources"];

let manager: typeof users.$inferSelect;
let tele: typeof users.$inferSelect;

const mkUser = async (name: string) => {
  const [u] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${randomUUID().slice(0, 6)}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role: "associate",
      initials: "XX",
    })
    .returning();
  return u;
};

const CAPTURE = (over: Record<string, unknown> = {}) =>
  ({
    name: `Shop ${randomUUID().slice(0, 6)}`,
    phone: String(9100000000 + Math.floor(Math.random() * 99999999)),
    city: "Nagpur",
    source: "google_maps",
    ...over,
  }) as Parameters<typeof captureLead>[0];

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run `npm run test:db` first.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table lead_stage_transitions, notifications, timeline_events, audit_log, customer_distributors,
      app_module_access, app_access, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  manager = await mkUser("Seema Manager");
  tele = await mkUser("Tara Telecaller");
  /* The Sales Manager module is a narrowing of the CRM grant. */
  await db.insert(appAccess).values({ id: id("aca"), userId: manager.id, app: "crm", role: "associate" });
  await db.insert(appModuleAccess).values({ id: id("amx"), userId: manager.id, app: "crm", module: "crm.sales-manager" });
  await db.insert(appAccess).values({ id: id("aca"), userId: tele.id, app: "crm", role: "associate" });
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("sourcesFor", () => {
  test("a Sales Manager sees Google Maps, before Other, with every existing option unchanged and in order", () => {
    const list = sourcesFor(CONFIGURED, true);
    assert.deepEqual(
      list.filter((o) => o.code !== "google_maps"),
      CONFIGURED,
    );
    assert.equal(list.filter((o) => o.code === "google_maps").length, 1);
    assert.equal(list.find((o) => o.code === "google_maps")?.label, "Google Maps");
    assert.equal(list.at(-1)?.code, "other");
  });

  test("everybody else gets the configured list exactly", () => {
    assert.deepEqual(sourcesFor(CONFIGURED, false), CONFIGURED);
  });

  test("the configured list itself does not carry it, so the handset and the rest never see it", () => {
    assert.ok(!CONFIGURED.some((o) => o.code === "google_maps"));
  });
});

describe("captureLead with source google_maps", () => {
  for (const [label, salesType] of [
    ["Direct Customer", "direct"],
    ["Third Party Customer", "third_party"],
    ["Not Decided", null],
  ] as const) {
    test(`a Sales Manager can raise a ${label} lead`, async () => {
      setTestUser(manager);
      const r = await captureLead(CAPTURE({ salesType, workspace: "sales" }));
      assert.equal(r.ok, true, r.ok ? "" : r.error);
      if (!r.ok) return;
      const [row] = await db.select().from(customers).where(eq(customers.id, r.data.customerId));
      assert.equal(row.leadSource, "google_maps");
    });
  }

  test("a Telecaller cannot use it, whatever workspace the request claims", async () => {
    setTestUser(tele);
    for (const workspace of ["crm", "sales", undefined] as const) {
      const r = await captureLead(CAPTURE({ salesType: "direct", workspace }));
      assert.equal(r.ok, false, String(workspace));
    }
    const [{ n }] = await db.select({ n: count() }).from(customers);
    assert.equal(Number(n), 0);
  });

  test("existing sources still work for a Telecaller and a Sales Manager, and nothing else is touched", async () => {
    for (const u of [tele, manager]) {
      setTestUser(u);
      const r = await captureLead(CAPTURE({ salesType: "direct", source: "telecalling" }));
      assert.equal(r.ok, true, r.ok ? "" : r.error);
    }
    setTestUser(manager);
    const bad = await captureLead(CAPTURE({ source: "not_a_source" }));
    assert.equal(bad.ok, false);
    const other = await captureLead(CAPTURE({ source: "other" }));
    assert.equal(other.ok, false, "'other' still demands its detail");
  });
});
