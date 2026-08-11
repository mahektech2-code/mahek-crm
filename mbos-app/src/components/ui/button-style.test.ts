import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Layout goes on the wrapper, appearance goes on the button.
 *
 * A pressable that scales is two boxes: an outer view carrying the transform,
 * and the button inside it. Put `flex: 1` on the inner one and it cannot
 * divide a row, because the wrapper has already sized itself to its content —
 * which is how thirteen paired Cancel/Save buttons ended up huddled at one end
 * of their sheets instead of filling them.
 *
 * The rule is reproduced here rather than imported because `primitives.tsx`
 * pulls in React Native. Any change has to be made in both.
 */

const LAYOUT_KEYS = [
  'flex', 'flexGrow', 'flexShrink', 'flexBasis', 'alignSelf',
  'width', 'minWidth', 'maxWidth',
  'margin', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight',
  'marginHorizontal', 'marginVertical', 'marginStart', 'marginEnd',
  'position', 'top', 'bottom', 'left', 'right', 'zIndex',
];

function splitStyle(flat: Record<string, unknown>) {
  const outer: Record<string, unknown> = {};
  const inner: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flat)) {
    if (LAYOUT_KEYS.includes(k)) outer[k] = v;
    else inner[k] = v;
  }
  return { outer, inner };
}

test('flex reaches the wrapper, so a pair can divide its row', () => {
  const { outer, inner } = splitStyle({ flex: 1, borderRadius: 14 });
  assert.deepEqual(outer, { flex: 1 });
  assert.deepEqual(inner, { borderRadius: 14 });
});

test('appearance stays on the button, where it is drawn', () => {
  const { outer, inner } = splitStyle({
    backgroundColor: '#6835FB',
    borderRadius: 12,
    height: 52,
    paddingHorizontal: 24,
  });
  assert.deepEqual(outer, {});
  assert.deepEqual(inner, {
    backgroundColor: '#6835FB',
    borderRadius: 12,
    height: 52,
    paddingHorizontal: 24,
  });
});

test('margins are layout — they position the wrapper, not the fill', () => {
  const { outer, inner } = splitStyle({ marginTop: 16, borderRadius: 8 });
  assert.deepEqual(outer, { marginTop: 16 });
  assert.deepEqual(inner, { borderRadius: 8 });
});

test('height is NOT layout, so it never fights the wrapper', () => {
  /* Height on the wrapper and a different height on the button is exactly the
     conflict that broke the empty-state button: one said 48, the other 52. */
  const { outer, inner } = splitStyle({ height: 48 });
  assert.deepEqual(outer, {});
  assert.deepEqual(inner, { height: 48 });
});

test('a width given for an intrinsic button reaches the wrapper', () => {
  const { outer } = splitStyle({ width: 140 });
  assert.deepEqual(outer, { width: 140 });
});

test('the real Cancel/Save pair splits the way the row needs', () => {
  /* The exact style thirteen call sites pass. */
  const { outer, inner } = splitStyle({ flex: 1, borderRadius: 14 });
  assert.equal(outer.flex, 1, 'the wrapper must flex or the row cannot divide');
  assert.equal(inner.flex, undefined, 'flex on the button alone does nothing');
  assert.equal(inner.borderRadius, 14);
});

test('an empty style produces two empty objects, never undefined', () => {
  const { outer, inner } = splitStyle({});
  assert.deepEqual(outer, {});
  assert.deepEqual(inner, {});
});
