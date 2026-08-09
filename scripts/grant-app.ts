/**
 * Grant an app to somebody, by hand.
 *
 *   npm run app:grant -- hrms vikram@mahek.in
 *   npm run app:grant -- hrms 9820011006
 *
 * Why this exists rather than a migration: a new app id is added to the
 * `app_id` enum by a migration, and Postgres refuses to USE a value added to
 * an enum until that transaction commits — drizzle-kit applies every pending
 * migration in ONE transaction, so a grant sitting in the next migration file
 * fails on any database that has not already been through the first. The
 * grant is therefore a deliberate step somebody runs, which is what it should
 * be anyway: HRMS carries salaries and home addresses.
 *
 * Idempotent. Granting an app somebody already has changes nothing.
 */
import { randomUUID } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { db } from "../src/db";
import { appAccess, users } from "../src/db/schema";
import { APP_IDS, type AppId } from "../src/lib/apps";

async function main() {
  const [app, who] = process.argv.slice(2);
  if (!app || !who) {
    console.error("Usage: npm run app:grant -- <app> <email or work number>");
    process.exit(1);
  }
  if (!APP_IDS.includes(app as AppId)) {
    console.error(`"${app}" is not an app. One of: ${APP_IDS.join(", ")}`);
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

  const existing = await db
    .select({ id: appAccess.id })
    .from(appAccess)
    .where(and(eq(appAccess.userId, user.id), eq(appAccess.app, app as AppId)))
    .limit(1);

  if (existing.length) {
    console.log(`${user.name} already has ${app}. Nothing changed.`);
    return;
  }

  await db.insert(appAccess).values({
    id: `acc_${randomUUID().slice(0, 12)}`,
    userId: user.id,
    app: app as AppId,
    grantedById: null,
  });
  console.log(`${user.name} can now open ${app}.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
