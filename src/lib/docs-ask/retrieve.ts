/* ---------------------------------------------------------------------------
 * The documentation's search engine — one engine for ⌘K and for "Ask the docs".
 *
 * PURE: sections in, ranked sections out, no I/O. `docs-ask/corpus.ts` builds
 * it once per process from the build-time `ask.json`; `/api/docs/search` asks
 * it for ⌘K on every keystroke and the assistant asks it through its tools.
 * One engine, so the search box and the answer cannot disagree about which
 * section is about a thing.
 *
 * HOW A SECTION IS SCORED — BM25F over an inverted index. A section has four
 * fields and a word counts for more in a better one: the page's title, the
 * section's heading, the page's one-line summary, and the body (the only field
 * normalised for length, so a long section is not found just for being long).
 * Each word's contribution is worked out at BUILD time, so a query is a few
 * posting-list lookups and additions — well under a millisecond on the whole
 * book.
 *
 * HOW A QUERY IS READ. Every word of the question is a GROUP of acceptable
 * spellings, and a section scores the best spelling of each group it holds:
 *
 *   - the word itself, folded to a light stem ("reminders" meets "reminder");
 *   - the word as a PREFIX while it is still being typed ("dispa" → dispatch);
 *   - a TYPO's nearest real words, within one edit for a short word and two
 *     for a long one ("recieve" → receive), taken only where the word as typed
 *     is not a word the docs use;
 *   - MahekOne's own ABBREVIATIONS and plain-word equivalents both ways —
 *     "PO" is a purchase order, "GRN" a goods receipt, "punch in" is
 *     attendance — at a lower weight than the word itself.
 *
 * Then: a section holding EVERY group beats one holding the rarest word only;
 * words that sit next to each other in the question and in a heading or the
 * body earn a phrase bonus; the Developer tab is held back a little unless the
 * question is about code; and the page the reader is on is nudged up.
 * ------------------------------------------------------------------------- */

export type AskSection = {
  app: string;
  slug: string;
  tab: string | null;
  heading: string | null;
  id: string | null;
  text: string;
};

export type SectionRef = string;

/** `crm/call-log/guide#why-a-customer-is-missing` — the one spelling of a section. */
export function refOf(s: Pick<AskSection, "app" | "slug" | "tab" | "id">): SectionRef {
  return `${s.app}/${s.slug}/${s.tab ?? "guide"}${s.id ? `#${s.id}` : ""}`;
}

/** The section's address in the app: the same rule `pageHref` follows for the first tab. */
export function hrefOf(s: Pick<AskSection, "app" | "slug" | "tab" | "id">, firstTab: string | null): string {
  const tab = !s.tab || s.tab === firstTab ? "" : `/${s.tab}`;
  return `/docs/${s.app}/${s.slug}${tab}${s.id ? `#${s.id}` : ""}`;
}

/* ------------------------------------------------------------------ words */

const STOP = new Set(
  "a an and are as at be been but by can could do does did for from has have had how i if in into is it its me my of on or our so that the their them then there these they this to was we were what when where which who whom why will with would you your about after before than too very also not no just any all should shall may might much many get got".split(
    " ",
  ),
);

