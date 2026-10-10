import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DOC_APPS, docPage } from "@/docs/registry";
import { buildIndex, editDistance, excerpt, hrefOf, planQuery, refOf, searchDocs, stem, tokens, type AskSection } from "./retrieve";
import { SEARCH_BENCHMARK } from "./search-benchmark";

const S = (app: string, slug: string, heading: string | null, text: string, tab = "guide"): AskSection => ({
  app,
  slug,
  tab,
  heading,
  id: heading ? heading.toLowerCase().replace(/\s+/g, "-") : null,
  text,
});

const BOOK = [
  S("crm", "call-log", "Why a customer is missing", "The quiet window holds a customer back after an order, and the held-back strip says why."),
  S("crm", "reminders", "Snoozing a reminder", "A reminder can be moved to another day from the list."),
  S("crm", "payments", "Promises", "A promise to pay moves the next call to the promised date."),
  S("erp", "dispatch", "Scanning a box", "Every box is scanned against its order at the dispatch desk."),
  S("sales", "overview", null, "The Sales Dashboard watches the field team and their reminders."),
];
const TITLES: Record<string, string> = {
  "crm/call-log": "Call Log",
  "crm/reminders": "Reminders",
  "crm/payments": "Payment Follow-up",
  "erp/dispatch": "Dispatch",
  "sales/overview": "Sales Dashboard",
};
const index = buildIndex(BOOK, (s) => ({ title: TITLES[`${s.app}/${s.slug}`] ?? "", summary: "" }));

test("words fold to a stem so plurals and -ing forms meet", () => {
  assert.equal(stem("reminders"), stem("reminder"));
  assert.equal(stem("scanning"), stem("scanned"));
  assert.equal(stem("policies"), "policy");
  assert.deepEqual(tokens("Why is the customer missing?"), ["customer", "miss"]);
});

test("a question finds the section it is about, heading first", () => {
  const hits = searchDocs(index, "why is a customer missing from my call log");
  assert.equal(hits[0].ref, "crm/call-log/guide#why-a-customer-is-missing");
});

test("the page title is part of what a section is found by", () => {
  assert.equal(searchDocs(index, "payment follow-up")[0].section.slug, "payments");
});

test("narrowing to one app hides every other app", () => {
  const hits = searchDocs(index, "reminders", { app: "sales" });
  assert.deepEqual(
    hits.map((h) => h.section.app),
    ["sales"],
  );
});

test("the page the reader is on is nudged up, never the only answer", () => {
  const plain = searchDocs(index, "reminders");
  const preferred = searchDocs(index, "reminders", { prefer: { app: "sales", slug: "overview" } });
  assert.equal(plain[0].section.slug, "reminders");
  assert.ok(preferred.some((h) => h.section.slug === "reminders"));
  assert.ok(
    preferred.findIndex((h) => h.section.app === "sales") <= plain.findIndex((h) => h.section.app === "sales"),
    "the reader's own page does not fall",
  );
});

test("a question made only of small words finds nothing rather than everything", () => {
  assert.deepEqual(searchDocs(index, "what is the"), []);
});

test("refs and hrefs agree with the page's first tab", () => {
  const s = BOOK[0];
  assert.equal(refOf(s), "crm/call-log/guide#why-a-customer-is-missing");
  assert.equal(hrefOf(s, "guide"), "/docs/crm/call-log#why-a-customer-is-missing");
  assert.equal(hrefOf({ ...s, tab: "developer" }, "guide"), "/docs/crm/call-log/developer#why-a-customer-is-missing");
});

test("an excerpt is cut around the words asked about", () => {
  const text = `${"padding ".repeat(200)}the quiet window is fifteen days ${"tail ".repeat(200)}`;
  const cut = excerpt(text, "quiet window", 200);
  assert.ok(cut.includes("quiet window"));
  assert.ok(cut.startsWith("…") && cut.endsWith("…"));
});

test("plurals and -ing forms of one word fold together", () => {
  assert.equal(stem("settings"), stem("setting"));
  assert.equal(stem("approved"), stem("approve"));
  assert.equal(stem("approving"), stem("approves"));
});

test("a typo is within reach and a different word is not", () => {
  assert.equal(editDistance("recieve", "receive", 2), 1, "a swap is one edit");
  assert.equal(editDistance("dispach", "dispatch", 1), 1);
  assert.ok(editDistance("order", "border", 1) <= 1);
  assert.ok(editDistance("payment", "shipment", 2) > 2);
});

test("an abbreviation reaches the words it stands for, and back", () => {
  const idx = buildIndex([S("erp", "purchase-orders", "Approving", "A purchase order is approved by somebody else.")], () => ({ title: "Purchase orders", summary: "" }));
  assert.equal(searchDocs(idx, "po approval")[0]?.section.slug, "purchase-orders");
  const plan = planQuery(idx, "purchase order ");
  assert.ok(plan.groups[0].variants.some((v) => v.terms.join(" ") === "po"));
});

test("a word still being typed matches the words it begins", () => {
  assert.equal(searchDocs(index, "remind")[0]?.section.slug, "reminders");
});

/* The real book, where the build has written it. */
const ASK = join(process.cwd(), "src/docs/_generated/ask.json");
const realIndex = () => {
  const sections = (JSON.parse(readFileSync(ASK, "utf8")) as { sections: AskSection[] }).sections;
  for (const s of sections) assert.ok(docPage(s.app, s.slug), `${refOf(s)} names a page the registry does not have`);
  return buildIndex(sections, (s) => ({ title: docPage(s.app, s.slug)?.title ?? "", summary: docPage(s.app, s.slug)?.summary ?? "" }));
};

/*
 * THE BENCHMARK. Every question must find its page in the top three, and at
 * least 95% must find it FIRST. Raising either bar is welcome; lowering one to
 * make a change pass is not — a ranking change that costs accuracy shows here.
 */
test("the benchmark: every question in the top three, 95% first", { skip: !existsSync(ASK) }, () => {
  const real = realIndex();
  let first = 0;
  const misses: string[] = [];
  for (const c of SEARCH_BENCHMARK) {
    const pages = searchDocs(real, c.q, { limit: 10, perPage: 1 }).map((h) => `${h.section.app}/${h.section.slug}`);
    const at = pages.findIndex((p) => c.pages.includes(p));
    if (at === 0) first += 1;
    if (at < 0 || at > 2) misses.push(`"${c.q}" → ${pages.slice(0, 3).join(", ")}`);
  }
  assert.deepEqual(misses, [], "every question finds its page in the top three");
  assert.ok(first / SEARCH_BENCHMARK.length >= 0.95, `${first} of ${SEARCH_BENCHMARK.length} first`);
});

test("a search of the whole book is fast", { skip: !existsSync(ASK) }, () => {
  const real = realIndex();
  for (const c of SEARCH_BENCHMARK) searchDocs(real, c.q);
  const t = performance.now();
  for (let i = 0; i < 3; i++) for (const c of SEARCH_BENCHMARK) searchDocs(real, c.q);
  const each = (performance.now() - t) / (3 * SEARCH_BENCHMARK.length);
  assert.ok(each < 15, `${each.toFixed(2)} ms a search`);
  assert.ok(DOC_APPS.length > 0);
});
