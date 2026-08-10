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
  markFeedbackRead,
  myFeedbackSummary,
  replyToFeedback,
  setFeedbackStatus,
  submitFeedback,
} from "@/lib/actions/feedback";
import {
  feedbackCounts,
  listFeedback,
  listMyFeedback,
} from "@/lib/services/feedback-service";
import { canRead } from "@/lib/services/attachment-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let manager: typeof users.$inferSelect;
let priya: typeof users.$inferSelect;
let deepa: typeof users.$inferSelect;

async function makeUser(name: string, role: "telecaller" | "manager" | "accounts") {
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
  return row;
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
  priya = await makeUser("Priya", "telecaller");
  deepa = await makeUser("Deepa", "accounts");
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
    assert.equal(bell[0].href, "/feedback");
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
    setTestUser(deepa);
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

    setTestUser(deepa);
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
