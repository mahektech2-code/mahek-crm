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
  // The call assistant: learning from logged calls, reading with no model,
  // and the save writing back what the call was really logged as.
  "src/lib/call-intel.test.ts",
  "src/lib/accounts.test.ts",
  "src/lib/bill-paging.test.ts",
  "src/lib/feedback.test.ts",
  "src/lib/activity-location.test.ts",
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
  "src/lib/change-password.test.ts",
  "src/lib/otp.test.ts",
  "src/lib/either-identifier.test.ts",
  "src/lib/storage-fallback.test.ts",
  "src/lib/relationship-handover.test.ts",
  "src/lib/seat-mirrors.test.ts",
  "src/lib/place-master.test.ts",
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
