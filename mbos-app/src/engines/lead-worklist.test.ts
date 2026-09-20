import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  countLeads,
  dayOf,
  dueToday,
  missingAnswers,
  nothingOwed,
  onHold,
  overdue,
  rowsFor,
  stillWorking,
  type WorklistLead,
} from './lead-worklist';

/**
 * §24 on the phone, pinned.
 *
 * Every case below is one somebody would otherwise find out about on a
 * morning: a park that never reads back, a legacy lead that can never leave a
 * worklist, a thorough next action that hides its own lead from Overdue. None
 * of them fails loudly — each just quietly makes a list wrong — which is
 * exactly the kind of rule that has to be held by a test rather than by a
 * reading of the screen.
 */

const TODAY = '2026-09-20';

function lead(over: Partial<WorklistLead> = {}): WorklistLead {
  return {
    name: 'Balaji Paints',
    archived: 0,
    stage: 'New',
    funnelStage: 'negotiation',
    nextAction: null,
    nextActionDate: null,
    nextActionOwnerId: null,
    nextActionOutcome: null,
    holdResumeDate: null,
    lastActivityDate: '2026-09-01',
    ...over,
  };
}

test('a promise falling today is owed today, and yesterday’s is late', () => {
  assert.equal(dueToday(lead({ nextActionDate: TODAY }), TODAY), true);
  assert.equal(overdue(lead({ nextActionDate: TODAY }), TODAY), false);
  assert.equal(overdue(lead({ nextActionDate: '2026-09-19' }), TODAY), true);
  assert.equal(dueToday(lead({ nextActionDate: '2026-09-21' }), TODAY), false);
});

test('an expected outcome does NOT hide a lead from Overdue', () => {
  /* The column on this phone holds what he expects to come back with, written
     in the same breath as the action — so reading it as "somebody answered
     this" would exclude exactly the leads that were planned most carefully. */
  assert.equal(
    overdue(lead({ nextActionDate: '2026-09-10', nextActionOutcome: 'a quantity' }), TODAY),
    true,
  );
});

test('a park reads back on its own day, and is late once it has gone', () => {
  const parked = (resume: string) =>
    lead({ funnelStage: 'on_hold', holdResumeDate: resume, nextActionDate: null });
  assert.equal(dueToday(parked(TODAY), TODAY), true);
  assert.equal(overdue(parked('2026-09-05'), TODAY), true);
  assert.equal(dueToday(parked('2026-10-01'), TODAY), false);
  assert.equal(overdue(parked('2026-10-01'), TODAY), false);
});

test('a park reads its resume date and a promise reads its action date', () => {
  assert.equal(dayOf(lead({ nextActionDate: '2026-09-25' })), '2026-09-25');
  assert.equal(
    dayOf(lead({ funnelStage: 'on_hold', holdResumeDate: '2026-10-02', nextActionDate: '2026-09-25' })),
    '2026-10-02',
  );
});

test('a park is never counted as a lead nobody is holding', () => {
  /* Somebody DID decide something about it — they decided to stop, and named
     the day it comes back. Folding it into "nothing owed" would send a
     salesman to set a next action on a lead he deliberately put away. */
  const parked = lead({ funnelStage: 'on_hold', holdResumeDate: '2026-10-02' });
  assert.equal(nothingOwed(parked), false);
  assert.equal(onHold(parked), true);
});

test('a legacy lead is still work, and finishes on its own vocabulary', () => {
  /* No rung at all. Reading only `funnelStage` would leave every lead raised
     before the funnel on every worklist for ever, because nothing would ever
     call one terminal. */
  assert.equal(stillWorking(lead({ funnelStage: null, stage: 'Contacted' })), true);
  assert.equal(stillWorking(lead({ funnelStage: null, stage: 'Converted' })), false);
  assert.equal(stillWorking(lead({ funnelStage: null, stage: 'Lost' })), false);
  assert.equal(onHold(lead({ funnelStage: null, stage: 'On hold' })), true);
});

test('a terminal rung and an archived lead are off every view', () => {
  assert.equal(stillWorking(lead({ funnelStage: 'customer' })), false);
  assert.equal(stillWorking(lead({ funnelStage: 'won' })), false);
  assert.equal(stillWorking(lead({ funnelStage: 'lost' })), false);
  assert.equal(dueToday(lead({ archived: 1, nextActionDate: TODAY }), TODAY), false);
});

test('the counts and the rows are the same answer', () => {
  const book: WorklistLead[] = [
    lead({ name: 'A', nextActionDate: TODAY }),
    lead({ name: 'B', nextActionDate: '2026-09-02' }),
    lead({ name: 'C', nextActionDate: '2026-09-11' }),
    lead({ name: 'D', funnelStage: 'on_hold', holdResumeDate: '2026-11-01' }),
    lead({ name: 'E' }),
    lead({ name: 'F', funnelStage: 'customer' }),
  ];
  const counts = countLeads(book, TODAY);
  assert.equal(counts.working, 5);
  assert.equal(counts.today, rowsFor(book, 'today', TODAY).length);
  assert.equal(counts.overdue, rowsFor(book, 'overdue', TODAY).length);
  assert.equal(counts.parked, rowsFor(book, 'parked', TODAY).length);
  assert.equal(counts.none, rowsFor(book, 'none', TODAY).length);
  assert.equal(counts.overdue, 2);
  assert.equal(counts.none, 1);
});

test('overdue is oldest first — the one waiting longest is at the top', () => {
  const book = [
    lead({ name: 'recent', nextActionDate: '2026-09-19' }),
    lead({ name: 'ancient', nextActionDate: '2026-07-01' }),
  ];
  assert.deepEqual(
    rowsFor(book, 'overdue', TODAY).map((l) => l.name),
    ['ancient', 'recent'],
  );
});

test('nothing owed is quietest first', () => {
  const book = [
    lead({ name: 'touched', lastActivityDate: '2026-09-18' }),
    lead({ name: 'forgotten', lastActivityDate: '2026-05-04' }),
  ];
  assert.deepEqual(
    rowsFor(book, 'none', TODAY).map((l) => l.name),
    ['forgotten', 'touched'],
  );
});

test('what is missing is named, not counted', () => {
  assert.deepEqual(missingAnswers(lead()), [
    'what will be done',
    'the day',
    'who is doing it',
    'what they come back with',
  ]);
  assert.deepEqual(
    missingAnswers(
      lead({
        nextAction: 'Take the rate list',
        nextActionDate: TODAY,
        nextActionOwnerId: 'u1',
        nextActionOutcome: 'a first order',
      }),
    ),
    [],
  );
  /* Whitespace is not an answer. A field somebody tabbed through reads as
     filled in on every screen that only checks for null. */
  assert.deepEqual(missingAnswers(lead({ nextAction: '   ' })).includes('what will be done'), true);
});
