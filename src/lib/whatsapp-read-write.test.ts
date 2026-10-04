/**
 * WHATSAPP READ AND WRITE — what the Access screen's select actually decides.
 *
 * The composer not being drawn is the courtesy half. These pin the half that
 * matters: a person narrowed to Read is refused by the ACTIONS, from either app,
 * and nobody who held WhatsApp before the level existed lost anything.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, appModuleAccess, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { whatsappLevel } from "@/lib/access";
import { markThreadHandled, sendChatMessage, setCustomerGroup } from "@/lib/actions/crm";
import { moduleKeysForApp } from "@/lib/modules";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

async function person(
  grants: Array<{ app: "crm" | "accounts"; modules?: string[] }>,
): Promise<typeof users.$inferSelect> {
  const [u] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name: "Reader",
      email: `r-${randomUUID().slice(0, 6)}@test.local`,
      passwordHash: "x",
      role: "associate",
      initials: "RE",
    })
    .returning();
  for (const g of grants) {
    await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app: g.app, role: "associate" });
    for (const module of g.modules ?? []) {
      await db.insert(appModuleAccess).values({ id: id("ama"), userId: u.id, app: g.app, module });
    }
  }
  return u;
}

/** Every screen of an app with its WhatsApp write level left out. */
const readOnly = (app: "crm" | "accounts") =>
  moduleKeysForApp(app).filter((k) => k !== `${app}.whatsapp-reply`);

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/);
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table app_module_access, app_access, sessions, audit_log, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

test("a whole-app grant is write — nothing anybody held moved", async () => {
  const u = await person([{ app: "crm" }]);
  assert.equal(await whatsappLevel(u.id), "write");
});

test("narrowed to the screen without its write level is read", async () => {
  const u = await person([{ app: "crm", modules: readOnly("crm") }]);
  assert.equal(await whatsappLevel(u.id), "read");
});

test("Accounts opens WhatsApp too, at either level", async () => {
  assert.equal(await whatsappLevel((await person([{ app: "accounts" }])).id), "write");
  assert.equal(
    await whatsappLevel((await person([{ app: "accounts", modules: readOnly("accounts") }])).id),
    "read",
  );
});

test("write in one app is write — what somebody may DO is the union", async () => {
  const u = await person([{ app: "crm" }, { app: "accounts", modules: readOnly("accounts") }]);
  assert.equal(await whatsappLevel(u.id), "write");
});

test("holding neither screen is none, not read", async () => {
  const u = await person([{ app: "crm", modules: ["crm.payments"] }]);
  assert.equal(await whatsappLevel(u.id), "none");
});

test("a reader is refused by the actions, not only by a hidden composer", async () => {
  const u = await person([{ app: "crm", modules: readOnly("crm") }]);
  setTestUser(u);
  const reply = await sendChatMessage({ key: "c:anything", text: "hello", idempotencyKey: randomUUID() });
  assert.equal(reply.ok, false);
  assert.equal(!reply.ok && reply.code, "not_permitted");
  const handled = await markThreadHandled("c:anything");
  assert.equal(!handled.ok && handled.code, "not_permitted");
  const group = await setCustomerGroup("nobody", "Group");
  assert.equal(!group.ok && group.code, "not_permitted");
});

test("somebody never given the chats is not refused a reminder by this rule", async () => {
  /* The payment panel sends reminders without the WhatsApp screen, and always
     could. The customer does not exist, so the refusal that comes back is
     the action's own — not `not_permitted` from the read-only rule. */
  const u = await person([{ app: "crm", modules: ["crm.payments"] }]);
  setTestUser(u);
  const group = await setCustomerGroup("nobody", "Group");
  assert.equal(group.ok, false);
  assert.notEqual(!group.ok && group.code, "not_permitted");
});
