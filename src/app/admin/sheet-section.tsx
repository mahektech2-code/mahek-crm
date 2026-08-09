"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Callout,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Select,
  Td,
  Th,
  Tr,
  cx,
} from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { money, shortDate, stamp } from "@/lib/format";
import { runSheetProjection } from "@/lib/actions/sheet";
import type { ProjectionReport } from "@/lib/services/sheet-projection-service";
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
          telecaller&rsquo;s screen is derived from them yet — the Sync tab is
          where that is turned on.
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
            {data.source.spreadsheetId ? (
              <code className="text-[12px]">{data.source.spreadsheetId}</code>
            ) : (
              <span className="text-danger">ORDERS_SHEET_ID is not set</span>
            )}
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

      <ProjectionPanel data={data} />

      <Card>
        <CardHeader
          title="Running a sync"
          hint="Three modes, because a spreadsheet has no way to say what changed."
        />
        <div className="space-y-3 px-5 pb-5 text-[13px] text-body">
          <p>
            <code>npm run jobs -- sheet-append</code> — reads only past the
            highest row seen before. Cheap enough to run every few minutes, and
            blind to edits of existing rows.
          </p>
          <p>
            <code>npm run jobs -- sheet-reconcile</code> — reads the whole tab
            and compares hashes. Catches edits and rows that have gone. Nightly.
          </p>
          <p>
            <code>npm run jobs -- sheet-reparse</code> — touches Google not at
            all; re-reads the stored rows. This is the one to run after a
            parsing rule is corrected.
          </p>
        </div>
      </Card>
    </div>
  );
}

/**
 * Turning the imported rows into CRM records.
 *
 * Two decisions the sheet cannot make for itself, so the screen asks:
 *
 *   WHOSE BOOK. The document's only ownership column holds sales channels
 *   rather than people. A customer with no owner and no sales account manager
 *   sits in nobody's scope, which means every screen stays empty and reads as
 *   a broken import rather than an unassigned book. So it is required, and the
 *   dry run reports how many records are in that state today.
 *
 *   WHETHER BILLS. The order tab records what was billed and never what was
 *   paid, so bills built from it alone are unpaid by construction — "everybody
 *   owes us everything" rather than "we do not know". Turn it on only once the
 *   Payment Status tab has synced, which is where paid actually comes from.
 */
function ProjectionPanel({ data }: { data: SheetData }) {
  const router = useRouter();
  const toast = useToast();
  const [assignTo, setAssignTo] = React.useState("");
  const [includeBills, setIncludeBills] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [report, setReport] = React.useState<
    (ProjectionReport & { applied: boolean }) | null
  >(null);

  const blocked = !data.canProject
    ? "Importing into the CRM is a manager action."
    : !data.summary.presentRows
      ? "Nothing has synced yet — there are no rows to project."
      : !assignTo
        ? "Choose who these customers answer to first."
        : null;

  async function go(dryRun: boolean) {
    setBusy(true);
    try {
      const result = await runSheetProjection({
        dryRun,
        includeBills,
        assignToUserId: assignTo,
      });
      if (result.ok) {
        if (result.message) toast.push(result.message);
        setReport({ ...result.data, applied: !dryRun });
        // A dry run wrote nothing, so re-reading would only throw the report
        // away to show the same figures back.
        if (!dryRun) router.refresh();
      } else {
        toast.push(result.error);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card>
        <CardHeader
          title="Feed the CRM"
          hint="Turns the imported rows into customers, orders and bills, then rebuilds every value derived from them — buying cycles, last order dates, outstanding and the follow-up stages. Idempotent: running it twice changes nothing the second time."
        />
        <div className="space-y-4 px-5 py-4">
          {data.unassignedCustomers > 0 ? (
            <Callout tone="warn">
              <strong>
                {data.unassignedCustomers} customer
                {data.unassignedCustomers === 1 ? " is" : "s are"} in nobody&rsquo;s book.
              </strong>{" "}
              A customer with neither a sales account manager nor an owner is in
              no telecaller&rsquo;s scope and no manager&rsquo;s team view, so they
              appear on no calling queue and no collections list at all. Running
              this with somebody chosen below adopts them — it never reassigns a
              customer who already answers to somebody.
            </Callout>
          ) : null}

          <div className="flex flex-wrap items-end gap-4">
            <Field
              label="Whose book"
              hint="The sheet does not say. Set on creation, and on an existing record only while it belongs to nobody."
              className="min-w-64"
            >
              <Select
                value={assignTo}
                disabled={!data.canProject || busy}
                onChange={(e) => setAssignTo(e.target.value)}
              >
                <option value="">Choose a person…</option>
                {data.assignees.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.role}
                  </option>
                ))}
              </Select>
            </Field>

            <Checkbox
              label="Write bills and payments too"
              checked={includeBills}
              disabled={!data.canProject || busy}
              onChange={(e) => setIncludeBills(e.target.checked)}
              className="pb-2"
            />
          </div>

          <p className="text-[13px] text-muted">
            Bills come from the Payment Status tab, which is the only place that
            records what was received. Leave this off until that tab has synced —
            bills built without it are unpaid by construction, and every customer
            would read as maximally overdue.
          </p>

          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              disabled={Boolean(blocked) || busy}
              title={blocked ?? undefined}
              onClick={() => go(true)}
            >
              Dry run
            </Button>
            <Button
              variant="primary"
              disabled={Boolean(blocked) || busy}
              title={blocked ?? undefined}
              onClick={() => go(false)}
            >
              Feed the CRM
            </Button>
            <span className="text-[13px] text-muted">
              {blocked ?? "A dry run reports exactly what a real run would change and writes nothing."}
            </span>
          </div>
        </div>
      </Card>

      {report ? <ProjectionReportCard report={report} /> : null}
    </>
  );
}

function ProjectionReportCard({
  report,
}: {
  report: ProjectionReport & { applied: boolean };
}) {
  const c = report.customers;
  const o = report.orders;
  const b = report.bills;
  return (
    <Card>
      <CardHeader
        title={report.applied ? "What was written" : "What a real run would write"}
        hint={report.applied ? undefined : "Nothing was written."}
      />
      <div className="space-y-2 px-5 pb-5 text-[13px]">
        <Row label="Customers">
          {c.created} created · {c.updated} updated
        </Row>
        <Row label="Without a phone number">
          {c.withoutPhone} — the source carries none, and nothing was invented
        </Row>
        <Row label="In nobody's book">
          {c.unassigned === 0 ? (
            "none"
          ) : (
            <span className="text-danger">
              {c.unassigned} — these will appear on no screen for anybody
            </span>
          )}
        </Row>
        <Row label="Orders">
          {o.created} created · {o.updated} updated · {o.lines} lines
        </Row>
        <Row label="Bills">
          {b.skipped
            ? "not written — the option was off"
            : `${b.created} created · ${b.updated} updated · ${b.payments} payments`}
        </Row>
        {!b.skipped ? (
          <Row label="Paid, date unknown">
            {b.paidWithoutDate} marked received with no date · {b.blankStatus} with no
            status at all, read as unpaid
          </Row>
        ) : null}
        {report.skipped.length ? (
          <div className="pt-2">
            <div className="text-muted">Rows the projection could not use</div>
            <ul className="mt-1 space-y-1">
              {report.skipped.map((s) => (
                <li key={s.reason} className="text-body">
                  {s.count} × {s.reason}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Card>
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
