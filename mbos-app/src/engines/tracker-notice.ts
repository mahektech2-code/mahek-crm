/**
 * WHAT TO SAY ABOUT THE TRACKER, on the one screen a salesman opens because he
 * thinks something is wrong.
 *
 * The Sync screen has carried a card about this for as long as the watchdog
 * has, and it said ONE of two things: "Your phone stopped the tracker" once it
 * had been caught, and otherwise a hypothetical — "if your route has holes in
 * it, your phone is stopping MahekOne". That second sentence is drawn on every
 * handset in the fleet, including the ones whose battery manager is provably
 * about to kill the service, because nothing on the screen was reading the one
 * answer Android will actually give.
 *
 * It will give one. `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` has a companion
 * query and the native module asks it: `exempt` or `optimised`, a real answer
 * about this phone right now. A screen that has that and prints a hypothetical
 * is burying the finding — and the finding is the whole of the production
 * incident this file sits under, where a vivo V2333 with every permission
 * reading `always` stalled two minutes after check-in.
 *
 * THE ORDER IS BY WHAT IS TRUE, NOT BY WHAT IS WORST. A stall already
 * happened and outranks a prediction that it will; a prediction from a reading
 * outranks a permission that was never granted, because a permission the app
 * can still ask for is a dialog away and this is a settings screen he has to
 * walk to. The one thing that never appears is a reassurance: there is no
 * "everything is fine" sentence here, because nothing on this phone can
 * establish that — autostart has no API on any Android, and the calm wording
 * is an offer rather than a tick.
 *
 * PURE, and an engine rather than a ternary inside the screen, for the reason
 * `cadence.ts`, `trail-watchdog.ts` and `trail-retry.ts` all give: everything
 * that reads these facts imports a native module, so a rule written beside them
 * cannot be exercised without a device.
 */

/* From the readiness engine beside it rather than from `native/phone-setup`,
   which declares the same union: that file imports the native module at module
   scope, and an engine that names it — even as a type — is one keystroke away
   from importing a value and becoming untestable. */
import type { BatteryExemption } from './phone-readiness';

/** Why the real background tracker is not running, where it is not. Mirrors
 *  `sync/trail.ts`'s own union — imported as a shape rather than from there,
 *  because that file imports expo-location at module scope. */
export type StartFailure =
  | 'unavailable'
  | 'no_foreground_permission'
  | 'no_background_permission'
  | 'registration_failed';

export type TrackerNotice = {
  /** `danger` is a thing that is wrong now. `plain` is an offer. */
  tone: 'danger' | 'plain';
  title: string;
  detail: string;
};

export function trackerNotice(i: {
  /** Has the watchdog caught this handset with an accepted, silent task? */
  stalled: boolean;
  exemption: BatteryExemption;
  failure: StartFailure | null;
}): TrackerNotice {
  /* It has already happened, which beats every prediction below. Where the
     battery manager is ALSO readably switched on, that is named — it is the
     one step with a system dialog behind it, so it is the one he can finish
     without leaving a sentence's worth of instructions behind. */
  if (i.stalled) {
    return {
      tone: 'danger',
      title: 'Your phone stopped the tracker',
      detail:
        i.exemption === 'optimised'
          ? 'Your route stopped being recorded while the app was in your pocket, and battery saving is ' +
            'still switched on for MahekOne. Two settings stop it happening again.'
          : 'Your route stopped being recorded while the app was in your pocket. Two settings stop it ' +
            'happening again.',
    };
  }

  /* A real reading about this phone, now. Not a hypothetical. */
  if (i.exemption === 'optimised') {
    return {
      tone: 'danger',
      title: 'Your phone will stop the tracker',
      detail:
        'Battery saving is switched on for MahekOne, so your phone is free to stop it the moment it ' +
        'goes in your pocket. It takes one tap to allow it.',
    };
  }

  if (i.failure === 'no_foreground_permission') {
    return {
      tone: 'danger',
      title: 'MahekOne cannot see where you are',
      detail: 'Location is not allowed for MahekOne, so nothing you do today is recorded anywhere.',
    };
  }

  if (i.failure === 'no_background_permission') {
    return {
      tone: 'danger',
      title: 'MahekOne can only see you while it is open',
      detail:
        'Following your day needs “Allow all the time”. Anything less and the trail stops the moment ' +
        'you put the phone away.',
    };
  }

  /*
   * THE OS ITSELF REFUSED, which is nobody's settings screen.
   *
   * This used to be indistinguishable from all three above and from a battery
   * manager killing an accepted task — `startBackground` answered `false` to
   * every one of them. It is the one case where walking him through switches is
   * the wrong advice, so it says so and sends him to the office instead, the
   * same shape as the dead end `phone-readiness.ts` draws.
   */
  if (i.failure === 'registration_failed') {
    return {
      tone: 'danger',
      title: 'This phone would not start the tracker',
      detail:
        'Your phone refused to start route recording, and this is not a setting you can change. Ring ' +
        'the office and tell them — your work is still being saved.',
    };
  }

  if (i.failure === 'unavailable') {
    return {
      tone: 'danger',
      title: 'This app cannot follow your route on this phone',
      detail:
        'Background route recording is not available on this handset. Your visits and orders are still ' +
        'recorded — the line on the map is what is missing. Tell the office.',
    };
  }

  /*
   * AN OFFER, AND NOT A TICK. `exempt` and `unknown` both land here, and they
   * are deliberately not distinguished: the battery half may be readable and
   * the autostart half never is, on any Android, so a phone that has done
   * everything and a phone nobody could check have exactly the same evidence
   * behind them. Drawing a green line for the first would be the app claiming
   * what it cannot know, which is the mistake the whole readiness engine exists
   * to refuse.
   */
  return {
    tone: 'plain',
    title: 'Keep tracking on',
    detail:
      'If your route has holes in it, your phone is stopping MahekOne to save battery. Two settings ' +
      'fix it.',
  };
}
