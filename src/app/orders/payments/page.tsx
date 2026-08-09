import { checkCapability } from "@/lib/access-control";
import { getConfig } from "@/lib/config/store";
import { pendingReceipts } from "@/lib/services/receipt-service";
import { ConfirmScreen } from "./confirm-screen";

export const metadata = { title: "Payments to confirm — MahekOne" };

export default async function Page() {
  // App access is gated by the layout. This decides only whether the buttons
  // are live: seeing what is waiting and deciding on it are different things.
  const [{ allowed }, receipts, config] = await Promise.all([
    checkCapability("payment.confirm"),
    pendingReceipts(),
    getConfig(),
  ]);

  return (
    <ConfirmScreen
      canConfirm={allowed}
      staleAfterHours={config["payments.confirmationAgeWarningHours"]}
      quietDays={config["payments.reportedQuietDays"]}
      receipts={receipts}
    />
  );
}
