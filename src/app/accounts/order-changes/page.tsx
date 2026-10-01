import { checkCapability } from "@/lib/access-control";
import { listOrderChanges } from "@/lib/services/order-change-service";
import { OrderChangesScreen } from "./order-changes-screen";

export const metadata = { title: "Order changes — Accounts — MahekOne" };

export default async function Page() {
  // App and module access are the layouts'. This decides whether the buttons
  // are live: seeing a request and deciding it are different things.
  const [{ allowed }, rows] = await Promise.all([checkCapability("order.approve"), listOrderChanges()]);
  return <OrderChangesScreen rows={rows} canDecide={allowed} />;
}
