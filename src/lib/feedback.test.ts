/**
 * Feedback, end to end: reported, answered, answered back, decided.
 *
 *   npm run test:integration
 *
 * What these pin is the part that used to be a single overwritable cell. A
 * report is a conversation between two people who work here, and the failures
 * worth guarding are the quiet ones: a reply that erases the previous one, a
 * screenshot nobody can open, one side seeing a shorter version of the thread
 * than the other, and a report readable by somebody it was not written to.
 *
 * They need mahekone_test, which `npm run test:db` creates from the committed
 * migrations. The harness truncates between tests.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, notifications, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import {
  answerFix,
  assignFeedback,
  markFeedbackRead,
  mergeFeedback,
  myFeedbackSummary,
  replyToFeedback,
  setFeedbackStatus,
  submitFeedback,
} from "@/lib/actions/feedback";
import {
  feedbackCounts,
  feedbackOverview,
  listFeedback,
  listMyFeedback,
  similarFeedback,
  unreadFeedbackReplies,
} from "@/lib/services/feedback-service";
import { canRead } from "@/lib/services/attachment-service";
import { testPhone } from "@/lib/test-phone";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let manager: typeof users.$inferSelect;
let priya: typeof users.$inferSelect;
let deepa: typeof users.$inferSelect;

async function makeUser(name: string, role: "associate" | "manager", app: "crm" | "accounts" = "crm") {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase()}@test.local`,
      phone: testPhone(),
      passwordHash: "x",
      role,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  /*
   * THE APP GRANT, because a level on its own is not one.
   *
   * A capability hangs on (app, level) now, so `role: "manager"` with no
   * `app_access` row is a manager of nothing — which is right, and is what
   * production looks like too: an app's layout refuses anybody without a
   * grant, so a person who can reach a screen always has one. A fixture
   * without it was testing somebody who cannot sign in.
   *
   * The CRM by default, because that is the book these tests work. The
   * ledger desk asks for `accounts` instead and holds NOTHING else — Deepa
   * is granted `apps: ["accounts"]` in the seed on purpose: "the person
   * deciding whether a customer may take more credit is not the person
   * chasing them for the next order".
   */
  await db.insert(appAccess).values({
    id: id("aca"),
    userId: row.id,
    app,
    role,
  });

  return row;
}

/**
 * The ledger desk, which is an APP GRANT and not a role any more.
 *
 * `role: "manager"` alone is a manager of nothing — the capabilities that make
 * somebody accounts (approving an order, confirming a payment, issuing a
 * credit note) hang on holding the Accounts app at manager level. A test that
 * set only the level would be testing a person who cannot do the job.
 */
async function makeAccountsUser(name: string) {
  return makeUser(name, "manager", "accounts");
}

/** A real 1×1 PNG: the type is sniffed from the bytes, never from the name. */
function png(filename = "screen.png") {
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  return new File([new Uint8Array(bytes)], filename, { type: "image/png" });
}

