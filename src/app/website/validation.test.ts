import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  emailError,
  gaIdError,
  hasErrors,
  linkError,
  phoneError,
  required,
  slugError,
  urlError,
} from "./validation";
import { PROTOTYPE_NOTE, tempFeedback } from "./prototype";
import { INDUSTRIES, NAV, PRODUCTS, SETTINGS } from "./mock-data";

/* ---------------------------------------------------------------------------
 * The Website app's form rules and its honest feedback wording.
 *
 * Pure, so no database or browser is needed. Two kinds of case: what must be
 * refused, and — just as important — what the app already carries, which a
 * form must never reject.
 * ------------------------------------------------------------------------- */

describe("required", () => {
  it("refuses empty and whitespace-only values, and names the field", () => {
    assert.equal(required("", "Name"), "Name is required.");
    assert.equal(required("   ", "Name"), "Name is required.");
    assert.equal(required("\t\n", "Title"), "Title is required.");
  });
  it("accepts a real value", () => {
    assert.equal(required("Universal Thinner", "Name"), undefined);
    assert.equal(required(" x ", "Name"), undefined);
  });
});

describe("slugError", () => {
  it("refuses a blank slug", () => {
    assert.match(slugError("", [])!, /required/);
    assert.match(slugError("   ", [])!, /required/);
  });
  it("refuses anything that is not a lower-case hyphenated segment", () => {
    for (const bad of ["Universal-Thinner", "has space", "under_score", "double--hyphen", "-lead", "trail-", "a/b", "ünï", "x.y"]) {
      assert.ok(slugError(bad, []), `should refuse "${bad}"`);
    }
  });
  it("accepts well-formed slugs, including digits", () => {
    for (const ok of ["nc-thinner", "mylac-135-melamine-thinner", "mahek-polish-thinner-m1433", "a", "a1"]) {
      assert.equal(slugError(ok, []), undefined, ok);
    }
  });
  it("refuses a slug another record already uses, ignoring case and padding", () => {
    assert.match(slugError("nc-thinner", ["nc-thinner"], "product")!, /Another product already uses this slug/);
    assert.match(slugError("nc-thinner", [" NC-Thinner "])!, /already uses/);
  });
  it("lets a record keep its own slug when its own is left out of `taken`", () => {
    assert.equal(slugError("nc-thinner", ["pu-thinner", "nano-thinner"]), undefined);
  });
  it("accepts every slug the seed data already carries", () => {
    for (const list of [PRODUCTS, INDUSTRIES]) {
      list.forEach((r, i) => {
        const others = list.filter((_, j) => j !== i).map((x) => x.slug);
        assert.equal(slugError(r.slug, others), undefined, r.slug);
      });
    }
  });
});

describe("emailError", () => {
  it("accepts blank (optional) and ordinary addresses", () => {
    assert.equal(emailError(""), undefined);
    assert.equal(emailError("sales@mahekchemicals.com"), undefined);
    assert.equal(emailError("  a.b+c@sub.example.co.in "), undefined);
  });
  it("refuses things that are not addresses", () => {
    for (const bad of ["not-an-email", "a@b", "a b@c.com", "@x.com", "a@.com", "a@b."]) {
      assert.ok(emailError(bad), `should refuse "${bad}"`);
    }
  });
});

describe("phoneError", () => {
  it("accepts blank and numbers as people write them", () => {
    assert.equal(phoneError(""), undefined);
    for (const ok of ["+91 98765 43210", "+91 81081 06253", "022-1234 5678", "(022) 12345678", "9876543210", "+1 (555) 010-9999"]) {
      assert.equal(phoneError(ok), undefined, ok);
    }
  });
  it("refuses words, too few digits and too many", () => {
    for (const bad of ["not-a-phone", "call us", "12345", "1234567890123456", "98765 4321 abc"]) {
      assert.ok(phoneError(bad), `should refuse "${bad}"`);
    }
  });
});

describe("urlError", () => {
  it("accepts blank and full http(s) addresses", () => {
    assert.equal(urlError(""), undefined);
    assert.equal(urlError("https://facebook.com/mahek"), undefined);
    assert.equal(urlError("http://example.co.in/a?b=1"), undefined);
  });
  it("refuses bare words, other schemes and hostnames with no dot", () => {
    for (const bad of ["hello", "facebook.com/mahek", "ftp://example.com", "javascript:alert(1)", "https://localhost", "https://"]) {
      assert.ok(urlError(bad), `should refuse "${bad}"`);
    }
  });
});

describe("gaIdError", () => {
  it("accepts blank and GA4 measurement IDs, including the real site's shape", () => {
    assert.equal(gaIdError(""), undefined);
    assert.equal(gaIdError("G-9QL6FEYDRC"), undefined);
    assert.equal(gaIdError("G-XXXXXXXXXX"), undefined);
  });
  it("refuses other shapes", () => {
    for (const bad of ["garbage", "UA-12345-1", "g-abcdef1234", "G-", "G-ab", "G-ABC DEF123"]) {
      assert.ok(gaIdError(bad), `should refuse "${bad}"`);
    }
  });
});

describe("linkError", () => {
  it("requires a link", () => {
    assert.match(linkError("")!, /required/);
    assert.match(linkError("  ")!, /required/);
  });
  it("accepts paths, full addresses, mailto and tel", () => {
    for (const ok of ["/", "/products", "/products/nc-thinner", "https://example.com/x", "mailto:sales@example.com", "tel:+918108106253"]) {
      assert.equal(linkError(ok), undefined, ok);
    }
  });
  it("refuses spaces and things that are not links", () => {
    for (const bad of ["not a path", "products", "/has space", "javascript:alert(1)", "ftp://x.com"]) {
      assert.ok(linkError(bad), `should refuse "${bad}"`);
    }
  });
  it("accepts every menu link the seed data already carries", () => {
    for (const items of Object.values(NAV)) for (const i of items) assert.equal(linkError(i.href), undefined, i.href);
  });
});

describe("the Settings seed passes its own checks", () => {
  it("every seeded value is accepted", () => {
    assert.equal(required(SETTINGS.company.name, "Name"), undefined);
    assert.equal(phoneError(SETTINGS.contact.phone), undefined);
    assert.equal(emailError(SETTINGS.contact.email), undefined);
    assert.equal(urlError(SETTINGS.social.facebook), undefined);
    assert.equal(urlError(SETTINGS.social.instagram), undefined);
    assert.equal(gaIdError(SETTINGS.analytics.gaId), undefined);
  });
});

describe("hasErrors", () => {
  it("is true only when some field carries a message", () => {
    assert.equal(hasErrors({}), false);
    assert.equal(hasErrors({ a: undefined, b: undefined }), false);
    assert.equal(hasErrors({ a: undefined, b: "bad" }), true);
  });
});

describe("honest feedback", () => {
  it("says what happened and then that nothing is kept", () => {
    assert.equal(tempFeedback("Product added"), `Product added. ${PROTOTYPE_NOTE}`);
  });
  it("does not double the full stop", () => {
    assert.equal(tempFeedback("Product added."), `Product added. ${PROTOTYPE_NOTE}`);
  });
  it("the note itself says the change is temporary and will not persist", () => {
    assert.match(PROTOTYPE_NOTE, /Prototype only/);
    assert.match(PROTOTYPE_NOTE, /temporary/);
    assert.match(PROTOTYPE_NOTE, /will not persist/);
  });
  it("the note never claims a save, upload, post or publish", () => {
    assert.doesNotMatch(tempFeedback("Anything"), /\b(saved to|uploaded|posted|published to)\b/i);
  });
});
