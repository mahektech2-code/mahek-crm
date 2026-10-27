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
import { bootstrap, contextFor, erpCtxFor, factoryAudit, factoryContext, textArray, type FactoryCtx } from "@/lib/factory/server";
import { saveCheckReason, saveOfficeCount, saveStockCheck, stockKit } from "@/lib/factory/counts";
import { qcKit, saveQcDecision } from "@/lib/factory/qc";
import { cancelFromFloor, raiseFromFloor, requirementKit } from "@/lib/factory/purchase";
import { submitJob } from "@/lib/factory/post";
import { assignTask, changeTeam, decideReview, reportProblem, requestCorrection, startFillFromLot, startMixingBatch, startPackFromLot } from "@/lib/factory/head";
import type { LorryBoard, LorryFind, LorryScan, QcInput, QcKit, QcSave, ReqInput, ReqKit, ReqSave } from "@/lib/factory/types";
import { lorryBoard, lorryDecide, lorryFind, lorryOverride, lorryScan, lorryUnload } from "@/lib/factory/lorry";
import type { BoxInfo, BoxScan, CountInput, DrumExisting, StockCheckInput, StockKit, StockSave, DrumLookup, DrumSave, FactoryData, LoadBoard, LrFields, LrBatchSave, LrKit, LrReading, LrSave, Proc, Submission, SubmitResult, Team } from "@/lib/factory/types";
import { boxInfo, loadBoard, lrKit, readLr, saveLr, saveLrPhotos, scanBox, unloadBox } from "@/lib/factory/dispatch";
import { readStoredLrs } from "@/lib/erp/lr-upload-read";
import { after } from "next/server";
import { findDrumLot, lotRefusal, recordEmptyDrum, type DrumLot } from "@/lib/erp/drums";
import { DRUM_STATUS_LABEL, OWNERSHIP_LABEL, drumLabel } from "@/lib/erp/engines/drums";
import { getConfig } from "@/lib/config/store";
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

export type Me = {
  key: string;
  n: string;
  ini: string;
  head: boolean;
  /** Their home department. */
  area: FactoryCtx["area"];
  /**
   * Every department they work in. More than one draws the department
   * switcher; absent on an older server, read as `[area]`.
   */
  areas?: FactoryCtx["areas"];
  lang: FactoryCtx["lang"];
  /** A supervisor's one department; absent or null is the whole floor. Kept for phones built before `scopes`. */
  scope?: FactoryCtx["scope"];
  /** A supervisor's departments; null is the whole floor. Absent on an older server, read from `scope`. */
  scopes?: FactoryCtx["scopes"];
  /** Records empty drums from the phone. Absent on an older server: no drum entry is offered. */
  drums?: boolean;
  /** Loads boxes and uploads LRs. Absent on an older server: neither is offered. */
  dispatch?: boolean;
  /** Checks stock — every department. Absent on an older server: no Stock check screen is offered. */
  counts?: boolean;
  /** Decides SFG lots' QC with the Testing list. Absent on an older server: no Quality check screen is offered. */
  qc?: boolean;
  /** The departments they raise purchase requirements for — in charge, a supervisor over it, or the Production Head. Absent or empty: none is offered. */
  reqs?: FactoryCtx["reqDepts"];
};
export type Who = { key: string; n: string; ini: string; ph: string; hasPin: boolean };
type Fail = { ok: false; error: string };
type SignedIn = { ok: true; me: Me; data: FactoryData; needPin: boolean };

const NOT_FOUND = "notFound";
const INACTIVE = "inactive";

