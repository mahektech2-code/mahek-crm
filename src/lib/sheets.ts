import "server-only";
import { createSign } from "node:crypto";

/* ---------------------------------------------------------------------------
 * The one place a Google Sheet is read.
 *
 * A service account holds Viewer on the one sheet it is meant to see, and the
 * token minted here carries the READONLY scope — so even a sheet shared too
 * generously, or a bug in a caller, cannot write back to somebody's data. That
 * is the whole reason this is a service account rather than a published link:
 * the permission is enforced by Google against a named identity, not by our
 * good intentions.
 *
 * No SDK. The flow is a self-signed JWT exchanged for an access token, which
 * is a POST and twenty lines — the same trade mailer.ts makes with Resend.
 *
 * Without credentials this reports NOT CONFIGURED rather than an empty sheet.
 * A sync that silently returns nothing looks exactly like a sheet somebody
 * emptied, and the two must never be confused.
 * ------------------------------------------------------------------------- */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

export function sheetsConfigured(): boolean {
  return Boolean(process.env.GOOGLE_SA_EMAIL && process.env.GOOGLE_SA_PRIVATE_KEY);
}

const b64url = (o: unknown) =>
  Buffer.from(JSON.stringify(o)).toString("base64url");

/**
 * Tokens last an hour; minting one costs a round trip to Google. Cached in
 * module scope with a minute of headroom so a sync of many ranges does not
 * re-authenticate per request.
 */
let cached: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.expiresAt > now + 60) return cached.token;

  const email = process.env.GOOGLE_SA_EMAIL;
  const rawKey = process.env.GOOGLE_SA_PRIVATE_KEY;
  if (!email || !rawKey) {
    throw new Error("Google Sheets is not configured.");
  }
  // Env files store the newlines of a PEM literally. Every "invalid JWT
  // signature" from Google is this line missing.
  const key = rawKey.replace(/\\n/g, "\n");

  const claim =
    `${b64url({ alg: "RS256", typ: "JWT" })}.` +
    `${b64url({ iss: email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })}`;
  const signature = createSign("RSA-SHA256").update(claim).sign(key, "base64url");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${claim}.${signature}`,
    }),
  });

  const body = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new Error(
      `Google refused the service account: ${body.error ?? res.status}` +
        (body.error_description ? ` — ${body.error_description}` : ""),
    );
  }

  cached = { token: body.access_token, expiresAt: now + (body.expires_in ?? 3600) };
  return cached.token;
}

async function api<T>(path: string): Promise<T> {
  const token = await accessToken();
  const res = await fetch(`${SHEETS_API}/${path}`, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const body = (await res.json()) as T & { error?: { message?: string } };
  if (!res.ok) {
    // 403 here is nearly always the sheet not being shared with the service
    // account, which is a different fix from anything code can do — so say so.
    const hint =
      res.status === 403
        ? ` Share the sheet with ${process.env.GOOGLE_SA_EMAIL} as Viewer.`
        : "";
    throw new Error(`Google Sheets ${res.status}: ${body.error?.message ?? ""}.${hint}`);
  }
  return body;
}

export type SheetTab = { title: string; gid: number; rows: number; columns: number };

export async function listTabs(spreadsheetId: string): Promise<SheetTab[]> {
  const meta = await api<{
    sheets: {
      properties: {
        title: string;
        sheetId: number;
        gridProperties: { rowCount: number; columnCount: number };
      };
    }[];
  }>(`${encodeURIComponent(spreadsheetId)}?fields=sheets.properties`);

  return meta.sheets.map((s) => ({
    title: s.properties.title,
    gid: s.properties.sheetId,
    rows: s.properties.gridProperties.rowCount,
    columns: s.properties.gridProperties.columnCount,
  }));
}

export type SheetTable = {
  /** Header text per column, in sheet order, trimmed of stray whitespace. */
  headers: string[];
  /**
   * One entry per non-empty row: the sheet's own 1-based row number, and the
   * cells keyed by header. The row number is kept because the only useful
   * thing to tell somebody about a bad row is where to scroll to.
   */
  rows: { rowNumber: number; cells: Record<string, string> }[];
  /**
   * How many rows the range actually returned, blank ones included.
   *
   * This is how the end of a sheet is found when reading in windows: Google
   * returns only the rows that exist, so a window shorter than it asked for is
   * the last one. `rows.length` cannot answer that — it has had the blanks
   * removed, and a window of nothing but blank rows would end the read early.
   */
  rowsInWindow: number;
};

export type ReadRange = {
  /** 1-based, inclusive. Defaults to the whole tab. */
  firstRow?: number;
  lastRow?: number;
  /**
   * Headers from an earlier read. Supplied when reading a window that starts
   * below row 1, which has no header of its own — and it saves re-fetching
   * the same row for every window of a thirty-thousand-row sync.
   */
  headers?: string[];
};

/**
 * Read a tab, or a window of one, as a table of strings.
 *
 * Everything comes back as text on purpose. Google will happily hand over its
 * own idea of a number or a date, and this sheet's dates are `1-Apr-2024` and
 * its amounts are `13,440.00` — reading them as text and parsing them
 * ourselves keeps the original string available when a parse fails, which is
 * the difference between "this cell is wrong, here it is" and a silent null.
 */
export async function readTab(
  spreadsheetId: string,
  tabTitle: string,
  range: ReadRange = {},
): Promise<SheetTable> {
  const tab = `'${tabTitle.replace(/'/g, "''")}'`;
  // Row-only A1 notation ("'Tab'!2:5000") takes the full width, so a column
  // added to the sheet arrives without anyone widening a range here.
  const rows =
    range.firstRow !== undefined
      ? `!${range.firstRow}:${range.lastRow ?? ""}`
      : "";

  const data = await api<{ values?: string[][] }>(
    `${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(tab + rows)}` +
      `?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`,
  );

  const values = data.values ?? [];
  const firstRow = range.firstRow ?? 1;

  // Headers are normalised for whitespace only. Two of this sheet's headers
  // carry a trailing newline and one has a double space inside it, and none of
  // that is meaningful — but the text itself is left alone, because it is the
  // key `raw` is stored under and what a person sees at the top of the column.
  const headers =
    range.headers ??
    (values[0] ?? []).map((h) => String(h ?? "").trim().replace(/\s+/g, " "));

  // Without supplied headers the first row of the response IS the header and
  // is not data. With them, every row returned is data.
  const dataFrom = range.headers ? 0 : 1;
  const dataRows = values.slice(dataFrom);

  const rowsOut: SheetTable["rows"] = [];
  dataRows.forEach((row, i) => {
    if (!row.some((c) => String(c ?? "").trim() !== "")) return; // blank row

    const cells: Record<string, string> = {};
    headers.forEach((header, col) => {
      if (!header) return; // an unnamed column has nowhere to go
      cells[header] = String(row[col] ?? "").trim();
    });
    rowsOut.push({ rowNumber: firstRow + dataFrom + i, cells });
  });

  return { headers, rows: rowsOut, rowsInWindow: dataRows.length };
}
