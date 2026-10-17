import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  fieldActivityCustomerDecisions,
  sheetFieldActivityRows,
  sheetSyncRuns,
  timelineEvents,
  users,
} from "@/db/schema";
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
import { getConfig } from "@/lib/config/store";
import {
  decideCustomerMatch,
  foldShopName,
  matchSalesmanName,
  type MatchResult,
} from "@/lib/field-activity-match";
import { loadNameDecisions, loadShopBook, nearShopNames, shopNameMatcher } from "./shop-name-match-service";
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

type ShopMatcher = Awaited<ReturnType<typeof shopNameMatcher>>;

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
  const matcher = await shopNameMatcher();

  return runSync(
    {
      source: FIELD_ACTIVITY_SOURCE,
      spreadsheetId: options.spreadsheetId,
      tabTitle,
      mode,
      triggeredById: options.triggeredById,
    },
    (syncId) => pullFromSheet(syncId, { ...options, tabTitle }, salesmen, matcher),
  );
}

async function pullFromSheet(
  syncId: string,
  { spreadsheetId, tabTitle, mode, reader }: FieldActivitySyncOptions & { tabTitle: string },
  salesmen: { id: string; name: string }[],
  matcher: ShopMatcher,
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
  let afterCutover = 0;
  let highestRow = Math.max(startRow - 1, 1);

  /*
   * MBOS IS THE RECORD FROM THE CUTOVER ON. A row dated on or after it is
   * read, counted and left out: storing it would put a visit from a retired
   * app beside the real one on every screen that reads this table. It is
   * still marked SEEN, so a reconcile never mistakes "not stored" for "gone".
   */
  const cutover = (await getConfig())["fieldActivity.cutoverDate"];

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

    const result = await writeWindow(syncId, { ...window, rows }, salesmen, matcher, seen, order, cutover);
    afterCutover += result.afterCutover;
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
    (withIssues ? `, ${withIssues} with issues` : "") +
    (afterCutover ? `, ${afterCutover} dated from ${cutover} on left out (MBOS is the record)` : "");

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
  matcher: ShopMatcher,
  seen: Set<string>,
  order: DateOrder,
  cutover: string,
) {
  let afterCutover = 0;
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
      // Already stored before the cutover existed: left as it is, and the
      // screens read it out by its date. Never stored: stays that way.
      if (parsed.visitDate && parsed.visitDate >= cutover) {
        afterCutover++;
        continue;
      }
      if (known === hash) {
        unchanged++;
        if (statusByActivityId.get(key) !== "present") returned.push(key);
        continue;
      }
      if (parsed.issues.length) withIssues++;
      if (known === undefined) created++;
      else updated++;

      const salesman = matchSalesmanName(parsed.employeeName, salesmen);
      const customer = await matcher.match(parsed.customerName);

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

  return { created, updated, unchanged, withIssues, afterCutover };
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
 * RE-JUDGE WHICH SHOP EVERY STORED ROW IS, by the rule in force today.
 *
 * Rows were linked by a fuzzy rule that auto-matched close names, and a
 * hash-driven sync never asks again about a row whose cells did not change —
 * so the wrong links stayed, each one a visit on somebody else's timeline.
 * This reads every row's name against the book and the people's decisions
 * (`decideCustomerMatch`), and where the answer MOVED it rewrites the row and
 * takes back the timeline entry the old link wrote; the projection writes the
 * right one afterwards. Google is not touched.
 *
 * A name with no exact account and no decision keeps the note it had — the
 * shortlist the import found — except that a row the old rule had LINKED is
 * now a question, naming what it had been linked to so a person can confirm
 * it in one click.
 */
export async function rematchFieldActivityCustomers(): Promise<{
  scanned: number;
  matched: number;
  ambiguous: number;
  unmatched: number;
  moved: number;
  timelineRemoved: number;
}> {
  const [book, decisions] = await Promise.all([loadShopBook(), loadNameDecisions()]);
  const rows = await db
    .select({
      id: sheetFieldActivityRows.id,
      customerName: sheetFieldActivityRows.customerName,
      matchedCustomerId: sheetFieldActivityRows.matchedCustomerId,
      status: sheetFieldActivityRows.customerMatchStatus,
      note: sheetFieldActivityRows.matchNote,
      timelineEventWritten: sheetFieldActivityRows.timelineEventWritten,
    })
    .from(sheetFieldActivityRows);

  const nameOf = new Map<string, string>();
  const linkedEarlier = rows.filter((r) => r.matchedCustomerId).map((r) => r.matchedCustomerId!);
  if (linkedEarlier.length) {
    const named = await db.execute<{ id: string; name: string; city: string | null }>(sql`
      select id, name, city from customers
       where id in (${sql.join([...new Set(linkedEarlier)].map((i) => sql`${i}`), sql`, `)})
    `);
    for (const n of named) nameOf.set(n.id, n.city ? `${n.name} (${n.city})` : n.name);
  }

  let matched = 0;
  let ambiguous = 0;
  let unmatched = 0;
  let moved = 0;
  let timelineRemoved = 0;

  /* Grouped by what each row becomes, so a thousand rows of one shop are one
     write rather than a thousand. */
  const writes = new Map<string, { set: { matchedCustomerId: string | null; customerMatchStatus: MatchResult["status"]; matchNote: string | null }; ids: string[]; dropTimeline: string[] }>();

  for (const row of rows) {
    const key = foldShopName(row.customerName);
    let result: MatchResult = decideCustomerMatch({
      exact: key ? (book.get(key) ?? []) : [],
      decision: key ? (decisions.get(key) ?? null) : null,
    });
    if (result.status === "unmatched" && !decisions.has(key)) {
      // No exact account and nobody has decided: the import's shortlist
      // stands, and an old link becomes a question rather than vanishing.
      if (row.matchedCustomerId) {
        result = {
          status: "ambiguous",
          matchedId: null,
          note: `Linked earlier by a close name to ${nameOf.get(row.matchedCustomerId) ?? "an account"}, which is not the same name. Check it.`,
        };
      } else {
        result = { status: row.status === "pending" ? "unmatched" : row.status, matchedId: null, note: row.note };
      }
    }

    if (result.status === "matched") matched++;
    else if (result.status === "ambiguous") ambiguous++;
    else unmatched++;

    if (
      result.matchedId === row.matchedCustomerId &&
      result.status === row.status &&
      result.note === row.note
    ) {
      continue;
    }
    moved++;
    const groupKey = JSON.stringify([result.matchedId, result.status, result.note]);
    const group = writes.get(groupKey) ?? {
      set: { matchedCustomerId: result.matchedId, customerMatchStatus: result.status, matchNote: result.note },
      ids: [],
      dropTimeline: [],
    };
    group.ids.push(row.id);
    if (row.timelineEventWritten && result.matchedId !== row.matchedCustomerId) group.dropTimeline.push(row.id);
    writes.set(groupKey, group);
  }

  for (const group of writes.values()) {
    for (let i = 0; i < group.ids.length; i += 1000) {
      const ids = group.ids.slice(i, i + 1000);
      const drop = new Set(group.dropTimeline);
      const dropping = ids.filter((id) => drop.has(id));
      await db.transaction(async (tx) => {
        if (dropping.length) {
          const removed = await tx
            .delete(timelineEvents)
            .where(
              and(
                eq(timelineEvents.sourceApp, "mbos"),
                eq(timelineEvents.eventType, MBOS_EVENT.visit),
                inArray(timelineEvents.sourceRecordId, dropping),
              ),
            )
            .returning({ id: timelineEvents.id });
          timelineRemoved += removed.length;
          await tx
            .update(sheetFieldActivityRows)
            .set({ timelineEventWritten: false })
            .where(inArray(sheetFieldActivityRows.id, dropping));
        }
        await tx
          .update(sheetFieldActivityRows)
          .set({ ...group.set, updatedAt: new Date() })
          .where(inArray(sheetFieldActivityRows.id, ids));
      });
    }
  }

  return { scanned: rows.length, matched, ambiguous, unmatched, moved, timelineRemoved };
}

/** The SQL spelling of `foldShopName`, for finding every row typed under one name. */
const FOLDED_ROW_NAME = sql`btrim(regexp_replace(upper(coalesce(${sheetFieldActivityRows.customerName}, '')), '[^A-Z0-9]+', ' ', 'g'))`;

/**
 * Re-judge every row typed under ONE folded name, right now — after a person
 * decides it or takes a decision back. The same rule and the same timeline
 * clean-up as the nightly re-match, for one shop rather than the whole log.
 */
export async function rejudgeShopName(nameKey: string): Promise<{ rows: number; timelineRemoved: number }> {
  const [decision] = await db
    .select({ customerId: fieldActivityCustomerDecisions.customerId })
    .from(fieldActivityCustomerDecisions)
    .where(eq(fieldActivityCustomerDecisions.nameKey, nameKey));
  const exact = await db.execute<{ id: string; name: string; city: string | null }>(sql`
    select id, name, city from customers
     where btrim(regexp_replace(upper(name), '[^A-Z0-9]+', ' ', 'g')) = ${nameKey}
  `);
  const rows = await db
    .select({
      id: sheetFieldActivityRows.id,
      customerName: sheetFieldActivityRows.customerName,
      matchedCustomerId: sheetFieldActivityRows.matchedCustomerId,
      timelineEventWritten: sheetFieldActivityRows.timelineEventWritten,
    })
    .from(sheetFieldActivityRows)
    .where(sql`${FOLDED_ROW_NAME} = ${nameKey}`);
  if (!rows.length) return { rows: 0, timelineRemoved: 0 };

  const near =
    !decision && exact.length === 0 && rows[0].customerName
      ? await nearShopNames(rows[0].customerName)
      : [];
  const result = decideCustomerMatch({ exact: [...exact], near, decision: decision ?? null });

  let timelineRemoved = 0;
  await db.transaction(async (tx) => {
    const dropping = rows
      .filter((r) => r.timelineEventWritten && r.matchedCustomerId !== result.matchedId)
      .map((r) => r.id);
    if (dropping.length) {
      const removed = await tx
        .delete(timelineEvents)
        .where(
          and(
            eq(timelineEvents.sourceApp, "mbos"),
            eq(timelineEvents.eventType, MBOS_EVENT.visit),
            inArray(timelineEvents.sourceRecordId, dropping),
          ),
        )
        .returning({ id: timelineEvents.id });
      timelineRemoved = removed.length;
      await tx
        .update(sheetFieldActivityRows)
        .set({ timelineEventWritten: false })
        .where(inArray(sheetFieldActivityRows.id, dropping));
    }
    await tx
      .update(sheetFieldActivityRows)
      .set({
        matchedCustomerId: result.matchedId,
        customerMatchStatus: result.status,
        matchNote: result.note,
        updatedAt: new Date(),
      })
      .where(
        inArray(
          sheetFieldActivityRows.id,
          rows.map((r) => r.id),
        ),
      );
  });
  return { rows: rows.length, timelineRemoved };
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
