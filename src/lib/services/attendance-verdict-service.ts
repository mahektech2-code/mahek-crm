import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getConfig } from "@/lib/config/store";
import {
  attendanceVerdict,
  type AttendanceSession,
  type AttendanceStatus,
} from "@/lib/engines/attendance";

/* ---------------------------------------------------------------------------
 * THE JOB `handleAttendance` DEFERS TO, finally written.
 *
 * The sync handler's own comment says `workedSeconds` and `status` are "derived
 * caches a job rebuilds from the two marks rather than values this may type",
 * and it was right to decline — a handset that could type its own verdict is a
 * handset that can type its own pay. What was missing was the other half: no
 * job existed, so every row in the table read `absent` with no hours against
 * it, on days carrying a check-in, a check-out and two selfies. Three screens
 * drew a red pill saying so.
 *
 * `lib/engines/attendance.ts` is the rule and this is the wiring: read the
 * rows, ask the leave register and the holiday calendar, and write back only
 * what changed.
 *
 * **IT IS A CACHE, SO IT IS REBUILT AND NEVER TYPED.** Nothing else in
 * MahekOne may write these two columns — not the handset, not a screen, not a
 * regularisation. A verdict somebody disagrees with is corrected by correcting
 * the day (the marks, the leave, the calendar) and letting this run, which is
 * the discipline outstanding, the buying cycle and the slow-payer flag already
 * keep. It is deliberately NOT the same kind of column as `calls.next_step_*`,
 * which records what somebody was TOLD on a day and must never be rebuilt:
 * this is a reading of the present, so a rebuild is a correction rather than a
 * destruction.
 *
 * **A WRITE THAT CHANGES NOTHING IS STILL A WRITE.** This runs over every
 * attendance day there has ever been, on a schedule, for ever — and a verdict
 * that settled in March does not move in September. So both columns are
 * compared against what is stored and a row that would be rewritten
 * identically is skipped, with `is distinct from` rather than `<>` because
 * `worked_seconds` is nullable and `null <> null` is null, which would defeat
 * the comparison on precisely the rows that have never been written. Postgres
 * has no in-place update: on a 961 MB droplet, ten thousand no-op tuples a
 * night is ten thousand WAL records and dirty pages evicting the page cache to
 * say nothing. `updated_at` is outside the comparison and moves only when
 * something else did — the same rule PR #407 settled for the projection.
 *
 * **THE GATE IS THE OUTPUT, never a hash of the inputs.** What this writes
 * depends on the sessions AND on the thresholds AND on an approval somebody
 * may have given this morning for leave taken last week AND on a holiday added
 * to the calendar afterwards. A rule keyed on the attendance row alone would
 * silently stop rewriting days the moment any of the other three moved, which
 * is the one failure a derived cache cannot afford, because nothing anywhere
 * looks wrong.
 * ------------------------------------------------------------------------- */

type VerdictRow = {
  id: string;
  sessions: AttendanceSession[] | null;
  checkInAt: string | null;
  checkOutAt: string | null;
  onApprovedLeave: boolean;
  isHoliday: boolean;
};

export type VerdictRebuild = {
  /** Rows actually rewritten. On a converged table this is near zero. */
  written: number;
  /** Rows considered — read, judged, and mostly found already correct. */
  read: number;
  /**
   * Rows the engine would not judge: a session still open. Today's days while
   * they are being worked, and the past days `markMissedCheckouts` could not
   * close because MahekOne holds no evidence of when the man stopped. Counted
   * rather than passed over in silence, because a number that stops falling
   * after a day or two is a handset that is not reporting its check-outs.
   */
  unjudged: number;
};

/**
 * Rebuild the verdict and the hours for a window of days, or for every day
 * there is.
 *
 * `from`/`to` are business dates (`YYYY-MM-DD`) and both ends are counted.
 * Omitting them reads the whole table, which is what the nightly does: a
 * retroactively approved leave request, a holiday added to the calendar, or a
 * changed threshold all reach back into days already judged, and only a full
 * pass carries the correction to them. It is affordable precisely because of
 * the comparison above — a pass over a converged table writes nothing.
 */
