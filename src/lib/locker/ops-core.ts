import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, gte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  appAccess,
  appModuleAccess,
  lockerAssetTypes,
  lockerAssets,
  lockerCredentials,
  lockerEntities,
  lockerIdentities,
  lockerLinks,
  lockerOffboarding,
  lockerPaymentMethods,
  lockerReminderSchedules,
  lockerReveals,
  lockerReviewItems,
  lockerSettings,
  lockerSites,
  users,
  type User,
} from "@/db/schema";
import { widestRole } from "@/lib/capability-matrix";
import { modulesForApp, moduleAllowed } from "@/lib/modules";
import { notifyUsers } from "@/lib/notify";
import { err, ok, type Result } from "@/lib/result";
import { writeModules } from "@/lib/services/access-writes";
import { lockerAccess } from "./access";
import { lockerAuditTx } from "./audit";
import { CATEGORY } from "./catalogue";
import { mergeSettings, type LockerSettings } from "./settings";
import { holdersOf } from "./vault-core";

/* ---------------------------------------------------------------------------
 * OPERATIONS AND ADMIN, ENFORCED: sign-in accounts and the edges to them,
 * offboarding, the access review, who holds which part of the Locker, and
 * the admin's types, schedules, companies and security settings. Same shape
 * as vault-core: each takes the acting user and checks the module itself.
 * ------------------------------------------------------------------------- */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const nid = (p: string) => `${p}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
const NO = (what: string) => `You do not have ${what} in the Locker. A Locker admin can add it under Admin › Access.`;

async function need(actor: User, key: string, what: string): Promise<string | null> {
  return (await lockerAccess(actor.id)).has(key) ? null : NO(what);
}

/* ---------------------------------------------------------- sign-in accounts */

export type IdentityInput = { email: string; provider: string; kind: string; controlled: boolean; mfa: boolean; recovery: boolean; controlledByName: string; ownerId: string | null };

export async function saveIdentity(actor: User, id: string | null, i: IdentityInput): Promise<Result<{ id: string }>> {
  const a = await lockerAccess(actor.id);
  if (!a.has("locker.identities") && !a.vault) return err(NO("Sign-in accounts"), "not_permitted");
  if (!i.email.trim() || !i.provider.trim()) return err("Give the account and its provider.");
  if (!["organisational", "shared", "personal", "service"].includes(i.kind)) return err("Choose what kind of account it is.");
  if (!i.controlled && !i.controlledByName.trim()) return err("A personal account is controlled by somebody — name them.");
  const rowId = id ?? nid("lki");
  try {
    await db.transaction(async (tx) => {
      const values = { email: i.email.trim(), provider: i.provider.trim(), kind: i.kind, controlled: i.controlled, mfa: i.mfa, recovery: i.recovery, controlledByName: i.controlled ? null : i.controlledByName.trim(), ownerId: i.ownerId };
      if (id) await tx.update(lockerIdentities).set(values).where(eq(lockerIdentities.id, id));
      else await tx.insert(lockerIdentities).values({ id: rowId, ...values });
      await lockerAuditTx(tx, { actorId: actor.id, actorName: actor.name, action: "locker.identity.saved", entityType: "identity", entityId: rowId, entityTitle: values.email, summary: `${id ? "Changed" : "Added"} sign-in account ${values.email}${values.controlled ? "" : " (personal)"}`, security: !values.controlled });
    });
  } catch (e) {
    if (e instanceof Error && /locker_identities_email/.test(e.message)) return err("That account is already recorded for this provider.", "duplicate");
    throw e;
  }
  return ok({ id: rowId }, "Saved");
}

/** Add an edge: this login relies on that account (recovery email, billing owner, shared sign-in). */
export async function addLink(actor: User, credentialId: string, identityId: string, kind: string, sole: boolean): Promise<Result> {
  if (!(await lockerAccess(actor.id)).vault) return err(NO("Passwords & keys"), "not_permitted");
  if (!["Shared sign-in", "Recovery email", "Billing owner"].includes(kind)) return err("Choose how it relies on the account.");
  await db.transaction(async (tx) => {
    await tx.insert(lockerLinks).values({ id: nid("lkl"), credentialId, identityId, kind, sole }).onConflictDoUpdate({ target: [lockerLinks.credentialId, lockerLinks.identityId, lockerLinks.kind], set: { sole } });
    await lockerAuditTx(tx, { actorId: actor.id, actorName: actor.name, action: "locker.credential.edited", entityType: "credential", entityId: credentialId, summary: `Recorded a connection: ${kind}${sole ? " (only way in)" : ""}` });
  });
  return ok(undefined);
}

export async function removeLink(actor: User, linkId: string): Promise<Result> {
  if (!(await lockerAccess(actor.id)).vault) return err(NO("Passwords & keys"), "not_permitted");
  const [l] = await db.select().from(lockerLinks).where(eq(lockerLinks.id, linkId)).limit(1);
  if (!l) return ok(undefined);
  await db.transaction(async (tx) => {
    await tx.delete(lockerLinks).where(eq(lockerLinks.id, linkId));
    if (l.kind === "Shared sign-in") await tx.update(lockerCredentials).set({ viaIdentityId: null }).where(and(eq(lockerCredentials.id, l.credentialId), eq(lockerCredentials.viaIdentityId, l.identityId)));
    await lockerAuditTx(tx, { actorId: actor.id, actorName: actor.name, action: "locker.credential.edited", entityType: "credential", entityId: l.credentialId, summary: `Removed a connection: ${l.kind}` });
  });
  return ok(undefined);
}

/* ---------------------------------------------------------------- offboarding */

export type OffItem = { kind: string; id: string; title: string; action: string; done: boolean; to?: string | null };

/**
 * Everything a leaver owned, could reach or saw, as a list of things to do.
 * Every login they owned or revealed in 90 days is CHANGED, not just removed:
 * revoking an account does not make somebody forget a password.
 */
export async function startOffboarding(actor: User, userId: string): Promise<Result<{ id: string }>> {
  const refused = await need(actor, "locker.offboard", "Offboard");
  if (refused) return err(refused, "not_permitted");
  const [person] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!person) return err("Nobody was chosen.", "not_found");
  const [open] = await db.select({ id: lockerOffboarding.id }).from(lockerOffboarding).where(and(eq(lockerOffboarding.userId, userId), sql`${lockerOffboarding.completedAt} is null`)).limit(1);
  if (open) return ok({ id: open.id });
  const since = new Date(Date.now() - 90 * 86_400_000);
  const [assets, owned, revealed, idents, pms] = await Promise.all([
    db.select({ id: lockerAssets.id, title: lockerAssets.title, ownerId: lockerAssets.ownerId }).from(lockerAssets).where(and(or(eq(lockerAssets.ownerId, userId), eq(lockerAssets.backupId, userId)), sql`${lockerAssets.stage} is distinct from 'superseded' and ${lockerAssets.stage} is distinct from 'cancelled'`)),
    db.select({ id: lockerCredentials.id, title: lockerCredentials.title }).from(lockerCredentials).where(and(eq(lockerCredentials.active, true), or(eq(lockerCredentials.ownerId, userId), eq(lockerCredentials.backupOwnerId, userId)))),
    db.selectDistinct({ id: lockerCredentials.id, title: lockerCredentials.title }).from(lockerReveals).innerJoin(lockerCredentials, eq(lockerCredentials.id, lockerReveals.credentialId)).where(and(eq(lockerReveals.userId, userId), eq(lockerReveals.state, "revealed"), gte(lockerReveals.revealedAt, since))),
    db.select({ id: lockerIdentities.id, email: lockerIdentities.email, controlled: lockerIdentities.controlled }).from(lockerIdentities).where(and(eq(lockerIdentities.active, true), or(eq(lockerIdentities.ownerId, userId), sql`lower(${lockerIdentities.controlledByName}) = lower(${person.name})`))),
    db.select({ id: lockerPaymentMethods.id, label: lockerPaymentMethods.label, last4: lockerPaymentMethods.last4 }).from(lockerPaymentMethods).where(and(eq(lockerPaymentMethods.active, true), sql`lower(${lockerPaymentMethods.holder}) = lower(${person.name})`)),
  ]);
  const items: OffItem[] = [];
  for (const a of assets) items.push({ kind: "asset", id: a.id, title: a.title, action: a.ownerId === userId ? "Reassign the primary owner" : "Reassign the backup owner", done: false, to: null });
  const rot = new Map<string, string>();
  for (const c of [...owned, ...revealed]) rot.set(c.id, c.title);
  for (const [id, title] of rot) items.push({ kind: "rotate", id, title, action: "Change it, and record the new value", done: false });
  for (const i of idents) items.push({ kind: "identity", id: i.id, title: i.email, action: i.controlled ? "Hand the account to a new owner" : "Move every service off this personal account", done: false });
  for (const p of pms) items.push({ kind: "payment", id: p.id, title: `${p.label} ····${p.last4}`, action: "Move subscriptions off this card", done: false });
  items.push({ kind: "playbook", id: "handover", title: "Renewal steps and know-how only they hold", action: "Hand over, and record where it is written", done: false });
  const id = nid("lko");
  await db.transaction(async (tx) => {
    await tx.insert(lockerOffboarding).values({ id, userId, startedById: actor.id, items });
    await lockerAuditTx(tx, { actorId: actor.id, actorName: actor.name, action: "locker.offboard.started", entityType: "offboarding", entityId: id, entityTitle: person.name, summary: `Started offboarding ${person.name} · ${items.length} items`, security: true });
  });
  return ok({ id });
}

/** Tick one item. A login can only be ticked once a new value has been recorded since offboarding began. */
export async function completeOffItem(actor: User, offId: string, index: number, input: { done: boolean; to?: string | null }): Promise<Result> {
  const refused = await need(actor, "locker.offboard", "Offboard");
  if (refused) return err(refused, "not_permitted");
  const [ob] = await db.select().from(lockerOffboarding).where(eq(lockerOffboarding.id, offId)).limit(1);
  if (!ob) return err("Not found.", "not_found");
  if (ob.completedAt) return err("This offboarding is signed off.", "conflict");
  const item = ob.items[index];
  if (!item) return err("Not found.", "not_found");
  if (input.done && item.kind === "rotate") {
    const [c] = await db.select({ at: lockerCredentials.lastRotatedAt }).from(lockerCredentials).where(eq(lockerCredentials.id, item.id)).limit(1);
    if (!c?.at || c.at < ob.startedAt) return err("Record the new value on the login first — changing it is the task, not ticking it.", "rule_violation");
  }
  if (input.done && item.kind === "asset" && !input.to) return err("Choose who takes it over.");
  const items = ob.items.slice();
  items[index] = { ...item, done: input.done, to: input.to ?? item.to ?? null };
  await db.transaction(async (tx: Tx) => {
    if (input.done && item.kind === "asset" && input.to) {
      const [a] = await tx.select({ ownerId: lockerAssets.ownerId }).from(lockerAssets).where(eq(lockerAssets.id, item.id)).limit(1);
      if (a?.ownerId === ob.userId) await tx.update(lockerAssets).set({ ownerId: input.to, updatedAt: new Date() }).where(eq(lockerAssets.id, item.id));
      else await tx.update(lockerAssets).set({ backupId: input.to, updatedAt: new Date() }).where(eq(lockerAssets.id, item.id));
      await lockerAuditTx(tx, { actorId: actor.id, actorName: actor.name, action: "locker.asset.owner_set", entityType: "asset", entityId: item.id, entityTitle: item.title, summary: `Reassigned ${item.title} while offboarding` });
    }
    await tx.update(lockerOffboarding).set({ items }).where(eq(lockerOffboarding.id, offId));
    await lockerAuditTx(tx, { actorId: actor.id, actorName: actor.name, action: "locker.offboard.item_done", entityType: "offboarding", entityId: offId, entityTitle: item.title, summary: `${input.done ? "Done" : "Reopened"}: ${item.action} · ${item.title}` });
  });
  return ok(undefined);
}

/** Signing off is refused while anything is open. */
export async function signOffOffboarding(actor: User, offId: string): Promise<Result> {
  const refused = await need(actor, "locker.offboard", "Offboard");
  if (refused) return err(refused, "not_permitted");
  const [ob] = await db.select().from(lockerOffboarding).where(eq(lockerOffboarding.id, offId)).limit(1);
  if (!ob) return err("Not found.", "not_found");
  const open = ob.items.filter((i) => !i.done).length;
  if (open) return err(`It cannot be signed off with ${open} open ${open === 1 ? "task" : "tasks"}.`, "rule_violation");
  await db.transaction(async (tx) => {
    await tx.update(lockerOffboarding).set({ completedAt: new Date() }).where(eq(lockerOffboarding.id, offId));
    await lockerAuditTx(tx, { actorId: actor.id, actorName: actor.name, action: "locker.offboard.item_done", entityType: "offboarding", entityId: offId, summary: "Signed off an offboarding", security: true });
  });
  return ok(undefined, "Signed off");
}

/* ---------------------------------------------------- who holds the Locker */

export const LOCKER_MODULES = () => modulesForApp("locker");

/** Each person holding the Locker, with the modules they actually hold. */
export async function lockerHolders(): Promise<{ id: string; name: string; role: string; modules: string[]; active: boolean }[]> {
  const grants = await db.select({ userId: appAccess.userId, role: appAccess.role, name: users.name, active: users.active }).from(appAccess).innerJoin(users, eq(users.id, appAccess.userId)).where(eq(appAccess.app, "locker"));
  const out = [];
  for (const g of grants) {
    const keys = new Set<string>();
    for (const h of await holdersByUser(g.userId)) keys.add(h);
    out.push({ id: g.userId, name: g.name, role: String(g.role ?? "associate"), modules: [...keys], active: g.active });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function holdersByUser(userId: string): Promise<string[]> {
  const rows = await db.select({ module: appModuleAccess.module }).from(appModuleAccess).where(and(eq(appModuleAccess.userId, userId), eq(appModuleAccess.app, "locker")));
  const granted = rows.map((r) => r.module);
  const [hat] = await db.select({ role: appAccess.role }).from(appAccess).where(and(eq(appAccess.userId, userId), eq(appAccess.app, "locker"))).limit(1);
  if (!hat) return [];
  return modulesForApp("locker")
    .filter((m) => moduleAllowed(m.key, granted, "locker", hat.role === "admin"))
    .map((m) => m.key);
}

/**
 * Write one person's Locker modules — the whole list. None means the Locker is
 * taken away (with its module rows, as the Access dialog does). Through
 * `writeModules`, the same helper `setAccess` uses, so "every module" stores
 * no rows and a narrowed grant stays narrowed.
 */
export async function setLockerModules(actor: User, userId: string, modules: string[], why: string): Promise<Result> {
  const refused = await need(actor, "locker.access", "Admin › Access");
  const reviewer = (await lockerAccess(actor.id)).has("locker.review");
  if (refused && !reviewer) return err(refused, "not_permitted");
  const valid = new Set(modulesForApp("locker").map((m) => m.key));
  const wanted = [...new Set(modules)].filter((k) => valid.has(k));
  if (!wanted.includes("locker.access")) {
    const others = (await holdersOf("locker.access")).filter((h) => h.id !== userId);
    if (!others.length) return err("Somebody has to keep Admin › Access, or nobody can change the Locker's access again.", "rule_violation");
  }
  const [person] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
  if (!person) return err("Nobody was chosen.", "not_found");
  const before = await holdersByUser(userId);
  await db.transaction(async (tx) => {
    const [held] = await tx.select({ id: appAccess.id }).from(appAccess).where(and(eq(appAccess.userId, userId), eq(appAccess.app, "locker"))).limit(1);
    if (!wanted.length) {
      await tx.delete(appAccess).where(and(eq(appAccess.userId, userId), eq(appAccess.app, "locker")));
      await tx.delete(appModuleAccess).where(and(eq(appModuleAccess.userId, userId), eq(appModuleAccess.app, "locker")));
    } else {
      if (!held) await tx.insert(appAccess).values({ id: nid("acc"), userId, app: "locker", role: "associate", grantedById: actor.id });
      await writeModules(tx, userId, "locker", wanted, actor.id);
    }
    const hats = await tx.select({ app: appAccess.app, role: appAccess.role }).from(appAccess).where(eq(appAccess.userId, userId));
    await tx.update(users).set({ role: widestRole(hats.map((h) => ({ app: h.app, role: h.role ?? "associate" }))) }).where(eq(users.id, userId));
    const added = wanted.filter((k) => !before.includes(k));
    const removed = before.filter((k) => !wanted.includes(k));
    await lockerAuditTx(tx, {
      actorId: actor.id,
      actorName: actor.name,
      action: "locker.review.decided",
      entityType: "user",
      entityId: userId,
      entityTitle: person.name,
      summary: `${!wanted.length ? "Took the Locker away from" : "Changed the Locker access of"} ${person.name}${added.length ? ` · gave ${added.length}` : ""}${removed.length ? ` · removed ${removed.length}` : ""}`,
      reason: why || null,
      detail: { added, removed },
      security: true,
    });
  });
  /* A8: a permission change is notified — to the person, and to another admin. */
  const others = (await holdersOf("locker.access")).filter((h) => h.id !== actor.id && h.id !== userId);
  await notifyUsers([
    ...(userId !== actor.id ? [{ userId, title: "Your Locker access changed", body: `${actor.name} changed what you can open in the Locker.`, kind: "info", href: "/locker" }] : []),
    ...others.slice(0, 5).map((o) => ({ userId: o.id, title: "Locker access changed", body: `${actor.name} changed ${person.name}'s Locker access.`, kind: "info", href: "/locker/admin/access" })),
  ]);
  return ok(undefined, "Saved");
}

