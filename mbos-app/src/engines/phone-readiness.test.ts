import { test } from 'node:test';
import assert from 'node:assert/strict';

import { phoneReadiness, type ItemKey, type ReadinessInput, type Readiness } from './phone-readiness';

/**
 * The gate, pinned.
 *
 * Every assertion here is a day of somebody's work. Too strict and a working
 * handset is refused the morning; too loose and the vivo that started this
 * goes out again with the office unable to see him for eight hours. Both
 * failures are invisible from the office, which is why the rule is tested
 * rather than trusted.
 */

/** A phone with nothing wrong with it. Each test breaks exactly one thing. */
const GOOD: ReadinessInput = {
  manufacturer: 'samsung',
  locationServicesEnabled: true,
  foreground: 'granted',
  background: 'granted',
  canAskAgain: true,
  batteryExemption: 'exempt',
  previousWorkedDay: { day: '2026-09-10', hadTrail: true },
  acknowledgedAt: null,
  nowMs: Date.parse('2026-09-11T09:00:00+05:30'),
};

function item(r: Readiness, key: ItemKey) {
  const found = r.items.find((i) => i.key === key);
  assert.ok(found, `no ${key} row`);
  return found;
}

test('a phone with nothing wrong lets the day start', () => {
  const r = phoneReadiness(GOOD);
  assert.equal(r.mayCheckIn, true);
  assert.equal(r.deadEnd, false);
  /* All five rows, always — a checklist that hides the ones it is happy with
     is one nobody can read back to somebody over a phone. */
  assert.equal(r.items.length, 5);
});

test('THE VIVO, end to end — the day that recorded nothing', () => {
  /*
   * The production case. Everything reads correct: location on, both
   * permissions granted, and the phone will not even say what its battery
   * saver is doing. The only evidence is the silence of the last worked day,
   * and it is enough.
   */
  const r = phoneReadiness({
    ...GOOD,
    manufacturer: 'vivo',
    batteryExemption: 'unknown',
    previousWorkedDay: { day: '2026-09-10', hadTrail: false },
  });

  assert.equal(r.mayCheckIn, false);
  assert.equal(r.deadEnd, false, 'there is a way out of this one');

  const autostart = item(r, 'autostart');
  assert.equal(autostart.state, 'todo');
  assert.equal(autostart.action, 'autostart');
  assert.match(autostart.detail, /no movement at all/);
  /* His phone's own word, not ours. */
  assert.equal(autostart.title, 'Autostart');
  assert.match(autostart.detail, /Background power consumption management/);

  /* And the three that read fine are still drawn as fine — the block names
     one thing rather than painting the whole phone as broken. */
  assert.equal(item(r, 'location_services').state, 'ok');
  assert.equal(item(r, 'foreground').state, 'ok');
  assert.equal(item(r, 'background').state, 'ok');
});

/* ------------------------------------------------- each blocker, alone */

test('location switched off blocks on its own', () => {
  const r = phoneReadiness({ ...GOOD, locationServicesEnabled: false });
  assert.equal(r.mayCheckIn, false);
  assert.equal(r.deadEnd, false);
  assert.equal(item(r, 'location_services').state, 'todo');
  assert.equal(item(r, 'location_services').action, 'location_settings');
});

test('a location query that would not answer does NOT block', () => {
  /* Null is "we asked and got nothing", which is a different fact from "off".
     Refusing a day because one query threw would take a working handset off
     the road for no reason anybody could see. */
  const r = phoneReadiness({ ...GOOD, locationServicesEnabled: null });
  assert.equal(r.mayCheckIn, true);
  assert.equal(item(r, 'location_services').state, 'unknowable');
  assert.equal(item(r, 'location_services').action, 'location_settings');
});

test('the foreground permission blocks on its own, and asks', () => {
  for (const state of ['denied', 'undetermined'] as const) {
    const r = phoneReadiness({ ...GOOD, foreground: state });
    assert.equal(r.mayCheckIn, false, state);
    assert.equal(r.deadEnd, false, state);
    assert.equal(item(r, 'foreground').state, 'todo');
    assert.equal(item(r, 'foreground').action, 'ask_permission');
  }
});

