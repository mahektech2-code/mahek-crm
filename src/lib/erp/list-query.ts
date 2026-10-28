/* ---------------------------------------------------------------------------
 * ONE READING OF A LIST: filter, chips, search, sort, group, page.
 *
 * The generic list used to do all of this in the browser, over every row the
 * server sent — which was every row there is. With the ERP holding real
 * history (ten thousand SFG lines, nine thousand FG fills) that was megabytes
 * of rows serialised into every page, each carrying its record and its
 * actions, to draw twenty-five of them. Now the ERP's page runs this on the
 * server and sends one page; HRMS and the other small lists still run it in
 * the browser. It is the SAME function in both places, so a search or a sort
 * cannot answer differently depending on which side happened to run it.
 *
 * PURE and client-safe.
 * ------------------------------------------------------------------------- */

import { validPeriod } from "./period";
import { aggsOf, cellText, type ColSpec, type ListRow, type ListSpec, type Tone } from "./ui";

export type ListSort = { k: string; d: 1 | -1 };

/** Everything the list's toolbar and pager can say, as it travels in the URL. */
export type ListQuery = {
  q: string;
  chip: string;
  /** The godown filter. */
  gf: string;
  /** Grouping on (the default where the spec groups at all). */
  grp: boolean;
  sort: ListSort | null;
  page: number;
  size: number;
  /** A dashboard pre-filter: only these ids. */
  ids: string[] | null;
  /**
   * The period a windowed register is read through (`period.ts`): a preset,
   * `c:<from>:<to>`, `all`, or empty for the screen's own default. Lists that
   * are not windowed ignore it.
   */
  pd: string;
  /** A folding list (`ListSpec.fold`) read part by part — every lot its own row — instead of as totals. */
  parts: boolean;
  /** The column filters (`ListSpec.filters`): column key → the value it must show, as the list draws it. */
  fx: Record<string, string>;
  /**
   * The Excel-style column filters (`ListSpec.colFilters`): column key → the
   * values it may show (a tick list), or a number range on a number column.
   */
  cf: Record<string, ColFilter>;
};

/**
 * One column's Excel-style filter. `in` is the ticked values, as the list
 * draws them ("—" is a blank cell); `min` / `max` bound a number column, either
 * end open. A filter that names nothing is no filter.
 */
export type ColFilter = { in?: string[]; min?: number | null; max?: number | null };

export const PAGE_SIZES = [25, 50, 100] as const;

/** The query keys a list owns in the URL, beside the page's own (`view`, `open`, `f`, `fl`, `new`). */
export const LIST_QUERY_KEYS = ["q", "chip", "gf", "grp", "sort", "page", "size", "pd", "parts", "fx", "cf"] as const;

type Raw = Record<string, string | string[] | undefined>;
const one = (raw: Raw, k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : "");

/** The column filters as they travel: a JSON object of strings. Anything else is no filter, never an error page. */
function parseFx(s: string): Record<string, string> {
  if (!s) return {};
  try {
    const o: unknown = JSON.parse(s);
    if (!o || typeof o !== "object" || Array.isArray(o)) return {};
    return Object.fromEntries(Object.entries(o).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""));
  } catch {
    return {};
  }
}

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** One column filter, cleaned: ticked strings, or finite bounds. Null where it says nothing. */
export function cleanColFilter(v: unknown): ColFilter | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Array.isArray(o.in)) {
    const vals = [...new Set(o.in.filter((x): x is string => typeof x === "string"))];
    return { in: vals };
  }
  const min = finite(o.min);
  const max = finite(o.max);
  return min == null && max == null ? null : { min, max };
}

/** The Excel filters as they travel: a JSON object of column filters. Anything malformed is dropped, never an error page. */
function parseCf(s: string): Record<string, ColFilter> {
  if (!s) return {};
  try {
    const o: unknown = JSON.parse(s);
    if (!o || typeof o !== "object" || Array.isArray(o)) return {};
    const out: Record<string, ColFilter> = {};
    for (const [k, v] of Object.entries(o)) {
      const f = cleanColFilter(v);
      if (f) out[k] = f;
    }
    return out;
  } catch {
    return {};
  }
}

