/**
 * Website Enquiries — Senior Review High #9.
 *
 * Run against the real services and a real database, the same discipline
 * `journeys.test.ts` follows: scope resolution, capability checks and the
 * shared reminder rules are the real thing, not a stub standing in for them.
 *
 *   npm run test:integration
 *
 * Needs `mahekone_test`, created by `npm run test:db` from the committed
 * migrations. Never point this at a database anybody is using — it truncates
 * between tests.
 *
 * Five things this file exists to prove, matching the review that asked for
 * it: idempotency on `externalRef`, the ingestion endpoint's bearer auth
 * (fail-closed when unconfigured, rejecting wrong/missing tokens, accepting
 * the right one), the existing `requireEnquiriesAccess` gate (not a new
 * scope/capability model — that is High #4, deliberately untouched here),
 * the service/action behaviour around creation, linking and reminders, and
 * — the one the recent Blocker #3 fix specifically needs proof of — that
 * `createEnquiryReminder` actually goes through the shared reminder service
 * rather than its own, bypassable insert.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  appSecrets,
  customers,
  enquiries,
  enquiryActivity,
  enquiryOrders,
  notifications,
  orders,
  reminders,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { launcherApps } from "@/lib/access";
import { invalidateConfig, seedConfig, updateSetting } from "@/lib/config/store";
import { ENQUIRY_REMINDER_TYPES, type EnquiryReminderType } from "@/lib/enquiry-labels";
import {
  addNote,
  assignEnquiry,
  assignableUsers,
  changePriority,
  changeStage,
  createEnquiryFromWebsite,
  createEnquiryReminder,
  enquiryDashboardCounts,
  findCustomersByPhone,
  findPossibleDuplicateEnquiries,
  getEnquiry,
  linkCustomer,
  linkOrder,
  listEnquiries,
  markEnquiryViewedIfFirst,
  ordersForLinking,
  unlinkOrder,
} from "@/lib/services/enquiry-service";
import { POST as ingestEnquiry } from "@/app/api/public/enquiries/route";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

async function makeUser(
  name: string,
  role: "associate" | "manager" | "admin",
  app: "enquiries" | "crm" | null = "enquiries",
) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase()}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  if (app) {
    await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app, role });
  }
  return row;
}

async function makeCustomer(ownerId: string, over: Partial<typeof customers.$inferInsert> = {}) {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: over.name ?? `Customer ${randomUUID().slice(0, 6)}`,
      contactPerson: "Contact Person",
      phone: String(9000000000 + Math.floor(Math.random() * 999999999)),
      city: "Mumbai",
      ownerId,
      salesAmId: ownerId,
      ...over,
    })
    .returning();
  return row;
}

async function makeOrder(customerId: string, userId: string, over: Partial<typeof orders.$inferInsert> = {}) {
  const [row] = await db
    .insert(orders)
    .values({
      id: id("ord"),
      customerId,
      userId,
      orderedAt: new Date(),
      totalAmount: 10_000_00,
      status: "confirmed",
      ...over,
    })
    .returning();
  return row;
}

function ingestRequest(body: unknown, bearer?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearer !== undefined) headers.authorization = `Bearer ${bearer}`;
  return new Request("http://localhost/api/public/enquiries", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function validSubmission(overrides: Record<string, unknown> = {}) {
  return {
    formType: "CONTACT",
    category: "GENERAL",
    externalRef: randomUUID(),
    receivedAt: new Date().toISOString(),
    submission: { name: "Test Visitor", phone: "9876543210", email: "visitor@example.com", message: "Testing" },
    ...overrides,
  };
}

let enquiriesUser: typeof users.$inferSelect;

before(async () => {
  assert.match(
    process.env.DATABASE_URL ?? "",
    /mahekone_test/,
    "Integration tests must run against mahekone_test. Run `npm run test:db` first.",
  );
});

beforeEach(async () => {
  // Truncate rather than drop: the schema stays, the data does not.
  await db.execute(sql`
    truncate table
      enquiry_orders, enquiry_activity, enquiries, reminders,
      orders, app_secrets, app_access, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  enquiriesUser = await makeUser("Enquiries Person", "associate", "enquiries");
  setTestUser(enquiriesUser);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

/* ---------------------------------------------------------------------- 1 */

describe("createEnquiryFromWebsite — idempotency on externalRef", () => {
  test("the same externalRef submitted twice does not create a second row", async () => {
    const externalRef = randomUUID();
    const input = {
      sourceForm: "CONTACT",
      externalRef,
      receivedAt: new Date(),
      submission: { name: "Rohit", phone: "9876543210", message: "Need a quote" },
    };

    const first = await createEnquiryFromWebsite(input);
    assert.equal(first.duplicate, false);

    const second = await createEnquiryFromWebsite({
      ...input,
      // A genuine retransmission carries the same externalRef; the rest of
      // the payload may legitimately differ slightly (a retry after a
      // timeout can re-serialise the same underlying submission).
      submission: { name: "Rohit", phone: "9876543210", message: "Need a quote (resent)" },
    });
    assert.equal(second.duplicate, true);
    assert.equal(second.id, first.id, "a repeat externalRef must resolve to the SAME row");

    const rows = await db.select().from(enquiries).where(eq(enquiries.externalRef, externalRef));
    assert.equal(rows.length, 1, "exactly one enquiry must exist for this externalRef");
    // The first write wins — a resend must not silently overwrite it.
    assert.equal((rows[0].rawSubmission as { message: string }).message, "Need a quote");
  });

  test("two different externalRefs from the same phone are two independent enquiries", async () => {
    const a = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: { phone: "9876543210", message: "First enquiry" },
    });
    const b = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: { phone: "9876543210", message: "Second enquiry, a week later" },
    });
    assert.notEqual(a.id, b.id);
    assert.equal(a.duplicate, false);
    assert.equal(b.duplicate, false);
  });
});

/* ------------------------------------------------------- Medium finding #10 */

describe("uniqueness is on (source, external_ref), not external_ref alone", () => {
  test("the same source and the same externalRef is rejected by the database", async () => {
    const externalRef = randomUUID();
    const row = {
      workspace: "enquiries" as const,
      source: "website",
      rawSubmission: { message: "x" },
      receivedAt: new Date(),
      externalRef,
    };
    await db.insert(enquiries).values({ id: id("enq"), ...row });
    await assert.rejects(
      () => db.insert(enquiries).values({ id: id("enq"), ...row }),
      // Drizzle wraps the driver's error in a DrizzleQueryError; the real
      // PostgresError — code and message both — is on `.cause`.
      (e: unknown) => {
        const cause = (e as { cause?: { code?: unknown; message?: unknown } })?.cause;
        return cause?.code === "23505" && /enquiries_source_external_ref_key/.test(String(cause?.message));
      },
      "a second row with the same (source, externalRef) must violate the unique index",
    );
  });

  test("the same externalRef under a different source is allowed", async () => {
    const externalRef = randomUUID();
    await db.insert(enquiries).values({
      id: id("enq"),
      workspace: "enquiries",
      source: "website",
      rawSubmission: { message: "from the website" },
      receivedAt: new Date(),
      externalRef,
    });
    // A future Instagram/WhatsApp/IndiaMART integration's id space is not the
    // website's — the same externalRef value from a different source names a
    // different submission and must not collide.
    const [instagramRow] = await db
      .insert(enquiries)
      .values({
        id: id("enq"),
        workspace: "enquiries",
        source: "instagram",
        rawSubmission: { message: "from instagram" },
        receivedAt: new Date(),
        externalRef,
      })
      .returning();
    assert.ok(instagramRow, "a different source with the same externalRef must be allowed");

    const rows = await db.select().from(enquiries).where(eq(enquiries.externalRef, externalRef));
    assert.equal(rows.length, 2, "both rows must exist — they are not duplicates of each other");
  });
});

/* ---------------------------------------------------------------------- 2 */

