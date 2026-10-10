/* ---------------------------------------------------------------------------
 * "Ask the docs" — finding the sections a question is about.
 *
 * PURE, like every engine: sections in, ranked sections out, no I/O. The
 * service hands it the build-time `ask.json` and the model calls it through
 * the `search_docs` tool as many times as a question needs.
 *
 * WHY NOT HAND THE MODEL EVERYTHING. The written pages are about 1.4 million
 * characters — several hundred thousand tokens — so every question would cost
 * a whole book and still be slow. A section is the unit instead: a heading and
 * the words under it, which is also the unit a citation links to.
 *
 * BM25 over the section's own words, with the page title and the heading
 * counted again on top, because "Call Log" in a heading is a far better sign
 * than "Call Log" in passing. Words are folded to a crude stem so "reminders"
 * finds "reminder". `app` narrows to one app; `prefer` nudges the page the
 * reader is standing on up, without hiding anything else.
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

const STOP = new Set(
  "a an and are as at be been but by can do does for from has have how i if in into is it its me my of on or our so that the their them then there these they this to was we were what when where which who why will with you your about after before than too very also not no just any all".split(
    " ",
  ),
);

/** A word's crude stem: enough that plurals and -ing forms meet, no more. */
export function stem(word: string): string {
  let w = word;
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("es") && !w.endsWith("ses")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  return w;
}

export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 1 && !STOP.has(w)).map(stem);
}

type Doc = { tf: Map<string, number>; len: number; title: Set<string> };

export type DocsIndex = {
  sections: AskSection[];
  docs: Doc[];
  df: Map<string, number>;
  avgLen: number;
  byRef: Map<SectionRef, number>;
};

/**
 * Build once per process. `titleOf` names the page a section sits on, so a
 * section is found by its page's name as well as its own heading.
 */
export function buildIndex(sections: AskSection[], titleOf: (s: AskSection) => string): DocsIndex {
  const df = new Map<string, number>();
  const byRef = new Map<SectionRef, number>();
  let total = 0;
  const docs = sections.map((s, i) => {
    byRef.set(refOf(s), i);
    const tf = new Map<string, number>();
    const body = tokens(s.text);
    for (const t of body) tf.set(t, (tf.get(t) ?? 0) + 1);
    const title = new Set([...tokens(titleOf(s)), ...tokens(s.heading ?? "")]);
    for (const t of new Set([...tf.keys(), ...title])) df.set(t, (df.get(t) ?? 0) + 1);
    total += body.length;
    return { tf, len: body.length, title };
  });
  return { sections, docs, df, avgLen: sections.length ? total / sections.length : 1, byRef };
}

export type SearchHit = { section: AskSection; ref: SectionRef; score: number };

export function searchDocs(
  index: DocsIndex,
  query: string,
  opts: { app?: string | null; prefer?: { app: string; slug: string } | null; limit?: number } = {},
): SearchHit[] {
  const terms = [...new Set(tokens(query))];
  if (!terms.length) return [];
  const n = index.sections.length;
  const k1 = 1.2;
  const b = 0.75;
  const hits: SearchHit[] = [];
  index.docs.forEach((d, i) => {
    const s = index.sections[i];
    if (opts.app && s.app !== opts.app) return;
    let score = 0;
    let matched = 0;
    for (const t of terms) {
      const df = index.df.get(t) ?? 0;
      if (!df) continue;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      const f = d.tf.get(t) ?? 0;
      const inTitle = d.title.has(t);
      if (!f && !inTitle) continue;
      matched += 1;
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / index.avgLen)));
      if (inTitle) score += idf * 1.5;
    }
    if (!score) return;
    // A section that has every word of the question beats one that has the rarest one.
    score *= 0.5 + matched / terms.length / 2;
    if (opts.prefer && s.app === opts.prefer.app) score *= s.slug === opts.prefer.slug ? 1.35 : 1.1;
    hits.push({ section: s, ref: refOf(s), score });
  });
  return hits.sort((a, b2) => b2.score - a.score).slice(0, opts.limit ?? 8);
}

/** The few hundred characters of a section around the words asked about. */
export function excerpt(text: string, query: string, length = 600): string {
  if (text.length <= length) return text;
  const lower = text.toLowerCase();
  const positions = (query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).map((w) => lower.indexOf(w)).filter((i) => i >= 0);
  const at = positions.length ? Math.max(0, Math.min(...positions) - 120) : 0;
  return `${at > 0 ? "…" : ""}${text.slice(at, at + length)}${at + length < text.length ? "…" : ""}`;
}

