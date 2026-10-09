import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NEW_FOR_MS,
  categoryLabel,
  fileBadge,
  fileKind,
  filterChips,
  filterCounts,
  isNew,
  librarySections,
  searchScore,
  type LibraryDoc,
} from './library-view';

const NOW = Date.UTC(2026, 9, 10, 6, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function doc(over: Partial<LibraryDoc> & { title: string }): LibraryDoc {
  return {
    id: over.title,
    category: 'price_list',
    description: null,
    kind: 'application/pdf',
    sizeLabel: '1.2 MB',
    publishedAt: NOW - 30 * DAY,
    onPhone: false,
    ...over,
  };
}

const BOOK: LibraryDoc[] = [
  doc({ title: 'Price List Odisha To Pay August 2026', publishedAt: NOW - 1 * DAY }),
  doc({ title: 'Price List Maharashtra', onPhone: true }),
  doc({ title: 'Wood Finish Catalogue', category: 'catalogue', kind: 'image/jpeg', description: 'PU and melamine' }),
  doc({ title: 'Credit Policy', category: 'policy', publishedAt: NOW - 2 * DAY }),
  doc({ title: 'Agreement — Bhagat Traders', category: 'agreement' }),
  doc({ title: 'Festival scheme', category: 'diwali_scheme' }),
  doc({ title: 'Untitled scan', category: null, kind: null }),
];

test('every category the server knows has a word, and one it does not is humanised rather than hidden', () => {
  for (const c of ['price_list', 'catalogue', 'company_profile', 'marketing', 'product_video', 'policy', 'agreement', 'kyc']) {
    assert.doesNotMatch(categoryLabel(c), /_/, c);
  }
  assert.equal(categoryLabel('diwali_scheme'), 'Diwali scheme');
  assert.equal(categoryLabel(null), 'Other');
});

test('the tile says what the file is, and an unknown type says FILE rather than guessing PDF', () => {
  assert.equal(fileBadge('application/pdf'), 'PDF');
  assert.equal(fileBadge('image/jpeg'), 'JPG');
  assert.equal(fileBadge('image/png'), 'PNG');
  assert.equal(fileBadge(null), 'FILE');
  assert.equal(fileKind('image/png'), 'image');
  assert.equal(fileKind('application/pdf'), 'pdf');
  assert.equal(fileKind(null), 'other');
});

test('new means published within the week, and never a document dated in the future', () => {
  assert.equal(isNew({ publishedAt: NOW - DAY }, NOW), true);
  assert.equal(isNew({ publishedAt: NOW - NEW_FOR_MS }, NOW), false);
  assert.equal(isNew({ publishedAt: NOW + DAY }, NOW), false);
  assert.equal(isNew({ publishedAt: null }, NOW), false);
});

test('chips: All, New, On this phone, then only the categories that have something, in a fixed order', () => {
  const labels = filterChips(BOOK).map((c) => c.label);
  assert.deepEqual(labels, [
    'All',
    'New',
    'On this phone',
    'Price lists',
    'Catalogues',
    'Policies',
    'Agreements',
    'Diwali scheme',
    'Other',
  ]);
  assert.ok(!labels.includes('KYC'), 'a category with nothing in it gets no chip');
});

test('each chip counts what it would show', () => {
  const chips = filterChips(BOOK);
  const counts = filterCounts(BOOK, chips, NOW);
  assert.equal(counts.all, 7);
  assert.equal(counts.new, 2);
  assert.equal(counts.offline, 1);
  assert.equal(counts['cat:price_list'], 2);
  assert.equal(counts['cat:_unfiled'], 1);
});

test('search wants every word, anywhere, in any order', () => {
  assert.ok(searchScore(BOOK[0], 'odisha price') != null);
  assert.equal(searchScore(BOOK[0], 'odisha kerala'), null);
  // The description and the category's own name are searched too.
  assert.ok(searchScore(BOOK[2], 'melamine') != null);
  assert.ok(searchScore(BOOK[3], 'policies') != null);
  // Accents and punctuation do not get in the way.
  assert.ok(searchScore(BOOK[4], 'bhagat') != null);
});

test('a title match outranks a description match, and a title that starts with the word outranks both', () => {
  const docs = [
    doc({ title: 'Melamine sealer rates', category: 'price_list' }),
    doc({ title: 'Wood Finish Catalogue', category: 'catalogue', description: 'melamine range' }),
    doc({ title: 'Full melamine range', category: 'catalogue' }),
  ];
  const [results] = librarySections(docs, { query: 'melamine', filter: 'all', now: NOW });
  assert.deepEqual(
    results.data.map((d) => d.title),
    ['Melamine sealer rates', 'Full melamine range', 'Wood Finish Catalogue'],
  );
  assert.equal(results.title, '3 matches');
});

test('no search: grouped by category in a fixed order, alphabetical inside, so nothing moves', () => {
  const sections = librarySections(BOOK, { query: '', filter: 'all', now: NOW });
  assert.deepEqual(
    sections.map((s) => s.title),
    ['Price lists', 'Catalogues', 'Policies', 'Agreements', 'Diwali scheme', 'Other'],
  );
  assert.deepEqual(
    sections[0].data.map((d) => d.title),
    ['Price List Maharashtra', 'Price List Odisha To Pay August 2026'],
  );
});

test('a search is ONE section, not grouped — the match he wanted is never under a header', () => {
  const sections = librarySections(BOOK, { query: 'price', filter: 'all', now: NOW });
  assert.equal(sections.length, 1);
  assert.equal(sections[0].data.length, 2);
});

test('the search and the chip combine', () => {
  const sections = librarySections(BOOK, { query: 'price', filter: 'offline', now: NOW });
  assert.deepEqual(sections[0].data.map((d) => d.title), ['Price List Maharashtra']);
});

test('New is newest first, in one section', () => {
  const [fresh] = librarySections(BOOK, { query: '', filter: 'new', now: NOW });
  assert.equal(fresh.title, 'Published this week');
  assert.deepEqual(fresh.data.map((d) => d.title), ['Price List Odisha To Pay August 2026', 'Credit Policy']);
});

test('nothing matching is no sections at all, so the screen can say why', () => {
  assert.deepEqual(librarySections(BOOK, { query: 'zzz', filter: 'all', now: NOW }), []);
  assert.deepEqual(librarySections([], { query: '', filter: 'all', now: NOW }), []);
});

test('three hundred documents are grouped quickly enough to redo on every keystroke', () => {
  const many = Array.from({ length: 300 }, (_, i) =>
    doc({ title: `Document ${i}`, category: ['price_list', 'catalogue', 'policy'][i % 3], description: `rates ${i}` }),
  );
  const t = performance.now();
  for (let i = 0; i < 20; i++) librarySections(many, { query: 'rates 1', filter: 'all', now: NOW });
  assert.ok(performance.now() - t < 500);
});