export function parseListQuery(raw: Raw): ListQuery {
  const s = /^(.+)\.(a|d)$/.exec(one(raw, "sort"));
  const size = Number(one(raw, "size"));
  const page = Number(one(raw, "page"));
  const f = one(raw, "f");
  return {
    q: one(raw, "q"),
    chip: one(raw, "chip"),
    gf: one(raw, "gf"),
    grp: one(raw, "grp") !== "0",
    sort: s ? { k: s[1], d: s[2] === "d" ? -1 : 1 } : null,
    page: Number.isInteger(page) && page > 0 ? page : 1,
    size: (PAGE_SIZES as readonly number[]).includes(size) ? size : 25,
    ids: f ? f.split(",") : null,
    pd: validPeriod(one(raw, "pd")) ? one(raw, "pd") : "",
    parts: one(raw, "parts") === "1",
    fx: parseFx(one(raw, "fx")),
    cf: parseCf(one(raw, "cf")),
  };
}

/** The URL form of a query, leaving out every default so a plain list keeps a plain address. */
export function listQueryParams(q: ListQuery): Record<string, string> {
  const out: Record<string, string> = {};
  if (q.q) out.q = q.q;
  if (q.chip) out.chip = q.chip;
  if (q.gf) out.gf = q.gf;
  if (!q.grp) out.grp = "0";
  if (q.sort) out.sort = `${q.sort.k}.${q.sort.d < 0 ? "d" : "a"}`;
  if (q.page > 1) out.page = String(q.page);
  if (q.size !== 25) out.size = String(q.size);
  if (q.pd) out.pd = q.pd;
  if (q.parts) out.parts = "1";
  const fx = Object.keys(q.fx).sort().filter((k) => q.fx[k]);
  if (fx.length) out.fx = JSON.stringify(Object.fromEntries(fx.map((k) => [k, q.fx[k]])));
  const cf = Object.keys(q.cf ?? {}).sort();
  if (cf.length) out.cf = JSON.stringify(Object.fromEntries(cf.map((k) => [k, q.cf[k]])));
  return out;
}

export type ListGroup = {
  /** Rows in the whole group, not just the part on this page. */
  n: number;
  /**
   * The spec's aggregates over the whole group, already summed or averaged,
   * in the spec's order; null where the list does not carry that column.
   * `missing` counts the rows with no value, for an aggregate that asks.
   */
  agg: ({ v: number; missing: number } | null)[];
  /** Every id in the group, for "Select all" on a group. */
  ids: string[];
  /** The group's first row's values, for the facts drawn in its header. */
  head: ListRow["v"];
};

export type ListPage = {
  /** The rows on this page, in order, grouped rows contiguous. */
  rows: ListRow[];
  /** Rows the filters leave, across every page. */
  total: number;
  /** The page actually drawn — a page past the end is the last page. */
  page: number;
  /** Rows before the chip is applied: the "All" tab's count. */
  beforeChip: number;
  chips: { v: string; n: number }[];
  /** Each column filter's choices, counted over the rows every OTHER filter leaves. */
  facets: Facet[];
  /**
   * The Excel filters' choices (`ListSpec.colFilters`), per column: its values
   * counted over the rows every OTHER column filter leaves, or a number
   * column's range. Absent where the list offers none.
   */
  colFacets?: Record<string, ColFacet>;
  sort: ListSort | null;
  /** The group label of each row on the page, by id. */
  groupOf: Record<string, string>;
  groups: Record<string, ListGroup>;
  /** The longest badge each status and flags column draws across ALL rows, so widths do not jump page to page. */
  badgeChars: Record<string, number>;
  /** Rows the screen holds before any filter — the difference between "nothing yet" and "nothing matches". */
  all: number;
  /**
   * The window a register was read through, where the screen has one. `tooWide`
   * is set when the period holds more rows than one page load may build: the
   * rows are then empty and the screen asks for a narrower period instead.
   */
  window?: { pd: string; label: string; dateLabel: string; tooWide: { n: number; cap: number } | null };
};

export type Facet = { k: string; l: string; opts: { v: string; n: number }[] };

/** One column's Excel-filter choices: the values it draws, or — a number column — its range. `more` counts values past the cap. */
export type ColFacet = { kind: "list"; opts: { v: string; n: number }[]; more: number } | { kind: "range"; lo: number | null; hi: number | null };

/** The most values one column's tick list carries; past it the menu's search finds the rest. */
export const COL_FACET_CAP = 500;

/** Whether a column is filtered by a range rather than a tick list. */
export const isRangeCol = (c: Pick<ColSpec, "t">) => c.t === "n";

/** The columns an Excel filter may be put on: every drawn column but the flags. */
function excelCols(spec: Pick<ListSpec, "cols" | "colFilters">): ColSpec[] {
  return spec.colFilters ? spec.cols.filter((c) => c.t !== "f") : [];
}

