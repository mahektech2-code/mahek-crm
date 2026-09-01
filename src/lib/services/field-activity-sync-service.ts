import "server-only";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { sheetFieldActivityRows, sheetSyncRuns, users } from "@/db/schema";
import { readTab, sheetsConfigured, type SheetTable } from "@/lib/sheets";
import {
  isBlankFieldActivityRow,
  parseFieldActivityRow,
  type ParsedFieldActivityRow,
} from "@/lib/field-activity-parse";
import {
  decideCustomerMatch,
  matchSalesmanName,
  type CustomerCandidate,
  type MatchResult,
} from "@/lib/field-activity-match";
import {
  hashRow,
  newSyncId,
  readWindows,
  runSync,
  watermark,
  WRITE_BATCH,
  type SheetReader,
  type SyncCounts,
  type SyncMode,
  type SyncOutcome,
} from "./sheet-sync-core";

/* ---------------------------------------------------------------------------
 * Pulling the Activity tab of a defunct prior system ("Mahek EMP 2.0") into
 * `sheet_field_activity_rows` — built on the same staging/hash/reconcile
 * machinery every other sheet import here uses.
 *
 * ONE ROW PER SHEET ROW, keyed on the sheet's own Activity ID — closer in
 * shape to the order sheet's per-line rows than to the employee master's
 * one-row-per-person. It takes the order sheet's OWN append/reconcile split
 * rather than HRMS's always-reconcile: this tab is tens of thousands of rows,
 * so a full compare on every tick would spend API quota reading rows an
 * append pass would never have missed. `field-activity-append` runs the
 * watermark-only pass often; the reconcile mode — the only mode this
 * started with, while the tab was still a hand-triggered backfill — is now
 * the once-a-day pass that catches an edited or withdrawn row.
 *
 * The service account was confirmed to hold Viewer on the live sheet on
 * 2026-09-01; before that, `reader` let the initial backfill run against a
 * CSV export instead (`scripts/import-field-activity-csv.ts`), sharing every
 * line of parsing, matching and staging with the live sheet read now.
 * ------------------------------------------------------------------------- */

export const FIELD_ACTIVITY_SOURCE = "field_activity";
export const FIELD_ACTIVITY_TAB = "Activity";
export const FIELD_ACTIVITY_SPREADSHEET_ID = "1lo03cZH6LFAr5lWYm-U1wEzh9MvNqZT9R4ZBU_Vqfi4";

export function fieldActivitySheetId(): string {
  return process.env.FIELD_ACTIVITY_SHEET_ID || FIELD_ACTIVITY_SPREADSHEET_ID;
}

/** Header is row 1; data starts at row 2 — this tab has no second header row. */
const FIRST_DATA_ROW = 2;

export type FieldActivitySyncOptions = {
  spreadsheetId: string;
  tabTitle?: string;
  mode: SyncMode;
  triggeredById?: string | null;
  reader?: SheetReader;
};

export async function syncFieldActivitySheet(
  options: FieldActivitySyncOptions,
): Promise<SyncOutcome> {
  const tabTitle = options.tabTitle ?? FIELD_ACTIVITY_TAB;
  const { mode } = options;

  if (!options.reader && !sheetsConfigured()) {
    throw new Error(
      "Google Sheets is not configured — set GOOGLE_SA_EMAIL and GOOGLE_SA_PRIVATE_KEY.",
    );
  }

  const salesmen = await db.select({ id: users.id, name: users.name }).from(users);
  const customerCache = new Map<string, MatchResult>();

  return runSync(
    {
      source: FIELD_ACTIVITY_SOURCE,
      spreadsheetId: options.spreadsheetId,
      tabTitle,
      mode,
      triggeredById: options.triggeredById,
    },
    (syncId) => pullFromSheet(syncId, { ...options, tabTitle }, salesmen, customerCache),
  );
}

/**
 * A distinct customer name against `customers.name`, by the same
 * trigram/substring technique product search already uses. Cached across
 * the whole run — 32,928 rows share only 5,180 distinct names, and every
 * repeat of one is a cache hit rather than a second query.
 */
