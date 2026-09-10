import React from 'react';
import { create } from 'zustand';
import { useFocusEffect } from 'expo-router';
import { getCustomer, type Customer } from '../data/customers';
import { unreadCount } from '../data/notifications';
import { pendingCount } from '../sync/queue';
import type { OutcomeKey } from '../data/fixtures';

/**
 * One store, holding what the design's single `this.state` held.
 *
 * Navigation is NOT in here — expo-router owns that, so the hardware back
 * button and the gesture do the obvious thing on both platforms. What is in
 * here is everything a screen must still be true about after you have
 * navigated away and come back: the day you started, the order in your cart,
 * the photographs you took on a visit you have not saved yet.
 *
 * Nothing here talks to a network, and nothing here IS the data. Every list,
 * figure and record comes from SQLite through `src/data/*`; what this holds is
 * the half-finished work a screen must still be true about after you have
 * navigated away — which customer you are looking at, what is in the cart, the
 * photographs you took on a visit you have not saved yet.
 */

export type GpsState = 'acquiring' | 'locked' | 'off';
/**
 * What became of the spoken half of a visit note.
 *
 * It replaced a five-value recorder state — idle, rec, busy, done, failed —
 * which was a state MACHINE living in global storage while the machine itself
 * lived on the screen. Two of the five were unreachable: nothing ever set
 * `done`, so the "AI transcribed" badge it drew could not appear, and a
 * successful recording set `failed`, so the visit-saved screen reported a
 * voice note that had uploaded perfectly as one still waiting for signal.
 *
 * These three are facts about the visit rather than steps of a recording, so
 * there is nothing here for a screen to leave stale. `dictated` means the
 * words are in the note already and the audio goes with it; `queued` means
 * there was no signal, the audio goes, and the office writes it out.
 */
export type VoiceState = 'none' | 'dictated' | 'queued';
export type LoginMethod = 'password' | 'otp';
/** `leadForm` is asked for on one screen and answered on another — the `+`
 *  sheet offers "Add lead" from anywhere, and the Leads screen opens the form
 *  as it arrives rather than making him find the button again. */
export type SheetKind = 'action' | 'journeyMore' | 'filters' | 'rowMore' | 'leadForm' | null;
export type FormKind = 'complaint' | 'sample' | null;

export type Confirm = {
  title: string;
  body: string;
  reasonLabel?: string;
  confirmLabel: string;
  run: (reason: string) => void;
} | null;

type State = {
  /* ---- session ---- */
  signedIn: boolean;
  method: LoginMethod;
  mob: string;
  pw: string;
  dial: string;
  remember: boolean;

  /* ---- the day ---- */
  checkedIn: boolean;
  gps: GpsState;

  /* ---- transient chrome ---- */
  toast: string | null;
  sheet: SheetKind;
  confirm: Confirm;
  confirmReason: string;
  confirmErr: boolean;

  /* ---- customers ---- */
  custQ: string;
  custId: string;
  pTab: number;
  tlFilter: string;

  /* ---- the visit being captured ---- */
  /** Media ids, not flags — the photograph is queued the moment it is taken,
   *  long before the visit it will belong to exists. */
  shots: { shop?: string; cust?: string };
  voice: VoiceState;
  note: string;
  outcome: OutcomeKey | null;
  nextDate: string;
  visitStart: number | null;
  /**
   * The shop he has just pressed "Start visit" on, waiting for the question
   * that comes before the visit: how is he getting there.
   *
   * Store state and not a route, because the answer is a CAMERA on the metered
   * modes and pushing a screen would take the flow off the stack half-way
   * through — the same reason `askConfirm` and the selfie camera are overlays.
   * `TravelGate` in `AppFrame` is the one place it is answered, which is what
   * lets all four Start-visit buttons ask by setting one field.
   */
  travelTo: { customerId: string; customerName: string } | null;
  visitSpent: string | null;
  /**
   * Why the next visit is off the plan.
   *
   * Set on the route screen, spent by the visit. It has to live here rather
   * than travel as a route param because the two are separated by a THIRD
   * screen — the reason is given on the route, the shop is chosen on the
   * Customers list, and the visit is where both arrive. `visits` has carried
   * `deviationReason` and `wasPlanned` since it was written and the handset
   * sent null for the first of them on every visit ever logged; the button
   * that was supposed to fill it raised a toast and wrote nothing, on a screen
   * whose own words are "your manager sees the reason".
   */
  offPlanReason: string | null;
  /** What this visit has already produced, so returning to it shows the work is done. */
  visitDone: Partial<Record<OutcomeKey, string>>;
  overrodeReason: string | null;
  form: FormKind;
  formDraft: Record<string, string>;
  formErr: string | null;

  /* ---- order ---- */
  cart: Record<string, string>;
  oQ: string;

  /* ---- payment ---- */
  payMode: string | null;
  payAmt: string;
  payChq: string;

  /* ---- people ---- */
  catQ: string;

  /* ---- profile ---- */
  pfSaved: Record<string, string>;
  pfPrefs: { wifi: boolean; push: boolean };
};

type Actions = {
  set: <K extends keyof State>(patch: Pick<State, K> | Partial<State>) => void;
  notify: (msg: string) => void;
  clearToast: () => void;
  signIn: () => void;
  signOut: () => void;
  startDay: () => void;
  beginVisit: (custId: string) => void;
  askTravel: (to: { customerId: string; customerName: string }) => void;
  arrivedAt: (at: number) => void;
  markVisitDone: (k: OutcomeKey, line: string) => void;
  setQty: (skuId: string, qty: string) => void;
  dropLine: (skuId: string) => void;
  askConfirm: (c: NonNullable<Confirm>) => void;
  closeConfirm: () => void;
};

