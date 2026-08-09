import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, auditLog, users } from "@/db/schema";
import { APP_IDS, type AppId } from "@/lib/apps";

/* ---------------------------------------------------------------------------
 * Provisioning a deployed MahekOne.
 *
 * The console's People section is a prototype — it reads a hardcoded array and
 * its access checkboxes never reach the database — and `npm run app:grant`
 * needs a shell no deployment has. Between the two, a live installation had no
 * way to grant an app or correct an account at all.
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
 *   Every change is audited against a named actor where one is known, and
 *   against nobody where the caller is a shared secret — which is itself worth
 *   recording rather than dressing up as a person.
 * ------------------------------------------------------------------------- */

const newId = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

export type ProvisionInput = {
  /** Email or work number of the account to change. Required. */
  user: string;
  name?: string;
  /** A new email. Also the new sign-in, so it must be free. */
  email?: string;
  role?: "telecaller" | "manager" | "accounts" | "admin";
  /** The complete set of apps this account may open. Replaces what is there. */
  apps?: string[];
  /** Apps to add, leaving the rest alone. */
  addApps?: string[];
};

export type ProvisionResult = {
  userId: string;
  before: { name: string; email: string; role: string; apps: string[] };
  after: { name: string; email: string; role: string; apps: string[] };
  changed: string[];
};

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "??";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : (parts[0][1] ?? "");
  return (first + last).toUpperCase();
}

export async function provisionUser(input: ProvisionInput): Promise<ProvisionResult> {
  const key = input.user.trim();
  const digits = key.replace(/\D/g, "");

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
    .select({ app: appAccess.app })
    .from(appAccess)
    .where(eq(appAccess.userId, user.id));
  const beforeApps = currentAccess.map((a) => a.app).sort();

  const before = {
    name: user.name,
    email: user.email,
    role: user.role as string,
    apps: beforeApps,
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

  if (input.role && input.role !== user.role) {
    patch.role = input.role;
    changed.push(`role ${user.role} → ${input.role}`);
  }

  if (Object.keys(patch).length) {
    patch.updatedAt = new Date();
    await db.update(users).set(patch).where(eq(users.id, user.id));
  }

  /* ---------------------------------------------------------------- apps */

  let afterApps = beforeApps;
  const requested = input.apps ?? (input.addApps ? [...beforeApps, ...input.addApps] : null);

  if (requested) {
    const wanted = [...new Set(requested)].filter((a): a is AppId =>
      APP_IDS.includes(a as AppId),
    );
    const unknown = [...new Set(requested)].filter((a) => !APP_IDS.includes(a as AppId));
    if (unknown.length) {
      throw new Error(`Not an app: ${unknown.join(", ")}. One of: ${APP_IDS.join(", ")}`);
    }

    const add = wanted.filter((a) => !beforeApps.includes(a));
    const remove = beforeApps.filter((a) => !wanted.includes(a as AppId));

    if (add.length) {
      await db.insert(appAccess).values(
        add.map((app) => ({ id: newId("acc"), userId: user.id, app, grantedById: null })),
      );
    }
    if (remove.length) {
      await db
        .delete(appAccess)
        .where(
          and(eq(appAccess.userId, user.id), inArray(appAccess.app, remove as AppId[])),
        );
    }
    if (add.length || remove.length) {
      changed.push(
        `apps ${beforeApps.join(",") || "none"} → ${wanted.sort().join(",") || "none"}`,
      );
    }
    afterApps = wanted.sort();
  }

  if (changed.length) {
    await db.insert(auditLog).values({
      id: newId("aud"),
      // No session behind a shared-secret call. Recording nobody is more
      // honest than attributing it to whoever is being changed.
      actorId: null,
      action: "provision-user",
      entityType: "user",
      entityId: user.id,
      afterState: { changed } as never,
    });
  }

  return {
    userId: user.id,
    before,
    after: {
      name: patch.name ?? user.name,
      email: patch.email ?? user.email,
      role: (patch.role ?? user.role) as string,
      apps: afterApps,
    },
    changed,
  };
}
