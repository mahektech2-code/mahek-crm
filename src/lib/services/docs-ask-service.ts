import "server-only";
import { createOpenAI } from "@ai-sdk/openai";
import { isStepCount, streamText, tool, type ModelMessage } from "ai";
import { z } from "zod";
import { DOC_APPS, DOC_TABS, docApp, docPage, tabsOf } from "@/docs/registry";
import { definition } from "@/lib/config/registry";
import { getConfig } from "@/lib/config/store";
import { readSecret } from "@/lib/secrets";
import { isPermanentRefusal } from "@/lib/voice-readiness";
import { TtlCache, normaliseQuestion } from "@/lib/team-ask/cache";
import { NAMED_SETTINGS, docsIndex as index, firstTabOf as firstTab, pageTitleOf as pageTitle } from "@/lib/docs-ask/corpus";
import { excerpt, hrefOf, refOf, searchDocs, type AskSection, type SearchHit } from "@/lib/docs-ask/retrieve";

/* ---------------------------------------------------------------------------
 * "Ask the docs" — a question in plain words, answered from the written pages.
 *
 * The documentation is the whole of what it may read. Its index is built at
 * BUILD time (`scripts/docs-index.mjs` writes `ask.json` beside the search
 * index) because the runtime image carries no MDX, and it is the same text
 * the pages render — so an answer and the page it cites cannot disagree about
 * what the page says.
 *
 * THE MODEL SEARCHES RATHER THAN BEING HANDED THE BOOK. The written pages are
 * about 1.4 million characters; it is given the table of contents, a first
 * search on the question already run, and three tools: search again, read a
 * whole section, and read a setting's LIVE value — because a page never types
 * a threshold (it names the key, `<Setting k/>`), and an answer quoting "15
 * days" must be quoting what this deployment runs on, exactly as the page
 * would. Only settings some page names may be read: the panel answers
 * questions about the docs, and the docs already show those.
 *
 * IT ANSWERS WITH PICTURES WHERE A PICTURE IS CLEARER: a Mermaid flowchart,
 * a wireframe in the pages' own `<Wireframe>` markup, a table, or an SVG
 * image, as fenced blocks the panel draws. The index carries the pages' own
 * diagrams and wireframes as source, so the usual case is the page's own
 * drawing, trimmed, rather than one the model made up.
 *
 * IT CITES OR IT SAYS IT DOES NOT KNOW. Every claim carries a link to the
 * section it came from, and a question the pages do not cover is answered
 * with exactly that, rather than with what the model believes about software
 * in general — a confident answer about a screen that does not work that way
 * is worse than none, because it is believed.
 *
 * It needs no database except the settings read, so the only gate is the
 * Documentation app itself (in the route) and `docsAsk.enabled`.
 * ------------------------------------------------------------------------- */

export type DocsAskEvent =
  | { type: "step"; text: string }
  | { type: "source"; href: string; title: string; heading: string | null; tab: string }
  | { type: "delta"; text: string }
  | { type: "done"; lookups: number; cached: boolean; ms: number }
  | { type: "error"; message: string };

export type DocsAskTurn = { role: "user" | "assistant"; text: string };
export type DocsAskPlace = { app: string; slug?: string | null; tab?: string | null };

const TAB_LABEL = Object.fromEntries(DOC_TABS.map((t) => [t.id, t.label])) as Record<string, string>;

const answers = new TtlCache<{ text: string; sources: Extract<DocsAskEvent, { type: "source" }>[] }>(300);
const ANSWER_TTL_MS = 10 * 60 * 1000;

/** The table of contents, as the model reads it: every page and its tabs, by app. */
function contents(): string {
  return DOC_APPS.map((a) => {
    const pages = a.pages
      .filter((p) => p.written.length)
      .map((p) => `  - ${a.app}/${p.slug} "${p.title}" [${tabsOf(p).filter((t) => p.written.includes(t)).join(", ")}] — ${p.summary}`);
    return `## ${a.title} (app: ${a.app})\n${a.summary}\n${pages.join("\n")}`;
  }).join("\n\n");
}

