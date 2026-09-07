import Link from "next/link";
import { stamp } from "@/lib/format";
import { listExceptions } from "@/lib/services/expense-service";
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
  Table,
} from "../parts";
import { ResolveException } from "./resolve";

export const metadata = { title: "Expense exceptions — Sales Dashboard — MahekOne" };

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
        title="Expense exceptions"
        subtitle="Claims outside policy, distances that do not agree, and spending unlike anything this person usually does. None of these refused a claim — the money was already spent. What they do is put it in front of you."
      />

      {blocking.length ? (
        <Banner
          tone="danger"
          title={`${blocking.length} claim${blocking.length === 1 ? "" : "s"} missing proof the policy requires`}
          body="These cannot be settled on their own. Either the bill arrives, or somebody decides to allow it without one and says so here — which is a decision with a name against it rather than a gap."
        />
      ) : null}

      <MetricRow
        metrics={[
          {
            label: "Missing proof",
            value: String(blocking.length),
            tone: blocking.length ? "danger" : undefined,
          },
          {
            label: "Questioned",
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
          body="Exceptions are raised when a day is submitted — a claim over a limit, a distance the odometer and the phone disagree about, or a day unlike this person's own recent ones."
        />
      ) : (
        <Table
          minWidth={1300}
          head={
            <>
              <HeadCell width={150}>Salesman</HeadCell>
              <HeadCell width={110}>Day</HeadCell>
              <HeadCell width={140}>What</HeadCell>
              <HeadCell>Why it was raised</HeadCell>
              <HeadCell width={160}>Their reason</HeadCell>
              <HeadCell width={150}>State</HeadCell>
              <HeadCell align="right" width={220} />
            </>
          }
        >
          {rows.map((r, i) => (
            <Row key={r.id} striped={i % 2 === 1}>
              <Cell truncate={150}>
                <Link href={`/sales/people/${r.userId}`} className="font-medium text-ink no-underline">
                  {r.userName}
                </Link>
              </Cell>
              <Cell>{r.day ?? <span className="text-muted">—</span>}</Cell>
              <Cell className="capitalize">{r.kind.replace(/_/g, " ")}</Cell>
              <Cell>
                {r.message}
                {/* The working, not just the verdict. "Unusually high" is an
                    accusation nobody can answer; the numbers behind it are a
                    question somebody can answer in a sentence. */}
                <span className="block text-[12px] text-muted">
                  {Object.entries(r.detail ?? {})
                    .filter(([, v]) => v !== null && v !== undefined)
                    .map(([k, v]) => `${k}: ${String(v)}`)
                    .join(" · ")}
                </span>
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
                      ? "Needs proof"
                      : r.severity === "warn"
                        ? "Questioned"
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
