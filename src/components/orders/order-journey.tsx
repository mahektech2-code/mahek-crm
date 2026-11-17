"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Field, Input, Textarea, type Tone } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { ProductCombobox } from "@/components/products/product-combobox";
import { cancelMyToAction, editMyToAction, loadMyToAction } from "@/lib/actions/my-orders";
import { money, stamp } from "@/lib/format";
import type { Journey, JourneyTone } from "@/lib/order-journey";
import type { OrderRow } from "@/lib/services/order-journey-service";

/* ---------------------------------------------------------------------------
 * AN ORDER'S JOURNEY, drawn the same on TeleCRM's My orders and on the
 * customer record: its TO number or order number, one status word, the facts
 * in the order they happened, and — only while it is a TO, for the person who
 * took it — Change and Cancel. Words are `lib/order-journey.ts`'s.
 * ------------------------------------------------------------------------- */

export const TONE: Record<JourneyTone, Tone> = { info: "brand", good: "success", warn: "warn", bad: "danger", muted: "muted" };
const DOT: Record<JourneyTone, string> = { info: "bg-brand", good: "bg-success", warn: "bg-warn", bad: "bg-danger", muted: "bg-line" };

export function JourneyBadge({ journey }: { journey: Journey }) {
  return <Badge tone={TONE[journey.tone]}>{journey.status}</Badge>;
}

export function orderSummary(r: OrderRow): string {
  const first = r.lines.slice(0, 2).map((l) => `${l.product} × ${l.cans}`).join(", ");
  const more = r.lines.length > 2 ? ` + ${r.lines.length - 2} more` : "";
  return `${first}${more}${r.litres != null ? ` · ${r.litres} L` : ""}`;
}

export function JourneyEvents({ journey }: { journey: Journey }) {
  return (
    <ol className="divide-y divide-divider">
      {journey.events.map((e, i) => (
        <li key={`${e.at}-${i}`} className="grid grid-cols-[12px_120px_minmax(0,1fr)_120px] items-center gap-3 py-2 text-[13px]">
          <span className={`h-2.5 w-2.5 justify-self-center rounded-full ${DOT[e.tone]}`} />
          <span className="text-muted">{stamp(e.at)}</span>
          <span className="min-w-0 text-ink">{e.text}</span>
          <span className="truncate text-right text-muted">{e.where ?? ""}</span>
        </li>
      ))}
    </ol>
  );
}

/** The header of one order, and its thread folded beneath it. */
export function OrderThread({ row, canEdit, defaultOpen = false, showCustomer = false }: { row: OrderRow; canEdit: boolean; defaultOpen?: boolean; showCustomer?: boolean }) {
  const [open, setOpen] = React.useState(defaultOpen);
  const [editing, setEditing] = React.useState(false);
  const [cancelling, setCancelling] = React.useState(false);
  const j = row.journey;
  const editable = canEdit && j.editable && !!row.intakeId;
  return (
    <div className="px-5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setOpen((v) => !v)} className="cursor-pointer text-[15px] font-semibold text-ink hover:text-brand" aria-expanded={open}>
          {j.title}
        </button>
        {j.orderNo != null && j.toNo != null ? <Badge tone="brand">from TO-{j.toNo}</Badge> : null}
        <JourneyBadge journey={j} />
        {showCustomer ? (
          <a href={`/crm/customers/${row.customerId}`} className="text-sm text-body hover:text-brand">
            {row.customerName}
          </a>
        ) : null}
        <span className="ml-auto text-[13px] text-muted">
          {stamp(row.orderedAt)}
          {row.totalPaise ? ` · ${money(row.totalPaise)}` : ""}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-body">
        <span className="min-w-0">{orderSummary(row)}</span>
        {editable ? (
          <span className="ml-auto flex gap-2">
            {j.state === "correction" ? (
              <Button size="sm" variant="primary" onClick={() => setEditing(true)}>
                Correct and send
              </Button>
            ) : (
              <>
                <Button size="sm" onClick={() => setEditing(true)}>
                  Edit
                </Button>
                <Button size="sm" onClick={() => setCancelling(true)}>
                  Cancel TO
                </Button>
              </>
            )}
          </span>
        ) : null}
      </div>
      {j.banner ? <div className="mt-2 rounded-control bg-warn-soft px-3 py-2 text-[13px] text-warn-ink">{j.banner}</div> : null}
      {open ? (
        <div className="mt-2 rounded-card border border-divider px-3">
          <JourneyEvents journey={j} />
          <p className="py-2 text-[12px] text-muted">{j.editable ? "You can change it until Accounts approve it." : j.orderNo != null ? "Approved: changes in the ERP." : ""}</p>
        </div>
      ) : null}
      {editing && row.intakeId ? <EditToDialog key={row.intakeId} intakeId={row.intakeId} correcting={j.state === "correction"} onClose={() => setEditing(false)} /> : null}
      {cancelling && row.intakeId ? <CancelToDialog intakeId={row.intakeId} title={j.title} onClose={() => setCancelling(false)} /> : null}
    </div>
  );
}

