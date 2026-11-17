import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";

/** The route guard for My orders: the folder is the module. */
export default async function MyOrdersModuleLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  await requireModule(user.id, "crm.my-orders");
  return children;
}
