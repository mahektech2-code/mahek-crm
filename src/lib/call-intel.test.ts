/**
 * THE CALL ASSISTANT, against a real database.
 *
 *   npm run test:integration
 *
 * The pure engines have their own suite (`engines/call-intel.test.ts`). This
 * pins the three things only a database can show:
 *
 *   - the classifier learns from logged calls and is stored, with its
 *     cross-validated figures beside it;
 *   - a reading with NO language model still answers from what was learned,
 *     sees what is already open for the customer, and writes nothing but its
 *     own draft — no call, no reminder, no complaint;
 *   - saving the call writes what it was SAVED as onto the draft, in the same
 *     transaction, and only onto the caller's own unspent draft.
 *
 * No key is spent: both provider keys are removed from the environment before
 * anything is imported that could read them, and `app_secrets` is truncated.
 */
delete process.env.OPENAI_API_KEY;
delete process.env.SARVAM_API_KEY;

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  callAiDrafts,
  callIntelModels,
  calls,
  customers,
  reminders,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import {
  analyseCall,
  forgetClassifier,
  trainCallClassifier,
} from "@/lib/services/call-intel-service";
import { addDays, today } from "@/lib/format";
import { saveInteraction } from "@/lib/services/interaction-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let telecaller: typeof users.$inferSelect;
let other: typeof users.$inferSelect;
let customerId: string;

async function makeUser(name: string) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase()}-${randomUUID().slice(0, 4)}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role: "associate",
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  await db
    .insert(appAccess)
    .values({ id: id("aca"), userId: row.id, app: "crm", role: "associate" });
  return row;
}

