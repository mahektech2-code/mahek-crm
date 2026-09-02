import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";

/** The route guard for this module. See the Sync health layout. */
export default async function ModuleLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  await requireModule(user.id, "sales.notify");
  return children;
}
