"use client";

import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import * as React from "react";
import Link from "next/link";
import { stamp } from "@/lib/format";
import { stageLabel, salesTypeLabel } from "@/lib/lead-labels";
import type { HandoverCandidate } from "@/lib/services/lead-console-service";
import type { OutstandingHandover } from "@/lib/services/lead-oversight-service";
import { HandoverPanel } from "../record/handover-panel";
import {
  Banner,
  Button,
  Cell,
  Empty,
  HeadCell,
  MetricRow,
  Pill,
  Row,
  ScreenHeader,
  Table,
  plural,
} from "@/components/console/parts";

/**
 * §Q — the fifth seat, and the list a flag would have been.
 *
 * **WHETHER A HANDOVER IS OUTSTANDING IS DERIVED, NEVER STORED.** Converted,
 * and `handed_over_at` still null. A flag would be a cache, and the only facts
 * it could be rebuilt from are the two columns it would be caching — so there
 * would be nothing to rebuild it from, no recompute path, and a column that
 * goes wrong quietly and is believed. The sentence is on the screen and not
 * only in this comment, because the next person to look at this table will
 * wonder why there is no `handover_pending` column and the answer is worth
 * having in front of them.
 *
 * **It moves SIGHT and deliberately not a rupee**, and that line is the whole
 * reason the act is a manager's. `relationship_owner_id` is read by
 * `scopedToUsers` and `assertCustomerInScope` — who may SEE and WORK the
 * record — and is pointedly not read by `ASSIGNED_TO_SQL`, which answers whose
 * orders an account is and whose target it counts toward. Moving money is
 * `customer.reassign`, accounts' and admin's; this one moves none, which is
 * what makes `customer.handOver` a manager's.
 *
 * **The panel is the record's own, reused rather than rebuilt.** One dialog
 * asking one question in two places is one set of rules about who may press
 * it, what a reason costs and who gets told. A second copy typed into a list
 * screen is the half that drifts, and the half that drifts is always the half
 * somebody is reading.
 */
