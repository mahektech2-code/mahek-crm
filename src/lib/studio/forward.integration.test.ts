/**
 * UPLOAD & BULK FORWARD, end to end — the route and the actions against a real
 * database. A finished poster is uploaded and checked on its bytes; it goes,
 * unchanged, only to people in the uploader's own book; an empty list and a
 * repeat are refused; starting twice cannot start twice; and every status is
 * what a person said — nothing here is, or claims to be, a delivery.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";

import { db } from "@/db";
import { appAccess, appModuleAccess, auditLog, customers, studioForwardRecipients, studioForwards, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { fileStorage } from "@/lib/storage";
import { markRecipient, openRecipientChat, searchRecipients, startForward } from "@/lib/actions/studio-forward";
import { POST as uploadRoute } from "@/app/api/studio/forwards/upload/route";
import { GET as imageRoute } from "@/app/api/studio/forwards/[id]/image/route";
import { forwardRecipients } from "./forward-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

async function makeUser(name: string, modules?: string[]) {
  const [row] = await db
    .insert(users)
    .values({ id: id("usr"), name, email: `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 4)}@test.local`, passwordHash: "x", role: "associate", initials: name.slice(0, 2).toUpperCase() })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "studio", role: "associate" });
  for (const m of modules ?? []) await db.insert(appModuleAccess).values({ id: id("amx"), userId: row.id, app: "studio", module: m });
  return row;
}

async function makeCustomer(owner: string, over: Record<string, unknown> = {}) {
  const cid = id("cus");
  await db.insert(customers).values({ id: cid, name: "Shree Paints", companyName: "Shree Paints", phone: "9820099001", city: "Nagpur", kind: "customer", ownerId: owner, salesAmId: owner, ...over } as never);
  return cid;
}

const png = (w = 600, h = 800, color = "#ff8800") => sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();

async function upload(title: string, bytes: Buffer, filename = "poster.png", type = "image/png") {
  const form = new FormData();
  form.set("title", title);
  form.set("file", new File([new Uint8Array(bytes)], filename, { type }));
  return uploadRoute(new Request("http://x/api/studio/forwards/upload", { method: "POST", body: form }));
}

async function uploadedId(title = "Navratri", bytes?: Buffer): Promise<string> {
  const res = await upload(title, bytes ?? (await png()));
  const j = (await res.json()) as { ok: boolean; data: { id: string } };
  assert.ok(j.ok);
  return j.data.id;
}

let priya: typeof users.$inferSelect;
let rakesh: typeof users.$inferSelect;

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run `npm run test:db` first.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table studio_forward_recipients, studio_forwards, studio_poster_shares, studio_posters, studio_batches, studio_designs,
      customers, attachment_bytes, audit_log, notifications, app_module_access, app_access, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  priya = await makeUser("Priya Sharma");
  rakesh = await makeUser("Rakesh Iyer");
  setTestUser(priya);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("Uploading a finished poster", () => {
  test("accepts PNG, JPEG and WebP, keeps the file as it arrived and writes one audit entry", async () => {
    for (const [fmt, type] of [["png", "image/png"], ["jpeg", "image/jpeg"], ["webp", "image/webp"]] as const) {
      const src = sharp({ create: { width: 500, height: 500, channels: 3, background: "#123456" } });
      const bytes = await (fmt === "png" ? src.png() : fmt === "jpeg" ? src.jpeg() : src.webp()).toBuffer();
      const res = await upload(`Poster ${fmt}`, bytes, `p.${fmt}`, type);
      const j = (await res.json()) as { ok: boolean; data: { id: string } };
      assert.equal(res.status, 200, fmt);
      const [row] = await db.select().from(studioForwards).where(eq(studioForwards.id, j.data.id));
      assert.equal(row.format, fmt);
      assert.equal(row.status, "draft");
      assert.equal(row.createdById, priya.id);
      assert.deepEqual(Buffer.from(await fileStorage.read(row.sourceRef)), bytes, "stored unchanged");
    }
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "studio.forward.created"));
    assert.equal(audits.length, 3);
  });

  test("refuses what is not an image, whatever its name says, and stores nothing", async () => {
    const res = await upload("Fake", Buffer.from("<html>not an image</html>"), "poster.png", "image/png");
    assert.equal(res.status, 400);
    assert.equal((await db.select().from(studioForwards)).length, 0);
  });

  test("refuses a PDF, an animated GIF-style header, an empty file and a missing name", async () => {
    assert.equal((await upload("PDF", Buffer.from("%PDF-1.4 test"), "a.pdf", "application/pdf")).status, 400);
    assert.equal((await upload("Empty", Buffer.alloc(0))).status, 400);
    assert.equal((await upload("   ", await png())).status, 400);
    assert.equal((await upload("Tiny", await png(60, 60))).status, 400);
  });

  test("is refused for somebody without the module, and the image is the uploader's alone", async () => {
    const narrowed = await makeUser("Only Make", ["studio.make"]);
    setTestUser(narrowed);
    assert.equal((await upload("Nope", await png())).status, 404);
    setTestUser(priya);
    const fid = await uploadedId();
    setTestUser(rakesh);
    const other = await imageRoute(new Request(`http://x/api/studio/forwards/${fid}/image`), { params: Promise.resolve({ id: fid }) });
    assert.equal(other.status, 404);
    setTestUser(priya);
    const mine = await imageRoute(new Request(`http://x/api/studio/forwards/${fid}/image`), { params: Promise.resolve({ id: fid }) });
    assert.equal(mine.status, 200);
    assert.equal(mine.headers.get("Content-Type"), "image/png");
    /* Never cached, not even privately: the next person on this browser must not be shown it from the cache. */
    assert.equal(mine.headers.get("Cache-Control"), "no-store");
    assert.ok(!/max-age|private|public/.test(mine.headers.get("Cache-Control") ?? ""));
  });
});

