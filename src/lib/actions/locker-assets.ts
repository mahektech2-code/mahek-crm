"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { attachments, lockerAssetTypes, lockerAssets, lockerPaymentMethods, lockerRenewals, users } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { today } from "@/lib/format";
import { lockerAccess } from "@/lib/locker/access";
import { lockerAuditTx } from "@/lib/locker/audit";
import { CATEGORY, DEFAULT_STEPS } from "@/lib/locker/catalogue";
import { RENEWAL_STEPS, stageForStep, type Stage } from "@/lib/locker/engine";
import { canEditRegister } from "@/lib/locker/register-service";
import { err, ok, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * THE REGISTER'S WRITES. Every one asks again, on the server, whether this
 * person may change this category — a server action is a URL — and writes
 * its audit row in the same transaction as the change, so a change without
 * its record cannot exist.
 * ------------------------------------------------------------------------- */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const newId = (p: string) => `${p}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
const NO = "You do not have this part of the Locker. A Locker admin can give it to you under Admin › Access.";
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function refresh(...paths: string[]) {
  for (const p of ["/locker", "/locker/assets", ...paths]) {
    try {
      revalidatePath(p, "layout");
    } catch {
      /* outside a request */
    }
  }
}

async function actor() {
  const user = await requireUser();
  const access = await lockerAccess(user.id);
  return { user, access };
}

async function editable(userId: string, category: string): Promise<string | null> {
  const a = await lockerAccess(userId);
  if (!a.catOk(category)) return NO;
  if (!canEditRegister(a)) return "Your Locker access is read-only. Ask a Locker admin if you need to change the register.";
  return null;
}

async function loadAsset(tx: Tx | typeof db, id: string) {
  const [a] = await tx.select().from(lockerAssets).where(eq(lockerAssets.id, id));
  return a ?? null;
}

const audit = (tx: Tx, user: { id: string; name: string }, action: string, a: { id: string; title: string }, summary: string, extra: { reason?: string | null; detail?: Record<string, unknown> } = {}) =>
  lockerAuditTx(tx, { actorId: user.id, actorName: user.name, action, entityType: "locker_asset", entityId: a.id, entityTitle: a.title, summary, reason: extra.reason ?? null, detail: extra.detail });

async function activeUser(id: string | null | undefined): Promise<boolean> {
  if (!id) return false;
  const [u] = await db.select({ active: users.active }).from(users).where(eq(users.id, id));
  return !!u?.active;
}

/* ------------------------------------------------------------- create / edit */

export type AssetInput = {
  typeCode: string;
  title: string;
  criticality?: number;
  entityId?: string | null;
  siteId?: string | null;
  endDate?: string | null;
  issuedOn?: string | null;
  docNo?: string;
  provider?: string;
  amountRupees?: number | null;
  billingCycle?: string;
  paymentMethodId?: string | null;
  autoRenew?: boolean;
  seats?: number | null;
  noticeDays?: number | null;
  conditions?: string | null;
  physicalLocation?: string | null;
  externalContact?: string | null;
  department?: string;
  ownerId: string;
  backupId?: string | null;
  approverId?: string | null;
  extra?: Record<string, string>;
};

function clean(input: AssetInput, model: string): { error: string; field: string } | null {
  if (!input.title?.trim()) return { error: "Give it a title.", field: "title" };
  if (!input.ownerId) return { error: "An asset cannot be saved without a responsible person.", field: "ownerId" };
  if (input.endDate && !ISO.test(input.endDate)) return { error: "The end date is not a date.", field: "endDate" };
  if (input.issuedOn && !ISO.test(input.issuedOn)) return { error: "The issue date is not a date.", field: "issuedOn" };
  if (input.endDate && input.issuedOn && input.endDate < input.issuedOn) return { error: "It cannot end before it was issued.", field: "endDate" };
  if (model !== "perpetual" && !input.endDate) return { error: model === "subscription" ? "When does the current period end?" : "When does it end? Enter the end date, or how long it is valid for.", field: "endDate" };
  return null;
}

export async function createAsset(input: AssetInput): Promise<Result<{ id: string }>> {
  const { user } = await actor();
  const [type] = await db.select().from(lockerAssetTypes).where(eq(lockerAssetTypes.code, input.typeCode));
  if (!type || !type.active) return err("Choose a type.", "validation");
  const refusal = await editable(user.id, type.category);
  if (refusal) return err(refusal, "not_permitted");
  const bad = clean(input, type.model);
  if (bad) return err(bad.error, "validation", [{ field: bad.field, message: bad.error }]);
  const crit = Math.min(4, Math.max(1, input.criticality ?? type.criticality));
  if (!(await activeUser(input.ownerId))) return err("The owner must be somebody with an active MahekOne account.", "validation", [{ field: "ownerId", message: "Choose an owner." }]);
  if (crit >= 3 && !input.backupId) return err(`Every ${crit === 4 ? "business-critical" : "high"} asset needs a backup owner too — if the owner is away, nobody receives the reminder.`, "validation", [{ field: "backupId", message: "Choose a backup owner." }]);
  if (input.backupId && input.backupId === input.ownerId) return err("The backup owner must be a different person.", "validation", [{ field: "backupId", message: "A different person." }]);

  const id = newId("lka");
  await db.transaction(async (tx) => {
    const code = CATEGORY[type.category]?.code ?? "GEN";
    /* Numbered per category, never reused: the highest number ever issued, plus one. */
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"locker-code-" + code}))`);
    const [{ n }] = (await tx.execute(
      sql`select coalesce(max(substring(code from '([0-9]+)$')::int), 0) + 1 as n from locker_assets where code like ${"LCK-" + code + "-%"}`,
    )) as unknown as { n: number | string }[];
    const assetCode = `LCK-${code}-${String(Number(n)).padStart(4, "0")}`;
    const row = {
      id,
      code: assetCode,
      title: input.title.trim(),
      typeCode: type.code,
      category: type.category,
      criticality: crit,
      entityId: input.entityId || null,
      siteId: input.siteId || null,
      endDate: type.model === "perpetual" ? input.endDate || null : input.endDate || null,
      issuedOn: input.issuedOn || null,
      ownerId: input.ownerId,
      backupId: input.backupId || null,
      approverId: input.approverId || null,
      department: input.department?.trim() ?? "",
      externalContact: input.externalContact?.trim() || null,
      docNo: input.docNo?.trim() ?? "",
      provider: input.provider?.trim() ?? "",
      amountPaise: Math.round((input.amountRupees ?? 0) * 100),
      billingCycle: input.billingCycle ?? "",
      paymentMethodId: input.paymentMethodId || null,
      autoRenew: !!input.autoRenew,
      seats: input.seats ?? 0,
      noticeDays: type.model === "term_contract" ? (input.noticeDays ?? type.leadDays) : 0,
      conditions: input.conditions?.trim() || null,
      physicalLocation: input.physicalLocation?.trim() || null,
      extra: input.extra ?? {},
      /* Entered against the document in hand: that IS a check. */
      lastCheckedAt: new Date(),
      lastCheckedById: user.id,
      createdById: user.id,
    };
    await tx.insert(lockerAssets).values(row);
    await audit(tx, user, "locker.asset.created", row, `Created ${row.title} · ${assetCode}`);
  });
  refresh();
  return ok({ id }, "Asset added · reminders scheduled");
}

