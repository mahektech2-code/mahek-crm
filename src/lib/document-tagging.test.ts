/**
 * A DOCUMENT TAGGED TO NAMED SALESMEN, end to end.
 *
 *   npm run test:integration
 *
 * Published, tagged, untagged, edited and withdrawn through the real actions,
 * and read back through the real bootstrap and delta — because "it is tagged"
 * means nothing until the phone it was tagged to gets it and the phone it was
 * not tagged to does not, and untagging means nothing until a tombstone tells
 * the phone that already has it.
 *
 * Needs mahekone_test; `npm run test:db` creates it.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, attachments, mbosDeletions, mbosDocuments, users } from "@/db/schema";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { setTestUser } from "@/lib/auth";
import {
  publishDocument,
  setDocumentPeople,
  setDocumentPublished,
  updateDocument,
} from "@/lib/actions/sales";
import { createAttachment } from "@/lib/services/attachment-service";
import {
  buildBootstrap,
  buildPull,
  encodeCursor,
  type MbosPrincipal,
} from "@/lib/services/mbos-service";
import { documentPeople, documents } from "@/lib/services/sales-service";
import { POST as uploadRoute } from "@/app/api/sales/publish-file/route";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let manager: typeof users.$inferSelect;
let rahul: typeof users.$inferSelect;
let suresh: typeof users.$inferSelect;

async function makeUser(name: string, role: "associate" | "admin", app: "field" | "sales") {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase()}-${randomUUID().slice(0, 4)}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  await db.insert(appAccess).values({ id: id("acc"), userId: row.id, app, role });
  return row;
}

function principalFor(user: typeof users.$inferSelect): MbosPrincipal {
  return {
    user,
    deviceId: `device-${user.id}`,
    role: "associate",
    scope: { kind: "own", userIds: [user.id] },
  } as MbosPrincipal;
}

/** A real PDF's first bytes — the sniffer reads the signature, not the name. */
async function storedPdf(name = "price-list.pdf"): Promise<string> {
  const bytes = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
  const created = await createAttachment({ filename: name, bytes, declaredType: "application/pdf" });
  assert.ok(created.ok, created.ok ? "" : created.error);
  return created.data.id;
}

async function docIdsOnBootstrap(user: typeof users.$inferSelect): Promise<string[]> {
  const boot = await buildBootstrap(principalFor(user));
  return (boot.documents as { id: string }[]).map((d) => d.id);
}

