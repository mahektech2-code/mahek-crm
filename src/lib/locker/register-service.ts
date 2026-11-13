import "server-only";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  attachments,
  lockerAssets,
  lockerAudit,
  lockerCredentials,
  lockerIdentities,
  lockerLinks,
  lockerPaymentMethods,
  lockerRenewals,
  lockerReveals,
  lockerSecrets,
  users,
} from "@/db/schema";
import { today } from "@/lib/format";
import { lockerAccess, type LockerAccess } from "./access";
import { DEFAULT_STEPS } from "./catalogue";
import { actionDate, daysLeft, identityRisk, type Tier } from "./engine";
import type { AssetLite } from "./lite";
import { allAssets, lockerPaymentMethodsList, lockerPeople, lockerSettingsRow, reminderLadders, type AssetRow } from "./service";

/* ---------------------------------------------------------------------------
 * The register's reads beyond the one in service.ts: an asset with everything
 * its detail page draws, the renewal case, the dashboard's hidden risks and
 * the cost picture. Every read starts from `registerFor`, so nothing here can
 * show an asset of a category the person may not open.
 * ------------------------------------------------------------------------- */

/**
 * WHO MAY CHANGE THE REGISTER. The design's read-only person is the external
 * auditor, whose Locker is the register and the audit and nothing of "My
 * work" (spec §6: "Auditor — read documents, never credentials"). Holding a
 * category is the right to SEE it; changing it needs a working seat too —
 * Renewals, My assets or an admin screen. Checked in every register action.
 */
export function canEditRegister(a: LockerAccess): boolean {
  return a.has("locker.renewals") || a.has("locker.myassets") || a.isAdmin;
}

export async function canReadLockerAsset(userId: string, assetId: string): Promise<boolean> {
  const [row] = await db.select({ category: lockerAssets.category }).from(lockerAssets).where(eq(lockerAssets.id, assetId));
  if (!row) return false;
  return (await lockerAccess(userId)).catOk(row.category);
}

export type RenewalRow = typeof lockerRenewals.$inferSelect & { assignedName: string | null; notesList: { who: string; at: string; t: string }[] };

function notesOf(raw: string | null): { who: string; at: string; t: string }[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [{ who: "", at: "", t: raw }];
  }
}

export async function renewalsForAsset(assetId: string): Promise<RenewalRow[]> {
  const rows = await db
    .select({ r: lockerRenewals, name: users.name })
    .from(lockerRenewals)
    .leftJoin(users, eq(users.id, lockerRenewals.assignedToId))
    .where(eq(lockerRenewals.assetId, assetId))
    .orderBy(desc(lockerRenewals.startedAt));
  return rows.map((x) => ({ ...x.r, assignedName: x.name, notesList: notesOf(x.r.notes) }));
}

export type LinkedCredential = {
  id: string;
  title: string;
  tier: string;
  auth: string;
  sole: boolean;
  viaEmail: string | null;
  hint: string | null;
  lastRotatedAt: Date | null;
  lastReveal: { at: Date; by: string } | null;
};

async function credentialsFor(asset: AssetRow): Promise<LinkedCredential[]> {
  const conds = [eq(lockerCredentials.assetId, asset.id)];
  if (asset.provider) conds.push(eq(lockerCredentials.provider, asset.provider));
  const rows = await db
    .select({ c: lockerCredentials, via: lockerIdentities.email })
    .from(lockerCredentials)
    .leftJoin(lockerIdentities, eq(lockerIdentities.id, lockerCredentials.viaIdentityId))
    .where(and(eq(lockerCredentials.active, true), or(...conds)))
    .limit(8);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.c.id);
  const [hints, reveals] = await Promise.all([
    db.select({ credential_id: lockerSecrets.credentialId, hint: lockerSecrets.hint }).from(lockerSecrets).where(and(inArray(lockerSecrets.credentialId, ids), isNull(lockerSecrets.retiredAt))).orderBy(asc(lockerSecrets.createdAt)),
    db
      .select({ cid: lockerReveals.credentialId, at: lockerReveals.revealedAt, by: users.name })
      .from(lockerReveals)
      .innerJoin(users, eq(users.id, lockerReveals.userId))
      .where(and(inArray(lockerReveals.credentialId, ids), eq(lockerReveals.state, "revealed")))
      .orderBy(desc(lockerReveals.revealedAt)),
  ]);
  const H = new Map<string, string>();
  for (const h of hints) if (!H.has(h.credential_id)) H.set(h.credential_id, h.hint);
  return rows.map((r) => {
    const rv = reveals.find((x) => x.cid === r.c.id && x.at);
    return {
      id: r.c.id,
      title: r.c.title,
      tier: r.c.tier,
      auth: r.c.auth,
      sole: r.c.sole,
      viaEmail: r.via,
      hint: H.get(r.c.id) ?? null,
      lastRotatedAt: r.c.lastRotatedAt,
      lastReveal: rv?.at ? { at: rv.at, by: rv.by } : null,
    };
  });
}

