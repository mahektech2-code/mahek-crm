import { test } from 'node:test';
import assert from 'node:assert/strict';

import { trackerNotice } from './tracker-notice';

const CLEAN = { stalled: false, exemption: 'unknown', failure: null } as const;

test('a phone with nothing known against it gets an offer, not a warning', () => {
  const n = trackerNotice({ ...CLEAN });
  assert.equal(n.tone, 'plain');
});

test('a readable battery manager is stated as a fact, not as a hypothetical', () => {
  /* The whole point: the screen had this answer available and printed "if your
     route has holes in it" on every handset regardless. */
  const n = trackerNotice({ ...CLEAN, exemption: 'optimised' });
  assert.equal(n.tone, 'danger');
  assert.match(n.title, /will stop the tracker/);
});

test('a stall outranks the prediction, and names the battery saver where it is on', () => {
  const both = trackerNotice({ stalled: true, exemption: 'optimised', failure: null });
  assert.match(both.title, /stopped the tracker/);
  assert.match(both.detail, /battery saving is still switched on/i);

  const only = trackerNotice({ stalled: true, exemption: 'exempt', failure: null });
  assert.match(only.title, /stopped the tracker/);
  assert.doesNotMatch(only.detail, /still switched on/i);
});

test('the four start failures say four different things', () => {
  const said = new Set(
    (['unavailable', 'no_foreground_permission', 'no_background_permission', 'registration_failed'] as const).map(
      (failure) => trackerNotice({ ...CLEAN, failure }).title,
    ),
  );
  assert.equal(said.size, 4, 'four causes, four cures — this used to be one sentence');
});

test('an OS that refused registration is not sent to a settings screen', () => {
  const n = trackerNotice({ ...CLEAN, failure: 'registration_failed' });
  assert.match(n.detail, /not a setting you can change/i);
  assert.match(n.detail, /office/i);
});

test('exempt is never drawn as a tick', () => {
  /* Autostart has no API on any Android, so a phone that has done everything
     and a phone nobody could check carry the same evidence. */
  const exempt = trackerNotice({ ...CLEAN, exemption: 'exempt' });
  const unknown = trackerNotice({ ...CLEAN, exemption: 'unknown' });
  assert.deepEqual(exempt, unknown);
  assert.doesNotMatch(exempt.title, /fine|all set|ready/i);
});