/** Sixty logged calls in the office's own shorthand — enough to learn from. */
async function seedHistory() {
  const notes: Array<[string, string]> = [];
  const nr = [
    "NR",
    "not picked",
    "switch off",
    "phone not reachable",
    "call not picked NR",
    "ringing no response",
  ];
  const pay = [
    "payment friday tak",
    "will pay next week",
    "payment karenge monday",
    "cheque dega 5 tarikh",
    "payment 20 tarikh ko",
    "NEFT karenge kal",
  ];
  const no = [
    "stock available no order",
    "rate jyada hai no order",
    "abhi requirement nahi",
    "stock hai abhi",
    "no requirement this month",
    "maal pada hai",
  ];
  for (let i = 0; i < 10; i++) {
    for (const n of nr) notes.push([`${n} ${i}`, "no_answer"]);
    for (const n of pay) notes.push([`${n} ${i}`, "payment_promised"]);
    for (const n of no) notes.push([`${n} ${i}`, "no_order"]);
  }
  const at = new Date(Date.now() - 86_400_000);
  await db.insert(calls).values(
    notes.map(([text, outcome]) => ({
      id: id("cal"),
      customerId,
      userId: telecaller.id,
      interactionType: "outbound_call" as const,
      outcome: outcome as never,
      notes: text,
      startedAt: at,
    })),
  );
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
      call_ai_drafts, call_intel_models, calls, reminders, complaints,
      timeline_events, notifications, audit_log, app_secrets,
      customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  forgetClassifier();
  await seedConfig();
  telecaller = await makeUser("Priya");
  other = await makeUser("Rakesh");
  customerId = id("cus");
  await db.insert(customers).values({
    id: customerId,
    name: "Shree Paints",
    phone: "9820099001",
    city: "Nagpur",
    kind: "customer",
    ownerId: telecaller.id,
    salesAmId: telecaller.id,
  } as never);
  setTestUser(telecaller);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

test("the classifier learns from logged calls and is stored with its figures", async () => {
  await seedHistory();
  const report = await trainCallClassifier();
  assert.equal(report.trainedOn, 180);
  assert.ok(
    report.evaluation && report.evaluation.accuracy > 0.8,
    `accuracy ${report.evaluation?.accuracy}`,
  );
  const [row] = await db.select().from(callIntelModels);
  assert.equal(row.kind, "outcome_nb");
  assert.equal(row.trainedOn, 180);
});

test("too few calls teach nothing, and nothing is stored", async () => {
  const report = await trainCallClassifier();
  assert.equal(report.evaluation, null);
  assert.equal((await db.select().from(callIntelModels)).length, 0);
});

test("with no model, the assistant answers from what it learned — and asks", async () => {
  await seedHistory();
  await trainCallClassifier();
  await db.insert(reminders).values({
    id: id("rem"),
    customerId,
    createdByUserId: telecaller.id,
    assignedUserId: telecaller.id,
    dueDate: addDays(today(), 1),
    note: "call back",
  });
  const callsBefore = (await db.select().from(calls)).length;

  const result = await analyseCall({
    customerId,
    spoken: "",
    english: "",
    typedNote: "NR switch off",
    language: null,
    heardBy: "typed",
    interactionType: "outbound_call",
  });
  assert.ok(result.ok, !result.ok ? result.error : "");
  const { analysis, draftId } = result.data;
  assert.equal(analysis.readers.model, false);
  assert.equal(analysis.primary?.intent, "no_answer");
  assert.equal(
    analysis.primary?.state,
    "confirm",
    "without a model it never fills on its own say-so",
  );
  /* The open reminder is seen, so the retry is offered as a move, not a second. */
  assert.equal(
    analysis.extras.find((e) => e.key === "retry")?.door,
    "reschedule",
  );

  const [draft] = await db
    .select()
    .from(callAiDrafts)
    .where(eq(callAiDrafts.id, draftId));
  assert.equal(draft.suggestedOutcome, "no_answer");
  assert.equal(draft.heardBy, "typed");
  assert.equal(draft.callId, null);
  assert.equal(
    (await db.select().from(calls)).length,
    callsBefore,
    "reading writes no call",
  );
  assert.equal(
    (await db.select().from(reminders)).length,
    1,
    "reading writes no reminder",
  );
});

test("with nothing learned and no model, it says so rather than guessing", async () => {
  const result = await analyseCall({
    customerId,
    spoken: "",
    english: "",
    typedNote: "spoke to him about the order",
    language: null,
    heardBy: "typed",
    interactionType: null,
  });
  assert.equal(result.ok, false);
  assert.equal((await db.select().from(callAiDrafts)).length, 0);
});

test("saving the call writes what it was saved as onto the draft — and only the caller's own", async () => {
  await seedHistory();
  await trainCallClassifier();
  const read = await analyseCall({
    customerId,
    spoken: "पंद्रह दिन बाद पेमेंट करेंगे",
    english: "Will pay after fifteen days",
    typedNote: "",
    language: "hi-IN",
    heardBy: "sarvam",
    interactionType: "outbound_call",
  });
  assert.ok(read.ok);
  const draftId = read.data.draftId;

  /* Somebody else's save cannot claim this reading. */
  setTestUser(other);
  await db
    .update(customers)
    .set({ salesAmId: other.id, ownerId: other.id })
    .where(eq(customers.id, customerId));
  const theirs = await saveInteraction({
    customerId,
    interactionType: "outbound_call",
    outcome: "no_answer",
    outcomeDetail: { whyNoAnswer: "no_response" },
    idempotencyKey: randomUUID(),
    aiDraftId: draftId,
  });
  assert.ok(theirs.ok, !theirs.ok ? theirs.error : "");
  let [draft] = await db
    .select()
    .from(callAiDrafts)
    .where(eq(callAiDrafts.id, draftId));
  assert.equal(draft.callId, null);

  setTestUser(telecaller);
  await db
    .update(customers)
    .set({ salesAmId: telecaller.id, ownerId: telecaller.id })
    .where(eq(customers.id, customerId));
  const pay = addDays(today(), 15);
  const mine = await saveInteraction({
    customerId,
    interactionType: "outbound_call",
    outcome: "payment_promised",
    paymentPromiseDate: pay,
    outcomeDetail: { promisedAmount: "50,000" },
    notes: "Will pay after fifteen days",
    idempotencyKey: randomUUID(),
    aiDraftId: draftId,
  });
  assert.ok(mine.ok, !mine.ok ? mine.error : "");
  [draft] = await db
    .select()
    .from(callAiDrafts)
    .where(eq(callAiDrafts.id, draftId));
  assert.equal(draft.callId, mine.data.interactionId);
  assert.equal(draft.savedOutcome, "payment_promised");
  assert.equal(
    draft.spoken,
    "पंद्रह दिन बाद पेमेंट करेंगे",
    "the original transcript is kept",
  );

  /* The amount rides into the reminder the person ringing on the day reads. */
  const [rem] = await db
    .select()
    .from(reminders)
    .where(eq(reminders.type, "payment_promise"));
  assert.match(rem.note, /₹50,000/);
});

test("an amount that is not a number is refused at its field", async () => {
  const r = await saveInteraction({
    customerId,
    interactionType: "outbound_call",
    outcome: "payment_promised",
    paymentPromiseDate: addDays(today(), 1),
    outcomeDetail: { promisedAmount: "fifty thousand" },
    idempotencyKey: randomUUID(),
  });
  assert.equal(r.ok, false);
  assert.equal(
    !r.ok && r.fieldErrors?.[0]?.field,
    "outcomeDetail.promisedAmount",
  );
});
