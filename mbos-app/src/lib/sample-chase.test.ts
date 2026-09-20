import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  chaseCountSentence,
  chaseOffsetDays,
  chaseRepeatDays,
  chaseSchedule,
  nextChaseSentence,
} from './sample-chase';

const LADDER = [2, 4, 6];
const iso = (s: string) => s;

test('the named rungs are the configured days, counted from receipt', () => {
  assert.equal(chaseOffsetDays(LADDER, 1), 2);
  assert.equal(chaseOffsetDays(LADDER, 2), 4);
  assert.equal(chaseOffsetDays(LADDER, 3), 6);
});

test('the LAST interval repeats — the ladder does not stop', () => {
  /* §16's whole point: a trial nobody reviewed is stock given away for
     nothing, so ask four is two days after ask three and so on for ever. */
  assert.equal(chaseOffsetDays(LADDER, 4), 8);
  assert.equal(chaseOffsetDays(LADDER, 5), 10);
  assert.equal(chaseOffsetDays(LADDER, 20), 40);
  assert.equal(chaseRepeatDays(LADDER), 2);
});

test('a ladder typed backwards steps forward by a day rather than into the past', () => {
  assert.equal(chaseOffsetDays([6, 2], 3), 3);
  assert.equal(chaseRepeatDays([6, 2]), 1);
});

test('nothing configured means asking daily rather than never', () => {
  assert.equal(chaseOffsetDays([], 3), 3);
  assert.equal(chaseRepeatDays([]), 1);
});

test('a day is added through the date parts, not by adding milliseconds', () => {
  assert.equal(addDays('2026-02-27', 2), '2026-03-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('nothing is chased until the SHOP says it has arrived', () => {
  /* Dispatch and delivery are two other parties asserting two other things.
     A review timed from either rings a customer still waiting for the parcel. */
  const s = chaseSchedule({ receivedOn: null, asked: 2, chaseDays: LADDER, today: '2026-09-20' });
  assert.equal(s.startedOn, null);
  assert.deepEqual(s.rungs, []);
  assert.equal(s.nextDayOn, null);
  assert.equal(nextChaseSentence(s, iso), null);
});

test('the office count marks which rungs have gone, and names the next ask', () => {
  const s = chaseSchedule({ receivedOn: '2026-09-10', asked: 3, chaseDays: LADDER, today: '2026-09-20' });
  assert.deepEqual(
    s.rungs.map((r) => [r.ask, r.dueOn, r.asked, r.duePassed]),
    [
      [1, '2026-09-12', true, true],
      [2, '2026-09-14', true, true],
      [3, '2026-09-16', true, true],
    ],
  );
  assert.equal(s.nextAsk, 4);
  assert.equal(s.nextAskDueOn, '2026-09-18');
  assert.equal(s.beyondLadder, 0);
});

test('asks past the ladder are counted, never listed', () => {
  const s = chaseSchedule({ receivedOn: '2026-08-01', asked: 9, chaseDays: LADDER, today: '2026-09-20' });
  assert.equal(s.rungs.length, 3, 'the checklist stays the named ladder');
  assert.equal(s.beyondLadder, 6);
  assert.equal(s.nextAsk, 10);
  assert.match(nextChaseSentence(s, iso) ?? '', /Ask 10/);
  assert.match(nextChaseSentence(s, iso) ?? '', /every 2 days until they answer/);
});

test('NO COUNT is not a count of zero', () => {
  /* The wire does not carry `review_chase_count`, so the handset genuinely
     does not know. Drawing that as "not asked yet" would reassure a salesman
     that nothing has been chased on a sample the office has rung about three
     times — which is the opposite of what this screen is for. */
  const s = chaseSchedule({ receivedOn: '2026-09-10', asked: null, chaseDays: LADDER, today: '2026-09-20' });
  assert.equal(s.asked, null);
  assert.equal(s.beyondLadder, null);
  assert.equal(s.nextAsk, null);
  assert.equal(s.nextAskDueOn, null);
  for (const r of s.rungs) assert.equal(r.asked, null, 'no rung claims to have gone or not gone');
  assert.equal(chaseCountSentence(null), 'This phone has not been told how many times the office has asked');
  assert.notEqual(chaseCountSentence(null), chaseCountSentence(0));
});

test('the calendar still answers when the count does not', () => {
  /* The days a ladder falls on are arithmetic off the receipt date, so a
     handset that has been told nothing can still say which days have gone by
     and when the next one lands. */
  const s = chaseSchedule({ receivedOn: '2026-09-17', asked: null, chaseDays: LADDER, today: '2026-09-20' });
  assert.deepEqual(s.rungs.map((r) => r.duePassed), [true, false, false]);
  assert.equal(s.nextDayOn, '2026-09-21');
});

test('the next day is worked out past the tail rather than walked', () => {
  const s = chaseSchedule({ receivedOn: '2025-09-20', asked: null, chaseDays: LADDER, today: '2026-09-20' });
  assert.ok(s.nextDayOn && s.nextDayOn > '2026-09-20');
  assert.equal(s.nextDayOn, addDays('2026-09-20', 1));
});

test('a corrupted count cannot put the next ask in the past', () => {
  const s = chaseSchedule({ receivedOn: '2026-09-10', asked: -4, chaseDays: LADDER, today: '2026-09-20' });
  assert.equal(s.asked, 0);
  assert.equal(s.nextAsk, 1);
  assert.equal(s.nextAskDueOn, '2026-09-12');
});

test('the count is said in words, and one, two and three read differently', () => {
  assert.equal(chaseCountSentence(0), 'Not asked yet');
  assert.equal(chaseCountSentence(1), 'Asked once');
  assert.equal(chaseCountSentence(2), 'Asked twice');
  assert.equal(chaseCountSentence(3), 'Asked 3 times');
});
