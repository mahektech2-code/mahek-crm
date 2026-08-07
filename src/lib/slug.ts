/* ---------------------------------------------------------------------------
 * Slugs — the stable name a screen answers to.
 *
 * A slug is an address, and an address that changes is a broken link. So a
 * slug is DECLARED next to the label it belongs to, never derived from it at
 * render time: somebody rewording "Workday" to "Working day" is fixing prose,
 * not moving a page, and every link anyone saved must survive it.
 *
 * `slugify` exists for the case where nothing was declared — a new tab, a new
 * app — so the screen is still addressable rather than unreachable. Treat what
 * it returns as a suggestion to write down, not as the address itself.
 * ------------------------------------------------------------------------- */

/**
 * Lowercase, ASCII, hyphen-separated. Digits are KEPT — "Stage 2" and
 * "Stage 3" are different screens, and a slugifier that drops the number
 * silently merges them.
 */
export function slugify(label: string): string {
  const out = label
    .normalize("NFKD")
    // Fold accents rather than deleting the letter underneath them.
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  // Never return an empty string: a label of only punctuation still needs an
  // address, and "" would collide with the section root.
  return out || "untitled";
}

/**
 * Slugs for a set of labels, unique within that set.
 *
 * Two tabs that slugify the same way would otherwise be one address pointing
 * at whichever the code happened to find first. The first keeps the bare slug
 * so the common case stays readable; later ones are numbered.
 */
export function uniqueSlugs(labels: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return labels.map((label) => {
    const base = slugify(label);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n + 1}`;
  });
}
