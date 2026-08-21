import { getKv } from '../db';
import { getConfig } from '../data/config';
import { getFix, type Fix } from './location';

/**
 * Where the salesman is, for anything he records.
 *
 * Every activity in MBOS carries the place it happened — an order taken at a
 * shop, a payment collected at a counter, a complaint raised in a godown. Four
 * things used to: visits, leads, the check-in and the trail. This is what
 * covers the rest.
 *
 * Three rules, and they are the whole design.
 *
 * **It NEVER delays a save.** A fix takes up to ten seconds and a save takes
 * none, so this does not wait for one — it answers from the freshest position
 * already known and says how old that is. Blocking a write on the radio would
 * trade the thing that matters, the record, for the thing that decorates it,
 * and on a phone indoors it would trade it for nothing at all.
 *
 * **Age is part of the reading, exactly as accuracy is.** A fix from four
 * minutes ago is evidence of where somebody was standing; one from four hours
 * ago is evidence of nothing. Both are stored, both carry their age, and it is
 * the screen that decides what to call stale — dropping the older one would
 * throw away a fact to avoid having to explain it.
 *
 * **It costs no battery.** While the day is open the trail is already taking a
 * fix every few minutes, and that is what nearly every activity uses. The only
 * time this asks the radio for anything is a background top-up AFTER the save
 * has returned, so the next act has something fresh.
 */

export type Where = {
  lat?: number | null;
  lng?: number | null;
  accuracyM?: number | null;
  /** When the FIX was taken, epoch ms. */
  capturedAt?: number | null;
  /** Its age at the moment of the act. */
  ageSeconds?: number | null;
  source?: 'fresh' | 'trail' | null;
  reason?: 'denied' | 'unavailable' | 'off' | null;
};

/* Written by `getFix`, in the one function that talks to the radio — so the
   trail, the visit screen and the check-in all feed this without knowing. */
const LAST_FIX = 'lastFix';

async function lastFix(): Promise<Fix | null> {
  const raw = await getKv(LAST_FIX);
  if (!raw) return null;
  try {
    const fix = JSON.parse(raw) as Fix;
    return typeof fix?.lat === 'number' && typeof fix?.lng === 'number' ? fix : null;
  } catch {
    return null;
  }
}

/**
 * The answer, immediately.
 *
 * `undefined` rather than a reason where the office has switched this off — no
 * field on the wire at all, so nothing is stored and the server has nothing to
 * decline. A `reason` means we tried: a screen can tell "asked and could not"
 * from "never asked", which are different facts about a salesman's day.
 */
export async function whereNow(): Promise<Where | undefined> {
  const on = await getConfig<boolean>('mbos.location.logActivityLocation', true);
  if (!on) return undefined;

  const fix = await lastFix();
  if (!fix) {
    /* Nothing known yet. Ask in the background so the next one has something,
       and record honestly that this one has nothing. */
    void topUp();
    return { reason: 'unavailable' };
  }

  const ageSeconds = Math.max(0, Math.round((Date.now() - fix.at) / 1000));

  /* The top-up is deliberately AFTER the answer is composed, and not awaited:
     it improves the next activity, never this one. */
  void topUp();

  return {
    lat: fix.lat,
    lng: fix.lng,
    accuracyM: fix.accuracyM,
    capturedAt: fix.at,
    ageSeconds,
    /* Anything under a minute was taken for this act in all but name — the
       visit screen's own fix, or a trail tick seconds ago. */
    source: ageSeconds <= 60 ? 'fresh' : 'trail',
  };
}

/* Only one in flight, and never more than one a minute: a burst of writes — an
   order, its payment and a task, saved in the same breath — must not become
   three simultaneous calls to the radio. */
let topping = false;
let toppedAt = 0;

async function topUp(): Promise<void> {
  if (topping || Date.now() - toppedAt < 60_000) return;
  topping = true;
  try {
    /* `getFix` remembers it for us — that is the whole point of it living
       there. Nothing to write back here. */
    await getFix({ accuracyThresholdM: 100, timeoutMs: 12_000 });
    toppedAt = Date.now();
  } catch {
    /* No fix, no permission, no radio. There is nothing to tell anybody and
       nothing for them to do about it. */
  } finally {
    topping = false;
  }
}
