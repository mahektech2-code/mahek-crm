// The ruleset on main names CI jobs as required checks by their job id. Rename
// a job in ci.yml and the ruleset goes on waiting for a check that will never
// report — every PR sits at "Expected — waiting for status" and nothing merges,
// with nothing anywhere saying why. This pins the two files to each other.
//
// A job does not have to be NAMED in the ruleset to be gated by it. A job that
// a required job `needs`, where that required job runs `if: always()`, is
// covered: when the dependency fails the required job still runs, sees it, and
// goes red. That is how the integration shards — a matrix, whose checks report
// as "integration (1/4)" and so can never be matched by a bare name — are held
// to the same standard as everything else. Without `always()` a failed
// dependency would SKIP the required job instead, and a skipped required check
// can read as passing, so that is the one condition a job may carry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const ruleset = JSON.parse(readFileSync(join(root, ".github/rulesets/main.json"), "utf8"));
const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8").replace(/\r\n/g, "\n");

const jobsBlock = ci.slice(ci.indexOf("\njobs:\n"));
const JOB_ID = /^ {2}([A-Za-z0-9_-]+):\s*$/gm;
const jobIds = [...jobsBlock.matchAll(JOB_ID)].map((m) => m[1]);

const required: string[] = ruleset.rules
  .find((r: { type: string }) => r.type === "required_status_checks")
  .parameters.required_status_checks.map((c: { context: string }) => c.context);

type Job = {
  id: string;
  needs: string[];
  condition: string | null;
  /** Everything after the id line except comment lines — what a result check has to be found in. */
  code: string;
  /** Every `continue-on-error:` value in the job, job-level or step-level. */
  continueOnError: string[];
};