function meOf(fc: FactoryCtx): Me {
  return { key: fc.user.id, n: fc.user.name, ini: initialsOf(fc.user.name), head: fc.head, area: fc.area, areas: fc.areas, lang: fc.lang, scope: fc.scope, scopes: fc.scopes, drums: fc.drums, dispatch: fc.dispatch, counts: true, qc: fc.qc, reqs: fc.reqDepts };
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
    insert into factory_staff (user_id, area, areas, pin_hash) values (${fc.user.id}, ${fc.head ? "head" : fc.area}, ${textArray([fc.head ? "head" : fc.area])}, ${hash})
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
/** A mixing worker starting a batch himself. Answers with the new job's id so the phone opens it. */
export async function factoryStartBatch(a: { item: string; qty: number }): Promise<(Done & { ok: true; id: string }) | Fail> {
  const fc = await factoryContext();
  if (!fc) return { ok: false, error: "Please sign in again." };
  const r = await startMixingBatch(fc, a);
  if (!r.ok) return { ok: false, error: r.error ?? "That did not work." };
  return { ok: true, id: r.data.id, data: await bootstrap(fc), msg: r.message ?? "" };
}
/** A filling worker starting a filling from the SFG lot he scanned. Answers with the new job's id so the phone opens it. */
export async function factoryStartFill(a: { lot: string; item: string; qty: number }): Promise<(Done & { ok: true; id: string }) | Fail> {
  const fc = await factoryContext();
  if (!fc) return { ok: false, error: "Please sign in again." };
  const r = await startFillFromLot(fc, a);
  if (!r.ok) return { ok: false, error: r.error ?? "That did not work." };
  return { ok: true, id: r.data.id, data: await bootstrap(fc), msg: r.message ?? "" };
}
/** A packing worker starting a packing from the FG lot he scanned — the ERP's New packing batch. Answers with the new job's id so the phone opens it. */
export async function factoryStartPack(a: { lot: string; item: string; qty: number }): Promise<(Done & { ok: true; id: string }) | Fail> {
  const fc = await factoryContext();
  if (!fc) return { ok: false, error: "Please sign in again." };
  const r = await startPackFromLot(fc, a);
  if (!r.ok) return { ok: false, error: r.error ?? "That did not work." };
  return { ok: true, id: r.data.id, data: await bootstrap(fc), msg: r.message ?? "" };
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

/* ------------------------------------------------------------ empty drums */

const existingOf = (lot: DrumLot): DrumExisting[] =>
  lot.registered.map((r) => ({ label: drumLabel(r.drumNo), seq: r.seq, status: DRUM_STATUS_LABEL[r.status], kg: r.actualKg, at: r.recordedAt }));

/** Step one of Empty drum entry: what the scanned label is, before anything is weighed. Writes nothing. */
export async function factoryDrumLookup(code: string): Promise<DrumLookup> {
  const fc = await factoryContext();
  if (!fc) return { ok: false, title: "Please sign in again", text: "Nothing was saved.", fix: "Sign in, then scan the drum again." };
  if (!fc.drums) return { ok: false, title: "Not your work", text: "Empty drums are recorded by the people the Production Head names.", fix: "Ask the Production Head." };
  const lot = await findDrumLot(String(code ?? "").slice(0, 120));
  if (!lot) return { ok: false, title: "We do not know this label", text: "It is not a lot in the purchase register.", fix: "Scan the white GRN label on the drum. If it is torn, keep the drum aside and tell the Production Head — do not record it without its label." };
  const refusal = lotRefusal(lot);
  if (refusal) return { ok: false, title: "Already recorded", text: refusal, fix: "This drum is already counted. Keep it with the other empty drums.", existing: existingOf(lot) };
  const c = await getConfig();
  const last = lot.registered[lot.registered.length - 1] ?? null;
  const minutes = c["erp.drums.sameLotMinutes"];
  return {
    ok: true,
    lot: {
      code: lot.lotNo,
      lotNo: lot.lotNo,
      material: lot.material,
      supplier: lot.supplier,
      pr: lot.prNumber,
      godown: lot.godown,
      ownership: lot.ownership,
      ownershipLabel: lot.ownership ? OWNERSHIP_LABEL[lot.ownership] : "Not recorded — the Production Head decides",
      declaredKg: lot.declaredTareKg,
      drums: lot.drums,
      recorded: lot.registered.length,
      nextSeq: lot.nextSeq ?? lot.registered.length + 1,
      last: last ? { seq: last.seq, at: last.recordedAt, by: last.by } : null,
      recent: !!last && minutes > 0 && Date.now() - Date.parse(last.recordedAt) < minutes * 60_000,
    },
    limits: { minKg: c["erp.drums.minEmptyKg"], maxKg: c["erp.drums.maxEmptyKg"] },
  };
}

const drumSaveSchema = z.object({
  code: z.string().min(1).max(120),
  kg: z.number().finite().nullable(),
  key: z.string().regex(/^DRM-[\w-]{3,60}$/),
  different: z.boolean().optional(),
});

/** Step two: save the empty drum. Safe to send twice — the key answers a resend with the first save. */
export async function factoryEmptyDrum(input: { code: string; kg: number | null; key: string; different?: boolean }): Promise<DrumSave> {
  const fc = await factoryContext();
  if (!fc) return { ok: false, kind: "signedOut", title: "Please sign in again", text: "The drum was not saved.", fix: "Sign in, then scan the drum again." };
  if (!fc.drums) return { ok: false, kind: "notAllowed", title: "Not your work", text: "Empty drums are recorded by the people the Production Head names.", fix: "Ask the Production Head." };
  const parsed = drumSaveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, kind: "weight", title: "Enter the weight", text: "The weight could not be read.", fix: "Type the weight in kg, then save." };
  const r = await recordEmptyDrum(
    { id: fc.user.id, name: fc.user.name, app: "factory", level: fc.level },
    { code: parsed.data.code, kg: parsed.data.kg, source: "scan", godownId: fc.godown.id, clientKey: parsed.data.key, confirmDifferent: !!parsed.data.different },
    { mayApproveWeight: false },
  );
  if (!r.ok) {
    const f = r.refusal;
    if (f?.kind === "confirm") return { ok: false, kind: "confirm", title: "Is this a different drum?", text: f.message, fix: "Say yes only if this is another drum of the same lot.", existing: f.existing ? f.existing.map((e) => ({ label: drumLabel(e.drumNo), seq: e.seq, status: DRUM_STATUS_LABEL[e.status], kg: e.actualKg, at: e.recordedAt })) : undefined };
    if (f?.kind === "weight" || f?.kind === "permission") return { ok: false, kind: "weight", title: "Check the weight", text: f.message, fix: "Weigh the empty drum again. If the weight is right, the Production Head saves it from the ERP." };
    if (f?.kind === "lot") return { ok: false, kind: "lot", title: "Already recorded", text: f.message, fix: "Keep it with the other empty drums.", existing: f.existing ? f.existing.map((e) => ({ label: drumLabel(e.drumNo), seq: e.seq, status: DRUM_STATUS_LABEL[e.status], kg: e.actualKg, at: e.recordedAt })) : undefined };
    if (f?.kind === "notFound") return { ok: false, kind: "notFound", title: "We do not know this label", text: f.message, fix: "Tell the Production Head." };
    return { ok: false, kind: "weight", title: "Not saved", text: r.error, fix: "Try again." };
  }
  const d = r.data;
  await factoryAudit(fc, "factory.drum.empty", null, `${d.label} · ${d.lotNo} · ${d.actualKg} kg`);
  return {
    ok: true,
    replay: d.replay,
    drum: { label: d.label, seq: d.seq, drums: d.drums, lotNo: d.lotNo, material: d.material, supplier: d.supplier, statusLabel: d.statusLabel, ownership: d.ownership, declaredKg: d.declaredTareKg, actualKg: d.actualKg, varianceKg: d.varianceKg, reviewReason: d.reviewReason },
  };
}

/* ------------------------------------------------------------ loading and LRs
 * lib/factory/dispatch.ts does the work, through the ERP's own dispatch scan
 * and LR register; these only say who is asking. */

const SIGNED_OUT = { title: "Please sign in again", text: "Nothing was saved.", fix: "Sign in, then try again." };

export async function factoryLoadBoard(order: string): Promise<LoadBoard | null> {
  const fc = await factoryContext();
  return fc ? loadBoard(fc, order) : null;
}
export async function factoryScanBox(order: string, code: string): Promise<BoxScan> {
  const fc = await factoryContext();
  if (!fc) return { ok: false, code: String(code ?? ""), ...SIGNED_OUT, board: null };
  return scanBox(fc, order, code);
}
export async function factoryUnloadBox(order: string, unitId: string): Promise<BoxScan> {
  const fc = await factoryContext();
  if (!fc) return { ok: false, code: String(unitId ?? ""), ...SIGNED_OUT, board: null };
  return unloadBox(fc, order, unitId);
}
/* A lorry: loaded item by item, the order each box goes onto chosen by lib/factory/lorry.ts. */
export async function factoryLorryBoard(key: string): Promise<LorryBoard | null> {
  const fc = await factoryContext();
  return fc ? lorryBoard(fc, key) : null;
}
export async function factoryLorryScan(key: string, code: string, taskId: string | null): Promise<LorryScan> {
  const fc = await factoryContext();
  if (!fc) return { ok: false, code: String(code ?? ""), ...SIGNED_OUT, board: null, task: null, override: null };
  return lorryScan(fc, key, code, taskId);
}
export async function factoryLorryUnload(key: string, unitId: string): Promise<LorryScan> {
  const fc = await factoryContext();
  if (!fc) return { ok: false, code: String(unitId ?? ""), ...SIGNED_OUT, board: null, task: null, override: null };
  return lorryUnload(fc, key, unitId);
}
export async function factoryLorryOverride(key: string, code: string, sku: string, reason: string): Promise<{ ok: true; message: string; board: LorryBoard } | { ok: false; error: string }> {
  const fc = await factoryContext();
  if (!fc) return { ok: false, error: SIGNED_OUT.title };
  return lorryOverride(fc, key, code, sku, reason);
}
export async function factoryLorryDecide(key: string, id: string, approve: boolean, note: string | null): Promise<{ ok: true; message: string; board: LorryBoard } | { ok: false; error: string }> {
  const fc = await factoryContext();
  if (!fc) return { ok: false, error: SIGNED_OUT.title };
  return lorryDecide(fc, key, id, approve, note);
}
export async function factoryLorryFind(code: string): Promise<LorryFind> {
  const fc = await factoryContext();
  if (!fc) return { ok: false, ...SIGNED_OUT };
  return lorryFind(fc, code);
}
export async function factoryBoxInfo(code: string): Promise<BoxInfo> {
  const fc = await factoryContext();
  if (!fc) return { ok: false, ...SIGNED_OUT };
  return boxInfo(code);
}
export async function factoryLrKit(): Promise<LrKit> {
  const fc = await factoryContext();
  if (!fc) return { ok: false, ...SIGNED_OUT };
  return lrKit(fc);
}
export async function factoryReadLr(fileId: string): Promise<LrReading> {
  const fc = await factoryContext();
  if (!fc) return { ok: false, text: SIGNED_OUT.title };
  return readLr(fc, fileId);
}
/** Up to twenty LR photos stored at once; their reading runs after the answer, and never holds it up. */
/**
 * A photo that did not upload, told by the phone that failed to send it. It
 * writes nothing but the server's log — one line a failure, saying who, which
 * build, what, why and how big — because a photo that never arrived otherwise
 * leaves no trace on this side at all. A signed-out phone is still heard.
 */
export async function factoryUploadTrouble(reports: unknown): Promise<{ ok: true }> {
  const fc = await factoryContext();
  const who = fc ? `${fc.user.name} (${fc.user.id})` : "signed out";
  const list = Array.isArray(reports) ? reports.slice(0, 20) : [];
  for (const r of list) {
    const x = (r ?? {}) as Record<string, unknown>;
    const clip = (v: unknown, n = 300) => (typeof v === "string" ? v.slice(0, n) : v == null ? null : String(v).slice(0, n));
    console.warn(
      "[factory] upload trouble",
      JSON.stringify({ who, what: clip(x.what, 60), kind: clip(x.kind, 20), why: clip(x.why), bytes: typeof x.bytes === "number" ? x.bytes : null, at: clip(x.at, 40), build: clip(x.build, 40) }),
    );
  }
  return { ok: true };
}

export async function factorySaveLrPhotos(fileIds: string[]): Promise<LrBatchSave> {
  const fc = await factoryContext();
  if (!fc) return { ok: false, ...SIGNED_OUT };
  const r = await saveLrPhotos(fc, fileIds);
  if (!r.ok) return r;
  const { newIds, ...answer } = r;
  if (newIds?.length) {
    const job = () => readStoredLrs(erpCtxFor(fc), newIds).catch((e) => console.error("[factory] reading LR photos failed:", e instanceof Error ? e.message : e));
    try {
      after(job);
    } catch {
      /* Outside a request (a test, a script) there is nothing to run after: read now. */
      await job();
    }
  }
  return answer;
}

export async function factorySaveLr(input: LrFields & { fileId: string | null; readingId: string | null; note?: string | null }): Promise<LrSave> {
  const fc = await factoryContext();
  if (!fc) return { ok: false, ...SIGNED_OUT };
  return saveLr(fc, input);
}

/* ------------------------------------------------------------ stock checks */

/** The office's counts and every item at this godown. Never the book — the check is blind. */
export async function factoryStockKit(): Promise<StockKit> {
  const fc = await factoryContext();
  if (!fc) return { ok: false, title: "Please sign in again", text: "The stock list could not be shown.", fix: "Sign in, then open Stock check again." };
  return stockKit(fc);
}

/** One check of an item the person chose. Safe to send twice — the key answers a resend. */
export async function factoryStockCheck(input: StockCheckInput): Promise<StockSave> {
  const fc = await factoryContext();
  if (!fc) return { ok: false, kind: "signedOut", title: "Please sign in again", text: "The check was not saved.", fix: "Sign in, then count it again." };
  return saveStockCheck(fc, input);
}

/** One count the office asked for, through the ERP's own submit. */
export async function factoryCountSave(input: CountInput): Promise<StockSave> {
  const fc = await factoryContext();
  if (!fc) return { ok: false, kind: "signedOut", title: "Please sign in again", text: "The count was not saved.", fix: "Sign in, then count it again." };
  return saveOfficeCount(fc, input);
}

/** The optional reason after a mismatch. */
export async function factoryCheckReason(kind: "check" | "count", id: string, reason: string): Promise<{ ok: boolean }> {
  const fc = await factoryContext();
  if (!fc) return { ok: false };
  return saveCheckReason(fc, kind === "count" ? "count" : "check", String(id ?? ""), String(reason ?? ""));
}

/* ------------------------------------------------------------ SFG quality check */

/** The lots waiting for QC and the Testing list's tests. */
export async function factoryQcKit(): Promise<QcKit> {
  const fc = await factoryContext();
  if (!fc) return { ok: false, title: "Please sign in again", text: "The lots could not be shown.", fix: "Sign in, then open Quality check again." };
  return qcKit(fc);
}

/** Approve or reject one SFG lot, with each test's Pass / Fail. */
export async function factoryQcDecide(input: QcInput): Promise<QcSave> {
  const fc = await factoryContext();
  if (!fc) return { ok: false, title: "Please sign in again", text: "The decision was not saved.", fix: "Sign in, then decide it again." };
  return saveQcDecision(fc, input);
}

/* ------------------------------------------------------------ purchase requirements */

/** The department's items (never their stock) and its requirements. */
export async function factoryReqKit(): Promise<ReqKit> {
  const fc = await factoryContext();
  if (!fc) return { ok: false, title: "Please sign in again", text: "The requirements could not be shown.", fix: "Sign in, then open Purchase requirement again." };
  return requirementKit(fc);
}

/** Raise one requirement with every item counted. Safe to send twice — the key answers a resend. */
export async function factoryReqRaise(input: ReqInput): Promise<ReqSave> {
  const fc = await factoryContext();
  if (!fc) return { ok: false, title: "Please sign in again", text: "The requirement was not sent.", fix: "Sign in, then send it again." };
  return raiseFromFloor(fc, input);
}

/** Cancel one item before it is on a PO. */
export async function factoryReqCancel(id: string, reason: string): Promise<{ ok: true; msg: string } | { ok: false; error: string }> {
  const fc = await factoryContext();
  if (!fc) return { ok: false, error: "Please sign in again." };
  return cancelFromFloor(fc, String(id ?? ""), String(reason ?? ""));
}
