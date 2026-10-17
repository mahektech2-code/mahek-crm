import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanScan, foundAnything, gstinSettled, hasIndianScript, preferGstin, tidy, type LeadScanReading } from "./lead-scan";

/* Everything goes through `cleanScan`, the one function the service calls —
   the helpers behind it are private, so a rule tested here is a rule the
   handset actually receives. */

const blank: LeadScanReading = {
  businessName: null,
  contactPerson: null,
  phones: [],
  city: null,
  state: null,
  address: null,
  pincode: null,
  gstin: null,
  note: null,
};

const numbers = (phones: LeadScanReading["phones"]) => {
  const r = cleanScan({ ...blank, phones });
  return { mobile: r.mobile, otherNumbers: r.otherNumbers };
};
const gst = (gstin: string | null) => {
  const r = cleanScan({ ...blank, gstin });
  return r.gstin ? { gstin: r.gstin, check: r.gstinCheck } : null;
};

test("a model's 'nothing here' is null, in every spelling", () => {
  for (const s of ["", "  ", "N/A", "na", "Not visible", "not legible", "--", "unknown", "?"]) {
    assert.equal(tidy(s), null, JSON.stringify(s));
  }
  assert.equal(tidy("  Patil   Paints "), "Patil Paints");
  assert.equal(cleanScan({ ...blank, businessName: "Not visible" }).businessName, null);
});

test("a mobile is reduced to its national ten digits however it was printed", () => {
  for (const printed of ["+91 98220 11001", "098220-11001", "91-9822011001", "(+91) 9822 011 001"]) {
    assert.equal(numbers([{ number: printed, kind: "mobile" }]).mobile, "9822011001", printed);
  }
});

test("only a number the model called a mobile becomes the mobile — an STD landline looks like one", () => {
  assert.deepEqual(
    numbers([
      { number: "0712 2345678", kind: "landline" },
      { number: "+91 98220 11001", kind: "mobile" },
    ]),
    { mobile: "9822011001", otherNumbers: ["0712 2345678"] },
  );
});

test("an unlabelled mobile-shaped number is the second choice, and a landline is never the first", () => {
  assert.equal(numbers([{ number: "0712 2345678", kind: "landline" }]).mobile, null);
  assert.equal(numbers([{ number: "98220 11001", kind: "unknown" }]).mobile, "9822011001");
});

test("the same number printed twice is offered once", () => {
  assert.deepEqual(
    numbers([
      { number: "98220 11001", kind: "mobile" },
      { number: "+919822011001", kind: "unknown" },
      { number: "8888812345", kind: "mobile" },
    ]),
    { mobile: "9822011001", otherNumbers: ["8888812345"] },
  );
});

test("a GSTIN that passes its checksum is valid as read", () => {
  assert.deepEqual(gst("27aapfu0939f1zv"), { gstin: "27AAPFU0939F1ZV", check: "valid" });
  assert.deepEqual(gst("27 AAPFU 0939 F1ZV"), { gstin: "27AAPFU0939F1ZV", check: "valid" });
});

test("O for 0 and I for 1 are repaired where the format forces it and the checksum agrees", () => {
  assert.deepEqual(gst("27AAPFUO939F1ZV"), { gstin: "27AAPFU0939F1ZV", check: "corrected" });
  assert.deepEqual(gst("29AAGCB7383JIZ4"), { gstin: "29AAGCB7383J1Z4", check: "corrected" });
});

test("a GSTIN that still fails is passed through marked invalid, never dropped", () => {
  assert.deepEqual(gst("27AAPFU0939F1ZX"), { gstin: "27AAPFU0939F1ZX", check: "invalid" });
  assert.deepEqual(gst("27AAPFU09"), { gstin: "27AAPFU09", check: "invalid" });
  assert.equal(gst("N/A"), null);
});

