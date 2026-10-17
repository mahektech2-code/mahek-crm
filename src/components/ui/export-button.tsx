"use client";

import * as React from "react";
import { downloadCsv, toCsv } from "@/lib/csv";

/**
 * Export to a spreadsheet — §30's "Export to Excel".
 *
 * CSV rather than a real `.xlsx`, and that is a deliberate trade rather than a
 * shortcut: Excel opens a CSV by double-click, the whole app already exports
 * this way, and an `.xlsx` writer is a dependency and a binary format to
 * maintain for a file whose only job is to be opened once and sorted.
 *
 * The rows are built on the SERVER and handed down, so what leaves in the file
 * is what was on the screen. Rebuilding them in the browser from a different
 * shape is how an export comes to hold a different set of rows to the table
 * above it — usually the unfiltered set, which is the worst version of that
 * bug because it looks like more data rather than wrong data.
 *
 * ON A PAGED TABLE THE ROWS ARE FETCHED INSTEAD, and the rule above is why
 * rather than an exception to it: once a screen shows ten of three thousand,
 * "what was on the screen" and "the list you are looking at" stop being the
 * same set, and the file has to be the second. Pass `fetchRows` and a `count`
 * and the button asks for them on the click — still built on the server, from
 * the same query the table was drawn with. Everything unpaged keeps passing
 * `rows` and is unchanged.
 */
export function ExportButton({
  name,
  rows,
  fetchRows,
  count,
}: {
  name: string;
  /** First row is the header. Omit where `fetchRows` is given. */
  rows?: Array<Array<string | number | null | undefined>>;
  /** Asked on the click, for a table that only holds one page. */
  fetchRows?: () => Promise<Array<Array<string | number | null | undefined>> | null>;
  /** How many rows the file will hold — the count the button prints. */
  count?: number;
}) {
  const [busy, setBusy] = React.useState(false);
  const body = rows ? rows.slice(1) : [];
  const total = count ?? body.length;
  const disabled = total === 0 || busy;

  async function run() {
    const source = fetchRows ? await fetchRows() : rows;
    if (!source?.length) return;
    const [headers, ...lines] = source;
    downloadCsv(name, toCsv(headers.map(String), lines), [name]);
  }

  return (
    <button
      type="button"
      disabled={disabled}
      title={
        total === 0
          ? "Nothing to download — nothing matches this filter."
          : `A spreadsheet of all ${total.toLocaleString("en-IN")} rows this filter reaches — not just the page below.`
      }
      onClick={() => {
        // A fetched export is a round trip, so the button has to say it is
        // working: a file that appears two seconds after a click nobody
        // acknowledged reads as a click that did nothing.
        setBusy(true);
        run().finally(() => setBusy(false));
      }}
      className="inline-flex h-9 cursor-pointer items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body hover:bg-canvas disabled:cursor-default disabled:opacity-50"
    >
      {/*
        "EXPORT" IS A WORD THAT MEANS FOUR THINGS IN AN OFFICE, and the number
        beside it used to be the length of an array the browser happened to be
        holding. Now that the file is fetched from the server over the whole
        filtered set, the count is the honest one — and saying "Download" and
        "spreadsheet" tells somebody what the click does and what they will get,
        which is the entire job of a button's label.
      */}
      {busy
        ? "Preparing…"
        : total === 0
          ? "Download as a spreadsheet"
          : `Download ${total.toLocaleString("en-IN")} as a spreadsheet`}
    </button>
  );
}