export async function updateAsset(id: string, input: AssetInput): Promise<Result> {
  const { user } = await actor();
  const a = await loadAsset(db, id);
  if (!a) return err("That asset no longer exists.", "not_found");
  const refusal = await editable(user.id, a.category);
  if (refusal) return err(refusal, "not_permitted");
  const [type] = await db.select().from(lockerAssetTypes).where(eq(lockerAssetTypes.code, a.typeCode));
  const bad = clean({ ...input, ownerId: input.ownerId || a.ownerId || "" }, type?.model ?? "document");
  if (bad) return err(bad.error, "validation", [{ field: bad.field, message: bad.error }]);
  const crit = Math.min(4, Math.max(1, input.criticality ?? a.criticality));
  const patch = {
    title: input.title.trim(),
    criticality: crit,
    entityId: input.entityId || null,
    siteId: input.siteId || null,
    endDate: input.endDate || null,
    issuedOn: input.issuedOn || null,
    docNo: input.docNo?.trim() ?? "",
    provider: input.provider?.trim() ?? "",
    amountPaise: Math.round((input.amountRupees ?? 0) * 100),
    billingCycle: input.billingCycle ?? "",
    paymentMethodId: input.paymentMethodId || null,
    autoRenew: !!input.autoRenew,
    seats: input.seats ?? 0,
    noticeDays: type?.model === "term_contract" ? (input.noticeDays ?? 0) : 0,
    conditions: input.conditions?.trim() || null,
    extra: input.extra ?? {},
    department: input.department?.trim() ?? a.department,
    updatedAt: new Date(),
  };
  const changed = Object.entries(patch).filter(([k, v]) => k !== "updatedAt" && JSON.stringify((a as Record<string, unknown>)[k] ?? null) !== JSON.stringify(v ?? null)).map(([k]) => k);
  if (!changed.length) return ok(undefined, "Nothing changed");
  await db.transaction(async (tx) => {
    await tx.update(lockerAssets).set(patch).where(eq(lockerAssets.id, id));
    await audit(tx, user, "locker.asset.edited", { id, title: patch.title }, `Changed ${changed.join(", ")} on ${patch.title}`, { detail: { fields: changed } });
  });
  refresh(`/locker/assets/${id}`);
  return ok(undefined, "Saved");
}

