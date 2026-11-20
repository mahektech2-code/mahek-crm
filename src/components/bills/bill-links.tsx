"use client";

import { RowMenu, type MenuItem } from "@/components/ui/overlays";
import { useRouter } from "next/navigation";

/**
 * WHERE A BILL ROW LEADS — its ERP order, the customer's ledger (where the
 * payments against it are, with Edit and Reverse), and Issue credit note.
 *
 * Each is offered only to somebody the destination would let in, decided on
 * the server and passed as `links`: the ERP for whoever holds it, the ledger
 * for whoever holds Accounts, the credit note desk for `creditnote.issue`. A
 * link to a screen that refuses the reader is worse than no link.
 */
export type BillLinks = { ledger: boolean; erp: boolean; credit: boolean };

export function BillRowLinks({
  customerId,
  erpOrderNo,
  links,
}: {
  customerId: string;
  erpOrderNo: number | null;
  links: BillLinks;
}) {
  const router = useRouter();
  const items: MenuItem[] = [];
  if (links.erp && erpOrderNo != null) {
    items.push({
      label: `Open order ${erpOrderNo}`,
      onSelect: () => router.push(`/erp/orders?view=orderDetails&q=${erpOrderNo}`),
    });
  }
  if (links.ledger) {
    items.push({
      label: "Customer ledger",
      title: "Every bill and payment for this customer — edit or reverse a payment there",
      onSelect: () => router.push(`/accounts/ledger?customer=${customerId}`),
    });
  }
  if (links.credit) {
    items.push({
      label: "Issue credit note",
      title: "Credit notes are issued from Accounts › Credit notes",
      onSelect: () => router.push(`/accounts/credits`),
    });
  }
  if (!items.length) return null;
  return <RowMenu items={items} />;
}
