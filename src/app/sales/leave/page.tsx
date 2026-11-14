import { shortDate } from "@/lib/format";
import { leaveEntitlements, leaveRequests } from "@/lib/services/sales-service";
import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { Entitlements } from "./entitlements";
import { Decide } from "../decide";
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
} from "../parts";
import { readSort, sortHref, sortRows, type SortColumns } from "../sort";
import {
  LEAVE_LABEL,
  label,
  plural,
} from "../words";

export const metadata = { title: "Leave — Sales Dashboard — MahekOne" };

/**
 * Leave asked for, and what stands in the way of saying yes.
 *
 * The clash column is the design's idea and the reason this is a screen rather
 * than a queue: two salesmen off in the same week leaves those shops unworked,
 * and the manager approving the second request usually cannot see the first.
 * It is computed at read time, because it is a question about the state of the
 * calendar at the moment somebody looks at it.
 *
 * Deciding happens in the approvals queue, which is where every kind of
 * request is answered with the same rules — a refusal needs a reason, and a
 * decision is made once. This screen is the calendar around that decision.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ show?: string; sort?: string; dir?: string }>;
}) {
  const params = await searchParams;
  const now = await today();
  const year = Number(now.slice(0, 4));
  const [all, entitlements, config] = await Promise.all([
    leaveRequests(),
    leaveEntitlements(year),
    getConfig(),
  ]);
  const defaults = config["mbos.leave.annualEntitlementDays"] ?? {};

  const show = ["all", "waiting", "approved"].includes(params.show ?? "")
    ? params.show!
    : "waiting";

  /* The counts are SQL's, over every request; the three views are still cut
     from the page, which is ordered pending-first — so nothing waiting can be
     the part a cap drops. */
  const live = all.rows.filter((l) => !l.cancelledAt);
  const waiting = live.filter((l) => !l.approvalState || l.approvalState === "pending");
  const approved = live.filter((l) => l.approvalState === "approved");
  const rows = show === "all" ? all.rows : show === "approved" ? approved : waiting;

  const clashes = waiting.filter((l) => l.clashesWith);
  const days = waiting.reduce((n, l) => n + Number(l.days), 0);

  /* Sorting is DISPLAY ONLY, and it is the filtered `rows` that is sorted
     rather than `all.rows` — the chip decides WHICH requests are on the
     screen and the column decides only what order they are in. The four
     figures above come from SQL over every request the scope allows, so none
     of them may move when a column is clicked: "Waiting 11" that became
     "Waiting 4" because somebody sorted by days would be the screen
     disagreeing with itself.

     `show` is carried through every header link. Dropping it would silently
     throw the manager back to the Waiting view the moment he sorted, which
     reads as the sort having lost rows rather than as a filter having been
     reset. */
  const sort = readSort(params, COLUMNS);
  const sorted = sortRows(rows, sort, COLUMNS);
  const head = (key: string, text: string, width?: number, align?: "left" | "right") => (
    <SortHead
      width={width}
      align={align}
      href={sortHref("/sales/leave", sort, key, `show=${show}`)}
      active={sort.key === key}
      dir={sort.dir}
    >
      {text}
    </SortHead>
  );

  return (
    <div className="p-6">
      <ScreenHeader
        title="Leave"
        subtitle="Who has asked for time off, and who else is already off on those days. Two salesmen away in one week leaves those shops unworked — that is the thing a calendar can tell you and a queue cannot."
      />

      {clashes.length ? (
        <Banner
          tone="warn"
          title={`${plural(clashes.length, "request")} overlaps somebody else's leave`}
          body={clashes
            .map((c) => `${c.salesmanName} (${shortDate(c.fromDate)}) with ${c.clashesWith}`)
            .join(" · ")}
        />
      ) : null}

      <MetricRow
        metrics={[
          { label: "Waiting", value: String(all.waiting), tone: all.waiting ? "warn" : undefined },
          { label: "Days asked for", value: String(days) },
          {
            label: "Overlapping",
            value: String(clashes.length),
            tone: clashes.length ? "warn" : undefined,
          },
          { label: "Approved", value: String(all.approved), tone: "success" },
        ]}
      />

      <FilterChips
        current={show}
                options={[
          { key: "waiting", href: `/sales/leave?show=waiting`, label: "Waiting", count: all.waiting },
          { key: "approved", href: `/sales/leave?show=approved`, label: "Approved", count: all.approved },
          { key: "all", href: `/sales/leave?show=all`, label: "Everything", count: all.total },
        ]}
      />

      {/*
        WHAT EACH PERSON IS ALLOWED, under the requests rather than on a page
        of its own, because "how much has he got left" is the question somebody
        is already holding while deciding one.

        The entitlement is configuration with a per-person override, and the
        override had no door: nothing in MahekOne ever wrote one of those rows,
        so a salesman on different terms could not be given them anywhere.
      */}
      <div className="mt-8">
        <h2 className="text-[15px] font-medium text-ink">Days a year</h2>
        <p className="mt-1 max-w-[70ch] text-[13px] leading-[20px] text-muted">
          What each salesman may take, and what is left of it. Everybody gets
          the company figure until somebody is given terms of their own here.
        </p>
        <div className="mt-3">
          <Entitlements year={year} rows={entitlements} defaults={defaults} />
        </div>
      </div>


      {rows.length === 0 ? (
        <Empty
          title={show === "waiting" ? "Nothing to decide" : "No leave recorded"}
          body="Leave is asked for on the handset. A request reaches the office on the next sync, and the balance the salesman was shown when he asked is stored on the request so a later recompute cannot rewrite what he was told."
        />
      ) : (
        <>
          {all.capped ? (
            <p className="mb-2 text-[13px] text-muted">
              {all.rows.length} of {all.total} requests, everything waiting on a
              decision first. The figures above count them all.
            </p>
          ) : null}
        <Table
          minWidth={1180}
          head={
            <>
              {head("name", "Salesman", 190)}
              {/* Kind and State are both small closed sets drawn as words, and
                  alphabetising either of them groups rows without ranking
                  them — which is what the chips above the table already do,
                  with a count on each. "Why" is the salesman's own sentence
                  and has no order at all. */}
              <HeadCell width={140}>Kind</HeadCell>
              {head("when", "When", 210)}
              {head("days", "Days", 90, "right")}
              <HeadCell>Why</HeadCell>
              {head("clash", "Also off", 200)}
              <HeadCell width={150}>State</HeadCell>
              <HeadCell align="right" width={230} />
            </>
          }
        >
          {sorted.map((l, i) => (
            <Row key={l.id} striped={i % 2 === 1}>
              <Cell truncate={190}>
                <EntityLink
                  href={`/sales/people/${l.salesmanId}`}
                >
                  {l.salesmanName}
                </EntityLink>
              </Cell>
              <Cell>{label(LEAVE_LABEL, l.leaveType)}</Cell>
              <Cell>
                {shortDate(l.fromDate)}
                {l.toDate !== l.fromDate ? ` – ${shortDate(l.toDate)}` : ""}
                {l.halfDay ? (
                  <span className="block text-[12px] text-muted">half day</span>
                ) : null}
              </Cell>
              <Cell align="right">{l.days}</Cell>
              <Cell truncate={320}>
                {l.reason ?? <span className="text-muted">No reason given</span>}
                {l.decisionNote ? (
                  <span className="block truncate text-[12px] text-muted">
                    {l.approverName ? `${l.approverName}: ` : ""}“{l.decisionNote}”
                  </span>
                ) : null}
              </Cell>
              <Cell truncate={200}>
                {l.clashesWith ? (
                  <span className="text-warn-ink">{l.clashesWith}</span>
                ) : (
                  <span className="text-muted">Nobody</span>
                )}
              </Cell>
              <Cell>
                {l.cancelledAt ? (
                  <Pill>Withdrawn</Pill>
                ) : l.approvalState === "approved" ? (
                  <Pill tone="success">Approved</Pill>
                ) : l.approvalState === "rejected" ? (
                  <Pill tone="danger">Refused</Pill>
                ) : (
                  <Pill tone="warn">Waiting</Pill>
                )}
              </Cell>
              <Cell align="right">
                {!l.cancelledAt && (!l.approvalState || l.approvalState === "pending") ? (
                  <Decide
                    approvalId={l.approvalId}
                    who={l.salesmanName}
                    what={`${label(LEAVE_LABEL, l.leaveType)}, ${shortDate(l.fromDate)}${
                      l.toDate !== l.fromDate ? ` – ${shortDate(l.toDate)}` : ""
                    }`}
                  />
                ) : null}
              </Cell>
            </Row>
          ))}
        </Table>
        </>
      )}
    </div>
  );
}

/**
 * What each sortable column is worth.
 *
 * "When" is the from-date and not the to-date, because the question a manager
 * holds on this screen is which of these starts soonest — a request that began
 * yesterday is decided differently from one for March, and a row is already
 * drawn as its own range.
 *
 * THE CLASH COLUMN SORTS AS PRESENT OR ABSENT, and deliberately not by the
 * name in it. What that cell holds is other people's names, and alphabetising
 * by them answers a question nobody has: the clash is a fact about THIS
 * request, and the only ordering worth offering is the one that brings every
 * overlapping request to the top of whichever view is showing. It answers 1 or
 * 0 rather than a name-or-null, so that flipping the direction genuinely
 * reverses the two groups — a null would sort last in both directions and the
 * ascending click would appear to do nothing.
 */
const COLUMNS: SortColumns<{
  salesmanName: string;
  fromDate: string;
  days: number;
  clashesWith: string | null;
}> = {
  name: (l) => l.salesmanName,
  when: (l) => l.fromDate,
  days: (l) => Number(l.days),
  clash: (l) => (l.clashesWith ? 1 : 0),
};