/** Whether a row passes one column's Excel filter. A blank number fails any bound. */
export function passColFilter(c: ColSpec, f: ColFilter, r: ListRow): boolean {
  if (f.in) return f.in.includes(cellText(c, r.v[c.k]));
  const raw = r.v[c.k];
  const n = raw == null || raw === "" ? NaN : Number(raw);
  if (f.min != null && !(n >= f.min)) return false;
  if (f.max != null && !(n <= f.max)) return false;
  return true;
}

function byColFilters(rows: ListRow[], cols: ColSpec[], cf: Record<string, ColFilter>, skip: string | null): ListRow[] {
  const on = cols.filter((c) => c.k !== skip && cf[c.k]);
  return on.length ? rows.filter((r) => on.every((c) => passColFilter(c, cf[c.k], r))) : rows;
}

/** Each column's Excel-filter choices, over the rows every other column filter leaves. A value still ticked is offered even at zero. */
export function colFacetsOf(spec: Pick<ListSpec, "cols" | "colFilters">, rows: ListRow[], cf: Record<string, ColFilter>): Record<string, ColFacet> {
  const cols = excelCols(spec);
  const out: Record<string, ColFacet> = {};
  for (const c of cols) {
    const rs = byColFilters(rows, cols, cf, c.k);
    if (isRangeCol(c)) {
      let lo: number | null = null;
      let hi: number | null = null;
      for (const r of rs) {
        const raw = r.v[c.k];
        if (raw == null || raw === "") continue;
        const n = Number(raw);
        if (!Number.isFinite(n)) continue;
        if (lo == null || n < lo) lo = n;
        if (hi == null || n > hi) hi = n;
      }
      out[c.k] = { kind: "range", lo, hi };
      continue;
    }
    const n = new Map<string, number>();
    for (const r of rs) {
      const v = cellText(c, r.v[c.k]);
      n.set(v, (n.get(v) ?? 0) + 1);
    }
    for (const v of cf[c.k]?.in ?? []) if (!n.has(v)) n.set(v, 0);
    const all = Array.from(n, ([v, x]) => ({ v, n: x })).sort((a, b) => (a.v === "—" ? 1 : b.v === "—" ? -1 : a.v.localeCompare(b.v, undefined, { numeric: true })));
    out[c.k] = { kind: "list", opts: all.slice(0, COL_FACET_CAP), more: Math.max(0, all.length - COL_FACET_CAP) };
  }
  return out;
}

export function colOf(cols: ColSpec[], k: string): ColSpec {
  return (
    cols.find((c) => c.k === k) ?? {
      k,
      l: k.replace(/Lbl$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase()),
      t: "t",
    }
  );
}

/**
 * The rows a folding list is read as: its totals, or — `parts` — every folded
 * row in its total's place. A row with nothing folded is the same row either way.
 */
export function unfold(spec: Pick<ListSpec, "fold">, rows: ListRow[], query: Pick<ListQuery, "parts">): ListRow[] {
  if (!spec.fold || !query.parts) return rows;
  return rows.flatMap((r) => (r.sub?.length ? r.sub : [r]));
}

/** A row's searchable words: every column, as the list draws it. */
function rowWords(cols: ColSpec[], r: ListRow, flagWords: Record<string, [string, Tone]>): string {
  return cols
    .map((c) => (c.t === "f" ? r.flags.map((f) => flagWords[f]?.[0] ?? f).join(" ") : cellText(c, r.v[c.k])))
    .join(" ")
    .toLowerCase();
}

/** Whether a search finds this row — itself, or one of the rows folded under it (a can's total is found by one of its lot numbers). */
export function rowMatches(cols: ColSpec[], r: ListRow, ql: string, flagWords: Record<string, [string, Tone]>): boolean {
  return rowWords(cols, r, flagWords).includes(ql) || (r.sub ?? []).some((x) => rowWords(cols, x, flagWords).includes(ql));
}

/** The folded rows a search found, so the list opens their total onto them. */
export function subMatches(cols: ColSpec[], r: ListRow, q: string, flagWords: Record<string, [string, Tone]>): boolean {
  const ql = q.trim().toLowerCase();
  return !!ql && (r.sub ?? []).some((x) => rowWords(cols, x, flagWords).includes(ql));
}

