import test from 'node:test';
import assert from 'node:assert/strict';

import { ALL_RUNGS, leadOwed, owedLabel, LEAD_SOURCES, LEAD_STAGES, LEGACY_LEAD_SOURCES, OTHER_SOURCE, leadPriorityLabel, leadSourceLabel, reorderLabel, reorderState, shiftDays, stageRefusal, viewMatch, viewOfLead, viewOfRung, visitCapLabel, visitCapState } from './leads';
import { ALL_LEAD_STAGES } from './funnel';

/**
 * The visit cap, and why it is a question rather than a gate.
 *
 * §B of the brief asks for a maximum of three visits to a Suspect, "enforced".
 * These tests pin the reading of that word this app took, because it is the
 * kind of decision somebody will later mistake for a missing feature: the cap
 * demands an ANSWER and never refuses the visit. `engines/geo.ts` states the
 * principle it follows — a reading is evidence, never a gate — and the failure
 * mode a refusal produces is the visit that simply never gets logged, taking
 * the GPS, the competitor note and the reason with it.
 *
 * Pure, so the rule can be checked with no handset and no database. The server
 * enforces `decide` against the same two configured numbers; that is what keeps
 * two runtimes agreeing without a module they cannot share.
 */


/* ------------------------------------------------------------ the visit cap */

test('a Suspect is warned before the decision is demanded, never after', () => {
  const cfg = { visitsBeforeDecision: 2, maxSuspectVisits: 3 };
  /* Nothing to say on the first visit — the answer must not be sprung on
     somebody standing in a shop. */
  assert.equal(visitCapState('New', 0, cfg), 'ok');
  /* The second visit warns that the next one needs an answer. */
  assert.equal(visitCapState('New', 1, cfg), 'warn');
  /* The third demands it. */
  assert.equal(visitCapState('New', 2, cfg), 'decide');
});

test('past the cap it still says decide, and never says stop', () => {
  const cfg = { visitsBeforeDecision: 2, maxSuspectVisits: 3 };
  /* There is no fourth state. A refused visit is an unlogged visit, and the
     company loses the GPS, the competitor note and the reason to prevent a
     number reaching four — see the note above `visitCapState`. */
  assert.equal(visitCapState('New', 5, cfg), 'decide');
  assert.equal(visitCapState('New', 50, cfg), 'decide');
});

test('only a Suspect is asked to justify itself', () => {
  const cfg = { visitsBeforeDecision: 2, maxSuspectVisits: 3 };
  /* A qualified prospect visited a fourth time is a negotiation, not a stall.
     Asking him to decide again would be asking a question already answered. */
  for (const stage of ['Qualified', 'Negotiation', 'On hold', 'Converted', 'Lost']) {
    assert.equal(visitCapState(stage, 9, cfg), 'ok', stage + ' should not be capped');
    assert.equal(visitCapLabel(stage, 9, cfg), null, stage + ' should carry no counter');
  }
});

test('the counter keeps counting past the cap rather than sticking', () => {
  const cfg = { visitsBeforeDecision: 2, maxSuspectVisits: 3 };
  assert.equal(visitCapLabel('New', 1, cfg), 'Visit 1 / 3');
  assert.equal(visitCapLabel('Contacted', 3, cfg), 'Visit 3 / 3');
  /* A fourth visit happened and the manager has been told. A counter that
     reads "3 / 3" there is lying about it. */
  assert.equal(visitCapLabel('New', 4, cfg), 'Visit 4 / 3');
});

test('a warning threshold equal to the cap means no warning, and is allowed', () => {
  /* checkConsistency permits it: a team that wants the answer on the second
     visit with no build-up can say so. What it refuses is a warning that comes
     AFTER the demand, which would ask for an answer nobody was told to expect. */
  const cfg = { visitsBeforeDecision: 2, maxSuspectVisits: 2 };
  assert.equal(visitCapState('New', 0, cfg), 'ok');
  assert.equal(visitCapState('New', 1, cfg), 'decide');
});

