/* ---------------------------------------------------------------------------
 * TSPL — the language the godown's label printers speak. PURE, no I/O, and
 * client-safe: the print page builds the job in the browser and hands the
 * bytes to the printer.
 *
 * THE LABEL IS SENT AS A PICTURE, NOT AS TEXT COMMANDS. The printer team's
 * sample files set each line with the printer's own fonts (`TEXT x,y,"0",…`),
 * which means a layout that only exists for one printer model, one firmware
 * and one installed font file — their SFG sample asks for `ROMAN.TTF`, which
 * is on a printer only if somebody copied it there. A picture is the label the
 * screen shows, dot for dot, on any printer that speaks TSPL at all, and
 * `BITMAP` is the one command every one of them implements. A 50 mm label is
 * 20 KB and an 80 mm one 51 KB, which a USB cable does not notice.
 *
 * ONE DOT IS ONE BIT, AND IN TSPL A SET BIT IS WHITE. That is the opposite of
 * almost every other bitmap format, so it is packed here and nowhere else.
 * ------------------------------------------------------------------------- */

/** How the printer is set up. Each of these is a setting (`erp.labels.*`), never a constant. */
export type PrinterSetup = {
  /** 8 on a 203 dpi printer, 12 on a 300 dpi one. */
  dotsPerMm: number;
  /** The gap between two labels on the roll. */
  gapMm: number;
  /** Which edge leaves the printer first: 0 or 1. */
  direction: 0 | 1;
  /** Millimetres to move the print along the roll, for a printer that lands every label the same distance off. 0 or absent sends nothing. */
  shiftMm?: number;
};

/** A label as dots: one byte per dot, row by row, 1 where the printer burns. */
export type Raster = { width: number; height: number; dots: Uint8Array };

export type LabelJob = { widthMm: number; heightMm: number; raster: Raster; copies: number };

/** How many dots a length is on this printer. */
export function dots(mm: number, dotsPerMm: number): number {
  return Math.round(mm * dotsPerMm);
}

/**
 * A canvas's pixels as dots. A pixel prints where it is darker than
 * `blackBelow` (0–255): a thermal head has no grey, and a threshold a little
 * above the middle keeps the thin strokes of small type from breaking up.
 */
export function rasterFromRgba(rgba: ArrayLike<number>, width: number, height: number, blackBelow = 150): Raster {
  const out = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const a = rgba[i * 4 + 3] / 255;
    /* Anything transparent is the white of the label. */
    const lum = (0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]) * a + 255 * (1 - a);
    out[i] = lum < blackBelow ? 1 : 0;
  }
  return { width, height, dots: out };
}

/** The raster packed for `BITMAP`: eight dots a byte, most significant first, each row padded with white, a set bit WHITE. */
export function packBitmap(r: Raster): { widthBytes: number; data: Uint8Array } {
  const widthBytes = Math.ceil(r.width / 8);
  const data = new Uint8Array(widthBytes * r.height).fill(0xff);
  for (let y = 0; y < r.height; y++)
    for (let x = 0; x < r.width; x++) if (r.dots[y * r.width + x]) data[y * widthBytes + (x >> 3)] &= ~(0x80 >> (x & 7));
  return { widthBytes, data };
}

const mm = (v: number) => `${Math.round(v * 10) / 10} mm`;

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/**
 * A print job: the stock and the printer's setup said once per size, then a
 * picture and a count per label. Labels that are the same label are one
 * picture printed `copies` times.
 */
export function tsplJob(labels: LabelJob[], setup: PrinterSetup): Uint8Array {
  const parts: Uint8Array[] = [];
  let stock = "";
  for (const l of labels) {
    const size = `${l.widthMm}x${l.heightMm}`;
    if (size !== stock) {
      stock = size;
      parts.push(
        ascii(
          [
            `SIZE ${mm(l.widthMm)},${mm(l.heightMm)}`,
            `GAP ${mm(setup.gapMm)},0 mm`,
            `DIRECTION ${setup.direction},0`,
            "REFERENCE 0,0",
            "OFFSET 0 mm",
            ...(setup.shiftMm ? [`SHIFT ${dots(setup.shiftMm, setup.dotsPerMm)}`] : []),
            "SET PEEL OFF",
            "SET CUTTER OFF",
            "SET TEAR ON",
            "",
          ].join("\r\n"),
        ),
      );
    }
    const { widthBytes, data } = packBitmap(l.raster);
    parts.push(ascii(`CLS\r\nBITMAP 0,0,${widthBytes},${l.raster.height},0,`), data, ascii(`\r\nPRINT 1,${Math.max(1, Math.round(l.copies))}\r\n`));
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Teach the printer this roll. A gap printer finds the top of every label by
 * its sensor seeing the gap; on a roll the sensor was never set for it sees
 * none, or sees them late, and each label lands at a different height — which
 * no shift can correct, because the error is not the same twice. `GAPDETECT`
 * feeds a few labels past the sensor, measures the label and the gap, and the
 * printer keeps the threshold. It is told the stock first, because it measures
 * against what it is told to expect.
 */
export function tsplCalibrate(widthMm: number, heightMm: number, setup: PrinterSetup): Uint8Array {
  return ascii([`SIZE ${mm(widthMm)},${mm(heightMm)}`, `GAP ${mm(setup.gapMm)},0 mm`, "GAPDETECT", "HOME", ""].join("\r\n"));
}

/**
 * Where the modules of a QR code fall when it is drawn into a square of
 * `boxDots`: every module the same whole number of dots, the code centred in
 * its square. A QR scaled like a photograph has modules of nine dots beside
 * modules of ten, and a scanner reading a curved, scuffed drum has enough to
 * forgive already.
 */
export function qrGrid(modules: number, boxDots: number): { cell: number; offset: number } {
  const cell = Math.max(1, Math.floor(boxDots / modules));
  return { cell, offset: Math.floor((boxDots - cell * modules) / 2) };
}
