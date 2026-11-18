# The Documentation app

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**`/docs` is an app like any other**, granted in `app_access` and checked in
its layout. Everybody granted it reads every page and all three tabs — that is
a decision, recorded on `docs.app` in `lib/modules.ts`, not an omission.

**Every page has three tabs for three readers**: Guide (the person using the
screen), How it works (the owner: the rule, why, and the setting that changes
it) and Developer (routes, services, engine, tables, tests). `src/docs/registry.ts`
lists the pages; `src/docs/<app>/<slug>/<tab>.mdx` is the content;
`src/docs/content.ts` is the one map from one to the other.

**No page types a setting's value.** `<Setting k="queue.quietDaysAfterOrder"/>`
reads it through `getConfig()` from the database the deployment is connected
to, so prod's docs quote prod's settings and a value changed on the Settings
screen changes the page. `<SettingsTable>`, `<SettingMap>`, `<DbTable>`,
`<DbEnum>`, `<CapabilityGrid>` and `<ModuleRef>` read the registry, the schema
and the matrix the same way, and a name that no longer exists renders as a red
mistake rather than a confident fiction.

**Code is quoted by SYMBOL, cut at build.** The runtime image carries no
source, so `<Code file="…" symbol="buildQueue"/>` is resolved by
`scripts/docs-index.mjs`, which `prebuild` runs: a renamed symbol fails the
build instead of quoting whatever now sits on those lines. The index
(`src/docs/_generated/`) is BUILT, never committed: npm runs it before `dev`,
`lint`, `test` and `build`, because a committed copy quotes the source as it
was and went stale — failing CI on unrelated PRs — the moment main moved.
`coverage.test.ts` fails on a quoted symbol that no longer exists, on a module
of a documented app that no page claims, and on a `;` inside a Mermaid chart,
which Mermaid reads as the end of a statement.

**Wireframes, never screenshots, and no names.** A screenshot carries real
customers into a page every grantee can read and goes stale when a column
moves. Wireframes are built from the design tokens (`components/wireframe.tsx`)
and use placeholders — "Customer A" — never seed or production names.
A `url` that is not a web path ("MBOS · Pay") draws a handset screen in a phone
frame instead of a browser window.

**THE SIDEBAR IS ONE APP AT A TIME.** It listed every app's every page down
one column, so a reader could not tell from it which app they were in. Now the
front page's sidebar is the list of apps; inside an app a switcher names it and
opens onto the others, and below it are only that app's sections, folding,
with the reader's own section open and the page's tabs under it, plus a filter
over the app's page names (`app/docs/docs-sidebar.tsx`). Each `DocApp` carries
an `icon` for it.

**ASK THE DOCS ANSWERS FROM THE PAGES, WITH LINKS, OR SAYS IT CANNOT.** The
header's "Ask the docs" docks a chat on the right (`app/docs/ask-panel.tsx`) —
docked rather than modal, so following a citation keeps the conversation — and
⌘K offers any typed words to it. `/api/docs/ask` (behind the `docs` grant)
streams `askDocsStream` (`services/docs-ask-service.ts`): the model is given
the contents, a first search already run, and three tools — `search_docs`,
`read_section`, and `read_setting`, which reads the live value of a setting
some page names, so an answer quotes this deployment's number exactly as the
page would. "Search in" above the box asks ONE app's documentation or all of
it: it starts on the app being read and follows the reader until they pick,
and a one-app question is held to that app's sections in the first search and
in both tools, not merely asked nicely. It is OpenAI only, on `openai.apiKey`,
and the `docsAsk.*` settings sit on Admin Console → Settings → AI assistants.

