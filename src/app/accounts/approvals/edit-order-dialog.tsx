"use client";

import * as React from "react";
import { Button } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { editOrderAction, loadOrderEditAction } from "@/lib/actions/orders";
import type { AccountsOrderEditView } from "@/lib/services/order-approval-service";
import { OrderLinesEditor, discountBpOf, lineErrors, linesEdited, type EditLine } from "./order-lines-editor";

/* ---------------------------------------------------------------------------
 * EDIT ORDER, for Accounts, in place on Order approvals (Option A): the lines
 * of a numbered order still waiting for them — product, cans, rate, discount,
 * a line added or taken off — and a missing rate filled before approving.
 * The parties and the godown are shown and never sent. Saving leaves the order
 * waiting; it is still Approve that decides it. Works without the ERP grant.
 * ------------------------------------------------------------------------- */

export function EditOrderDialog({ orderId, onClose, onSaved }: { orderId: string; onClose: () => void; onSaved: () => void }) {
  const { run } = useToast();
  const [data, setData] = React.useState<AccountsOrderEditView | null>(null);
  const [loadError, setLoadError] = React.useState("");
  const [lines, setLines] = React.useState<EditLine[]>([]);
  const [errs, setErrs] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    void loadOrderEditAction(orderId).then((res) => {
      if (!live) return;
      if (!res.ok) return setLoadError(res.error);
      setData(res.data);
      setLines(res.data.lines.map((l, i) => ({ key: `l${i}`, lineId: l.lineId, skuId: l.skuId, qtyCans: l.qtyCans, ratePaise: l.ratePaise, discountPct: l.discountBp == null ? null : l.discountBp / 100 })));
    });
    return () => {
      live = false;
    };
  }, [orderId]);

  const edited = data ? linesEdited(lines, data.lines) : false;

  async function save() {
    const e = lineErrors(lines, { rateRequired: false });
    setErrs(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const res = await run(editOrderAction(orderId, { lines: lines.map((l) => ({ lineId: l.lineId ?? null, skuId: l.skuId, qtyCans: l.qtyCans!, ratePaise: l.ratePaise, discountBp: discountBpOf(l) })) }));
      if (res.ok) onSaved();
      else if (res.fieldErrors?.length) setErrs(Object.fromEntries(res.fieldErrors.map((f) => [f.field, f.message])));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={860}
      title={data ? `Edit order ${data.orderNo} · ${data.billing}` : "Edit order"}
      footer={
        <div className="flex w-full flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 text-[12.5px] text-muted">Saving keeps it waiting here; Approve still decides it.</span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!data || busy || !edited} title={!edited ? "Change a line first" : undefined} onClick={() => void save()}>
            {busy ? "Saving…" : "Save changes"}
          </Button>
        </div>
      }
    >
      {loadError ? <p className="text-danger">{loadError}</p> : null}
      {!data ? (
        !loadError ? <p className="text-muted">Loading the order…</p> : null
      ) : (
        <div className="flex min-w-0 flex-col gap-3">
          <span className="text-[12.5px] text-muted">Accounts can change the lines before approving. The parties and the godown stay as they are — decline the order if one is wrong.</span>
          <div className="grid grid-cols-3 gap-2.5 text-[13px]">
            <div>
              <div className="text-[12px] text-muted">Billing party</div>
              <strong>{data.billing}</strong>
            </div>
            <div>
              <div className="text-[12px] text-muted">Delivery party</div>
              <strong>{data.delivery}</strong>
            </div>
            <div>
              <div className="text-[12px] text-muted">Godown</div>
              <strong>{data.godown || "Not picked"}</strong>
            </div>
          </div>
          <OrderLinesEditor lines={lines} setLines={setLines} products={data.products} errs={errs} editable />
        </div>
      )}
    </Modal>
  );
}
