import { NextResponse } from "next/server";
import { DOC_TABS } from "@/docs/registry";
import { listUserApps } from "@/lib/access";
import { getCurrentUser } from "@/lib/auth";
import { docsIndex, firstTabOf, pageTitleOf } from "@/lib/docs-ask/corpus";
import { excerpt, hrefOf, matchedWords, searchDocs } from "@/lib/docs-ask/retrieve";
import { TtlCache } from "@/lib/team-ask/cache";

/* ---------------------------------------------------------------------------
 * ⌘K, answered on the server by the same engine "Ask the docs" reads with.
 *
 * It used to be a substring match in the browser over the whole search index,
 * shipped into every docs page (1.3 MB) — slow to load, blind to a typo, and
 * a different ranking from the assistant's. Now each keystroke asks this, and
 * the answer is the best dozen sections with the words to highlight. The same
 * query asked again within a minute (a backspace, a second person) is
 * answered from memory.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";

const TAB_LABEL = Object.fromEntries(DOC_TABS.map((t) => [t.id, t.label])) as Record<string, string>;

export type DocsSearchResult = {
  href: string;
  app: string;
  title: string;
  heading: string | null;
  tab: string;
  snippet: string;
  marks: string[];
};

const remembered = new TtlCache<DocsSearchResult[]>(500);

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ ok: false, error: "Sign in again." }, { status: 401 });
  if (!(await listUserApps(user.id)).includes("docs")) {
    return NextResponse.json({ ok: false, error: "The Documentation app is not on your account." }, { status: 403 });
  }

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").slice(0, 200);
  const app = url.searchParams.get("app");
  const slug = url.searchParams.get("slug");
  const key = `${app ?? ""}/${slug ?? ""}|${q.toLowerCase()}`;

  let results = remembered.get(key);
  if (!results) {
    const hits = searchDocs(docsIndex(), q, { prefer: app ? { app, slug } : null, limit: 12, perPage: 3 });
    results = hits.map((h) => {
      const snippet = excerpt(h.section.text, h.matched, 180);
      return {
        href: hrefOf(h.section, firstTabOf(h.section)),
        app: h.section.app,
        title: pageTitleOf(h.section),
        heading: h.section.heading,
        tab: TAB_LABEL[h.section.tab ?? "guide"] ?? "",
        snippet,
        marks: matchedWords(`${pageTitleOf(h.section)} ${h.section.heading ?? ""} ${snippet}`, h.matched),
      };
    });
    remembered.set(key, results, 60_000);
  }
  return NextResponse.json({ ok: true, results }, { headers: { "cache-control": "no-store" } });
}
