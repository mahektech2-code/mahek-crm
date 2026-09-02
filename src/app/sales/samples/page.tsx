import Link from "next/link";
import { shortDate, stamp } from "@/lib/format";
import { fieldSamples } from "@/lib/services/sales-service";
import { Decide } from "../decide";
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

export const metadata = { title: "Samples — Sales Dashboard — MahekOne" };

/**
 * What is out with customers on trial.
 *
 * The design's sentence is the whole argument for the screen: **a sample with
 * no feedback is stock given away.** So the column that matters is not what
 * was sent, it is how long ago the feedback was due — and anything past that
 * date is flagged rather than left to be noticed.
 *
 * There is no value column, deliberately. `products.priceSource` is `unset`,
 * so nothing in MahekOne can say what two cans of thinner are worth, and a
 * number derived from the packing cost would be a confident wrong one.
 */
export default async function Page() {
  const samples = await fieldSamples();

  const awaiting = samples.filter((s) => s.trialOutcome === "pending");
  const late = awaiting.filter((s) => s.lateDays > 0);
  const converted = samples.filter((s) => s.trialOutcome === "converted");
  const oldest = late.reduce((n, s) => Math.max(n, s.lateDays), 0);

  return (
    <div className="p-6">
      <ScreenHeader
        title="Samples"
        subtitle="What is out with customers on trial. A sample with no feedback is stock given away, so anything past its follow-up date is flagged here rather than left to be noticed."
      />

      {late.length ? (
        <Banner
          tone="warn"
          title={`${plural(late.length, "sample")} past the follow-up date`}
          body={
            <>
              Oldest is {plural(oldest, "day")} late —{" "}
              {late
                .slice(0, 3)
                .map((s) => `${s.customerName} (${s.salesmanName})`)
                .join(" · ")}
              {late.length > 3 ? ` and ${late.length - 3} more` : ""}. The handset raises a task
              for these; nothing else chases them.
            </>
          }
        />
      ) : null}

      <MetricRow
        metrics={[
          { label: "Awaiting feedback", value: String(awaiting.length) },
          {
            label: "Past the date",
            value: String(late.length),
            sub: oldest ? `oldest ${plural(oldest, "day")}` : undefined,
            tone: late.length ? "warn" : undefined,
          },
          { label: "Converted", value: String(converted.length), tone: "success" },
          { label: "Sent in all", value: String(samples.length) },
        ]}
      />

      {samples.length === 0 ? (
        <Empty
          title="Nothing out on trial"
          body="No sample has been requested from a handset. A sample needs somebody's approval before it goes, and it is asked for on the visit where the customer asked."
        />
      ) : (
        <Table
          minWidth={1180}
          head={
            <>
              <HeadCell width={220}>Customer</HeadCell>
              <HeadCell width={160}>Salesman</HeadCell>
              <HeadCell width={240}>Product</HeadCell>
              <HeadCell align="right" width={90}>Cans</HeadCell>
              <HeadCell width={130}>Requested</HeadCell>
              <HeadCell width={150}>Feedback due</HeadCell>
              <HeadCell>State</HeadCell>
              <HeadCell align="right" width={230} />
            </>
          }
        >
          {samples.map((s, i) => (
            <Row key={s.id} striped={i % 2 === 1}>
              <Cell truncate={220}>{s.customerName}</Cell>
              <Cell truncate={160}>
                <Link
                  href={`/sales/people/${s.salesmanId}`}
                  className="no-underline"
                >
                  {s.salesmanName}
                </Link>
              </Cell>
              <Cell truncate={240}>
                {s.productName ?? (
                  <span
                    className="text-muted"
                    title="No product was named — the request says what the customer asked for in words."
                  >
                    Not named
                  </span>
                )}
              </Cell>
              <Cell align="right">{s.quantityCans ?? <span className="text-muted">—</span>}</Cell>
              <Cell title={s.deliveredAt ? `Delivered ${stamp(s.deliveredAt)}` : undefined}>
                {s.requestedDate ? shortDate(s.requestedDate) : <span className="text-muted">—</span>}
              </Cell>
              <Cell>
                {s.followUpDate ? (
                  <>
                    {shortDate(s.followUpDate)}
                    {s.lateDays > 0 && s.trialOutcome === "pending" ? (
                      <span className="block text-[12px] text-warn-ink">
                        {plural(s.lateDays, "day")} late
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="text-muted">None set</span>
                )}
              </Cell>
              <Cell truncate={280} title={s.feedbackNotes ?? undefined}>
                <Pill
                  tone={
                    s.trialOutcome === "converted"
                      ? "success"
                      : s.trialOutcome === "rejected"
                        ? "danger"
                        : s.lateDays > 0
                          ? "warn"
                          : "neutral"
                  }
                >
                  {s.trialOutcome === "pending" ? "Awaiting feedback" : s.trialOutcome}
                </Pill>
                {s.approvalState === "pending" ? (
                  <span className="ml-1.5">
                    <Pill tone="warn">Not approved yet</Pill>
                  </span>
                ) : null}
                {s.feedbackNotes ? (
                  <span className="block truncate text-[12px] text-muted">
                    “{s.feedbackNotes}”
                  </span>
                ) : null}
              </Cell>
              <Cell align="right">
                {s.approvalState === "pending" ? (
                  <Decide
                    approvalId={s.approvalId}
                    who={s.salesmanName}
                    what={`${s.quantityCans ?? "Some"} cans of ${s.productName ?? "a sample"} for ${s.customerName}`}
                  />
                ) : null}
              </Cell>
            </Row>
          ))}
        </Table>
      )}
    </div>
  );
}
