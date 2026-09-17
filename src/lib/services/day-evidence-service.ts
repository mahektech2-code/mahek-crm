import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { APP_TIMEZONE, asDate } from "../business-date";
import { fieldTeam } from "./sales-service";

/* ---------------------------------------------------------------------------
 * ONE SALESMAN, ONE DAY, EVERYTHING HE PHOTOGRAPHED — and what was made of it.
 *
 * The evidence a working day produces is spread across three tables by the way
 * it arrives: the selfies ride on `mbos_attendance_days.sessions`, the meters
 * ride on `mbos_travel_legs`, and whether the day's money has been settled
 * lives on `mbos_expense_days`. Nothing joined them, so verifying a day meant
 * the Attendance screen for the faces, the Travel ledger for the readings and
 * the Expenses screen for the claim — three screens, three date pickers, and
 * in practice nobody doing it.
 *
 * This is that day as one list, in the order it happened, with the verdict
 * somebody has already given on each item beside it.
 *
 * **THE ORDER IS THE DAY, not the table.** A check-in, the meter he set off
 * on, the meter he arrived on, a second check-in after lunch: read top to
 * bottom that is the morning, and read grouped by table it is two lists
 * somebody has to interleave in their head while deciding whether they agree
 * with it.
 *
 * **A PHOTOGRAPH TAKEN AND SINCE DELETED IS NOT A PHOTOGRAPH NEVER TAKEN.**
 * `mbos.attendance.selfieRetentionHours` sweeps the image and deliberately
 * leaves the id on the day for ever, so past the window this has to say which
 * of the two it is looking at. Drawing them alike would turn an ordinary
 * expired file into what reads as somebody skipping a camera, on a record a
 * payslip is read against. `photographed` and `photoAvailable` are the two
 * halves of that and no caller may collapse them.
 * ------------------------------------------------------------------------- */

const IST_DAY = sql.raw(`at time zone '${APP_TIMEZONE}'`);

export type EvidenceVerdict = "accepted" | "declined";

export type EvidenceReview = {
  verdict: EvidenceVerdict;
  remark: string | null;
  /** Odometer only: what the salesman typed, before anybody corrected it. */
  reportedKm: number | null;
  /** Odometer only: what the manager read off the photograph. */
  correctedKm: number | null;
  decidedAt: Date;
  decidedByName: string | null;
};

export type EvidenceItem = {
  /** The natural key a verdict is stored against. See the schema note. */
  ref: string;
  kind: "attendance_selfie" | "odometer";
  /** What this mark IS, in the words the screen prints. */
  label: string;
  /** When it happened. Null where the mark carries no time of its own. */
  at: Date | null;
  /** The journey or the place, for a reader who has to judge the picture. */
  context: string | null;
  /** True where a file id is recorded — whatever became of the file. */
  photographed: boolean;
  /** The id to fetch, null where there is nothing to fetch. */
  photoId: string | null;
  /** False where it was photographed and the image has since been swept. */
  photoAvailable: boolean;
  /** Odometer only: the reading as it stands on the leg RIGHT NOW. */
  km: number | null;
  sourceType: "mbos_attendance_days" | "mbos_travel_legs";
  sourceId: string;
  review: EvidenceReview | null;
};

export type DayEvidence = {
  salesmanId: string;
  salesmanName: string;
  day: string;
  items: EvidenceItem[];
  /** Null where he never opened the day at all, which is a real answer. */
  attendance: {
    checkInAt: Date | null;
    checkOutAt: Date | null;
    status: string;
    autoCheckedOut: boolean;
    withinGeofence: boolean | null;
    geofenceDistanceM: number | null;
  } | null;
  /**
   * WHAT MAY STILL BE CORRECTED, answered here rather than guessed at on the
   * screen. A reading is what the distance is worked out from, so changing one
   * after the claim has been decided would move the numbers under somebody's
   * signature. Reopening the day is the way past it and the screen names it.
   */
  claim: {
    dayId: string;
    submitted: boolean;
    locked: boolean;
    /** True once an approval step has been answered either way. */
    decided: boolean;
  } | null;
};

/**
 * Everything one salesman photographed on one day.
 *
 * Answers null for anybody outside this manager's patch, exactly as
 * `salesmanRecord` does and for the same reason: a screen that told the
 * difference between "no such person" and "not yours" would confirm to a
 * URL-guesser that an id belongs to a real account somewhere else.
 */
