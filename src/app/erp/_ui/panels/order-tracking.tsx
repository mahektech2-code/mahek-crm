"use client";

import { useEffect, useState } from "react";
import { Badge, Button, Callout, cx, SectionLabel, type Tone } from "@/components/ui/primitives";
import { stamp } from "@/lib/format";
import { erpOrderTrackingPanel, erpRegenerateTrackingLink, erpTrackingMessage } from "@/lib/actions/erp-tracking";
import type { TrackingPanel } from "@/lib/erp/order-tracking";
import { registerPanel, type PanelProps } from "../panels";
import { resultError, useAct } from "../use-act";
import { useErpUi } from "../erp-ui";
import { insetClass, LinkButton, linkClass } from "../look";

/* ---------------------------------------------------------------------------
 * The order record's Customer tracking tab: the link the customer has, what
 * their page says right now, the hold, and every message sent or waiting.
 * Read when the tab opens — never for every row of the list.
 * ------------------------------------------------------------------------- */

const STATUS: Record<string, { word: string; tone: Tone }> = {
  sent: { word: "Sent", tone: "success" },
  sent_by_hand: { word: "Sent by hand", tone: "success" },
  delivered: { word: "Delivered", tone: "success" },
  read: { word: "Read", tone: "success" },
  to_send: { word: "To send", tone: "warn" },
  failed: { word: "Failed", tone: "danger" },
  skipped: { word: "Not sent", tone: "muted" },
};

/** The kinds this tab may mark sent; the rest are Logistics' own and are handled there. */
const ORDER_KINDS = new Set(["confirmed", "invoice", "dispatched", "hold", "resolved"]);

function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
        } catch {
          setDone(false);
        }
      }}
    >
      {done ? "Copied" : label}
    </Button>
  );
}

function LinkRow({ label, href, hint }: { label: string; href: string; hint?: string }) {
  const full = href.startsWith("/") && typeof window !== "undefined" ? `${window.location.origin}${href}` : href;
  return (
    <div className="grid gap-1">
      <SectionLabel>{label}</SectionLabel>
      <div className="flex items-center gap-2 rounded-control border border-line bg-canvas px-2.5 py-1.5">
        <a href={full} target="_blank" rel="noreferrer" className={linkClass("brand", "min-w-0 flex-1 truncate font-mono text-xs")}>
          {full}
        </a>
        <Copy text={full} />
      </div>
      {hint ? <span className="text-meta text-muted">{hint}</span> : null}
    </div>
  );
}