test('On hold asks for a reason, and for the opposite reason to Lost', () => {
  assert.equal(
    stageRefusal('On hold', ''),
    'Say what you are waiting for — that is what tells anybody when to pick it up again.',
  );
  assert.equal(stageRefusal('On hold', 'Back after Diwali'), null);
  /* Lost still asks, and everything else still does not. */
  assert.ok(stageRefusal('Lost', '  '));
  assert.equal(stageRefusal('Qualified', ''), null);
});

/* -------------------------------------------------------- the reorder due */

test('a customer who has never ordered is in no reorder state at all', () => {
  /* Not "due", not "overdue", nothing. They have no cycle to be late against,
     and saying "due" about them would be an invention the salesman has no way
     to check. The same reasoning as `decide` and `none` carrying no date in
     the CRM's next-step labels. */
  assert.equal(reorderState(null, 30, '2026-09-09'), null);
  assert.equal(reorderState('2026-08-10', null, '2026-09-09'), null);
  assert.equal(reorderState('2026-08-10', 0, '2026-09-09'), null);
});

test('due at one cycle, overdue at two', () => {
  const today = '2026-09-09';
  /* 29 days on a 30-day cycle: not yet. */
  assert.equal(reorderState('2026-08-11', 30, today), null);
  /* 30 days exactly: due. */
  assert.equal(reorderState('2026-08-10', 30, today), 'due');
  /* 60 days: twice the cycle, and the word changes. */
  assert.equal(reorderState('2026-07-11', 30, today), 'overdue');
});

test('the cycle is the customer\'s own, and the label says so', () => {
  /* "Due" alone invites "due by whose reckoning". The cycle is measured from
     this shop's own gaps rather than a company default, which is the part
     worth saying out loud. */
  const label = reorderLabel('2026-08-10', 30, '2026-09-09');
  assert.match(label ?? '', /Due to reorder/);
  assert.match(label ?? '', /buys every 30/);
  assert.match(label ?? '', /30 days/);
});

test('a fortnightly buyer and a quarterly one are judged on their own rhythm', () => {
  const today = '2026-09-09';
  /* 20 days. Late for the fortnightly shop, nowhere near for the quarterly
     one — which is the whole reason this reads `cycleDays` rather than a flat
     30/60/90. */
  assert.equal(reorderState('2026-08-20', 14, today), 'due');
  assert.equal(reorderState('2026-08-20', 90, today), null);
});

/* ------------------------------------------------------------- the source */

/**
 * A CODE IS NOT A LABEL, and the thing being pinned is that none of the four
 * words the old builds wrote ends up on a screen as itself.
 *
 * `cold_call`, `manual`, `referral` and `campaign` are on the book and are in
 * none of the ten. Orphaning them is the mistake `product_aliases` exists to
 * prevent: a stored value that stops resolving reads on the card as a database
 * word, which is how somebody concludes the record is broken.
 */
test('the office\'s own list wins, and it is words rather than codes', () => {
  const sources = [
    { code: 'walk_in', label: 'Walk-in' },
    { code: 'other', label: 'Other' },
  ];
  assert.equal(leadSourceLabel('walk_in', sources), 'Walk-in');
  assert.equal(leadSourceLabel(OTHER_SOURCE, sources), 'Other');
});

test('the four codes the old builds wrote still resolve to words', () => {
  for (const legacy of LEGACY_LEAD_SOURCES) {
    assert.equal(leadSourceLabel(legacy.code, LEAD_SOURCES), legacy.label);
  }
});

test('a source nobody recognises is shown as itself, never hidden', () => {
  /* An eleventh channel a manager added after this APK shipped, arriving on a
     lead pulled down from the office. The pulled list will normally carry it;
     where it does not, the code is a better answer than a blank cell. */
  assert.equal(leadSourceLabel('architect_reference', LEAD_SOURCES), 'architect_reference');
  assert.equal(leadSourceLabel(null, LEAD_SOURCES), null);
  assert.equal(leadSourceLabel('   ', LEAD_SOURCES), null);
});


