import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";

/** The route guard for Order changes — see the Credit notes layout for why a folder layout. */
export default async function OrderChangesModuleLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  await requireModule(user.id, "accounts.order-changes");
  return children;
}