export function HandoversScreen({
  workspace,
  rows,
  total,
  candidates,
  reasonCodes,
  canWork,
  canHandOver,
}: {
  /** Which app is drawing this. See `lib/lead-workspace.ts`. */
  workspace: LeadWorkspace;
  rows: OutstandingHandover[];
  /** From SQL, not from `rows.length` — a capped list says what it is a slice of. */
  total: number;
  candidates: HandoverCandidate[];
  reasonCodes: string[];
  canWork: boolean;
  canHandOver: boolean;
}) {
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const selected = rows.find((r) => r.customerId === selectedId) ?? null;

  const oldest = rows.reduce<number | null>(
    (worst, r) => (r.waitingDays !== null && (worst === null || r.waitingDays > worst) ? r.waitingDays : worst),
    null,
  );

  return (
    <>
      <ScreenHeader
        title="Handovers"
        subtitle="Accounts that have converted and still have nobody named to run the relationship. This list is DERIVED — converted, and handed over never — and there is no flag behind it, because a flag would be a cache and the only facts it could be rebuilt from are the two columns it would be caching."
      />

      {/* What it moves and what it does not, in one line, above everything.
          Drawn as information rather than as a warning: this is the note that
          makes the act safe to perform, not a reason to hesitate over it. */}
      <Banner
        tone="info"
        title="A handover moves who RUNS the account, and no money at all."
        body={
          <>
            It writes <code className="text-[12px]">relationship_owner_id</code>, which decides who
            may see and work the record. It does not touch the sales seat, the owner, the account&rsquo;s
            kind or its decision mark — so no target moves, no collections list changes and nobody&rsquo;s
            revenue is credited differently. That is precisely why it is a manager&rsquo;s
            (<code className="text-[12px]">customer.handOver</code>) rather than accounts&rsquo; and
            admin&rsquo;s (<code className="text-[12px]">customer.reassign</code>), which is the one that
            moves numbers between a manager&rsquo;s own people.
          </>
        }
      />

      <MetricRow
        metrics={[
          {
            label: "Nobody running them",
            value: String(total),
            sub: "converted, handed over never",
            tone: total > 0 ? "warn" : undefined,
          },
          {
            label: "Longest wait",
            value: oldest === null ? "—" : plural(oldest, "day"),
            sub: oldest === null ? "nothing waiting" : "since it converted",
            tone: oldest !== null && oldest > 30 ? "danger" : undefined,
          },
          {
            label: "People it can go to",
            value: String(candidates.length),
            sub: "with a login and a book",
          },
        ]}
      />

      {rows.length === 0 ? (
        <Empty
          title="Every converted account has an owner"
          body="Nothing has converted without somebody named to run the relationship. This list is asked of the book every time it is opened, so it empties itself the moment the last one is handed over."
        />
      ) : (
        <Table
          minWidth={980}
          head={
            <>
              <HeadCell width={260}>Account</HeadCell>
              <HeadCell width={130}>City</HeadCell>
              <HeadCell width={130}>Rung</HeadCell>
              <HeadCell width={150}>Converted</HeadCell>
              <HeadCell width={90} align="right">
                Waiting
              </HeadCell>
              <HeadCell width={150}>Lead manager</HeadCell>
              <HeadCell width={150}>Sales seat</HeadCell>
              <HeadCell width={120} />
            </>
          }
        >
          {rows.map((r, i) => (
            <Row
              key={r.customerId}
              striped={i % 2 === 1}
              selected={r.customerId === selectedId}
              onClick={() => setSelectedId(r.customerId)}
            >
              <Cell truncate={250}>
                <Link href={leadHref(workspace, `leads/${r.customerId}`)} className="font-medium text-ink">
                  {r.name}
                </Link>
                {r.companyName && r.companyName !== r.name ? (
                  <div className="text-[12px] text-muted">{r.companyName}</div>
                ) : null}
              </Cell>
              <Cell truncate={120}>{r.city ?? <span className="text-muted">—</span>}</Cell>
              <Cell>
                {r.stage ? (
                  <Pill tone="success">{stageLabel(r.stage)}</Pill>
                ) : (
                  /* Conversion writes the rung and the instant together, so
                     this should not happen. Said in words rather than filled
                     in: a rung invented here would be read as one somebody
                     recorded. */
                  <span className="text-[12px] text-warn-ink">rung not recorded</span>
                )}
                {r.salesType ? (
                  <div className="text-[12px] text-muted">{salesTypeLabel(r.salesType)}</div>
                ) : null}
              </Cell>
              <Cell>
                {r.convertedAt ? (
                  stamp(r.convertedAt)
                ) : (
                  <span className="text-muted">not recorded</span>
                )}
              </Cell>
              <Cell align="right">
                {r.waitingDays === null ? (
                  <span className="text-muted">—</span>
                ) : (
                  <span className={r.waitingDays > 30 ? "font-medium text-danger" : undefined}>
                    {r.waitingDays}d
                  </span>
                )}
              </Cell>
              <Cell truncate={140}>
                {r.leadManagerName ?? <span className="text-muted">nobody</span>}
              </Cell>
              <Cell truncate={140} title="Whose book it is for crediting orders. A handover does not move this.">
                {r.salesSeatName ?? <span className="text-muted">unassigned</span>}
              </Cell>
              <Cell onClick={(e) => e.stopPropagation()}>
                <Button
                  size="sm"
                  disabled={!canHandOver}
                  title={
                    canHandOver
                      ? undefined
                      : "Naming who runs an account is a manager's. It moves no revenue and no target — the sales seat, which does, is changed by accounts on the customer record."
                  }
                  onClick={() => setSelectedId(r.customerId)}
                >
                  Name the owner
                </Button>
              </Cell>
            </Row>
          ))}
        </Table>
      )}

      {rows.length > 0 && total > rows.length ? (
        <p className="mt-2 text-[12px] text-muted">
          Showing the {rows.length} longest-waiting of {total}. The count comes from the book, not
          from this page.
        </p>
      ) : null}

      {/* The record's own panel, keyed on the account so it remounts with
          fresh state rather than having an effect reset it — the React
          Compiler rules are on and that is the pattern every drawer here
          follows. */}
      {selected && !selected.stage ? (
        <div className="mt-5">
          <Banner
            tone="warn"
            title="This account has no rung recorded, so the handover panel cannot be drawn for it."
            body={
              <>
                Converting an account writes the rung and the instant together, so a converted
                account with no <code className="text-[12px]">lead_stage</code> is a row nothing in
                this codebase produces. The panel decides from the rung whether an account is on the
                book yet, and supplying one here would be inventing a fact somebody would read as
                recorded. Open the record and the funnel&rsquo;s own history will say what happened to
                it.
              </>
            }
            action={
              <Link
                href={leadHref(workspace, `leads/${selected.customerId}`)}
                className="text-[13px] font-medium text-[#5223E0]"
              >
                Open the record
              </Link>
            }
          />
        </div>
      ) : null}

      {selected && selected.stage ? (
        <div className="mt-5">
          <HandoverPanel
            key={selected.customerId}
            customerId={selected.customerId}
            leadName={selected.name}
            stage={selected.stage}
            salesType={selected.salesType}
            convertedAt={selected.convertedAt}
            leadManagerName={selected.leadManagerName}
            currentOwnerId={selected.relationshipOwnerId}
            currentOwnerName={selected.relationshipOwnerName}
            candidates={candidates}
            reasonCodes={reasonCodes}
            canWork={canWork}
            canHandOver={canHandOver}
          />
        </div>
      ) : null}
    </>
  );
}