/* --------------------------------------------------------------- access review */

/** "2026-Q4" for a date. */
export function quarterOf(d: Date): string {
  const ist = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit" }).format(d);
  const [y, m] = ist.split("-").map(Number);
  return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
}

/** Open the period's review: one row per person × Locker module they hold, never twice. */
export async function openReview(actor: User, period: string): Promise<Result<{ rows: number }>> {
  const refused = await need(actor, "locker.review", "Access review");
  if (refused) return err(refused, "not_permitted");
  const holders = await lockerHolders();
  const values = holders.filter((h) => h.active).flatMap((h) => h.modules.map((m) => ({ id: nid("lkv"), period, userId: h.id, moduleKey: m })));
  if (values.length) await db.insert(lockerReviewItems).values(values).onConflictDoNothing();
  return ok({ rows: values.length });
}

/** Keep or remove one grant. Remove takes the module away, there and then. */
export async function decideReview(actor: User, itemId: string, decision: "keep" | "remove"): Promise<Result> {
  const refused = await need(actor, "locker.review", "Access review");
  if (refused) return err(refused, "not_permitted");
  const [it] = await db.select().from(lockerReviewItems).where(eq(lockerReviewItems.id, itemId)).limit(1);
  if (!it) return err("Not found.", "not_found");
  if (decision === "remove") {
    const now = await holdersByUser(it.userId);
    const res = await setLockerModules(actor, it.userId, now.filter((k) => k !== it.moduleKey), `Access review ${it.period}`);
    if (!res.ok) return res;
  }
  await db.transaction(async (tx) => {
    await tx.update(lockerReviewItems).set({ decision, decidedById: actor.id, decidedAt: new Date() }).where(eq(lockerReviewItems.id, itemId));
    await lockerAuditTx(tx, { actorId: actor.id, actorName: actor.name, action: "locker.review.decided", entityType: "user", entityId: it.userId, summary: `${decision === "keep" ? "Kept" : "Removed"} ${it.moduleKey} in the ${it.period} review`, security: decision === "remove" });
  });
  return ok(undefined);
}

