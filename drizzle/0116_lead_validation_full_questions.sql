/* §8 — the seven questions main's validation row had no box for.
 *
 * `mbos_lead_validations` (0102) was built for §E's four feedback questions
 * asked of an existing customer. §8 is the Sales Manager's verification call,
 * which asks twelve of a lead, and five of the twelve fit the columns already
 * there — quality, dispatch, the salesman, the competitor and the monthly
 * requirement. The other seven had nowhere to go.
 *
 * They went into `notes` for exactly one afternoon, as labelled lines, and
 * that is the bug this migration exists to undo rather than a shape anybody
 * shipped: "how many of last month's leads said price was the problem" is the
 * question §8 exists to answer, and `notes ilike '%price%'` is not an answer
 * to it. The branch that raised §8 had the same problem one level along — it
 * kept all twelve as a jsonb blob on a `lead_manager_calls` table of its own,
 * which is unqueryable in the same way and duplicated the table besides.
 *
 * Text rather than boolean on all seven, including the three that read like
 * yes/no questions. "He came, but only for five minutes" is the answer that
 * actually matters on the visit question, and a tick cannot hold it.
 *
 * Every one is nullable with no default. A verification call recorded before
 * today answered none of these, and null says that; a default would assert
 * something nobody asked.
 */

alter table "mbos_lead_validations" add column if not exists "salesman_visited" text;--> statement-breakpoint
alter table "mbos_lead_validations" add column if not exists "mahek_explained" text;--> statement-breakpoint
alter table "mbos_lead_validations" add column if not exists "product_understood" text;--> statement-breakpoint
alter table "mbos_lead_validations" add column if not exists "current_product" text;--> statement-breakpoint
alter table "mbos_lead_validations" add column if not exists "growth_potential" text;--> statement-breakpoint
alter table "mbos_lead_validations" add column if not exists "price_concern" text;--> statement-breakpoint
alter table "mbos_lead_validations" add column if not exists "genuine_interest" text;
