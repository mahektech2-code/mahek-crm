/**
 * HOW FAR A LINE OF TEXT MAY GROW WITH THE PHONE'S FONT SIZE, where it sits in
 * a box that cannot grow with it.
 *
 * Android's font size goes to 2.0 and a good share of the people carrying this
 * phone have it turned up. Most text in the app is in a box that grows with it
 * — a card, a row with `minHeight` — and is left alone: that setting is theirs.
 * A handful of places cannot: a badge on the bell, the status strip under the
 * header, a tab label, the two-line rows of the + menu. At 1.6 those clipped
 * to "In 09:" and a badge whose digit was cut in half.
 *
 * There is no global switch any more — React 19 dropped `defaultProps` on
 * function components, which is what `Text.defaultProps` used to rest on — so
 * it is said on the Text, from here, rather than as a literal at each one.
 */

/** A count inside a fixed circle. Grows a little, never out of its pip. */
export const BADGE_FONT_CAP = 1.15;

/** One line in a fixed bar — the header title, the strip, a tab label. */
export const BAR_FONT_CAP = 1.3;