/** A word's light stem: enough that plurals, -ing and -ed forms meet, no more. */
export function stem(word: string): string {
  let w = word;
  // Plural first, so "settings" and "setting" fold the same way.
  if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 3 && w.endsWith("es") && !w.endsWith("ses") && !w.endsWith("ies")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 5 && w.endsWith("ied")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  // "approve"/"approv(ed)", "receive"/"receiv(ed)": a final e is noise once the ending is gone.
  if (w.length > 4 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

const words = (text: string) => text.toLowerCase().replace(/(\w)['’](\w)/g, "$1$2").match(/[a-z0-9]+/g) ?? [];

export function tokens(text: string): string[] {
  return words(text)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);
}

/**
 * The body as words, without the drawing syntax: a wireframe's tag names and a
 * diagram's keywords are not what the section is about — and "flowchart LR"
 * would otherwise make every diagram a match for "LR", the lorry receipt.
 */
function bodyTokens(text: string): string[] {
  return tokens(
    text
      .replace(/\b(flowchart|graph)\s+(TD|TB|LR|RL|BT)\b/g, " ")
      .replace(/\b(sequenceDiagram|stateDiagram(-v2)?|participant|autonumber|subgraph|classDef)\b/g, " ")
      .replace(/<br\s*\/?>/g, " ")
      .replace(/<\/?(Wireframe|Wf\w+|Hotspots?)\b/g, " ")
      .replace(/\b(nav|active|caption|url|primary|sub|tone|placeholder|wide|side|highlight|columns|rows|items|label|title|h|n)=/g, " ")
      .replace(/```\w*/g, " "),
  );
}

/* ---------------------------------------------------------------- synonyms */

/**
 * MahekOne's own vocabulary: an abbreviation and the words it stands for, or
 * two ways people name one thing. Read both ways — the question may use either
 * and the page the other.
 */
const SYNONYMS: string[][] = [
  ["po", "purchase order"],
  ["grn", "goods receipt", "goods inward"],
  ["lr", "lorry receipt"],
  ["cn", "credit note"],
  ["otp", "one time code", "sign in code"],
  ["sfg", "semi finished"],
  ["fg", "finished good"],
  ["rm", "raw material"],
  ["qc", "quality check"],
  ["gst", "gstin"],
  ["eod", "end of day"],
  ["am", "account manager"],
  ["sm", "sales manager"],
  ["kpi", "owner kpis"],
  ["pdc", "post dated cheque"],
  ["utr", "transfer reference"],
  ["sku", "product"],
  ["mbos", "handset", "field app"],
  ["login", "sign in"],
  ["logout", "sign out"],
  ["password", "credential"],
  ["punch", "attendance"],
  ["checkin", "check in"],
  ["expense", "reimbursement", "claim"],
  ["outstanding", "dues", "owed"],
  ["collection", "payment"],
  ["customer", "shop", "party"],
  ["salesman", "field sales"],
  // Plural on purpose: a quoted singular reads as the retired role to the guard in mbos-wire.test.ts; the stem is the same.
  ["telecallers", "calling"],
  ["dispatch", "shipping"],
  ["stock", "inventory"],
  ["deploy", "release"],
  ["backup", "restore"],
  ["whatsapp", "wati"],
  ["complaint", "grievance"],
  ["discount", "rebate"],
  ["queue", "call log"],
  ["leave", "holiday"],
  ["map", "location"],
  ["gps", "location"],
  ["track", "trail"],
  ["laptop", "local"],
  ["mileage", "odometer", "kilometre"],
  ["selfie", "photograph"],
  ["godown", "warehouse"],
  ["lorry", "transport"],
];

/* ------------------------------------------------------------- the index */

type Posting = { docs: Int32Array; w: Float32Array };

export type DocsIndex = {
  sections: AskSection[];
  byRef: Map<SectionRef, number>;
  postings: Map<string, Posting>;
  /** Terms by first letter, for the prefix search. */
  vocab: Map<string, string[]>;
  /** Terms by length, for the typo search: a word is only compared with words near its own length. */
  byLength: Map<number, string[]>;
  df: Map<string, number>;
  /** Title + heading as stems, and the body as stems, for the phrase bonus. */
  head: string[][];
  /** The page title's stems and the heading's, for "the title names it". */
  titleSet: Array<Set<string>>;
  headingSet: Array<Set<string>>;
  body: string[][];
  synonyms: Map<string, string[][]>;
};

export type SectionMeta = { title: string; summary: string };

const K1 = 1.2;
const B = 0.75;
const FIELD = { title: 3, heading: 2.5, summary: 0.8, body: 1 };

export function buildIndex(sections: AskSection[], metaOf: (s: AskSection) => SectionMeta): DocsIndex {
  const byRef = new Map<SectionRef, number>();
  const n = sections.length;
  const head: string[][] = [];
  const body: string[][] = [];
  const titleSet: Array<Set<string>> = [];
  const headingSet: Array<Set<string>> = [];
  const raw = new Map<string, Array<[number, number]>>();
  let total = 0;
  const fields = sections.map((s, i) => {
    byRef.set(refOf(s), i);
    const meta = metaOf(s);
    const f = { title: tokens(meta.title), heading: tokens(s.heading ?? ""), summary: tokens(meta.summary), body: bodyTokens(s.text) };
    head.push([...f.heading, ...f.title]);
    titleSet.push(new Set(f.title));
    headingSet.push(new Set(f.heading));
    body.push(f.body);
    total += f.body.length;
    return f;
  });
  const avg = n ? total / n : 1;

  fields.forEach((f, i) => {
    const tf = new Map<string, number>();
    const add = (list: string[], weight: number) => {
      for (const t of list) tf.set(t, (tf.get(t) ?? 0) + weight);
    };
    add(f.title, FIELD.title);
    add(f.heading, FIELD.heading);
    add(f.summary, FIELD.summary);
    add(f.body, FIELD.body / (1 - B + (B * f.body.length) / avg));
    for (const [t, v] of tf) {
      let list = raw.get(t);
      if (!list) raw.set(t, (list = []));
      list.push([i, v]);
    }
  });

  const postings = new Map<string, Posting>();
  const df = new Map<string, number>();
  const vocab = new Map<string, string[]>();
  const byLength = new Map<number, string[]>();
  for (const [t, list] of raw) {
    let sized = byLength.get(t.length);
    if (!sized) byLength.set(t.length, (sized = []));
    sized.push(t);
    const idf = Math.log(1 + (n - list.length + 0.5) / (list.length + 0.5));
    const docs = new Int32Array(list.length);
    const w = new Float32Array(list.length);
    list.forEach(([d, v], k) => {
      docs[k] = d;
      w[k] = (idf * (v * (K1 + 1))) / (v + K1);
    });
    postings.set(t, { docs, w });
    df.set(t, list.length);
    const first = t[0];
    let bucket = vocab.get(first);
    if (!bucket) vocab.set(first, (bucket = []));
    bucket.push(t);
  }

  const synonyms = new Map<string, string[][]>();
  for (const set of SYNONYMS) {
    const forms = set.map(tokens).filter((f) => f.length);
    for (const form of forms) {
      const key = form.join(" ");
      const others = forms.filter((o) => o.join(" ") !== key);
      synonyms.set(key, [...(synonyms.get(key) ?? []), ...others]);
    }
  }

  // Most-used first, so a prefix or a typo prefers the word the docs lean on.
  const byUse = (a: string, b: string) => (df.get(b) ?? 0) - (df.get(a) ?? 0);
  for (const list of vocab.values()) list.sort(byUse);
  for (const list of byLength.values()) list.sort(byUse);

  return { sections, byRef, postings, vocab, df, byLength, head, body, titleSet, headingSet, synonyms };
}

/* -------------------------------------------------------------- the query */

/** Damerau–Levenshtein distance, giving up past `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = b.length;
  let prev2 = new Int32Array(m + 1);
  let prev = new Int32Array(m + 1);
  let cur = new Int32Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let best = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const bj = b.charCodeAt(j - 1);
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ai === bj ? 0 : 1));
      if (i > 1 && j > 1 && ai === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === bj) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    [prev2, prev, cur] = [prev, cur, prev2];
  }
  return prev[m];
}

/** One way of meeting a word of the question: the stems that must all be present, and what it is worth. */
type Variant = { terms: string[]; weight: number };
type Group = { word: string; variants: Variant[] };

export type QueryPlan = { groups: Group[]; codeIntent: boolean };

const CODE_WORDS = new Set(
  ["code", "table", "column", "route", "api", "endpoint", "service", "function", "schema", "migration", "test", "file", "component", "engine", "sql", "developer", "query", "type", "module", "action", "server", "cron", "job", "script", "env", "variable"].map(stem),
);

export function planQuery(index: DocsIndex, query: string): QueryPlan {
  const typing = !/\s$/.test(query);
  const qs = tokens(query);
  // A word made only of stop words ("what is it") asks nothing.
  if (!qs.length) return { groups: [], codeIntent: false };

  const groups: Group[] = [];
  const used = new Set<number>();

  // Multi-word synonyms first ("purchase order" → "po"), longest phrase wins.
  for (let i = 0; i < qs.length; i++) {
    for (const len of [3, 2]) {
      if (i + len > qs.length || [...Array(len).keys()].some((k) => used.has(i + k))) continue;
      const phrase = qs.slice(i, i + len);
      const alts = index.synonyms.get(phrase.join(" "));
      if (!alts) continue;
      for (let k = 0; k < len; k++) used.add(i + k);
      groups.push({ word: phrase.join(" "), variants: [{ terms: phrase, weight: 1 }, ...alts.map((terms) => ({ terms, weight: 0.7 }))] });
    }
  }

  qs.forEach((term, i) => {
    if (used.has(i)) return;
    const variants: Variant[] = [];
    const known = index.postings.has(term);
    if (known) variants.push({ terms: [term], weight: 1 });
    const last = i === qs.length - 1 && typing;

    // Still being typed, or never finished: the words it begins.
    if ((last || !known) && term.length >= 2) {
      const begins: string[] = [];
      for (const t of index.vocab.get(term[0]) ?? []) {
        if (t !== term && t.startsWith(term)) begins.push(t);
        if (begins.length >= 24) break;
      }
      for (const t of begins) variants.push({ terms: [t], weight: known ? 0.6 : 0.85 });
    }

    // A typo: the nearest words the docs actually use.
    if (!known && term.length >= 4) {
      const max = term.length >= 8 ? 2 : 1;
      const near: Array<[string, number]> = [];
      for (let len = term.length - max; len <= term.length + max; len++) {
        for (const t of index.byLength.get(len) ?? []) {
          const d = editDistance(term, t, max);
          if (d <= max) near.push([t, d]);
        }
      }
      near
        .sort((a, b) => a[1] - b[1] || (index.df.get(b[0]) ?? 0) - (index.df.get(a[0]) ?? 0))
        .slice(0, 6)
        .forEach(([t, d]) => variants.push({ terms: [t], weight: d === 1 ? 0.8 : 0.6 }));
    }

    for (const alt of index.synonyms.get(term) ?? []) variants.push({ terms: alt, weight: 0.7 });

    if (variants.length) groups.push({ word: term, variants });
    // A word nothing in the docs resembles still counts as asked, so coverage stays honest.
    else groups.push({ word: term, variants: [] });
  });

  return { groups, codeIntent: qs.some((t) => CODE_WORDS.has(t)) };
}

export type SearchHit = {
  section: AskSection;
  ref: SectionRef;
  score: number;
  /** The stems that matched, for the excerpt and highlighting. */
  matched: string[];
};

export type SearchOptions = {
  app?: string | null;
  prefer?: { app: string; slug: string | null } | null;
  limit?: number;
  /** At most this many sections from one page, so a page cannot fill the list. */
  perPage?: number;
};

export function searchDocs(index: DocsIndex, query: string, opts: SearchOptions = {}): SearchHit[] {
  const plan = planQuery(index, query);
  const live = plan.groups.filter((g) => g.variants.length);
  if (!live.length) return [];
  const asked = plan.groups.length;

  // Per group, each section's best variant score.
  const n = index.sections.length;
  const total = new Float64Array(n);
  const covered = new Uint8Array(n);
  const matched = new Map<number, Set<string>>();
  const best = new Float64Array(n);
  const bestVariant = new Int32Array(n);

  for (const group of live) {
    best.fill(0);
    bestVariant.fill(-1);
    group.variants.forEach((v, vi) => {
      // The usual case, one word: straight off its posting list, nothing allocated.
      if (v.terms.length === 1) {
        const p = index.postings.get(v.terms[0]);
        if (!p) return;
        for (let k = 0; k < p.docs.length; k++) {
          const d = p.docs[k];
          const score = p.w[k] * v.weight;
          if (score > best[d]) {
            best[d] = score;
            bestVariant[d] = vi;
          }
        }
        return;
      }
      // Every stem of a multi-word variant must be present; it scores their average.
      let acc: Map<number, number> | null = null;
      for (const t of v.terms) {
        const p = index.postings.get(t);
        if (!p) {
          acc = new Map();
          break;
        }
        const next = new Map<number, number>();
        for (let k = 0; k < p.docs.length; k++) {
          const d = p.docs[k];
          if (acc === null) next.set(d, p.w[k]);
          else if (acc.has(d)) next.set(d, acc.get(d)! + p.w[k]);
        }
        acc = next;
      }
      if (!acc) return;
      for (const [d, s] of acc) {
        const score = (s / v.terms.length) * v.weight;
        if (score > best[d]) {
          best[d] = score;
          bestVariant[d] = vi;
        }
      }
    });
    for (let d = 0; d < n; d++) {
      if (!best[d]) continue;
      total[d] += best[d];
      covered[d] += 1;
      let m = matched.get(d);
      if (!m) matched.set(d, (m = new Set()));
      for (const t of group.variants[bestVariant[d]].terms) m.add(t);
    }
  }

  const exact = plan.groups.map((g) => g.word.split(" ")).flat();
  const candidates: SearchHit[] = [];
  for (let d = 0; d < n; d++) {
    if (!total[d]) continue;
    const s = index.sections[d];
    if (opts.app && s.app !== opts.app) continue;
    const coverage = covered[d] / asked;
    let score = total[d] * (0.08 + 0.92 * coverage * coverage);
    // The page's title or the section's heading NAMING what was asked is the strongest sign there is.
    let inTitle = 0;
    let inHeading = 0;
    for (const g of live) {
      const t = index.titleSet[d];
      const h = index.headingSet[d];
      if (g.variants.some((v) => v.terms.every((x) => t.has(x)))) inTitle += 1;
      if (g.variants.some((v) => v.terms.every((x) => h.has(x)))) inHeading += 1;
    }
    score *= 1 + (0.8 * inTitle) / asked + (0.35 * inHeading) / asked;
    // An overview mentions everything; it is the answer only when nothing more particular is.
    if (s.slug === "overview" || s.slug === "architecture") score *= 0.8;
    if (s.tab === "developer") score *= plan.codeIntent ? 1.15 : 0.82;
    if (opts.prefer && s.app === opts.prefer.app) score *= s.slug === opts.prefer.slug ? 1.15 : 1.05;
    candidates.push({ section: s, ref: refOf(s), score, matched: [...(matched.get(d) ?? [])] });
  }
  candidates.sort((a, b) => b.score - a.score);

  // The phrase bonus, on the leaders only: the words of the question side by side.
  if (exact.length > 1) {
    const pairs = new Set<string>();
    for (let i = 0; i + 1 < exact.length; i++) pairs.add(`${exact[i]} ${exact[i + 1]}`);
    for (const h of candidates.slice(0, 80)) {
      const d = index.byRef.get(h.ref)!;
      const inHead = adjacent(index.head[d], pairs);
      const inBody = adjacent(index.body[d], pairs);
      h.score *= 1 + 0.25 * inHead + 0.08 * Math.min(inBody, 3);
    }
    candidates.sort((a, b) => b.score - a.score);
  }

  const limit = opts.limit ?? 8;
  const perPage = opts.perPage ?? Infinity;
  const out: SearchHit[] = [];
  const pageCount = new Map<string, number>();
  for (const h of candidates) {
    const key = `${h.section.app}/${h.section.slug}`;
    const c = pageCount.get(key) ?? 0;
    if (c >= perPage) continue;
    pageCount.set(key, c + 1);
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}

function adjacent(list: string[], pairs: Set<string>): number {
  let hits = 0;
  for (let i = 0; i + 1 < list.length; i++) if (pairs.has(`${list[i]} ${list[i + 1]}`)) hits += 1;
  return hits;
}

/* --------------------------------------------------------------- excerpt */

/**
 * The few hundred characters of a section around the words that matched, with
 * the drawing source left out — an excerpt of a wireframe's markup tells a
 * reader nothing.
 */
export function excerpt(text: string, matched: string[] | string, length = 600): string {
  const clean = text.replace(/```(mermaid|wireframe|svg)[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
  if (clean.length <= length) return clean;
  const want = new Set(typeof matched === "string" ? tokens(matched) : matched);
  let at = 0;
  for (const m of clean.matchAll(/[A-Za-z0-9]+/g)) {
    if (want.has(stem(m[0].toLowerCase()))) {
      at = Math.max(0, m.index! - 120);
      break;
    }
  }
  return `${at > 0 ? "…" : ""}${clean.slice(at, at + length)}${at + length < clean.length ? "…" : ""}`;
}

/** The words of a passage that a search matched, as they are spelled there — for highlighting. */
export function matchedWords(text: string, matched: string[]): string[] {
  const want = new Set(matched);
  const out = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z0-9]+/g)) if (want.has(stem(m[0].toLowerCase()))) out.add(m[0]);
  return [...out];
}