/** The jobs of a workflow, with what each needs and its job-level `if:`. Step-level `if:` sits deeper and is not read. */
function parseJobs(workflow: string): Job[] {
  const block = workflow.slice(workflow.indexOf("\njobs:\n"));
  const headers = [...block.matchAll(JOB_ID)];
  return headers.map((h, i) => {
    const start = (h.index ?? 0) + h[0].length;
    const body = block.slice(start, headers[i + 1]?.index ?? block.length);
    const code = body
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    const continueOnError = [...code.matchAll(/^\s*(?:- )?continue-on-error:[ \t]*(.*?)[ \t]*$/gm)].map((m) =>
      m[1].replace(/[ \t]+#.*$/, ""),
    );

    const needs: string[] = [];
    const n = /^ {4}needs:[ \t]*(.*)$/m.exec(body);
    if (n) {
      const inline = n[1].replace(/#.*$/, "").trim();
      if (inline.startsWith("[")) {
        needs.push(
          ...inline
            .slice(1, inline.lastIndexOf("]"))
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        );
      } else if (inline) {
        needs.push(inline);
      } else {
        for (const line of body.slice((n.index ?? 0) + n[0].length).split("\n").slice(1)) {
          const item = /^ {6}- ([A-Za-z0-9_-]+)\s*(#.*)?$/.exec(line);
          if (item) needs.push(item[1]);
          else if (line.trim() === "" || /^\s*#/.test(line)) continue;
          else break;
        }
      }
    }

    const c = /^ {4}if:[ \t]*(.*?)[ \t]*$/m.exec(body);
    return { id: h[1], needs, condition: c ? c[1].replace(/[ \t]+#.*$/, "") : null, code, continueOnError };
  });
}

/**
 * Is a result reference actually used? A bare `RESULTS: ${{ needs.*.result }}`
 * under `env:` reads nothing until a script uses `$RESULTS`, so a reference of
 * that shape only counts when the variable is used on some other line.
 */
function isRead(code: string, pattern: RegExp): boolean {
  const lines = code.split("\n");
  return lines.some((line, i) => {
    if (!pattern.test(line)) return false;
    const env = /^\s*(?:- )?([A-Za-z_][A-Za-z0-9_]*):[ \t]*\$\{\{/.exec(line);
    if (!env) return true;
    const used = new RegExp(`\\$\\{?${env[1]}\\b|\\benv\\.${env[1]}\\b`);
    return lines.some((other, j) => j !== i && used.test(other));
  });
}

/**
 * A required job that gates others only gates them if it LOOKS at how they
 * ended. `if: always()` makes it run after a failure; it is the job's own
 * script that has to go red. A step that merely says `echo ok` would turn every
 * failed shard into a green required check, so each dependency's result — or
 * all of them at once, `needs.*.result` — has to be named somewhere in the job.
 * This cannot prove the comparison is right; it proves there is one to be wrong.
 */
function unchecked(workflow: string, requiredIds: string[]): string[] {
  const problems: string[] = [];
  for (const job of parseJobs(workflow)) {
    if (!requiredIds.includes(job.id) || job.needs.length === 0) continue;
    if (isRead(job.code, /needs\.\*\.result|toJSON\(\s*needs\s*\)/)) continue;
    const missing = job.needs.filter((n) => !isRead(job.code, new RegExp(`needs\\.${n}\\.result`)));
    if (missing.length > 0) {
      problems.push(
        `required job "${job.id}" needs ${missing.map((m) => `"${m}"`).join(", ")} but never reads ` +
          `${missing.length === 1 ? "its" : "their"} result (needs.<job>.result, or needs.*.result)`,
      );
    }
  }
  return problems;
}

/** Any `continue-on-error` that is not literally `false`: the job or step can fail and the check still goes green. */
function maskedFailures(workflow: string): string[] {
  return parseJobs(workflow).flatMap((j) =>
    j.continueOnError
      .filter((v) => v !== "false")
      .map((v) => `ci.yml job "${j.id}" has "continue-on-error: ${v}", so a failure there would not turn its check red`),
  );
}

/** Jobs nothing gates: neither required, nor needed by a required job that always reports. */
function ungated(workflow: string, requiredIds: string[]): string[] {
  const jobs = parseJobs(workflow);
  const problems: string[] = [];
  for (const job of jobs) {
    if (requiredIds.includes(job.id)) continue;
    const gates = jobs.filter((j) => requiredIds.includes(j.id) && j.needs.includes(job.id));
    if (gates.length === 0) {
      problems.push(`ci.yml job "${job.id}" is not a required check in .github/rulesets/main.json, and no required job needs it`);
    } else if (!gates.some((g) => g.condition === "always()")) {
      problems.push(
        `ci.yml job "${job.id}" is gated only by ${gates.map((g) => `"${g.id}"`).join(", ")}, which has no job-level "if: always()" — ` +
          `a failure here would skip it, and a skipped required check can read as passing`,
      );
    }
  }
  return problems;
}

/** Job-level conditions other than the one that cannot skip a job. */
function skippable(workflow: string): string[] {
  return parseJobs(workflow)
    .filter((j) => j.condition !== null && j.condition !== "always()")
    .map((j) => `ci.yml job "${j.id}" has "if: ${j.condition}"; the only job-level condition allowed is always()`);
}

test("every required check is a job ci.yml actually runs", () => {
  for (const name of required) assert.ok(jobIds.includes(name), `ruleset requires "${name}", which ci.yml does not define`);
});

test("every CI job is required, or gated by a required job that always reports, so a new one cannot be merged past red", () => {
  assert.deepEqual(ungated(ci, required), []);
});

test("no CI job is skipped on a pull request, or a required check never reports", () => {
  assert.match(ci, /^\s{2}pull_request:\s*$/m);
  // Not a blanket ban: `always()` is the opposite of a skip, and the aggregate
  // job needs it. Any other job-level condition could leave a required check
  // with nothing to report.
  assert.deepEqual(skippable(ci), []);
});

test("a required job that gates others reads how they ended", () => {
  assert.deepEqual(unchecked(ci, required), []);
});

test("no job or step can fail while its check goes green", () => {
  assert.deepEqual(maskedFailures(ci), []);
});

test("main cannot be deleted or force-pushed", () => {
  const types = ruleset.rules.map((r: { type: string }) => r.type);
  assert.ok(types.includes("deletion"));
  assert.ok(types.includes("non_fast_forward"));
  assert.ok(types.includes("pull_request"));
});

// ---------------------------------------------------------------------------
// The rules above are only worth having if they can fail. These run them over
// small workflows written to break each one.
// ---------------------------------------------------------------------------

const wf = (jobs: string) => `name: CI\non:\n  pull_request:\n\njobs:\n${jobs}`;

test("a job nothing requires and nothing required needs is reported", () => {
  const w = wf("  ci:\n    runs-on: x\n  orphan:\n    runs-on: x\n");
  assert.equal(ungated(w, ["ci"]).length, 1);
  assert.match(ungated(w, ["ci"])[0], /"orphan".*no required job needs it/);
});

test("a dependency of a required job that runs `if: always()` is covered — inline, list and single forms", () => {
  for (const needs of ["needs: [a, b]", "needs:\n      - a\n      - b", "needs: a"]) {
    const w = wf(`  a:\n    runs-on: x\n  b:\n    runs-on: x\n  ci:\n    ${needs}\n    if: always()\n    runs-on: x\n`);
    const covered = needs === "needs: a" ? ["b"] : [];
    assert.deepEqual(
      ungated(w, ["ci"]).map((p) => /"(\w+)"/.exec(p)?.[1]),
      covered,
      needs,
    );
  }
});

test("a dependency of a required job WITHOUT `if: always()` is not covered", () => {
  const w = wf("  a:\n    runs-on: x\n  ci:\n    needs: [a]\n    runs-on: x\n");
  assert.match(ungated(w, ["ci"])[0], /"a".*no job-level "if: always\(\)"/);
});

test("only `always()` is allowed as a job-level condition; step-level conditions are not job-level", () => {
  assert.deepEqual(skippable(wf("  ci:\n    if: always()\n    runs-on: x\n")), []);
  assert.deepEqual(skippable(wf("  ci:\n    if: always() # reports even when cancelled\n    runs-on: x\n")), []);
  assert.deepEqual(skippable(wf("  ci:\n    runs-on: x\n    steps:\n      - run: y\n        if: failure()\n")), []);
  for (const bad of ["github.event_name == 'push'", "${{ always() }}", "!cancelled()", "success()"]) {
    assert.equal(skippable(wf(`  ci:\n    if: ${bad}\n    runs-on: x\n`)).length, 1, bad);
  }
});

test("an aggregate that no longer reads its dependencies' results is rejected", () => {
  const aggregate = (step: string) =>
    wf(`  a:\n    runs-on: x\n  b:\n    runs-on: x\n  ci:\n    needs: [a, b]\n    if: always()\n    runs-on: x\n    steps:\n${step}`);
  // The regression: the check replaced by something that always succeeds.
  assert.equal(unchecked(aggregate("      - run: echo ok\n"), ["ci"]).length, 1);
  // A mention in a comment is not a check.
  assert.equal(unchecked(aggregate("      # needs.a.result needs.b.result\n      - run: echo ok\n"), ["ci"]).length, 1);
  // Reading only some of them leaves the others unwatched.
  assert.match(unchecked(aggregate("      - run: test ${{ needs.a.result }} = success\n"), ["ci"])[0], /"b"/);
  // Each way of actually reading them.
  assert.deepEqual(unchecked(aggregate("      - run: echo ${{ join(needs.*.result, ' ') }}\n"), ["ci"]), []);
  assert.deepEqual(unchecked(aggregate("      - run: echo '${{ toJSON(needs) }}'\n"), ["ci"]), []);
  assert.deepEqual(
    unchecked(aggregate("      - run: test ${{ needs.a.result }} = success && test ${{ needs.b.result }} = success\n"), ["ci"]),
    [],
  );
  // Bound to an env var that nothing then uses: still reads nothing.
  const viaEnv = (run: string) =>
    wf(
      "  a:\n    runs-on: x\n  ci:\n    needs: [a]\n    if: always()\n    runs-on: x\n    steps:\n" +
        "      - env:\n          R: ${{ join(needs.*.result, ' ') }}\n        run: " +
        run +
        "\n",
    );
  assert.equal(unchecked(viaEnv("echo ok"), ["ci"]).length, 1);
  assert.deepEqual(unchecked(viaEnv('test "$R" = success'), ["ci"]), []);
  assert.deepEqual(unchecked(viaEnv('echo "${R}"'), ["ci"]), []);
  // A required job with nothing to gate has nothing to read.
  assert.deepEqual(unchecked(wf("  ci:\n    runs-on: x\n"), ["ci"]), []);
});

test("uppercase and mixed-case job ids are seen, not skipped", () => {
  const w = wf("  ci:\n    needs: [Lint]\n    if: always()\n    runs-on: x\n  Lint:\n    runs-on: x\n  Extra:\n    runs-on: x\n");
  assert.deepEqual(
    parseJobs(w).map((j) => j.id),
    ["ci", "Lint", "Extra"],
  );
  const problems = ungated(w, ["ci"]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /"Extra"/);
  const list = wf("  ci:\n    needs:\n      - Lint\n    if: always()\n    runs-on: x\n  Lint:\n    runs-on: x\n");
  assert.deepEqual(parseJobs(list)[0].needs, ["Lint"]);
});

test("continue-on-error, on a job or a step, is rejected unless it is literally false", () => {
  assert.deepEqual(maskedFailures(wf("  ci:\n    runs-on: x\n")), []);
  assert.deepEqual(maskedFailures(wf("  ci:\n    continue-on-error: false\n    runs-on: x\n")), []);
  // Only a comment mentioning it.
  assert.deepEqual(maskedFailures(wf("  ci:\n    runs-on: x\n    # continue-on-error: true\n")), []);
  for (const bad of [
    "  ci:\n    continue-on-error: true\n    runs-on: x\n",
    "  ci:\n    continue-on-error: ${{ matrix.experimental }}\n    runs-on: x\n",
    "  ci:\n    runs-on: x\n    steps:\n      - run: y\n        continue-on-error: true\n",
    "  ci:\n    runs-on: x\n    steps:\n      - continue-on-error: true\n        run: y\n",
  ]) {
    assert.equal(maskedFailures(wf(bad)).length, 1, bad);
  }
});