test('“while the app is open” is not good enough, and the words say why', () => {
  const r = phoneReadiness({ ...GOOD, background: 'denied' });
  assert.equal(r.mayCheckIn, false);
  const bg = item(r, 'background');
  assert.equal(bg.state, 'todo');
  assert.match(bg.detail, /Allow all the time/);
  assert.match(bg.detail, /put the phone away/);
});

test('a readably optimised battery blocks, because one tap fixes it', () => {
  const r = phoneReadiness({ ...GOOD, batteryExemption: 'optimised' });
  assert.equal(r.mayCheckIn, false);
  assert.equal(item(r, 'battery').state, 'todo');
  assert.equal(item(r, 'battery').action, 'battery');
});

/* ------------------------------------------------------- the dead end */

test('THE DEAD END: Android will not ask again', () => {
  const r = phoneReadiness({ ...GOOD, foreground: 'denied', canAskAgain: false });
  assert.equal(r.deadEnd, true);
  assert.equal(r.mayCheckIn, false);

  const fg = item(r, 'foreground');
  assert.equal(fg.state, 'dead_end');
  /* Settings is a real page and a real fix, so it is offered. What the words
     add is the honest part: if he cannot find it, the answer is the office and
     not another tap. There is no way past, on this row or anywhere. */
  assert.equal(fg.action, 'app_settings');
  assert.match(fg.detail, /ring the/i);
  assert.ok(!/skip/i.test(fg.detail));
});

test('a dead end on the background permission is a dead end too', () => {
  const r = phoneReadiness({ ...GOOD, background: 'denied', canAskAgain: false });
  assert.equal(r.deadEnd, true);
  assert.equal(item(r, 'background').state, 'dead_end');
  /* The foreground is granted and stays drawn as granted. */
  assert.equal(item(r, 'foreground').state, 'ok');
});

test('never asked is not a dead end, whatever canAskAgain says', () => {
  /* `undetermined` with no ask left is not a state Android produces, and
     reading it as a dead end would strand a phone that has simply never been
     asked — the one case where the prompt is certain to work. */
  const r = phoneReadiness({ ...GOOD, foreground: 'undetermined', canAskAgain: false });
  assert.equal(r.deadEnd, false);
  assert.equal(item(r, 'foreground').state, 'todo');
  assert.equal(item(r, 'foreground').action, 'ask_permission');
});

/* ----------------------------------------- the acknowledgement, one day */

const SILENT = { ...GOOD, manufacturer: 'vivo', previousWorkedDay: { day: '2026-09-10', hadTrail: false } };

test('an acknowledgement unblocks EXACTLY ONE DAY, and then blocks again', () => {
  /* Wednesday recorded nothing. He is stopped on Thursday morning. */
  assert.equal(phoneReadiness(SILENT).mayCheckIn, false);

  /* He goes to the setting, comes back, says he has done it. Thursday starts. */
  const acked = {
    ...SILENT,
    acknowledgedAt: Date.parse('2026-09-11T08:40:00+05:30'),
    nowMs: Date.parse('2026-09-11T08:41:00+05:30'),
  };
  assert.equal(phoneReadiness(acked).mayCheckIn, true);
  /* And it is still not a TICK. He said so; nothing has proved it. */
  assert.equal(item(phoneReadiness(acked), 'autostart').state, 'unknowable');

  /* Thursday also recorded nothing. The same acknowledgement is now no longer
     after the failing day, and Friday is blocked. THIS is the rule: a claim
     buys one day, and only a day that produces a trail settles it. */
  const friday = {
    ...acked,
    previousWorkedDay: { day: '2026-09-11', hadTrail: false },
    nowMs: Date.parse('2026-09-12T08:40:00+05:30'),
  };
  assert.equal(phoneReadiness(friday).mayCheckIn, false);
  assert.equal(item(phoneReadiness(friday), 'autostart').state, 'todo');

  /* Thursday recorded a trail instead: nothing to answer for, and the row goes
     back to being an offer. */
  const worked = { ...friday, previousWorkedDay: { day: '2026-09-11', hadTrail: true } };
  assert.equal(phoneReadiness(worked).mayCheckIn, true);
});