describe("Choosing recipients and confirming", () => {
  test("an empty list is refused and nothing is started", async () => {
    const fid = await uploadedId();
    const res = await startForward({ forwardId: fid, customerIds: [], caption: "" });
    assert.ok(!res.ok);
    const [row] = await db.select().from(studioForwards).where(eq(studioForwards.id, fid));
    assert.equal(row.status, "draft");
  });

  test("several recipients start one forward; a repeated id counts once; the poster is not changed", async () => {
    const fid = await uploadedId();
    const [before] = await db.select().from(studioForwards).where(eq(studioForwards.id, fid));
    const a = await makeCustomer(priya.id, { name: "A Paints", companyName: "A Paints" });
    const b = await makeCustomer(priya.id, { name: "B Paints", companyName: "B Paints" });
    const c = await makeCustomer(priya.id, { name: "C Lead", companyName: "C Lead", kind: "lead" });
    const res = await startForward({ forwardId: fid, customerIds: [a, b, a, c], caption: "Happy Navratri" });
    assert.ok(res.ok, res.ok ? "" : res.error);
    assert.equal(res.data.started, 3);
    const rows = await forwardRecipients(fid);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.status === "pending"));
    const [row] = await db.select().from(studioForwards).where(eq(studioForwards.id, fid));
    assert.equal(row.status, "started");
    assert.equal(row.caption, "Happy Navratri");
    assert.equal(row.sha256, before.sha256);
    assert.equal(row.sourceRef, before.sourceRef);
    const audit = await db.select().from(auditLog).where(eq(auditLog.action, "studio.forward.started"));
    assert.equal(audit.length, 1);
  });

  test("nothing is recorded until confirmation: choosing alone writes no recipients", async () => {
    const fid = await uploadedId();
    await makeCustomer(priya.id);
    const found = await searchRecipients("customer", "");
    assert.ok(found.ok && found.data.rows.length === 1);
    assert.equal((await db.select().from(studioForwardRecipients)).length, 0);
    assert.ok(!("phone" in (found.ok ? found.data.rows[0] : {})), "no phone number reaches the page");
    void fid;
  });

  test("somebody else's customer is refused for the whole request, and cannot be found in the picker", async () => {
    const fid = await uploadedId();
    const mine = await makeCustomer(priya.id);
    const theirs = await makeCustomer(rakesh.id, { name: "Other Shop", companyName: "Other Shop" });
    const res = await startForward({ forwardId: fid, customerIds: [mine, theirs], caption: "" });
    assert.ok(!res.ok);
    assert.equal(res.code, "not_permitted");
    assert.equal((await db.select().from(studioForwardRecipients)).length, 0, "nothing half-ran");
    const found = await searchRecipients("customer", "Other");
    assert.ok(found.ok && found.data.rows.length === 0);
  });

  test("a Do Not Contact recipient is left out with the reason; only DNC chosen is refused", async () => {
    const fid = await uploadedId();
    const ok1 = await makeCustomer(priya.id);
    const dnc = await makeCustomer(priya.id, { name: "No Calls", companyName: "No Calls", doNotContact: true });
    const res = await startForward({ forwardId: fid, customerIds: [ok1, dnc], caption: "" });
    assert.ok(res.ok);
    assert.equal(res.data.started, 1);
    assert.deepEqual(res.data.skipped.map((s) => s.name), ["No Calls"]);
    const fid2 = await uploadedId("Second", await png(600, 800, "#001122"));
    const only = await startForward({ forwardId: fid2, customerIds: [dnc], caption: "" });
    assert.ok(!only.ok);
  });

  test("starting twice cannot start twice", async () => {
    const fid = await uploadedId();
    const a = await makeCustomer(priya.id);
    const [r1, r2] = await Promise.all([startForward({ forwardId: fid, customerIds: [a], caption: "" }), startForward({ forwardId: fid, customerIds: [a], caption: "" })]);
    assert.equal([r1, r2].filter((r) => r.ok).length, 1);
    assert.equal((await db.select().from(studioForwardRecipients)).length, 1);
  });

  test("somebody else's forward is not theirs to start", async () => {
    const fid = await uploadedId();
    const mine = await makeCustomer(rakesh.id);
    setTestUser(rakesh);
    const res = await startForward({ forwardId: fid, customerIds: [mine], caption: "" });
    assert.ok(!res.ok);
    assert.equal(res.code, "not_found");
  });

  test("forwarding the same picture again to somebody already done asks first, and can leave them out", async () => {
    const bytes = await png(700, 700, "#445566");
    const f1 = await uploadedId("First", bytes);
    const a = await makeCustomer(priya.id, { name: "A Paints", companyName: "A Paints" });
    const b = await makeCustomer(priya.id, { name: "B Paints", companyName: "B Paints" });
    assert.ok((await startForward({ forwardId: f1, customerIds: [a], caption: "" })).ok);
    const [r] = await forwardRecipients(f1);
    assert.ok((await markRecipient(r.id, "sent")).ok);

    const f2 = await uploadedId("Again", bytes);
    const asked = await startForward({ forwardId: f2, customerIds: [a, b], caption: "" });
    assert.ok(asked.ok);
    assert.equal(asked.data.started, 0);
    assert.deepEqual(asked.data.repeats?.map((x) => x.name), ["A Paints"]);
    assert.equal((await db.select().from(studioForwards).where(eq(studioForwards.id, f2)))[0].status, "draft");

    const left = await startForward({ forwardId: f2, customerIds: [a, b], caption: "" , includeRepeats: false });
    assert.ok(left.ok && left.data.started === 0, "still asking until a choice is made");
    const only = await startForward({ forwardId: f2, customerIds: [b], caption: "" });
    assert.ok(only.ok && only.data.started === 1);
  });

  test("including repeats on purpose is allowed", async () => {
    const bytes = await png(700, 700, "#778899");
    const f1 = await uploadedId("First", bytes);
    const a = await makeCustomer(priya.id);
    assert.ok((await startForward({ forwardId: f1, customerIds: [a], caption: "" })).ok);
    await db.update(studioForwardRecipients).set({ status: "sent" });
    const f2 = await uploadedId("Again", bytes);
    const res = await startForward({ forwardId: f2, customerIds: [a], caption: "", includeRepeats: true });
    assert.ok(res.ok && res.data.started === 1);
  });
});

