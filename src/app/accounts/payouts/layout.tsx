import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";

/** The route guard for Vendor payouts — a bookmark reaches past the sidebar. */
export default async function PayoutsModuleLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  await requireModule(user.id, "accounts.payouts");
  return children;
}