function Body({ orderNo }: { orderNo: number }) {
  const [data, setData] = useState<TrackingPanel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const { run, pending } = useAct();
  const ui = useErpUi();
  useEffect(() => {
    let live = true;
    void erpOrderTrackingPanel(orderNo).then((r) => {
      if (!live) return;
      if (r.ok) {
        setData(r.data);
        setError(null);
      } else setError(resultError(r));
    });
    return () => {
      live = false;
    };
  }, [orderNo, n]);
  const again = () => setN((x) => x + 1);

  if (error) return <Callout tone="danger">{error}</Callout>;
  if (!data) return <div className="text-meta text-muted">Reading what the customer sees…</div>;
  const p = data.preview;
  return (
    <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
      <section className="grid content-start gap-3.5">
        {data.notConfirmedYet ? (
          <Callout tone="neutral">No tracking link yet. It is made, and the confirmation sent, when the back office verifies the order (and Accounts approve a new customer).</Callout>
        ) : (
          <>
            <LinkRow
              label="Customer's tracking link"
              href={data.link!}
              hint={`${data.backfilled ? "Made for an order already under way; nothing was sent automatically. " : ""}Opened ${data.opens} time${data.opens === 1 ? "" : "s"}${data.lastOpenedAt ? `, last ${stamp(data.lastOpenedAt)}` : ""}.`}
            />
            {data.deliveryLink ? <LinkRow label="Delivery party's link (no invoice)" href={data.deliveryLink} hint="The goods go to somebody other than the billing party, so their link never shows the invoice." /> : null}
          </>
        )}
        {p ? (
          <div className={cx("grid gap-2 bg-canvas", insetClass)}>
            <SectionLabel>What the customer sees now</SectionLabel>
            <div className="text-lg font-semibold text-ink">{p.status.label}</div>
            <div className="text-meta text-muted">
              {p.status.lastUpdated ? `Last updated ${stamp(p.status.lastUpdated)}` : null}
              {p.expectedOn ? ` · Expected delivery ${p.expectedOn}` : ""}
            </div>
            {p.hold ? (
              <Callout tone="warn">
                <span className="font-semibold">{p.hold.title}.</span> {p.hold.text}
              </Callout>
            ) : null}
            <div className="text-meta text-body">
              Invoice: {p.documents.invoice.available ? "can be opened" : (p.documents.invoice.detail ?? "not yet")} · LR: {p.documents.lr.available ? "can be opened" : (p.documents.lr.detail ?? "not yet")}
            </div>
            {!data.invoiceFile ? <span className="text-meta text-muted">No invoice PDF on this order — Invoice PDF adds one once it is billed.</span> : null}
          </div>
        ) : null}
        {data.hold ? (
          <div className={cx("grid gap-1", insetClass)}>
            <SectionLabel>{data.hold.kind === "hold" ? "On hold" : "Delivery delayed"} · {data.hold.reasonLabel}</SectionLabel>
            <span className="text-sm text-ink">{data.hold.customerText}</span>
            {data.hold.internalNote ? <span className="text-meta text-warn-ink">Internal: {data.hold.internalNote}</span> : null}
            <span className="text-meta text-muted">
              Since {stamp(data.hold.raisedAt)}
              {data.hold.nextUpdateOn ? ` · next update by ${data.hold.nextUpdateOn}` : ""}
              {data.hold.kind === "hold" ? " · Resolve hold is below" : " · Logistics clears it"}
            </span>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {data.confirmationText ? <Copy text={data.confirmationText} label="Copy confirmation message" /> : null}
          {!data.notConfirmedYet ? (
            <LinkButton
              disabled={pending}
              onClick={() => {
                ui.confirm(`Make a new tracking link for order ${orderNo}? The link the customer has stops working, and so do older consignment links.`, () => void run(() => erpRegenerateTrackingLink(orderNo), () => again()));
              }}
            >
              Make a new link…
            </LinkButton>
          ) : null}
        </div>
        {data.history.length ? (
          <div className="grid gap-1.5">
            <SectionLabel>Holds and delays</SectionLabel>
            {data.history.map((h, i) => (
              <div key={i} className="text-meta text-body">
                <span className="font-medium text-ink">{h.label} · {h.reason}</span> — {stamp(h.at)}
                {h.resolvedAt ? ` · resolved ${stamp(h.resolvedAt)}${h.resolutionText ? `: ${h.resolutionText}` : ""}` : " · open"}
              </div>
            ))}
          </div>
        ) : null}
      </section>
      <section className={cx("grid content-start gap-1", insetClass)}>
        <SectionLabel>Messages to the customer</SectionLabel>
        {data.messages.length ? (
          data.messages.map((m) => {
            const st = STATUS[m.status] ?? { word: m.status, tone: "neutral" as Tone };
            const waiting = m.status === "to_send" || m.status === "failed";
            return (
              <div key={m.id} className="grid gap-1 border-t border-divider py-2 first:border-t-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-ink">{m.label}</span>
                  <Badge tone={st.tone}>{st.word}</Badge>
                </div>
                <span className="text-meta text-muted">
                  {m.customer}
                  {m.phone ? ` · ${m.phone}` : ""} · {stamp(m.at)}
                  {m.why && waiting ? ` · ${m.why}` : ""}
                </span>
                {waiting ? (
                  <div className="flex flex-wrap gap-2">
                    <Copy text={m.body} />
                    {m.waLink ? (
                      <a href={m.waLink} target="_blank" rel="noreferrer" className={linkClass("brand", "text-xs")}>
                        Open WhatsApp
                      </a>
                    ) : null}
                    {ORDER_KINDS.has(m.kind) ? (
                      <>
                        <LinkButton className="text-xs" disabled={pending} onClick={() => void run(() => erpTrackingMessage(m.id, "sent"), () => again())}>
                          Mark sent
                        </LinkButton>
                        <LinkButton className="text-xs" tone="muted" disabled={pending} onClick={() => void run(() => erpTrackingMessage(m.id, "skip"), () => again())}>
                          Don&apos;t send
                        </LinkButton>
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })
        ) : (
          <span className="text-meta text-muted">Nothing sent yet. A step saved twice is told once; every message is also on Logistics → Customer messages.</span>
        )}
      </section>
    </div>
  );
}

function OrderTracking({ data }: PanelProps) {
  const d = data as { orderNo: number };
  return <Body key={d.orderNo} orderNo={d.orderNo} />;
}

registerPanel("orderTracking", OrderTracking);
