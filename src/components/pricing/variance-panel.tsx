"use client";

/* ---------------------------------------------------------------------------
 * WHAT WAS BILLED AGAINST WHAT THE LIST SAYS — a month at a time.
 *
 * This is the only screen that can tell anybody whether the price lists mean
 * anything. A list published in August is a document; a month of order lines
 * billed at what it says is a policy. The rows below are the difference, and
 * BELOW is the direction that costs money, so it is the one drawn in danger.
 *
 * The month is a URL, not a piece of state: a variance somebody wants to
 * argue about is one they send a link to. Choosing one navigates, which also
 * means the server does the reading — the resolution is as of each order's
 * OWN date, which a browser cannot answer for a month it is not living in.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Callout,
  Card,
  EmptyState,
  MetricStrip,
  Select,
  Td,
  Th,
  Tr,
} from "@/components/ui/primitives";
import { FilterPills } from "@/components/ui/overlays";
import { money, shortDate } from "@/lib/format";
import type { VarianceReport, VarianceRow } from "@/lib/price-list-views";
import { monthLabel } from "./months";

type Which = "below" | "above" | "on" | "unresolved" | "all";

function bucket(r: VarianceRow): Which {
  if (r.listExPaise == null || r.deltaPaise == null) return "unresolved";
  if (r.deltaPaise < 0) return "below";
  if (r.deltaPaise > 0) return "above";
  return "on";
}

export function VariancePanel({
  basePath,
  report,
  monthOptions,
}: {
  basePath: string;
  report: VarianceReport;
  /** The last twelve months, newest first, built on the server. */
  monthOptions: string[];
}) {
  const router = useRouter();
  const [which, setWhich] = React.useState<Which>("all");

  const rows = which === "all" ? report.rows : report.rows.filter((r) => bucket(r) === which);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Month
          </span>
          <Select
            value={report.month}
            onChange={(e) => router.push(`${basePath}/variance?month=${e.target.value}`)}
          >
            {monthOptions.map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
              </option>
            ))}
          </Select>
        </label>
      </div>

      <MetricStrip
        metrics={[
          { label: "Order lines", value: report.summary.lines.toLocaleString("en-IN") },
          { label: "At the list price", value: report.summary.onList.toLocaleString("en-IN") },
          {
            label: "Below the list",
            value: report.summary.belowList.toLocaleString("en-IN"),
            tone: report.summary.belowList ? "danger" : "ink",
          },
          { label: "Above the list", value: report.summary.aboveList.toLocaleString("en-IN") },
          {
            label: "No list resolved",
            value: report.summary.unresolved.toLocaleString("en-IN"),
          },
          {
            label: "Given away below the list",
            value: money(report.summary.totalBelowPaise),
            tone: report.summary.totalBelowPaise ? "danger" : "ink",
            sub: "Ex-GST, over the lines below",
          },
        ]}
      />

      <div className="mt-4">
        <Callout tone="brand">
          <span className="text-[13px] text-body">
            The billed rate is the order sheet&rsquo;s own, ex-GST, exactly as it was
            entered. The list rate beside it is resolved as of{" "}
            <strong>each order&rsquo;s own date</strong> rather than today, so a revision
            published since does not rewrite what last month looks like.
          </span>
        </Callout>
      </div>

      <div className="mb-4">
        <FilterPills
          value={which}
          onChange={setWhich}
          options={[
            { key: "all", label: "All", count: report.rows.length },
            { key: "below", label: "Below the list", count: report.summary.belowList },
            { key: "above", label: "Above", count: report.summary.aboveList },
            { key: "on", label: "On the list", count: report.summary.onList },
            { key: "unresolved", label: "No list", count: report.summary.unresolved },
          ]}
        />
      </div>

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            title={`Nothing to show for ${monthLabel(report.month)}`}
            body="Either the order sheet has no priced lines in this month, or none of them fall in this filter."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1140px] border-collapse text-sm">
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>Order</Th>
                  <Th>Customer</Th>
                  <Th>Product</Th>
                  <Th align="right">Cans</Th>
                  <Th align="right">Billed ex-GST</Th>
                  <Th align="right">List ex-GST</Th>
                  <Th align="right">Delta</Th>
                  <Th align="right">Sheet discount</Th>
                  <Th>List</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const below = r.deltaPaise != null && r.deltaPaise < 0;
                  const above = r.deltaPaise != null && r.deltaPaise > 0;
                  return (
                    <Tr key={`${r.orderNumber ?? "n"}-${r.productId ?? "p"}-${i}`}>
                      <Td>{shortDate(r.orderDate)}</Td>
                      <Td>{r.orderNumber ?? <span className="text-muted">no number</span>}</Td>
                      <Td>{r.customerName}</Td>
                      <Td>{r.productName}</Td>
                      <Td align="right">{r.cans ?? <span className="text-muted">—</span>}</Td>
                      <Td align="right">{money(r.billedExPaise)}</Td>
                      <Td align="right">
                        {r.listExPaise == null ? (
                          <span className="text-muted">no list rate</span>
                        ) : (
                          money(r.listExPaise)
                        )}
                      </Td>
                      <Td align="right">
                        {r.deltaPaise == null ? (
                          <span className="text-muted">—</span>
                        ) : (
                          <span
                            className={below ? "text-danger" : above ? "text-success" : undefined}
                          >
                            {r.deltaPaise > 0 ? "+" : ""}
                            {money(r.deltaPaise)}
                            {r.deltaBp == null ? null : (
                              <span className="block text-[12px]">
                                {r.deltaBp > 0 ? "+" : ""}
                                {Math.round(r.deltaBp / 10) / 10}%
                              </span>
                            )}
                          </span>
                        )}
                      </Td>
                      <Td align="right">
                        {r.sheetDiscountBp == null ? (
                          <span className="text-muted">—</span>
                        ) : (
                          `${Math.round(r.sheetDiscountBp / 10) / 10}%`
                        )}
                      </Td>
                      <Td>{r.listName ?? <span className="text-muted">none resolved</span>}</Td>
                    </Tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