export async function remindReviewer(actor: User, userId: string, period: string): Promise<Result> {
  const refused = await need(actor, "locker.review", "Access review");
  if (refused) return err(refused, "not_permitted");
  await notifyUsers([{ userId, title: `Locker access review ${period}`, body: `${actor.name} asked you to confirm the Locker access recorded against you.`, kind: "info", href: "/locker/review" }]);
  return ok(undefined, "Reminder sent");
}

/* ------------------------------------------------------------------- admin */

export type TypeInput = { code?: string; name: string; category: string; model: string; validityMonths: number; leadDays: number; graceDays: number; criticality: number; authority: string; typicalCostPaise: number; steps: string[]; consequence: string; fields: { key: string; label: string }[]; active: boolean };

export async function saveType(actor: User, code: string | null, t: TypeInput): Promise<Result<{ code: string }>> {
  const refused = await need(actor, "locker.types", "Admin › Types");
  if (refused) return err(refused, "not_permitted");
  if (!t.name.trim()) return err("Give the type a name.");
  if (!CATEGORY[t.category]) return err("Choose a category.");
  if (!["document", "subscription", "perpetual", "term_contract"].includes(t.model)) return err("Choose a time model.");
  if (![1, 2, 3, 4].includes(t.criticality)) return err("Choose an importance.");
  for (const n of [t.validityMonths, t.leadDays, t.graceDays, t.typicalCostPaise]) if (!Number.isFinite(n) || n < 0) return err("Numbers cannot be negative.");
  if (t.criticality === 4 && !t.consequence.trim()) return err("A business-critical type has to say what stops if it runs out.");
  const fields = t.fields
    .filter((f) => f.label.trim())
    .map((f) => ({ key: f.key || f.label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""), label: f.label.trim() }));
  const newCode = code ?? (t.code?.trim() || `${t.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24)}_${randomUUID().slice(0, 4)}`);
  const values = { name: t.name.trim(), category: t.category, model: t.model, validityMonths: Math.round(t.validityMonths), leadDays: Math.round(t.leadDays), graceDays: Math.round(t.graceDays), criticality: t.criticality, authority: t.authority.trim(), typicalCostPaise: Math.round(t.typicalCostPaise), steps: t.steps.map((s) => s.trim()).filter(Boolean), consequence: t.consequence.trim() || null, fields, active: t.active };
  await db.transaction(async (tx) => {
    if (code) await tx.update(lockerAssetTypes).set(values).where(eq(lockerAssetTypes.code, code));
    else await tx.insert(lockerAssetTypes).values({ code: newCode, ...values });
    await lockerAuditTx(tx, { actorId: actor.id, actorName: actor.name, action: "locker.type.saved", entityType: "type", entityId: newCode, entityTitle: values.name, summary: `${code ? "Changed" : "Added"} asset type ${values.name}` });
  });
  return ok({ code: newCode }, "Saved");
}