async function matchCustomer(
  name: string | null,
  cache: Map<string, MatchResult>,
): Promise<MatchResult> {
  if (!name) return { status: "unmatched", matchedId: null, note: null };
  const key = name.trim().toLowerCase();
  if (!key) return { status: "unmatched", matchedId: null, note: null };

  const cached = cache.get(key);
  if (cached) return cached;

  const like = `%${name}%`;
  const rows = await db.execute<{ id: string; name: string; score: number }>(sql`
    select id, name, similarity(lower(name), lower(${name})) as score
      from customers
     where name ilike ${like} or similarity(lower(name), lower(${name})) > 0.3
     order by
       case
         when lower(name) = lower(${name}) then 0
         when name ilike ${name + "%"} then 1
         when name ilike ${like} then 2
         else 3
       end,
       similarity(lower(name), lower(${name})) desc
     limit 8
  `);
  const candidates: CustomerCandidate[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    score: Number(r.score),
  }));
  const result = decideCustomerMatch(candidates);
  cache.set(key, result);
  return result;
}

async function pullFromSheet(
  syncId: string,
  { spreadsheetId, tabTitle, mode, reader }: FieldActivitySyncOptions & { tabTitle: string },
  salesmen: { id: string; name: string }[],
  customerCache: Map<string, MatchResult>,
): Promise<SyncCounts> {
  const read: SheetReader =
    reader ?? ((range) => readTab(spreadsheetId, tabTitle, range));
  const startRow =
    mode === "append"
      ? Math.max((await watermark(FIELD_ACTIVITY_SOURCE)) + 1, FIRST_DATA_ROW)
      : FIRST_DATA_ROW;

  let rowsRead = 0;
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let withIssues = 0;
  let highestRow = Math.max(startRow - 1, 1);

  for await (const window of readWindows(read, startRow, FIRST_DATA_ROW)) {
    const rows = window.rows.filter((row) => !isBlankFieldActivityRow(row.cells));
    rowsRead += rows.length;
    for (const row of rows) highestRow = Math.max(highestRow, row.rowNumber);

    const result = await writeWindow(syncId, { ...window, rows }, salesmen, customerCache);
    created += result.created;
    updated += result.updated;
    unchanged += result.unchanged;
    withIssues += result.withIssues;

    await db
      .update(sheetSyncRuns)
      .set({ cursorRow: highestRow, rowsRead, highestRow })
      .where(eq(sheetSyncRuns.id, syncId));
  }

  let withdrawn = 0;
  if (mode === "reconcile") {
    const result = await db
      .update(sheetFieldActivityRows)
      .set({ status: "withdrawn", updatedAt: new Date() })
      .where(
        and(
          ne(sheetFieldActivityRows.lastSeenSyncId, syncId),
          eq(sheetFieldActivityRows.status, "present"),
        ),
      )
      .returning({ id: sheetFieldActivityRows.id });
    withdrawn = result.length;
  }

  const detail =
    `${mode} from row ${startRow}: ${created} new, ${updated} changed, ` +
    `${unchanged} unchanged` +
    (withdrawn ? `, ${withdrawn} gone from the sheet` : "") +
    (withIssues ? `, ${withIssues} with issues` : "");

  return {
    rowsRead,
    rowsCreated: created,
    rowsUpdated: updated,
    rowsUnchanged: unchanged,
    rowsWithdrawn: withdrawn,
    rowsWithIssues: withIssues,
    detail,
  };
}

