import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skuLines } from './sku-lines';

test('the SKU name leads, and the formulation follows only where it adds something', () => {
  assert.deepEqual(skuLines({ name: 'Nano Thinner - 5 Liter (6 Can/Box)', formulation: 'M5x4' }), {
    lead: 'Nano Thinner - 5 Liter (6 Can/Box)',
    detail: 'M5x4',
  });
  assert.deepEqual(skuLines({ name: 'Enamel Thinner 20 Liter (Loose)', formulation: 'Enamel Thinner' }), {
    lead: 'Enamel Thinner 20 Liter (Loose)',
    detail: null,
  });
  assert.deepEqual(skuLines({ name: 'Mahek N C Thinner - 1 Liter (32 Can/Box)', formulation: null }), {
    lead: 'Mahek N C Thinner - 1 Liter (32 Can/Box)',
    detail: null,
  });
});

test('two packs of one liquid never share a title', () => {
  const a = skuLines({ name: 'Nano Thinner - 5 Liter (6 Can/Box)', formulation: 'M5x4' });
  const b = skuLines({ name: 'Nano Thinner - 20 Liter (2 Can/Box)', formulation: 'M5x4' });
  assert.notEqual(a.lead, b.lead);
});
