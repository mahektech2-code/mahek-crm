/**
 * Website Enquiries — the desk's edits and removals, against a real database.
 *
 *   NODE_ENV=test DATABASE_URL=<…mahekone_test…> npx tsx --conditions=react-server --test src/lib/enquiry-edits.test.ts
 *
 * Each new action is proved three ways: refused to somebody without the
 * grant, refused without the impact confirmation where it takes something
 * away, and the write itself — the row, the activity a person reads and the
 * audit row.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, auditLog, customers, enquiries, enquiryActivity, reminders, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { addDays } from "@/lib/format";
import { impactReport } from "@/lib/impact/registry";
import type { ImpactConfirmation } from "@/lib/impact/types";
import {
  addNote,
  createEnquiryFromWebsite,
  createEnquiryReminder,
  enquiryDashboardCounts,
  getEnquiry,
  linkCustomer,
  listEnquiries,
} from "@/lib/services/enquiry-service";
import {
  cancelEnquiryReminderAction,
  changeStageAction,
  correctEnquiryDetailsAction,
  createManualEnquiryAction,
  deleteEnquiryNoteAction,
  editEnquiryNoteAction,
  markEnquirySpamAction,
  deleteEnquiryAction,
  rescheduleEnquiryReminderAction,
} from "@/lib/actions/enquiries";
import { testPhone } from "@/lib/test-phone";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

async function makeUser(name: string, role: "associate" | "manager" | "admin", apps: Array<"enquiries" | "crm">) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\s+/g, ".")}@test.local`,
      phone: testPhone(),
      passwordHash: "x",
      role,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  for (const app of apps) await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app, role });
  return row;
}

async function websiteEnquiry(submission: Record<string, unknown> = { first_name: "Rames", last_name: "Patil", mobile: "+91 98200 11001", enquiry: "Need 20L drums" }) {
  const r = await createEnquiryFromWebsite({ sourceForm: "QUOTE", externalRef: randomUUID(), receivedAt: new Date(), submission });
  return r.id;
}

async function confirmationFor(kind: string, recordId: string): Promise<ImpactConfirmation> {
  const report = await impactReport(kind, recordId);
  assert.ok(report.ok, report.ok ? "" : report.error);
  return { typed: report.data.confirmWord, fingerprint: report.data.fingerprint };
}

async function audits(action: string) {
  return db.select().from(auditLog).where(eq(auditLog.action, action));
}

async function activityOf(enquiryId: string, kind: string) {
  return db
    .select()
    .from(enquiryActivity)
    .where(and(eq(enquiryActivity.enquiryId, enquiryId), eq(enquiryActivity.kind, kind)));
}

let desk: typeof users.$inferSelect;
let outsider: typeof users.$inferSelect;

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Integration tests must run against a mahekone_test database.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table enquiry_deletions, enquiry_orders, enquiry_activity, enquiries, reminders, audit_log,
      orders, app_access, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  desk = await makeUser("Enquiry Desk", "associate", ["enquiries"]);
  outsider = await makeUser("Crm Only", "associate", ["crm"]);
  setTestUser(desk);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

/* ------------------------------------------------------------ new enquiry */

describe("an enquiry entered by hand", () => {
  test("is refused to somebody without Website Enquiries", async () => {
    setTestUser(outsider);
    const r = await createManualEnquiryAction({ name: "Walk In", phone: "9820011005", source: "manual" });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.code, "not_permitted");
    assert.equal((await db.select().from(enquiries)).length, 0);
  });

  test("cannot claim the website, and needs a way to reply", async () => {
    const web = await createManualEnquiryAction({ name: "Walk In", phone: "9820011005", source: "website" });
    assert.equal(web.ok, false);
    const none = await createManualEnquiryAction({ name: "Walk In", source: "manual" });
    assert.equal(none.ok, false);
    const bad = await createManualEnquiryAction({ name: "Walk In", phone: "12345", source: "manual" });
    assert.equal(bad.ok, false);
  });

  test("is written with its author, its activity and an audit row, and reads like any other", async () => {
    const r = await createManualEnquiryAction({
      name: "Walk In",
      phone: "+91 98200 11005",
      company: "Shree Paints",
      requirement: "50 L primer",
      source: "indiamart",
      priority: "high",
    });
    assert.ok(r.ok);
    const [row] = await db.select().from(enquiries).where(eq(enquiries.id, r.data.id));
    assert.equal(row.source, "indiamart");
    assert.equal(row.createdById, desk.id);
    assert.equal(row.priority, "high");
    assert.deepEqual(row.rawSubmission, { name: "Walk In", phone: "9820011005", company: "Shree Paints", message: "50 L primer" });
    assert.ok(row.searchText.includes("Shree Paints"));
    assert.equal((await activityOf(r.data.id, "created")).length, 1);
    assert.equal((await audits("enquiry.create")).length, 1);
  });
});

