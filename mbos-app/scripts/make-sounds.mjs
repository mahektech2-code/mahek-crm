/**
 * Writes every sound MBOS plays, from arithmetic.
 *
 * SYNTHESISED RATHER THAN DOWNLOADED, so there is no licence to keep track of
 * and nothing to ask anybody's permission about: the files are what this script
 * writes, and changing one is an edit here followed by `node scripts/make-sounds.mjs`.
 * The WAVs are committed beside it, because the bundler and the notification
 * plugin both want a file on disk and neither should need this to run.
 *
 * Two families with two jobs:
 *
 * - `ui_*` are played INSIDE the app by `components/ui/feedback.ts` — confirming
 *   something the person just did. Short (under 300 ms), soft, and at −12 dBFS,
 *   because they are heard at arm's length in a shop with a customer listening.
 * - `mbos_*` are NOTIFICATION sounds, compiled into the APK by the
 *   expo-notifications plugin (app.json) and named by the Android channels in
 *   `native/push.ts`. Louder (−6 dBFS) and a little longer, because they have to
 *   be heard from a pocket. Android resource names allow only [a-z0-9_].
 *
 * 22.05 kHz, 16-bit, mono: every one of these is a few sine partials, and a
 * higher rate would only make the files bigger.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RATE = 22050;
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'sounds');

/** One struck note: a fundamental and a quieter octave, with a quick attack and an exponential tail. */
function note(freq, ms, { decay = 6, harmonic = 0.25, attackMs = 4 } = {}) {
  const n = Math.round((RATE * ms) / 1000);
  const attack = Math.round((RATE * attackMs) / 1000);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const env = (i < attack ? i / attack : 1) * Math.exp((-decay * i) / n);
    out[i] = env * (Math.sin(2 * Math.PI * freq * t) + harmonic * Math.sin(2 * Math.PI * freq * 2 * t));
  }
  return out;
}

/** Notes laid end to end, each starting `gapMs` after the previous one starts, and allowed to ring over the next. */
function sequence(notes, gapMs) {
  const step = Math.round((RATE * gapMs) / 1000);
  const total = step * (notes.length - 1) + Math.max(...notes.map((x) => x.length));
  const out = new Float32Array(total);
  notes.forEach((x, k) => {
    for (let i = 0; i < x.length; i++) out[k * step + i] += x[i];
  });
  return out;
}

function normalise(samples, dbfs) {
  const peak = samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
  const gain = Math.pow(10, dbfs / 20) / peak;
  /* A 5 ms fade at the very end, so a tail that has not quite reached zero does not click. */
  const fade = Math.round(RATE * 0.005);
  return samples.map((v, i) => v * gain * (i > samples.length - fade ? (samples.length - i) / fade : 1));
}

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2));
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

const SOUNDS = {
  /* A rising fifth: done, and it went the way you meant. */
  ui_success: normalise(sequence([note(659.25, 120), note(987.77, 200)], 70), -12),
  /* Two level notes, the second a step down: check this. Not alarming. */
  ui_warning: normalise(sequence([note(783.99, 110), note(659.25, 170)], 110), -12),
  /* A falling minor third, lower and drier: it did not happen. */
  ui_error: normalise(sequence([note(392.0, 120, { harmonic: 0.45 }), note(329.63, 200, { harmonic: 0.45 })], 120), -12),
  /* One soft bell: something arrived while you were looking. */
  ui_arrive: normalise(note(1046.5, 260, { decay: 5, harmonic: 0.35 }), -14),

  /* Notification sounds — heard from a pocket. */
  /* A decision that needs you: three notes, rising then settling, firm. */
  mbos_alert: normalise(
    sequence([note(659.25, 180, { harmonic: 0.4 }), note(880.0, 180, { harmonic: 0.4 }), note(783.99, 380, { harmonic: 0.4 })], 140),
    -6,
  ),
  /* Something worth knowing: a two-note chime. */
  mbos_update: normalise(sequence([note(880.0, 220, { decay: 5 }), note(1318.51, 420, { decay: 5 })], 150), -8),
};

for (const [name, samples] of Object.entries(SOUNDS)) {
  const file = join(OUT, `${name}.wav`);
  writeFileSync(file, wav(samples));
  console.log(`${name}.wav  ${(samples.length / RATE).toFixed(2)}s`);
}
