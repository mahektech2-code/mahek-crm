import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, customers, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { captureLead } from "@/lib/actions/lead-intake";

/* ---------------------------------------------------------------------------
 * THE GST NUMBER ON A NEW LEAD: OPTIONAL when it is raised, in the one
 * `customers.gstin` column. (Where it becomes REQUIRED — the Prospect — is
 * `lead-gates.test`, `lead-prospect-answers.test` and `lead-prospect-conversion`.)
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
let tele: typeof users.$inferSelect;

const CAPTURE = (over: Record<string, unknown> = {}) => ({
  name: `Shop ${randomUUID().slice(0, 6)}`,
  phone: String(9100000000 + Math.floor(Math.random() * 99999999)),
  city: "Nagpur",
  source: "telecalling",
  salesType: "direct",
  ...over,
});
const row = async (leadId: string) => (await db.select().from(customers).where(eq(customers.id, leadId)))[0]!;
async function raise(over: Record<string, unknown> = {}) {
  const r = await captureLead(CAPTURE(over) as Parameters<typeof captureLead>[0]);
  return r;
}

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Integration tests must run against a mahekone_test* database.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table lead_stage_transitions, notifications, timeline_events, audit_log, customer_distributors,
      app_module_access, app_access, customers, products, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  const [u] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name: "Tara Telecaller",
      email: `tara-${randomUUID().slice(0, 4)}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role: "associate",
      initials: "TT",
    })
    .returning();
  tele = u!;
  await db.insert(appAccess).values({ id: id("aca"), userId: tele.id, app: "crm", role: "associate" });
  setTestUser(tele);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("a new lead's GST number is optional", () => {
  test("a lead raised WITHOUT one is created, and the column stays empty", async () => {
    const r = await raise();
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    if (!r.ok) return;
    assert.equal((await row(r.data.customerId)).gstin, null);
  });

  test("a blank or whitespace one is the same as none", async () => {
    for (const gstin of ["", "   "]) {
      const r = await raise({ gstin });
      assert.equal(r.ok, true, r.ok ? "" : r.error);
      if (r.ok) assert.equal((await row(r.data.customerId)).gstin, null);
    }
  });

  test("one that is given is stored on the existing gstin column", async () => {
    const r = await raise({ gstin: "27ABCDE1234F1Z5" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    if (r.ok) assert.equal((await row(r.data.customerId)).gstin, "27ABCDE1234F1Z5");
  });

  test("it is trimmed, and held to the same 20-character limit the Prospect writer keeps", async () => {
    const r = await raise({ gstin: "  27ABCDE1234F1Z5  " });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    if (r.ok) assert.equal((await row(r.data.customerId)).gstin, "27ABCDE1234F1Z5");
    const tooLong = await raise({ gstin: "x".repeat(21) });
    assert.equal(tooLong.ok, false);
    if (!tooLong.ok) assert.ok((tooLong.fieldErrors ?? []).some((f) => f.field === "gstin"));
  });

  test("it works for every way of selling — direct, third-party and undecided", async () => {
    for (const salesType of ["direct", "third_party", null]) {
      const r = await raise({ salesType, gstin: "27ABCDE1234F1Z5", ...(salesType === "third_party" ? {} : {}) });
      /* A third-party lead may need its distributor; the point here is only that
         the GST number is never what refuses it. */
      if (!r.ok) assert.ok(!(r.fieldErrors ?? []).some((f) => f.field === "gstin"), `${salesType}: ${r.error}`);
    }
  });
});

describe("the form", () => {
  const form = readFileSync("src/components/leads/intake/intake-form.tsx", "utf8");
  test("draws a GST number box in a Customer block shown only for a Direct customer, not marked required", () => {
    const customer = form.indexOf("<SectionTitle>Customer</SectionTitle>");
    const who = form.indexOf("<SectionTitle>Who</SectionTitle>");
    const gst = form.indexOf('<F label="GST number"');
    assert.ok(customer > 0 && gst > customer && gst < who, "the GST field sits in the Customer block, above Who");
    assert.match(form.slice(customer - 700, customer), /answer === "direct"/, "shown only for a Direct customer");
    assert.ok(!/<F label="GST number" required/.test(form), "optional: no required marker");
    assert.equal(form.split('<F label="GST number"').length - 1, 1, "one box, not a duplicate");
  });
  test("sends it to the existing capture action, and only for a Direct customer", () => {
    assert.match(form, /gstin: answer === "direct" \? f\.gstin\.trim\(\) \|\| undefined : undefined/);
  });
});
