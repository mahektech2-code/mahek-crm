import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import Link from "next/link";
import { shortDate, stamp } from "@/lib/format";
import { fieldSamples } from "@/lib/services/sales-service";
import { Decide } from "@/components/console/decide";
import {
  Banner,
  Cell,
  Empty,
  FilterChips,
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
import { CustomerName } from "@/components/console/customer-name";
import { readSort, sortHref, sortRows, type SortColumns } from "@/components/console/sort";


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
export async function Body({
  workspace,
  searchParams,
}: {
  workspace: LeadWorkspace;
  searchParams: Promise<{ show?: string; sort?: string; dir?: string }>;
}) {
  const params = await searchParams;
  const samples = await fieldSamples();

  /* The counts are SQL's, over every sample. The list is a page of them
     ordered by what is owed — pending first, latest first — so the rows the
     banner names are the rows at the top rather than the ones under the cap. */
  const rows = samples.rows;
  const late = rows.filter((s) => s.trialOutcome === "pending" && s.lateDays > 0);
  const oldest = late.reduce((n, s) => Math.max(n, s.lateDays), 0);

  /*
   * AWAITING FEEDBACK IS THE DEFAULT, not "past the date".
   *
   * The overdue ones are the loudest and they are already named in the banner
   * above, which is where an exception belongs. The list itself is a worklist:
   * a sample due on Friday is chased on Thursday, and a screen that opened on
   * the late ones alone would show a manager only the chances he has already
   * missed. Everything still owed is the set he can actually act on.
   */
  const show = (
    ["late", "awaiting", "converted", "all"].includes(params.show ?? "") ? params.show! : "awaiting"
  ) as "late" | "awaiting" | "converted" | "all";

  const visible =
    show === "late"
      ? rows.filter((s) => s.trialOutcome === "pending" && s.lateDays > 0)
      : show === "awaiting"
        ? rows.filter((s) => s.trialOutcome === "pending")
        : show === "converted"
          ? rows.filter((s) => s.trialOutcome === "converted")
          : rows;

  /*
   * THE CHIP COUNTS ARE SQL'S AND THE TABLE IS A PAGE OF ONE VIEW.
   *
   * `samples.late`, `.awaiting` and `.converted` are counted over every sample
   * ever sent out; `visible` is a filter over the newest three hundred.
   * Counting the page instead would be the cheaper answer and the wrong one in
   * the direction that matters here — a sample goes quiet by being forgotten,
   * so the figure that must never shrink is the one saying how many are still
   * owed. A chip reading eleven on a book with forty outstanding is a screen
   * telling a manager he is nearly finished. The cap is disclosed underneath
   * instead, which says both true things rather than one of them.
   */
  const counts = {
    late: samples.late,
    awaiting: samples.awaiting,
    converted: samples.converted,
    all: samples.total,
  };

  const sort = readSort(params, COLUMNS);
  const sorted = sortRows(visible, sort, COLUMNS);
  const head = (key: string, label: string, width?: number, align?: "left" | "right") => (
    <SortHead
      width={width}
      align={align}
      href={sortHref(leadHref(workspace, "samples"), sort, key, `show=${show}`)}
      active={sort.key === key}
      dir={sort.dir}
    >
      {label}
    </SortHead>
  );

  return (
    <div className="p-6">
      <ScreenHeader
        title="Samples"
        subtitle="What is out with customers on trial. A sample with no feedback is stock given away, so anything past its follow-up date is flagged here rather than left to be noticed."
      />

      {samples.late ? (
        <Banner
          tone="warn"
          title={`${plural(samples.late, "sample")} past the follow-up date`}
          body={
            <>
              Oldest is {plural(oldest, "day")} late —{" "}
              {late
                .slice(0, 3)
                .map((s) => `${s.customerName} (${s.salesmanName})`)
                .join(" · ")}
              {samples.late > 3 ? ` and ${samples.late - 3} more` : ""}. The handset raises a task
              for these; nothing else chases them.
            </>
          }
        />
      ) : null}

      {/* Counted over every sample and deliberately unmoved by the chips. A
          figure that fell when somebody filtered the list under it would read
          as progress rather than as a narrower question. */}
      <MetricRow
        metrics={[
          { label: "Awaiting feedback", value: String(samples.awaiting) },
          {
            label: "Past the date",
            value: String(samples.late),
            sub: oldest ? `oldest ${plural(oldest, "day")}` : undefined,
            tone: samples.late ? "warn" : undefined,
          },
          { label: "Converted", value: String(samples.converted), tone: "success" },
          { label: "Sent in all", value: String(samples.total) },
        ]}
      />

      {samples.total === 0 ? (
        <Empty
          title="Nothing out on trial"
          body="No sample has been requested from a handset. A sample needs somebody's approval before it goes, and it is asked for on the visit where the customer asked."
        />
      ) : (
        <>
          <FilterChips
            current={show}
            options={[
              { key: "late", href: "/sales/samples?show=late", label: "Past the date", count: counts.late },
              { key: "awaiting", href: "/sales/samples?show=awaiting", label: "Awaiting feedback", count: counts.awaiting },
              { key: "converted", href: "/sales/samples?show=converted", label: "Converted", count: counts.converted },
              { key: "all", href: "/sales/samples?show=all", label: "Everything", count: counts.all },
            ]}
          />

          {samples.capped ? (
            <p className="mb-2 text-[13px] text-muted">
              {rows.length} of {samples.total}, everything still awaiting feedback first
              {show === "all" ? "" : `, of which ${sorted.length} are in this view`}. The chip
              counts above are taken over every sample, so they can be larger than what this page
              holds.
            </p>
          ) : null}

          {sorted.length === 0 ? (
            <Empty
              title={
                show === "late"
                  ? "Nothing is past its date"
                  : show === "converted"
                    ? "Nothing has converted yet"
                    : "Nothing is waiting on feedback"
              }
              body={
                show === "awaiting"
                  ? "Every sample on this page has an answer against it, which is the state to be in — a sample with no feedback is stock given away."
                  : "No sample on this page is in that state. The count on the chip is taken over every sample, so there may be older ones behind the cap."
              }
            />
          ) : (
        <Table
          minWidth={1180}
          head={
            <>
              {head("customer", "Customer", 220)}
              {head("salesman", "Salesman", 160)}
              {head("product", "Product", 240)}
              {head("cans", "Cans", 90, "right")}
              {head("requested", "Requested", 130)}
              {head("due", "Feedback due", 150)}
              {head("state", "State")}
              <HeadCell align="right" width={230} />
            </>
          }
        >
          {sorted.map((s, i) => (
            <Row key={s.id} striped={i % 2 === 1}>
              <Cell truncate={220}>
                <CustomerName id={s.customerId} name={s.customerName} />
              </Cell>
              <Cell truncate={160}>
                <Link
                  href={leadHref(workspace, `people/${s.salesmanId}`)}
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
        </>
      )}
    </div>
  );
}

/**
 * What each sortable column is worth.
 *
 * `null` sorts last in both directions, which is the right way round for the
 * two dates: a sample with no follow-up date set is not the most overdue thing
 * on the screen, it is a sample nobody has said anything about, and floating it
 * to the top of "latest due" would put the row that answers the question least
 * where the eye goes first.
 *
 * The State column sorts on the stored outcome rather than on the words drawn
 * in the pill — `pending` is rendered as "Awaiting feedback", and sorting by
 * the label would order the table by a translation the engine knows nothing
 * about.
 */
const COLUMNS: SortColumns<{
  customerName: string;
  salesmanName: string;
  productName: string | null;
  quantityCans: number | null;
  requestedDate: string | null;
  followUpDate: string | null;
  trialOutcome: string;
}> = {
  customer: (s) => s.customerName,
  salesman: (s) => s.salesmanName,
  product: (s) => s.productName,
  cans: (s) => s.quantityCans,
  requested: (s) => (s.requestedDate ? new Date(s.requestedDate).getTime() : null),
  due: (s) => (s.followUpDate ? new Date(s.followUpDate).getTime() : null),
  state: (s) => s.trialOutcome,
};
