import Link from "next/link";
import { APP_TIMEZONE, addDays } from "@/lib/business-date";
import { today } from "@/lib/recompute";
import { attendanceForDay } from "@/lib/services/sales-service";
import {
  Banner,
  Cell,
  Empty,
  HeadCell,
  MetricRow,
  Pill,
  Row,
  ScreenHeader,
  Table,
} from "../parts";
import {
  plural,
} from "../words";

export const metadata = { title: "Attendance — Sales Dashboard — MahekOne" };

/**
 * Who started the day, when, and from where.
 *
 * **This is not the sign-in log.** MahekOne's `attendance` table is a misnomer
 * kept until the real thing took it — it records that somebody opened the app,
 * from home, on a phone, at 2am. This is the check-in system, and on a screen
 * a manager might pay somebody from, the difference is the whole point.
 *
 * Everybody appears, including those who never checked in. A missing row IS
 * the fact worth seeing, and a list of only the people who turned up cannot
 * answer the question the screen exists for.
 *
 * A check-in outside the permitted radius is FLAGGED and never blocked: a
 * salesman who cannot mark attendance cannot work, so the handset lets him in
 * and records where he was.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ day?: string }>;
}) {
  const params = await searchParams;
  const now = await today();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(params.day ?? "") ? params.day! : now;

  const rows = await attendanceForDay(day);

  const inToday = rows.filter((r) => r.checkInAt);
  const missing = rows.filter((r) => !r.checkInAt);
  const offSite = rows.filter((r) => r.withinGeofence === false);
  const corrections = rows.filter((r) => r.regularisationRequested);
  const openDays = rows.filter((r) => r.checkInAt && !r.checkOutAt);

  return (
    <div className="p-6">
      <ScreenHeader
        title="Attendance"
        subtitle="Who started the day and from where. A check-in outside the permitted radius is flagged, never blocked — a salesman who cannot mark attendance cannot work."
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
          { label: "Checked in", value: `${inToday.length} of ${rows.length}` },
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
            sub: "no check-out yet",
          },
          {
            label: "Corrections asked for",
            value: String(corrections.length),
            tone: corrections.length ? "warn" : undefined,
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
          minWidth={1160}
          head={
            <>
              <HeadCell width={200}>Salesman</HeadCell>
              <HeadCell width={130}>In</HeadCell>
              <HeadCell width={130}>Out</HeadCell>
              <HeadCell width={130}>Worked</HeadCell>
              <HeadCell align="right" width={100}>Visits</HeadCell>
              <HeadCell width={150}>Verdict</HeadCell>
              <HeadCell>Notes</HeadCell>
            </>
          }
        >
          {rows.map((r, i) => (
            <Row key={r.id} striped={i % 2 === 1}>
              <Cell truncate={200}>
                <Link
                  href={`/sales/people/${r.salesmanId}`}
                  className="font-medium text-ink no-underline"
                >
                  {r.salesmanName}
                </Link>
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
    </div>
  );
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
