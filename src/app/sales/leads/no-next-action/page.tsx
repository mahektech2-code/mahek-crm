import Link from "next/link";
import { shortDate } from "@/lib/format";
import { today } from "@/lib/recompute";
import { salesTypeLabel, stageLabel } from "@/lib/lead-labels";
import { leadsWithoutNextAction } from "@/lib/services/lead-console-service";
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
} from "../../parts";
import { plural } from "../../words";

export const metadata = { title: "Leads with no next action — Sales Dashboard — MahekOne" };

/**
 * §24 — the exception list. It should be empty, and on a real book it will not
 * be.
 *
 * The rule is that an active lead may never sit with nothing owed by anybody,
 * and `advanceLeadStage` enforces it on every upward move — so a lead that has
 * never moved since the rule landed, or one whose promised day came and went
 * with nothing recorded, both end up here. Two shapes, one list, because a
 * manager asking "what is nobody working" means both.
 *
 * **Worst first.** A lead with no plan at all is a different order of thing
 * from one whose call was due yesterday, and a list sorted by date buries the
 * first under the second — the same argument the expense exceptions screen
 * makes.
 *
 * A server component with no client state at all: there is nothing to DO from
 * here. The action is opening the lead and planning something, which is a link.
 */
export default async function Page() {
  const day = await today();
  const { rows, total, unplanned } = await leadsWithoutNextAction(day);

  return (
    <div className="p-6">
      <ScreenHeader
        title="Nobody is working these"
        subtitle="An active lead may not sit with nothing owed by anybody. Every row here has either no plan at all, or a plan whose day has gone past with no outcome recorded — which is the same thing a fortnight later."
        actions={
          <Link
            href="/sales/leads"
            className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
          >
            ← All leads
          </Link>
        }
      />

      {unplanned ? (
        <Banner
          tone="danger"
          title={`${plural(unplanned, "lead")} with no next action at all`}
          body="No action, no day, or nobody named. A date with nobody against it is how a lead sits for six weeks with everyone assuming somebody else has it."
        />
      ) : null}

      <MetricRow
        metrics={[
          { label: "On the list", value: String(total), tone: total ? "warn" : "success" },
          {
            label: "No plan at all",
            value: String(unplanned),
            tone: unplanned ? "danger" : undefined,
          },
          { label: "Plan gone past", value: String(total - unplanned) },
        ]}
      />

      {rows.length === 0 ? (
        <Empty
          title="Every lead has somebody on it"
          body="Which is what this screen is for. It is the one list in the console that is supposed to be empty, and an empty one means the rule is holding rather than that nothing is being checked."
        />
      ) : (
        <>
          {rows.length < total ? (
            <p className="mb-2 text-[12px] text-muted">
              Showing the worst {rows.length} of {total}.
            </p>
          ) : null}
          <Table
            minWidth={1220}
            head={
              <>
                <HeadCell width={240}>Lead</HeadCell>
                <HeadCell width={130}>Sales type</HeadCell>
                <HeadCell width={140}>Stage</HeadCell>
                <HeadCell width={160}>Salesman</HeadCell>
                <HeadCell width={160}>Lead manager</HeadCell>
                <HeadCell width={200}>What is missing</HeadCell>
                <HeadCell width={130}>Quiet</HeadCell>
              </>
            }
          >
            {rows.map((r, i) => {
              const missing = [
                r.hasAction ? null : "the action",
                r.hasDate ? null : "a day",
                r.hasOwner ? null : "a person",
              ].filter(Boolean) as string[];
              return (
                <Row key={r.customerId} striped={i % 2 === 1}>
                  <Cell truncate={240}>
                    <Link href={`/sales/leads/${r.customerId}`} className="no-underline">
                      {r.name}
                    </Link>
                    <span className="block truncate text-[12px] text-muted">
                      {[r.companyName, r.city].filter(Boolean).join(" · ") || "—"}
                    </span>
                  </Cell>
                  <Cell>{salesTypeLabel(r.salesType)}</Cell>
                  <Cell>
                    {stageLabel(r.stage)}
                    {r.stageSince ? (
                      <span className="block text-[12px] text-muted">
                        {plural(r.stuckDays, "day")} here
                      </span>
                    ) : null}
                  </Cell>
                  <Cell truncate={160}>
                    {r.salesmanId ? (
                      <Link href={`/sales/people/${r.salesmanId}`} className="no-underline">
                        {r.salesmanName}
                      </Link>
                    ) : (
                      <span className="text-warn-ink">Nobody</span>
                    )}
                  </Cell>
                  <Cell truncate={160}>
                    {r.leadManagerName ?? <span className="text-warn-ink">Nobody</span>}
                  </Cell>
                  <Cell truncate={200}>
                    {missing.length ? (
                      <>
                        <Pill tone="danger">No plan</Pill>
                        <span className="block truncate text-[12px] text-muted">
                          missing {missing.join(", ")}
                        </span>
                      </>
                    ) : (
                      <>
                        <Pill tone="warn">
                          {plural(r.overdueDays ?? 0, "day")} past
                        </Pill>
                        <span className="block truncate text-[12px] text-muted">
                          due {r.stageSince ? shortDate(r.stageSince) : "—"}, nothing recorded
                        </span>
                      </>
                    )}
                  </Cell>
                  <Cell>{plural(r.quietDays, "day")}</Cell>
                </Row>
              );
            })}
          </Table>
        </>
      )}
    </div>
  );
}
