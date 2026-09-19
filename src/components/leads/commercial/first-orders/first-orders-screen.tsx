"use client";

import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { money, shortDate } from "@/lib/format";
import { nextStage } from "@/lib/engines/lead-ladder";
import { salesTypeLabel, stageLabel, type LeadStage } from "@/lib/lead-labels";
import type { LeadOrderRow, LeadReceiptRow } from "@/lib/services/lead-console-service";
import type { FirstOrderRow } from "@/lib/services/lead-commercial-service";
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
} from "@/components/console/parts";
import { plural } from "@/components/console/words";
import { LeadTabs } from "../../lead-tabs";
import { FirstOrderPanel } from "../../first-order-panel";
import { AdvanceStageModal } from "../negotiation-screen";

/* ---------------------------------------------------------------------------
 * 18 — the first order, and the two things everybody gets wrong about it.
 *
 * THIS SCREEN RENDERS ORDER STATUS AND NEVER WRITES IT — §20.
 *
 * Order Received → Confirmed → Dispatched → In Transit → Delivered is a
 * ladder, and it already has an owner: `orders.status` is written by the Order
 * Details projection, which restates it every thirty minutes, and by accounts'
 * approval. A second ladder kept by the funnel would be overwritten by the
 * first or would fight it into `sync_conflicts` — either way the screen would
 * be arguing with the sheet about one row, and the sheet would win. So every
 * status on this page is a READ, there is no control anywhere on it that
 * writes one, and what counts as a SALE comes from `PURCHASE_STATUSES` through
 * `orderCountsSql` rather than from three statuses typed into a query or a
 * component. The one thing the funnel does write is the rung, which is a
 * statement about the relationship rather than about the order.
 *
 * `kind` FLIPPED AT THE FIRST ORDER, NOT THE SECOND.
 *
 * §22 asks for the second order and this codebase says otherwise, deliberately:
 * a lead here IS an account that has never ordered, and about thirty readers of
 * `customers.kind` mean exactly that by it — the Call Log's prospect cadence,
 * sales attribution, the buying cycle, the owner's funnel. An account with one
 * order, one bill and one confirmed payment sitting at `kind = 'lead'` would
 * get every one of them wrong, so `promotesToCustomerAt` flips it at the FIRST
 * counting order and the ladder keeps its own `second_order` and `customer`
 * rungs.
 *
 * The consequence is the single most misread thing in this module: an account
 * on this screen is ALREADY a customer in the ledger while it is still
 * climbing the funnel's last three rungs. That is said in words, at the top,
 * and again on every row whose `kind` and rung disagree — because somebody
 * who discovers it from a report instead concludes that one of the two screens
 * is broken.
 * ------------------------------------------------------------------------- */

