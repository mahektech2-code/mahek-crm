/**
 * Issue somebody a new sign-in password, by hand.
 *
 *   npm run user:password -- pritesh@mahek.in
 *   npm run user:password:prod -- 9820011006 SOME-PASSWORD
 *
 * WHY THIS EXISTS WHEN THE ADMIN CONSOLE ALREADY DOES IT. `issueCredential`
 * is the door, and it is the better one — it is audited against a named
 * actor, it is reachable by whoever is setting somebody up, and it refuses
 * the cases a terminal cannot see. It has exactly one case it cannot serve:
 * it will not issue a password for an account whose role is above the
 * actor's, so THE SUPER ADMIN LOCKED OUT OF THEIR OWN ACCOUNT has nobody
 * standing above them to ask. That is what this is for, and it is the only
 * thing it should be used for.
 *
 * The alternative people reach for is a reseed, which is why this is written
 * down rather than left as a one-liner somebody improvises: `npm run db:seed`
 * wipes the book. Nobody should be within one keystroke of that because
 * somebody forgot a password.
 *
 * It keeps the three disciplines `issueCredential` keeps, because the damage
 * from dropping them is the same from a terminal as from a screen:
 *
 *   - every session on the account goes, since a live session is somebody
 *     signed in on a credential that no longer exists;
 *   - any outstanding reset link is spent, or a link minted before this would
 *     quietly set a THIRD password and neither the office nor the employee
 *     would know which one was live;
 *   - an audit row says it happened, and never says what to.
 *
 * That row's actor is NULL, which is the honest answer rather than a missing
 * one: nobody signed in to do this. Attributing it to the account it was done
 * TO would read months later as that person having reset themselves, which is
 * the one thing the log would then be wrong about. `actor_id` is nullable for
 * exactly this shape of write.
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "../src/db";
import { auditLog, passwordResets, sessions, users } from "../src/db/schema";
import { hashPassword, newPassword } from "../src/lib/password";

const newId = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

async function main() {
  const [who, chosen] = process.argv.slice(2);
  if (!who) {
    console.error("Usage: npm run user:password -- <email or work number> [password]");
    console.error("Leave the password off and a readable one is generated.");
    process.exit(1);
  }

  const [user] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      phone: users.phone,
      role: users.role,
      active: users.active,
    })
    .from(users)
    .where(or(eq(users.email, who), eq(users.phone, who)))
    .limit(1);

  if (!user) {
    console.error(`No user with the email or work number "${who}".`);
    process.exit(1);
  }

  /* The same refusal the Console gives, for the same reason: a password for an
     account that refuses every sign-in is a support call dressed up as a
     solution. Said rather than worked around — re-enabling somebody is a
     decision, and it is not this script's to make on the way past. */
  if (!user.active) {
    console.error(
      `${user.name}'s sign-in is disabled, so a password would not let them in.`,
    );
    console.error("Enable it on the Access screen first, then run this again.");
    process.exit(1);
  }

  const signInWith = user.phone ?? user.email;
  if (!signInWith) {
    console.error(
      `${user.name} has neither a work number nor an email on their account, so there is nothing to sign in with.`,
    );
    process.exit(1);
  }

  const password = chosen ?? newPassword();
  const passwordHash = await hashPassword(password);

  const ended = await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, user.id));
    await tx
      .update(passwordResets)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordResets.userId, user.id), isNull(passwordResets.usedAt)));
    const gone = await tx
      .delete(sessions)
      .where(eq(sessions.userId, user.id))
      .returning({ id: sessions.id });
    await tx.insert(auditLog).values({
      id: newId("aud"),
      actorId: null,
      action: "issue-credential",
      entityType: "user",
      entityId: user.id,
      afterState: {
        detail: `Sign-in password issued to ${user.name} from the terminal${
          gone.length
            ? ` · ${gone.length} session${gone.length === 1 ? "" : "s"} ended`
            : ""
        }`,
      } as never,
    });
    return gone.length;
  });

  console.log(`${user.name} (${user.role})`);
  console.log(`  signs in with   ${signInWith}`);
  console.log(`  password        ${password}`);
  if (password.includes("-")) console.log("  the dash is part of the password");
  console.log(
    ended
      ? `\n${ended} session${ended === 1 ? " was" : "s were"} ended.`
      : "\nThere were no open sessions.",
  );
  console.log("It is not stored anywhere and cannot be shown again.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
