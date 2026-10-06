import test from "node:test";
import assert from "node:assert/strict";
import {
  contactRoleLabel,
  emailProblem,
  last10,
  mirrorsFrom,
  normalisePhone,
  sortContacts,
  whatsappNumberFor,
  type ContactLike,
} from "./customer-contacts";

const c = (over: Partial<ContactLike> & { id: string; phone: string }): ContactLike => ({
  name: null,
  role: "other",
  isPrimary: false,
  forWhatsapp: false,
  forPaymentReminders: false,
  sortOrder: 0,
  ...over,
});

test("a mobile is stored as ten digits whatever was typed around it", () => {
  for (const typed of ["9820011001", "+91 98200 11001", "919820011001", "098200-11001"]) {
    const n = normalisePhone(typed);
    assert.ok(n.ok && n.mobile && n.phone === "9820011001", typed);
  }
});

test("a landline with its STD code is a number, but not a mobile", () => {
  const n = normalisePhone("022 2345 6789");
  assert.ok(n.ok);
  assert.equal(n.ok && n.mobile, false);
});

test("too short is refused with a reason rather than guessed at", () => {
  const n = normalisePhone("12345");
  assert.equal(n.ok, false);
  assert.equal(normalisePhone("").ok, false);
});

test("numbers are compared on their last ten digits", () => {
  assert.equal(last10("+91 98200 11001"), last10("9820011001"));
});

test("an email is checked only when one was typed", () => {
  assert.equal(emailProblem(""), null);
  assert.equal(emailProblem("accounts@shop.in"), null);
  assert.ok(emailProblem("accounts@shop"));
});

test("an unknown role code is shown as itself, never hidden", () => {
  assert.equal(contactRoleLabel("accounts"), "Accounts & payments");
  assert.equal(contactRoleLabel("godown"), "godown");
});

test("the primary contact sorts first", () => {
  const sorted = sortContacts([
    c({ id: "a", phone: "9000000001", sortOrder: 0 }),
    c({ id: "b", phone: "9000000002", sortOrder: 1, isPrimary: true }),
  ]);
  assert.equal(sorted[0].id, "b");
});

test("the mirrors are the designated contacts, and an undesignated slot is null", () => {
  const m = mirrorsFrom([
    c({ id: "owner", phone: "9000000001", name: "Ramesh", isPrimary: true }),
    c({ id: "acct", phone: "9000000002", forPaymentReminders: true, sortOrder: 1 }),
  ]);
  assert.equal(m.phone, "9000000001");
  assert.equal(m.contactPerson, "Ramesh");
  assert.equal(m.whatsappPhone, null);
  assert.equal(m.paymentWhatsappPhone, "9000000002");
  assert.equal(m.altPhone, "9000000002");
});

test("a list with no primary leaves the phone column alone — it is NOT NULL", () => {
  const m = mirrorsFrom([]);
  assert.equal(m.phone, undefined);
  assert.equal(m.contactPerson, undefined);
});

test("a payment reminder goes to the payment number, then WhatsApp, then the phone", () => {
  const all = { phone: "9000000001", whatsappPhone: "9000000002", paymentWhatsappPhone: "9000000003" };
  assert.equal(whatsappNumberFor(all, "payment"), "9000000003");
  assert.equal(whatsappNumberFor(all, "general"), "9000000002");
  assert.equal(whatsappNumberFor({ ...all, paymentWhatsappPhone: null }, "payment"), "9000000002");
  assert.equal(whatsappNumberFor({ phone: "9000000001", whatsappPhone: null }, "payment"), "9000000001");
});

test("an order message never borrows the payment number", () => {
  assert.equal(
    whatsappNumberFor({ phone: "9000000001", whatsappPhone: null, paymentWhatsappPhone: "9000000003" }, "general"),
    "9000000001",
  );
});
