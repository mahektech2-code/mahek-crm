import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { downloadFilename, suggestedCaption, whatsappTextUrl } from "./caption";
import { checkCopyText } from "./copy";

const lead = { contact: "Rajesh Shah", company: "ABC Industries", product: { id: "M1433", code: "M1433", name: "M1433 Thinner" } };
const user = { name: "Priya Sharma" };

describe("suggestedCaption", () => {
  test("festival, promotion and greeting each have their own message", () => {
    assert.equal(suggestedCaption("festival", lead, user), "Dear Rajesh, warm wishes from all of us at Mahek Marketing India.\n— Priya Sharma");
    assert.equal(suggestedCaption("promotion", lead, user), "Hello Rajesh, sharing a note on M1433 Thinner. Happy to answer any questions.\n— Priya Sharma, Mahek Marketing India");
    assert.equal(suggestedCaption("greeting", lead, user), "Hello Rajesh, thank you for your interest in Mahek. We are here to help.\n— Priya Sharma, Mahek Marketing India");
  });
  test("without a contact the company is addressed; without a product it says 'our range'", () => {
    assert.ok(suggestedCaption("festival", { ...lead, contact: null }, user).startsWith("Dear ABC Industries,"));
    assert.ok(suggestedCaption("promotion", { ...lead, product: null }, user).includes("our range"));
  });
  test("a caption contains no prices, offers, claims, links or currency", () => {
    for (const c of ["festival", "greeting"] as const) {
      const text = suggestedCaption(c, { ...lead, contact: "Rajesh" }, user);
      assert.deepEqual(checkCopyText(text, "en").filter((i) => i.code !== "digits"), [], c);
    }
  });
});

describe("whatsappTextUrl", () => {
  test("encodes the message, including line breaks, ampersands and non-English text", () => {
    const url = whatsappTextUrl("Hi & bye\nशुभ");
    assert.ok(url.startsWith("https://wa.me/?text="));
    assert.equal(new URL(url).searchParams.get("text"), "Hi & bye\nशुभ");
  });
});

describe("downloadFilename", () => {
  test("is plain ASCII with the design, the company and the language", () => {
    assert.equal(downloadFilename("diwali-premium", "ABC Industries", "hi", "png"), "Mahek_diwali-premium_ABC-Industries_hi.png");
    assert.equal(downloadFilename("welcome-note", "Qureshi Hardware & Paints", "en", "jpeg"), "Mahek_welcome-note_Qureshi-Hardware-Paints_en.jpg");
  });
  test("a long company name is shortened and never ends on a dash", () => {
    const n = downloadFilename("diwali-premium", "Maharashtra Industrial Coatings & Allied Products Pvt. Ltd.", "en", "png");
    assert.ok(n.length < 80);
    assert.match(n, /^Mahek_diwali-premium_[A-Za-z0-9-]+_en\.png$/);
    assert.ok(!n.includes("-_"));
  });
  test("a name with no ASCII letters falls back to 'lead'; path tricks and quotes cannot survive", () => {
    assert.equal(downloadFilename("diwali-premium", "पटेल", "gu", "png"), "Mahek_diwali-premium_lead_gu.png");
    const evil = downloadFilename("diwali-premium", '../../etc/passwd"; rm -rf', "en", "png");
    assert.match(evil, /^[A-Za-z0-9._-]+$/);
    assert.ok(!evil.includes(".."));
  });
});

describe("downloadFilename for sample data", () => {
  test("a sample poster's file name starts with SAMPLE_; a real one never does", () => {
    assert.equal(downloadFilename("diwali-premium", "ABC Industries", "hi", "png", { sample: true }), "SAMPLE_Mahek_diwali-premium_ABC-Industries_hi.png");
    assert.equal(downloadFilename("diwali-premium", "ABC Industries", "hi", "jpeg", { sample: true }), "SAMPLE_Mahek_diwali-premium_ABC-Industries_hi.jpg");
    assert.equal(downloadFilename("diwali-premium", "ABC Industries", "hi", "png", { sample: false }), "Mahek_diwali-premium_ABC-Industries_hi.png");
    assert.equal(downloadFilename("diwali-premium", "ABC Industries", "hi", "png"), "Mahek_diwali-premium_ABC-Industries_hi.png");
  });
});
