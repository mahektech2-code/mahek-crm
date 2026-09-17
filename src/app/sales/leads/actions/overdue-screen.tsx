"use client";

import * as React from "react";
import Link from "next/link";
import { shortDate } from "@/lib/format";
import { salesTypeLabel, stageLabel } from "@/lib/lead-labels";
import type {
  ActionOwnerCandidate,
  NextActionRow,
  OwnerTally,
} from "@/lib/services/lead-actions-service";
import {
  Banner,
  Button,
  Cell,
  Empty,
  FilterChips,
  HeadCell,
  MetricRow,
  Pill,
  Row,
  ScreenHeader,
  Table,
} from "../../parts";
import { plural } from "../../words";
import { NextActionModal } from "./due-screen";

/* ---------------------------------------------------------------------------
 * Past its day, with nobody having said anything since.
 *
 * The same four answers and the same read as the Due tab; what differs is the
 * window and what the screen is FOR. Due today is a morning's work. This is the
 * list that should not exist: every row on it is a promise somebody made, a day
 * that went by, and an outcome nobody wrote down — which is §24 failing
 * quietly, because the lead still LOOKS planned.
 *
 * **Most overdue first**, and the number of days is drawn rather than the date
 * alone. "Due 14 Aug" on a screen read in September is a date somebody has to
 * subtract; "35 days past" is the finding itself. The date is still printed
 * beside it, because a day count with nothing behind it is a number nobody can
 * check.
 *
 * **An outcome recorded takes a row off this list, and that is counted rather
 * than implied.** A lead whose call was made and whose answer was written down
 * has been worked whatever its date says. Without the count beside the table, a
 * team that is closing these and a team that never had any both draw the same
 * empty screen.
 * ------------------------------------------------------------------------- */

export function OverdueScreen({
  day,
  rows,
  total,
  incomplete,
  owners,
  ownerId,
  answered,
  candidates,
  canWork,
  requireNextAction,
}: {
  day: string;
  rows: NextActionRow[];
  total: number;
  incomplete: number;
  owners: OwnerTally[];
  ownerId?: string;
  /** Overdue days whose outcome HAS since been recorded. Not on this list. */
  answered: number;
  candidates: ActionOwnerCandidate[];
  canWork: boolean;
  requireNextAction: boolean;
}) {
  const [editing, setEditing] = React.useState<NextActionRow | null>(null);

  const chips = [
    {
      key: "all",
      label: "Everybody",
      href: "/sales/leads/actions/overdue",
      count: owners.reduce((n, o) => n + o.count, 0),
    },
    ...owners.map((o) => ({
      key: o.ownerId ?? "nobody",
      label: o.ownerName ?? "Nobody",
      href: o.ownerId
        ? `/sales/leads/actions/overdue?owner=${encodeURIComponent(o.ownerId)}`
        : "/sales/leads/actions/overdue",
      count: o.count,
    })),
  ];

  /* The server orders worst-first, so the head of the list is the worst one
     there is. Read off the rows rather than asked for separately: it is the
     row already on the page, and a second query to restate it could disagree
     with the table underneath it. */
  const worst = rows.reduce((n, r) => Math.max(n, r.overdueDays), 0);

  return (
    <>
      <ScreenHeader
        title="Past its day"
        subtitle="A next action whose day has gone with nobody recording an outcome. Nothing here should stay here — each row is either work somebody still owes, or a promise that needs replacing with an honest one."
        actions={
          <Link
            href="/sales/leads/actions"
            className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
          >
            ← Owed today
          </Link>
        }
      />

      {worst >= 30 ? (
        <Banner
          tone="danger"
          title={`The oldest has been sitting for ${plural(worst, "day")}`}
          body="A month past its day with nothing recorded is not a late call; it is a lead nobody is working that still reads as planned on every other screen. That is the exact shape §24 was written to make visible."
        />
      ) : null}

      <MetricRow
        metrics={[
          { label: "Past its day", value: String(total), tone: total ? "danger" : "success" },
          { label: "Oldest", value: total ? plural(worst, "day") : "—" },
          {
            label: "Missing an answer",
            value: String(incomplete),
            tone: incomplete ? "warn" : undefined,
          },
          { label: "Answered since", value: String(answered), tone: answered ? "success" : undefined },
        ]}
      />

      {chips.length > 1 ? <FilterChips options={chips} current={ownerId ?? "all"} /> : null}

      {rows.length === 0 ? (
        <Empty
          title={ownerId ? "Nothing of theirs is late" : "Nothing is past its day"}
          body={
            answered
              ? `Which is the rule holding rather than nothing being checked — ${plural(answered, "promise")} came due and had an outcome written against it.`
              : "No active lead has a next action dated before today with nothing recorded against it. Worth reading beside the Nothing scheduled tab: a book with nothing overdue because nothing was ever promised is the other way this rule fails."
          }
        />
      ) : (
        <>
          {rows.length < total ? (
            <p className="mb-2 text-[12px] text-muted">
              Showing the worst {rows.length} of {total}.
            </p>
          ) : null}
          <Table
            minWidth={1300}
            head={
              <>
                <HeadCell width={230}>Lead</HeadCell>
                <HeadCell width={140}>How late</HeadCell>
                <HeadCell width={230}>The action</HeadCell>
                <HeadCell width={170}>Whose</HeadCell>
                <HeadCell width={230}>What they come back with</HeadCell>
                <HeadCell width={120}>Quiet</HeadCell>
                <HeadCell width={140}>&nbsp;</HeadCell>
              </>
            }
          >
            {rows.map((r, i) => (
              <Row key={r.customerId} striped={i % 2 === 1}>
                <Cell truncate={230}>
                  <Link href={`/sales/leads/${r.customerId}`} className="no-underline">
                    {r.name}
                  </Link>
                  <span className="block truncate text-[12px] text-muted">
                    {stageLabel(r.stage)} · {salesTypeLabel(r.salesType)}
                  </span>
                </Cell>
                <Cell>
                  <Pill tone={r.overdueDays >= 14 ? "danger" : "warn"}>
                    {plural(r.overdueDays, "day")} past
                  </Pill>
                  <span className="block text-[12px] text-muted">
                    due {r.actionDate ? shortDate(r.actionDate) : "—"}
                  </span>
                </Cell>
                <Cell truncate={230}>
                  {r.action ?? <span className="text-danger">No action written</span>}
                </Cell>
                <Cell truncate={170}>
                  {r.ownerId ? (
                    r.ownerName
                  ) : (
                    <span
                      className="text-danger"
                      title="The day was written down and the person was not, so nobody was ever going to be late — which is why it sat."
                    >
                      Nobody
                    </span>
                  )}
                  {r.leadManagerName ? (
                    <span className="block truncate text-[12px] text-muted">
                      manager {r.leadManagerName}
                    </span>
                  ) : null}
                </Cell>
                <Cell truncate={230}>
                  {r.outcome ?? <span className="text-warn-ink">Nothing expected</span>}
                </Cell>
                <Cell>{plural(r.quietDays, "day")}</Cell>
                <Cell>
                  <Button
                    size="sm"
                    disabled={!canWork}
                    title={
                      canWork
                        ? "Replace it with a day somebody will actually keep, and say what they come back with."
                        : "Setting a next action needs lead.work, which this account does not hold."
                    }
                    onClick={() => setEditing(r)}
                  >
                    Re-plan it
                  </Button>
                </Cell>
              </Row>
            ))}
          </Table>
        </>
      )}

      <NextActionModal
        row={editing}
        day={day}
        candidates={candidates}
        requireNextAction={requireNextAction}
        onClose={() => setEditing(null)}
      />
    </>
  );
}
