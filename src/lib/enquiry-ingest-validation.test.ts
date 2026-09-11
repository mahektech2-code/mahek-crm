import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseIngestPayload, MAX_INGEST_BODY_BYTES, ENQUIRY_SOURCE_FORM_TYPES } from "./enquiry-ingest-validation";

/* ---------------------------------------------------------------------------
 * The untrusted-input boundary for /api/public/enquiries. Pure — no
 * database, no secrets — so every shape a real or malicious sender could
 * send is checked here without a server running.
 * ------------------------------------------------------------------------- */

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    formType: "CONTACT",
    category: "GENERAL",
    externalRef: "11111111-1111-4111-8111-111111111111",
    receivedAt: "2026-09-10T09:14:00.000Z",
    submission: { name: "Rohit Deshmukh", phone: "9876543210", email: "rohit@example.com", company: "Deshmukh Traders", message: "Need a quote." },
    ...overrides,
  };
}

describe("parseIngestPayload — valid submissions, one per real form type", () => {
  for (const formType of ENQUIRY_SOURCE_FORM_TYPES) {
    test(`accepts a well-formed ${formType} submission`, () => {
      const result = parseIngestPayload(validPayload({ formType }));
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.data.formType, formType);
        assert.equal(result.data.externalRef, "11111111-1111-4111-8111-111111111111");
      }
    });
  }
});

describe("parseIngestPayload — required shape", () => {
  test("rejects an unknown formType", () => {
    const result = parseIngestPayload(validPayload({ formType: "SOMETHING_ELSE" }));
    assert.equal(result.ok, false);
  });

  test("rejects an unknown category", () => {
    const result = parseIngestPayload(validPayload({ category: "NOT_A_REAL_CATEGORY" }));
    assert.equal(result.ok, false);
  });

  test("category is optional", () => {
    const withoutCategory = validPayload();
    delete (withoutCategory as { category?: unknown }).category;
    const result = parseIngestPayload(withoutCategory);
    assert.equal(result.ok, true);
  });

  test("rejects a missing externalRef", () => {
    const withoutRef = validPayload();
    delete (withoutRef as { externalRef?: unknown }).externalRef;
    const result = parseIngestPayload(withoutRef);
    assert.equal(result.ok, false);
  });

  test("rejects an empty externalRef", () => {
    const result = parseIngestPayload(validPayload({ externalRef: "" }));
    assert.equal(result.ok, false);
  });

  test("rejects a non-ISO receivedAt", () => {
    const result = parseIngestPayload(validPayload({ receivedAt: "10 September 2026" }));
    assert.equal(result.ok, false);
  });

  test("rejects a receivedAt with no timezone offset", () => {
    const result = parseIngestPayload(validPayload({ receivedAt: "2026-09-10T09:14:00" }));
    assert.equal(result.ok, false);
  });

  test("rejects a submission that is not an object", () => {
    const result = parseIngestPayload(validPayload({ submission: "just a string" }));
    assert.equal(result.ok, false);
  });

  test("rejects a completely malformed payload", () => {
    const result = parseIngestPayload({ nothing: "like the real shape" });
    assert.equal(result.ok, false);
  });

  test("rejects null and undefined outright", () => {
    assert.equal(parseIngestPayload(null).ok, false);
    assert.equal(parseIngestPayload(undefined).ok, false);
  });
});

describe("parseIngestPayload — submission field safety", () => {
  test("a __proto__ key in the submission is neutralised, never stored, never pollutes", () => {
    // JSON.parse (what the route actually receives) DOES create a genuine
    // own "__proto__" key — unlike object-literal syntax, which treats it as
    // prototype-setting syntax and never reaches here as a property at all.
    // But `__proto__` is an ACCESSOR inherited from Object.prototype, not a
    // plain data property: Zod's z.record() rebuilds the parsed object via
    // `result[key] = value`, and assigning to "__proto__" on that fresh
    // object invokes the inherited setter instead of creating an own key —
    // so it never survives parsing to reach the FORBIDDEN_KEYS check at all,
    // and nothing about it ends up on the parsed object or leaks anywhere.
    // This is verified here rather than assumed: the submission still parses
    // (the poisoned key harmlessly vanishes), and the thing an attacker
    // would actually want — a "polluted" property reaching a live object —
    // never appears.
    const submission = JSON.parse('{"__proto__": {"polluted": true}, "name": "Test"}');
    const result = parseIngestPayload(validPayload({ submission }));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(Object.keys(result.data.submission).includes("__proto__"), false);
      assert.equal((result.data.submission as Record<string, unknown>).polluted, undefined);
      assert.equal(Object.getPrototypeOf(result.data.submission), Object.prototype);
    }
  });

  test("rejects a submission carrying prototype as a key", () => {
    const submission = JSON.parse('{"prototype": {"polluted": true}, "name": "Test"}');
    const result = parseIngestPayload(validPayload({ submission }));
    assert.equal(result.ok, false);
  });

  test("rejects a submission carrying constructor as a key", () => {
    const result = parseIngestPayload(
      validPayload({ submission: JSON.parse('{"constructor": "x", "name": "Test"}') }),
    );
    assert.equal(result.ok, false);
  });

  test("allows arbitrary ordinary field names — new form fields need no CRM change", () => {
    const result = parseIngestPayload(
      validPayload({ submission: { name: "Test", aBrandNewFieldNobodyHasSeenYet: "value" } }),
    );
    assert.equal(result.ok, true);
  });
});

describe("parseIngestPayload — same phone, different submissions", () => {
  test("two different externalRefs from the same phone number both parse as valid, independent submissions", () => {
    const first = parseIngestPayload(validPayload({ externalRef: "aaaaaaaa-1111-4111-8111-111111111111", submission: { phone: "9876543210", message: "Thinner enquiry" } }));
    const second = parseIngestPayload(validPayload({ externalRef: "bbbbbbbb-2222-4222-8222-222222222222", submission: { phone: "9876543210", message: "Solvent enquiry, a week later" } }));
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (first.ok && second.ok) {
      assert.notEqual(first.data.externalRef, second.data.externalRef);
    }
  });
});

test("MAX_INGEST_BODY_BYTES is a sane, finite cap", () => {
  assert.ok(MAX_INGEST_BODY_BYTES > 1024);
  assert.ok(MAX_INGEST_BODY_BYTES < 1024 * 1024);
});