describe("POST /api/public/enquiries — bearer authentication", () => {
  test("fails closed when no ingest secret is configured anywhere", async () => {
    // Neither the console-set row nor the environment fallback may be
    // present for this one — the test controls both explicitly so the
    // result cannot depend on what happens to be in .env.local.
    const savedEnv = process.env.ENQUIRY_INGEST_SECRET;
    delete process.env.ENQUIRY_INGEST_SECRET;
    try {
      const res = await ingestEnquiry(ingestRequest(validSubmission(), "anything"));
      assert.equal(res.status, 503);
    } finally {
      if (savedEnv !== undefined) process.env.ENQUIRY_INGEST_SECRET = savedEnv;
    }
  });

  test("rejects a missing Authorization header", async () => {
    await db.insert(appSecrets).values({ name: "enquiries.ingestSecret", value: "correct-horse-battery-staple", last4: "aple" });
    const res = await ingestEnquiry(ingestRequest(validSubmission()));
    assert.equal(res.status, 401);
  });

  test("rejects an incorrect bearer token", async () => {
    await db.insert(appSecrets).values({ name: "enquiries.ingestSecret", value: "correct-horse-battery-staple", last4: "aple" });
    const res = await ingestEnquiry(ingestRequest(validSubmission(), "totally-wrong-secret"));
    assert.equal(res.status, 401);
  });

  test("accepts the correct bearer token and stores the enquiry", async () => {
    await db.insert(appSecrets).values({ name: "enquiries.ingestSecret", value: "correct-horse-battery-staple", last4: "aple" });
    const externalRef = randomUUID();
    const res = await ingestEnquiry(ingestRequest(validSubmission({ externalRef }), "correct-horse-battery-staple"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; id: string };
    assert.equal(body.ok, true);

    const [row] = await db.select().from(enquiries).where(eq(enquiries.externalRef, externalRef));
    assert.ok(row, "the accepted request must actually have stored a row");
    assert.equal(row.source, "website");
  });
});

/* ------------------------------------------------------- Medium finding #18 */

describe("POST /api/public/enquiries — category is validated AND preserved", () => {
  test("a valid category is accepted and persisted, read back exactly", async () => {
    await db.insert(appSecrets).values({ name: "enquiries.ingestSecret", value: "correct-horse-battery-staple", last4: "aple" });
    const externalRef = randomUUID();
    const res = await ingestEnquiry(
      ingestRequest(validSubmission({ externalRef, category: "DISTRIBUTOR" }), "correct-horse-battery-staple"),
    );
    assert.equal(res.status, 200);

    const [row] = await db.select().from(enquiries).where(eq(enquiries.externalRef, externalRef));
    assert.ok(row);
    assert.equal(row.category, "DISTRIBUTOR", "the validated category must survive ingestion, not be discarded");
  });

  test("a missing category is still accepted, exactly as the existing contract allows, and stores null rather than a guess", async () => {
    await db.insert(appSecrets).values({ name: "enquiries.ingestSecret", value: "correct-horse-battery-staple", last4: "aple" });
    const externalRef = randomUUID();
    const payload = validSubmission({ externalRef });
    delete (payload as { category?: unknown }).category;

    const res = await ingestEnquiry(ingestRequest(payload, "correct-horse-battery-staple"));
    assert.equal(res.status, 200, "an older producer that never sends a category must still be accepted");

    const [row] = await db.select().from(enquiries).where(eq(enquiries.externalRef, externalRef));
    assert.ok(row);
    assert.equal(row.category, null, "no category was sent, so none is fabricated");
  });

  test("an invalid category is still rejected at the public boundary, exactly as before", async () => {
    await db.insert(appSecrets).values({ name: "enquiries.ingestSecret", value: "correct-horse-battery-staple", last4: "aple" });
    const externalRef = randomUUID();
    const res = await ingestEnquiry(
      ingestRequest(validSubmission({ externalRef, category: "NOT_A_REAL_CATEGORY" }), "correct-horse-battery-staple"),
    );
    assert.equal(res.status, 400);

    const rows = await db.select().from(enquiries).where(eq(enquiries.externalRef, externalRef));
    assert.equal(rows.length, 0, "a rejected payload must not create a row at all");
  });

  test("category is preserved as its own field, not folded into rawSubmission", async () => {
    await db.insert(appSecrets).values({ name: "enquiries.ingestSecret", value: "correct-horse-battery-staple", last4: "aple" });
    const externalRef = randomUUID();
    await ingestEnquiry(
      ingestRequest(validSubmission({ externalRef, category: "LOGISTICS" }), "correct-horse-battery-staple"),
    );

    const [row] = await db.select().from(enquiries).where(eq(enquiries.externalRef, externalRef));
    assert.ok(row);
    assert.equal(row.category, "LOGISTICS");
    // rawSubmission is kept exactly as the visitor's own submitted fields —
    // category is the WEBSITE's classification, a sibling of sourceForm, and
    // must not leak into the visitor's own submitted-fields object.
    assert.equal(Object.prototype.hasOwnProperty.call(row.rawSubmission, "category"), false);
    assert.equal((row.rawSubmission as { name?: string }).name, "Test Visitor", "the visitor's own fields are untouched");
  });

  test("createEnquiryFromWebsite called directly (bypassing the route) also persists category", async () => {
    const externalRef = randomUUID();
    const created = await createEnquiryFromWebsite({
      sourceForm: "QUOTE",
      category: "SALES",
      externalRef,
      receivedAt: new Date(),
      submission: { message: "Direct service call" },
    });
    const [row] = await db.select().from(enquiries).where(eq(enquiries.id, created.id));
    assert.equal(row.category, "SALES");
  });

  test("createEnquiryFromWebsite with no category at all (existing callers, existing behavior) stores null and does not throw", async () => {
    const externalRef = randomUUID();
    const created = await createEnquiryFromWebsite({
      sourceForm: "QUOTE",
      externalRef,
      receivedAt: new Date(),
      submission: { message: "No category supplied" },
    });
    const [row] = await db.select().from(enquiries).where(eq(enquiries.id, created.id));
    assert.equal(row.category, null);
  });

  test("idempotency on externalRef is unaffected: a retransmission with category still resolves to the same row", async () => {
    await db.insert(appSecrets).values({ name: "enquiries.ingestSecret", value: "correct-horse-battery-staple", last4: "aple" });
    const externalRef = randomUUID();
    const first = await ingestEnquiry(
      ingestRequest(validSubmission({ externalRef, category: "GENERAL" }), "correct-horse-battery-staple"),
    );
    const second = await ingestEnquiry(
      ingestRequest(validSubmission({ externalRef, category: "GENERAL" }), "correct-horse-battery-staple"),
    );
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const firstBody = (await first.json()) as { id: string };
    const secondBody = (await second.json()) as { id: string; duplicate?: boolean };
    assert.equal(secondBody.id, firstBody.id);
    assert.equal(secondBody.duplicate, true);

    const rows = await db.select().from(enquiries).where(eq(enquiries.externalRef, externalRef));
    assert.equal(rows.length, 1, "exactly one row must exist for this externalRef, category included in the payload or not");
  });
});

/* ------------------------------------------------------- Senior finding #18 */

describe("category is carried all the way through to the read path (Senior #18)", () => {
  test("listEnquiries returns the stored category on each item", async () => {
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "DISTRIBUTOR",
      category: "DISTRIBUTOR",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: { name: "Category List Test" },
    });

    const { items } = await listEnquiries({});
    const item = items.find((i) => i.id === enquiry.id);
    assert.ok(item, "the enquiry must appear on the list");
    assert.equal(item!.category, "DISTRIBUTOR", "the stored category must reach EnquiryListItem, not be dropped");
  });

  test("getEnquiry returns the stored category", async () => {
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "SAMPLE",
      category: "SALES",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });

    const detail = await getEnquiry(enquiry.id);
    assert.equal(detail?.category, "SALES", "the stored category must reach EnquiryDetail, not be dropped");
  });

  test("an enquiry with no category (existing rows, older producers) returns null cleanly through both reads", async () => {
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });

    const { items } = await listEnquiries({});
    const item = items.find((i) => i.id === enquiry.id);
    assert.equal(item?.category, null, "no category was ever stored, so none is invented on the way out");

    const detail = await getEnquiry(enquiry.id);
    assert.equal(detail?.category, null);
  });

  test("an unrecognised category (a future, not-yet-labelled value) still reaches both reads without failing", async () => {
    // The website's own validation refuses a category outside the known five
    // AT INGESTION — but the column itself is free text (like `sourceForm`),
    // and this same service function is called directly by other paths, so
    // the READ side must never assume every stored row matches today's list.
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "QUOTE",
      category: "NINTH_CATEGORY_THE_WEBSITE_ADDED",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });

    const { items } = await listEnquiries({});
    const item = items.find((i) => i.id === enquiry.id);
    assert.equal(item?.category, "NINTH_CATEGORY_THE_WEBSITE_ADDED");

    const detail = await getEnquiry(enquiry.id);
    assert.equal(detail?.category, "NINTH_CATEGORY_THE_WEBSITE_ADDED");
  });
});

/* ------------------------------------------------------- Medium finding #19 */

