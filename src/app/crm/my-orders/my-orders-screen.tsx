"use client";

import * as React from "react";
import { Badge, Button, Card, EmptyState, PageHeader, Td, Th, type Tone } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/modal";
import { CancelToDialog, EditToDialog, JourneyEvents, TONE } from "@/components/orders/order-journey";
import { stamp } from "@/lib/format";
import type { Journey } from "@/lib/order-journey";
import type { OrderRow } from "@/lib/services/order-journey-service";

/**
 * TELECRM · MY ORDERS. The orders this telecaller took on a call, newest
 * first, each as its TO number until Accounts approve it and then as its
 * order number. A TO she took can be edited or cancelled until Accounts
 * approve it; one they sent back says why and is corrected and sent again;
 * a declined one says why. After approval it is read only: the ERP office
 * makes any change.
 */

/** The short word for the Status column, keyed on the journey's state. */
function pill(j: Journey): { label: string; tone: Tone } {
  switch (j.state) {
    case "open":
      return { label: "Waiting for Accounts", tone: "warn" };
    case "possible_duplicate":
      return { label: "Possible duplicate", tone: "warn" };
    case "correction":
      return { label: "Sent back by Accounts", tone: "brand" };
    case "hold":
      return { label: "On hold", tone: "danger" };
    case "declined":
      return { label: "Declined", tone: "danger" };
    case "cancelled":
      return { label: "Cancelled", tone: "muted" };
    default:
      return { label: j.status, tone: TONE[j.tone] };
  }
}

function goods(r: OrderRow): string {
  const n = r.lines.length;
  return `${n} line${n === 1 ? "" : "s"}${r.litres != null ? ` · ${r.litres.toLocaleString("en-IN")} L` : ""}`;
}

function Lock() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

function Row({ r }: { r: OrderRow }) {
  const [editing, setEditing] = React.useState(false);
  const [cancelling, setCancelling] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const j = r.journey;
  const p = pill(j);
  const editable = j.editable && !!r.intakeId;
  const quote = (j.state === "correction" || j.state === "declined" || j.state === "hold") && j.reason ? j.reason : null;
  return (
    <tr>
      <Td className="align-top">
        <button type="button" onClick={() => setOpen(true)} className="cursor-pointer font-semibold text-ink hover:text-brand">
          {j.title}
        </button>
        {j.orderNo != null && j.toNo != null ? <div className="text-[12px] text-muted">was TO-{j.toNo}</div> : null}
      </Td>
      <Td className="align-top">
        <a href={`/crm/customers/${r.customerId}`} className="text-body hover:text-brand">
          {r.customerName}
        </a>
      </Td>
      <Td className="align-top">{goods(r)}</Td>
      <Td className="align-top whitespace-normal">
        <Badge tone={p.tone}>{p.label}</Badge>
        {quote ? <div className="mt-1 text-[12.5px] text-body">&ldquo;{quote}&rdquo;</div> : null}
        {j.state === "possible_duplicate" && j.duplicateOfToNo != null ? (
          <div className="mt-1 text-[12.5px] text-muted">Matches TO-{j.duplicateOfToNo}; Accounts will check it.</div>
        ) : null}
      </Td>
      <Td className="align-top">{stamp(r.takenAt)}</Td>
      <Td className="align-top">
        {editable ? (
          j.state === "correction" ? (
            <Button size="sm" variant="primary" onClick={() => setEditing(true)}>
              Correct and send
            </Button>
          ) : (
            <span className="flex gap-2">
              <Button size="sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button size="sm" onClick={() => setCancelling(true)}>
                Cancel TO
              </Button>
            </span>
          )
        ) : j.orderNo != null && j.state === "approved" ? (
          <span className="inline-flex items-center gap-1.5 text-[12.5px] text-muted">
            <Lock />
            Approved: changes in the ERP
          </span>
        ) : null}
        {editing && r.intakeId ? <EditToDialog key={r.intakeId} intakeId={r.intakeId} correcting={j.state === "correction"} onClose={() => setEditing(false)} /> : null}
        {cancelling && r.intakeId ? <CancelToDialog intakeId={r.intakeId} title={j.title} onClose={() => setCancelling(false)} /> : null}
        {open ? (
          <Modal open onClose={() => setOpen(false)} width={640} title={`${j.title} · ${r.customerName}`}>
            {j.banner ? <p className="mb-2 text-[13px] text-body">{j.banner}</p> : null}
            <div className="rounded-card border border-divider px-3">
              <JourneyEvents journey={j} />
            </div>
          </Modal>
        ) : null}
      </Td>
    </tr>
  );
}

export function MyOrdersScreen({ rows }: { rows: OrderRow[] }) {
  return (
    <div className="flex flex-col gap-3">
      <PageHeader title="My orders" subtitle="You can change an order until Accounts approve it. After that, the ERP office makes any change." />
      <Card className="overflow-auto">
        {rows.length ? (
          <table className="w-full">
            <thead>
              <tr>
                <Th>Number</Th>
                <Th>Customer</Th>
                <Th>Goods</Th>
                <Th>Status</Th>
                <Th>Taken</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Row key={r.id} r={r} />
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState title="No orders yet." body="An order you take on a call appears here with its TO number." />
        )}
      </Card>
    </div>
  );
}
