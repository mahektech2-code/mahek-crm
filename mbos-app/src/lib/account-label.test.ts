import test from 'node:test';
import assert from 'node:assert/strict';

import { accountLine, accountType, customerStage } from './account-label';
import { customerPageQuery } from '../data/customer-query';

/**
 * What a row of the Customers list SAYS about itself.
 *
 * These exist because the screen could not answer the question a salesman
 * actually has — customer or lead, and if a lead, which rung — and because the
 * one function that was supposed to answer half of it had shipped with a
 * branch that could never fire. Nothing caught that: the rules lived in
 * `data/customers.ts`, which imports the database, so there was no test that
 * could reach them. They are pure now, and this is that test.
 */

const shop = (over: Record<string, unknown> = {}) => ({
  kind: null,
  thirdParty: 0,
  ...over,
}) as Parameters<typeof accountLine>[0];

/* ------------------------------------------------------ what it IS */

test('the leads table decides, not the kind column', () => {
  /* The office keeps ONE customers row for a lead and sends the lead down its
     own channel, so `kind` on that row is not the answer — which is what this
     read before, and why a lead whose row said `customer`, or whose kind had
     never been filled in, was labelled wrongly or not at all. */
  assert.equal(accountType(shop({ isLead: 1, kind: 'customer' })), 'Lead');
  assert.equal(accountType(shop({ isLead: 1, kind: null })), 'Lead');
  assert.equal(accountType(shop({ isLead: 0, kind: 'customer' })), 'Customer');
});

test('the mark wins over the kind, exactly as the web list has it', () => {
  assert.equal(accountType(shop({ thirdParty: 1, kind: 'lead', isLead: 1 })), 'Third party');
});

test('nothing known says nothing, rather than guessing Customer', () => {
  assert.equal(accountType(shop()), null);
  assert.equal(accountLine(shop()), null);
});

test('a caller that did not ask for the lead facts still gets the old answer', () => {
  // `isLead` undefined — every read of this table that is not the list.
  assert.equal(accountType(shop({ kind: 'lead' })), 'Lead');
});

/* -------------------------------------------------- and WHICH RUNG */

test('a lead carries its rung, which is the whole point of the line', () => {
  assert.equal(
    accountLine(shop({ isLead: 1, leadFunnelStage: 'suspect' })),
    'Lead · Suspect',
  );
  assert.equal(
    accountLine(shop({ isLead: 1, leadFunnelStage: 'negotiation' })),
    'Lead · Negotiation',
  );
});

test('a lead raised before the funnel falls back to the six-word column', () => {
  assert.equal(
    accountLine(shop({ isLead: 1, leadFunnelStage: null, leadStage: 'Contacted' })),
    'Lead · Contacted',
  );
  // 'Converted' is the one that is not the same word twice.
  assert.equal(
    accountLine(shop({ isLead: 1, leadFunnelStage: null, leadStage: 'Converted' })),
    'Lead · Won',
  );
  // Nothing stored at all is the foot of the ladder, never a blank.
  assert.equal(accountLine(shop({ isLead: 1 })), 'Lead · New');
});

test('a customer gets no rung — it has left the funnel', () => {
  assert.equal(
    accountLine(shop({ isLead: 0, kind: 'customer', leadFunnelStage: 'won' })),
    'Customer',
  );
});

/* ------------------------------------------------- how it is DOING */

test('a deactivated account is Closed, and that outranks any derived band', () => {
  /* `recomputeInactivity` writes every other status and pointedly never this
     one, because it is a person's decision rather than a derivation. */
  assert.equal(customerStage({ status: 'deactivated', healthBand: 'active' }), 'Closed');
});

test('the band answers everything else', () => {
  assert.equal(customerStage({ status: 'active', healthBand: 'active' }), 'Active');
  assert.equal(customerStage({ status: 'active', healthBand: 'at-risk' }), 'At risk');
  assert.equal(customerStage({ status: 'active', healthBand: 'dormant' }), 'Dormant');
  assert.equal(customerStage({ status: 'active', healthBand: 'lost' }), 'Lost');
});

test('an account nothing has been measured on gets NO verdict', () => {
  /* This is the one the screenshot was about. It returned null already — but
     the card drew the dot unconditionally and only the WORD was conditional,
     so a shop nobody has ever sold to got a bare green dot: the most
     reassuring mark on the card, on the row that deserves it least. */
  assert.equal(customerStage({ status: 'active', healthBand: null }), null);
  assert.equal(customerStage({ status: null, healthBand: null }), null);
});

test('the values the enum cannot produce are gone', () => {
  /* `customer_status` is exactly active | inactive | deactivated. The old
     branch compared against 'Overdue', 'At risk' and 'Active' — two of which
     name nothing anywhere in MahekOne — so it could never fire and every
     account fell through to the band, deactivated ones included. */
  assert.equal(customerStage({ status: 'Active', healthBand: null }), null);
  assert.equal(customerStage({ status: 'Overdue', healthBand: null }), null);
  assert.equal(customerStage({ status: 'inactive', healthBand: 'dormant' }), 'Dormant');
});

/* ------------------------------------ and the facts actually reach it */

test('both pages of the list select the lead facts the card reads', () => {
  /* A rule that cannot see `isLead` answers "Customer" for every lead in the
     book, and the two pages are built separately — the nearest-first one has
     its own projection. */
  for (const q of [
    customerPageQuery({}),
    customerPageQuery({ origin: { lat: 21.16, lng: 79.08 } }),
  ]) {
    for (const column of ['isLead', 'leadFunnelStage', 'leadStage']) {
      assert.ok(q.sql.includes(column), `${column} missing from: ${q.sql.slice(0, 120)}`);
    }
  }
});

test('the lead facts bind no parameters, so the placeholder order is unchanged', () => {
  /* The projection's six placeholders are the distance CASE's own and must
     still come before the WHERE's. A subquery that bound one would silently
     shift every parameter after it. */
  const plain = customerPageQuery({ query: 'sai' });
  const near = customerPageQuery({ query: 'sai', origin: { lat: 21.16, lng: 79.08 } });
  assert.equal((plain.sql.match(/\?/g) ?? []).length, plain.params.length);
  assert.equal((near.sql.match(/\?/g) ?? []).length, near.params.length);
});