/* -------------------------------------------------------------- the check */

export async function markChecked(id: string, what: string): Promise<Result> {
  const { user } = await actor();
  const a = await loadAsset(db, id);
  if (!a) return err("That asset no longer exists.", "not_found");
  const refusal = await editable(user.id, a.category);
  if (refusal) return err(refusal, "not_permitted");
  if ((what ?? "").trim().length < 10) return err("Write at least a sentence on what you checked — it is kept on the record.", "validation");
  await db.transaction(async (tx) => {
    await tx.update(lockerAssets).set({ lastCheckedAt: new Date(), lastCheckedById: user.id, updatedAt: new Date() }).where(eq(lockerAssets.id, id));
    await audit(tx, user, "locker.asset.checked", a, `Checked ${a.title} · “${what.trim()}”`, { reason: what.trim() });
  });
  refresh(`/locker/assets/${id}`);
  return ok(undefined, "Checked");
}

/* ------------------------------------------------------------ the people */

export type Seat = "owner" | "backup" | "approver" | "executor" | "custodian";
const SEAT_COL = { owner: "ownerId", backup: "backupId", approver: "approverId", executor: "executorId", custodian: "custodianId" } as const;
const SEAT_LABEL: Record<Seat, string> = { owner: "Primary owner", backup: "Backup owner", approver: "Approver", executor: "Executor", custodian: "Custodian of the original" };

export async function setSeat(id: string, seat: Seat, userId: string | null): Promise<Result<{ previous: string | null }>> {
  const { user } = await actor();
  const a = await loadAsset(db, id);
  if (!a) return err("That asset no longer exists.", "not_found");
  const refusal = await editable(user.id, a.category);
  if (refusal) return err(refusal, "not_permitted");
  if (!SEAT_COL[seat]) return err("Not a seat.", "validation");
  if (seat === "owner" && !userId) return err("An asset cannot be left without a primary owner. Choose somebody else instead.", "validation");
  if (userId && !(await activeUser(userId))) return err("Choose somebody with an active MahekOne account.", "validation");
  if (seat === "backup" && userId && userId === a.ownerId) return err("The backup owner must be a different person from the owner.", "validation");
  const col = SEAT_COL[seat];
  const previous = (a as Record<string, unknown>)[col] as string | null;
  const [p] = userId ? await db.select({ name: users.name }).from(users).where(eq(users.id, userId)) : [null];
  await db.transaction(async (tx) => {
    await tx.update(lockerAssets).set({ [col]: userId, updatedAt: new Date() }).where(eq(lockerAssets.id, id));
    await audit(tx, user, "locker.asset.owner_set", a, `${SEAT_LABEL[seat]} of ${a.title} ${userId ? `set to ${p?.name ?? "?"}` : "cleared"}`, { detail: { seat, from: previous, to: userId } });
  });
  refresh(`/locker/assets/${id}`);
  return ok({ previous }, `${SEAT_LABEL[seat]} ${userId ? `set to ${p?.name}` : "cleared"}`);
}

