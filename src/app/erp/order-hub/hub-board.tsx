"use client";

import * as React from "react";
import { Button, Th, Td, Tr, cx } from "@/components/ui/primitives";
import { erpLoadForm } from "@/lib/actions/erp";
import { inr, nf, NEW_FORM_ACTION } from "@/lib/erp/ui";
import type { HubBoardRow } from "@/lib/erp/screens/order-hub";
import { clock, stamp } from "@/lib/format";
import { ActionMenu, BoardFoot, BoardHeader, BoardTable, BoardTabs, FigureCards, Pill, waitLate, waitWords } from "../_ui/board";
import { DialogBody, DialogFooter, DialogHeader, DialogTitle, ErpDialog, TabBar } from "../_ui/dialog";
import { useErpUi } from "../_ui/erp-ui";
import { Eyebrow } from "../_ui/look";

/* ---------------------------------------------------------------------------
 * THE ORDER HUB BOARD and its TO dialog. Option A: Accounts approve a TO in
 * Accounts > Order approvals, and that makes the order number, so the hub
 * verifies nothing. Its writes are the hub list's own actions on the server:
 * Edit TO and Cancel TO.
 * ------------------------------------------------------------------------- */

export type HubTab = "waiting" | "correction" | "verified";
const SCREEN = "orderHub";

function goodsLine(l: HubBoardRow["lines"][number]): string {
  return `${l.sku} × ${l.boxes != null ? `${l.boxes} boxes` : `${l.qty} cans`}`;
}

