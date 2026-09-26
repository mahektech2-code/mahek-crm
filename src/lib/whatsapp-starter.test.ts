import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  starterStatements,
  WHATSAPP_STARTER_MIGRATIONS,
} from "./whatsapp-starter";

const read = (tag: string) =>
  readFileSync(join(process.cwd(), "drizzle", `${tag}.sql`), "utf8");

test("the seed restores all eight approved templates", () => {
  const stmts = starterStatements(read(WHATSAPP_STARTER_MIGRATIONS[0]));
  const templates = stmts.filter((s) => /^INSERT INTO "wa_templates"/.test(s));
  assert.equal(templates.length, 8);
  assert.ok(
    templates.every((s) => /WHERE NOT EXISTS/.test(s)),
    "every insert must be safe to run on a database that already has it",
  );
});

test("the seed restores the window and the eight starter rules, and nothing else", () => {
  const stmts = starterStatements(read(WHATSAPP_STARTER_MIGRATIONS[1]));
  assert.equal(stmts.length, 2);
  assert.match(stmts[0], /^INSERT INTO "wa_automation_settings"/);
  assert.match(stmts[1], /^INSERT INTO "wa_triggers"/);
  assert.equal((stmts[1].match(/\('trg_/g) ?? []).length, 8);
});

test("schema statements and comments are never replayed", () => {
  const all = WHATSAPP_STARTER_MIGRATIONS.flatMap((t) => starterStatements(read(t)));
  assert.ok(all.every((s) => !/^(ALTER|CREATE|DROP)\b/i.test(s)));
  assert.ok(all.every((s) => !s.startsWith("--")));
});
