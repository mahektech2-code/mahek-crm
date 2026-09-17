import Link from "next/link";
import { APP_TIMEZONE, addDays } from "@/lib/business-date";
import { today } from "@/lib/recompute";
import { attendanceForDay } from "@/lib/services/sales-service";
import { unreviewedCounts } from "@/lib/services/day-evidence-service";
import { getSetting } from "@/lib/config/store";
import {
  Banner,
  Cell,
  Empty,
  EntityLink,
  HeadCell,
  MetricRow,
  Pill,
  Row,
  ScreenHeader,
  SortHead,
  Table,
} from "@/components/console/parts";
import {
  plural,
} from "@/components/console/words";
import { readSort, sortHref, sortRows, type SortColumns } from "@/components/console/sort";
import { Selfies } from "./selfies";
import { DayCheckDialog } from "./day-check";

export const metadata = { title: "Attendance — Sales Dashboard — MahekOne" };

/**
 * Who started the day, when, and from where.
 *
 * **This is not the sign-in log.** MahekOne's `attendance` table is a misnomer
 * kept until the real thing took it — it records that somebody opened the app,
 * from home, on a phone, at 2am. This is the punch-in system, and on a screen
 * a manager might pay somebody from, the difference is the whole point.
 *
 * Everybody appears, including those who never checked in. A missing row IS
 * the fact worth seeing, and a list of only the people who turned up cannot
 * answer the question the screen exists for.
 *
 * A punch-in outside the permitted radius is FLAGGED and never blocked: a
 * salesman who cannot mark attendance cannot work, so the handset lets him in
 * and records where he was.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ day?: string; sort?: string; dir?: string }>;
}) {
  const params = await searchParams;
  const now = await today();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(params.day ?? "") ? params.day! : now;

  const [rows, outstanding, retentionHours] = await Promise.all([
    attendanceForDay(day),
    /* What each person's day still has unanswered, so the roll-call can carry
       the work rather than making somebody open eleven people to find the two
       who need him. */
    unreviewedCounts(day),
    getSetting("mbos.attendance.selfieRetentionHours"),
  ]);

  /* The sort is read off the URL and the DAY is carried through it, because the
     two are independent questions about this screen and the day is the one
     somebody has already answered. A sort link that dropped it would step the
     reader silently back to today, which is the worst way to lose a page: the
     table redraws, nothing says it moved, and the row he was about to open is
     a different person's.

     The figures in the MetricRow below are counted over `rows`, the WHOLE
     roll-call, and go on being — sorting reorders a list, it does not change
     what is in it, and a metric that moved when somebody clicked a column
     would be the screen disagreeing with itself. */
  const sort = readSort(params, COLUMNS);
  const sorted = sortRows(rows, sort, COLUMNS);
  const head = (key: string, label: string, width?: number, align?: "left" | "right") => (
    <SortHead
      width={width}
      align={align}
      href={sortHref("/sales/attendance", sort, key, `day=${day}`)}
      active={sort.key === key}
      dir={sort.dir}
    >
      {label}
    </SortHead>
  );

  const inToday = rows.filter((r) => r.checkInAt);
  const missing = rows.filter((r) => !r.checkInAt);
  const offSite = rows.filter((r) => r.withinGeofence === false);
  const corrections = rows.filter((r) => r.regularisationRequested);
  const openDays = rows.filter((r) => r.checkInAt && !r.checkOutAt);
  const toCheck = rows.filter((r) => (outstanding.get(r.salesmanId) ?? 0) > 0);

  return (
    <div className="p-6">
      <ScreenHeader
        title="Attendance"
        subtitle={`Who punched in and from where. A punch-in outside the permitted radius is flagged, never blocked — a salesman who cannot mark attendance cannot work. Photographs are kept for ${retentionWords(retentionHours)} and then deleted.`}
        actions={
          <div className="flex items-center gap-1 text-[13px]">
            <Link
              href={`/sales/attendance?day=${addDays(day, -1)}`}
              className="rounded-[4px] border border-line bg-surface px-2.5 py-1.5 text-body no-underline hover:bg-canvas hover:no-underline"
            >
              ←
            </Link>
            <span className="px-2 text-muted">{longDay(day)}</span>
            <Link
              href={`/sales/attendance?day=${addDays(day, 1)}`}
              className="rounded-[4px] border border-line bg-surface px-2.5 py-1.5 text-body no-underline hover:bg-canvas hover:no-underline"
            >
              →
            </Link>
          </div>
        }
      />

      {missing.length ? (
        <Banner
          tone="warn"
          title={`${plural(missing.length, "salesman", "salesmen")} ${missing.length === 1 ? "has" : "have"} not checked in`}
          body={`${missing.map((m) => m.salesmanName).join(", ")}. Nothing refused them — they have either not opened the app or not pressed the button.`}
        />
      ) : null}

      <MetricRow
        metrics={[
          { label: "Punched in", value: `${inToday.length} of ${rows.length}` },
          {
            label: "Never started",
            value: String(missing.length),
            tone: missing.length ? "warn" : undefined,
          },
          {
            label: "Off site",
            value: String(offSite.length),
            sub: offSite.length ? "flagged, not blocked" : undefined,
          },
          {
            label: "Still open",
            value: String(openDays.length),
            sub: "no punch-out yet",
          },
          {
            label: "Corrections asked for",
            value: String(corrections.length),
            tone: corrections.length ? "warn" : undefined,
          },
          {
            label: "Photographs to check",
            value: String([...outstanding.values()].reduce((n, v) => n + v, 0)),
            tone: toCheck.length ? "warn" : undefined,
            sub: toCheck.length
              ? `across ${toCheck.length === 1 ? "one day" : `${toCheck.length} days`}`
              : "every one is answered",
          },
        ]}
      />

      {rows.length === 0 ? (
        <Empty
          title="Nobody holds the Salesman App"
          body="The field team is whoever has been granted it. Grant it on the Access screen in the Admin Console."
        />
      ) : (
        <Table
          minWidth={1530}
          head={
            <>
              {head("name", "Salesman", 200)}
              {head("in", "In", 130)}
              {head("out", "Out", 130)}
              {head("worked", "Worked", 130)}
              {head("visits", "Visits", 100, "right")}
              {head("verdict", "Verdict", 150)}
              {/* Deliberately beside the times rather than at the end: the
                  photograph is what the two times either side of it are worth,
                  and a column somebody has to scroll to is one they stop
                  checking by the second week. */}
              <HeadCell width={230}>Photographs</HeadCell>
              {/* THE VERIFICATION ITSELF, over the list it was asked from —
                  and it is the SAME component the person's record draws, not a
                  second copy of it, so there is still only one set of controls
                  to keep in step. Photographs, Notes and this one are not
                  sortable: none of the three is a value a row can be ranked by,
                  and a header that invites a click and then reorders nothing
                  teaches people the whole row of them is decorative. */}
              <HeadCell width={140}>Day check</HeadCell>
              <HeadCell>Notes</HeadCell>
            </>
          }
        >
          {sorted.map((r, i) => (
            <Row key={r.id} striped={i % 2 === 1}>
              <Cell truncate={200}>
                <EntityLink href={`/sales/people/${r.salesmanId}`}>
                  {r.salesmanName}
                </EntityLink>
              </Cell>
              <Cell>
                {r.checkInAt ? (
                  clock(r.checkInAt)
                ) : (
                  <span className="text-danger">Not started</span>
                )}
              </Cell>
              <Cell>
                {r.checkOutAt ? (
                  <>
                    {clock(r.checkOutAt)}
                    {r.autoCheckedOut ? (
                      <span
                        className="block text-[12px] text-warn-ink"
                        title="Closed by the nightly sweep because nobody checked out. The duration is deliberately not invented."
                      >
                        closed for them
                      </span>
                    ) : null}
                  </>
                ) : r.checkInAt ? (
                  <span className="text-muted">Still open</span>
                ) : (
                  <span className="text-muted">—</span>
                )}
              </Cell>
              <Cell>
                {r.workedSeconds != null ? (
                  `${Math.floor(r.workedSeconds / 3600)}h ${String(
                    Math.round((r.workedSeconds % 3600) / 60),
                  ).padStart(2, "0")}m`
                ) : (
                  <span className="text-muted">—</span>
                )}
              </Cell>
              <Cell align="right">{r.visits || <span className="text-muted">—</span>}</Cell>
              <Cell>
                <Pill
                  tone={
                    r.status === "present"
                      ? "success"
                      : r.status === "absent"
                        ? "danger"
                        : r.status === "on_leave"
                          ? "brand"
                          : "warn"
                  }
                >
                  {r.status.replace(/_/g, " ")}
                </Pill>
              </Cell>
              <Cell>
                <Selfies row={r} />
              </Cell>
              {/* The day is CHECKED HERE, over the list it was asked from. It
                  used to be a link into a nine-tab record of a MONTH, to answer
                  a question about one person on one day, with the browser's own
                  Back button as the way home — so checking three people cost
                  three navigations out and three back, which is how the check
                  quietly stops being done. The dialog draws its own trigger and
                  its own "not looked at yet" line, so neither is repeated
                  here. */}
              <Cell>
                <DayCheckDialog
                  salesmanId={r.salesmanId}
                  salesmanName={r.salesmanName}
                  day={day}
                  longDay={longDay(day)}
                  today={now}
                  retentionHours={retentionHours}
                  outstanding={outstanding.get(r.salesmanId) ?? 0}
                />
              </Cell>
              <Cell truncate={340} title={r.regularisationReason ?? undefined}>
                {r.withinGeofence === false ? (
                  <span className="mr-1.5">
                    <Pill tone="warn">
                      Off site
                      {r.geofenceDistanceM ? ` · ${r.geofenceDistanceM}m` : ""}
                    </Pill>
                  </span>
                ) : null}
                {r.regularisationRequested ? <Pill tone="brand">Correction asked for</Pill> : null}
                {r.regularisationReason ? (
                  <span className="block truncate text-[12px] text-muted">
                    “{r.regularisationReason}”
                  </span>
                ) : null}
              </Cell>
            </Row>
          ))}
        </Table>
      )}

      {/*
        WHY AN OLDER DAY HAS NO PHOTOGRAPHS, said on the screen rather than left
        to be worked out. A manager who steps back a week and finds the column
        empty has two readings available — the team stopped photographing, or
        the app is broken — and both are wrong. Printed whatever day is being
        looked at, because the rule is the same on all of them and a sentence
        that appears only on old days is one nobody reads until they are
        confused.
      */}
      {rows.length ? (
        <p className="mt-3 text-[13px] text-muted">
          A photograph is taken at every punch-in and every punch-out, and is
          deleted {retentionWords(retentionHours)} after it reaches the office.
          The punch-in itself, its time and its place are kept — only the image
          goes, so an older day shows when somebody arrived and no longer shows
          their face.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The window in the unit somebody thinks in. A round number of days is how the
 * team says it; anything else stays in hours rather than being rounded into a
 * figure that disagrees with the setting.
 */
function retentionWords(hours: number): string {
  if (hours % 24 === 0) {
    const days = hours / 24;
    return days === 1 ? "24 hours" : `${days} days`;
  }
  return `${hours} hours`;
}


function longDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
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

/**
 * What each sortable column is worth.
 *
 * `null` sorts last in both directions, which is the point on this screen: a
 * salesman who never punched in has no time, no duration and no visits, and
 * floating him to the top of "latest in" would put the row that answers the
 * question least where the eye goes first. His absence is said in the banner
 * above the table, which is where it belongs.
 *
 * The times are compared as INSTANTS rather than as the strings the clock
 * prints. Those are wall-clock in Asia/Kolkata and would sort a punch-in at
 * 23:50 above one at 00:10 the same night, which reads as the list being
 * wrong rather than as a day boundary.
 */
const COLUMNS: SortColumns<{
  salesmanName: string;
  checkInAt: Date | string | null;
  checkOutAt: Date | string | null;
  workedSeconds: number | null;
  visits: number;
  status: string;
}> = {
  name: (r) => r.salesmanName,
  in: (r) => (r.checkInAt ? new Date(r.checkInAt).getTime() : null),
  out: (r) => (r.checkOutAt ? new Date(r.checkOutAt).getTime() : null),
  worked: (r) => r.workedSeconds,
  visits: (r) => r.visits,
  verdict: (r) => r.status,
};
