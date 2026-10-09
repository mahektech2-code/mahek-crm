#!/usr/bin/env node
/* ---------------------------------------------------------------------------
 * The Documentation app's build-time index.
 *
 *   node scripts/docs-index.mjs          write src/docs/_generated/index.json
 *   node scripts/docs-index.mjs --check  exit 1 if what is committed is stale
 *
 * WHY THIS EXISTS AT ALL. The runtime image carries no source — the Dockerfile
 * ships Next's standalone server and nothing else — so a docs page that quoted
 * a function by reading `src/lib/engines/queue.ts` at request time would work
 * on a laptop and find nothing on prod. Everything a page needs from the SOURCE
 * is therefore read here, once, at build: `npm run build` runs this first
 * (the `prebuild` hook), so the image always quotes the code it was built from.
 *
 * Three things come out:
 *
 *   excerpts  every <Code file="…" symbol="…"/> or lines="a-b" an MDX page
 *             names, cut from the file and coloured by Shiki. By SYMBOL is
 *             the default and the one to prefer: line numbers drift with every
 *             edit above them, a function's name does not, and a symbol that
 *             no longer exists fails this script rather than quoting the wrong
 *             twenty lines.
 *   toc       each page's ## and ### headings, slugged exactly as rehype-slug
 *             slugs them, for the "On this page" rail.
 *   search    each section's heading and plain text, for ⌘K.
 *
 * Settings are NOT read here. A setting's value is a fact about the database a
 * deployment is connected to, not about the source, and the docs read it live
 * (`<Setting k="…"/>`) so prod quotes prod.
 * ------------------------------------------------------------------------- */

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import GithubSlugger from "github-slugger";
import { codeToHtml } from "shiki";

const ROOT = process.cwd();
const DOCS = join(ROOT, "src/docs");
const OUT = join(DOCS, "_generated/index.json");
const check = process.argv.includes("--check");

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name.startsWith("_") ? [] : walk(path);
    return name.endsWith(".mdx") ? [path] : [];
  });
}

/* --------------------------------------------------------------- excerpts */

const CODE_TAG = /<Code\b([^>]*?)\/>/gs;
const attr = (attrs, name) => attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

/** The excerpt's key, as `<Code>` computes it at runtime. One spelling, two readers. */
const keyOf = (file, symbol, lines) => `${file}#${symbol ?? `L${lines}`}`;

/**
 * Where a top-level declaration ends, by counting brackets with a small
 * lexer that steps over strings, template literals and comments — a brace in
 * a comment is the ordinary case in this codebase, not the edge one.
 */
function endOfDeclaration(src, from) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") { i = src.indexOf("\n", i); if (i < 0) return src.length; continue; }
    if (c === "/" && next === "*") { i = src.indexOf("*/", i + 2) + 1; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      for (i++; i < src.length && src[i] !== q; i++) {
        if (src[i] === "\\") i++;
        else if (q === "`" && src[i] === "$" && src[i + 1] === "{") {
          let d = 1;
          for (i += 2; i < src.length && d > 0; i++) { if (src[i] === "{") d++; else if (src[i] === "}") d--; }
          i--;
        }
      }
      continue;
    }
    if (c === "{" || c === "(" || c === "[") { depth++; continue; }
    if (c === "}" || c === ")" || c === "]") {
      depth--;
      // Only a BRACE can finish a declaration, and only one that ends its
      // line: a parameter list closes with `)`, and a return type written as
      // an object literal closes with `}` followed by the body's `{` on the
      // same line. `= { … } as const;` runs on to its semicolon below.
      if (c === "}" && depth === 0) {
        const eol = src.indexOf("\n", i);
        const rest = src.slice(i + 1, eol < 0 ? src.length : eol).trim();
        if (rest === "" || rest === ";" || rest.startsWith("//")) return eol < 0 ? src.length : eol;
      }
      continue;
    }
    if (c === ";" && depth === 0) return i + 1;
  }
  return src.length;
}

function cutSymbol(file, symbol) {
  const src = readFileSync(join(ROOT, file), "utf8");
  const decl = new RegExp(
    `^(export\\s+)?(default\\s+)?(async\\s+)?(function\\*?|const|let|type|interface|class|enum)\\s+${symbol}\\b`,
    "m",
  );
  const m = decl.exec(src);
  if (!m) throw new Error(`${file}: no declaration named "${symbol}"`);
  const start = m.index;
  const end = endOfDeclaration(src, start + m[0].length);
  const startLine = src.slice(0, start).split("\n").length;
  const code = src.slice(start, end).replace(/\s+$/, "");
  return { code, startLine, endLine: startLine + code.split("\n").length - 1 };
}

