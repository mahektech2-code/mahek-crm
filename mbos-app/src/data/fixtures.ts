/**
 * The words the design owns. There is no data in this file.
 *
 * It used to hold placeholder RECORDS as well — a payslip, a league position,
 * a document library, a training list and a month's target — for the five
 * screens with no source behind them. Each carried a grey caption admitting it
 * was not live, and that was not enough: a caption sits under the figure, and
 * a figure with a progress bar beside it is read as fact at a glance. Home's
 * target panel was the worst of them, being the first screen after sign-in.
 * All of it is gone. Documents and training read the local store, which the
 * pull has been filling all along; salary, performance and the target say
 * plainly that the office does not send them yet.
 *
 * What is left is of one kind only: VOCABULARY and LABELS. The seven visit
 * outcomes and the five complaint categories are the words on the buttons —
 * they belong with the screens rather than in a payload, and `lib/wire.ts`
 * translates them on the way out. The two Home arrays are label-and-tone
 * scaffolds; every figure beside them is a query against SQLite.
 *
 * Nothing that could be mistaken for a record may be added here again.
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
  { l: 'stops planned' },
  { l: 'to collect' },
  { l: 'follow-ups due' },
] as const;

/** The labels and tones of the six dashboard cells. Every value is a query. */
/*
 * The six numbers, and WHERE EACH ONE OPENS — where anything does.
 *
 * Every tile used to answer a tap with "<name> — opens the list behind this
 * number", and none of them opened anything. Four of the six have no list to
 * open: `/order` and `/pay` are FORMS, not ledgers, and MBOS has no visits list
 * or receipts list at all. Routing them somewhere plausible would be worse than
 * the toast — a tap on "Cash in hand" landing on a blank payment form is the
 * app losing your place, not answering you.
 *
 * So the two with a real destination navigate, and the rest are numbers. A
 * figure that does not open is ordinary; a figure that says it opens and does
 * not is what teaches people to stop tapping things.
 */
export const DASH_CARDS: { l: string; tone?: 'danger' | 'amber'; route?: string }[] = [
  { l: 'Today’s sales' },
  { l: 'Visits', route: 'journey' },
  { l: 'Collection due', tone: 'danger' },
  { l: 'Cash in hand', tone: 'amber' },
  { l: 'Tasks', tone: 'amber', route: 'tasks' },
  { l: 'Follow-ups', route: 'tasks' },
];
