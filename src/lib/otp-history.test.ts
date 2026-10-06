import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OTP_STATUSES,
  OTP_STATUS_LABELS,
  deliveryChannel,
  deviceOf,
  labelOf,
  numberForReading,
  otpStatus,
  OTP_REFUSAL_LABELS,
} from "./otp-history";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const base = {
  refusedReason: null,
  sentAt: "2026-10-06T11:55:00Z",
  consumedAt: null,
  expiresAt: "2026-10-06T12:05:00Z",
  attempts: 0,
};

test("a refusal wins over everything, and an unsent code is not delivered", () => {
  assert.equal(otpStatus({ ...base, refusedReason: "cooldown", sentAt: null }, 5, NOW), "refused");
  assert.equal(otpStatus({ ...base, sentAt: null }, 5, NOW), "send_failed");
});

test("used, locked, expired and waiting read off the row", () => {
  assert.equal(otpStatus({ ...base, consumedAt: "2026-10-06T11:56:00Z" }, 5, NOW), "verified");
  assert.equal(otpStatus({ ...base, attempts: 5 }, 5, NOW), "locked");
  assert.equal(otpStatus({ ...base, expiresAt: "2026-10-06T11:59:00Z" }, 5, NOW), "expired");
  assert.equal(otpStatus(base, 5, NOW), "waiting");
});

test("a code used on its last try is used, not locked", () => {
  assert.equal(otpStatus({ ...base, attempts: 4, consumedAt: "2026-10-06T11:58:00Z" }, 5, NOW), "verified");
});

test("every status has words, and the SQL CASE names the same statuses in the same order", () => {
  for (const s of OTP_STATUSES) assert.ok(OTP_STATUS_LABELS[s].label);
  const src = readFileSync(join(import.meta.dirname, "services/otp-history-service.ts"), "utf8");
  const caseBlock = src.slice(src.indexOf("const statusSql"), src.indexOf("export type OtpHistoryFilters"));
  const named = [...caseBlock.matchAll(/then '([a-z_]+)'|else '([a-z_]+)'/g)].map((m) => m[1] ?? m[2]);
  assert.deepEqual(named, ["refused", "send_failed", "verified", "locked", "expired", "waiting"]);
  assert.deepEqual([...named].sort(), [...OTP_STATUSES].sort());
});

test("unknown codes are shown as themselves", () => {
  assert.equal(labelOf(OTP_REFUSAL_LABELS, "cooldown"), "Asked again inside the resend cooldown");
  assert.equal(labelOf(OTP_REFUSAL_LABELS, "something_new"), "something_new");
  assert.equal(labelOf(OTP_REFUSAL_LABELS, null), "Not recorded");
});

test("numbers read whole, channel and device read off what was stored", () => {
  assert.equal(numberForReading("919820011001"), "+91 98200 11001");
  assert.equal(numberForReading(""), "—");
  assert.equal(deliveryChannel({ otp_id: "x", channel: "sms" }), "sms");
  assert.equal(deliveryChannel({ otp_id: "x" }), null);
  assert.equal(deviceOf("okhttp/4.9.2"), "MBOS handset");
  assert.equal(deviceOf("Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537"), "Chrome on Windows");
  assert.equal(deviceOf(null), "Not recorded");
});
