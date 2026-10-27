import { importState } from "@/lib/services/bill-import-service";
import { getConfig } from "@/lib/config/store";
import { ORDER_TABS_RETIRED } from "@/lib/engines/sheet-retirement";
import { ImportScreen } from "./import-screen";

export const metadata = { title: "Sheet import — Accounts — MahekOne" };

export default async function Page() {
  const [state, config] = await Promise.all([importState(), getConfig()]);
  return <ImportScreen state={state} retired={config["erp.orders.live"] ? ORDER_TABS_RETIRED : null} />;
}
