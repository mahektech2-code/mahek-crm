/* ---------------------------------------------------------------------------
 * THE IDENTITY GRAPH — spec §6.4–6.5. PURE: identities, logins and the edges
 * between them in; blast radius, risk score and the plain-language account
 * of "what breaks" out. No I/O, so a test can hand it a cycle.
 *
 * TWO KINDS OF EDGE make it a graph rather than a list:
 *   login → sign-in account   a link (shared sign-in, recovery email, billing
 *                             owner): the login relies on that account
 *   sign-in account → login   `credential.identityId`: that login IS the
 *                             account's own password (an inbox's login)
 * Losing an account loses every login that signs in ONLY through it; if one of
 * those is itself another account's login, that account is lost too, and so
 * on — which is why the radius is a traversal, with a visited set so a cycle
 * (an inbox whose recovery email is an inbox that recovers through it) ends.
 * ------------------------------------------------------------------------- */

import { identityRisk, type Tier } from "./engine";

export type GIdentity = { id: string; email: string; provider: string; kind: string; controlled: boolean; mfa: boolean; recovery: boolean; controlledByName: string | null };
export type GCred = { id: string; title: string; tier: Tier; provider: string; identityId: string | null };
export type GLink = { credentialId: string; identityId: string; kind: string; sole: boolean };

export type Affected = {
  cred: GCred;
  /** The edge that ties it to the lost account. */
  kind: string;
  /** No other way in: losing the account loses this. */
  sole: boolean;
  /** How many hops from the account picked. 1 = relies on it directly. */
  depth: number;
  /** The account through which it was reached. */
  via: string;
};

export type Blast = {
  identity: GIdentity;
  affected: Affected[];
  /** Further sign-in accounts lost because their own login was lost. */
  lostIdentities: GIdentity[];
  soleCount: number;
};

/** The logins that rely on one account directly, one entry per login (the strongest edge wins). */
export function dependentsOf(identityId: string, creds: GCred[], links: GLink[]): { cred: GCred; kind: string; sole: boolean }[] {
  const byId = new Map(creds.map((c) => [c.id, c]));
  const best = new Map<string, { cred: GCred; kind: string; sole: boolean }>();
  for (const l of links) {
    if (l.identityId !== identityId) continue;
    const cred = byId.get(l.credentialId);
    if (!cred) continue;
    const prev = best.get(cred.id);
    if (!prev || (l.sole && !prev.sole)) best.set(cred.id, { cred, kind: l.kind, sole: l.sole });
  }
  return [...best.values()];
}

export function blastRadius(identityId: string, identities: GIdentity[], creds: GCred[], links: GLink[]): Blast | null {
  const idMap = new Map(identities.map((i) => [i.id, i]));
  const root = idMap.get(identityId);
  if (!root) return null;
  const seenIds = new Set<string>([identityId]);
  const seenCreds = new Set<string>();
  const affected: Affected[] = [];
  const lostIdentities: GIdentity[] = [];
  let frontier: { id: string; depth: number }[] = [{ id: identityId, depth: 1 }];
  while (frontier.length) {
    const next: { id: string; depth: number }[] = [];
    for (const f of frontier) {
      const via = idMap.get(f.id)?.email ?? f.id;
      for (const d of dependentsOf(f.id, creds, links)) {
        if (seenCreds.has(d.cred.id)) continue;
        seenCreds.add(d.cred.id);
        affected.push({ cred: d.cred, kind: d.kind, sole: d.sole, depth: f.depth, via });
        /* A login lost outright that is some account's own password takes that account with it. */
        if (d.sole && d.cred.identityId && !seenIds.has(d.cred.identityId)) {
          seenIds.add(d.cred.identityId);
          const lost = idMap.get(d.cred.identityId);
          if (lost) {
            lostIdentities.push(lost);
            next.push({ id: lost.id, depth: f.depth + 1 });
          }
        }
      }
    }
    frontier = next;
  }
  return { identity: root, affected, lostIdentities, soleCount: affected.filter((a) => a.sole).length };
}