export async function recomputeAttendanceVerdicts(
  window?: { from: string; to: string },
): Promise<VerdictRebuild> {
  const config = await getConfig();
  const thresholds = {
    fullDayHours: config["mbos.attendance.fullDayHours"],
    halfDayHours: config["mbos.attendance.halfDayHours"],
  };

  /* Raw, because both the leave and the holiday are EXISTS subqueries against
     the outer row's day and user, and every column of the outer table is
     qualified — Drizzle renders a bare `"day"` inside a correlated subquery,
     which binds to the inner table and quietly answers false. AGENTS.md has
     the whole story; it shipped once already.

     Approved leave is read the same way `leaveRequests` reads it — an approval
     row of type `leave` in state `approved`, with the request not withdrawn —
     rather than a second opinion about what "approved" means. */
  const scope = window
    ? sql`and d.day between ${window.from}::date and ${window.to}::date`
    : sql``;

  const rows = (await db.execute<VerdictRow>(sql`
    select d.id,
           d.sessions,
           d.check_in_at as "checkInAt",
           d.check_out_at as "checkOutAt",
           exists (select 1
                     from mbos_leave_requests l
                     join mbos_approvals ap
                       on ap.subject_id = l.id
                      and ap.type = 'leave'
                      and ap.state = 'approved'
                    where l.user_id = d.user_id
                      and l.cancelled_at is null
                      and l.from_date <= d.day
                      and l.to_date >= d.day) as "onApprovedLeave",
           exists (select 1 from mbos_holidays h where h.on_date = d.day) as "isHoliday"
      from mbos_attendance_days d
     where true ${scope}
     order by d.day
  `)) as unknown as VerdictRow[];

  const pending: { id: string; workedSeconds: number; status: AttendanceStatus }[] = [];
  let unjudged = 0;

  for (const row of rows) {
    const verdict = attendanceVerdict(
      {
        sessions: row.sessions ?? [],
        checkInAt: millis(row.checkInAt),
        checkOutAt: millis(row.checkOutAt),
        onApprovedLeave: row.onApprovedLeave,
        isHoliday: row.isHoliday,
      },
      thresholds,
    );

    /* No verdict, so nothing is written — not the hours and not the status.
       The row keeps what it holds, which for a day still being worked is the
       honest answer and for the day nobody closed is the same refusal
       `markMissedCheckouts` already makes about its closing time. */
    if (verdict.status == null || verdict.workedSeconds == null) {
      unjudged++;
      continue;
    }

    pending.push({
      id: row.id,
      workedSeconds: verdict.workedSeconds,
      status: verdict.status,
    });
  }

  let written = 0;
  for (let i = 0; i < pending.length; i += CHUNK) {
    written += await writeVerdicts(pending.slice(i, i + CHUNK));
  }

  return { written, read: rows.length, unjudged };
}

/**
 * One statement per chunk rather than one per row.
 *
 * A full pass is every attendance day the company has, which grows by a row
 * per salesman per working day for ever — at a round trip each that is minutes
 * of latency to write nothing. The chunk is bounded because a `values` list is
 * parameters and Postgres has a ceiling on those.
 */
const CHUNK = 500;

async function writeVerdicts(
  batch: { id: string; workedSeconds: number; status: AttendanceStatus }[],
): Promise<number> {
  if (batch.length === 0) return 0;

  /* Every parameter is cast. An untyped parameter in a `values` list is
     resolved by Postgres from whatever it sits beside, which this codebase has
     already paid for twice in the MBOS delta — and here it would sit beside an
     enum, which has no implicit cast from text at all. */
  const tuples = batch.map(
    (row) =>
      sql`(${row.id}::text, ${row.workedSeconds}::int, ${row.status}::mbos_attendance_status)`,
  );

  const updated = await db.execute<{ id: string }>(sql`
    update mbos_attendance_days d
       set worked_seconds = v.worked_seconds,
           status = v.status,
           updated_at = now()
      from (values ${sql.join(tuples, sql`, `)}) as v(id, worked_seconds, status)
     where d.id = v.id
       and (d.worked_seconds is distinct from v.worked_seconds
            or d.status is distinct from v.status)
    returning d.id
  `);

  return updated.length;
}

/**
 * A timestamp off `db.execute` is a STRING however the type reads, so it is
 * parsed here rather than trusted. An ISO instant carries its own zone, which
 * is why this is not the bare-cast rule in different clothes — nothing is
 * truncated to a day anywhere in this file.
 */
function millis(value: string | null): number | null {
  if (!value) return null;
  const at = new Date(value).getTime();
  return Number.isFinite(at) ? at : null;
}