async function writeWindow(
  syncId: string,
  window: SheetTable,
  salesmen: { id: string; name: string }[],
  customerCache: Map<string, MatchResult>,
) {
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let withIssues = 0;

  for (let i = 0; i < window.rows.length; i += WRITE_BATCH) {
    const slice = window.rows.slice(i, i + WRITE_BATCH);
    if (!slice.length) continue;

    const prepared = slice.map((row) => ({
      row,
      parsed: parseFieldActivityRow(row.cells),
      hash: hashRow(row.cells),
    }));

    const activityIds = prepared.map((p) => p.parsed.activityId).filter(Boolean);
    const existing = activityIds.length
      ? await db
          .select({
            activityId: sheetFieldActivityRows.activityId,
            rowHash: sheetFieldActivityRows.rowHash,
          })
          .from(sheetFieldActivityRows)
          .where(inArray(sheetFieldActivityRows.activityId, activityIds))
      : [];
    const hashByActivityId = new Map(existing.map((e) => [e.activityId, e.rowHash]));

    const changed: (typeof sheetFieldActivityRows.$inferInsert)[] = [];
    const untouched: string[] = [];

    for (const { row, parsed, hash } of prepared) {
      // No Activity ID: cannot be matched on a re-import, so it is written
      // once under its row number and left alone on every later pass —
      // never silently dropped, which is what happened to the 74 fully
      // blank rows before they were ever offered to this function.
      const key = parsed.activityId || `ROW-${row.rowNumber}`;
      const known = hashByActivityId.get(key);
      if (known === hash) {
        unchanged++;
        untouched.push(key);
        continue;
      }
      if (parsed.issues.length) withIssues++;
      if (known === undefined) created++;
      else updated++;

      const salesman = matchSalesmanName(parsed.employeeName, salesmen);
      const customer = await matchCustomer(parsed.customerName, customerCache);

      changed.push(toRow(syncId, row, key, parsed, hash, salesman, customer));
    }

    if (changed.length) {
      await db
        .insert(sheetFieldActivityRows)
        .values(changed)
        .onConflictDoUpdate({
          target: sheetFieldActivityRows.activityId,
          set: upsertColumns(),
        });
    }

    if (untouched.length) {
      await db
        .update(sheetFieldActivityRows)
        .set({ lastSeenSyncId: syncId, status: "present" })
        .where(inArray(sheetFieldActivityRows.activityId, untouched));
    }
  }

  return { created, updated, unchanged, withIssues };
}

function toRow(
  syncId: string,
  row: { rowNumber: number; cells: Record<string, string> },
  activityId: string,
  parsed: ParsedFieldActivityRow,
  hash: string,
  salesman: MatchResult,
  customer: MatchResult,
): typeof sheetFieldActivityRows.$inferInsert {
  return {
    id: newSyncId("fact"),
    syncId,
    rowNumber: row.rowNumber,
    activityId,
    raw: row.cells,
    rowHash: hash,
    status: "present",
    lastSeenSyncId: syncId,

    employeeName: parsed.employeeName,
    matchedSalesmanId: salesman.matchedId,
    salesmanMatchStatus: salesman.status,

    customerName: parsed.customerName,
    matchedCustomerId: customer.matchedId,
    customerMatchStatus: customer.status,
    matchNote: customer.note ?? salesman.note,

    visitDate: parsed.visitDate,
    durationMinutes: parsed.durationMinutes,
    meetingNote: parsed.meetingNote,
    issueNote: parsed.issueNote,
    reminderDate: parsed.reminderDate,

    moodRaw: parsed.moodRaw,
    mood: parsed.mood,
    stageLabel: parsed.stageLabel,

    meetingType: parsed.meetingType,
    meetingPurpose: parsed.meetingPurpose,
    location: parsed.location,

    timelineEventWritten: false,
    issues: parsed.issues,
    updatedAt: new Date(),
  };
}

function upsertColumns() {
  const set: Record<string, unknown> = {};
  for (const column of [
    "syncId", "rowNumber", "raw", "rowHash", "status", "lastSeenSyncId",
    "employeeName", "matchedSalesmanId", "salesmanMatchStatus",
    "customerName", "matchedCustomerId", "customerMatchStatus", "matchNote",
    "visitDate", "durationMinutes", "meetingNote", "issueNote", "reminderDate",
    "moodRaw", "mood", "stageLabel", "meetingType", "meetingPurpose", "location",
    // Deliberately NOT timelineEventWritten: a re-import must not forget that
    // a row's timeline entry already exists just because the sheet cell it
    // was read from happened to change on the same pass.
    "issues", "updatedAt",
  ]) {
    set[column] = sql.raw(`excluded.${toSnake(column)}`);
  }
  return set;
}

const toSnake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
