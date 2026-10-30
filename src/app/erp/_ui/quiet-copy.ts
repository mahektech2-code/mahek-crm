/* ---------------------------------------------------------------------------
 * What a header may say under its title, and how much.
 *
 * Titles used to carry a line of explanation under them — "SFG from one lot,
 * filled into cans or drums of one FG product." — which a person reads once
 * and then skips for ever. A line that NAMES the record ("FG-128 · FG12NA")
 * is different: it says which one this is, and it stays.
 *
 *  - A form or a list says nothing under its title that is a sentence.
 *  - A prompt or a confirm keeps its first sentence: that is what pressing the
 *    button will do, and a destructive act must still say so.
 *
 * Pure, so the rule is tested rather than remembered.
 * ------------------------------------------------------------------------- */

/** True for a line written as an explanation — it ends like a sentence. */
export function isSentence(line: string): boolean {
  return /[.!?…]["”’)]?\s*$/.test(line.trim());
}

/** The first sentence of a line, or the whole line if it is one. */
export function firstSentence(line: string): string {
  const t = line.trim();
  const m = /^(.+?[.!?])(?=\s+[A-Z“"‘(]|$)/.exec(t);
  return m ? m[1] : t;
}

/** What a form's or a list's header shows under its title: a record's name, never a sentence. */
export function formSub(sub: string | undefined | null): string | null {
  if (!sub || typeof sub !== "string") return null;
  return isSentence(sub) ? null : sub;
}

/** What a prompt or a confirm shows under its title: at most its first sentence. */
export function promptSub(sub: string | undefined | null): string | null {
  if (!sub || typeof sub !== "string") return null;
  return firstSentence(sub);
}
