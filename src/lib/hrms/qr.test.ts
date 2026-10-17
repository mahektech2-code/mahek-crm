import { test } from "node:test";
import assert from "node:assert/strict";
import { dataCodewords, encodeQr, formatBits, rsRemainder } from "./qr";

test("Reed–Solomon matches the standard's worked example (1-M HELLO WORLD)", () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(rsRemainder(data, 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test("format bits for level L match the published table", () => {
  assert.equal(formatBits(0).toString(2).padStart(15, "0"), "111011111000100");
  assert.equal(formatBits(4).toString(2).padStart(15, "0"), "110011000101111");
  assert.equal(formatBits(7).toString(2).padStart(15, "0"), "110100101110110");
});

test("byte-mode data is headed, terminated and padded with EC/11", () => {
  const cw = dataCodewords([0x41], 1);
  assert.equal(cw.length, 19);
  assert.deepEqual(cw.slice(0, 3), [0x40, 0x14, 0x10]);
  assert.deepEqual(cw.slice(3, 6), [0xec, 0x11, 0xec]);
});

test("the smallest version that fits is chosen, and finders are drawn", () => {
  assert.equal(encodeQr("MMI-ATT-101").version, 1);
  assert.equal(encodeQr("x".repeat(18)).version, 2);
  assert.equal(encodeQr("x".repeat(78)).size, 33);
  assert.throws(() => encodeQr("x".repeat(79)));
  const q = encodeQr("MMI-ATT-101");
  const row0 = q.dark[0].slice(0, 7);
  assert.deepEqual(row0, [true, true, true, true, true, true, true]);
  assert.equal(q.dark[q.size - 8][8], true, "the dark module");
});
