import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { BUILT_IN, filterLibrary, libraryFacets, type LibraryItem } from "./library";

const item = (over: Partial<LibraryItem>): LibraryItem => ({
  id: "d",
  version: "1.0.0",
  name: "Design",
  description: "",
  occasion: "diwali",
  occasionLabel: "Diwali",
  occasionColor: null,
  languages: [{ code: "en", label: "English" }],
  preview: "/p",
  custom: false,
  uploaderId: null,
  uploaderName: null,
  archived: false,
  ...over,
});

const items = [
  item({ id: "a", name: "Diwali Classic", languages: [{ code: "en", label: "English" }, { code: "hi", label: "हिन्दी" }] }),
  item({ id: "b", name: "Monsoon wishes", occasion: "anytime", occasionLabel: "Anytime", custom: true, uploaderId: "u1", uploaderName: "Neha Joshi", languages: [{ code: "en", label: "English" }, { code: "gu", label: "ગુજરાતી" }] }),
  item({ id: "c", name: "Holi colour", occasion: "holi", occasionLabel: "Holi", custom: true, uploaderId: "u2", uploaderName: "Rakesh Iyer" }),
];
const ids = (l: LibraryItem[]) => l.map((d) => d.id);

describe("the template library filter", () => {
  test("no filter is the whole list, in order", () => assert.deepEqual(ids(filterLibrary(items, {})), ["a", "b", "c"]));
  test("search matches the name, the occasion and the uploader, every word", () => {
    assert.deepEqual(ids(filterLibrary(items, { q: "monsoon" })), ["b"]);
    assert.deepEqual(ids(filterLibrary(items, { q: "neha" })), ["b"]);
    assert.deepEqual(ids(filterLibrary(items, { q: "holi colour" })), ["c"]);
    assert.deepEqual(ids(filterLibrary(items, { q: "holi monsoon" })), []);
    assert.deepEqual(ids(filterLibrary(items, { q: "  DIWALI " })), ["a"]);
  });
  test("occasion, language and uploader narrow, and combine", () => {
    assert.deepEqual(ids(filterLibrary(items, { occasion: "holi" })), ["c"]);
    assert.deepEqual(ids(filterLibrary(items, { language: "hi" })), ["a"]);
    assert.deepEqual(ids(filterLibrary(items, { language: "gu" })), ["b"]);
    assert.deepEqual(ids(filterLibrary(items, { language: "en" })), ["a", "b", "c"]);
    assert.deepEqual(ids(filterLibrary(items, { uploader: "u1" })), ["b"]);
    assert.deepEqual(ids(filterLibrary(items, { uploader: BUILT_IN })), ["a"]);
    assert.deepEqual(ids(filterLibrary(items, { language: "en", uploader: "u2" })), ["c"]);
    assert.deepEqual(ids(filterLibrary(items, { language: "gu", occasion: "holi" })), []);
  });
  test("the filter boxes offer only what the list has, each once", () => {
    const f = libraryFacets(items);
    assert.deepEqual(f.occasions.map((o) => o.value).sort(), ["anytime", "diwali", "holi"]);
    assert.deepEqual(f.languages.map((o) => o.value).sort(), ["en", "gu", "hi"]);
    assert.deepEqual(f.uploaders.map((o) => o.value).sort(), [BUILT_IN, "u1", "u2"].sort());
  });
});