export async function dayEvidence(
  userId: string,
  day: string,
): Promise<DayEvidence | null> {
  const team = await fieldTeam();
  const salesman = team.find((s) => s.id === userId);
  if (!salesman) return null;

  const [attendance, legs, reviews, claim] = await Promise.all([
    /* Every instant below is typed `unknown` and read through `asDate`.
       `db.execute` hands back what the driver parsed, and for a timestamptz
       that is a STRING — annotating it `Date` is how `.toISOString is not a
       function` reaches a screen months later. */
    db.execute<{
      id: string;
      checkInAt: unknown;
      checkOutAt: unknown;
      checkInSelfieId: string | null;
      checkOutSelfieId: string | null;
      checkInAddress: string | null;
      checkOutAddress: string | null;
      status: string;
      autoCheckedOut: boolean;
      withinGeofence: boolean | null;
      geofenceDistanceM: number | null;
      sessions: {
        inAt: number;
        outAt: number | null;
        inSelfieId?: string | null;
        outSelfieId?: string | null;
      }[];
      /* Which of this day's selfies a manager can still OPEN, asked of the
         attachments table itself. The ids on the day say a photograph was
         taken and say nothing whatever about whether it still exists. */
      availableSelfieIds: string[];
    }>(sql`
      select d.id,
             d.check_in_at as "checkInAt", d.check_out_at as "checkOutAt",
             d.check_in_selfie_id as "checkInSelfieId",
             d.check_out_selfie_id as "checkOutSelfieId",
             d.check_in_address as "checkInAddress",
             d.check_out_address as "checkOutAddress",
             d.status::text as status,
             coalesce(d.auto_checked_out, false) as "autoCheckedOut",
             d.within_geofence as "withinGeofence",
             d.geofence_distance_m as "geofenceDistanceM",
             coalesce(d.sessions, '[]'::jsonb) as sessions,
             coalesce((select jsonb_agg(a.id) from attachments a
                        where a.parent_type = 'mbos_attendance'
                          and a.parent_id = d.id
                          and a.status = 'available'), '[]'::jsonb)
               as "availableSelfieIds"
        from mbos_attendance_days d
       where d.user_id = ${userId} and d.day = ${day}::date
       limit 1
    `),

    /* The day's legs. Joined through the expense day where there is one, and
       falling back to the clock where there is not: a leg opened from "Start
       visit" belongs to a day the moment it is written, but a leg typed up on
       /travel before a day exists is real evidence too, and dropping it would
       silently show a manager fewer meters than the salesman photographed. */
    db.execute<{
      id: string;
      startedAt: unknown;
      endedAt: unknown;
      modeLabel: string | null;
      modeKey: string;
      fromLabel: string | null;
      toLabel: string | null;
      customerName: string | null;
      odometerStartKm: number | null;
      odometerEndKm: number | null;
      odometerPhotoId: string | null;
      odometerEndPhotoId: string | null;
      startPhotoAvailable: boolean;
      endPhotoAvailable: boolean;
      gpsMetres: number | null;
      odometerMetres: number | null;
      origin: string;
    }>(sql`
      select l.id, l.started_at as "startedAt", l.ended_at as "endedAt",
             m.label as "modeLabel", l.mode_key as "modeKey",
             l.from_label as "fromLabel", l.to_label as "toLabel",
             c.name as "customerName",
             l.odometer_start_km as "odometerStartKm",
             l.odometer_end_km as "odometerEndKm",
             l.odometer_photo_id as "odometerPhotoId",
             l.odometer_end_photo_id as "odometerEndPhotoId",
             coalesce((select a.status = 'available' from attachments a
                        where a.id = l.odometer_photo_id), false)
               as "startPhotoAvailable",
             coalesce((select a.status = 'available' from attachments a
                        where a.id = l.odometer_end_photo_id), false)
               as "endPhotoAvailable",
             l.gps_metres as "gpsMetres", l.odometer_metres as "odometerMetres",
             l.origin
        from mbos_travel_legs l
        left join mbos_travel_modes m on m.key = l.mode_key
        left join customers c on c.id = l.customer_id
       where l.user_id = ${userId}
         and (
           l.expense_day_id in (
             select e.id from mbos_expense_days e
              where e.user_id = ${userId} and e.day = ${day}::date
           )
           or (l.expense_day_id is null
               and (l.started_at ${IST_DAY})::date = ${day}::date)
         )
       order by l.started_at asc nulls last
    `),

    db.execute<{
      sourceRef: string;
      verdict: EvidenceVerdict;
      remark: string | null;
      reportedKm: number | null;
      correctedKm: number | null;
      decidedAt: unknown;
      decidedByName: string | null;
    }>(sql`
      select r.source_ref as "sourceRef", r.verdict::text as verdict, r.remark,
             r.reported_km as "reportedKm", r.corrected_km as "correctedKm",
             r.decided_at as "decidedAt", u.name as "decidedByName"
        from mbos_evidence_reviews r
        left join users u on u.id = r.decided_by_id
       where r.user_id = ${userId} and r.day = ${day}::date
    `),

    db.execute<{
      dayId: string;
      submittedAt: unknown;
      lockedAt: unknown;
      decided: boolean;
    }>(sql`
      select e.id as "dayId", e.submitted_at as "submittedAt",
             e.locked_at as "lockedAt",
             exists (select 1 from mbos_approvals ap
                      where ap.subject_type = 'mbos_expense_days'
                        and ap.subject_id = e.id
                        and ap.state <> 'pending') as decided
        from mbos_expense_days e
       where e.user_id = ${userId} and e.day = ${day}::date
       limit 1
    `),
  ]);

  const byRef = new Map(
    reviews.map((r) => [
      r.sourceRef,
      {
        verdict: r.verdict,
        remark: r.remark,
        reportedKm: r.reportedKm,
        correctedKm: r.correctedKm,
        decidedAt: asDate(r.decidedAt)!,
        decidedByName: r.decidedByName,
      } satisfies EvidenceReview,
    ]),
  );

  const items: EvidenceItem[] = [];
  const att = attendance[0] ?? null;

  if (att) {
    const available = new Set(att.availableSelfieIds ?? []);

    /* The sessions column is the handset's own shape and is the truth about a
       day of three arrivals. A row written before it existed carries an empty
       list, and falling back to the two mirror marks is what keeps an older
       day readable rather than blank — those two columns ARE the first-in and
       last-out of the same list. */
    const sessions = (att.sessions ?? []).length
      ? att.sessions
      : asDate(att.checkInAt)
        ? [
            {
              inAt: asDate(att.checkInAt)!.getTime(),
              outAt: asDate(att.checkOutAt)?.getTime() ?? null,
              inSelfieId: att.checkInSelfieId,
              outSelfieId: att.checkOutSelfieId,
            },
          ]
        : [];

    sessions.forEach((s, i) => {
      const many = sessions.length > 1;
      items.push(
        selfieItem({
          ref: `att:${att.id}:${i}:in`,
          dayId: att.id,
          label: many ? `Check-in ${i + 1}` : "Check-in",
          at: s.inAt ? new Date(s.inAt) : null,
          context: i === 0 ? att.checkInAddress : null,
          photoId: s.inSelfieId ?? null,
          available,
          byRef,
        }),
      );

      /* A mark that has not happened yet is not a missing photograph. An open
         session has no check-out, and drawing a gap for it would accuse
         somebody of skipping a camera they have not reached. */
      if (s.outAt || s.outSelfieId) {
        items.push(
          selfieItem({
            ref: `att:${att.id}:${i}:out`,
            dayId: att.id,
            label: many ? `Check-out ${i + 1}` : "Check-out",
            at: s.outAt ? new Date(s.outAt) : null,
            context: i === sessions.length - 1 ? att.checkOutAddress : null,
            photoId: s.outSelfieId ?? null,
            available,
            byRef,
          }),
        );
      }
    });
  }

  for (const l of legs) {
    const journey = `${l.fromLabel ?? "?"} → ${l.toLabel ?? "?"}`;
    const mode = l.modeLabel ?? l.modeKey.replace(/_/g, " ");
    const context = [journey, mode, l.customerName].filter(Boolean).join(" · ");

    /* A leg with neither a reading nor a photograph at either end has no
       evidence on it to answer — a bus fare, a lift, a leg typed up from
       memory. Listing it would put rows on the screen with nothing to look at
       and a button that means nothing. */
    if (
      l.odometerStartKm === null &&
      l.odometerEndKm === null &&
      !l.odometerPhotoId &&
      !l.odometerEndPhotoId
    ) {
      continue;
    }

    if (l.odometerStartKm !== null || l.odometerPhotoId) {
      items.push({
        ref: `leg:${l.id}:start`,
        kind: "odometer",
        label: "Odometer — set off",
        at: asDate(l.startedAt),
        context,
        photographed: Boolean(l.odometerPhotoId),
        photoId: l.odometerPhotoId,
        photoAvailable: l.startPhotoAvailable,
        km: l.odometerStartKm,
        sourceType: "mbos_travel_legs",
        sourceId: l.id,
        review: byRef.get(`leg:${l.id}:start`) ?? null,
      });
    }

    if (l.odometerEndKm !== null || l.odometerEndPhotoId) {
      items.push({
        ref: `leg:${l.id}:end`,
        kind: "odometer",
        label: "Odometer — arrived",
        at: asDate(l.endedAt),
        context,
        photographed: Boolean(l.odometerEndPhotoId),
        photoId: l.odometerEndPhotoId,
        photoAvailable: l.endPhotoAvailable,
        km: l.odometerEndKm,
        sourceType: "mbos_travel_legs",
        sourceId: l.id,
        review: byRef.get(`leg:${l.id}:end`) ?? null,
      });
    }
  }

  /* Sorted by the clock, and an item with no time sinks rather than being
     dropped: a leg whose start was never stamped is still a meter somebody
     has to look at, and a row missing from this list is a photograph nobody
     ever checks. Ties keep the order they were built in, which puts a leg's
     departure above its arrival. */
  items.sort((a, b) => {
    if (!a.at && !b.at) return 0;
    if (!a.at) return 1;
    if (!b.at) return -1;
    return a.at.getTime() - b.at.getTime();
  });

  const c = claim[0] ?? null;

  return {
    salesmanId: salesman.id,
    salesmanName: salesman.name,
    day,
    items,
    attendance: att
      ? {
          checkInAt: asDate(att.checkInAt),
          checkOutAt: asDate(att.checkOutAt),
          status: att.status,
          autoCheckedOut: att.autoCheckedOut,
          withinGeofence: att.withinGeofence,
          geofenceDistanceM: att.geofenceDistanceM,
        }
      : null,
    claim: c
      ? {
          dayId: c.dayId,
          submitted: Boolean(c.submittedAt),
          locked: Boolean(c.lockedAt),
          decided: c.decided,
        }
      : null,
  };
}

