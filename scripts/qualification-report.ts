/**
 * READ-ONLY: what the Telecaller-owned Qualification workflow means for the leads
 * already in the book.
 *
 *   npm run report:qualification
 *
 * It runs SELECTs and nothing else. It writes no row, voids no review, opens no
 * Qualification, assigns no owner and moves no stage — every count below is
 * something a person reads and then decides about. The database it reads is
 * whichever `DATABASE_URL` points at, so run it against production only with
 * that in mind (it is still read-only).
 *
 * Why it exists rather than a migration: the new rules are evaluated by the
 * gate on what is stored, so NOTHING has to be rewritten for them to take
 * effect. What a person may want to know is which leads the rules will now
 * stop, and which reviews were given before an edit they never saw.
 */
import { sql } from "drizzle-orm";
import { db } from "../src/db";

type Row = Record<string, unknown>;

/** Every query runs through this, which main() sets to a READ ONLY transaction. */
let runner: typeof db = db;
const n = (r: Row[]) => Number(r[0]?.n ?? 0);

async function count(label: string, query: ReturnType<typeof sql>) {
  const rows = (await runner.execute(query)) as unknown as Row[];
  console.log(`${String(n(rows)).padStart(6)}  ${label}`);
}

async function report() {
  console.log("\nQualification workflow — read-only report\n");

  await count(
    "Prospects nobody has verified (they wait for a Sales Manager; nothing is changed)",
    sql`select count(*)::int n from customers where lead_stage = 'prospect' and lead_verified_at is null`,
  );
  await count(
    "Prospects a manager HAS verified but that are still at Prospect (Qualification never opened for them)",
    sql`select count(*)::int n from customers where lead_stage = 'prospect' and lead_verified_at is not null`,
  );
  await count(
    "Leads at Qualification with NO manager review (blocked at Sample/Trial until reviewed)",
    sql`select count(*)::int n from customers
         where lead_stage in ('qualification','qualified') and lead_sales_type in ('direct','third_party')
           and lead_qualification_review is null`,
  );
  await count(
    "Leads at Qualification with a VERIFIED review",
    sql`select count(*)::int n from customers
         where lead_stage in ('qualification','qualified') and lead_sales_type in ('direct','third_party')
           and lead_qualification_review = 'verified'`,
  );
  await count(
    "Leads at Qualification sent back (incomplete / clarification) — still blocked, as before",
    sql`select count(*)::int n from customers
         where lead_stage in ('qualification','qualified') and lead_sales_type in ('direct','third_party')
           and lead_qualification_review in ('incomplete','clarification')`,
  );

  console.log("\nVerified reviews that may be STALE (a person decides; nothing is voided here):\n");
  await count(
    "  definitely stale — an AUDITED material edit was made after the review",
    sql`select count(distinct c.id)::int n
          from customers c
          join audit_log a on a.entity_id = c.id
         where c.lead_stage in ('qualification','qualified')
           and c.lead_qualification_review = 'verified'
           and a.action in ('lead.qualification.save','lead.prospectFields.save','lead.gstValidate',
                            'lead.salesType.set','customer.addDistributor','customer.removeDistributor',
                            'customer.updateDistributor','lead.nameDistributor','customer.update')
           and a.at > c.lead_qualification_reviewed_at`,
  );
  await count(
    "  possibly stale — the record changed after the review, with no audited edit to explain it",
    sql`select count(*)::int n from customers c
         where c.lead_stage in ('qualification','qualified')
           and c.lead_qualification_review = 'verified'
           and c.updated_at > c.lead_qualification_reviewed_at + interval '1 minute'
           and not exists (
             select 1 from audit_log a
              where a.entity_id = c.id and a.at > c.lead_qualification_reviewed_at
                and a.action in ('lead.qualification.save','lead.prospectFields.save','lead.gstValidate',
                                 'lead.salesType.set','customer.addDistributor','customer.removeDistributor',
                                 'customer.updateDistributor','lead.nameDistributor','customer.update'))`,
  );
  console.log(
    "  (edits made from a handset, and by the sheet import, leave no audit row, so they cannot be\n" +
      "   counted as 'definitely' — 'possibly stale' is the honest ceiling for those.)\n",
  );

  await count(
    "Third-party SALES-TYPE leads with no distributor named (the distributor is now required for a sample)",
    sql`select count(*)::int n from customers c
         where c.lead_sales_type = 'third_party' and c.lead_stage is not null
           and c.lead_stage not in ('lost','customer')
           and not exists (select 1 from customer_distributors d where d.customer_id = c.id)`,
  );
  await count(
    "Leads with no owner at all (on no Telecaller's desk until somebody assigns them)",
    sql`select count(*)::int n from customers
         where lead_stage is not null and lead_archived = false and owner_id is null
           and lead_stage not in ('lost','customer')`,
  );
  await count(
    "Leads with no 'lead_created' history (Created By reads 'Not recorded' — imported or older than the event)",
    sql`select count(*)::int n from customers c
         where c.lead_stage is not null
           and not exists (select 1 from timeline_events t
                            where t.customer_id = c.id and t.event_type = 'lead_created')`,
  );
  await count(
    "Open 'requirement_visit' tasks left over from the old handset flow (not touched; new ones are no longer created)",
    sql`select count(*)::int n from mbos_tasks where source_type = 'requirement_visit' and status in ('open','in_progress')`,
  );

  console.log("\nNothing was changed.\n");
}

/**
 * The whole report runs in ONE transaction that Postgres itself has been told is
 * read only, so even a query added carelessly later cannot write: the database
 * would refuse it. That is the guarantee worth having when the connection string
 * points at production.
 */
async function main() {
  await db.transaction(async (tx) => {
    await tx.execute(sql`set transaction read only`);
    runner = tx as unknown as typeof db;
    await report();
  });
  await db.$client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
