"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button, controlClass, cx } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/modal";
import { CardGrid } from "@/components/ui/card-grid";
import { useToast } from "@/components/ui/toast";
import { money, stamp } from "@/lib/format";
import { approveToAction, declineToAction, holdToAction, loadToReviewAction, releaseToAction, saveToLinesAction, sendBackToAction } from "@/lib/actions/to-approval";
import type { AccountsToRow, ToReview } from "@/lib/services/to-approval-service";
import { ACCOUNTS_HOLD_REASONS } from "@/lib/erp/engines/order-hub";
import { Cell, Empty, HeadCell, Pill, Row, ScreenHeader, Table, plural } from "../parts";
import { OrderLinesEditor, discountBpOf, lineAmount, lineErrors, linesEdited, type EditLine } from "./order-lines-editor";

/* ---------------------------------------------------------------------------
 * ACCOUNTS › ORDER APPROVALS, the TO queue (Option A).
 *
 * Every order is a TO until Accounts approve it here; approving makes the
 * order number and hands it to the Production Head's MRP check. The review
 * lets Accounts change the LINES for this order only (product, cans, rate,
 * discount, add a line) — the parties and the godown are shown, never
 * edited: a wrong party is sent back to whoever took it.
 * ------------------------------------------------------------------------- */


function waiting(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h${min % 60 ? ` ${min % 60} m` : ""}`;
  const d = Math.floor(h / 24);
  return `${plural(d, "day")}`;
}

function Flags({ r }: { r: AccountsToRow }) {
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {r.duplicate?.state === "possible" ? <Pill tone="warn">Possible duplicate of TO-{r.duplicate.toNo}</Pill> : null}
      {r.duplicate?.state === "different" ? <Pill tone="neutral">Different from TO-{r.duplicate.toNo}</Pill> : null}
      {r.overCreditLimit ? <Pill tone="danger">Over credit limit</Pill> : null}
      {r.pendingCustomer ? <Pill tone="brand">Pending customer</Pill> : null}
      {r.noRateLines ? <Pill tone="danger">{plural(r.noRateLines, "line")} with no rate</Pill> : null}
    </span>
  );
}

/** Nothing to look at: approved straight from the list. Anything flagged opens in Review. */
const clean = (r: AccountsToRow) => r.duplicate?.state !== "possible" && !r.overCreditLimit && !r.pendingCustomer && !r.noRateLines;

export function ToApprovals({
  waiting: waitingRows,
  sentBack,
  held,
  canDecide,
}: {
  waiting: AccountsToRow[];
  sentBack: AccountsToRow[];
  held: AccountsToRow[];
  canDecide: boolean;
}) {
  const router = useRouter();
  const { run } = useToast();
  const [tab, setTab] = React.useState<"approve" | "sentBack">("approve");
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [releaseFor, setReleaseFor] = React.useState<AccountsToRow | null>(null);
  const rows = tab === "approve" ? waitingRows : sentBack;
  const past = waitingRows.filter((r) => r.pastDeadline).length;
  const dups = waitingRows.filter((r) => r.duplicate?.state === "possible").length;

  async function quickApprove(r: AccountsToRow) {
    setBusy(r.id);
    try {
      const res = await run(approveToAction(r.id, null));
      if (res.ok) router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const cards: { label: string; value: number; tone?: string }[] = [
    { label: "TOs waiting", value: waitingRows.length },
    { label: "Past the deadline", value: past, tone: past ? "text-danger" : undefined },
    { label: "Possible duplicates", value: dups, tone: dups ? "text-warn-ink" : undefined },
    { label: "Sent back, waiting for taker", value: sentBack.length },
  ];

  return (
    <section className="mx-auto w-full max-w-(--container-measure) px-6 pt-6" aria-labelledby="to-approvals">
      <ScreenHeader title={<span id="to-approvals">Order approvals</span>} />
      <CardGrid min={200} gap="gap-3" className="mb-4">
        {cards.map((c) => (
          <div key={c.label} className="rounded-card border border-line bg-surface px-4 py-3">
            <div className="text-[12px] text-muted">{c.label}</div>
            <div className={cx("text-[24px] font-semibold tabular-nums", c.tone ?? "text-ink")}>{c.value}</div>
          </div>
        ))}
      </CardGrid>
      <div role="tablist" className="mb-3 flex gap-1 border-b border-line">
        {(
          [
            ["approve", `To approve (${waitingRows.length})`],
            ["sentBack", `Sent back (${sentBack.length})`],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={cx("-mb-px cursor-pointer border-b-2 px-3.5 py-2 text-sm", tab === k ? "border-brand font-semibold text-brand-deep" : "border-transparent text-muted")}
          >
            {label}
          </button>
        ))}
      </div>
      {rows.length ? (
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          <Table
            minWidth={1000}
            head={
              <>
                <HeadCell width={90}>TO</HeadCell>
                <HeadCell>Billing → delivery</HeadCell>
                <HeadCell width={170}>Taken by</HeadCell>
                <HeadCell width={130}>Goods</HeadCell>
                <HeadCell align="right" width={110}>Value</HeadCell>
                <HeadCell align="right" width={150}>Owes / overdue</HeadCell>
                <HeadCell width={130}>{tab === "approve" ? "Waiting" : "Sent back"}</HeadCell>
                <HeadCell width={170}>
                  <span className="sr-only">Actions</span>
                </HeadCell>
              </>
            }
          >
            {rows.map((r, i) => (
              <Row key={r.id} striped={i % 2 === 1}>
                <Cell className="align-top font-semibold text-ink">TO-{r.toNo}</Cell>
                <Cell className="align-top whitespace-normal">
                  <div>
                    {r.billingName} → {r.deliveryName}
                  </div>
                  <Flags r={r} />
                  {tab === "sentBack" && r.correctionNote ? <div className="mt-1 text-[12.5px] text-muted">&ldquo;{r.correctionNote}&rdquo;</div> : null}
                </Cell>
                <Cell className="align-top">{r.takenBy}</Cell>
                <Cell className="align-top">
                  {plural(r.lineCount, "line")} · {r.litres.toLocaleString("en-IN")} L
                </Cell>
                <Cell align="right" className="align-top">
                  {money(r.valuePaise)}
                </Cell>
                <Cell align="right" className="align-top">
                  {money(r.outstandingPaise)} · {money(r.overduePaise)}
                </Cell>
                <Cell className={cx("align-top", r.pastDeadline ? "font-semibold text-danger" : "")}>
                  {waiting(r.waitingMinutes)}
                  {r.pastDeadline ? " · past deadline" : ""}
                </Cell>
                <Cell className="align-top">
                  <span className="flex justify-end gap-1.5">
                    {tab === "approve" && clean(r) ? (
                      <Button variant="primary" size="sm" disabled={!canDecide || busy === r.id} title={canDecide ? undefined : "Only an Accounts manager approves an order"} onClick={() => void quickApprove(r)}>
                        Approve
                      </Button>
                    ) : null}
                    <Button size="sm" onClick={() => setOpenId(r.id)}>
                      Review
                    </Button>
                  </span>
                </Cell>
              </Row>
            ))}
          </Table>
        </div>
      ) : (
        <Empty title={tab === "approve" ? "Nothing to approve" : "Nothing sent back"} body={tab === "approve" ? "A new order lands here as a TO number." : "A TO you send back waits here until whoever took it corrects it."} />
      )}
      <p className="mt-2 text-[12.5px] text-muted">Approve makes the order number. Held TOs are listed below; releasing one brings it back here.</p>

      {held.length ? (
        <div className="mt-6">
          <h2 className="mb-2 text-[18px] font-semibold text-ink">TOs on hold · {held.length}</h2>
          <div className="overflow-hidden rounded-card border border-line bg-surface">
            <Table
              minWidth={820}
              head={
                <>
                  <HeadCell width={90}>TO</HeadCell>
                  <HeadCell>Party</HeadCell>
                  <HeadCell align="right" width={120}>Value</HeadCell>
                  <HeadCell>Reason · remarks</HeadCell>
                  <HeadCell width={120}>
                    <span className="sr-only">Actions</span>
                  </HeadCell>
                </>
              }
            >
              {held.map((r, i) => (
                <Row key={r.id} striped={i % 2 === 1}>
                  <Cell className="font-semibold text-ink">TO-{r.toNo}</Cell>
                  <Cell>{r.billingName}</Cell>
                  <Cell align="right">{money(r.valuePaise)}</Cell>
                  <Cell className="whitespace-normal">
                    <span className="font-medium">{r.holdReason}</span>
                    {r.holdNote ? <span className="text-muted"> · {r.holdNote}</span> : null}
                  </Cell>
                  <Cell>
                    <span className="flex justify-end">
                      <Button size="sm" disabled={!canDecide} onClick={() => setReleaseFor(r)}>
                        Release
                      </Button>
                    </span>
                  </Cell>
                </Row>
              ))}
            </Table>
          </div>
        </div>
      ) : null}

      {openId ? <ReviewDialog key={openId} id={openId} canDecide={canDecide} onClose={() => setOpenId(null)} onDone={() => { setOpenId(null); router.refresh(); }} /> : null}
      {releaseFor ? <ReleaseDialog row={releaseFor} onClose={() => setReleaseFor(null)} onDone={() => { setReleaseFor(null); router.refresh(); }} /> : null}
    </section>
  );
}

/* ------------------------------------------------------------- the review */

function ReviewDialog({ id, canDecide, onClose, onDone }: { id: string; canDecide: boolean; onClose: () => void; onDone: () => void }) {
  const { run } = useToast();
  const [data, setData] = React.useState<{ review: ToReview; products: { id: string; name: string }[] } | null>(null);
  const [loadError, setLoadError] = React.useState("");
  const [tab, setTab] = React.useState<"order" | "credit" | "history">("order");
  const [lines, setLines] = React.useState<EditLine[]>([]);
  const [errs, setErrs] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [sub, setSub] = React.useState<"sendBack" | "hold" | "decline" | null>(null);
  const seq = React.useRef(0);

  React.useEffect(() => {
    let live = true;
    void loadToReviewAction(id).then((res) => {
      if (!live) return;
      if (!res.ok) return setLoadError(res.error);
      setData(res.data);
      setLines(res.data.review.lines.map((l) => ({ key: `l${seq.current++}`, skuId: l.skuId, qtyCans: l.qtyCans, ratePaise: l.ratePaise, discountPct: l.discountBp == null ? null : l.discountBp / 100 })));
    });
    return () => {
      live = false;
    };
  }, [id]);

  const r = data?.review.row;
  const open = r?.status === "open";
  const total = lines.reduce((n, l) => n + (lineAmount(l) ?? 0), 0);
  const edited = linesEdited(lines, data?.review.lines ?? []);
  const asSent = () => lines.map((l) => ({ skuId: l.skuId, qtyCans: l.qtyCans!, ratePaise: l.ratePaise, discountBp: discountBpOf(l) }));

  /* Saving is not deciding: the TO stays here, and a line may still lack its rate. */
  async function save() {
    const e = lineErrors(lines, { rateRequired: false });
    setErrs(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const res = await run(saveToLinesAction(id, asSent()));
      if (res.ok) onDone();
      else if (res.fieldErrors?.length) setErrs(Object.fromEntries(res.fieldErrors.map((f) => [f.field, f.message])));
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    const e = lineErrors(lines, { rateRequired: true });
    setErrs(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const res = await run(approveToAction(id, edited ? asSent() : null));
      if (res.ok) onDone();
      else if (res.fieldErrors?.length) setErrs(Object.fromEntries(res.fieldErrors.map((f) => [f.field, f.message])));
    } finally {
      setBusy(false);
    }
  }

  const credit = r
    ? [
        ["Credit limit", r.creditLimitPaise == null ? "Not set" : money(r.creditLimitPaise)],
        ["Outstanding", money(r.outstandingPaise)],
        ["After this order", money(r.outstandingPaise + total), r.overCreditLimit || (r.creditLimitPaise != null && r.outstandingPaise + total > r.creditLimitPaise)],
        ["Overdue", r.overdueBills ? `${money(r.overduePaise)} · ${plural(r.overdueBills, "bill")}` : "None"],
        ["Credit days", data?.review.customer.creditDays == null ? "Not set" : String(data.review.customer.creditDays)],
        ["Customer status", r.pendingCustomer ? "Pending" : (data?.review.customer.status ?? "active").replace(/^./, (c) => c.toUpperCase())],
      ]
    : [];

  return (
    <Modal
      open
      onClose={onClose}
      width={1040}
      title={
        r ? (
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-[20px]">
                TO-{r.toNo} · {r.billingName}
              </div>
              <div className="mt-1 text-[13.5px] font-normal text-muted">
                Taken by {r.takenBy.replace(" · ", " on ")} · {stamp(new Date(r.createdAt))} · waiting {waiting(r.waitingMinutes)}
                {r.pastDeadline ? <span className="font-semibold text-danger"> (past the deadline)</span> : null}
              </div>
            </div>
            <Flags r={r} />
          </div>
        ) : (
          "Loading"
        )
      }
      footer={
        r ? (
          <div className="flex w-full flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 text-[12.5px] text-muted">
              {open ? 'Approve makes the order number · the customer gets "Confirmed" · the Production Head gets it in MRP check' : r.status === "correction" ? "Sent back - waiting for whoever took it to correct it." : "On hold with Accounts."}
            </span>
            <Button className="text-danger" disabled={!canDecide || busy} onClick={() => setSub("decline")}>
              Decline
            </Button>
            <Button disabled={!canDecide || busy || !open} onClick={() => setSub("hold")}>
              Hold
            </Button>
            <Button disabled={!canDecide || busy || !open} onClick={() => setSub("sendBack")}>
              Send back
            </Button>
            <Button disabled={!canDecide || busy || !open || !edited} title={!canDecide ? "Only an Accounts manager edits an order" : !edited ? "Change a line first" : "Keep the changes without approving it yet"} onClick={() => void save()}>
              Save changes
            </Button>
            <Button variant="primary" disabled={!canDecide || busy || !open} title={canDecide ? undefined : "Only an Accounts manager approves an order"} onClick={() => void approve()}>
              Approve
            </Button>
          </div>
        ) : null
      }
    >
      {loadError ? <p className="text-danger">{loadError}</p> : null}
      {!data || !r ? (
        !loadError ? <p className="text-muted">Loading the order…</p> : null
      ) : (
        <>
          <div role="tablist" className="-mx-5 -mt-4 mb-4 flex border-b border-divider px-3">
            {(
              [
                ["order", "The order"],
                ["credit", "Customer & credit"],
                ["history", "History"],
              ] as const
            ).map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={cx("-mb-px cursor-pointer border-b-2 px-3.5 py-2.5 text-sm", tab === k ? "border-brand font-semibold text-brand-deep" : "border-transparent text-muted")}>
                {label}
              </button>
            ))}
          </div>

          {tab === "order" ? (
            <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-5">
              <div className="flex min-w-0 flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[12.5px] text-muted">Accounts can change the lines before approving. Changes apply to this order only.</span>
                  {open ? <span className="rounded-full bg-brand-soft px-2.5 py-0.5 text-[12px] font-semibold text-brand-deep">Editable</span> : null}
                </div>
                <div className="grid grid-cols-3 gap-2.5 text-[13px]">
                  <div>
                    <div className="text-[12px] text-muted">Billing party</div>
                    <strong>{r.billingName}</strong>
                  </div>
                  <div>
                    <div className="text-[12px] text-muted">Delivery party</div>
                    <strong>{r.deliveryName}</strong>
                  </div>
                  <div>
                    <div className="text-[12px] text-muted">Godown</div>
                    <strong>{data.review.godown ?? "Not picked"}</strong>
                  </div>
                </div>
                <OrderLinesEditor lines={lines} setLines={setLines} products={data.products} errs={errs} editable={open} />
                {data.review.remark ? <p className="text-[12.5px] text-muted">Remark: {data.review.remark}</p> : null}
                {r.duplicate ? (
                  <p className="text-[12.5px] text-warn-ink">
                    {r.duplicate.state === "possible"
                      ? `Possible duplicate of TO-${r.duplicate.toNo}: same parties and items, punched the same day.`
                      : `Marked a different order from TO-${r.duplicate.toNo}: ${r.duplicate.reason ?? ""}`}
                  </p>
                ) : null}
              </div>
              <div className="h-fit rounded-card border border-divider bg-page px-3.5 py-3">
                <div className="mb-1.5 text-[12px] font-semibold tracking-[0.05em] text-muted">CUSTOMER &amp; CREDIT</div>
                {credit.map(([k, v, bad], i) => (
                  <div key={String(k)} className={cx("flex justify-between gap-3 py-[7px] text-[13px]", i < credit.length - 1 ? "border-b border-divider" : "")}>
                    <span className="text-muted">{k}</span>
                    <span className={bad ? "font-semibold text-danger" : ""}>{v}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {tab === "credit" ? (
            <div className="grid grid-cols-2 gap-5">
              <div>
                {credit.map(([k, v, bad]) => (
                  <div key={String(k)} className="flex justify-between gap-3 border-b border-divider py-2 text-[13.5px]">
                    <span className="text-muted">{k}</span>
                    <span className={bad ? "font-semibold text-danger" : ""}>{v}</span>
                  </div>
                ))}
                {data.review.customer.slowPayer ? <p className="mt-2 text-[12.5px] text-warn-ink">Marked a slow payer.</p> : null}
              </div>
              <div>
                <div className="mb-1.5 text-[12px] font-semibold tracking-[0.05em] text-muted">OVERDUE BILLS</div>
                {data.review.customer.overdueList.length ? (
                  data.review.customer.overdueList.map((b) => (
                    <div key={b.billNo} className="flex justify-between gap-3 border-b border-divider py-2 text-[13px]">
                      <span>{b.billNo}</span>
                      <span className="text-muted">due {b.dueDate}</span>
                      <span className="font-medium tabular-nums">{money(b.balancePaise)}</span>
                    </div>
                  ))
                ) : (
                  <p className="text-[13px] text-muted">Nothing overdue.</p>
                )}
              </div>
            </div>
          ) : null}

          {tab === "history" ? (
            <ol className="flex flex-col gap-2">
              {data.review.history.map((h, i) => (
                <li key={i} className="flex gap-3 text-[13.5px]">
                  <span className="w-[150px] flex-none text-muted">{stamp(new Date(h.at))}</span>
                  <span className={h.tone === "warn" ? "text-warn-ink" : "text-body"}>{h.text}</span>
                </li>
              ))}
            </ol>
          ) : null}
        </>
      )}
      {sub && r ? <DecisionDialog kind={sub} row={r} onClose={() => setSub(null)} onDone={onDone} /> : null}
    </Modal>
  );
}

/* --------------------------------------------------- send back · hold · decline */

function DecisionDialog({ kind, row, onClose, onDone }: { kind: "sendBack" | "hold" | "decline"; row: AccountsToRow; onClose: () => void; onDone: () => void }) {
  const { run } = useToast();
  const [text, setText] = React.useState("");
  const [reason, setReason] = React.useState<string>(ACCOUNTS_HOLD_REASONS[0].code);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const taker = row.takenBy.split(" · ")[0];
  const copy = {
    sendBack: { title: `Send TO-${row.toNo} back`, sub: "It goes back to whoever took it, to correct and send again.", label: "What needs correcting", submit: "Send back", tell: `${taker} is told, with your reason. They correct it and it comes back here.` },
    hold: { title: `Hold TO-${row.toNo}`, sub: "It moves to the held TOs below. Releasing it brings it back to Order approvals.", label: "Remarks", submit: "Put on hold", tell: `${taker} is told the order is on hold.` },
    decline: { title: `Decline TO-${row.toNo}`, sub: "No order number is made.", label: "Why", submit: "Decline", tell: `${taker} is told the reason, so they can ring the customer. It is also written on the customer's timeline.` },
  }[kind];

  async function submit() {
    if (kind !== "hold" && !text.trim()) return setError(kind === "decline" ? "Say why it is declined" : "Say what needs correcting");
    setBusy(true);
    try {
      const res = await run(kind === "sendBack" ? sendBackToAction(row.id, text) : kind === "hold" ? holdToAction(row.id, reason, text) : declineToAction(row.id, text));
      if (res.ok) onDone();
      else setError(res.fieldErrors?.[0]?.message ?? res.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={460}
      title={
        <div>
          <div className="text-[17px]">{copy.title}</div>
          <div className="mt-1 text-[13px] font-normal text-muted">{copy.sub}</div>
        </div>
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={kind === "decline" ? "danger" : "primary"} disabled={busy} onClick={() => void submit()}>
            {copy.submit}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        {kind === "hold" ? (
          <>
            <label htmlFor="to-hold-reason" className="text-[12px] font-medium text-muted">
              Reason <span className="text-danger">*</span>
            </label>
            <select id="to-hold-reason" value={reason} onChange={(e) => setReason(e.target.value)} className={controlClass({ className: "h-9 text-sm" })}>
              {ACCOUNTS_HOLD_REASONS.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.label}
                </option>
              ))}
            </select>
          </>
        ) : null}
        <label htmlFor={`to-${kind}-text`} className="text-[12px] font-medium text-muted">
          {copy.label} {kind !== "hold" ? <span className="text-danger">*</span> : null}
        </label>
        <textarea id={`to-${kind}-text`} rows={4} value={text} onChange={(e) => { setText(e.target.value); setError(""); }} className={controlClass({ invalid: !!error, className: "min-h-[84px] py-2 text-sm" })} />
        {error ? <p className="text-[12.5px] text-danger">{error}</p> : null}
        <div className="rounded-[7px] bg-ai-soft px-2.5 py-2 text-[12.5px] text-ai">{copy.tell}</div>
      </div>
    </Modal>
  );
}

function ReleaseDialog({ row, onClose, onDone }: { row: AccountsToRow; onClose: () => void; onDone: () => void }) {
  const { run } = useToast();
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  return (
    <Modal
      open
      onClose={onClose}
      width={440}
      title={`Release TO-${row.toNo}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const res = await run(releaseToAction(row.id, note));
                if (res.ok) onDone();
              } finally {
                setBusy(false);
              }
            }}
          >
            Back to Order approvals
          </Button>
        </>
      }
    >
      <label htmlFor="to-release-note" className="mb-1.5 block text-[12px] font-medium text-muted">
        What changed
      </label>
      <textarea id="to-release-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} className={controlClass({ className: "w-full py-2 text-sm" })} placeholder="Overdue cleared on the 20th." />
    </Modal>
  );
}
