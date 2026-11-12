import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { templateSchema, templateLanguage, type Template } from "./template";
import { FIELD_KEYS, isFieldKey } from "./fields";

const root = path.resolve(process.cwd(), "studio", "templates");
const folders = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
const raw = (id: string) => JSON.parse(fs.readFileSync(path.join(root, id, "template.json"), "utf8"));
// the approved designs and their archived earlier versions; draft versions awaiting review (the "-contact" versions) are checked separately below
const ids = folders.filter((id) => raw(id).status !== "draft");
const messages = (input: unknown) => {
  const r = templateSchema.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};
// a deep copy that tests can break one thing in
const base = (): Template & Record<string, unknown> => structuredClone(raw("diwali-premium"));

describe("the eight approved templates", () => {
  test("there are eight approved designs (and six archived earlier versions), and every manifest passes the schema", () => {
    assert.equal(ids.filter((id) => raw(id).status === "approved").length, 8);
    assert.equal(ids.filter((id) => raw(id).status === "archived").length, 6);
    assert.equal(ids.length, 14);
    for (const id of ids) assert.deepEqual(messages(raw(id)), [], id);
  });
  test("every other folder is a draft awaiting review, never an approved design, and also passes the schema", () => {
    const drafts = folders.filter((id) => !ids.includes(id));
    assert.equal(drafts.length, 8);
    for (const id of drafts) {
      assert.equal(raw(id).status, "draft", id);
      assert.deepEqual(messages(raw(id)), [], id);
    }
  });
  test("every text field has a font size range, a line limit and an overflow policy", () => {
    for (const id of ids) {
      for (const f of raw(id).fields) {
        if (f.type !== "text") continue;
        assert.ok(f.minFont <= f.maxFont && f.maxLines >= 1 && ["ellipsis", "abbreviate", "block"].includes(f.overflow), `${id}/${f.key}`);
      }
    }
  });
  test("every greeting field has a character limit for the wording", () => {
    for (const id of ids) {
      const g = raw(id).fields.find((f: { source: string }) => f.source === "copy");
      assert.ok(g && g.maxChars > 0, id);
    }
  });
  test("product-spotlight requires a product; festival templates do not", () => {
    assert.deepEqual(raw("product-spotlight").requires, ["product"]);
    assert.deepEqual(raw("diwali-premium").requires, []);
  });
});

describe("template schema rejects bad manifests with a clear reason", () => {
  test("a box outside the canvas", () => {
    const t = base();
    t.fields[1].box = { x: 1000, y: 100, w: 200, h: 100 };
    assert.ok(messages(t).some((m) => /outside the 1080x1080 canvas/.test(m)), messages(t).join("|"));
  });
  test("minFont larger than maxFont", () => {
    const t = base();
    (t.fields[1] as { minFont: number }).minFont = 500;
    assert.ok(messages(t).some((m) => /minFont .* larger than maxFont/.test(m)));
  });
  test("an unknown field key", () => {
    const t = base();
    t.fields[1].key = "made_up_field" as never;
    assert.ok(messages(t).some((m) => /not a known field key/.test(m)));
  });
  test("a source the field key does not allow", () => {
    const t = base();
    (t.fields.find((f) => f.key === "greeting") as { source: string }).source = "static";
    assert.ok(messages(t).some((m) => /cannot use source "static"/.test(m)));
  });
  test("a crmPath the field key does not allow", () => {
    const t = base();
    (t.fields.find((f) => f.key === "company_name") as { crmPath: string }).crmPath = "lead.contact";
    assert.ok(messages(t).some((m) => /not allowed for "company_name"/.test(m)));
  });
  test("duplicate field keys", () => {
    const t = base();
    t.fields.push(structuredClone(t.fields[1]));
    assert.ok(messages(t).some((m) => /duplicate field key/.test(m)));
  });
  test("a font role with no font for a declared language", () => {
    const t = base();
    delete (t.fonts.display as Record<string, string>).hi;
    assert.ok(messages(t).some((m) => /role "display" has no font for "hi"/.test(m)));
  });
  test("an unsupported schemaVersion, a bad id, a bad version, a bad status", () => {
    assert.ok(messages({ ...base(), schemaVersion: 2 }).length > 0);
    assert.ok(messages({ ...base(), id: "Diwali_Premium" }).length > 0);
    assert.ok(messages({ ...base(), version: "1.2" }).length > 0);
    assert.ok(messages({ ...base(), status: "published" }).length > 0);
  });
  test("requires a product but no field uses it", () => {
    const t = base();
    t.requires = ["product"];
    t.fields = t.fields.filter((f) => !["product_line", "product_name", "product_image"].includes(f.key));
    assert.ok(messages(t).some((m) => /no field uses the product/.test(m)));
  });
  test("a static field needs text, and static text needs an English fallback", () => {
    const t = base();
    (t.fields.find((f) => f.key === "occasion_title") as { text?: unknown }).text = { hi: "x" };
    assert.ok(messages(t).some((m) => /English \(en\) entry/.test(m)));
  });
});

describe("registry and language helpers", () => {
  test("every registered key is recognised and unknown keys are not", () => {
    for (const k of FIELD_KEYS) assert.ok(isFieldKey(k));
    assert.ok(!isFieldKey("toString"));
    assert.ok(!isFieldKey("nope"));
  });
  test("templateLanguage keeps an offered language and falls back to English otherwise", () => {
    assert.equal(templateLanguage({ languages: ["en", "hi"] }, "hi"), "hi");
    assert.equal(templateLanguage({ languages: ["en", "hi"] }, "gu"), "en");
  });
});
