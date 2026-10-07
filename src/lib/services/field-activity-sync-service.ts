import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { sheetFieldActivityRows, sheetSyncRuns, timelineEvents, users } from "@/db/schema";
import { readTab, sheetsConfigured, type SheetTable } from "@/lib/sheets";
import {
  detectDateOrder,
  FIELD_ACTIVITY_COL,
  isBlankFieldActivityRow,
  parseFieldActivityRow,
  type DateOrder,
  type ParsedFieldActivityRow,
} from "@/lib/field-activity-parse";
import { MBOS_EVENT } from "@/lib/timeline";
import {
  decideCustomerMatch,
  matchSalesmanName,
  type CustomerCandidate,
  type MatchResult,
} from "@/lib/field-activity-match";
import {
  hashRow,
  newSyncId,
  notAmong,
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

  /** Every activity key this pass found, accumulated across windows. A
   *  reconcile withdraws what is NOT in here; an append never withdraws. */
  const seen = new Set<string>();

  /*
   * The order the Date column is written in, decided from what this read can
   * see. An append pass in the first week of a month holds nothing over 12 and
   * cannot settle it alone, so it falls back on the rows already stored —
   * which were read from the same workbook — and only then on month-first.
   */
  let order: DateOrder | null = null;

  for await (const window of readWindows(read, startRow, FIRST_DATA_ROW)) {
    const rows = window.rows.filter((row) => !isBlankFieldActivityRow(row.cells));
    rowsRead += rows.length;
    for (const row of rows) highestRow = Math.max(highestRow, row.rowNumber);

    order =
      detectDateOrder(rows.map((r) => r.cells[FIELD_ACTIVITY_COL.date])) ??
      order ??
      (await storedDateOrder()) ??
      "mdy";

    const result = await writeWindow(syncId, { ...window, rows }, salesmen, customerCache, seen, order);
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
          eq(sheetFieldActivityRows.status, "present"),
          notAmong(sheetFieldActivityRows.activityId, seen),
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
  seen: Set<string>,
  order: DateOrder,
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
      parsed: parseFieldActivityRow(row.cells, order),
      hash: hashRow(row.cells),
    }));

    // Keyed on what the row is actually STORED under, which for a row with no
    // Activity ID is its row number. Looking up only the real ids left those
    // rows matching nothing, so every pass read them as new and rewrote them —
    // a small count, and a rewrite of a row that had not moved all the same.
    const activityIds = prepared.map((p) => p.parsed.activityId || `ROW-${p.row.rowNumber}`);
    const existing = activityIds.length
      ? await db
          .select({
            activityId: sheetFieldActivityRows.activityId,
            rowHash: sheetFieldActivityRows.rowHash,
            status: sheetFieldActivityRows.status,
          })
          .from(sheetFieldActivityRows)
          .where(inArray(sheetFieldActivityRows.activityId, activityIds))
      : [];
    const hashByActivityId = new Map(existing.map((e) => [e.activityId, e.rowHash]));
    const statusByActivityId = new Map(existing.map((e) => [e.activityId, e.status]));

    const changed: (typeof sheetFieldActivityRows.$inferInsert)[] = [];
    /** Unchanged rows the sheet has taken back. Normally empty. */
    const returned: string[] = [];

    for (const { row, parsed, hash } of prepared) {
      // No Activity ID: cannot be matched on a re-import, so it is written
      // once under its row number and left alone on every later pass —
      // never silently dropped, which is what happened to the 74 fully
      // blank rows before they were ever offered to this function.
      const key = parsed.activityId || `ROW-${row.rowNumber}`;
      const known = hashByActivityId.get(key);
      seen.add(key);
      if (known === hash) {
        unchanged++;
        if (statusByActivityId.get(key) !== "present") returned.push(key);
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

    if (returned.length) {
      await db
        .update(sheetFieldActivityRows)
        .set({ lastSeenSyncId: syncId, status: "present", updatedAt: new Date() })
        .where(inArray(sheetFieldActivityRows.activityId, returned));
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

/**
 * RE-READ WHO THESE ROWS BELONG TO, without touching Google.
 *
 * The counterpart of `taken-order-reparse`, and it exists for the reason
 * AGENTS.md already states about that one: a hash-driven sync never rewrites a
 * row that has not changed, so when the READING of a row changes rather than
 * the row itself, nothing lands. Here the reading changes when somebody gets a
 * MahekOne account.
 *
 * It happened exactly that way. The 33,058 activity rows were written on
 * 1 September; Rahul Richhariya's account was created on the 10th. At sync
 * time `matchSalesmanName` correctly answered "unmatched" — there was nobody
 * of that name to match — and because not one cell of the sheet has changed
 * since, the question has never been asked again. Every row on the screen is
 * still marked unmatched, including 3,552 that are plainly his.
 *
 * It re-matches the SALESMAN only. The customer match is fuzzy, expensive and
 * already working (12,524 of 33,058 resolved); redoing it here would spend a
 * long pass re-deriving answers nobody has disputed. Matching is exact on
 * `partyNameKey`, so this is cheap and safe to run as often as anybody likes.
 *
 * **It will never match most of them, and that is correct.** These names are
 * field salesmen from a prior system — "Prakash Vasudev Prasad" has 8,911 rows
 * and no MahekOne account, and may never have one. That is the same fact
 * `customers.sales_person_name` exists for: a salesperson is a name, not an
 * account. Rows that stay unmatched belong to nobody and are shown to
 * everybody, which is what the review screen is for.
 */
export async function rematchFieldActivitySalesmen(): Promise<{
  scanned: number;
  matched: number;
  ambiguous: number;
  stillUnmatched: number;
}> {
  const salesmen = await db.select({ id: users.id, name: users.name }).from(users);

  const rows = await db
    .select({
      id: sheetFieldActivityRows.id,
      employeeName: sheetFieldActivityRows.employeeName,
      matchedSalesmanId: sheetFieldActivityRows.matchedSalesmanId,
      salesmanMatchStatus: sheetFieldActivityRows.salesmanMatchStatus,
    })
    .from(sheetFieldActivityRows);

  let matched = 0;
  let ambiguous = 0;
  let stillUnmatched = 0;

  for (const row of rows) {
    const result = matchSalesmanName(row.employeeName, salesmen);
    if (result.status === "matched") matched += 1;
    else if (result.status === "ambiguous") ambiguous += 1;
    else stillUnmatched += 1;

    /* Only where the answer actually MOVED. On a book this size most rows
       resolve to the same nobody they resolved to before, and rewriting all
       33,058 to change none of them would be a long write nobody can tell
       apart from a real one in the audit. */
    if (
      result.matchedId === row.matchedSalesmanId &&
      result.status === row.salesmanMatchStatus
    ) {
      continue;
    }
    await db
      .update(sheetFieldActivityRows)
      .set({ matchedSalesmanId: result.matchedId, salesmanMatchStatus: result.status })
      .where(eq(sheetFieldActivityRows.id, row.id));
  }

  return { scanned: rows.length, matched, ambiguous, stillUnmatched };
}

/**
 * How the stored rows write their dates — the most recent read that said
 * anything either way. Used only where a read is too small to say for itself.
 */
async function storedDateOrder(): Promise<DateOrder | null> {
  const rows = await db.execute<{ d: string | null }>(sql`
    select raw->>${FIELD_ACTIVITY_COL.date} as d
      from sheet_field_activity_rows
     order by updated_at desc
     limit 5000
  `);
  return detectDateOrder(rows.map((r) => r.d));
}

/**
 * RE-READ EVERY STORED DATE, without touching Google.
 *
 * The twin of `rematchFieldActivitySalesmen`, for the date rather than the
 * salesman. A hash-driven sync never rewrites a row whose cells did not
 * change, so a row read month-first from a day-first workbook keeps its wrong
 * date for ever — 10 June sitting on the screen as 6 October, a visit on a
 * day nobody made it, by somebody who may have left in July.
 *
 * Every row's `raw` is what ONE sync run read, so the order is decided per run
 * (`sync_id`): a CSV export and a live read of the same tab can disagree, and
 * deciding for the whole table would put one of them wrong. A run too small to
 * say — an append in the first week of a month — takes the nearest run that
 * did, earlier first. Only rows whose answer MOVED are written, and a moved
 * row's timeline entry moves with it, because that entry is what reaches the
 * customer's history and the salesman's phone.
 */
export async function reparseFieldActivityDates(): Promise<{
  scanned: number;
  moved: number;
  nowUnreadable: number;
  timelineMoved: number;
  orders: { dmy: number; mdy: number };
}> {
  const rows = await db
    .select({
      id: sheetFieldActivityRows.id,
      syncId: sheetFieldActivityRows.syncId,
      raw: sheetFieldActivityRows.raw,
      visitDate: sheetFieldActivityRows.visitDate,
      reminderDate: sheetFieldActivityRows.reminderDate,
      timelineEventWritten: sheetFieldActivityRows.timelineEventWritten,
      startedAt: sheetSyncRuns.startedAt,
    })
    .from(sheetFieldActivityRows)
    .leftJoin(sheetSyncRuns, eq(sheetSyncRuns.id, sheetFieldActivityRows.syncId));

  // Runs in the order they happened, each with what its own rows say.
  const byRun = new Map<string, { at: number; rows: typeof rows }>();
  for (const r of rows) {
    const run = byRun.get(r.syncId) ?? { at: r.startedAt ? r.startedAt.getTime() : 0, rows: [] };
    run.rows.push(r);
    byRun.set(r.syncId, run);
  }
  const runs = [...byRun.entries()]
    .map(([id, run]) => ({
      id,
      ...run,
      order: detectDateOrder(run.rows.map((r) => r.raw[FIELD_ACTIVITY_COL.date])),
    }))
    .sort((a, b) => a.at - b.at);
  const decided = runs.map((run, i) => {
    if (run.order) return run.order;
    for (let j = i - 1; j >= 0; j--) if (runs[j].order) return runs[j].order!;
    for (let j = i + 1; j < runs.length; j++) if (runs[j].order) return runs[j].order!;
    return "mdy" as DateOrder;
  });

  let moved = 0;
  let nowUnreadable = 0;
  let timelineMoved = 0;
  const orders = { dmy: 0, mdy: 0 };

  for (const [i, run] of runs.entries()) {
    const order = decided[i];
    orders[order] += run.rows.length;
    for (const row of run.rows) {
      const parsed = parseFieldActivityRow(row.raw, order);
      if (parsed.visitDate === row.visitDate && parsed.reminderDate === row.reminderDate) continue;
      moved++;
      if (!parsed.visitDate) nowUnreadable++;

      await db
        .update(sheetFieldActivityRows)
        .set({
          visitDate: parsed.visitDate,
          reminderDate: parsed.reminderDate,
          issues: parsed.issues,
          // No readable date is nothing to put on a timeline; a fresh one is
          // owed one if it never had it.
          timelineEventWritten: parsed.visitDate ? row.timelineEventWritten : false,
          updatedAt: new Date(),
        })
        .where(eq(sheetFieldActivityRows.id, row.id));

      if (row.timelineEventWritten && parsed.visitDate !== row.visitDate) {
        const where = and(
          eq(timelineEvents.sourceApp, "mbos"),
          eq(timelineEvents.eventType, MBOS_EVENT.visit),
          eq(timelineEvents.sourceRecordId, row.id),
        );
        const changed = parsed.visitDate
          ? await db
              .update(timelineEvents)
              .set({ occurredAt: new Date(`${parsed.visitDate}T12:00:00+05:30`) })
              .where(where)
              .returning({ id: timelineEvents.id })
          : await db.delete(timelineEvents).where(where).returning({ id: timelineEvents.id });
        timelineMoved += changed.length;
      }
    }
  }

  return { scanned: rows.length, moved, nowUnreadable, timelineMoved, orders };
}
