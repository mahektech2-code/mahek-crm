/* ---------------------------------------------------------------------------
 * HOW A TYPED SEARCH FINDS AN OPTION, in every ERP picker.
 *
 * The pickers used to ask whether the option CONTAINED what was typed, as one
 * string, so "universal 1 liter" found nothing in "Mahek Universal Thinner - 1
 * Liter (16 Can/Box)" — the words are there, with "Thinner -" between them.
 * Now every WORD typed must appear somewhere in the option, in any order, and
 * spacing and punctuation do not count: "1liter", "1 ltr" and "1 litre" all
 * find "1 Liter". The better matches come first: an option holding the whole
 * phrase, then one whose words start with what was typed, then the rest in the
 * order they were given. A number must match a whole number ("1" never finds
 * "16"), except as the last word typed, which may not be finished.
 *
 * PURE, so the rule is tested without a browser.
 * ------------------------------------------------------------------------- */

/** Spellings of one unit folded to one word, so a pack size is found however it is typed. */
const UNIT: Record<string, string> = {
  l: "liter",
  ltr: "liter",
  ltrs: "liter",
  lt: "liter",
  lit: "liter",
  liter: "liter",
  liters: "liter",
  litre: "liter",
  litres: "liter",
  ml: "ml",
  kg: "kg",
  kgs: "kg",
  pc: "pcs",
  pcs: "pcs",
};

/** Lower case, digits split from letters ("1liter" → "1 liter"), punctuation as spaces. */
function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .split(/[^a-z0-9.]+/)
    .map((w) => w.replace(/^\.+|\.+$/g, ""))
    .filter(Boolean)
    .map((w) => UNIT[w] ?? w);
}

export type Matcher = (option: string) => number | null;

/**
 * A scorer for one query: null where the option does not match, else a rank
 * (lower is better). An empty query matches everything at rank 0.
 */
export function matcher(query: string): Matcher {
  const q = words(query);
  if (!q.length) return () => 0;
  const phrase = q.join(" ");
  return (option) => {
    const o = words(option);
    if (!o.length) return null;
    let starts = 0;
    for (let k = 0; k < q.length; k++) {
      const w = q[k];
      /* A number is a size or a count, so "1" must not find "16" — unless it
         is the last word, which may still be being typed. */
      const exact = /^[\d.]+$/.test(w) && k < q.length - 1;
      let hit = false;
      let start = false;
      for (const x of o) {
        if (exact) {
          if (x === w) {
            hit = true;
            start = true;
            break;
          }
          continue;
        }
        if (x === w || x.startsWith(w)) {
          hit = true;
          start = true;
          break;
        }
        if (x.includes(w)) hit = true;
      }
      if (!hit) return null;
      if (start) starts++;
    }
    const whole = ` ${o.join(" ")} `.includes(` ${phrase}`) ? 0 : 1;
    return whole * 10 + (q.length - starts);
  };
}

/**
 * The options that match, best first, keeping the given order inside a rank.
 * `text` reads what is searched on an option that is not a plain string.
 */
export function matchOptions<T>(options: readonly T[], query: string, text?: (o: T) => string): T[] {
  if (!query.trim()) return [...options];
  const score = matcher(query);
  const read = text ?? ((o: T) => String(o));
  const hits: { o: T; r: number; i: number }[] = [];
  options.forEach((o, i) => {
    const r = score(read(o));
    if (r != null) hits.push({ o, r, i });
  });
  return hits.sort((a, b) => a.r - b.r || a.i - b.i).map((h) => h.o);
}

/** How many rows a picker draws first, and how many more each time its list is scrolled near the end. */
export const PAGE = 40;

/** Whether a scrolled list is close enough to its end to draw the next rows. */
export function nearEnd(el: { scrollTop: number; clientHeight: number; scrollHeight: number }, slack = 120): boolean {
  return el.scrollTop + el.clientHeight >= el.scrollHeight - slack;
}