**AN ANSWER MAY BE A PICTURE.** Fenced blocks in the answer are drawn by
`app/docs/answer-blocks.tsx`: ```` ```mermaid ```` with the pages' own `<Flow>`,
```` ```wireframe ```` in the pages' own `<Wireframe>`/`Wf*` markup, read by
`lib/docs-ask/wire-markup.ts` — PARSED, never compiled: known tags and literal
props only, so an event handler, a style or an unknown tag in model output is
dropped — and ```` ```svg ```` shown through `<img>` from a data URL, where it
cannot run or fetch anything. Markdown tables render too. `ask.json` keeps
every page's diagrams and wireframes as source, so the usual picture is the
page's own, trimmed; a test parses every wireframe in the book.

**ONE SEARCH ENGINE, ON THE SERVER, MEASURED.** ⌘K and the assistant both read
`lib/docs-ask/retrieve.ts` (pure): BM25F over an inverted index built once per
process from `_generated/ask.json` (`docs-ask/corpus.ts`, server-only — the
browser no longer receives a search index). Fields are weighted title >
heading > summary > body; each word of a query is a group of spellings — its
light stem, completions while it is still being typed, typo corrections within
one or two edits (only where the word as typed is not one the docs use), and
MahekOne's abbreviations both ways (`SYNONYMS`: PO, GRN, LR, CN, OTP…). A
section covering every word, naming it in its title or heading, or holding the
words side by side ranks higher; the Developer tab is held back unless the
question is about code, and overview pages yield to particular ones.
`search-benchmark.ts` is real questions with the page that answers each —
typos, abbreviations and half-typed words included — and `retrieve.test.ts`
fails unless every one finds its page in the top three and 95% find it first
(64 of 66 today), and unless a search of the whole book stays fast (about 1 ms
warm). Add a question there whenever a search goes wrong; lower neither bar.

**A page describes the code as it stands.** Where the code and the intent
disagree, the How it works and Developer tabs say so under "Where the code and
the intent disagree today", rather than documenting the intent as if it shipped.

**AN ERP LIST SENDS ONE PAGE, NEVER THE LIST.** The generic list searched,
sorted, grouped and paged in the browser over every row the server sent, and
on the real book that was every row there is: the SFG batch screen was 34 MB of
HTML, each of ten thousand lines carrying its drawer and its actions, to draw
twenty-five of them. The search, the chip, the godown, grouping, the sort and
the page now travel in the URL; `[slug]/page.tsx` runs `pageOf` in
`lib/erp/list-query.ts` over the module's rows and sends one page, the counts
the toolbar needs, and each group on the page WHOLE — its count, its aggregate
and every id, so "Select all 14" on a group still means fourteen. Export and
"Select all" across pages ask the server (`erpListExport`, `erpListIds`) under
the same reading. HRMS and the other short lists still send every row and run
the SAME `pageOf` in the browser, so a search cannot answer differently
depending on which side ran it.

**A PAGE ASKS EACH LEDGER ONCE.** Stock is added up from the whole history of
its ledger, and a screen asks for it through several doors at once — its rows,
its form's lot picker, a rate behind a costing column — so the SFG screen read
the raw-material ledger five times for one page. `withReadMemo` around a page's
reads (`lib/erp/read-memo.ts`) answers an identical statement once. Only a page
opens one, because a page writes nothing; a server action never runs inside it.

**AND A LEDGER NOTHING HAS WRITTEN TO IS NOT ADDED UP AGAIN.**
`lib/erp/ledger-cache.ts` keeps each stock statement's answer between requests
under a stamp: the count and highest id of `erp_ledger_ticks`, which a STATEMENT
TRIGGER on every table those reads touch appends to (`0269`). The stamp is read
in the reader's own snapshot, so it moves only once a write has committed —
from the factory app, the dispatch desk, a terminal import, anything — and
nothing in the app has to remember to invalidate it. A table a stock read
starts reading must get the trigger too, or that read goes stale silently. A
read on a transaction never touches the cache: whatever is about to spend stock
reads it afresh under its lock. The nightly prunes ticks older than two days;
pruning moves the stamp, which costs one re-read.

**`toLocaleString` with options builds a formatter per call.** `nf`, `inrRate`
and `stampLine` are called several times a row, and on ten thousand rows the
formatters alone were half a second. They hold one `Intl` formatter each now;
a new number or date helper on a list path should do the same.

**THE OPEN ORDER BOOK IS READ ONCE PER RENDER (Nov 2026).** It was the ERP's
biggest statement on prod — read by the layout's badges, again by the tab strip
and list, and a third time by order number to see each order whole — and every
save drew the page twice. Now: the layout and a read-only page share one memo
(`withRenderMemo`, React `cache`; Logistics writes as it loads and keeps its
own); a working tab asks only for the CLOSED lines of its orders
(`closedWork`, `openWork`'s complement); "does this order have a billed line"
is one indexed query over the read's order numbers, not an EXISTS over the
whole book; and an Orders row's fields, actions and invoice panel are built
only when read (`later`/`withLater` in `lazy-row.ts`). A kit that revalidates
(`ScreenKit.revalidates`, the ERP's) does not `router.refresh()` after a save:
the action's answer already carries the redrawn page. The LR lists count bills
through `erp_transports_signed_copy_idx` (`0344`), and `consignments` reads each
bill's order and newest event by index instead of grouping the whole book.
