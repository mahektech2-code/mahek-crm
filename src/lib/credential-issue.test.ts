/**
 * Issuing a sign-in somebody can be told over the telephone.
 *
 *   npm run test:integration
 *
 * The Admin Console creates accounts with `hashPassword(randomUUID() +
 * randomUUID())` — a password nobody knows — because the flow was written for a
 * sign-in where a code is sent to the work number. No code is sent: `otp_channel`
 * is an enum in the schema that nothing reads. So every account created that way
 * was unusable, and this is the thing that makes it usable.
 *
 * What is pinned here is mostly what must NOT happen. It is a function that
 * prints a working password on the screen of whoever asks for it, which is a
 * shape no other action in this app has — `sendPasswordResetFor` can be pointed
 * at anybody precisely because what it produces lands in a mailbox the actor
 * cannot read.
 *
 * Needs mahekone_test, which `npm run test:db` creates from the committed
 * migrations. The harness truncates between tests.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, auditLog, passwordResets, sessions, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { verifyPassword } from "@/lib/password";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { issueCredential } from "@/lib/actions/access";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let boss: typeof users.$inferSelect;
let admin: typeof users.$inferSelect;
let clerk: typeof users.$inferSelect;

async function makeUser(name: string, role: "manager" | "associate" | "admin") {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 4)}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      /* The state the console actually leaves a new account in. */
      passwordHash: "scrypt$00$00",
      role,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "crm", role });
  return row;
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
      password_resets, sessions, app_access, audit_log, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  boss = await makeUser("Boss", "manager");
  admin = await makeUser("Admin", "admin");
  clerk = await makeUser("Clerk", "associate");
  setTestUser(boss);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

/* ------------------------------------------------- what it is actually for */

test("the password it prints is the password that signs them in", async () => {
  const r = await issueCredential(clerk.id);
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  if (!r.ok) return;

  const [row] = await db.select().from(users).where(eq(users.id, clerk.id));
  assert.equal(
    await verifyPassword(r.data.password, row.passwordHash),
    true,
    "what was shown must be what the login form checks against",
  );
});

test("it says the work number, because that is what they type into the first box", async () => {
  const r = await issueCredential(clerk.id);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.data.signInWith, clerk.phone);
});

test("an account with no work number falls back to the email rather than to nothing", async () => {
  await db.update(users).set({ phone: null }).where(eq(users.id, clerk.id));
  const r = await issueCredential(clerk.id);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.data.signInWith, clerk.email);
});

test("two issues on one account never produce the same password", async () => {
  const first = await issueCredential(clerk.id);
  const second = await issueCredential(clerk.id);
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.notEqual(first.data.password, second.data.password);

  /* And only the last one works — a password that was replaced must be gone,
     or the office has handed out two live credentials for one person. */
  const [row] = await db.select().from(users).where(eq(users.id, clerk.id));
  assert.equal(await verifyPassword(first.data.password, row.passwordHash), false);
  assert.equal(await verifyPassword(second.data.password, row.passwordHash), true);
});

/* --------------------------------------------------- what it must not do */

test("a manager may not mint a way into an administrator's account", async () => {
  /* The escalation this guard exists for: seeing the result IS the access, so
     without it any manager could read themselves into admin and leave "issued
     a credential" in the log rather than "escalated". */
  const r = await issueCredential(admin.id);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, "not_permitted");
  assert.match(r.error, /administrator/i);

  const [row] = await db.select().from(users).where(eq(users.id, admin.id));
  assert.equal(row.passwordHash, "scrypt$00$00", "the admin's password must be untouched");
});

test("an administrator may, because there is nothing above them to escalate to", async () => {
  setTestUser(admin);
  const r = await issueCredential(boss.id);
  assert.equal(r.ok, true, r.ok ? "" : r.error);
});

test("a disabled sign-in is refused, rather than handed a password that cannot work", async () => {
  await db.update(users).set({ active: false }).where(eq(users.id, clerk.id));
  const r = await issueCredential(clerk.id);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /disabled/i);
});

test("issuing signs them out everywhere, because the password they held is now wrong", async () => {
  await db.insert(sessions).values([
    {
      id: id("ses"),
      userId: clerk.id,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
    {
      id: id("ses"),
      userId: clerk.id,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  ]);

  const r = await issueCredential(clerk.id);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.data.sessionsEnded, 2);

  const left = await db.select().from(sessions).where(eq(sessions.userId, clerk.id));
  assert.equal(left.length, 0);
});

test("an outstanding reset link is spent, so a third password cannot appear later", async () => {
  /* Without this, a link minted before the issue would still work and set a
     password neither the office nor the employee could name. */
  await db.insert(passwordResets).values({
    id: id("rst"),
    userId: clerk.id,
    tokenHash: "deadbeef",
    expiresAt: new Date(Date.now() + 1_800_000),
  });

  const r = await issueCredential(clerk.id);
  assert.equal(r.ok, true);

  const [live] = await db
    .select()
    .from(passwordResets)
    .where(eq(passwordResets.userId, clerk.id));
  assert.notEqual(live.usedAt, null, "the old link must be dead");
});

test("THE AUDIT RECORDS THAT ONE WAS ISSUED AND NEVER WHAT IT WAS", async () => {
  /* An audit row is read by more people than the screen was, and it sits in
     every backup of the log. */
  const r = await issueCredential(clerk.id);
  assert.equal(r.ok, true);
  if (!r.ok) return;

  const rows = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.entityId, clerk.id));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, "issue-credential");
  assert.equal(rows[0].actorId, boss.id);

  const written = JSON.stringify(rows[0]);
  assert.ok(
    !written.includes(r.data.password),
    "the password must not be anywhere in the audit row",
  );
});

test("somebody who is not a manager cannot issue one at all", async () => {
  setTestUser(clerk);
  const r = await issueCredential(boss.id);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, "not_permitted");
});
