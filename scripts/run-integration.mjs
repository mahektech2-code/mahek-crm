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
  "src/lib/journeys.test.ts",
  "src/lib/accounts.test.ts",
  "src/lib/feedback.test.ts",
  "src/lib/activity-location.test.ts",
  "src/lib/outstanding-import.test.ts",
  "src/lib/performance.test.ts",
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