function cutLines(file, range) {
  const [a, b] = range.split("-").map(Number);
  const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
  if (!a || !b || a > b || b > lines.length) throw new Error(`${file}: bad line range "${range}"`);
  return { code: lines.slice(a - 1, b).join("\n"), startLine: a, endLine: b };
}

const LANG = { ts: "ts", tsx: "tsx", mjs: "js", js: "js", sql: "sql", json: "json", sh: "bash", css: "css" };

/* -------------------------------------------------------- toc and search */

/** MDX source → readable text: no JSX, no markdown punctuation, no code. */
function plain(md) {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    // A diagram's source, an object or array prop: data, not words to search.
    .replace(/=\{`[\s\S]*?`\}/g, " ")
    .replace(/=\{\{[\s\S]*?\}\}/g, " ")
    .replace(/=\{\[[\s\S]*?\]\}/g, " ")
    // Questions, titles and captions ARE words somebody searches for.
    .replace(/<[A-Za-z]\w*[^>]*?\b(?:q|title|caption)="([^"]*)"[^>]*>/g, " $1. ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_>#|]/g, " ")
    .replace(/-{3,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sections(body) {
  const slugger = new GithubSlugger();
  const toc = [];
  const out = [{ heading: null, id: null, text: [] }];
  let fenced = false;
  for (const line of body.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    const h = !fenced && /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (h) {
      const text = h[2].replace(/[`*_]/g, "");
      const id = slugger.slug(text);
      toc.push({ depth: h[1].length, text, id });
      out.push({ heading: text, id, text: [] });
    } else {
      out[out.length - 1].text.push(line);
    }
  }
  return { toc, sections: out.map((s) => ({ ...s, text: plain(s.text.join("\n")).slice(0, 2400) })) };
}

/* ------------------------------------------------------------------- run */

const files = walk(DOCS).sort();
const excerpts = {};
const toc = {};
const search = [];
const failures = [];

for (const path of files) {
  const rel = relative(DOCS, path).replace(/\.mdx$/, ""); // crm/call-log/guide
  const body = readFileSync(path, "utf8");

  for (const [, attrs] of body.matchAll(CODE_TAG)) {
    const file = attr(attrs, "file");
    const symbol = attr(attrs, "symbol");
    const lines = attr(attrs, "lines");
    if (!file || (!symbol && !lines)) { failures.push(`${rel}: <Code> needs file= and symbol= or lines=`); continue; }
    const key = keyOf(file, symbol, lines);
    if (excerpts[key]) continue;
    try {
      if (!existsSync(join(ROOT, file))) throw new Error(`${file}: no such file`);
      const cut = symbol ? cutSymbol(file, symbol) : cutLines(file, lines);
      const lang = LANG[file.split(".").pop()] ?? "text";
      const html = await codeToHtml(cut.code, { lang, theme: "github-light" });
      excerpts[key] = { file, symbol: symbol ?? null, startLine: cut.startLine, endLine: cut.endLine, html };
    } catch (e) {
      failures.push(`${rel}: ${e.message}`);
    }
  }

  const [app, slug, tab] = rel.split("/");
  const parsed = sections(body.replace(/^---[\s\S]*?---/, ""));
  toc[rel] = parsed.toc;
  for (const s of parsed.sections) {
    if (!s.text && !s.heading) continue;
    search.push({ app, slug, tab: tab ?? null, heading: s.heading, id: s.id, text: s.text });
  }
}

if (failures.length) {
  console.error("docs-index: the documentation names code that does not exist:\n  " + failures.join("\n  "));
  process.exit(1);
}

const next = JSON.stringify({ excerpts, toc, search }, null, 1) + "\n";

if (check) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (current !== next) {
    console.error("docs-index: src/docs/_generated/index.json is stale — run `npm run docs:index`.");
    process.exit(1);
  }
  console.log(`docs-index: current (${Object.keys(excerpts).length} excerpts, ${files.length} pages).`);
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, next);
  console.log(`docs-index: wrote ${Object.keys(excerpts).length} excerpts, ${files.length} pages.`);
}
