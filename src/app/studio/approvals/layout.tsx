import { requireModule } from "@/lib/access";
import { requireUser } from "@/lib/auth";

export default async function Layout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  await requireModule(user.id, "studio.approve");
  return children;
}