async function report(over: { title?: string; body?: string; images?: File[] } = {}) {
  const result = await submitFeedback({
    kind: "bug",
    title: over.title ?? "The call log shows a customer we dispatched to",
    body: over.body ?? "GMP took material on the 7th and they are still on my list.",
    path: "/crm/queue",
    images: over.images,
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  return result.ok ? result.data.id : "";
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
      audit_log, notifications, feedback_messages, feedback, attachments,
      app_access, sessions, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  manager = await makeUser("Vikram", "manager");
  priya = await makeUser("Priya", "associate");
  deepa = await makeAccountsUser("Deepa");
  setTestUser(priya);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("A report becomes a conversation", () => {
  test("both sides write to one thread, and both read the same one", async () => {
    const fb = await report();

    setTestUser(manager);
    const answered = await replyToFeedback({
      id: fb,
      body: "Found it — the hold releases on dispatch. Fixing this week.",
    });
    assert.equal(answered.ok, true);

    setTestUser(priya);
    const back = await replyToFeedback({ id: fb, body: "Two more customers the same." });
    assert.equal(back.ok, true);

    const mine = (await listMyFeedback(priya.id))[0];
    setTestUser(manager);
    const theirs = (await listFeedback())[0];

    // The whole point: one conversation, not a summary for the person who
    // started it. Somebody shown less than they were told stops reporting.
    assert.deepEqual(
      mine.messages.map((m) => m.body),
      theirs.messages.map((m) => m.body),
    );
    assert.equal(mine.messages.length, 2);
    assert.equal(mine.messages[0].fromSubmitter, false);
    assert.equal(mine.messages[1].fromSubmitter, true);
  });

  test("a second answer does not erase the first", async () => {
    const fb = await report();

    setTestUser(manager);
    await replyToFeedback({ id: fb, body: "Looking at it now." });
    await replyToFeedback({ id: fb, body: "Fixed — it goes out tonight." });

    const thread = (await listFeedback())[0];
    assert.deepEqual(
      thread.messages.filter((m) => m.body).map((m) => m.body),
      ["Looking at it now.", "Fixed — it goes out tonight."],
    );
  });

  test("a status change is a line of the thread, not a silent column", async () => {
    const fb = await report();

    setTestUser(manager);
    assert.equal((await setFeedbackStatus(fb, "declined")).ok, true);

    setTestUser(priya);
    const thread = (await listMyFeedback(priya.id))[0];
    const decision = thread.messages.at(-1)!;
    assert.equal(decision.statusTo, "declined");
    assert.equal(decision.body, null);
    assert.equal(decision.authorName, "Vikram");
    // Being told no is the message that matters most; it must reach them.
    const bell = await db
      .select()
      .from(notifications)
      .where(sql`${notifications.userId} = ${priya.id}`);
    assert.equal(bell.length, 1);
    assert.equal(bell[0].href, `/feedback?r=${fb}`);
    assert.equal(bell[0].kind, "warn");
  });
});

describe("Who is owed an answer", () => {
  test("a fresh report is waiting, an answer clears it, a question re-opens it", async () => {
    const fb = await report();
    assert.equal((await feedbackCounts()).awaitingReply, 1);

    setTestUser(manager);
    await replyToFeedback({ id: fb, body: "On it." });
    assert.equal((await feedbackCounts()).awaitingReply, 0);

    setTestUser(priya);
    await replyToFeedback({ id: fb, body: "Any idea when?" });
    assert.equal(
      (await feedbackCounts()).awaitingReply,
      1,
      "a question added to an answered thread is somebody waiting again",
    );

    // Closed threads are not work: a thank-you on a done report is not a debt.
    setTestUser(manager);
    await setFeedbackStatus(fb, "done");
    setTestUser(priya);
    await replyToFeedback({ id: fb, body: "Thank you." });
    assert.equal((await feedbackCounts()).awaitingReply, 0);
  });

  test("replies the submitter has not seen are counted, and reading clears them", async () => {
    const fb = await report();

    setTestUser(manager);
    await replyToFeedback({ id: fb, body: "Answered." });

    setTestUser(priya);
    const before = await myFeedbackSummary();
    assert.equal(before.ok && before.data.unreadReplies, 1);

    await markFeedbackRead();
    const after = await myFeedbackSummary();
    assert.equal(after.ok && after.data.unreadReplies, 0);
  });
});

describe("Screenshots", () => {
  test("a screenshot sent with a report is bound to it and readable by both sides", async () => {
    await report({ images: [png("queue.png")] });

    const thread = (await listMyFeedback(priya.id))[0];
    assert.equal(thread.attachments.length, 1);
    assert.equal(thread.attachments[0].filename, "queue.png");
    assert.equal(thread.attachments[0].isImage, true);

    const file = thread.attachments[0].id;
    assert.equal(await canRead(file), true, "the person who sent it");

    setTestUser(manager);
    assert.equal(await canRead(file), true, "the person answering it");

    // No customer sits behind a feedback attachment, so the customer-scope
    // path cannot answer this — and answering it wrongly either leaks the file
    // or 404s the owner, which is how attachments stayed write-only for months.
    /*
       A THIRD associate — neither the author nor anybody who may answer.
       Deepa used to stand here because she was `accounts` and therefore not a
       manager; she is a MANAGER of the Accounts app now and `canTriageFeedback`
       lets any manager in, so she reads it legitimately. The person who must
       not is a colleague with no part in the thread.
    */
    const bystander = await makeUser("Rakesh", "associate");
    setTestUser(bystander);
    assert.equal(await canRead(file), false, "somebody the report was not written to");
  });

  test("a screenshot on a reply hangs off that reply, not the report", async () => {
    const fb = await report();

    setTestUser(manager);
    await replyToFeedback({ id: fb, body: "Is this the screen?", images: [png("mine.png")] });

    const thread = (await listFeedback())[0];
    assert.equal(thread.attachments.length, 0);
    assert.equal(thread.messages[0].attachments.length, 1);
    assert.equal(thread.messages[0].attachments[0].filename, "mine.png");
  });

  test("a report is saved even when its screenshot is not a picture at all", async () => {
    const notAnImage = new File([new Uint8Array([1, 2, 3, 4])], "screen.png", {
      type: "image/png",
    });
    const reportId = await report({ images: [notAnImage] });

    // §4.2 — a save is never blocked by an attachment. The words survive.
    const thread = (await listMyFeedback(priya.id))[0];
    assert.equal(thread.id, reportId);
    assert.equal(thread.attachments.length, 0);
  });
});

describe("Who may answer, and who may look", () => {
  test("a telecaller cannot triage somebody else's report or read it", async () => {
    const fb = await report();

    /*
       A colleague, not Deepa and not the author. Deepa used to stand here
       because she was `accounts` and therefore not a manager; she is a
       MANAGER of the Accounts app now and any manager may triage. Priya
       cannot stand here either — she WROTE the report, and both sides of a
       thread reply through the same action.
    */
    const bystander = await makeUser("Rakesh", "associate");
    setTestUser(bystander);
    const status = await setFeedbackStatus(fb, "done");
    assert.equal(status.ok, false);
    assert.equal(status.ok === false && status.code, "not_permitted");

    const reply = await replyToFeedback({ id: fb, body: "Ignore this." });
    assert.equal(reply.ok, false);
    assert.equal(reply.ok === false && reply.code, "not_permitted");
  });

  test("whoever holds the Admin app may answer, without being a manager", async () => {
    const fb = await report();

    await db
      .insert(appAccess)
      .values({ id: id("acc"), userId: deepa.id, app: "admin", grantedById: manager.id });

    setTestUser(deepa);
    const reply = await replyToFeedback({ id: fb, body: "Taking this one." });
    assert.equal(reply.ok, true, reply.ok ? "" : reply.error);
  });

  test("an empty reply is refused rather than notifying somebody about nothing", async () => {
    const fb = await report();

    setTestUser(manager);
    const blank = await replyToFeedback({ id: fb, body: "   " });
    assert.equal(blank.ok, false);
    assert.equal((await listFeedback())[0].messages.length, 0);
  });
});

/* ------------------------------------------------------------------ v2 */

/** What reached somebody as a REPORTER — the links to their own threads. */
async function bellOf(userId: string) {
  return db
    .select()
    .from(notifications)
    .where(sql`${notifications.userId} = ${userId} and ${notifications.href} like '/feedback%'`);
}

describe("A report has a number, an impact and a heading of its own", () => {
  test("the first line becomes the title when none is given, and the number reads FB-n", async () => {
    const result = await submitFeedback({
      kind: "bug",
      body: "Outstanding on the customer page is double\nOpened Shree Paints from the queue.",
      impact: "blocking",
      path: "/crm/customers/cus_1",
    });
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    const row = (await listFeedback())[0];
    assert.equal(row.title, "Outstanding on the customer page is double");
    assert.match(row.ref, /^FB-\d+$/);
    assert.equal(row.impact, "blocking");
    assert.equal(result.ok && result.data.ref, row.ref);
  });

  test("only a fault carries an impact", async () => {
    await submitFeedback({ kind: "suggestion", body: "Let me sort bills by due date please", impact: "blocking" });
    assert.equal((await listFeedback())[0].impact, null);
  });
});

describe("Same problem, one conversation", () => {
  test("joining a report puts the second person on its reporter side", async () => {
    const first = await report();
    setTestUser(deepa);
    const joined = await submitFeedback({ kind: "bug", body: "Same here on Mehta Hardware", sameAsId: first });
    assert.equal(joined.ok, true, joined.ok ? "" : joined.error);

    // The console lists the problem once, with both people on it.
    setTestUser(manager);
    const listed = await listFeedback();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].alsoReported.length, 1);
    assert.equal(listed[0].alsoReported[0].byName, "Deepa");

    // A reply there reaches both of them, each linked to their own report.
    assert.equal((await replyToFeedback({ id: first, body: "Found it." })).ok, true);
    const deepaBell = await bellOf(deepa.id);
    const priyaBell = await bellOf(priya.id);
    assert.equal(deepaBell.length, 1);
    assert.equal(priyaBell.length, 1);
    assert.ok(deepaBell[0].href?.endsWith(joined.ok ? joined.data.id : "x"));

    // Deepa reads the shared thread on her own report, and it counts as unread.
    setTestUser(deepa);
    const mine = await listMyFeedback(deepa.id);
    assert.equal(mine[0].sameAs?.id, first);
    assert.deepEqual(mine[0].messages.map((m) => m.body), ["Found it."]);
    assert.equal(await unreadFeedbackReplies(deepa.id), 1);

    // What she adds lands on the shared thread, on the reporter side.
    assert.equal((await replyToFeedback({ id: joined.ok ? joined.data.id : "", body: "Kapoor too." })).ok, true);
    setTestUser(manager);
    const after = (await listFeedback())[0];
    assert.equal(after.messages.at(-1)?.body, "Kapoor too.");
    assert.equal(after.queue, "reply");
  });

  test("triage merges by number, and the reporter is told where to look", async () => {
    const a = await report({ body: "Lot stock shows zero after a transfer" });
    const b = await report({ body: "Stock on hand is wrong after moving it" });
    setTestUser(manager);
    const target = (await listFeedback()).find((r) => r.id === a)!;
    const merged = await mergeFeedback(b, target.ref);
    assert.equal(merged.ok, true, merged.ok ? "" : merged.error);
    const listed = await listFeedback();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, a);
  });

  test("open reports that read the same are offered", async () => {
    await report({ title: "Outstanding figure on the customer page is wrong", body: "It is double what Accounts says." });
    const hits = await similarFeedback("the outstanding figure on the customer page is wrong for Mehta");
    assert.equal(hits.length, 1);
  });
});

