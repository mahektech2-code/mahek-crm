import { checkCapability } from "@/lib/access-control";
import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { listPayouts, payoutPickers, syncPurchasePayouts } from "@/lib/services/vendor-payout-service";
import { PayoutsScreen } from "./payouts-screen";

export const metadata = { title: "Vendor payouts — Accounts — MahekOne" };

export default async function Page() {
  // The register is the source of every purchase payout: bring it in first,
  // so a lot rated in the ERP a minute ago is on the calendar now.
  await syncPurchasePayouts();
  const [payouts, pickers, config, day, record, confirm] = await Promise.all([
    listPayouts(),
    payoutPickers(),
    getConfig(),
    today(),
    checkCapability("payment.record"),
    checkCapability("payment.confirm"),
  ]);

  return (
    <PayoutsScreen
      payouts={payouts}
      suppliers={pickers.suppliers}
      pos={pickers.pos}
      today={day}
      paymentDays={config["payments.vendorPayoutDays"]}
      defaultCreditDays={config["payments.vendorDefaultCreditDays"]}
      modes={config["payments.modes"]}
      canEdit={record.allowed}
      canSettle={confirm.allowed}
    />
  );
}