/** The column filters a spec offers, among the columns it actually draws (a column withheld by a power is not filterable). */
function filterCols(spec: Pick<ListSpec, "cols" | "filters">): ColSpec[] {
  return (spec.filters ?? []).flatMap((k) => spec.cols.filter((c) => c.k === k));
}

/** Rows whose column `c` shows `v` — matched on the words the list draws, so the choice and the cell cannot disagree. */
function byFilter(rows: ListRow[], c: ColSpec, v: string): ListRow[] {
  return rows.filter((r) => cellText(c, r.v[c.k]) === v);
}

/** The rows the filters, chip and search leave, sorted and grouped — every page of them. */
export function queryRows(
  spec: Pick<ListSpec, "cols" | "chips" | "godownKey" | "sortDefault" | "groups" | "fold" | "filters" | "colFilters">,
  rows: ListRow[],
  query: ListQuery,
  flagWords: Record<string, [string, Tone]>,
): { list: ListRow[]; beforeFx: ListRow[]; beforeCf: ListRow[]; beforeChip: ListRow[]; sort: ListSort | null; gk: string[] | null; gOf: (r: ListRow) => string; by: Map<string, ListRow[]> | null } {
  const cols = spec.cols;
  let all = unfold(spec, rows, query);
  if (query.ids) {
    const ids = new Set(query.ids);
    /* A total is kept when it, or a part folded under it, was named. */
    all = all.filter((r) => ids.has(r.id) || (r.sub ?? []).some((x) => ids.has(x.id)));
  }
  if (spec.godownKey && query.gf) all = all.filter((r) => String(r.v[spec.godownKey!] ?? "") === query.gf);
  const beforeFx = all;
  for (const c of filterCols(spec)) if (query.fx[c.k]) all = byFilter(all, c, query.fx[c.k]);
  const beforeCf = all;
  all = byColFilters(all, excelCols(spec), query.cf ?? {}, null);
  const beforeChip = all;
  if (spec.chips && query.chip) all = all.filter((r) => String(r.v[spec.chips!] ?? "") === query.chip);
  const ql = query.q.trim().toLowerCase();
  if (ql) all = all.filter((r) => rowMatches(cols, r, ql, flagWords));
  const sort = query.sort ?? (spec.sortDefault ? { k: spec.sortDefault[0], d: spec.sortDefault[1] } : null);
  if (sort) {
    all = all.slice().sort((a, b) => {
      const x = a.v[sort.k];
      const y = b.v[sort.k];
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x ?? "").localeCompare(String(y ?? ""));
      return c * sort.d;
    });
  }
  const gk = spec.groups && query.grp ? spec.groups : null;
  const gOf = (r: ListRow) => (gk ?? []).map((k) => cellText(colOf(cols, k), r.v[k])).join(" · ");
  if (!gk) return { list: all, beforeFx, beforeCf, beforeChip, sort, gk, gOf, by: null };
  /* Each group contiguous, in the order its first row appears. Pushed onto
     its own array — spreading a fresh copy per row was quadratic, and on a
     group of eight thousand that is the whole page load. */
  const by = new Map<string, ListRow[]>();
  for (const r of all) {
    const g = gOf(r);
    const at = by.get(g);
    if (at) at.push(r);
    else by.set(g, [r]);
  }
  return { list: Array.from(by.values()).flat(), beforeFx, beforeCf, beforeChip, sort, gk, gOf, by };
}

/** The status-value chips over the rows before a chip is picked. */
export function chipCounts(spec: Pick<ListSpec, "chips">, rows: ListRow[]): { v: string; n: number }[] {
  if (!spec.chips) return [];
  const n = new Map<string, number>();
  for (const r of rows) {
    const v = String(r.v[spec.chips] ?? "");
    if (v) n.set(v, (n.get(v) ?? 0) + 1);
  }
  return Array.from(n, ([v, c]) => ({ v, n: c }));
}

/**
 * Each column filter's choices. A filter's counts are taken over the rows the
 * OTHER filters leave, so picking a product narrows the QC choices to that
 * product's — and a choice still picked is offered even where nothing now has
 * it, or the select would silently show "All" while the list is filtered.
 */
