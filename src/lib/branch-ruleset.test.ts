// The ruleset on main names CI jobs as required checks by their job id. Rename
// a job in ci.yml and the ruleset goes on waiting for a check that will never
// report — every PR sits at "Expected — waiting for status" and nothing merges,
// with nothing anywhere saying why. This pins the two files to each other.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const ruleset = JSON.parse(readFileSync(join(root, ".github/rulesets/main.json"), "utf8"));
const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");

const jobsBlock = ci.slice(ci.indexOf("\njobs:\n"));
const jobIds = [...jobsBlock.matchAll(/^ {2}([a-z0-9_-]+):\s*$/gm)].map((m) => m[1]);

const required: string[] = ruleset.rules
  .find((r: { type: string }) => r.type === "required_status_checks")
  .parameters.required_status_checks.map((c: { context: string }) => c.context);

test("every required check is a job ci.yml actually runs", () => {
  for (const name of required) assert.ok(jobIds.includes(name), `ruleset requires "${name}", which ci.yml does not define`);
});

test("every CI job is required, so a new one cannot be merged past red", () => {
  for (const id of jobIds) assert.ok(required.includes(id), `ci.yml job "${id}" is not a required check in .github/rulesets/main.json`);
});

test("no CI job is skipped on a pull request, or a required check never reports", () => {
  assert.match(ci, /^\s{2}pull_request:\s*$/m);
  assert.doesNotMatch(jobsBlock, /^ {4}if:/m);
});

test("main cannot be deleted or force-pushed", () => {
  const types = ruleset.rules.map((r: { type: string }) => r.type);
  assert.ok(types.includes("deletion"));
  assert.ok(types.includes("non_fast_forward"));
  assert.ok(types.includes("pull_request"));
});
