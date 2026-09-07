import Link from "next/link";
import { money, shortDate } from "@/lib/format";
import { today } from "@/lib/recompute";
import { endOfMonth } from "@/lib/business-date";
import { travelLedger } from "@/lib/services/expense-service";
import { getConfig } from "@/lib/config/store";
import { MonthNav } from "@/components/ui/month-nav";
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
import { plural } from "../words";

export const metadata = { title: "Travel ledger — Sales Dashboard — MahekOne" };

const km = (metres: number | null) =>
  metres === null ? null : `${(metres / 1000).toFixed(1)} km`;

/**
 * Requirement 25 — every movement, and how far it was.
 *
 * **All three distances, side by side.** A ledger printing only the one that
 * was paid on cannot answer requirement 19's question at all, and the manager
 * reading this screen is exactly the person who needs to see that a leg read
 * 60 km on the dial and 6 km on the phone. Which one the money went on is a
 * column of its own, because "40 km" and "40 km, on the odometer, against a
 * track that saw 38" are different facts.
 *
 * The GPS column says its METHOD and its coverage. A trail sampled every few
 * minutes cuts every corner and reads short, so a figure presented bare would
 * quietly accuse whoever covered the most ground.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; who?: string }>;
}) {
  const params = await searchParams;
  const now = await today();
  const month = /^\d{4}-\d{2}$/.test(params.month ?? "") ? params.month! : now.slice(0, 7);
  const from = `${month}-01`;
  const to = endOfMonth(month);

  const [rows, config] = await Promise.all([
    travelLedger(from, to, params.who),
    getConfig(),
  ]);

  const fixEverySeconds = config["mbos.location.trackEverySeconds"];
  const totalMetres = rows.reduce((n, r) => n + (r.chosenMetres ?? 0), 0);
  const totalPaise = rows.reduce((n, r) => n + Number(r.eligiblePaise ?? 0), 0);
  const disagreeing = rows.filter((r) => r.varianceBps !== null && r.varianceBps > 2500);
  const unmeasured = rows.filter((r) => r.chosenMetres === null);

  return (
    <div className="p-6">
      <ScreenHeader
        title="Travel ledger"
        subtitle="Every leg the field recorded, with the odometer, the day's GPS track and anything entered by hand beside each other. The track takes a fix every few minutes, so it cuts corners and reads SHORT — it is the cross-check, not the measurement."
        actions={<MonthNav month={month} basePath="/sales/travel" />}
      />

      {disagreeing.length ? (
        <Banner
          tone="warn"
          title={`${plural(disagreeing.length, "leg")} where the odometer and the track disagree by more than 25%`}
          body="A disagreement is a question, not an accusation — a phone left in a bag reads short, and a dial read at the wrong moment reads long. Each of these is on the exceptions list with the numbers behind it."
        />
      ) : null}

      {unmeasured.length ? (
        <Banner
          tone="warn"
          title={`${plural(unmeasured.length, "leg")} with no distance at all`}
          body="No odometer pair, no usable GPS track and nothing typed. These are recorded and worth nothing, which is almost never what was meant."
        />
      ) : null}

      <MetricRow
        metrics={[
          { label: "Legs", value: String(rows.length) },
          { label: "Distance paid on", value: km(totalMetres) ?? "—" },
          { label: "Travel reimbursed", value: money(totalPaise) },
          {
            label: "Distances disagreeing",
            value: String(disagreeing.length),
            tone: disagreeing.length ? "warn" : undefined,
          },
        ]}
      />

      {rows.length === 0 ? (
        <Empty
          title="No travel recorded this month"
          body={`Legs are recorded on the handset as the salesman moves. A position is taken every ${fixEverySeconds} seconds while somebody is checked in, and the distance is worked out when the day is submitted.`}
        />
      ) : (
        <Table
          minWidth={1500}
          head={
            <>
              <HeadCell width={110}>Day</HeadCell>
              <HeadCell width={150}>Salesman</HeadCell>
              <HeadCell width={130}>Mode</HeadCell>
              <HeadCell width={230}>From → to</HeadCell>
              <HeadCell width={130}>Purpose</HeadCell>
              <HeadCell width={170}>Customer</HeadCell>
              <HeadCell align="right" width={130}>Odometer</HeadCell>
              <HeadCell align="right" width={170}>GPS track</HeadCell>
              <HeadCell align="right" width={110}>By hand</HeadCell>
              <HeadCell align="right" width={150}>Paid on</HeadCell>
              <HeadCell align="right" width={120}>Eligible</HeadCell>
            </>
          }
        >
          {rows.map((r, i) => {
            const disagrees = r.varianceBps !== null && r.varianceBps > 2500;
            return (
              <Row key={r.id} striped={i % 2 === 1}>
                <Cell>{r.day ? shortDate(r.day) : <span className="text-muted">—</span>}</Cell>
                <Cell truncate={150}>
                  <Link href={`/sales/people/${r.userId}`} className="font-medium text-ink no-underline">
                    {r.userName}
                  </Link>
                </Cell>
                <Cell>{r.modeLabel ?? r.modeKey.replace(/_/g, " ")}</Cell>
                <Cell truncate={230}>
                  {r.fromLabel ?? "?"} <span className="text-muted">→</span> {r.toLabel ?? "?"}
                </Cell>
                <Cell className="capitalize">
                  {r.purpose?.replace(/_/g, " ") ?? <span className="text-muted">Not said</span>}
                </Cell>
                <Cell truncate={170}>
                  {r.customerName ?? <span className="text-muted">No customer</span>}
                </Cell>
                <Cell align="right">
                  {km(r.odometerMetres) ?? <span className="text-muted">—</span>}
                  {r.odometerPhotoId ? (
                    <span className="ml-1.5" title="A photograph of the odometer is attached.">
                      <Pill tone="success">Photo</Pill>
                    </span>
                  ) : null}
                </Cell>
                <Cell align="right">
                  {r.gpsMetres === null ? (
                    <span className="text-muted" title={r.gpsReason ?? undefined}>
                      Not measured
                    </span>
                  ) : (
                    <>
                      <span className={disagrees ? "text-warn-ink" : undefined}>
                        {km(r.gpsMetres)}
                      </span>
                      {/* The method matters as much as the number: an estimate
                          from two endpoints is not a measurement, and a screen
                          that draws them alike is lying by omission. */}
                      <span className="block text-[12px] text-muted">
                        {r.gpsMethod === "trail"
                          ? `along the track, ${r.gpsCoveragePct ?? 0}% covered`
                          : r.gpsMethod === "straight_line_factored"
                            ? "estimated from the two ends"
                            : "—"}
                      </span>
                    </>
                  )}
                </Cell>
                <Cell align="right">
                  {km(r.manualMetres) ?? <span className="text-muted">—</span>}
                </Cell>
                <Cell align="right">
                  <span className="font-medium">{km(r.chosenMetres) ?? "—"}</span>
                  <span className="block text-[12px] text-muted">
                    {r.chosenSource
                      ? `from the ${r.chosenSource}`
                      : "nothing measured this leg"}
                  </span>
                </Cell>
                <Cell align="right">
                  {r.eligiblePaise === null ? (
                    <span className="text-muted" title="This day has not been submitted, so nothing has been worked out yet.">
                      Not yet
                    </span>
                  ) : (
                    money(Number(r.eligiblePaise))
                  )}
                </Cell>
              </Row>
            );
          })}
        </Table>
      )}
    </div>
  );
}
