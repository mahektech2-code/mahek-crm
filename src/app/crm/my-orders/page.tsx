import { requireUser } from "@/lib/auth";
import { ordersTakenBy } from "@/lib/services/order-journey-service";
import { MyOrdersScreen } from "./my-orders-screen";

export const metadata = { title: "My orders - MahekOne CRM" };

/**
 * THE ORDERS SHE TOOK ON A CALL, each as its TO number until the Order Hub
 * has checked it, then as its order number and wherever it now is. Always her
 * own: a manager reads the team's orders on the Order Hub and in Accounts.
 */
export default async function MyOrdersPage() {
  const user = await requireUser();
  const rows = await ordersTakenBy(user.id);
  return <MyOrdersScreen rows={rows} />;
}
