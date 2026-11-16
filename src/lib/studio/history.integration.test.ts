/**
 * POSTER FORWARDING HISTORY on My posters, against a real database. One row per made poster (however many shares), one row
 * per recipient of an uploaded poster in a STARTED list — never both, never twice. Making a poster is not forwarding it;
 * "Not Started" is only for a recipient who was actually selected; nothing is a delivery. Uploaded forwards stay with their
 * uploader; a recipient outside the viewer's book is omitted; a removed CRM record keeps its stored snapshot.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";

import { db } from "@/db";
import { appAccess, appModuleAccess, customers, studioForwardRecipients, studioForwards, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { makeBatch, makePoster, recordShare } from "@/lib/actions/studio";
import { markRecipient, openRecipientChat, startForward } from "@/lib/actions/studio-forward";
import { POST as uploadRoute } from "@/app/api/studio/forwards/upload/route";
import { GET as imageRoute } from "@/app/api/studio/forwards/[id]/image/route";
import { HISTORY_PAGE, parseFilters } from "./domain/history";
import { historyPage, historyPanel, historyRow } from "./history-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

async function makeUser(name: string, role: "associate" | "manager", over: { modules?: string[]; reportsTo?: string } = {}) {
  const [row] = await db
    .insert(users)
    .values({ id: id("usr"), name, email: `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 4)}@test.local`, passwordHash: "x", role, initials: name.slice(0, 2).toUpperCase(), reportsToId: over.reportsTo ?? null })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "studio", role });
  for (const m of over.modules ?? []) await db.insert(appModuleAccess).values({ id: id("amx"), userId: row.id, app: "studio", module: m });
  return row;
}

async function makeCustomer(owner: string, name = "Shree Paints", over: Record<string, unknown> = {}) {
  const cid = id("cus");
  await db.insert(customers).values({ id: cid, name, companyName: name, phone: `98${Math.floor(10000000 + Math.random() * 89999999)}`, city: "Nagpur", kind: "customer", ownerId: owner, salesAmId: owner, ...over } as never);
  return cid;
}

const png = (color = "#ff8800") => sharp({ create: { width: 600, height: 800, channels: 3, background: color } }).png().toBuffer();

async function uploadForward(title: string, bytes: Buffer): Promise<string> {
  const form = new FormData();
  form.set("title", title);
  form.set("file", new File([new Uint8Array(bytes)], "poster.png", { type: "image/png" }));
  const res = await uploadRoute(new Request("http://x/api/studio/forwards/upload", { method: "POST", body: form }));
  const j = (await res.json()) as { ok: boolean; data: { id: string } };
  assert.ok(j.ok);
  return j.data.id;
}

async function startedForward(title: string, customerIds: string[], bytes?: Buffer): Promise<string> {
  const fid = await uploadForward(title, bytes ?? (await png()));
  const r = await startForward({ forwardId: fid, customerIds, caption: "Hello" });
  assert.ok(r.ok && r.data.started === customerIds.length, r.ok ? "" : r.error);
  return fid;
}

const q = (over: Record<string, string> = {}) => parseFilters(over);
const recipientRowKey = async (fid: string, customerId: string) => {
  const [r] = await db.select().from(studioForwardRecipients).where(eq(studioForwardRecipients.forwardId, fid));
  void customerId;
  return `f:${r.id}`;
};

let priya: typeof users.$inferSelect;
let rakesh: typeof users.$inferSelect;
let vikram: typeof users.$inferSelect;

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
  vikram = await makeUser("Vikram Shah", "manager");
  priya = await makeUser("Priya Sharma", "associate", { reportsTo: vikram.id });
  rakesh = await makeUser("Rakesh Iyer", "associate");
  setTestUser(priya);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

const make = async (customerId: string) => {
  const r = await makePoster({ customerId, templateId: "diwali-classic", language: "en", showProduct: true });
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.data.id;
};

describe("a made poster", () => {
  test("is one row, 'Not forwarded' (not Not Started) until WhatsApp is opened from it", async () => {
    const cid = await makeCustomer(priya.id);
    const pid = await make(cid);
    const page = await historyPage(q(), "mine");
    assert.equal(page.total, 1);
    assert.equal(page.rows[0].key, `p:${pid}`);
    assert.equal(page.rows[0].status, "not_forwarded");
    assert.equal(page.rows[0].mode, "individual");
    assert.equal(page.rows[0].actionAt, null);
  });

  test("downloads and phone shares are not forwarding; WhatsApp opens are, and many opens are still ONE row", async () => {
    const cid = await makeCustomer(priya.id);
    const pid = await make(cid);
    await recordShare(pid, "download", "png");
    await recordShare(pid, "device", "jpeg");
    assert.equal((await historyPage(q(), "mine")).rows[0].status, "not_forwarded");
    await recordShare(pid, "whatsapp");
    await recordShare(pid, "whatsapp");
    await recordShare(pid, "whatsapp");
    const page = await historyPage(q(), "mine");
    assert.equal(page.total, 1, "three opens are one row");
    assert.equal(page.rows[0].status, "opened");
    assert.equal(page.rows[0].opens, 3);
    assert.ok(page.rows[0].actionAt);
  });

  test("the panel timeline lists the poster being made and each WhatsApp open; downloads and phone shares are notes, not forwarding", async () => {
    const cid = await makeCustomer(priya.id);
    const pid = await make(cid);
    await recordShare(pid, "download", "png");
    await recordShare(pid, "whatsapp");
    const panel = await historyPanel(`p:${pid}`, "mine");
    assert.ok(panel);
    assert.deepEqual(panel.timeline.map((t) => t.text), ["Poster made (not a forwarding)", "Opened WhatsApp"]);
    assert.deepEqual(panel.notes.map((n) => n.text), ["Downloaded"]);
  });
});

describe("a bulk-created poster run", () => {
  test("creating the run is not forwarding: every poster shows 'Not forwarded' until WhatsApp is opened from it", async () => {
    const a = await makeCustomer(priya.id, "Anand Colours");
    const b = await makeCustomer(priya.id, "Kiran Hardware");
    const made = await makeBatch({ list: "customer", templateId: "diwali-classic", language: "en", showProduct: true, customerIds: [a, b] });
    assert.ok(made.ok, made.ok ? "" : made.error);
    let page = await historyPage(q(), "mine");
    assert.equal(page.total, 2);
    assert.ok(page.rows.every((r) => r.mode === "bulk_run" && r.status === "not_forwarded"));
    const first = page.rows.find((r) => r.company === "Anand Colours")!;
    await recordShare(first.refId, "whatsapp");
    page = await historyPage(q(), "mine");
    assert.equal(page.rows.find((r) => r.company === "Anand Colours")!.status, "opened");
    assert.equal(page.rows.find((r) => r.company === "Kiran Hardware")!.status, "not_forwarded");
    const panel = await historyPanel(first.key, "mine");
    assert.equal(panel!.run.length, 2, "the whole run is listed");
    assert.equal(panel!.run.find((x) => x.current)!.company, "Anand Colours");
    assert.ok(panel!.run.every((x) => x.status !== "pending"), "nobody in a poster run is 'Not Started'");
  });
});

describe("an uploaded poster", () => {
  test("a draft list has no rows; a started list has one row per selected recipient, each Not Started until touched", async () => {
    const a = await makeCustomer(priya.id, "Om Traders");
    const b = await makeCustomer(priya.id, "Kiran Hardware");
    await uploadForward("Festive", await png());
    assert.equal((await historyPage(q(), "mine")).total, 0, "an unstarted upload is nothing yet");
    await startedForward("Festive 2", [a, b]);
    const page = await historyPage(q(), "mine");
    assert.equal(page.total, 2);
    assert.ok(page.rows.every((r) => r.kind === "forward" && r.mode === "bulk_upload" && r.status === "pending"));
  });

  test("status follows what the person did — chat opened, marked sent, skipped — and never claims delivery", async () => {
    const a = await makeCustomer(priya.id, "Om Traders");
    const b = await makeCustomer(priya.id, "Kiran Hardware");
    const c = await makeCustomer(priya.id, "Jai Hardware");
    const fid = await startedForward("Festive", [a, b, c]);
    const recs = await db.select().from(studioForwardRecipients).where(eq(studioForwardRecipients.forwardId, fid));
    const by = (cid: string) => recs.find((r) => r.customerId === cid)!;
    assert.ok((await openRecipientChat(by(a).id)).ok);
    assert.ok((await markRecipient(by(b).id, "sent")).ok);
    assert.ok((await markRecipient(by(c).id, "skipped")).ok);
    const page = await historyPage(q(), "mine");
    const status = (name: string) => page.rows.find((r) => r.company === name)!.status;
    assert.equal(status("Om Traders"), "opened");
    assert.equal(status("Kiran Hardware"), "sent");
    assert.equal(status("Jai Hardware"), "skipped");
  });

  test("the panel shows the timeline, everyone in the run, and other runs of the same picture", async () => {
    const a = await makeCustomer(priya.id, "Om Traders");
    const b = await makeCustomer(priya.id, "Kiran Hardware");
    const bytes = await png("#112233");
    const first = await startedForward("Festive", [a, b], bytes);
    await startedForward("Festive again", [a], bytes);
    const recs = await db.select().from(studioForwardRecipients).where(eq(studioForwardRecipients.forwardId, first));
    const rec = recs.find((r) => r.customerId === a)!;
    await openRecipientChat(rec.id);
    await markRecipient(rec.id, "sent");
    const panel = await historyPanel(`f:${rec.id}`, "mine");
    assert.ok(panel);
    assert.deepEqual(panel.timeline.map((t) => t.text), ["Selected in the forwarding list", "Chat opened", "Marked sent by Priya Sharma"]);
    assert.equal(panel.run.length, 2);
    assert.equal(panel.otherRuns.length, 1);
    assert.equal(panel.otherRuns[0].people, 1);
  });

  test("a different picture is not 'the same picture'", async () => {
    const a = await makeCustomer(priya.id);
    const first = await startedForward("One", [a], await png("#111111"));
    await startedForward("Two", [a], await png("#999999"));
    const [rec] = await db.select().from(studioForwardRecipients).where(eq(studioForwardRecipients.forwardId, first));
    assert.equal((await historyPanel(`f:${rec.id}`, "mine"))!.otherRuns.length, 0);
  });
});

describe("no duplicate rows", () => {
  test("rows = made posters + started-list recipients, every key unique across pages", async () => {
    const owned: string[] = [];
    for (let i = 0; i < 34; i++) owned.push(await makeCustomer(priya.id, `Shop ${String(i).padStart(2, "0")}`));
    const made = await makeBatch({ list: "customer", templateId: "diwali-classic", language: "en", showProduct: true, customerIds: owned.slice(0, 33) });
    assert.ok(made.ok, made.ok ? "" : made.error);
    const single = await make(owned[33]);
    await recordShare(single, "whatsapp");
    await recordShare(single, "whatsapp");
    await startedForward("Upload", owned.slice(0, 6));
    const seen = new Set<string>();
    let total = 0;
    const pages = (await historyPage(q(), "mine")).pageCount;
    assert.equal(pages, 2);
    for (let p = 1; p <= pages; p++) {
      const page = await historyPage(q({ page: String(p) }), "mine");
      total = page.total;
      for (const r of page.rows) {
        assert.ok(!seen.has(r.key), `duplicate ${r.key}`);
        seen.add(r.key);
      }
    }
    assert.equal(total, 33 + 1 + 6);
    assert.equal(seen.size, 40);
    assert.equal((await historyPage(q({ page: "1" }), "mine")).rows.length, HISTORY_PAGE);
  });

  test("the same recipient in two sessions of one picture is two rows (two real actions)", async () => {
    const a = await makeCustomer(priya.id);
    const bytes = await png("#445566");
    await startedForward("One", [a], bytes);
    await startedForward("Two", [a], bytes);
    assert.equal((await historyPage(q(), "mine")).total, 2);
  });
});

describe("who sees which rows", () => {
  test("a manager's My team's shows the team's made posters; Mine does not; uploaded forwards are never shown to anybody but the uploader", async () => {
    const cid = await makeCustomer(priya.id);
    await make(cid);
    const fid = await startedForward("Festive", [cid]);
    setTestUser(vikram);
    const team = await historyPage(q(), "team");
    assert.equal(team.canTeam, true);
    assert.deepEqual(team.rows.map((r) => r.kind), ["poster"], "the team's made poster only");
    assert.equal((await historyPage(q(), "mine")).total, 0, "not the manager's own");
    const [rec] = await db.select().from(studioForwardRecipients).where(eq(studioForwardRecipients.forwardId, fid));
    assert.equal(await historyRow(`f:${rec.id}`, "team"), null);
    assert.equal(await historyRow(`f:${rec.id}`, "mine"), null);
    assert.equal(await historyPanel(`f:${rec.id}`, "team"), null);
    setTestUser(priya);
    assert.equal((await historyPage(q(), "mine")).total, 2, "the uploader sees her poster and her recipient");
  });

  test("somebody with no team has no My team's: asking for it still answers within her own sight", async () => {
    const cid = await makeCustomer(priya.id);
    await make(cid);
    const page = await historyPage(q(), "team");
    assert.equal(page.canTeam, false);
    assert.equal(page.total, 1);
    setTestUser(rakesh);
    assert.equal((await historyPage(q(), "team")).total, 0, "a colleague outside her reporting line sees nothing of hers");
  });

  test("somebody else's poster and forward row answer exactly like ones that do not exist", async () => {
    const cid = await makeCustomer(priya.id);
    const pid = await make(cid);
    const fid = await startedForward("Festive", [cid]);
    const [rec] = await db.select().from(studioForwardRecipients).where(eq(studioForwardRecipients.forwardId, fid));
    setTestUser(rakesh);
    for (const key of [`p:${pid}`, `f:${rec.id}`, "p:nope", "f:nope"]) {
      assert.equal(await historyRow(key, "mine"), null);
      assert.equal(await historyRow(key, "team"), null);
      assert.equal(await historyPanel(key, "mine"), null);
    }
    assert.equal((await historyPage(q(), "mine")).total, 0);
  });

  test("a malformed key is refused before the database is asked", async () => {
    assert.equal(await historyRow("p:a'; drop table users; --", "mine"), null);
    assert.equal(await historyPanel("zzz", "mine"), null);
  });

  test("without the Upload & Bulk Forward module, uploaded rows are not listed", async () => {
    const narrowed = await makeUser("Meena Rao", "associate", { modules: ["studio.home", "studio.posters", "studio.make"] });
    const cid = await makeCustomer(narrowed.id);
    setTestUser(priya);
    await startedForward("Festive", [await makeCustomer(priya.id)]);
    setTestUser(narrowed);
    await make(cid);
    const page = await historyPage(q(), "mine");
    assert.deepEqual(page.rows.map((r) => r.kind), ["poster"]);
  });
});

describe("CRM record scope and removed records", () => {
  test("a recipient who has since moved out of the viewer's book is omitted — from the list, the count and the panel", async () => {
    const a = await makeCustomer(priya.id, "Om Traders");
    const b = await makeCustomer(priya.id, "Kiran Hardware");
    const fid = await startedForward("Festive", [a, b]);
    const recs = await db.select().from(studioForwardRecipients).where(eq(studioForwardRecipients.forwardId, fid));
    const gone = recs.find((r) => r.customerId === a)!;
    const kept = recs.find((r) => r.customerId === b)!;
    await db.update(customers).set({ ownerId: rakesh.id, salesAmId: rakesh.id }).where(eq(customers.id, a));
    const page = await historyPage(q(), "mine");
    assert.equal(page.total, 1);
    assert.equal(page.rows[0].company, "Kiran Hardware");
    assert.equal(await historyRow(`f:${gone.id}`, "mine"), null);
    const panel = await historyPanel(`f:${kept.id}`, "mine");
    assert.deepEqual(panel!.run.map((x) => x.company), ["Kiran Hardware"], "the run list never names the one outside the book");
    assert.ok(!JSON.stringify(panel).includes("Om Traders"));
    assert.equal((await historyPage(q({ q: "Om Traders" }), "mine")).total, 0, "search cannot find it either");
  });

  test("a removed CRM record keeps the stored snapshot, marked 'Record removed', where the row is visible", async () => {
    const a = await makeCustomer(priya.id, "Om Traders");
    const pcid = await makeCustomer(priya.id, "Anand Colours");
    const pid = await make(pcid);
    await startedForward("Festive", [a]);
    await db.delete(customers).where(eq(customers.id, a));
    await db.delete(customers).where(eq(customers.id, pcid));
    const page = await historyPage(q(), "mine");
    assert.equal(page.total, 2);
    for (const r of page.rows) {
      assert.equal(r.recordRemoved, true);
      assert.equal(r.customerId, null);
    }
    assert.deepEqual(page.rows.map((r) => r.company).sort(), ["Anand Colours", "Om Traders"]);
    assert.ok(await historyPanel(`p:${pid}`, "mine"));
  });
});

describe("search and filters", () => {
  async function seed() {
    const a = await makeCustomer(priya.id, "Om Traders");
    const b = await makeCustomer(priya.id, "Kiran Hardware");
    const c = await makeCustomer(priya.id, "Anand Colours");
    const pid = await make(c);
    await recordShare(pid, "whatsapp");
    const fid = await startedForward("Festive Offer", [a, b]);
    const recs = await db.select().from(studioForwardRecipients).where(eq(studioForwardRecipients.forwardId, fid));
    await markRecipient(recs.find((r) => r.customerId === a)!.id, "sent");
    return { pid };
  }

  test("search, poster, recipient, mode, status, show and date range", async () => {
    await seed();
    const names = async (o: Record<string, string>) => (await historyPage(q(o), "mine")).rows.map((r) => r.company).sort();
    assert.deepEqual(await names({ q: "om" }), ["Om Traders"]);
    assert.deepEqual(await names({ q: "festive" }), ["Kiran Hardware", "Om Traders"]);
    assert.deepEqual(await names({ poster: "diwali" }), ["Anand Colours"]);
    assert.deepEqual(await names({ recipient: "kiran" }), ["Kiran Hardware"]);
    assert.deepEqual(await names({ mode: "bulk_upload" }), ["Kiran Hardware", "Om Traders"]);
    assert.deepEqual(await names({ mode: "individual" }), ["Anand Colours"]);
    assert.deepEqual(await names({ status: "sent" }), ["Om Traders"]);
    assert.deepEqual(await names({ status: "pending" }), ["Kiran Hardware"]);
    assert.deepEqual(await names({ status: "opened" }), ["Anand Colours"]);
    assert.equal((await names({ status: "not_forwarded" })).length, 0);
    assert.equal((await names({ show: "forwarded" })).length, 3);
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    assert.equal((await names({ from: today, to: today })).length, 3);
    assert.equal((await names({ from: "2999-01-01" })).length, 0);
    assert.equal((await names({ to: "2000-01-01" })).length, 0);
  });

  test("a filter that matches nothing is an empty page, not an error; LIKE wildcards are literal", async () => {
    await seed();
    const none = await historyPage(q({ q: "zzzz" }), "mine");
    assert.equal(none.total, 0);
    assert.deepEqual(none.rows, []);
    assert.equal(none.pageCount, 1);
    assert.equal((await historyPage(q({ q: "%" }), "mine")).total, 0, "% is not a wildcard");
  });

  test("the user filter narrows My team's only to people in scope", async () => {
    const c = await makeCustomer(priya.id);
    await make(c);
    setTestUser(vikram);
    assert.equal((await historyPage(q({ user: priya.id }), "team")).total, 1);
    assert.equal((await historyPage(q({ user: rakesh.id }), "team")).total, 0);
    const team = await historyPage(q(), "team");
    assert.deepEqual(team.people.map((p) => p.name), ["Priya Sharma"]);
  });

  test("an empty book is an empty page", async () => {
    const page = await historyPage(q(), "mine");
    assert.deepEqual([page.total, page.rows.length, page.pageCount], [0, 0, 1]);
  });
});

describe("the uploaded picture's thumbnail", () => {
  test("?thumb=1 is a small JPEG, never cached, and only the uploader gets it", async () => {
    const a = await makeCustomer(priya.id);
    const fid = await startedForward("Festive", [a]);
    const call = () => imageRoute(new Request(`http://x/api/studio/forwards/${fid}/image?thumb=1`), { params: Promise.resolve({ id: fid }) });
    const mine = await call();
    assert.equal(mine.status, 200);
    assert.equal(mine.headers.get("Content-Type"), "image/jpeg");
    assert.equal(mine.headers.get("Cache-Control"), "no-store");
    const meta = await sharp(Buffer.from(await mine.arrayBuffer())).metadata();
    assert.ok((meta.width ?? 999) <= 160);
    setTestUser(rakesh);
    assert.equal((await call()).status, 404);
  });
});

void studioForwards;
void recipientRowKey;
