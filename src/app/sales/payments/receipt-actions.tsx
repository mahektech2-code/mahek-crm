"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { EditPaymentDialog } from "@/app/accounts/edit-payment-dialog";

/**
 * A FIELD RECEIPT'S OWN ACTION on Sales › Payments.
 *
 * Edit payment for whoever the server lets edit it (`receiptForEdit`):
 * Accounts (`payment.confirm`) on any payment still counting or waiting, the
 * salesman who reported it while it is still `reported`. Everybody else who
 * holds Accounts gets the customer's ledger, where the receipt sits with its
 * own Edit and Reverse. A reader with neither gets nothing rather than a link
 * to a screen that would refuse them.
 */
export function ReceiptActions({
  receiptId,
  customerId,
  status,
  reportedById,
  userId,
  canConfirm,
  holdsAccounts,
}: {
  receiptId: string;
  customerId: string;
  status: string;
  reportedById: string | null;
  userId: string;
  canConfirm: boolean;
  holdsAccounts: boolean;
}) {
  const router = useRouter();
  const { run } = useToast();
  const [open, setOpen] = React.useState(false);
  const live = status === "reported" || status === "held" || status === "confirmed";
  const editable = live && (canConfirm || (reportedById === userId && status === "reported"));

  if (editable) {
    return (
      <>
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          Edit
        </Button>
        {open ? (
          <EditPaymentDialog
            key={receiptId}
            receiptId={receiptId}
            run={run}
            onClose={() => setOpen(false)}
            onDone={() => {
              setOpen(false);
              router.refresh();
            }}
          />
        ) : null}
      </>
    );
  }
  if (holdsAccounts) {
    return (
      <Link
        href={`/accounts/ledger?customer=${customerId}`}
        className="text-[13px] whitespace-nowrap"
        title="The customer's ledger — the receipt is there with Edit and Reverse"
      >
        Ledger
      </Link>
    );
  }
  return null;
}