describe("Team notes and the queues", () => {
  test("a team note is never read by, or told to, the reporter, and is not an answer", async () => {
    const fb = await report();
    setTestUser(manager);
    assert.equal((await replyToFeedback({ id: fb, body: "Probably the ledger double count.", internal: true })).ok, true);
    assert.equal((await listFeedback())[0].queue, "reply", "a note does not answer anybody");
    assert.equal((await bellOf(priya.id)).length, 0);
    setTestUser(priya);
    assert.equal((await listMyFeedback(priya.id))[0].messages.length, 0);
  });

  test("a reporter cannot write a team note", async () => {
    const fb = await report();
    const r = await replyToFeedback({ id: fb, body: "secret", internal: true });
    assert.equal(r.ok, false);
  });

  test("a written reply moves it to Waiting on them; a status alone to Being looked at", async () => {
    const fb = await report();
    setTestUser(manager);
    await setFeedbackStatus(fb, "in_progress");
    assert.equal((await listFeedback())[0].queue, "looking");
    await replyToFeedback({ id: fb, body: "Which customer was it?" });
    assert.equal((await listFeedback())[0].queue, "waiting");
    assert.equal((await feedbackCounts()).waiting, 1);
  });

  test("a report is handed only to somebody who can answer feedback", async () => {
    const fb = await report();
    setTestUser(manager);
    assert.equal((await assignFeedback(fb, priya.id)).ok, false);
    assert.equal((await assignFeedback(fb, manager.id)).ok, true);
    assert.equal((await listFeedback())[0].assigneeName, "Vikram");
  });
});

