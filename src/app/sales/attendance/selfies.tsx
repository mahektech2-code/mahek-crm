import { APP_TIMEZONE } from "@/lib/business-date";
import type { AttendanceRow } from "@/lib/services/sales-service";

/**
 * The photographs behind a day, for a manager to verify it with.
 *
 * **ONE PER MARK, never one per day.** A salesman breaks for lunch and comes
 * out again in the evening, so a day is a list of arrivals and departures and
 * each end of each session was photographed. Showing the day's first selfie
 * alone would verify that he arrived in the morning and assert nothing
 * whatever about the two marks that decide the hours — which is the half the
 * pay is worked out from.
 *
 * **A DELETED PHOTOGRAPH IS SAID, not left blank.** The image is swept after
 * `mbos.attendance.selfieRetentionHours`; the id stays on the day for ever.
 * So this screen has three things to draw and they are three different facts:
 * a photograph you can open, a photograph that was taken and has since been
 * deleted, and a mark with no photograph against it at all. Drawing the
 * second and the third alike would turn an ordinary expired file into what
 * looks like somebody skipping the camera — on the record a payslip is read
 * against, which is exactly where a wrong impression costs the most.
 *
 * The thumbnail is the FILE, not a resized copy: there is no thumbnailing
 * service here and one would be a subsystem to answer a question about
 * forty-eight-pixel squares. They are lazy, so a day of twelve people costs
 * nothing until somebody scrolls to them, and `/api/attachments/[id]` checks
 * `canReadAttendanceSelfie` on every one — a manager sees his own team's and
 * nobody else's, and a salesman only ever sees himself.
 */
export function Selfies({ row }: { row: AttendanceRow }) {
  const available = new Set(row.availableSelfieIds ?? []);

  /* Both ends of every session, flattened in the order they happened, so the
     strip reads left to right as the day was actually worked. */
  const marks = (row.sessions ?? []).flatMap((s) => [
    { kind: "In" as const, at: s.inAt, id: s.inSelfieId },
    { kind: "Out" as const, at: s.outAt, id: s.outSelfieId },
  ]);

  /* A mark that has not happened yet is not a missing photograph. An open
     session has no check-out, and drawing a gap for it would accuse somebody
     of skipping a camera they have not reached. */
  const happened = marks.filter((m) => m.at || m.id);

  if (!happened.length) {
    return (
      <span className="text-muted">
        {row.checkInAt ? "None taken" : "—"}
      </span>
    );
  }

  const expired = happened.filter((m) => m.id && !available.has(m.id)).length;

  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {happened.map((m, i) => {
        const label = `${m.kind}${m.at ? ` · ${clock(m.at)}` : ""}`;

        if (m.id && available.has(m.id)) {
          return (
            <a
              key={`${m.kind}-${i}`}
              href={`/api/attachments/${m.id}`}
              target="_blank"
              rel="noreferrer"
              title={`${label} — open the full photograph`}
              className="block rounded-[4px] border border-line hover:border-brand"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/attachments/${m.id}`}
                alt={`${row.salesmanName}, ${label}`}
                loading="lazy"
                className="h-10 w-10 rounded-[3px] object-cover"
              />
            </a>
          );
        }

        return (
          <span
            key={`${m.kind}-${i}`}
            title={
              m.id
                ? `${label} — photographed, and the image has since been deleted`
                : `${label} — no photograph was taken`
            }
            className={
              "flex h-10 w-10 items-center justify-center rounded-[4px] border border-dashed text-[10px] leading-[11px] " +
              (m.id ? "border-line text-muted" : "border-warn-edge text-warn-ink")
            }
          >
            {m.id ? "gone" : "none"}
          </span>
        );
      })}

      {expired ? (
        <span className="text-[12px] text-muted">
          {expired === happened.length
            ? "deleted after their window"
            : `${expired} deleted`}
        </span>
      ) : null}
    </span>
  );
}

/** Named, because this renders on a server that is not in Asia/Kolkata. */
function clock(at: Date | string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(at));
}