export function FirstOrdersScreen({
  workspace,
  rows,
  total,
  byStage,
  awaitingTheOrder,
  awaitingApproval,
  selectedId,
  orders,
  receipts,
  canWork,
}: {
  /** Which app is drawing this. See `lib/lead-workspace.ts`. */
  workspace: LeadWorkspace;
  rows: FirstOrderRow[];
  total: number;
  byStage: Record<string, number>;
  /** On the rung, and the ledger has nothing to show for it. A named gap. */
  awaitingTheOrder: number;
  /** An order sitting at `pending_approval` — accounts have not decided. */
  awaitingApproval: number;
  selectedId: string | null;
  orders: LeadOrderRow[];
  receipts: LeadReceiptRow[];
  canWork: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [advancing, setAdvancing] = React.useState<FirstOrderRow | null>(null);

  const refused = "Only somebody who works leads can do this.";
  const selected = rows.find((r) => r.customerId === selectedId) ?? null;
  const alreadyCustomers = rows.filter((r) => r.kind === "customer").length;

  return (
    <div className="p-6">
      <LeadTabs workspace={workspace} />

      <ScreenHeader
        title="First order & conversion"
        subtitle="Leads on the first-order rung and the three after it — delivery, payment, the second order. The eight questions are asked here, once, and every order status on this page is read off the ledger rather than written by the funnel."
        actions={
          <Link
            href={leadHref(workspace, "leads/commercial/commitments")}
            className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
          >
            ← Commitments
          </Link>
        }
      />

      {/*
        THE SENTENCE SOMEBODY WOULD OTHERWISE DISCOVER. It is a banner rather
        than a footnote because the alternative is a manager reading the CRM's
        customer list, finding an account there that this screen still calls a
        lead, and concluding one of the two has lost a row.
      */}
      <Banner
        tone="info"
        title="These accounts are already customers in the ledger"
        body="kind flips at the FIRST order, not the second — promotesToCustomerAt is the one place that is decided, because roughly thirty readers of customers.kind mean “has never ordered” by the word lead. So an account here is a customer everywhere money is counted, while it is still climbing the funnel's last three rungs. The rung says something about the relationship; the ledger has already moved on."
      />

      <Banner
        tone="info"
        title="Order status is read here and never written"
        body="§20 — Received, Confirmed, Dispatched, In Transit, Delivered belong to orders.status, which the Order Details projection restates every thirty minutes and accounts' approval decides. A second ladder kept here would be overwritten within the half hour or would fight the projection into sync_conflicts, so there is no control on this screen that writes one."
      />

      {awaitingApproval ? (
        <Banner
          tone="warn"
          title={`${plural(awaitingApproval, "account")} with an order accounts have not decided`}
          body="An order at pending_approval is the customer saying yes and the business not yet agreeing. It does not count as a sale anywhere, so the rung has moved and the ledger has not — and the person who took it is the one who has to ring back if it is declined."
        />
      ) : null}

      <MetricRow
        metrics={[
          { label: "On these rungs", value: String(total) },
          {
            label: "Nothing on the ledger",
            value: String(awaitingTheOrder),
            sub: awaitingTheOrder ? "Rung moved, no counting order" : undefined,
            tone: awaitingTheOrder ? "warn" : undefined,
          },
          {
            label: "Waiting on accounts",
            value: String(awaitingApproval),
            tone: awaitingApproval ? "warn" : undefined,
          },
          {
            label: "Already customers",
            value: `${alreadyCustomers} of ${rows.length}`,
            sub: "In the ledger, not on the ladder",
          },
        ]}
      />

      <div className="mb-4 flex flex-wrap gap-x-6 gap-y-1 text-[13px] text-muted">
        {RUNGS.map((s) => (
          <span key={s}>
            {stageLabel(s)}{" "}
            <span className="tabular-nums text-body">{byStage[s] ?? 0}</span>
          </span>
        ))}
      </div>

      {rows.length === 0 ? (
        <Empty
          title="Nothing on the first-order rungs"
          body="No lead has reached first_order. §28's gate to that rung reads the commitment — the day a customer said they would place it — so this fills from the commitments board rather than from anybody pressing a button here."
        />
      ) : (
        <>
          {rows.length < total ? (
            <p className="mb-2 text-[12px] text-muted">
              Showing the {rows.length} that have been on their rung longest, of {total}.
            </p>
          ) : null}

          <Table
            minWidth={1460}
            head={
              <>
                <HeadCell width={240}>Account</HeadCell>
                <HeadCell width={150}>Rung</HeadCell>
                <HeadCell width={150}>In the ledger</HeadCell>
                <HeadCell width={250}>Latest order · read only</HeadCell>
                <HeadCell width={190} align="right">
                  Billed
                </HeadCell>
                <HeadCell width={190} align="right">
                  Received · confirmed
                </HeadCell>
                <HeadCell width={210}>&nbsp;</HeadCell>
              </>
            }
          >
            {rows.map((r, i) => {
              const up = nextStage(r.stage, r.salesType);
              const open = r.customerId === selectedId;
              return (
                <Row key={r.customerId} striped={i % 2 === 1} selected={open}>
                  <Cell truncate={240}>
                    <Link href={leadHref(workspace, `leads/${r.customerId}`)} className="no-underline">
                      {r.name}
                    </Link>
                    <span className="block truncate text-[12px] text-muted">
                      {[r.companyName, r.city, r.salesmanName].filter(Boolean).join(" · ") || "—"}
                    </span>
                  </Cell>
                  <Cell>
                    {stageLabel(r.stage)}
                    <span className="block text-[12px] text-muted">
                      {plural(r.daysHere, "day")} here · {salesTypeLabel(r.salesType)}
                    </span>
                  </Cell>
                  <Cell>
                    {/*
                      The rung and the ledger, side by side, because they
                      legitimately differ. `kind` is selected rather than
                      inferred from the rung: an order accounts declined leaves
                      a lead on `first_order` with kind still `lead`, and a
                      screen that guessed would contradict the ledger.
                    */}
                    {r.kind === "customer" ? (
                      <>
                        <Pill tone="success">Customer</Pill>
                        <span className="block text-[12px] text-muted">
                          Flipped at the first order
                        </span>
                      </>
                    ) : (
                      <>
                        <Pill tone="warn">Still a lead</Pill>
                        <span className="block text-[12px] text-muted">
                          No counting order yet
                        </span>
                      </>
                    )}
                  </Cell>
                  <Cell truncate={250}>
                    {r.latestOrderId ? (
                      <>
                        <span className="block truncate text-body">
                          {r.latestOrderNo ?? "No number"} ·{" "}
                          {statusWords(r.latestOrderStatus)}
                        </span>
                        <span className="block truncate text-[12px] text-muted">
                          {r.latestOrderAt ? shortDate(r.latestOrderAt) : "—"}
                          {r.latestOrderValuePaise != null
                            ? ` · ${money(r.latestOrderValuePaise)}`
                            : ""}
                          {r.declinedOrders
                            ? ` · ${r.declinedOrders} declined on this account`
                            : ""}
                        </span>
                      </>
                    ) : (
                      <span className="text-muted">
                        No order on the ledger
                        <span className="block text-[12px]">
                          The rung moved and nothing has arrived
                        </span>
                      </span>
                    )}
                  </Cell>
                  <Cell align="right">
                    <span className="tabular-nums">{money(r.billedPaise)}</span>
                    {/*
                      An `unstated` bill is NEITHER paid nor owed — the sheet
                      never asserted money against it and no person has spoken
                      for it. Counted here and never folded into a balance,
                      which is the rule `recomputeOutstanding` already keeps.
                    */}
                    <span className="block text-[12px] text-muted">
                      {r.unstatedBills
                        ? `${plural(r.unstatedBills, "bill")} nobody has spoken for`
                        : `${money(r.outstandingPaise)} outstanding`}
                    </span>
                  </Cell>
                  <Cell align="right">
                    <span className="tabular-nums">{money(r.confirmedReceiptsPaise)}</span>
                    <span className="block text-[12px] text-muted">
                      confirmed money only
                    </span>
                  </Cell>
                  <Cell>
                    <span className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        title="Orders and receipts on this account, read off the ledger"
                        onClick={() =>
                          router.push(
                            open ? pathname : `${pathname}?open=${r.customerId}`,
                            { scroll: false },
                          )
                        }
                      >
                        {open ? "Close" : "Ledger"}
                      </Button>
                      <Button
                        size="sm"
                        tone="primary"
                        disabled={!canWork || !up}
                        title={
                          !canWork
                            ? refused
                            : !up
                              ? "This account is at the top of its own ladder."
                              : `Move it to ${stageLabel(up)} — §28's gate is asked on the server.`
                        }
                        onClick={() => setAdvancing(r)}
                      >
                        {up ? `To ${stageLabel(up)}` : "Top of ladder"}
                      </Button>
                    </span>
                  </Cell>
                </Row>
              );
            })}
          </Table>
        </>
      )}

      {selected ? (
        <section key={selected.customerId} className="mt-5 grid gap-4 lg:grid-cols-2">
          <div>
            {/*
              THE EIGHT QUESTIONS, ASKED ONCE. `FirstOrderPanel` is imported
              rather than rebuilt: it holds the rule that the DATE is required
              and the value is not, and a second copy of the form would be a
              second answer to which of the eight are mandatory. Nothing it
              writes touches `orders.status`.
            */}
            <FirstOrderPanel
              customerId={selected.customerId}
              expectedOrderDate={selected.forecastDate}
              expectedOrderCans={selected.forecastCans}
              expectedOrderValuePaise={selected.forecastValuePaise}
              countingOrderCount={selected.countingOrders}
              disabled={!canWork}
              disabledReason={refused}
            />
          </div>

          <div className="rounded-[6px] border border-line bg-surface px-5 py-4">
            <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              Orders on this account · read only
            </div>
            {orders.length === 0 ? (
              <p className="mt-2 text-[13px] text-muted">
                No order row exists for this account. Not an empty ledger panel — there is
                genuinely nothing to render, which is the same fact the rung column states.
              </p>
            ) : (
              <ul className="mt-2 space-y-1.5 text-[13px]">
                {orders.slice(0, 8).map((o) => (
                  <li key={o.id} className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-body">
                      {o.orderNo ?? "No number"} · {statusWords(o.status)}
                      {o.declineReason ? ` — ${o.declineReason}` : ""}
                    </span>
                    <span className="flex-none tabular-nums text-muted">
                      {shortDate(o.orderedAt)} · {money(o.totalAmountPaise)}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-4 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              Money against it
            </div>
            {receipts.length === 0 ? (
              <p className="mt-2 text-[13px] text-muted">
                No receipt of any kind — not reported, not held, not confirmed. Nobody has
                said money arrived, which is different from money having failed to.
              </p>
            ) : (
              <ul className="mt-2 space-y-1.5 text-[13px]">
                {receipts.slice(0, 8).map((p) => (
                  <li key={p.id} className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-body">
                      {p.mode}
                      {p.reference ? ` · ${p.reference}` : ""} · {p.status}
                    </span>
                    <span className="flex-none tabular-nums text-muted">
                      {shortDate(p.receivedAt)} · {money(p.amountPaise)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-[12px] text-muted">
              Only confirmed money moves a balance. A reported or held receipt is somebody&rsquo;s
              word that a transfer happened, and it counts nowhere else in MahekOne either.
            </p>
          </div>
        </section>
      ) : null}

      {advancing ? (
        <AdvanceStageModal
          key={advancing.customerId}
          customerId={advancing.customerId}
          name={advancing.name}
          stage={advancing.stage}
          salesType={advancing.salesType}
          hint={
            advancing.countingOrders
              ? `${plural(advancing.countingOrders, "order")} on the ledger — this account is already a customer there.`
              : "Nothing on the ledger yet. The rung is ahead of the order."
          }
          onClose={() => setAdvancing(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * The four rungs this screen covers.
 *
 * Restated here rather than imported from the service because that file is
 * `server-only` and this is a client component — the same reason
 * `lead-labels.ts` and `lead-ladder.ts` are pure. It is a DISPLAY order for a
 * count strip and not a second definition of the population: the rows
 * themselves are whatever the service returned.
 */
const RUNGS: readonly LeadStage[] = ["first_order", "delivery", "payment", "second_order"];

/**
 * §20's own vocabulary, rendered.
 *
 * A map rather than a chain of ternaries, and an unknown status prints ITSELF
 * rather than falling through to the last arm — the enum is the sheet's and
 * accounts', both of which can gain a value without this file hearing about
 * it, and a status silently drawn as "Delivered" because it was last in a
 * ternary is the failure this screen exists to avoid. Nothing here decides
 * what counts as a sale: that is `PURCHASE_STATUSES`, asked in SQL.
 */
function statusWords(status: string | null): string {
  if (!status) return "No status";
  const words: Record<string, string> = {
    pending_approval: "Waiting on accounts",
    captured: "Received",
    confirmed: "Confirmed",
    dispatched: "Dispatched",
    in_transit: "In transit",
    delivered: "Delivered",
    declined: "Declined",
    cancelled: "Cancelled",
  };
  return words[status] ?? status;
}