test('a claim made ON the failing day does not cover it', () => {
  /* At the time it was made, nobody yet knew the day would record nothing. */
  const r = phoneReadiness({
    ...SILENT,
    acknowledgedAt: Date.parse('2026-09-10T19:00:00+05:30'),
  });
  assert.equal(r.mayCheckIn, false);
});

test('a claim dated in the future is discarded, not trusted', () => {
  /* A phone whose clock is a week ahead would otherwise stamp a claim that
     sits after every day between now and then — a gate held permanently open
     by an error, which is the one direction it must never fail in. */
  const r = phoneReadiness({
    ...SILENT,
    acknowledgedAt: Date.parse('2026-09-18T08:00:00+05:30'),
    nowMs: Date.parse('2026-09-11T08:00:00+05:30'),
  });
  assert.equal(r.mayCheckIn, false);
});

test('a corrupt acknowledgement mark cannot open the gate', () => {
  for (const bad of [Number.NaN, 0, -1]) {
    assert.equal(phoneReadiness({ ...SILENT, acknowledgedAt: bad }).mayCheckIn, false, String(bad));
  }
});

test('an acknowledgement on a phone that never failed changes nothing', () => {
  /* It is not a credit to be spent later: the row is an offer, and stays one. */
  const r = phoneReadiness({ ...GOOD, acknowledgedAt: Date.parse('2026-09-11T08:00:00+05:30') });
  assert.equal(r.mayCheckIn, true);
  assert.equal(item(r, 'autostart').state, 'unknowable');
});

test('a salesman with no worked day behind him is not stopped', () => {
  /* A new handset, or a man back from leave. There is no evidence either way,
     and a gate that fires on the absence of evidence fires on everybody. */
  const r = phoneReadiness({ ...GOOD, previousWorkedDay: null });
  assert.equal(r.mayCheckIn, true);
  assert.equal(item(r, 'autostart').state, 'unknowable');
});

/* ----------------------------------------------- unknowable is not ok */

test('UNKNOWABLE IS NEVER DRAWN AS OK, and never blocks on its own', () => {
  /* Both of the unreadable rows at once: an iPhone-shaped battery answer and
     an autostart setting no Android will report. Neither may be ticked, and
     neither may stop the day — that is the whole distinction the third state
     exists for. */
  const r = phoneReadiness({ ...GOOD, batteryExemption: 'unknown', manufacturer: null });
  assert.equal(r.mayCheckIn, true);
  assert.equal(item(r, 'battery').state, 'unknowable');
  assert.equal(item(r, 'autostart').state, 'unknowable');
  assert.ok(!r.items.some((i) => i.state === 'ok' && (i.key === 'battery' || i.key === 'autostart')));
});

test('an unreadable battery offers nothing to press, and says what to do instead', () => {
  const b = item(phoneReadiness({ ...GOOD, batteryExemption: 'unknown' }), 'battery');
  /* A button that cannot change anything is worse than no button: he presses
     it, nothing happens, and he stops believing the screen. */
  assert.equal(b.action, null);
  assert.match(b.detail, /step below/);
});

/* --------------------------------------------------- the OEM wording */

