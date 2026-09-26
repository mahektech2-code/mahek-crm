/**
 * WhatsApp sign-in codes, end to end against a real database — Wati stubbed,
 * so the "sent" code is read off the stub instead of a phone.
 *
 * Pins: nothing is offered until an approved template is named · the code goes
 * to the account's own number · only a hash is stored · one use · wrong
 * guesses run out · it expires · resend cooldown · the handset signs in with a
 * code in place of the password · change and reset a password with a code.
 *
 * They need mahekone_test, which `npm run test:db` creates.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, authOtps, sessions, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { verifyPassword } from "@/lib/password";
import { invalidateConfig, seedConfig, updateSetting } from "@/lib/config/store";
import {
  forgetOtpAvailability,
  otpAvailability,
  resetPasswordWithOtp,
  sendOtp,
  verifyOtp,
} from "@/lib/services/otp-service";
import { runLoginChecks } from "@/lib/services/mbos-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const TEMPLATE = "mahekone_login_code";

let lastCode: string | null = null;
let lastPhone: string | null = null;
const realFetch = globalThis.fetch;

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run against mahekone_test.");
  process.env.WATI_API_TOKEN = "wati_test_token";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://live-mt-server.wati.io/")) return realFetch(input, init);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("/messageTemplates/send")) {
      const body = JSON.parse(String(init?.body));
      lastPhone = body.recipients[0].phone_number;
      lastCode = body.recipients[0].custom_params[0].value;
      return json({ success: true, recipients: [{ errors: [] }] });
    }
    if (url.includes("/messageTemplates")) {
      return json({
        templates: [{ name: TEMPLATE, status: "APPROVED", category: "AUTHENTICATION", body: "*{{1}}* is your verification code.", custom_params: [{ name: "1" }] }],
        total: 1,
      });
    }
    return json({});
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  setTestUser(null);
  await db.$client.end();
});

let priya: typeof users.$inferSelect;

beforeEach(async () => {
  await db.execute(sql`truncate table auth_otps, sessions, app_access, audit_log, users, app_settings restart identity cascade`);
  invalidateConfig();
  await seedConfig();
  forgetOtpAvailability();
  lastCode = null;
  lastPhone = null;
  [priya] = await db
    .insert(users)
    .values({ id: id("usr"), name: "Priya", email: "priya@t.local", phone: "9820011001", passwordHash: "scrypt$00$00", role: "associate", initials: "PR" })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: priya.id, app: "field", role: "associate" });
});

async function configure() {
  await updateSetting("auth.otp.whatsappTemplateName", TEMPLATE, priya.id);
  invalidateConfig();
  forgetOtpAvailability();
}

test("nothing is offered until an approved template is named", async () => {
  assert.equal((await otpAvailability()).available, false);
  const r = await sendOtp(priya.id, "login");
  assert.equal(r.ok, false);
  assert.equal(lastCode, null, "Wati was never asked to send");
});

test("a code goes to the account's own number, and only its hash is stored", async () => {
  await configure();
  const r = await sendOtp(priya.id, "login");
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  assert.equal(lastPhone, "919820011001");
  assert.match(lastCode ?? "", /^\d{6}$/);
  if (r.ok) assert.equal(r.sentTo, "+91 98•••••001");
  const [row] = await db.select().from(authOtps).where(eq(authOtps.userId, priya.id));
  assert.notEqual(row.codeHash, lastCode, "the code itself is never stored");
  assert.ok(row.sentAt);
});

test("the right code works once; the same code a second time does not", async () => {
  await configure();
  await sendOtp(priya.id, "login");
  assert.deepEqual(await verifyOtp(priya.id, "login", lastCode!), { ok: true });
  const again = await verifyOtp(priya.id, "login", lastCode!);
  assert.equal(again.ok, false);
});

test("a code for one purpose does not unlock another", async () => {
  await configure();
  await sendOtp(priya.id, "login");
  assert.equal((await verifyOtp(priya.id, "password_change", lastCode!)).ok, false);
});

test("wrong guesses run out, and then even the right code is refused", async () => {
  await configure();
  await sendOtp(priya.id, "login");
  const wrong = lastCode === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) await verifyOtp(priya.id, "login", wrong);
  const r = await verifyOtp(priya.id, "login", lastCode!);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /Too many wrong tries/);
});

test("an expired code is refused and says to ask again", async () => {
  await configure();
  await sendOtp(priya.id, "login");
  await db.update(authOtps).set({ expiresAt: new Date(Date.now() - 1000) });
  const r = await verifyOtp(priya.id, "login", lastCode!);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /expired/);
});

test("asking again straight away is refused with how long to wait", async () => {
  await configure();
  await sendOtp(priya.id, "login");
  const r = await sendOtp(priya.id, "login");
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok((r.retryInSeconds ?? 0) > 0);
});

test("an account with no mobile number is told to use the password", async () => {
  await configure();
  await db.update(users).set({ phone: null }).where(eq(users.id, priya.id));
  const r = await sendOtp(priya.id, "login");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /no mobile number/i);
});

test("the handset signs in with a code in place of the password, and a wrong one is refused", async () => {
  await configure();
  await sendOtp(priya.id, "login");
  const bad = await runLoginChecks({ mobile: "9820011001", otp: "000001" === lastCode ? "000002" : "000001" });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.step, "bad_otp");
  const good = await runLoginChecks({ mobile: "9820011001", otp: lastCode! });
  assert.equal(good.ok, true);
});

test("changing a password takes a WhatsApp code once codes are set up", async () => {
  const { changePassword, sendPasswordChangeCode } = await import("@/lib/actions/account");
  await configure();
  setTestUser(priya);
  const sent = await sendPasswordChangeCode();
  assert.equal(sent.ok, true, sent.ok ? "" : sent.error);

  const noCode = new FormData();
  noCode.set("password", "newpass123");
  noCode.set("confirm", "newpass123");
  assert.equal((await changePassword(null, noCode)).ok, false, "no code, no change");

  const withCode = new FormData();
  withCode.set("code", lastCode!);
  withCode.set("password", "newpass123");
  withCode.set("confirm", "newpass123");
  const r = await changePassword(null, withCode);
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  const [row] = await db.select().from(users).where(eq(users.id, priya.id));
  assert.equal(await verifyPassword("newpass123", row.passwordHash), true);
});

test("a forgotten password is reset with a code, and every session ends", async () => {
  await configure();
  await db.insert(sessions).values({ id: "sess_x", userId: priya.id, expiresAt: new Date(Date.now() + 3_600_000) });
  await sendOtp(priya.id, "password_reset");
  assert.equal((await resetPasswordWithOtp(priya.id, "000000" === lastCode ? "111111" : "000000", "x".repeat(9))).ok, false);
  const r = await resetPasswordWithOtp(priya.id, lastCode!, "brandnew99");
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  assert.equal((await db.select().from(sessions).where(eq(sessions.userId, priya.id))).length, 0);
  const [row] = await db.select().from(users).where(eq(users.id, priya.id));
  assert.equal(await verifyPassword("brandnew99", row.passwordHash), true);
});
