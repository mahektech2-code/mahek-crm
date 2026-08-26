import "server-only";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { sheetFieldActivityRows } from "@/db/schema";
import { writeTimelineEvents, type TimelineEventInput } from "@/lib/timeline";

/* ---------------------------------------------------------------------------
 * Matched rows -> `timeline_events`, which is how this backfill reaches a
 * customer's shared history and, through the MBOS `timeline` pull channel, a
 * salesman's phone — without pretending to be a live visit or a telecaller
 * call. See `sheet_field_activity_rows`'s own doc comment in schema.ts.
 *
 * `eventType: "visit"` — the SAME string live MBOS check-ins use
 * (`lib/actions/mbos.ts`) — deliberately, not a distinct historical type. The
 * mobile app's rendering falls back to a generic "Visit" label for any
 * `eventType` it does not recognise, so a distinct type would need an app
 * change AND a rebuild before it read correctly on any phone. The SUMMARY
 * sentence is what actually discloses this is history, not a live check-in.
 * ------------------------------------------------------------------------- */

const EVENT_TYPE = "visit";
const SOURCE_APP = "mbos" as const;
const BATCH = 500;

function summaryFor(row: {
  meetingPurpose: string | null;
  meetingNote: string | null;
  issueNote: string | null;
}): string {
  const detail = [row.meetingNote, row.issueNote].filter(Boolean).join(". ");
  const purpose = row.meetingPurpose ? `${row.meetingPurpose}` : "Visit";
  const opening = `Past visit (before this app) — ${purpose}`;
  const text = detail ? `${opening}: ${detail}` : opening;
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}

/**
 * Noon IST for a date-only value, so this survives the session-timezone
 * cast bugs the rest of this codebase is careful about — never a bare
 * `::timestamptz` on a date.
 */
function noonIst(isoDate: string): Date {
  return new Date(`${isoDate}T12:00:00+05:30`);
}

export type ProjectionResult = { written: number; skipped: number; scanned: number };

/**
 * Every matched, not-yet-projected row -> a `timeline_events` entry.
 *
 * Run separately from the sync itself (a `--project` step, mirroring
 * `project-sheet --bills`) rather than automatically on every sync — a
 * batch imported from a sheet is visible before it is believed, the same
 * discipline `sheetSyncRuns.feedsCrm` states explicitly for the order sheet.
 * Here that decision is per-row rather than per-batch: only a row with a
 * real matched customer can produce an entry at all, and unmatched or
 * ambiguous rows are simply never eligible — never something a flag has to
 * hold back.
 */
export async function projectFieldActivityTimeline(): Promise<ProjectionResult> {
  let written = 0;
  let scanned = 0;
  let after = "";

  for (;;) {
    const page = await db
      .select({
        id: sheetFieldActivityRows.id,
        matchedCustomerId: sheetFieldActivityRows.matchedCustomerId,
        matchedSalesmanId: sheetFieldActivityRows.matchedSalesmanId,
        visitDate: sheetFieldActivityRows.visitDate,
        meetingPurpose: sheetFieldActivityRows.meetingPurpose,
        meetingNote: sheetFieldActivityRows.meetingNote,
        issueNote: sheetFieldActivityRows.issueNote,
      })
      .from(sheetFieldActivityRows)
      .where(
        and(
          eq(sheetFieldActivityRows.customerMatchStatus, "matched"),
          eq(sheetFieldActivityRows.timelineEventWritten, false),
          isNotNull(sheetFieldActivityRows.matchedCustomerId),
          after ? sql`${sheetFieldActivityRows.id} > ${after}` : undefined,
        ),
      )
      .orderBy(sheetFieldActivityRows.id)
      .limit(BATCH);

    if (!page.length) break;
    scanned += page.length;
    after = page[page.length - 1].id;

    // A row with no readable date has nothing to occur AT — held out of the
    // timeline rather than backdated to an invented moment. It stays a full
    // staging record either way; only the projection skips it.
    const eligible = page.filter((r) => r.matchedCustomerId && r.visitDate);

    const events: TimelineEventInput[] = eligible.map((r) => ({
      customerId: r.matchedCustomerId!,
      eventType: EVENT_TYPE,
      sourceApp: SOURCE_APP,
      sourceRecordId: r.id,
      occurredAt: noonIst(r.visitDate!),
      actorUserId: r.matchedSalesmanId,
      summary: summaryFor(r),
    }));

    if (events.length) {
      written += await writeTimelineEvents(db, events);
      await db
        .update(sheetFieldActivityRows)
        .set({ timelineEventWritten: true, updatedAt: new Date() })
        .where(
          inArray(
            sheetFieldActivityRows.id,
            eligible.map((r) => r.id),
          ),
        );
    }
  }

  return { written, skipped: scanned - written, scanned };
}
