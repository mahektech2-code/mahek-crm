/**
 * Grant an app to somebody, by hand.
 *
 *   npm run app:grant -- hrms vikram@mahek.in --level=manager
 *   npm run app:grant -- crm 9820011006                 (associate)
 *   npm run app:grant -- admin vikram@mahek.in --level=admin
 *                                     (the platform administrator — see below)
 *
 * Why this exists rather than a migration: a new app id is added to the
 * `app_id` enum by a migration, and Postgres refuses to USE a value added to
 * an enum until that transaction commits — drizzle-kit applies every pending
 * migration in ONE transaction, so a grant sitting in the next migration file
 * fails on any database that has not already been through the first. The
 * grant is therefore a deliberate step somebody runs, which is what it should
 * be anyway: HRMS carries salaries and home addresses.
 *
 * THE LEVEL IS ALWAYS WRITTEN, associate unless `--level` says otherwise. It
 * used to be left null, which meant "the account's own level" — the widest
 * held anywhere — so granting Reports to a CRM manager from here made them a
 * Reports manager without anybody choosing it. And the account level is
 * DERIVED afterwards from every grant the person holds, never typed: `admin`
 * on the Admin Console is what makes a platform administrator, and that is
 * the only way this script can make one.
 *
 * Idempotent. Granting an app somebody already has at the same level changes
 * nothing; at a different level, it moves the level and says so.
 */
import { randomUUID } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { db } from "../src/db";
import { appAccess, auditLog, users } from "../src/db/schema";
import { APP_IDS, getApp, type AppId } from "../src/lib/apps";
import type { Role } from "../src/lib/role-levels";
import {
  grantAppWithDefaultModules,
  rederiveAccountLevel,
} from "../src/lib/services/app-provisioning";

const LEVELS: readonly Role[] = ["associate", "manager", "admin"];
const USAGE =
  "Usage: npm run app:grant -- <app> <email or work number> [--level=associate|manager|admin]";

async function main() {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith("--"));
  const [app, who] = args.filter((a) => !a.startsWith("--"));

  let level: Role = "associate";
  for (const f of flags) {
    const m = /^--level=(.+)$/.exec(f);
    if (!m) {
      // Refused rather than ignored: a flag dropped on the floor reports
      // success for an option that never arrived.
      console.error(`Unknown option "${f}".\n${USAGE}`);
      process.exit(1);
    }
    if (!LEVELS.includes(m[1] as Role)) {
      console.error(`"${m[1]}" is not a level. One of: ${LEVELS.join(", ")}`);
      process.exit(1);
    }
    level = m[1] as Role;
  }

  if (!app || !who) {
    console.error(USAGE);
    process.exit(1);
  }
  if (!APP_IDS.includes(app as AppId)) {
    console.error(`"${app}" is not an app. One of: ${APP_IDS.join(", ")}`);
    process.exit(1);
  }
  const retiredInto = getApp(app)?.retiredInto;
  if (retiredInto) {
    console.error(`"${app}" is retired into ${retiredInto} and is not granted any more.`);
    process.exit(1);
  }

  const [user] = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(or(eq(users.email, who), eq(users.phone, who)))
    .limit(1);

  if (!user) {
    console.error(`No user with the email or work number "${who}".`);
    process.exit(1);
  }

  const [existing] = await db
    .select({ id: appAccess.id, role: appAccess.role })
    .from(appAccess)
    .where(and(eq(appAccess.userId, user.id), eq(appAccess.app, app as AppId)))
    .limit(1);

  const was = (existing?.role ?? "associate") as Role;
  if (existing && was === level) {
    console.log(`${user.name} already has ${app} as ${level}. Nothing changed.`);
    return;
  }

  /* One transaction: the grant (or the level), the account level rebuilt from
     every grant they now hold, and the audit row saying a terminal did it. */
  const derived = await db.transaction(async (tx) => {
    if (existing) {
      await tx.update(appAccess).set({ role: level }).where(eq(appAccess.id, existing.id));
    } else {
      await grantAppWithDefaultModules(tx, { userId: user.id, app: app as AppId, grantedById: null, level });
    }
    const accountLevel = await rederiveAccountLevel(tx, user.id);
    await tx.insert(auditLog).values({
      id: `aud_${randomUUID().slice(0, 12)}`,
      // Nobody signed in ran this, and recording nobody is more honest than
      // naming whoever was changed. No actor role or app either: a terminal
      // wears no hat, and null means "not recorded".
      actorId: null,
      action: existing ? "app-grant-level" : "app-grant",
      entityType: "user",
      entityId: user.id,
      afterState: {
        detail: existing ? `${app} ${was} → ${level} (terminal)` : `granted ${app} as ${level} (terminal)`,
        accountLevel,
      } as never,
    });
    return accountLevel;
  });

  console.log(
    existing
      ? `${user.name} now holds ${app} as ${level} (was ${was}). Account level: ${derived}.`
      : `${user.name} can now open ${app}, as ${level}. Account level: ${derived}.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