describe("workspace and source are fixed, server-controlled values (Medium #19)", () => {
  test("website ingestion always creates workspace='enquiries' and source='website'", async () => {
    await db.insert(appSecrets).values({ name: "enquiries.ingestSecret", value: "correct-horse-battery-staple", last4: "aple" });
    const externalRef = randomUUID();
    const res = await ingestEnquiry(ingestRequest(validSubmission({ externalRef }), "correct-horse-battery-staple"));
    assert.equal(res.status, 200);

    const [row] = await db.select().from(enquiries).where(eq(enquiries.externalRef, externalRef));
    assert.ok(row);
    assert.equal(row.workspace, "enquiries");
    assert.equal(row.source, "website");
  });

  test("a caller cannot override workspace or source by adding them as top-level request fields", async () => {
    await db.insert(appSecrets).values({ name: "enquiries.ingestSecret", value: "correct-horse-battery-staple", last4: "aple" });
    const externalRef = randomUUID();
    const res = await ingestEnquiry(
      ingestRequest(
        // Zod's default object parsing strips unknown top-level keys before
        // this ever reaches the service, but the point of this test is the
        // OUTCOME, not the mechanism — that a request naming a different app
        // or an untrusted source can never place the row anywhere but here.
        validSubmission({ externalRef, workspace: "accounts", source: "some-untrusted-value" }),
        "correct-horse-battery-staple",
      ),
    );
    assert.equal(res.status, 200, "unknown top-level fields must be silently ignored, not rejected outright");

    const [row] = await db.select().from(enquiries).where(eq(enquiries.externalRef, externalRef));
    assert.ok(row);
    assert.equal(row.workspace, "enquiries", "workspace must never be taken from the request body");
    assert.equal(row.source, "website", "source must never be taken from the request body");
  });

  test("a caller cannot override workspace or source by nesting them inside submission either", async () => {
    await db.insert(appSecrets).values({ name: "enquiries.ingestSecret", value: "correct-horse-battery-staple", last4: "aple" });
    const externalRef = randomUUID();
    const res = await ingestEnquiry(
      ingestRequest(
        validSubmission({ externalRef, submission: { name: "Attempt", workspace: "accounts", source: "evil" } }),
        "correct-horse-battery-staple",
      ),
    );
    assert.equal(res.status, 200);

    const [row] = await db.select().from(enquiries).where(eq(enquiries.externalRef, externalRef));
    assert.ok(row);
    assert.equal(row.workspace, "enquiries");
    assert.equal(row.source, "website");
    // `submission` is stored verbatim — an arbitrary key legitimately lands
    // there, which is harmless precisely because nothing ever reads a
    // workspace/source back OUT of it to assign the two trusted columns.
    assert.equal((row.rawSubmission as Record<string, unknown>).workspace, "accounts");
  });
});

/* ---------------------------------------------------------------------- 3 */

describe("requireEnquiriesAccess — the existing access gate", () => {
  test("a user with no app grants is refused", async () => {
    const nobody = await makeUser("Nobody", "associate", null);
    setTestUser(nobody);
    const owner = await makeUser("Owner", "associate");
    const customer = await makeCustomer(owner.id);
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: { message: "x" },
    });

    const result = await linkCustomer(enquiry.id, customer.id);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "not_permitted");
  });

  test("a user holding a DIFFERENT app (not enquiries) is still refused", async () => {
    const crmOnly = await makeUser("CrmOnly", "associate", "crm");
    setTestUser(crmOnly);
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: { message: "x" },
    });

    const result = await addNote(enquiry.id, "should not be allowed");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "not_permitted");
  });

  test("a user holding the enquiries app is allowed", async () => {
    // enquiriesUser, set in beforeEach, holds exactly the "enquiries" grant.
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: { message: "x" },
    });
    const result = await addNote(enquiry.id, "a real note");
    assert.equal(result.ok, true, result.ok ? "" : result.error);
  });
});

/* ------------------------------------------------------- Medium finding #15 */

describe("read-side enquiry functions enforce module access at the service boundary (Medium #15)", () => {
  test("an unauthorized caller is refused directly at every one of these functions, not only at the page", async () => {
    const nobody = await makeUser("Nobody15", "associate", null);
    // Made while enquiriesUser (the authorized fixture) is still current, so
    // there is a real row for the unauthorized calls below to reach for —
    // proving the refusal is the ACCESS check firing, not a "not found".
    const owner = await makeUser("Owner15", "associate");
    const customer = await makeCustomer(owner.id);
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: { phone: customer.phone },
    });

    setTestUser(nobody);

    await assert.rejects(() => listEnquiries({}), /Website Enquiries access/);
    await assert.rejects(() => getEnquiry(enquiry.id), /Website Enquiries access/);
    await assert.rejects(() => enquiryDashboardCounts(), /Website Enquiries access/);
    await assert.rejects(() => assignableUsers(), /Website Enquiries access/);
    await assert.rejects(() => findPossibleDuplicateEnquiries(enquiry.id, customer.phone), /Website Enquiries access/);
    await assert.rejects(() => ordersForLinking(enquiry.id), /Website Enquiries access/);
    await assert.rejects(() => markEnquiryViewedIfFirst(enquiry.id, nobody.id), /Website Enquiries access/);
  });

  test("a user holding a DIFFERENT app is refused the same way — this is module access, not merely being signed in", async () => {
    const crmOnly = await makeUser("CrmOnly15", "associate", "crm");
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });

    setTestUser(crmOnly);
    await assert.rejects(() => listEnquiries({}));
    await assert.rejects(() => getEnquiry(enquiry.id));
  });

  test("an authorized user can still call every one of these functions, and gets the established shapes back", async () => {
    // enquiriesUser, from beforeEach, holds exactly the "enquiries" grant.
    const owner = await makeUser("Owner15b", "associate");
    const customer = await makeCustomer(owner.id, { phone: "9988776655" });
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: { phone: customer.phone },
    });
    await linkCustomer(enquiry.id, customer.id);
    const order = await makeOrder(customer.id, owner.id);

    const list = await listEnquiries({});
    assert.ok(list.items.some((i) => i.id === enquiry.id));

    const detail = await getEnquiry(enquiry.id);
    assert.equal(detail?.id, enquiry.id);

    const counts = await enquiryDashboardCounts();
    assert.ok(counts.total >= 1);

    const team = await assignableUsers();
    assert.ok(team.some((t) => t.id === enquiriesUser.id));

    const duplicates = await findPossibleDuplicateEnquiries("enq_does_not_exist", customer.phone);
    assert.ok(duplicates.some((d) => d.id === enquiry.id));

    const candidates = await ordersForLinking(enquiry.id);
    assert.ok(candidates.some((c) => c.id === order.id));

    // void return, but must not throw for an authorized caller.
    await markEnquiryViewedIfFirst(enquiry.id, enquiriesUser.id);
    const activity = await db.select().from(enquiryActivity).where(eq(enquiryActivity.enquiryId, enquiry.id));
    assert.ok(activity.some((a) => a.kind === "viewed"));
  });

  test("company-wide visibility is preserved: an authorized user sees an enquiry linked to a customer owned by somebody else entirely", async () => {
    // The customer here is owned by a THIRD user, unrelated to enquiriesUser
    // and never granted anything — proving there is no row-level/ownership
    // restriction layered on top of the module check.
    const stranger = await makeUser("Stranger15", "associate", null);
    const customer = await makeCustomer(stranger.id);
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });
    await linkCustomer(enquiry.id, customer.id);

    const list = await listEnquiries({});
    assert.ok(list.items.some((i) => i.id === enquiry.id), "company-wide visibility: no ownership filter was introduced");

    const detail = await getEnquiry(enquiry.id);
    assert.equal(detail?.customerId, customer.id);
  });
});

/* ---------------------------------------------------------------------- 4 */

describe("createEnquiryFromWebsite — defaults", () => {
  test("a new enquiry starts new/normal/unlinked/unassigned, with a received activity", async () => {
    const externalRef = randomUUID();
    const created = await createEnquiryFromWebsite({
      sourceForm: "QUOTE",
      externalRef,
      receivedAt: new Date("2026-09-11T09:00:00.000Z"),
      submission: { name: "Test", message: "Quote please" },
    });

    const [row] = await db.select().from(enquiries).where(eq(enquiries.id, created.id));
    assert.equal(row.source, "website");
    assert.equal(row.sourceForm, "QUOTE");
    assert.equal(row.stage, "new");
    assert.equal(row.priority, "normal");
    assert.equal(row.customerId, null);
    assert.equal(row.assignedToId, null);
    assert.equal(row.externalRef, externalRef);

    const activity = await db.select().from(enquiryActivity).where(eq(enquiryActivity.enquiryId, created.id));
    assert.equal(activity.length, 1);
    assert.equal(activity[0].kind, "received");
  });
});

describe("customer linking", () => {
  test("linking a real customer succeeds and is recorded on the activity trail", async () => {
    const owner = await makeUser("Owner3", "associate");
    const customer = await makeCustomer(owner.id);
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: { phone: customer.phone },
    });

    const result = await linkCustomer(enquiry.id, customer.id);
    assert.equal(result.ok, true, result.ok ? "" : result.error);

    const detail = await getEnquiry(enquiry.id);
    assert.equal(detail?.customerId, customer.id);
    assert.ok(detail?.activity.some((a) => a.kind === "customer_linked"));
  });

  test("linking a customer that does not exist is refused", async () => {
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });
    const result = await linkCustomer(enquiry.id, "cus_does_not_exist");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "not_found");
  });

  test("findCustomersByPhone finds a match by digits", async () => {
    const owner = await makeUser("Owner4", "associate");
    const customer = await makeCustomer(owner.id, { phone: "9123456789" });
    const result = await findCustomersByPhone("9123456789");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.ok(result.data.some((c) => c.id === customer.id));
    }
  });
});

/* ------------------------------------------------------- Medium finding #16 */

