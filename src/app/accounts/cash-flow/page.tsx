import { checkCapability } from "@/lib/access-control";
import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { cashInForecast } from "@/lib/services/cash-flow-service";
import { listPayouts, payoutPickers, syncPurchasePayouts } from "@/lib/services/vendor-payout-service";
import { CashFlowScreen, type CashFlowView } from "./cash-flow-screen";

export const metadata = { title: "Cash flow — Accounts — MahekOne" };

export default async function Page({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const params = await searchParams;
  const view: CashFlowView = params.view === "in" || params.view === "out" ? params.view : "overview";

  // The register is the source of every purchase payout: bring it in first,
  // so a lot rated in the ERP a minute ago is on the calendar now.
  await syncPurchasePayouts();
  const [payouts, pickers, cashIn, config, day, record, confirm] = await Promise.all([
    listPayouts(),
    payoutPickers(),
    cashInForecast(),
    getConfig(),
    today(),
    checkCapability("payment.record"),
    checkCapability("payment.confirm"),
  ]);

  return (
    <CashFlowScreen
      view={view}
      today={day}
      cashIn={cashIn}
      payouts={payouts}
      suppliers={pickers.suppliers}
      pos={pickers.pos}
      paymentDays={config["payments.vendorPayoutDays"]}
      defaultCreditDays={config["payments.vendorDefaultCreditDays"]}
      modes={config["payments.modes"]}
      canEdit={record.allowed}
      canSettle={confirm.allowed}
    />
  );
}
