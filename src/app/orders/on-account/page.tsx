import { checkCapability } from "@/lib/access-control";
import { onAccountHolders } from "@/lib/services/on-account-service";
import { OnAccountScreen } from "./on-account-screen";

export const metadata = { title: "On account — Accounts — MahekOne" };

export default async function Page() {
  const [holders, { allowed }] = await Promise.all([
    onAccountHolders(),
    // Moving money between bills is the same decision as confirming it arrived.
    checkCapability("payment.confirm"),
  ]);

  return <OnAccountScreen holders={holders} canApply={allowed} />;
}
