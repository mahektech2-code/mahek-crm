/**
 * A website enquiry becomes a lead on the calling desk — by hand, through the
 * one writer, and only for the people who were given the desk.
 *
 * Runs against mahekone_test with the real actions and services: scope,
 * capabilities, module grants and the audit log are the real thing, because this
 * feature adds no mechanism of its own and the way to prove it is to drive the
 * existing ones.
 *
 * What is pinned, in the order it was asked for:
 *
 *   A  the website still creates an enquiry, once, with its source and raw
 *      submission intact;
 *   B  Create lead — the four forms that may become one, the four that may not,
 *      the Suspect rung, the source, the prefill, the atomic link and the
 *      refusal of a second lead from the same enquiry;
 *   C  assignment — an unowned lead is on no telecaller's desk and says so, the
 *      administrator sees it, and once it is assigned the telecaller can open it
 *      and work it;
 *   D  the desk is granted, not inherited — the module, the actions behind it
 *      and the migration that keeps existing CRM users from receiving it.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  appModuleAccess,
  customers,
  enquiries,
  enquiryActivity,
  notifications,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { canOpenModule } from "@/lib/access";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { captureLead } from "@/lib/actions/lead-intake";
import { leadFromEnquiryContextAction } from "@/lib/actions/enquiries";
import { assignDeskLead } from "@/lib/actions/lead-desk-assignment";
import { logQualificationCall } from "@/lib/actions/lead-calling-desk";
import { bandOf } from "@/lib/engines/lead-ladder";
import { modulesForApp } from "@/lib/modules";
import { createEnquiryFromWebsite } from "@/lib/services/enquiry-service";
import { callingDesk, deskLeadRecord } from "@/lib/services/lead-calling-desk-service";
import { DESK_MODULE, deskAssigners, deskHolders } from "@/lib/services/lead-desk-assignment-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const DAY = "2026-09-24";

let telecaller: typeof users.$inferSelect;
let boss: typeof users.$inferSelect;
let manager: typeof users.$inferSelect;
let crmOnly: typeof users.$inferSelect;

async function makeUser(
  name: string,
  role: "associate" | "manager" | "admin",
  apps: ("crm" | "enquiries")[],
) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 4)}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  for (const app of apps) {
    await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app, role });
  }
  return row;
}

/** Narrow a person's CRM to exactly these modules — what the Access screen writes. */
async function grantCrmModules(userId: string, modules: string[]) {
  for (const key of modules) {
    await db.insert(appModuleAccess).values({ id: id("mod"), userId, app: "crm", module: key });
  }
}

const FORMS = ["QUOTE", "PRODUCT_ENQUIRY", "QUICK_ENQUIRY", "DISTRIBUTOR"] as const;

async function makeEnquiry(
  form: string,
  over: { category?: string; submission?: Record<string, unknown> } = {},
) {
  const created = await createEnquiryFromWebsite({
    sourceForm: form,
    category: over.category ?? "SALES",
    externalRef: randomUUID(),
    receivedAt: new Date("2026-09-20T09:00:00Z"),
    submission: over.submission ?? {
      name: "Ganesh Pawar",
      company: "Shree Ganesh Paints",
      phone: "+91 98230 11101",
      email: "ganesh@shreeganeshpaints.in",
      message: "Need PU thinner for our paint shop, please send rates.",
      product: "PU Thinner",
      quantity: "200 litres a month",
    },
  });
  return created.id;
}

const enquiryRow = async (enquiryId: string) =>
  (await db.select().from(enquiries).where(eq(enquiries.id, enquiryId)))[0];

type Prefill = NonNullable<Awaited<ReturnType<typeof prefillOf>>>;

/** What the dialog opens with — read once, so a second press can post what a stale tab still holds. */
async function prefillOf(enquiryId: string) {
  const ctx = await leadFromEnquiryContextAction(enquiryId);
  assert.ok(ctx.ok, ctx.ok ? "" : ctx.error);
  return ctx.data.enquiry.prefill;
}

