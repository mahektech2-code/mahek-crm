import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseIngestPayload,
  MAX_INGEST_BODY_BYTES,
  ENQUIRY_SOURCE_FORM_TYPES,
  ENQUIRY_SOURCE_CATEGORIES,
  EnquiryIngestSchema,
} from "./enquiry-ingest-validation";

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

/* ---------------------------------------------------------------------------
 * Senior Review Finding #22 — the Website → CRM contract.
 *
 * The website (mahektech2-code/mahek-website) and this CRM are separate
 * repositories with no shared package, no generated schema, and no
 * cross-repo CI — `formType`/`category` are hand-copied on each side, by
 * design (see this file's own top-of-file comment). This is NOT a fix for
 * that: it cannot create real cross-repository synchronization from inside
 * one repo. What it DOES do is turn the specific contract already verified
 * by hand into an executable regression: if a future change here silently
 * drops, renames, or re-spells a value the website is known to send, THIS
 * test fails, rather than the ingestion route quietly starting to reject
 * production traffic.
 *
 * Contract verified against mahek-website `src/app/api/enquiry/route.ts` and
 * `src/lib/crm-sync.ts` during Finding #22 audit on 2026-09-12. Keep these
 * values synchronized with the website producer — if the website adds,
 * renames, or removes a formType/category, this test must be updated to
 * match, deliberately, rather than left to fail forever.
 *
 * The expected arrays below are typed out independently rather than derived
 * from `ENQUIRY_SOURCE_FORM_TYPES`/`ENQUIRY_SOURCE_CATEGORIES` — comparing
 * this file's own constant against itself would prove nothing: a change that
 * altered both the production list and this test in the same commit would
 * still pass, exactly the way a future accidental drift is likely to happen.
 * ------------------------------------------------------------------------- */

describe("Website → CRM contract (Senior Review Finding #22)", () => {
  // The exact 8 formType values verified against the website's
  // src/app/api/enquiry/route.ts VALID_FORM_TYPES and src/types/enquiry.ts
  // EnquiryFormType during the Finding #22 audit — not re-derived from this
  // file's own ENQUIRY_SOURCE_FORM_TYPES.
  const WEBSITE_VERIFIED_FORM_TYPES = [
    "CONTACT",
    "QUICK_ENQUIRY",
    "PRODUCT_ENQUIRY",
    "DISTRIBUTOR",
    "TECHNICAL_ENQUIRY",
    "QUOTE",
    "SAMPLE",
    "CAREER",
  ];

  // The exact 5 category values verified against the website's
  // src/app/api/enquiry/route.ts VALID_CATEGORIES and src/types/enquiry.ts
  // EnquiryCategory during the same audit.
  const WEBSITE_VERIFIED_CATEGORIES = ["GENERAL", "SALES", "DISTRIBUTOR", "CAREER", "LOGISTICS"];

  test("the CRM's accepted formType vocabulary is exactly what the website currently sends — no more, no fewer, no renamed/re-spelled value", () => {
    assert.deepEqual(
      [...ENQUIRY_SOURCE_FORM_TYPES].sort(),
      [...WEBSITE_VERIFIED_FORM_TYPES].sort(),
      "ENQUIRY_SOURCE_FORM_TYPES has drifted from the formType vocabulary verified against the live website source — " +
        "update WEBSITE_VERIFIED_FORM_TYPES here only after confirming the website's own VALID_FORM_TYPES really changed",
    );
  });

  test("the CRM's accepted category vocabulary is exactly what the website currently sends — no more, no fewer, no renamed/re-spelled value", () => {
    assert.deepEqual(
      [...ENQUIRY_SOURCE_CATEGORIES].sort(),
      [...WEBSITE_VERIFIED_CATEGORIES].sort(),
      "ENQUIRY_SOURCE_CATEGORIES has drifted from the category vocabulary verified against the live website source — " +
        "update WEBSITE_VERIFIED_CATEGORIES here only after confirming the website's own VALID_CATEGORIES really changed",
    );
  });

  test("a representative website wire payload (crm-sync.ts's own shape) is accepted by EnquiryIngestSchema", () => {
    // The exact envelope forwardEnquiryToCrm() builds: formType, category,
    // externalRef (the website's own uuid().defaultRandom() enquiry id),
    // receivedAt (Date#toISOString()), and submission — common fields
    // spread in under the same key names buildSubmission() uses.
    const websitePayload = {
      formType: "CONTACT",
      category: "GENERAL",
      externalRef: "550e8400-e29b-41d4-a716-446655440000",
      receivedAt: "2026-09-12T10:30:00.000Z",
      submission: {
        name: "Rohit Deshmukh",
        phone: "9876543210",
        email: "rohit@example.com",
        company: "Deshmukh Traders",
        message: "Need a quote for 200 litres of thinner.",
      },
    };

    const result = EnquiryIngestSchema.safeParse(websitePayload);
    assert.equal(result.success, true, result.success ? "" : JSON.stringify(result.error?.issues));
    if (result.success) {
      assert.equal(result.data.formType, "CONTACT");
      assert.equal(result.data.category, "GENERAL");
      assert.equal(result.data.externalRef, "550e8400-e29b-41d4-a716-446655440000");
      assert.equal(result.data.receivedAt, "2026-09-12T10:30:00.000Z");
      assert.equal(result.data.submission.name, "Rohit Deshmukh");
      assert.equal(result.data.submission.phone, "9876543210");
      assert.equal(result.data.submission.email, "rohit@example.com");
      assert.equal(result.data.submission.company, "Deshmukh Traders");
      assert.equal(result.data.submission.message, "Need a quote for 200 litres of thinner.");
    }
  });
});
