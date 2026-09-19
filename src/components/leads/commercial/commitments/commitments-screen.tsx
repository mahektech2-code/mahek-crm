"use client";

import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import * as React from "react";
import Link from "next/link";
import { money, shortDate } from "@/lib/format";
import { commitmentSizeLabel } from "@/lib/lead-commitment";
import { salesTypeLabel, stageLabel } from "@/lib/lead-labels";
import type { HandoverCandidate } from "@/lib/services/lead-console-service";
import type { CommitmentRow, CommitmentView } from "@/lib/services/lead-commercial-service";
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
} from "@/components/console/parts";
import { plural } from "@/components/console/words";
import { LeadTabs } from "../../lead-tabs";
import { FirstOrderPanel } from "../../first-order-panel";
import { NextActionModal } from "../negotiation-screen";

/* ---------------------------------------------------------------------------
 * 17 — A COMMITMENT IS NOT AN ORDER, AND THIS SCREEN EXISTS TO KEEP THEM APART.
 *
 * `lead_expected_order_date`, `lead_expected_order_cans` and
 * `lead_expected_order_value_paise` are what a customer said on a phone call
 * when somebody ran the eight questions. They
 * are worth chasing and they are not revenue: nothing has been billed, nothing
 * has been approved by accounts, and the product master cannot price an order
 * at all — `canValueOrders()` still answers no — so even the figure is
 * somebody's estimate rather than a price.
 *
 * So every figure on this screen is LABELLED a forecast, in the markup and not
 * only in a variable name, and the one total it draws says so in the label
 * above it. See the comment over that total.
 *
 * FOUR VIEWS, ONE LIST. Open is a day that has not come round; Due this week
 * is the next seven days of it; Converted is an account that has since taken a
 * real order. SLIPPED — a promised day gone past with nothing on the ledger —
 * is the view that earns the screen, because it is the only one nobody can see
 * anywhere else: an unkept promise leaves no row of its own anywhere in
 * MahekOne.
 *
 * AND A DAY WITH NO SIZE IS LISTED HERE AND COUNTED IN NOTHING. §3.4 says a
 * commitment is an expected date AND a quantity or a value; "he said the 25th
 * and could not say how much" is a follow-up. It stays on this screen because
 * this is the only screen that watches these days go past, and dropping it
 * would hide the very row somebody has to ring back about — it is marked on
 * its row, counted in its own metric, and in none of the money.
 * ------------------------------------------------------------------------- */

