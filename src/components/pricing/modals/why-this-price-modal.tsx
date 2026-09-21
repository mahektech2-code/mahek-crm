"use client";

/* ---------------------------------------------------------------------------
 * WHY THIS SHOP PAYS WHAT IT PAYS — the chain, not the answer.
 *
 * A price a telecaller cannot explain is a price the customer argues with,
 * and "because the system says so" is how a rate gets given away on the next
 * call. The resolution engine returns the reasoning it used — every scope
 * that named this shop, kind by kind, and why the winner won — and this
 * renders it.
 *
 * Where NOTHING resolved there is no chain to draw, and the honest sentence
 * is that no published list names this shop. An empty modal that looked like
 * a failed load would send somebody looking for a fault that is not there.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { Button } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlays";
import { ResolutionChain } from "../resolution-chain";
import type { Resolution } from "@/lib/engines/price-resolution";

export function WhyThisPriceModal({
  open,
  onClose,
  customerName,
  resolution,
}: {
  open: boolean;
  onClose: () => void;
  customerName: string;
  resolution: Resolution | null;
}) {
  if (!open) return null;
  return (
    <Modal
      open
      onClose={onClose}
      title={`Why this price — ${customerName}`}
      width={620}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      {resolution ? (
        <ResolutionChain resolution={resolution} />
      ) : (
        <div className="space-y-3 text-sm text-body">
          <p>
            No published price list names this shop, so there is no chain to show. That
            is not a refusal — it means no scope on any list in force today reaches
            them: not their city, not their state, not their salesman, and no list
            scoped to everybody.
          </p>
          <p className="text-muted">
            Putting a list on them, or giving one list a scope of Everybody, is what
            fixes it. Until then the order form shows quantities and no money, which is
            what it did before price lists existed.
          </p>
        </div>
      )}
    </Modal>
  );
}
