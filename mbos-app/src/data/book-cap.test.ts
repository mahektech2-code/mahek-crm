import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every read of the book is CAPPED.
 *
 * This is the bug that stopped the handset answering, and it is invisible to
 * every other check in the project: `SELECT * FROM customers ORDER BY name`
 * type-checks, lints, passes the schema-usage test — every table and column in
 * it is real — and returns six rows on a seeded laptop. On a salesman's phone
 * it returns 1,076, each one a card in the frame's plain ScrollView, and the
 * app mounts the whole territory as native views the moment the tab is
 * touched. Nothing fails. It just stops.
 *
 * So the rule is pinned as TEXT, the way `mbos-wire.test.ts` pins the wire
 * contract, because there is nowhere else it can be seen: the query is a
 * string, the row count is a property of production, and the freeze only
 * happens on a device.
 *
 * A read is allowed to be uncapped only if it cannot return the book — an
 * aggregate, or a lookup bounded by id. Anything else needs a LIMIT or a
 * NAMED entry below saying why not.
 */

const DATA = import.meta.dirname;

/**
 * Reads that return the whole book on purpose.
 *
 * Two, and both earn it.
 *
 * `findDuplicate` matches a typed mobile against every number on the book, and
 * the matching cannot be done in SQL — the numbers are stored as they arrived
 * (`+91 98220 11002`, `09822011003`) and `normaliseMobile` is what makes them
 * comparable. It selects three narrow columns and renders NONE of them. A cap
 * would not be a slower screen, it would be a duplicate shop created because
 * the match was looked for in the first sixty names alphabetically.
 *
 * `listCustomers` is the declared whole-book LOOKUP, and its own comment says
 * so: anything that RENDERS it has the bug `CUSTOMER_PAGE` exists to prevent.
 * That is a rule about its callers rather than about the query, and this test
 * cannot see callers — which is the gap, stated rather than papered over.
 */
const UNCAPPED_ON_PURPOSE = [
  'SELECT id, name, phone FROM customers WHERE phone IS NOT NULL',
  /* customerPageQuery({ limit: -1 }) — the lookup above, built in customer-query.ts. */
  'X',
];

/** Comments carry SQL words and confuse the reader below. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * Blank out `${...}` before looking for string literals.
 *
 * Interpolations carry quotes of their own — `${ids.map(() => '?').join(',')}`
 * has two — so a reader that does not remove them first walks straight past
 * the backtick that ends the query and swallows the rest of the file. That is
 * not a hypothetical: it is what the first version of this test did, and it
 * reported a `FROM payments` query as an uncapped read of the book.
 */
function blankInterpolations(src: string): string {
  let out = src;
  for (let i = 0; i < 5; i++) {
    const next = out.replace(/\$\{[^{}]*\}/g, ' X ');
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Every SELECT whose FROM is `customers`, as written.
 *
 * `JOIN customers` is deliberately not matched: a join reaches the book to
 * name one row per row of something else that is already bounded, which is a
 * different question to reading the book itself.
 */
function customerSelects(src: string): string[] {
  const clean = blankInterpolations(stripComments(src));
  const out: string[] = [];
  for (const m of clean.matchAll(/`([^`]*)`|'([^']*)'|"([^"]*)"/g)) {
    const body = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\s+/g, ' ').trim();
    if (/\bSELECT\b/i.test(body) && /\bFROM\s+customers\b/i.test(body)) out.push(body);
  }
  return out;
}

const files = readdirSync(DATA).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

for (const file of files) {
  const src = stripComments(readFileSync(join(DATA, file), 'utf8'));
  for (const q of customerSelects(src)) {
    /* An aggregate returns one row however big the book is. */
    if (/\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(q)) continue;
    /* Bounded by id: one row, or the handful the caller already named. */
    if (/\bWHERE\b[^;]*\bid\s*(?:=|\bIN\b)/i.test(q)) continue;
    if (UNCAPPED_ON_PURPOSE.includes(q)) continue;

    test(`${file}: a read of the book carries a LIMIT — ${q.slice(0, 60)}`, () => {
      assert.match(
        q,
        /\bLIMIT\b/i,
        `This returns every customer on the handset — 1,076 on a real book. If a screen renders it, ` +
          `the app freezes on that screen. Add a LIMIT and say what the list is a slice of, or add it ` +
          `to UNCAPPED_ON_PURPOSE with the reason it cannot be capped.\n\n  ${q}`,
      );
    });
  }
}

/**
 * Each cap is a named constant, not a literal typed into a query.
 *
 * Two screens read the book at two sizes — the Customers tab pages at
 * `CUSTOMER_PAGE` behind a Load more button, the pick list scans at
 * `PICK_PAGE` — and three hand-typed limits is how one of them ends up at 600.
 */
test('the Customers tab cap is a named constant', () => {
  const src = readFileSync(join(DATA, 'customer-query.ts'), 'utf8');
  assert.match(src, /export const CUSTOMER_PAGE = \d+;/);
});

test('the pick list cap is a named constant', () => {
  const src = readFileSync(join(DATA, 'journey.ts'), 'utf8');
  assert.match(src, /export const PICK_PAGE = \d+;/);
});
