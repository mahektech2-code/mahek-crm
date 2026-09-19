/* ---------------------------------------------------------------------------
 * WHICH GROUP IS OPEN — the accordion's whole rule, and nothing else.
 *
 * Pure and its own file for the reason `customer-health` and `account-types`
 * are: the sidebar is a client component that imports React, `next/navigation`
 * and an icon set, so a rule living inside it can only be exercised by
 * rendering a page — which is exactly how the bug below survived. Here it is
 * four arguments in and a label out, and `nav-open.test.ts` reads it.
 * ------------------------------------------------------------------------- */

/** All this rule needs of a group. The sidebar's own type is wider. */
export type OpenableGroup = { label: string };

/**
 * Shutting the group you are standing in is a thing somebody may want — the
 * column is then its headings and nothing else — and it cannot be said by
 * storing a label. It is stored as this rather than as an empty string, which
 * already means "nothing remembered" and would reopen on the next render.
 */
export const SHUT = "__none__";

/**
 * WHAT IS REMEMBERED IS THE CHOICE AND THE SCREEN IT WAS MADE ON.
 *
 * A label alone could not be honoured, because the group holding the current
 * route wins over anything remembered — and on every screen that rule was
 * answering a question somebody had just asked with their own hands. Standing
 * on Customers, a click on the Lead Management heading wrote the label,
 * redrew the column, and `openGroupFor` returned "Customer records" again:
 * the heading is a button and not a link, so the group did not open and
 * nothing navigated either. On any screen a group claims — which is all of
 * them — the accordion could only ever open the group you were already in.
 *
 * So the pathname travels with the label. A choice made ON THIS SCREEN is
 * deliberate and wins; anything older is a preference, and the group holding
 * the route somebody has since navigated to wins over that, which is the rule
 * this was written for. A value stored before this existed carries no
 * pathname and is read as the preference it was.
 */
const AT = "\u0000";

export function packChoice(pathname: string, label: string): string {
  return `${pathname}${AT}${label}`;
}

/** The label somebody chose, and where they were standing when they chose it. */
function unpackChoice(remembered: string): { at: string | null; label: string } {
  const i = remembered.indexOf(AT);
  return i === -1
    ? { at: null, label: remembered }
    : { at: remembered.slice(0, i), label: remembered.slice(i + AT.length) };
}

/**
 * Which group is open, and the five answers in their order of authority.
 *
 * A choice made on THIS screen wins over everything, including a shut, and
 * including the group holding the route: somebody who has just pressed a
 * heading is looking straight at it, and a column that answers a click by
 * redrawing itself unchanged is one they conclude is broken. Then the group
 * holding the current route, which is what a navigation means — a shut group
 * hiding the screen somebody has just opened reads as the sidebar having lost
 * it. Then an older deliberate shut, then a label remembered from a previous
 * session. Where none of them says anything — a first visit, or a route no
 * group claims — the first group opens, because a column of nothing but
 * headings on arrival reads as one that failed to load.
 *
 * A remembered label naming no group any more resolves to the default rather
 * than to something near it: groups get renamed and apps get narrowed by a
 * grant, and the honest answer to "the group you had open is gone" is not a
 * guess at which one replaced it.
 */
export function openGroupFor(
  groups: readonly OpenableGroup[],
  activeGroup: string | null,
  remembered: string,
  pathname: string,
): string | null {
  const { at, label } = unpackChoice(remembered);
  const here = at !== null && at === pathname;
  const known = label !== SHUT && groups.some((g) => g.label === label);

  if (here && label === SHUT) return null;
  if (here && known) return label;
  if (activeGroup) return activeGroup;
  if (label === SHUT) return null;
  if (known) return label;
  return groups[0]?.label ?? null;
}