describe("linkCustomer — the link is set once and never silently overwritten", () => {
  test("an unlinked enquiry links successfully to Customer A", async () => {
    const owner = await makeUser("OwnerA16", "associate");
    const customerA = await makeCustomer(owner.id);
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });

    const result = await linkCustomer(enquiry.id, customerA.id);
    assert.equal(result.ok, true, result.ok ? "" : result.error);

    const [row] = await db.select().from(enquiries).where(eq(enquiries.id, enquiry.id));
    assert.equal(row.customerId, customerA.id);

    const activity = await db.select().from(enquiryActivity).where(eq(enquiryActivity.enquiryId, enquiry.id));
    const linkedEvents = activity.filter((a) => a.kind === "customer_linked");
    assert.equal(linkedEvents.length, 1, "exactly one customer_linked activity for the one real link");
  });

  test("already linked to Customer A — attempting Customer B is refused, and the link is untouched", async () => {
    const ownerA = await makeUser("OwnerB16a", "associate");
    const ownerB = await makeUser("OwnerB16b", "associate");
    const customerA = await makeCustomer(ownerA.id);
    const customerB = await makeCustomer(ownerB.id);
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });

    const first = await linkCustomer(enquiry.id, customerA.id);
    assert.equal(first.ok, true, first.ok ? "" : first.error);

    const second = await linkCustomer(enquiry.id, customerB.id);
    assert.equal(second.ok, false, "linking a second, different customer must be refused");
    if (!second.ok) assert.equal(second.code, "conflict");

    const [row] = await db.select().from(enquiries).where(eq(enquiries.id, enquiry.id));
    assert.equal(row.customerId, customerA.id, "the ORIGINAL link must remain — never silently repointed to B");

    const activity = await db.select().from(enquiryActivity).where(eq(enquiryActivity.enquiryId, enquiry.id));
    const linkedEvents = activity.filter((a) => a.kind === "customer_linked");
    assert.equal(linkedEvents.length, 1, "the refused second attempt must not write a second, false link activity");
    assert.equal((linkedEvents[0].meta as { customerId: string }).customerId, customerA.id);
  });

  test("already linked to Customer A — attempting Customer A again is also refused, consistent with this codebase's other set-once fields", async () => {
    // Precedent: credit-note-service.ts refuses re-issuing an already-issued
    // credit note outright ("Somebody has already issued this one."),
    // regardless of whether the resubmitted amount matches. "Set once" here
    // means exactly that — not "set once per distinct value" — so relinking
    // the SAME customer is refused the same way as a different one, and the
    // existing row (and its one activity entry) is left exactly as it was.
    const owner = await makeUser("OwnerC16", "associate");
    const customerA = await makeCustomer(owner.id);
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });

    const first = await linkCustomer(enquiry.id, customerA.id);
    assert.equal(first.ok, true, first.ok ? "" : first.error);

    const second = await linkCustomer(enquiry.id, customerA.id);
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.code, "conflict");

    const [row] = await db.select().from(enquiries).where(eq(enquiries.id, enquiry.id));
    assert.equal(row.customerId, customerA.id);

    const activity = await db.select().from(enquiryActivity).where(eq(enquiryActivity.enquiryId, enquiry.id));
    assert.equal(activity.filter((a) => a.kind === "customer_linked").length, 1, "no second activity for the refused repeat");
  });

  test("two concurrent attempts to link the same unlinked enquiry: exactly one wins, the other is refused, never a mixed or overwritten result", async () => {
    // A true multi-process race is outside what this test infrastructure can
    // exercise — one Node process, one test runner. What this DOES prove is
    // the part that actually matters: the guard is the UPDATE's own WHERE
    // clause (`customer_id is null`), not a read-then-branch in application
    // code, so the two calls below hit the database concurrently through the
    // connection pool and Postgres's own row lock — not this test's
    // scheduling — decides which one's WHERE clause still matches. Firing
    // them with Promise.all (rather than awaiting one before starting the
    // other) is the strongest concurrency this environment can exert: both
    // requests are in flight and racing for the same row at once.
    const ownerA = await makeUser("OwnerD16a", "associate");
    const ownerB = await makeUser("OwnerD16b", "associate");
    const customerA = await makeCustomer(ownerA.id);
    const customerB = await makeCustomer(ownerB.id);
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });

    const [resultA, resultB] = await Promise.all([
      linkCustomer(enquiry.id, customerA.id),
      linkCustomer(enquiry.id, customerB.id),
    ]);

    const outcomes = [resultA, resultB];
    const succeeded = outcomes.filter((r) => r.ok);
    const failed = outcomes.filter((r) => !r.ok);
    assert.equal(succeeded.length, 1, "exactly one of the two concurrent attempts must succeed");
    assert.equal(failed.length, 1, "exactly one must be refused");
    assert.equal((failed[0] as { ok: false; code?: string }).code, "conflict");

    const [row] = await db.select().from(enquiries).where(eq(enquiries.id, enquiry.id));
    assert.ok(
      row.customerId === customerA.id || row.customerId === customerB.id,
      "the stored link must be exactly one of the two customers, never null and never corrupted",
    );

    const activity = await db.select().from(enquiryActivity).where(eq(enquiryActivity.enquiryId, enquiry.id));
    assert.equal(
      activity.filter((a) => a.kind === "customer_linked").length,
      1,
      "only the winning attempt may write a customer_linked activity",
    );
  });
});

describe("order linking", () => {
  test("an order can be linked once a customer is linked, and unlinked again", async () => {
    const owner = await makeUser("Owner5", "associate");
    const customer = await makeCustomer(owner.id);
    const order = await makeOrder(customer.id, owner.id);
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });
    await linkCustomer(enquiry.id, customer.id);

    const linked = await linkOrder(enquiry.id, order.id);
    assert.equal(linked.ok, true, linked.ok ? "" : linked.error);

    const rows = await db.select().from(enquiryOrders).where(eq(enquiryOrders.enquiryId, enquiry.id));
    assert.equal(rows.length, 1);

    const remaining = await ordersForLinking(enquiry.id);
    assert.equal(remaining.some((o) => o.id === order.id), false, "an already-linked order must not be offered again");

    const unlinked = await unlinkOrder(enquiry.id, order.id);
    assert.equal(unlinked.ok, true);
    const afterUnlink = await db.select().from(enquiryOrders).where(eq(enquiryOrders.enquiryId, enquiry.id));
    assert.equal(afterUnlink.length, 0);
  });

  test("an order belonging to a different customer than the enquiry's linked one is refused", async () => {
    const owner = await makeUser("Owner6", "associate");
    const customer = await makeCustomer(owner.id);
    const otherCustomer = await makeCustomer(owner.id);
    const otherOrder = await makeOrder(otherCustomer.id, owner.id);
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });
    await linkCustomer(enquiry.id, customer.id);

    const result = await linkOrder(enquiry.id, otherOrder.id);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "rule_violation");
  });
});

/* ------------------------------------------------------- Medium finding #17 */

describe("linkOrder — an order may only be linked once the enquiry has a matching customer", () => {
  test("no customer linked: a valid company order is refused, and no relationship is created", async () => {
    const owner = await makeUser("Owner17a", "associate");
    const customer = await makeCustomer(owner.id);
    // A perfectly real, ordinary order — the point is that it belongs to
    // SOME customer in the company, and this enquiry has none at all.
    const order = await makeOrder(customer.id, owner.id);
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });

    const result = await linkOrder(enquiry.id, order.id);
    assert.equal(result.ok, false, "an unlinked enquiry must not be able to link an arbitrary company order");
    if (!result.ok) assert.equal(result.code, "rule_violation");

    const rows = await db.select().from(enquiryOrders).where(eq(enquiryOrders.enquiryId, enquiry.id));
    assert.equal(rows.length, 0, "no enquiry-order relationship may exist");

    // Product decision #8: this must not have inferred, assigned or created
    // any customer relationship on the enquiry as a side effect.
    const [row] = await db.select().from(enquiries).where(eq(enquiries.id, enquiry.id));
    assert.equal(row.customerId, null);

    const activity = await db.select().from(enquiryActivity).where(eq(enquiryActivity.enquiryId, enquiry.id));
    assert.equal(activity.some((a) => a.kind === "order_linked"), false, "a refused link must not write a false order_linked activity");
  });

  test("Customer A linked + Customer A's own order: linking succeeds", async () => {
    const owner = await makeUser("Owner17b", "associate");
    const customerA = await makeCustomer(owner.id);
    const order = await makeOrder(customerA.id, owner.id);
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });
    await linkCustomer(enquiry.id, customerA.id);

    const result = await linkOrder(enquiry.id, order.id);
    assert.equal(result.ok, true, result.ok ? "" : result.error);

    const rows = await db.select().from(enquiryOrders).where(eq(enquiryOrders.enquiryId, enquiry.id));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].orderId, order.id);

    const activity = await db.select().from(enquiryActivity).where(eq(enquiryActivity.enquiryId, enquiry.id));
    assert.ok(activity.some((a) => a.kind === "order_linked"));
  });

  test("Customer A linked + Customer B's order: linking is refused and nothing is created", async () => {
    const owner = await makeUser("Owner17c", "associate");
    const customerA = await makeCustomer(owner.id);
    const customerB = await makeCustomer(owner.id);
    const orderB = await makeOrder(customerB.id, owner.id);
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });
    await linkCustomer(enquiry.id, customerA.id);

    const result = await linkOrder(enquiry.id, orderB.id);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "rule_violation");

    const rows = await db.select().from(enquiryOrders).where(eq(enquiryOrders.enquiryId, enquiry.id));
    assert.equal(rows.length, 0);

    const [row] = await db.select().from(enquiries).where(eq(enquiries.id, enquiry.id));
    assert.equal(row.customerId, customerA.id, "the enquiry's own customer link must never be reassigned to B");

    const activity = await db.select().from(enquiryActivity).where(eq(enquiryActivity.enquiryId, enquiry.id));
    assert.equal(activity.some((a) => a.kind === "order_linked"), false);
  });

  test("ordersForLinking returns nothing for an enquiry with no customer, even though real company orders exist", async () => {
    const owner = await makeUser("Owner17d", "associate");
    const customer = await makeCustomer(owner.id);
    await makeOrder(customer.id, owner.id);
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });

    const candidates = await ordersForLinking(enquiry.id);
    assert.deepEqual(candidates, [], "no candidates may be offered until the enquiry has a customer");
  });

  test("ordersForLinking returns only the linked customer's own eligible orders", async () => {
    const owner = await makeUser("Owner17e", "associate");
    const customerA = await makeCustomer(owner.id);
    const customerB = await makeCustomer(owner.id);
    const orderA = await makeOrder(customerA.id, owner.id);
    await makeOrder(customerB.id, owner.id); // a real order, belonging to somebody else entirely
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });
    await linkCustomer(enquiry.id, customerA.id);

    const candidates = await ordersForLinking(enquiry.id);
    assert.deepEqual(candidates.map((c) => c.id), [orderA.id], "only Customer A's own order is offered");
  });
});

