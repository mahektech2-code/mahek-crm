/**
 * Changing your own password, from the account menu.
 *
 *   npm run test:integration
 *
 * The form is three fields and the rules behind it are four, every one of
 * which fails silently if it is wrong: a change that did not take, a change
 * that took but said it had not, a "Saved" for a password that is the same one,
 * and a session somewhere in the world still holding the old one. None of
 * those is visible on a screen, so they are pinned here.
 *
 * Needs mahekone_test, which `npm run test:db` creates from the committed
 * migrations.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { auditLog, passwordResets, sessions, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { hashPassword, verifyPassword } from "@/lib/password";
import { changePassword } from "@/lib/actions/account";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const OLD = "old-password-1";
const NEW = "new-password-2";

let person: typeof users.$inferSelect;

/** The three fields, as the dialog posts them. */
function form(current: string, password: string, confirm = password) {
  const fd = new FormData();
  fd.set("current", current);
  fd.set("password", password);
  fd.set("confirm", confirm);
  return fd;
}

async function storedHash(userId: string) {
  const [row] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId));
  return row.passwordHash;
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
    truncate table audit_log, password_resets, sessions, users
    restart identity cascade
  `);

  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name: "Priya Sharma",
      email: `priya-${randomUUID().slice(0, 4)}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: await hashPassword(OLD),
      role: "associate",
      initials: "PS",
    })
    .returning();
  person = row;
  setTestUser(person);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

test("the current password has to be right, and the stored one is untouched when it is not", async () => {
  const before = await storedHash(person.id);

  const res = await changePassword(null, form("not-my-password", NEW));

  assert.equal(res.ok, false, "a wrong current password is refused");
  assert.equal(
    res.ok ? null : res.fieldErrors?.[0].field,
    "current",
    "and the message names the box it is about, not the amount box beside it",
  );
  assert.equal(
    await storedHash(person.id),
    before,
    "nothing was written",
  );
  assert.equal(await verifyPassword(OLD, await storedHash(person.id)), true);
});

test("the two new passwords have to match", async () => {
  const res = await changePassword(null, form(OLD, NEW, "new-password-3"));
  assert.equal(res.ok, false);
  assert.equal(res.ok ? null : res.fieldErrors?.[0].field, "confirm");
  assert.equal(await verifyPassword(OLD, await storedHash(person.id)), true);
});

test("a new password that is the old one is refused rather than saved", async () => {
  // The dangerous case: it would write the same hash and answer "Saved", and
  // somebody changing their password because they think it has been seen
  // would walk away believing they had.
  const res = await changePassword(null, form(OLD, OLD));
  assert.equal(res.ok, false);
  assert.equal(res.ok ? null : res.fieldErrors?.[0].field, "password");
});

test("it has to be eight characters, like every other password in the product", async () => {
  const res = await changePassword(null, form(OLD, "short"));
  assert.equal(res.ok, false);
  assert.equal(await verifyPassword(OLD, await storedHash(person.id)), true);
});

test("a good change writes the new one, ends the other sessions and kills any live reset link", async () => {
  const expiresAt = new Date(Date.now() + 86_400_000);
  await db.insert(sessions).values([
    { id: randomUUID(), userId: person.id, expiresAt },
    { id: randomUUID(), userId: person.id, expiresAt },
  ]);
  // Asked for and never spent — a working link sitting in an inbox.
  await db.insert(passwordResets).values({
    id: id("pwr"),
    userId: person.id,
    tokenHash: randomUUID(),
    expiresAt,
  });

  const res = await changePassword(null, form(OLD, NEW));
  assert.equal(res.ok, true, res.ok ? "" : res.error);

  const stored = await storedHash(person.id);
  assert.equal(await verifyPassword(NEW, stored), true, "the new one works");
  assert.equal(await verifyPassword(OLD, stored), false, "the old one does not");

  /*
   * Every session goes here because a test has no cookie jar, so
   * `currentSessionId` answers null — which the action reads as "cannot tell
   * which is yours" and ends the lot. That is the deliberate safe direction;
   * in a browser the one holding the cookie is kept.
   */
  const live = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.userId, person.id));
  assert.equal(live.length, 0, "the other devices are signed out");

  const [reset] = await db
    .select({ usedAt: passwordResets.usedAt })
    .from(passwordResets)
    .where(eq(passwordResets.userId, person.id));
  assert.ok(reset.usedAt, "the outstanding reset link is spent");

  const [entry] = await db
    .select({ action: auditLog.action, actorId: auditLog.actorId })
    .from(auditLog)
    .where(eq(auditLog.action, "change-password"));
  assert.equal(entry?.actorId, person.id, "and it is on the audit log");
});

test("the sentence says what else happened, because the other half is the surprise", async () => {
  const res = await changePassword(null, form(OLD, NEW));
  assert.equal(res.ok, true);
  assert.match(
    res.ok ? (res.message ?? "") : "",
    /signed out/i,
    "a password saved is obvious; a phone at home signed out is not",
  );
});