export function HubBoard({
  rows,
  seeMoney,
  now,
  initialTab,
  initialOpen,
  readOnly,
}: {
  rows: HubBoardRow[];
  seeMoney: boolean;
  now: number;
  initialTab: HubTab | null;
  initialOpen: string | null;
  readOnly: boolean;
}) {
  const ui = useErpUi();
  const waiting = rows.filter((r) => r.status === "open");
  const correction = rows.filter((r) => r.status === "correction");
  const held = rows.filter((r) => r.status === "hold");
  const verifiedToday = rows.filter((r) => r.verifiedToday);
  const [tab, setTab] = React.useState<HubTab>(initialTab ?? "waiting");
  const [openId, setOpenId] = React.useState<string | null>(initialOpen);
  const shown = tab === "waiting" ? waiting : tab === "correction" ? correction : verifiedToday;
  const open = rows.find((r) => r.id === openId) ?? null;

  const newOrder = () => ui.askForm("New order", () => erpLoadForm(SCREEN, NEW_FORM_ACTION, ""));

  return (
    <div className="px-6 pt-6 pb-10">
      <BoardHeader
        title="Order Hub"
        sub="Every new order, before it has an order number"
        actions={
          readOnly ? null : (
            <Button variant="primary" onClick={newOrder}>
              + New order
            </Button>
          )
        }
      />
      <FigureCards
        figures={[
          { label: "Waiting for Accounts", value: waiting.length, onClick: () => setTab("waiting"), on: tab === "waiting" },
          { label: "Sent back by Accounts", value: correction.length, onClick: () => setTab("correction"), on: tab === "correction" },
          { label: "On hold here", value: held.length },
          { label: "Got order numbers today", value: verifiedToday.length, onClick: () => setTab("verified"), on: tab === "verified" },
        ]}
      />
      <BoardTabs<HubTab>
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "waiting", label: "Waiting for Accounts", count: waiting.length },
          { key: "correction", label: "Sent back", count: correction.length },
          { key: "verified", label: "Approved today", count: verifiedToday.length },
        ]}
      />
      {shown.length ? (
        <BoardTable>
          <colgroup>
            <col style={{ width: 110 }} />
            <col style={{ width: 230 }} />
            <col />
            {seeMoney ? <col style={{ width: 110 }} /> : null}
            <col style={{ width: 190 }} />
            <col style={{ width: 100 }} />
            <col style={{ width: 120 }} />
          </colgroup>
          <thead>
            <tr>
              <Th>TO</Th>
              <Th>Party · taken by</Th>
              <Th>Goods</Th>
              {seeMoney ? <Th align="right">Value</Th> : null}
              <Th>Accounts</Th>
              <Th>{tab === "verified" ? "Order" : "Waiting"}</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const late = r.status === "open" && waitLate(r.createdAt, now);
              return (
                <Tr key={r.id} className={cx("cursor-pointer hover:bg-canvas/70", r.dup ? "bg-warn-soft/40" : undefined)} onClick={() => setOpenId(r.id)}>
                  <Td className="py-3 font-semibold text-ink">TO-{r.toNo}</Td>
                  <Td className="py-3 whitespace-normal">
                    <span className="block truncate text-ink">{r.party}</span>
                    <span className="block truncate text-meta text-muted">{[r.city, r.source, r.takenBy].filter(Boolean).join(" · ")}</span>
                  </Td>
                  <Td className="py-3 whitespace-normal">
                    {r.lines.length <= 2 ? (
                      <>
                        <span className="block truncate text-ink">{goodsLine(r.lines[0])}</span>
                        <span className="block truncate text-meta text-muted">{[r.lines[1] ? goodsLine(r.lines[1]) : null, `${nf(r.litres)} L`].filter(Boolean).join(" · ")}</span>
                      </>
                    ) : (
                      <>
                        <span className="block text-ink">{r.lines.length} products</span>
                        <span className="block text-meta text-muted">{nf(r.litres)} L</span>
                      </>
                    )}
                    {r.dup ? (
                      <span className="mt-1 block">
                        <Pill tone="warn">Possible duplicate of {r.dup}</Pill>
                      </span>
                    ) : null}
                    {r.edited ? (
                      <span className="mt-1 block">
                        <Pill tone="info">
                          Edited by {r.edited.by ?? "the taker"} at {clock(new Date(r.edited.at))}
                        </Pill>
                      </span>
                    ) : null}
                    {r.status === "correction" && r.correction ? <span className="mt-1 block text-meta text-danger">Sent back: {r.correction.note}</span> : null}
                  </Td>
                  {seeMoney ? (
                    <Td align="right" className="py-3 tabular-nums text-ink">
                      {r.value != null ? inr(r.value) : ""}
                    </Td>
                  ) : null}
                  <Td className="py-3">
                    {r.orderNo ? <Pill tone="success">Approved</Pill> : r.status === "correction" ? <Pill tone="warn">Sent back</Pill> : r.status === "hold" ? <Pill tone="warn">On hold</Pill> : <Pill tone="info">Waiting</Pill>}
                  </Td>
                  <Td className={cx("py-3", late ? "font-medium text-danger" : "text-ink")}>{r.orderNo ? `Order ${r.orderNo}` : waitWords(r.createdAt, now)}</Td>
                  <Td className="py-3" onClick={(e) => e.stopPropagation()}>
                    <span className="flex items-center justify-end gap-2">
                      {readOnly ? null : <ActionMenu screen={SCREEN} recordId={r.id} actions={r.actions} extra={[{ label: `Open TO-${r.toNo}`, onSelect: () => setOpenId(r.id) }]} />}
                    </span>
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </BoardTable>
      ) : (
        <div className="rounded-card border border-line bg-surface px-5 py-10 text-center text-sm text-muted">
          {tab === "correction" ? "Nothing sent back." : tab === "verified" ? "Nothing got its order number today." : "Nothing waiting. A new order lands here as a TO number."}
        </div>
      )}
      <BoardFoot>Accounts approve each TO in Accounts › Order approvals, and that makes its order number. ⋯ has Edit TO and Cancel TO.</BoardFoot>
      {open ? <ToDialog key={open.id} row={open} readOnly={readOnly} onClose={() => setOpenId(null)} /> : null}
    </div>
  );
}

type VTab = "checks" | "lines" | "party" | "history";

