/**
 * Which animation a route gets, and why.
 *
 * Kept here rather than scattered across `Stack.Screen` options so the whole
 * vocabulary can be read at once — and so a new screen has an obvious place to
 * declare what kind of thing it is. PURE, with no React Native import, so
 * `route-motion.test.ts` can check that every file in `app/` is in it: a
 * screen left out silently takes the default slide, and nothing else would
 * ever notice.
 */
export type ScreenMotion = 'sibling' | 'deeper' | 'over' | 'result' | 'none';

export const ROUTE_MOTION: Record<string, ScreenMotion> = {
  /* The four tabs are siblings. Sliding between them would claim a hierarchy
     that is not there — Customers is not "inside" Home. */
  home: 'sibling',
  journey: 'sibling',
  customers: 'sibling',
  more: 'sibling',

  /* Going into a record, or into a form about one. This is depth, and the
     slide is what makes Back feel like the reverse of it. */
  customer: 'deeper',
  visit: 'deeper',
  order: 'deeper',
  orders: 'deeper',
  pay: 'deeper',
  collections: 'deeper',
  samples: 'deeper',
  sample: 'deeper',
  tasks: 'deeper',
  leads: 'deeper',
  lead: 'deeper',
  'lead-actions': 'deeper',
  'lead-prospect': 'deeper',
  'lead-qualify': 'deeper',
  catalogue: 'deeper',
  attendance: 'deeper',
  leave: 'deeper',
  holidays: 'deeper',
  salary: 'deeper',
  expenses: 'deeper',
  travel: 'deeper',
  performance: 'deeper',
  eod: 'deeper',
  docs: 'deeper',
  knowledge: 'deeper',
  policy: 'deeper',
  profile: 'deeper',
  reports: 'deeper',
  accounts: 'deeper',
  account: 'deeper',
  journeys: 'deeper',
  nearby: 'deeper',
  maps: 'deeper',
  'phone-setup': 'deeper',
  'tracking-setup': 'deeper',

  /* Things that sit OVER the day rather than inside it. They come up from the
     bottom because that is where they go back down to. Picking a day's shops
     and taking a check call are both done ON TOP of the day and dismissed
     back down into it — neither is a place inside anything. */
  notifications: 'over',
  sync: 'over',
  rejections: 'over',
  pick: 'over',
  validate: 'over',

  /* The visit receipt is not a place you navigated to — it is what happened.
     A slide would invite Back, and there is nothing behind it to go to. */
  saved: 'result',

  /* Signing in replaces the world, and so does the first-run walkthrough it
     hands over to. */
  index: 'result',
  setup: 'result',

  /* An address this build has no screen for. It is never navigated to on
     purpose — it only catches what slipped past `isMbosRoute` — and it hands
     straight on to Home, so it should not be seen moving. */
  '+not-found': 'none',
};

export type NativeAnimation =
  | 'default' | 'fade' | 'fade_from_bottom' | 'flip' | 'simple_push'
  | 'slide_from_bottom' | 'slide_from_right' | 'slide_from_left' | 'none';

export function animationFor(motion: ScreenMotion, reduce: boolean): NativeAnimation {
  /* Reduced motion keeps the navigation legible without moving anything: a
     fade still tells you the screen changed. */
  if (reduce) return 'fade';

  switch (motion) {
    case 'sibling':
      return 'fade';
    case 'deeper':
      return 'slide_from_right';
    case 'over':
      return 'slide_from_bottom';
    case 'result':
      return 'fade';
    default:
      return 'none';
  }
}

/** Siblings cross-fade quickly; depth is allowed to take its time. */
export function durationFor(motion: ScreenMotion, reduce: boolean): number {
  if (reduce) return 120;
  return motion === 'sibling' || motion === 'result' ? 180 : 260;
}

/* ------------------------------------------------------------------ timing */

/**
 * Every duration in the app, named. Nothing animates for longer than `max`:
 * this is used one-handed in a market, and a 400 ms flourish on the four
 * hundredth order of the month is a 400 ms wait.
 */
export const DUR = { tap: 120, quick: 180, settle: 260, max: 320 } as const;

/** How many rows of a list are worth staggering. Past that the list is long, and a cascade is a wait. */
export const STAGGER_CAP = 8;
export const STAGGER_STEP_MS = 30;

export function staggerDelay(index: number): number | null {
  return index < STAGGER_CAP ? index * STAGGER_STEP_MS : null;
}
