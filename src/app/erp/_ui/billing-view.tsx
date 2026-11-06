"use client";

import { useEffect, useState } from "react";
import { Callout, Td, Th } from "@/components/ui/primitives";
import { erpBillingView } from "@/lib/actions/erp-tracking";
import type { BillingField, BillingSheet, BillingValue } from "@/lib/erp/billing-view";
import { DialogHeader, DialogTitle, ErpDialog } from "./dialog";
import { Icon } from "./icons";
import { labelClass, SubTitle } from "./look";
import { resultError } from "./use-act";

/* ---------------------------------------------------------------------------
 * The ticked orders as the invoice to make in Tally. Nothing here writes: every
 * value carries its own copy icon, so a field is copied in one press and pasted
 * wherever the invoice is being typed.
 * ------------------------------------------------------------------------- */

function CopyValue({ label, value, strong, end }: { label: string; value: BillingValue | null; strong?: boolean; end?: boolean }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  if (!value) return <span className="text-muted">—</span>;
  const copy = () => {
    const done = (s: "copied" | "failed") => {
      setState(s);
      setTimeout(() => setState("idle"), 1500);
    };
    /* The clipboard is absent outside https, and can be refused by the browser. */
    if (!navigator.clipboard) return done("failed");
    void navigator.clipboard.writeText(value.copy).then(
      () => done("copied"),
      () => done("failed"),
    );
  };
  const word = state === "copied" ? `Copied ${label}` : state === "failed" ? `Could not copy ${label}` : `Copy ${label}`;
  return (
    <span className={`inline-flex max-w-full items-start gap-1 ${end ? "justify-end" : ""}`}>
      <span className={`min-w-0 break-words ${strong ? "font-semibold text-ink" : "text-body"}`}>{value.show}</span>
      <button
        type="button"
        onClick={copy}
        title={word}
        aria-label={word}
        className={`-my-0.5 grid h-6 w-6 flex-none cursor-pointer place-items-center rounded-control hover:bg-canvas ${state === "copied" ? "text-success" : state === "failed" ? "text-danger" : "text-muted hover:text-brand"}`}
      >
        <Icon n={state === "copied" ? "check" : state === "failed" ? "close" : "copy"} s={13} />
      </button>
      <span className="sr-only" aria-live="polite">
        {state === "idle" ? "" : word}
      </span>
    </span>
  );
}