/* ---------------------------------------------------------------------- 5 */

describe("createEnquiryReminder — routed through the shared reminder service", () => {
  test("refuses a reminder before a customer is linked", async () => {
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });
    const result = await createEnquiryReminder({
      enquiryId: enquiry.id,
      dueDate: "2026-09-15",
      note: "Call back",
      type: "call_back",
      assignedUserId: enquiriesUser.id,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "rule_violation");
  });

  test("refuses a reminder for an assignee that does not exist", async () => {
    const owner = await makeUser("Owner7", "associate");
    const customer = await makeCustomer(owner.id);
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });
    await linkCustomer(enquiry.id, customer.id);

    const result = await createEnquiryReminder({
      enquiryId: enquiry.id,
      dueDate: "2026-09-15",
      note: "Call back",
      type: "call_back",
      assignedUserId: "usr_does_not_exist",
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "not_found");
  });

  test("a valid reminder is written with enquiryId preserved, via the real reminders row", async () => {
    // Owned by enquiriesUser — the acting test user — rather than a separate
    // fixture user: `createReminder` (worklist-services) runs the real
    // `assertCustomerInScope` check, and outside a real request `hatInForce`
    // cannot resolve a per-app hat, so an associate's scope is their own book
    // only. A customer owned by somebody else would be correctly refused, and
    // that refusal has nothing to do with what this test is proving.
    const customer = await makeCustomer(enquiriesUser.id);
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });
    await linkCustomer(enquiry.id, customer.id);

    const result = await createEnquiryReminder({
      enquiryId: enquiry.id,
      dueDate: "2026-09-20",
      note: "Follow up on the quote",
      type: "call_back",
      assignedUserId: enquiriesUser.id,
    });
    assert.equal(result.ok, true, result.ok ? "" : result.error);

    const rows = await db.select().from(reminders).where(eq(reminders.enquiryId, enquiry.id));
    assert.equal(rows.length, 1, "the reminder must exist and carry the enquiryId");
    assert.equal(rows[0].customerId, customer.id);
    assert.equal(rows[0].assignedUserId, enquiriesUser.id);
    assert.equal(rows[0].note, "Follow up on the quote");

    // The activity trail names the REAL reminder id, not a locally-minted one
    // that was never actually written by the shared service.
    const activity = await db
      .select()
      .from(enquiryActivity)
      .where(eq(enquiryActivity.enquiryId, enquiry.id));
    const reminderActivity = activity.find((a) => a.kind === "reminder_created");
    assert.ok(reminderActivity);
    assert.equal((reminderActivity!.meta as { reminderId: string }).reminderId, rows[0].id);
  });

  test("the shared service's own rules are not bypassed: a Sunday due date rolls forward", async () => {
    // Proof that this really goes through worklist-services.createReminder
    // and not a parallel insert: a direct insert has no idea what a working
    // day is. If this rolls forward, the shared function ran.
    await updateSetting("reminders.rollForwardOnNonWorkingDays", true, enquiriesUser.id);

    // Same reasoning as the test above: owned by the acting user so the real
    // scope check in `createReminder` passes on its own merits.
    const customer = await makeCustomer(enquiriesUser.id);
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });
    await linkCustomer(enquiry.id, customer.id);

    // 2026-09-13 is a Sunday.
    const result = await createEnquiryReminder({
      enquiryId: enquiry.id,
      dueDate: "2026-09-13",
      note: "Should roll forward off a non-working day",
      type: "call_back",
      assignedUserId: enquiriesUser.id,
    });
    assert.equal(result.ok, true, result.ok ? "" : result.error);

    const [row] = await db.select().from(reminders).where(eq(reminders.enquiryId, enquiry.id));
    assert.notEqual(row.dueDate, "2026-09-13", "a Sunday due date was not rolled forward — the shared working-day rule did not run");
  });

  test("an Enquiries-authorized associate can create a reminder for a customer owned by a DIFFERENT CRM user (Deep Audit Finding #1)", async () => {
    // This is exactly the scenario the two tests above deliberately avoid —
    // see the comment on "a valid reminder is written...": outside a real
    // request `hatInForce` cannot resolve a per-app hat, so without the fix
    // the shared reminder service's `assertCustomerInScope` would apply the
    // CRM's own "mine" scope to `enquiriesUser` and refuse a customer it does
    // not own, even though Website Enquiries is a separate, company-wide app
    // authorised by `requireEnquiriesAccess()` alone. A different CRM
    // associate owns this customer; `enquiriesUser` (set by beforeEach) has
    // no CRM relationship to them whatsoever.
    const otherCrmOwner = await makeUser("Other CRM Owner", "associate", "crm");
    const customer = await makeCustomer(otherCrmOwner.id);
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });
    await linkCustomer(enquiry.id, customer.id);

    const result = await createEnquiryReminder({
      enquiryId: enquiry.id,
      dueDate: "2026-09-20",
      note: "Follow up — customer belongs to another CRM user's book",
      type: "call_back",
      assignedUserId: enquiriesUser.id,
    });
    assert.equal(result.ok, true, result.ok ? "" : result.error);

    const rows = await db.select().from(reminders).where(eq(reminders.enquiryId, enquiry.id));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].customerId, customer.id);
    assert.equal(rows[0].assignedUserId, enquiriesUser.id);
  });

  test("working-day roll-forward still applies when the customer is owned by a different CRM user", async () => {
    // Proves the bypass is narrow: it skips ONLY assertCustomerInScope, and
    // every other rule inside the shared service — including this one — is
    // still unconditionally enforced for exactly the scenario above.
    await updateSetting("reminders.rollForwardOnNonWorkingDays", true, enquiriesUser.id);

    const otherCrmOwner = await makeUser("Other CRM Owner 2", "associate", "crm");
    const customer = await makeCustomer(otherCrmOwner.id);
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });
    await linkCustomer(enquiry.id, customer.id);

    // 2026-09-13 is a Sunday.
    const result = await createEnquiryReminder({
      enquiryId: enquiry.id,
      dueDate: "2026-09-13",
      note: "Should roll forward even for an out-of-book customer",
      type: "call_back",
      assignedUserId: enquiriesUser.id,
    });
    assert.equal(result.ok, true, result.ok ? "" : result.error);

    const [row] = await db.select().from(reminders).where(eq(reminders.enquiryId, enquiry.id));
    assert.notEqual(row.dueDate, "2026-09-13", "a Sunday due date was not rolled forward for a different-owner customer");
  });
});

/* ------- Deep Audit Finding #1 fix: the bypass is not reachable from CRM -- */

