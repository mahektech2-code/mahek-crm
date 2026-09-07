#!/usr/bin/env node
/* ---------------------------------------------------------------------------
 * Copy the engines the handset has to agree with, byte for byte.
 *
 * The expense engine is the one piece of arithmetic that runs in two places:
 * on the phone, so a salesman in a market with no signal is told what his day
 * is worth, and on the server, which pays it. Two hand-written copies of that
 * is the worst drift available in this product — the half that drifts is the
 * half somebody read out loud and is now arguing about.
 *
 * So there is one source and a mechanical copy, and `shared-engines.test.ts`
 * in both projects fails the build if the copy is stale. Editing the generated
 * file is pointless: the next run overwrites it and the test fails until it
 * does.
 *
 * These files import nothing. That is a requirement of being shared, not a
 * coincidence — the handset has no `@/lib`, no `server-only` and no database,
 * so an engine that reaches for one of them cannot cross.
 * ------------------------------------------------------------------------- */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const SHARED_ENGINES = ["expense-policy.ts", "travel-distance.ts"];

const FROM = join(root, "src", "lib", "engines");
const TO = join(root, "mbos-app", "src", "engines", "generated");

export function header(name) {
  return [
    "/* GENERATED FILE — DO NOT EDIT.",
    ` * Copied from src/lib/engines/${name} by scripts/sync-mbos-engines.mjs.`,
    " * Edit the source and run `npm run mbos:sync-engines`. A stale copy fails",
    " * the test suite in both projects, which is the point: the handset and the",
    " * office must never disagree about what a day is worth.",
    " */",
    "",
  ].join("\n");
}

export function expected(name) {
  return header(name) + readFileSync(join(FROM, name), "utf8");
}

export function generatedPath(name) {
  return join(TO, name);
}

function main() {
  mkdirSync(TO, { recursive: true });
  let changed = 0;
  for (const name of SHARED_ENGINES) {
    const want = expected(name);
    const path = generatedPath(name);
    let have = null;
    try {
      have = readFileSync(path, "utf8");
    } catch {
      /* not there yet */
    }
    if (have !== want) {
      writeFileSync(path, want);
      changed++;
      console.log(`wrote ${name}`);
    } else {
      console.log(`${name} already current`);
    }
  }

  /* A file in the generated folder that no longer has a source is a copy of
     something that has been deleted or renamed, and it will go on being
     imported by whatever imported it. Name it rather than leave it. */
  const orphans = readdirSync(TO).filter((f) => !SHARED_ENGINES.includes(f));
  if (orphans.length) {
    console.error(`\nOrphaned generated files with no source: ${orphans.join(", ")}`);
    console.error("Delete them, or add them to SHARED_ENGINES.");
    process.exitCode = 1;
  }

  console.log(changed ? `\n${changed} file(s) updated.` : "\nNothing to do.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
