"use client";

import * as React from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/primitives";
import { receiptForEditAction } from "@/lib/actions/payments";
import type { ReceiptForEdit } from "@/lib/services/receipt-service";
import { CorrectReceiptDialog } from "./correct-receipt-dialog";

/**
 * EDIT A PAYMENT FROM WHEREVER IT IS LISTED. Loads the payment, then opens the
 * one correction dialog: for a payment that has counted (Accounts' own entries
 * are confirmed as they are saved) saving reverses it and records the
 * corrected one; for a claim still waiting it corrects it in place. The
 * server decides who may — this only draws.
 */
export function EditPaymentDialog({
  receiptId,
  run,
  onClose,
  onDone,
}: {
  receiptId: string;
  run: <T extends { ok: boolean; message?: string; error?: string }>(p: Promise<T>) => Promise<T>;
  onClose: () => void;
  onDone: () => void;
}) {
  const [loaded, setLoaded] = React.useState<{ state: "loading" } | { state: "error"; message: string } | { state: "ready"; r: ReceiptForEdit }>({ state: "loading" });
  React.useEffect(() => {
    let alive = true;
    receiptForEditAction(receiptId).then(
      (res) => alive && setLoaded(res.ok ? { state: "ready", r: res.data } : { state: "error", message: res.error }),
      () => alive && setLoaded({ state: "error", message: "Could not open the payment. Try again." }),
    );
    return () => {
      alive = false;
    };
  }, [receiptId]);

  if (loaded.state !== "ready") {
    return (
      <Modal open onClose={onClose} title="Edit payment" footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
        <p className={loaded.state === "error" ? "text-sm text-danger" : "text-sm text-muted"}>
          {loaded.state === "error" ? loaded.message : "Opening the payment…"}
        </p>
      </Modal>
    );
  }
  const r = loaded.r;
  if (r.status === "rejected" || r.status === "reversed") {
    return (
      <Modal open onClose={onClose} title="Edit payment" footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
        <p className="text-sm text-body">This payment no longer counts ({r.status}), so there is nothing to edit. Record the right payment instead.</p>
      </Modal>
    );
  }
  return (
    <CorrectReceiptDialog
      receiptId={r.receiptId}
      detail={r}
      amount={r.amount}
      customerName={r.customerName}
      run={run}
      counted={r.status === "confirmed"}
      onClose={onClose}
      onDone={onDone}
    />
  );
}