export async function setAssetText(id: string, field: "externalContact" | "department" | "physicalLocation" | "conditions", value: string): Promise<Result> {
  const { user } = await actor();
  const a = await loadAsset(db, id);
  if (!a) return err("That asset no longer exists.", "not_found");
  const refusal = await editable(user.id, a.category);
  if (refusal) return err(refusal, "not_permitted");
  const label = { externalContact: "External contact", department: "Department", physicalLocation: "Where the original is", conditions: "Conditions" }[field];
  if (!label) return err("Not a field.", "validation");
  const v = value.trim();
  await db.transaction(async (tx) => {
    await tx.update(lockerAssets).set({ [field]: field === "department" ? v : v || null, updatedAt: new Date() }).where(eq(lockerAssets.id, id));
    await audit(tx, user, "locker.asset.edited", a, `${label} of ${a.title} ${v ? `set to “${v}”` : "cleared"}`, { detail: { fields: [field] } });
  });
  refresh(`/locker/assets/${id}`);
  return ok(undefined, "Saved");
}

/* ----------------------------------------------------------------- stage */

const SETTABLE: (Stage | null)[] = ["cancelled", "lost", "suspended", "disputed", "draft", null];

/** Cancel (deliberately not renewed), lost original, suspended, disputed — or clear back to the dates. Never deletes (P9). */
export async function setStage(id: string, stage: Stage | null, reason: string): Promise<Result> {
  const { user } = await actor();
  const a = await loadAsset(db, id);
  if (!a) return err("That asset no longer exists.", "not_found");
  const refusal = await editable(user.id, a.category);
  if (refusal) return err(refusal, "not_permitted");
  if (!SETTABLE.includes(stage)) return err("That status is set by a renewal, not by hand.", "validation");
  if ((reason ?? "").trim().length < 10) return err("Say why in a sentence — it is kept on the record.", "validation");
  await db.transaction(async (tx) => {
    await tx
      .update(lockerAssets)
      .set({ stage, archivedAt: stage === "cancelled" ? new Date() : null, archivedReason: stage === "cancelled" ? reason.trim() : null, updatedAt: new Date() })
      .where(eq(lockerAssets.id, id));
    await audit(tx, user, "locker.asset.stage_set", a, stage ? `Marked ${a.title} as ${stage.replace("_", " ")}` : `Cleared the status of ${a.title} back to its dates`, { reason: reason.trim(), detail: { from: a.stage, to: stage } });
  });
  refresh(`/locker/assets/${id}`);
  return ok(undefined, "Saved");
}

/* ---------------------------------------------------------------- documents */

/** Bind an uploaded file (from /api/locker/assets/[id]/documents) and record it. Called by that route. */
export async function recordDocument(assetId: string, attachmentId: string): Promise<Result> {
  const { user } = await actor();
  const a = await loadAsset(db, assetId);
  if (!a) return err("That asset no longer exists.", "not_found");
  const refusal = await editable(user.id, a.category);
  if (refusal) return err(refusal, "not_permitted");
  const [f] = await db.select().from(attachments).where(and(eq(attachments.id, attachmentId), eq(attachments.uploadedById, user.id), isNull(attachments.parentId)));
  if (!f) return err("That file is not yours to attach, or is already attached.", "validation");
  await db.transaction(async (tx) => {
    await tx.update(attachments).set({ parentType: "locker_asset", parentId: assetId, updatedAt: new Date() }).where(eq(attachments.id, attachmentId));
    await audit(tx, user, "locker.asset.document_added", a, `Uploaded ${f.filename} · SHA-256 ${String(f.contentHash ?? "").slice(0, 12)}… recorded`, { detail: { attachmentId, sha256: f.contentHash } });
  });
  refresh(`/locker/assets/${assetId}`);
  return ok(undefined, `${f.filename} added · hash recorded`);
}

