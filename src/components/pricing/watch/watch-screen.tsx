"use client";

/* ---------------------------------------------------------------------------
 * WATCH THE MONEY — every order line against the price live on its own date.
 *
 * The window is a URL, as the variance month is: a pattern somebody wants to
 * argue about is one they send a link to, and the server does the reading,
 * because the book price is resolved as of each line's OWN date.
 *
 * MONEY GIVEN AWAY is the book less what was billed, times the cans, ex-GST,
 * over lines billed below the book — most first, so the screen opens on where
 * the money is. Nothing here changes a price. "Make it a special price" is the
 * ordinary special-price request; asking why and sending to the founder are
 * the Price Desk's and are not drawn on the CRM's read-only door.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Callout, Card, EmptyState, Input, MetricStrip, Select, Td, Th, Tr } from "@/components/ui/primitives";
import { FilterPills } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { money, shortDate } from "@/lib/format";
import { inclFromEx } from "@/lib/engines/price-math";
import {
  APPROVAL_LABEL,
  WATCH_PRESET_LABEL,
  WATCH_PRESETS,
  type WatchLineView,
  type WatchPreset,
  type WatchShopProduct,
} from "@/lib/engines/price-watch";
import { askAboutLine, sendToFounder, summariseWatch } from "@/lib/actions/price-watch";
import type { WatchResult } from "@/lib/services/price-watch-service";
import type { WatchSummary } from "@/lib/price-ai/watch-ai";
import type { RateRow } from "@/lib/price-list-views";
import { SpecialPriceModal } from "@/components/pricing/modals/special-price-modal";

type Tab = "shop" | "person" | "product" | "lines";
const LINES_SHOWN = 500;

const pct = (bp: number | null) => (bp == null ? "—" : `${bp > 0 ? "+" : ""}${Math.round(bp / 10) / 10}%`);
const count = (n: number) => n.toLocaleString("en-IN");
const SOURCE_LABEL = { sheet: "Sheet", erp: "ERP" } as const;

export function WatchScreen({
  basePath,
  canManage,
  report,
  preset,
}: {
  basePath: string;
  /** The Price Desk: Ask why and Send to founder are drawn. */
  canManage: boolean;
  report: WatchResult;
  preset: WatchPreset;
}) {
  const [tab, setTab] = React.useState<Tab>("shop");
  const [special, setSpecial] = React.useState<WatchShopProduct | null>(null);
  const t = report.totals;

  return (
    <>
      <RangePicker key={`${preset}${report.from}${report.to}`} basePath={basePath} preset={preset} from={report.from} to={report.to} />

      <MetricStrip
        metrics={[
          { label: "Lines priced", value: count(t.priced), sub: `of ${count(t.lines)} order lines` },
          { label: "On the book", value: count(t.on) },
          { label: "Below", value: count(t.below), tone: t.below ? "danger" : "ink" },
          { label: "Above", value: count(t.above) },
          { label: "No book price", value: count(t.unpriced) },
          {
            label: "Money given away",
            value: money(t.givenAwayPaise),
            tone: t.givenAwayPaise ? "danger" : "ink",
            sub: `${money(t.unapprovedPaise)} with nothing on record approving it`,
          },
        ]}
      />

      {report.truncated ? (
        <div className="mb-4">
          <Callout tone="warn">
            <span className="text-[13px] text-body">
              This window holds more order lines than one reading takes, so only the oldest {count(report.lines.length)} are
              shown. Pick a shorter range to see all of it.
            </span>
          </Callout>
        </div>
      ) : null}

      <SummaryCard from={report.from} to={report.to} hasBelow={t.below > 0} />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <FilterPills
          value={tab}
          onChange={setTab}
          options={[
            { key: "shop", label: "By shop & product", count: report.byShopProduct.length },
            { key: "person", label: "By person", count: report.byPerson.filter((p) => p.belowLines > 0).length },
            { key: "product", label: "By product", count: report.byProduct.filter((p) => p.belowLines > 0).length },
            { key: "lines", label: "All lines", count: report.lines.length },
          ]}
        />
        {canManage && t.below > 0 ? <FounderButton from={report.from} to={report.to} label="Send this window to the founder" /> : null}
      </div>

      <Card className="overflow-hidden">
        {tab === "shop" ? (
          <ShopTable report={report} canManage={canManage} onSpecial={setSpecial} />
        ) : tab === "person" ? (
          <PersonTable report={report} canManage={canManage} />
        ) : tab === "product" ? (
          <ProductTable report={report} canManage={canManage} />
        ) : (
          <AllLines report={report} canManage={canManage} />
        )}
      </Card>

      {special && special.customerId && special.productId ? (
        <SpecialPriceModal
          open
          onClose={() => setSpecial(null)}
          customerId={special.customerId}
          customerName={special.customerName}
          rates={[bookRow(special)]}
          gstBp={special.listGstBp ?? 1800}
          initialProductId={special.productId}
          initialAskedInclPaise={inclFromEx(special.billedMedianPaise, special.listGstBp ?? 1800)}
        />
      ) : null}
    </>
  );
}

