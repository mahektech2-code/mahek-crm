/**
 * AN EXPENSE AND EVERY FILE BEHIND IT, from the handset to the manager.
 *
 *   npm run test:integration
 *
 * Prod had never received a single expense claim when this was written, so
 * nothing in the path had ever run for real. These pin the whole of it:
 *
 *   - a claim carries several files — photographs and a PDF — and every one is
 *     filed under the claim, INCLUDING one that uploaded before the claim
 *     existed, parented to the handset's literal `pending`;
 *   - a file somebody else uploaded is never moved under this claim by naming
 *     its id;
 *   - the bills can be opened by the man who claimed them and by a manager
 *     holding the Sales Dashboard, and by no other salesman — before this, they
 *     could be opened by nobody at all;
 *   - the Decide dialog's read returns the day's claims with their files.
 *
 * Needs mahekone_test, which `npm run test:db` creates from the migrations.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, attachments, mbosDevices, mbosExpenseDays, mbosExpenses, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { ingestSyncBatch, storeMbosMedia } from "@/lib/actions/mbos";
import { canRead } from "@/lib/services/attachment-service";
import { claimLinesForDay } from "@/lib/services/expense-claims-service";
import type { MbosPrincipal } from "@/lib/services/mbos-service";
import type { SyncItem } from "@/lib/mbos/types";
import { addDays, today } from "@/lib/format";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/* Files that are what they say BY THEIR BYTES — the server sniffs signatures. */
const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);
const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");

let salesman: typeof users.$inferSelect;
let colleague: typeof users.$inferSelect;
let manager: typeof users.$inferSelect;
let principal: MbosPrincipal;
let colleaguePrincipal: MbosPrincipal;
let dayId: string;
const DAY = addDays(today(), -1);

async function makeUser(name: string, role: "associate" | "manager") {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase()}-${randomUUID().slice(0, 6)}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  return row!;
}

function principalFor(u: typeof users.$inferSelect): MbosPrincipal {
  return {
    user: u,
    deviceId: `device-${u.id}`,
    role: "associate",
    scope: { kind: "own", userIds: [u.id] },
  } as MbosPrincipal;
}

/** A file as the handset sends it: named for the claim, or for `pending`. */
async function upload(p: MbosPrincipal, parentId: string, bytes: Uint8Array, name: string): Promise<string> {
  const out = await storeMbosMedia(p, {
    clientId: `mbos_media_${randomUUID()}`,
    kind: "bill_photo",
    parentType: "expense",
    parentId,
    filename: name,
    bytes,
  });
  assert.ok(out.ok, `the file should store: ${JSON.stringify(out)}`);
  return out.ok ? out.attachmentId : "";
}

function claim(expenseId: string, payload: Record<string, unknown>): SyncItem {
  return {
    queueId: id("q"),
    entityId: expenseId,
    entityType: "expense",
    op: "create",
    idempotencyKey: `${expenseId}:create:${randomUUID()}`,
    clientCreatedAt: Date.now(),
    payload: {
      category: "travel",
      kind: "local_transport",
      amountPaise: 45_000,
      expenseDate: DAY,
      description: "Auto, station to Kamptee and back",
      expenseDayId: dayId,
      ...payload,
    },
  };
}

