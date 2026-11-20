import { requireUser } from "@/lib/auth";
import { nowMs } from "@/lib/format";
import { PAYMENT_HISTORY_LIMIT, paymentHistory } from "@/lib/services/receipt-service";
import { canFor } from "@/lib/access-control";
import { PaymentHistoryScreen } from "./payment-history-screen";

export const metadata = { title: "Payment history — Accounts — MahekOne" };

/**
 * Everything the accounts team recorded or decided on, across every
 * customer — the record a hectic day of collections is checked against.
 * See `paymentHistory()` in `lib/services/receipt-service.ts` for why this
 * is a separate query from the confirm queue and the audit log.
 */
export default async function PaymentHistoryPage() {
  const user = await requireUser();
  const [rows, canDecide] = await Promise.all([paymentHistory(), canFor(user, "payment.confirm")]);

  return (
    <PaymentHistoryScreen
      rows={rows}
      capped={rows.length >= PAYMENT_HISTORY_LIMIT}
      currentUserName={user.name}
      nowMs={nowMs()}
      canDecide={canDecide}
      currentUserId={user.id}
    />
  );
}
