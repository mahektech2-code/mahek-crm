/**
 * What the phone does, besides draw, when something happens.
 *
 * PURE, like every engine here: the decision about whether to buzz or chime is
 * made from the event, the person's two switches and the ringer mode, all
 * passed in. `components/ui/feedback.ts` is the half that touches the
 * hardware. They are separate for the usual reason — the hardware half cannot
 * run without a phone, and the rules are where the mistakes live: a chime on a
 * phone set to silent, or a buzz on every tap until somebody turns the whole
 * thing off.
 *
 * THE VOCABULARY IS SMALL ON PURPOSE. Six kinds, and a screen names a kind,
 * never a vibration pattern or a sound file. A screen that could pick its own
 * buzz would pick a different one from the screen beside it, and a buzz only
 * means something if the same thing always feels the same.
 *
 * - `success` — it is done: a visit saved, an order taken, the day started.
 * - `warning` — it was refused, and the reason is on the screen: a check-in
 *   past the radius, a rung the gates will not open.
 * - `error`   — it did not happen: a save that failed.
 * - `select`  — a choice moved: a tab, a chip, a switch, a day on a calendar.
 * - `tap`     — a deliberate physical moment: the shutter, a sheet snapping.
 * - `arrive`  — something reached you while you were looking: a push banner.
 *
 * NOTHING ON AN ORDINARY BUTTON. The press scale already answers a press, and a
 * buzz on every button is decoration that costs battery on the cheapest phones
 * in the company — the same rule `motion.tsx` states for movement.
 */

export type FeedbackKind = 'success' | 'warning' | 'error' | 'select' | 'tap' | 'arrive';

export type HapticKind = FeedbackKind;

export type SoundName = 'ui_success' | 'ui_warning' | 'ui_error' | 'ui_arrive';

export type RingerMode = 'normal' | 'vibrate' | 'silent' | 'unknown';

export type FeedbackPrefs = {
  /** On by default — it is felt by the person holding the phone and nobody else. */
  haptics: boolean;
  /**
   * OFF by default. A salesman is standing in somebody else's shop with the
   * owner watching; a phone that chimes on every save is not something to
   * switch on for him. It is a choice he makes on Profile.
   */
  sounds: boolean;
};

export const DEFAULT_FEEDBACK_PREFS: FeedbackPrefs = { haptics: true, sounds: false };

/**
 * Only the four kinds that REPORT AN OUTCOME have a sound. A sound on a tab
 * switch or a chip would be a click track; the outcome is the only thing worth
 * hearing across a counter.
 */
const SOUND_FOR: Partial<Record<FeedbackKind, SoundName>> = {
  success: 'ui_success',
  warning: 'ui_warning',
  error: 'ui_error',
  arrive: 'ui_arrive',
};

export function plan(
  kind: FeedbackKind,
  prefs: FeedbackPrefs,
  ringer: RingerMode,
): { haptic: HapticKind | null; sound: SoundName | null } {
  /* The phone's own silent switch means silent. A vibrate setting still
     vibrates — that is what the person asked their phone to do instead of
     ringing — but silent means nothing at all, the way it does for a call. */
  const haptic = prefs.haptics && ringer !== 'silent' ? kind : null;
  /* `unknown` is read as silent: an old APK without the ringer query, or a ROM
     that refuses it. A sound held back costs nothing; a chime on a phone its
     owner silenced is the thing this exists to stop. */
  const sound = prefs.sounds && ringer === 'normal' ? (SOUND_FOR[kind] ?? null) : null;
  return { haptic, sound };
}

/**
 * Two events of the same kind inside this window are one event.
 *
 * A save raises a toast AND the screen it lands on may say so too; a list of
 * three tasks ticked fast is three taps of one hand. Buzzing twice for one act
 * reads as the phone stuttering, and the second chime of a pair is the one
 * that makes somebody switch sounds off.
 */
export const FEEDBACK_DEBOUNCE_MS = 250;

export function shouldFire(kind: FeedbackKind, last: { kind: FeedbackKind; at: number } | null, now: number): boolean {
  if (!last) return true;
  if (now < last.at) return true; // a clock that moved backwards resets rather than silences
  return !(last.kind === kind && now - last.at < FEEDBACK_DEBOUNCE_MS);
}

/* ------------------------------------------------------------ notifications */

export type NotificationTone = 'success' | 'warn' | 'info';

/**
 * How a notification's server `kind` reads on the phone.
 *
 * The server's `notifications.kind` is free text — `warn` and `warning` are
 * both in use today, and `danger` once — so this folds every spelling onto
 * three tones rather than trusting one. An unknown kind is `info`: a neutral
 * banner is never wrong, and a red one for a kind nobody mapped would be.
 */
export function toneOfNotification(kind: unknown): NotificationTone {
  const k = typeof kind === 'string' ? kind.toLowerCase() : '';
  if (k === 'warn' || k === 'warning' || k === 'danger' || k === 'rejected' || k === 'error') return 'warn';
  if (k === 'success' || k === 'accepted' || k === 'approved') return 'success';
  return 'info';
}

/** The haptic a banner of that tone arrives with. */
export function feedbackForTone(tone: NotificationTone): FeedbackKind {
  return tone === 'warn' ? 'warning' : 'arrive';
}
