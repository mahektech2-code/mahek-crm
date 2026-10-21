import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";

/** The route guard — a bookmark reaches past the sidebar. */
export default async function Layout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  await requireModule(user.id, "accounts.bank-uploads");
  return children;
}