/** The one book row the special-price modal asks a difference against. */
function bookRow(g: WatchShopProduct): RateRow {
  const ex = g.listExPaise ?? 0;
  return {
    id: g.key,
    productId: g.productId ?? "",
    productName: g.productName,
    brandName: null,
    formulationName: null,
    millilitresPerCan: null,
    cansPerBox: null,
    packing: null,
    productActive: true,
    rateExGstPaise: ex,
    rateInclGstPaise: g.listInclPaise ?? inclFromEx(ex, g.listGstBp ?? 1800),
    perLitrePaise: null,
    minCans: null,
    maxCans: null,
    offered: true,
    rawProductText: null,
    rawPackText: null,
    rawPriceText: null,
    matchStatus: "matched",
    matchConfidence: null,
    updatedAt: "",
  };
}

/* ------------------------------------------------------------------ range */

function RangePicker({ basePath, preset, from, to }: { basePath: string; preset: WatchPreset; from: string; to: string }) {
  const router = useRouter();
  const [custom, setCustom] = React.useState(preset === "custom");
  const [a, setA] = React.useState(from);
  const [b, setB] = React.useState(to);
  const go = (p: WatchPreset, f?: string, e?: string) =>
    router.push(p === "custom" ? `${basePath}/watch?preset=custom&from=${f}&to=${e}` : `${basePath}/watch?preset=${p}`);

  return (
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <label className="block">
        <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">Range</span>
        <Select
          value={custom ? "custom" : preset}
          onChange={(e) => {
            const p = e.target.value as WatchPreset;
            if (p === "custom") setCustom(true);
            else {
              setCustom(false);
              go(p);
            }
          }}
        >
          {WATCH_PRESETS.map((p) => (
            <option key={p} value={p}>
              {WATCH_PRESET_LABEL[p]}
            </option>
          ))}
        </Select>
      </label>
      {custom ? (
        <>
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">From</span>
            <Input type="date" value={a} onChange={(e) => setA(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">To (included)</span>
            <Input type="date" value={b} onChange={(e) => setB(e.target.value)} />
          </label>
          <Button variant="primary" disabled={!a || !b || a > b} onClick={() => go("custom", a, b)}>
            Show
          </Button>
        </>
      ) : null}
      <p className="pb-2 text-[13px] text-muted">
        {shortDate(from)} to {shortDate(to)}, both days included. Each line is judged against the book live on its own date.
      </p>
    </div>
  );
}

/* --------------------------------------------------------------- AI card */

function SummaryCard({ from, to, hasBelow }: { from: string; to: string; hasBelow: boolean }) {
  const [busy, setBusy] = React.useState(false);
  const [answer, setAnswer] = React.useState<WatchSummary | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);

  async function summarise() {
    setBusy(true);
    setFailed(null);
    try {
      const r = await summariseWatch({ from, to });
      if (r.ok) setAnswer(r.data);
      else setFailed(r.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-4 px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-ink">Pattern summary</div>
          <p className="text-[13px] text-muted">
            AI reads the groups below and says where the money concentrates. Advice only — it changes no price and approves nothing.
          </p>
        </div>
        <Button variant="secondary" size="sm" disabled={busy || !hasBelow} title={!hasBelow ? "Nothing was billed below the book in this window." : undefined} onClick={() => void summarise()}>
          {busy ? "Reading…" : answer ? "Summarise again" : "Summarise"}
        </Button>
      </div>
      {failed ? <p className="mt-3 text-[13px] text-danger">AI could not answer: {failed}</p> : null}
      {answer && !answer.ok ? <p className="mt-3 text-[13px] text-danger">AI could not answer: {answer.reason}</p> : null}
      {answer && answer.ok ? (
        <div className="mt-3 space-y-3 text-[13px] text-body">
          <p>{answer.summary}</p>
          {answer.concentrations.length ? (
            <ul className="list-disc space-y-1 pl-5">
              {answer.concentrations.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          ) : null}
          {answer.unapproved.length ? (
            <div>
              <div className="mb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">Below the book with nothing on record</div>
              <ul className="space-y-1">
                {answer.unapproved.map((u, i) => (
                  <li key={i}>
                    <strong>{u.person}</strong> — {u.note}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {answer.looksApproved.length ? (
            <div>
              <div className="mb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">Looks approved</div>
              <ul className="list-disc space-y-1 pl-5">
                {answer.looksApproved.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="text-[12px] text-muted">Read by {answer.by}. Check the figures in the table before acting on it.</p>
        </div>
      ) : null}
    </Card>
  );
}

/* ---------------------------------------------------------------- buttons */

function FounderButton({ from, to, groupKey, label }: { from: string; to: string; groupKey?: string; label: string }) {
  const { run } = useToast();
  const [busy, setBusy] = React.useState(false);
  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await run(sendToFounder({ from, to, groupKey: groupKey ?? null }));
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "Sending…" : label}
    </Button>
  );
}

function AskButton({ line }: { line: WatchLineView }) {
  const { run } = useToast();
  const [busy, setBusy] = React.useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={busy}
      title="Tell the shop's account manager and whoever took the line, and ask why."
      onClick={async () => {
        setBusy(true);
        try {
          await run(askAboutLine({ lineId: line.lineId, orderDate: line.orderDate }));
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "Asking…" : "Ask why"}
    </Button>
  );
}

/* ----------------------------------------------------------------- tables */

function Nothing({ what }: { what: string }) {
  return (
    <EmptyState
      title="Nothing billed below the book"
      body={`No priced order line in this window was billed below the book price live on its date, so there is nothing to show ${what}.`}
    />
  );
}

function Expand({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="cursor-pointer text-[13px] text-brand hover:underline" aria-expanded={open}>
      {open ? "Hide lines" : "Lines"}
    </button>
  );
}

function LinesTable({ lines, canManage }: { lines: WatchLineView[]; canManage: boolean }) {
  return (
    <div className="overflow-x-auto bg-canvas px-3 py-2">
      <table className="w-full min-w-[980px] border-collapse text-[13px]">
        <thead>
          <tr>
            <Th>Date</Th>
            <Th>Order</Th>
            <Th>Shop</Th>
            <Th>Product</Th>
            <Th align="right">Cans</Th>
            <Th align="right">Billed</Th>
            <Th align="right">Book</Th>
            <Th align="right">Delta</Th>
            <Th align="right">Given away</Th>
            <Th>Source · who</Th>
            {canManage ? <Th /> : null}
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <Tr key={l.lineId}>
              <Td>{shortDate(l.orderDate)}</Td>
              <Td>{l.orderNumber ?? <span className="text-muted">no number</span>}</Td>
              <Td>{l.customerName}</Td>
              <Td>{l.productName}</Td>
              <Td align="right">{l.cans ?? <span className="text-muted">—</span>}</Td>
              <Td align="right">{money(l.billedExPaise)}</Td>
              <Td align="right">{l.listExPaise == null ? <span className="text-muted">no book price</span> : money(l.listExPaise)}</Td>
              <Td align="right">
                {l.deltaPaise == null ? (
                  <span className="text-muted">—</span>
                ) : (
                  <span className={l.deltaPaise < 0 ? "text-danger" : l.deltaPaise > 0 ? "text-success" : undefined}>
                    {l.deltaPaise > 0 ? "+" : l.deltaPaise < 0 ? "−" : ""}
                    {money(l.deltaPaise)} <span className="text-[12px]">{pct(l.deltaBp)}</span>
                  </span>
                )}
              </Td>
              <Td align="right">{l.givenAwayPaise ? <span className="text-danger">{money(l.givenAwayPaise)}</span> : <span className="text-muted">—</span>}</Td>
              <Td>
                {SOURCE_LABEL[l.source]} · {l.person.known ? l.person.name : <span className="text-muted">not recorded</span>}
                {l.approval ? (
                  <span className="ml-1">
                    <Badge tone="success">{APPROVAL_LABEL[l.approval]}</Badge>
                  </span>
                ) : null}
              </Td>
              {canManage ? <Td>{l.verdict === "below" ? <AskButton line={l} /> : null}</Td> : null}
            </Tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ShopTable({
  report,
  canManage,
  onSpecial,
}: {
  report: WatchResult;
  canManage: boolean;
  onSpecial: (g: WatchShopProduct) => void;
}) {
  const [open, setOpen] = React.useState<string | null>(null);
  if (!report.byShopProduct.length) return <Nothing what="by shop and product" />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1180px] border-collapse text-sm">
        <thead>
          <tr>
            <Th>Shop</Th>
            <Th>Product</Th>
            <Th align="right">Book</Th>
            <Th align="right">Billed (min · median)</Th>
            <Th align="right">Lines</Th>
            <Th align="right">Cans</Th>
            <Th align="right">Given away</Th>
            <Th>List · who</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {report.byShopProduct.map((g) => (
            <React.Fragment key={g.key}>
              <Tr>
                <Td>{g.customerName}</Td>
                <Td>{g.productName}</Td>
                <Td align="right">
                  {g.listExPaise == null ? "—" : money(g.listExPaise)}
                  {g.listPrices.length > 1 ? <span className="block text-[12px] text-muted">revised in range</span> : null}
                </Td>
                <Td align="right">
                  {money(g.billedMinPaise)} · {money(g.billedMedianPaise)}
                </Td>
                <Td align="right">{count(g.lines)}</Td>
                <Td align="right">{count(g.cans)}</Td>
                <Td align="right">
                  <span className="text-danger">{money(g.givenAwayPaise)}</span>
                  {g.unapprovedPaise !== g.givenAwayPaise ? (
                    <span className="block text-[12px] text-muted">{money(g.unapprovedPaise)} unapproved</span>
                  ) : null}
                </Td>
                <Td>
                  <span className="block">{g.listNames.join(", ") || "—"}</span>
                  <span className="block text-[12px] text-muted">
                    {g.sources.map((s) => SOURCE_LABEL[s]).join(" & ")} · {g.people.join(", ")}
                  </span>
                  {g.approvals.map((a) => (
                    <Badge key={a} tone="success" className="mr-1">
                      {APPROVAL_LABEL[a]}
                    </Badge>
                  ))}
                </Td>
                <Td>
                  <div className="flex items-center justify-end gap-2">
                    <Expand open={open === g.key} onClick={() => setOpen(open === g.key ? null : g.key)} />
                    {g.customerId && g.productId && g.listExPaise != null ? (
                      <Button variant="ghost" size="sm" onClick={() => onSpecial(g)} title="Ask for this price to be agreed as the shop's special price.">
                        Make it a special price
                      </Button>
                    ) : null}
                    {canManage ? <FounderButton from={report.from} to={report.to} groupKey={g.key} label="Send to founder" /> : null}
                  </div>
                </Td>
              </Tr>
              {open === g.key ? (
                <tr>
                  <td colSpan={9}>
                    <LinesTable lines={g.lineIdx.map((i) => report.lines[i])} canManage={canManage} />
                  </td>
                </tr>
              ) : null}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PersonTable({ report, canManage }: { report: WatchResult; canManage: boolean }) {
  const [open, setOpen] = React.useState<string | null>(null);
  const rows = report.byPerson.filter((p) => p.belowLines > 0);
  if (!rows.length) return <Nothing what="by person" />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] border-collapse text-sm">
        <thead>
          <tr>
            <Th>Who took it</Th>
            <Th>Source</Th>
            <Th align="right">Below / priced lines</Th>
            <Th align="right">Cans</Th>
            <Th align="right">Shops</Th>
            <Th align="right">Given away</Th>
            <Th align="right">Unapproved</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <React.Fragment key={p.key}>
              <Tr>
                <Td>{p.known ? p.name : <span className="text-muted">Not recorded on the line</span>}</Td>
                <Td>{p.sources.map((s) => SOURCE_LABEL[s]).join(" & ")}</Td>
                <Td align="right">
                  {count(p.belowLines)} / {count(p.lines)}
                </Td>
                <Td align="right">{count(p.cans)}</Td>
                <Td align="right">{count(p.shops)}</Td>
                <Td align="right">
                  <span className="text-danger">{money(p.givenAwayPaise)}</span>
                </Td>
                <Td align="right">{money(p.unapprovedPaise)}</Td>
                <Td>
                  <Expand open={open === p.key} onClick={() => setOpen(open === p.key ? null : p.key)} />
                </Td>
              </Tr>
              {open === p.key ? (
                <tr>
                  <td colSpan={8}>
                    <LinesTable lines={p.lineIdx.map((i) => report.lines[i])} canManage={canManage} />
                  </td>
                </tr>
              ) : null}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProductTable({ report, canManage }: { report: WatchResult; canManage: boolean }) {
  const [open, setOpen] = React.useState<string | null>(null);
  const rows = report.byProduct.filter((p) => p.belowLines > 0);
  if (!rows.length) return <Nothing what="by product" />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] border-collapse text-sm">
        <thead>
          <tr>
            <Th>Product</Th>
            <Th align="right">Below / priced lines</Th>
            <Th align="right">Cans</Th>
            <Th align="right">Shops</Th>
            <Th align="right">Median below</Th>
            <Th align="right">Given away</Th>
            <Th align="right">Unapproved</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <React.Fragment key={p.key}>
              <Tr>
                <Td>{p.productName}</Td>
                <Td align="right">
                  {count(p.belowLines)} / {count(p.lines)}
                </Td>
                <Td align="right">{count(p.cans)}</Td>
                <Td align="right">{count(p.shops)}</Td>
                <Td align="right">{pct(p.medianDeltaBp)}</Td>
                <Td align="right">
                  <span className="text-danger">{money(p.givenAwayPaise)}</span>
                </Td>
                <Td align="right">{money(p.unapprovedPaise)}</Td>
                <Td>
                  <Expand open={open === p.key} onClick={() => setOpen(open === p.key ? null : p.key)} />
                </Td>
              </Tr>
              {open === p.key ? (
                <tr>
                  <td colSpan={8}>
                    <LinesTable lines={p.lineIdx.map((i) => report.lines[i])} canManage={canManage} />
                  </td>
                </tr>
              ) : null}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AllLines({ report, canManage }: { report: WatchResult; canManage: boolean }) {
  if (!report.lines.length) {
    return (
      <EmptyState
        title="No priced order lines in this window"
        body="Neither the order sheet nor the ERP has a line with a rate between these dates — or none of them is in your book."
      />
    );
  }
  const sorted = [...report.lines].sort((a, b) => b.givenAwayPaise - a.givenAwayPaise || (a.orderDate < b.orderDate ? 1 : a.orderDate > b.orderDate ? -1 : 0));
  return (
    <>
      <LinesTable lines={sorted.slice(0, LINES_SHOWN)} canManage={canManage} />
      {sorted.length > LINES_SHOWN ? (
        <p className="px-4 py-3 text-[13px] text-muted">
          The {count(LINES_SHOWN)} lines that gave away the most are shown, of {count(sorted.length)}. The groups above add up all of them.
        </p>
      ) : null}
    </>
  );
}