function ToDialog({ row, readOnly, onClose }: { row: HubBoardRow; readOnly: boolean; onClose: () => void }) {
  const ui = useErpUi();
  const [tab, setTab] = React.useState<VTab>("checks");
  const edit = row.actions.find((a) => a.id === "editTo");
  const cancel = row.actions.find((a) => a.id === "cancel");
  const totalLitres = row.lines.reduce((n, l) => n + (l.litres ?? 0), 0);
  const runAfterClose = (a: NonNullable<typeof edit>) => {
    onClose();
    ui.act(SCREEN, a, row.id);
  };

  return (
    <ErpDialog onClose={onClose} label={`TO-${row.toNo}`} width={820} tall={false}>
      <DialogHeader onClose={onClose}>
        <DialogTitle className="flex items-center gap-2">
          TO-{row.toNo}
          {row.status === "open" ? <Pill tone="info">Waiting for Accounts</Pill> : <Pill tone={row.status === "verified" ? "success" : row.status === "correction" || row.status === "hold" ? "warn" : "muted"}>{row.orderNo ? `Order ${row.orderNo}` : row.status === "correction" ? "Sent back" : row.status === "hold" ? "On hold" : row.status}</Pill>}
        </DialogTitle>
        <div className="mt-1 text-meta text-body">
          {row.party}
          {row.city ? `, ${row.city}` : ""} · taken by {row.takenBy ?? "—"} on {row.source === "TeleCRM" ? "a TeleCRM call" : row.source === "Salesman App" ? "the Salesman App" : row.source} · {stamp(row.createdAt)}
        </div>
      </DialogHeader>
      <TabBar
        active={tab}
        onChange={(k) => setTab(k as VTab)}
        tabs={[
          { key: "checks", label: "Order" },
          { key: "lines", label: "Lines", count: row.lines.length },
          { key: "party", label: "Party" },
          { key: "history", label: "History" },
        ]}
      />
      <DialogBody>
        {tab === "checks" ? (
          <div className="grid gap-6 md:grid-cols-2">
            <div className="flex flex-col">
              <Eyebrow className="mb-2">What Accounts will see</Eyebrow>
              {row.checklist.map((c, i) => (
                <CheckLine key={i} tone={c.tone}>
                  {c.text}
                </CheckLine>
              ))}
            </div>
            <div className="flex flex-col gap-4">
              <div className="overflow-hidden rounded-card border border-line">
                <table className="w-full">
                  <thead>
                    <tr>
                      <Th>Product</Th>
                      <Th align="right">Cans</Th>
                      <Th align="right">Litres</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {row.lines.map((l, i) => (
                      <Tr key={i}>
                        <Td className="whitespace-normal text-ink">{l.sku}</Td>
                        <Td align="right" className="tabular-nums text-ink">
                          {l.qty}
                        </Td>
                        <Td align="right" className="tabular-nums text-ink">
                          {l.litres ?? "—"}
                        </Td>
                      </Tr>
                    ))}
                    <Tr className="bg-canvas/60">
                      <Td className="font-semibold text-ink">Total</Td>
                      <Td colSpan={2} align="right" className="font-semibold tabular-nums text-ink">
                        {nf(totalLitres)} L{row.value != null ? ` · ${inr(row.value)}` : ""}
                      </Td>
                    </Tr>
                  </tbody>
                </table>
              </div>
              {row.correction ? <p className="text-meta text-danger">Sent back{row.correction.by ? ` by ${row.correction.by}` : ""}: {row.correction.note}</p> : null}
              {row.remark ? <p className="text-meta text-body">Remark: {row.remark}</p> : null}
            </div>
          </div>
        ) : tab === "lines" ? (
          <div className="overflow-hidden rounded-card border border-line">
            <table className="w-full">
              <thead>
                <tr>
                  <Th>Product</Th>
                  <Th align="right">Cans</Th>
                  <Th align="right">Boxes</Th>
                  <Th align="right">Litres</Th>
                  {row.value != null ? <Th align="right">Rate</Th> : null}
                  {row.value != null ? <Th align="right">Amount</Th> : null}
                </tr>
              </thead>
              <tbody>
                {row.lines.map((l, i) => (
                  <Tr key={i}>
                    <Td className="whitespace-normal text-ink">
                      {l.sku}
                      {!l.active ? <span className="ml-2 text-meta text-danger">not active</span> : null}
                    </Td>
                    <Td align="right">{l.qty}</Td>
                    <Td align="right">{l.boxes ?? "—"}</Td>
                    <Td align="right">{l.litres ?? "—"}</Td>
                    {row.value != null ? <Td align="right">{l.rate != null ? inr(l.rate) : "no rate"}</Td> : null}
                    {row.value != null ? <Td align="right">{l.amount != null ? inr(l.amount) : ""}</Td> : null}
                  </Tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : tab === "party" ? (
          <dl className="grid grid-cols-[160px_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-sm">
            {[
              ["Billing party", `${row.party}${row.city ? `, ${row.city}` : ""}`],
              ["Delivery party", row.delivery],
              ["Godown", row.godown ?? "Not picked"],
              ["Transporter", row.transporter ?? "The delivery party's"],
              ["Order date", row.orderDate],
              ["Taken", `${row.source}${row.takenBy ? ` · ${row.takenBy}` : ""}`],
            ].map(([k, v]) => (
              <React.Fragment key={k}>
                <dt className="text-muted">{k}</dt>
                <dd className="text-ink">{v}</dd>
              </React.Fragment>
            ))}
          </dl>
        ) : (
          <History row={row} />
        )}
      </DialogBody>
      <DialogFooter
        left={
          edit && !readOnly ? (
            <Button onClick={() => runAfterClose(edit)} disabled={!!edit.why} title={edit.why || undefined}>
              Edit TO
            </Button>
          ) : undefined
        }
      >
        {cancel && !readOnly ? (
          <Button variant="dangerOutline" onClick={() => runAfterClose(cancel)} disabled={!!cancel.why} title={cancel.why || undefined}>
            Cancel TO
          </Button>
        ) : null}
        <Button onClick={onClose}>Close</Button>
      </DialogFooter>
    </ErpDialog>
  );
}

function CheckLine({ tone, children }: { tone: "ok" | "warn" | "wait"; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 border-b border-divider py-2.5 text-sm text-body last:border-0">
      <span
        aria-hidden="true"
        className={cx(
          "mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full text-xs font-bold",
          tone === "ok" ? "bg-success-soft text-success" : tone === "warn" ? "bg-warn-soft text-warn-ink" : "border border-line-strong text-muted",
        )}
      >
        {tone === "ok" ? "✓" : tone === "warn" ? "!" : ""}
      </span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

function History({ row }: { row: HubBoardRow }) {
  const events: { at: string | null; text: string }[] = [
    { at: row.createdAt, text: `Taken${row.takenBy ? ` by ${row.takenBy}` : ""} · ${row.source}` },
    ...(row.edited ? [{ at: row.edited.at, text: `Edited by ${row.edited.by ?? "the taker"}` }] : []),
    ...(row.correction ? [{ at: row.correction.at, text: `Sent back by Accounts${row.correction.by ? ` (${row.correction.by})` : ""}: ${row.correction.note}` }] : []),
    ...(row.held ? [{ at: row.held.at, text: `On hold${row.held.by ? ` by ${row.held.by}` : ""}: ${row.held.reason}${row.held.note ? ` — ${row.held.note}` : ""}` }] : []),
    ...(row.orderNo ? [{ at: null, text: `Approved by Accounts · order ${row.orderNo} made` }] : []),
    ...(row.cancelReason ? [{ at: null, text: `Cancelled: ${row.cancelReason}` }] : []),
  ].sort((a, b) => (a.at ?? "9").localeCompare(b.at ?? "9"));
  return (
    <ol className="flex flex-col">
      {events.map((e, i) => (
        <li key={i} className="grid grid-cols-[140px_minmax(0,1fr)] gap-3 border-b border-divider py-2.5 text-sm last:border-0">
          <span className="text-muted">{e.at ? stamp(e.at) : ""}</span>
          <span className="text-ink">{e.text}</span>
        </li>
      ))}
    </ol>
  );
}
