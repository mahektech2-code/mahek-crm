import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { resolveFieldValues, type ResolveInput } from "./fields";
import { templateSchema } from "./template";
import { leadSchema, type Lead, type User } from "./lead";
import { checkReadiness } from "./readiness";
import { MOCK_LEAD_RECORDS } from "@/lib/studio/test-fixtures";

const root = path.resolve(process.cwd(), "studio", "templates");
const tpl = (id: string) => templateSchema.parse(JSON.parse(fs.readFileSync(path.join(root, id, "template.json"), "utf8")));
const leads = Object.fromEntries(MOCK_LEAD_RECORDS.map((r) => [r.id, leadSchema.parse(r)]));
const user: User = { id: "u-priya", name: "Priya Sharma", role: "Sales executive", initials: "PS" };

const resolve = (id: string, lead: Lead, over: Partial<ResolveInput> = {}) =>
  resolveFieldValues({ fields: tpl(id).fields, lead, user, language: "en", greeting: "Hello", showOptional: true, ...over });
const text = (r: ReturnType<typeof resolve>, key: string) => {
  const v = r.values[key];
  return v && v.kind === "text" ? v.text : null;
};

describe("resolveFieldValues", () => {
  test("fills a festival template from the lead, in order: salutation prefix, company, greeting, product, footer", () => {
    const r = resolve("diwali-premium", leads.l1);
    assert.equal(text(r, "occasion_title"), "Happy Diwali");
    assert.equal(text(r, "customer_name"), "Dear Rajesh Shah");
    assert.equal(text(r, "company_name"), "ABC Industries");
    assert.equal(text(r, "greeting"), "Hello");
    assert.equal(text(r, "product_line"), "M1433 Thinner");
    assert.equal(text(r, "footer_site"), "mahekindia.com");
    assert.equal(text(r, "salesperson"), "Your Mahek contact · Priya Sharma");
    assert.deepEqual(r.missing, []);
  });
  test("the salutation and static text follow the language, with English as the fallback", () => {
    assert.equal(text(resolve("diwali-premium", leads.l1, { language: "hi" }), "customer_name"), "प्रिय Rajesh Shah");
    assert.equal(text(resolve("diwali-premium", leads.l3, { language: "gu" }), "occasion_title"), "દિવાળીની શુભેચ્છાઓ");
    // footer_site only has English text: other languages reuse it
    assert.equal(text(resolve("diwali-premium", leads.l1, { language: "gu" }), "footer_site"), "mahekindia.com");
  });
  test("no contact: the customer name falls back to the company", () => {
    const lead = { ...leads.l1, contact: null };
    assert.equal(text(resolve("diwali-premium", lead), "customer_name"), "Dear ABC Industries");
  });
  test("optional fields are left out when switched off, and when the lead has no value", () => {
    assert.equal(resolve("diwali-premium", leads.l1, { showOptional: false }).values.product_line, null);
    assert.equal(resolve("diwali-premium", leads.l8).values.product_line, null);
  });
  test("a lead without a product is not 'missing' anything for a festival template", () => {
    assert.deepEqual(resolve("diwali-premium", leads.l8).missing, []);
  });
  test("product-spotlight reports the product fields as missing when the lead has no product", () => {
    const r = resolve("product-spotlight", leads.l8);
    assert.deepEqual(r.missing.sort(), ["product_image", "product_name"]);
    assert.equal(r.values.product_image, null);
  });
  test("product-spotlight with a product resolves the pack image by product code", () => {
    const r = resolve("product-spotlight", leads.l1);
    assert.deepEqual(r.values.product_image, { kind: "asset", asset: "product_image", code: "M1433" });
    assert.equal(text(r, "product_name"), "M1433 Thinner");
  });
  test("the logo variant comes from the template", () => {
    assert.deepEqual(resolve("diwali-premium", leads.l1).values.logo, { kind: "asset", asset: "logo", variant: "light" });
    assert.deepEqual(resolve("diwali-classic", leads.l1).values.logo, { kind: "asset", asset: "logo", variant: "dark" });
  });
  test("lead text is carried through untouched (special characters are the renderer's concern)", () => {
    assert.equal(text(resolve("diwali-premium", leads.l4), "company_name"), "Qureshi Hardware & Paints");
  });
  test("deterministic: the same input gives the same output", () => {
    assert.deepEqual(resolve("diwali-premium", leads.l1), resolve("diwali-premium", leads.l1));
  });
});

describe("checkReadiness with real templates", () => {
  test("festival templates are ready for every sample lead, including the one without a product", () => {
    for (const id of ["dussehra-victory", "diwali-premium", "diwali-classic", "newyear-gold", "holi-colour", "independence-salute", "welcome-note"]) {
      for (const lead of Object.values(leads)) assert.deepEqual(checkReadiness(lead, user, tpl(id)), { ok: true }, `${id}/${lead.id}`);
    }
  });
  test("product-spotlight is ready only for leads with a product, with a plain-language reason otherwise", () => {
    assert.deepEqual(checkReadiness(leads.l1, user, tpl("product-spotlight")), { ok: true });
    const r = checkReadiness(leads.l8, user, tpl("product-spotlight"));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "Needs a product on this lead");
  });
});
