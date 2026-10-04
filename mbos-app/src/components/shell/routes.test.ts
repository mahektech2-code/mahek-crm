import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backTarget, fromQuery, isMbosRoute, isTabRoot, safeHref, screenOf } from './routes';

test('an office web route is not a screen on the phone', () => {
  for (const href of ['/crm/performance', '/field/tasks', '/field', '/accounts/order-changes', '/crm/customers', '/day']) {
    assert.equal(isMbosRoute(href), false, href);
    assert.equal(safeHref(href), '/notifications');
  }
});

test('the phone\'s own screens are, with their params', () => {
  for (const href of ['/tasks', '/lead?id=abc', '/journey', '/home?punchOut=1', '/sample?id=1&from=lead']) {
    assert.equal(isMbosRoute(href), true, href);
  }
  assert.equal(isMbosRoute('/'), false);
  assert.equal(isMbosRoute('/index'), false);
  assert.equal(isMbosRoute('/+not-found'), false);
  assert.equal(isMbosRoute(undefined), false);
  assert.equal(isMbosRoute('tasks'), false);
});

test('screenOf reads the first segment', () => {
  assert.equal(screenOf('/lead?id=1'), 'lead');
  assert.equal(screenOf('/crm/customers'), 'crm');
  assert.equal(screenOf('nope'), null);
});

test('tab roots', () => {
  assert.equal(isTabRoot('/home?punchOut=1'), true);
  assert.equal(isTabRoot('/journey'), true);
  assert.equal(isTabRoot('/tasks'), false);
});

test('back keeps the record it came from', () => {
  const q = fromQuery('/lead', { id: 'L1', from: 'leads' });
  assert.equal(q, '?from=lead&back=' + encodeURIComponent('/lead?id=L1'));
  /* What a screen receives is the DECODED value, as expo-router hands it over. */
  assert.equal(backTarget({ from: 'lead', back: '/lead?id=L1' }, 'more'), '/lead?id=L1');
});

test('a screen with nothing to keep sends only its name', () => {
  assert.equal(fromQuery('/journey', {}), '?from=journey');
  assert.equal(fromQuery('/', {}), '?from=home');
});

test('a bare word still means that screen', () => {
  assert.equal(backTarget({ from: 'journey' }, 'more'), '/journey');
  assert.equal(backTarget({}, 'more'), '/more');
});

test('a back target that is not a screen falls back to one that is', () => {
  assert.equal(backTarget({ from: 'day' }, 'more'), '/more');
  assert.equal(backTarget({}, 'day'), '/home');
  assert.equal(backTarget({ back: '/crm/customers', from: 'crm' }, 'tasks'), '/tasks');
});
