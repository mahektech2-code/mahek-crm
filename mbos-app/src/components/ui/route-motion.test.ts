import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { animationFor, durationFor, DUR, ROUTE_MOTION, staggerDelay, STAGGER_CAP } from './route-motion';

const ROOT = join(import.meta.dirname, '..', '..', '..');

test('every screen declares what kind of move reaches it', () => {
  const screens = readdirSync(join(ROOT, 'app'))
    .filter((f) => f.endsWith('.tsx') && !f.startsWith('_'))
    .map((f) => f.replace(/\.tsx$/, ''));
  const missing = screens.filter((s) => !(s in ROUTE_MOTION));
  assert.deepEqual(missing, [], `add these to ROUTE_MOTION in route-motion.ts: ${missing.join(', ')}`);
  const stale = Object.keys(ROUTE_MOTION).filter((k) => !screens.includes(k));
  assert.deepEqual(stale, [], `ROUTE_MOTION names screens that no longer exist: ${stale.join(', ')}`);
});

test('reduced motion turns every move into a short fade', () => {
  for (const m of ['sibling', 'deeper', 'over', 'result'] as const) {
    assert.equal(animationFor(m, true), 'fade');
    assert.ok(durationFor(m, true) <= DUR.tap);
  }
});

test('no screen move outlasts the ceiling', () => {
  for (const m of ['sibling', 'deeper', 'over', 'result'] as const) assert.ok(durationFor(m, false) <= DUR.max);
});

test('a stagger stops after the first rows rather than cascading down a long list', () => {
  assert.equal(staggerDelay(0), 0);
  assert.ok((staggerDelay(STAGGER_CAP - 1) ?? 0) <= DUR.settle);
  assert.equal(staggerDelay(STAGGER_CAP), null);
});

/**
 * The motor and the speaker have one door each. A screen that imports
 * expo-haptics directly picks its own buzz, and the vocabulary in
 * `engines/feedback.ts` stops meaning anything.
 */
test('haptics and UI sound are reached only through components/ui', () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.ts$/.test(e.name)) {
        const rel = relative(ROOT, p);
        if (rel.startsWith(join('src', 'components', 'ui'))) continue;
        const src = readFileSync(p, 'utf8');
        if (/from ['"]expo-haptics['"]/.test(src)) offenders.push(rel);
        if (/createAudioPlayer|useAudioPlayer\(/.test(src)) offenders.push(rel);
      }
    }
  };
  walk(join(ROOT, 'app'));
  walk(join(ROOT, 'src'));
  assert.deepEqual(offenders, [], 'call feedback() from components/ui/feedback.ts instead');
});
