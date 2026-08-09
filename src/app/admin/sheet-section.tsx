"use client";

import * as React from "react";
import {
  Badge,
  Card,
  CardHeader,
  Callout,
  EmptyState,
  Input,
  Td,
  Th,
  Tr,
  cx,
} from "@/components/ui/primitives";
import { money, shortDate, stamp } from "@/lib/format";
import { pinnedCell, pinnedHead } from "./pinned";
import type { SheetData } from "./sheet-data";

/* ---------------------------------------------------------------------------
 * The Order Sheet section.
 *
 * Read-only, deliberately. The sheet is somebody else's document and it stays
 * the source of truth: a screen that let you edit a value here would create
 * two answers to the same question, and the one on the spreadsheet would keep
 * winning every time it synced.
 *
 * Three views because there are three questions. The lines are what the sheet
 * literally says. The orders are what it MEANS — 99 rows are 47 orders, and
 * the value of one is the sum of its lines, which no row shows. And the
 * attention list is every cell the import could not read or that contradicts
 * itself, because a figure nobody has questioned is a figure people trust.
 * ------------------------------------------------------------------------- */

/** A cell that holds nothing reads as a gap, not as a zero. */
function Blank({ title }: { title?: string }) {
  return (
    <span className="text-muted" title={title}>
      —
    </span>
  );
}

const litres = (ml: number | null) =>
  ml === null ? null : (ml / 1000).toLocaleString("en-IN", { maximumFractionDigits: 2 });

const percent = (bp: number | null) =>
  bp === null ? null : `${(bp / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`;

export function SheetSection({ data, tab }: { data: SheetData; tab: number }) {
  const view = ["lines", "orders", "issues", "sync"][tab] ?? "lines";
  return (
    <div className="space-y-5">
      <SummaryStrip data={data} />
      {view === "lines" ? <LinesTable data={data} /> : null}
      {view === "orders" ? <OrdersTable data={data} /> : null}
      {view === "issues" ? <IssuesList data={data} /> : null}
      {view === "sync" ? <SyncPanel data={data} /> : null}
    </div>
  );
}

