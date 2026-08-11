import test from 'node:test';
import assert from 'node:assert/strict';
import {
  followUpRefusal,
  leadAlert,
  matchDuplicate,
  normaliseMobile,
  stageRefusal,
} from '../engines/leads';

/**
 * The lead rules, tested where they live — `src/engines/leads.ts` is pure and
 * imports nothing from expo, which is what lets the two rules that cost real
 * money be pinned without a handset: a shop that is already on the book, and a
 * lead marked Lost by somebody who never said why.
 */

const customers = [
  { id: 'mbos_customer_1', name: 'Om Sai Enterprises', phone: '9822011001' },
  { id: 'mbos_customer_2', name: 'Balaji Paints', phone: '+91 98220 11002' },
  { id: 'mbos_customer_3', name: 'No Number Traders', phone: null },
];

const leads = [
  { id: 'mbos_lead_1', name: 'Shree Hardware', mobile: '09822011003' },
  { id: 'mbos_lead_2', name: 'New Shop, Kamptee Road', mobile: null },
];

/* ------------------------------------------------------------ duplicates */

test('a number already on the book names the CUSTOMER, so the salesman can open it', () => {
  const hit = matchDuplicate('9822011001', customers, leads);
  assert.deepEqual(hit, { kind: 'customer', id: 'mbos_customer_1', name: 'Om Sai Enterprises' });
});

test('a number already being worked names the LEAD', () => {
  const hit = matchDuplicate('9822011003', customers, leads);
  assert.deepEqual(hit, { kind: 'lead', id: 'mbos_lead_1', name: 'Shree Hardware' });
});

test('a number nobody has is not a duplicate', () => {
  assert.equal(matchDuplicate('9876543210', customers, leads), null);
});

test('a customer wins over a lead on the same number', () => {
  /* Being on the book is the stronger fact: told "already a lead" he opens the
     lead, told "already a customer" he stops selling and starts serving. */
  const both = [{ id: 'mbos_lead_9', name: 'Same Shop', mobile: '9822011001' }];
  const hit = matchDuplicate('9822011001', customers, both);
  assert.equal(hit?.kind, 'customer');
});

test('the same shop written three ways is one shop', () => {
  /* This is the whole duplicate check. Comparing the typed strings finds none
     of these, and the shop is entered a second time an hour later. */
  for (const typed of ['98220 11001', '+91 9822011001', '09822011001', '+91-98220-11001', ' 91 9822011001 ']) {
    const hit = matchDuplicate(typed, customers, leads);
    assert.equal(hit?.id, 'mbos_customer_1', typed + ' should reach Om Sai');
  }
});

test('the stored number is normalised too, not just the typed one', () => {
  /* Balaji is stored as "+91 98220 11002" and Shree as "09822011003". A check
     that normalised only the input would miss both. */
  assert.equal(matchDuplicate('9822011002', customers, leads)?.name, 'Balaji Paints');
  assert.equal(matchDuplicate('9822011003', customers, leads)?.name, 'Shree Hardware');
});

test('normalisation strips punctuation, the country code and a leading zero', () => {
  assert.equal(normaliseMobile('+91 98220 11001'), '9822011001');
  assert.equal(normaliseMobile('09822011001'), '9822011001');
  assert.equal(normaliseMobile('91-98220-11001'), '9822011001');
  assert.equal(normaliseMobile('9822011001'), '9822011001');
  assert.equal(normaliseMobile(null), '');
});

test('a ten-digit number beginning 91 keeps both digits', () => {
  /* Indian mobiles start 6 to 9, so 9198… is a real number and not a country
     code. Stripping it would turn one shop into another. */
  assert.equal(normaliseMobile('9198011001'), '9198011001');
});

test('half a number is never a duplicate', () => {
  /* Mid-typing, the field holds four digits. Matching on a prefix would refuse
     the save against whichever shop happened to share them. */
  assert.equal(matchDuplicate('98220', customers, leads), null);
  assert.equal(matchDuplicate('', customers, leads), null);
});

test('records with no number are skipped rather than matching an empty one', () => {
  const hit = matchDuplicate('9822011009', customers, leads);
  assert.equal(hit, null);
});

/* ---------------------------------------------------------------- stages */

test('Lost without a reason is refused', () => {
  assert.ok(stageRefusal('Lost', null));
  assert.ok(stageRefusal('Lost', '   '));
  assert.ok(stageRefusal('Lost', undefined));
});

test('Lost with a reason goes through', () => {
  assert.equal(stageRefusal('Lost', 'Buying from Asian Paints on 60 days'), null);
});

test('every other stage is free', () => {
  for (const s of ['New', 'Contacted', 'Qualified', 'Negotiation', 'Converted']) {
    assert.equal(stageRefusal(s, null), null, s + ' should not ask for a reason');
  }
});

/* ------------------------------------------------------------- follow-ups */

test('a follow-up in the past is refused', () => {
  assert.ok(followUpRefusal('2026-08-11', '2026-08-12'));
});

test('today and later are allowed, and no date at all is allowed', () => {
  assert.equal(followUpRefusal('2026-08-12', '2026-08-12'), null);
  assert.equal(followUpRefusal('2026-09-01', '2026-08-12'), null);
  assert.equal(followUpRefusal(null, '2026-08-12'), null);
});

/* ------------------------------------------------------------------ time */

const CFG = { staleDays: 30, archiveDays: 90, escalateAfterDays: 7 };

test('a missed follow-up outranks going quiet', () => {
  const said = leadAlert(
    { stage: 'Contacted', archived: 0, nextFollowUpDate: '2026-08-10', lastActivityDate: '2026-05-01' },
    '2026-08-12',
    CFG,
  );
  assert.match(String(said), /Follow-up was 2 days ago/);
});

test('quiet, then archive-worthy, at the configured thresholds', () => {
  const at = (last: string) =>
    leadAlert({ stage: 'Contacted', archived: 0, nextFollowUpDate: null, lastActivityDate: last }, '2026-08-12', CFG);
  assert.equal(at('2026-08-01'), null, '11 days is not yet quiet');
  assert.match(String(at('2026-07-01')), /Gone quiet/);
  assert.match(String(at('2026-01-01')), /archive it or ring it/);
});

test('a settled lead says nothing, because there is nothing to do about it', () => {
  for (const stage of ['Converted', 'Lost']) {
    assert.equal(
      leadAlert({ stage, archived: 0, nextFollowUpDate: '2026-01-01', lastActivityDate: '2026-01-01' }, '2026-08-12', CFG),
      null,
    );
  }
  assert.equal(
    leadAlert({ stage: 'New', archived: 1, nextFollowUpDate: '2026-01-01', lastActivityDate: '2026-01-01' }, '2026-08-12', CFG),
    null,
  );
});

test('a New lead nobody has touched escalates on its own, shorter clock', () => {
  const said = leadAlert(
    { stage: 'New', archived: 0, nextFollowUpDate: null, lastActivityDate: '2026-08-01' },
    '2026-08-12',
    CFG,
  );
  assert.match(String(said), /Untouched for 11 days/);
});
