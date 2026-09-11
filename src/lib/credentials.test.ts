import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, newPassword, verifyPassword } from "./password";

/**
 * The password the Admin Console hands over.
 *
 * It is generated on the server, hashed, and shown to the person granting
 * access exactly once — so the properties that matter are the ones nobody can
 * check by looking at it later: that it is unambiguous when read aloud, that
 * the dash it is displayed with is really part of it, and that no two are the
 * same.
 */

const AMBIGUOUS = ["I", "O", "S", "Z", "0", "1", "2", "5"];

test("every character is one nobody can mishear or mistype", () => {
  for (let i = 0; i < 200; i++) {
    for (const ch of newPassword().replace("-", "")) {
      assert.ok(
        !AMBIGUOUS.includes(ch),
        `${ch} is one half of a pair somebody transcribes wrong`,
      );
      assert.match(ch, /[A-Z0-9]/);
    }
  }
});

test("the dash is IN the password, not painted on beside it", () => {
  /* A group that is only a display flourish is a transcription trap: the
     screen shows one thing and the hash holds another. */
  for (let i = 0; i < 50; i++) {
    const p = newPassword();
    assert.equal(p.length, 11);
    assert.equal(p[5], "-");
    assert.equal(p.indexOf("-"), p.lastIndexOf("-"));
  }
});

test("what is shown is what signs in", async () => {
  const shown = newPassword();
  assert.equal(await verifyPassword(shown, await hashPassword(shown)), true);
});

test("a password typed without its dash is refused, which is why the screen says so", async () => {
  const shown = newPassword();
  const stored = await hashPassword(shown);
  assert.equal(await verifyPassword(shown.replace("-", ""), stored), false);
});

test("two people set up in one afternoon do not get the same password", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) seen.add(newPassword());
  assert.equal(seen.size, 2000);
});

test("the alphabet is not so small that a draw repeats itself constantly", () => {
  /* 28 symbols over 10 places. A generator quietly reduced to, say, hex would
     still pass every test above and would be a far weaker credential. */
  const chars = new Set<string>();
  for (let i = 0; i < 300; i++) {
    for (const ch of newPassword().replace("-", "")) chars.add(ch);
  }
  assert.equal(chars.size, 28);
});
