import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";

/** Set up — routines and automatic tasks — is a module of its own, withheld here as well as in the sidebar. */
export default async function SetupLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  await requireModule(user.id, "tasks.setup");
  return children;
}
