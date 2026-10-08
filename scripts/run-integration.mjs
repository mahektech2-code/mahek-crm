/**
 * Runs the journey tests against mahekone_test, never against the database the
 * developer is looking at. Node's test runner is invoked directly so there is
 * no test framework to install.
 */
import { execFileSync } from "node:child_process";

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
  // A lead is raised inside the salesman's own area, and lands there.
  "src/lib/lead-territory.test.ts",
  // Editing a field order before approval, and asking to change it after.
  "src/lib/order-change.test.ts",
  // The ERP: access, powers, working location and the masters.
  "src/lib/erp/erp-foundation.test.ts",
  "src/lib/erp/erp-designations.test.ts",
  "src/lib/erp/erp-purchase.test.ts",
  // Purchase and production, department by department.
  "src/lib/erp/erp-departments.test.ts",
  "src/lib/erp/erp-production.test.ts",
  "src/lib/erp/erp-sales.test.ts",
  "src/lib/erp/erp-logistics.test.ts",
  "src/lib/erp/erp-book.test.ts",
  "src/lib/erp/erp-ai.test.ts",
  "src/lib/erp/erp-ai-reading.test.ts",
  // The HRMS restructure: tabs open with their screen, a head reaches their
  // team and office only, and the audit's fixes hold.
  "src/lib/hrms/integration/restructure.test.ts",
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
  "src/lib/bill-paging.test.ts",
  // A call's own reminder is folded onto the call in the All view.
  "src/lib/timeline-fold.test.ts",
  "src/lib/feedback.test.ts",
  "src/lib/activity-location.test.ts",
  "src/lib/salesman-day.test.ts",
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
  "src/lib/change-password.test.ts",
  "src/lib/otp.test.ts",
  "src/lib/either-identifier.test.ts",
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
  // The telecaller's calling desk itself: three calls, Ready for Prospect, and
  // that asking for a Prospect is not being one.
  "src/lib/lead-calling-desk.test.ts",
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

let failed = 0;
for (const file of files) {
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
  console.error(`${failed} of ${files.length} integration suites failed.`);
  process.exit(1);
}
