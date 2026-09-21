"use client";

/* ---------------------------------------------------------------------------
 * DECIDING A SPECIAL PRICE — approve it, refuse it, and say what that does.
 *
 * Approving is not a note on a request: it writes a price list of this shop's
 * own, scoped to them by name, carrying the one rate that was asked for. That
 * is a real consequence and the person pressing the button has to be able to
 * read it BEFORE they press it — so the sentence is on the screen in words,
 * naming the shop and naming the list everything else they buy goes on
 * falling through to. A decision whose effect somebody discovers afterwards
 * is a decision they stop making.
 *
 * Refusing needs no date and asks for none. It still takes a note, because
 * "no" with no reason is a request the salesman raises again next week.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button, Callout, Field, Radio, Textarea } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { money, pct } from "@/lib/format";
import { decidePriceRequest } from "@/lib/actions/price-lists";
import type { RequestView } from "@/lib/price-list-views";

export function DecideRequestModal({
  open,
  onClose,
  request,
  todayIso,
}: {
  open: boolean;
  onClose: () => void;
  request: RequestView;
  todayIso: string;
}) {
  if (!open) return null;
  // Keyed on the request, so the form is fresh for each one rather than
  // reset in an effect — see the modal pattern.
  return <Body key={request.id} onClose={onClose} request={request} todayIso={todayIso} />;
}

function Body({
  onClose,
  request,
  todayIso,
}: {
  onClose: () => void;
  request: RequestView;
  todayIso: string;
}) {
  const router = useRouter();
  const { run } = useToast();
  const [decision, setDecision] = React.useState<"approved" | "refused">("approved");
  const [note, setNote] = React.useState("");
  const [effectiveFrom, setEffectiveFrom] = React.useState(todayIso);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);

  const current = request.currentRateExGstPaise;
  const delta =
    current && current > 0
      ? Math.round(((request.requestedRateExGstPaise - current) / current) * 1000) / 10
      : null;

  async function save() {
    setErrors({});
    if (decision === "refused" && !note.trim()) {
      setErrors({ note: "Say why. A refusal with no reason comes back next week." });
      return;
    }
    setBusy(true);
    try {
      const r = await run(
        decidePriceRequest(request.id, {
          decision,
          note: note.trim() || undefined,
          effectiveFrom: decision === "approved" ? effectiveFrom : undefined,
        }),
      );
      if (r.ok) {
        onClose();
        router.refresh();
      } else if (r.fieldErrors) {
        setErrors(Object.fromEntries(r.fieldErrors.map((f) => [f.field, f.message])));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`${request.customerName} — ${request.productName}`}
      width={560}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : decision === "approved" ? "Approve" : "Refuse"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-[4px] border border-line bg-canvas px-4 py-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted">They pay today</span>
            <span className="tabular-nums text-ink">
              {current == null ? "no list rate" : `${money(current)} ex-GST`}
            </span>
          </div>
          <div className="mt-1 flex items-center justify-between gap-3">
            <span className="text-muted">They are asking for</span>
            <span className="tabular-nums text-ink">
              {money(request.requestedRateExGstPaise)} ex-GST
              {delta == null ? null : (
                <span className={delta < 0 ? " text-danger" : " text-success"}>
                  {" "}
                  {delta > 0 ? "+" : ""}
                  {delta}%
                </span>
              )}
            </span>
          </div>
          <p className="mt-2 text-[13px] text-muted">
            {request.requestedByName} asked: {request.reason}
          </p>
        </div>

        <div className="flex gap-5">
          <Radio
            name="decision"
            label="Approve"
            checked={decision === "approved"}
            onChange={() => setDecision("approved")}
          />
          <Radio
            name="decision"
            label="Refuse"
            checked={decision === "refused"}
            onChange={() => setDecision("refused")}
          />
        </div>

        {decision === "approved" ? (
          <>
            <Callout tone="brand">
              <span className="text-[13px] text-body">
                Approving creates or extends a list of agreed prices for{" "}
                <strong>{request.customerName}</strong> with this one rate — everything else
                they buy stays on{" "}
                <strong>{request.currentListName ?? "whichever list their area is on"}</strong>.
              </span>
            </Callout>
            <Field
              label="In force from"
              hint="The day this rate starts applying. Orders taken before it keep the old price."
              error={errors.effectiveFrom ?? null}
            >
              <input
                type="date"
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
                className="h-8.5 rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand"
              />
            </Field>
          </>
        ) : null}

        <Field
          label="Note"
          hint={
            decision === "approved"
              ? "What was agreed, and with whom. Optional, and worth writing."
              : "Why not. The person who asked reads this."
          }
          error={errors.note ?? null}
        >
          <Textarea
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            invalid={!!errors.note}
          />
        </Field>

        {request.currentListName ? (
          <p className="text-[13px] text-muted">
            Priced today from {request.currentListName}
            {current && current > 0
              ? ` · the ask is ${pct(Math.abs(request.requestedRateExGstPaise - current), current)}% ${
                  request.requestedRateExGstPaise < current ? "below" : "above"
                } it`
              : ""}
            .
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
