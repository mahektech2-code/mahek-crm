"use server";

import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { users, type User } from "@/db/schema";
import { createSession, destroySession, getCurrentUser, hashPassword, verifyPassword } from "@/lib/auth";
import { listUserApps, recordSignIn, recordSignOut } from "@/lib/access";
import { findAccount, maskNumber, sendOtp, verifyOtp } from "@/lib/services/otp-service";
import { accountKey, clearSignInFailures, clientAddress, recordSignInFailure, signInRefusal } from "@/lib/services/sign-in-throttle";
import { erpId } from "@/lib/erp/server";
import { eq } from "drizzle-orm";
import { bootstrap, contextFor, factoryAudit, factoryContext, type FactoryCtx } from "@/lib/factory/server";
import { submitJob } from "@/lib/factory/post";
import { assignTask, changeTeam, decideReview, reportProblem, requestCorrection } from "@/lib/factory/head";
import type { FactoryData, Proc, Submission, SubmitResult, Team } from "@/lib/factory/types";
import { initialsOf } from "@/lib/format";

/* ---------------------------------------------------------------------------
 * The factory app's doors. Every one resolves who is asking from the session
 * and checks it here — a server action is a URL, and the phone's buttons are
 * not a permission.
 *
 * SIGNING IN IS A NUMBER AND A PIN. A mobile number the person knows, then
 * four digits — typing a password is exactly what this floor cannot do. A
 * forgotten PIN is an SMS code to the HRMS personal mobile (the same codes
 * the web sign-in sends), and then a new PIN. A badge only fills in WHO; the
 * PIN is still asked, so a badge found on the floor opens nothing.
 * ------------------------------------------------------------------------- */

export type Me = { key: string; n: string; ini: string; head: boolean; area: FactoryCtx["area"]; lang: FactoryCtx["lang"]; /** A supervisor's one department; absent or null is the whole floor. */ scope?: FactoryCtx["scope"] };
export type Who = { key: string; n: string; ini: string; ph: string; hasPin: boolean };
type Fail = { ok: false; error: string };
type SignedIn = { ok: true; me: Me; data: FactoryData; needPin: boolean };

const NOT_FOUND = "notFound";
const INACTIVE = "inactive";

function meOf(fc: FactoryCtx): Me {
  return { key: fc.user.id, n: fc.user.name, ini: initialsOf(fc.user.name), head: fc.head, area: fc.area, lang: fc.lang, scope: fc.scope };
}

async function whoFor(user: User, typed: string): Promise<{ ok: true; who: Who } | Fail> {
  if (!user.active) return { ok: false, error: INACTIVE };
  if (!(await listUserApps(user.id)).includes("factory")) return { ok: false, error: INACTIVE };
  const [s] = (await db.execute(sql`select pin_hash is not null as "hasPin" from factory_staff where user_id = ${user.id}`)) as unknown as { hasPin: boolean }[];
  const digits = (typed.replace(/\D/g, "") || (user.phone ?? "").replace(/\D/g, "")).slice(-10);
  return { ok: true, who: { key: user.id, n: user.name, ini: initialsOf(user.name), ph: digits, hasPin: !!s?.hasPin } };
}

/** Step one: whose number is this. Answers with the name and photo-initials so the person can say "that is me". */
export async function factoryFindPhone(phone: string): Promise<{ ok: true; who: Who } | Fail> {
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length !== 10) return { ok: false, error: "phone" };
  const address = await clientAddress();
  const refused = await signInRefusal(accountKey(null, digits), address);
  if (refused) return { ok: false, error: refused };
  const user = await findAccount(digits);
  if (!user) {
    await recordSignInFailure(accountKey(null, digits), address);
    return { ok: false, error: NOT_FOUND };
  }
  return whoFor(user, digits);
}

/** A badge QR: the factory badge code, or the HRMS employee code printed on the ID card. */
export async function factoryFindBadge(code: string): Promise<{ ok: true; who: Who } | Fail> {
  const c = String(code).trim();
  if (!c) return { ok: false, error: NOT_FOUND };
  const [row] = (await db.execute(sql`
    select u.id from users u
      left join factory_staff s on s.user_id = u.id
      left join employees e on e.id = u.employee_id
     where upper(s.badge_code) = upper(${c}) or upper(e.employee_code) = upper(${c})
     limit 1`)) as unknown as { id: string }[];
  if (!row) return { ok: false, error: NOT_FOUND };
  const [user] = await db.select().from(users).where(eq(users.id, row.id));
  return user ? whoFor(user, "") : { ok: false, error: NOT_FOUND };
}

async function enter(user: User, how: string): Promise<SignedIn | Fail> {
  const fc = await contextFor(user);
  if (!fc) return { ok: false, error: INACTIVE };
  await createSession(user.id, true, true);
  await recordSignIn(user.id, erpId("att"));
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  await factoryAudit(fc, "factory.sign-in", null, "Signed in · " + how);
  return { ok: true, me: meOf(fc), data: await bootstrap(fc), needPin: false };
}

export async function factorySignInPin(userId: string, pin: string): Promise<SignedIn | Fail> {
  const [user] = await db.select().from(users).where(eq(users.id, String(userId)));
  if (!user || !user.active) return { ok: false, error: INACTIVE };
  const account = accountKey(user.id, user.id);
  const address = await clientAddress();
  const refused = await signInRefusal(account, address);
  if (refused) return { ok: false, error: refused };
  const [s] = (await db.execute(sql`select pin_hash as "pinHash" from factory_staff where user_id = ${user.id}`)) as unknown as { pinHash: string | null }[];
  if (!s?.pinHash) return { ok: false, error: "noPin" };
  if (!/^\d{4}$/.test(String(pin)) || !(await verifyPassword(String(pin), s.pinHash))) {
    await recordSignInFailure(account, address);
    return { ok: false, error: "wrongPin" };
  }
  await clearSignInFailures(account);
  return enter(user, "PIN");
}

