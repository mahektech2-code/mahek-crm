/**
 * Change somebody's role, by hand.
 *
 *   npm run user:role -- vikram@mahek.in admin
 *   npm run user:role -- 9820011006 manager
 *
 * Why this exists rather than a migration each time: a role is a decision
 * about a person, and the first one — Vikram to admin — went in as
 * `0043_vikram_admin_role` because production is never reseeded and there was
 * no other door. That is a poor pattern to repeat: migration history is not
 * where an org chart belongs, and a migration naming an individual runs on
 * every database forever.
 *
 * WHAT A ROLE DECIDES, so nobody runs this casually:
 *
 *   telecaller  own book, pinned; cannot widen it
 *   manager     their reporting line, and the manager-only capabilities
 *   accounts    every book for approvals, and ONLY the accounts capabilities
 *   admin       everything, including the accounts-only ones
 *
 * `admin` therefore hands one person both halves of a separation the rest of
 * the file works to keep apart — approving the orders that hit the targets
 * they are chasing. That is somebody's call to make, and this prints it
 * rather than assuming it was understood.
 *
 * Idempotent. Setting the role somebody already holds changes nothing.
 */
import { eq, or } from "drizzle-orm";
import { db } from "../src/db";
import { users } from "../src/db/schema";

const ROLES = ["telecaller", "manager", "accounts", "admin"] as const;
type Role = (typeof ROLES)[number];

/** What each role opens, in one line, printed on every change. */
const CONSEQUENCE: Record<Role, string> = {
  telecaller: "their own book only, and none of the manager actions",
  manager: "their reporting line, targets, exports and configuration",
  accounts: "every book for approvals, and none of the calling work",
  admin: "everything, including approving orders and confirming payments",
};

async function main() {
  const [who, role] = process.argv.slice(2);
  if (!who || !role) {
    console.error("Usage: npm run user:role -- <email or work number> <role>");
    console.error(`Roles: ${ROLES.join(", ")}`);
    process.exit(1);
  }
  if (!ROLES.includes(role as Role)) {
    console.error(`"${role}" is not a role. One of: ${ROLES.join(", ")}`);
    process.exit(1);
  }

  const [user] = await db
    .select({ id: users.id, name: users.name, role: users.role })
    .from(users)
    .where(or(eq(users.email, who), eq(users.phone, who)))
    .limit(1);

  if (!user) {
    console.error(`No user with the email or work number "${who}".`);
    process.exit(1);
  }

  if (user.role === role) {
    console.log(`${user.name} is already ${role}. Nothing to do.`);
    process.exit(0);
  }

  await db.update(users).set({ role: role as Role }).where(eq(users.id, user.id));

  console.log(`${user.name}: ${user.role} → ${role}`);
  console.log(`They can now reach ${CONSEQUENCE[role as Role]}.`);
  /*
   * Sessions are not ended. The role is read per request rather than baked
   * into the session row, so the change takes effect on their next page load
   * without signing anybody out mid-call.
   */
  console.log("Takes effect on their next page load; nobody is signed out.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
