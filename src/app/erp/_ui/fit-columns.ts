import type { ColSpec, ColType } from "@/lib/erp/ui";

/* ---------------------------------------------------------------------------
 * WHICH COLUMNS A LIST DRAWS, AND HOW WIDE — so a list never scrolls sideways.
 *
 * A server module names every column a person's powers reveal, and on the
 * busiest screens that is eighteen or twenty-seven of them. Drawn as they
 * came, the order-details list was three thousand pixels wider than the card
 * it sat in, and the figures somebody opened the screen for were off the
 * right-hand edge behind a scrollbar nobody noticed. This decides, for the
 * width actually available, which columns are drawn and how wide each is. The
 * rest are FOLDED: still searched, still exported, and drawn in full in the
 * record drawer a row opens. Nothing is lost. A column that does not fit is
 * one click away rather than one scroll away.
 *
 * Columns are chosen in the order the server declared them, which is the
 * order a screen's author put the important ones in, except that the first
 * column, the record's name, its first status and its flags are always kept: those
 * are what a person scans a list FOR. A person may pick their own set from
 * the Columns menu; a pick that does not fit the width they have now keeps
 * the ones it can, in their order, and says how many it could not.
 *
 * PURE: the list screen hands it the measured width.
 * ------------------------------------------------------------------------- */

/** The narrowest each kind of column may be drawn, padding included. */
const MIN: Record<ColType, number> = {
  b: 168,
  t: 124,
  n: 80,
  m: 104,
  d: 92,
  s: 112,
  f: 104,
  ph: 112,
  em: 168,
  map: 112,
  /* A bill number such as MMI/26-27/1100 in monospace, whole. */
  mono: 136,
};

/** The selection checkbox. */
export const CHECK_COL = 36;

/**
 * The narrowest a column may be. A heading wraps rather than widening its
 * column, but its longest single word cannot wrap, so the column is at least
 * that word plus the sort chevron and padding. Headings are 12px uppercase
 * with letter spacing, which is about 7.6px a character.
 */
export function minWidth(c: ColSpec): number {
  const word = Math.max(0, ...c.l.split(/\s+/).map((w) => w.length));
  return Math.max(c.w ?? MIN[c.t], Math.ceil(word * 7.6) + 24 + 16);
}

/** Kinds that take what is left over: text reads better wider, numbers do not. */
const GROWS: ReadonlySet<ColType> = new Set(["b", "t", "em", "mono"]);

/** The columns that are kept whatever the width, by key, in priority order. */
export function essentialKeys(cols: ColSpec[]): string[] {
  const keys: string[] = [];
  const add = (c?: ColSpec) => {
    if (c && !keys.includes(c.k)) keys.push(c.k);
  };
  add(cols[0]);
  add(cols.find((c) => c.t === "b"));
  add(cols.find((c) => c.t === "s"));
  add(cols.find((c) => c.t === "f"));
  return keys;
}

export type ColumnFit = {
  /** Drawn, in the server's order. */
  shown: ColSpec[];
  /** Pixel width per drawn column; with the checkbox they total `avail`. */
  widths: Record<string, number>;
  /** Not drawn — in the record drawer, the search and the export. */
  folded: ColSpec[];
  /** Of a person's own pick, how many there was no room for at this width. */
  dropped: number;
  /** Whether one more of the folded columns would still fit. */
  roomFor: (k: string) => boolean;
};

export function fitColumns({
  cols,
  avail,
  check = false,
  chosen = null,
}: {
  cols: ColSpec[];
  /** The width the table has, in px. */
  avail: number;
  /** Whether the selection checkbox column is drawn. */
  check?: boolean;
  /** A person's own pick of column keys, or null for the automatic set. */
  chosen?: string[] | null;
}): ColumnFit {
  const room = Math.max(0, avail - (check ? CHECK_COL : 0));
  const known = new Set(cols.map((c) => c.k));
  const pick = chosen?.filter((k) => known.has(k)) ?? null;

  /* Candidates in the order they are offered the room. */
  const order: string[] = pick?.length
    ? cols.filter((c) => pick.includes(c.k)).map((c) => c.k)
    : [...essentialKeys(cols), ...cols.map((c) => c.k)].filter((k, i, a) => a.indexOf(k) === i);

  const byKey = new Map(cols.map((c) => [c.k, c]));
  const keep = new Set<string>();
  let used = 0;
  for (const k of order) {
    const w = minWidth(byKey.get(k)!);
    /* The first column is drawn even on a screen too narrow for it: a list
       with no columns at all is not a narrower list, it is a broken one. */
    if (used + w <= room || keep.size === 0) {
      keep.add(k);
      used += w;
    } else if (!pick?.length) {
      /* The automatic set stops at the first column that does not fit, so
         what is drawn is a prefix of the server's order, not a scatter of
         narrow columns that happened to squeeze in from further along. */
      if (!essentialKeys(cols).includes(k)) break;
    }
  }

  const shown = cols.filter((c) => keep.has(c.k));
  const folded = cols.filter((c) => !keep.has(c.k));

  /* Share what is left over, to the text columns where there are any. */
  const widths: Record<string, number> = {};
  for (const c of shown) widths[c.k] = minWidth(c);
  const spare = Math.max(0, room - used);
  const growers = shown.filter((c) => GROWS.has(c.t));
  const takers = growers.length ? growers : shown;
  const base = takers.reduce((n, c) => n + widths[c.k], 0) || 1;
  let given = 0;
  takers.forEach((c, i) => {
    const extra = i === takers.length - 1 ? spare - given : Math.floor((spare * widths[c.k]) / base);
    widths[c.k] += extra;
    given += extra;
  });

  return {
    shown,
    widths,
    folded,
    dropped: pick?.length ? pick.length - shown.length : 0,
    roomFor: (k) => {
      const c = byKey.get(k);
      return !!c && used + minWidth(c) <= room;
    },
  };
}
