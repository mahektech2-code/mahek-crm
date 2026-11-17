"use client";

import * as React from "react";
import { Button, Textarea, Th, Td, Tr, cx } from "@/components/ui/primitives";
import { erpLoadForm } from "@/lib/actions/erp";
import { inr, nf, NEW_FORM_ACTION } from "@/lib/erp/ui";
import type { HubBoardRow } from "@/lib/erp/screens/order-hub";
import { clock, stamp } from "@/lib/format";
import { ActionMenu, BoardFoot, BoardHeader, BoardTable, BoardTabs, CheckMark, FigureCards, Pill, waitLate, waitWords } from "../_ui/board";
import { DialogBody, DialogFooter, DialogHeader, DialogTitle, ErpDialog, TabBar } from "../_ui/dialog";
import { useErpUi } from "../_ui/erp-ui";
import { useKit } from "../_ui/kit";
import { Eyebrow } from "../_ui/look";

/* ---------------------------------------------------------------------------
 * THE ORDER HUB BOARD and its Verify dialog, as the mockups draw them. Every
 * write goes through the hub list's own actions on the server — Verify,
 * Send back for correction, Put on hold, Edit TO, Cancel TO — so the rules
 * (who checks which, the second check makes the order number) are unchanged.
 * ------------------------------------------------------------------------- */

export type HubTab = "mine" | "waiting" | "correction" | "verified";
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
  const mine = waiting.filter((r) => r.myCheck);
  const correction = rows.filter((r) => r.status === "correction");
  const held = rows.filter((r) => r.status === "hold");
  const verifiedToday = rows.filter((r) => r.verifiedToday);
  const [tab, setTab] = React.useState<HubTab>(initialTab ?? (mine.length ? "mine" : "waiting"));
  const [openId, setOpenId] = React.useState<string | null>(initialOpen);
  const shown = tab === "mine" ? mine : tab === "waiting" ? waiting : tab === "correction" ? correction : verifiedToday;
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
          { label: "Waiting for checks", value: waiting.length, onClick: () => setTab("waiting"), on: tab === "waiting" },
          { label: "Need your check", value: mine.length, onClick: () => setTab("mine"), on: tab === "mine" },
          { label: "Sent back for correction", value: correction.length, onClick: () => setTab("correction"), on: tab === "correction" },
          { label: "On hold here", value: held.length },
          { label: "Got order numbers today", value: verifiedToday.length, onClick: () => setTab("verified"), on: tab === "verified" },
        ]}
      />
      <BoardTabs<HubTab>
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "mine", label: "Need my check", count: mine.length },
          { key: "waiting", label: "All waiting", count: waiting.length },
          { key: "correction", label: "Correction", count: correction.length },
          { key: "verified", label: "Verified today", count: verifiedToday.length },
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
              <Th>Checks</Th>
              <Th>{tab === "verified" ? "Order" : "Waiting"}</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const verify = r.actions.find((a) => a.id === "verify");
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
                    <CheckMark done={!!r.back} label={r.edited && !r.back ? "Back office (again)" : "Back office"} by={r.back?.by} />
                    <CheckMark done={!!r.prod} label="Production Head" by={r.prod?.by} />
                  </Td>
                  <Td className={cx("py-3", late ? "font-medium text-danger" : "text-ink")}>{r.orderNo ? `Order ${r.orderNo}` : waitWords(r.createdAt, now)}</Td>
                  <Td className="py-3" onClick={(e) => e.stopPropagation()}>
                    <span className="flex items-center justify-end gap-2">
                      {verify && !readOnly ? (
                        <Button size="sm" variant="success" disabled={!!verify.why} title={verify.why || undefined} onClick={() => setOpenId(r.id)}>
                          Verify
                        </Button>
                      ) : null}
                      {readOnly ? null : <ActionMenu screen={SCREEN} recordId={r.id} actions={r.actions} skip={["verify"]} extra={[{ label: `Open TO-${r.toNo}`, onSelect: () => setOpenId(r.id) }]} />}
                    </span>
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </BoardTable>
      ) : (
        <div className="rounded-card border border-line bg-surface px-5 py-10 text-center text-sm text-muted">
          {tab === "mine" ? "Nothing needs your check." : tab === "correction" ? "Nothing sent back." : tab === "verified" ? "Nothing got its order number today." : "Nothing waiting. A new order lands here as a TO number."}
        </div>
      )}
      <BoardFoot>⋯ has Edit TO, Send back for correction and Hold. The order number is made by whichever check comes second. An edit by the person who took the order clears both checks.</BoardFoot>
      {open ? <VerifyDialog key={open.id} row={open} readOnly={readOnly} onClose={() => setOpenId(null)} /> : null}
    </div>
  );
}

type VTab = "checks" | "lines" | "party" | "history";