const SYSTEM_RULES = `You answer questions about MahekOne — Mahek Marketing India's apps (the Telecaller CRM, the Sales Dashboard, the MBOS handset app, the ERP and the platform itself) — using ONLY its written documentation.

How to work:
- You are given a first search of the documentation for the question. If it does not plainly answer, call search_docs with other words (the screen's name, the rule, the setting), and read_section to read a section in full before relying on it.
- Each documentation page has up to three tabs: Guide (for the person using the screen), How it works (the rules and why) and Developer (routes, services, tables, tests). Prefer the Guide and How it works tabs unless the question is about code.
- Text like {setting:queue.quietDaysAfterOrder} marks a configurable value. Call read_setting to quote the value this deployment uses; never guess a number.
- When the reader is on a page, a question that does not name an app is usually about that app — but answer from wherever the documentation answers it.

How to answer:
- Short and direct: the answer first, then only the detail that matters. Plain words, the screen's own names. Use short bullet lists for steps.
- Cite every fact with a markdown link to the section it came from, using the exact "link" you were given, e.g. [Call Log › Why a customer is missing](/docs/crm/call-log#why-a-customer-is-missing). Never invent a link.
- If the documentation does not cover it, say so plainly in one sentence and point to the nearest page that does exist. Never answer from general knowledge, and never describe a screen or a rule the documentation does not describe.
- Write in the language of the question.

Showing, not only telling — pick whatever answers best, and always say it in words as well:
- A FLOWCHART, sequence or state diagram for a process, a decision or who-does-what-when: a fenced block \`\`\`mermaid … \`\`\`. Mermaid syntax: "flowchart TD", "sequenceDiagram" or "stateDiagram-v2"; put every node label in double quotes; use <br/> for a line break; never use a semicolon. If the documentation already has a diagram of it (you will see \`\`\`mermaid blocks in what you read), reuse it — trimmed to what the question needs — rather than drawing a new one.
- A WIREFRAME to show where something is on a screen: a fenced block \`\`\`wireframe … \`\`\` holding the same markup the pages use. Copy and trim the page's own wireframe where one exists (you will see \`\`\`wireframe blocks). The only tags are:
  <Wireframe url="/crm/call-log" nav={["Dashboard", "#Group heading", "Call Log"]} active="Call Log" caption="…"> (a url not starting with "/" draws a phone screen, e.g. url="MBOS · Pay"),
  <WfBar>, <WfSpacer />, <WfTitle sub="…">, <WfText muted>, <WfButton primary>, <WfInput placeholder="…" wide />, <WfTabs items={["A","B"]} active="A" />, <WfPill tone="neutral|brand|success|warn|danger|info">, <WfBlock label="…" h={40} />, <WfCard title="…" tone="warn|brand">, <WfTable columns={["…"]} rows={[["…"]]} highlight={0} /> (cells are plain strings), <WfPanel title="…" side>, <WfField label="…">, <Hotspot n={1} />, <Hotspots items={["what 1 is", "what 2 is"]} /> (after the Wireframe). Props are strings in quotes or JSON in braces — no expressions, no other HTML. Use placeholder names like "Customer A", never a real person or business.
- A TABLE (markdown) to compare things side by side.
- An IMAGE only when none of those fits, e.g. a simple illustration: a fenced block \`\`\`svg … \`\`\` holding one self-contained <svg> with a viewBox, at most 640 wide, in the brand's purple (#6835fb) and greys, with no scripts, links or external references.
- Plain text alone when the answer is a sentence. A picture is for when it is clearer than words, not decoration; one or two per answer at most.`;

function hitLine(h: SearchHit, query: string, chars: number): string {
  const s = h.section;
  return [
    `ref: ${h.ref}`,
    `page: ${pageTitle(s)} (${s.app}) · tab: ${TAB_LABEL[s.tab ?? "guide"] ?? s.tab}${s.heading ? ` · section: ${s.heading}` : ""}`,
    `link: ${hrefOf(s, firstTab(s))}`,
    `text: ${excerpt(s.text, h.matched, chars)}`,
  ].join("\n");
}