before(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run `npm run test:db` first.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table
      mbos_expenses, mbos_expense_days, mbos_approvals, mbos_devices, attachments,
      audit_log, notifications, app_access, sessions, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  salesman = await makeUser("Mahesh", "associate");
  colleague = await makeUser("Ramesh", "associate");
  manager = await makeUser("Vikram", "manager");
  await db.insert(appAccess).values([
    { id: id("aa"), userId: salesman.id, app: "field", role: "associate" },
    { id: id("aa"), userId: colleague.id, app: "field", role: "associate" },
    { id: id("aa"), userId: manager.id, app: "sales", role: "manager" },
  ]);
  await db.insert(mbosDevices).values([
    { id: id("dev"), userId: salesman.id, deviceId: `device-${salesman.id}`, active: true },
    { id: id("dev"), userId: colleague.id, deviceId: `device-${colleague.id}`, active: true },
  ]);
  principal = principalFor(salesman);
  colleaguePrincipal = principalFor(colleague);

  dayId = id("xday");
  await db.insert(mbosExpenseDays).values({ id: dayId, userId: salesman.id, day: DAY });
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("a claim with several files", () => {
  test("every file is filed under the claim, including one that went up before it", async () => {
    const expenseId = id("exp");
    /* The commonest real order: the bill photographed while the form is still
       open, and uploaded by the media queue before the claim is sent. */
    const early = await upload(principal, "pending", JPEG, "bill-page-1.jpg");
    const page2 = await upload(principal, expenseId, JPEG, "bill-page-2.jpg");
    const pdf = await upload(principal, expenseId, PDF, "upi-receipt.pdf");

    const [out] = await ingestSyncBatch(principal, [
      claim(expenseId, { billPhotoId: early, attachmentIds: [early, page2, pdf] }),
    ]);
    assert.equal(out.status, "accepted", JSON.stringify(out));

    const files = await db
      .select({ id: attachments.id, parentType: attachments.parentType, parentId: attachments.parentId, contentType: attachments.contentType })
      .from(attachments)
      .where(inArray(attachments.id, [early, page2, pdf]));
    assert.equal(files.length, 3);
    for (const f of files) {
      assert.equal(f.parentType, "mbos_expense", `${f.id} filed as an expense file`);
      assert.equal(f.parentId, expenseId, `${f.id} filed under this claim, not "pending"`);
    }
    assert.equal(files.find((f) => f.id === pdf)?.contentType, "application/pdf");

    const [row] = await db.select().from(mbosExpenses).where(eq(mbosExpenses.id, expenseId));
    assert.equal(row.billPhotoId, early, "the first file stays in the one-column slot");
  });

  test("a handset that sends only the list still satisfies the bill rule", async () => {
    const expenseId = id("exp");
    const only = await upload(principal, expenseId, JPEG, "bill.jpg");
    const [out] = await ingestSyncBatch(principal, [claim(expenseId, { attachmentIds: [only] })]);
    assert.equal(out.status, "accepted", JSON.stringify(out));
    const [row] = await db.select().from(mbosExpenses).where(eq(mbosExpenses.id, expenseId));
    assert.equal(row.billPhotoId, only);
  });

  test("a claim over the threshold with no file at all is still refused", async () => {
    const [out] = await ingestSyncBatch(principal, [claim(id("exp"), {})]);
    assert.equal(out.status, "rejected");
  });

  test("naming somebody else's file does not move it under this claim", async () => {
    const theirs = await upload(colleaguePrincipal, "pending", JPEG, "their-bill.jpg");
    const mine = await upload(principal, "pending", JPEG, "my-bill.jpg");
    const expenseId = id("exp");
    const [out] = await ingestSyncBatch(principal, [claim(expenseId, { attachmentIds: [mine, theirs] })]);
    assert.equal(out.status, "accepted", JSON.stringify(out));
    const [t] = await db.select().from(attachments).where(eq(attachments.id, theirs));
    assert.notEqual(t.parentId, expenseId, "a colleague's file stays where it was");
  });
});

describe("who can open the bills", () => {
  test("the claimant and his manager can; another salesman cannot", async () => {
    const expenseId = id("exp");
    const bill = await upload(principal, expenseId, JPEG, "bill.jpg");
    const pdf = await upload(principal, expenseId, PDF, "receipt.pdf");
    await ingestSyncBatch(principal, [claim(expenseId, { attachmentIds: [bill, pdf] })]);

    setTestUser(salesman);
    assert.equal(await canRead(bill), true, "his own bill");
    assert.equal(await canRead(pdf), true, "his own PDF");

    setTestUser(manager);
    assert.equal(await canRead(bill), true, "the manager deciding it");

    setTestUser(colleague);
    assert.equal(await canRead(bill), false, "not a colleague's to open");
  });
});

describe("the Decide dialog", () => {
  test("it reads the day's claims with every file behind each", async () => {
    const a = id("exp");
    const b = id("exp");
    const a1 = await upload(principal, a, JPEG, "a1.jpg");
    const a2 = await upload(principal, a, PDF, "a2.pdf");
    const b1 = await upload(principal, b, JPEG, "b1.jpg");
    await ingestSyncBatch(principal, [
      claim(a, { attachmentIds: [a1, a2] }),
      claim(b, { kind: "food", category: "food", amountPaise: 18_000, description: "Lunch", attachmentIds: [b1] }),
    ]);

    setTestUser(manager);
    const lines = await claimLinesForDay(dayId);
    assert.ok(lines, "the manager can read the day");
    assert.equal(lines!.length, 2);
    const la = lines!.find((l) => l.id === a)!;
    assert.deepEqual(la.files.map((f) => f.id).sort(), [a1, a2].sort());
    assert.equal(la.files.find((f) => f.id === a2)?.contentType, "application/pdf");
    assert.equal(lines!.find((l) => l.id === b)!.files.length, 1);
  });
});
