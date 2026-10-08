import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ENTITY_LABEL, describePayload, entityLabel, readPayload } from './labels';

/** Every `entityType: '…'` the app writes, read off the source. */
function writtenTypes(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== 'node_modules') walk(path);
      } else if (/\.tsx?$/.test(name) && !name.endsWith('.test.ts')) {
        for (const m of readFileSync(path, 'utf8').matchAll(/entityType: '([a-z_]+)'/g)) out.add(m[1]);
      }
    }
  };
  walk(join(__dirname, '..'));
  walk(join(__dirname, '..', '..', 'app'));
  return out;
}

test('every kind of entry the app sends has words on the outbox screens', () => {
  const missing = [...writtenTypes()].filter((t) => !(t in ENTITY_LABEL));
  assert.deepEqual(missing, [], 'these would print their wire spelling to the salesman');
});

test('an unknown kind reads as an entry, never as its wire name', () => {
  assert.equal(entityLabel('something_new'), 'Entry');
});

test('a malformed payload is an empty object, not a crash', () => {
  assert.deepEqual(readPayload('{not json'), {});
  assert.deepEqual(readPayload('null'), {});
  assert.equal(describePayload('{oops', 'mbos_order_abcdef123456'), '123456');
});
