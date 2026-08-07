/* ---------------------------------------------------------------------------
 * The note a quick-note chip writes, and how it is taken back out.
 *
 * A chip is a shortcut for typing, not a field of its own: what it produces
 * lands in the same box the telecaller types into, and stays editable. That is
 * what makes unpicking one delicate — the words have to come out without
 * disturbing anything a person put there themselves.
 *
 * Pure, so the rule is tested without a browser.
 * ------------------------------------------------------------------------- */

/**
 * Takes one quick note's words back out of the note.
 *
 * Exactly ONE occurrence, and the first: a telecaller who typed the same
 * phrase themselves keeps theirs. Unpicking a chip removes what the chip
 * added and nothing else.
 *
 * The gap it leaves goes too. Without that, a note collects the spaces of
 * everything ever picked and unpicked, and eventually a telecaller notices
 * their notes look wrong and stops trusting the box.
 */
export function dropLabel(text: string, label: string): string {
  const at = text.indexOf(label);
  if (at < 0) return text;
  return (text.slice(0, at) + text.slice(at + label.length))
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/** Appends a chip's words to whatever is already in the box. */
export function addLabel(text: string, label: string): string {
  const trimmed = text.trim();
  return trimmed ? `${trimmed} ${label}` : label;
}
