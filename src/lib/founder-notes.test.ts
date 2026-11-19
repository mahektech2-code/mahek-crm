/**
 * A NOTE WRITTEN FROM HQ is corrected or deleted by its author only, and the
 * audit log it lives in is never rewritten: each change is a row of its own,
 * folded on the way to the timeline.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, auditLog, customers, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { addNote, notesFor } from "@/lib/command-centre/provider";
import { deleteOwnNote as deleteNoteAction, editOwnNote as editNoteAction } from "@/lib/command-centre/notes";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let author: typeof users.$inferSelect;
let other: typeof users.$inferSelect;
let shop: string;

before(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run against mahekone_test.");
  await db.execute(sql`
    truncate table audit_log, app_access, sessions, notifications, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  [author, other] = await db
    .insert(users)
    .values([
      { id: id("usr"), name: "Founder", email: `f-${randomUUID().slice(0, 4)}@t.local`, passwordHash: "x", role: "admin", initials: "FO" },
      { id: id("usr"), name: "Delegate", email: `d-${randomUUID().slice(0, 4)}@t.local`, passwordHash: "x", role: "admin", initials: "DE" },
    ])
    .returning();
  await db.insert(appAccess).values([
    { id: id("aca"), userId: author.id, app: "founder", role: "admin" as const },
    { id: id("aca"), userId: other.id, app: "founder", role: "admin" as const },
  ]);
  shop = id("cus");
  await db.insert(customers).values({ id: shop, name: "Colour Camp", kind: "customer", ownerId: author.id, contactPerson: "A", phone: "9820011111", city: "Pune" });
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

test("a note is edited and deleted by its author, never by anybody else, and the log keeps every step", async () => {
  setTestUser(author);
  await addNote(author.id, "customer", shop, "Cheque on Friday");
  const [mine] = await notesFor("customer", shop);
  assert.equal(mine.note?.mine, true, "the author is told it is theirs");
  const noteId = mine.note!.id;

  setTestUser(other);
  const [theirs] = await notesFor("customer", shop);
  assert.equal(theirs.note?.mine, false, "nobody else is offered Edit or Delete");
  assert.equal((await editNoteAction(noteId, "Rewritten")).ok, false, "somebody else's note is refused");
  assert.equal((await deleteNoteAction(noteId)).ok, false);

  setTestUser(author);
  assert.equal((await editNoteAction(noteId, "   ")).ok, false, "an empty note is refused");
  const edited = await editNoteAction(noteId, "Cheque on Monday instead");
  assert.ok(edited.ok, edited.ok ? "" : edited.error);
  const [after1] = await notesFor("customer", shop);
  assert.equal(after1.what, "Cheque on Monday instead");
  assert.match(after1.when, /edited/);

  const [original] = await db.select().from(auditLog).where(eq(auditLog.id, noteId));
  assert.equal((original.afterState as { note: string }).note, "Cheque on Friday", "the original audit row is untouched");

  const deleted = await deleteNoteAction(noteId);
  assert.ok(deleted.ok, deleted.ok ? "" : deleted.error);
  assert.equal((await notesFor("customer", shop)).length, 0, "a deleted note leaves the timeline");
  assert.equal((await editNoteAction(noteId, "Back again")).ok, false, "and cannot be edited after");

  const trail = await db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(and(eq(auditLog.entityId, shop), like(auditLog.action, "founder.note%")));
  assert.deepEqual(trail.map((t) => t.action).sort(), ["founder.note", "founder.note_delete", "founder.note_edit"]);
});
