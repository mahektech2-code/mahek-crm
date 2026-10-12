/* ---------------------------------------------------------------------------
 * The checks an SFG lot's QC decision records, from the Testing list.
 *
 * The Testing list (ERP → Settings → Reference lists) is the company's own
 * list of tests, and its ACTIVE values are what QC is asked about: one Pass /
 * Fail answer per test, beside the note. Adding a test to the list puts it on
 * the next decision; switching one off takes it away — nothing here names a
 * test.
 *
 * The rule:
 *  - APPROVING needs every test answered, and every answer Pass. A lot that
 *    failed a test is rejected, not approved, and the refusal says which.
 *  - REJECTING records whatever was answered — a lot can fail on its first
 *    test and nobody runs the rest — and asks for nothing more.
 *
 * The answers are stored with the verdict keyed by the test's NAME, so a test
 * renamed or retired later still reads back as what was checked that day.
 *
 * PURE, so the prompt the screen draws and the rule the server enforces are
 * one function each, tested without a database.
 * ------------------------------------------------------------------------- */

export const TEST_RESULTS = ["Pass", "Fail"] as const;
export type TestResult = (typeof TEST_RESULTS)[number];
export type TestResults = Record<string, TestResult>;

/** The prompt field for one test. The key carries the test's name. */
export const testKey = (test: string) => `test:${test}`;

/** One Pass / Fail field per active test, required only when approving. */
export function qcTestFields(tests: string[], approving: boolean) {
  return tests.map((test) => ({
    k: testKey(test),
    l: test,
    t: "select" as const,
    opts: [...TEST_RESULTS],
    req: approving,
  }));
}

export type QcTestReading =
  | { ok: true; results: TestResults }
  | { ok: false; field: string; message: string };

/**
 * The answers a prompt sent, read against the tests asked about. Only a test
 * on the list counts — a value for anything else is ignored, so a crafted
 * post cannot record a check nobody was asked to make.
 */
export function readQcTests(tests: string[], values: Record<string, string | undefined>, approving: boolean): QcTestReading {
  const results: TestResults = {};
  for (const test of tests) {
    const raw = (values[testKey(test)] ?? "").trim();
    if (!raw) continue;
    if (raw !== "Pass" && raw !== "Fail") return { ok: false, field: testKey(test), message: `Choose Pass or Fail for ${test}` };
    results[test] = raw;
  }
  if (!approving) return { ok: true, results };
  const missing = tests.find((t) => !results[t]);
  if (missing) return { ok: false, field: testKey(missing), message: `Record the ${missing} result before approving` };
  const failed = tests.filter((t) => results[t] === "Fail");
  if (failed.length)
    return {
      ok: false,
      field: testKey(failed[0]),
      message: `${failed.join(", ")} failed — a lot that fails a test is rejected, not approved`,
    };
  return { ok: true, results };
}

/** The recorded checks in one line, for the record drawer. */
export function testResultsLine(results: TestResults | null | undefined): string | null {
  const entries = Object.entries(results ?? {});
  if (!entries.length) return null;
  return entries.map(([test, r]) => `${test}: ${r}`).join(" · ");
}

/** Every test answered Pass — what a seeded or scripted approval sends. */
export function allPassValues(tests: string[]): Record<string, string> {
  return Object.fromEntries(tests.map((t) => [testKey(t), "Pass"]));
}