test('each phone is told its own word for the setting', () => {
  const word = (m: string | null) => item(phoneReadiness({ ...GOOD, manufacturer: m }), 'autostart');

  assert.equal(word('vivo').title, 'Autostart');
  assert.equal(word('iQOO').title, 'Autostart');
  assert.equal(word('Xiaomi').title, 'Autostart');
  assert.equal(word('Redmi').title, 'Autostart');
  assert.equal(word('POCO').title, 'Autostart');
  assert.equal(word('OPPO').title, 'Auto-launch');
  assert.equal(word('realme').title, 'Auto-launch');
  assert.equal(word('OnePlus').title, 'Battery optimisation');
  assert.equal(word('HUAWEI').title, 'App launch');
  assert.equal(word('HONOR').title, 'App launch');
  assert.equal(word('samsung').title, 'Never sleeping apps');

  /* Each one names a path on that phone rather than a generic one. */
  assert.match(word('Xiaomi').detail, /Manage apps/);
  assert.match(word('OPPO').detail, /App battery management/);
  assert.match(word('HUAWEI').detail, /Secondary launch/);
  assert.match(word('samsung').detail, /Background usage limits/);
  assert.match(word('OnePlus').detail, /Deep optimisation/);
});

test('an unknown manufacturer gets honest generic wording, never a guess', () => {
  /* A confident wrong path is worse than an admitted vague one: a man who
     cannot find "Autostart" where we said it was stops believing the rest of
     the screen too. */
  for (const m of [null, '', '   ', 'Nothing', 'Lava']) {
    const a = item(phoneReadiness({ ...GOOD, manufacturer: m }), 'autostart');
    assert.equal(a.title, 'Let MBOS run in the background', String(m));
    assert.match(a.detail, /look for Battery/);
    /* And it does not claim a menu name it cannot know. */
    assert.ok(!/Funtouch|Never sleeping|Secondary launch/.test(a.detail), String(m));
  }
});

test('the manufacturer changes the words and never the rule', () => {
  /* The same broken phone, seven badges on the back. Every one of them is
     stopped, and every one of them is stopped for the same reason. */
  const makes = ['vivo', 'Xiaomi', 'OPPO', 'realme', 'OnePlus', 'HUAWEI', 'samsung', null];
  const details = new Set<string>();
  for (const m of makes) {
    const r = phoneReadiness({ ...SILENT, manufacturer: m });
    assert.equal(r.mayCheckIn, false, String(m));
    assert.equal(item(r, 'autostart').state, 'todo', String(m));
    details.add(item(r, 'autostart').detail);
  }
  /* Eight makes, SEVEN sets of words: Oppo and Realme are one company running
     one skin, and telling a Realme owner to look for something Oppo calls
     something else would be inventing a difference the phone does not have. */
  assert.equal(details.size, 7);
});

/* ------------------------------------------------------- everything at once */

test('several things wrong at once are all listed, not just the first', () => {
  /* A checklist that reveals one fault at a time is a screen somebody walks
     through four times. */
  const r = phoneReadiness({
    ...GOOD,
    locationServicesEnabled: false,
    foreground: 'undetermined',
    background: 'undetermined',
    batteryExemption: 'optimised',
    previousWorkedDay: { day: '2026-09-10', hadTrail: false },
  });
  assert.equal(r.mayCheckIn, false);
  assert.equal(r.items.filter((i) => i.state === 'todo').length, 5);
});

test('every row carries words, and a button only where there is one to press', () => {
  const shapes: ReadinessInput[] = [
    GOOD,
    { ...GOOD, locationServicesEnabled: false },
    { ...GOOD, locationServicesEnabled: null },
    { ...GOOD, foreground: 'denied', canAskAgain: false },
    { ...GOOD, background: 'undetermined' },
    { ...GOOD, batteryExemption: 'optimised' },
    { ...GOOD, batteryExemption: 'unknown' },
    SILENT,
  ];
  for (const s of shapes) {
    for (const i of phoneReadiness(s).items) {
      assert.ok(i.title.length > 0);
      assert.ok(i.detail.length > 0);
      /* Nothing that is already right asks him to do anything. */
      if (i.state === 'ok') assert.equal(i.action, null);
      /* And nothing that needs doing is left with no way to do it. */
      if (i.state === 'todo') assert.notEqual(i.action, null);
    }
  }
});