function Fields({ fields, owner }: { fields: BillingField[]; owner: string }) {
  return (
    <dl className="grid grid-cols-[minmax(84px,auto)_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 text-meta">
      {fields.map((f) => (
        <div key={f.l} className="contents">
          <dt className="text-muted">{f.l}</dt>
          <dd>
            <CopyValue label={`${owner} ${f.l}`.trim().toLowerCase()} value={f.v} strong={f.l === "Name"} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-card border border-line p-3">
      <div className={`mb-2 ${labelClass}`}>{title}</div>
      {children}
    </section>
  );
}

function Sheet({ sheet }: { sheet: BillingSheet }) {
  const showRate = sheet.rows.some((r) => r.rate);
  const showBoxes = sheet.rows.some((r) => r.boxes);
  const showDiscount = sheet.rows.some((r) => r.discount);
  const showAmount = sheet.rows.some((r) => r.amount);
  return (
    <article className="rounded-card border border-line bg-surface p-4">
      <SubTitle className="mb-3" aside={<span className="text-meta text-muted">{sheet.orderCount === 1 ? "1 order" : `${sheet.orderCount} orders`}</span>}>
        {sheet.title}
      </SubTitle>
      <div className="grid gap-3 md:grid-cols-3">
        <Block title="Invoice">
          <Fields fields={sheet.head} owner="" />
        </Block>
        <Block title="Buyer (bill to)">
          <Fields fields={sheet.buyer} owner="buyer" />
        </Block>
        <Block title="Consignee (ship to)">
          <div className="flex flex-col gap-3">
            {sheet.consignees.map((c) => (
              <Fields key={c.key} fields={c.fields} owner="consignee" />
            ))}
          </div>
        </Block>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-meta">
          <thead>
            <tr>
              <Th>Order</Th>
              <Th>Description of goods</Th>
              <Th align="right">Cans</Th>
              {showBoxes ? <Th align="right">Boxes</Th> : null}
              <Th align="right">Litres</Th>
              {showRate ? <Th align="right">Rate</Th> : null}
              <Th>Per</Th>
              {showDiscount ? <Th align="right">Disc.</Th> : null}
              <Th align="right">GST</Th>
              {showAmount ? <Th align="right">Amount</Th> : null}
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {sheet.rows.map((r, i) => (
              <tr key={i}>
                <Td className="whitespace-normal">
                  <CopyValue label="order no" value={r.orderNo} />
                </Td>
                <Td className="whitespace-normal">
                  <CopyValue label="description" value={r.description} strong />
                </Td>
                <Td align="right" className="whitespace-normal">
                  <CopyValue label="cans" value={r.cans} strong end />
                </Td>
                {showBoxes ? (
                  <Td align="right" className="whitespace-normal">
                    <CopyValue label="boxes" value={r.boxes} end />
                  </Td>
                ) : null}
                <Td align="right" className="whitespace-normal">
                  <CopyValue label="litres" value={r.litres} end />
                </Td>
                {showRate ? (
                  <Td align="right" className="whitespace-normal">
                    <CopyValue label="rate" value={r.rate} end />
                  </Td>
                ) : null}
                <Td className="whitespace-normal">
                  <CopyValue label="unit" value={r.per} />
                </Td>
                {showDiscount ? (
                  <Td align="right" className="whitespace-normal">
                    <CopyValue label="discount" value={r.discount} end />
                  </Td>
                ) : null}
                <Td align="right" className="whitespace-normal">
                  <CopyValue label="GST" value={r.gst} end />
                </Td>
                {showAmount ? (
                  <Td align="right" className="whitespace-normal">
                    <CopyValue label="amount" value={r.amount} end />
                  </Td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sheet.totals.length ? (
        <dl className="mt-3 ml-auto grid w-full max-w-sm grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-1 text-meta tabular-nums">
          {sheet.totals.map((t) => (
            <div key={t.l} className="contents">
              <dt className={t.l === "Invoice total" ? "font-semibold text-ink" : "text-muted"}>{t.l}</dt>
              <dd className="text-right">
                <CopyValue label={t.l.toLowerCase()} value={t.v} strong={t.l === "Invoice total"} end />
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {sheet.notes.map((n) => (
        <p key={n} className="mt-2 text-xs text-muted">
          {n}
        </p>
      ))}
    </article>
  );
}

export function BillingViewModal({ screen, lineIds, onClose }: { screen: string; lineIds: string[]; onClose: () => void }) {
  const [sheets, setSheets] = useState<BillingSheet[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void erpBillingView(screen, lineIds).then((r) => {
      if (!live) return;
      if (!r.ok) return setFailed(resultError(r));
      setSheets(r.data);
    });
    return () => {
      live = false;
    };
  }, [screen, lineIds]);

  return (
    <ErpDialog onClose={onClose} label="Billing view" width={1120}>
      <DialogHeader onClose={onClose}>
        <div className="flex flex-wrap items-center gap-2.5">
          <DialogTitle>Billing view</DialogTitle>
          {sheets ? <span className="text-meta text-muted">{sheets.length === 1 ? "1 invoice" : `${sheets.length} invoices`}</span> : null}
        </div>
      </DialogHeader>
      <div className="min-h-0 flex-1 overflow-y-auto bg-canvas/50 p-4">
        {failed ? (
          <Callout tone="danger">{failed}</Callout>
        ) : !sheets ? (
          <div className="py-16 text-center text-meta text-muted">Reading the selection…</div>
        ) : !sheets.length ? (
          <Callout tone="warn">These lines are cancelled, so there is nothing to bill.</Callout>
        ) : (
          <div className="flex flex-col gap-4">
            {sheets.map((s) => (
              <Sheet key={s.key} sheet={s} />
            ))}
          </div>
        )}
      </div>
    </ErpDialog>
  );
}
