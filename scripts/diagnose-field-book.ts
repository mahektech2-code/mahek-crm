/**
 * Why is a field salesman's handset empty?
 *
 * Read-only. It asks the four questions in the order the sync asks them, and
 * stops being interesting at the first one that answers zero:
 *
 *   1. Is there an account at all, is it active, and does it hold `field`?
 *   2. What scope does MBOS resolve for it — `mine`, `team` or `all`?
 *   3. How many customers does `scopedToUsers` return for that scope? This is
 *      the number `customersForDevice` sends, so it IS what the handset shows.
 *   4. If that is zero: does the name appear anywhere the book already knows
 *      it — `sales_person_name`, the field-activity log — which is the
 *      evidence of which shops are actually theirs.
 *
 * `npx tsx --conditions=react-server --env-file=.env.prod.local \
 *    scripts/diagnose-field-book.ts <name-or-mobile-or-email>`
 */
import { eq, or, sql } from "drizzle-orm";
import { db } from "../src/db";
import { appAccess, customers, users } from "../src/db/schema";
import { ASSIGNED_TO_SQL, BACK_OFFICE_SQL, scopedToUsers } from "../src/lib/access-control";

/** Whether this deployment has taken the EMP 2.0 shop master yet. */
async function hasMaster(): Promise<boolean> {
  const [row] = await db.execute<{ there: string | null }>(
    sql`select to_regclass('public.sheet_customer_master_rows')::text as there`,
  );
  return !!row?.there;
}

async function main() {
  const term = process.argv[2];
  if (!term) {
    console.error("Name, mobile or email, please.");
    process.exit(1);
  }

  const like = `%${term.toLowerCase()}%`;

  const found = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      phone: users.phone,
      role: users.role,
      active: users.active,
      reportsToId: users.reportsToId,
      lastLoginAt: users.lastLoginAt,
    })
    .from(users)
    .where(
      or(
        sql`lower(${users.name}) like ${like}`,
        sql`lower(${users.email}) like ${like}`,
        sql`coalesce(${users.phone}, '') like ${like}`,
      ),
    );

  if (!found.length) {
    console.log(`No account matches "${term}". That alone is the answer — MBOS refuses at step one.`);
    process.exit(0);
  }

  for (const u of found) {
    console.log(`\n── ${u.name} · ${u.email} · ${u.phone ?? "no work number"}`);
    console.log(`   id ${u.id}`);
    console.log(`   role ${u.role} · ${u.active ? "active" : "DISABLED"}`);
    console.log(`   last signed in ${u.lastLoginAt ? u.lastLoginAt.toISOString() : "never"}`);

    const grants = await db
      .select({ app: appAccess.app, role: appAccess.role })
      .from(appAccess)
      .where(eq(appAccess.userId, u.id));
    const apps = grants.map((g) => g.app + (g.role ? ` (as ${g.role})` : "")).join(", ") || "none";
    console.log(`   apps: ${apps}`);
    if (!grants.some((g) => g.app === "field")) {
      console.log(`   → MBOS would refuse sign-in: no \`field\` grant.`);
      continue;
    }

    /* What `loadPrincipal` resolves. A manager gets their reports; anybody else
       gets themselves, which for a field salesman is one id. */
    const isManager = u.role === "manager" || u.role === "admin";
    const reports = isManager
      ? await db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(or(eq(users.reportsToId, u.id), eq(users.id, u.id)))
      : [{ id: u.id, name: u.name }];
    const ids = u.role === "admin" ? null : reports.map((r) => r.id);
    console.log(
      `   scope: ${ids === null ? "all (admin)" : isManager ? `team — ${ids.length} people` : "mine — just this account"}`,
    );

    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(customers)
      .where(scopedToUsers(ids));
    console.log(`   customers the handset would receive: ${n}`);

    if (n > 0) {
      console.log(`   → The book is not empty on the server. The fault is in the sync or on the handset.`);
      continue;
    }

    /*
     * Zero. So where does this person's name actually appear?
     *
     * TWO places, and which one answers decides the shape of the fix. The
     * party sheet writes `customers.sales_person_name` and `recomputeSalesPeople`
     * rebuilds it nightly; the EMP 2.0 shop master names a salesman too, but
     * the projection deliberately leaves that on the staging row rather than
     * fight the nightly for the column. A book that lives entirely in the
     * second one cannot be reached by reading the first.
     */
    const [byName] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(customers)
      .where(sql`lower(coalesce(${customers.salesPersonName}, '')) like ${like}`);
    console.log(`   shops naming them in \`customers.sales_person_name\` (party sheet): ${byName.n}`);

    /* The master is a newer table than this script's other subjects, so a
       deployment that has not taken 0093 yet answers "not imported here"
       rather than throwing and losing the eight findings above it. */
    if (await hasMaster()) {
      const master = await db.execute<{ rows: number; published: number }>(sql`
        select count(*)::int as rows,
               count(projected_customer_id)::int as published
          from sheet_customer_master_rows
         where lower(coalesce(sales_person_name, '')) like ${like}`);
      const m = master[0] ?? { rows: 0, published: 0 };
      console.log(
        `   shops naming them in the EMP 2.0 master (staging): ${m.rows}, of which ${m.published} are published customers`,
      );
    } else {
      console.log(`   EMP 2.0 master: not imported on this database`);
    }

    const activity = await db.execute<{ n: number; matched: number }>(sql`
      select count(*)::int as n,
             count(distinct matched_customer_id)::int as matched
        from sheet_field_activity_rows
       where matched_salesman_id = ${u.id}`);
    const a = activity[0] ?? { n: 0, matched: 0 };
    console.log(`   field-activity rows matched to them: ${a.n}, across ${a.matched} matched shops`);

    const [seats] = await db
      .select({
        sales: sql<number>`count(*) filter (where ${ASSIGNED_TO_SQL} = ${u.id})::int`,
        back: sql<number>`count(*) filter (where ${BACK_OFFICE_SQL} = ${u.id})::int`,
        owner: sql<number>`count(*) filter (where ${customers.ownerId} = ${u.id})::int`,
      })
      .from(customers);
    console.log(`   seats held: sales ${seats.sales} · back office ${seats.back} · owner ${seats.owner}`);

    /* The exact spellings, because a link is made against one of them and
       "Pritesh" and "PRITESH PATEL" are not the same string to a join. */
    const party = sql`
      select 'party sheet' as source, sales_person_name as name, count(*)::int as n
        from customers
       where lower(coalesce(sales_person_name, '')) like ${like}
       group by sales_person_name`;
    const spellings = await db.execute<{ source: string; name: string; n: number }>(
      (await hasMaster())
        ? sql`${party}
              union all
              select 'EMP 2.0 master', sales_person_name, count(*)::int
                from sheet_customer_master_rows
               where lower(coalesce(sales_person_name, '')) like ${like}
               group by sales_person_name
               order by n desc`
        : sql`${party} order by n desc`,
    );
    if (spellings.length) {
      console.log(`   spellings found:`);
      for (const s of spellings) console.log(`     ${s.n.toString().padStart(5)}  ${s.name}  · ${s.source}`);
    }

    console.log(
      `   → Nothing links this login to a customer. The handset is empty because the book is,\n` +
        `     not because the sync failed.`,
    );
  }

  process.exit(0);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