function SummaryStrip({ data }: { data: SheetData }) {
  const s = data.summary;
  const stats: { label: string; value: string; tone?: "danger" | "warn" }[] = [
    { label: "Order lines", value: s.presentRows.toLocaleString("en-IN") },
    { label: "Orders", value: s.distinctOrders.toLocaleString("en-IN") },
    { label: "Billing parties", value: s.distinctParties.toLocaleString("en-IN") },
    {
      label: "Needs attention",
      value: s.rowsWithIssues.toLocaleString("en-IN"),
      tone: s.rowsWithIssues ? "danger" : undefined,
    },
    {
      label: "Gone from sheet",
      value: s.withdrawnRows.toLocaleString("en-IN"),
      tone: s.withdrawnRows ? "warn" : undefined,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {stats.map((stat) => (
          <Card key={stat.label} className="px-4 py-3">
            <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              {stat.label}
            </div>
            <div
              className={cx(
                "mt-1 text-xl font-semibold tabular-nums",
                stat.tone === "danger" && "text-danger",
                stat.tone === "warn" && "text-warn",
              )}
            >
              {stat.value}
            </div>
          </Card>
        ))}
      </div>

      {/* The quarantine, said plainly. Somebody reading these figures needs to
          know they are not the ones the CRM is working from. */}
      {s.lastSync && !s.lastSync.feedsCrm ? (
        <Callout tone="warn">
          <strong>Imported, but not yet driving the CRM.</strong> These rows are
          stored and readable here, and they are not feeding
          buying cycles, outstanding, targets or the calling queue. Nothing on a
          telecaller&rsquo;s screen is derived from them yet.
        </Callout>
      ) : null}
    </div>
  );
}

function LinesTable({ data }: { data: SheetData }) {
  const [query, setQuery] = React.useState(data.filters.query ?? "");

  // Filtering in the browser over the page that was served. The server-side
  // filter is the URL one; this is the "find it while I am looking at it" case.
  const rows = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return data.rows;
    return data.rows.filter((r) =>
      [
        r.orderNumber,
        r.billingPartyName,
        r.description,
        r.tallyBillNo,
        r.area,
        r.salesMan,
      ]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [data.rows, query]);

  return (
    <Card>
      <CardHeader
        title="Order lines"
        hint={`One row per line in the sheet. ${data.total.toLocaleString("en-IN")} lines, page ${data.page} of ${data.pages}.`}
        action={
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find an order, party, product, bill…"
            className="w-64"
          />
        }
      />

      {rows.length === 0 ? (
        <EmptyState
          title={query ? "Nothing matches that" : "No rows imported yet"}
          body={
            query
              ? "Try the order number, the billing party, or a product name."
              : "Run a sync to pull the sheet in."
          }
        />
      ) : (
        <div className="overflow-x-auto" style={{ ["--rowh" as string]: "44px" }}>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th className={pinnedHead("left")}>Order</Th>
                <Th>Date</Th>
                <Th>Billing party</Th>
                <Th>Goods</Th>
                <Th align="right">Cans</Th>
                <Th align="right">Litres</Th>
                <Th>Type</Th>
                <Th align="right">Rate</Th>
                <Th>Payment status</Th>
                <Th>Payment received</Th>
                <Th>Area</Th>
                <Th align="right">GST</Th>
                <Th align="right">Amount</Th>
                <Th>Transport</Th>
                <Th align="right">Discount</Th>
                <Th align="right">Final</Th>
                <Th>Dispatch</Th>
                <Th>Tally bill</Th>
                <Th align="right">Fulfil days</Th>
                <Th align="right">Credit days</Th>
                <Th>Payment type</Th>
                <Th>Segment</Th>
                <Th>Sales man</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <Tr key={r.id}>
                  <Td className={pinnedCell("left", i)}>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{r.orderNumber ?? "—"}</span>
                      {r.issueCount ? (
                        <span title={`${r.issueCount} cell(s) need attention`}>
                          <Badge tone="danger">{r.issueCount}</Badge>
                        </span>
                      ) : null}
                    </div>
                    <div className="text-[11px] text-muted">row {r.rowNumber}</div>
                  </Td>
                  <Td>{r.orderDate ? shortDate(r.orderDate) : <Blank />}</Td>
                  <Td>{r.billingPartyName ?? <Blank />}</Td>
                  <Td>{r.description ?? <Blank />}</Td>
                  <Td align="right" className="tabular-nums">
                    {r.cans ?? <Blank />}
                  </Td>
                  <Td align="right" className="tabular-nums">
                    {litres(r.volumeMl) ?? <Blank />}
                  </Td>
                  <Td>{r.packType ?? <Blank />}</Td>
                  <Td align="right" className="tabular-nums">
                    {r.ratePaise === null ? <Blank /> : money(r.ratePaise)}
                  </Td>
                  <Td>
                    {r.paymentStatus ?? <Blank title="This column is empty in the sheet" />}
                  </Td>
                  <Td>
                    {r.paymentReceivedDate ? (
                      shortDate(r.paymentReceivedDate)
                    ) : (
                      <Blank title="This column is empty in the sheet" />
                    )}
                  </Td>
                  <Td>{r.area ?? <Blank />}</Td>
                  <Td align="right" className="tabular-nums">
                    {percent(r.gstBp) ?? <Blank />}
                  </Td>
                  <Td align="right" className="tabular-nums">
                    {r.amountPaise === null ? <Blank /> : money(r.amountPaise)}
                  </Td>
                  <Td>{r.transportName ?? <Blank />}</Td>
                  <Td align="right" className="tabular-nums">
                    {/* A percentage, never an amount — which is exactly how it
                        would be misread sitting between two money columns. */}
                    {percent(r.discountBp) ?? <Blank />}
                  </Td>
                  <Td align="right" className="tabular-nums font-medium">
                    {r.finalAmountPaise === null ? <Blank /> : money(r.finalAmountPaise)}
                  </Td>
                  <Td>{r.dispatchDate ? shortDate(r.dispatchDate) : <Blank />}</Td>
                  <Td>{r.tallyBillNo ?? <Blank />}</Td>
                  <Td align="right" className="tabular-nums">
                    {r.orderFulfillDays ?? <Blank />}
                  </Td>
                  <Td align="right" className="tabular-nums">
                    {r.creditDays ?? <Blank />}
                  </Td>
                  <Td>{r.paymentType ?? <Blank />}</Td>
                  <Td>{r.segmentCounterType ?? <Blank />}</Td>
                  <Td>{r.salesMan ?? <Blank />}</Td>
                </Tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="border-t border-divider px-5 py-3 text-[13px] text-muted">
        Amount, Discount, Final and Tally bill belong to the <strong>line</strong>,
        not the order — an order&rsquo;s value is the sum of its lines. See the
        Orders tab for the totals.
      </div>
    </Card>
  );
}

function OrdersTable({ data }: { data: SheetData }) {
  return (
    <Card>
      <CardHeader
        title="Orders"
        hint="The same rows grouped by order number, with the line figures summed."
      />
      {data.orders.length === 0 ? (
        <EmptyState title="No orders yet" body="Run a sync to pull the sheet in." />
      ) : (
        <div className="overflow-x-auto" style={{ ["--rowh" as string]: "44px" }}>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th className={pinnedHead("left")}>Order</Th>
                <Th>Date</Th>
                <Th>Billing party</Th>
                <Th>Area</Th>
                <Th align="right">Lines</Th>
                <Th align="right">Amount</Th>
                <Th align="right">Final</Th>
                <Th>Tally bill</Th>
                <Th>Sales man</Th>
              </tr>
            </thead>
            <tbody>
              {data.orders.map((o, i) => (
                <Tr key={o.orderNumber}>
                  <Td className={pinnedCell("left", i)}>
                    <span className="font-medium">{o.orderNumber}</span>
                  </Td>
                  <Td>{o.orderDate ? shortDate(o.orderDate) : <Blank />}</Td>
                  <Td>{o.billingPartyName ?? <Blank />}</Td>
                  <Td>{o.area ?? <Blank />}</Td>
                  <Td align="right" className="tabular-nums">
                    {o.lineCount}
                  </Td>
                  <Td align="right" className="tabular-nums">
                    {money(o.amountPaise)}
                  </Td>
                  <Td align="right" className="tabular-nums font-medium">
                    {money(o.finalAmountPaise)}
                  </Td>
                  <Td>
                    {o.tallyBillNos.length === 0 ? (
                      <Blank />
                    ) : o.tallyBillNos.length === 1 ? (
                      o.tallyBillNos[0]
                    ) : (
                      <span title={o.tallyBillNos.join(", ")}>
                        {o.tallyBillNos.length} bills
                      </span>
                    )}
                  </Td>
                  <Td>{o.salesMan ?? <Blank />}</Td>
                </Tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function IssuesList({ data }: { data: SheetData }) {
  if (data.issues.length === 0) {
    return (
      <Card>
        <CardHeader title="Needs attention" hint="Cells the import could not read, or that disagree with each other." />
        <EmptyState
          title="Every row read cleanly"
          body="No cell failed to parse and no row contradicts its own arithmetic."
        />
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Needs attention"
        hint={`${data.issues.length} row${data.issues.length === 1 ? "" : "s"}. These were imported in full — nothing was rejected — but somebody should look at the sheet.`}
      />
      <div className="divide-y divide-divider">
        {data.issues.map((row) => (
          <div key={row.id} className="px-5 py-4">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-medium">Order {row.orderNumber ?? "—"}</span>
              <span className="text-[13px] text-muted">
                sheet row {row.rowNumber}
              </span>
              <span className="text-[13px] text-body">{row.billingPartyName}</span>
            </div>
            <ul className="mt-2 space-y-1.5">
              {row.issues.map((issue, i) => (
                <li key={i} className="text-[13px]">
                  <Badge tone="danger">{issue.column}</Badge>{" "}
                  <span className="text-body">{issue.problem}</span>
                  {issue.value ? (
                    <span className="text-muted"> — cell holds &ldquo;{issue.value}&rdquo;</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Card>
  );
}

function SyncPanel({ data }: { data: SheetData }) {
  const s = data.summary.lastSync;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Source" hint="Where these rows come from." />
        <div className="space-y-2 px-5 pb-5 text-[13px]">
          <Row label="Spreadsheet">
            <code className="text-[12px]">{data.source.spreadsheetId}</code>
          </Row>
          <Row label="Tab">{data.source.tabTitle}</Row>
          <Row label="Access">
            {data.source.configured ? (
              "Service account, read-only. This app cannot write to the sheet."
            ) : (
              <span className="text-danger">
                Not configured — GOOGLE_SA_EMAIL and GOOGLE_SA_PRIVATE_KEY are unset.
              </span>
            )}
          </Row>
        </div>
      </Card>

      <Card>
        <CardHeader title="Last sync" />
        <div className="space-y-2 px-5 pb-5 text-[13px]">
          {!s ? (
            <p className="text-muted">Nothing has synced yet.</p>
          ) : (
            <>
              <Row label="When">{stamp(s.at)}</Row>
              <Row label="Mode">{s.mode}</Row>
              <Row label="Result">
                {s.status === "failed" ? (
                  <span className="text-danger">failed — {s.error}</span>
                ) : (
                  `${s.rowsCreated} new, ${s.rowsUpdated} changed, ${s.rowsUnchanged} unchanged`
                )}
              </Row>
              <Row label="Feeds the CRM">
                {s.feedsCrm ? "yes" : "no — stored and readable only"}
              </Row>
            </>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Running a sync"
          hint="Nothing is scheduled. The sheets are read when something asks."
        />
        <div className="space-y-3 px-5 pb-5 text-[13px] text-body">
          <p>
            One endpoint, authorised with <code>CRON_SECRET</code>. There is no
            cron behind it — Vercel Cron is a paid feature — so a person or an
            external scheduler has to call it.
          </p>
          <pre className="overflow-x-auto rounded bg-canvas p-3 text-[12px] leading-relaxed">
{`curl -H "Authorization: Bearer $CRON_SECRET" \\
  "https://<host>/api/sheets/sync?mode=reconcile"`}
          </pre>
          <table className="w-full text-[13px]">
            <tbody>
              {[
                ["append", "only past the highest row seen. Cheap; blind to edits of existing rows."],
                ["reconcile", "the whole order tab, hash-compared. Catches edits and rows that have gone."],
                ["payments", "the Payment Status tab. Always a full compare — a payment row changes in place."],
                ["parties", "the customer master. Where every phone number comes from."],
                ["project", "turns what has landed into customers and orders. Takes &owner=, &leads=1, &bills=1."],
              ].map(([mode, what]) => (
                <tr key={mode} className="border-t border-divider">
                  <td className="w-28 py-1.5 align-top">
                    <code>?mode={mode}</code>
                  </td>
                  <td className="py-1.5 text-muted">{what}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-muted">
            On a developer machine the same work is <code>npm run jobs -- sheet-reconcile</code>,
            and <code>sheet-reparse</code> re-reads stored rows without touching
            Google — the one to run after a parsing rule is corrected. Neither is
            available on a deployment, which has no shell.
          </p>
        </div>
      </Card>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="w-40 flex-none text-muted">{label}</span>
      <span className="text-body">{children}</span>
    </div>
  );
}
