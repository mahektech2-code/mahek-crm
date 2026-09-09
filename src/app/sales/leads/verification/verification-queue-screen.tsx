"use client";

import * as React from "react";
import Link from "next/link";
import { money, shortDate, stamp } from "@/lib/format";
import { salesTypeLabel } from "@/lib/lead-labels";
import type { VerificationRow } from "@/lib/services/lead-console-service";
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
import { VerificationForm } from "../verification-form";

/**
 * My verification queue.
 *
 * **Mine and everybody's are two chips, not two screens.** The call belongs to
 * the lead manager whose territory the shop sits in, and the ordinary morning is
 * working your own. But a lead in a territory nobody covers has a null manager
 * and would then belong to no queue at all — which is exactly the row somebody
 * has to see, because nobody else is going to. It is shown under "everybody"
 * and marked, rather than dropped.
 *
 * **The wait is drawn against a configured number, not a mood.**
 * `leads.verificationDueDays` is what "overdue" means here, and it is one
 * setting rather than a threshold typed into this screen.
 */
export function VerificationQueueScreen({
  rows,
  total,
  mineCount,
  mineOnly,
  dueDays,
  canVerify,
}: {
  rows: VerificationRow[];
  /** From SQL — a capped list still says what it is a slice of. */
  total: number;
  mineCount: number;
  mineOnly: boolean;
  dueDays: number;
  canVerify: boolean;
}) {
  const [calling, setCalling] = React.useState<VerificationRow | null>(null);

  const shown = mineOnly ? rows.filter((r) => r.mine) : rows;
  const overdue = shown.filter((r) => r.waitingDays > dueDays);
  const unowned = rows.filter((r) => !r.leadManagerId);
  const oldest = shown.reduce((n, r) => Math.max(n, r.waitingDays), 0);

  return (
    <div className="p-6">
      <ScreenHeader
        title="Verification queue"
        subtitle="Prospects waiting on a sales manager's call. Qualification does not open until one is recorded, so every day here is a day the salesman cannot move — which is why it is oldest first and nothing else."
        actions={
          <Link
            href="/sales/leads"
            className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
          >
            ← All leads
          </Link>
        }
      />

      <FilterChips
        current={mineOnly ? "mine" : "all"}
        options={[
          { key: "mine", label: "Mine", href: "/sales/leads/verification", count: mineCount },
          {
            key: "all",
            label: "Everybody's",
            href: "/sales/leads/verification?who=all",
            count: total,
          },
        ]}
      />

      {overdue.length ? (
        <Banner
          tone="warn"
          title={`${plural(overdue.length, "prospect")} past ${plural(dueDays, "day")}`}
          body={`Oldest has been waiting ${plural(oldest, "day")}. Nothing about these leads is wrong — they are stopped, and the only thing that starts them again is the call.`}
        />
      ) : null}

      {!mineOnly && unowned.length ? (
        <Banner
          tone="danger"
          title={`${plural(unowned.length, "prospect")} with no lead manager`}
          body="No territory covers these, so they are in nobody's queue. A lead nobody owns is the one most likely to sit for a month, which is why it is said in words rather than left off the list."
        />
      ) : null}

      <MetricRow
        metrics={[
          { label: "Mine", value: String(mineCount) },
          { label: "All waiting", value: String(total) },
          {
            label: "Oldest",
            value: shown.length ? plural(oldest, "day") : "—",
            tone: oldest > dueDays ? "warn" : undefined,
          },
          {
            label: "Nobody's",
            value: String(unowned.length),
            tone: unowned.length ? "danger" : undefined,
          },
        ]}
      />

      {shown.length === 0 ? (
        <Empty
          title={mineOnly ? "Nothing waiting on you" : "Nothing waiting on anybody"}
          body="A prospect reaches this queue the moment a salesman promotes a suspect. An empty queue means every one of them has been rung, which is the whole point of the screen."
        />
      ) : (
        <>
          {rows.length < total ? (
            <p className="mb-2 text-[12px] text-muted">
              Showing the oldest {rows.length} of {total}.
            </p>
          ) : null}
          <Table
            minWidth={1220}
            head={
              <>
                <HeadCell width={230}>Prospect</HeadCell>
                <HeadCell width={140}>Sales type</HeadCell>
                <HeadCell width={160}>Salesman</HeadCell>
                <HeadCell width={160}>Lead manager</HeadCell>
                <HeadCell width={130}>Waiting</HeadCell>
                <HeadCell width={230}>What we already know</HeadCell>
                <HeadCell align="right" width={170} />
              </>
            }
          >
            {shown.map((r, i) => (
              <Row key={r.customerId} striped={i % 2 === 1}>
                <Cell truncate={230}>
                  <Link href={`/sales/leads/${r.customerId}`} className="no-underline">
                    {r.name}
                  </Link>
                  <span className="block truncate text-[12px] text-muted">
                    {[r.companyName, r.city].filter(Boolean).join(" · ") || r.mobile || "—"}
                  </span>
                </Cell>
                <Cell>{salesTypeLabel(r.salesType)}</Cell>
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
                  {r.leadManagerName ?? (
                    <span
                      className="text-danger"
                      title="No territory covers this lead, so nobody's queue holds it."
                    >
                      Nobody
                    </span>
                  )}
                </Cell>
                <Cell>
                  {plural(r.waitingDays, "day")}
                  {r.waitingDays > dueDays ? (
                    <span className="ml-1.5">
                      <Pill tone="warn">Overdue</Pill>
                    </span>
                  ) : null}
                  {r.prospectSince ? (
                    <span className="block text-[12px] text-muted">
                      since {shortDate(r.prospectSince)}
                    </span>
                  ) : null}
                </Cell>
                <Cell truncate={230}>
                  <span className="block truncate text-[13px] text-body">
                    {r.competitor ? `Using ${r.competitor}` : "Competitor not established"}
                  </span>
                  <span className="block truncate text-[12px] text-muted">
                    {r.monthlyLitres ? `${r.monthlyLitres} L a month` : "no volume"}
                    {r.potentialPaise ? ` · ${money(r.potentialPaise)}` : ""}
                    {r.requiredProductName ? ` · ${r.requiredProductName}` : ""}
                  </span>
                </Cell>
                <Cell align="right">
                  {r.attempts ? (
                    <span
                      className="mr-2 text-[12px] text-muted"
                      title={r.lastAttemptAt ? `Last tried ${stamp(r.lastAttemptAt)}` : undefined}
                    >
                      tried {plural(r.attempts, "time")}
                    </span>
                  ) : null}
                  <Button
                    size="sm"
                    tone="primary"
                    disabled={!canVerify}
                    title={
                      canVerify
                        ? undefined
                        : "The verification call is a sales manager's. Yours is not one of the hats that carries it."
                    }
                    onClick={() => setCalling(r)}
                  >
                    Call
                  </Button>
                </Cell>
              </Row>
            ))}
          </Table>
        </>
      )}

      {/* Keyed on the row, so picking a different prospect REMOUNTS the form
          with fresh answers rather than an effect clearing them — the React
          Compiler rules are on and a reset-in-effect is what they forbid. */}
      {calling ? (
        <VerificationForm
          key={calling.customerId}
          customerId={calling.customerId}
          customerName={calling.name}
          detail={
            [calling.companyName, calling.city].filter(Boolean).join(" · ") ||
            calling.mobile ||
            undefined
          }
          known={[
            calling.competitor ? { label: "Using", value: calling.competitor } : null,
            calling.monthlyLitres
              ? { label: "A month", value: `${calling.monthlyLitres} L` }
              : null,
            calling.requiredProductName
              ? { label: "Wants", value: calling.requiredProductName }
              : null,
            calling.salesmanName ? { label: "Visited by", value: calling.salesmanName } : null,
            calling.mobile ? { label: "Ring", value: calling.mobile } : null,
          ].filter((k): k is { label: string; value: string } => Boolean(k))}
          open
          onClose={() => setCalling(null)}
        />
      ) : null}
    </div>
  );
}
