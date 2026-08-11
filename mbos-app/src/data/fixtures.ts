/**
 * What is left of the design's own data.
 *
 * Everything that HAS a source now reads the local SQLite store through
 * `src/data/*` — customers, products, visits, orders, payments, tasks, leave,
 * expenses, samples, notifications, attendance, the journey and the outbox.
 * What survives here is of exactly two kinds, and neither is a customer, a
 * figure or a record:
 *
 *   VOCABULARY the design owns and the server does not send — the seven visit
 *   outcomes and the five complaint categories. These are the words on the
 *   buttons; they belong with the screens, not in a payload.
 *
 *   PLACEHOLDER data for the five screens with no server behind them yet.
 *   Each of those screens now carries a caption saying the figures are not
 *   live, so nobody reads them as fact.
 *
 * Still importing from here, and why:
 *
 *   `app/visit.tsx`, `app/saved.tsx`, `src/lib/visit.ts`, `src/state/store.ts`
 *       OUTCOMES, OutcomeKey, COMPLAINT_CATEGORIES — vocabulary, above.
 *   `app/home.tsx`
 *       DAY_AHEAD and DASH_CARDS for their LABELS and tones only; every value
 *       beside them is a query. SUGGESTIONS is still a fixture — the engine
 *       that would rank them does not exist yet — and Home filters it to
 *       customers this handset actually has, so it can only ever offer a shop
 *       that is really there. PERIODS is the target panel, which the office
 *       owns and has not sent; the panel says so on screen.
 *   `app/salary.tsx`, `app/performance.tsx`, `app/docs.tsx`, `app/knowledge.tsx`
 *       MONTHS_PAY, SLABS, PERFORMANCE, DOCS, KNOWLEDGE — no payroll, no
 *       ranking, no document store and no course records exist on either side
 *       of the sync yet. Each screen says the figures are not live.
 *
 * When a source arrives for one of these, the screen moves to `src/data/*`
 * and its block leaves this file. Nothing else should ever be added to it.
 */

/* ------------------------------------------------------- visit vocabulary */

export type OutcomeKey = 'visited' | 'order' | 'payment' | 'complaint' | 'sample' | 'closed_now' | 'closed';

export const OUTCOMES: { k: OutcomeKey; label: string }[] = [
  { k: 'visited', label: 'Visited' },
  { k: 'order', label: 'Order taken' },
  { k: 'payment', label: 'Payment collected' },
  { k: 'complaint', label: 'Complaint' },
  { k: 'sample', label: 'Sample required' },
  { k: 'closed_now', label: 'Not available' },
  { k: 'closed', label: 'Shop closed' },
];

export const COMPLAINT_CATEGORIES = [
  'Late delivery',
  'Damaged goods',
  'Wrong material',
  'Short quantity',
  'Rate dispute',
] as const;

/* ------------------------------------------------------------------ home */

/** The labels on the day-ahead strip. The three figures beside them are real. */
export const DAY_AHEAD = [
  { v: '', l: 'stops planned' },
  { v: '', l: 'to collect' },
  { v: '', l: 'follow-ups due' },
] as const;

/** The labels and tones of the six dashboard cells. Every value is a query. */
export const DASH_CARDS: { l: string; s: string; tone?: 'danger' | 'amber' }[] = [
  { l: 'Today’s sales', s: '' },
  { l: 'Visits', s: '' },
  { l: 'Collection due', s: '', tone: 'danger' },
  { l: 'Cash in hand', s: '', tone: 'amber' },
  { l: 'Tasks', s: '', tone: 'amber' },
  { l: 'Follow-ups', s: '' },
];

/**
 * The suggestions on Home. Advisory by construction — each is a shortcut to a
 * screen reachable anyway, each can be dismissed, and none creates anything.
 * That is a rule from the brief, not a property of this fixture.
 *
 * Home shows only the ones whose customer exists in the local book, so on a
 * real handset these disappear until the engine that ranks them is built.
 */