/* ------------------------------------------------------------------ renewals */

export async function startRenewal(assetId: string): Promise<Result<{ id: string }>> {
  const { user } = await actor();
  const a = await loadAsset(db, assetId);
  if (!a) return err("That asset no longer exists.", "not_found");
  const refusal = await editable(user.id, a.category);
  if (refusal) return err(refusal, "not_permitted");
  if (a.stage === "superseded" || a.stage === "cancelled") return err("This asset has been replaced or cancelled; renew the current version instead.", "validation");
  const [open] = await db.select({ id: lockerRenewals.id }).from(lockerRenewals).where(and(eq(lockerRenewals.assetId, assetId), isNull(lockerRenewals.completedAt)));
  if (open) return ok({ id: open.id }, "The renewal task is already open");
  const [type] = await db.select().from(lockerAssetTypes).where(eq(lockerAssetTypes.code, a.typeCode));
  const steps = type?.steps?.length ? type.steps : DEFAULT_STEPS;
  const id = newId("lkr");
  await db.transaction(async (tx) => {
    await tx.insert(lockerRenewals).values({
      id,
      assetId,
      step: 1,
      checklist: steps.map((text) => ({ text, done: false })),
      assignedToId: a.executorId ?? a.ownerId,
      costPaise: type?.typicalCostPaise ?? 0,
      startedById: user.id,
    });
    await tx.update(lockerAssets).set({ stage: "renewal_in_progress", updatedAt: new Date() }).where(eq(lockerAssets.id, assetId));
    await audit(tx, user, "locker.renewal.started", a, `Started renewing ${a.title}`);
  });
  refresh(`/locker/assets/${assetId}`, "/locker/renewals");
  return ok({ id }, "Renewal started");
}

export type RenewalPatch = {
  step?: number;
  toggle?: number;
  assignedToId?: string | null;
  appliedOn?: string | null;
  ackNo?: string | null;
  costRupees?: number | null;
  note?: string;
};

export async function updateRenewal(renewalId: string, patch: RenewalPatch): Promise<Result> {
  const { user } = await actor();
  const [r] = await db.select().from(lockerRenewals).where(eq(lockerRenewals.id, renewalId));
  if (!r || r.completedAt) return err("That renewal task is closed.", "not_found");
  const a = await loadAsset(db, r.assetId);
  if (!a) return err("That asset no longer exists.", "not_found");
  const refusal = await editable(user.id, a.category);
  if (refusal) return err(refusal, "not_permitted");

  const set: Partial<typeof lockerRenewals.$inferInsert> = {};
  const said: string[] = [];
  if (patch.step != null) {
    if (patch.step < 1 || patch.step > 7) return err("Complete the renewal with the new document to finish it.", "validation");
    if (patch.step >= 3 && !(patch.appliedOn ?? r.appliedOn)) return err("Record the date it was applied for first.", "validation");
    set.step = patch.step;
    said.push(`moved to ${RENEWAL_STEPS[patch.step]}`);
  }
  if (patch.toggle != null) {
    const list = r.checklist.slice();
    const item = list[patch.toggle];
    if (!item) return err("Not a step on this checklist.", "validation");
    list[patch.toggle] = item.done ? { text: item.text, done: false } : { text: item.text, done: true, by: user.name, at: new Date().toISOString() };
    set.checklist = list;
    said.push(`${item.done ? "unticked" : "ticked"} “${item.text}”`);
  }
  if (patch.assignedToId !== undefined) {
    if (patch.assignedToId && !(await activeUser(patch.assignedToId))) return err("Choose somebody with an active account.", "validation");
    set.assignedToId = patch.assignedToId;
    said.push("reassigned");
  }
  if (patch.appliedOn !== undefined) {
    if (patch.appliedOn && !ISO.test(patch.appliedOn)) return err("The applied date is not a date.", "validation");
    if (patch.appliedOn && patch.appliedOn > today()) return err("It cannot have been applied for in the future.", "validation");
    set.appliedOn = patch.appliedOn || null;
    said.push(patch.appliedOn ? `applied on ${patch.appliedOn}` : "applied date cleared");
    if (patch.appliedOn && (set.step ?? r.step) < 3) set.step = 3;
  }
  if (patch.ackNo !== undefined) {
    set.ackNo = patch.ackNo?.trim() || null;
    said.push("acknowledgement recorded");
  }
  if (patch.costRupees !== undefined) {
    set.costPaise = Math.max(0, Math.round((patch.costRupees ?? 0) * 100));
    said.push("cost recorded");
  }
  if (patch.note?.trim()) {
    const notes = (() => {
      try {
        return r.notes ? (JSON.parse(r.notes) as unknown[]) : [];
      } catch {
        return r.notes ? [{ who: "", at: "", t: r.notes }] : [];
      }
    })();
    notes.push({ who: user.name, at: new Date().toISOString(), t: patch.note.trim() });
    set.notes = JSON.stringify(notes);
    said.push("note added");
  }
  if (!said.length) return ok(undefined, "Nothing changed");
  const step = set.step ?? r.step;
  await db.transaction(async (tx) => {
    await tx.update(lockerRenewals).set(set).where(eq(lockerRenewals.id, renewalId));
    await tx.update(lockerAssets).set({ stage: stageForStep(step), updatedAt: new Date() }).where(eq(lockerAssets.id, a.id));
    await audit(tx, user, "locker.renewal.updated", a, `Renewal task for ${a.title}: ${said.join(", ")}`, { detail: { renewalId } });
  });
  refresh(`/locker/assets/${a.id}`, "/locker/renewals");
  return ok(undefined, "Saved");
}