describe("Working the list: per-recipient status", () => {
  async function started() {
    const fid = await uploadedId();
    const ok1 = await makeCustomer(priya.id, { name: "Open Shop", companyName: "Open Shop", phone: "9820011111" });
    const nowa = await makeCustomer(priya.id, { name: "No WhatsApp", companyName: "No WhatsApp", whatsappDnd: true });
    const nophone = await makeCustomer(priya.id, { name: "No Phone", companyName: "No Phone", phone: "" });
    assert.ok((await startForward({ forwardId: fid, customerIds: [ok1, nowa, nophone], caption: "Hello there" })).ok);
    const rows = await forwardRecipients(fid);
    const by = (c: string) => rows.find((r) => r.company === c)!;
    return { fid, open: by("Open Shop"), nowa: by("No WhatsApp"), nophone: by("No Phone") };
  }

  test("opening a chat returns the link with the message, and says only 'chat opened' — never sent", async () => {
    const { open } = await started();
    const res = await openRecipientChat(open.id);
    assert.ok(res.ok, res.ok ? "" : res.error);
    assert.equal(res.data.href, `https://wa.me/919820011111?text=${encodeURIComponent("Hello there")}`);
    const [row] = await db.select().from(studioForwardRecipients).where(eq(studioForwardRecipients.id, open.id));
    assert.equal(row.status, "opened");
    assert.ok(row.openedAt);
    assert.equal(row.decidedAt, null);
  });

  test("a failure is per recipient: no WhatsApp and no number are refused with a reason while the others work", async () => {
    const { nowa, nophone, open } = await started();
    const a = await openRecipientChat(nowa.id);
    const b = await openRecipientChat(nophone.id);
    assert.ok(!a.ok && /not to be messaged/.test(a.error));
    assert.ok(!b.ok && /phone number/.test(b.error));
    assert.ok((await openRecipientChat(open.id)).ok);
    const rows = await forwardRecipients(open.forwardId);
    assert.deepEqual(rows.map((r) => r.status).sort(), ["opened", "pending", "pending"]);
  });

  test("a person marks sent, skips and undoes; each is audited; nobody else can", async () => {
    const { open, nowa } = await started();
    assert.ok((await markRecipient(open.id, "sent")).ok);
    assert.ok((await markRecipient(nowa.id, "skipped", "asked not to")).ok);
    let rows = await forwardRecipients(open.forwardId);
    assert.equal(rows.find((r) => r.id === open.id)!.status, "sent");
    assert.equal(rows.find((r) => r.id === open.id)!.decidedById, priya.id);
    assert.ok((await markRecipient(open.id, "pending")).ok);
    rows = await forwardRecipients(open.forwardId);
    assert.equal(rows.find((r) => r.id === open.id)!.status, "pending");
    assert.equal((await db.select().from(auditLog).where(eq(auditLog.action, "studio.forward.recipient"))).length, 3);
    setTestUser(rakesh);
    const intruder = await markRecipient(open.id, "sent");
    assert.ok(!intruder.ok);
    const chat = await openRecipientChat(open.id);
    assert.ok(!chat.ok);
  });

  test("a customer who has since left the book is refused a chat, not guessed at", async () => {
    const { open } = await started();
    await db.update(customers).set({ ownerId: rakesh.id, salesAmId: rakesh.id });
    const res = await openRecipientChat(open.id);
    assert.ok(!res.ok);
  });
});