function selfieItem(o: {
  ref: string;
  dayId: string;
  label: string;
  at: Date | null;
  context: string | null;
  photoId: string | null;
  available: Set<string>;
  byRef: Map<string, EvidenceReview>;
}): EvidenceItem {
  return {
    ref: o.ref,
    kind: "attendance_selfie",
    label: o.label,
    at: o.at,
    context: o.context,
    photographed: Boolean(o.photoId),
    photoId: o.photoId,
    photoAvailable: Boolean(o.photoId && o.available.has(o.photoId)),
    km: null,
    sourceType: "mbos_attendance_days",
    sourceId: o.dayId,
    review: o.byRef.get(o.ref) ?? null,
  };
}

/**
 * How many days in a row somebody's evidence is still unanswered.
 *
 * Read by the team Attendance screen so a row can carry the work rather than
 * making a manager open every person to find out which of them need him. It is
 * derived on every read and never cached: the answer changes the moment a
 * verdict is written, and a counter would be a cache with an invalidation path
 * to get wrong.
 */
export async function unreviewedCounts(day: string): Promise<Map<string, number>> {
  const rows = await db.execute<{ userId: string; outstanding: number }>(sql`
    with marks as (
      /* Every selfie the day recorded, one row per mark, taken from the
         handset's own session list. */
      select d.user_id as "userId",
             'att:' || d.id || ':' || (s.ord - 1)::text || ':in' as ref
        from mbos_attendance_days d,
             lateral jsonb_array_elements(coalesce(d.sessions, '[]'::jsonb))
               with ordinality as s(value, ord)
       where d.day = ${day}::date
      union all
      select d.user_id, 'att:' || d.id || ':' || (s.ord - 1)::text || ':out'
        from mbos_attendance_days d,
             lateral jsonb_array_elements(coalesce(d.sessions, '[]'::jsonb))
               with ordinality as s(value, ord)
       where d.day = ${day}::date
         and (s.value ->> 'outAt' is not null or s.value ->> 'outSelfieId' is not null)
      union all
      select l.user_id, 'leg:' || l.id || ':start'
        from mbos_travel_legs l
       where (l.started_at ${IST_DAY})::date = ${day}::date
         and (l.odometer_start_km is not null or l.odometer_photo_id is not null)
      union all
      select l.user_id, 'leg:' || l.id || ':end'
        from mbos_travel_legs l
       where (l.started_at ${IST_DAY})::date = ${day}::date
         and (l.odometer_end_km is not null or l.odometer_end_photo_id is not null)
    )
    select marks."userId" as "userId", count(*)::int as outstanding
      from marks
     where not exists (
       select 1 from mbos_evidence_reviews r where r.source_ref = marks.ref
     )
     group by marks."userId"
  `);
  return new Map(rows.map((r) => [r.userId, r.outstanding]));
}