export const SUGGESTIONS = [
  { id: 'a1', title: 'Om Sai Enterprises', why: '44 days since the last order, and they used to buy every 18.', cta: 'Start visit', tone: 'danger' as const, custId: 'c3', go: 'visit' },
  { id: 'a2', title: 'Collect ₹5,12,000', why: 'Ganesh Chemicals, oldest bill is 62 days over.', cta: 'Collect', tone: 'amber' as const, custId: 'c6', go: 'pay' },
  { id: 'a3', title: 'Sample at Balaji Traders', why: 'Sent 9 days ago, no feedback recorded yet.', cta: 'Open', tone: 'neutral' as const, custId: 'c4', go: 'samples' },
];

/** The target panel. The office computes these; none of them has arrived. */
export const PERIODS = [
  { k: 'month', label: 'This month', done: 1842000, goal: 2600000, left: '9 days left' },
  { k: 'fy', label: 'FY 26-27', done: 14260000, goal: 31200000, left: '7 months left' },
  { k: 'life', label: 'Lifetime', done: 96400000, goal: 0, left: 'Since Apr 2019' },
] as const;

/* --------------------------------------------------------------- salary */

export type SalaryMonth = {
  m: string; net: number; basic: number; travel: number; inc: number;
  bonus: number; adv: number; pf: number; pct: number; paid: string;
};

export const MONTHS_PAY: SalaryMonth[] = [
  { m: 'July 2026', net: 48240, basic: 32000, travel: 6000, inc: 12400, bonus: 2800, adv: 4000, pf: 960, pct: 71, paid: 'Paid 03 Aug' },
  { m: 'June 2026', net: 46800, basic: 32000, travel: 6000, inc: 10600, bonus: 2400, adv: 3200, pf: 960, pct: 64, paid: 'Paid 03 Jul' },
  { m: 'May 2026', net: 51200, basic: 32000, travel: 6000, inc: 15800, bonus: 3200, adv: 4800, pf: 960, pct: 88, paid: 'Paid 03 Jun' },
  { m: 'April 2026', net: 44100, basic: 32000, travel: 6000, inc: 8600, bonus: 1800, adv: 3400, pf: 960, pct: 56, paid: 'Paid 03 May' },
];

/** Incentive slabs, so the number on the payslip is something he can act on. */
export const SLABS: [number, number][] = [[60, 4], [75, 6], [90, 9], [100, 12]];

/* ---------------------------------------------------------- performance */

export const PERFORMANCE = {
  rankLine: '3rd of 9 in the region · was 5th last month',
  cards: [
    { l: 'Target', v: '71%', s: '₹18,42,000 of ₹26,00,000' },
    { l: 'Visits', v: '184', s: 'Against a plan of 210', tone: 'amber' },
    { l: 'Collections', v: '₹9,84,000', s: '62% of what was due', tone: 'amber' },
    { l: 'New customers', v: '6', s: 'Best in your area', tone: 'good' },
  ] as { l: string; v: string; s: string; tone?: 'amber' | 'good' }[],
  bars: [
    { l: 'Order value', me: 71, team: 64 },
    { l: 'Visits done', me: 88, team: 91 },
    { l: 'Collections', me: 62, team: 74 },
    { l: 'New customers', me: 120, team: 80 },
  ],
  weakest: 'Collections is where you are furthest behind the team. Six customers account for ₹8,42,000 of it.',
} as const;

/* ------------------------------------------------ documents and training */

export type DocRow = { name: string; kind: string; size: string; expiring: boolean };

export const DOCS: DocRow[] = [
  { name: 'Price list · August 2026', kind: 'PDF', size: '820 KB', expiring: false },
  { name: 'Company ID card', kind: 'Image', size: '240 KB', expiring: true },
  { name: 'Product safety sheets', kind: 'PDF', size: '1.4 MB', expiring: false },
  { name: 'Credit policy', kind: 'PDF', size: '320 KB', expiring: false },
  { name: 'Territory map · Nagpur East', kind: 'PDF', size: '640 KB', expiring: false },
];

export type CourseRow = { title: string; kind: string; mins: number; done: boolean; due: boolean };

export const KNOWLEDGE: CourseRow[] = [
  { title: 'Handling a rate objection', kind: 'Video', mins: 6, done: false, due: true },
  { title: 'Thinner grades explained', kind: 'Guide', mins: 8, done: true, due: false },
  { title: 'Collecting without souring the relationship', kind: 'Video', mins: 5, done: true, due: false },
  { title: 'What counts as a verified visit', kind: 'Guide', mins: 3, done: false, due: false },
];
