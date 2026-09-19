import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import Link from "next/link";
import { shortDate } from "@/lib/format";
import { today } from "@/lib/recompute";
import { stageLabel } from "@/lib/lead-labels";
import { prospectiveDistributors } from "@/lib/services/lead-console-service";
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
} from "@/components/console/parts";
import { plural } from "@/components/console/words";
import { LeadTabs } from "@/components/leads/lead-tabs";

/**
 * THE LEADS STANDING ON A LADDER THAT LEADS NOWHERE.
 *
 * Mahek does not appoint distributors through MahekOne, so the distributor
 * ladder was retired for new leads — and that deliberately left every lead
 * already on it exactly where it was, behind a two-step approval nobody in the
 * building can give. `migrateProspectiveDistributor` is the way one of them is
 * moved onto the ladder that describes how the account is actually being sold
 * to, and it was a finished action with no door: a manager could only reach it
 * from a lead's own record, and only if he already knew which leads those were.
 * Nobody did. That is what this screen is — not a report, a worklist, and one
 * that is finished when it is empty.
 *
 * **They are invisible everywhere else, which is the whole argument for a
 * screen.** A lead here has a rung, an owner and a stage date, so it is drawn
 * on the funnel, counted on the dashboard and listed among "my leads" exactly
 * like a live opportunity. Nothing on any of those screens says that the rung
 * it is standing on cannot be climbed. Sorted OLDEST FIRST, because the
 * question this answers is which of them has been stalled longest, and a lead
 * that moved last week is the one least likely to have been forgotten.
 *
 * **An appointed distributor is not on it.** Mahek's own words: Prospective
 * Distributor is a historical lead TYPE; Distributor means formally APPOINTED.
 * A lead at `active_distributor` was appointed, so it is a distributor and
 * stays one — the action refuses it, and offering it here would be listing work
 * that cannot be done. The exclusion is the service's, once, rather than
 * restated on the screen.
 *
 * A server component with no client state at all: there is nothing to DO from
 * here. The decision — direct or third-party, and which rung — is one somebody
 * makes after reading the lead, so the action on every row is a link into it.
 */
export async function Body({ workspace }: { workspace: LeadWorkspace }) {
  const day = await today();
  const { rows, total } = await prospectiveDistributors(day);

  /* Counted on the server, like every other figure on this page, because a
     client component may not read the clock during render and these are
     derived from a day the server resolved. */
  const started = rows.filter((r) => r.approvals > 0).length;
  const unowned = rows.filter((r) => !r.salesmanId).length;

  return (
    <div className="p-6">
      <LeadTabs workspace={workspace} />
      <ScreenHeader
        title="Leads on the retired distributor ladder"
        subtitle="Mahek appoints distributors outside MahekOne, so this ladder was retired for new leads and everything already on it was left where it stood. Each of these is waiting on an approval nobody here can give — open one to move it onto the ladder that describes how the account is actually being sold to."
        actions={
          <Link
            href={leadHref(workspace, "leads/appointments")}
            className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
          >
            ← Appointments
          </Link>
        }
      />

      {total ? (
        <Banner
          tone="warn"
          title={`${plural(total, "lead")} waiting on an appointment that will not come`}
          body="They are not lost and they are not deleted — both destroy a real record to tidy a screen. Moving one keeps its whole history: the old ladder, the rung it reached and who took it there all stay on its transitions, and the move is a further row rather than an edit."
        />
      ) : null}

      <MetricRow
        metrics={[
          { label: "On the list", value: String(total), tone: total ? "warn" : "success" },
          {
            label: "Appointment already started",
            value: String(started),
            tone: started ? "warn" : undefined,
          },
          {
            label: "Nobody holds it",
            value: String(unowned),
            tone: unowned ? "danger" : undefined,
          },
        ]}
      />

      {rows.length === 0 ? (
        <Empty
          title="Nothing is left on the distributor ladder"
          body="Which is what this screen is for. Every prospective distributor has been moved onto the ladder it is actually sold on, or was appointed — and an appointed distributor is one, so it is never on this list."
        />
      ) : (
        <>
          {rows.length < total ? (
            <p className="mb-2 text-[12px] text-muted">
              Showing the longest-stalled {rows.length} of {total}.
            </p>
          ) : null}
          <Table
            minWidth={1160}
            head={
              <>
                <HeadCell width={260}>Lead</HeadCell>
                <HeadCell width={180}>Rung it stopped on</HeadCell>
                <HeadCell width={160}>Salesman</HeadCell>
                <HeadCell width={160}>Lead manager</HeadCell>
                <HeadCell width={150}>Sitting there</HeadCell>
                <HeadCell width={130}>Quiet</HeadCell>
                <HeadCell width={120}>Appointment</HeadCell>
              </>
            }
          >
            {rows.map((r, i) => (
              <Row key={r.customerId} striped={i % 2 === 1}>
                <Cell truncate={260}>
                  <Link
                    href={leadHref(workspace, `leads/${r.customerId}`)}
                    className="no-underline"
                  >
                    {r.name}
                  </Link>
                  <span className="block truncate text-[12px] text-muted">
                    {[r.companyName, r.city].filter(Boolean).join(" · ") || r.mobile || "—"}
                  </span>
                </Cell>
                <Cell truncate={180}>
                  {stageLabel(r.stage)}
                  <span className="block truncate text-[12px] text-muted">
                    on §3B, which ends at an appointment
                  </span>
                </Cell>
                <Cell truncate={160}>
                  {r.salesmanId ? (
                    r.salesmanName
                  ) : (
                    <span className="text-warn-ink">Nobody</span>
                  )}
                </Cell>
                <Cell truncate={160}>
                  {r.leadManagerName ?? <span className="text-warn-ink">Nobody</span>}
                </Cell>
                <Cell>
                  {plural(r.stuckDays, "day")}
                  <span className="block text-[12px] text-muted">
                    {r.stageSince ? `since ${shortDate(r.stageSince)}` : "no stage date"}
                  </span>
                </Cell>
                <Cell>{plural(r.quietDays, "day")}</Cell>
                <Cell>
                  {/* A chain already open is not a stall of the same kind, and
                      it is the fact that decides where the lead should land:
                      somebody got as far as asking for a signature. */}
                  {r.approvals > 0 ? (
                    <Pill tone="warn">{plural(r.approvals, "step")} raised</Pill>
                  ) : (
                    <span className="text-[12px] text-muted">never asked</span>
                  )}
                </Cell>
              </Row>
            ))}
          </Table>
        </>
      )}
    </div>
  );
}
