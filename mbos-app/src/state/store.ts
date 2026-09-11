import React from 'react';
import { create } from 'zustand';
import { useFocusEffect } from 'expo-router';
import { getKv, setKv } from '../db';
import { getCustomer, type Customer } from '../data/customers';
import { unreadCount } from '../data/notifications';
import { daysAwaitingAnswer } from '../data/journey';
import { pendingCount } from '../sync/queue';
import { isoDate } from '../lib/format';
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
   *
   * It is written down as well as held — see `rememberOffPlan` below.
   */
  offPlanReason: string | null;
  /**
   * When that sentence was typed.
   *
   * Not decoration: it is what the route screen prints beside the pending
   * reason so he can tell this morning's from one he typed an hour ago and
   * abandoned, and it is what the expiry is measured on. Written by the `set`
   * action rather than by the caller, so the two cannot disagree.
   */
  offPlanReasonAt: number | null;
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

  /**
   * Which shop the cart and the payment fields above were built for.
   *
   * See `draftMovedShop`. It is not read by any screen — it exists so the
   * store can tell "he navigated away and came back" from "he is standing in
   * a different shop", which are the two cases a draft has to answer
   * differently.
   */
  cartFor: string;

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

/**
 * A DRAFT BELONGS TO A SHOP, and it used to follow him to the next one.
 *
 * `cart`, `oQ`, `payMode`, `payAmt` and `payChq` live up here so half-finished
 * work survives NAVIGATION — he opens the customer record to check a balance
 * mid-order and comes back to his three lines. Nothing cleared them when
 * `custId` changed, so those three lines were still on the screen at the next
 * shop, priced and credit-checked against it, and the "42500" typed at one
 * counter pre-filled the amount box at the next with Collect already live. On
 * the order side it was worse than it looked: `inCart` is the cart's ids
 * resolved through the products THIS shop knows, so a line the next shop has
 * never bought vanished off the screen with its quantity still in the cart,
 * and reappeared at the shop after that.
 *
 * Changing shop clears the draft; setting the SAME id again changes nothing,
 * because that is exactly the navigation the draft exists to survive.
 */
function draftMovedShop(nextCustId: string, cartFor: string): Partial<State> {
  if (nextCustId === cartFor) return {};
  return { cartFor: nextCustId, cart: {}, oQ: '', payMode: null, payAmt: '', payChq: '' };
}

/**
 * THE OFF-PLAN REASON IS A RECORD, NOT SCREEN STATE, and it lived only here.
 *
 * It is typed on the route screen, the shop is chosen on the Customers list,
 * and the visit two screens later is what spends it — and this store is memory.
 * Android reaps this app between any two of those, so the reason was routinely
 * gone by the time the visit saved, which then wrote `deviationReason: null`
 * with nothing anywhere saying the sentence had been lost. It is the same
 * argument `travel_legs` makes about a journey in progress, one screen over: a
 * sentence somebody has typed is a record, and a record goes to SQLite.
 *
 * THE DAY IT WAS TYPED ON IS STORED WITH IT, and that is the expiry. A window
 * of minutes or hours is the DANGEROUS direction — dropping a reason he is
 * about to spend loses it exactly the way the app kill did, silently — while no
 * expiry at all is the other half of the same finding, attaching a sentence
 * about one shop to an unrelated visit next week. Within the day it is held and
 * SHOWN: the route screen draws it as pending, says when it was typed, and
 * offers to let it go.
 */
const OFF_PLAN_KEY = 'mbos.offPlanReason';

type OffPlanPending = { reason: string; at: number; day: string };

/**
 * Write the pending reason down, or rub it out. Fire and forget on purpose:
 * the reason is already in memory either way, so a failed write costs the app
 * kill and never the visit in front of him.
 */
function rememberOffPlan(reason: string | null, at: number | null): void {
  void (async () => {
    try {
      if (!reason || at == null) {
        await setKv(OFF_PLAN_KEY, '');
        return;
      }
      const pending: OffPlanPending = { reason, at, day: isoDate(new Date(at)) };
      await setKv(OFF_PLAN_KEY, JSON.stringify(pending));
    } catch {
      /* Nothing to tell him: the sentence is on the screen he is looking at. */
    }
  })();
}

/**
 * Put a reason typed before the app was killed back on the screen that took it.
 *
 * Run once at launch from `BootProvider`. A reason from an earlier day is
 * rubbed out rather than restored — a deviation is recorded against the day it
 * was made, and a Tuesday sentence arriving on Wednesday's first walk-in is the
 * leak this exists to close.
 */
export async function restoreOffPlanReason(): Promise<void> {
  try {
    /* Whatever is in hand is newer than whatever is on disk, always: the only
       way the store holds one already is that somebody typed it in this
       session. It also makes a second call do nothing, which is what a
       restore should do. */
    if (useStore.getState().offPlanReason) return;
    const raw = await getKv(OFF_PLAN_KEY);
    if (!raw) return;
    const pending = JSON.parse(raw) as OffPlanPending | null;
    if (!pending?.reason || pending.day !== isoDate(new Date())) {
      await setKv(OFF_PLAN_KEY, '');
      return;
    }
    useStore.setState({ offPlanReason: pending.reason, offPlanReasonAt: pending.at });
  } catch {
    /* A value that will not parse is one nothing can spend. It is cleared
       rather than left to be re-read and re-thrown on every launch — and the
       clearing is itself allowed to fail, because this runs at startup and
       housekeeping must never be what stops the app opening. */
    void setKv(OFF_PLAN_KEY, '').catch(() => {});
  }
}

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
  offPlanReasonAt: null,
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
  cartFor: '',

  catQ: '',

  pfSaved: {},
  pfPrefs: { wifi: true, push: true },

  /* Every screen that opens a shop does it through here — the customers list,
     the record, the map, a task, the rejections screen — so this is the one
     place that can notice the shop changed. See `draftMovedShop`. */
  set: (patch) => {
    const given = patch as Partial<State>;
    /* The off-plan reason is mirrored to the kv HERE rather than at the two
       call sites, and that placement is the whole of it: the screen that SPENDS
       the reason clears it with this same `set`, so a clear intercepted
       anywhere else would leave a spent sentence on disk to be restored onto
       the next walk-in after a kill. One door in, one door out. */
    let p = given;
    if (given.offPlanReason !== undefined) {
      const at = given.offPlanReason ? Date.now() : null;
      rememberOffPlan(given.offPlanReason, at);
      p = { ...given, offPlanReasonAt: at };
    }
    const custId = p.custId;
    set(custId !== undefined ? { ...p, ...draftMovedShop(custId, get().cartFor) } : p);
  },

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
      /* This writes `custId` through zustand's own setter rather than the
         action above, so it has to ask the same question itself — starting a
         visit at the next shop is the commonest way the cart moved. */
      ...draftMovedShop(custId, get().cartFor),
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

/**
 * Days the office has proposed and he has not answered.
 *
 * `daysAwaitingAnswer` has existed since the plan conversation was built and
 * nothing called it: the Journey screen derives its own "days to agree" list
 * from `planDays`, so the list was right and there was NOTHING ANYWHERE ELSE
 * that said to go and look at it. A plan is agreed rather than issued, and the
 * office is waiting on the answer to lay out a week — but the only way to find
 * out he had been asked was to happen to open the tab. This is what puts it on
 * the tab itself.
 */
export function useDaysToAgreeCount(): number {
  return usePolledCount(daysAwaitingAnswer);
}
