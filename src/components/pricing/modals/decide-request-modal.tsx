"use client";

/* ---------------------------------------------------------------------------
 * DECIDING A SPECIAL PRICE — approve it, counter it, refuse it, and say what
 * that does.
 *
 * Approving is not a note on a request: it writes a dated special price (an
 * override) for this shop, which its own agreed-prices list carries from the
 * day it starts until the day it ends — everything else they buy goes on
 * falling through to their book. That is a real consequence and the person
 * pressing the button has to be able to read it BEFORE they press it, so the
 * sentence is on the screen in words, beside the facts it is weighed on: what
 * the shop actually buys, how it pays, what the shops around it pay, and what
 * the discount gives away over the period.
 *
 * Both models may be asked for advice, separately; their answers sit side by
 * side and a disagreement is shown rather than averaged. Advice only — the
 * buttons below are the only thing that decides.
 *
 * Refusing needs no date and asks for none. It still takes a note, because
 * "no" with no reason is a request the salesman raises again next week.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button, Callout, Field, Input, MoneyInput, Radio, Textarea } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { money, parseRupees, pct } from "@/lib/format";
import { exFromIncl } from "@/lib/engines/price-math";
import { decidePriceRequest } from "@/lib/actions/price-lists";
import { requestAdviceAction, requestContextAction } from "@/lib/actions/price-overrides";
import type { RequestView } from "@/lib/price-list-views";
import type { RequestAdvice, RequestContext } from "@/components/pricing/overrides/types";
import { AdvicePanel, FactsPanel, monthsBetween } from "@/components/pricing/overrides/facts-panel";

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

const dateClass =
  "h-8.5 rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand";

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
  const { run, push } = useToast();
  const [decision, setDecision] = React.useState<"approved" | "counter" | "refused">("approved");
  const [note, setNote] = React.useState("");
  const [effectiveFrom, setEffectiveFrom] = React.useState(todayIso);
  const [validTo, setValidTo] = React.useState("");
  const [minCans, setMinCans] = React.useState("");
  const [counter, setCounter] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [context, setContext] = React.useState<RequestContext | null | "failed">(null);
  const [advice, setAdvice] = React.useState<RequestAdvice[] | null>(null);
  const [asking, setAsking] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    (async () => {
      const r = await requestContextAction(request.id);
      if (live) setContext(r.ok ? r.data : "failed");
    })();
    return () => {
      live = false;
    };
  }, [request.id]);

  const facts = context && context !== "failed" ? context.facts : null;
  const shownAdvice = advice ?? (context && context !== "failed" ? context.advice : []);
  const current = request.currentRateExGstPaise;
  const delta =
    current && current > 0
      ? Math.round(((request.requestedRateExGstPaise - current) / current) * 1000) / 10
      : null;
  const counterIncl = parseRupees(counter);
  const weighedEx =
    decision === "counter" && counterIncl && counterIncl > 0
      ? exFromIncl(counterIncl, facts?.gstBp ?? 1800)
      : request.requestedRateExGstPaise;
  const months = validTo && validTo >= effectiveFrom ? monthsBetween(effectiveFrom, validTo) : 3;

  async function askAdvice() {
    setAsking(true);
    try {
      const r = await run(requestAdviceAction(request.id));
      if (r.ok) setAdvice(r.data);
    } finally {
      setAsking(false);
    }
  }

  async function save() {
    setErrors({});
    if (decision === "refused" && !note.trim()) {
      setErrors({ note: "Say why. A refusal with no reason comes back next week." });
      return;
    }
    if (decision === "counter" && (!counterIncl || counterIncl <= 0)) {
      setErrors({ counterRateInclGstPaise: "Type the price you are offering instead." });
      return;
    }
    if (validTo && validTo < effectiveFrom) {
      setErrors({ validTo: "It cannot end before it starts." });
      return;
    }
    setBusy(true);
    try {
      const approving = decision !== "refused";
      const r = await run(
        decidePriceRequest(request.id, {
          decision: approving ? "approved" : "refused",
          note: note.trim() || undefined,
          effectiveFrom: approving ? effectiveFrom : undefined,
          validTo: approving ? validTo || null : undefined,
          minCansPerMonth: approving && minCans.trim() ? Number(minCans) : null,
          counterRateInclGstPaise: decision === "counter" ? counterIncl : null,
        }),
      );
      if (r.ok) {
        for (const w of r.warnings ?? []) push(w);
        onClose();
        router.refresh();
      } else if (r.fieldErrors) {
        setErrors(Object.fromEntries(r.fieldErrors.map((f) => [f.field, f.message])));
      }
    } finally {
      setBusy(false);
    }
  }

  const aiReady = context && context !== "failed" ? context.aiReady : null;

  return (
    <Modal
      open
      onClose={onClose}
      title={`${request.customerName} — ${request.productName}`}
      width={880}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : decision === "approved" ? "Approve" : decision === "counter" ? "Approve at my price" : "Refuse"}
          </Button>
        </>
      }
    >
      <div className="grid gap-5 md:grid-cols-[1fr_1fr]">
        <div className="space-y-3">
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

          {context === null ? (
            <p className="text-[13px] text-muted">Reading the shop&apos;s volume, payments and neighbours…</p>
          ) : context === "failed" ? (
            <p className="text-[13px] text-muted">The facts could not be read. The decision still works.</p>
          ) : facts ? (
            <FactsPanel facts={facts} askedExGstPaise={weighedEx} months={months} />
          ) : null}

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-medium tracking-label text-muted uppercase">Advice</span>
              {aiReady && (aiReady.openai || aiReady.anthropic) ? (
                <Button size="sm" variant="secondary" disabled={asking} onClick={() => void askAdvice()}>
                  {asking ? "Asking both…" : shownAdvice.length ? "Ask again" : "Ask both models"}
                </Button>
              ) : null}
            </div>
            {shownAdvice.length ? (
              <AdvicePanel advice={shownAdvice} />
            ) : (
              <p className="text-[13px] text-muted">
                {aiReady && !aiReady.openai && !aiReady.anthropic
                  ? "AI is switched off for prices, or no key is set."
                  : "Nobody has asked yet. The models only advise; you decide."}
              </p>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div className="flex gap-5">
            <Radio name="decision" label="Approve" checked={decision === "approved"} onChange={() => setDecision("approved")} />
            <Radio name="decision" label="Counter" checked={decision === "counter"} onChange={() => setDecision("counter")} />
            <Radio name="decision" label="Refuse" checked={decision === "refused"} onChange={() => setDecision("refused")} />
          </div>

          {decision !== "refused" ? (
            <>
              {decision === "counter" ? (
                <Field label="Your price" hint="GST inclusive, per can — what you will agree instead." error={errors.counterRateInclGstPaise ?? null}>
                  <MoneyInput value={counter} invalid={!!errors.counterRateInclGstPaise} onChange={(e) => setCounter(e.target.value)} placeholder="0" />
                </Field>
              ) : null}
              <Callout tone="brand">
                <span className="text-[13px] text-body">
                  {decision === "counter" ? "Approving at your price" : "Approving"} gives{" "}
                  <strong>{request.customerName}</strong> a special price on this one product
                  {validTo ? ` until ${validTo}` : " with no end date"} — everything else they buy stays on{" "}
                  <strong>{request.currentListName ?? "whichever list their area is on"}</strong>.
                </span>
              </Callout>
              <div className="flex flex-wrap gap-4">
                <Field label="From" hint="Orders before it keep the old price." error={errors.effectiveFrom ?? null}>
                  <input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} className={dateClass} />
                </Field>
                <Field label="Until" hint="Empty: until somebody ends it." error={errors.validTo ?? null}>
                  <input type="date" value={validTo} min={effectiveFrom} onChange={(e) => setValidTo(e.target.value)} className={dateClass} />
                </Field>
              </div>
              <Field label="Minimum cans a month" hint="Optional. Overrides flags a month the shop buys less.">
                <Input inputMode="numeric" value={minCans} onChange={(e) => setMinCans(e.target.value.replace(/[^0-9]/g, ""))} />
              </Field>
            </>
          ) : null}

          <Field
            label="Note"
            hint={decision === "refused" ? "Why not. The person who asked reads this." : "What was agreed, and with whom. The person who asked reads this."}
            error={errors.note ?? null}
          >
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} invalid={!!errors.note} />
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
      </div>
    </Modal>
  );
}
