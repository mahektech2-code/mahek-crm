import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Does every query name a table and a column that actually exist?
 *
 * This is the one class of bug in this app that TypeScript cannot see. SQL
 * lives in template strings, so a column renamed in the schema and missed in a
 * query compiles perfectly and then throws the moment somebody opens that
 * screen — on a handset, in a market, with no console attached.
 *
 * The store's shape is not a small thing to hold in one's head: twenty-six
 * tables across two migrations. This reads the schema and the queries from
 * source and cross-references them, so the mismatch is found here instead of
 * by the salesman.
 *
 * WHAT IT DOES NOT COVER, so nobody reads a green run as more than it is:
 * table names, INSERT column lists and UPDATE SET clauses are checked;
 * columns named only in a WHERE, an ORDER BY or a SELECT list are not. Those
 * need alias and join resolution, and a checker that guesses at them produces
 * false positives — which is worse than a gap, because it teaches people to
 * ignore the output.
 */

const ROOT = join(import.meta.dirname, '..');

/* ------------------------------------------------------- read the schema */

/** Comments carry commas and English words, and both confuse a column parser. */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

function schemaTables(): Map<string, Set<string>> {
  const sql = stripComments(readFileSync(join(ROOT, 'db/schema.ts'), 'utf8'));
  const tables = new Map<string, Set<string>>();

  /* CREATE TABLE IF NOT EXISTS <name> ( ... ) */
  const create = /CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\);/g;
  for (const m of sql.matchAll(create)) {
    const [, name, body] = m;
    const cols = new Set<string>();
    for (const line of body.split(/,(?![^(]*\))/)) {
      const t = line.trim();
      /* Skip table-level constraints; take the first identifier otherwise. */
      if (/^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)\b/i.test(t)) continue;
      const col = t.match(/^(\w+)/);
      if (col) cols.add(col[1]);
    }
    tables.set(name, cols);
  }

  /* Later migrations add columns rather than recreating the table. */
  for (const m of sql.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+)/g)) {
    tables.get(m[1])?.add(m[2]);
  }

  return tables;
}

/* ------------------------------------------------------ read the queries */

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      sourceFiles(path, out);
    } else if (/\.tsx?$/.test(entry) && !entry.endsWith('.test.ts')) {
      out.push(path);
    }
  }
  return out;
}

/** The tables the local store owns. Anything else is a false positive. */
const KNOWN = schemaTables();
const files = sourceFiles(ROOT).filter((f) => !f.endsWith('db/schema.ts'));

type Finding = { file: string; detail: string };

/**
 * The SQL in a file, and only the SQL.
 *
 * The first version of this read every `FROM` in the source and reported
 * "from their", "from where" and "from each" out of the prose in comments —
 * a checker whose output nobody would read twice. It looks inside quoted
 * strings that contain a SQL verb, and nowhere else.
 */
function sqlStrings(source: string): string[] {
  /* Comments go first. A comment reading `cannot be told "update the app
     first"` is a quoted phrase containing a SQL verb, and without this it
     reports a table called "the". */
  const src = stripComments(source);
  const out: string[] = [];
  for (const m of src.matchAll(/`([^`]*)`|'([^'\n]*)'|"([^"\n]*)"/g)) {
    const body = m[1] ?? m[2] ?? m[3] ?? '';
    if (/\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(body)) out.push(body);
  }
  return out;
}

/* `ON CONFLICT(...) DO UPDATE SET` puts a keyword exactly where a table name
   would be. These are the words that can legitimately follow one. */
const SQL_KEYWORDS = new Set([
  'set', 'select', 'values', 'where', 'from', 'into', 'update', 'join', 'on',
  'and', 'or', 'as', 'by', 'order', 'group', 'limit', 'case', 'when', 'then',
  'else', 'end', 'null', 'not', 'exists', 'conflict', 'do', 'nothing',
]);

test('every table a query names exists in the schema', () => {
  const bad: Finding[] = [];

  for (const file of files) {
    for (const sql of sqlStrings(readFileSync(file, 'utf8'))) {
      for (const m of sql.matchAll(/\b(?:FROM|INTO|UPDATE|JOIN)\s+([a-z_][a-z0-9_]*)/gi)) {
        const table = m[1];
        if (KNOWN.has(table)) continue;
        if (SQL_KEYWORDS.has(table.toLowerCase())) continue;
        bad.push({ file: file.replace(ROOT, 'src'), detail: table });
      }
    }
  }

  assert.deepEqual(bad, [], 'queries naming a table that does not exist:\n' + JSON.stringify(bad, null, 2));
});

test('every column an INSERT names exists on that table', () => {
  const bad: Finding[] = [];

  for (const file of files) {
    const src = sqlStrings(readFileSync(file, 'utf8')).join('\n');
    for (const m of src.matchAll(/INSERT\s+INTO\s+(\w+)\s*\(([^)]*)\)/gi)) {
      const [, table, list] = m;
      const cols = KNOWN.get(table);
      if (!cols) continue;
      for (const raw of list.split(',')) {
        const col = raw.trim().replace(/[`"']/g, '');
        if (!col || col.startsWith('$')) continue;
        if (!cols.has(col)) bad.push({ file: file.replace(ROOT, 'src'), detail: `${table}.${col}` });
      }
    }
  }

  assert.deepEqual(bad, [], 'INSERT naming a column that does not exist:\n' + JSON.stringify(bad, null, 2));
});

test('every column an UPDATE sets exists on that table', () => {
  const bad: Finding[] = [];

  for (const file of files) {
    const src = sqlStrings(readFileSync(file, 'utf8')).join('\n');
    for (const m of src.matchAll(/UPDATE\s+(\w+)\s+SET\s+([\s\S]*?)(?:WHERE|$)/gim)) {
      const [, table, assignments] = m;
      const cols = KNOWN.get(table);
      if (!cols) continue;
      for (const part of assignments.split(',')) {
        const col = part.trim().split(/\s*=/)[0]?.trim();
        if (!col || !/^\w+$/.test(col)) continue;
        if (!cols.has(col)) bad.push({ file: file.replace(ROOT, 'src'), detail: `${table}.${col}` });
      }
    }
  }

  assert.deepEqual(bad, [], 'UPDATE setting a column that does not exist:\n' + JSON.stringify(bad, null, 2));
});

test('the schema itself parsed — the checks above are not vacuously passing', () => {
  /* A regex that silently matched nothing would make every test above green
     while checking nothing at all. This is the guard on the guard. */
  assert.ok(KNOWN.size >= 20, `expected the full store, found ${KNOWN.size} tables`);
  assert.ok(KNOWN.get('visits')?.has('outcome'), 'visits.outcome should be known');
  assert.ok(KNOWN.get('attendance_days')?.has('sessions'), 'the v2 ALTER should be picked up');
  /* The comment-stripping regression: a comma inside a code comment used to
     swallow the column declared after it. */
  assert.ok(KNOWN.get('media_queue')?.has('transcriptionState'), 'a column after a comment must still be seen');
  assert.ok(!KNOWN.get('media_queue')?.has('earlier'), 'prose from a comment must not read as a column');
  assert.ok(files.length > 20, `expected the whole source tree, found ${files.length} files`);

  /* And the SQL extractor is not vacuous either: it must find the real
     queries, and must not find prose that merely mentions a SQL verb. */
  const realSql = sqlStrings(readFileSync(join(ROOT, 'data/customers.ts'), 'utf8'));
  assert.ok(realSql.some((q) => /FROM customers/i.test(q)), 'should find the customer queries');
  assert.deepEqual(sqlStrings('/* cannot be told "update the app first" */'), []);
});