describe("createReminder's skipCustomerScope option — proof ordinary CRM callers cannot reach it", () => {
  test("actions/crm.ts's two createReminderService call sites are still single-argument", () => {
    // worklist-services.createReminder(raw, opts?) is a plain TypeScript
    // parameter, not part of reminderSchema, so the only way an ordinary CRM
    // action could reach the Enquiries-only skipCustomerScope bypass is by
    // someone adding a second argument to one of these call sites. This pins
    // both as source text so that change fails a test rather than shipping
    // silently — a type-level `opts?` cannot be enforced away by a Zod
    // schema, since it is deliberately not part of one.
    const src = readFileSync("src/lib/actions/crm.ts", "utf8");

    assert.match(
      src,
      /const r = await createReminderService\(input\);/,
      "createReminder's call site changed shape — confirm it is still single-argument and does not pass opts",
    );
    assert.match(
      src,
      /const r = await createReminderService\(\{ customerId, dueDate, note \}\);/,
      "createRemindersBulk's call site changed shape — confirm it is still single-argument and does not pass opts",
    );

    const callCount = (src.match(/createReminderService\(/g) ?? []).length;
    assert.equal(
      callCount,
      2,
      "a new call site to the shared reminder service appeared in actions/crm.ts — it must be reviewed for the same bypass risk and added to this test",
    );
  });
});

/* ------------------------------------------------------- Medium finding #14 */

describe("createEnquiryReminder — the reminder type is one centralized list (Medium #14)", () => {
  test("all six existing reminder types are still accepted end to end", async () => {
    for (const type of ENQUIRY_REMINDER_TYPES) {
      const customer = await makeCustomer(enquiriesUser.id);
      const enquiry = await createEnquiryFromWebsite({
        sourceForm: "CONTACT",
        externalRef: randomUUID(),
        receivedAt: new Date(),
        submission: {},
      });
      await linkCustomer(enquiry.id, customer.id);

      const result = await createEnquiryReminder({
        enquiryId: enquiry.id,
        dueDate: "2026-09-20",
        note: `Reminder of type ${type}`,
        type,
        assignedUserId: enquiriesUser.id,
      });
      assert.equal(result.ok, true, result.ok ? "" : `type "${type}" was refused: ${result.error}`);

      const [row] = await db.select().from(reminders).where(eq(reminders.enquiryId, enquiry.id));
      assert.equal(row.type, type, "the exact stored value must match what was requested, unchanged");
    }
  });

  test("an invalid reminder type is still rejected by the shared service's own validation", async () => {
    const customer = await makeCustomer(enquiriesUser.id);
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });
    await linkCustomer(enquiry.id, customer.id);

    // A caller bypassing the application-level type (an older client, a
    // hand-built request) still hits the real Zod enum in
    // `worklist-services.reminderSchema` — centralizing the TypeScript type
    // must not have replaced that runtime check with a compile-time-only one.
    const result = await createEnquiryReminder({
      enquiryId: enquiry.id,
      dueDate: "2026-09-20",
      note: "Should be refused",
      type: "not_a_real_type" as EnquiryReminderType,
      assignedUserId: enquiriesUser.id,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "validation");

    const rows = await db.select().from(reminders).where(eq(reminders.enquiryId, enquiry.id));
    assert.equal(rows.length, 0, "the invalid reminder must not have been written");
  });
});

/* ------------------------------------------------------- Medium finding #11 */

describe("listEnquiries — keyset pagination ordered by (received_at, id)", () => {
  async function makeEnquiryAt(receivedAt: Date, overrides: Record<string, unknown> = {}) {
    const e = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt,
      submission: {},
      ...overrides,
    });
    return e.id;
  }

  test("the first page (no cursor) returns the newest rows first", async () => {
    const base = Date.now();
    const created: string[] = [];
    for (let i = 0; i < 5; i++) created.push(await makeEnquiryAt(new Date(base + i * 1000)));

    const page1 = await listEnquiries({ pageSize: 3 });
    assert.equal(page1.items.length, 3);
    assert.equal(page1.more, true, "two rows remain unread");
    assert.ok(page1.cursor);
    // Newest first: index 4 was received last.
    assert.deepEqual(page1.items.map((i) => i.id), [created[4], created[3], created[2]]);
  });

  test("a cursor returns the next page correctly, with no duplicate and no skipped rows", async () => {
    const base = Date.now();
    const created: string[] = [];
    for (let i = 0; i < 5; i++) created.push(await makeEnquiryAt(new Date(base + i * 1000)));

    const page1 = await listEnquiries({ pageSize: 3 });
    const page2 = await listEnquiries({ pageSize: 3, cursor: page1.cursor });

    assert.equal(page2.items.length, 2);
    assert.equal(page2.more, false);
    // `cursor` names the last row read, whenever there was one — the same
    // contract `customerTimeline`'s own cursor follows. `more` is the
    // separate answer to "does asking again return anything", and it must be
    // false: the history really is exhausted.
    assert.equal(page2.more, false, "the history is exhausted");
    assert.deepEqual(page2.items.map((i) => i.id), [created[1], created[0]]);

    const seen = [...page1.items, ...page2.items].map((i) => i.id);
    assert.equal(new Set(seen).size, 5, "no id must appear on both pages");
    assert.deepEqual([...seen].sort(), [...created].sort(), "every row created must appear exactly once");
  });

  test("enquiries sharing the same received_at are still ordered deterministically, by id", async () => {
    const at = new Date();
    const created: string[] = [];
    for (let i = 0; i < 4; i++) created.push(await makeEnquiryAt(at));

    // Independent ground truth for the tiebreak: the same (received_at desc,
    // id desc) ordering the service uses, read directly rather than assumed.
    const truth = await db
      .select({ id: enquiries.id })
      .from(enquiries)
      .where(inArray(enquiries.id, created))
      .orderBy(desc(enquiries.receivedAt), desc(enquiries.id));
    const expectedOrder = truth.map((r) => r.id);

    const page1 = await listEnquiries({ pageSize: 2 });
    const page2 = await listEnquiries({ pageSize: 2, cursor: page1.cursor });

    assert.deepEqual(page1.items.map((i) => i.id), expectedOrder.slice(0, 2));
    assert.deepEqual(page2.items.map((i) => i.id), expectedOrder.slice(2, 4));
  });

  test("existing filters keep narrowing the result across a cursor boundary", async () => {
    const base = Date.now();
    const matching: string[] = [];
    for (let i = 0; i < 3; i++) {
      matching.push(await makeEnquiryAt(new Date(base + i * 1000)));
    }
    // Received after all three, and never moved to "contacted" — must never
    // appear in a stage-filtered page, however the cursor moves.
    const other = await makeEnquiryAt(new Date(base + 10_000));
    for (const enquiryId of matching) await changeStage(enquiryId, "contacted");

    const page1 = await listEnquiries({ stage: "contacted", pageSize: 2 });
    assert.equal(page1.total, 3, "the count is scoped to the filter, not the whole table");
    assert.equal(page1.items.length, 2);
    assert.ok(!page1.items.some((i) => i.id === other));

    const page2 = await listEnquiries({ stage: "contacted", pageSize: 2, cursor: page1.cursor });
    assert.equal(page2.items.length, 1);
    assert.equal(page2.more, false);
    assert.ok(!page2.items.some((i) => i.id === other));

    const allIds = [...page1.items, ...page2.items].map((i) => i.id).sort();
    assert.deepEqual(allIds, [...matching].sort());
  });
});

/* ------------------------------------------------------- Medium finding #12 */

describe("listEnquiries — search matches values, never JSON key names", () => {
  test("a search term matching name, phone, email, company or message finds the enquiry", async () => {
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {
        name: "Rohit Sharma",
        phone: "9876543210",
        email: "rohit@sharmatraders.example",
        company: "Sharma Traders",
        message: "Need bulk pricing on thinner",
      },
    });

    for (const term of ["Sharma", "9876543210", "sharmatraders", "bulk pricing"]) {
      const { items } = await listEnquiries({ q: term });
      assert.ok(
        items.some((i) => i.id === enquiry.id),
        `search term "${term}" should have found the enquiry`,
      );
    }
  });

  test("searching a JSON property name alone does not match an enquiry merely because that key exists", async () => {
    // None of these VALUES contain the word "email", "phone" or "company" —
    // only the JSON keys do. The old `rawSubmission::text ilike` matched on
    // the serialised key names too; `search_text` must not.
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {
        name: "Priya",
        email: "priya@xyz.example",
        phone: "9123456780",
        company: "Xyz Traders",
      },
    });

    for (const key of ["email", "phone", "company", "message", "sourceForm", "externalRef"]) {
      const { items } = await listEnquiries({ q: key });
      assert.ok(
        !items.some((i) => i.id === enquiry.id),
        `searching the key name "${key}" must not match an enquiry that merely has that field`,
      );
    }

    // The values themselves still work.
    const byName = await listEnquiries({ q: "Priya" });
    assert.ok(byName.items.some((i) => i.id === enquiry.id));
  });

  test("existing filters (stage) continue to narrow a text search", async () => {
    const matching = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: { name: "Anand Traders", message: "Anand needs a quote" },
    });
    const wrongStage = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: { name: "Anand Hardware", message: "Also asking about Anand's order" },
    });
    await changeStage(matching.id, "contacted");

    const result = await listEnquiries({ q: "Anand", stage: "contacted" });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].id, matching.id);
    assert.ok(!result.items.some((i) => i.id === wrongStage.id));
  });

  test("search results page correctly with the keyset cursor from #11", async () => {
    const base = Date.now();
    const matching: string[] = [];
    for (let i = 0; i < 5; i++) {
      const e = await createEnquiryFromWebsite({
        sourceForm: "CONTACT",
        externalRef: randomUUID(),
        receivedAt: new Date(base + i * 1000),
        submission: { company: "Vantage Coatings", message: `Enquiry number ${i}` },
      });
      matching.push(e.id);
    }
    // Never matches the search term — must not appear on any page.
    const other = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(base + 10_000),
      submission: { company: "Some Other Company" },
    });

    const page1 = await listEnquiries({ q: "Vantage", pageSize: 2 });
    const page2 = await listEnquiries({ q: "Vantage", pageSize: 2, cursor: page1.cursor });
    const page3 = await listEnquiries({ q: "Vantage", pageSize: 2, cursor: page2.cursor });

    assert.equal(page1.total, 5);
    const seen = [...page1.items, ...page2.items, ...page3.items].map((i) => i.id);
    assert.equal(new Set(seen).size, 5, "no duplicate across pages");
    assert.deepEqual([...seen].sort(), [...matching].sort(), "every matching row seen exactly once");
    assert.ok(!seen.includes(other.id), "a non-matching enquiry must never appear");
    assert.equal(page3.more, false);
  });

  test("an enquiry with no name/phone/email/company/message is handled safely", async () => {
    const bare = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: { unrecognised_field: "something" },
    });

    const [row] = await db.select().from(enquiries).where(eq(enquiries.id, bare.id));
    assert.equal(row.searchText, "", "no searchable value exists, so search_text is empty rather than absent");

    // Does not crash, and is not returned for an unrelated search term.
    const searched = await listEnquiries({ q: "something else entirely" });
    assert.ok(!searched.items.some((i) => i.id === bare.id));

    // Still listed when nobody is searching.
    const unfiltered = await listEnquiries({});
    assert.ok(unfiltered.items.some((i) => i.id === bare.id));
  });
});

