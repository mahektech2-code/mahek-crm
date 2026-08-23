/**
 * One field salesman, by hand, because he is not in the HRMS mirror.
 *
 * The console's Access dialog reads the employee master and refuses anybody
 * who is not ACTIVE there — which is right, and which this deliberately steps
 * around for somebody HR has not added to the sheet yet. The consequence is
 * named rather than hidden: nothing links this login to an employee record, so
 * he will not appear as a leaver when he goes.
 *
 * Idempotent. An email or a work number already spoken for is reported and
 * skipped rather than guessed around — both are how somebody signs in, so a
 * collision means the sign-in form has two answers to one question.
 */
import { randomUUID } from "node:crypto"
import { eq, or } from "drizzle-orm"
import { db } from "./src/db"
import { appAccess, users } from "./src/db/schema"
import { initialsOf } from "./src/lib/format"
import { hashPassword } from "./src/lib/password"

const NAME = "Abhinaba"
const EMAIL = "abhinaba@mahek.in"
const PHONE = "8876249506"
const PASSWORD = "mahek1234"
const APP = "field" as const
const ROLE = "telecaller" as const   // no "salesman" role exists; this is how Mahesh is seeded
const DRY = process.argv.includes("--dry-run")

const newId = (p: string) => `${p}_${randomUUID().slice(0, 12)}`

const clash = await db
  .select({ id: users.id, name: users.name, email: users.email, phone: users.phone })
  .from(users)
  .where(or(eq(users.email, EMAIL), eq(users.phone, PHONE)))

if (clash.length) {
  console.log("REFUSED — that email or work number is already in use:")
  for (const c of clash) console.log(`  ${c.name} · ${c.email} · ${c.phone ?? "no number"}`)
  process.exit(1)
}

console.log(`${DRY ? "WOULD CREATE" : "CREATING"}:`)
console.log(`  name      ${NAME}`)
console.log(`  email     ${EMAIL}`)
console.log(`  work no.  ${PHONE}`)
console.log(`  role      ${ROLE}`)
console.log(`  app       ${APP} (Salesman App — what MBOS sign-in requires)`)
console.log(`  password  set as given`)

if (DRY) { console.log("\nDry run — nothing written."); process.exit(0) }

const id = newId("usr")
const passwordHash = await hashPassword(PASSWORD)

await db.transaction(async (tx) => {
  await tx.insert(users).values({
    id, name: NAME, email: EMAIL, phone: PHONE,
    role: ROLE, initials: initialsOf(NAME), passwordHash, active: true,
  })
  await tx.insert(appAccess).values({ id: newId("acc"), userId: id, app: APP, grantedById: null })
})

const [made] = await db.select().from(users).where(eq(users.id, id))
const grants = await db.select({ app: appAccess.app }).from(appAccess).where(eq(appAccess.userId, id))
console.log(`\nMADE  ${made.name} · ${made.email} · ${made.phone} · role=${made.role} · apps=${grants.map(g=>g.app).join(", ")}`)

// The pool keeps the process alive otherwise — the work is done, this just ends it.
process.exit(0)
