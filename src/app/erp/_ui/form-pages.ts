/* ---------------------------------------------------------------------------
 * HOW A FORM IS CUT INTO PAGES. Pure, so the rule is tested without a browser.
 *
 * A short form is one page: splitting six fields across three screens makes
 * somebody press Next twice to do what one glance did. Past that, a form is
 * cut at its SECTIONS — the `sec` headings a screen already gives its fields —
 * and small sections are packed together so no page is a single box. The
 * lines of a multi-line document are a page of their own, and a form of more
 * than one page ends on a Review page that says back what will be saved.
 *
 * Pages are planned from the fields VISIBLE now, every render: a field that
 * appears because of an answer (`when`) lands on its section's page, and a
 * section with nothing visible is no page at all.
 * ------------------------------------------------------------------------- */

export type PlanField = { k: string; sec?: string };

export type FormPage =
  | { kind: "fields"; title: string; keys: string[] }
  | { kind: "lines"; title: string }
  | { kind: "review"; title: string };

/** At or below this many fields, and with no lines, a form is one page. */
export const ONE_PAGE_MAX = 7;
/** A page is packed with whole sections up to this many fields. */
export const PAGE_FIELDS = 8;

export function plural(label: string): string {
  const l = label.trim();
  if (!l) return "Lines";
  /* "Raw material (litres)" is "Raw materials (litres)": the noun takes the s, not the bracket. */
  const unit = /^(.*\S)(\s*\(.*\))$/.exec(l);
  if (unit) return `${plural(unit[1])}${unit[2]}`;
  if (/s$/i.test(l)) return l;
  if (/[^aeiou]y$/i.test(l)) return `${l.slice(0, -1)}ies`;
  return `${l}s`;
}

export function planPages(fields: PlanField[], opts: { lines?: string | null } = {}): FormPage[] {
  const hasLines = opts.lines != null;
  if (!hasLines && fields.length <= ONE_PAGE_MAX) return [{ kind: "fields", title: "", keys: fields.map((f) => f.k) }];

  /* Runs of one section, in the order drawn. Fields before the first heading are "Details". */
  const runs: { sec: string; keys: string[] }[] = [];
  for (const f of fields) {
    const sec = f.sec?.trim() || (runs.length ? runs[runs.length - 1].sec : "Details");
    const last = runs[runs.length - 1];
    if (last && last.sec === sec) last.keys.push(f.k);
    else runs.push({ sec, keys: [f.k] });
  }

  const pages: FormPage[] = [];
  /* With lines, the header is the page before them — a few fields of it never earn their own pages. */
  if (fields.length && (fields.length <= PAGE_FIELDS || runs.length === 1)) {
    pages.push({ kind: "fields", title: runs.length === 1 && runs[0].sec !== "Details" ? runs[0].sec : "Details", keys: fields.map((f) => f.k) });
  } else {
    let cur: { secs: string[]; keys: string[] } | null = null;
    const flush = () => {
      if (!cur) return;
      const title = cur.secs.length > 2 ? `${cur.secs[0]} & more` : cur.secs.join(" & ");
      pages.push({ kind: "fields", title, keys: cur.keys });
      cur = null;
    };
    for (const r of runs) {
      if (cur && cur.keys.length + r.keys.length > PAGE_FIELDS) flush();
      if (!cur) cur = { secs: [], keys: [] };
      cur.secs.push(r.sec);
      cur.keys.push(...r.keys);
    }
    flush();
  }
  if (hasLines) pages.push({ kind: "lines", title: plural(opts.lines ?? "") });
  if (pages.length > 1) pages.push({ kind: "review", title: "Review" });
  return pages;
}

/** The page an error key (`h.item`, `l3.qty`) is on, or -1. */
export function pageOfError(pages: FormPage[], key: string): number {
  if (/^l\d+\./.test(key)) return pages.findIndex((p) => p.kind === "lines");
  const k = key.replace(/^h\./, "");
  const i = pages.findIndex((p) => p.kind === "fields" && p.keys.includes(k));
  return i;
}