export async function saveLadder(actor: User, criticality: number, offsets: number[]): Promise<Result> {
  const refused = await need(actor, "locker.ladders", "Admin › Reminders");
  if (refused) return err(refused, "not_permitted");
  if (![1, 2, 3, 4].includes(criticality)) return err("Choose an importance.");
  const clean = [...new Set(offsets.filter((n) => Number.isInteger(n) && n >= -730 && n <= 60))].sort((a, b) => a - b);
  if (!clean.length) return err("A schedule needs at least one reminder.");
  if (!clean.includes(0)) return err("Every schedule reminds on the day itself (0).");
  await db.transaction(async (tx) => {
    await tx.insert(lockerReminderSchedules).values({ criticality, offsets: clean, updatedById: actor.id, updatedAt: new Date() }).onConflictDoUpdate({ target: lockerReminderSchedules.criticality, set: { offsets: clean, updatedById: actor.id, updatedAt: new Date() } });
    await lockerAuditTx(tx, { actorId: actor.id, actorName: actor.name, action: "locker.ladder.saved", entityType: "ladder", entityId: String(criticality), summary: `Changed the reminder schedule for importance ${criticality}: ${clean.join(", ")}` });
  });
  return ok(undefined, "Saved");
}

export async function saveEntity(actor: User, id: string | null, e: { name: string; gstin: string; isPrimary: boolean; active: boolean }): Promise<Result<{ id: string }>> {
  const refused = await need(actor, "locker.entities", "Admin › Companies");
  if (refused) return err(refused, "not_permitted");
  if (!e.name.trim()) return err("Give the company a name.");
  const gstin = e.gstin.trim().toUpperCase();
  if (gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/.test(gstin)) return err("That is not a GSTIN (15 characters, e.g. 27ABCDE1234F1Z5).");
  const rowId = id ?? nid("lke");
  await db.transaction(async (tx) => {
    if (e.isPrimary) await tx.update(lockerEntities).set({ isPrimary: false });
    const values = { name: e.name.trim(), gstin: gstin || null, isPrimary: e.isPrimary, active: e.active };
    if (id) await tx.update(lockerEntities).set(values).where(eq(lockerEntities.id, id));
    else await tx.insert(lockerEntities).values({ id: rowId, ...values });
    await lockerAuditTx(tx, { actorId: actor.id, actorName: actor.name, action: "locker.entity.saved", entityType: "entity", entityId: rowId, entityTitle: values.name, summary: `${id ? "Changed" : "Added"} company ${values.name}` });
  });
  return ok({ id: rowId }, "Saved");
}

