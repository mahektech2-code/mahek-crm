import { test } from 'node:test';
import assert from 'node:assert/strict';
import { areaRule, type AreaChoice } from './lead-areas';
import {
  LIST_LIMIT,
  areaFacts,
  nearLabel,
  norm,
  rememberArea,
  searchAreas,
  suggestAreas,
  type BookPlace,
} from './area-picker';

function choices(): AreaChoice[] {
  const rule = areaRule({
    exempt: false,
    areas: [
      { kind: 'city', value: 'Nagpur', parent: 'Maharashtra' },
      { kind: 'city', value: 'Wardha', parent: 'Maharashtra' },
      { kind: 'beat', value: 'Sadar', parent: 'Nagpur' },
      { kind: 'beat', value: 'Sadar', parent: 'Wardha' },
      { kind: 'beat', value: 'Itwari', parent: 'Nagpur' },
      { kind: 'state', value: 'Gujarat', parent: null },
    ],
  });
  assert.equal(rule.kind, 'pick');
  return rule.kind === 'pick' ? rule.choices : [];
}

const shop = (city: string | null, beat: string | null, lat: number | null = null, lng: number | null = null): BookPlace => ({
  city,
  area: null,
  beat,
  lat,
  lng,
});

const key = (cs: AreaChoice[], label: string) => cs.find((c) => c.label === label)!.key;

test('his shops are counted into the town and the beat they sit in', () => {
  const cs = choices();
  const f = areaFacts(cs, [shop('Nagpur', 'Sadar'), shop('nagpur', 'SADAR'), shop('Nagpur', 'Itwari'), shop('Wardha', null)], null);
  assert.equal(f.get(key(cs, 'Nagpur · Maharashtra'))!.shops, 3);
  assert.equal(f.get(key(cs, 'Sadar · Nagpur'))!.shops, 2);
  assert.equal(f.get(key(cs, 'Sadar · Wardha'))!.shops, 0);
  assert.equal(f.get(key(cs, 'Gujarat'))!.shops, null, 'the book has no state column, so a state is not counted');
});

test('with no query, the areas he works come first and the list is capped', () => {
  const cs = choices();
  const f = areaFacts(cs, [shop('Nagpur', 'Itwari'), shop('Nagpur', 'Itwari'), shop('Nagpur', null), shop('Wardha', null)], null);
  const r = searchAreas(cs, f, '');
  assert.equal(r.total, cs.length);
  assert.equal(r.rows[0].label, 'Nagpur · Maharashtra');
  assert.equal(r.rows[1].label, 'Itwari · Nagpur');

  const many: AreaChoice[] = Array.from({ length: 1500 }, (_, i) => ({
    key: `beat|b${i}|x`,
    label: `Beat ${i} · X`,
    city: 'X',
    area: `Beat ${i}`,
    state: null,
  }));
  const big = searchAreas(many, areaFacts(many, [], null), '');
  assert.equal(big.rows.length, LIST_LIMIT);
  assert.equal(big.total, 1500);
});

test('search finds by the start of the name, then by the town it is in', () => {
  const cs = choices();
  const f = areaFacts(cs, [], null);
  assert.deepEqual(
    searchAreas(cs, f, 'sad').rows.map((c) => c.label),
    ['Sadar · Nagpur', 'Sadar · Wardha'],
  );
  /* "nagpur" is the town itself first, then the beats inside it. */
  assert.deepEqual(
    searchAreas(cs, f, 'Nagpur').rows.map((c) => c.label),
    ['Nagpur · Maharashtra', 'Itwari · Nagpur', 'Sadar · Nagpur'],
  );
  /* Every word has to land: Sadar in Wardha, not every Sadar. */
  assert.deepEqual(searchAreas(cs, f, 'sadar war').rows.map((c) => c.label), ['Sadar · Wardha']);
  assert.equal(searchAreas(cs, f, 'pune').total, 0);
});

test('the areas near where he stands are offered first, nearest first, then his recent picks', () => {
  const cs = choices();
  const here = { lat: 21.15, lng: 79.09 };
  const f = areaFacts(
    cs,
    [
      shop('Nagpur', 'Itwari', 21.152, 79.09), // ~220 m
      shop('Nagpur', 'Sadar', 21.16, 79.09), // ~1.1 km
      shop('Wardha', 'Sadar', 20.74, 78.6), // far
    ],
    here,
  );
  const s = suggestAreas(cs, f, [key(cs, 'Sadar · Wardha'), key(cs, 'Itwari · Nagpur')]);
  assert.deepEqual(
    s.map((x) => `${x.why}:${x.choice.label}`),
    ['near:Itwari · Nagpur', 'near:Nagpur · Maharashtra', 'near:Sadar · Nagpur', 'recent:Sadar · Wardha'],
  );
});

test('no fix and no history offers nothing rather than a guess', () => {
  const cs = choices();
  assert.deepEqual(suggestAreas(cs, areaFacts(cs, [shop('Nagpur', 'Sadar', 21.15, 79.09)], null), []), []);
  assert.deepEqual(suggestAreas(cs, areaFacts(cs, [], null), ['gone|key|']), []);
});

test('a grouped book counts by its n, and distances come from the nearby list alone', () => {
  const cs = choices();
  const grouped: BookPlace[] = [{ city: 'Nagpur', area: null, beat: 'Sadar', lat: null, lng: null, n: 40 }];
  const near: BookPlace[] = [shop('Nagpur', 'Sadar', 21.151, 79.09)];
  const f = areaFacts(cs, grouped, { lat: 21.15, lng: 79.09 }, near);
  assert.equal(f.get(key(cs, 'Sadar · Nagpur'))!.shops, 40, 'the nearby shop is not counted twice');
  assert.ok(f.get(key(cs, 'Sadar · Nagpur'))!.nearM! < 200);
});

test('helpers', () => {
  assert.equal(norm('  Sadar Bazar (W) '), 'sadar bazar w');
  assert.equal(nearLabel(240), '0.2 km');
  assert.equal(nearLabel(2140), '2.1 km');
  assert.deepEqual(rememberArea(['a', 'b', 'c'], 'b'), ['b', 'a', 'c']);
  assert.deepEqual(rememberArea(['a', 'b', 'c', 'd', 'e', 'f'], 'g').length, 6);
});
