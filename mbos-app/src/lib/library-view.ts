/**
 * WHAT THE DOCUMENTS SCREEN SHOWS, decided without a phone.
 *
 * The library was a flat alphabetical list, which was fine at five documents
 * and is not at a few hundred: the price list he needs in front of a customer
 * is somewhere between "Agreement — Bhagat Traders" and "Wood finish
 * brochure", and he scrolls past the right one looking for it. So the screen
 * now searches, narrows by category, and groups what is left — and every one
 * of those rules is here, PURE, so it can be tested without a handset.
 *
 * The category words mirror `src/lib/mbos/library-labels.ts` on the server.
 * A category this build has never heard of is humanised rather than hidden:
 * the office adding a ninth one must never make documents vanish from phones
 * that have not been updated.
 */

export type LibraryDoc = {
  id: string;
  title: string;
  category: string | null;
  description: string | null;
  /** The file's media type, e.g. `application/pdf`. Null on rows synced before it was sent. */
  kind: string | null;
  sizeLabel: string | null;
  /** Epoch milliseconds the office published it. Null on rows synced before it was sent. */
  publishedAt: number | null;
  onPhone: boolean;
};

/** The order sections are drawn in: what is quoted from first, paperwork last. */
const CATEGORY_ORDER = [
  'price_list',
  'catalogue',
  'company_profile',
  'marketing',
  'product_video',
  'policy',
  'agreement',
  'kyc',
] as const;

const CATEGORY_LABEL: Record<string, string> = {
  price_list: 'Price lists',
  catalogue: 'Catalogues',
  company_profile: 'Company profile',
  marketing: 'Marketing',
  product_video: 'Product videos',
  policy: 'Policies',
  agreement: 'Agreements',
  kyc: 'KYC',
};

export const UNFILED = '_unfiled';

export function categoryLabel(category: string | null): string {
  if (!category) return 'Other';
  return CATEGORY_LABEL[category] ?? humanise(category);
}

function humanise(code: string): string {
  const words = code.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Other';
}

/** How long a document stays marked new. A week is one round of a beat. */
export const NEW_FOR_MS = 7 * 24 * 60 * 60 * 1000;

export function isNew(d: Pick<LibraryDoc, 'publishedAt'>, now: number): boolean {
  return d.publishedAt != null && now - d.publishedAt >= 0 && now - d.publishedAt < NEW_FOR_MS;
}

export type FileKind = 'pdf' | 'image' | 'other';

export function fileKind(kind: string | null): FileKind {
  if (!kind) return 'other';
  if (kind === 'application/pdf') return 'pdf';
  if (kind.startsWith('image/')) return 'image';
  return 'other';
}

/** The three letters on the tile. Unknown says so rather than guessing PDF. */
export function fileBadge(kind: string | null): string {
  switch (kind) {
    case 'application/pdf':
      return 'PDF';
    case 'image/jpeg':
      return 'JPG';
    case 'image/png':
      return 'PNG';
    case 'image/webp':
      return 'WEBP';
    default:
      return kind?.startsWith('image/') ? 'IMG' : 'FILE';
  }
}

/* --------------------------------------------------------------- filters */

export type LibraryFilter = 'all' | 'new' | 'offline' | `cat:${string}`;

export type FilterChip = { value: LibraryFilter; label: string };

/**
 * The chips, in a fixed order: everything, new, on this phone, then each
 * category that has at least one document. A category with nothing in it is
 * left off — a chip that always answers zero is a chip nobody needs.
 */
export function filterChips(docs: LibraryDoc[]): FilterChip[] {
  const present = new Set(docs.map((d) => d.category ?? UNFILED));
  const known = CATEGORY_ORDER.filter((c) => present.has(c));
  const unknown = [...present]
    .filter((c) => c !== UNFILED && !(CATEGORY_ORDER as readonly string[]).includes(c))
    .sort((a, b) => categoryLabel(a).localeCompare(categoryLabel(b)));
  const cats = [...known, ...unknown, ...(present.has(UNFILED) ? [UNFILED] : [])];
  return [
    { value: 'all', label: 'All' },
    { value: 'new', label: 'New' },
    { value: 'offline', label: 'On this phone' },
    ...cats.map((c) => ({ value: `cat:${c}` as LibraryFilter, label: categoryLabel(c === UNFILED ? null : c) })),
  ];
}

