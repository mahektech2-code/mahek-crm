import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/* ---------------------------------------------------------------------------
 * THE NAMES IN `.env.production.example` ARE THE NAMES THE CODE READS.
 *
 * This exists because of a specific failure, and because of what that failure
 * looked like. The example file was written from memory and said
 * GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY; the code reads
 * GOOGLE_SA_EMAIL and GOOGLE_SA_PRIVATE_KEY. It also promised a single
 * SHEET_ID where there are four sheet ids and four tab names.
 *
 * A WRONG ENV NAME IN THIS APP DOES NOT ERROR. It makes a feature go quiet:
 * the microphone stops being drawn, the sheet sync answers "not configured",
 * password reset writes mail to the log. Every one of those reads as a
 * deliberate state rather than a typo, which is why nobody finds it by using
 * the app — and why the only thing that can find it is a test.
 *
 * Pure: it reads files off disk and compares two lists. No database, no
 * network, and it runs with the engine tests in milliseconds.
 * ------------------------------------------------------------------------- */

const ROOT = new URL("../..", import.meta.url).pathname;

/** Every `process.env.NAME` under src/ and scripts/. */
function referencedNames(): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(ts|tsx|mjs|js)$/.test(entry)) continue;
      // Tests are not the deployment. This file in particular contains the
      // string `process.env.` inside its own regex, and would otherwise
      // report a variable called NAME as undocumented.
      if (/\.test\.(ts|tsx|mjs|js)$/.test(entry)) continue;
      const text = readFileSync(path, "utf8");
      for (const m of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
        if (!found.has(m[1])) found.set(m[1], path.slice(ROOT.length));
      }
    }
  };
  walk(join(ROOT, "src"));
  walk(join(ROOT, "scripts"));
  return found;
}

/** Every key in the example file, including the ones commented out. */
function documentedNames(): Set<string> {
  const text = readFileSync(join(ROOT, ".env.production.example"), "utf8");
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    // `# BLOB_READ_WRITE_TOKEN=` counts: it is documented as optional, which is
    // a decision somebody made, not an omission.
    const m = line.match(/^#?\s*([A-Z0-9_]+)=/);
    if (m) names.add(m[1]);
  }
  return names;
}

/**
 * Names the production file deliberately does NOT carry, each with the reason.
 * A bare exemption list rots; one that has to say why gets read when it is
 * added to.
 */
const NOT_IN_PRODUCTION_ENV: Record<string, string> = {
  // Composed by docker-compose from POSTGRES_PASSWORD, so the deployment never
  // spells it out and a copy here would be a second definition to keep in step.
  DATABASE_URL: "built by docker-compose from POSTGRES_PASSWORD",
  // Set by Node and by the runtime, never by us.
  NODE_ENV: "set by the runtime",
  // Developer machines only: two scripts resolve a path under ~.
  HOME: "developer machines only — scripts/parse-catalogue.mjs, apply-receivables.ts",
  // The link crawler's target, which is localhost in CI and a laptop in dev.
  BASE_URL: "scripts/check-links.mjs only, defaults to localhost:3000",
  // The field app's older name for MBOS_JWT_SECRET, kept as a fallback for
  // deployments that still set it. New deployments set MBOS_JWT_SECRET.
  JWT_SECRET: "legacy fallback for MBOS_JWT_SECRET, which IS documented",
};

describe("The production env example matches what the code reads", () => {
  test("every variable the code reads is documented, or exempted with a reason", () => {
    const documented = documentedNames();
    const missing: string[] = [];
    for (const [name, where] of referencedNames()) {
      if (documented.has(name)) continue;
      if (name in NOT_IN_PRODUCTION_ENV) continue;
      missing.push(`${name}  (read in ${where})`);
    }
    assert.deepEqual(
      missing,
      [],
      `These are read by the code and absent from .env.production.example. A missing ` +
        `variable does not error here — it makes a feature go quiet. Add it to the ` +
        `example, or add it to NOT_IN_PRODUCTION_ENV with the reason:\n  ` +
        missing.join("\n  "),
    );
  });

  test("every documented variable is actually read somewhere", () => {
    // The other direction, which catches the invented name rather than the
    // forgotten one — GOOGLE_SERVICE_ACCOUNT_EMAIL would have failed HERE,
    // sitting in the example while nothing on earth read it.
    const referenced = new Set(referencedNames().keys());
    // Read by the deployment rather than by the application: compose and Caddy
    // consume these, and no TypeScript ever will.
    const infrastructure = new Set([
      "DOMAIN",
      "ACME_EMAIL",
      "IMAGE",
      "POSTGRES_PASSWORD",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "R2_ENDPOINT",
      "R2_BUCKET",
    ]);
    const stale = [...documentedNames()].filter(
      (n) => !referenced.has(n) && !infrastructure.has(n),
    );
    assert.deepEqual(
      stale,
      [],
      `These sit in .env.production.example and nothing reads them. Either the name ` +
        `is wrong, or the feature is gone:\n  ${stale.join("\n  ")}`,
    );
  });
});
