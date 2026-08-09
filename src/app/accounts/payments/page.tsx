import { checkCapability } from "@/lib/access-control";
import { getConfig } from "@/lib/config/store";
import { longDate, money, stamp } from "@/lib/format";
import { pendingReceipts } from "@/lib/services/receipt-service";
import { QueueScreen } from "../queue-screen";
import { SOURCE_WORDS, type QueueRow } from "../queue-types";

export const metadata = { title: "Payments to confirm — Accounts — MahekOne" };

export default async function Page() {
  // App access is gated by the layout. This decides only whether the buttons
  // are live: seeing what is waiting and deciding on it are different things.
  const [{ allowed }, receipts, config] = await Promise.all([
    checkCapability("payment.confirm"),
    pendingReceipts(),
    getConfig(),
  ]);

  const rows: QueueRow[] = receipts.map((r) => {
    const bills = r.lines.filter((l) => l.billId);
    const onAccount = r.lines.filter((l) => !l.billId).reduce((s, l) => s + l.amount, 0);
    return {
      id: r.receiptId,
      customerId: r.customerId,
      customerName: r.customerName,
      amount: r.amount,
      waitingHours: r.waitingHours,
      byName: r.reportedBy ?? "—",
      byWhen: stamp(r.reportedAt),
      // The source in words, and what confirming it would settle. A stored
      // identifier tells the reader nothing about how much to trust the claim,
      // and the number of bills is what says whether this is a simple receipt
      // or one that has to be read carefully.
      byMeta: [
        SOURCE_WORDS[r.source] ?? r.source,
        bills.length
          ? `settles ${bills.length} bill${bills.length === 1 ? "" : "s"}${onAccount ? ` + ${money(onAccount)} on account` : ""}`
          : "nothing named — it would sit on account",
      ].join(" · "),
      middle: r.mode,
      // The absence of a reference has to be legible: a confirmed payment
      // without one is money nobody can find in the statement again.
      middleSub: r.reference ?? "no reference",
      context: longDate(r.receivedAt),
      contextTone: "body",
      slowPayer: false,
      overdueBills: 0,
    };
  });

  return (
    <QueueScreen
      kind="payments"
      rows={rows}
      canDecide={allowed}
      staleHours={config["payments.confirmationAgeWarningHours"]}
      quietDays={config["payments.reportedQuietDays"]}
    />
  );
}
