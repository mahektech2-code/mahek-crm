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
  EntityLink,
  FilterChips,
  HeadCell,
  MetricRow,
  Pill,
  Row,
  ScreenHeader,
  SortHead,
  Table,
} from "@/components/console/parts";
import { plural } from "@/components/console/words";
import { readSort, sortHref, sortRows, type SortColumns } from "@/components/console/sort";

export const metadata = { title: "Travel ledger — Sales Dashboard — MahekOne" };

const km = (metres: number | null) =>
  metres === null ? null : `${(metres / 1000).toFixed(1)} km`;

/**
 * The disagreement threshold, named once.
 *
 * It was a bare `2500` written out at both the banner and the row, which is
 * two statements of one fact waiting to drift — and now that a filter chip
 * counts the same set, it would have been three. It is not configuration:
 * nothing is priced, refused or paid on it, and what it decides is which legs
 * a manager is invited to look at rather than what anybody is owed.
 */
const DISAGREEMENT_BPS = 2500;

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
  searchParams: Promise<{ month?: string; who?: string; show?: string; sort?: string; dir?: string }>;
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
  const disagreeing = rows.filter(
    (r) => r.varianceBps !== null && r.varianceBps > DISAGREEMENT_BPS,
  );
  const unmeasured = rows.filter((r) => r.chosenMetres === null);
  /*
   * "No photograph" MEANS A CLAIMED READING WITH NOTHING BEHIND IT, and not
   * simply an empty column.
   *
   * A leg typed up on `/travel` once the journey is over has no photograph and
   * never will — the meter has moved, and refusing to record a journey for
   * want of a picture nobody can now take is the worse answer, which is why
   * `origin` exists on the row at all. So a chip counting every photograph-less
   * leg would put those honest rows in front of a manager as though somebody
   * had withheld something. What is worth a second look is a leg that names a
   * DISTANCE off the dial with no image of the dial: a number that cannot be
   * checked by anybody who was not standing there.
   */
  const unphotographed = rows.filter((r) => r.odometerMetres !== null && !r.odometerPhotoId);

  /*
   * THE LEDGER OPENS WHOLE, and the exception is one click away.
   *
   * The obvious default is "Disagreeing", since that is what the screen was
   * built to surface — and it is the wrong one here, for a reason the word
   * "ledger" gives away. This is the RECORD of a month's movement, read to
   * answer "what did the field do and what did it cost" as often as "who
   * should I doubt", and a record that opens showing four of four hundred legs
   * has hidden the book from whoever came to read it. It would also make the
   * empty state lie: "No travel recorded this month" under a filter is a
   * sentence about the filter wearing the clothes of a sentence about the
   * month. The disagreements already reach the manager twice before he touches
   * a chip — the banner names them and the metric counts them — so the cost of
   * defaulting wide is one click and the cost of defaulting narrow is a
   * ledger nobody can see.
   */
  const show = params.show === "disagreeing" || params.show === "nophoto" ? params.show : "all";
  const visible =
    show === "disagreeing" ? disagreeing : show === "nophoto" ? unphotographed : rows;

  /* The month and the salesman narrowing survive a chip and a sort alike:
     getting this wrong silently drops the filter somebody is standing in and
     answers a different question under the same heading. */
  const scoped = `month=${month}${params.who ? `&who=${encodeURIComponent(params.who)}` : ""}`;

  /* Sorting is DISPLAY ONLY. The figures above the table and the counts on the
     chips are both taken over the whole month's legs, never over the sorted or
     filtered copy — a metric that moved when somebody re-ordered a column would
     be the screen disagreeing with itself. */
  const sort = readSort(params, COLUMNS);
  const sorted = sortRows(visible, sort, COLUMNS);
  const head = (key: string, label: string, width?: number, align?: "left" | "right") => (
    <SortHead
      width={width}
      align={align}
      href={sortHref("/sales/travel", sort, key, `${scoped}&show=${show}`)}
      active={sort.key === key}
      dir={sort.dir}
    >
      {label}
    </SortHead>
  );

  /* A chip carries the sort with it. Changing WHICH legs are listed is not a
     statement about what order to list them in, and dropping the column
     somebody chose on the way into a narrower view is a small betrayal they
     have to notice and undo. */
  const held = sort.key ? `&sort=${encodeURIComponent(sort.key)}&dir=${sort.dir}` : "";
  const chip = (key: string) => `/sales/travel?${scoped}&show=${key}${held}`;

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

      {rows.length ? (
        <FilterChips
          current={show}
          options={[
            {
              key: "disagreeing",
              href: chip("disagreeing"),
              label: "Disagreeing",
              count: disagreeing.length,
            },
            {
              key: "nophoto",
              href: chip("nophoto"),
              label: "No photograph",
              count: unphotographed.length,
            },
            { key: "all", href: chip("all"), label: "Everything", count: rows.length },
          ]}
        />
      ) : null}

      {rows.length === 0 ? (
        <Empty
          title="No travel recorded this month"
          body={`Legs are recorded on the handset as the salesman moves. A position is taken every ${fixEverySeconds} seconds while somebody is checked in, and the distance is worked out when the day is submitted.`}
        />
      ) : visible.length === 0 ? (
        /* A view that is empty because it was ASKED to be, said as exactly
           that. The sentence above it is about the month and would be false
           here, and a manager who reads "no travel recorded" under a chip he
           picked concludes the ledger is broken rather than that the month was
           clean. */
        <Empty
          title={show === "disagreeing" ? "Nothing disagrees this month" : "Every claimed reading is photographed"}
          body={
            show === "disagreeing"
              ? `All ${plural(rows.length, "leg")} this month read within 25% between the odometer and the day's track. Everything is on the Everything chip.`
              : `Every leg this month that names a distance off the dial has a photograph of it. Everything is on the Everything chip.`
          }
        />
      ) : (
        <Table
          minWidth={1600}
          head={
            <>
              {head("day", "Day", 110)}
              {head("salesman", "Salesman", 150)}
              {/* Mode, the two ends, the purpose and the customer are left
                  unsorted deliberately. Each is a label rather than a
                  quantity, and ordering a month of legs alphabetically by
                  "Bus" or by "Nagpur → Wardha" groups rows that have nothing
                  to say to each other — the questions this screen is opened
                  with are all "how far", "how much" and "when". */}
              <HeadCell width={130}>Mode</HeadCell>
              <HeadCell width={230}>From → to</HeadCell>
              <HeadCell width={130}>Purpose</HeadCell>
              <HeadCell width={170}>Customer</HeadCell>
              {head("odometer", "Odometer", 130, "right")}
              {head("gps", "GPS track", 170, "right")}
              {head("manual", "By hand", 110, "right")}
              {head("paid", "Paid on", 150, "right")}
              {head("eligible", "Eligible", 120, "right")}
            </>
          }
        >
          {sorted.map((r, i) => {
            const disagrees = r.varianceBps !== null && r.varianceBps > DISAGREEMENT_BPS;
            return (
              <Row key={r.id} striped={i % 2 === 1}>
                <Cell>{r.day ? shortDate(r.day) : <span className="text-muted">—</span>}</Cell>
                <Cell truncate={150}>
                  <EntityLink href={`/sales/people/${r.userId}`}>
                    {r.userName}
                  </EntityLink>
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

/**
 * What each sortable column is worth.
 *
 * Every distance is kept in METRES rather than sorted on the rendered "4.1 km"
 * — the string sort would read 10 km as smaller than 9 km, and the one number
 * on this screen nobody may be wrong about is a distance.
 *
 * `null` sorts last in both directions, which is what the legs with nothing
 * measured need: a leg worth nothing is already named in its own banner, and
 * floating it to the top of "furthest first" would put the rows that answer
 * the question least where the eye goes first.
 */
const COLUMNS: SortColumns<{
  day: string | null;
  userName: string;
  odometerMetres: number | null;
  gpsMetres: number | null;
  manualMetres: number | null;
  chosenMetres: number | null;
  eligiblePaise: number | string | null;
}> = {
  day: (r) => r.day,
  salesman: (r) => r.userName,
  odometer: (r) => r.odometerMetres,
  gps: (r) => r.gpsMetres,
  manual: (r) => r.manualMetres,
  paid: (r) => r.chosenMetres,
  /* A day nobody has submitted has no figure at all, and that is not zero —
     the cell says "Not yet" for the same reason. */
  eligible: (r) => (r.eligiblePaise === null ? null : Number(r.eligiblePaise)),
};