export type ActivityRow = { at: Date; who: string; t: string };

export async function activityFor(assetId: string): Promise<ActivityRow[]> {
  const rows = await db
    .select({ at: lockerAudit.at, who: lockerAudit.actorName, t: lockerAudit.summary })
    .from(lockerAudit)
    .where(and(eq(lockerAudit.entityType, "locker_asset"), eq(lockerAudit.entityId, assetId)))
    .orderBy(desc(lockerAudit.seq))
    .limit(200);
  return rows;
}

export type DocRow = { id: string; filename: string; sizeBytes: number; contentType: string; uploadedAt: Date; by: string | null; hash: string | null; assetId: string; current: boolean };

/** The asset's documents and every earlier version's, newest first. */
export async function documentsFor(chain: string[], currentId: string): Promise<DocRow[]> {
  if (!chain.length) return [];
  const rows = await db
    .select({ a: attachments, by: users.name })
    .from(attachments)
    .leftJoin(users, eq(users.id, attachments.uploadedById))
    .where(and(eq(attachments.parentType, "locker_asset"), inArray(attachments.parentId, chain), eq(attachments.status, "available")))
    .orderBy(desc(attachments.uploadedAt));
  return rows.map((r) => ({
    id: r.a.id,
    filename: r.a.filename,
    sizeBytes: r.a.sizeBytes,
    contentType: r.a.contentType,
    uploadedAt: r.a.uploadedAt,
    by: r.by,
    hash: r.a.contentHash,
    assetId: r.a.parentId ?? "",
    current: r.a.parentId === currentId,
  }));
}

/** Older versions this asset replaced, following `replaces_id` back. */
function chainBack(all: AssetRow[], a: AssetRow): AssetRow[] {
  const out: AssetRow[] = [];
  const seen = new Set<string>([a.id]);
  let cur = a;
  while (cur.replacesId && !seen.has(cur.replacesId)) {
    const prev = all.find((x) => x.id === cur.replacesId);
    if (!prev) break;
    out.push(prev);
    seen.add(prev.id);
    cur = prev;
  }
  return out;
}

export async function assetDetail(userId: string, id: string) {
  const day = today();
  const [access, all] = await Promise.all([lockerAccess(userId), allAssets(day)]);
  const asset = all.find((x) => x.id === id);
  if (!asset || !access.catOk(asset.category)) return null;
  const newer = all.find((x) => x.replacesId === asset.id) ?? null;
  const older = chainBack(all, asset);
  const [renewals, activity, docs, ladders, people, pms, creds] = await Promise.all([
    renewalsForAsset(asset.id),
    activityFor(asset.id),
    documentsFor([asset.id, ...older.map((o) => o.id)], asset.id),
    reminderLadders(),
    lockerPeople(),
    lockerPaymentMethodsList(),
    access.vault ? credentialsFor(asset) : Promise.resolve([] as LinkedCredential[]),
  ]);
  /* "Relies on this": for a licence, the policies and premises at the same site assume it. */
  const reliesOnThis =
    asset.category === "hazardous" || asset.category === "statutory"
      ? all.filter((x) => x.siteId && x.siteId === asset.siteId && x.id !== asset.id && x.live && ["stockins", "fireins", "lease", "rent"].includes(x.typeCode)).slice(0, 6)
      : [];
  const name = (uid: string | null) => (uid ? (people.find((p) => p.id === uid)?.name ?? null) : null);
  return {
    asset,
    newer,
    older,
    renewals,
    openRenewal: renewals.find((r) => !r.completedAt) ?? null,
    history: renewals.filter((r) => r.completedAt),
    activity,
    docs,
    ladder: ladders[asset.criticality] ?? [],
    people,
    paymentMethod: pms.find((p) => p.id === asset.paymentMethodId) ?? null,
    paymentMethods: pms.filter((p) => p.active),
    creds,
    reliesOnThis,
    approverName: name(asset.approverId),
    executorName: name(asset.executorId),
    custodianName: name(asset.custodianId),
    access,
    canEdit: canEditRegister(access),
    day,
  };
}

