import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { leadScanReadingSchema } from "../lead-scan-schema";
import type { LeadScanResult } from "./lead-scan";
import {
  agreement,
  compareLeadScans,
  readDate,
  readRupeesToPaise,
  scoreBill,
  summariseTrials,
  toSarvamSchema,
  type TrialRow,
} from "./read-trial";

const scan = (over: Partial<LeadScanResult>): LeadScanResult => ({
  businessName: null,
  contactPerson: null,
  mobile: null,
  otherNumbers: [],
  city: null,
  state: null,
  address: null,
  gstin: null,
  gstinCheck: null,
  note: null,
  ...over,
});

test("case, spacing and punctuation are not a disagreement", () => {
  assert.equal(agreement("SHRI GANESH PAINTS.", "Shri Ganesh  Paints"), "same");
  assert.equal(agreement("Shri Ganesh Paints", "Ganesh Hardware"), "differs");
  assert.equal(agreement("Patil", null), "only_openai");
  assert.equal(agreement("  ", "Patil"), "only_sarvam");
  assert.equal(agreement(null, null), "neither");
});

test("a lead scan comparison holds verdicts and checksums, never a value read", () => {
  const out = compareLeadScans(
    scan({ businessName: "Shyam Traders", mobile: "9820011001", gstin: "27AAPFU0939F1ZV", gstinCheck: "valid" }),
    scan({ businessName: "SHYAM TRADERS", mobile: "9820011002", city: "Pune" }),
  );
  assert.deepEqual(out, {
    businessName: "same",
    contactPerson: "neither",
    mobile: "differs",
    city: "only_sarvam",
    address: "neither",
    gstin: "only_openai",
    gstinCheck_openai: "valid",
    gstinCheck_sarvam: "none",
  });
  for (const v of Object.values(out)) assert.ok(!/\d|Shyam|Pune/i.test(v), `"${v}" is a value, not a verdict`);
});

test("a bill is scored against what the salesman typed beside it", () => {
  const typed = { amountPaise: 125_000, billNumber: "INV/0042", billDate: "2026-11-20" };
  assert.deepEqual(scoreBill(typed, { amountPaise: 125_050, billNumber: "inv-0042", billDate: "2026-11-20" }), {
    amount: "right",
    billNumber: "right",
    billDate: "right",
  });
  assert.deepEqual(scoreBill(typed, { amountPaise: 152_000, billNumber: "INV 42", billDate: null }), {
    amount: "wrong",
    billNumber: "wrong",
    billDate: "missed",
  });
  assert.deepEqual(scoreBill({ amountPaise: 50_000, billNumber: null, billDate: null }, { amountPaise: null, billNumber: "7", billDate: "2026-01-01" }), {
    amount: "missed",
    billNumber: "untyped",
    billDate: "untyped",
  });
});

test("rupees and dates as a reader returns them", () => {
  assert.equal(readRupeesToPaise("₹ 1,250.50"), 125_050);
  assert.equal(readRupeesToPaise(830), 83_000);
  assert.equal(readRupeesToPaise("Rs. 99"), 9_900);
  assert.equal(readRupeesToPaise("about two hundred"), null);
  assert.equal(readRupeesToPaise(0), null);
  assert.equal(readDate("2026-11-05"), "2026-11-05");
  assert.equal(readDate("05/11/2026"), "2026-11-05", "day first, as Indian bills are printed");
  assert.equal(readDate("5.11.26"), "2026-11-05");
  assert.equal(readDate("31/13/2026"), null);
  assert.equal(readDate(null), null);
});

test("the summary counts each provider's verdicts and its middle time", () => {
  const rows: TrialRow[] = [
    { feature: "expense_bill", provider: "sarvam", ok: true, ms: 9000, fields: { amount: "right" } },
    { feature: "expense_bill", provider: "sarvam", ok: true, ms: 3000, fields: { amount: "wrong" } },
    { feature: "expense_bill", provider: "sarvam", ok: false, ms: 500, fields: {} },
    { feature: "expense_bill", provider: "openai", ok: true, ms: 4000, fields: { amount: "right" } },
    { feature: "lead_scan", provider: "openai", ok: true, ms: 1, fields: {} },
  ];
  const [openai, sarvam] = summariseTrials(rows, "expense_bill");
  assert.equal(openai.provider, "openai");
  assert.deepEqual(openai.fields, { amount: { right: 1 } });
  assert.equal(sarvam.reads, 3);
  assert.equal(sarvam.failed, 1);
  assert.equal(sarvam.medianMs, 3000, "a failed read's time is not a reading time");
  assert.deepEqual(sarvam.fields.amount, { right: 1, wrong: 1 });
});

test("the lead scan's own schema converts to what Sarvam accepts", () => {
  const s = toSarvamSchema(z.toJSONSchema(leadScanReadingSchema) as Record<string, unknown>);
  const props = s.properties as Record<string, Record<string, unknown>>;
  assert.equal(s.type, "object");
  assert.equal(props.businessName.type, "string", "nullable becomes its plain type");
  assert.match(String(props.gstin.description), /15-character/, "descriptions guide Sarvam too");
  const phone = (props.phones.items as Record<string, unknown>).properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(phone.kind.enum, ["mobile", "landline", "unknown"]);
  assert.ok(!JSON.stringify(s).includes("anyOf") && !JSON.stringify(s).includes("required"));
});
