import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { absolutePage, isEncrypted, layoutText, pageRanges, prepareStatement, StatementLocked } from "./bank-statement-pdf";

/* Bank PDFs: a PDF that opens without a password is never asked for one, and
 * a long one is read a few pages at a time. The two encrypted fixtures were
 * made with pypdf: one with an owner password only (as most banks send), one
 * with the user password "secret". */

const fixture = (n: string) => new Uint8Array(readFileSync(join(__dirname, "__fixtures__", "bank-pdf", n)));

async function plainPdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) doc.addPage().drawText(`Page ${i} 01-10-2026 NEFT 10.00 990.00`, { x: 40, y: 700, size: 9, font });
  return doc.save();
}

test("an owner-password PDF opens with no password and goes as text", async () => {
  const bytes = fixture("owner-only.pdf");
  assert.equal(isEncrypted(bytes), true);
  const r = await prepareStatement(bytes, "s.pdf", null);
  assert.equal(r.pages, 2);
  assert.equal(r.mode, "text");
  const piece = await r.pieceFor(r.ranges[0]);
  const text = (piece.content[0] as { text: string }).text;
  assert.match(text, /--- Page 2 ---/);
  assert.match(text, /NEFT\/P1L0\s+10\.00\s+990\.00/);
});

test("a password typed for a PDF that needs none is not used", async () => {
  assert.equal((await prepareStatement(fixture("owner-only.pdf"), "s.pdf", "wrong")).pages, 2);
  assert.equal((await prepareStatement(await plainPdf(1), "s.pdf", "wrong")).mode, "whole");
});

test("a PDF that will not open asks for its password, and says when it is wrong", async () => {
  const bytes = fixture("user-locked.pdf");
  await assert.rejects(prepareStatement(bytes, "s.pdf", null), (e) => e instanceof StatementLocked && !e.wrongPassword);
  await assert.rejects(prepareStatement(bytes, "s.pdf", "nope"), (e) => e instanceof StatementLocked && e.wrongPassword);
  const r = await prepareStatement(bytes, "s.pdf", "secret");
  assert.equal(r.pages, 2);
  assert.equal(r.mode, "text");
});

test("a long plain PDF is split into pieces of a few pages, each its own PDF", async () => {
  const r = await prepareStatement(await plainPdf(42), "s.pdf", null);
  assert.equal(r.mode, "split");
  assert.equal(r.ranges.length, 11);
  const piece = await r.pieceFor(r.ranges[10]);
  const file = piece.content[1] as { data: Uint8Array; filename: string };
  assert.equal(file.filename, "s-p41-42.pdf");
  assert.equal((await PDFDocument.load(file.data)).getPageCount(), 2);
});

test("page ranges and page numbers", () => {
  assert.deepEqual(pageRanges(9, 4), [{ from: 1, to: 4 }, { from: 5, to: 8 }, { from: 9, to: 9 }]);
  assert.equal(absolutePage(6, 5, 8), 6);
  assert.equal(absolutePage(2, 5, 8), 6);
  assert.equal(absolutePage(null, 9, 9), 9);
  assert.equal(absolutePage(30, 5, 8), null);
});

test("layout keeps columns apart", () => {
  const t = layoutText([
    { str: "01-10", x: 40, y: 700, w: 25, h: 8 },
    { str: "10.00", x: 400, y: 700, w: 25, h: 8 },
    { str: "02-10", x: 40, y: 680, w: 25, h: 8 },
    { str: "5.00", x: 460, y: 680.5, w: 20, h: 8 },
  ]).split("\n");
  assert.equal(t.length, 2);
  assert.ok(t[1].indexOf("5.00") > t[0].indexOf("10.00"));
});