export async function renewalCase(userId: string, assetId: string) {
  const d = await assetDetail(userId, assetId);
  if (!d) return null;
  const steps = d.asset.type.steps.length ? d.asset.type.steps : DEFAULT_STEPS;
  return { ...d, steps };
}

/* ------------------------------------------------------------ dashboard risks */

export type CardRisk = { pm: typeof lockerPaymentMethods.$inferSelect; daysLeft: number; subs: AssetRow[] };

/** The card-expiry trap (spec §5.7): a card expiring inside the window, and every auto-renewal it pays. */
export async function cardRisks(rows: AssetRow[], day: string = today()): Promise<CardRisk[]> {
  const [pms, settings] = await Promise.all([lockerPaymentMethodsList(), lockerSettingsRow()]);
  return pms
    .filter((p) => p.active && p.expiresOn)
    .map((p) => ({ pm: p, daysLeft: daysLeft(p.expiresOn, day) ?? 0, subs: rows.filter((a) => a.live && a.paymentMethodId === p.id && a.autoRenew) }))
    .filter((x) => x.daysLeft <= settings.cardWarnDays && x.subs.length);
}

export type IdentityRisk = { id: string; email: string; provider: string; controlledByName: string | null; mfa: boolean; controlled: boolean; recovery: boolean; linked: number; score: number };

/** Sign-in accounts with how many logins hang off them and the spec's §6.5 risk score. */
export async function identityRisks(): Promise<IdentityRisk[]> {
  const [ids, links, creds] = await Promise.all([
    db.select().from(lockerIdentities).where(eq(lockerIdentities.active, true)).orderBy(asc(lockerIdentities.email)),
    db.select({ identityId: lockerLinks.identityId, credentialId: lockerLinks.credentialId }).from(lockerLinks),
    db.select({ identityId: lockerCredentials.viaIdentityId, id: lockerCredentials.id, tier: lockerCredentials.tier }).from(lockerCredentials).where(eq(lockerCredentials.active, true)),
  ]);
  const tierOf = new Map(creds.map((c) => [c.id, c.tier as Tier]));
  return ids.map((i) => {
    const set = new Set<string>([...links.filter((l) => l.identityId === i.id).map((l) => l.credentialId), ...creds.filter((v) => v.identityId === i.id).map((v) => v.id)]);
    const deps = [...set].filter((id) => tierOf.has(id)).map((id) => ({ tier: tierOf.get(id)! }));
    return { id: i.id, email: i.email, provider: i.provider, controlledByName: i.controlledByName, mfa: i.mfa, controlled: i.controlled, recovery: i.recovery, linked: set.size, score: identityRisk(i, deps) };
  });
}

/* --------------------------------------------------------------------- costs */

/** A subscription's cost per month, from its cycle. Paise. */
export function monthlyPaise(a: Pick<AssetRow, "amountPaise" | "billingCycle">): number {
  const c = (a.billingCycle || "Annual").toLowerCase();
  const months = c.startsWith("month") ? 1 : c.startsWith("quarter") ? 3 : c.startsWith("half") ? 6 : c.startsWith("bien") ? 24 : c.startsWith("trien") ? 36 : 12;
  return a.amountPaise / months;
}

export async function unownedCount(): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(lockerAssets).where(and(isNull(lockerAssets.ownerId), isNull(lockerAssets.archivedAt)));
  return Number(r?.n ?? 0);
}

export function toLite(a: AssetRow): AssetLite {
  return {
    id: a.id,
    code: a.code,
    title: a.title,
    category: a.category,
    typeCode: a.typeCode,
    typeName: a.type.name,
    model: a.model,
    crit: a.criticality,
    status: a.status,
    d: a.d,
    actionIn: a.actionIn,
    endDate: a.endDate,
    actionDate: actionDate(a, a.model),
    noticeDays: a.noticeDays,
    entityId: a.entityId,
    entityName: a.entityName,
    siteId: a.siteId,
    siteName: a.siteName,
    siteState: a.siteState,
    ownerId: a.ownerId,
    ownerName: a.ownerName,
    backupId: a.backupId,
    checkedAgo: a.checkedAgo,
    unchecked: a.unchecked,
    docNo: a.docNo,
    provider: a.provider,
    live: a.live,
    consequence: a.type.consequence,
    leadDays: a.type.leadDays,
    graceDays: a.type.graceDays,
  };
}
