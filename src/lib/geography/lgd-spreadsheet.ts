/* ---------------------------------------------------------------------------
 * READING AN LGD DOWNLOAD — PURE, no I/O, no dependencies.
 *
 * The Local Government Directory's "Xls Report" is not a binary Excel file. It is
 * a SpreadsheetML (Excel 2003 XML) document with an `.xls` name:
 *
 *   <Row><Cell><Data ss:Type="String">Maharashtra</Data></Cell> ... </Row>
 *
 * This reads exactly that and nothing else. A cell is whatever text its <Data>
 * holds, trimmed; an empty or missing cell is "". A cell may carry `ss:Index`,
 * which means "this is column N" and skips the empty ones before it, and that is
 * honoured — dropping it would slide every later value one column to the left.
 *
 * Columns are found by HEADER TEXT by the importer, never by position, because an
 * LGD report's column order is not a contract and two of its files repeat a header
 * ("Subdistrict Name" in English and again in the local language).
 * ------------------------------------------------------------------------- */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** XML character references and the five named entities. Anything else is left as written. */
export function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

const ROW = /<Row\b[^>]*?(?:\/>|>([\s\S]*?)<\/Row>)/g;
const CELL = /<Cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Cell>)/g;
const DATA = /<Data\b[^>]*?(?:\/>|>([\s\S]*?)<\/Data>)/;
const INDEX = /\bss:Index="(\d+)"/;

/** Every row of every worksheet, in order, as an array of trimmed cell text. */
export function spreadsheetRows(xml: string): string[][] {
  const out: string[][] = [];
  for (const row of xml.matchAll(ROW)) {
    const cells: string[] = [];
    for (const cell of (row[1] ?? "").matchAll(CELL)) {
      const at = INDEX.exec(cell[1] ?? "");
      if (at) while (cells.length < Number(at[1]) - 1) cells.push("");
      const data = DATA.exec(cell[2] ?? "");
      cells.push(data ? decodeXml(data[1] ?? "").trim() : "");
    }
    out.push(cells);
  }
  return out;
}

export type LgdTable = {
  /** The title lines above the header, kept because the state's name and code are in them. */
  title: string[];
  headers: string[];
  rows: string[][];
};

/**
 * The table of one report: the header row is the first whose first cell is
 * `S.No.` (with or without the space), the title is every non-empty row above it,
 * and the data are the rows below it that have a serial number. The row of
 * "(In English) (In Local)" captions under the header has none and is skipped.
 */
export function lgdTable(xml: string): LgdTable {
  const all = spreadsheetRows(xml);
  const at = all.findIndex((r) => /^s\.?\s?no\.?$/i.test(r[0] ?? ""));
  if (at < 0) throw new Error("This is not an LGD report: no S.No. header row was found.");
  return {
    title: all.slice(0, at).map((r) => r.join(" ").trim()).filter(Boolean),
    headers: all[at],
    rows: all.slice(at + 1).filter((r) => (r[0] ?? "") !== ""),
  };
}

/** The index of the Nth column whose header reads `name` (case-insensitive), or throws. */
export function column(headers: ReadonlyArray<string>, name: string, nth = 0): number {
  let seen = 0;
  for (let i = 0; i < headers.length; i++) {
    if (headers[i].trim().toLowerCase() === name.toLowerCase()) {
      if (seen === nth) return i;
      seen++;
    }
  }
  throw new Error(`The report has no column "${name}"${nth ? ` (#${nth + 1})` : ""}. Headers are: ${headers.join(" | ")}`);
}
