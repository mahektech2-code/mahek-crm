/**
 * A PHONE NUMBER FOR A TEST ROW THAT CANNOT REPEAT. `users.phone` is unique,
 * and the fixtures used to draw one at random from a million — so every so
 * often a test drew a number another file in the same shard had already
 * left behind, and failed in its setup with `users_phone_key` on a change
 * that had nothing to do with users (CI #2244, `travel-on-visit.test.ts`).
 *
 * The number is the clock's millisecond and a counter from a random start:
 * inside one process the pair never repeats, and files in a shard run one
 * after another, so a later file's millisecond is always a later one. Ten
 * digits starting with 9, which every mobile check here accepts.
 */
let seq = Math.floor(Math.random() * 1000);

export function testPhone(): string {
  const ms = Date.now() % 1_000_000;
  return `9${String(ms).padStart(6, "0")}${String(seq++ % 1000).padStart(3, "0")}`;
}
