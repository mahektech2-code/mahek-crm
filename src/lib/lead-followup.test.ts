/**
 * FOLLOW-UP INSIDE THE CALL FORM — focused checks. Clicking an option opens the
 * lead's WhatsApp conversation (the screen) and records "WhatsApp opened"; the
 * action under test is that record. Real services against a scratch
 * `mahekone_test*` database.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, appModuleAccess, auditLog, calls, customers, mbosDocuments, timelineEvents, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { captureLead } from "@/lib/actions/lead-intake";
import { logQualificationCall } from "@/lib/actions/lead-calling-desk";
import { recordLeadFollowUp } from "@/lib/actions/lead-followup";
import { COMMUNICATION_ACTIONS } from "@/lib/lead-labels";
import { CRM_EVENT } from "@/lib/timeline";
import { DESK_MODULE } from "@/lib/services/lead-desk-assignment-service";
import { FOLLOWUP_MATERIALS, followUpSentence, whatsappHref } from "@/lib/lead-followup";
import { testPhone } from "@/lib/test-phone";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const key = () => randomUUID().replaceAll("-", "").slice(0, 20);

async function makeUser(name: string, modules: string[]) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 4)}@test.local`,
      phone: testPhone(),
      passwordHash: "x",
      role: "associate",
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "crm", role: "associate" });
  for (const m of modules) await db.insert(appModuleAccess).values({ id: id("mod"), userId: row.id, app: "crm", module: m });
  return row;
}

let tele: typeof users.$inferSelect;
let outsider: typeof users.$inferSelect;
let leadId: string;

async function publish(category: "marketing" | "catalogue" | "price_list", title: string) {
  await db.insert(mbosDocuments).values({ id: id("doc"), title, category, active: true });
}
const events = () =>
  db.select().from(timelineEvents).where(and(eq(timelineEvents.customerId, leadId), eq(timelineEvents.eventType, CRM_EVENT.followUp)));
const qualCalls = () => db.select().from(calls).where(sql`${calls.customerId} = ${leadId} and ${calls.outcomeDetail}->>'qualCall' is not null`);

before(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Integration tests must run against a mahekone_test* database.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table
      mbos_documents, mbos_visits, reminders, lead_stage_transitions, mbos_tasks, calls, notifications,
      timeline_events, audit_log, orders, app_secrets, app_module_access, app_access, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  tele = await makeUser("Telecaller T", ["crm.dashboard", "crm.leads", DESK_MODULE]);
  outsider = await makeUser("Outsider O", ["crm.dashboard", "crm.leads"]);
  setTestUser(tele);
  const r = await captureLead({ salesType: "direct", name: "Follow Lead", phone: testPhone(), city: "Nashik", source: "telecalling" });
  assert.ok(r.ok, r.ok ? "" : r.error);
  leadId = r.data.customerId;
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("the vocabulary", () => {
  test("the three materials are the Reach-out actions' own codes and categories", () => {
    for (const m of FOLLOWUP_MATERIALS) {
      const a = COMMUNICATION_ACTIONS.find((x) => x.code === m.code);
      assert.ok(a, `${m.code} is a Communication action`);
      assert.equal(a.document, m.category, `${m.code} resolves to the same library category`);
    }
  });

  test("no sentence ever claims it was sent", () => {
    for (const m of FOLLOWUP_MATERIALS) {
      for (const status of ["requested", "whatsapp_opened"] as const) {
        for (const title of ["Doc", null]) {
          const s = followUpSentence(m.code, title, status, 2);
          assert.match(s, /not (yet )?sent|not confirmed/, s);
          assert.doesNotMatch(s, /\b(was|has been|were) sent\b|\bdelivered\b/i, s);
        }
      }
    }
  });

  test("the WhatsApp link is this lead's own conversation", () => {
    assert.equal(whatsappHref("cus_abc 1"), "/crm/whatsapp?customer=cus_abc%201");
  });
});

describe("choosing an option records that WhatsApp was opened", () => {
  test("who, when, which option and the status — and nothing is a call, an answer or a stage move", async () => {
    await publish("catalogue", "Mahek Brochure 2026");
    const before = (await db.select().from(customers).where(eq(customers.id, leadId)))[0];
    const r = await recordLeadFollowUp({ customerId: leadId, materials: ["brochure"], clientKey: key() });
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.equal(r.ok && r.data.status, "whatsapp_opened");

    const [e] = await events();
    assert.equal(e.actorUserId, tele.id, "the user");
    assert.ok(Math.abs(e.occurredAt.getTime() - Date.now()) < 60_000, "the time");
    assert.match(e.summary, /Follow-up initiated: Brochure “Mahek Brochure 2026” — WhatsApp opened, send not confirmed/);
    assert.doesNotMatch(e.summary, /\bsent\b(?! not)/i, "it never says sent");

    assert.equal((await db.select().from(calls).where(eq(calls.customerId, leadId))).length, 0, "no calls row at all");
    assert.equal((await qualCalls()).length, 0, "never counted as Call 1/2/3");
    const after = (await db.select().from(customers).where(eq(customers.id, leadId)))[0];
    assert.equal(after.leadStage, before.leadStage, "the stage is untouched");
    assert.equal(after.ownerId, before.ownerId);
    assert.equal(after.leadMonthlyVolumeLitres, before.leadMonthlyVolumeLitres, "no qualification answer was filled in");
    const [aud] = await db.select().from(auditLog).where(eq(auditLog.action, "lead.followup.request"));
    assert.equal(aud.entityId, leadId);
    assert.equal(aud.actorId, tele.id);
  });

  test("each of the three options is its own entry", async () => {
    for (const code of ["product_image", "brochure", "price_list"] as const) {
      assert.ok((await recordLeadFollowUp({ customerId: leadId, materials: [code], clientKey: key() })).ok);
    }
    const summaries = (await events()).map((e) => e.summary).join(" | ");
    assert.match(summaries, /Product image/);
    assert.match(summaries, /Brochure/);
    assert.match(summaries, /Price list/);
  });

  test("no published file is needed — the person composes the message in WhatsApp", async () => {
    const r = await recordLeadFollowUp({ customerId: leadId, materials: ["price_list"], clientKey: key() });
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.match((await events())[0].summary, /Follow-up initiated: Price list — WhatsApp opened/);
  });

  test("a withdrawn document is not named", async () => {
    await publish("catalogue", "Old Brochure");
    await db.update(mbosDocuments).set({ active: false });
    assert.ok((await recordLeadFollowUp({ customerId: leadId, materials: ["brochure"], clientKey: key() })).ok);
    assert.doesNotMatch((await events())[0].summary, /Old Brochure/);
  });

  test("a retried click is recorded once", async () => {
    const k = key();
    assert.ok((await recordLeadFollowUp({ customerId: leadId, materials: ["brochure"], clientKey: k })).ok);
    assert.ok((await recordLeadFollowUp({ customerId: leadId, materials: ["brochure"], clientKey: k })).ok);
    assert.equal((await events()).length, 1);
    assert.equal((await db.select().from(auditLog).where(eq(auditLog.action, "lead.followup.request"))).length, 1);
  });

  test("nothing chosen is refused", async () => {
    assert.equal((await recordLeadFollowUp({ customerId: leadId, materials: [], clientKey: key() })).ok, false);
  });
});

describe("alongside a call", () => {
  test("the call is saved exactly as before and the follow-up is a separate record", async () => {
    const call = await logQualificationCall({
      customerId: leadId,
      outcome: "spoke_callback",
      answers: {},
      notes: "Wants the brochure on WhatsApp",
      next: { kind: "call", text: "x", date: "2099-01-01" },
    });
    assert.ok(call.ok, call.ok ? "" : call.error);
    assert.ok((await recordLeadFollowUp({ customerId: leadId, materials: ["brochure"], clientKey: key() })).ok);
    assert.equal((await qualCalls()).length, 1, "exactly one call, the real one");
    assert.equal((await events()).length, 1);
  });
});

describe("who may", () => {
  test("a user whose scope does not contain the lead cannot record anything for it", async () => {
    setTestUser(outsider);
    const r = await recordLeadFollowUp({ customerId: leadId, materials: ["brochure"], clientKey: key() });
    assert.equal(r.ok, false);
    assert.equal((await events()).length, 0);
  });
});
