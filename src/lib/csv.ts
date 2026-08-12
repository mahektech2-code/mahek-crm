import { APP_TIMEZONE } from "./business-date";

/** Quote everything — Indian business names contain commas often enough. */
export function toCsv(
  headers: string[],
  rows: Array<Array<string | number | null | undefined>>,
): string {
  const esc = (v: string | number | null | undefined) =>
    `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [headers.map(esc).join(",")]
    .concat(rows.map((r) => r.map(esc).join(",")))
    .join("\n");
}

/**
 * The filename carries the filters that produced the file and the moment it was
 * taken. Two exports of the same screen an hour apart are different files, and
 * a spreadsheet found on somebody's desktop next week still says what it is.
 */
export function downloadCsv(name: string, csv: string, filters?: Array<string | null>) {
  const slug = (filters ?? [])
    .filter((f): f is string => Boolean(f && f.trim()))
    .map((f) =>
      f
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, ""),
    )
    .filter(Boolean)
    .join("-");

  // Local time, not UTC — the person reading the name is in Asia/Kolkata.
  const now = new Date();
  // In the business's own zone, like everything else that turns an instant
  // into something a person reads. An export taken at 9am in Mumbai was
  // landing in the downloads folder named 03:30 on a UTC server, which is the
  // one moment somebody actually reads a filename: when they are looking for
  // the file they just made.
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: APP_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const stamp = `${parts.year}-${parts.month}-${parts.day}-${String(
    Number(parts.hour) % 24,
  ).padStart(2, "0")}${parts.minute}`;

  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = [name, slug, stamp].filter(Boolean).join("-") + ".csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Reads a CSV into keyed rows. Handles quoted fields, embedded commas and
 * doubled quotes — Excel exports from an Indian office contain all three.
 */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  const clean = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");

  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];

    if (quoted) {
      if (c === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows.filter((r) => r.some((v) => v.trim() !== ""));
  if (!header) return [];

  const keys = header.map((h) => h.trim());
  return body.map((r) =>
    Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])),
  );
}
