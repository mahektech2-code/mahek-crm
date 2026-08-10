/**
 * Give the accounts team sign-ins, from the employee master.
 *
 *   npm run users:accounts -- --dry-run
 *   npm run users:accounts
 *
 * Those two read `.env.local`, which is the LOCAL database. Creating the team
 * there and believing it was done is how the accounts team spent a week unable
 * to sign in to prod: the rows existed, on somebody's laptop, and the sign-in
 * screen cannot tell a missing account from a wrong password. Against any
 * other database, pass the URL rather than a file:
 *
 *   DATABASE_URL=... npm run users:accounts:url -- --dry-run
 *   DATABASE_URL=... npm run users:accounts:url
 *
 * Who gets one is a question the HRMS mirror already answers: an ACTIVE
 * employee whose position is the Account Department. Typing the names in here
 * instead would mean this file disagreeing with the sheet the day somebody
 * joins or leaves, and the sheet is the one HR maintains.
 *
 * They sign in with their own email — the sheet's `email` column — and with
 * their personal mobile as the work number, because the company mobile column
 * carries placeholders (1111111111) shared across rows and a work number has
 * to be unique or the sign-in form has two answers to one question.
 *
 * Role `accounts`, and the Accounts app only. Deliberately without the CRM:
 * the person deciding whether a customer may take more credit is not the
 * person chasing them for the next order.
 *
 * Idempotent. An employee who already has an account is left alone — this
 * never resets a password somebody has changed. An email or work number
 * already spoken for by somebody else is reported and skipped rather than
 * guessed around.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { appAccess, employees, users } from "../src/db/schema";
import { initialsOf } from "../src/lib/format";
import { hashPassword } from "../src/lib/password";

/** Admin-created accounts start on a known password and are told to change it. */
const INITIAL_PASSWORD = "mahek1234";

const newId = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");

  const team = (
    await db
      .select({
        code: employees.employeeCode,
        name: employees.name,
        position: employees.position,
        status: employees.status,
        email: employees.email,
        personalMobile: employees.personalMobile,
      })
      .from(employees)
      .where(eq(employees.status, "active"))
  ).filter((e) => /account/i.test(e.position ?? ""));

  if (!team.length) {
    console.log("No active employee sits in the Account Department. Nothing to do.");
    return;
  }

  const existing = await db.select({ email: users.email, phone: users.phone }).from(users);
  const takenEmail = new Set(existing.map((u) => u.email));
  const takenPhone = new Set(existing.map((u) => u.phone).filter(Boolean) as string[]);

  for (const e of team) {
    const label = `${e.name} (${e.code})`;
    const email = e.email?.trim().toLowerCase() ?? "";
    const phone = e.personalMobile?.trim() ?? "";

    if (!email) {
      console.log(`SKIP  ${label} — the sheet has no email for them, and that is how they sign in.`);
      continue;
    }
    if (takenEmail.has(email)) {
      console.log(`SKIP  ${label} — ${email} already has an account.`);
      continue;
    }

    const workNumber = /^[6-9]\d{9}$/.test(phone) && !takenPhone.has(phone) ? phone : null;
    if (!workNumber && phone) {
      console.log(`NOTE  ${label} — ${phone} is not usable as a work number; email only.`);
    }

    if (dryRun) {
      console.log(`WOULD ${label} → ${email}${workNumber ? ` / ${workNumber}` : ""} · accounts`);
      takenEmail.add(email);
      if (workNumber) takenPhone.add(workNumber);
      continue;
    }

    const id = newId("usr");
    const passwordHash = await hashPassword(INITIAL_PASSWORD);
    await db.transaction(async (tx) => {
      await tx.insert(users).values({
        id,
        name: e.name,
        email,
        phone: workNumber,
        role: "accounts",
        initials: initialsOf(e.name),
        passwordHash,
        active: true,
      });
      await tx.insert(appAccess).values({
        id: newId("acc"),
        userId: id,
        app: "accounts",
        grantedById: null,
      });
    });
    takenEmail.add(email);
    if (workNumber) takenPhone.add(workNumber);
    console.log(`MADE  ${label} → ${email}${workNumber ? ` / ${workNumber}` : ""} · accounts`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
