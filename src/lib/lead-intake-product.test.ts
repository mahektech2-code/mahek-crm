import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, customers, products, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig, updateSetting } from "@/lib/config/store";
import { listActiveProducts } from "@/lib/services/product-service";
import { GET as productSearchRoute } from "@/app/api/product-search/route";
import { captureLead, captureLeadBatch } from "@/lib/actions/lead-intake";

/* ---------------------------------------------------------------------------
 * "WHAT THEY WANT" AT INTAKE: words, or a product chosen from the catalogue.
 *
 * Both land in `customers.lead_requirement`. A chosen product is read back from
 * the catalogue on the server (the browser's spelling is never trusted) and is
 * NEVER written to `lead_required_product_id` — that column is the Calling
 * Desk's and Qualification's own Product answer, and an intake choice must not
 * answer it for them.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let tele: typeof users.$inferSelect;
let active: { id: string; name: string };
let retired: { id: string; name: string };

const CAPTURE = (over: Record<string, unknown> = {}) => ({
  name: `Shop ${randomUUID().slice(0, 6)}`,
  phone: String(9100000000 + Math.floor(Math.random() * 99999999)),
  city: "Nagpur",
  source: "telecalling",
  ...over,
});

const row = async (leadId: string) => (await db.select().from(customers).where(eq(customers.id, leadId)))[0];

async function raise(over: Record<string, unknown> = {}) {
  const r = await captureLead(CAPTURE(over) as Parameters<typeof captureLead>[0]);
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  if (!r.ok) throw new Error("unreachable");
  return row(r.data.customerId);
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
  tele = u;
  await db.insert(appAccess).values({ id: id("aca"), userId: tele.id, app: "crm", role: "associate" });
  active = { id: id("prd"), name: "PU Thinner - 20 Liter (Loose)" };
  retired = { id: id("prd"), name: "Old Thinner - 5 Liter (Loose)" };
  await db.insert(products).values([
    { id: active.id, name: active.name, active: true },
    { id: retired.id, name: retired.name, active: false },
  ]);
  setTestUser(tele);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("a catalogue product chosen at intake", () => {
  test("is checked on the server and its NAME is stored in lead_requirement", async () => {
    const lead = await raise({ salesType: "direct", requirementProductId: active.id });
    assert.equal(lead.leadRequirement, active.name);
  });

  test("replaces typed words on the same request, and nothing the browser spelled is trusted", async () => {
    const lead = await raise({
      salesType: "direct",
      requirement: "something the browser typed",
      requirementProductId: active.id,
    });
    assert.equal(lead.leadRequirement, active.name);
  });

  test("does NOT touch lead_required_product_id — it is the Calling Desk's own answer", async () => {
    for (const salesType of ["direct", "third_party", null]) {
      const lead = await raise({ salesType, requirementProductId: active.id });
      assert.equal(lead.leadRequiredProductId, null, String(salesType));
    }
  });

  test("an inactive product, one that does not exist, and a bare id are all refused — and no lead is made", async () => {
    const before = (await db.select().from(customers)).length;
    for (const requirementProductId of [retired.id, "prd_does_not_exist"]) {
      const r = await captureLead(CAPTURE({ salesType: "direct", requirementProductId }) as Parameters<typeof captureLead>[0]);
      assert.equal(r.ok, false, requirementProductId);
      assert.equal(r.ok ? [] : (r.fieldErrors ?? []).map((f) => f.field).includes("requirementProductId"), true);
    }
    assert.equal((await db.select().from(customers)).length, before, "nothing was written");
  });
});

describe("what they want, written in words, and left empty", () => {
  test("custom text is stored exactly as before", async () => {
    const lead = await raise({ salesType: "direct", requirement: "Thinner for a spray booth" });
    assert.equal(lead.leadRequirement, "Thinner for a spray booth");
    assert.equal(lead.leadRequiredProductId, null);
  });

  test("nothing at all is still fine", async () => {
    for (const over of [{}, { requirement: "" }, { requirementProductId: null }]) {
      const lead = await raise({ salesType: "direct", ...over });
      assert.equal(lead.leadRequirement, null);
      assert.equal(lead.leadRequiredProductId, null);
    }
  });

  test("the same field works for Direct, Third Party and Not Decided — in words or by product", async () => {
    for (const salesType of ["direct", "third_party", null]) {
      const words = await raise({ salesType, requirement: "Universal thinner" });
      assert.equal(words.leadRequirement, "Universal thinner", `${salesType} words`);
      const chosen = await raise({ salesType, requirementProductId: active.id });
      assert.equal(chosen.leadRequirement, active.name, `${salesType} product`);
      assert.equal(chosen.leadSalesType, salesType);
    }
  });

  test("an old free-text value is untouched and still readable (no backfill, no conversion)", async () => {
    const lead = await raise({ salesType: "direct", requirement: "pu thinner" });
    // Same text as a product name, different case: it stays what somebody typed.
    assert.equal(lead.leadRequirement, "pu thinner");
    assert.equal(lead.leadRequiredProductId, null);
  });
});

describe("the other doors are unchanged", () => {
  test("a bulk file's product column is still free text, and sets no product id", async () => {
    const phone = String(9300000000 + Math.floor(Math.random() * 99999999));
    const r = await captureLeadBatch(
      [
        {
          name: `Bulk ${randomUUID().slice(0, 5)}`,
          phone,
          city: "Pune",
          source: "telecalling",
          "Sales Type": "direct",
          Product: "Thinner for a booth",
        },
      ],
      { ownerId: null, nextAction: { action: "Call", date: "2026-10-05", ownerId: tele.id } },
    );
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const [lead] = await db.select().from(customers).where(eq(customers.phone, phone));
    assert.equal(lead.leadRequirement, "Thinner for a booth");
    assert.equal(lead.leadRequiredProductId, null);
  });

  test("a request that names no product id (an enquiry conversion, the handset) is read exactly as before", async () => {
    // `requirementProductId` is optional and absent from every other caller's payload.
    const lead = await raise({ salesType: null, requirement: "PU Thinner — Quantity: 200 litres a month" });
    assert.equal(lead.leadRequirement, "PU Thinner — Quantity: 200 litres a month");
  });
});

describe("ProductField keeps working for the screens that already use it", () => {
  const field = readFileSync("src/components/products/product-field.tsx", "utf8");

  test("customerId is optional now, and is still sent when there is one", () => {
    assert.match(field, /customerId\?: string/);
    assert.match(field, /customerId \? `&customerId=\$\{encodeURIComponent\(customerId\)\}` : ""/);
  });

  test("every existing caller still passes its customerId", () => {
    for (const [file, count] of [
      ["src/components/leads/calling-desk/dialogs.tsx", 1],
      ["src/components/leads/record/qualify/qualify-screen.tsx", 1],
      ["src/components/sales-lead-pipeline/modals.tsx", 2],
      ["src/components/samples/request-sample.tsx", 1],
    ] as const) {
      const src = readFileSync(file, "utf8");
      const uses = [...src.matchAll(/<ProductField[\s\S]*?\/>/g)].map((m) => m[0]);
      assert.equal(uses.length, count, file);
      for (const u of uses) assert.match(u, /customerId=/, `${file} still passes customerId`);
    }
  });

  test("the intake form is ONE field — a combobox over the catalogue — not a text box plus a second picker", () => {
    const form = readFileSync("src/components/leads/intake/intake-form.tsx", "utf8");
    assert.match(form, /<ProductCombobox/);
    assert.doesNotMatch(form, /<ProductField/);
    assert.ok(form.includes("What product they want (optional)"));
    assert.equal(form.includes("What they want (optional)"), false);
    assert.doesNotMatch(form, /Or choose one of Mahek/);
    assert.doesNotMatch(form, /Nothing chosen/);
    assert.match(form, /requirementProductId/);
    assert.doesNotMatch(form, /lead_required_product_id|leadRequiredProductId/);
    // With product search switched off the box is plain text, and says why.
    assert.match(form, /Product search is switched off/);
    // The voice assistant must not write words behind a chosen product.
    assert.match(form, /key === "requirement" && requirementProductId/);
  });

  test("the Telecaller and the Sales workspace both draw that same form", () => {
    const page = readFileSync("src/components/leads/pages/leads-intake.tsx", "utf8");
    assert.match(page, /<IntakeForm/);
    assert.ok(page.includes('productSearchEnabled={config["products.searchOnOrderForms"]}'));
    for (const route of ["src/app/crm/leads/intake/page.tsx", "src/app/sales/leads/intake/page.tsx"]) {
      assert.match(readFileSync(route, "utf8"), /leads-intake/, route);
    }
    const form = readFileSync("src/components/leads/intake/intake-form.tsx", "utf8");
    assert.equal((form.match(/<ProductCombobox/g) ?? []).length, 1, "one product field in the form, for every sales type");
  });

  test("the combobox is an accessible listbox that keeps free text and drops a pick when it is edited", () => {
    const box = readFileSync("src/components/products/product-combobox.tsx", "utf8");
    assert.match(box, /role="combobox"/);
    assert.match(box, /role="listbox"/);
    assert.ok(box.includes("/api/product-search?all=1"));
    assert.match(box, /will be saved as your own words/);
    const form = readFileSync("src/components/leads/intake/intake-form.tsx", "utf8");
    // Typing clears any chosen product, so what is shown is what is saved.
    const onText = form.slice(form.indexOf("onText={(t) => {"));
    assert.ok(onText.slice(0, 300).includes("setRequirementProductId(null);"));
  });
});

describe("the catalogue the field offers", () => {
  const ids = (rows: Array<{ productId: string }>) => rows.map((r) => r.productId).sort();

  test("listActiveProducts is every ACTIVE product and nothing retired", async () => {
    const extra = [id("prd"), id("prd"), id("prd")];
    await db.insert(products).values(extra.map((pid, i) => ({ id: pid, name: `Extra Thinner ${i} - 1 Liter (Loose)`, active: true })));
    const rows = await listActiveProducts();
    assert.deepEqual(ids(rows), [active.id, ...extra].sort());
    assert.equal(rows.some((r) => r.productId === retired.id), false);
    assert.equal(rows.find((r) => r.productId === active.id)?.name, active.name);
  });

  test("the endpoint returns the same list behind the login, and nothing when product search is switched off", async () => {
    const res = await productSearchRoute(new Request("http://x.test/api/product-search?all=1"));
    const body = (await res.json()) as { products: Array<{ productId: string }> };
    assert.deepEqual(ids(body.products), [active.id]);

    setTestUser(null);
    assert.equal((await productSearchRoute(new Request("http://x.test/api/product-search?all=1"))).status, 401);

    setTestUser(tele);
    await updateSetting("products.searchOnOrderForms", false, tele.id);
    const off = await productSearchRoute(new Request("http://x.test/api/product-search?all=1"));
    assert.deepEqual(((await off.json()) as { products: unknown[] }).products, []);
  });

  test("the existing search is untouched by the new option", async () => {
    const res = await productSearchRoute(new Request("http://x.test/api/product-search?q=thinner"));
    const body = (await res.json()) as { products: Array<{ productId: string }> };
    assert.deepEqual(ids(body.products), [active.id]);
  });
});
