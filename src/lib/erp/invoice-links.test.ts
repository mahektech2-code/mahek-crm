import { test } from "node:test";
import assert from "node:assert/strict";
import { erpInvoicesPdfHref, INVOICE_COPIES_MAX, invoiceCopies } from "./trace-links";

test("one copy unless somebody asks for more, and never more than the ceiling", () => {
  assert.equal(invoiceCopies(undefined), 1);
  assert.equal(invoiceCopies(""), 1);
  assert.equal(invoiceCopies("0"), 1);
  assert.equal(invoiceCopies("-3"), 1);
  assert.equal(invoiceCopies("abc"), 1);
  assert.equal(invoiceCopies("3"), 3);
  assert.equal(invoiceCopies("2.9"), 2);
  assert.equal(invoiceCopies(999), INVOICE_COPIES_MAX);
});

test("the viewer reads the orders' invoices from one address", () => {
  assert.equal(erpInvoicesPdfHref([10082]), "/api/erp/invoices?orders=10082");
  assert.equal(erpInvoicesPdfHref([10082, 10080]), "/api/erp/invoices?orders=10082%2C10080");
});
