import React from 'react';
import { getKv, setKv } from '../db';
import { DEFAULT_FEEDBACK_PREFS, type FeedbackPrefs } from '../engines/feedback';

/**
 * The two switches on Profile — vibration and sounds — kept on the handset.
 *
 * PER PHONE, in the local kv, for the reason the app lock gives: whether a
 * phone buzzes is a property of the phone in a pocket rather than a company
 * policy, and it has to be answerable with no signal.
 *
 * HELD IN MEMORY TOO, because `feedback()` is called in the middle of a press
 * and must not wait on SQLite to decide whether to buzz. `loadFeedbackPrefs`
 * fills it once at boot; until then the defaults stand, which means a buzz and
 * no sound — the safe pair.
 */

const HAPTICS_KEY = 'mbos.feedback.haptics';
const SOUNDS_KEY = 'mbos.feedback.sounds';

let current: FeedbackPrefs = DEFAULT_FEEDBACK_PREFS;
const listeners = new Set<() => void>();

function publish(next: FeedbackPrefs) {
  current = next;
  listeners.forEach((l) => l());
}

/** What the switches say right now. Synchronous by design — see above. */
export function feedbackPrefs(): FeedbackPrefs {
  return current;
}

/* A stored '' is a deliberate OFF; a missing row is "never chosen", which is the default. */
function read(stored: string | null, fallback: boolean): boolean {
  return stored === null ? fallback : stored === '1';
}

export async function loadFeedbackPrefs(): Promise<FeedbackPrefs> {
  try {
    const [h, s] = await Promise.all([getKv(HAPTICS_KEY), getKv(SOUNDS_KEY)]);
    publish({ haptics: read(h, DEFAULT_FEEDBACK_PREFS.haptics), sounds: read(s, DEFAULT_FEEDBACK_PREFS.sounds) });
  } catch {
    /* No database yet — the defaults stand, and the next load will read it. */
  }
  return current;
}

export async function setFeedbackPref(key: keyof FeedbackPrefs, on: boolean): Promise<void> {
  publish({ ...current, [key]: on });
  await setKv(key === 'haptics' ? HAPTICS_KEY : SOUNDS_KEY, on ? '1' : '');
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** For the Profile switches, which have to redraw when either moves. */
export function useFeedbackPrefs(): FeedbackPrefs {
  return React.useSyncExternalStore(subscribe, feedbackPrefs, feedbackPrefs);
}