/** The spec's single-point-of-failure score, over the account's DIRECT dependants. */
export function spofScore(identity: GIdentity, creds: GCred[], links: GLink[]): number {
  return identityRisk(identity, dependentsOf(identity.id, creds, links).map((d) => ({ tier: d.cred.tier })));
}

/** Accounts ranked worst first: uncontrolled before controlled, then by score. */
export function rankIdentities(identities: GIdentity[], creds: GCred[], links: GLink[]): { identity: GIdentity; score: number; direct: number }[] {
  return identities
    .map((identity) => ({ identity, score: spofScore(identity, creds, links), direct: dependentsOf(identity.id, creds, links).length }))
    .sort((a, b) => b.score - a.score || a.identity.email.localeCompare(b.identity.email));
}

/** "What breaks · explained" — said in words, from the traversal and nothing invented. */
export function narrate(b: Blast): string {
  const i = b.identity;
  const n = b.affected.length;
  if (!n) return `Nothing recorded in the Locker relies on ${i.email}. If services sign in with it, record them so this answer is true.`;
  const providers = [...new Set(b.affected.map((a) => a.cred.provider).filter(Boolean))];
  const named = providers.slice(0, 3).join(", ") + (providers.length > 3 ? ` and ${providers.length - 3} more` : "");
  const restricted = b.affected.filter((a) => a.cred.tier === "restricted").length;
  const parts = [
    `Losing ${i.email} removes access to ${n} ${n === 1 ? "service" : "services"}${named ? `, including ${named}` : ""}.`,
    b.soleCount ? `${b.soleCount} ${b.soleCount === 1 ? "has" : "have"} no alternative access path.` : "Every one has another way in.",
  ];
  if (restricted) parts.push(`${restricted} ${restricted === 1 ? "is" : "are"} restricted — banking, payments or a main account.`);
  if (b.lostIdentities.length) parts.push(`It also takes ${b.lostIdentities.map((x) => x.email).join(", ")} with it, because ${b.lostIdentities.length === 1 ? "that account's" : "those accounts'"} own login relies on it.`);
  parts.push(
    !i.controlled
      ? `This account belongs to ${i.controlledByName || "a person"}, not the company — if they leave or lose it, recovery relies on their goodwill.`
      : !i.mfa
        ? "It is protected by a password alone."
        : !i.recovery
          ? "It has 2-step sign-in but no recovery set, so a lost device is a lost account."
          : "It has 2-step sign-in and recovery, so the main risk is a lost recovery path.",
  );
  return parts.join(" ");
}

/** The continuity document: plain text, no secrets, one line per thing to restore. */
export function backupPlan(b: Blast, generatedFor: string, at: string): string {
  const lines = [
    `MAHEK LOCKER — BACKUP PLAN`,
    `If we lose: ${b.identity.email} (${b.identity.provider}, ${b.identity.kind})`,
    `Prepared for ${generatedFor} · ${at}`,
    ``,
    narrate(b),
    ``,
    `WHAT TO RESTORE, MOST URGENT FIRST`,
  ];
  const order = [...b.affected].sort((x, y) => Number(y.sole) - Number(x.sole) || ["restricted", "sensitive", "standard"].indexOf(x.cred.tier) - ["restricted", "sensitive", "standard"].indexOf(y.cred.tier));
  order.forEach((a, k) =>
    lines.push(`${k + 1}. ${a.cred.title} — ${a.cred.provider || "provider not recorded"} · ${a.kind}${a.depth > 1 ? ` (through ${a.via})` : ""} · ${a.sole ? "NO OTHER WAY IN: needs the provider's support, days to weeks" : "recoverable through another admin, hours"}`),
  );
  if (b.lostIdentities.length) {
    lines.push(``, `SIGN-IN ACCOUNTS LOST WITH IT`);
    b.lostIdentities.forEach((x) => lines.push(`- ${x.email} (${x.provider})`));
  }
  lines.push(``, `This document holds no passwords. Reveal them in the Locker, where each reveal is recorded.`);
  return lines.join("\n");
}
