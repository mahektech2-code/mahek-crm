import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { customerSchema, customerToRecipient, formatPhone, normalizePhone, RESERVED_CUSTOMER_IDS, selectProduct, type Customer } from "./customer";
import { customerRef, leadRef, recipientRefSchema } from "./recipient";

const valid = {
  id: "cu-test",
  company: "Test Paints",
  contact: "Asha Rao",
  phone: "+91 00000 00001",
  city: "Pune",
  state: "Maharashtra",
  products: [
    { id: "M1433", code: "M1433", name: "M1433 Thinner" },
    { id: "M2210", code: "M2210", name: "M2210 Epoxy Primer" },
  ],
};
const parse = (patch: Record<string, unknown> = {}) => customerSchema.parse({ ...valid, ...patch });

describe("customer schema", () => {
  test("a valid customer parses and the phone is stored normalised", () => {
    const c = parse();
    assert.equal(c.phone, "+910000000001");
    assert.equal(c.products.length, 2);
  });
  test("every required field is required", () => {
    for (const key of ["id", "company", "city", "state", "products"]) {
      const { [key]: _omit, ...rest } = valid as Record<string, unknown>;
      void _omit;
      assert.throws(() => customerSchema.parse(rest), /[\s\S]/, key);
    }
  });
  test("contact and phone are optional and may be null or missing; blanks become null", () => {
    assert.equal(parse({ contact: null }).contact, null);
    assert.equal(parse({ contact: "   " }).contact, null);
    assert.equal(parse({ phone: null }).phone, null);
    assert.equal(parse({ phone: "  " }).phone, null);
    const { contact: _c, phone: _p, ...rest } = valid;
    void _c;
    void _p;
    const c = customerSchema.parse(rest);
    assert.equal(c.contact, null);
    assert.equal(c.phone, null);
  });
  test("text is normalised (whitespace, NFC) and ZWJ/ZWNJ are kept", () => {
    assert.equal(parse({ company: "  Test \n  Paints  " }).company, "Test Paints");
    assert.equal(parse({ company: "क्‍ष" }).company, "क्‍ष");
  });
  test("an unknown property is rejected, so a source cannot leak extra fields (the allow-list)", () => {
    for (const extra of ["ownerId", "ownerName", "orders", "creditLimit", "notes", "email", "status"]) {
      assert.throws(() => customerSchema.parse({ ...valid, [extra]: "x" }), /[\s\S]/, extra);
    }
  });
  test("products: zero, one and many are valid; duplicate codes are not; there is no cap", () => {
    assert.equal(parse({ products: [] }).products.length, 0);
    assert.equal(parse({ products: [valid.products[0]] }).products.length, 1);
    const many = Array.from({ length: 300 }, (_, i) => ({ id: `P${i}`, code: `P${i}`, name: `Product ${i}` }));
    assert.equal(parse({ products: many }).products.length, 300);
    assert.throws(() => parse({ products: [valid.products[0], valid.products[0]] }), /duplicate product code/);
  });
  test("ids are opaque: no spaces, e-mail characters or phone-like numbers, and not a route word", () => {
    for (const bad of ["", "a b", "x@y.com", "+919000000000", "9000000000", "Ramesh Gokhale", "a".repeat(101)]) {
      assert.throws(() => parse({ id: bad }), /[\s\S]/, `id ${JSON.stringify(bad)}`);
    }
    for (const word of RESERVED_CUSTOMER_IDS) assert.throws(() => parse({ id: word }));
    assert.throws(() => parse({ id: "Generated" }));
    assert.doesNotThrow(() => parse({ id: "cu1" }));
    assert.doesNotThrow(() => parse({ id: "123456" }), "short digit ids are fine");
  });
  test("company, city and state have length limits", () => {
    assert.throws(() => parse({ company: "x".repeat(201) }));
    assert.throws(() => parse({ city: "x".repeat(101) }));
    assert.throws(() => parse({ state: "" }));
  });
});

describe("phone", () => {
  test("normalisation removes spaces, dashes, dots and brackets and keeps a leading +", () => {
    assert.equal(normalizePhone("+91 98765-43210"), "+919876543210");
    assert.equal(normalizePhone("(022) 2345.6789"), "02223456789");
    assert.equal(normalizePhone(null), null);
    assert.equal(normalizePhone(""), null);
  });
  test("invalid numbers are rejected", () => {
    for (const bad of ["12345", "abc", "+91 98765 4321O", "1234567890123456", "98-7"]) assert.throws(() => normalizePhone(bad), /[\s\S]/, bad);
  });
  test("an Indian mobile is shown in two groups; anything else is shown as stored", () => {
    assert.equal(formatPhone("+919876543210"), "+91 98765 43210");
    assert.equal(formatPhone("02223456789"), "02223456789");
  });
});

describe("selecting a product", () => {
  const c = parse() as Customer;
  test("no code selects the first product", () => {
    assert.deepEqual(selectProduct(c, undefined), { ok: true, product: c.products[0] });
  });
  test("a code selects that product", () => {
    assert.deepEqual(selectProduct(c, "M2210"), { ok: true, product: c.products[1] });
  });
  test("a code that is not one of this customer's products is refused", () => {
    assert.deepEqual(selectProduct(c, "M9999"), { ok: false });
  });
  test("a customer with no products selects none, and any code is refused", () => {
    const none = parse({ products: [] });
    assert.deepEqual(selectProduct(none, undefined), { ok: true, product: null });
    assert.deepEqual(selectProduct(none, "M1433"), { ok: false });
  });
});

describe("recipient projection", () => {
  test("a customer projects to exactly the five facts a creative can use, and never the phone", () => {
    const c = parse();
    const r = customerToRecipient(c, c.products[1]);
    assert.deepEqual(Object.keys(r).sort(), ["city", "company", "contact", "product", "state"]);
    assert.equal(r.product?.code, "M2210");
    assert.ok(!JSON.stringify(r).includes("00000"));
  });
  test("recipient references name a kind and an id", () => {
    assert.deepEqual(leadRef("l1"), { kind: "lead", id: "l1" });
    assert.deepEqual(customerRef("cu1"), { kind: "customer", id: "cu1" });
    assert.equal(recipientRefSchema.safeParse({ kind: "supplier", id: "x" }).success, false);
    assert.equal(recipientRefSchema.safeParse({ kind: "lead", id: "" }).success, false);
  });
});