/* ----------------------------------------------------------- corrections */

describe("correcting the submitted details", () => {
  test("is refused without the grant", async () => {
    const enquiryId = await websiteEnquiry();
    setTestUser(outsider);
    const r = await correctEnquiryDetailsAction(enquiryId, { name: "Ramesh Patil" });
    assert.equal(!r.ok && r.code, "not_permitted");
  });

  test("reads over the raw submission, which stays exactly as sent, and keeps the before in the activity", async () => {
    const enquiryId = await websiteEnquiry();
    const r = await correctEnquiryDetailsAction(enquiryId, { name: "Ramesh Patil", phone: "98200 11002", message: "Need 40L drums" });
    assert.ok(r.ok, !r.ok ? r.error : "");

    const [row] = await db.select().from(enquiries).where(eq(enquiries.id, enquiryId));
    assert.equal((row.rawSubmission as Record<string, string>).first_name, "Rames", "the raw is never rewritten");
    assert.deepEqual(row.corrections, { name: "Ramesh Patil", phone: "9820011002", message: "Need 40L drums" });

    const detail = await getEnquiry(enquiryId);
    assert.equal(detail?.submission.name, "Ramesh Patil");
    assert.deepEqual(detail?.corrected.sort(), ["message", "name", "phone"]);

    const [act] = await activityOf(enquiryId, "details_corrected");
    const meta = act.meta as { before: Record<string, string>; after: Record<string, string> };
    assert.equal(meta.before.name, "Rames Patil");
    assert.equal(meta.after.name, "Ramesh Patil");
    assert.equal((await audits("enquiry.correct")).length, 1);

    /* the list and search read the correction */
    const found = await listEnquiries({ q: "Ramesh" });
    assert.equal(found.items[0]?.name, "Ramesh Patil");
  });

  test("a correction that changes nothing writes nothing, and a name cannot be emptied", async () => {
    const enquiryId = await websiteEnquiry({ name: "Same", phone: "9820011001" });
    const same = await correctEnquiryDetailsAction(enquiryId, { name: "Same", phone: "+91 9820011001" });
    assert.ok(same.ok);
    assert.equal((await activityOf(enquiryId, "details_corrected")).length, 0);
    const empty = await correctEnquiryDetailsAction(enquiryId, { name: "  " });
    assert.equal(empty.ok, false);
  });
});

/* ------------------------------------------------------------------ notes */

describe("a note", () => {
  async function noteBy(enquiryId: string) {
    await addNote(enquiryId, "Called, no answer");
    const [n] = await activityOf(enquiryId, "note");
    return n.id;
  }

  test("is edited only by its author, and the edit keeps what it said before", async () => {
    const enquiryId = await websiteEnquiry();
    const noteId = await noteBy(enquiryId);

    const other = await makeUser("Other Desk", "associate", ["enquiries"]);
    setTestUser(other);
    const refused = await editEnquiryNoteAction(enquiryId, noteId, "rewritten");
    assert.equal(!refused.ok && refused.code, "not_permitted");

    setTestUser(desk);
    const r = await editEnquiryNoteAction(enquiryId, noteId, "Called twice, no answer");
    assert.ok(r.ok);
    const [row] = await db.select().from(enquiryActivity).where(eq(enquiryActivity.id, noteId));
    assert.equal(row.kind, "note_edited");
    assert.equal(row.note, "Called twice, no answer");
    assert.equal((row.meta as { edits: Array<{ previous: string }> }).edits[0].previous, "Called, no answer");
    assert.equal((await audits("enquiry.note.edit")).length, 1);
  });

  test("is deleted only with the impact confirmation, only by its author, and leaves its place in the story", async () => {
    const enquiryId = await websiteEnquiry();
    const noteId = await noteBy(enquiryId);

    const bare = await deleteEnquiryNoteAction(enquiryId, noteId);
    assert.equal(bare.ok, false, "refused without a confirmation");

    const other = await makeUser("Other Desk", "associate", ["enquiries"]);
    setTestUser(other);
    const confirmation = await confirmationFor("enquiry-note-delete", noteId);
    const notAuthor = await deleteEnquiryNoteAction(enquiryId, noteId, confirmation);
    assert.equal(!notAuthor.ok && notAuthor.code, "not_permitted");

    setTestUser(desk);
    const r = await deleteEnquiryNoteAction(enquiryId, noteId, confirmation);
    assert.ok(r.ok, !r.ok ? r.error : "");
    const [row] = await db.select().from(enquiryActivity).where(eq(enquiryActivity.id, noteId));
    assert.equal(row.kind, "note_deleted");
    assert.equal(row.note, null);
    const [a] = await audits("enquiry.note.delete");
    assert.equal((a.beforeState as { note: string }).note, "Called, no answer");
  });
});

