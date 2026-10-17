import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, ne, or } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, auditLog, users } from "@/db/schema";
import { APP_IDS, getApp, type AppId } from "@/lib/apps";
import type { Role } from "@/lib/role-levels";
import {
  grantAppWithDefaultModules,
  rederiveAccountLevel,
  revokeApps,
} from "@/lib/services/app-provisioning";

/* ---------------------------------------------------------------------------
 * Provisioning a deployed MahekOne.
 *
 * The Access screen is the way a person grants an app, and `npm run
 * app:grant` needs a shell. This was the third way, for the case neither
 * reaches, and it was reached over HTTP: `/api/admin/provision`, behind
 * CRON_SECRET. That secret is also in the Apps Script of two workbooks so the
 * syncs can run, so anybody who could edit those sheets could read it and
 * make their own account a platform administrator. The route is deleted; what
 * is left is a function that only code already on the server can call.
 *
 * This is the narrow, deliberate way in. It is narrow on purpose:
 *
 *   It NEVER creates a user. Everything here modifies an account that already
 *   exists, so a leaked secret cannot mint an identity — the worst it can do is
 *   rearrange what is already there, which the audit log records.
 *
 *   It never touches a password. Renaming an account leaves the person signing
 *   in with what they already know, and password resets have their own path
 *   with its own single-use tokens.
 *
 *   It never writes the account level. `users.role` is derived from the
 *   per-app levels after every change, exactly as the Access screen derives
 *   it, and every app it grants is written WITH a level — associate unless
 *   the call names another.
 *
 *   Every change is audited against a named actor where one is known, and
 *   against nobody where the caller is a shared secret — which is itself worth
 *   recording rather than dressing up as a person.
 * ------------------------------------------------------------------------- */

const newId = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

const LEVELS = ["associate", "manager", "admin"] as const;

export type ProvisionInput = {
  /** Email or work number of the account to change. Required. */
  user: string;
  name?: string;
  /** A new email. Also the new sign-in, so it must be free. */
  email?: string;
  /**
   * The LEVEL an app is granted at where its entry does not name one —
   * associate when this is absent too.
   *
   * There used to be a `role` here that wrote `users.role` directly. That
   * column is now a cache of the grants (see `rederiveAccountLevel`), and
   * writing `admin` into it made a platform administrator out of somebody
   * holding no Admin Console grant. It is gone; the account level follows
   * from the levels on the apps.
   */
  level?: "associate" | "manager" | "admin";
  /**
   * The complete set of apps this account may open. Replaces what is there.
   * Each entry is `app` or `app:level` — `crm:manager` — and an app already
   * held whose entry names a different level is moved to it.
   */
  apps?: string[];
  /** Apps to add, leaving the rest alone. The same `app:level` form. */
  addApps?: string[];
};

export type ProvisionResult = {
  userId: string;
  before: { name: string; email: string | null; role: string; apps: string[] };
  after: { name: string; email: string | null; role: string; apps: string[] };
  changed: string[];
};

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "??";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : (parts[0][1] ?? "");
  return (first + last).toUpperCase();
}

/** `crm` or `crm:manager`, read into an app and the level it asks for. */
function parseEntries(entries: string[], fallback: Role): Map<AppId, Role> {
  const out = new Map<AppId, Role>();
  const unknown: string[] = [];
  for (const raw of entries) {
    const [app, level] = raw.split(":").map((x) => x.trim());
    if (!APP_IDS.includes(app as AppId)) {
      unknown.push(app);
      continue;
    }
    if (level && !LEVELS.includes(level as Role)) {
      throw new Error(`"${level}" is not a level. One of: ${LEVELS.join(", ")}.`);
    }
    out.set(app as AppId, (level as Role | undefined) || fallback);
  }
  if (unknown.length) {
    throw new Error(`Not an app: ${unknown.join(", ")}. One of: ${APP_IDS.join(", ")}`);
  }
  return out;
}

const describeHeld = (held: Map<string, Role>) =>
  [...held.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([app, level]) => `${app}:${level}`);