type Line = { skuId: string; name: string; qtyCans: string; ratePaise: number | null };

export function EditToDialog({ intakeId, onClose, correcting = false }: { intakeId: string; onClose: () => void; correcting?: boolean }) {
  const router = useRouter();
  const { run } = useToast();
  const [state, setState] = React.useState<{ toNo: number; lines: Line[]; remark: string } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [pick, setPick] = React.useState("");

  React.useEffect(() => {
    let live = true;
    loadMyToAction(intakeId).then((res) => {
      if (!live) return;
      if (res.ok) setState({ toNo: res.data.toNo, remark: res.data.remark ?? "", lines: res.data.lines.map((l) => ({ ...l, qtyCans: String(l.qtyCans) })) });
      else setError(res.error);
    });
    return () => {
      live = false;
    };
  }, [intakeId]);

  async function save() {
    if (!state) return;
    const lines = state.lines.map((l) => ({ skuId: l.skuId, qtyCans: Number(l.qtyCans) }));
    if (lines.some((l) => !Number.isInteger(l.qtyCans) || l.qtyCans <= 0)) {
      setError("Every line needs a whole number of cans above 0.");
      return;
    }
    setBusy(true);
    try {
      const res = await run(editMyToAction({ intakeId, lines, remark: state.remark }));
      if (res.ok) {
        onClose();
        router.refresh();
      } else setError(res.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={620}
      title={state ? `${correcting ? "Correct" : "Change"} TO-${state.toNo}` : "Change the TO"}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" disabled={!state || busy} onClick={save}>
            {correcting ? "Correct and send" : "Save"}
          </Button>
        </>
      }
    >
      {!state && !error ? <p className="text-sm text-muted">Opening the TO…</p> : null}
      {error ? <p className="mb-3 text-sm text-danger">{error}</p> : null}
      {state ? (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-muted">Accounts check it again after a change. A product you add is priced from the shop&apos;s list.</p>
          <ul className="divide-y divide-divider rounded-card border border-divider">
            {state.lines.map((l, i) => (
              <li key={l.skuId} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 text-ink">{l.name}</span>
                <span className="text-[12px] text-muted">{l.ratePaise == null ? "no rate yet" : `${money(l.ratePaise)} a can`}</span>
                <Input
                  aria-label={`Cans of ${l.name}`}
                  inputMode="numeric"
                  className="w-20 text-right"
                  value={l.qtyCans}
                  onChange={(e) => setState({ ...state, lines: state.lines.map((x, k) => (k === i ? { ...x, qtyCans: e.target.value.replace(/[^0-9]/g, "") } : x)) })}
                />
                <span className="text-[12px] text-muted">cans</span>
                <Button size="sm" disabled={state.lines.length === 1} title={state.lines.length === 1 ? "A TO needs at least one product. Cancel it instead." : undefined} onClick={() => setState({ ...state, lines: state.lines.filter((_, k) => k !== i) })}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
          <Field label="Add a product" optional>
            <ProductCombobox
              text={pick}
              productId={null}
              onText={setPick}
              placeholder="Search the catalogue"
              onPick={(p) => {
                if (!p) return;
                setPick("");
                if (state.lines.some((l) => l.skuId === p.productId)) return;
                setState({ ...state, lines: [...state.lines, { skuId: p.productId, name: p.name, qtyCans: "1", ratePaise: null }] });
              }}
            />
          </Field>
          <Field label="Note for Accounts" optional>
            <Textarea rows={2} value={state.remark} onChange={(e) => setState({ ...state, remark: e.target.value })} />
          </Field>
        </div>
      ) : null}
    </Modal>
  );
}

export function CancelToDialog({ intakeId, title, onClose }: { intakeId: string; title: string; onClose: () => void }) {
  const router = useRouter();
  const { run } = useToast();
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  return (
    <Modal
      open
      onClose={onClose}
      title={`Cancel ${title}`}
      footer={
        <>
          <Button onClick={onClose}>Keep it</Button>
          <Button
            variant="danger"
            disabled={busy || !reason.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                const res = await run(cancelMyToAction({ intakeId, reason }));
                if (res.ok) {
                  onClose();
                  router.refresh();
                }
              } finally {
                setBusy(false);
              }
            }}
          >
            Cancel the TO
          </Button>
        </>
      }
    >
      <Field label="Why is it cancelled?" required>
        <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Modal>
  );
}