export function matchesFilter(d: LibraryDoc, filter: LibraryFilter, now: number): boolean {
  if (filter === 'all') return true;
  if (filter === 'new') return isNew(d, now);
  if (filter === 'offline') return d.onPhone;
  return (d.category ?? UNFILED) === filter.slice(4);
}

/** How many each chip would show, against what the search has already narrowed. */
export function filterCounts(docs: LibraryDoc[], chips: FilterChip[], now: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of chips) out[c.value] = docs.filter((d) => matchesFilter(d, c.value, now)).length;
  return out;
}

/* ---------------------------------------------------------------- search */

function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Every word he types has to appear somewhere — the title, the description or
 * the category's name — in any order. "odisha price" finds "Price List
 * Odisha"; a search that wanted the words in the title's own order would not.
 * Titles that match score above descriptions, and a title that STARTS with
 * the first word above both, because that is the document he named.
 */
export function searchScore(d: LibraryDoc, query: string): number | null {
  const words = fold(query).split(' ').filter(Boolean);
  if (!words.length) return 0;
  const title = fold(d.title);
  const rest = fold(`${d.description ?? ''} ${categoryLabel(d.category)}`);
  let score = 0;
  for (const w of words) {
    if (title.includes(w)) score += title.split(' ').some((t) => t.startsWith(w)) ? 3 : 2;
    else if (rest.includes(w)) score += 1;
    else return null;
  }
  if (title.startsWith(words[0])) score += 2;
  return score;
}

/* ------------------------------------------------------------- sections */

export type LibrarySection = { key: string; title: string; data: LibraryDoc[] };

function byTitle(a: LibraryDoc, b: LibraryDoc): number {
  return a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true });
}

/**
 * WHAT THE LIST IS, given the search and the chip.
 *
 * - A search answers in ONE section, best match first: grouping a search by
 *   category would bury the one result he wanted under a header.
 * - "New" is one section, newest first — the question is "what came in".
 * - Everything else is grouped by category in a fixed order, alphabetical
 *   inside each, so a document never moves while he is looking for it.
 */
export function librarySections(
  docs: LibraryDoc[],
  opts: { query: string; filter: LibraryFilter; now: number },
): LibrarySection[] {
  const narrowed = docs.filter((d) => matchesFilter(d, opts.filter, opts.now));

  if (opts.query.trim()) {
    const scored = narrowed
      .map((d) => ({ d, s: searchScore(d, opts.query) }))
      .filter((x): x is { d: LibraryDoc; s: number } => x.s != null)
      .sort((a, b) => b.s - a.s || byTitle(a.d, b.d))
      .map((x) => x.d);
    return scored.length ? [{ key: 'results', title: resultsTitle(scored.length), data: scored }] : [];
  }

  if (opts.filter === 'new') {
    const fresh = [...narrowed].sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0) || byTitle(a, b));
    return fresh.length ? [{ key: 'new', title: 'Published this week', data: fresh }] : [];
  }

  const groups = new Map<string, LibraryDoc[]>();
  for (const d of narrowed) {
    const k = d.category ?? UNFILED;
    groups.set(k, [...(groups.get(k) ?? []), d]);
  }
  const order = filterChips(narrowed)
    .filter((c) => c.value.startsWith('cat:'))
    .map((c) => c.value.slice(4));
  return order
    .filter((k) => groups.has(k))
    .map((k) => ({
      key: k,
      title: categoryLabel(k === UNFILED ? null : k),
      data: groups.get(k)!.sort(byTitle),
    }));
}

function resultsTitle(n: number): string {
  return n === 1 ? '1 match' : `${n} matches`;
}
