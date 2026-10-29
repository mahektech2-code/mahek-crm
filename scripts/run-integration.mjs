/**
 * Runs the journey tests against mahekone_test, never against the database the
 * developer is looking at. Node's test runner is invoked directly so there is
 * no test framework to install.
 */
import { execFileSync } from "node:child_process";
import { filesForShard, shardFromArgv } from "./integration-shards.mjs";

process.env.NODE_ENV = "test";

const dev = process.env.DATABASE_URL;
if (!dev) {
  console.error("DATABASE_URL is not set — copy .env.example to .env.local first.");
  process.exit(1);
}
const testUrl = dev.replace(/\/[^/?]+(\?|$)/, "/mahekone_test$1");

/*
 * ONE FILE PER PROCESS, one after the other.
 *
 * There is one database, and every suite truncates the same tables in its
 * `before` hook. Two of them overlapping is not a test failure anybody can
 * read: it comes out as `duplicate key value violates unique constraint
 * "users_email_key"`, deadlocks, and a different number of failures on every
 * run — 103, 126, 139 passing out of 242, from a suite where each file on its
 * own is green.
 *
 * This used to be one invocation with `--test-concurrency=1` and the same
 * intent written in a comment. The flag did not survive the trip: passed after
 * `--test` through `tsx`, it reached the script rather than Node, so the
 * runner went on parallelising files while the comment said it did not. A loop
 * cannot be misread by an argument parser.
 *
 * Every file is run even after one fails, because "journeys failed" and
 * "journeys and accounts both failed" are different sizes of problem and
 * stopping at the first hides which one you have.
 */
