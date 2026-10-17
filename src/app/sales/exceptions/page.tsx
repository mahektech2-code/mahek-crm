import { stamp } from "@/lib/format";
import { listExceptions } from "@/lib/services/expense-service";
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
  Table,
} from "@/components/console/parts";
import { ResolveException } from "./resolve";

export const metadata = { title: "Flagged expenses — Sales Dashboard — MahekOne" };

/**
 * Requirements 42 to 46, and 69's worklist.
 *
 * **Every row is a question, never a refusal.** Nothing on this screen stopped
 * a claim being recorded — the money was already spent, and a system that
 * refuses to write it down has not saved it, it has only made sure nobody
 * finds out. What an exception does is put the claim in front of a person.
 *
 * Worst first: a claim missing the bill the policy demands is a different
 * order of thing from a day that ran 12% over somebody's usual distance, and
 * a list that sorts them by time buries the first under the second.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>;
}) {
  const params = await searchParams;
  const show = ["open", "all"].includes(params.show ?? "") ? params.show! : "open";
  const rows = await listExceptions({ openOnly: show === "open" });

  const blocking = rows.filter((r) => r.severity === "block_route" && !r.resolvedAt);
  const questioned = rows.filter((r) => r.severity === "warn" && !r.resolvedAt);
  const notes = rows.filter((r) => r.severity === "info" && !r.resolvedAt);

  return (
    <div className="p-6">
      <ScreenHeader
        title="Flagged expenses"
        subtitle="Things the policy wants you to check before you approve a day. Nothing here stopped a claim being recorded."
      />

      {blocking.length ? (
        <Banner
          tone="danger"
          title={`${blocking.length} claim${blocking.length === 1 ? "" : "s"} missing a bill`}
          body="Ask for the bill, or allow it without one here."
        />
      ) : null}

      <MetricRow
        metrics={[
          {
            label: "Missing a bill",
            value: String(blocking.length),
            tone: blocking.length ? "danger" : undefined,
          },
          {
            label: "To check",
            value: String(questioned.length),
            tone: questioned.length ? "warn" : undefined,
          },
          { label: "Notes", value: String(notes.length) },
        ]}
      />

      <FilterChips
        current={show}
        options={[
          { key: "open", href: "/sales/exceptions?show=open", label: "Open", count: rows.filter((r) => !r.resolvedAt).length },
          { key: "all", href: "/sales/exceptions?show=all", label: "Everything" },
        ]}
      />

      {rows.length === 0 ? (
        <Empty
          title="Nothing to look at"
          body="A day is flagged when it is sent — a claim over the limit, a missing bill, or a distance the meter and the phone disagree about."
        />
      ) : (
        <Table
          minWidth={1300}
          head={
            <>
              <HeadCell width={150}>Salesman</HeadCell>
              <HeadCell width={110}>Day</HeadCell>
              <HeadCell width={140}>What</HeadCell>
              <HeadCell>Why</HeadCell>
              <HeadCell width={160}>Their reason</HeadCell>
              <HeadCell width={150}>State</HeadCell>
              <HeadCell align="right" width={220} />
            </>
          }
        >
          {rows.map((r, i) => (
            <Row key={r.id} striped={i % 2 === 1}>
              <Cell truncate={150}>
                <EntityLink href={`/sales/people/${r.userId}`}>
                  {r.userName}
                </EntityLink>
              </Cell>
              <Cell>{r.day ?? <span className="text-muted">—</span>}</Cell>
              <Cell>{KIND_LABELS[r.kind] ?? r.kind.replace(/_/g, " ")}</Cell>
              <Cell>
                {r.message}
              </Cell>
              <Cell truncate={160}>
                {r.salesmanReason ?? <span className="text-muted">Nothing said</span>}
              </Cell>
              <Cell>
                {r.resolvedAt ? (
                  <>
                    <Pill tone={r.resolution === "rejected" ? "danger" : "success"}>
                      {r.resolution === "accepted"
                        ? "Allowed"
                        : r.resolution === "rejected"
                          ? "Refused"
                          : "Corrected"}
                    </Pill>
                    <span className="block text-[12px] text-muted">
                      {r.resolvedByName} · {stamp(r.resolvedAt)}
                    </span>
                  </>
                ) : (
                  <Pill
                    tone={
                      r.severity === "block_route" ? "danger" : r.severity === "warn" ? "warn" : "neutral"
                    }
                  >
                    {r.severity === "block_route"
                      ? "Needs a bill"
                      : r.severity === "warn"
                        ? "To check"
                        : "Note"}
                  </Pill>
                )}
              </Cell>
              <Cell align="right">
                {r.resolvedAt ? null : <ResolveException id={r.id} what={r.message} />}
              </Cell>
            </Row>
          ))}
        </Table>
      )}
    </div>
  );
}

/** The flag's kind, in a word or two a manager recognises. */
const KIND_LABELS: Record<string, string> = {
  over_cap: "Over the limit",
  over_km_ceiling: "Very long day",
  missing_proof: "Missing bill",
  gps_odometer_variance: "Meter vs GPS",
  manual_km_disagrees: "Km typed by hand",
  unpriced_mode: "No rate for this",
  unpriced_lodging: "No hotel limit",
  day_hotel: "Day-only room",
  no_policy: "No policy",
  open_day: "Day not closed",
  odometer_chain_broken: "Meter reading gap",
  arrival_time_disagrees: "Arrival time differs",
  duplicate_suspect: "Looks like a repeat",
  client_disagreement: "Phone and office differ",
};
