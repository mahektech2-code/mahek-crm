import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DOC_APPS, docPage, tabsOf } from "@/docs/registry";
import { buildIndex, excerpt, hrefOf, refOf, searchDocs, stem, tokens, type AskSection } from "./retrieve";

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
const index = buildIndex(BOOK, (s) => TITLES[`${s.app}/${s.slug}`] ?? "");

test("words fold to a stem so plurals and -ing forms meet", () => {
  assert.equal(stem("reminders"), stem("reminder"));
  assert.equal(stem("scanning"), "scann");
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

/* The real book, where the build has written it: every section's page exists,
   and a handful of plain questions land in the right app. */
const ASK = join(process.cwd(), "src/docs/_generated/ask.json");
test("the real documentation answers ordinary questions from the right app", { skip: !existsSync(ASK) }, () => {
  const sections = (JSON.parse(readFileSync(ASK, "utf8")) as { sections: AskSection[] }).sections;
  for (const s of sections) assert.ok(docPage(s.app, s.slug), `${refOf(s)} names a page the registry does not have`);
  const real = buildIndex(sections, (s) => docPage(s.app, s.slug)?.title ?? "");
  const expect: Array<[string, string]> = [
    ["why is a customer not on the call log", "crm"],
    ["how is a box scanned at dispatch", "erp"],
    ["how do I deploy to DigitalOcean", "platform"],
  ];
  for (const [q, app] of expect) {
    const top = searchDocs(real, q, { limit: 3 });
    assert.ok(
      top.some((h) => h.section.app === app),
      `"${q}" should find ${app}; found ${top.map((h) => h.ref).join(", ")}`,
    );
  }
  assert.ok(DOC_APPS.every((a) => a.pages.every((p) => tabsOf(p).length > 0)));
});
