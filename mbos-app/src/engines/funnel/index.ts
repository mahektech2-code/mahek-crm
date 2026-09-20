/**
 * The funnel's rules, on the handset.
 *
 * The four files beside this one are BYTE-FOR-BYTE COPIES of MahekOne's own
 * `src/lib/lead-labels.ts`, `src/lib/engines/lead-ladder.ts`,
 * `src/lib/engines/lead-gates.ts` and `src/lib/engines/lead-role-action.ts`,
 * differing only in the path an import names.
 * They are copied rather than imported because this project is a separate
 * TypeScript program that the server's `tsconfig.json` excludes and that
 * excludes the server's `src/` in turn — a phone builds from this folder and
 * nothing else.
 *
 * They are copies rather than a second implementation for the reason
 * `lead-gates.ts` states in its own header: three callers, one answer. The
 * salesman standing in a shop with no signal is told which condition is
 * missing by the SAME function the server action refuses on, so a rung he
 * cannot pass on the phone is a rung the office also refuses, in the same
 * words. A handset that made up its own list would teach the process wrongly
 * and the salesman would find out at the save.
 *
 * A copy can drift, so `src/lib/mbos-wire.test.ts` reads both sides as text
 * and asserts they are identical apart from those import lines — the same
 * technique, and the same reasoning, as the wire contract test it sits beside.
 * Edit the SERVER's copy and re-copy; never edit these directly.
 */

export * from './lead-labels';
export * from './lead-ladder';
export * from './lead-gates';
/* §7 — the VERB, where the three above answer which rung and whether it may
   be climbed. A salesman reading a rung noun is reading the state of a lead;
   what he needs is what he is supposed to do about it this morning, and the
   same sentence has to be the one the office reads for him. */
export * from './lead-role-action';