/** Create the lead the way the dialog does: prefill from the server, complete what is missing, post to captureLead. */
async function createLead(
  enquiryId: string,
  extra: Partial<Parameters<typeof captureLead>[0]> = {},
  held?: Prefill,
) {
  const p = held ?? (await prefillOf(enquiryId));
  return captureLead({
    salesType: "direct",
    name: p.name ?? "",
    companyName: p.companyName ?? undefined,
    contactPerson: p.contactPerson ?? undefined,
    email: p.email ?? undefined,
    phone: p.phone ?? "",
    city: p.city ?? "Nashik",
    address: p.address ?? undefined,
    requirement: p.requirement ?? undefined,
    notes: p.notes ?? undefined,
    source: "website",
    fromEnquiry: { enquiryId },
    ...extra,
  });
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
      enquiry_orders, enquiry_activity, enquiries, reminders, lead_stage_transitions, mbos_tasks,
      calls, notifications, timeline_events, audit_log, orders, app_secrets, app_module_access,
      app_access, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  /* The telecaller is explicitly GRANTED the desk, beside the CRM screens she works in. */
  telecaller = await makeUser("Telecaller A", "associate", ["crm", "enquiries"]);
  await grantCrmModules(telecaller.id, ["crm.dashboard", "crm.leads", DESK_MODULE]);
  /* The administrator holds the whole CRM — no module rows — which is what includes the desk. */
  boss = await makeUser("Office Administrator", "admin", ["crm", "enquiries"]);
  manager = await makeUser("Sales Manager", "manager", ["crm"]);
  await grantCrmModules(manager.id, ["crm.dashboard", "crm.leads"]);
  /* Somebody in the CRM narrowed to other screens: no desk. */
  crmOnly = await makeUser("Other CRM User", "associate", ["crm", "enquiries"]);
  await grantCrmModules(crmOnly.id, ["crm.dashboard", "crm.customers"]);
  setTestUser(telecaller);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

/* ------------------------------------------------------------------------ A */

describe("A — the website still creates an enquiry", () => {
  test("one row, source and form and raw submission preserved, and a resend is a no-op", async () => {
    const externalRef = randomUUID();
    const input = {
      sourceForm: "QUOTE",
      category: "SALES",
      externalRef,
      receivedAt: new Date("2026-09-20T09:00:00Z"),
      submission: { name: "Rohit", phone: "9876543210", message: "Need a quote" },
    };
    const first = await createEnquiryFromWebsite(input);
    const again = await createEnquiryFromWebsite({ ...input, submission: { name: "Rohit", phone: "9876543210", message: "resent" } });
    assert.equal(first.duplicate, false);
    assert.equal(again.duplicate, true);
    assert.equal(again.id, first.id);

    const row = await enquiryRow(first.id);
    assert.equal(row.source, "website");
    assert.equal(row.sourceForm, "QUOTE");
    assert.equal(row.category, "SALES");
    assert.equal(row.customerId, null, "nothing is converted automatically");
    assert.equal((row.rawSubmission as { message: string }).message, "Need a quote");
    const leads = await db.select().from(customers).where(eq(customers.kind, "lead"));
    assert.equal(leads.length, 0, "receiving an enquiry never raises a lead");
  });
});

/* ------------------------------------------------------------------------ B */

describe("B — Create lead", () => {
  for (const form of FORMS) {
    test(`${form}: the lead is a Suspect from the website, the enquiry points at it, and what the visitor typed is reused`, async () => {
      const enquiryId = await makeEnquiry(form);
      const r = await createLead(enquiryId);
      assert.ok(r.ok, r.ok ? "" : r.error);
      assert.equal(r.data.stage, "suspect");

      const [lead] = await db.select().from(customers).where(eq(customers.id, r.data.customerId));
      assert.equal(lead.kind, "lead");
      assert.equal(lead.leadStage, "suspect");
      assert.equal(lead.leadSource, "website", "the configured source code, not a free-text spelling");
      assert.match(lead.leadSourceDetail ?? "", /form on the website/);
      assert.equal(lead.name, "Shree Ganesh Paints");
      assert.equal(lead.companyName, "Shree Ganesh Paints");
      assert.equal(lead.contactPerson, "Ganesh Pawar");
      assert.equal(lead.phone, "9823011101", "the number the visitor typed, as ten digits");
      assert.equal(lead.email, "ganesh@shreeganeshpaints.in");
      assert.match(lead.leadNotes ?? "", /Need PU thinner for our paint shop/);
      assert.match(lead.leadRequirement ?? "", /PU Thinner/);
      assert.equal(lead.ownerId, null, "assignment is somebody's decision, never automatic");
      assert.equal(bandOf(lead.leadStage!), "new", "the funnel counts it in its first band");

      const row = await enquiryRow(enquiryId);
      assert.equal(row.customerId, lead.id);
      const acts = await db.select().from(enquiryActivity).where(eq(enquiryActivity.enquiryId, enquiryId));
      assert.ok(acts.some((a) => a.kind === "lead_created" && a.actorUserId === telecaller.id));
    });
  }

  test("the four forms that are not a sales lead are refused, and a career application above all", async () => {
    for (const form of ["CAREER", "CONTACT", "TECHNICAL_ENQUIRY", "SAMPLE"]) {
      const enquiryId = await makeEnquiry(form, { category: form === "CAREER" ? "CAREER" : "GENERAL" });
      const ctx = await leadFromEnquiryContextAction(enquiryId);
      assert.equal(ctx.ok, false, `${form} offers Create lead`);
      const r = await createLead(enquiryId).catch((e) => e);
      assert.ok(r instanceof Error || r.ok === false, `${form} became a lead`);
      assert.equal((await enquiryRow(enquiryId)).customerId, null);
    }
    const leads = await db.select().from(customers).where(eq(customers.kind, "lead"));
    assert.equal(leads.length, 0);
  });

  test("a form the website sends as one thing and files under CAREER is still refused", async () => {
    const enquiryId = await makeEnquiry("QUOTE", { category: "CAREER" });
    assert.equal((await leadFromEnquiryContextAction(enquiryId)).ok, false);
  });

  test("a second lead from the same enquiry is refused, and only one exists", async () => {
    const enquiryId = await makeEnquiry("QUOTE");
    const held = await prefillOf(enquiryId);
    const first = await createLead(enquiryId, {}, held);
    assert.ok(first.ok);
    const second = await createLead(enquiryId, { allowDuplicate: true }, held);
    assert.equal(second.ok, false);
    assert.equal(!second.ok && second.code, "conflict");
    const leads = await db.select().from(customers).where(eq(customers.kind, "lead"));
    assert.equal(leads.length, 1);
    assert.equal((await leadFromEnquiryContextAction(enquiryId)).ok, false, "the button is gone once it has a lead");
  });

  test("two people pressing Create lead at once make ONE lead, and the loser leaves nothing behind", async () => {
    const enquiryId = await makeEnquiry("PRODUCT_ENQUIRY");
    const held = await prefillOf(enquiryId);
    const [a, b] = await Promise.all([createLead(enquiryId, {}, held), createLead(enquiryId, {}, held)]);
    assert.equal([a, b].filter((r) => r.ok).length, 1, "exactly one succeeds");
    const leads = await db.select().from(customers).where(eq(customers.kind, "lead"));
    assert.equal(leads.length, 1, "the transaction that lost was undone with its lead");
    assert.equal((await enquiryRow(enquiryId)).customerId, leads[0].id, "the enquiry points at the lead that exists");
  });

  test("a phone number already on the book is a question, and nothing is linked until it is answered", async () => {
    const enquiryId = await makeEnquiry("QUICK_ENQUIRY");
    await db.insert(customers).values({
      id: id("cus"), name: "Existing Shop", phone: "9823011101", city: "Pune", kind: "customer",
    });
    const asked = await createLead(enquiryId);
    assert.equal(asked.ok, false);
    assert.equal(!asked.ok && asked.code, "duplicate");
    assert.equal((await enquiryRow(enquiryId)).customerId, null, "a refused lead links nothing");

    const different = await createLead(enquiryId, { allowDuplicate: true });
    assert.ok(different.ok, different.ok ? "" : different.error);
  });

  test("the source is the enquiry's own — a client cannot claim another channel or another enquiry's form", async () => {
    const enquiryId = await makeEnquiry("QUOTE");
    const r = await createLead(enquiryId, { source: "salesman_prospecting", sourceDetail: "made up" });
    assert.ok(r.ok);
    const [lead] = await db.select().from(customers).where(eq(customers.id, r.data.customerId));
    assert.equal(lead.leadSource, "website");
    assert.notEqual(lead.leadSourceDetail, "made up");
  });

  test("somebody without Website Enquiries cannot convert one, whatever else they hold", async () => {
    const enquiryId = await makeEnquiry("QUOTE");
    const desklessOfEnquiries = await makeUser("No Enquiries", "associate", ["crm"]);
    setTestUser(desklessOfEnquiries);
    const r = await createLead(enquiryId).catch((e: unknown) => e);
    assert.ok(r instanceof Error || (typeof r === "object" && r !== null && "ok" in r && r.ok === false));
    assert.equal((await enquiryRow(enquiryId)).customerId, null);
  });

  test("the enquiry says whether anybody has the lead it made", async () => {
    const enquiryId = await makeEnquiry("QUOTE");
    const r = await createLead(enquiryId);
    assert.ok(r.ok);
    const { getEnquiry } = await import("@/lib/services/enquiry-service");
    const detail = await getEnquiry(enquiryId);
    assert.equal(detail?.customerKind, "lead");
    assert.equal(detail?.customerOwnerName, null, "unowned, and the screen says so");
  });
});

/* ------------------------------------------------------------------------ C */

describe("C — assignment and what each person sees", () => {
  test("an unowned lead is on no telecaller's desk, is seen and flagged for the administrator, and the assigners are told", async () => {
    const enquiryId = await makeEnquiry("QUOTE");
    const r = await createLead(enquiryId);
    assert.ok(r.ok);
    assert.match(r.message ?? "", /no owner yet/i, "the person who created it is told it is unowned");
    const leadId = r.data.customerId;

    const mine = await callingDesk(DAY, "all");
    assert.ok(!mine.all.some((l) => l.id === leadId), "an associate's scope is her own book: an unowned lead is not in it");

    setTestUser(boss);
    const theirs = await callingDesk(DAY, "all");
    const row = theirs.all.find((l) => l.id === leadId);
    assert.ok(row, "the administrator sees every lead");
    assert.equal(row?.unassigned, true);
    assert.equal(row?.responsible, "Unassigned");
    assert.equal(row?.source, "Website / Online Enquiry", "the configured label, from the stored code");
    assert.equal((await callingDesk(DAY, "unassigned")).rows.some((l) => l.id === leadId), true);
    assert.equal((await deskLeadRecord(leadId, DAY))?.unassigned, true);

    const told = await db.select().from(notifications).where(eq(notifications.userId, boss.id));
    assert.equal(told.length, 1, "whoever can assign it is told it is waiting");
    assert.equal(told[0].href, `/crm/leads/calling-desk/${leadId}`);
    const toCreator = await db.select().from(notifications).where(eq(notifications.userId, telecaller.id));
    assert.equal(toCreator.length, 0, "nobody is told what they just did");
  });

  test("the administrator assigns it to the telecaller, who can then see it, open it and work it", async () => {
    const enquiryId = await makeEnquiry("DISTRIBUTOR");
    const r = await createLead(enquiryId);
    assert.ok(r.ok);
    const leadId = r.data.customerId;

    setTestUser(boss);
    const assigned = await assignDeskLead({ customerId: leadId, ownerId: telecaller.id });
    assert.ok(assigned.ok, assigned.ok ? "" : assigned.error);
    assert.equal((await db.select().from(customers).where(eq(customers.id, leadId)))[0].ownerId, telecaller.id);

    setTestUser(telecaller);
    const desk = await callingDesk(DAY, "all");
    const row = desk.all.find((l) => l.id === leadId);
    assert.ok(row, "assigned, the lead is on her desk");
    assert.equal(row?.unassigned, false);
    assert.equal(row?.phase, "call1");
    assert.equal(row?.stage, "suspect");
    const rec = await deskLeadRecord(leadId, DAY);
    assert.ok(rec, "the V6 record opens for her");
    assert.equal(rec?.ownerName, "Telecaller A");

    const call = await logQualificationCall({
      customerId: leadId,
      outcome: "spoke_callback",
      answers: { monthlyLitres: 150 },
      next: { kind: "call", text: "the rest", date: "2026-12-01" },
    });
    assert.ok(call.ok, call.ok ? "" : call.error);

    const told = await db.select().from(notifications).where(eq(notifications.userId, telecaller.id));
    assert.ok(told.some((n) => n.href === `/crm/leads/calling-desk/${leadId}`), "she is told a lead has landed on her desk");
  });

  test("a lead can only be handed to somebody who holds the desk, and only by somebody who may hand work out", async () => {
    const enquiryId = await makeEnquiry("QUOTE");
    const r = await createLead(enquiryId);
    assert.ok(r.ok);
    const leadId = r.data.customerId;

    setTestUser(boss);
    const toOutsider = await assignDeskLead({ customerId: leadId, ownerId: crmOnly.id });
    assert.equal(toOutsider.ok, false, "a desk nobody can open would swallow it");
    assert.equal(!toOutsider.ok && toOutsider.code, "rule_violation");
    assert.equal((await db.select().from(customers).where(eq(customers.id, leadId)))[0].ownerId, null);

    setTestUser(telecaller);
    const byAssociate = await assignDeskLead({ customerId: leadId, ownerId: telecaller.id });
    assert.equal(byAssociate.ok, false, "an associate cannot give a lead to herself or anybody");
  });

  test("the list of who can be given a lead is exactly the people who hold the desk", async () => {
    assert.deepEqual((await deskHolders()).map((p) => p.name).sort(), ["Office Administrator", "Telecaller A"]);
    assert.deepEqual((await deskAssigners()).map((p) => p.name), ["Office Administrator"]);
  });

  test("the Create lead dialog offers an owner only to somebody who may assign", async () => {
    const enquiryId = await makeEnquiry("QUOTE");
    const mineCtx = await leadFromEnquiryContextAction(enquiryId);
    assert.ok(mineCtx.ok);
    assert.equal(mineCtx.data.canAssign, false);
    assert.deepEqual(mineCtx.data.assignees, []);

    setTestUser(boss);
    const bossCtx = await leadFromEnquiryContextAction(enquiryId);
    assert.ok(bossCtx.ok);
    assert.equal(bossCtx.data.canAssign, true);
    assert.ok(bossCtx.data.assignees.some((p) => p.id === telecaller.id));

    const r = await createLead(enquiryId, { ownerId: telecaller.id });
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.doesNotMatch(r.message ?? "", /no owner yet/i);
    setTestUser(telecaller);
    assert.ok((await callingDesk(DAY, "all")).all.some((l) => l.id === r.data.customerId), "created already assigned, it is on her desk at once");
  });
});

/* ------------------------------------------------------------------------ D */

describe("D — the desk is granted, not inherited", () => {
  test("the telecaller and the administrator hold it; a CRM user narrowed to other screens does not", async () => {
    assert.equal(await canOpenModule(telecaller.id, DESK_MODULE), true);
    assert.equal(await canOpenModule(boss.id, DESK_MODULE), true);
    assert.equal(await canOpenModule(crmOnly.id, DESK_MODULE), false);
    assert.equal(await canOpenModule(manager.id, DESK_MODULE), false);
  });

  test("the desk's writes refuse somebody without it, though they hold lead.work like every CRM associate", async () => {
    const enquiryId = await makeEnquiry("QUOTE");
    const made = await createLead(enquiryId, { ownerId: null });
    assert.ok(made.ok);
    const leadId = made.data.customerId;
    await db.update(customers).set({ ownerId: crmOnly.id }).where(eq(customers.id, leadId));

    setTestUser(crmOnly);
    const r = await logQualificationCall({ customerId: leadId, outcome: "no_answer", answers: {}, noAnswerReason: "busy" });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.code, "not_permitted");
    assert.match(!r.ok ? r.error : "", /Calling desk/);
  });

  test("the module is off by default, so the Access screen does not tick it along with the whole CRM", () => {
    const mod = modulesForApp("crm").find((m) => m.key === DESK_MODULE);
    assert.equal(mod?.offByDefault, true);
    assert.equal(modulesForApp("sales").some((m) => m.key.endsWith("calling-desk")), false);
    assert.equal(modulesForApp("crm").filter((m) => m.offByDefault).length, 1, "the flag is for this one module and no other");
  });

  describe("the migration that keeps existing CRM users from receiving it", () => {
    const file = readdirSync("drizzle").find((f) => f.startsWith("0170_"))!;
    const text = readFileSync(`drizzle/${file}`, "utf8");
    const run = () => db.execute(sql.raw(text));

    test("a whole-CRM account keeps every screen it had, minus the desk, and the administrator is left whole", async () => {
      const wholeAssociate = await makeUser("Whole App Associate", "associate", ["crm"]);
      const wholeManager = await makeUser("Whole App Manager", "manager", ["crm"]);
      const before = modulesForApp("crm").map((m) => m.key);
      assert.equal(await canOpenModule(wholeAssociate.id, DESK_MODULE), true, "before: the whole app includes the new module");

      await run();

      for (const u of [wholeAssociate, wholeManager]) {
        const held = (await db.select().from(appModuleAccess).where(and(eq(appModuleAccess.userId, u.id), eq(appModuleAccess.app, "crm"))))
          .map((r) => r.module)
          .sort();
        assert.deepEqual(held, before.filter((k) => k !== DESK_MODULE).sort(), "every screen they had, and not the desk");
        assert.equal(await canOpenModule(u.id, DESK_MODULE), false);
        assert.equal(await canOpenModule(u.id, "crm.leads"), true, "nothing they could open was taken away");
        assert.equal(await canOpenModule(u.id, "crm.settings"), true);
      }

      const bossRows = await db.select().from(appModuleAccess).where(eq(appModuleAccess.userId, boss.id));
      assert.equal(bossRows.length, 0, "an administrator's whole-app grant is left alone");
      assert.equal(await canOpenModule(boss.id, DESK_MODULE), true);
    });

    test("somebody already narrowed is untouched, and running it twice changes nothing", async () => {
      const wholeAssociate = await makeUser("Whole App Associate", "associate", ["crm"]);
      const beforeNarrow = await db.select().from(appModuleAccess).where(eq(appModuleAccess.userId, telecaller.id));
      await run();
      const once = await db.select().from(appModuleAccess);
      await run();
      const twice = await db.select().from(appModuleAccess);
      assert.equal(twice.length, once.length, "idempotent");
      const afterNarrow = await db.select().from(appModuleAccess).where(eq(appModuleAccess.userId, telecaller.id));
      assert.equal(afterNarrow.length, beforeNarrow.length, "a narrowed grant is not rewritten");
      assert.equal(await canOpenModule(telecaller.id, DESK_MODULE), true, "and the telecaller keeps the desk she was given");
      assert.equal(await canOpenModule(wholeAssociate.id, DESK_MODULE), false);
    });

    test("every module the migration names is a real CRM module, so a rename cannot leave a dead key behind", () => {
      const named = [...text.matchAll(/\('(crm\.[a-z-]+)'\)/g)].map((m) => m[1]);
      const real = new Set(modulesForApp("crm").map((m) => m.key));
      assert.ok(named.length >= 20);
      for (const k of named) assert.ok(real.has(k), `${k} is in the migration and not in the registry`);
      assert.ok(!named.includes(DESK_MODULE), "the desk is exactly what it leaves out");
    });
  });
});