export async function provisionUser(input: ProvisionInput): Promise<ProvisionResult> {
  const key = input.user.trim();
  const digits = key.replace(/\D/g, "");
  const fallback: Role = input.level ?? "associate";
  if (!LEVELS.includes(fallback)) throw new Error(`"${fallback}" is not a level.`);

  const found = await db
    .select()
    .from(users)
    .where(
      digits.length >= 10
        ? or(eq(users.email, key), eq(users.phone, digits.slice(-10)))
        : eq(users.email, key),
    )
    .limit(1);

  const user = found[0];
  if (!user) throw new Error(`No account matches "${input.user}".`);

  const currentAccess = await db
    .select({ app: appAccess.app, role: appAccess.role })
    .from(appAccess)
    .where(eq(appAccess.userId, user.id));
  const heldBefore = new Map<string, Role>(
    currentAccess.map((a) => [a.app, (a.role ?? "associate") as Role]),
  );

  const before = {
    name: user.name,
    email: user.email,
    role: user.role as string,
    apps: describeHeld(heldBefore),
  };
  const changed: string[] = [];

  /* ------------------------------------------------------------- identity */

  const patch: Partial<typeof users.$inferInsert> = {};

  if (input.name && input.name !== user.name) {
    patch.name = input.name;
    // Derived from the name, so the avatar does not keep the old person's
    // letters after a rename.
    patch.initials = initialsOf(input.name);
    changed.push(`name ${user.name} → ${input.name}`);
  }

  if (input.email && input.email !== user.email) {
    const taken = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1);
    if (taken.length) throw new Error(`${input.email} already belongs to another account.`);
    patch.email = input.email;
    changed.push(`email ${user.email} → ${input.email}`);
  }

  /* ---------------------------------------------------------------- apps */

  const requested = input.apps
    ? parseEntries(input.apps, fallback)
    : input.addApps
      ? new Map<AppId, Role>([
          ...[...heldBefore.entries()].map(([a, l]) => [a as AppId, l] as const),
          ...parseEntries(input.addApps, fallback),
        ])
      : null;

  const add = requested ? [...requested.keys()].filter((a) => !heldBefore.has(a)) : [];
  const remove = requested ? ([...heldBefore.keys()].filter((a) => !requested.has(a as AppId)) as AppId[]) : [];
  const relevel = requested
    ? [...requested.entries()].filter(([a, l]) => heldBefore.has(a) && heldBefore.get(a) !== l)
    : [];

  /* A retired app is never given out again — the Access screen refuses it,
     and a shared secret is not a reason to be more generous than a person. */
  const retired = add.filter((a) => getApp(a)?.retiredInto);
  if (retired.length) throw new Error(`${retired.join(", ")} is retired and cannot be granted.`);

  /* Nobody removes the LAST platform administrator, from here any more than
     from the console — this endpoint has no session behind it, so the
     "your own" half of the console's rule has nobody to apply to. */
  const losesPlatform =
    heldBefore.get("admin") === "admin" && (remove.includes("admin") || requested?.get("admin") !== "admin");
  if (requested && losesPlatform) {
    const others = await db
      .select({ id: users.id })
      .from(appAccess)
      .innerJoin(users, eq(users.id, appAccess.userId))
      .where(and(eq(appAccess.app, "admin"), eq(appAccess.role, "admin"), eq(users.active, true), ne(users.id, user.id)))
      .limit(1);
    if (!others.length) {
      throw new Error(`${user.name} is the only platform administrator. Make somebody else admin on the Admin Console first.`);
    }
  }

  /* ONE TRANSACTION. The identity, the grants, the module rows and the
     account level move together or not at all: half a provisioning call is an
     account whose cached level describes grants it no longer holds. */
  let roleAfter = user.role as string;
  await db.transaction(async (tx) => {
    if (Object.keys(patch).length) {
      patch.updatedAt = new Date();
      await tx.update(users).set(patch).where(eq(users.id, user.id));
    }
    for (const app of add) {
      await grantAppWithDefaultModules(tx, { userId: user.id, app, grantedById: null, level: requested!.get(app)! });
    }
    for (const [app, level] of relevel) {
      await tx
        .update(appAccess)
        .set({ role: level })
        .where(and(eq(appAccess.userId, user.id), eq(appAccess.app, app)));
    }
    await revokeApps(tx, user.id, remove);
    if (add.length || remove.length || relevel.length) {
      roleAfter = await rederiveAccountLevel(tx, user.id);
    }

    if (add.length || remove.length || relevel.length) {
      changed.push(`apps ${before.apps.join(",") || "none"} → ${describeHeld(requested!).join(",") || "none"}`);
    }
    if (roleAfter !== user.role) changed.push(`account level ${user.role} → ${roleAfter} (derived)`);

    if (changed.length) {
      await tx.insert(auditLog).values({
        id: newId("aud"),
        // No session behind a shared-secret call. Recording nobody is more
        // honest than attributing it to whoever is being changed — and for
        // the same reason no actor ROLE or APP is written: there is no hat
        // behind a secret, and null is "not recorded", never "no role".
        actorId: null,
        action: "provision-user",
        entityType: "user",
        entityId: user.id,
        afterState: { changed } as never,
      });
    }
  });

  return {
    userId: user.id,
    before,
    after: {
      name: patch.name ?? user.name,
      email: patch.email ?? user.email,
      role: roleAfter,
      apps: requested ? describeHeld(requested) : before.apps,
    },
    changed,
  };
}