export async function factorySendCode(userId: string): Promise<{ ok: true; sentTo: string } | Fail> {
  const [user] = await db.select().from(users).where(eq(users.id, String(userId)));
  if (!user || !user.active) return { ok: false, error: INACTIVE };
  const sent = await sendOtp(user.id, "login", { surface: "web", requestedWith: "factory" });
  if (!sent.ok) return { ok: false, error: sent.error };
  return { ok: true, sentTo: sent.sentTo };
}

/** The code is the way in when the PIN is forgotten — and the next screen sets a new one. */
export async function factoryVerifyCode(userId: string, code: string): Promise<SignedIn | Fail> {
  const [user] = await db.select().from(users).where(eq(users.id, String(userId)));
  if (!user || !user.active) return { ok: false, error: INACTIVE };
  const v = await verifyOtp(user.id, "login", String(code));
  if (!v.ok) return { ok: false, error: v.error };
  const res = await enter(user, "SMS code");
  return res.ok ? { ...res, needPin: true } : res;
}

export async function factorySetPin(pin: string): Promise<{ ok: true } | Fail> {
  const fc = await factoryContext();
  if (!fc) return { ok: false, error: "Sign in again." };
  if (!/^\d{4}$/.test(String(pin))) return { ok: false, error: "Use 4 numbers." };
  if (/^(\d)\1{3}$/.test(pin) || pin === "1234") return { ok: false, error: "Too easy to guess. Choose other numbers." };
  const hash = await hashPassword(pin);
  await db.execute(sql`
    insert into factory_staff (user_id, area, pin_hash) values (${fc.user.id}, ${fc.head ? "head" : fc.area}, ${hash})
    on conflict (user_id) do update set pin_hash = excluded.pin_hash, updated_at = now()`);
  await factoryAudit(fc, "factory.pin", null, "Set a new PIN");
  return { ok: true };
}

export async function factorySetLang(lang: string): Promise<void> {
  const fc = await factoryContext();
  if (!fc || !["en", "hi", "mr"].includes(lang)) return;
  await db.execute(sql`update factory_staff set lang = ${lang}, updated_at = now() where user_id = ${fc.user.id}`);
}

export async function factorySignOut(): Promise<void> {
  const user = await getCurrentUser();
  if (user) {
    await recordSignOut(user.id);
    const fc = await contextFor(user);
    if (fc) await factoryAudit(fc, "factory.sign-out", null, "Signed out");
  }
  await destroySession();
}

/* ------------------------------------------------------------ the floor */

export async function factoryBootstrap(): Promise<{ ok: true; me: Me; data: FactoryData } | Fail> {
  const fc = await factoryContext();
  if (!fc) return { ok: false, error: "signedOut" };
  return { ok: true, me: meOf(fc), data: await bootstrap(fc) };
}

const draftSchema = z.object({
  key: z.string().regex(/^MOB-[\w-]{3,60}$/),
  taskId: z.string().min(1).max(40),
  savedAt: z.string().max(40),
  d: z.record(z.string(), z.unknown()),
});

export async function factorySubmit(sub: Submission): Promise<{ result: SubmitResult; data: FactoryData | null }> {
  const fc = await factoryContext();
  if (!fc) return { result: { kind: "failed", key: String(sub?.key ?? ""), title: "Please sign in again", text: "Nothing was saved.", fix: "Sign in, then send the job again. It is safe.", step: null }, data: null };
  const parsed = draftSchema.safeParse(sub);
  if (!parsed.success) return { result: { kind: "failed", key: String(sub?.key ?? ""), title: "This job could not be read", text: "Nothing was saved.", fix: "Start the job again from your list.", step: null }, data: null };
  const result = await submitJob(fc, sub);
  return { result, data: await bootstrap(fc) };
}

type Done = { ok: true; data: FactoryData; msg: string } | Fail;
async function headDo(fn: (fc: FactoryCtx) => Promise<{ ok: boolean; error?: string; message?: string }>): Promise<Done> {
  const fc = await factoryContext();
  if (!fc) return { ok: false, error: "Please sign in again." };
  const r = await fn(fc);
  if (!r.ok) return { ok: false, error: r.error ?? "That did not work." };
  return { ok: true, data: await bootstrap(fc), msg: r.message ?? "" };
}

export async function factoryAssign(a: { proc: Proc; item: string; qty: number; due: string }): Promise<Done> {
  return headDo((fc) => assignTask(fc, a));
}
export async function factoryChangeTeam(taskId: string, role: keyof Team, sel: string[]): Promise<Done> {
  return headDo((fc) => changeTeam(fc, taskId, role, sel));
}
export async function factoryReportProblem(taskId: string, reason: string, label: string): Promise<Done> {
  return headDo((fc) => reportProblem(fc, taskId, reason, label));
}
export async function factoryRequestCorrection(taskId: string, reason: string, label: string, rej?: number | null): Promise<Done> {
  return headDo((fc) => requestCorrection(fc, taskId, reason, label, rej));
}
export async function factoryDecide(id: string, act: string, actIndex: number, reason: string, helpers?: string[]): Promise<Done> {
  return headDo((fc) => decideReview(fc, id, act, actIndex, reason, helpers));
}

/** For the OTP screen's sentence, without sending anything. */
export async function factoryMasked(ph: string): Promise<string> {
  return maskNumber(ph);
}
