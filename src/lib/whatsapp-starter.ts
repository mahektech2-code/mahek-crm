/**
 * THE EIGHT APPROVED TEMPLATES AND THEIR STARTER RULES, as the migrations
 * state them — read back for anything that wipes and refills the database.
 *
 * `0165` inserts the eight Wati templates and archives every free-text one;
 * `0166` inserts the sending window and the eight starter rules, all Off. Both
 * are written to be run again safely (`WHERE NOT EXISTS`). `npm run db:seed`
 * truncates every WhatsApp table and refilled only its own ten demo templates,
 * so a seeded database had no approved templates and no rules at all: the
 * Automation screen showed "No rules yet" twice and a rule editor whose
 * template list was empty, which made "Add rule" impossible to press.
 *
 * The migrations stay the ONE statement of the starter set. A second copy
 * typed out for the seed would be right the day it was written and wrong the
 * first time somebody retuned a starter rule in a new migration.
 *
 * PURE: text in, statements out. The seed reads the files and runs these.
 */

/** The migrations that hold the starter set, by tag, in the order to run them. */
export const WHATSAPP_STARTER_MIGRATIONS = [
  "0165_whatsapp_templates_follow_their_rules",
  "0166_whatsapp_rules_the_founder_sets",
] as const;

/**
 * The data statements of a migration: its INSERTs and UPDATEs, with their
 * leading comments dropped. Schema statements are left out — the database has
 * been migrated before it is seeded, and a seed is not the place to alter it.
 */
export function starterStatements(migrationSql: string): string[] {
  return migrationSql
    .split("--> statement-breakpoint")
    .map((chunk) =>
      chunk
        .split("\n")
        .filter((line) => !/^\s*--/.test(line))
        .join("\n")
        .trim(),
    )
    .filter((stmt) => /^(INSERT|UPDATE)\b/i.test(stmt));
}