/**
 * Answer one question as a stream of events: each lookup the model makes, the
 * sections it read, then the answer's words, then `done` — or `error`.
 * Never throws.
 */
export async function askDocsStream(
  question: string,
  history: DocsAskTurn[],
  place: DocsAskPlace | null,
  /** One app's pages only, or null for every app — the reader's choice in the panel. */
  scopeApp: string | null,
  emit: (e: DocsAskEvent) => void,
): Promise<void> {
  const started = Date.now();
  try {
    const config = await getConfig();
    if (!config["docsAsk.enabled"]) {
      emit({ type: "error", message: "Ask the docs is switched off in Admin Console → Settings → AI assistants." });
      return;
    }
    const key = await readSecret("openai.apiKey");
    if (!key) {
      emit({
        type: "error",
        message: "No OpenAI account is connected yet. Add an OpenAI key in Admin Console → Integrations and this will start working.",
      });
      return;
    }

    const here = place && docApp(place.app) ? place : null;
    const herePage = here?.slug ? docPage(here.app, here.slug) : undefined;
    const prefer = here && herePage ? { app: here.app, slug: herePage.slug } : null;

    const scope = scopeApp ? docApp(scopeApp) : undefined;
    const answerKey = history.length ? null : `${scope?.app ?? "*"}|${here?.app ?? ""}|${normaliseQuestion(question)}`;
    const remembered = answerKey ? answers.get(answerKey) : undefined;
    if (remembered) {
      for (const s of remembered.sources) emit(s);
      emit({ type: "delta", text: remembered.text });
      emit({ type: "done", lookups: 0, cached: true, ms: Date.now() - started });
      return;
    }

    const sources: Extract<DocsAskEvent, { type: "source" }>[] = [];
    const cite = (s: AskSection) => {
      const href = hrefOf(s, firstTab(s));
      if (sources.some((x) => x.href === href)) return;
      const source = { type: "source" as const, href, title: pageTitle(s), heading: s.heading, tab: TAB_LABEL[s.tab ?? "guide"] ?? "" };
      sources.push(source);
      emit(source);
    };

    // A first search on the question itself, so most questions need no tool call at all.
    emit({ type: "step", text: scope ? `Searched the ${scope.title} documentation` : "Searched the documentation" });
    const first = searchDocs(index(), question, { app: scope?.app, prefer, limit: 6, perPage: 2 });

    let lookups = 0;
    const max = Math.max(1, config["docsAsk.maxLookups"]);
    const where = here
      ? `The reader is on ${herePage ? `the page "${herePage.title}" (${here.app}/${herePage.slug}${here.tab ? `, ${TAB_LABEL[here.tab] ?? here.tab} tab` : ""})` : `the ${docApp(here.app)?.title} index`} of the ${docApp(here.app)?.title} documentation.`
      : "The reader is on the documentation's front page.";
    const limitTo = scope
      ? `\nThe reader asked to search ONLY the ${scope.title} documentation (app: ${scope.app}). Answer from its pages alone; if they do not cover it, say so and say that asking across all apps may find it.`
      : "";

    const messages: ModelMessage[] = [
      ...history.slice(-8).map((t) => ({ role: t.role, content: t.text.slice(0, 4000) }) as ModelMessage),
      {
        role: "user",
        content: `${question}\n\n---\n${where}${limitTo}\n\nFirst search of the documentation for this question:\n\n${
          first.length ? first.map((h) => hitLine(h, question, 900)).join("\n\n") : "(nothing matched — search with other words)"
        }`,
      },
    ];

    let text = "";
    const result = streamText({
      model: createOpenAI({ apiKey: key })(config["docsAsk.model"]),
      system: `${SYSTEM_RULES}\n\n# The documentation's table of contents\n\n${contents()}`,
      messages,
      tools: {
        search_docs: tool({
          description: "Search every written documentation page. Returns the best-matching sections with an excerpt, a ref and a link.",
          inputSchema: z.object({
            query: z.string().describe("Words to look for — a screen's name, a rule, a setting, a question."),
            app: z
              .enum(DOC_APPS.map((a) => a.app) as [string, ...string[]])
              .optional()
              .describe("Only this app's pages."),
          }),
          execute: async ({ query, app: asked }) => {
            const app = scope?.app ?? asked;
            lookups += 1;
            if (lookups > max) return { error: "No more lookups for this question — answer with what you have." };
            emit({ type: "step", text: `Searched for “${query}”${app ? ` in ${docApp(app)?.title ?? app}` : ""}` });
            const hits = searchDocs(index(), query, { app, prefer, limit: 8, perPage: 3 });
            return hits.length ? hits.map((h) => hitLine(h, query, 500)).join("\n\n") : "Nothing matched. Try other words.";
          },
        }),
        read_section: tool({
          description: "Read one section in full, by the ref a search returned.",
          inputSchema: z.object({ ref: z.string().describe("e.g. crm/call-log/how-it-works#the-quiet-window") }),
          execute: async ({ ref }) => {
            lookups += 1;
            if (lookups > max) return { error: "No more lookups for this question — answer with what you have." };
            const i = index().byRef.get(ref.trim());
            if (i === undefined) return { error: `No section has the ref ${ref}. Use a ref exactly as a search returned it.` };
            const s = index().sections[i];
            if (scope && s.app !== scope.app) return { error: `That section is outside the ${scope.title} documentation the reader asked about.` };
            emit({ type: "step", text: `Read ${pageTitle(s)}${s.heading ? ` › ${s.heading}` : ""}` });
            cite(s);
            return `ref: ${refOf(s)}\nlink: ${hrefOf(s, firstTab(s))}\n\n${s.text.slice(0, 16000)}`;
          },
        }),
        read_setting: tool({
          description: "The value this deployment uses for a setting a page names as {setting:key}, with its label and shipped default.",
          inputSchema: z.object({ key: z.string() }),
          execute: async ({ key: k }) => {
            const def = definition(k);
            if (!def || !NAMED_SETTINGS.has(k)) return { error: `${k} is not a setting the documentation names.` };
            const value = config[k as keyof typeof config];
            return { key: k, label: def.label, meaning: def.description, value, shippedDefault: def.default };
          },
        }),
      },
      stopWhen: isStepCount(max + 2),
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(Math.max(10, config["docsAsk.timeoutSeconds"]) * 1000),
      providerOptions: {
        openai: {
          reasoningEffort: config["docsAsk.reasoningEffort"] as "minimal" | "low" | "medium" | "high",
          parallelToolCalls: false,
          // Everybody shares the long prefix: the rules and the contents.
          promptCacheKey: "docs-ask",
        },
      },
    });

    for await (const part of result.fullStream) {
      if (part.type === "text-delta" && part.text) {
        text += part.text;
        emit({ type: "delta", text: part.text });
      } else if (part.type === "error") {
        throw part.error;
      }
    }

    // What the first search found counts as read where the answer links to it.
    for (const h of first) if (text.includes(hrefOf(h.section, firstTab(h.section)))) cite(h.section);

    if (!text.trim()) {
      emit({ type: "delta", text: "I could not put an answer together from the documentation for that. Try asking it another way." });
    } else if (answerKey) {
      answers.set(answerKey, { text, sources }, ANSWER_TTL_MS);
    }
    emit({ type: "done", lookups, cached: false, ms: Date.now() - started });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("Ask the docs failed:", detail);
    emit({
      type: "error",
      message: isPermanentRefusal(detail)
        ? "OpenAI refused the request — the connected account may be out of credit, the key may be invalid, or the model name in settings may be wrong. Check Admin Console → Integrations."
        : /timeout|aborted/i.test(detail)
          ? "That took too long to answer. Try a narrower question."
          : "Could not answer just now. Try again in a moment.",
    });
  }
}
