import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { leadConvertibility, LEAD_CONVERTIBLE_FORMS } from "./enquiry-labels";
import { ENQUIRY_SOURCE_FORM_TYPES } from "./enquiry-ingest-validation";
import { readLeadPrefill } from "./enquiry-submission";

/* ---------------------------------------------------------------------------
 * Which enquiries may become a lead, and what a lead is prefilled with. Both
 * pure, so the rules the Create lead button and the writer behind it share are
 * pinned without a database.
 * ------------------------------------------------------------------------- */

const enquiry = (sourceForm: string | null, over: { source?: string; category?: string | null } = {}) => ({
  source: over.source ?? "website",
  sourceForm,
  category: over.category ?? null,
});

describe("which enquiries may become a lead", () => {
  it("is exactly a quote, a product enquiry, a quick enquiry and a distributor enquiry", () => {
    assert.deepEqual([...LEAD_CONVERTIBLE_FORMS].sort(), ["DISTRIBUTOR", "PRODUCT_ENQUIRY", "QUICK_ENQUIRY", "QUOTE"]);
    for (const form of LEAD_CONVERTIBLE_FORMS) assert.equal(leadConvertibility(enquiry(form)).ok, true, form);
  });

  it("refuses every other form the website can send, a career application first among them", () => {
    for (const form of ENQUIRY_SOURCE_FORM_TYPES) {
      if ((LEAD_CONVERTIBLE_FORMS as readonly string[]).includes(form)) continue;
      const r = leadConvertibility(enquiry(form));
      assert.equal(r.ok, false, `${form} may become a lead`);
    }
    const career = leadConvertibility(enquiry("CAREER"));
    assert.equal(!career.ok && /career/i.test(career.reason), true);
  });

  it("refuses a convertible form filed under the CAREER category, and a form nobody named", () => {
    assert.equal(leadConvertibility(enquiry("QUOTE", { category: "CAREER" })).ok, false);
    assert.equal(leadConvertibility(enquiry(null)).ok, false);
    assert.equal(leadConvertibility(enquiry("A_NINTH_FORM")).ok, false, "a form the website adds later is not a lead until somebody says so");
  });

  it("is the website's alone: another channel is future scope, not a lead by accident", () => {
    const r = leadConvertibility(enquiry("QUOTE", { source: "instagram" }));
    assert.equal(r.ok, false);
  });
});

describe("what a lead is prefilled with", () => {
  it("reuses everything the visitor typed, and keeps the person apart from the business", () => {
    const p = readLeadPrefill({
      name: "Ganesh Pawar",
      company: "Shree Ganesh Paints",
      phone: "+91 98230 11101",
      email: "ganesh@shreeganeshpaints.in",
      message: "Need PU thinner, please send rates.",
      product: "PU Thinner",
      quantity: "200 litres a month",
      city: "Nashik",
      address: "Shop 12, Dwarka Circle",
      state: "Maharashtra",
      pincode: "422011",
      preferred_time: "evening",
    });
    assert.equal(p.name, "Shree Ganesh Paints", "the shop is the company where there is one");
    assert.equal(p.companyName, "Shree Ganesh Paints");
    assert.equal(p.contactPerson, "Ganesh Pawar");
    assert.equal(p.phone, "9823011101", "ten digits, whatever the visitor typed");
    assert.equal(p.email, "ganesh@shreeganeshpaints.in");
    assert.equal(p.city, "Nashik");
    assert.equal(p.address, "Shop 12, Dwarka Circle, Maharashtra, 422011");
    assert.equal(p.requirement, "PU Thinner — Quantity: 200 litres a month");
    assert.match(p.notes ?? "", /^Need PU thinner, please send rates\./, "what they wrote comes first");
    assert.match(p.notes ?? "", /preferred_time: evening/, "a field nothing else read is kept, not dropped");
  });

  it("uses the visitor's own name as the business where they gave no company", () => {
    const p = readLeadPrefill({ first_name: "Asha", last_name: "Rao", mobile: "9876543210" });
    assert.equal(p.name, "Asha Rao");
    assert.equal(p.companyName, null);
    assert.equal(p.contactPerson, "Asha Rao");
  });

  it("says nothing it does not know: a missing town is null for the dialog to ask about, never a guess", () => {
    const p = readLeadPrefill({ name: "Rohit", phone: "9876543210", message: "Need a quote" });
    assert.equal(p.city, null);
    assert.equal(p.address, null);
    assert.equal(p.requirement, null);
    assert.equal(p.email, null);
  });

  it("survives a submission that is not an object at all", () => {
    for (const raw of [null, undefined, "text", 42, []]) {
      const p = readLeadPrefill(raw);
      assert.equal(p.name, null);
      assert.equal(p.phone, null);
    }
  });
});