describe("Done closes it, and the reporter can reopen it", () => {
  test("still happening reopens it into Needs a reply; fixed is recorded", async () => {
    const fb = await report();
    setTestUser(manager);
    await setFeedbackStatus(fb, "done");
    assert.equal((await listFeedback())[0].queue, "closed");

    setTestUser(priya);
    const still = await answerFix({ id: fb, verdict: "still_happening" });
    assert.equal(still.ok, true, still.ok ? "" : still.error);
    setTestUser(manager);
    const reopened = (await listFeedback())[0];
    assert.equal(reopened.status, "in_progress");
    assert.equal(reopened.queue, "reply");

    await setFeedbackStatus(fb, "done");
    setTestUser(priya);
    assert.equal((await answerFix({ id: fb, verdict: "fixed" })).ok, true);
    const mine = (await listMyFeedback(priya.id))[0];
    assert.equal(mine.stage, "confirmed");
    setTestUser(manager);
    assert.equal((await feedbackOverview(30)).confirmedFixed, 1);
  });

  test("only somebody who reported it may answer", async () => {
    const fb = await report();
    setTestUser(manager);
    await setFeedbackStatus(fb, "done");
    assert.equal((await answerFix({ id: fb, verdict: "fixed" })).ok, false);
  });
});

describe("The menu summary", () => {
  test("carries the last few with their stage and what is unread", async () => {
    const fb = await report();
    setTestUser(manager);
    await replyToFeedback({ id: fb, body: "On it." });
    setTestUser(priya);
    const summary = await myFeedbackSummary();
    assert.equal(summary.ok && summary.data.unreadReplies, 1);
    assert.equal(summary.ok && summary.data.recent[0].unread, 1);
    await markFeedbackRead(fb);
    const after = await myFeedbackSummary();
    assert.equal(after.ok && after.data.unreadReplies, 0);
  });
});
