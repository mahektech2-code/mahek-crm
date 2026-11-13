import "server-only";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  lockerAudit,
  lockerBreakglass,
  lockerCredentials,
  lockerIdentities,
  lockerLinks,
  lockerOffboarding,
  lockerReveals,
  lockerReviewItems,
  lockerSecrets,
  users,
} from "@/db/schema";
import { today } from "@/lib/format";
import { rotationDue, type Tier } from "./engine";
import { blastRadius, dependentsOf, rankIdentities, type GCred, type GIdentity, type GLink } from "./graph";
import { lapseRequests } from "./vault-core";
import { allAssets, lockerSettingsRow } from "./service";

/* ---------------------------------------------------------------------------
 * The vault's READS. Never a secret value — at most the two-character hint
 * and the keyed fingerprint's verdict ("used on 3 other items"), never the
 * fingerprint itself. Each screen is one function so the list and the detail
 * cannot disagree about a login.
 * ------------------------------------------------------------------------- */

export type CredRow = {
  id: string;
  title: string;
  kind: string;
  tier: Tier;
  provider: string;
  url: string;
  username: string;
  env: string;
  auth: string;
  via: { id: string; email: string; controlled: boolean; controlledByName: string | null } | null;
  sole: boolean;
  ownerId: string | null;
  ownerName: string | null;
  mfa: boolean;
  policyDays: number;
  ageDays: number | null;
  changeDue: boolean;
  overBy: number;
  lastRevealedAt: string | null;
  lastRevealedBy: string | null;
  reveals: number;
  reuseCount: number;
  flags: string[];
  identityId: string | null;
  assetId: string | null;
};