export async function saveSite(actor: User, id: string | null, s: { name: string; kind: string; state: string; hazardous: boolean; entityId: string | null; active: boolean }): Promise<Result<{ id: string }>> {
  const refused = await need(actor, "locker.entities", "Admin › Companies");
  if (refused) return err(refused, "not_permitted");
  if (!s.name.trim()) return err("Give the site a name.");
  if (!["office", "factory", "godown", "depot"].includes(s.kind)) return err("Choose what kind of site it is.");
  const rowId = id ?? nid("lkt");
  await db.transaction(async (tx) => {
    const values = { name: s.name.trim(), kind: s.kind, state: s.state.trim(), hazardous: s.hazardous, entityId: s.entityId || null, active: s.active };
    if (id) await tx.update(lockerSites).set(values).where(eq(lockerSites.id, id));
    else await tx.insert(lockerSites).values({ id: rowId, ...values });
    await lockerAuditTx(tx, { actorId: actor.id, actorName: actor.name, action: "locker.site.saved", entityType: "site", entityId: rowId, entityTitle: values.name, summary: `${id ? "Changed" : "Added"} site ${values.name}${values.hazardous ? " (hazardous storage)" : ""}` });
  });
  return ok({ id: rowId }, "Saved");
}

export async function saveSettings(actor: User, next: LockerSettings): Promise<Result> {
  const refused = await need(actor, "locker.settings", "Admin › Security");
  if (refused) return err(refused, "not_permitted");
  const s = mergeSettings(next as unknown as Record<string, unknown>);
  for (const t of Object.values(s.tiers)) {
    if (t.showSeconds < 5 || t.showSeconds > 300) return err("A reveal stays on screen between 5 and 300 seconds.");
    if (t.clipboardSeconds < 0 || t.clipboardSeconds > 300) return err("The clipboard clears within 300 seconds.");
    if (t.rotateDays < 7 || t.rotateDays > 3650) return err("A change policy is between 7 days and 10 years.");
  }
  if (s.reasonMin < 5 || s.reasonMin > 200) return err("The shortest reason is between 5 and 200 characters.");
  if (s.approvalMinutes < 1 || s.approvalMinutes > 240) return err("An approval waits between 1 and 240 minutes.");
  if (s.revealsPerHour < 1) return err("At least one reveal an hour.");
  if (s.breakglassMinutes < 5 || s.breakglassMinutes > 240) return err("Emergency access lasts between 5 and 240 minutes.");
  if (s.workStartHour < 0 || s.workEndHour > 24 || s.workStartHour >= s.workEndHour) return err("Working hours start before they end.");
  await db.transaction(async (tx) => {
    await tx.insert(lockerSettings).values({ id: "locker", values: s as unknown as Record<string, unknown>, updatedById: actor.id, updatedAt: new Date() }).onConflictDoUpdate({ target: lockerSettings.id, set: { values: s as unknown as Record<string, unknown>, updatedById: actor.id, updatedAt: new Date() } });
    await lockerAuditTx(tx, { actorId: actor.id, actorName: actor.name, action: "locker.type.saved", entityType: "settings", entityId: "locker", summary: "Changed the Locker's security settings", detail: s as unknown as Record<string, unknown>, security: true });
  });
  const others = (await holdersOf("locker.access")).filter((h) => h.id !== actor.id);
  await notifyUsers(others.map((o) => ({ userId: o.id, title: "Locker security settings changed", body: `${actor.name} changed how reveals work.`, kind: "warn", href: "/locker/admin/security" })));
  return ok(undefined, "Saved");
}