/** A pull from a cursor a minute old: what changed, and what stopped. */
async function deltaFor(user: typeof users.$inferSelect) {
  const pull = await buildPull(principalFor(user), encodeCursor(new Date(Date.now() - 60_000)));
  const docs = (pull.documents as { id: string }[]).map((d) => d.id);
  const gone = (pull.deletions as { entity: string; ids: string[] }[])
    .filter((d) => d.entity === "documents")
    .flatMap((d) => d.ids);
  return { docs, gone };
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
      mbos_documents, mbos_deletions, attachment_bytes, attachments,
      notifications, audit_log, app_access, sessions, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  manager = await makeUser("Vikram", "admin", "sales");
  rahul = await makeUser("Rahul", "associate", "field");
  suresh = await makeUser("Suresh", "associate", "field");
  setTestUser(manager);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

test("the picker offers exactly the people holding the field app", async () => {
  const people = await documentPeople();
  assert.deepEqual(
    people.map((p) => p.name).sort(),
    ["Rahul", "Suresh"],
    "the manager holds the Sales Dashboard, not the field app, and is not somebody a handset can show a document to",
  );
});

test("untagged reaches everybody; tagged reaches only the people named", async () => {
  const everyone = await publishDocument({
    title: "Dealer price list",
    category: "price_list",
    attachmentId: await storedPdf(),
  });
  assert.ok(everyone.ok, everyone.ok ? "" : everyone.error);

  const named = await publishDocument({
    title: "Vidarbha scheme",
    category: "marketing",
    attachmentId: await storedPdf("scheme.pdf"),
    visibleToUserIds: [rahul.id],
  });
  assert.ok(named.ok, named.ok ? "" : named.error);

  assert.deepEqual((await docIdsOnBootstrap(rahul)).sort(), [everyone.data.id, named.data.id].sort());
  assert.deepEqual(await docIdsOnBootstrap(suresh), [everyone.data.id]);

  const [row] = (await documents()).filter((d) => d.id === named.data.id);
  assert.deepEqual(
    row.tagged.map((p) => p.name),
    ["Rahul"],
    "the screen names who it is tagged to",
  );

  const [note] = await db.execute<{ user_id: string }>(
    sql`select user_id from notifications where title = 'A document was shared with you'`,
  );
  assert.equal(note?.user_id, rahul.id, "the person tagged is told; nobody else is");
});

test("a tag that names somebody outside the field is refused, not stored", async () => {
  const res = await publishDocument({
    title: "Price list",
    category: "price_list",
    attachmentId: await storedPdf(),
    visibleToUserIds: [manager.id],
  });
  assert.equal(res.ok, false);
  assert.equal((await db.select().from(mbosDocuments)).length, 0);
});

test("untagging somebody tombstones it on his phone, and tagging him back lifts the tombstone", async () => {
  const pub = await publishDocument({
    title: "Price list",
    category: "price_list",
    attachmentId: await storedPdf(),
  });
  assert.ok(pub.ok);
  const doc = pub.data.id;

  // Everybody -> Rahul only: Suresh loses it.
  const narrowed = await setDocumentPeople({ documentId: doc, userIds: [rahul.id] });
  assert.ok(narrowed.ok, narrowed.ok ? "" : narrowed.error);
  assert.deepEqual((await deltaFor(suresh)).gone, [doc], "Suresh is told it went");
  assert.deepEqual((await deltaFor(rahul)).gone, [], "Rahul is not");
  assert.ok((await deltaFor(rahul)).docs.includes(doc));

  // Rahul -> Suresh: Rahul loses it, Suresh gets it back with nothing left
  // standing that would delete it again in the same pull.
  const swapped = await setDocumentPeople({ documentId: doc, userIds: [suresh.id] });
  assert.ok(swapped.ok);
  const s = await deltaFor(suresh);
  assert.ok(s.docs.includes(doc), "the row comes back down");
  assert.deepEqual(s.gone, [], "and the old tombstone is gone, or the handset would apply it after the row");
  assert.deepEqual((await deltaFor(rahul)).gone, [doc]);

  // Back to everybody.
  const cleared = await setDocumentPeople({ documentId: doc, userIds: [] });
  assert.ok(cleared.ok);
  assert.ok((await deltaFor(rahul)).docs.includes(doc));
  assert.deepEqual((await deltaFor(rahul)).gone, []);
  assert.deepEqual(await docIdsOnBootstrap(suresh), [doc]);
});

test("replacing the file keeps the document and its tags, and retires the old file", async () => {
  const oldFile = await storedPdf("august.pdf");
  const pub = await publishDocument({
    title: "Price list",
    category: "price_list",
    attachmentId: oldFile,
    visibleToUserIds: [rahul.id],
  });
  assert.ok(pub.ok);

  const newFile = await storedPdf("september.pdf");
  const res = await updateDocument({
    documentId: pub.data.id,
    title: "Price list — September",
    category: "price_list",
    attachmentId: newFile,
  });
  assert.ok(res.ok, res.ok ? "" : res.error);

  const [doc] = await db.select().from(mbosDocuments).where(eq(mbosDocuments.id, pub.data.id));
  assert.equal(doc.attachmentId, newFile);
  assert.equal(doc.title, "Price list — September");
  assert.deepEqual(doc.visibleToUserIds, [rahul.id]);

  const [old] = await db.select().from(attachments).where(eq(attachments.id, oldFile));
  const [fresh] = await db.select().from(attachments).where(eq(attachments.id, newFile));
  assert.equal(old.status, "removed");
  assert.equal(fresh.parentId, pub.data.id);

  const boot = await buildBootstrap(principalFor(rahul));
  const sent = (boot.documents as { id: string; remoteRef: string }[]).find((d) => d.id === pub.data.id);
  assert.equal(sent?.remoteRef, newFile, "the handset is sent the new file to fetch");
});

test("publishing again after a withdrawal is not undone by the withdrawal's own tombstone", async () => {
  const pub = await publishDocument({
    title: "Policy",
    category: "policy",
    attachmentId: await storedPdf(),
  });
  assert.ok(pub.ok);
  assert.ok((await setDocumentPublished({ documentId: pub.data.id, published: false })).ok);
  assert.deepEqual((await deltaFor(rahul)).gone, [pub.data.id]);

  assert.ok((await setDocumentPublished({ documentId: pub.data.id, published: true })).ok);
  const d = await deltaFor(rahul);
  assert.ok(d.docs.includes(pub.data.id));
  assert.deepEqual(d.gone, []);
  assert.equal(
    (await db.select().from(mbosDeletions).where(eq(mbosDeletions.entityId, pub.data.id))).length,
    0,
  );
});

test("a file past a megabyte is stored — the size every real price list is", async () => {
  /* The bug this screen shipped with: the upload was a server action, Next
   * refuses those past 1 MB before our code runs, and nothing caught it. */
  const head = new TextEncoder().encode("%PDF-1.4\n");
  const big = new Uint8Array(2.5 * 1024 * 1024);
  big.set(head, 0);
  const form = new FormData();
  form.set("file", new File([big], "catalogue.pdf", { type: "application/pdf" }));
  const res = await uploadRoute(new Request("http://test.local/api/sales/publish-file", { method: "POST", body: form }));
  const body = (await res.json()) as { ok: boolean; data?: { id: string; sizeBytes: number }; error?: string };
  assert.equal(res.status, 200, body.error);
  assert.ok(body.ok && body.data);
  assert.equal(body.data.sizeBytes, big.byteLength);

  const pub = await publishDocument({ title: "Catalogue", category: "catalogue", attachmentId: body.data.id });
  assert.ok(pub.ok, pub.ok ? "" : pub.error);
});

test("somebody without the Sales Dashboard cannot upload into the library", async () => {
  setTestUser(rahul);
  const form = new FormData();
  form.set("file", new File([new TextEncoder().encode("%PDF-1.4\n")], "x.pdf"));
  const res = await uploadRoute(new Request("http://test.local/api/sales/publish-file", { method: "POST", body: form }));
  assert.equal(res.status, 403);
  assert.equal((await db.select().from(attachments)).length, 0);
});
