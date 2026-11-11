import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";

/** The team screens are a module of their own — a link not drawn is still a URL somebody can type. */
export default async function TeamLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  await requireModule(user.id, "tasks.team");
  return <>{children}</>;
}