/* ------------------------------------------------- what the book is cut by */

/**
 * The chips are the ladders read back, and the test that matters is COVERAGE.
 *
 * A rung that falls in no view is a lead standing on it that no chip can find —
 * it exists and cannot be reached, which is precisely the state this change was
 * made to end. A twenty-fourth rung added without a band would fail here rather
 * than on somebody's phone.
 */
test('every rung anything can stand on answers to exactly one chip', () => {
  for (const rung of ALL_RUNGS) {
    const view = viewOfRung(rung);
    const matches = ['new', 'contacted', 'qualified', 'negotiation', 'on_hold', 'converted', 'lost']
      .filter((v) => viewMatch(v as never)!.rungs.includes(rung));
    assert.deepEqual(matches, [view], rung + ' answered to ' + matches.join(', '));
  }
});

/** Every rung the funnel declares is one this book can cut by. */
test('the chips cover the whole funnel vocabulary', () => {
  for (const rung of ALL_LEAD_STAGES) {
    assert.ok(ALL_RUNGS.includes(rung), rung + ' is on no ladder and reachable from no chip');
  }
});

/**
 * The old book has to keep answering. A lead raised before the funnel carries
 * `funnelStage` null and one of the six words, and a change to a filter that
 * emptied every chip of it would be the worst kind of regression: the leads are
 * still there, on no chip, findable only on All.
 */
test('the six-word column still answers to a chip, every value of it', () => {
  for (const word of LEAD_STAGES) {
    const views = ['new', 'contacted', 'qualified', 'negotiation', 'on_hold', 'converted', 'lost']
      .filter((v) => viewMatch(v as never)!.legacy.includes(word));
    assert.equal(views.length, 1, word + ' answered to ' + views.join(', '));
  }
});

test('a lead reads its chip off whichever column it is carrying', () => {
  /* The funnel's rung wins where there is one. Sample review is Qualified —
     the band the console's funnel bar and the owner's cohort both draw. */
  assert.equal(
    viewOfLead({ funnelStage: 'sample_review', stage: 'New', salesType: 'direct' }),
    'qualified',
  );
  /* And the six-word column answers where there is not. */
  assert.equal(viewOfLead({ funnelStage: null, stage: 'Negotiation', salesType: null }), 'negotiation');
  /* On the book is Converted rather than the Negotiation band it sits in —
     the same reading `legacyStageFor` takes, so the badge and the chip that
     caught the row cannot disagree. */
  assert.equal(
    viewOfLead({ funnelStage: 'second_order', stage: 'New', salesType: 'direct' }),
    'converted',
  );
  /* A park is neither lost nor in a band. It has a chip of its own because
     `bandOf` refuses to guess which rung it was parked from. */
  assert.equal(viewOfLead({ funnelStage: 'on_hold', stage: 'On hold', salesType: 'direct' }), 'on_hold');
});

test('All and Archived narrow by nothing but the archive flag', () => {
  /* Cutting them by stage as well would hide the leads somebody opens All to
     find — which is the whole reason All exists. */
  assert.equal(viewMatch('all'), null);
  assert.equal(viewMatch('archived'), null);
});

/* ------------------------------------------------------------- the whens */

