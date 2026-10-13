import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dots, packBitmap, qrGrid, rasterFromRgba, tsplCalibrate, tsplJob, type Raster } from "./tspl";

const text = (b: Uint8Array) => Buffer.from(b).toString("latin1");

/** A raster with the given dots burnt: "x,y" pairs. */
function raster(width: number, height: number, burnt: [number, number][]): Raster {
  const d = new Uint8Array(width * height);
  for (const [x, y] of burnt) d[y * width + x] = 1;
  return { width, height, dots: d };
}

describe("TSPL", () => {
  it("a 50 mm label is 400 dots on a 203 dpi printer and 600 on a 300 dpi one", () => {
    assert.equal(dots(50, 8), 400);
    assert.equal(dots(80, 8), 640);
    assert.equal(dots(50, 12), 600);
  });

  it("a set bit is WHITE: an empty label is all ones", () => {
    const { widthBytes, data } = packBitmap(raster(16, 2, []));
    assert.equal(widthBytes, 2);
    assert.deepEqual([...data], [0xff, 0xff, 0xff, 0xff]);
  });

  it("a burnt dot clears its bit, most significant bit first", () => {
    const { data } = packBitmap(raster(16, 2, [[0, 0], [7, 0], [8, 1], [15, 1]]));
    assert.deepEqual([...data], [0b01111110, 0xff, 0xff, 0b01111110]);
  });

  it("a width that is not a whole byte is padded with white", () => {
    const { widthBytes, data } = packBitmap(raster(10, 1, [[9, 0]]));
    assert.equal(widthBytes, 2);
    assert.deepEqual([...data], [0xff, 0b10111111]);
  });

  it("a pixel prints where it is dark, and a transparent one is the label's white", () => {
    const rgba = [
      0, 0, 0, 255, // black
      255, 255, 255, 255, // white
      120, 120, 120, 255, // darker than the threshold
      200, 200, 200, 255, // lighter than it
      0, 0, 0, 0, // transparent
    ];
    assert.deepEqual([...rasterFromRgba(rgba, 5, 1).dots], [1, 0, 1, 0, 0]);
  });

  it("a job says the stock and the setup once, then a picture and a count per label", () => {
    const one = raster(400, 400, [[0, 0]]);
    const job = tsplJob(
      [
        { widthMm: 50, heightMm: 50, raster: one, copies: 1 },
        { widthMm: 50, heightMm: 50, raster: one, copies: 3 },
      ],
      { dotsPerMm: 8, gapMm: 3, direction: 1 },
    );
    const t = text(job);
    assert.ok(t.startsWith("SIZE 50 mm,50 mm\r\nGAP 3 mm,0 mm\r\nDIRECTION 1,0\r\n"));
    assert.equal(t.split("SIZE ").length - 1, 1);
    assert.equal(t.split("CLS\r\nBITMAP 0,0,50,400,0,").length - 1, 2);
    assert.ok(t.includes("\r\nPRINT 1,1\r\n"));
    assert.ok(t.endsWith("\r\nPRINT 1,3\r\n"));
    /* Two pictures of 50 bytes x 400 rows, and nothing but commands around them. */
    assert.ok(job.length > 2 * 50 * 400 && job.length < 2 * 50 * 400 + 400);
  });

  it("the picture's bytes follow the BITMAP command exactly", () => {
    const job = tsplJob([{ widthMm: 2, heightMm: 1, raster: raster(16, 1, [[0, 0]]), copies: 1 }], { dotsPerMm: 8, gapMm: 2.5, direction: 0 });
    const t = text(job);
    const at = t.indexOf("BITMAP 0,0,2,1,0,") + "BITMAP 0,0,2,1,0,".length;
    assert.deepEqual([...job.subarray(at, at + 2)], [0b01111111, 0xff]);
    assert.ok(t.includes("GAP 2.5 mm,0 mm"));
    assert.ok(t.includes("DIRECTION 0,0"));
  });

  it("a change of stock is said again", () => {
    const r = raster(8, 8, []);
    const t = text(
      tsplJob(
        [
          { widthMm: 50, heightMm: 50, raster: r, copies: 1 },
          { widthMm: 80, heightMm: 80, raster: r, copies: 1 },
        ],
        { dotsPerMm: 8, gapMm: 3, direction: 1 },
      ),
    );
    assert.ok(t.includes("SIZE 50 mm,50 mm") && t.includes("SIZE 80 mm,80 mm"));
  });

  it("a shift moves the print along the roll in dots, and none sends no SHIFT", () => {
    const r = raster(8, 8, []);
    assert.ok(!text(tsplJob([{ widthMm: 80, heightMm: 80, raster: r, copies: 1 }], { dotsPerMm: 8, gapMm: 3, direction: 1 })).includes("SHIFT"));
    assert.ok(!text(tsplJob([{ widthMm: 80, heightMm: 80, raster: r, copies: 1 }], { dotsPerMm: 8, gapMm: 3, direction: 1, shiftMm: 0 })).includes("SHIFT"));
    assert.ok(text(tsplJob([{ widthMm: 80, heightMm: 80, raster: r, copies: 1 }], { dotsPerMm: 8, gapMm: 3, direction: 1, shiftMm: -2.5 })).includes("\r\nSHIFT -20\r\n"));
  });

  it("calibrating says the stock, then measures the roll, and prints nothing", () => {
    const t = text(tsplCalibrate(80, 80, { dotsPerMm: 8, gapMm: 3, direction: 1 }));
    assert.equal(t, "SIZE 80 mm,80 mm\r\nGAP 3 mm,0 mm\r\nGAPDETECT\r\nHOME\r\n");
    assert.ok(!t.includes("PRINT"));
  });

  it("a QR module is a whole number of dots, and the code is centred in its square", () => {
    /* A 24 mm code of 21 modules on a 203 dpi printer: 192 dots, nine a module. */
    assert.deepEqual(qrGrid(21, 192), { cell: 9, offset: 1 });
    assert.deepEqual(qrGrid(21, 176), { cell: 8, offset: 4 });
    assert.deepEqual(qrGrid(25, 192), { cell: 7, offset: 8 });
    assert.equal(qrGrid(21, 10).cell, 1);
  });
});
