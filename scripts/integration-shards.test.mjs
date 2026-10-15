/**
 * Pins how the integration suite is divided. Pure — it reads the runner's file
 * list as text and never touches a database, so it is safe to run anywhere.
 *
 * node --test scripts/integration-shards.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  WEIGHTS,
  assignShards,
  filesForShard,
  parseShard,
  shardFromArgv,
} from "./integration-shards.mjs";

const RUNNER = new URL("./run-integration.mjs", import.meta.url);

/** The runner's own list, read the way a person reads it: one quoted path per line. */
function runnerFiles() {
  const text = readFileSync(RUNNER, "utf8");
  return [...text.matchAll(/^\s*"(src\/[^"\n]+\.test\.ts)",\s*$/gm)].map((m) => m[1]);
}

test("the runner's list is found, and has no repeats", () => {
  const files = runnerFiles();
  assert.ok(files.length > 50, `only ${files.length} files parsed — the runner's layout changed`);
  assert.equal(new Set(files).size, files.length);
});

for (const count of [1, 2, 3, 4, 5, 7, 200]) {
  test(`every real file is in exactly one of ${count} shards`, () => {
    const files = runnerFiles();
    const seen = new Map();
    for (let index = 1; index <= count; index++) {
      for (const f of filesForShard(files, { index, count })) {
        assert.ok(!seen.has(f), `${f} is in shard ${seen.get(f)} and shard ${index}`);
        seen.set(f, index);
      }
    }
    assert.deepEqual([...seen.keys()].sort(), [...files].sort());
  });
}

test("assignment depends only on the list: same input, same shards", () => {
  const files = runnerFiles();
  assert.deepEqual(assignShards(files, 4), assignShards(files, 4));
  // The order the list is written in does not move a file between shards.
  const reversed = [...files].reverse();
  const a = assignShards(files, 4).map((g) => [...g.files].sort());
  const b = assignShards(reversed, 4).map((g) => [...g.files].sort());
  assert.deepEqual(a, b);
});

test("a shard keeps the runner's own order", () => {
  const files = runnerFiles();
  const at = new Map(files.map((f, i) => [f, i]));
  for (const g of assignShards(files, 4)) {
    const idx = g.files.map((f) => at.get(f));
    assert.deepEqual(idx, [...idx].sort((x, y) => x - y));
  }
});

test("four shards are reasonably balanced on the known durations", () => {
  const files = runnerFiles().filter((f) => f in WEIGHTS);
  const loads = assignShards(files, 4).map((g) => g.load);
  const longest = Math.max(...files.map((f) => WEIGHTS[f]));
  // The slowest file is a floor nobody can shard away; beyond it the heaviest
  // shard may not be more than 15% over the mean of the rest.
  assert.ok(Math.max(...loads) <= Math.max(longest, (loads.reduce((a, b) => a + b, 0) / 4) * 1.15));
});

test("files with no recorded duration are still assigned", () => {
  const files = ["a.test.ts", "b.test.ts", "c.test.ts"];
  const groups = assignShards(files, 2, {});
  assert.deepEqual(groups.flatMap((g) => g.files).sort(), files);
});

test("a repeated file is refused rather than quietly run once", () => {
  assert.throws(() => assignShards(["a", "b", "a"], 2), /more than once/);
});

test("more shards than files leaves empty shards, not lost files", () => {
  const groups = assignShards(["a", "b"], 5, {});
  assert.equal(groups.length, 5);
  assert.deepEqual(groups.flatMap((g) => g.files).sort(), ["a", "b"]);
});

test("--shard parsing: both spellings, and absence means unsharded", () => {
  assert.equal(shardFromArgv([]), null);
  assert.deepEqual(shardFromArgv(["--shard", "2/4"]), { index: 2, count: 4 });
  assert.deepEqual(shardFromArgv(["--shard=3/3"]), { index: 3, count: 3 });
  assert.deepEqual(parseShard(" 1/1 "), { index: 1, count: 1 });
});

test("invalid --shard arguments are refused with a reason", () => {
  for (const bad of [
    ["--shard"],
    ["--shard", "--other"],
    ["--shard", "0/4"],
    ["--shard", "5/4"],
    ["--shard", "1/0"],
    ["--shard", "-1/4"],
    ["--shard", "a/b"],
    ["--shard", "2"],
    ["--shard", "1.5/4"],
    ["--shard", "1/4/8"],
    ["--shard=2/4", "--shard=3/4"],
    ["--sharde", "1/4"],
    ["extra"],
  ]) {
    assert.throws(() => shardFromArgv(bad), Error, `accepted ${JSON.stringify(bad)}`);
  }
});

test("unsharded mode: one shard of one is the whole list, in order", () => {
  const files = runnerFiles();
  assert.deepEqual(filesForShard(files, { index: 1, count: 1 }), files);
  // And the runner, given no flag, selects `files` itself rather than a copy.
  const text = readFileSync(RUNNER, "utf8");
  assert.match(text, /const selected = shard \? filesForShard\(files, shard\) : files;/);
});

test("the runner exits 2 on a bad shard before touching any database", () => {
  const r = spawnSync(
    process.execPath,
    [RUNNER.pathname.replace(/^\/([A-Za-z]:)/, "$1"), "--shard", "9/4"],
    {
      encoding: "utf8",
      // A URL that would fail loudly if anything connected to it.
      env: { ...process.env, DATABASE_URL: "postgresql://nobody:x@127.0.0.1:1/never" },
    },
  );
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /Invalid shard "9\/4"/);
});
