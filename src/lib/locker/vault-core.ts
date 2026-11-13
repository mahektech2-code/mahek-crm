import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, gte, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  appAccess,
  appModuleAccess,
  employees,
  lockerBreakglass,
  lockerCredentials,
  lockerIdentities,
  lockerLinks,
  lockerReveals,
  lockerSecrets,
  users,
  type User,
} from "@/db/schema";
import { moduleAllowed } from "@/lib/modules";
import { notifyUsers } from "@/lib/notify";
import { verifyPassword } from "@/lib/password";
import { err, ok, type Result } from "@/lib/result";
import { lockerAccess } from "./access";
import { lockerAuditTx } from "./audit";
import { fingerprint, hintOf, openValue, sealValue, vaultReady } from "./crypto";
import type { Tier } from "./engine";
import { lockerSettingsRow } from "./service";

/* ---------------------------------------------------------------------------
 * THE VAULT'S RULES, ENFORCED. Every function takes the acting user and
 * checks what that user may do — the "use server" actions are thin wrappers
 * that add `requireUser()`, so the rules here are the rules whatever calls
 * them, and the integration test calls them directly.
 *
 * A1  Nobody without the vault module reveals anything, by any path.
 * A2  A restricted reveal always needs a DIFFERENT person to approve.
 * A3  Emergency access is never invoked and approved by one person.
 * E7  The audit row is written in the reveal's own transaction BEFORE the
 *     value is decrypted and returned; if it cannot be written, nothing is.
 * E9  One value per request. There is no bulk reveal.
 * ------------------------------------------------------------------------- */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const nid = (p: string) => `${p}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
const REFUSED_VAULT = "You do not have Vault › Passwords & keys. A Locker admin can add it under Admin › Access.";

/* ------------------------------------------------------------- who holds what */

/** Everybody holding one Locker module, by the same rule the route guard reads. */
export async function holdersOf(key: string): Promise<{ id: string; name: string }[]> {
  const grants = await db
    .select({ userId: appAccess.userId, role: appAccess.role, name: users.name, active: users.active })
    .from(appAccess)
    .innerJoin(users, eq(users.id, appAccess.userId))
    .where(eq(appAccess.app, "locker"));
  const rows = await db.select({ userId: appModuleAccess.userId, module: appModuleAccess.module }).from(appModuleAccess).where(eq(appModuleAccess.app, "locker"));
  const byUser = new Map<string, string[]>();
  for (const r of rows) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r.module]);
  return grants.filter((g) => g.active && moduleAllowed(key, byUser.get(g.userId) ?? [], "locker", g.role === "admin")).map((g) => ({ id: g.userId, name: g.name }));
}

export async function employeeCode(userId: string): Promise<string> {
  const [r] = await db.select({ code: employees.employeeCode }).from(users).leftJoin(employees, eq(employees.id, users.employeeId)).where(eq(users.id, userId)).limit(1);
  return r?.code ?? "";
}

/* ------------------------------------------------------------- emergency access */

/** The emergency-access window in force over this login right now, if any. */
export async function activeBreakglassFor(credentialId: string): Promise<{ id: string; startedById: string } | null> {
  const rows = await db
    .select({ id: lockerBreakglass.id, scope: lockerBreakglass.scope, startedById: lockerBreakglass.startedById })
    .from(lockerBreakglass)
    .where(and(eq(lockerBreakglass.state, "active"), gt(lockerBreakglass.activeUntil, new Date())));
  const hit = rows.find((r) => r.scope.includes(credentialId));
  return hit ? { id: hit.id, startedById: hit.startedById } : null;
}

/* ------------------------------------------------------------------- reveal */

export type RevealPlan =
  | { step: "denied"; why: string; who: string[] }
  | { step: "ratelimited"; why: string; canBreakglass: boolean }
  | { step: "confirm" | "stepup"; askReason: boolean; reasonMin: number; showSeconds: number; tier: Tier; notice: string; emergency: boolean; approvedBy?: string; requestId?: string; approvalLeftMs?: number }
  | { step: "request"; reasonMin: number; approvers: string[]; approvalMinutes: number; tier: Tier }
  | { step: "waiting"; requestId: string; leftMs: number; totalMs: number; approvers: string[] }
  | { step: "declined"; by: string; note: string }
  | { step: "expired" }
  | { step: "novault"; why: string };

function noticeFor(tier: Tier, ownerName: string | null, showSeconds: number): string {
  if (tier === "restricted") return "The owner, the Locker admins and management are notified immediately.";
  if (tier === "sensitive") return `The owner, ${ownerName ?? "nobody"}, is notified. It hides after ${showSeconds} seconds.`;
  return `The reveal is recorded against your name. It hides after ${showSeconds} seconds.`;
}

async function loadCred(credentialId: string) {
  const [c] = await db.select().from(lockerCredentials).where(eq(lockerCredentials.id, credentialId)).limit(1);
  return c ?? null;
}

/** May this person reveal this login at all, before the tier's ceremony? */
async function mayReveal(actor: User, cred: NonNullable<Awaited<ReturnType<typeof loadCred>>>): Promise<{ ok: true; emergency: { id: string } | null } | { ok: false; why: string }> {
  const access = await lockerAccess(actor.id);
  if (!access.vault) return { ok: false, why: REFUSED_VAULT };
  if (!cred.active) return { ok: false, why: "This login has been retired." };
  const bg = await activeBreakglassFor(cred.id);
  if (cred.tier === "restricted" && !bg) {
    const named = cred.ownerId === actor.id || cred.revealers.includes(actor.id);
    if (!named) return { ok: false, why: "Restricted logins are revealed only by the people named on them. Ask the owner to add you, or use emergency access." };
  }
  return { ok: true, emergency: bg ? { id: bg.id } : null };
}

async function revealsLastHour(userId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(lockerReveals)
    .where(and(eq(lockerReveals.userId, userId), eq(lockerReveals.state, "revealed"), gte(lockerReveals.revealedAt, new Date(Date.now() - 3600_000))));
  return Number(r?.n ?? 0);
}

/** Lapse waiting requests and unspent approvals whose time has run out. */
export async function lapseRequests(): Promise<void> {
  const s = await lockerSettingsRow();
  const cutoff = new Date(Date.now() - s.approvalMinutes * 60_000);
  await db.update(lockerReveals).set({ state: "expired" }).where(and(eq(lockerReveals.state, "waiting"), sql`${lockerReveals.createdAt} < ${cutoff.toISOString()}`));
  await db.update(lockerReveals).set({ state: "expired" }).where(and(eq(lockerReveals.state, "approved"), sql`${lockerReveals.expiresAt} < now()`));
}

/** What the reveal dialog should ask for. Opening it reveals nothing. */
export async function planReveal(actor: User, credentialId: string, field: string, previousSecretId: string | null): Promise<RevealPlan> {
  if (!vaultReady()) return { step: "novault", why: "This deployment has no vault key, so nothing can be revealed." };
  const cred = await loadCred(credentialId);
  if (!cred) return { step: "denied", why: "That login does not exist.", who: [] };
  const may = await mayReveal(actor, cred);
  const s = await lockerSettingsRow();
  if (!may.ok) {
    const who = (await holdersOf("locker.credentials")).filter((h) => cred.tier !== "restricted" || h.id === cred.ownerId || cred.revealers.includes(h.id)).map((h) => h.name);
    return { step: "denied", why: may.why, who };
  }
  const access = await lockerAccess(actor.id);
  if ((await revealsLastHour(actor.id)) >= s.revealsPerHour)
    return { step: "ratelimited", why: `You have revealed ${s.revealsPerHour} secrets in the last hour. That is the limit for one person; reveals open again within the hour. The Locker admins have been told, in case this is an emergency.`, canBreakglass: access.has("locker.approvals") };
  const tier = cred.tier as Tier;
  const rules = s.tiers[tier];
  const owner = cred.ownerId ? (await db.select({ name: users.name }).from(users).where(eq(users.id, cred.ownerId)))[0]?.name ?? null : null;
  const prev = !!previousSecretId;
  const askReason = rules.reason || prev || !!may.emergency;
  if (tier === "restricted" && !may.emergency) {
    await lapseRequests();
    const [req] = await db
      .select()
      .from(lockerReveals)
      .where(and(eq(lockerReveals.credentialId, cred.id), eq(lockerReveals.userId, actor.id), eq(lockerReveals.field, field), eq(lockerReveals.previous, prev), inArray(lockerReveals.state, ["waiting", "approved", "declined"])))
      .orderBy(desc(lockerReveals.createdAt))
      .limit(1);
    const approvers = (await holdersOf("locker.approvals")).filter((h) => h.id !== actor.id).map((h) => h.name);
    if (req?.state === "waiting") {
      const total = s.approvalMinutes * 60_000;
      return { step: "waiting", requestId: req.id, leftMs: Math.max(0, req.createdAt.getTime() + total - Date.now()), totalMs: total, approvers };
    }
    if (req?.state === "approved" && req.expiresAt) {
      const by = req.decidedById ? (await db.select({ name: users.name }).from(users).where(eq(users.id, req.decidedById)))[0]?.name ?? "" : "";
      return { step: "stepup", askReason: false, reasonMin: s.reasonMin, showSeconds: rules.showSeconds, tier, notice: noticeFor(tier, owner, rules.showSeconds), emergency: false, approvedBy: by, requestId: req.id, approvalLeftMs: req.expiresAt.getTime() - Date.now() };
    }
    if (req?.state === "declined" && req.decidedAt && Date.now() - req.decidedAt.getTime() < 10 * 60_000) {
      const by = req.decidedById ? (await db.select({ name: users.name }).from(users).where(eq(users.id, req.decidedById)))[0]?.name ?? "" : "";
      return { step: "declined", by, note: req.decisionNote ?? "" };
    }
    return { step: "request", reasonMin: s.reasonMin, approvers, approvalMinutes: s.approvalMinutes, tier };
  }
  return {
    step: rules.stepUp || prev || may.emergency ? "stepup" : "confirm",
    askReason,
    reasonMin: s.reasonMin,
    showSeconds: rules.showSeconds,
    tier,
    notice: noticeFor(tier, owner, rules.showSeconds) + (may.emergency ? " You are using emergency access; this is in the after-emergency report." : ""),
    emergency: !!may.emergency,
  };
}

/** Raise a restricted-reveal request. The reason is captured here, once. */
export async function requestReveal(actor: User, credentialId: string, field: string, previousSecretId: string | null, reason: string): Promise<Result<{ requestId: string }>> {
  const cred = await loadCred(credentialId);
  if (!cred) return err("That login does not exist.", "not_found");
  const may = await mayReveal(actor, cred);
  if (!may.ok) return err(may.why, "not_permitted");
  if (cred.tier !== "restricted") return err("Only a restricted login needs an approval.");
  const s = await lockerSettingsRow();
  if (reason.trim().length < s.reasonMin) return err(`Give a reason of at least ${s.reasonMin} characters — it is kept on the record.`);
  const approvers = (await holdersOf("locker.approvals")).filter((h) => h.id !== actor.id);
  if (!approvers.length) return err("Nobody else holds Approvals in the Locker, so a restricted reveal cannot be approved. Ask a Locker admin to give a second person Approvals.", "rule_violation");
  const id = nid("lkr");
  await db.transaction(async (tx) => {
    await tx.insert(lockerReveals).values({ id, credentialId, secretId: previousSecretId, field, previous: !!previousSecretId, userId: actor.id, reason: reason.trim(), state: "waiting" });
    await lockerAuditTx(tx, {
      actorId: actor.id,
      actorName: actor.name,
      action: "locker.secret.reveal_requested",
      entityType: "credential",
      entityId: cred.id,
      entityTitle: cred.title,
      summary: `Asked to reveal ${cred.title} · ${field}${previousSecretId ? " (previous value)" : ""}`,
      reason: reason.trim(),
      security: true,
    });
  });
  await notifyUsers(
    approvers.map((a) => ({ userId: a.id, title: "A restricted reveal needs your approval", body: `${actor.name} asked to reveal ${cred.title} · ${field}: “${reason.trim()}”. It lapses in ${s.approvalMinutes} minutes.`, kind: "warn", href: "/locker/approvals" })),
  );
  return ok({ requestId: id });
}

/** Approve or decline somebody's restricted reveal. Never your own (A2). */
export async function decideReveal(actor: User, requestId: string, approve: boolean, note: string): Promise<Result> {
  const access = await lockerAccess(actor.id);
  if (!access.has("locker.approvals")) return err("Approving needs Approvals in the Locker.", "not_permitted");
  await lapseRequests();
  const [req] = await db.select().from(lockerReveals).where(eq(lockerReveals.id, requestId)).limit(1);
  if (!req) return err("That request no longer exists.", "not_found");
  if (req.userId === actor.id) return err("You cannot approve your own reveal. A different person has to.", "rule_violation");
  if (req.state !== "waiting") return err(req.state === "expired" ? "That request lapsed before anybody decided it." : "That request has already been decided.", "conflict");
  if (!approve && note.trim().length < 5) return err("Say why you are declining — the requester has to know what to do instead.");
  const cred = await loadCred(req.credentialId);
  const s = await lockerSettingsRow();
  await db.transaction(async (tx) => {
    await tx
      .update(lockerReveals)
      .set({ state: approve ? "approved" : "declined", decidedById: actor.id, decidedAt: new Date(), decisionNote: note.trim() || null, expiresAt: approve ? new Date(Date.now() + s.approvalMinutes * 60_000) : null })
      .where(and(eq(lockerReveals.id, requestId), eq(lockerReveals.state, "waiting")));
    await lockerAuditTx(tx, {
      actorId: actor.id,
      actorName: actor.name,
      action: approve ? "locker.secret.reveal_approved" : "locker.secret.reveal_declined",
      entityType: "credential",
      entityId: req.credentialId,
      entityTitle: cred?.title ?? "",
      summary: `${approve ? "Approved" : "Declined"} a reveal of ${cred?.title ?? "a login"} · ${req.field}`,
      reason: note.trim() || null,
      approvedById: approve ? actor.id : null,
      security: true,
    });
  });
  await notifyUsers([
    {
      userId: req.userId,
      title: approve ? "Your reveal was approved" : "Your reveal was declined",
      body: approve ? `${actor.name} approved revealing ${cred?.title ?? "the login"}. Open it within ${s.approvalMinutes} minutes.` : `${actor.name} declined: “${note.trim()}”`,
      kind: approve ? "info" : "warn",
      href: `/locker/vault/${req.credentialId}`,
    },
  ]);
  return ok(undefined, approve ? "Approved" : "Declined");
}

export async function withdrawRequest(actor: User, requestId: string): Promise<Result> {
  const [req] = await db.select().from(lockerReveals).where(eq(lockerReveals.id, requestId)).limit(1);
  if (!req || req.userId !== actor.id) return err("That request is not yours.", "not_permitted");
  if (req.state !== "waiting" && req.state !== "approved") return ok(undefined);
  await db.transaction(async (tx) => {
    await tx.update(lockerReveals).set({ state: "expired" }).where(eq(lockerReveals.id, requestId));
    await lockerAuditTx(tx, { actorId: actor.id, actorName: actor.name, action: "locker.secret.reveal_declined", entityType: "credential", entityId: req.credentialId, summary: "Withdrew a reveal request", security: true });
  });
  return ok(undefined);
}

export type Revealed = { value: string; showSeconds: number; clipboardSeconds: number; watermark: string | null; field: string; previous: boolean };

/**
 * THE REVEAL. Checks everything again (the plan the dialog was shown is
 * advice, this is the rule), writes the reveal row and its audit row in one
 * transaction, decrypts inside it, and only then returns the value. A tampered
 * ciphertext throws, the transaction rolls back, and nothing is returned.
 */
export async function performReveal(
  actor: User,
  input: { credentialId: string; field: string; previousSecretId?: string | null; password?: string; reason?: string; requestId?: string | null },
): Promise<Result<Revealed>> {
  if (!vaultReady()) return err("This deployment has no vault key.", "rule_violation");
  const cred = await loadCred(input.credentialId);
  if (!cred) return err("That login does not exist.", "not_found");
  const may = await mayReveal(actor, cred);
  if (!may.ok) return err(may.why, "not_permitted");
  const s = await lockerSettingsRow();
  const tier = cred.tier as Tier;
  const rules = s.tiers[tier];
  const prev = !!input.previousSecretId;
  const emergency = may.emergency;

  if ((await revealsLastHour(actor.id)) >= s.revealsPerHour) {
    const admins = await holdersOf("locker.access");
    await notifyUsers(admins.map((a) => ({ userId: a.id, title: "Locker reveals paused for one person", body: `${actor.name} reached ${s.revealsPerHour} reveals in an hour and was paused.`, kind: "warn", href: "/locker/audit" })));
    return err("Reveals are paused: you reached the hourly limit. The Locker admins have been told.", "rule_violation");
  }

  /* Step-up: the person's own MahekOne password. */
  if (rules.stepUp || prev || emergency) {
    const [u] = await db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, actor.id)).limit(1);
    if (!input.password || !u || !(await verifyPassword(input.password, u.hash))) {
      await db.transaction((tx) =>
        lockerAuditTx(tx, { actorId: actor.id, actorName: actor.name, action: "locker.secret.reveal_declined", entityType: "credential", entityId: cred.id, entityTitle: cred.title, summary: `Extra check failed revealing ${cred.title}`, security: true }),
      );
      return err("That password didn’t match.", "not_permitted", [{ field: "password", message: "That password didn’t match." }]);
    }
  }

  /* Restricted: an approval by somebody else, unspent and in time. */
  let request: typeof lockerReveals.$inferSelect | null = null;
  if (tier === "restricted" && !emergency) {
    await lapseRequests();
    if (!input.requestId) return err("A restricted login needs a second person’s approval first.", "rule_violation");
    const [r] = await db.select().from(lockerReveals).where(eq(lockerReveals.id, input.requestId)).limit(1);
    if (!r || r.userId !== actor.id || r.credentialId !== cred.id || r.field !== input.field || r.previous !== prev) return err("That approval is for a different reveal.", "not_permitted");
    if (r.state !== "approved") return err(r.state === "expired" ? "The approval lapsed. Ask again." : "This reveal has not been approved.", "rule_violation");
    if (!r.decidedById || r.decidedById === actor.id) return err("A restricted reveal needs a different person to approve it.", "rule_violation");
    request = r;
  }

  const reason = (request?.reason ?? input.reason ?? "").trim();
  if ((rules.reason || prev || emergency) && !request && reason.length < s.reasonMin) return err(`Give a reason of at least ${s.reasonMin} characters.`, "validation", [{ field: "reason", message: `At least ${s.reasonMin} characters.` }]);

  /* The value: the current one for the field, or a named previous one of this login. */
  const [secret] = prev
    ? await db.select().from(lockerSecrets).where(and(eq(lockerSecrets.id, input.previousSecretId!), eq(lockerSecrets.credentialId, cred.id))).limit(1)
    : await db.select().from(lockerSecrets).where(and(eq(lockerSecrets.credentialId, cred.id), eq(lockerSecrets.field, input.field), isNull(lockerSecrets.retiredAt))).limit(1);
  if (!secret) return err("No value is stored for that field.", "not_found");

  const now = new Date();
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false }).format(now));
  const outside = hour < s.workStartHour || hour >= s.workEndHour;
  const [firstEver] = await db.select({ id: lockerReveals.id }).from(lockerReveals).where(and(eq(lockerReveals.credentialId, cred.id), eq(lockerReveals.state, "revealed"))).limit(1);

  let value: string;
  try {
    value = await db.transaction(async (tx: Tx) => {
      if (request) {
        const spent = await tx.update(lockerReveals).set({ state: "revealed", revealedAt: now, secretId: secret.id }).where(and(eq(lockerReveals.id, request.id), eq(lockerReveals.state, "approved"))).returning({ id: lockerReveals.id });
        if (!spent.length) throw new Error("That approval was already used.");
      } else {
        await tx.insert(lockerReveals).values({
          id: nid("lkr"),
          credentialId: cred.id,
          secretId: secret.id,
          field: input.field,
          previous: prev,
          userId: actor.id,
          reason: reason || "Standard reveal — no reason required",
          state: "revealed",
          revealedAt: now,
          breakglassId: emergency?.id ?? null,
        });
      }
      /* E7: the audit row BEFORE the value exists outside the database. */
      await lockerAuditTx(tx, {
        actorId: actor.id,
        actorName: actor.name,
        action: "locker.secret.revealed",
        entityType: "credential",
        entityId: cred.id,
        entityTitle: cred.title,
        summary: `Revealed ${cred.title} · ${input.field}${prev ? " (previous value)" : ""}${emergency ? " · under emergency access" : ""}`,
        reason: reason || null,
        approvedById: request?.decidedById ?? null,
        detail: { tier, field: input.field, previous: prev, breakglassId: emergency?.id ?? null, notable: outside || !firstEver ? [outside ? "outside working hours" : null, !firstEver ? "first reveal of this item" : null].filter(Boolean) : [] },
        security: true,
      });
      return openValue({ ciphertext: secret.ciphertext, wrappedDek: secret.wrappedDek, kekVersion: secret.kekVersion });
    });
  } catch (e) {
    const tampered = e instanceof Error && /auth|unsupported state|Unsupported state|malformed/i.test(e.message);
    await db.transaction((tx) =>
      lockerAuditTx(tx, {
        actorId: actor.id,
        actorName: actor.name,
        action: "locker.secret.reveal_declined",
        entityType: "credential",
        entityId: cred.id,
        entityTitle: cred.title,
        summary: tampered ? `Reveal of ${cred.title} failed: the stored value did not pass its integrity check` : `Reveal of ${cred.title} failed`,
        security: true,
      }),
    );
    return err(tampered ? "The stored value failed its integrity check, so it was not revealed. The Locker admins should look at this." : e instanceof Error && /already used/.test(e.message) ? e.message : "The value could not be revealed.", "rule_violation");
  }

  /* Who is told — after the commit, and never able to undo it. */
  const tell = new Set<string>();
  if (tier !== "standard" && cred.ownerId && cred.ownerId !== actor.id) tell.add(cred.ownerId);
  if (tier === "restricted" || emergency) for (const h of [...(await holdersOf("locker.approvals")), ...(await holdersOf("locker.access"))]) if (h.id !== actor.id) tell.add(h.id);
  if (outside) for (const h of await holdersOf("locker.access")) if (h.id !== actor.id) tell.add(h.id);
  if (tell.size)
    await notifyUsers(
      [...tell].map((userId) => ({ userId, title: `${cred.title} was revealed`, body: `${actor.name} revealed ${input.field}${prev ? " (previous value)" : ""}${reason ? `: “${reason}”` : ""}${outside ? " · outside working hours" : ""}.`, kind: tier === "restricted" ? "warn" : "info", href: `/locker/vault/${cred.id}` })),
    );

  const stamp = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  const code = await employeeCode(actor.id);
  return ok({
    value,
    field: input.field,
    previous: prev,
    showSeconds: rules.showSeconds,
    clipboardSeconds: rules.clipboardSeconds,
    watermark: rules.watermark || emergency ? `${actor.name.toUpperCase()}${code ? ` · ${code}` : ""} · ${stamp} IST` : null,
  });
}

export async function recordCopy(actor: User, credentialId: string, field: string): Promise<void> {
  const cred = await loadCred(credentialId);
  if (!cred || cred.tier === "restricted") return;
  await db.transaction((tx) =>
    lockerAuditTx(tx, { actorId: actor.id, actorName: actor.name, action: "locker.secret.copied", entityType: "credential", entityId: cred.id, entityTitle: cred.title, summary: `Copied ${cred.title} · ${field} to the clipboard`, security: true }),
  );
}

/* ------------------------------------------------------------ writing secrets */

/** Store a value for one field: retire the current one, keep it as a previous value, seal the new one. */
export async function writeSecret(tx: Tx, credentialId: string, field: string, plain: string, byId: string): Promise<void> {
  const sealed = sealValue(plain);
  await tx.update(lockerSecrets).set({ retiredAt: new Date() }).where(and(eq(lockerSecrets.credentialId, credentialId), eq(lockerSecrets.field, field), isNull(lockerSecrets.retiredAt)));
  await tx.insert(lockerSecrets).values({ id: nid("lks"), credentialId, field, ...sealed, hint: hintOf(plain), fingerprint: fingerprint(plain), createdById: byId });
}

/** Other active logins whose CURRENT value matches one of this login's, by fingerprint only. */
export async function reuseOf(credentialId: string): Promise<{ id: string; title: string }[]> {
  const mine = await db.select({ fp: lockerSecrets.fingerprint }).from(lockerSecrets).where(and(eq(lockerSecrets.credentialId, credentialId), isNull(lockerSecrets.retiredAt)));
  const fps = mine.map((m) => m.fp).filter(Boolean);
  if (!fps.length) return [];
  const rows = await db
    .selectDistinct({ id: lockerCredentials.id, title: lockerCredentials.title })
    .from(lockerSecrets)
    .innerJoin(lockerCredentials, eq(lockerCredentials.id, lockerSecrets.credentialId))
    .where(and(inArray(lockerSecrets.fingerprint, fps), isNull(lockerSecrets.retiredAt), eq(lockerCredentials.active, true), sql`${lockerSecrets.credentialId} <> ${credentialId}`));
  return rows;
}

export type CredentialInput = {
  title: string;
  kind: string;
  tier: Tier;
  provider: string;
  url: string;
  username: string;
  env: string;
  auth: string;
  viaIdentityId: string | null;
  sole: boolean;
  identityId: string | null;
  assetId: string | null;
  ownerId: string | null;
  backupOwnerId: string | null;
  mfa: boolean;
  mfaMethod: string;
  recoveryEmail: string;
  accessLevel: string;
  rotateEveryDays: number | null;
  revealers: string[];
  notes: string;
  /** Field name → value, for a new login. Ignored on edit. */
  secrets?: Record<string, string>;
};

function cleanInput(i: CredentialInput): CredentialInput | string {
  if (!i.title.trim()) return "Give the login a title.";
  if (!i.ownerId) return "Every login needs an owner.";
  if (!["standard", "sensitive", "restricted"].includes(i.tier)) return "Choose a level.";
  if (i.auth === "federated_sso" && !i.viaIdentityId) return "Choose which sign-in account it signs in with.";
  /* A bank or payment login is always restricted (PRD §5.1). */
  const tier: Tier = /^(Banking|Payment card portal)$/.test(i.kind) ? "restricted" : i.tier;
  return { ...i, tier, title: i.title.trim(), provider: i.provider.trim(), url: i.url.trim(), username: i.username.trim(), revealers: [...new Set(i.revealers.filter(Boolean))] };
}

/** Keep the "signs in with" link in step with the via account: one edge, kept in locker_links. */
async function syncViaLink(tx: Tx, credentialId: string, viaIdentityId: string | null, sole: boolean) {
  await tx.delete(lockerLinks).where(and(eq(lockerLinks.credentialId, credentialId), eq(lockerLinks.kind, "Shared sign-in")));
  if (viaIdentityId) await tx.insert(lockerLinks).values({ id: nid("lkl"), credentialId, identityId: viaIdentityId, kind: "Shared sign-in", sole }).onConflictDoNothing();
}

async function syncRecoveryLink(tx: Tx, credentialId: string, email: string) {
  await tx.delete(lockerLinks).where(and(eq(lockerLinks.credentialId, credentialId), eq(lockerLinks.kind, "Recovery email")));
  const e = email.trim().toLowerCase();
  if (!e) return;
  const [idn] = await tx.select({ id: lockerIdentities.id }).from(lockerIdentities).where(sql`lower(${lockerIdentities.email}) = ${e}`).limit(1);
  if (idn) await tx.insert(lockerLinks).values({ id: nid("lkl"), credentialId, identityId: idn.id, kind: "Recovery email", sole: false }).onConflictDoNothing();
}

export async function createCredential(actor: User, raw: CredentialInput): Promise<Result<{ id: string; reusedWith: string[] }>> {
  const access = await lockerAccess(actor.id);
  if (!access.vault) return err(REFUSED_VAULT, "not_permitted");
  if (!vaultReady()) return err("This deployment has no vault key, so nothing can be stored.", "rule_violation");
  const i = cleanInput(raw);
  if (typeof i === "string") return err(i);
  const secrets = Object.entries(i.secrets ?? {}).filter(([, v]) => v.length);
  if (i.auth !== "federated_sso" && !secrets.length) return err("Enter the secret — it is encrypted the moment you save.");
  const id = nid("lkc");
  await db.transaction(async (tx) => {
    await tx.insert(lockerCredentials).values({
      id,
      title: i.title,
      kind: i.kind,
      tier: i.tier,
      provider: i.provider,
      url: i.url,
      username: i.username,
      env: i.env,
      auth: i.auth,
      viaIdentityId: i.viaIdentityId,
      sole: i.sole,
      identityId: i.identityId,
      assetId: i.assetId,
      ownerId: i.ownerId,
      backupOwnerId: i.backupOwnerId,
      mfa: i.mfa,
      mfaMethod: i.mfaMethod,
      recoveryEmail: i.recoveryEmail,
      accessLevel: i.accessLevel,
      rotateEveryDays: i.rotateEveryDays,
      revealers: i.revealers,
      notes: i.notes || null,
      lastRotatedAt: new Date(),
      createdById: actor.id,
    });
    for (const [field, v] of secrets) await writeSecret(tx, id, field, v, actor.id);
    await syncViaLink(tx, id, i.viaIdentityId, i.sole);
    await syncRecoveryLink(tx, id, i.recoveryEmail);
    await lockerAuditTx(tx, { actorId: actor.id, actorName: actor.name, action: "locker.credential.created", entityType: "credential", entityId: id, entityTitle: i.title, summary: `Added login ${i.title} (${i.tier})`, detail: { fields: secrets.map(([f]) => f) }, security: i.tier !== "standard" });
  });
  return ok({ id, reusedWith: (await reuseOf(id)).map((r) => r.title) });
}

export async function updateCredential(actor: User, id: string, raw: CredentialInput): Promise<Result> {
  const access = await lockerAccess(actor.id);
  if (!access.vault) return err(REFUSED_VAULT, "not_permitted");
  const before = await loadCred(id);
  if (!before) return err("That login does not exist.", "not_found");
  const i = cleanInput(raw);
  if (typeof i === "string") return err(i);
  await db.transaction(async (tx) => {
    await tx
      .update(lockerCredentials)
      .set({
        title: i.title,
        kind: i.kind,
        tier: i.tier,
        provider: i.provider,
        url: i.url,
        username: i.username,
        env: i.env,
        auth: i.auth,
        viaIdentityId: i.viaIdentityId,
        sole: i.sole,
        identityId: i.identityId,
        assetId: i.assetId,
        ownerId: i.ownerId,
        backupOwnerId: i.backupOwnerId,
        mfa: i.mfa,
        mfaMethod: i.mfaMethod,
        recoveryEmail: i.recoveryEmail,
        accessLevel: i.accessLevel,
        rotateEveryDays: i.rotateEveryDays,
        revealers: i.revealers,
        notes: i.notes || null,
        updatedAt: new Date(),
      })
      .where(eq(lockerCredentials.id, id));
    await syncViaLink(tx, id, i.viaIdentityId, i.sole);
    await syncRecoveryLink(tx, id, i.recoveryEmail);
    const changed = (["tier", "ownerId", "viaIdentityId", "sole", "mfa", "revealers"] as const).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(i[k]));
    await lockerAuditTx(tx, {
      actorId: actor.id,
      actorName: actor.name,
      action: "locker.credential.edited",
      entityType: "credential",
      entityId: id,
      entityTitle: i.title,
      summary: `Changed login ${i.title}${before.tier !== i.tier ? ` · level ${before.tier} → ${i.tier}` : ""}`,
      detail: { changed },
      security: changed.includes("tier") || changed.includes("revealers"),
    });
  });
  /* A7: an admin's change to a login is never silent. */
  const others = (await holdersOf("locker.access")).filter((h) => h.id !== actor.id);
  if (others.length && (before.tier !== i.tier || JSON.stringify(before.revealers) !== JSON.stringify(i.revealers)))
    await notifyUsers(others.map((o) => ({ userId: o.id, title: `${i.title} changed`, body: `${actor.name} changed who can reveal it or its level.`, kind: "info", href: `/locker/vault/${id}` })));
  return ok(undefined, "Saved");
}

/** Record a password change: the old value becomes a previous value, kept encrypted. */
export async function recordChange(actor: User, id: string, field: string, value: string, note: string): Promise<Result<{ reusedWith: string[] }>> {
  const access = await lockerAccess(actor.id);
  if (!access.vault) return err(REFUSED_VAULT, "not_permitted");
  if (!vaultReady()) return err("This deployment has no vault key.", "rule_violation");
  const cred = await loadCred(id);
  if (!cred) return err("That login does not exist.", "not_found");
  if (!value) return err("Enter the new value.");
  if (note.trim().length < 10) return err("Say what you changed and checked — at least 10 characters.");
  await db.transaction(async (tx) => {
    await writeSecret(tx, id, field, value, actor.id);
    await tx.update(lockerCredentials).set({ lastRotatedAt: new Date(), lastVerifiedAt: new Date(), updatedAt: new Date() }).where(eq(lockerCredentials.id, id));
    await lockerAuditTx(tx, { actorId: actor.id, actorName: actor.name, action: "locker.secret.changed", entityType: "credential", entityId: id, entityTitle: cred.title, summary: `Changed ${cred.title} · ${field}`, reason: note.trim(), detail: { field }, security: cred.tier !== "standard" });
  });
  return ok({ reusedWith: (await reuseOf(id)).map((r) => r.title) }, "Change recorded");
}

/* ------------------------------------------------------------- emergency access */

export async function startBreakglass(actor: User, scope: string[], reason: string): Promise<Result<{ id: string }>> {
  const access = await lockerAccess(actor.id);
  if (!access.has("locker.approvals") || !access.vault) return err("Only somebody holding both Approvals and Passwords & keys can start emergency access.", "not_permitted");
  const s = await lockerSettingsRow();
  if (reason.trim().length < Math.max(30, s.reasonMin)) return err(`Give a reason of at least ${Math.max(30, s.reasonMin)} characters — it is recorded word for word in the after-emergency report.`);
  const ids = [...new Set(scope)];
  if (!ids.length) return err("Choose the named items the emergency needs — never everything.");
  const found = await db.select({ id: lockerCredentials.id }).from(lockerCredentials).where(and(inArray(lockerCredentials.id, ids), eq(lockerCredentials.active, true)));
  if (found.length !== ids.length) return err("One of the chosen logins no longer exists.");
  const [open] = await db.select({ id: lockerBreakglass.id }).from(lockerBreakglass).where(inArray(lockerBreakglass.state, ["awaiting", "active"])).limit(1);
  if (open) return err("Emergency access is already open or waiting. Finish that one first.", "conflict");
  const id = nid("lkb");
  await db.transaction(async (tx) => {
    await tx.insert(lockerBreakglass).values({ id, startedById: actor.id, reason: reason.trim(), scope: ids, minutes: s.breakglassMinutes, state: "awaiting" });
    await lockerAuditTx(tx, { actorId: actor.id, actorName: actor.name, action: "locker.breakglass.started", entityType: "breakglass", entityId: id, summary: `Asked for emergency access · ${ids.length} items`, reason: reason.trim(), detail: { scope: ids }, security: true });
  });
  const tell = new Map<string, string>();
  for (const h of [...(await holdersOf("locker.approvals")), ...(await holdersOf("locker.access"))]) if (h.id !== actor.id) tell.set(h.id, h.name);
  await notifyUsers([...tell.keys()].map((userId) => ({ userId, title: "EMERGENCY ACCESS requested in the Locker", body: `${actor.name}: “${reason.trim()}” · ${ids.length} items. A second person must approve.`, kind: "danger", href: "/locker/emergency" })));
  return ok({ id });
}

export async function decideBreakglass(actor: User, id: string, approve: boolean): Promise<Result> {
  const access = await lockerAccess(actor.id);
  if (!access.has("locker.approvals")) return err("Approving needs Approvals in the Locker.", "not_permitted");
  const [bg] = await db.select().from(lockerBreakglass).where(eq(lockerBreakglass.id, id)).limit(1);
  if (!bg) return err("That request no longer exists.", "not_found");
  if (bg.startedById === actor.id) return err("The person who started emergency access cannot approve it. A different person has to.", "rule_violation");
  if (bg.state !== "awaiting") return err("That request has already been decided.", "conflict");
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(lockerBreakglass)
      .set(approve ? { state: "active", approvedById: actor.id, activeFrom: now, activeUntil: new Date(now.getTime() + bg.minutes * 60_000) } : { state: "declined", approvedById: actor.id, endedAt: now })
      .where(and(eq(lockerBreakglass.id, id), eq(lockerBreakglass.state, "awaiting")));
    await lockerAuditTx(tx, { actorId: actor.id, actorName: actor.name, action: approve ? "locker.breakglass.approved" : "locker.breakglass.declined", entityType: "breakglass", entityId: id, summary: `${approve ? "Approved" : "Declined"} emergency access`, approvedById: approve ? actor.id : null, security: true });
  });
  const everyone = new Set<string>([bg.startedById]);
  for (const h of [...(await holdersOf("locker.approvals")), ...(await holdersOf("locker.access")), ...(await holdersOf("locker.credentials"))]) everyone.add(h.id);
  everyone.delete(actor.id);
  await notifyUsers(
    [...everyone].map((userId) => ({ userId, title: approve ? "EMERGENCY ACCESS IS ACTIVE in the Locker" : "Emergency access was declined", body: approve ? `Approved by ${actor.name} for ${bg.minutes} minutes · ${bg.scope.length} items. Every access is recorded.` : `${actor.name} declined it.`, kind: approve ? "danger" : "info", href: "/locker/emergency" })),
  );
  return ok(undefined);
}

export async function endBreakglass(actor: User, id: string): Promise<Result> {
  const access = await lockerAccess(actor.id);
  const [bg] = await db.select().from(lockerBreakglass).where(eq(lockerBreakglass.id, id)).limit(1);
  if (!bg) return err("Not found.", "not_found");
  if (!access.has("locker.approvals") && bg.startedById !== actor.id) return err("Ending it needs Approvals.", "not_permitted");
  if (bg.state !== "active" && bg.state !== "awaiting") return ok(undefined);
  await db.transaction(async (tx) => {
    await tx.update(lockerBreakglass).set({ state: "ended", endedAt: new Date(), endedById: actor.id, activeUntil: bg.state === "active" ? new Date() : bg.activeUntil }).where(eq(lockerBreakglass.id, id));
    await lockerAuditTx(tx, { actorId: actor.id, actorName: actor.name, action: "locker.breakglass.ended", entityType: "breakglass", entityId: id, summary: "Ended emergency access", security: true });
  });
  return ok(undefined);
}

export async function reviewBreakglass(actor: User, id: string, note: string): Promise<Result> {
  const access = await lockerAccess(actor.id);
  if (!access.has("locker.approvals")) return err("Recording the review needs Approvals.", "not_permitted");
  const [bg] = await db.select().from(lockerBreakglass).where(eq(lockerBreakglass.id, id)).limit(1);
  if (!bg) return err("Not found.", "not_found");
  if (bg.startedById === actor.id) return err("The person who used emergency access cannot review it.", "rule_violation");
  if (bg.reviewNote) return err("The review is already recorded.", "conflict");
  const windowOver = bg.state === "ended" || bg.state === "declined" || (bg.activeUntil && bg.activeUntil < new Date());
  if (!windowOver) return err("End emergency access before reviewing it.");
  if (note.trim().length < 10) return err("Write the findings — at least 10 characters.");
  await db.transaction(async (tx) => {
    await tx.update(lockerBreakglass).set({ reviewNote: note.trim(), state: bg.state === "active" ? "ended" : bg.state, endedAt: bg.endedAt ?? bg.activeUntil }).where(eq(lockerBreakglass.id, id));
    await lockerAuditTx(tx, { actorId: actor.id, actorName: actor.name, action: "locker.breakglass.ended", entityType: "breakglass", entityId: id, summary: "Recorded the after-emergency review", reason: note.trim(), security: true });
  });
  return ok(undefined, "Review recorded");
}
