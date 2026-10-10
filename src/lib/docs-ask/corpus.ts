import "server-only";
import ask from "@/docs/_generated/ask.json";
import { docPage, tabsOf } from "@/docs/registry";
import { buildIndex, type AskSection, type DocsIndex } from "./retrieve";

/* ---------------------------------------------------------------------------
 * The documentation as the search engine reads it: the build-time `ask.json`
 * (every section's full text — never sent to a browser) against the registry,
 * indexed ONCE per process and shared by ⌘K (`/api/docs/search`) and "Ask the
 * docs". A section whose page the registry no longer has is left out, so a
 * search can never offer a link to nowhere.
 * ------------------------------------------------------------------------- */

const SECTIONS = (ask as { sections: AskSection[] }).sections.filter((s) => docPage(s.app, s.slug));

let built: DocsIndex | null = null;

export function docsIndex(): DocsIndex {
  built ??= buildIndex(SECTIONS, (s) => {
    const page = docPage(s.app, s.slug);
    return { title: page?.title ?? s.slug, summary: page?.summary ?? "" };
  });
  return built;
}

export function pageTitleOf(s: Pick<AskSection, "app" | "slug">): string {
  return docPage(s.app, s.slug)?.title ?? s.slug;
}

/** The tab a page opens on — its bare URL. */
export function firstTabOf(s: Pick<AskSection, "app" | "slug">): string {
  const page = docPage(s.app, s.slug);
  return page ? tabsOf(page)[0] : "guide";
}

/** The settings some page names, as `{setting:key}` — the only ones the assistant may read. */
export const NAMED_SETTINGS = new Set(SECTIONS.flatMap((s) => [...s.text.matchAll(/\{setting:([\w.]+)\}/g)].map((m) => m[1])));
