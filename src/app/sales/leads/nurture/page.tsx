import Link from "next/link";
import { shortDate, stamp } from "@/lib/format";
import { today } from "@/lib/recompute";
import { NURTURE_SEQUENCE } from "@/lib/lead-labels";
import { nurtureSchedule, type NurtureRow } from "@/lib/services/lead-console-service";
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

export const metadata = { title: "Nurture schedule — Sales Dashboard — MahekOne" };

/**
 * §13 — the nurture sequence, visible.
 *
 * A schedule nobody can see is one nobody trusts, and a sequence whose output
 * is invisible is indistinguishable from one that is not running. That is not a
 * hypothetical here: the nightly job that deleted every field photograph ran
 * silently for a year because nothing showed what it had done.
 *
 * So this screen shows three things — what is overdue, what is due today, and
 * what has fired — beside the fifteen rules that produce them. The rules are
 * printed rather than described, because "why has nobody been asked to send
 * the brochure" is a question about the SEQUENCE rather than about a task, and
 * it cannot be answered from a list of tasks that were never raised.
 *
 * Server-only: there is nothing to do from here except open a lead.
 */
export default async function Page() {
  const day = await today();
  const schedule = await nurtureSchedule(day, { limit: 80 });

  return (
    <div className="p-6">
      <ScreenHeader
        title="Nurture schedule"
        subtitle="What the sequence has raised, what is late, and what fired. Fifteen rules produce these; the rules are printed at the bottom so a missing task can be traced to the trigger that never happened."
        actions={
          <Link
            href="/sales/leads"
            className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
          >
            ← All leads
          </Link>
        }
      />

      {schedule.counts.overdue ? (
        <Banner
          tone="warn"
          title={`${plural(schedule.counts.overdue, "nurture task")} past its day`}
          body="Each of these is a call or a file somebody was asked for on a date that has gone. The sequence does not chase itself — it raises the task and stops."
        />
      ) : null}

      <MetricRow
        metrics={[
          {
            label: "Overdue",
            value: String(schedule.counts.overdue),
            tone: schedule.counts.overdue ? "warn" : undefined,
          },
          { label: "Due today", value: String(schedule.counts.today) },
          { label: "Ahead", value: String(schedule.counts.ahead) },
          { label: "Done", value: String(schedule.counts.done), tone: "success" },
        ]}
      />

      {schedule.counts.overdue + schedule.counts.today + schedule.counts.ahead === 0 ? (
        <Empty
          title="Nothing scheduled"
          body="No lead has reached a rung that raises a task, or the sequence has not run. Both are possible and they look identical from here — the rules below say what each one fires from."
        />
      ) : (
        <>
          <Group
            title="Overdue"
            note="Worst first. The day has gone and nobody has recorded an outcome."
            rows={schedule.overdue}
            total={schedule.counts.overdue}
            tone="warn"
          />
          <Group
            title="Due today"
            note="What somebody is expected to do before this evening."
            rows={schedule.today}
            total={schedule.counts.today}
          />
          <Group
            title="Ahead"
            note="Raised and dated. A task with no day at all is listed here too, and it is the one worth fixing."
            rows={schedule.ahead}
            total={schedule.counts.ahead}
          />
          <Group
            title="Fired"
            note="Done or cancelled. This is what makes the schedule believable — a sequence with no visible history is one nobody can tell has run."
            rows={schedule.done}
            total={schedule.counts.done}
            tone="success"
          />
        </>
      )}

      <section className="mt-6 rounded-[6px] border border-line bg-surface px-5 py-4">
        <div className="mb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
          The fifteen rules
        </div>
        <p className="mb-3 max-w-[680px] text-[12px] text-pretty text-muted">
          Read straight from the sequence rather than described, so this page cannot drift from
          what actually runs. `after` is days from the event that triggers it.
        </p>
        <div className="min-w-0 overflow-x-auto">
          <table className="w-full min-w-[860px] border-collapse text-[13px]">
            <thead>
              <tr>
                <HeadCell width={180}>Fires from</HeadCell>
                <HeadCell width={70}>After</HeadCell>
                <HeadCell width={140}>Whose</HeadCell>
                <HeadCell width={230}>Task</HeadCell>
                <HeadCell>What it is for</HeadCell>
              </tr>
            </thead>
            <tbody>
              {NURTURE_SEQUENCE.map((n, i) => (
                <Row key={`${n.trigger}-${n.title}`} striped={i % 2 === 1}>
                  <Cell className="text-muted">{n.trigger.replace(/_/g, " ")}</Cell>
                  <Cell>{n.after === 0 ? "same day" : `+${n.after}d`}</Cell>
                  <Cell>
                    {n.owner === "lead_manager" ? "Lead manager" : "Salesman"}
                  </Cell>
                  <Cell truncate={230}>{n.title}</Cell>
                  <Cell className="text-muted">{n.detail}</Cell>
                </Row>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Group({
  title,
  note,
  rows,
  total,
  tone,
}: {
  title: string;
  note: string;
  rows: NurtureRow[];
  /** From SQL, so a capped group says what it is a slice of. */
  total: number;
  tone?: "warn" | "success";
}) {
  if (!rows.length) return null;
  return (
    <section className="mb-5">
      <div className="mb-1.5">
        <h2 className="text-[15px] font-semibold text-ink">
          {title} <span className="font-normal text-muted">· {total}</span>
        </h2>
        <p className="text-[12px] text-muted">{note}</p>
      </div>
      <Table
        minWidth={1080}
        head={
          <>
            <HeadCell width={260}>Task</HeadCell>
            <HeadCell width={220}>Lead</HeadCell>
            <HeadCell width={170}>Whose</HeadCell>
            <HeadCell width={150}>Day</HeadCell>
            <HeadCell width={140}>State</HeadCell>
          </>
        }
      >
        {rows.map((t, i) => (
          <Row key={t.id} striped={i % 2 === 1}>
            <Cell truncate={260}>
              <span className="text-body">{t.title}</span>
              {t.description ? (
                <span className="block truncate text-[12px] text-muted">{t.description}</span>
              ) : null}
            </Cell>
            <Cell truncate={220}>
              {t.customerId ? (
                <Link href={`/sales/leads/${t.customerId}`} className="no-underline">
                  {t.customerName}
                </Link>
              ) : (
                <span className="text-muted">no lead</span>
              )}
            </Cell>
            <Cell truncate={170}>
              {t.assignedToName ?? <span className="text-warn-ink">Nobody</span>}
            </Cell>
            <Cell>
              {t.dueDate ? (
                shortDate(t.dueDate)
              ) : (
                <span
                  className="text-warn-ink"
                  title="No day was named, so nothing will ever call this overdue."
                >
                  No day
                </span>
              )}
            </Cell>
            <Cell>
              {t.completedAt ? (
                <>
                  <Pill tone="success">Done</Pill>
                  <span className="block text-[12px] text-muted">{stamp(t.completedAt)}</span>
                </>
              ) : t.dueInDays != null && t.dueInDays < 0 ? (
                <Pill tone="warn">{plural(-t.dueInDays, "day")} late</Pill>
              ) : t.dueInDays === 0 ? (
                <Pill tone="brand">Today</Pill>
              ) : (
                <Pill tone={tone === "success" ? "neutral" : "neutral"}>{t.status}</Pill>
              )}
            </Cell>
          </Row>
        ))}
      </Table>
    </section>
  );
}
