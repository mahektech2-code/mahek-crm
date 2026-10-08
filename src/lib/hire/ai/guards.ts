/* ---------------------------------------------------------------------------
 * The orchestration layer's two guards, PURE so they can be tested on their
 * own (spec §2.2, §4.1, §10.2, §10.3).
 *
 *  - `redact` strips identity numbers, phone numbers and emails from text
 *    before it leaves for a model.
 *  - `findProhibited` reads every STRING VALUE of an output (never its keys —
 *    `confidence` is a field name, not a judgement about a person) for the
 *    inferences Hire never makes.
 *  - `locate` / `checkEvidence` decide whether a quote is really in the text
 *    it claims to come from. A score without a quote that resolves is not a
 *    score.
 * ------------------------------------------------------------------------- */

const PATTERNS: [string, RegExp][] = [
  ["aadhaar", /\b\d{4}\s?\d{4}\s?\d{4}\b/g],
  ["pan", /\b[A-Z]{5}\d{4}[A-Z]\b/g],
  ["phone", /(?:\+91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b/g],
  ["email", /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g],
  ["account", /\b\d{9,18}\b/g],
  ["ifsc", /\b[A-Z]{4}0[A-Z0-9]{6}\b/g],
];

export function redact(text: string): { text: string; fields: string[] } {
  let out = text;
  const fields = new Set<string>();
  for (const [name, re] of PATTERNS) {
    out = out.replace(re, () => {
      fields.add(name);
      return `[${name} removed]`;
    });
  }
  return { text: out, fields: [...fields] };
}

/** The inferences Hire never makes (spec §2.2). Word-bounded, on values only. */
const PROHIBITED: [string, RegExp][] = [
  ["personality", /\b(personality|introvert(ed)?|extrovert(ed)?|charismatic|arrogant|timid|shy)\b/i],
  ["emotion", /\b(nervous|anxious|anxiety|emotional|seemed (happy|sad|upset|angry)|fearful)\b/i],
  ["appearance", /\b(appearance|good[- ]looking|attractive|well[- ]dressed|grooming|presentable|his looks|her looks)\b/i],
  ["accent or demeanour", /\b(accent|body language|demeanou?r|eye contact)\b/i],
  ["health", /\b(disabilit(y|ies)|illness|medical condition|health (issue|problem)s?)\b/i],
  ["religion or caste", /\b(religion|religious|caste|hindu|muslim|christian|sikh|jain|dalit|brahmin)\b/i],
  ["family", /\b(married|unmarried|marital|pregnan(t|cy)|family planning|has children|newly[- ]wed)\b/i],
];

export function findProhibited(output: unknown): string | null {
  const strings: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(output);
  const text = strings.join("\n");
  for (const [name, re] of PROHIBITED) if (re.test(text)) return name;
  return null;
}

/** Quotes, dashes and whitespace normalised — the model may straighten a curly quote. */
export function normaliseForMatch(s: string): string {
  return s
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Where a verbatim quote sits in its source, or null when it is not there. */
export function locate(source: string, quote: string): { start: number; end: number } | null {
  const q = quote.trim();
  if (q.length < 3) return null;
  const exact = source.indexOf(q);
  if (exact >= 0) return { start: exact, end: exact + q.length };
  /* Fall back to a normalised match, mapped back onto the original offsets. */
  const map: number[] = [];
  let norm = "";
  let prevSpace = false;
  for (let i = 0; i < source.length; i++) {
    const c = normaliseForMatch(source[i]) || (/\s/.test(source[i]) ? " " : "");
    if (c === " ") {
      if (prevSpace || norm.length === 0) continue;
      prevSpace = true;
    } else prevSpace = false;
    for (const ch of c) {
      norm += ch;
      map.push(i);
    }
  }
  const nq = normaliseForMatch(q);
  const at = norm.indexOf(nq);
  if (at < 0) return null;
  return { start: map[at], end: map[at + nq.length - 1] + 1 };
}

/** Null when every quote resolves in its source; otherwise the sentence saying which did not. */
export function checkEvidence(quotes: { verbatim: string; source: string }[], sources: Record<string, string>): string | null {
  for (const q of quotes) {
    const text = sources[q.source] ?? Object.values(sources).join("\n");
    if (!locate(text, q.verbatim)) return `The quote “${q.verbatim.slice(0, 80)}” is not in the candidate’s words.`;
  }
  return null;
}
