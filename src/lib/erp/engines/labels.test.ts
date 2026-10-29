import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  boldLines,
  boldWidthEm,
  boxFoot,
  boxNameFit,
  copiesOf,
  fitPt,
  labelDate,
  labelNumber,
  LABEL_MM,
  lotSize,
  MAX_COPIES,
  orderQty,
  packSizePt,
  partyPt,
  pieceQty,
  printRuns,
  productLine,
  shortRef,
} from "./labels";

describe("what a label says", () => {
  it("the four labels are two sizes of stock", () => {
    assert.deepEqual(LABEL_MM, { box: 50, sfg: 80, purchase: 80, dispatch: 80 });
  });

  it("a date is written out, day first, with the day two digits wide", () => {
    assert.equal(labelDate("2026-10-08"), "08 Oct 2026");
    assert.equal(labelDate("2026-07-10T04:00:00Z"), "10 Jul 2026");
    assert.equal(labelDate(null), "");
    assert.equal(labelDate("yesterday"), "yesterday");
  });

  it("a figure is written as a person would write it on a drum", () => {
    assert.equal(labelNumber(205), "205");
    assert.equal(labelNumber(0.84), "0.84");
    assert.equal(labelNumber(1250.5), "1250.5");
    assert.equal(labelNumber(3.14159), "3.14");
    assert.equal(labelNumber(null), "—");
  });

  it("the box label does not say MAHEK twice", () => {
    assert.equal(productLine("Mahek Universal Thinner"), "Universal Thinner");
    assert.equal(productLine("  mahek   Enamel Thinner "), "Enamel Thinner");
    assert.equal(productLine("Melody Green Thinner"), "Melody Green Thinner");
    /* A product that is only the company's name keeps it. */
    assert.equal(productLine("Mahek"), "Mahek");
  });

  it("an order line's id is shortened to its own first eight characters", () => {
    assert.equal(shortRef("ord_a300fe0011223344"), "A300FE00");
    assert.equal(shortRef("A300FE"), "A300FE");
  });

  it("an order is counted in cans, or in drums on a drum line", () => {
    assert.equal(orderQty("Box", 12), "12 cans");
    assert.equal(orderQty("Can", 1), "1 can");
    assert.equal(pieceQty("Box", 60, 15), 4, "a sticker on a box of four says four cans, not the order's sixty");
    assert.equal(pieceQty("Can", 7, 0), 1, "one sticker a can on a loose line");
    assert.equal(pieceQty("Drum", 3, 0), 1);
    assert.equal(orderQty("Drum", 2), "2 drums");
  });

  it("the lot size is every label on the order", () => {
    /* The sample order in the label sheet: five lines, labels 1, 1, 2, 1, 1. */
    assert.equal(lotSize([{ labels: 1 }, { labels: 1 }, { labels: 2 }, { labels: 1 }, { labels: 1 }]), 6);
    assert.equal(lotSize([]), 0);
  });

  it("copies are at least one and never a roll's worth by accident", () => {
    assert.equal(copiesOf("3", 1), 3);
    assert.equal(copiesOf("", 4), 4);
    assert.equal(copiesOf("0", 4), 4);
    assert.equal(copiesOf("-2", 1), 1);
    assert.equal(copiesOf("abc", 2), 2);
    assert.equal(copiesOf("5000", 1), MAX_COPIES);
    assert.equal(copiesOf(undefined, 0), 1);
  });
});

describe("fitting words to a label", () => {
  it("measures bold text by its own character widths", () => {
    /* Helvetica Bold: U 722, n 611, i 278, v 556, e 556, r 389, s 556, a 556, l 278. */
    assert.equal(Math.round(boldWidthEm("Universal") * 1000), 4502);
    assert.ok(boldWidthEm("WWW") > boldWidthEm("iii") * 3);
  });

  it("breaks only between words", () => {
    assert.equal(boldLines("Mahek Universal", 20, 44), 2);
    assert.equal(boldLines("Mahek Universal", 12, 44), 1);
  });

  it("takes the largest size that fits, and the smallest when none does", () => {
    assert.equal(fitPt("1 L", 17, [27, 24, 21]), 27);
    assert.equal(fitPt("A very long line that fits nowhere at all", 17, [27, 24, 21]), 21);
  });

  it("the pack size is as large as its 17 mm allows", () => {
    assert.equal(packSizePt("1 L"), 27);
    assert.ok(packSizePt("20 L") < 27);
    assert.ok(packSizePt("500 ml") < packSizePt("20 L"));
    assert.ok(packSizePt("500 ml") >= 13);
  });

  it("the approved sample keeps its approved size", () => {
    assert.deepEqual(boxNameFit("Universal Thinner"), { pt: 14, lines: 1 });
  });

  it("a long product name takes two smaller lines instead of losing its end", () => {
    const fit = boxNameFit("Melody Green Thinner Tin Can");
    assert.equal(fit.lines, 2);
    assert.ok(fit.pt <= 10);
  });

  it("a long party name steps down before it is cut, beside the sticker's QR", () => {
    assert.equal(partyPt("SHREE SHANTI JAIN STORES"), 15);
    assert.ok(partyPt("SHREE MAHAVIR PAINTS AND HARDWARE STORES") < 15);
  });

  it("the box label's last line says 'Box 1 of 5' while it fits", () => {
    const sample = { lotWord: "Batch", lot: "FP2AM", unitWord: "Box", seq: 1, of: 5, date: "2026-10-08" };
    assert.deepEqual(boxFoot(sample), { position: "Box 1 of 5", pt: 6 });
    assert.deepEqual(boxFoot({ ...sample, lot: "FP40NA", seq: 12, of: 40 }), { position: "Box 12 of 40", pt: 6 });
  });

  it("and steps down, then shortens, for a long batch", () => {
    const long = boxFoot({ lotWord: "Batch", lot: "FP120AM", unitWord: "Box", seq: 118, of: 120, date: "2026-10-09" });
    assert.deepEqual(long, { position: "Box 118 of 120", pt: 5.5 });
    const longer = boxFoot({ lotWord: "Batch", lot: "FP1200AMXX", unitWord: "Box", seq: 1180, of: 1200, date: "2026-10-09" });
    assert.equal(longer.position, "Box 1180/1200");
  });

  it("a loose unit has no 'of'", () => {
    assert.deepEqual(boxFoot({ lotWord: "Lot", lot: "FG12NA", unitWord: "Unit", seq: 3, of: null, date: null }), { position: "Unit 3", pt: 6 });
  });
});

describe("print runs", () => {
  it("the same label several times over is one label and a count", () => {
    const runs = printRuns(["a", "a", "b", "a", "a", "a"], (x) => x);
    assert.deepEqual(runs, [
      { item: "a", copies: 2 },
      { item: "b", copies: 1 },
      { item: "a", copies: 3 },
    ]);
  });

  it("every box label is its own run", () => {
    assert.equal(printRuns(["BX-1", "BX-2", "BX-3"], (x) => x).length, 3);
    assert.deepEqual(printRuns([], (x: string) => x), []);
  });
});