const files = [
  /* FIRST, because it is the cheapest and it explains the others. A table whose
     declared columns are not in the database takes down every test that touches
     it with "column … does not exist", and eleven journey failures is a worse
     place to start reading than one sentence naming the table. */
  "src/lib/mbos-columns.test.ts",
  "src/lib/journeys.test.ts",
  "src/lib/crm-accounts-impact.test.ts",
  // Adding a customer from Accounts, and it reaching every app on its own.
  "src/lib/customer-create.test.ts",
  // A lead is raised inside the salesman's own area, and lands there.
  "src/lib/lead-territory.test.ts",
  "src/lib/lead-scope.test.ts",
  // Editing a field order before approval, and asking to change it after.
  "src/lib/order-change.test.ts",
  // The ERP: access, powers, working location and the masters.
  "src/lib/erp/erp-foundation.test.ts",
  "src/lib/erp/erp-designations.test.ts",
  "src/lib/erp/erp-purchase.test.ts",
  // Inventory Accuracy Control: a requirement waits for a blind count; a red
  // flag is recounted by somebody else; stock moves only through an approved
  // adjustment; missing records and the daily cycle count.
  "src/lib/erp/erp-stock-check.test.ts",
  // Stock adjusted by hand from its row, and the stock inquiry.
  "src/lib/erp/erp-stock-adjust.test.ts",
  // Empty drums, scrap sale and vendor-returnable drums: the PRD's acceptance
  // tests — FIFO allocation, strict separation, receivables matched from
  // Petty Cash/Bank, corrections approved by somebody else.
  "src/lib/erp/erp-scrap.test.ts",
  "src/lib/erp/erp-returns.test.ts",
  // Can photos and look-alike can groups: grouping by name never moves a can
  // somebody placed, photos are capped and taken off without deleting.
  "src/lib/erp/erp-can-groups.test.ts",
  // Purchase and production, department by department.
  "src/lib/erp/erp-departments.test.ts",
  "src/lib/erp/erp-production.test.ts",
  // The factory floor app: one key posts once, stock refuses at the step,
  // full packing batches only, loading checked but never dispatched.
  "src/lib/factory/factory.test.ts",
  // SFG QC → refill → box ids → the dispatch desk's scan, override and
  // Do Verified → tracing a box, a lot and an order both ways.
  "src/lib/erp/erp-traceability.test.ts",
  "src/lib/erp/erp-sales.test.ts",
  "src/lib/erp/erp-logistics.test.ts",
  // Customer order tracking: one link per order, every step recorded once, holds, documents, messages.
  "src/lib/erp/erp-order-tracking.test.ts",
  "src/lib/erp/erp-money.test.ts",
  // Accounts → Bank statement management: upload, import only what is new,
  // match each line to what explains it, and the PDF's seven days.
  "src/lib/bank-statements.test.ts",
  "src/lib/erp/erp-book.test.ts",
  "src/lib/erp/erp-scale.test.ts",
  "src/lib/erp/erp-ai.test.ts",
  "src/lib/erp/erp-ai-reading.test.ts",
  // The HRMS restructure: tabs open with their screen, a head reaches their
  // team and office only, and the audit's fixes hold.
  "src/lib/hrms/integration/restructure.test.ts",
  // Every HRMS delete says what it takes with it, is refused bare, and does
  // what its report said once confirmed.
  "src/lib/hrms/integration/impact.test.ts",
  // Hire: identity is the phone, gating is enforced, an override is a named
  // act, an interviewer's scope is narrow, and the record is append-only.
  "src/lib/hire/integration/core.test.ts",
  // The call assistant: learning from logged calls, reading with no model,
  // and the save writing back what the call was really logged as.
  "src/lib/call-intel.test.ts",
  // "They called us", completed: the opportunity answer and its worklist, next
  // actions handed to the people they belong to, the ERP/ledger snapshot read
  // by the server, and the history drawing what a call recorded.
  "src/lib/they-called-us.test.ts",
  // The visit assistant: scope, no model, the switch, and the visit writing
  // back what it was really saved as.
  "src/lib/visit-intel.test.ts",
  // A task with a form: assigned on the dashboard, answered on the handset,
  // and every salesman's answers read back side by side.
  "src/lib/task-campaigns.test.ts",
  "src/lib/accounts.test.ts",
  // Vendor payouts: the purchase register as payouts, payment days, invoices.
  "src/lib/vendor-payouts.test.ts",
  // The Website CMS: what is saved stays saved, publishing is atomic and honest about the live site, and the server refuses who may not.
  "src/lib/website-cms/website-cms.test.ts",
  // The review workflow's tables: what the migration itself enforces, whatever code writes the row.
  "src/lib/website-cms/review-schema.test.ts",
  // The review workflow itself, called as people with different grants: who may assign, edit, submit, decide and publish, and what an approval covers.
  "src/lib/website-cms/review-workflow.test.ts",
  // What the Website screens SHOW: where assignments are enforced, an editor's lists, counts and entry points are their own work and nobody else's.
  "src/lib/website-cms/review-visibility.test.ts",
  // Who is TOLD what: each step's recipient, wording and link, that nobody else is told, that a broken bell changes nothing, and the launcher tile and hourly sweep.
  "src/lib/website-cms/review-notifications.test.ts",
  "src/lib/bill-paging.test.ts",
  // A call's own reminder is folded onto the call in the All view.
  "src/lib/timeline-fold.test.ts",
  "src/lib/feedback.test.ts",
  // The bell, one app at a time: the SQL and the browser agree on the app.
  "src/lib/notification-apps.db.test.ts",
  // A field document tagged to named salesmen: who gets it, who loses it, and
  // the file past a megabyte that the old server-action upload refused.
  "src/lib/document-tagging.test.ts",
  "src/lib/activity-location.test.ts",
  "src/lib/salesman-day.test.ts",
  // Activity history: MBOS visits are the record, the old app's sheet its past.
  "src/lib/activity-history.test.ts",
  // The server's end-of-day punch-out reminder: found, claimed, sent once.
  "src/lib/punch-out-reminders.test.ts",
  "src/lib/positions-endpoint.test.ts",
  "src/lib/field-book.test.ts",
  "src/lib/leads-list.test.ts",
  "src/lib/outstanding-import.test.ts",
  "src/lib/monthly-targets.test.ts",
  "src/lib/performance.test.ts",
  "src/lib/owner-dashboard.test.ts",
  "src/lib/founder-dashboard.test.ts",
  "src/lib/expense-policy.test.ts",
  "src/lib/travel-on-visit.test.ts",
  // An expense and every file behind it: several per claim, one that uploaded
  // before the claim existed, who can open them, and the Decide dialog's read.
  "src/lib/expense-attachments.test.ts",
  "src/lib/day-evidence.test.ts",
  "src/lib/check-in-gate.test.ts",
  "src/lib/credential-issue.test.ts",
  "src/lib/whatsapp-api.test.ts",
  "src/lib/whatsapp-automation.test.ts",
  "src/lib/wati-backfill.test.ts",
  "src/lib/lead-trash.test.ts",
  "src/lib/lead-twins.test.ts",
  "src/lib/change-password.test.ts",
  "src/lib/otp.test.ts",
  "src/lib/either-identifier.test.ts",
  "src/lib/website-access-save.test.ts",
  "src/lib/access-candidates.test.ts",
  "src/lib/storage-fallback.test.ts",
  "src/lib/relationship-handover.test.ts",
  "src/lib/seat-mirrors.test.ts",
  // The people at a customer: the list and the columns it mirrors cannot
  // disagree, a column written directly is folded in, and the full edit form.
  "src/lib/customer-contacts.integration.test.ts",
  "src/lib/place-master.test.ts",
  "src/lib/place-tree-filters.test.ts",
  "src/lib/territory-requests.test.ts",
  // Who a holiday reaches — company, state, city, named — on the right phones.
  "src/lib/holidays.test.ts",
  // Price lists: the engines are pure and the reader is pinned against the
  // four real documents, so what is left for a database is publishing,
  // superseding, the hierarchy through the real service, and the refusal.
  "src/lib/price-lists.integration.test.ts",
  // Lists made here rather than read in: the editor's sheet becomes exactly
  // its rates, publishing stores the PDF read back cell by cell, and the
  // price desk is Accounts and the Founder Dashboard — not a sales manager.
  "src/lib/price-sheets.integration.test.ts",
  "src/lib/sample-logistics.test.ts",
  "src/lib/enquiries.test.ts",
  // A website enquiry becomes a lead by hand, through the one writer, and only
  // the people granted the calling desk can work it: the four forms that may,
  // the atomic link, assignment and who sees an unowned lead, and the
  // migration that keeps the desk from reaching every existing CRM user.
  "src/lib/lead-from-enquiry.test.ts",
  // Change owner: everybody listed, Unassigned a real choice, the desk rule unchanged.
  "src/lib/lead-owner-choices.test.ts",
  // The telecaller's calling desk itself: three calls, Ready for Prospect, and
  // that asking for a Prospect is not being one.
  "src/lib/lead-calling-desk.test.ts",
  "src/lib/lead-prospect-conversion.test.ts",
  // The calling desk's voice assistant: that it writes only a draft, refuses
  // outside its scope before reading anything, and that Call 1/2/3 voice
  // proposals save and narrow through the unmodified existing path.
  "src/lib/lead-call-intel.test.ts",
  // The lead intake form's voice assistant: that it only reads, refuses outside
  // its permission and module before reading anything, and that the form's own
  // captureLead is still the only way a lead is made.
  "src/lib/intake-intel.test.ts",
  // The Manager verification dialog's voice assistant: that it reads and writes
  // one audit draft only, belongs to the CRM Sales Manager workspace, asks lead.verify
  // before reading, and that verifyProspect is still the only way a lead is verified.
  "src/lib/verify-intel.test.ts",
  // The Convert to Prospect dialog's voice assistant: that it reads and writes one audit
  // draft only, belongs to the CRM Sales Manager workspace, asks lead.work before reading,
  // never replaces a value the salesman entered, and that convertProspect is still the only
  // writer of the converted values.
  "src/lib/convert-intel.test.ts",
  // Lead Management → Lost: the module gate, the list narrowed by the same
  // scope every other lead list runs through, stage-at-loss read off the
  // closing transition rather than guessed, and the next-action/nurture-task
  // cleanup touching only the lead and the tasks it is actually about.
  "src/lib/lead-lost.test.ts",
  // Resuming a PARKED lead: judged from the rung the park came from rather than
  // from a rung `on_hold` does not have — with the target's gate, §24 and the
  // manager rules for stepping backwards all still applying, from the console
  // and from the handset.
  "src/lib/lead-resume-hold.test.ts",
  // The four worklists that left the navigation as screens and live on as VIEWS
  // of the lead list — suspect decisions, on hold, nobody working these,
  // handovers: each one definition, the count on the desk line equal to the list
  // it opens, parity with the old readers, and the sales-seat scope for handovers.
  "src/lib/lead-worklist-views.test.ts",
  // Reversing a Lost lead, from the Sales Manager's door and the Telecaller's,
  // over one shared implementation: the same row and id, the loss kept in the
  // history, a failed verification asked again, a lead lost at Call 3 callable
  // again with every call kept, one reopen from two simultaneous requests, and
  // the ladder's gates still applying to what comes back.
  "src/lib/lead-reopen.test.ts",
  // All Leads → Change stage → Lost: the reason the modal now sends, validated
  // by the server, a mixed batch reported by name, and a bulk loss reversed by
  // the existing reopen with its history intact.
  "src/lib/lead-bulk-lost.test.ts",
  // All Leads -> Change stage -> On hold: the answers a park demands, per-lead owners, ended leads refused.
  "src/lib/lead-bulk-hold.test.ts",
  // A lead still at the old new/contacted stage moves to Suspect once it has a
  // funnel sales type; every other off-ladder move is still refused.
  "src/lib/lead-move-to-suspect.test.ts",
  // The Telecaller-owned Qualification workflow, Prospect to Sample/Trial.
  "src/lib/telecaller-qualification.test.ts",
  // Intake: what they want, in words or from the catalogue — and never the Calling Desk Product answer.
  "src/lib/lead-intake-product.test.ts",
  "src/lib/lead-source-scope.test.ts",
  // A fresh CRM/Sales grant made through the CLI, the provisioning endpoint
  // or the back-office bulk provision must not carry an offByDefault module
  // (the calling desk, the Sales Manager seat) along for free — and an
  // administrator's automatic reach into the desk must survive that fix.
  "src/lib/services/app-provisioning.test.ts",
  // The Sales Manager lead pipeline: reads counted in SQL, every mutation
  // persisted, the distributor track, and authorisation — including the one
  // place read scope and write scope disagree, pinned rather than fixed.
  "src/lib/sales-manager-pipeline.test.ts",
  // The same screens mounted in the CRM: one scope (sales_manager_id) for what
  // is drawn and for what may be done to it, admin sees all, owner-only and
  // unassigned leads are nobody's, and no other screen's scope moved.
  "src/lib/crm-sales-manager.test.ts",
  // Verification follows lead.sales_manager_id: the seat holder verifies, at any CRM level.
  "src/lib/lead-verifier-seat.test.ts",
  // Qualification: the Salesman collects, the Sales Manager validates GST and reviews.
  "src/lib/qualification-flow.test.ts",
  // A lead the Sales Manager raised herself is approved by the person Mahek designates.
  "src/lib/self-raised-approver.test.ts",
  // Who verifies a Prospect on each of the three workflows, kept apart: a Telecaller's lead,
  // a Sales Manager's own, and everything a salesman or a seat already routes.
  "src/lib/telecaller-verifier-routing.test.ts",
  // The third verifier: a lead a Salesman raised or holds goes to the person
  // `leads.fieldVerifierEmail` names, by the seat the Sales Manager already has.
  "src/lib/field-verifier-routing.test.ts",
  // Editing a SKU end to end: a rename keeps the old name as an alias and survives a re-import; the ERP packing row.
  "src/lib/catalogue-edit.test.ts",
  // Turning a sign-in off and clearing a saved key, through the impact modal: refused until confirmed, and the report names what moves.
  "src/lib/impact/admin-removals.test.ts",
  // Saving where a salesman works can hand him the shops in those places — only the count shown, only with customer.reassign.
  "src/lib/area-handover.test.ts",
  "src/lib/org-chart-verifier-routing.test.ts",
  // A lead still at the legacy `new` / `contacted` stage converts to Prospect once the desk
  // gives it a sales type: it is relabelled as the Suspect it is, not refused as off-ladder.
  "src/lib/convert-legacy-stage.test.ts",
  // A lead's owner is respected: a Sales Manager's lead is not a Telecaller's.
  "src/lib/lead-owner-visibility.test.ts",
  "src/lib/sales-manager-desk-queues.test.ts",
  // The dashboard reads its four figures from `queueProgress`, which must stay
  // exactly equal to what `getQueue` would have said. That equivalence is only
  // checkable against a real book, so it lives here rather than in the pure set.
  "src/lib/queue-progress.test.ts",
  // The queue ranks calls by a cached median now. If the cache and the
  // subquery it replaced ever disagree, the calling list silently reorders.
  "src/lib/typical-order-cache.test.ts",
  // The sheet projection and the cycle recompute run together every thirty
  // minutes. That a pass over an unchanged book writes no tuple is only
  // checkable against a real database — `xmin` is the witness — so it lives
  // here, and it will regress silently the moment anything stops comparing.
  "src/lib/projection-idempotence.test.ts",
  // The same question one layer up, in the SYNC rather than the projection:
  // re-reading an unchanged tab must write no staging row. It also pins the
  // three things a difference-based withdrawal could break — a real change
  // landing, a row that left being marked, and a row the sheet takes back.
  "src/lib/staging-idempotence.test.ts",
  // Raw SQL returns bigint and numeric as NUMBERS (src/db/index.ts), and an
  // account is one payroll row: the two bugs behind a Cost and return screen
  // that concatenated salaries and listed one salesman twice.
  "src/lib/numbers-from-sql.test.ts",
  // WhatsApp's Read level is refused by the actions, from either app, and a
  // grant made before the level existed is still Write.
  "src/lib/whatsapp-read-write.test.ts",
];

/*
 * `--shard i/N` runs one balanced slice of the list above — see
 * integration-shards.mjs. Each shard is its own CI job with its own database,
 * and within it the files still run one after the other. Without the flag
 * every file runs, exactly as before.
 */
let shard = null;
try {
  shard = shardFromArgv(process.argv.slice(2));
} catch (e) {
  console.error(`${e.message}
Usage: run-integration.mjs [--shard i/N]`);
  process.exit(2);
}
const selected = shard ? filesForShard(files, shard) : files;
if (shard) {
  console.log(`Shard ${shard.index}/${shard.count}: ${selected.length} of ${files.length} suites.`);
}

let failed = 0;
for (const file of selected) {
  try {
    execFileSync("npx", ["tsx", "--conditions=react-server", "--test", file], {
      stdio: "inherit",
      env: { ...process.env, NODE_ENV: "test", DATABASE_URL: testUrl },
    });
  } catch {
    failed++;
    console.error(`\n--- ${file} FAILED ---\n`);
  }
}

if (failed) {
  console.error(`${failed} of ${selected.length} integration suites failed.`);
  process.exit(1);
}
