/**
 * A "Login as …" link opens ONE session, however many times it is submitted.
 *
 * Two submits of the same link at once both passed `findLiveImpersonation`
 * (the token was read, not claimed) and both created a session. The token is
 * now consumed with `used_at is null … returning`, so the second submit is
 * refused before any session exists.
 *
 * `createSession` writes the session row and then sets the cookie; outside a
 * request the cookie throws, which is fine here — the row is what is counted.
 * Needs `mahekone_test`. It truncates what it touches.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { impersonationTokens, sessions, users } from "@/db/schema";
import { hashImpersonationToken, newImpersonationToken } from "@/lib/impersonation";
import { enterImpersonatedSession } from "@/lib/actions/impersonation";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

async function makeUser(name: string, role: "associate" | "admin") {
  const [u] = await db
    .insert(users)
    .values({ id: id("usr"), name, email: `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 4)}@test.local`, passwordHash: "x", role, initials: name.slice(0, 2).toUpperCase() })
    .returning();
  return u;
}

before(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run `npm run test:db` first.");
  await db.execute(sql`truncate table impersonation_tokens, sessions, audit_log restart identity cascade`);
});

after(async () => {
  await db.$client.end();
});

test("two submits of one link at once open one session, and the second is told the link is spent", async () => {
  const admin = await makeUser("Imp Admin", "admin");
  const target = await makeUser("Imp Target", "associate");
  const token = newImpersonationToken();
  const tokenId = id("imp");
  await db.insert(impersonationTokens).values({ id: tokenId, userId: target.id, createdById: admin.id, tokenHash: hashImpersonationToken(token), expiresAt: new Date(Date.now() + 5 * 60_000) });

  /* Two submits in one process do not overlap on their own, so the race is
     made to happen: another connection holds the token's row while both
     submits read the link as live and reach the write, then lets go. */
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let locked!: () => void;
  const isLocked = new Promise<void>((r) => (locked = r));
  const holder = db.transaction(async (tx) => {
    await tx.execute(sql`select id from impersonation_tokens where id = ${tokenId} for update`);
    locked();
    await held;
  });
  await isLocked;

  const submit = async () => {
    const form = new FormData();
    form.set("token", token);
    try {
      return await enterImpersonatedSession(null, form);
    } catch {
      return "threw after creating the session" as const; // cookies()/redirect() outside a request
    }
  };
  const racing = Promise.all([submit(), submit()]);
  await new Promise((r) => setTimeout(r, 500));
  release();
  await holder;
  const both = await racing;
  const refused = both.filter((r) => typeof r === "object" && r && !r.ok);
  assert.equal(refused.length, 1, JSON.stringify(both));
  const opened = await db.select().from(sessions).where(eq(sessions.userId, target.id));
  assert.equal(opened.length, 1, "one link, one session");
});
