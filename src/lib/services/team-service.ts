import "server-only";
import { randomUUID } from "node:crypto";
import { eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, auditLog, sheetPartyRows, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth";

/* ---------------------------------------------------------------------------
 * The back office team, from the customer master.
 *
 * `Tag Sales Person` on the Sales Party tab is who works an account — the back
 * office, which in this company is the telecalling team. Four names cover
 * 919 of the 1,191 parties, and one of them is the owner, who still keeps a
 * few accounts of his own.
 *
 * Two jobs, deliberately separate. Making people accounts is one thing;
 * handing them a book is another, and the second is re-runnable while the
 * first must never quietly mint a second login for somebody who already has
 * one.
 *
 * Why this is not read from the employee master: the four are not all in it.
 * Two are missing entirely, and the two present share one mailbox — so the
 * addresses are constructed here, where they can be seen and corrected, rather
 * than guessed from a tab that cannot answer. Sign-in also accepts a work
 * number, which is what a telecaller actually remembers.
 * ------------------------------------------------------------------------- */

const newId = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/**
 * The address each person signs in with.
 *
 * An explicit table rather than a rule, because these are four real people and
 * a rule that generated `vaishalishivajichaudhari@` would be worse than a list
 * somebody can read and fix. A name not listed falls back to its first word,
 * which is enough to create the account and easy to correct afterwards.
 */
const EMAIL_BY_NAME: Record<string, string> = {
  "vaishali shivaji chaudhari": "vaishali@mahek.in",
  "heena pritesh doshi": "heena@mahek.in",
  "poonam pashte": "poonam@mahek.in",
  "pritesh bipin doshi": "pritesh@mahek.in",
};

const key = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

function emailFor(name: string): string {
  const known = EMAIL_BY_NAME[key(name)];
  if (known) return known;
  const first = key(name).split(" ")[0].replace(/[^a-z0-9]/g, "");
  return `${first || "staff"}@mahek.in`;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const a = parts[0]?.[0] ?? "";
  const b = parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : (parts[0]?.[1] ?? "");
  return (a + b).toUpperCase();
}

export type TeamReport = {
  people: {
    name: string;
    email: string;
    parties: number;
    created: boolean;
    appsGranted: string[];
  }[];
  assigned: number;
  untagged: number;
  skippedNoUser: number;
};

/**
 * Everyone named as Tag Sales Person, with how much of the book they hold.
 */
export async function backOfficeNames(): Promise<{ name: string; parties: number }[]> {
  const rows = await db
    .select({
      name: sheetPartyRows.backOfficeName,
      n: sql<number>`count(*)::int`,
    })
    .from(sheetPartyRows)
    .where(isNotNull(sheetPartyRows.backOfficeName))
    .groupBy(sheetPartyRows.backOfficeName)
    .orderBy(sql`count(*) desc`);

  return rows
    .filter((r) => r.name && r.name.trim())
    .map((r) => ({ name: r.name!.trim(), parties: Number(r.n) }));
}

/**
 * Make sure each of them can sign in, then give every customer to the person
 * the master says works it.
 *
 * `password` is set only on accounts this creates. An existing account keeps
 * whatever its owner already knows — resetting somebody's password because a
 * sync ran would be a way to lock the team out of their own system.
 */
export async function provisionBackOffice(options: {
  password: string;
  /** Apps a newly created telecaller gets. */
  apps?: ("crm" | "reports")[];
  dryRun?: boolean;
}): Promise<TeamReport> {
  const names = await backOfficeNames();
  const apps = options.apps ?? ["crm"];

  const report: TeamReport = {
    people: [],
    assigned: 0,
    untagged: 0,
    skippedNoUser: 0,
  };

  const userIdByName = new Map<string, string>();

  for (const { name, parties } of names) {
    const email = emailFor(name);
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (existing.length) {
      userIdByName.set(key(name), existing[0].id);
      report.people.push({ name, email, parties, created: false, appsGranted: [] });
      continue;
    }

    if (options.dryRun) {
      report.people.push({ name, email, parties, created: true, appsGranted: apps });
      continue;
    }

    const id = newId("usr");
    await db.insert(users).values({
      id,
      name,
      email,
      // Not from the employee master's plaintext password column. That holds
      // credentials to another system and is nobody's business here.
      passwordHash: await hashPassword(options.password),
      role: "telecaller",
      initials: initialsOf(name),
      active: true,
    });
    await db.insert(appAccess).values(
      apps.map((app) => ({ id: newId("acc"), userId: id, app, grantedById: null })),
    );
    await db.insert(auditLog).values({
      id: newId("aud"),
      actorId: null,
      action: "create-user",
      entityType: "user",
      entityId: id,
      afterState: { detail: `${name} <${email}> from the customer master` } as never,
    });

    userIdByName.set(key(name), id);
    report.people.push({ name, email, parties, created: true, appsGranted: apps });
  }

  if (options.dryRun) {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(sheetPartyRows)
      .where(sql`${sheetPartyRows.backOfficeName} is null`);
    report.untagged = Number(n);
    return report;
  }

  /* -------------------------------------------------------- the handover */

  // One statement per person rather than per customer: the master says who
  // works an account, and the join is the party name both sides already agree
  // on.
  for (const [nameKey, userId] of userIdByName) {
    // NOTE the doubled backslash. This is a JS template literal, so a single
    // "\s" collapses to "s" before Postgres ever sees it and the expression
    // quietly starts replacing the letter s. It matched nothing, which reads
    // exactly like a handover that ran and found nobody to hand over.
    //
    // The join is the party NAME, folded the same way both sides fold it.
    // Not external_code: the order projection prefixes that with "SHEET:" and
    // the master's key carries no prefix, so matching them would silently
    // assign nobody — and a handover that touches no rows looks exactly like a
    // handover that worked.
    const moved = await db.execute(sql`
      update customers c
         set sales_am_id = ${userId},
             owner_id    = coalesce(c.owner_id, ${userId}),
             updated_at  = now()
        from sheet_party_rows p
       where p.status = 'present'
         and lower(regexp_replace(trim(p.back_office_name), '\\s+', ' ', 'g')) = ${nameKey}
         and upper(regexp_replace(trim(c.name), '\\s+', ' ', 'g')) = p.party_key
         and c.kind = 'customer'
      returning c.id
    `);
    const rows = (moved as unknown as { length?: number; rows?: unknown[] });
    report.assigned += rows.rows?.length ?? rows.length ?? 0;
  }

  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sheetPartyRows)
    .where(sql`${sheetPartyRows.backOfficeName} is null`);
  report.untagged = Number(n);

  return report;
}
