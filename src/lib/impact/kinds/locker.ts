import "server-only";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { lockerAssets, lockerBreakglass, lockerCredentials, lockerIdentities, lockerLinks, lockerReveals, lockerSecrets } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { lockerAccess } from "@/lib/locker/access";
import type { ImpactItem } from "../types";
import type { ImpactSource } from "../registry";
import { many, present } from "./erp-common";

/* ---------------------------------------------------------------------------
 * RETIRING IN THE LOCKER'S VAULT DELETES NOTHING — the values stay encrypted,
 * the audit chain and every connection stay — and that is the half worth
 * saying, along with what does stop: the login cannot be revealed, a waiting
 * request expires, it leaves the lists and counts. A sign-in account's report
 * names the logins that rely on it, because those are what break when the
 * account is really gone.
 * ------------------------------------------------------------------------- */

const word = (name: string, fallback: string) => (name.length <= 40 ? name : fallback);

export const lockerCredentialRetireImpact: ImpactSource = {
  authorize: async () => {
    const user = await requireUser();
    if (!(await lockerAccess(user.id)).vault) throw new Error("You do not have Vault › Passwords & keys. A Locker admin can add it under Admin › Access.");
  },

  async report(id) {
    const [c] = await db.select().from(lockerCredentials).where(eq(lockerCredentials.id, id)).limit(1);
    if (!c) return null;
    const [secrets, links, requests, emergencies, asset] = await Promise.all([
      db.select({ id: lockerSecrets.id }).from(lockerSecrets).where(and(eq(lockerSecrets.credentialId, id), isNull(lockerSecrets.retiredAt))),
      db.select({ kind: lockerLinks.kind, email: lockerIdentities.email }).from(lockerLinks).innerJoin(lockerIdentities, eq(lockerIdentities.id, lockerLinks.identityId)).where(eq(lockerLinks.credentialId, id)),
      db.select({ id: lockerReveals.id }).from(lockerReveals).where(and(eq(lockerReveals.credentialId, id), inArray(lockerReveals.state, ["waiting", "approved"]))),
      db
        .select({ id: lockerBreakglass.id })
        .from(lockerBreakglass)
        .where(and(inArray(lockerBreakglass.state, ["awaiting", "active"]), sql`${lockerBreakglass.scope} @> ${JSON.stringify([id])}::jsonb`)),
      c.assetId ? db.select({ title: lockerAssets.title }).from(lockerAssets).where(eq(lockerAssets.id, c.assetId)) : Promise.resolve([] as { title: string }[]),
    ]);
    const items: ImpactItem[] = [
      {
        app: "Locker",
        label: "login leaves the vault list, the change-due and reuse checks, and cannot be revealed",
        effect: "changed",
        count: c.active ? 1 : 0,
        note: "Restore, on its page, brings it back exactly as it was.",
      },
      {
        app: "Locker",
        label: `reveal ${many(requests.length, "request")} waiting or approved`,
        effect: "changed",
        count: requests.length,
        note: "They expire; whoever asked asks again if the login is restored.",
      },
      {
        app: "Locker",
        label: `stored ${many(secrets.length, "value")}, with every previous value`,
        effect: "kept",
        count: secrets.length,
        note: "Kept encrypted. Nothing is wiped.",
      },
      {
        app: "Locker",
        label: `${many(links.length, "connection")} to sign-in accounts`,
        effect: "kept",
        count: links.length,
        examples: links.map((l) => `${l.kind} · ${l.email}`),
      },
      { app: "Locker", label: "asset it belongs to", effect: "kept", count: asset.length, examples: asset.map((a) => a.title) },
    ];
    const blockers: string[] = [];
    if (!c.active) blockers.push("This login is already retired.");
    if (emergencies.length) blockers.push("Emergency access covering this login is open. End it before retiring the login.");
    return { title: c.title, verb: "Retire", confirmWord: word(c.title, "RETIRE"), items: present(items), blockers };
  },
};

export const lockerIdentityRetireImpact: ImpactSource = {
  authorize: async () => {
    const user = await requireUser();
    const a = await lockerAccess(user.id);
    if (!a.has("locker.identities") && !a.vault) throw new Error("You do not have Sign-in accounts in the Locker. A Locker admin can add it under Admin › Access.");
  },

  async report(id) {
    const [i] = await db.select().from(lockerIdentities).where(eq(lockerIdentities.id, id)).limit(1);
    if (!i) return null;
    const [through, links] = await Promise.all([
      db
        .select({ title: lockerCredentials.title })
        .from(lockerCredentials)
        .where(and(eq(lockerCredentials.active, true), or(eq(lockerCredentials.identityId, id), eq(lockerCredentials.viaIdentityId, id)))),
      db
        .select({ title: lockerCredentials.title, kind: lockerLinks.kind, sole: lockerLinks.sole })
        .from(lockerLinks)
        .innerJoin(lockerCredentials, eq(lockerCredentials.id, lockerLinks.credentialId))
        .where(and(eq(lockerLinks.identityId, id), eq(lockerCredentials.active, true))),
    ]);
    const sole = links.filter((l) => l.sole);
    const items: ImpactItem[] = [
      {
        app: "Locker",
        label: "account leaves Sign-in accounts, the connection map and offboarding",
        effect: "changed",
        count: i.active ? 1 : 0,
        note: "Restore, from the retired accounts on that screen, brings it back.",
      },
      {
        app: "Locker",
        label: `${many(through.length, "login")} that ${through.length === 1 ? "signs" : "sign"} in with or through it`,
        effect: "kept",
        count: through.length,
        examples: through.map((t) => t.title),
        note: "They keep pointing at it. If the account is really gone, change each login's sign-in.",
      },
      {
        app: "Locker",
        label: `${many(links.length, "connection")} from logins in use`,
        effect: "kept",
        count: links.length,
        examples: links.map((l) => `${l.title} · ${l.kind}`),
        note: "Kept on the record; the connection map stops drawing them.",
      },
    ];
    const blockers: string[] = [];
    if (!i.active) blockers.push("This sign-in account is already retired.");
    if (sole.length) blockers.push(`It is the only way into ${sole.map((s) => s.title).join(", ")}. Give ${sole.length === 1 ? "that login" : "those logins"} another way in first.`);
    return { title: i.email, verb: "Retire", confirmWord: word(i.email, "RETIRE"), items: present(items), blockers };
  },
};
