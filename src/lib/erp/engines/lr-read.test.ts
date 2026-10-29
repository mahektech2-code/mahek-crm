import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanLrNo, cleanLrReading, fitsStyle, freightTermOf, listedTransporter, lrShape, matchTransporter, styleLine, type LrRawReading, type LrStyle } from "./lr-read";

const DIR: LrStyle[] = [
  { name: "Shree Maruti Courier", label: "GR Number", examples: ["1048821", "1048830", "1048902"] },
  { name: "VRL Logistics", label: "LR Number", examples: ["MUM/45120", "MUM/45133"] },
  { name: "Gati", label: null, examples: [] },
];

const raw = (p: Partial<LrRawReading> = {}): LrRawReading => ({
  lrNo: null,
  lrLabelSeen: null,
  transporter: null,
  lrDate: null,
  destination: null,
  packages: null,
  freightTerm: null,
  freightRupees: null,
  confidence: "high",
  ...p,
});

test("a number's shape is digits and letters, punctuation kept", () => {
  assert.equal(lrShape("mum/45120"), "AAA/99999");
  assert.equal(lrShape(" 1048821 "), "9999999");
});

test("a number fits its transporter's style, and a serial one digit longer still does", () => {
  assert.equal(fitsStyle("1049001", DIR[0].examples), true);
  assert.equal(fitsStyle("10490012", DIR[0].examples), true, "999999 → 1000000 is the same book");
  assert.equal(fitsStyle("27AAPFU0939F1ZV", DIR[0].examples), false, "a GSTIN is not a GR number");
  assert.equal(fitsStyle("MUM/46001", DIR[1].examples), true);
  assert.equal(fitsStyle("46001", DIR[1].examples), false);
  assert.equal(fitsStyle("123", []), null, "no history says nothing either way");
});

test("the transporter is the directory's name, not the receipt's letterhead", () => {
  assert.equal(matchTransporter("SHREE MARUTI COURIER SERVICES PVT LTD", DIR)?.name, "Shree Maruti Courier");
  assert.equal(matchTransporter("vrl logistics", DIR)?.name, "VRL Logistics");
  assert.equal(matchTransporter("Blue Dart", DIR), null);
  assert.equal(matchTransporter("", DIR), null);
});

test("a label read along with the number is stripped", () => {
  assert.equal(cleanLrNo("G.R. No. 1048821"), "1048821");
  assert.equal(cleanLrNo("LR No: MUM/45120"), "MUM/45120");
  assert.equal(cleanLrNo("No. 10 48 821"), "1048821");
  assert.equal(cleanLrNo("ORIGINAL"), null, "a word with no digit is not a number");
  assert.equal(cleanLrNo(null), null);
});

test("freight terms are read however the receipt prints them", () => {
  assert.equal(freightTermOf("TO-PAY"), "To pay");
  assert.equal(freightTermOf("To Be Billed"), "TBB");
  assert.equal(freightTermOf("PAID"), "Paid");
  assert.equal(freightTermOf("FOC"), null);
});

test("a reading in the transporter's style is offered as it is", () => {
  const s = cleanLrReading(raw({ lrNo: "GR No 1049001", transporter: "Shree Maruti Courier Services", lrDate: "2026-10-09", freightTerm: "To Pay", packages: 12, destination: " Nagpur " }), DIR, "2026-10-11");
  assert.equal(s.lrNo, "1049001");
  assert.equal(s.transporter, "Shree Maruti Courier");
  assert.equal(s.lrDate, "2026-10-09");
  assert.equal(s.freightTerm, "To pay");
  assert.equal(s.packages, 12);
  assert.equal(s.destination, "Nagpur");
  assert.equal(s.checkNumber, false);
  assert.deepEqual(s.notes, []);
});

test("a number off the transporter's style is offered and marked to check", () => {
  const s = cleanLrReading(raw({ lrNo: "9850220231", transporter: "VRL Logistics" }), DIR, "2026-10-11");
  assert.equal(s.lrNo, "9850220231");
  assert.equal(s.checkNumber, true);
  assert.match(s.notes[0], /does not look like VRL Logistics/);
});

test("an unsure reading is marked even where the style fits", () => {
  const s = cleanLrReading(raw({ lrNo: "1049001", transporter: "Shree Maruti Courier", confidence: "check" }), DIR, "2026-10-11");
  assert.equal(s.checkNumber, true);
});

test("a date in the future or months old is not filled in", () => {
  assert.equal(cleanLrReading(raw({ lrDate: "2026-10-12" }), DIR, "2026-10-11").lrDate, null);
  assert.equal(cleanLrReading(raw({ lrDate: "2025-10-11" }), DIR, "2026-10-11").lrDate, null);
  assert.equal(cleanLrReading(raw({ lrDate: "2026-02-30" }), DIR, "2026-10-11").lrDate, null);
});

test("an unknown transporter is not offered — it is said, and the list is not added to", () => {
  const s = cleanLrReading(raw({ transporter: "Blue Dart", lrNo: "7781" }), DIR, "2026-10-11");
  assert.equal(s.transporter, null);
  assert.ok(s.notes.some((n) => n.includes('"Blue Dart"') && n.includes("not on the transporter list")));
});

test("a typed transporter is the listed one only where it is the same name", () => {
  const names = ["Great India Roadways", "VRL Logistics", "Shree Maruti Courier"];
  assert.deepEqual(listedTransporter("  great   india roadways ", names), { name: "Great India Roadways", near: null });
  assert.deepEqual(listedTransporter("The Great India Roadways Pvt. Ltd.", names), { name: "Great India Roadways", near: null });
  assert.deepEqual(listedTransporter("M/s VRL Logistics", names), { name: "VRL Logistics", near: null });
  /* Close is a suggestion, never an answer. */
  assert.equal(listedTransporter("Great India Roadway", names).name, null);
  assert.equal(listedTransporter("Great India Roadway", names).near, "Great India Roadways");
  assert.deepEqual(listedTransporter("Blue Dart", names), { name: null, near: null });
});

test("nonsense figures are dropped", () => {
  const s = cleanLrReading(raw({ packages: -3, freightRupees: 0 }), DIR, "2026-10-11");
  assert.equal(s.packages, null);
  assert.equal(s.freightRupees, null);
});

test("the style line names the label and the examples", () => {
  assert.equal(styleLine(DIR[0]), '- Shree Maruti Courier — calls it "GR Number"; earlier numbers: 1048821, 1048830, 1048902');
  assert.equal(styleLine(DIR[2]), "- Gati");
});