/**
 * COMPLETING A RENEWAL MAKES A NEW VERSION (spec §7.2). The renewed document
 * is a new asset carrying everything the old one did, with the new dates and
 * number and `replaces_id` pointing back; the old one is marked replaced and
 * kept, so an audit years from now can show the licence was continuously valid.
 */
export async function completeRenewal(renewalId: string, input: { newEndDate: string | null; newDocNo: string; issuedOn?: string | null; attachmentId?: string | null }): Promise<Result<{ id: string }>> {
  const { user } = await actor();
  const [r] = await db.select().from(lockerRenewals).where(eq(lockerRenewals.id, renewalId));
  if (!r || r.completedAt) return err("That renewal task is already closed.", "not_found");
  const a = await loadAsset(db, r.assetId);
  if (!a) return err("That asset no longer exists.", "not_found");
  const refusal = await editable(user.id, a.category);
  if (refusal) return err(refusal, "not_permitted");
  const [type] = await db.select().from(lockerAssetTypes).where(eq(lockerAssetTypes.code, a.typeCode));
  if (r.checklist.some((c) => !c.done)) return err("Tick every step first.", "validation");
  if (type?.model !== "perpetual") {
    if (!input.newEndDate || !ISO.test(input.newEndDate)) return err("Enter the new end date from the renewed document.", "validation", [{ field: "newEndDate", message: "Required." }]);
    if (a.endDate && input.newEndDate <= a.endDate) return err("The new end date must be after the old one.", "validation", [{ field: "newEndDate", message: "After the old end date." }]);
  }
  const id = newId("lka");
  await db.transaction(async (tx) => {
    const { id: _old, code, createdAt: _c, updatedAt: _u, ...rest } = a;
    void _old;
    void _c;
    void _u;
    /* The same code with a version suffix: one asset, a chain of versions. */
    const [{ n }] = (await tx.execute(sql`select count(*)::int as n from locker_assets where code like ${code.replace(/-v\d+$/, "") + "%"}`)) as unknown as { n: number | string }[];
    const newCode = `${code.replace(/-v\d+$/, "")}-v${Number(n) + 1}`;
    await tx.insert(lockerAssets).values({
      ...rest,
      id,
      code: newCode,
      stage: null,
      endDate: input.newEndDate || null,
      issuedOn: input.issuedOn || today(),
      docNo: input.newDocNo?.trim() || a.docNo,
      replacesId: a.id,
      archivedAt: null,
      archivedReason: null,
      lastCheckedAt: new Date(),
      lastCheckedById: user.id,
      createdById: user.id,
    });
    await tx.update(lockerAssets).set({ stage: "superseded", updatedAt: new Date() }).where(eq(lockerAssets.id, a.id));
    await tx.update(lockerRenewals).set({ step: 8, completedAt: new Date(), completedById: user.id, newEndDate: input.newEndDate || null, newDocNo: input.newDocNo?.trim() || null }).where(eq(lockerRenewals.id, renewalId));
    if (input.attachmentId) {
      await tx.update(attachments).set({ parentType: "locker_asset", parentId: id, updatedAt: new Date() }).where(and(eq(attachments.id, input.attachmentId), eq(attachments.uploadedById, user.id), isNull(attachments.parentId)));
    }
    await audit(tx, user, "locker.renewal.completed", a, `Renewal completed · ${a.title} replaced by ${newCode}${input.newEndDate ? `, valid until ${input.newEndDate}` : ""}`, { detail: { renewalId, newAssetId: id } });
    await lockerAuditTx(tx, { actorId: user.id, actorName: user.name, action: "locker.asset.created", entityType: "locker_asset", entityId: id, entityTitle: a.title, summary: `Created ${newCode} as the renewed version of ${code}` });
  });
  refresh(`/locker/assets/${a.id}`, `/locker/assets/${id}`, "/locker/renewals");
  return ok({ id }, "Renewal complete · the new document replaces the old one");
}

