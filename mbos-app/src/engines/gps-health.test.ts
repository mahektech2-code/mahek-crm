import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gpsVerdict } from './gps-health';

/**
 * The status strip's GPS light, pinned.
 *
 * It said "Finding GPS" for the life of an installation on a handset fixing to
 * three metres every three seconds, because it read a store field written only
 * by the check-in flows — so a phone reinstalled while already checked in
 * never had it written at all. Both directions matter: a light that cannot go
 * green is ignored, and a light that goes green on no evidence is worse than
 * no light.
 */

type Args = Parameters<typeof gpsVerdict>[0];

const base: Args = {
  permitted: true,
  ageSeconds: 5,
  accuracyM: 8,
  freshSeconds: 60,
  thresholdM: 50,
};

const verdict = (over: Partial<Args>) => gpsVerdict({ ...base, ...over });

test('a recent, precise fix is locked', () => {
  assert.equal(verdict({}), 'locked');
  /* The measured reality on a real handset: 3 s apart, 3 m accurate. This is
     the case that was rendering as "Finding GPS". */
  assert.equal(verdict({ ageSeconds: 3, accuracyM: 3 }), 'locked');
  assert.equal(verdict({ ageSeconds: 60, accuracyM: 50 }), 'locked', 'the boundary is inclusive');
});

test('no permission is the only thing that reads as off', () => {
  assert.equal(verdict({ permitted: false }), 'off');
  /* NO FIX IS NOT "OFF". An empty store on a phone that has just opened means
     nothing has come back yet, and sending somebody to a settings screen where
     everything is already correct is the mistake the office-side panel records
     about permission notes. */
  assert.equal(verdict({ ageSeconds: null, accuracyM: null }), 'acquiring');
});

test('a stale or coarse fix is still acquiring, never locked', () => {
  assert.equal(verdict({ ageSeconds: 61 }), 'acquiring', 'past the freshness window');
  assert.equal(verdict({ ageSeconds: 20 * 60 }), 'acquiring');
  /* 100 m is what Balanced returns indoors, and it is exactly what the map's
     own filter discards — so the light must not call it good. */
  assert.equal(verdict({ accuracyM: 100 }), 'acquiring');
  assert.equal(verdict({ accuracyM: 51 }), 'acquiring');
});

test('missing accuracy is kept whole rather than penalised', () => {
  /* Every engine here treats absent confidence that way, and most of this
     app's history predates accuracy travelling with a fix. */
  assert.equal(verdict({ accuracyM: null }), 'locked');
});

test('a fix from the future does not light the strip', () => {
  /* A clock corrected under us. Read as age zero it would go green on no
     evidence; "still looking" is the true answer and the same direction
     `shouldKeepFix` and `trailVerdict` take. */
  assert.equal(verdict({ ageSeconds: -30 }), 'acquiring');
  assert.equal(verdict({ ageSeconds: Number.NaN }), 'acquiring');
});
