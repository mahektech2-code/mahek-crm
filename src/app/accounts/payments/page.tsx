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
      //
      // A hold replaces the source line entirely. Where the money came from
      // stops being the interesting fact the moment somebody parked it: what
      // matters is who, how long ago, and what they said they were checking —
      // and the customer has been off collections for every one of those days.
      byMeta:
        r.status === "held"
          ? [
              r.heldDays === 0
                ? `On hold since today${r.heldByName ? ` · ${r.heldByName}` : ""}`
                : `On hold ${r.heldDays} day${r.heldDays === 1 ? "" : "s"}${r.heldByName ? ` · ${r.heldByName}` : ""}`,
              r.holdReason,
            ]
              .filter(Boolean)
              .join(" · ")
          : [
              SOURCE_WORDS[r.source] ?? r.source,
              bills.length
                ? `settles ${bills.length} bill${bills.length === 1 ? "" : "s"}${onAccount ? ` + ${money(onAccount)} on account` : ""}`
                : "nothing named — it would sit on account",
            ].join(" · "),
      middle: r.status === "held" ? `On hold · ${r.mode}` : r.mode,
      // The absence of a reference has to be legible: a confirmed payment
      // without one is money nobody can find in the statement again.
      middleSub: r.reference ?? "no reference",
      /*
       * A DATED INSTRUMENT REPLACES THE RECEIVED DATE HERE.
       *
       * The day a cheque was handed over stops being the interesting fact the
       * moment it carries a date of its own. What accounts need off a list is
       * whether it can be banked — one dated today is a job for this morning,
       * and one dated last week has been sitting somewhere it should not have
       * been.
       */
      context: r.instrumentDate
        ? r.bankableNow
          ? r.bankableDays === 0
            ? `${r.mode} dated today`
            : `${r.mode} dated ${r.bankableDays}d ago`
          : `${r.mode} dated ${longDate(r.instrumentDate)}`
        : longDate(r.receivedAt),
      contextTone: r.instrumentDate ? (r.bankableNow ? "danger" : "warn") : "body",
      slowPayer: false,
      overdueBills: 0,
      /*
       * Two things worth a second look, and the same flag drives the count as
       * draws the highlight — the number and the highlighted rows must
       * describe the same rows.
       *
       *   A stale hold, because a hold does not expire and this is the whole
       *   of what stops one being forgotten.
       *
       *   A cheque that can be banked, because the money is reachable now and
       *   nobody has gone and got it. A POST-DATED one is deliberately not
       *   flagged: it is not asking for anything yet, and marking it would
       *   train people to ignore the mark.
       */
      needsAttention: r.holdStale || r.bankableNow,
      held: r.status === "held",
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