/* -------------------------------------------------------- dashboard counts */

describe("enquiryDashboardCounts", () => {
  test("counts total, by stage, unassigned and high/urgent correctly", async () => {
    const owner = await makeUser("Owner10", "associate");

    const a = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });
    const b = await createEnquiryFromWebsite({
      sourceForm: "QUOTE",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });
    const c = await createEnquiryFromWebsite({
      sourceForm: "SAMPLE",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });

    await changeStage(b.id, "contacted");
    await changePriority(c.id, "urgent");
    await assignEnquiry(a.id, owner.id);

    const counts = await enquiryDashboardCounts();
    assert.equal(counts.total, 3);
    assert.equal(counts.byStage.new, 2, "b moved to contacted, a and c remain new");
    assert.equal(counts.byStage.contacted, 1);
    assert.equal(counts.unassigned, 2, "b and c are still unassigned");
    assert.equal(counts.highOrUrgent, 1);
  });

  test("listEnquiries filters by unassigned and by stage the same way the dashboard counts them", async () => {
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });
    const { items, total } = await listEnquiries({ assignedToId: "unassigned", pageSize: 25 });
    assert.equal(total, 1);
    assert.equal(items[0].id, enquiry.id);
  });
});

/* ------------------------------------------------------ Senior finding #2 */

describe("assignment cannot hand enquiry work to somebody who cannot see it (capabilities/scope)", () => {
  test("assignEnquiry refuses a target who does not hold Website Enquiries access", async () => {
    const outsider = await makeUser("Outsider2a", "associate", "crm");
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });

    const result = await assignEnquiry(enquiry.id, outsider.id);
    assert.equal(result.ok, false, "assigning to somebody outside the app's scope must be refused");
    if (!result.ok) assert.equal(result.code, "rule_violation");

    const [row] = await db.select().from(enquiries).where(eq(enquiries.id, enquiry.id));
    assert.equal(row.assignedToId, null, "the enquiry must remain unassigned, not silently assigned to an outsider");
  });

  test("assignEnquiry succeeds for a target who does hold Website Enquiries access", async () => {
    // makeUser's default third argument already grants "enquiries" — this is
    // the existing, already-correct path, kept alongside the refusal above so
    // a future change to the check cannot silently start refusing everyone.
    const colleague = await makeUser("Colleague2a", "associate");
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });

    const result = await assignEnquiry(enquiry.id, colleague.id);
    assert.equal(result.ok, true, result.ok ? "" : result.error);

    const [row] = await db.select().from(enquiries).where(eq(enquiries.id, enquiry.id));
    assert.equal(row.assignedToId, colleague.id);
  });

  test("createEnquiryReminder refuses an assignee who does not hold Website Enquiries access", async () => {
    const outsider = await makeUser("Outsider2b", "associate", "crm");
    const customer = await makeCustomer(enquiriesUser.id);
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });
    await linkCustomer(enquiry.id, customer.id);

    const result = await createEnquiryReminder({
      enquiryId: enquiry.id,
      dueDate: "2026-09-20",
      note: "Should not be assignable to an outsider",
      type: "call_back",
      assignedUserId: outsider.id,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "rule_violation");

    const rows = await db.select().from(reminders).where(eq(reminders.enquiryId, enquiry.id));
    assert.equal(rows.length, 0, "no reminder may be created for an assignee outside the app's scope");
  });
});

/* -------------------------------------------------- Senior finding #21 */

describe("assignEnquiry notifies whoever's queue actually changed (Senior #21)", () => {
  test("unassigned to User B: B is told, with the right kind/title/body/href", async () => {
    const colleague = await makeUser("Notify21a", "associate");
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });

    const result = await assignEnquiry(enquiry.id, colleague.id);
    assert.equal(result.ok, true, result.ok ? "" : result.error);

    const rows = await db.select().from(notifications).where(eq(notifications.userId, colleague.id));
    assert.equal(rows.length, 1, "exactly one notification for the newly assigned user");
    assert.equal(rows[0].kind, "info");
    assert.equal(rows[0].title, "Website enquiry assigned to you");
    assert.match(rows[0].body, new RegExp(enquiriesUser.name));
    assert.equal(rows[0].href, `/enquiries/list/${enquiry.id}`);
  });

  test("User A to User B (a third party reassigns): both A and B are told, exactly once each, the actor is told nothing", async () => {
    const userA = await makeUser("Notify21b-A", "associate");
    const userB = await makeUser("Notify21b-B", "associate");
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });
    await assignEnquiry(enquiry.id, userA.id);
    await db.delete(notifications); // clear the first assignment's own notification

    // enquiriesUser (the acting/current test user) is a third party — neither A nor B.
    const result = await assignEnquiry(enquiry.id, userB.id);
    assert.equal(result.ok, true, result.ok ? "" : result.error);

    const rowsB = await db.select().from(notifications).where(eq(notifications.userId, userB.id));
    assert.equal(rowsB.length, 1, "the new assignee is told exactly once");
    assert.equal(rowsB[0].title, "Website enquiry assigned to you");

    const rowsA = await db.select().from(notifications).where(eq(notifications.userId, userA.id));
    assert.equal(rowsA.length, 1, "the previous assignee is told exactly once");
    assert.equal(rowsA[0].title, "Website enquiry moved from you");
    assert.match(rowsA[0].body, new RegExp(userB.name));

    const rowsActor = await db.select().from(notifications).where(eq(notifications.userId, enquiriesUser.id));
    assert.equal(rowsActor.length, 0, "the person who performed the reassignment is never told about their own action");

    const all = await db.select().from(notifications);
    assert.equal(all.length, 2, "no duplicate rows — one per affected person, never more");
  });

  test("reassigning to the same user who already holds it is a no-op: no notification at all", async () => {
    const userA = await makeUser("Notify21c-A", "associate");
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });
    await assignEnquiry(enquiry.id, userA.id);
    await db.delete(notifications);

    const result = await assignEnquiry(enquiry.id, userA.id);
    assert.equal(result.ok, true, result.ok ? "" : result.error);

    assert.equal((await db.select().from(notifications)).length, 0, "naming the same holder again must tell nobody");
  });

  test("self-assignment: the actor receives no notification for assigning it to themselves", async () => {
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });

    // enquiriesUser assigns the enquiry to themselves.
    const result = await assignEnquiry(enquiry.id, enquiriesUser.id);
    assert.equal(result.ok, true, result.ok ? "" : result.error);

    const rows = await db.select().from(notifications).where(eq(notifications.userId, enquiriesUser.id));
    assert.equal(rows.length, 0, "nobody needs to be told they did their own thing");
  });

  test("unassigning: the previous assignee is told, and there is no new-assignee notification to create", async () => {
    const userA = await makeUser("Notify21e-A", "associate");
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });
    await assignEnquiry(enquiry.id, userA.id);
    await db.delete(notifications);

    // enquiriesUser (a third party) unassigns it.
    const result = await assignEnquiry(enquiry.id, null);
    assert.equal(result.ok, true, result.ok ? "" : result.error);

    const rowsA = await db.select().from(notifications).where(eq(notifications.userId, userA.id));
    assert.equal(rowsA.length, 1, "the person who lost it is told");
    assert.equal(rowsA[0].title, "Website enquiry unassigned");
    assert.match(rowsA[0].body, new RegExp(enquiriesUser.name));

    const all = await db.select().from(notifications);
    assert.equal(all.length, 1, "there is no new assignee, so there is nothing else to send");
  });

  test("an invalid target is refused, and writes no notification and no activity", async () => {
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });

    const result = await assignEnquiry(enquiry.id, "usr_does_not_exist");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "not_found");

    assert.equal((await db.select().from(notifications)).length, 0, "a refused assignment must not notify anybody");
    const activity = await db.select().from(enquiryActivity).where(eq(enquiryActivity.enquiryId, enquiry.id));
    assert.equal(
      activity.some((a) => a.kind === "assigned" || a.kind === "reassigned"),
      false,
      "existing behavior is unchanged: a refused assignment writes no activity either",
    );
  });

  test("a target without Website Enquiries access is refused, and writes no notification", async () => {
    const outsider = await makeUser("Notify21g", "associate", "crm");
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });

    const result = await assignEnquiry(enquiry.id, outsider.id);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "rule_violation");

    assert.equal((await db.select().from(notifications)).length, 0, "a refused assignment must not notify the ineligible target either");
    const [row] = await db.select().from(enquiries).where(eq(enquiries.id, enquiry.id));
    assert.equal(row.assignedToId, null, "existing access behavior is unchanged: the enquiry remains unassigned");
  });
});

