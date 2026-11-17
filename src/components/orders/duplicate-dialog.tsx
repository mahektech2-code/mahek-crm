"use client";

import * as React from "react";
import { Button, Input } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/modal";
import { stamp } from "@/lib/format";
import type { DuplicateFound } from "@/lib/erp/order-hub";

/* ---------------------------------------------------------------------------
 * "THIS ORDER MAY ALREADY BE PUNCHED" - the one warning every door that takes
 * an order draws when the duplicate check finds a TO for the same billing and
 * delivery party, the same day and the same items. The person punching
 * answers it while they are punching: "Same order - don't create" (the
 * primary answer: nothing new is made, and whoever punched the first one is
 * told) or "Different order - create it", which needs a one-line reason that
 * the TO carries for Accounts.
 *
 * Shared by TeleCRM's call panel (stacked, narrow) and the ERP's order form
 * (side by side). It decides nothing: `onSame` and `onDifferent` are the
 * screen's, and the server checks the answer again.
 * ------------------------------------------------------------------------- */

const ORIGIN_WORD: Record<string, string> = { crm: "TeleCRM", mbos: "Salesman App", erp: "ERP" };

/** "Priya (ERP)" - the same words as `takenWhere` on the server, which a client component cannot import. */
export function punchedBy(m: DuplicateFound["match"]): string {
  return `${m.takenBy ?? "Someone"} (${ORIGIN_WORD[m.origin] ?? "ERP"})`;
}

function Lines({ lines }: { lines: DuplicateFound["newLines"] }) {
  return (
    <>
      {lines.map((l) => (
        <div key={l.skuId}>
          {l.name} × {l.qtyCans}
        </div>
      ))}
    </>
  );
}

export function DuplicateDialog({
  found,
  newLabel,
  reason,
  onReason,
  onSame,
  onDifferent,
  onClose,
  busy = false,
  layout = "stack",
  note,
  error,
}: {
  found: DuplicateFound;
  /** The heading over the order being punched: "THIS CALL", "YOU ARE PUNCHING · now". */
  newLabel: string;
  reason: string;
  onReason: (v: string) => void;
  onSame: () => void;
  onDifferent: (reason: string) => void;
  /** Closing without an answer goes back to the form; nothing is saved. */
  onClose: () => void;
  busy?: boolean;
  /** `stack` for a narrow panel, `side` for a wide form. */
  layout?: "stack" | "side";
  /** One line under the reason saying what "Same order" does on this screen. */
  note?: string;
  error?: string | null;
}) {
  const m = found.match;
  const [tried, setTried] = React.useState(false);
  const missing = !reason.trim();
  const existingLabel = layout === "side" ? `ALREADY PUNCHED · TO-${m.toNo} · ${m.takenBy ?? "Someone"} · ${stamp(m.takenAt)}` : `TO-${m.toNo}`;
  const sameParties = m.billingName === m.deliveryName ? m.billingName : `${m.billingName} → ${m.deliveryName}`;
  return (
    <Modal
      open
      onClose={busy ? () => undefined : onClose}
      width={layout === "side" ? 720 : 480}
      title="This order may already be punched"
      footer={
        <>
          <Button
            disabled={busy}
            onClick={() => {
              setTried(true);
              if (!missing) onDifferent(reason.trim());
            }}
          >
            Different order - create it
          </Button>
          <Button variant="primary" disabled={busy} onClick={onSame}>
            Same order - don&apos;t create
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-[13.5px] text-body">
          <strong>TO-{m.toNo}</strong> · {punchedBy(m)} · {stamp(m.takenAt)} · same billing and delivery party, same items.
        </p>
        <div className={layout === "side" ? "grid grid-cols-2 gap-3" : "flex flex-col gap-2"}>
          <div className="rounded-control border border-line px-3 py-2.5 text-[13px] leading-relaxed">
            <div className="text-[11.5px] font-semibold text-muted">{existingLabel}</div>
            {layout === "side" ? <div>{sameParties}</div> : null}
            <Lines lines={m.lines} />
          </div>
          <div className="rounded-control border-2 border-brand px-3 py-2.5 text-[13px] leading-relaxed">
            <div className="text-[11.5px] font-semibold text-brand-deep">{newLabel}</div>
            {layout === "side" ? <div>{sameParties}</div> : null}
            <Lines lines={found.newLines} />
          </div>
        </div>
        {found.line ? (
          <p className="flex items-center gap-2 text-[12.5px] text-muted">
            {found.ai ? <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-semibold text-brand-deep">AI</span> : null}
            {found.line}
          </p>
        ) : null}
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-muted">If it is a different order, say why</span>
          <Input value={reason} maxLength={300} placeholder="Reason" onChange={(e) => onReason(e.target.value)} aria-invalid={tried && missing} />
          {tried && missing ? <span className="text-[13px] text-danger">Say why it is a different order</span> : null}
        </label>
        {error ? <p className="text-[13px] text-danger">{error}</p> : null}
        {note ? <p className="text-[12.5px] text-muted">{note}</p> : null}
      </div>
    </Modal>
  );
}
