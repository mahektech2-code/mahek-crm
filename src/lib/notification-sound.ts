"use client";

import type { NotifyTone } from "./notification-feed";

/* ---------------------------------------------------------------------------
 * THE CHIME, SYNTHESISED — no audio file, so nothing to license, cache or 404.
 *
 * A browser refuses to make a sound until the page has had a gesture, so the
 * AudioContext is created and resumed on the first click or key press
 * (`primeAudio`, wired by NotificationCenter). A telecaller has always pressed
 * something by the time a notification arrives; on a tab nobody has touched
 * the chime is silently skipped and the pop-up still appears.
 *
 * Each tone has its own phrase, so a decline is heard as different from a
 * reminder without anybody looking up: two rising notes for news, a third on
 * top for good news, and a lower falling pair for something that went wrong.
 * ------------------------------------------------------------------------- */

let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (ctx) return ctx;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    ctx = null;
  }
  return ctx;
}

/** Called from a real gesture: this is the moment a browser lets audio start. */
export function primeAudio() {
  const c = context();
  if (c && c.state === "suspended") void c.resume().catch(() => {});
}

const PHRASES: Record<NotifyTone, [number, number][]> = {
  // [frequency Hz, start offset s]
  info: [[880, 0], [1318.5, 0.13]],
  success: [[784, 0], [1046.5, 0.11], [1568, 0.22]],
  warn: [[987.8, 0], [987.8, 0.18]],
  danger: [[659.3, 0], [493.9, 0.17]],
};

export function playChime(tone: NotifyTone = "info", volume = 0.16) {
  const c = context();
  if (!c) return;
  if (c.state === "suspended") {
    // Outside a gesture this usually stays suspended; that is fine, the
    // pop-up carries the news on its own.
    void c.resume().catch(() => {});
    if (c.state === "suspended") return;
  }
  const t0 = c.currentTime + 0.01;
  const master = c.createGain();
  master.gain.value = volume;
  master.connect(c.destination);
  for (const [freq, at] of PHRASES[tone]) {
    const start = t0 + at;
    const osc = c.createOscillator();
    const overtone = c.createOscillator();
    const env = c.createGain();
    osc.type = "sine";
    overtone.type = "triangle";
    osc.frequency.value = freq;
    overtone.frequency.value = freq * 2;
    const over = c.createGain();
    over.gain.value = 0.12;
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(1, start + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, start + 0.42);
    osc.connect(env);
    overtone.connect(over).connect(env);
    env.connect(master);
    osc.start(start);
    overtone.start(start);
    osc.stop(start + 0.45);
    overtone.stop(start + 0.45);
  }
}