/* -------------------------------------------------------------- follow-ups */

describe("an enquiry's follow-up", () => {
  async function withReminder() {
    const owner = await makeUser("Crm Owner", "associate", ["crm"]);
    const [customer] = await db
      .insert(customers)
      .values({ id: id("cus"), name: "Patil Traders", contactPerson: "Ramesh", phone: testPhone(), city: "Pune", ownerId: owner.id, salesAmId: owner.id })
      .returning();
    const enquiryId = await websiteEnquiry();
    assert.ok((await linkCustomer(enquiryId, customer.id)).ok);
    const due = addDays(new Date().toISOString().slice(0, 10), 3);
    const made = await createEnquiryReminder({ enquiryId, dueDate: due, note: "Send rates", type: "call_back", assignedUserId: desk.id });
    assert.ok(made.ok, !made.ok ? made.error : "");
    const [rem] = await db.select().from(reminders).where(eq(reminders.enquiryId, enquiryId));
    return { enquiryId, reminderId: rem.id, due: rem.dueDate };
  }

  test("is moved by the desk without a CRM book, with activity and audit", async () => {
    const { enquiryId, reminderId, due } = await withReminder();
    setTestUser(outsider);
    const refused = await rescheduleEnquiryReminderAction(enquiryId, reminderId, addDays(due, 7));
    assert.equal(!refused.ok && refused.code, "not_permitted");

    /* somebody else on the desk — neither its creator nor its assignee, and no CRM scope */
    const colleague = await makeUser("Colleague", "associate", ["enquiries"]);
    setTestUser(colleague);
    const r = await rescheduleEnquiryReminderAction(enquiryId, reminderId, addDays(due, 7));
    assert.ok(r.ok, !r.ok ? r.error : "");
    const [rem] = await db.select().from(reminders).where(eq(reminders.id, reminderId));
    assert.ok(rem.dueDate >= addDays(due, 7));
    assert.equal(rem.rescheduleCount, 1);
    assert.equal((await activityOf(enquiryId, "reminder_rescheduled")).length, 1);
    assert.equal((await audits("enquiry.reminder.reschedule")).length, 1);
  });

  test("is cancelled only with a reason, reminder.close and the impact confirmation", async () => {
    const { enquiryId, reminderId } = await withReminder();

    const noReason = await cancelEnquiryReminderAction(enquiryId, reminderId, "  ");
    assert.equal(noReason.ok, false);

    /* the desk associate does not hold reminder.close */
    const noPower = await cancelEnquiryReminderAction(enquiryId, reminderId, "Customer bought elsewhere");
    assert.equal(noPower.ok, false);
    assert.equal(!noPower.ok && noPower.code, "not_permitted");

    const manager = await makeUser("Enquiries Manager", "manager", ["enquiries"]);
    setTestUser(manager);
    const bare = await cancelEnquiryReminderAction(enquiryId, reminderId, "Customer bought elsewhere");
    assert.equal(bare.ok, false, "refused without a confirmation");

    const confirmation = await confirmationFor("enquiry-reminder-cancel", reminderId);
    const r = await cancelEnquiryReminderAction(enquiryId, reminderId, "Customer bought elsewhere", confirmation);
    assert.ok(r.ok, !r.ok ? r.error : "");
    const [rem] = await db.select().from(reminders).where(eq(reminders.id, reminderId));
    assert.equal(rem.status, "dismissed");
    assert.equal(rem.dismissReason, "Customer bought elsewhere");
    assert.equal((await activityOf(enquiryId, "reminder_cancelled")).length, 1);
    assert.equal((await audits("reminder.dismiss")).length, 1);

    const again = await rescheduleEnquiryReminderAction(enquiryId, reminderId, addDays(rem.dueDate, 2));
    assert.equal(!again.ok && again.code, "conflict", "a closed follow-up is not moved");
  });
});

/* ------------------------------------------------------------------- spam */

