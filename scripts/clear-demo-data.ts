/**
 * Clears the demo book — the fifty-two invented customers and everything that
 * hangs off them — and leaves everything that is not demo data alone.
 *
 *   npm run demo:clear              what would go, and what would stay
 *   npm run demo:clear -- --apply   do it
 *
 * Three kinds of row live in this database and only one of them is demo:
 *
 *   The BOOK — customers, their orders, bills, payments, calls, reminders,
 *   complaints, messages and the derived caches over them. Invented, and the
 *   thing to remove before real work starts.
 *
 *   The TEAM and the CONFIGURATION — users, who may open which app, every
 *   threshold in app_settings, the quick notes, the WhatsApp templates, the
 *   help articles. Seeded, but not demo: delete the users and nobody can sign
 *   in, delete app_settings and the queue has no thresholds to read.
 *
 *   The CATALOGUE — Mahek's real product master. Written by the seeder, which
 *   makes it look like demo data and it is not.
 *
 * So this names the tables it clears rather than clearing what the seeder
 * wrote, and it counts the keep-set before and after so that "left alone" is
 * demonstrated rather than asserted.
 */
import { sql } from "drizzle-orm";
import { db } from "../src/db";

/**
 * The demo book, in an order that respects foreign keys — children first, so
 * nothing is left pointing at a row that has gone.
 */
const BOOK = [
  "queue_snapshots",
  "interaction_product_lines",
  "complaint_images",
  "complaint_status_history",
  "complaints",
  "follow_up_attempts",
  "follow_up_states",
  "inactive_watch_items",
  "wa_replies",
  "wa_messages",
  "wa_runs",
  "reminders",
  "payments",
  "bills",
  "orders",
  "calls",
  "monthly_targets",
  "eod_reports",
  "attendance",
  "notifications",
  "migration_exceptions",
  "attachment_bytes",
  "attachments",
  "customers",
] as const;

/**
 * What must still be standing afterwards. Counted before and after, because a
 * cascade reaching one of these is the failure worth catching, and it would
 * otherwise be silent.
 */
const KEEP = [
  "users",
  "app_access",
  "app_settings",
  "quick_notes",
  "wa_templates",
  "help_articles",
  "products",
  "finished_goods",
  "product_brands",
  "product_formulations",
  "product_aliases",
  "catalogue_exceptions",
  // Not demo, and not ours to erase: the audit log is the record of who did
  // what, including decisions taken against the catalogue. Rows naming a
  // deleted customer are harmless — it holds no foreign key.
  "audit_log",
  // Somebody signed in stays signed in. Clearing the book is not a reason to
  // throw everybody out.
  "sessions",
] as const;

const apply = process.argv.includes("--apply");

async function countOf(table: string): Promise<number> {
  const rows = await db.execute<{ n: number }>(
    sql.raw(`select count(*)::int as n from "${table}"`),
  );
  return Number(rows[0]?.n ?? 0);
}

async function counts(tables: readonly string[]) {
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = await countOf(t);
  return out;
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  // Say which database, every time. The whole risk here is doing this to the
  // wrong one, and a host in the output is what makes that visible.
  const host = url.replace(/^.*@/, "").replace(/\/.*$/, "") || "unknown";

  const bookBefore = await counts(BOOK);
  const keepBefore = await counts(KEEP);
  const doomed = Object.values(bookBefore).reduce((a, b) => a + b, 0);

  console.log(`\nDatabase: ${host}`);
  console.log(apply ? "Applying.\n" : "Dry run — nothing will be written.\n");

  console.log("The demo book:");
  for (const [t, n] of Object.entries(bookBefore)) {
    if (n > 0) console.log(`  ${String(n).padStart(7)}  ${t}`);
  }
  console.log(`  ${String(doomed).padStart(7)}  rows in total\n`);

  console.log("Left alone:");
  for (const [t, n] of Object.entries(keepBefore)) {
    console.log(`  ${String(n).padStart(7)}  ${t}`);
  }

  if (!apply) {
    console.log("\nRe-run with --apply to clear the book.\n");
    process.exit(0);
  }

  if (doomed === 0) {
    console.log("\nNothing to clear — the book is already empty.\n");
    process.exit(0);
  }

  // One transaction: a half-cleared book is a customer whose bills survived
  // them, which is worse than either outcome on its own.
  await db.transaction(async (tx) => {
    for (const table of BOOK) {
      await tx.execute(sql.raw(`delete from "${table}"`));
    }
  });

  const bookAfter = await counts(BOOK);
  const keepAfter = await counts(KEEP);

  const leftovers = Object.entries(bookAfter).filter(([, n]) => n > 0);
  const harmed = Object.entries(keepAfter).filter(
    ([t, n]) => n !== keepBefore[t],
  );

  console.log(`\nCleared ${doomed} rows.`);
  if (leftovers.length) {
    console.log("Still holding rows, which should not happen:");
    for (const [t, n] of leftovers) console.log(`  ${n} ${t}`);
  }
  if (harmed.length) {
    console.log("\nSomething reached the keep-set — investigate:");
    for (const [t, n] of harmed) console.log(`  ${t}: ${keepBefore[t]} → ${n}`);
    process.exit(1);
  }
  console.log("Everything outside the book is untouched.\n");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