export function facetCounts(spec: Pick<ListSpec, "cols" | "filters">, rows: ListRow[], fx: Record<string, string>): Facet[] {
  const cs = filterCols(spec);
  return cs.map((c) => {
    let rs = rows;
    for (const o of cs) if (o.k !== c.k && fx[o.k]) rs = byFilter(rs, o, fx[o.k]);
    const n = new Map<string, number>();
    for (const r of rs) {
      const v = cellText(c, r.v[c.k]);
      if (v && v !== "—") n.set(v, (n.get(v) ?? 0) + 1);
    }
    if (fx[c.k] && !n.has(fx[c.k])) n.set(fx[c.k], 0);
    const opts = Array.from(n, ([v, x]) => ({ v, n: x })).sort((a, b) => a.v.localeCompare(b.v, undefined, { numeric: true }));
    return { k: c.k, l: c.l, opts };
  });
}

export function badgeWidths(cols: ColSpec[], rows: ListRow[], flagWords: Record<string, [string, Tone]>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of cols) {
    if (c.t === "s") out[c.k] = rows.reduce((n, r) => Math.max(n, r.v[c.k] == null ? 0 : String(r.v[c.k]).length), 0);
    if (c.t === "f") out[c.k] = rows.reduce((n, r) => r.flags.reduce((m, f) => Math.max(m, (flagWords[f]?.[0] ?? f).length), n), 0);
  }
  return out;
}

/**
 * The facts a group's header draws: the first row's values, except that a
 * fact the rows DISAGREE on is every value they carry, in order — a goods
 * receipt across two POs heads "PO-15, PO-16", never only its first line's,
 * and a first line with no value does not hide a later line's.
 */
export function groupHeadValues(rs: ListRow[], keys: string[]): ListRow["v"] {
  const head: ListRow["v"] = { ...(rs[0]?.v ?? {}) };
  for (const k of keys) {
    const seen: string[] = [];
    for (const r of rs) {
      const v = r.v[k];
      if (typeof v === "string" && v !== "" && !seen.includes(v)) seen.push(v);
    }
    if (seen.length > 1 || (seen.length === 1 && head[k] !== seen[0])) head[k] = seen.join(", ");
  }
  return head;
}

/** One page of a list, with everything the toolbar, the group headers and the pager need about the rest. */
export function pageOf(spec: ListSpec, rows: ListRow[], query: ListQuery, flagWords: Record<string, [string, Tone]>): ListPage {
  const r = queryRows(spec, rows, query, flagWords);
  const total = r.list.length;
  const pages = Math.max(1, Math.ceil(total / query.size));
  const page = Math.min(query.page, pages);
  const slice = r.list.slice((page - 1) * query.size, page * query.size);
  const groupOf: Record<string, string> = {};
  const groups: Record<string, ListGroup> = {};
  if (r.by) {
    for (const row of slice) {
      const g = r.gOf(row);
      groupOf[row.id] = g;
      if (groups[g]) continue;
      const rs = r.by.get(g) ?? [];
      const agg = aggsOf(spec.agg).map((a) => {
        if (!spec.cols.some((c) => c.k === a.k)) return null;
        const s = rs.reduce((t, x) => t + (Number(x.v[a.k]) || 0), 0);
        const missing = a.missing ? rs.filter((x) => x.v[a.k] == null || x.v[a.k] === "").length : 0;
        return { v: a.t === "avg" ? s / (rs.length || 1) : s, missing };
      });
      groups[g] = { n: rs.length, agg, ids: rs.map((x) => x.id), head: groupHeadValues(rs, spec.groupHead ?? []) };
    }
  }
  return {
    rows: slice,
    total,
    page,
    beforeChip: r.beforeChip.length,
    chips: chipCounts(spec, r.beforeChip),
    facets: facetCounts(spec, r.beforeFx, query.fx),
    ...(spec.colFilters ? { colFacets: colFacetsOf(spec, r.beforeCf, query.cf ?? {}) } : {}),
    sort: r.sort,
    groupOf,
    groups,
    badgeChars: badgeWidths(spec.cols, unfold(spec, rows, query), flagWords),
    all: rows.length,
  };
}

/** The filtered list as CSV, every page of it, as the Export button gives it. */
export function listCsv(spec: ListSpec, rows: ListRow[], query: ListQuery, flagWords: Record<string, [string, Tone]>): { csv: string; n: number } {
  const { list } = queryRows(spec, rows, query, flagWords);
  const head = spec.cols.map((c) => c.l).join(",");
  const body = list
    .map((r) =>
      spec.cols
        .map((c) => `"${(c.t === "f" ? r.flags.map((f) => flagWords[f]?.[0] ?? f).join("; ") : cellText(c, r.v[c.k])).replace(/"/g, '""')}"`)
        .join(","),
    )
    .join("\n");
  return { csv: `${head}\n${body}`, n: list.length };
}
