/**
 * Fixing a report, end to end against mahekone_test, with GitHub played by a
 * stand-in `fetch`: what it needs, the issue, Claude's label, and the report
 * closing itself only once the merged fix is in the serving build.
 *
 *   npm run test:integration
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, appSecrets, feedback, feedbackFixes, feedbackMessages, notifications, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { submitFeedback } from "@/lib/actions/feedback";
import { askClaudeToFix, chooseWhatItNeeds, sendToDeveloper } from "@/lib/actions/feedback-fix";
import { getFix, syncFeedbackFixes } from "@/lib/services/feedback-fix-service";
import { testPhone } from "@/lib/test-phone";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let admin: typeof users.$inferSelect;
let manager: typeof users.$inferSelect;
let priya: typeof users.$inferSelect;

async function makeUser(name: string, role: "associate" | "manager" | "admin", app: "crm" | "admin") {
  const [row] = await db
    .insert(users)
    .values({ id: id("usr"), name, email: `${name.toLowerCase()}@test.local`, phone: testPhone(), passwordHash: "x", role, initials: name.slice(0, 2).toUpperCase() })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app, role });
  return row;
}

/* ------------------------------------------------------- a GitHub stand-in */

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];
let github: { prMerged: boolean; compare: string };
const realFetch = globalThis.fetch;

function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (!url.startsWith("https://api.github.com/")) return realFetch(input, init);
  const method = init?.method ?? "GET";
  calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
  const json = (v: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } }));
  if (method === "POST" && url.endsWith("/issues")) return json({ number: 77, html_url: "https://github.com/o/r/issues/77" }, 201);
  if (method === "POST" && url.endsWith("/issues/77/labels")) return json([{ name: "ai-fix" }]);
  if (url.includes("/issues/77/timeline")) {
    return json([{ event: "cross-referenced", source: { issue: { number: 78, pull_request: {} } } }]);
  }
  if (url.endsWith("/pulls/78")) {
    return json({
      number: 78,
      html_url: "https://github.com/o/r/pull/78",
      state: github.prMerged ? "closed" : "open",
      merged_at: github.prMerged ? "2026-11-12T10:00:00Z" : null,
      merge_commit_sha: github.prMerged ? "abc1234def" : null,
    });
  }
  if (url.includes("/compare/abc1234def...")) return json({ status: github.compare });
  return json({ message: "Not Found" }, 404);
}

before(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/);
  globalThis.fetch = fakeFetch as typeof fetch;
});
after(async () => {
  globalThis.fetch = realFetch;
  setTestUser(null);
  await db.$client.end();
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table audit_log, notifications, feedback_fixes, feedback_messages, feedback, attachments,
      app_secrets, app_access, sessions, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  calls = [];
  github = { prMerged: false, compare: "behind" };
  admin = await makeUser("Vikram", "admin", "admin");
  manager = await makeUser("Meena", "manager", "crm");
  priya = await makeUser("Priya", "associate", "crm");
  process.env.MAHEK_BUILD = "fedcba9876";
});

async function report() {
  setTestUser(priya);
  const r = await submitFeedback({
    kind: "bug",
    body: "Save does nothing on the call log\nPressing Save on Shree Ganesh Paints spins for ever. Their number is 9820011001.",
    path: "/crm/queue",
  });
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  return r.ok ? r.data.id : "";
}

async function connect() {
  await db.insert(appSecrets).values({ name: "github.token", value: "github_pat_test_0000", last4: "0000" });
}

describe("fixing feedback", () => {
  test("a report the team can fix never reaches GitHub", async () => {
    await connect();
    const fb = await report();
    setTestUser(manager);
    assert.equal((await chooseWhatItNeeds(fb, "access")).ok, true);
    const sent = await sendToDeveloper(fb);
    assert.equal(sent.ok, false);
    assert.equal(calls.length, 0, "nothing went to GitHub");
  });

  test("only a platform administrator may ask Claude", async () => {
    await connect();
    const fb = await report();
    setTestUser(manager);
    await chooseWhatItNeeds(fb, "code_change");
    const refused = await askClaudeToFix(fb);
    assert.equal(refused.ok, false);
    assert.equal(calls.length, 0);
  });

  test("the issue carries no phone number, Claude is labelled, and the report closes only once live", async () => {
    await connect();
    const fb = await report();
    setTestUser(admin);
    await chooseWhatItNeeds(fb, "code_change");
    const asked = await askClaudeToFix(fb);
    assert.equal(asked.ok, true, asked.ok ? "" : asked.error);

    const issue = calls.find((c) => c.method === "POST" && c.url.endsWith("/issues"))!;
    const body = (issue.body as { body: string }).body;
    assert.match(body, /Shree Ganesh Paints/, "names stay");
    assert.doesNotMatch(body, /9820011001/, "the phone does not");
    assert.ok(calls.some((c) => c.url.endsWith("/issues/77/labels")), "the label that starts Claude");

    // Open PR: nothing closes.
    await syncFeedbackFixes();
    let [row] = await db.select().from(feedback).where(eq(feedback.id, fb));
    assert.notEqual(row.status, "done");
    assert.equal((await getFix(fb))?.prState, "open");

    // Merged but not deployed: still open.
    github.prMerged = true;
    await syncFeedbackFixes();
    [row] = await db.select().from(feedback).where(eq(feedback.id, fb));
    assert.notEqual(row.status, "done");
    assert.equal((await getFix(fb))?.prState, "merged");

    // In the serving build: closed, told, and never closed twice.
    github.compare = "ahead";
    const r = await syncFeedbackFixes();
    assert.equal(r.closed, 1);
    [row] = await db.select().from(feedback).where(eq(feedback.id, fb));
    assert.equal(row.status, "done");
    const told = await db.select().from(notifications).where(eq(notifications.userId, priya.id));
    assert.ok(told.some((n) => n.title.startsWith("Fixed:")), "the reporter is told");
    assert.equal((await syncFeedbackFixes()).checked, 0, "a live fix is not checked again");
    const lines = await db.select().from(feedbackMessages).where(eq(feedbackMessages.feedbackId, fb));
    assert.equal(lines.filter((l) => l.statusTo === "done").length, 1);
  });

  test("without a token nothing is attempted", async () => {
    const fb = await report();
    setTestUser(manager);
    await chooseWhatItNeeds(fb, "code_change");
    const sent = await sendToDeveloper(fb);
    assert.equal(sent.ok, false);
    assert.match(sent.ok ? "" : sent.error, /not connected/);
    const [fix] = await db.select().from(feedbackFixes).where(eq(feedbackFixes.feedbackId, fb));
    assert.equal(fix.issueNumber, null);
  });
});