describe("marking an enquiry as spam", () => {
  test("is refused without the grant and without the confirmation", async () => {
    const enquiryId = await websiteEnquiry();
    setTestUser(outsider);
    const noGrant = await markEnquirySpamAction(enquiryId, "bot");
    assert.equal(!noGrant.ok && noGrant.code, "not_permitted");
    setTestUser(desk);
    const bare = await markEnquirySpamAction(enquiryId, "bot");
    assert.equal(bare.ok, false);
    const [row] = await db.select().from(enquiries).where(eq(enquiries.id, enquiryId));
    assert.equal(row.stage, "new");
  });

  test("is a stage: off the list and the counts, back with any other stage, and never picked from the dropdown", async () => {
    const enquiryId = await websiteEnquiry();
    await websiteEnquiry({ name: "Real One", phone: "9820011009" });

    const r = await markEnquirySpamAction(enquiryId, "SEO pitch", await confirmationFor("enquiry-spam", enquiryId));
    assert.ok(r.ok, !r.ok ? r.error : "");
    assert.equal((await audits("enquiry.spam")).length, 1);
    assert.equal((await activityOf(enquiryId, "marked_spam")).length, 1);

    const all = await listEnquiries({});
    assert.ok(!all.items.some((i) => i.id === enquiryId), "spam is not in All");
    const spam = await listEnquiries({ stage: "spam" });
    assert.deepEqual(spam.items.map((i) => i.id), [enquiryId]);
    const counts = await enquiryDashboardCounts();
    assert.equal(counts.total, 1);
    assert.equal(counts.byStage.spam, 1);
    assert.equal(counts.unassigned, 1);

    const picked = await changeStageAction(enquiryId, "spam");
    assert.equal(picked.ok, false, "spam is not a stage anybody picks");

    const back = await changeStageAction(enquiryId, "new");
    assert.ok(back.ok);
    assert.equal((await activityOf(enquiryId, "unmarked_spam")).length, 1);
    assert.equal((await audits("enquiry.unspam")).length, 1);
  });

  test("is blocked once a customer is linked", async () => {
    const owner = await makeUser("Crm Owner", "associate", ["crm"]);
    const [customer] = await db
      .insert(customers)
      .values({ id: id("cus"), name: "Patil Traders", contactPerson: "Ramesh", phone: testPhone(), city: "Pune", ownerId: owner.id, salesAmId: owner.id })
      .returning();
    const enquiryId = await websiteEnquiry();
    await linkCustomer(enquiryId, customer.id);
    const report = await impactReport("enquiry-spam", enquiryId);
    assert.ok(report.ok && report.data.blockers.length === 1);
    const r = await markEnquirySpamAction(enquiryId, "x", { typed: report.ok ? report.data.confirmWord : "", fingerprint: report.ok ? report.data.fingerprint : "" });
    assert.equal(!r.ok && r.code, "rule_violation");
  });
});

describe("deleting an enquiry", () => {
  test("is a manager's, asks first, and a resend of the same submission does not bring it back", async () => {
    const ref = randomUUID();
    const sent = { sourceForm: "QUOTE", externalRef: ref, receivedAt: new Date(), submission: { first_name: "Junk", last_name: "Bot", mobile: "+91 98200 11009", enquiry: "buy crypto" } };
    const { id: enquiryId } = await createEnquiryFromWebsite(sent);
    await createEnquiryReminder({ enquiryId, dueDate: addDays(new Date().toISOString().slice(0, 10), 2), note: "Call", type: "call_back", assignedUserId: desk.id });

    setTestUser(desk);
    const confirmation = await confirmationFor("enquiry-delete", enquiryId);
    const associate = await deleteEnquiryAction(enquiryId, "junk", confirmation);
    assert.equal(associate.ok, false, "an associate cannot delete");

    const manager = await makeUser("Enquiries Boss", "manager", ["enquiries"]);
    setTestUser(manager);
    assert.equal((await deleteEnquiryAction(enquiryId, "junk")).ok, false, "refused without the confirmation");
    const r = await deleteEnquiryAction(enquiryId, "junk", await confirmationFor("enquiry-delete", enquiryId));
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.equal((await db.select().from(enquiries).where(eq(enquiries.id, enquiryId))).length, 0);
    assert.equal((await db.select().from(reminders).where(eq(reminders.enquiryId, enquiryId))).length, 0, "its follow-ups go, not orphaned");
    assert.equal((await audits("enquiry.delete")).length, 1);

    const again = await createEnquiryFromWebsite(sent);
    assert.equal(again.duplicate, true, "the website resending it is acknowledged");
    assert.equal((await db.select().from(enquiries)).length, 0, "and nothing is stored again");
  });

  test("is refused while a customer is linked", async () => {
    const enquiryId = await websiteEnquiry();
    const [customer] = await db.insert(customers).values({ id: id("cus"), name: "Real Shop", kind: "customer", phone: testPhone(), city: "Pune" } as never).returning();
    assert.ok((await linkCustomer(enquiryId, customer.id)).ok);
    const manager = await makeUser("Enquiries Head", "manager", ["enquiries"]);
    setTestUser(manager);
    const report = await impactReport("enquiry-delete", enquiryId);
    assert.ok(report.ok && report.data.blockers.length > 0);
    const r = await deleteEnquiryAction(enquiryId, "x", { typed: report.ok ? report.data.confirmWord : "", fingerprint: report.ok ? report.data.fingerprint : "" });
    assert.equal(r.ok, false);
  });
});