export function CommitmentsScreen({
  workspace,
  view,
  rows,
  counts,
  forecastValuePaise,
  unvalued,
  unconfirmed,
  day,
  people,
  canWork,
}: {
  /** Which app is drawing this. See `lib/lead-workspace.ts`. */
  workspace: LeadWorkspace;
  view: CommitmentView;
  rows: CommitmentRow[];
  counts: Record<CommitmentView, number>;
  /** The sum for THIS view. A forecast — read the comment where it is drawn. */
  forecastValuePaise: number;
  /** Commitments with no estimate against them. Not zero; nobody said. */
  unvalued: number;
  /** §3.4 — rows on this view that are an expected order rather than one. */
  unconfirmed: number;
  day: string;
  people: HandoverCandidate[];
  canWork: boolean;
}) {
  const [planning, setPlanning] = React.useState<CommitmentRow | null>(null);
  const [confirming, setConfirming] = React.useState<CommitmentRow | null>(null);

  const refused = "Only somebody who works leads can do this.";
  const shown = counts[view];

  return (
    <div className="p-6">
      <LeadTabs workspace={workspace} />

      <ScreenHeader
        title="Commitments & forecast"
        subtitle="A day and a figure a customer gave somebody on a phone call. Every number on this screen is a forecast and none of it is revenue — nothing here has been billed, approved or received, and no total on this page may be added to a real order value."
        actions={
          <Link
            href={leadHref(workspace, "leads/commercial")}
            className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
          >
            ← Negotiation desk
          </Link>
        }
      />

      <FilterChips
        current={view}
        options={[
          { key: "open", label: "Open", href: "?view=open", count: counts.open },
          { key: "due", label: "Due this week", href: "?view=due", count: counts.due },
          { key: "slipped", label: "Slipped", href: "?view=slipped", count: counts.slipped },
          {
            key: "converted",
            label: "Converted",
            href: "?view=converted",
            count: counts.converted,
          },
        ]}
      />

      {view === "slipped" && counts.slipped ? (
        <Banner
          tone="danger"
          title={`${plural(counts.slipped, "promised day")} gone past with no order`}
          body="A commitment that slips leaves no row of its own anywhere in MahekOne — the date simply ages and nothing changes colour. This is the only screen it shows on, which is why it is a view rather than a report somebody remembers to run."
        />
      ) : null}

      <MetricRow
        metrics={[
          { label: "On this view", value: String(shown) },
          {
            /*
             * THIS TOTAL IS A FORECAST AND MAY NEVER BE ADDED TO A REAL ORDER
             * VALUE.
             *
             * It is the sum of what customers SAID they would place, over the
             * rows on this view only. It is not revenue, not pipeline value
             * anybody has priced, and not a figure that belongs beside an EOD
             * total, a target, a bill or an outstanding balance. Adding it to
             * one would overstate the book by exactly the amount nobody has
             * bought — so the label says "forecast" rather than the tone
             * saying it, because a tone is not a word anybody reads back.
             */
            label: "Forecast on this view",
            value: money(forecastValuePaise),
            sub: "What customers said · never revenue",
          },
          {
            label: "No estimate given",
            value: String(unvalued),
            sub: unvalued ? "Not zero — nobody judged it" : undefined,
            tone: unvalued ? "warn" : undefined,
          },
          {
            /* NOT folded into "No estimate given": that one is a commitment
               whose VALUE nobody guessed, which is still a commitment because
               the quantity carries it. This is a row where neither half was
               given, so there is nothing to forecast at all. Two different
               phone calls to make. */
            label: "Not a commitment yet",
            value: String(unconfirmed),
            sub: unconfirmed ? "A day, and nobody asked how much" : undefined,
            tone: unconfirmed ? "warn" : undefined,
          },
          {
            label: "Slipped, all views",
            value: String(counts.slipped),
            tone: counts.slipped ? "danger" : undefined,
          },
        ]}
      />

      {rows.length === 0 ? (
        <Empty title={EMPTY[view].title} body={EMPTY[view].body} />
      ) : (
        <>
          {rows.length < shown ? (
            <p className="mb-2 text-[12px] text-muted">
              Showing the {rows.length} with the oldest promised day, of {shown}.
            </p>
          ) : null}

          <Table
            minWidth={1380}
            head={
              <>
                <HeadCell width={240}>Lead</HeadCell>
                <HeadCell width={120}>Sales type</HeadCell>
                <HeadCell width={140}>Rung</HeadCell>
                <HeadCell width={200}>Promised day · forecast</HeadCell>
                <HeadCell width={170} align="right">
                  Forecast value
                </HeadCell>
                <HeadCell width={220}>On the ledger</HeadCell>
                <HeadCell width={230}>&nbsp;</HeadCell>
              </>
            }
          >
            {rows.map((r, i) => (
              <Row key={r.customerId} striped={i % 2 === 1}>
                <Cell truncate={240}>
                  <Link href={leadHref(workspace, `leads/${r.customerId}`)} className="no-underline">
                    {r.name}
                  </Link>
                  <span className="block truncate text-[12px] text-muted">
                    {[r.companyName, r.city].filter(Boolean).join(" · ") || "—"}
                  </span>
                </Cell>
                <Cell>{salesTypeLabel(r.salesType)}</Cell>
                <Cell>{stageLabel(r.stage)}</Cell>
                <Cell>
                  {shortDate(r.forecastDate)}
                  <span className="block text-[12px] text-muted">
                    {r.daysUntil < 0
                      ? `${plural(-r.daysUntil, "day")} past — forecast`
                      : r.daysUntil === 0
                        ? "today — forecast"
                        : `in ${plural(r.daysUntil, "day")} — forecast`}
                  </span>
                </Cell>
                <Cell align="right">
                  {/*
                    A forecast figure, and the word rides WITH it rather than
                    living in the column heading alone: this cell is read one
                    row at a time beside a real order value two columns over,
                    and a heading four lines up is not what somebody reads.
                    Null is a named gap — nobody estimated it, which is not
                    the same as nothing being expected.
                  */}
                  {r.confirmed ? (
                    <>
                      <span className="tabular-nums">
                        {commitmentSizeLabel(
                          {
                            expectedOrderDate: r.forecastDate,
                            expectedOrderCans: r.forecastCans,
                            expectedOrderValuePaise: r.forecastValuePaise,
                          },
                          money,
                        )}
                      </span>
                      <span className="block text-[12px] text-muted">forecast</span>
                    </>
                  ) : (
                    /*
                      §3.4 SAID ON THE ROW, because this is where somebody
                      decides which name to ring. "Not estimated" was the old
                      words and they were too kind: they read as a figure
                      nobody bothered to guess, when what is actually true is
                      that nobody knows whether this day is worth anything at
                      all.
                    */
                    <span className="text-muted">
                      Not a commitment
                      <span className="block text-[12px]">
                        No quantity or value — ask, and it counts
                      </span>
                    </span>
                  )}
                </Cell>
                <Cell truncate={220}>
                  {/*
                    THE ONLY REAL MONEY ON THIS SCREEN, and it is deliberately
                    never added to the forecast beside it. It is the first
                    COUNTING order on the account — `PURCHASE_STATUSES`
                    through `orderCountsSql`, never three statuses typed out.
                  */}
                  {r.countingOrders ? (
                    <>
                      <Pill tone="success">Ordered</Pill>
                      <span className="block truncate text-[12px] text-muted">
                        {r.firstOrderDate ? shortDate(r.firstOrderDate) : "—"}
                        {r.firstOrderValuePaise != null
                          ? ` · ${money(r.firstOrderValuePaise)} billed value`
                          : ""}
                      </span>
                    </>
                  ) : (
                    <span className="text-muted">
                      Nothing on the ledger
                      <span className="block text-[12px]">
                        No order accounts have counted as a sale
                      </span>
                    </span>
                  )}
                </Cell>
                <Cell>
                  <span className="flex justify-end gap-2">
                    <Button
                      size="sm"
                      disabled={!canWork}
                      title={canWork ? "§24 — the action, the day and the person" : refused}
                      onClick={() => setPlanning(r)}
                    >
                      Next action
                    </Button>
                    <Button
                      size="sm"
                      tone="primary"
                      disabled={!canWork}
                      title={
                        canWork
                          ? "Quote the forecast back and record what they actually said"
                          : refused
                      }
                      onClick={() => setConfirming(r)}
                    >
                      {r.countingOrders ? "Ask again" : "Confirm the order"}
                    </Button>
                  </span>
                </Cell>
              </Row>
            ))}
          </Table>
        </>
      )}

      {/*
        The confirm panel, quoting the commitment back BEFORE the form — which
        is the whole reason it is drawn rather than the row's date being handed
        silently to the dialog. Somebody about to record what a customer really
        said should be reading what they said last time, with the word
        "forecast" against it.

        `FirstOrderPanel` is imported rather than reimplemented: it is where the
        eight questions and the "the date is required and the value is not"
        rule live, and a second copy of that form would be a second answer to
        which of the eight are mandatory.
      */}
      {confirming ? (
        <section key={confirming.customerId} className="mt-5">
          <div className="mb-2 rounded-[6px] border border-line bg-canvas px-4 py-3">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-sm font-semibold text-ink">{confirming.name}</div>
                <p className="mt-0.5 text-[13px] text-muted">
                  Last time they said <strong>{shortDate(confirming.forecastDate)}</strong>
                  {confirming.confirmed
                    ? `, about ${commitmentSizeLabel(
                        {
                          expectedOrderDate: confirming.forecastDate,
                          expectedOrderCans: confirming.forecastCans,
                          expectedOrderValuePaise: confirming.forecastValuePaise,
                        },
                        money,
                      )}`
                    : ", with no quantity or value given, so not a commitment"}{" "}
                  — a forecast, and the only thing on this screen that is not.{" "}
                  {confirming.countingOrders
                    ? "A real order has since arrived on the account."
                    : "Nothing has arrived on the ledger against it."}
                </p>
              </div>
              <Button tone="quiet" size="sm" onClick={() => setConfirming(null)}>
                Close
              </Button>
            </div>
          </div>
          <FirstOrderPanel
            customerId={confirming.customerId}
            expectedOrderDate={confirming.forecastDate}
            expectedOrderCans={confirming.forecastCans}
            expectedOrderValuePaise={confirming.forecastValuePaise}
            countingOrderCount={confirming.countingOrders}
            disabled={!canWork}
            disabledReason={refused}
          />
        </section>
      ) : null}

      {planning ? (
        <NextActionModal
          key={planning.customerId}
          customerId={planning.customerId}
          subject={planning.name}
          day={day}
          people={people}
          onClose={() => setPlanning(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * An empty view says which empty it is.
 *
 * "No commitments" under Slipped and under Converted are opposite pieces of
 * news — one is nothing broken, the other is nothing achieved — and one
 * sentence for both is how a screen stops being read.
 */
const EMPTY: Record<CommitmentView, { title: string; body: string }> = {
  open: {
    title: "No open commitments",
    body: "Nobody is holding a promised day that has not come round yet. A commitment is recorded by asking for the first order, which is the eight questions — and a lead with no commitment against it shows on the negotiation desk as exactly that.",
  },
  due: {
    title: "Nothing promised this week",
    body: "No customer has named a day inside the next seven. This is a slice of Open rather than a list of its own, so an empty week with open commitments further out is an ordinary week.",
  },
  slipped: {
    title: "Nothing has slipped",
    body: "Every promised day either has not come round or produced an order. This is the one view on the screen that is supposed to be empty, and an empty one means the promises are being kept rather than that nothing is being checked.",
  },
  converted: {
    title: "No commitment has produced an order yet",
    body: "Converted counts a real order on the ledger — PURCHASE_STATUSES, what accounts have agreed is a sale — not a rung somebody moved by hand. An empty list here with commitments open elsewhere is a pipeline that has not landed rather than a screen that has lost something.",
  },
};
