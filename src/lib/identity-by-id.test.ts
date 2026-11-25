import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/* ---------------------------------------------------------------------------
 * A PERSON IS AN ID. A NAME IS A LABEL.
 *
 * The owner's standing rule (2026-11-17): allocation, reporting lines and
 * books must never hang off somebody's name, because names change — HR
 * renames a person and every question answered by comparing name strings
 * silently changes its answer. Who-is-whose goes through ids
 * (`users.employee_id`, `employee_reporting`, the seat ids on customers), and
 * a piece of text is turned into a person only through `personDirectory()`
 * (lib/services/person-identity-service.ts), which remembers every spelling
 * and refuses a name two people share.
 *
 * This fails the build when the old shapes come back. If you are here
 * because it failed: ask `personDirectory()` instead. The allow-list is for
 * one-off provisioning scripts that ran once against a sheet, and grows only
 * with a reason.
 * ------------------------------------------------------------------------- */

const ROOT = join(process.cwd(), "src");
const SCRIPTS = join(process.cwd(), "scripts");

const BANNED: Array<{ re: RegExp; why: string }> = [
  { re: /managerNameByEmployeeName/, why: "the name-keyed org map was retired; use personDirectory().managerOfAccount" },
  { re: /eq\(\s*users\.name\s*,/, why: "finding an account by its name; use personDirectory().accountByName" },
  { re: /lower\(trim\(\$\{users\.name\}\)\)\s*=/, why: "finding an account by its name in SQL" },
  { re: /\b(userByName|userIdByName|managerByName|ownerByName|usersByName|accountByName)\s*=\s*new Map/, why: "a Map from a person's name to their id" },
  { re: /\$\{employees\.(reportsTo|position)\}\)?\)?\s*=/, why: "a manager or team worked out from a job title; titles become chart links once, in placeByTitles" },
  { re: /lower\(trim\((reports_to|position)\)\)\s*=/, why: "a manager or team worked out from a job title in SQL" },
  { re: /lower\((btrim\()?(\$\{)?(users\.name|employees\.name|employee_name)\}?\)?\)\s*=/, why: "a person found by comparing their name" },
  { re: /\.name\.toLowerCase\(\)\s*===\s*\w+\.user\.name/, why: "the signed-in person found among employees by name; use their HRMS link" },
  { re: /\b(byName|nameToId|idByName)\.(get|set)\(\s*(u|user|p|person|e|emp|employee|staff)\.name/, why: "a person indexed by their name" },
  {
    re: /\.(get|set)\(\s*(norm|normName|normalise|normalize|fold|foldName|nameKey|personKey|lower|clean)\(\s*(u|user|a|acc|account|person|e|emp|employee|staff|who)\.name\s*\)/,
    why: "a person indexed by a folded name in a home-made Map; ask personDirectory() (task-emp-import's personLookup is the model)",
  },
  { re: /\b(lower|btrim)\(\$\{\w+\.(controlledByName|holder|salesmanName|employeeName|expenseBy)\}\)\s*=/, why: "a person found by comparing a stored name; store and ask the user id" },
  { re: /coalesce\(\s*(c|customers|r)\.(sales_person_name|salesPersonName)\b/, why: "the typed salesperson name read before the account; the seat's account comes first, the text only where nobody holds it" },
  { re: /nameFold\(customers\.salesPersonName\)/, why: "a shop given to somebody by matching their name" },
];

/**
 * path (relative to the repo) → why it may stay. A single line can also say
 * `identity-ok: <why>` — for a comparison that is not a lookup (refusing a
 * duplicate name, an old row with no id to ask by).
 */
const ALLOWED: Record<string, string> = {
  "src/lib/services/team-service.ts":
    "provisionBackOffice: a one-off that CREATED the back-office accounts from the sheet's names; it has to key on the name it is creating",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

test("nothing resolves a person by their name", () => {
  const hits: string[] = [];
  for (const file of [...walk(ROOT), ...walk(SCRIPTS)]) {
    const rel = file.slice(process.cwd().length + 1);
    if (ALLOWED[rel]) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (line.includes("identity-ok")) return;
      const code = line.replace(/\/\/.*$/, "");
      if (/^\s*(\*|\/\*)/.test(code)) return;
      for (const b of BANNED) if (b.re.test(code)) hits.push(`${rel}:${i + 1} — ${b.why}`);
    });
  }
  assert.deepEqual(hits, [], `\n${hits.join("\n")}`);
});

test("the guard knows the shapes it was widened for", () => {
  const caught = (line: string) => BANNED.some((b) => b.re.test(line));
  // The task import's home-made name map, before it asked the directory.
  assert.ok(caught("for (const e of accounts) byName.set(norm(e.name), [...(byName.get(norm(e.name)) ?? []), e]);"));
  // The Locker's offboarding checklist, before it asked by account.
  assert.ok(caught("sql`lower(${lockerPaymentMethods.holder}) = lower(${person.name})`"));
  assert.ok(caught("sql`lower(${lockerIdentities.controlledByName}) = lower(${person.name})`"));
  // A product list folded by name is not a person.
  assert.ok(!caught("for (const p of products) map.set(fold(p.name), p);"));
});

test("HRMS renames carry to the account", () => {
  const people = readFileSync(join(ROOT, "lib/hrms/screens/people.ts"), "utf8");
  assert.match(people, /renameEmployee\(/, "the HRMS edit form must call renameEmployee");
  const sync = readFileSync(join(ROOT, "lib/services/employee-sync-service.ts"), "utf8");
  assert.match(sync, /alignAccountNames\(/, "the employee sheet sync must align account names");
  assert.match(sync, /rememberSheetRenames\(/, "the employee sheet sync must remember the old spelling");
});

test("the MBOS book is decided by the sales seat, never by a name", () => {
  const mbos = readFileSync(join(ROOT, "lib/services/mbos-service.ts"), "utf8");
  assert.match(mbos, /inArray\(customers\.salesAmId, ids\)/, "the handset adds the shops he is the sales seat on");
  assert.doesNotMatch(mbos, /salesPersonName\)\}? in \(|nameFold\(customers\.salesPersonName/, "no shop reaches a handset by its typed salesman name");
});

/* ---------------------------------------------------------------------------
 * ONE PERSON, ONE ACCOUNT (owner, 2026-11-18).
 *
 * Every employee is given exactly one account (`ensureEmployeeAccounts`), and
 * every path that makes one first looks for the account the person already
 * has. Pranavi's second, empty login came from a path that did not. So the
 * places allowed to INSERT a user are listed here, each with the check it
 * makes, and a new one fails the build until somebody adds it on purpose.
 * ------------------------------------------------------------------------- */
const MAY_CREATE_ACCOUNTS: Record<string, string> = {
  "src/lib/services/person-identity-service.ts": "ensureEmployeeAccounts — only for an employee with no linked account and no look-alike",
  "src/lib/actions/access.ts": "Add user — sets up the employee's existing account; refuses an account in use or a look-alike login",
  "src/lib/hire/services/provision.ts": "Hire — finds the account by phone or through the HRMS record first",
  "src/lib/services/team-service.ts": "provisionBackOffice — resolves the name through the directory first",
  "scripts/create-accounts-users.ts": "skips an employee who already has an account, links the one it makes",
  "src/db/seed.ts": "dev seed",
  "src/lib/hire/seed/seed.ts": "dev seed",
  "src/lib/hire/seed/onboarding-demo.ts": "dev seed — finds the account by email or phone first",
  "src/lib/factory/demo-seed.ts": "dev seed",
};

test("only the listed places create accounts", () => {
  const hits: string[] = [];
  for (const file of [...walk(ROOT), ...walk(SCRIPTS)]) {
    const rel = file.slice(process.cwd().length + 1);
    if (/\/integration\//.test(rel) || MAY_CREATE_ACCOUNTS[rel]) continue;
    if (/insert\(\s*users\s*\)/.test(readFileSync(file, "utf8"))) hits.push(rel);
  }
  assert.deepEqual(hits, [], `\nThese create accounts without going through the one-account checks:\n${hits.join("\n")}`);
});

test("Add user sets up the existing account rather than making another", () => {
  const access = readFileSync(join(ROOT, "lib/actions/access.ts"), "utf8");
  assert.match(access, /eq\(users\.employeeId, employee\.id\)/, "Add user must look for the employee's own account");
  assert.match(access, /userId = own\?\.id \?\? newId\("usr"\)/, "and use it");
  const nightly = readFileSync(join(ROOT, "lib/jobs.ts"), "utf8");
  assert.match(nightly, /ensureEmployeeAccounts\(\)/, "nightly must give every employee an account");
});