test('a day shifts with no zone anywhere in it', () => {
  assert.equal(shiftDays('2026-09-20', 7), '2026-09-27');
  /* Across a month end and a year end, where a naive setMonth is wrong. */
  assert.equal(shiftDays('2026-02-28', 1), '2026-03-01');
  assert.equal(shiftDays('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftDays('2026-01-01', -1), '2025-12-31');
});

/* ---------------------------------------------------------- the manager's */

test('an unjudged lead draws no priority at all', () => {
  assert.equal(leadPriorityLabel('high'), 'High priority');
  /* Null is not low. Nobody has judged it, and a card has no column in which
     "Not set" would be telling somebody something. */
  assert.equal(leadPriorityLabel(null), null);
  assert.equal(leadPriorityLabel('nonsense'), null);
});


/* ------------------------------------------------------------ what is owed */

/** A lead carrying nothing but the columns this question reads. */
function owing(bits: Partial<Parameters<typeof leadOwed>[0]>) {
  return {
    nextActionDate: null,
    nextFollowUpDate: null,
    holdResumeDate: null,
    funnelStage: null,
    stage: 'New',
    ...bits,
  };
}

test('the earliest of the three days wins, whichever column it is in', () => {
  /* §24's action alone. Keying the chip on the diary would have hidden this
     lead entirely, and it is every lead anybody has moved up a rung. */
  assert.deepEqual(leadOwed(owing({ nextActionDate: '2026-09-25' }), '2026-09-20'), {
    date: '2026-09-25',
    source: 'action',
    daysLate: 0,
  });
  /* The diary alone. Keying on the action would have emptied the chip for the
     whole legacy book, which §24 never applied to. */
  assert.equal(leadOwed(owing({ nextFollowUpDate: '2026-09-25' }), '2026-09-20')!.source, 'promise');
  /* Both, and the earlier one is the answer — the CRM's own rule about a
     cadence and a promise, one screen along. */
  const both = leadOwed(
    owing({ nextActionDate: '2026-09-25', nextFollowUpDate: '2026-09-22' }),
    '2026-09-20',
  )!;
  assert.equal(both.date, '2026-09-22');
  assert.equal(both.source, 'promise');
});

test('a tie goes to the action, which is the one with a person behind it', () => {
  const tied = leadOwed(
    owing({ nextActionDate: '2026-09-22', nextFollowUpDate: '2026-09-22' }),
    '2026-09-20',
  )!;
  assert.equal(tied.source, 'action');
});

test('a park is owed only while the lead is actually parked', () => {
  /* `holdResumeDate` outlives the resume, so a lead somebody brought back in
     March would otherwise go on being owed for ever on a day it has honoured. */
  assert.equal(leadOwed(owing({ holdResumeDate: '2026-09-15' }), '2026-09-20'), null);
  const parked = leadOwed(
    owing({ holdResumeDate: '2026-09-15', funnelStage: 'on_hold' }),
    '2026-09-20',
  )!;
  assert.equal(parked.source, 'hold');
  assert.equal(parked.daysLate, 5);
  /* And a lead parked before the funnel, which carries the park in the
     six-word column and no rung at all. */
  assert.equal(
    leadOwed(owing({ holdResumeDate: '2026-09-15', stage: 'On hold' }), '2026-09-20')!.source,
    'hold',
  );
});

test('a lead nobody is waiting on is owed nothing, rather than owed today', () => {
  assert.equal(leadOwed(owing({}), '2026-09-20'), null);
  assert.equal(owedLabel(null, (iso) => iso), null);
});

test('the sentence names WHICH of the three days it is', () => {
  const said = (bits: Partial<Parameters<typeof leadOwed>[0]>) =>
    owedLabel(leadOwed(owing(bits), '2026-09-20'), (iso) => iso);
  /* Three late leads, three different mornings. A chip that caught all three
     over one sentence would be a count nobody could act on. */
  assert.equal(said({ nextActionDate: '2026-09-14' }), 'Late \u2014 this was due on 2026-09-14');
  assert.equal(
    said({ nextFollowUpDate: '2026-09-14' }),
    'Late \u2014 you said you would go back on 2026-09-14',
  );
  assert.equal(
    said({ holdResumeDate: '2026-09-14', funnelStage: 'on_hold' }),
    'Late \u2014 back off hold since 2026-09-14',
  );
});
