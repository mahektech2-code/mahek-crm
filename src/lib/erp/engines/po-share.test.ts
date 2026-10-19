import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { defaultPoMessage, itemsLine, poRecipients, readShare, waMeLink, withLink, MAX_SHARE_TARGETS } from "./po-share";
import { poPdfFilename, renderPoPdf } from "../po-pdf";

const people = poRecipients({
  vendor: "Vendor B",
  vendorPhone: "098200 11004",
  vendorEmail: "orders@vendor-b.test",
  godown: "Bhiwandi",
  godownPhone: "022 2345 6789",
  godownEmail: null,
});

describe("who a PO can go to", () => {
  test("the vendor is ticked with its WhatsApp number; the godown is offered", () => {
    assert.deepEqual(
      people.map((p) => [p.key, p.whatsapp, p.email, p.checked]),
      [
        ["vendor", "919820011004", "orders@vendor-b.test", true],
        ["godown", null, null, false],
      ],
      "a landline is not a WhatsApp number",
    );
  });
});

describe("reading a share", () => {
  test("WhatsApp to the vendor and a typed number", () => {
    const r = readShare({ channel: "whatsapp", to: '["vendor"]', extra: "97000 11182", message: "Hello" }, people);
    assert.ok(r.ok);
    assert.deepEqual(r.value.targets, [
      { recipient: "Vendor B", address: "919820011004" },
      { recipient: "97000 11182", address: "919700011182" },
    ]);
  });

  test("a ticked party with no number is refused by name, never dropped", () => {
    const r = readShare({ channel: "whatsapp", to: '["godown"]', message: "Hello" }, people);
    assert.ok(!r.ok);
    assert.match(r.error, /Godown — Bhiwandi has no WhatsApp number/);
  });

  test("a typed entry the channel cannot use is refused", () => {
    const wa = readShare({ channel: "whatsapp", to: "[]", extra: "someone@x.test", message: "Hi" }, people);
    assert.ok(!wa.ok && wa.field === "extra");
    const em = readShare({ channel: "email", to: "[]", extra: "9820011004", message: "Hi" }, people);
    assert.ok(!em.ok && em.field === "extra");
  });

  test("the same address twice is one message", () => {
    const r = readShare({ channel: "email", to: '["vendor"]', extra: "ORDERS@vendor-b.test, a@b.test", message: "Hi" }, people);
    assert.ok(r.ok);
    assert.deepEqual(r.value.targets.map((t) => t.address), ["orders@vendor-b.test", "a@b.test"]);
  });

  test("nobody, no message, and too many are refused; a link needs nobody", () => {
    assert.ok(!readShare({ channel: "email", to: "[]", message: "Hi" }, people).ok);
    assert.ok(!readShare({ channel: "email", to: '["vendor"]', message: " " }, people).ok);
    const many = Array.from({ length: MAX_SHARE_TARGETS + 1 }, (_, i) => `p${i}@x.test`).join(",");
    assert.ok(!readShare({ channel: "email", to: "[]", extra: many, message: "Hi" }, people).ok);
    assert.ok(!readShare({ channel: "fax", message: "Hi" }, people).ok);
    const link = readShare({ channel: "link", message: "" }, people);
    assert.ok(link.ok && link.value.targets.length === 0);
  });
});

describe("the message", () => {
  test("names the items, the total and the delivery; the link goes under it", () => {
    const items = itemsLine([
      { item: "MEK", quantity: 800, unit: "Litre" },
      { item: "IPA", quantity: 400, unit: "Litre" },
    ]);
    assert.equal(items, "MEK (800 Litre) and IPA (400 Litre)");
    assert.equal(itemsLine([1, 2, 3, 4, 5].map((n) => ({ item: `I${n}`, quantity: n, unit: "Pcs" }))), "I1 (1 Pcs), I2 (2 Pcs) and 3 more items");
    const m = defaultPoMessage({ vendor: "Vendor B", name: "PO-411", items, total: "Rs. 2,10,500", deliverTo: "Bhiwandi", deliveryBy: "22 Oct 2026", company: "Mahek Marketing India" });
    assert.match(m, /purchase order PO-411 for MEK \(800 Litre\) and IPA \(400 Litre\), total Rs\. 2,10,500, delivery to our Bhiwandi godown by 22 Oct 2026/);
    assert.equal(withLink(m, "https://x.test/po/abc"), `${m}\n\nPurchase order (PDF): https://x.test/po/abc`);
    assert.equal(waMeLink("919820011004", "a b"), "https://wa.me/919820011004?text=a%20b");
  });
});

describe("the PDF", () => {
  test("draws a PO of many lines, with ₹ and names the font cannot encode", async () => {
    const bytes = await renderPoPdf({
      name: "PO-411",
      date: "18 Oct 2026",
      company: "Mahek Marketing India",
      vendor: { name: "Vendor “B” ₹", phone: "+91 98200 11004", email: "orders@vendor-b.test" },
      deliverTo: "Bhiwandi",
      deliveryBy: "22 Oct 2026",
      paymentTerms: "30 days",
      freightPaise: 150000,
      remarks: "Deliver before noon. टेस्ट",
      lines: Array.from({ length: 40 }, (_, i) => ({ item: `Item ${i + 1} with a rather long name that has to wrap onto a second line`, quantity: 10 + i, unit: "Litre", ratePaise: 12345, gstBp: 1800 })),
      approvedBy: "Deepa",
      approvedOn: "18 Oct 2026",
    });
    const doc = await PDFDocument.load(bytes);
    assert.ok(doc.getPageCount() >= 2, "forty lines run onto a second page");
    assert.equal(doc.getTitle(), "PO-411 — Vendor “B” Rs. ", "₹ becomes Rs.; what Helvetica can draw is kept");
    const again = await renderPoPdf({ name: "PO-1", date: "1 Oct 2026", company: "M", vendor: { name: "V", phone: null, email: null }, deliverTo: "G", deliveryBy: "2 Oct 2026", paymentTerms: "Advance", freightPaise: 0, remarks: null, lines: [], approvedBy: null, approvedOn: null });
    assert.ok(again.length > 500);
    assert.equal(poPdfFilename("PO-411"), "PO-411.pdf");
    assert.equal(poPdfFilename("QM/24 25"), "QM-24-25.pdf");
  });
});