async function names(): Promise<Map<string, string>> {
  const rows = await db.select({ id: users.id, name: users.name }).from(users);
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function listCredentials(): Promise<CredRow[]> {
  const [creds, idents, s, N, revealAgg, fps] = await Promise.all([
    db.select().from(lockerCredentials).where(eq(lockerCredentials.active, true)).orderBy(asc(lockerCredentials.title)),
    db.select().from(lockerIdentities),
    lockerSettingsRow(),
    names(),
    db
      .select({ id: lockerReveals.credentialId, n: sql<number>`count(*)::int`, last: sql<string>`max(${lockerReveals.revealedAt})::text` })
      .from(lockerReveals)
      .where(eq(lockerReveals.state, "revealed"))
      .groupBy(lockerReveals.credentialId),
    db.select({ cred: lockerSecrets.credentialId, fp: lockerSecrets.fingerprint }).from(lockerSecrets).where(and(isNull(lockerSecrets.retiredAt), sql`${lockerSecrets.fingerprint} <> ''`)),
  ]);
  const lastBy = await db
    .selectDistinctOn([lockerReveals.credentialId], { id: lockerReveals.credentialId, by: lockerReveals.userId })
    .from(lockerReveals)
    .where(eq(lockerReveals.state, "revealed"))
    .orderBy(lockerReveals.credentialId, desc(lockerReveals.revealedAt));
  const I = new Map(idents.map((i) => [i.id, i]));
  const R = new Map(revealAgg.map((r) => [r.id, r]));
  const LB = new Map(lastBy.map((r) => [r.id, r.by]));
  /* Reuse: how many OTHER logins share a current fingerprint with this one. */
  const byFp = new Map<string, Set<string>>();
  for (const f of fps) byFp.set(f.fp, (byFp.get(f.fp) ?? new Set()).add(f.cred));
  const reuse = new Map<string, Set<string>>();
  for (const set of byFp.values()) if (set.size > 1) for (const c of set) for (const o of set) if (o !== c) reuse.set(c, (reuse.get(c) ?? new Set()).add(o));
  const day = today();
  return creds.map((c) => {
    const tier = c.tier as Tier;
    const policy = c.rotateEveryDays ?? s.tiers[tier].rotateDays;
    const rot = rotationDue(c.lastRotatedAt ?? c.createdAt, policy, day);
    const via = c.viaIdentityId ? I.get(c.viaIdentityId) : undefined;
    const reuseCount = reuse.get(c.id)?.size ?? 0;
    const flags: string[] = [];
    if (via && !via.controlled) flags.push("Main sign-in account is a personal account");
    if (rot.due) flags.push("Change overdue");
    if (reuseCount) flags.push("Password reused");
    if (!c.mfa && tier !== "standard") flags.push("No 2-step sign-in");
    const agg = R.get(c.id);
    const lastBy = LB.get(c.id);
    return {
      id: c.id,
      title: c.title,
      kind: c.kind,
      tier,
      provider: c.provider,
      url: c.url,
      username: c.username,
      env: c.env,
      auth: c.auth,
      via: via ? { id: via.id, email: via.email, controlled: via.controlled, controlledByName: via.controlledByName } : null,
      sole: c.sole,
      ownerId: c.ownerId,
      ownerName: c.ownerId ? (N.get(c.ownerId) ?? null) : null,
      mfa: c.mfa,
      policyDays: policy,
      ageDays: rot.age,
      changeDue: rot.due,
      overBy: rot.overBy,
      lastRevealedAt: agg?.last ? agg.last.slice(0, 10) : null,
      lastRevealedBy: lastBy ? (N.get(lastBy) ?? null) : null,
      reveals: agg?.n ?? 0,
      reuseCount,
      flags,
      identityId: c.identityId,
      assetId: c.assetId,
    };
  });
}

export async function credentialDetail(id: string) {
  const [c] = await db.select().from(lockerCredentials).where(eq(lockerCredentials.id, id)).limit(1);
  if (!c) return null;
  const [rows, N, secrets, links, hist, idents] = await Promise.all([
    listCredentials(),
    names(),
    db.select({ id: lockerSecrets.id, field: lockerSecrets.field, hint: lockerSecrets.hint, createdAt: lockerSecrets.createdAt, retiredAt: lockerSecrets.retiredAt, createdById: lockerSecrets.createdById, fingerprint: lockerSecrets.fingerprint }).from(lockerSecrets).where(eq(lockerSecrets.credentialId, id)).orderBy(desc(lockerSecrets.createdAt)),
    db.select().from(lockerLinks).where(eq(lockerLinks.credentialId, id)),
    db.select({ by: lockerReveals.userId, at: lockerReveals.revealedAt, reason: lockerReveals.reason, field: lockerReveals.field, previous: lockerReveals.previous, bg: lockerReveals.breakglassId, approvedBy: lockerReveals.decidedById }).from(lockerReveals).where(and(eq(lockerReveals.credentialId, id), eq(lockerReveals.state, "revealed"))).orderBy(desc(lockerReveals.revealedAt)).limit(50),
    db.select().from(lockerIdentities),
  ]);
  const row = rows.find((r) => r.id === id) ?? null;
  const I = new Map(idents.map((i) => [i.id, i]));
  /* Who relies on THIS login, when it is an account's own login (an inbox). */
  const dependants = c.identityId
    ? await db
        .select({ id: lockerCredentials.id, title: lockerCredentials.title, kind: lockerLinks.kind, sole: lockerLinks.sole })
        .from(lockerLinks)
        .innerJoin(lockerCredentials, eq(lockerCredentials.id, lockerLinks.credentialId))
        .where(and(eq(lockerLinks.identityId, c.identityId), eq(lockerCredentials.active, true)))
        .limit(30)
    : [];
  const current = secrets.filter((s) => !s.retiredAt);
  const fpsMine = new Set(current.map((s) => s.fingerprint).filter(Boolean));
  const reuseWith = fpsMine.size
    ? await db
        .selectDistinct({ id: lockerCredentials.id, title: lockerCredentials.title })
        .from(lockerSecrets)
        .innerJoin(lockerCredentials, eq(lockerCredentials.id, lockerSecrets.credentialId))
        .where(and(inArray(lockerSecrets.fingerprint, [...fpsMine]), isNull(lockerSecrets.retiredAt), eq(lockerCredentials.active, true), sql`${lockerSecrets.credentialId} <> ${id}`))
    : [];
  return {
    c,
    row,
    ownerName: c.ownerId ? (N.get(c.ownerId) ?? null) : null,
    backupName: c.backupOwnerId ? (N.get(c.backupOwnerId) ?? null) : null,
    revealerNames: c.revealers.map((u) => N.get(u) ?? "Unknown"),
    via: c.viaIdentityId ? (I.get(c.viaIdentityId) ?? null) : null,
    selfIdentity: c.identityId ? (I.get(c.identityId) ?? null) : null,
    current: current.map((s) => ({ id: s.id, field: s.field, hint: s.hint, since: s.createdAt.toISOString() })),
    previous: secrets.filter((s) => s.retiredAt).map((s) => ({ id: s.id, field: s.field, setAt: s.createdAt.toISOString(), replacedAt: s.retiredAt!.toISOString(), by: s.createdById ? (N.get(s.createdById) ?? "") : "" })),
    links: links.map((l) => ({ id: l.id, kind: l.kind, sole: l.sole, identity: I.get(l.identityId) ?? null })),
    dependants,
    reuseWith,
    history: hist.map((h) => ({ who: N.get(h.by) ?? "Unknown", at: h.at?.toISOString() ?? "", reason: h.reason, field: h.field, previous: h.previous, emergency: !!h.bg, approvedBy: h.approvedBy ? (N.get(h.approvedBy) ?? null) : null })),
  };
}

/* ---------------------------------------------------------------- the graph */

export async function graphData() {
  const [idents, creds, links] = await Promise.all([
    db.select().from(lockerIdentities).where(eq(lockerIdentities.active, true)),
    db.select({ id: lockerCredentials.id, title: lockerCredentials.title, tier: lockerCredentials.tier, provider: lockerCredentials.provider, identityId: lockerCredentials.identityId }).from(lockerCredentials).where(eq(lockerCredentials.active, true)),
    db.select({ id: lockerLinks.id, credentialId: lockerLinks.credentialId, identityId: lockerLinks.identityId, kind: lockerLinks.kind, sole: lockerLinks.sole }).from(lockerLinks),
  ]);
  const G: GIdentity[] = idents.map((i) => ({ id: i.id, email: i.email, provider: i.provider, kind: i.kind, controlled: i.controlled, mfa: i.mfa, recovery: i.recovery, controlledByName: i.controlledByName }));
  const C: GCred[] = creds.map((c) => ({ ...c, tier: c.tier as Tier }));
  const L: GLink[] = links;
  return { identities: G, creds: C, links: L, idents };
}

export async function identitiesView() {
  const { identities, creds, links, idents } = await graphData();
  const N = await names();
  const ranked = rankIdentities(identities, creds, links);
  const raw = new Map(idents.map((i) => [i.id, i]));
  return ranked
    .map((r) => ({ ...r, ownerName: raw.get(r.identity.id)?.ownerId ? (N.get(raw.get(r.identity.id)!.ownerId!) ?? null) : null, ownerId: raw.get(r.identity.id)?.ownerId ?? null }))
    .sort((a, b) => Number(a.identity.controlled) - Number(b.identity.controlled) || b.score - a.score);
}

export async function blastFor(identityId: string) {
  const { identities, creds, links } = await graphData();
  return { blast: blastRadius(identityId, identities, creds, links), direct: dependentsOf(identityId, creds, links) };
}

/* --------------------------------------------------------------- providers */

export async function providersView() {
  const [creds, assets] = await Promise.all([listCredentials(), allAssets()]);
  const P = new Map<string, { name: string; creds: CredRow[]; assets: Awaited<ReturnType<typeof allAssets>> }>();
  const key = (n: string) => n.trim().split(" ")[0].toLowerCase();
  for (const c of creds) {
    if (!c.provider) continue;
    const k = key(c.provider);
    const p = P.get(k) ?? { name: c.provider, creds: [], assets: [] };
    p.creds.push(c);
    P.set(k, p);
  }
  for (const a of assets.filter((a) => a.live && a.provider)) {
    const k = key(a.provider);
    const p = P.get(k) ?? { name: a.provider, creds: [], assets: [] };
    p.assets.push(a);
    P.set(k, p);
  }
  return [...P.values()]
    .map((p) => ({
      ...p,
      accounts: new Set(p.creds.map((c) => c.via?.email ?? c.username)).size,
      spendPaise: p.assets.reduce((x, a) => x + (a.amountPaise || 0) * (/month/i.test(a.billingCycle) ? 12 : /quarter/i.test(a.billingCycle) ? 4 : 1), 0),
      mfaPct: p.creds.length ? Math.round((p.creds.filter((c) => c.mfa).length / p.creds.length) * 100) : null,
      owners: [...new Set([...p.creds.map((c) => c.ownerName), ...p.assets.map((a) => a.ownerName)].filter(Boolean))] as string[],
    }))
    .sort((a, b) => b.creds.length + b.assets.length - (a.creds.length + a.assets.length));
}

/* --------------------------------------------------------------- approvals */

export async function pendingApprovals(viewerId: string) {
  await lapseRequests();
  const s = await lockerSettingsRow();
  const N = await names();
  const reveals = await db
    .select({ id: lockerReveals.id, userId: lockerReveals.userId, field: lockerReveals.field, reason: lockerReveals.reason, createdAt: lockerReveals.createdAt, previous: lockerReveals.previous, credId: lockerCredentials.id, title: lockerCredentials.title, tier: lockerCredentials.tier })
    .from(lockerReveals)
    .innerJoin(lockerCredentials, eq(lockerCredentials.id, lockerReveals.credentialId))
    .where(eq(lockerReveals.state, "waiting"))
    .orderBy(asc(lockerReveals.createdAt));
  const mine = await db
    .select({ id: lockerReveals.id, state: lockerReveals.state, field: lockerReveals.field, credId: lockerCredentials.id, title: lockerCredentials.title, decidedById: lockerReveals.decidedById, decisionNote: lockerReveals.decisionNote, expiresAt: lockerReveals.expiresAt })
    .from(lockerReveals)
    .innerJoin(lockerCredentials, eq(lockerCredentials.id, lockerReveals.credentialId))
    .where(and(eq(lockerReveals.userId, viewerId), inArray(lockerReveals.state, ["waiting", "approved"])));
  const bgs = await db.select().from(lockerBreakglass).where(eq(lockerBreakglass.state, "awaiting"));
  return {
    approvalMinutes: s.approvalMinutes,
    reveals: reveals.map((r) => ({ ...r, who: N.get(r.userId) ?? "Unknown", leftMs: Math.max(0, r.createdAt.getTime() + s.approvalMinutes * 60_000 - Date.now()), mine: r.userId === viewerId })),
    mine: mine.map((m) => ({ ...m, decidedBy: m.decidedById ? (N.get(m.decidedById) ?? "") : null, expiresAt: m.expiresAt?.toISOString() ?? null })),
    breakglass: bgs.map((b) => ({ id: b.id, by: N.get(b.startedById) ?? "Unknown", mine: b.startedById === viewerId, reason: b.reason, items: b.scope.length, at: b.startedAt.toISOString() })),
  };
}

/* ------------------------------------------------------------ emergency access */

export async function breakglassView() {
  const s = await lockerSettingsRow();
  const N = await names();
  const rows = await db.select().from(lockerBreakglass).orderBy(desc(lockerBreakglass.startedAt)).limit(20);
  const creds = await db.select({ id: lockerCredentials.id, title: lockerCredentials.title, tier: lockerCredentials.tier, provider: lockerCredentials.provider }).from(lockerCredentials).where(eq(lockerCredentials.active, true)).orderBy(asc(lockerCredentials.title));
  const C = new Map(creds.map((c) => [c.id, c]));
  const used = rows.length
    ? await db
        .select({ bg: lockerReveals.breakglassId, cred: lockerReveals.credentialId, by: lockerReveals.userId, at: lockerReveals.revealedAt })
        .from(lockerReveals)
        .where(and(isNotNull(lockerReveals.breakglassId), inArray(lockerReveals.breakglassId, rows.map((r) => r.id))))
    : [];
  const now = Date.now();
  return {
    settings: s,
    candidates: creds.filter((c) => c.tier !== "standard"),
    sessions: rows.map((b) => {
      const lapsed = b.state === "active" && b.activeUntil && b.activeUntil.getTime() <= now;
      const state = lapsed ? "ended" : b.state;
      const closedAt = b.endedAt ?? (lapsed ? b.activeUntil : null);
      return {
        id: b.id,
        state,
        by: N.get(b.startedById) ?? "Unknown",
        startedById: b.startedById,
        approvedBy: b.approvedById ? (N.get(b.approvedById) ?? null) : null,
        reason: b.reason,
        minutes: b.minutes,
        startedAt: b.startedAt.toISOString(),
        activeUntil: b.activeUntil?.toISOString() ?? null,
        closedAt: closedAt?.toISOString() ?? null,
        reviewNote: b.reviewNote,
        reviewOverdue: !b.reviewNote && state === "ended" && !!closedAt && now - closedAt.getTime() > s.breakglassReviewHours * 3600_000,
        scope: b.scope.map((id) => {
          const c = C.get(id);
          const hits = used.filter((u) => u.bg === b.id && u.cred === id);
          return { id, title: c?.title ?? "Retired login", tier: (c?.tier ?? "standard") as Tier, used: hits.length, by: [...new Set(hits.map((h) => N.get(h.by) ?? ""))].join(", ") };
        }),
      };
    }),
  };
}

/* --------------------------------------------------------------- offboarding */

export async function offboardingView() {
  const N = await names();
  const rows = await db.select().from(lockerOffboarding).orderBy(desc(lockerOffboarding.startedAt)).limit(30);
  const people = await db.select({ id: users.id, name: users.name, active: users.active }).from(users).orderBy(asc(users.name));
  return {
    people,
    cases: rows.map((r) => ({ id: r.id, userId: r.userId, name: N.get(r.userId) ?? "Unknown", by: N.get(r.startedById) ?? "", startedAt: r.startedAt.toISOString(), completedAt: r.completedAt?.toISOString() ?? null, items: r.items })),
  };
}

export async function revealedBy(userId: string, days = 90) {
  return db
    .select({ id: lockerCredentials.id, title: lockerCredentials.title, tier: lockerCredentials.tier, at: lockerReveals.revealedAt })
    .from(lockerReveals)
    .innerJoin(lockerCredentials, eq(lockerCredentials.id, lockerReveals.credentialId))
    .where(and(eq(lockerReveals.userId, userId), eq(lockerReveals.state, "revealed"), sql`${lockerReveals.revealedAt} >= now() - (${days}::int * interval '1 day')`))
    .orderBy(desc(lockerReveals.revealedAt));
}

/* -------------------------------------------------------------- access review */

export async function reviewView(period: string) {
  const N = await names();
  const items = await db.select().from(lockerReviewItems).where(eq(lockerReviewItems.period, period));
  return items.map((i) => ({ ...i, name: N.get(i.userId) ?? "Unknown", decidedBy: i.decidedById ? (N.get(i.decidedById) ?? "") : null, decidedAt: i.decidedAt?.toISOString() ?? null }));
}

/* -------------------------------------------------------------------- audit */

export async function auditRows(limit = 2000) {
  const rows = await db.select().from(lockerAudit).orderBy(desc(lockerAudit.seq)).limit(limit);
  return rows.map((r) => ({ seq: r.seq, at: r.at.toISOString(), actor: r.actorName, action: r.action, entity: r.entityTitle || r.entityType, summary: r.summary, reason: r.reason, security: r.security, ip: r.ip }));
}