function VerifyDialog({ row, readOnly, onClose }: { row: HubBoardRow; readOnly: boolean; onClose: () => void }) {
  const ui = useErpUi();
  const kit = useKit();
  const [tab, setTab] = React.useState<VTab>("checks");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const verify = row.actions.find((a) => a.id === "verify");
  const correct = row.actions.find((a) => a.id === "correct");
  const hold = row.actions.find((a) => a.id === "hold");
  const edit = row.actions.find((a) => a.id === "editTo");
  const done = (row.back ? 1 : 0) + (row.prod ? 1 : 0);
  const totalLitres = row.lines.reduce((n, l) => n + (l.litres ?? 0), 0);
  const runAfterClose = (a: NonNullable<typeof verify>) => {
    onClose();
    ui.act(SCREEN, a, row.id);
  };

  async function doVerify() {
    setBusy(true);
    try {
      const res = await kit.runAction(SCREEN, "verify", row.id, { note });
      if (res.ok) {
        ui.toast(res.message ?? "Verified");
        onClose();
      } else ui.toast(res.fieldErrors?.[0]?.message ?? res.error, "error");
    } finally {
      setBusy(false);
    }
  }

  const checkSection = (kind: "backOffice" | "production") => {
    const done = kind === "backOffice" ? row.back : row.prod;
    const label = kind === "backOffice" ? "Back office" : "Production Head";
    const you = row.myCheck === kind;
    return (
      <div className="flex flex-col">
        <Eyebrow className="mb-2">
          {label}
          {you ? " · you" : ""}
        </Eyebrow>
        {done ? (
          <CheckLine tone="ok">
            Verified by <b className="font-semibold text-ink">{done.by ?? "—"}</b> at {clock(new Date(done.at))}
            {done.note ? <span className="block text-muted">&ldquo;{done.note}&rdquo;</span> : null}
          </CheckLine>
        ) : you ? (
          row.checklist.map((c, i) => (
            <CheckLine key={i} tone={c.tone}>
              {c.text}
            </CheckLine>
          ))
        ) : (
          <CheckLine tone="wait">Not checked yet</CheckLine>
        )}
      </div>
    );
  };

  return (
    <ErpDialog onClose={onClose} label={`TO-${row.toNo}`} width={820} tall={false}>
      <DialogHeader onClose={onClose} aside={row.second && verify && !verify.why ? <span className="text-meta text-body">Verifying now makes the order number</span> : undefined}>
        <DialogTitle className="flex items-center gap-2">
          TO-{row.toNo}
          {row.status === "open" ? <Pill tone="info">{done} of 2 checks done</Pill> : <Pill tone={row.status === "verified" ? "success" : row.status === "correction" || row.status === "hold" ? "warn" : "muted"}>{row.orderNo ? `Order ${row.orderNo}` : row.status === "correction" ? "Sent back" : row.status === "hold" ? "On hold" : row.status}</Pill>}
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
          { key: "checks", label: "Checks" },
          { key: "lines", label: "Lines", count: row.lines.length },
          { key: "party", label: "Party" },
          { key: "history", label: "History" },
        ]}
      />
      <DialogBody>
        {tab === "checks" ? (
          <div className="grid gap-6 md:grid-cols-2">
            <div className="flex flex-col gap-4">
              {checkSection("backOffice")}
              {checkSection("production")}
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
              {row.status === "open" && !readOnly ? (
                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium text-ink">
                    Note <span className="font-normal text-muted">(optional)</span>
                  </span>
                  <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
                </label>
              ) : null}
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
        {readOnly ? (
          <Button onClick={onClose}>Close</Button>
        ) : (
          <>
            {correct ? (
              <Button onClick={() => runAfterClose(correct)} disabled={!!correct.why} title={correct.why || undefined}>
                Send back for correction
              </Button>
            ) : null}
            {hold ? (
              <Button onClick={() => runAfterClose(hold)} disabled={!!hold.why} title={hold.why || undefined}>
                Hold
              </Button>
            ) : null}
            {verify ? (
              <Button variant="success" onClick={doVerify} disabled={busy || !!verify.why} title={verify.why || undefined}>
                {busy ? "Verifying…" : "Verify"}
              </Button>
            ) : (
              <Button onClick={onClose}>Close</Button>
            )}
          </>
        )}
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
    ...(row.edited ? [{ at: row.edited.at, text: `Edited by ${row.edited.by ?? "the taker"}. Both checks start again.` }] : []),
    ...(row.back ? [{ at: row.back.at, text: `Back office check · ${row.back.by ?? ""}${row.back.note ? ` — “${row.back.note}”` : ""}` }] : []),
    ...(row.prod ? [{ at: row.prod.at, text: `Production Head check · ${row.prod.by ?? ""}${row.prod.note ? ` — “${row.prod.note}”` : ""}` }] : []),
    ...(row.correction ? [{ at: row.correction.at, text: `Sent back for correction${row.correction.by ? ` by ${row.correction.by}` : ""}: ${row.correction.note}` }] : []),
    ...(row.held ? [{ at: row.held.at, text: `On hold${row.held.by ? ` by ${row.held.by}` : ""}: ${row.held.reason}${row.held.note ? ` — ${row.held.note}` : ""}` }] : []),
    ...(row.orderNo ? [{ at: row.prod?.at ?? row.back?.at ?? null, text: `Order ${row.orderNo} made · with Accounts` }] : []),
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