/* ------------------------------------------------------------ export record */

/** The export is built in the browser from what is on screen; this records that it happened. */
export async function recordExport(count: number, view: string): Promise<Result> {
  const { user, access } = await actor();
  if (!access.has("locker.assets") && !access.categories.length) return err(NO, "not_permitted");
  await db.transaction((tx) =>
    lockerAuditTx(tx, { actorId: user.id, actorName: user.name, action: "locker.assets.exported", entityType: "locker_register", summary: `Exported ${count} assets · ${view}`, detail: { count, view } }),
  );
  return ok(undefined, `${count} assets exported · the export is logged`);
}

/* --------------------------------------------------------- payment methods */

export type PaymentMethodInput = { id?: string; label: string; kind: string; last4: string; expiresOn: string | null; holder: string; bank: string; personal: boolean; active?: boolean };

/** Last four and the expiry, never a full number or a CVV (spec §4). */
export async function savePaymentMethod(input: PaymentMethodInput): Promise<Result<{ id: string }>> {
  const { user, access } = await actor();
  if (!access.has("locker.costs")) return err(NO, "not_permitted");
  if (!input.label?.trim()) return err("Give it a name people will recognise.", "validation", [{ field: "label", message: "Required." }]);
  const last4 = (input.last4 ?? "").replace(/\D/g, "");
  if (last4 && last4.length !== 4) return err("Only the last four digits — never the full number.", "validation", [{ field: "last4", message: "Four digits." }]);
  if (input.expiresOn && !ISO.test(input.expiresOn)) return err("The expiry is not a date.", "validation");
  const id = input.id || newId("lkp");
  const row = { label: input.label.trim(), kind: input.kind || "Credit card", last4, expiresOn: input.expiresOn || null, holder: input.holder?.trim() ?? "", bank: input.bank?.trim() ?? "", personal: !!input.personal, active: input.active ?? true };
  await db.transaction(async (tx) => {
    if (input.id) await tx.update(lockerPaymentMethods).set(row).where(eq(lockerPaymentMethods.id, id));
    else await tx.insert(lockerPaymentMethods).values({ id, ...row });
    await lockerAuditTx(tx, { actorId: user.id, actorName: user.name, action: "locker.payment_method.saved", entityType: "locker_payment_method", entityId: id, entityTitle: row.label, summary: `${input.id ? "Changed" : "Added"} payment method ${row.label}${last4 ? ` ····${last4}` : ""}` });
  });
  refresh("/locker/costs");
  return ok({ id }, "Saved");
}