/**
 * The follow-up date starts EMPTY, not on a guessed day.
 *
 * The visit screen fills it from the customer's own measured buying cycle the
 * moment the record is read — a date baked in here would be the same day for a
 * shop that reorders weekly and one that reorders quarterly.
 */
const NO_DATE_YET = '';

export const useStore = create<State & Actions>((set, get) => ({
  signedIn: false,
  method: 'password',
  mob: '',
  pw: '',
  dial: '+91',
  remember: true,

  checkedIn: false,
  gps: 'acquiring',

  toast: null,
  sheet: null,
  confirm: null,
  confirmReason: '',
  confirmErr: false,

  custQ: '',
  custId: '',
  pTab: 0,
  tlFilter: 'All',

  shots: {},
  voice: 'none',
  note: '',
  outcome: null,
  nextDate: NO_DATE_YET,
  visitStart: null,
  travelTo: null,
  visitSpent: null,
  offPlanReason: null,
  visitDone: {},
  overrodeReason: null,
  form: null,
  formDraft: {},
  formErr: null,

  cart: {},
  oQ: '',

  payMode: null,
  payAmt: '',
  payChq: '',

  catQ: '',

  pfSaved: {},
  pfPrefs: { wifi: true, push: true },

  set: (patch) => set(patch as Partial<State>),

  notify: (msg) => set({ toast: msg }),
  clearToast: () => set({ toast: null }),

  signIn: () => set({ signedIn: true }),

  /**
   * Signing out keeps the day, the cart and the queue exactly where they were.
   * The design says four records have not been sent yet and that they stay on
   * this phone — clearing them here would make that sentence a lie.
   */
  signOut: () => set({ signedIn: false, pw: '' }),

  startDay: () => set({ checkedIn: true, gps: 'locked' }),

  beginVisit: (custId) =>
    set({
      custId,
      gps: 'acquiring',
      shots: {},
      voice: 'none',
      note: '',
      outcome: null,
      nextDate: NO_DATE_YET,
      /*
       * NOT `Date.now()` any more, and that is the whole shape of the change.
       *
       * "Start visit" used to mean "I am standing in the shop", so the dwell
       * clock began here. It now means "I am setting off" — the mode is asked,
       * the meter is photographed, and the journey happens between this moment
       * and the arrival. Starting the clock here would count the ride as time
       * in the shop, which is the one number the dwell check exists to be
       * honest about. `arrivedAt` sets it.
       */
      visitStart: null,
      visitSpent: null,
      visitDone: {},
      overrodeReason: null,
      sheet: null,
      /* `offPlanReason` is deliberately NOT reset here. It is set on the route
         screen BEFORE the shop is chosen, and choosing the shop is what calls
         this — clearing it would throw away the reason on the way to the very
         visit it was written for. The visit clears it once, on save. */
    }),

  askTravel: (to) => set({ travelTo: to }),

  /**
   * He is at the shop. The dwell clock starts HERE and nowhere else.
   *
   * It takes the arrival instant rather than reading the clock itself, because
   * the caller has already written that instant onto the leg — two readings of
   * `Date.now()` a few lines apart would put the record and the screen a
   * second or two out of step for no reason anybody could later explain.
   */
  arrivedAt: (at) => set({ visitStart: at, travelTo: null }),

  markVisitDone: (k, line) => set({ visitDone: { ...get().visitDone, [k]: line } }),

  setQty: (skuId, qty) => set({ cart: { ...get().cart, [skuId]: qty } }),
  dropLine: (skuId) => {
    const next = { ...get().cart };
    delete next[skuId];
    set({ cart: next });
  },

  askConfirm: (c) => set({ confirm: c, confirmReason: '', confirmErr: false }),
  closeConfirm: () => set({ confirm: null, confirmReason: '', confirmErr: false }),
}));

/**
 * The customer every screen means when it says "the customer".
 *
 * It is a read of the local store rather than a lookup in a list held in
 * memory, which is why it can be null: a handset that has not bootstrapped has
 * no book yet, and a screen that assumed one would render somebody else's
 * figures under this customer's name.
 */
export function useCustomer(): Customer | null {
  const id = useStore((s) => s.custId);
  const [row, setRow] = React.useState<Customer | null>(null);

  useFocusEffect(
    React.useCallback(() => {
      let live = true;
      if (!id) {
        setRow(null);
        return;
      }
      void getCustomer(id).then((c) => {
        if (live) setRow(c);
      });
      return () => {
        live = false;
      };
    }, [id]),
  );

  return row;
}

/**
 * A count polled from the local store.
 *
 * The bell and the status strip sit on every screen, so they cannot wait for a
 * focus event on a screen that never re-focuses. Ten seconds is slower than a
 * write and far cheaper than a subscription over a table we do not otherwise
 * observe.
 */
function usePolledCount(read: () => Promise<number>, everyMs = 10_000): number {
  const [n, setN] = React.useState(0);

  React.useEffect(() => {
    let live = true;
    const tick = () => {
      void read().then((v) => {
        if (live) setN(v);
      });
    };
    tick();
    const t = setInterval(tick, everyMs);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [read, everyMs]);

  return n;
}

export function useUnreadCount(): number {
  return usePolledCount(unreadCount);
}

/** The status strip's third cell, and the More list's Sync badge, read this. */
export function usePendingCount(): number {
  return usePolledCount(pendingCount);
}