/* --------------------------------------------------- Senior finding: launcher badge */

describe("launcherApps — the Website Enquiries tile reflects real unassigned enquiries", () => {
  test("with pending (unassigned) enquiries, the badge shows the real count and sentence", async () => {
    // enquiriesUser (from beforeEach) holds exactly the "enquiries" grant.
    await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });
    await createEnquiryFromWebsite({
      sourceForm: "QUOTE",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });

    const apps = await launcherApps(enquiriesUser);
    const tile = apps.find((a) => a.id === "enquiries");
    assert.ok(tile, "the enquiries tile must appear for a user holding the app");
    assert.equal(tile.count, 2, "the badge must be the real unassigned count, not a stub");
    assert.match(tile.status, /2 enquiries unassigned/);
  });

  test("with zero unassigned enquiries, the badge shows the genuine empty state", async () => {
    const owner = await makeUser("LauncherOwner", "associate");
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });
    // Assigning it away is what makes zero the CORRECT, live answer here —
    // not a hardcoded fallback standing in for a query that never ran.
    await assignEnquiry(enquiry.id, owner.id);

    const apps = await launcherApps(enquiriesUser);
    const tile = apps.find((a) => a.id === "enquiries");
    assert.ok(tile);
    assert.equal(tile.count, 0);
    assert.equal(tile.status, "Nothing waiting");
  });

  test("a user without the enquiries app gets no enquiries tile at all — no count leaks to somebody outside its scope", async () => {
    const crmOnly = await makeUser("LauncherOutsider", "associate", "crm");
    await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });

    const apps = await launcherApps(crmOnly);
    assert.equal(apps.some((a) => a.id === "enquiries"), false);
  });
});

/* ------------------------------------------------- Senior finding: stamp/timezone */

describe("order and duplicate dates use the business's own calendar day, not UTC (timezone)", () => {
  test("getEnquiry's linkedOrders reports the IST calendar date for an order placed just after midnight IST", async () => {
    const customer = await makeCustomer(enquiriesUser.id);
    // 2026-09-10T20:00:00Z is 2026-09-11 01:30 IST — after midnight in the
    // business's own timezone but still "2026-09-10" in UTC. A bare
    // `.toISOString()` read back through a date-only formatter would show
    // the WRONG, earlier day.
    const order = await makeOrder(customer.id, enquiriesUser.id, {
      orderedAt: new Date("2026-09-10T20:00:00.000Z"),
    });
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });
    await linkCustomer(enquiry.id, customer.id);
    await linkOrder(enquiry.id, order.id);

    const detail = await getEnquiry(enquiry.id);
    assert.equal(
      detail?.linkedOrders[0]?.orderedAt,
      "2026-09-11",
      "the order's IST calendar date, not the UTC one, must be reported",
    );
  });

  test("ordersForLinking reports the same IST calendar date for a candidate order", async () => {
    const customer = await makeCustomer(enquiriesUser.id);
    const order = await makeOrder(customer.id, enquiriesUser.id, {
      orderedAt: new Date("2026-09-10T20:00:00.000Z"),
    });
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });
    await linkCustomer(enquiry.id, customer.id);

    const candidates = await ordersForLinking(enquiry.id);
    const candidate = candidates.find((c) => c.id === order.id);
    assert.ok(candidate);
    assert.equal(candidate.orderedAt, "2026-09-11");
  });

  test("findPossibleDuplicateEnquiries reports the IST calendar date an enquiry was actually received on", async () => {
    const phone = "9812345670";
    // Same boundary case, on the enquiry's own receivedAt this time.
    const duplicate = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date("2026-09-10T20:00:00.000Z"),
      submission: { phone },
    });
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: { phone },
    });

    const found = await findPossibleDuplicateEnquiries(enquiry.id, phone);
    const match = found.find((d) => d.id === duplicate.id);
    assert.ok(match, "the other enquiry sharing this phone must be found");
    assert.equal(match.receivedAt, "2026-09-11");
  });

  test("a normal, non-boundary order date is unaffected", async () => {
    const customer = await makeCustomer(enquiriesUser.id);
    // Comfortably midday IST — UTC and IST calendar dates agree here, so this
    // proves the fix did not merely shift every date by a day.
    const order = await makeOrder(customer.id, enquiriesUser.id, {
      orderedAt: new Date("2026-09-10T09:00:00.000Z"),
    });
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });
    await linkCustomer(enquiry.id, customer.id);
    await linkOrder(enquiry.id, order.id);

    const detail = await getEnquiry(enquiry.id);
    assert.equal(detail?.linkedOrders[0]?.orderedAt, "2026-09-10");
  });
});

/* ------------------------------------------------- Senior finding: insufficient test coverage */

describe("changeStage / changePriority enforce the same access gate as every other mutation", () => {
  // Every other mutation in this file (addNote, assignEnquiry, linkCustomer,
  // createEnquiryReminder) has its own "unauthorized caller is refused" test.
  // These two never did, despite going through the identical
  // requireEnquiriesAccess() call — a real, previously-unproven gap in
  // exactly the capability/scope area Senior finding #2 was about.
  test("changeStage refuses a user without Website Enquiries access", async () => {
    const crmOnly = await makeUser("StageOutsider", "associate", "crm");
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });

    setTestUser(crmOnly);
    const result = await changeStage(enquiry.id, "contacted");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "not_permitted");

    const [row] = await db.select().from(enquiries).where(eq(enquiries.id, enquiry.id));
    assert.equal(row.stage, "new", "an unauthorized caller must not be able to move the stage");
  });

  test("changePriority refuses a user without Website Enquiries access", async () => {
    const crmOnly = await makeUser("PriorityOutsider", "associate", "crm");
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });

    setTestUser(crmOnly);
    const result = await changePriority(enquiry.id, "urgent");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "not_permitted");

    const [row] = await db.select().from(enquiries).where(eq(enquiries.id, enquiry.id));
    assert.equal(row.priority, "normal", "an unauthorized caller must not be able to change the priority");
  });
});

describe("addNote — content and validation, not just the access gate", () => {
  test("a note's trimmed text is actually written to the activity trail", async () => {
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });

    const result = await addNote(enquiry.id, "  Called back, wants a quote by Friday.  ");
    assert.equal(result.ok, true, result.ok ? "" : result.error);

    const activity = await db.select().from(enquiryActivity).where(eq(enquiryActivity.enquiryId, enquiry.id));
    const noteEntry = activity.find((a) => a.kind === "note");
    assert.ok(noteEntry, "a note activity entry must exist");
    assert.equal(noteEntry!.note, "Called back, wants a quote by Friday.", "the note must be trimmed and stored verbatim");
  });

  test("an empty or whitespace-only note is refused and writes nothing", async () => {
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });

    const result = await addNote(enquiry.id, "   ");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "validation");

    const activity = await db.select().from(enquiryActivity).where(eq(enquiryActivity.enquiryId, enquiry.id));
    assert.equal(activity.some((a) => a.kind === "note"), false, "a rejected empty note must not be written");
  });
});

describe("markEnquiryViewedIfFirst — only the FIRST view is recorded", () => {
  test("a second view, even by a different user, does not create a second `viewed` activity entry", async () => {
    const secondViewer = await makeUser("SecondViewer", "associate");
    const enquiry = await createEnquiryFromWebsite({
      sourceForm: "CONTACT",
      externalRef: randomUUID(),
      receivedAt: new Date(),
      submission: {},
    });

    await markEnquiryViewedIfFirst(enquiry.id, enquiriesUser.id);
    await markEnquiryViewedIfFirst(enquiry.id, secondViewer.id);

    const activity = await db.select().from(enquiryActivity).where(eq(enquiryActivity.enquiryId, enquiry.id));
    const viewedEntries = activity.filter((a) => a.kind === "viewed");
    assert.equal(viewedEntries.length, 1, "only the first view may be recorded, however many people open it afterwards");
    assert.equal(viewedEntries[0].actorUserId, enquiriesUser.id, "the recorded viewer must be whoever actually saw it first");
  });
});
