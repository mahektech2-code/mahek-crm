"use client";

import * as React from "react";
import { Drawer, DrawerHeader, Modal } from "@/components/ui/overlays";
import { Button, Field, Input, MoneyInput, Select, Textarea, cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import {
  addPayoutInvoiceAction,
  cancelPayoutAction,
  holdPayoutAction,
  markPayoutPaidAction,
  releasePayoutAction,
  removePayoutInvoiceAction,
  reopenPayoutAction,
  reschedulePayoutAction,
  updatePayoutNotesAction,
} from "@/lib/actions/vendor-payouts";
import { addDays, daysFrom, moveRefusal, paymentDayOnOrAfter, WEEKDAY_SHORT, weekdayOf } from "@/lib/engines/vendor-payouts";
import { longDate, money, parseRupees, rupeesFromPaise, shortDate } from "@/lib/format";
import type { PayoutView } from "@/lib/services/vendor-payout-service";
import { blankInvoice, draftToInput, InvoiceFields, sourceWords, StatusPill, toneOf, type InvoiceDraft } from "./payout-parts";

/* ---------------------------------------------------------------------------
 * One payout, opened: what it is for, its PO, every invoice on it, the day it
 * is planned for, and the decisions — hold, pay, cancel, reopen.
 * ------------------------------------------------------------------------- */

export function PayoutDrawer({
  payout,
  today,
  days,
  modes,
  canEdit,
  canSettle,
  onClose,
  onMoved,
  onChanged,
}: {
  payout: PayoutView | null;
  today: string;
  days: Set<number>;
  modes: string[];
  canEdit: boolean;
  canSettle: boolean;
  onClose: () => void;
  /** The calendar moves the card at once rather than waiting for the refresh. */
  onMoved: (id: string, payOn: string) => void;
  onChanged: () => void;
}) {
  return (
    <Drawer open={!!payout} onClose={onClose} width={600} label="Vendor payout">
      {payout ? (
        <PayoutBody
          key={payout.id}
          p={payout}
          today={today}
          days={days}
          modes={modes}
          canEdit={canEdit}
          canSettle={canSettle}
          onClose={onClose}
          onMoved={onMoved}
          onChanged={onChanged}
        />
      ) : null}
    </Drawer>
  );
}

function PayoutBody({
  p,
  today,
  days,
  modes,
  canEdit,
  canSettle,
  onClose,
  onMoved,
  onChanged,
}: {
  p: PayoutView;
  today: string;
  days: Set<number>;
  modes: string[];
  canEdit: boolean;
  canSettle: boolean;
  onClose: () => void;
  onMoved: (id: string, payOn: string) => void;
  onChanged: () => void;
}) {
  const { run } = useToast();
  const tone = toneOf(p, today);
  const live = p.status === "open" || p.status === "on_hold";
  const [busy, setBusy] = React.useState(false);
  const [dialog, setDialog] = React.useState<null | "paid" | "hold" | "cancel" | "reopen">(null);
  const [notes, setNotes] = React.useState(p.notes ?? "");
  const [adding, setAdding] = React.useState<InvoiceDraft | null>(null);
  const [moveTo, setMoveTo] = React.useState(p.payOn);

  async function act<T extends { ok: boolean }>(work: Promise<T>): Promise<T> {
    setBusy(true);
    try {
      const res = await run(work);
      if (res.ok) onChanged();
      return res;
    } finally {
      setBusy(false);
    }
  }

  async function move(date: string) {
    const res = await act(reschedulePayoutAction(p.id, date));
    if (res.ok) onMoved(p.id, date);
  }

  // The next payment days, offered as one-press choices.
  const nextDays: string[] = [];
  let d = paymentDayOnOrAfter(today, days);
  while (nextDays.length < 6 && days.size) {
    nextDays.push(d);
    d = paymentDayOnOrAfter(addDays(d, 1), days);
  }
  const moveWhy = moveTo ? moveRefusal(moveTo, today, days, p.status) : "Pick a day.";
  const invoiceTotal = p.invoices.reduce((a, i) => a + (i.amountPaise ?? 0), 0);

  return (
    <>
      <DrawerHeader onClose={onClose}>
        <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
          {p.source === "purchase" ? "Purchase payable" : "Manual payable"}
        </div>
        <div className="mt-0.5 truncate text-lg font-semibold text-ink">{p.payeeName}</div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span className="text-[22px] leading-7 font-semibold text-ink tabular-nums">{money(p.amountPaise)}</span>
          <StatusPill tone={tone} />
          {p.payOnDecided ? <span className="text-[12px] text-muted">rescheduled</span> : null}
        </div>
      </DrawerHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {p.status === "on_hold" && p.holdReason ? (
          <div className="mb-4 rounded-[4px] border border-l-[3px] border-warn-line border-l-warn bg-warn-soft px-3 py-2 text-[13px] text-warn-ink">
            <b>On hold:</b> {p.holdReason}
          </div>
        ) : null}
        {p.status === "cancelled" ? (
          <div className="mb-4 rounded-[4px] border border-l-[3px] border-line border-l-line-strong bg-canvas px-3 py-2 text-[13px] text-muted">
            <b>Cancelled:</b> {p.cancelReason ?? "no reason recorded"}
          </div>
        ) : null}
        {p.status === "paid" ? (
          <div className="mb-4 rounded-[4px] border border-l-[3px] border-success-soft border-l-success bg-success-soft px-3 py-2 text-[13px] text-success">
            <b>Paid {money(p.paidAmountPaise)}</b> on {longDate(p.paidOn)} by {p.paymentMode}
            {p.paymentReference ? ` · ref ${p.paymentReference}` : ""}
            {p.paidByName ? ` · marked by ${p.paidByName}` : ""}
            {p.paidAmountPaise != null && p.paidAmountPaise !== p.amountPaise ? (
              <div className="mt-0.5 text-warn-ink">
                Payable {money(p.amountPaise)} · difference {money(Math.abs(p.amountPaise - p.paidAmountPaise))}
              </div>
            ) : null}
          </div>
        ) : null}

        <dl className="grid grid-cols-2 gap-x-5 gap-y-3 text-sm">
          <Fact label="Description">{sourceWords(p)}</Fact>
          <Fact label="Invoice / ref.">{p.reference ?? <Muted>—</Muted>}</Fact>
          <Fact label="Purchase order">
            {p.poNumber != null ? (
              <span>
                <span className="font-medium text-ink">PO {p.poNumber}</span>
                <span className="text-muted">
                  {" "}
                  · {p.poStatus} · {shortDate(p.poDate)}
                </span>
              </span>
            ) : (
              <Muted>—</Muted>
            )}
          </Fact>
          <Fact label={p.source === "purchase" ? "Purchase date" : "Invoice date"}>
            {p.purchaseDate ? longDate(p.purchaseDate) : <Muted>—</Muted>}
          </Fact>
          <Fact label="Due date">
            {longDate(p.dueDate)}
            {p.source === "purchase" ? (
              <span className="text-muted"> · {p.creditDays != null ? `${p.creditDays}-day terms` : "default terms"}</span>
            ) : null}
          </Fact>
          <Fact label="Payment date">
            <span className={cx(tone === "overdue" && "font-medium text-danger")}>
              {WEEKDAY_SHORT[weekdayOf(p.payOn) - 1]} {longDate(p.payOn)}
            </span>
            {p.payOn > p.dueDate ? (
              <span className="text-warn-ink"> · {daysFrom(p.dueDate, p.payOn)}d after due</span>
            ) : null}
          </Fact>
          {p.source === "purchase" && p.registerStatuses.length ? (
            <Fact label="Register status">{p.registerStatuses.join(", ")}</Fact>
          ) : null}
        </dl>

        {live && canEdit ? (
          <section className="mt-5">
            <SectionTitle>Reschedule</SectionTitle>
            <div className="flex flex-wrap gap-1.5">
              {nextDays.map((day) => (
                <button
                  key={day}
                  type="button"
                  disabled={busy || day === p.payOn}
                  onClick={() => void move(day)}
                  className={cx(
                    "h-8 cursor-pointer rounded-[4px] border px-2.5 text-[12px] font-medium disabled:cursor-default",
                    day === p.payOn ? "border-brand bg-brand-soft text-[#5223E0]" : "border-line bg-surface text-body hover:bg-canvas",
                  )}
                >
                  {WEEKDAY_SHORT[weekdayOf(day) - 1]} {shortDate(day)}
                </button>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <Input type="date" value={moveTo} min={today} onChange={(e) => setMoveTo(e.target.value)} className="w-[170px]" />
              <Button size="sm" disabled={busy || !!moveWhy || moveTo === p.payOn} onClick={() => void move(moveTo)}>
                Move
              </Button>
              {moveTo && moveTo !== p.payOn && moveWhy ? <span className="text-[12px] text-danger">{moveWhy}</span> : null}
            </div>
          </section>
        ) : null}

        <section className="mt-5">
          <div className="mb-2 flex items-center justify-between">
            <SectionTitle>
              Invoices <span className="font-normal normal-case text-muted">({p.invoices.length})</span>
            </SectionTitle>
            {canEdit && !adding ? (
              <Button size="sm" onClick={() => setAdding(blankInvoice(1, p.invoices.length ? "Tax invoice" : "Proforma invoice"))}>
                + Add invoice
              </Button>
            ) : null}
          </div>
          {p.invoices.length === 0 && !adding ? (
            <p className="rounded-[4px] border border-dashed border-line px-3 py-3 text-[13px] text-muted">
              No invoices attached
            </p>
          ) : null}
          <ul className="space-y-1.5">
            {p.invoices.map((inv) => (
              <li key={inv.id} className="flex items-center gap-3 rounded-[4px] border border-line bg-surface px-3 py-2">
                <FileGlyph pdf={!inv.isImage} muted={!inv.attachmentId} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="rounded-[3px] bg-brand-soft px-1.5 text-[11px] font-medium text-[#5223E0]">{inv.kind}</span>
                    <span className="truncate text-[13px] font-medium text-ink">{inv.invoiceNo ?? "no number"}</span>
                  </div>
                  <div className="truncate text-[12px] text-muted">
                    {[inv.invoiceDate ? shortDate(inv.invoiceDate) : null, inv.amountPaise != null ? money(inv.amountPaise) : null, inv.createdByName]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </div>
                {inv.attachmentId ? (
                  <a
                    href={`/api/attachments/${inv.attachmentId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[13px] font-medium text-brand hover:underline"
                    title={inv.filename ?? undefined}
                  >
                    Open
                  </a>
                ) : (
                  <span className="text-[12px] text-muted">no file</span>
                )}
                {canEdit ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void act(removePayoutInvoiceAction(inv.id))}
                    className="cursor-pointer text-[12px] text-muted hover:text-danger"
                  >
                    Remove
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {invoiceTotal > 0 && invoiceTotal !== p.amountPaise ? (
            <p className="mt-1.5 text-[12px] text-muted">
              Invoices total {money(invoiceTotal)} vs. payable {money(p.amountPaise)}
            </p>
          ) : null}
          {adding ? (
            <div className="mt-2">
              <InvoiceFields draft={adding} onChange={(next) => setAdding((cur) => (cur ? { ...cur, ...next } : cur))} />
              <div className="mt-2 flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setAdding(null)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy || adding.file?.uploading || !adding.kind.trim()}
                  onClick={async () => {
                    const res = await act(addPayoutInvoiceAction(p.id, draftToInput(adding)));
                    if (res.ok) setAdding(null);
                  }}
                >
                  Save invoice
                </Button>
              </div>
            </div>
          ) : null}
        </section>

        <section className="mt-5">
          <SectionTitle>Note</SectionTitle>
          <Textarea
            rows={2}
            value={notes}
            disabled={!canEdit}
            placeholder="Add a note"
            onChange={(e) => setNotes(e.target.value)}
          />
          {canEdit && notes !== (p.notes ?? "") ? (
            <div className="mt-1.5 flex justify-end">
              <Button size="sm" disabled={busy} onClick={() => void act(updatePayoutNotesAction(p.id, notes))}>
                Save note
              </Button>
            </div>
          ) : null}
        </section>
      </div>

      <div className="flex flex-none flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">
        {p.source === "manual" && live && canSettle ? (
          <Button variant="ghost" disabled={busy} onClick={() => setDialog("cancel")}>
            Cancel payable
          </Button>
        ) : null}
        {p.status === "open" && canEdit ? (
          <Button disabled={busy} onClick={() => setDialog("hold")}>
            Hold
          </Button>
        ) : null}
        {p.status === "on_hold" && canEdit ? (
          <Button disabled={busy} onClick={() => void act(releasePayoutAction(p.id))}>
            Release hold
          </Button>
        ) : null}
        {p.status === "paid" && canSettle ? (
          <Button disabled={busy} onClick={() => setDialog("reopen")}>
            Undo paid
          </Button>
        ) : null}
        {live ? (
          <Button
            variant="primary"
            disabled={busy || !canSettle}
            title={canSettle ? undefined : "Requires Accounts manager"}
            onClick={() => setDialog("paid")}
          >
            Mark paid
          </Button>
        ) : null}
      </div>

      {dialog === "paid" ? (
        <PaidDialog
          p={p}
          today={today}
          modes={modes}
          onClose={() => setDialog(null)}
          onSubmit={(input) => act(markPayoutPaidAction(p.id, input))}
        />
      ) : null}
      {dialog === "hold" || dialog === "cancel" || dialog === "reopen" ? (
        <ReasonDialog
          title={dialog === "hold" ? `Hold the payout to ${p.payeeName}` : dialog === "cancel" ? "Cancel this payout" : "Undo paid"}
          prompt={
            dialog === "hold"
              ? "Why is it held? Whoever picks it up next will ask."
              : dialog === "cancel"
                ? "Why is this not owed after all?"
                : "Why is it being reopened — returned by the bank, marked on the wrong payout?"
          }
          confirm={dialog === "hold" ? "Hold" : dialog === "cancel" ? "Cancel payable" : "Reopen"}
          destructive={dialog === "cancel"}
          onClose={() => setDialog(null)}
          onSubmit={(reason) =>
            act(
              dialog === "hold"
                ? holdPayoutAction(p.id, reason)
                : dialog === "cancel"
                  ? cancelPayoutAction(p.id, reason)
                  : reopenPayoutAction(p.id, reason),
            )
          }
        />
      ) : null}
    </>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">{label}</dt>
      <dd className="mt-0.5 text-body">{children}</dd>
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-muted">{children}</span>;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="mb-2 text-xs font-medium tracking-[0.04em] text-muted uppercase">{children}</div>;
}

function FileGlyph({ pdf, muted }: { pdf: boolean; muted: boolean }) {
  return (
    <span
      className={cx(
        "flex h-8 w-7 flex-none items-center justify-center rounded-[3px] text-[9px] font-bold",
        muted ? "bg-canvas text-muted" : pdf ? "bg-danger-soft text-danger" : "bg-brand-soft text-[#5223E0]",
      )}
    >
      {muted ? "—" : pdf ? "PDF" : "IMG"}
    </span>
  );
}

function PaidDialog({
  p,
  today,
  modes,
  onClose,
  onSubmit,
}: {
  p: PayoutView;
  today: string;
  modes: string[];
  onClose: () => void;
  onSubmit: (input: { paidOn: string; amountPaise: number; mode: string; reference: string | null }) => Promise<{ ok: boolean }>;
}) {
  const payModes = modes.filter((m) => m !== "Credit note");
  const [paidOn, setPaidOn] = React.useState(p.payOn <= today ? p.payOn : today);
  const [amount, setAmount] = React.useState(rupeesFromPaise(p.amountPaise));
  const [mode, setMode] = React.useState(payModes[0] ?? "Bank transfer");
  const [reference, setReference] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const paise = parseRupees(amount);

  return (
    <Modal
      open
      onClose={onClose}
      title={`Mark ${p.payeeName} paid`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={busy || !paise || !paidOn}
            onClick={async () => {
              setBusy(true);
              const res = await onSubmit({ paidOn, amountPaise: paise ?? 0, mode, reference: reference.trim() || null });
              setBusy(false);
              if (res.ok) onClose();
            }}
          >
            Mark paid
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Paid on">
          <Input type="date" value={paidOn} max={today} onChange={(e) => setPaidOn(e.target.value)} />
        </Field>
        <Field label="Amount paid" hint={paise != null && paise !== p.amountPaise ? `The payout is ${money(p.amountPaise)}` : undefined}>
          <MoneyInput value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="How">
          <Select value={mode} onChange={(e) => setMode(e.target.value)}>
            {payModes.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </Select>
        </Field>
        <Field label="UTR / cheque no.">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="optional" />
        </Field>
      </div>
    </Modal>
  );
}

function ReasonDialog({
  title,
  prompt,
  confirm,
  destructive,
  onClose,
  onSubmit,
}: {
  title: string;
  prompt: string;
  confirm: string;
  destructive?: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<{ ok: boolean }>;
}) {
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose}>Back</Button>
          <Button
            variant={destructive ? "danger" : "primary"}
            disabled={busy || !reason.trim()}
            onClick={async () => {
              setBusy(true);
              const res = await onSubmit(reason.trim());
              setBusy(false);
              if (res.ok) onClose();
            }}
          >
            {confirm}
          </Button>
        </>
      }
    >
      <Field label="Reason" hint={prompt}>
        <Textarea autoFocus rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Modal>
  );
}