test("a valid GSTIN names the state where the board does not, and never overrules it", () => {
  assert.equal(cleanScan({ ...blank, gstin: "27AAPFU0939F1ZV" }).state, "Maharashtra");
  assert.equal(cleanScan({ ...blank, gstin: "27AAPFU0939F1ZV", state: "Gujarat" }).state, "Gujarat");
  assert.equal(cleanScan({ ...blank, gstin: "27AAPFU0939F1ZX" }).state, null, "an invalid number names nothing");
});

test("the pincode joins the address once", () => {
  assert.equal(
    cleanScan({ ...blank, address: "Shop 4, Itwari", pincode: "440002" }).address,
    "Shop 4, Itwari 440002",
  );
  assert.equal(
    cleanScan({ ...blank, address: "Shop 4, Itwari, Nagpur 440002", pincode: "440002" }).address,
    "Shop 4, Itwari, Nagpur 440002",
  );
});

test("a reading of nothing is said to be nothing", () => {
  assert.equal(foundAnything(cleanScan(blank)), false);
  assert.equal(foundAnything(cleanScan({ ...blank, businessName: "Patil Paints" })), true);
});

test("two numbers on one printed line are two numbers", () => {
  assert.deepEqual(numbers([{ number: "98220 11001 / 98220 11002", kind: "mobile" }]), {
    mobile: "9822011001",
    otherNumbers: ["9822011002"],
  });
  assert.deepEqual(numbers([{ number: "9822011001, 0712-2345678", kind: "unknown" }]).mobile, "9822011001");
});

test("a run of digits too long to be one number is not offered as one", () => {
  assert.deepEqual(numbers([{ number: "98220110019822011002", kind: "mobile" }]), { mobile: null, otherNumbers: [] });
});

test("a contact person who is only the shop's name again is no person", () => {
  const r = cleanScan({ ...blank, businessName: "Patil Paints", contactPerson: "PATIL PAINTS" });
  assert.equal(r.businessName, "Patil Paints");
  assert.equal(r.contactPerson, null);
});

test("second GSTIN look: is not asked for when the first reading passes or was repaired", () => {
  assert.equal(gstinSettled("27AAPFU0939F1ZV"), true);
  assert.equal(gstinSettled("27AAPFUO939F1ZV"), true);
  assert.equal(gstinSettled(null), false);
  assert.equal(gstinSettled("27AAPFU0939F1Z"), false);
  assert.equal(gstinSettled("27AAPFU0939F1ZX"), false);
});

test("second GSTIN look: replaces a missing or failing reading with one the checksum accepts", () => {
  assert.equal(preferGstin(null, "27AAPFU0939F1ZV"), "27AAPFU0939F1ZV");
  assert.equal(preferGstin("27AAPFU0939F1ZX", "27AAPFU0939F1ZV"), "27AAPFU0939F1ZV");
});

test("second GSTIN look: never loses what the first reading found", () => {
  assert.equal(preferGstin("27AAPFU0939F1ZX", null), "27AAPFU0939F1ZX");
  assert.equal(preferGstin("27AAPFU0939F1ZX", "27AAPFU0939F1Z"), "27AAPFU0939F1ZX");
});

test("Indian-script text is caught", () => {
  assert.equal(hasIndianScript("ಶ್ರೀ ಗಣೇಶ ಪೇಂಟ್ಸ್"), true);
  assert.equal(hasIndianScript("హైదరాబాద్"), true);
  assert.equal(hasIndianScript("রহিম হার্ডওয়্যার"), true);
  assert.equal(hasIndianScript("श्याम ट्रेडर्स"), true);
  assert.equal(hasIndianScript("Shri Ganesh Paints"), false);
  assert.equal(hasIndianScript(null), false);
});

test("a mobile and a PIN printed in Indian digits still arrive", () => {
  const r = cleanScan({
    ...blank,
    phones: [{ number: "+९१ ९८२२० ११००१", kind: "mobile" }],
    address: "MG Road, Bengaluru",
    pincode: "೫೬೦೦೦೧",
  });
  assert.equal(r.mobile, "9822011001");
  assert.equal(r.address, "MG Road, Bengaluru 560001");
});
