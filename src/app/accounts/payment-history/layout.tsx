import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";

/** The route guard for this module. See the Customer account layout. */
export default async function PaymentHistoryModuleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  await requireModule(user.id, "accounts.payment-history");
  return children;
}
